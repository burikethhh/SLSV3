//! Local SQLite — mirrors supabase/migrations/0001_init.sql table names.
//! WAL mode, single file `sls_local.sqlite`, prepared statements per sale.
//! Single-camera: attendance.direction always 'in'.
//! Path: app-data dir once Tauri `setup` calls `init_data_dir` (NSIS launches
//! the exe with CWD = System32 / Program Files — relative paths die there);
//! CWD fallback is for unit tests only.

use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once from Tauri `setup` with the resolved app-data directory.
pub fn init_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("sls-v3-session-tests"))
}

/// Presence only: do not expose unscoped legacy customer data to a new account.
pub fn legacy_rows_retained() -> bool {
    static PRESENT: OnceLock<bool> = OnceLock::new();
    *PRESENT.get_or_init(|| {
        let Ok(legacy) =
            Connection::open_with_flags(db_path(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            return false;
        };
        ["members", "products", "sales", "outbox"]
            .iter()
            .any(|table| {
                legacy
                    .query_row(
                        &format!("SELECT EXISTS(SELECT 1 FROM {table})"),
                        [],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
            })
    })
}

/// Facility-specific storage includes the outbox and staff/face caches.
/// Caller stops sync and holds the context write lock. Unscoped legacy data
/// stays untouched; importing ambiguous old rows requires reviewed recovery.
pub fn select_gym(gym_id: &str) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(gym_id).map_err(|_| "Invalid facility identity")?;
    let folder = data_dir().join("facilities").join(id.to_string());
    std::fs::create_dir_all(&folder).map_err(|_| "Cannot create facility storage")?;
    let next =
        open_db(folder.join("sls_local.sqlite")).map_err(|_| "Cannot open facility storage")?;
    *conn().lock().unwrap() = next;
    set_setting("gym_id", &id.to_string()).map_err(|e| e.to_string())
}

fn db_path() -> PathBuf {
    match DATA_DIR.get() {
        Some(dir) => dir.join("sls_local.sqlite"),
        None => PathBuf::from("sls_local.sqlite"), // tests / dev fallback
    }
}

pub fn conn() -> &'static Mutex<Connection> {
    DB.get_or_init(|| Mutex::new(open_db(db_path()).expect("open terminal database")))
}

pub(crate) fn open_db(path: PathBuf) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let c = Connection::open(&path)?;
    c.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, full_name TEXT NOT NULL, embedding_dim SMALLINT NOT NULL DEFAULT 512, face_vector TEXT);
             CREATE TABLE IF NOT EXISTS attendance_logs(id TEXT PRIMARY KEY, member_id TEXT, direction TEXT NOT NULL DEFAULT 'in', confidence REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
             CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents BIGINT NOT NULL, stock INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
             CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY, items_json TEXT NOT NULL, total_cents BIGINT NOT NULL, pay_method TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
             CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, op TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
             CREATE TABLE IF NOT EXISTS license_cache(token TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS staff_cache(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE IF NOT EXISTS promos_cache(code TEXT PRIMARY KEY COLLATE NOCASE, pct_off REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE IF NOT EXISTS plans_cache(id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL, duration_days INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS idx_attendance_member_created ON attendance_logs(member_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);",
        )?;
    let _ = c.execute(
        "ALTER TABLE attendance_logs ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'",
        [],
    );
    let _ = c.execute(
        "ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
        [],
    );
    let _ = c.execute("ALTER TABLE members ADD COLUMN expires_at TEXT", []);
    Ok(c)
}

pub fn get_setting(key: &str) -> rusqlite::Result<Option<String>> {
    let db = conn().lock().unwrap();
    Ok(db
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![key],
            |r| r.get(0),
        )
        .ok())
}

pub fn set_setting(key: &str, value: &str) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO settings(key, value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Push an enrolled member into the outbox (sync Edge Fn inserts into members
/// before attendance so the FK is satisfied in the same batch).
pub fn enqueue_member(member_id: &str, full_name: &str, vector: &[f32]) -> rusqlite::Result<()> {
    let expiry: Option<String> = conn().lock().unwrap().query_row(
        "SELECT expires_at FROM members WHERE id=?1",
        params![member_id],
        |r| r.get(0),
    )?;
    let payload = serde_json::json!({
        "id": member_id,
        "full_name": full_name,
        "embedding_dim": vector.len() as i32,
        "face_vector": vector,
        "expires_at": expiry,
    })
    .to_string();
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO outbox(id, op, payload) VALUES(?1,'member',?2)
         ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, attempts=0, created_at=datetime('now')",
        params![member_id, payload],
    )?;
    Ok(())
}

/// Upsert member details pulled from cloud (preserves local face_vector and dim).
pub fn upsert_member_cloud(
    id: &str,
    full_name: &str,
    status: &str,
    expires_at: Option<&str>,
) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO members(id, full_name, status, expires_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           full_name = excluded.full_name,
           status = excluded.status,
           expires_at = excluded.expires_at",
        params![id, full_name, status, expires_at],
    )?;
    Ok(())
}

/// Reconcile a complete roster without discarding unacknowledged enrollments.
pub fn apply_member_snapshot(
    members: &[serde_json::Value],
    faces: &[serde_json::Value],
    plans: &[serde_json::Value],
    cursor: &str,
) -> Result<(), String> {
    apply_member_snapshot_on(&mut conn().lock().unwrap(), members, faces, plans, cursor)
}
fn apply_member_snapshot_on(
    db: &mut Connection,
    members: &[serde_json::Value],
    faces: &[serde_json::Value],
    plans: &[serde_json::Value],
    cursor: &str,
) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(cursor).map_err(|_| "Invalid face-sync cursor")?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS snapshot_member_ids(id TEXT PRIMARY KEY);DELETE FROM snapshot_member_ids;").map_err(|e|e.to_string())?;
    for row in members {
        let id = row["id"].as_str().ok_or("Invalid roster identity")?;
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid roster identity")?;
        let name = row["full_name"].as_str().ok_or("Missing member name")?;
        let status = row["status"].as_str().ok_or("Missing member lifecycle")?;
        let expiry = row["expires_at"].as_str();
        if let Some(value) = expiry {
            chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "Invalid member expiry")?;
        }
        tx.execute("INSERT INTO snapshot_member_ids VALUES(?1)", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO members(id,full_name,status,expires_at) VALUES(?1,?2,?3,?4)
            ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name,status=excluded.status,expires_at=excluded.expires_at",params![id,name,status,expiry]).map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE members SET status='cancelled',face_vector=NULL WHERE id NOT IN(SELECT id FROM snapshot_member_ids)
        AND NOT EXISTS(SELECT 1 FROM outbox WHERE op='member' AND outbox.id=members.id)",[]).map_err(|e|e.to_string())?;
    for row in faces {
        let id = row["id"].as_str().ok_or("Invalid face identity")?;
        let vector = if row["face_vector"].is_null() {
            None
        } else {
            let value: Vec<f32> = serde_json::from_value(row["face_vector"].clone())
                .map_err(|_| "Invalid face vector")?;
            if value.len() != 512 || value.iter().any(|x| !x.is_finite()) {
                return Err("Unsupported face vector; sync cursor retained".into());
            }
            Some(serde_json::to_string(&value).map_err(|_| "Invalid face vector")?)
        };
        tx.execute("UPDATE members SET face_vector=?2,embedding_dim=512 WHERE id=?1 AND id IN(SELECT id FROM snapshot_member_ids)
            AND NOT EXISTS(SELECT 1 FROM outbox WHERE op='member' AND outbox.id=members.id)",params![id,vector]).map_err(|e|e.to_string())?;
    }
    tx.execute("DELETE FROM plans_cache", [])
        .map_err(|e| e.to_string())?;
    for row in plans {
        let id = row["id"].as_str().ok_or("Invalid membership plan")?;
        let price = row["price_cents"]
            .as_i64()
            .filter(|v| *v >= 0)
            .ok_or("Invalid plan price")?;
        let days = row["duration_days"]
            .as_i64()
            .filter(|v| *v > 0 && *v <= 3650)
            .ok_or("Invalid plan duration")?;
        tx.execute(
            "INSERT INTO plans_cache VALUES(?1,?2,?3,?4)",
            params![
                id,
                row["name"].as_str().ok_or("Invalid plan name")?,
                price,
                days
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute("INSERT INTO settings VALUES('face_sync_cursor',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![cursor]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn plans_list() -> rusqlite::Result<Vec<serde_json::Value>> {
    let db = conn().lock().unwrap();
    let mut stmt =
        db.prepare("SELECT id,name,price_cents,duration_days FROM plans_cache ORDER BY name")?;
    let rows=stmt.query_map([],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"price_cents":r.get::<_,i64>(2)?,"duration_days":r.get::<_,i32>(3)?})))?.collect();
    rows
}

/// Check member lifecycle status (frozen, cancelled, or expired) before admitting.
pub fn check_member_lifecycle(member_id: &str) -> rusqlite::Result<Result<(), String>> {
    let db = conn().lock().unwrap();
    let row: rusqlite::Result<(String, Option<String>)> = db.query_row(
        "SELECT coalesce(status, 'active'), expires_at FROM members WHERE id=?1",
        params![member_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );
    match row {
        Ok((status, expires_at)) => {
            if status.eq_ignore_ascii_case("frozen") {
                return Ok(Err("frozen".into()));
            }
            if status.eq_ignore_ascii_case("cancelled") {
                return Ok(Err("cancelled".into()));
            }
            if !status.eq_ignore_ascii_case("active") {
                return Ok(Err("inactive_member".into()));
            }
            if let Some(exp_str) = expires_at {
                if let Ok(exp_dt) = chrono::DateTime::parse_from_rfc3339(&exp_str) {
                    if chrono::Utc::now() > exp_dt {
                        return Ok(Err("expired".into()));
                    }
                } else if let Ok(exp_dt) =
                    chrono::DateTime::parse_from_str(&exp_str, "%Y-%m-%d %H:%M:%S%#z")
                {
                    if chrono::Utc::now() > exp_dt {
                        return Ok(Err("expired".into()));
                    }
                } else if let Ok(naive) =
                    chrono::NaiveDateTime::parse_from_str(&exp_str, "%Y-%m-%d %H:%M:%S")
                {
                    if chrono::Utc::now().naive_utc() > naive {
                        return Ok(Err("expired".into()));
                    }
                } else {
                    return Ok(Err("invalid_expiry".into()));
                }
            }
            Ok(Ok(()))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Err("unknown_member".into())),
        Err(e) => Err(e),
    }
}

/// Check if a member is currently inside (latest record direction == 'in')
pub fn is_member_inside(member_id: &str) -> rusqlite::Result<bool> {
    let db = conn().lock().unwrap();
    let dir: rusqlite::Result<String> = db.query_row(
        "SELECT direction FROM attendance_logs WHERE member_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
        params![member_id],
        |r| r.get(0),
    );
    match dir {
        Ok(d) => Ok(d.eq_ignore_ascii_case("in")),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Gate-IN log with 5s per-member anti-passback cooldown to avoid camera spam.
pub fn log_checkin(member_id: &str, confidence: f32) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();

    // Member lifecycle guard (skip for manual override)
    if member_id != "MANUAL_OVERRIDE" && member_id != "EXIT_BUTTON" {
        if let Err(reason) = check_member_lifecycle(member_id)? {
            return Ok(reason);
        }
    }

    let db = conn().lock().unwrap();

    // Cooldown: reject if same member checked in within last 5s to avoid duplicate scan spam.
    if member_id != "MANUAL_OVERRIDE" {
        let recent: i64 = db.query_row(
            "SELECT COUNT(*) FROM attendance_logs WHERE member_id=?1 AND coalesce(direction,'in')='in' AND created_at > datetime('now','-5 seconds')",
            params![member_id],
            |r| r.get(0),
        )?;
        if recent > 0 {
            return Ok("cooldown".into());
        }
    }

    db.execute(
        "INSERT INTO attendance_logs(id, member_id, direction, confidence) VALUES(?1,?2,'in',?3)",
        params![id, member_id, confidence],
    )?;
    let created_at: String = db
        .query_row(
            "SELECT created_at FROM attendance_logs WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "1970-01-01 00:00:00".into());
    // Outbox id == attendance id → server upserts by id, retries can't dup.
    let payload = serde_json::json!({
        "id": id,
        "member_id": member_id,
        "direction": "in",
        "confidence": confidence,
        "created_at": created_at,
    })
    .to_string();
    db.execute(
        "INSERT INTO outbox(id, op, payload) VALUES(?1,'attendance',?2)
         ON CONFLICT(id) DO NOTHING",
        params![id, payload],
    )?;
    Ok(id)
}

/// Gate-OUT log: marks member as checked out, unlocking subsequent checkin.
pub fn log_checkout(member_id: &str) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO attendance_logs(id, member_id, direction, confidence) VALUES(?1,?2,'out',1.0)",
        params![id, member_id],
    )?;
    let created_at: String = db
        .query_row(
            "SELECT created_at FROM attendance_logs WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "1970-01-01 00:00:00".into());
    let payload = serde_json::json!({
        "id": id,
        "member_id": member_id,
        "direction": "out",
        "confidence": 1.0,
        "created_at": created_at,
    })
    .to_string();
    db.execute(
        "INSERT INTO outbox(id, op, payload) VALUES(?1,'attendance',?2)
         ON CONFLICT(id) DO NOTHING",
        params![id, payload],
    )?;
    Ok(id)
}

/// Gate exit button press: logs anonymous exit with current timestamp.
pub fn log_exit_button() -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO attendance_logs(id, member_id, direction, confidence) VALUES(?1, 'EXIT_BUTTON', 'out', 1.0)",
        params![id],
    )?;
    let created_at: String = db
        .query_row(
            "SELECT created_at FROM attendance_logs WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "1970-01-01 00:00:00".into());
    let payload = serde_json::json!({
        "id": id,
        "member_id": "EXIT_BUTTON",
        "direction": "out",
        "confidence": 1.0,
        "created_at": created_at,
    })
    .to_string();
    let _ = db.execute(
        "INSERT INTO outbox(id, op, payload) VALUES(?1,'attendance',?2)
         ON CONFLICT(id) DO NOTHING",
        params![id, payload],
    );
    Ok(id)
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct AttendanceRow {
    pub id: String,
    pub member_id: String,
    pub full_name: String,
    pub direction: String,
    pub is_inside: bool,
    pub confidence: f32,
    pub created_at: String,
    pub visits_today: u32,
    pub total_visits: u32,
    pub rank: String,
}

pub fn calculate_hunter_rank(total_visits: u32) -> &'static str {
    match total_visits {
        100.. => "S",
        50..=99 => "A",
        25..=49 => "B",
        10..=24 => "C",
        5..=9 => "D",
        _ => "E",
    }
}

/// Manual override of the gate (e.g. from topbar button, shortcut, or receptionist).
/// Logs an explicit record to attendance_logs and enqueues to outbox for cloud audit.
pub fn log_manual_override(operator: Option<&str>) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = conn().lock().unwrap();
    let op_name = operator.unwrap_or("Staff Manual Override");
    db.execute(
        "INSERT INTO attendance_logs(id, member_id, direction, confidence) VALUES(?1, 'MANUAL_OVERRIDE', 'in', 1.0)",
        params![id],
    )?;
    let created_at: String = db
        .query_row(
            "SELECT created_at FROM attendance_logs WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "1970-01-01 00:00:00".into());
    let payload = serde_json::json!({
        "id": id,
        "member_id": "MANUAL_OVERRIDE",
        "full_name": "MANUAL GATE OVERRIDE",
        "operator": op_name,
        "confidence": 1.0,
        "created_at": created_at,
    })
    .to_string();
    let _ = db.execute(
        "INSERT INTO outbox(id, op, payload) VALUES(?1,'attendance',?2)
         ON CONFLICT(id) DO NOTHING",
        params![id, payload],
    );
    Ok(id)
}

/// Recent attendance logs joined with members (or fallback name).
pub fn attendance_list(limit: u32) -> rusqlite::Result<Vec<AttendanceRow>> {
    let db = conn().lock().unwrap();
    let mut st = db.prepare(
        "SELECT a.id, a.member_id, 
                CASE 
                    WHEN a.member_id = 'MANUAL_OVERRIDE' THEN 'MANUAL GATE OVERRIDE'
                    WHEN a.member_id = 'EXIT_BUTTON' THEN 'EXIT (BUTTON)'
                    ELSE coalesce(m.full_name, 'Hunter ' || substr(a.member_id, 1, 8))
                END, 
                a.confidence, a.created_at,
                CASE 
                    WHEN a.member_id IN ('MANUAL_OVERRIDE', 'EXIT_BUTTON') THEN 1
                    ELSE (
                        SELECT count(*) 
                        FROM attendance_logs al 
                        WHERE al.member_id = a.member_id 
                          AND date(al.created_at) = date(a.created_at)
                          AND al.created_at <= a.created_at
                          AND coalesce(al.direction, 'in') = 'in'
                    )
                END as visits_today,
                CASE 
                    WHEN a.member_id IN ('MANUAL_OVERRIDE', 'EXIT_BUTTON') THEN 1
                    ELSE (
                        SELECT count(*) 
                        FROM attendance_logs al 
                        WHERE al.member_id = a.member_id 
                          AND al.created_at <= a.created_at
                          AND coalesce(al.direction, 'in') = 'in'
                    )
                END as total_visits,
                coalesce(a.direction, 'in') as direction,
                (
                    SELECT al2.direction 
                    FROM attendance_logs al2 
                    WHERE al2.member_id = a.member_id 
                    ORDER BY al2.created_at DESC, al2.rowid DESC 
                    LIMIT 1
                ) as latest_direction
         FROM attendance_logs a
         LEFT JOIN members m ON m.id = a.member_id
         ORDER BY a.created_at DESC
         LIMIT ?1",
    )?;
    let rows = st
        .query_map(params![limit], |r| {
            let member_id: String = r.get(1)?;
            let visits_today: u32 = r.get(5)?;
            let total_visits: u32 = r.get(6)?;
            let direction: String = r.get(7)?;
            let latest_direction: Option<String> = r.get(8)?;
            let is_inside = if member_id == "MANUAL_OVERRIDE" || member_id == "EXIT_BUTTON" {
                false
            } else {
                latest_direction
                    .as_deref()
                    .unwrap_or("in")
                    .eq_ignore_ascii_case("in")
            };
            let rank = if member_id == "MANUAL_OVERRIDE" {
                "OVERRIDE".to_string()
            } else if member_id == "EXIT_BUTTON" {
                "EXIT".to_string()
            } else {
                calculate_hunter_rank(total_visits).to_string()
            };
            Ok(AttendanceRow {
                id: r.get(0)?,
                member_id,
                full_name: r.get(2)?,
                direction,
                is_inside,
                confidence: r.get(3)?,
                created_at: r.get(4)?,
                visits_today,
                total_visits,
                rank,
            })
        })?
        .collect();
    rows
}

// ── Outbox (offline-first push queue; see crates/sls-core/src/sync.rs) ────────

#[derive(serde::Serialize)]
pub struct OutboxItem {
    pub id: String,
    pub op: String,
    pub payload: String,
    pub attempts: u32,
    pub created_at: String,
}

/// Oldest-first batch of unsynced rows (cap `limit` for one PostgREST round-trip).
pub fn take_outbox(limit: u32) -> rusqlite::Result<Vec<OutboxItem>> {
    let db = conn().lock().unwrap();
    let mut st = db.prepare(
        "SELECT id, op, payload, attempts, created_at FROM outbox WHERE attempts < 10 ORDER BY created_at LIMIT ?1",
    )?;
    let rows = st.query_map(params![limit], |r| {
        Ok(OutboxItem {
            id: r.get(0)?,
            op: r.get(1)?,
            payload: r.get(2)?,
            attempts: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Remove rows after a successful PostgREST insert.
pub fn clear_outbox(ids: &[String]) -> rusqlite::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let db = conn().lock().unwrap();
    for id in ids {
        db.execute("DELETE FROM outbox WHERE id=?1", params![id])?;
    }
    Ok(())
}

/// Bump attempts on failure (drives 5/15/30/60s backoff + DLQ visibility).
pub fn bump_outbox_attempts(ids: &[String]) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    for id in ids {
        db.execute(
            "UPDATE outbox SET attempts = attempts + 1 WHERE id=?1",
            params![id],
        )?;
    }
    Ok(())
}

/// Cheap COUNT for the status bar — sync_pending must not pull full payloads
/// (member rows carry 512-float face vectors) just to show "3 pending sync".
pub fn outbox_count() -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let n: i64 = db.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))?;
    Ok(n as u32)
}

pub fn outbox_quarantined_count() -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let n: i64 = db.query_row(
        "SELECT COUNT(*) FROM outbox WHERE attempts >= 10",
        [],
        |r| r.get(0),
    )?;
    Ok(n as u32)
}

pub fn unsynced_sales_count() -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let n: i64 = db.query_row("SELECT COUNT(*) FROM outbox WHERE op='sale'", [], |r| {
        r.get(0)
    })?;
    Ok(n as u32)
}

/// Kiosk retention: keep 90 days of local logs, cloud is source of truth.
/// Runs at boot; failures are ignored by the caller so the gate never blocks.
pub fn prune_old_logs(keep_days: u32) -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let days = format!("-{} days", keep_days.max(7));
    let a = db.execute(
        "DELETE FROM attendance_logs WHERE created_at < datetime('now', ?1)
         AND NOT EXISTS(SELECT 1 FROM outbox WHERE outbox.id=attendance_logs.id)",
        params![days],
    )? as u32;
    let _ = db.execute(
        "DELETE FROM sales WHERE created_at < datetime('now', ?1)
         AND NOT EXISTS(SELECT 1 FROM outbox WHERE outbox.id=sales.id)",
        params![days],
    );
    Ok(a)
}

// ── Staff cache (terminal-PIN lock for Settings; pulled via sync) ─────────────

/// Upsert a staff row pulled from Supabase (`staff` table, PHC pin_hash —
/// verified locally by `sls_core::auth::verify_password`, same params).
pub fn upsert_staff(
    id: &str,
    username: &str,
    pin_hash: &str,
    role: &str,
    active: bool,
) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO staff_cache(id, username, pin_hash, role, active) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET username=excluded.username, pin_hash=excluded.pin_hash,
           role=excluded.role, active=excluded.active",
        params![id, username, pin_hash, role, active as i32],
    )?;
    Ok(())
}

/// Reconcile against the full staff list from the sync pull — staff removed
/// or deactivated in the dashboard lose terminal access on the next poll.
pub fn reconcile_staff(present: &[String]) -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let mut st = db.prepare("SELECT id FROM staff_cache")?;
    let local: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut dropped = 0u32;
    for id in local {
        if !present.iter().any(|p| p == &id) {
            dropped += db.execute("DELETE FROM staff_cache WHERE id=?1", params![id])? as u32;
        }
    }
    Ok(dropped)
}

/// True when any active staff row exists → Settings requires a PIN.
/// Fresh installs (no pull yet) stay open so the first license can land.
pub fn staff_locked() -> rusqlite::Result<bool> {
    let db = conn().lock().unwrap();
    let n: i64 = db.query_row("SELECT COUNT(*) FROM staff_cache WHERE active=1", [], |r| {
        r.get(0)
    })?;
    Ok(n > 0)
}

pub fn staff_identity(username: &str) -> rusqlite::Result<Option<(String, String)>> {
    use rusqlite::OptionalExtension;
    conn()
        .lock()
        .unwrap()
        .query_row(
            "SELECT role,pin_hash FROM staff_cache WHERE username=?1 AND active=1",
            params![username.trim().to_lowercase()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
}

/// Verify a terminal PIN against the local cache. Returns the staff `role`
/// on success, None for unknown user / inactive / bad PIN / locked out.
/// Brute-force guard: 5 fails → 5-min lockout per username + ~300ms delay
/// on failure (Argon2id is already slow; this stops fast PIN sweeps).
/// Old 4-digit PINs still verify — the 6-digit minimum is enforced at
/// creation (`staff-create`); owners should rotate short PINs.
pub fn staff_verify(username: &str, pin: &str) -> rusqlite::Result<Option<String>> {
    let user = username.trim().to_lowercase();
    let lock_key = format!("pin_lock_{user}");
    let fail_key = format!("pin_fail_{user}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let locked_until: i64 = conn()
        .lock()
        .unwrap()
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![lock_key],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if locked_until > now {
        return Ok(None);
    }
    let (hash, role, active): (String, String, i64) = {
        let db = conn().lock().unwrap();
        match db.query_row(
            "SELECT pin_hash, role, active FROM staff_cache WHERE username=?1",
            params![user],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        ) {
            Ok(v) => v,
            Err(_) => {
                drop(db);
                std::thread::sleep(std::time::Duration::from_millis(300));
                return Ok(None);
            }
        }
    };
    if active == 1 && sls_core::auth::verify_password(pin, &hash) {
        let db = conn().lock().unwrap();
        let _ = db.execute(
            "DELETE FROM settings WHERE key=?1 OR key=?2",
            params![lock_key, fail_key],
        );
        return Ok(Some(role));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let db = conn().lock().unwrap();
    let fails: i64 = db
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![fail_key],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        + 1;
    let _ = db.execute(
        "INSERT INTO settings(key, value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![fail_key, fails.to_string()],
    );
    if fails >= 5 {
        let _ = db.execute(
            "INSERT INTO settings(key, value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![lock_key, (now + 300).to_string()],
        );
        let _ = db.execute("DELETE FROM settings WHERE key=?1", params![fail_key]);
    }
    Ok(None)
}

// ── License cache + heartbeat (kill-switch e2e state) ─────────────────────────

pub fn cache_license(token: &str, expires_at: &str) -> rusqlite::Result<()> {
    let mut db = conn().lock().unwrap();
    let tx = db.transaction()?;
    tx.execute("DELETE FROM license_cache", [])?;
    tx.execute(
        "INSERT INTO license_cache(token, expires_at) VALUES(?1,?2)",
        params![token, expires_at],
    )?;
    tx.commit()
}

pub fn get_cached_license() -> rusqlite::Result<Option<String>> {
    let db = conn().lock().unwrap();
    Ok(db
        .query_row("SELECT token FROM license_cache LIMIT 1", [], |r| r.get(0))
        .ok())
}

pub fn clear_cached_license() -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute("DELETE FROM license_cache", [])?;
    Ok(())
}

/// Record a successful online verify (drives the 7-day heartbeat window in
/// license_verify::is_heartbeat_expired — mirrors v2 `heartbeat_ok()`).
pub fn heartbeat_ok() -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS heartbeat(last_ok_unix INTEGER NOT NULL);
         INSERT INTO heartbeat(last_ok_unix) SELECT strftime('%s','now') WHERE NOT EXISTS (SELECT 1 FROM heartbeat);
         UPDATE heartbeat SET last_ok_unix = strftime('%s','now');",
    )?;
    Ok(())
}

pub fn last_heartbeat() -> rusqlite::Result<i64> {
    let db = conn().lock().unwrap();
    Ok(db
        .query_row("SELECT last_ok_unix FROM heartbeat LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap_or(0))
}

// ── Catalog ingest (pull side: owner edits land on terminal) ──────────────────

/// Upsert a product pulled from Supabase (id, name, price_cents, stock).
pub fn upsert_product(id: &str, name: &str, price_cents: i64, stock: i32) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO products(id, name, price_cents, stock) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, price_cents=excluded.price_cents, stock=excluded.stock",
        params![id, name, price_cents, stock],
    )?;
    Ok(())
}

/// Delete local products the owner removed in the dashboard (`product_ids`
/// from the sync pull is the authoritative id list for this gym).
pub fn reconcile_products(present: &[String]) -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let mut st = db.prepare("SELECT id FROM products")?;
    let local: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut dropped = 0u32;
    for id in local {
        if !present.iter().any(|p| p == &id) {
            dropped += db.execute("DELETE FROM products WHERE id=?1", params![id])? as u32;
        }
    }
    Ok(dropped)
}

// ── POS persistence (sale row + outbox op='sale' for sync_worker) ─────────────

/// Persist a completed checkout: sales row + outbox payload matching
/// the `sync` Edge Fn shape (`id`, `items_json`, `total_cents`, `pay_method`,
/// `created_at`). Outbox id == sale id — server upserts, retries can't dup.
pub fn record_sale(
    id: &str,
    items_json: &str,
    total_cents: i64,
    pay_method: &str,
) -> rusqlite::Result<()> {
    let mut db = conn().lock().unwrap();
    let tx = db.transaction()?;
    let items: Vec<serde_json::Value> =
        serde_json::from_str(items_json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if items.is_empty() || total_cents <= 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut verified_total = 0_i64;
    for item in &items {
        let product_id = item
            .get("product_id")
            .and_then(|v| v.as_str())
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let qty = item
            .get("qty")
            .and_then(|v| v.as_i64())
            .filter(|q| *q > 0)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let price = item
            .get("unit_cents")
            .and_then(|v| v.as_i64())
            .filter(|p| *p >= 0)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let discount = item
            .get("discount_cents")
            .and_then(|v| v.as_i64())
            .filter(|d| *d >= 0)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let gross = price
            .checked_mul(qty)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        if discount > gross {
            return Err(rusqlite::Error::InvalidQuery);
        }
        verified_total = verified_total
            .checked_add(gross - discount)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let changed = tx.execute(
            "UPDATE products SET stock = stock - ?1 WHERE id = ?2 AND price_cents = ?3 AND stock >= ?1",
            params![qty, product_id, price],
        )?;
        if changed != 1 {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    if verified_total != total_cents {
        return Err(rusqlite::Error::InvalidQuery);
    }
    tx.execute(
        "INSERT INTO sales(id, items_json, total_cents, pay_method) VALUES(?1,?2,?3,?4)",
        params![id, items_json, total_cents, pay_method],
    )?;
    let created_at: String = tx
        .query_row(
            "SELECT created_at FROM sales WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "1970-01-01 00:00:00".into());
    let payload = serde_json::json!({
        "id": id,
        "items_json": items_json,
        "total_cents": total_cents,
        "pay_method": pay_method,
        "created_at": created_at,
    })
    .to_string();
    tx.execute(
        "INSERT INTO outbox(id, op, payload) VALUES(?1,'sale',?2)
         ON CONFLICT(id) DO NOTHING",
        params![id, payload],
    )?;
    tx.commit()?;
    Ok(())
}

/// Product search: LIKE + LIMIT 50 (debounced 150ms in the webview).
/// Empty query returns the newest 50 (browse mode).
pub fn product_search(q: &str) -> rusqlite::Result<Vec<ProductRow>> {
    let db = conn().lock().unwrap();
    if q.trim().is_empty() {
        let mut st =
            db.prepare("SELECT id, name, price_cents, stock FROM products ORDER BY name LIMIT 50")?;
        return st.query_map([], row_product)?.collect();
    }
    let like = format!("%{}%", q.trim());
    let mut st = db.prepare(
        "SELECT id, name, price_cents, stock FROM products WHERE name LIKE ?1 OR id LIKE ?1 ORDER BY name LIMIT 50",
    )?;
    let rows = st.query_map(params![like], row_product)?.collect();
    rows
}

#[derive(serde::Serialize)]
pub struct ProductRow {
    pub id: String,
    pub name: String,
    pub price_cents: i64,
    pub stock: i32,
}

fn row_product(r: &rusqlite::Row) -> rusqlite::Result<ProductRow> {
    Ok(ProductRow {
        id: r.get(0)?,
        name: r.get(1)?,
        price_cents: r.get(2)?,
        stock: r.get(3)?,
    })
}

/// Member search for the POS "walk-in / lookup" box.
pub fn member_search(q: &str) -> rusqlite::Result<Vec<MemberRow>> {
    let db = conn().lock().unwrap();
    let like = format!("%{}%", q.trim());
    let mut st = db.prepare(
        "SELECT m.id, m.full_name,
                (SELECT al.direction FROM attendance_logs al WHERE al.member_id = m.id ORDER BY al.created_at DESC, al.rowid DESC LIMIT 1) as latest_dir,
                coalesce(m.status, 'active') as status,
                m.expires_at
         FROM members m 
         WHERE m.full_name LIKE ?1 OR m.id LIKE ?1 
         ORDER BY m.full_name 
         LIMIT 20",
    )?;
    let rows = st
        .query_map(params![like], |r| {
            let latest_dir: Option<String> = r.get(2)?;
            let is_inside = latest_dir
                .as_deref()
                .unwrap_or("out")
                .eq_ignore_ascii_case("in");
            let status: String = r.get(3)?;
            let expires_at: Option<String> = r.get(4)?;
            Ok(MemberRow {
                id: r.get(0)?,
                full_name: r.get(1)?,
                is_inside,
                status,
                expires_at,
            })
        })?
        .collect();
    rows
}

#[derive(serde::Serialize)]
pub struct MemberRow {
    pub id: String,
    pub full_name: String,
    pub is_inside: bool,
    pub status: String,
    pub expires_at: Option<String>,
}

/// Cache a promo voucher pulled from Supabase.
pub fn upsert_promo(code: &str, pct_off: f64, active: bool) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO promos_cache(code, pct_off, active) VALUES(?1, ?2, ?3)
         ON CONFLICT(code) DO UPDATE SET pct_off=excluded.pct_off, active=excluded.active",
        params![code, pct_off, if active { 1 } else { 0 }],
    )?;
    Ok(())
}

/// Reconcile local promos against the active list from the cloud.
pub fn reconcile_promos(present_codes: &[String]) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    if present_codes.is_empty() {
        db.execute("DELETE FROM promos_cache", [])?;
    } else {
        let mut query = String::from("DELETE FROM promos_cache WHERE code NOT IN (");
        for (i, _) in present_codes.iter().enumerate() {
            if i > 0 {
                query.push(',');
            }
            query.push_str(&format!("?{}", i + 1));
        }
        query.push(')');
        let mut stmt = db.prepare(&query)?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = present_codes
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        stmt.execute(params_vec.as_slice())?;
    }
    Ok(())
}

/// Validate promo code: returns Some(pct_off) if active, None if invalid or inactive.
pub fn validate_promo(code: &str) -> rusqlite::Result<Option<f64>> {
    let db = conn().lock().unwrap();
    let pct: rusqlite::Result<f64> = db.query_row(
        "SELECT pct_off FROM promos_cache WHERE code=?1 AND active=1",
        params![code.trim()],
        |r| r.get(0),
    );
    match pct {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Recent sales for the POS history pane (local-first; cloud rows land via sync pull).
pub fn sale_list(limit: u32) -> rusqlite::Result<Vec<SaleRow>> {
    let db = conn().lock().unwrap();
    let mut st = db.prepare(
        "SELECT id, items_json, total_cents, pay_method, created_at,
         EXISTS(SELECT 1 FROM outbox WHERE outbox.id=sales.id) FROM sales ORDER BY created_at DESC LIMIT ?1",
    )?;
    let rows = st
        .query_map(params![limit], |r| {
            Ok(SaleRow {
                id: r.get(0)?,
                items_json: r.get(1)?,
                total_cents: r.get(2)?,
                pay_method: r.get(3)?,
                created_at: r.get(4)?,
                pending: r.get(5)?,
            })
        })?
        .collect();
    rows
}

#[derive(serde::Serialize)]
pub struct SaleRow {
    pub id: String,
    pub items_json: String,
    pub total_cents: i64,
    pub pay_method: String,
    pub created_at: String,
    pub pending: bool,
}

pub fn sales_summary() -> rusqlite::Result<serde_json::Value> {
    conn().lock().unwrap().query_row("SELECT coalesce(sum(total_cents),0),count(*) FROM sales
        WHERE date(created_at,'+8 hours')=date('now','+8 hours')",[],|r|Ok(serde_json::json!({"total_cents":r.get::<_,i64>(0)?,"transactions":r.get::<_,i64>(1)?,"timezone":"Asia/Manila"})))
}

// ── Face vectors (face_enroll / face_match commands) ──────────────────────────

/// Persist an enrolled embedding (dim-agnostic JSON float array).
pub fn upsert_member_embedding(
    member_id: &str,
    full_name: &str,
    vector: &[f32],
) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    let dim = vector.len() as i32;
    let json = serde_json::to_string(vector)
        .map_err(|_| rusqlite::Error::InvalidParameterName("json".into()))?;
    db.execute(
        "INSERT INTO members(id, full_name, embedding_dim, face_vector) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, embedding_dim=excluded.embedding_dim, face_vector=excluded.face_vector",
        params![member_id, full_name, dim, json],
    )?;
    Ok(())
}

/// Load all enrolled vectors into the in-memory FaceStore at startup.
pub fn enroll_with_plan(
    member_id: &str,
    name: &str,
    vector: &[f32],
    plan_id: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(member_id).map_err(|_| "Invalid member ID")?;
    if name.trim().is_empty() || name.chars().count() > 200 {
        return Err("Enter a member name, up to 200 characters".into());
    }
    let mut db = conn().lock().unwrap();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let days: i64 = tx
        .query_row(
            "SELECT duration_days FROM plans_cache WHERE id=?1",
            params![plan_id],
            |r| r.get(0),
        )
        .map_err(|_| "Select a synced membership plan first")?;
    if !(1..=3650).contains(&days) {
        return Err("Invalid membership duration".into());
    }
    let expires = (chrono::Utc::now() + chrono::Duration::days(days)).to_rfc3339();
    let face = serde_json::to_string(vector).map_err(|_| "Invalid face vector")?;
    tx.execute("INSERT INTO members(id,full_name,embedding_dim,face_vector,status,expires_at) VALUES(?1,?2,512,?3,'active',?4)",params![member_id,name.trim(),face,expires]).map_err(|_|"Member already exists or cannot be enrolled")?;
    let payload=serde_json::json!({"id":member_id,"full_name":name.trim(),"embedding_dim":512,"face_vector":vector,"expires_at":expires}).to_string();
    tx.execute(
        "INSERT INTO outbox(id,op,payload) VALUES(?1,'member',?2)",
        params![member_id, payload],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn load_face_vectors() -> rusqlite::Result<Vec<(String, Vec<f32>)>> {
    let db = conn().lock().unwrap();
    let mut st = db.prepare("SELECT id, face_vector FROM members WHERE face_vector IS NOT NULL")?;
    let rows = st.query_map([], |r| {
        let id: String = r.get(0)?;
        let json: String = r.get(1)?;
        Ok((id, json))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, json) = row?;
        if let Ok(v) = serde_json::from_str::<Vec<f32>>(&json) {
            out.push((id, v));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_roster_reconciles_deletions_preserves_pending_and_rolls_back_bad_faces() {
        let mut db = open_db(PathBuf::from(":memory:")).unwrap();
        let kept = uuid::Uuid::new_v4().to_string();
        let deleted = uuid::Uuid::new_v4().to_string();
        let pending = uuid::Uuid::new_v4().to_string();
        for id in [&kept, &deleted, &pending] {
            db.execute(
                "INSERT INTO members(id,full_name,face_vector) VALUES(?1,'Local','[0.1]')",
                params![id],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO outbox(id,op,payload) VALUES(?1,'member','{}')",
            params![pending],
        )
        .unwrap();
        let members = vec![
            serde_json::json!({"id":kept,"full_name":"Cloud member","status":"frozen","expires_at":null}),
        ];
        let faces = vec![serde_json::json!({"id":kept,"face_vector":vec![0.1_f32;512]})];
        let plan = serde_json::json!({"id":"plan","name":"Monthly","price_cents":15000,"duration_days":30});
        apply_member_snapshot_on(&mut db, &members, &faces, &[plan], "2026-10-13T00:00:00Z")
            .unwrap();
        let status = |db: &Connection, id: &str| {
            db.query_row("SELECT status FROM members WHERE id=?1", params![id], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
        };
        assert_eq!(status(&db, &deleted), "cancelled");
        assert_eq!(status(&db, &pending), "active");
        assert_eq!(status(&db, &kept), "frozen");
        assert!(db
            .query_row(
                "SELECT face_vector FROM members WHERE id=?1",
                params![deleted],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none());
        let invalid = vec![serde_json::json!({"id":kept,"face_vector":[0.1]})];
        assert!(
            apply_member_snapshot_on(&mut db, &[], &invalid, &[], "2026-10-14T00:00:00Z").is_err()
        );
        assert_eq!(status(&db, &kept), "frozen");
        assert_eq!(
            db.query_row(
                "SELECT value FROM settings WHERE key='face_sync_cursor'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "2026-10-13T00:00:00Z"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM plans_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn unknown_and_invalid_members_are_denied() {
        setup();
        assert_eq!(
            log_checkin(&uuid::Uuid::new_v4().to_string(), 0.99).unwrap(),
            "unknown_member"
        );
        let member = uuid::Uuid::new_v4().to_string();
        upsert_member_cloud(&member, "Invalid expiry", "active", Some("not-a-date")).unwrap();
        assert_eq!(log_checkin(&member, 0.99).unwrap(), "invalid_expiry");
        upsert_member_cloud(&member, "Inactive", "unknown", None).unwrap();
        assert_eq!(log_checkin(&member, 0.99).unwrap(), "inactive_member");
    }

    #[test]
    fn facility_files_isolate_pending_rows() {
        let directory =
            std::env::temp_dir().join(format!("sls-isolation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let first = open_db(directory.join("first.sqlite")).unwrap();
        let second = open_db(directory.join("second.sqlite")).unwrap();
        first
            .execute(
                "INSERT INTO outbox(id,op,payload) VALUES('pending-first','sale','{}')",
                [],
            )
            .unwrap();
        let count: i64 = second
            .query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(first);
        let reopened = open_db(directory.join("first.sqlite")).unwrap();
        let count: i64 = reopened
            .query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 1,
            "switching facilities must retain the original queue"
        );
    }

    /// Pin the DB to a temp dir (OnceLock — first caller wins) so tests never
    /// drop `sls_local.sqlite` into the crate dir.
    fn setup() {
        let _ = init_data_dir(std::env::temp_dir().join("sls-v3-db-tests"));
    }

    fn outbox_row(id: &str) -> Option<OutboxItem> {
        take_outbox(1000).ok()?.into_iter().find(|o| o.id == id)
    }

    #[test]
    fn checkin_outbox_carries_id_and_offline_timestamp() {
        setup();
        let member = uuid::Uuid::new_v4().to_string();
        upsert_member_cloud(&member, "Test member", "active", None).unwrap();
        let att_id = log_checkin(&member, 0.91).expect("log_checkin");
        let item = outbox_row(&att_id).expect("attendance outbox row");
        assert_eq!(item.op, "attendance");
        let v: serde_json::Value = serde_json::from_str(&item.payload).unwrap();
        // Server upserts by id — payload must carry it + the offline created_at.
        assert_eq!(v["id"].as_str(), Some(att_id.as_str()));
        assert_eq!(v["member_id"].as_str(), Some(member.as_str()));
        assert!(v["created_at"].as_str().unwrap_or("").len() >= 19);
        clear_outbox(&[att_id]).unwrap();
    }

    #[test]
    fn checkin_rate_limited_and_exit_button_logged() {
        setup();
        let member = uuid::Uuid::new_v4().to_string();
        upsert_member_cloud(&member, "Test member", "active", None).unwrap();
        let att_id1 = log_checkin(&member, 0.95).expect("first checkin");
        assert_ne!(att_id1, "cooldown");

        // Attempting to check in again within 5s returns cooldown to avoid camera spam
        let att_id2 = log_checkin(&member, 0.95).expect("second checkin");
        assert_eq!(att_id2, "cooldown");

        // Button out logs anonymous checkout with timestamp
        let exit_id = log_exit_button().expect("exit button");
        let item = outbox_row(&exit_id).expect("exit outbox row");
        assert_eq!(item.op, "attendance");
        let v: serde_json::Value = serde_json::from_str(&item.payload).unwrap();
        assert_eq!(v["member_id"].as_str(), Some("EXIT_BUTTON"));
        assert_eq!(v["direction"].as_str(), Some("out"));
        assert!(v["created_at"].as_str().unwrap_or("").len() >= 19);

        clear_outbox(&[att_id1, exit_id]).unwrap();
    }

    #[test]
    fn sale_outbox_is_idempotent_on_sale_id() {
        setup();
        upsert_product("p1", "Test product", 100, 2).expect("seed product");
        let id = uuid::Uuid::new_v4().to_string();
        let items = r#"[{"product_id":"p1","unit_cents":100,"qty":2,"discount_cents":0}]"#;
        record_sale(&id, items, 200, "cash").expect("record_sale");
        let item = outbox_row(&id).expect("sale outbox row");
        assert_eq!(item.op, "sale");
        let v: serde_json::Value = serde_json::from_str(&item.payload).unwrap();
        assert_eq!(v["id"].as_str(), Some(id.as_str()));
        assert_eq!(v["total_cents"].as_i64(), Some(200));
        assert!(v["created_at"].as_str().unwrap_or("").len() >= 19);
        clear_outbox(&[id]).unwrap();
    }

    #[test]
    fn sale_rejects_stale_price_without_changing_stock() {
        setup();
        let product_id = uuid::Uuid::new_v4().to_string();
        upsert_product(&product_id, "Price check", 250, 3).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let items = format!(
            r#"[{{"product_id":"{product_id}","unit_cents":100,"qty":1,"discount_cents":0}}]"#
        );
        assert!(record_sale(&id, &items, 100, "cash").is_err());
        let row = product_search(&product_id)
            .unwrap()
            .into_iter()
            .find(|p| p.id == product_id)
            .unwrap();
        assert_eq!(row.stock, 3);
    }

    #[test]
    fn failed_rows_are_quarantined_without_deletion() {
        setup();
        let member = uuid::Uuid::new_v4().to_string();
        upsert_member_cloud(&member, "Test member", "active", None).unwrap();
        let att_id = log_checkin(&member, 0.42).expect("log_checkin");
        for _ in 0..10 {
            bump_outbox_attempts(&[att_id.clone()]).unwrap();
        }
        assert!(
            outbox_row(&att_id).is_none(),
            "quarantined row must not block sync"
        );
        assert!(outbox_quarantined_count().unwrap() >= 1);
        let db = conn().lock().unwrap();
        let still_stored: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE id=?1",
                params![att_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still_stored, 1, "quarantined row must remain recoverable");
        drop(db);
        clear_outbox(&[att_id]).unwrap();
    }

    #[test]
    fn staff_cache_lock_verify_and_reconcile() {
        setup();
        let id = uuid::Uuid::new_v4().to_string();
        let hash = sls_core::auth::hash_password("1234");
        upsert_staff(&id, "frontdesk", &hash, "manager", true).expect("upsert");
        assert!(staff_locked().unwrap(), "active staff => Settings locked");
        assert_eq!(
            staff_verify("frontdesk", "1234").unwrap().as_deref(),
            Some("manager")
        );
        assert!(staff_verify("frontdesk", "9999").unwrap().is_none());
        assert!(staff_verify("ghost", "1234").unwrap().is_none());

        upsert_staff(&id, "frontdesk", &hash, "manager", false).unwrap();
        assert!(
            staff_verify("frontdesk", "1234").unwrap().is_none(),
            "inactive = locked out"
        );

        reconcile_staff(&[]).expect("reconcile"); // removed in dashboard → gone next pull
        assert!(
            !staff_locked().unwrap(),
            "empty cache => fresh install stays open"
        );
    }

    #[test]
    fn promos_cache_and_validation() {
        setup();
        upsert_promo("VIP20", 20.0, true).expect("upsert promo");
        // Case insensitive lookup
        assert_eq!(validate_promo("vip20").unwrap(), Some(20.0));
        assert_eq!(validate_promo("VIP20").unwrap(), Some(20.0));
        assert_eq!(validate_promo("UNKNOWN").unwrap(), None);

        // Deactivated promo returns None
        upsert_promo("VIP20", 20.0, false).expect("deactivate promo");
        assert_eq!(validate_promo("vip20").unwrap(), None);

        // Reactivate & reconcile
        upsert_promo("VIP20", 20.0, true).expect("reactivate");
        upsert_promo("WINTER50", 50.0, true).expect("upsert winter");
        reconcile_promos(&["VIP20".into()]).expect("reconcile");
        assert_eq!(validate_promo("vip20").unwrap(), Some(20.0));
        assert_eq!(
            validate_promo("winter50").unwrap(),
            None,
            "reconcile dropped winter50"
        );
    }

    #[test]
    fn member_lifecycle_guard_expired_and_frozen() {
        setup();
        let m_active = uuid::Uuid::new_v4().to_string();
        let m_expired = uuid::Uuid::new_v4().to_string();
        let m_frozen = uuid::Uuid::new_v4().to_string();

        let future = (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339();
        let past = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();

        upsert_member_cloud(&m_active, "Active Hunter", "active", Some(&future)).expect("active");
        upsert_member_cloud(&m_expired, "Expired Hunter", "active", Some(&past)).expect("expired");
        upsert_member_cloud(&m_frozen, "Frozen Hunter", "frozen", Some(&future)).expect("frozen");

        // Active checks in fine
        let check_res = log_checkin(&m_active, 0.98).expect("active checkin");
        assert_ne!(check_res, "expired");
        assert_ne!(check_res, "frozen");

        // Expired is denied with "expired"
        let exp_res = log_checkin(&m_expired, 0.98).expect("expired checkin");
        assert_eq!(exp_res, "expired");

        // Frozen is denied with "frozen"
        let frz_res = log_checkin(&m_frozen, 0.98).expect("frozen checkin");
        assert_eq!(frz_res, "frozen");

        // Manual override still passes regardless of status
        let man_res = log_manual_override(Some("Staff Override")).expect("manual override");
        assert_ne!(man_res, "expired");
    }
}
