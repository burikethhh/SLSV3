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

fn db_path() -> PathBuf {
    match DATA_DIR.get() {
        Some(dir) => dir.join("sls_local.sqlite"),
        None => PathBuf::from("sls_local.sqlite"), // tests / dev fallback
    }
}

pub fn conn() -> &'static Mutex<Connection> {
    DB.get_or_init(|| {
        let path = db_path();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        let c = Connection::open(&path).expect("open sqlite");
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
             CREATE INDEX IF NOT EXISTS idx_attendance_member_created ON attendance_logs(member_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);",
        )
        .expect("migrate");
        let _ = c.execute("ALTER TABLE attendance_logs ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'", []);
        Mutex::new(c)
    })
}

pub fn get_setting(key: &str) -> rusqlite::Result<Option<String>> {
    let db = conn().lock().unwrap();
    Ok(db.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0)).ok())
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
    let payload = serde_json::json!({
        "id": member_id,
        "full_name": full_name,
        "embedding_dim": vector.len() as i32,
        "face_vector": vector,
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
                latest_direction.as_deref().unwrap_or("in").eq_ignore_ascii_case("in")
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
        "SELECT id, op, payload, attempts, created_at FROM outbox ORDER BY created_at LIMIT ?1",
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
        db.execute("UPDATE outbox SET attempts = attempts + 1 WHERE id=?1", params![id])?;
    }
    Ok(())
}

/// Dead-letter: drop rows that kept failing past `max_attempts` so one
/// poisoned row can't wedge the queue forever. Count lands in the
/// `sync_dropped` setting (surfaced in Settings).
pub fn drop_outbox_dead(max_attempts: u32) -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let n = db.execute("DELETE FROM outbox WHERE attempts >= ?1", params![max_attempts])? as u32;
    if n > 0 {
        db.execute(
            "INSERT INTO settings(key, value) VALUES('sync_dropped', ?1)
             ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(?1 AS INTEGER) AS TEXT)",
            params![n.to_string()],
        )?;
    }
    Ok(n)
}

/// Cheap COUNT for the status bar — sync_pending must not pull full payloads
/// (member rows carry 512-float face vectors) just to show "3 pending sync".
pub fn outbox_count() -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let n: i64 = db.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))?;
    Ok(n as u32)
}

/// Kiosk retention: keep 90 days of local logs, cloud is source of truth.
/// Runs at boot; failures are ignored by the caller so the gate never blocks.
pub fn prune_old_logs(keep_days: u32) -> rusqlite::Result<u32> {
    let db = conn().lock().unwrap();
    let days = format!("-{} days", keep_days.max(7));
    let a = db.execute(
        "DELETE FROM attendance_logs WHERE created_at < datetime('now', ?1)",
        params![days],
    )? as u32;
    let _ = db.execute(
        "DELETE FROM sales WHERE created_at < datetime('now', ?1)",
        params![days],
    );
    Ok(a)
}

// ── Staff cache (terminal-PIN lock for Settings; pulled via sync) ─────────────

/// Upsert a staff row pulled from Supabase (`staff` table, PHC pin_hash —
/// verified locally by `sls_core::auth::verify_password`, same params).
pub fn upsert_staff(id: &str, username: &str, pin_hash: &str, role: &str, active: bool) -> rusqlite::Result<()> {
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
    let n: i64 = db.query_row("SELECT COUNT(*) FROM staff_cache WHERE active=1", [], |r| r.get(0))?;
    Ok(n > 0)
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
        .query_row("SELECT value FROM settings WHERE key=?1", params![lock_key], |r| {
            r.get::<_, String>(0)
        })
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
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
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
        let _ = db.execute("DELETE FROM settings WHERE key=?1 OR key=?2", params![lock_key, fail_key]);
        return Ok(Some(role));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let db = conn().lock().unwrap();
    let fails: i64 = db
        .query_row("SELECT value FROM settings WHERE key=?1", params![fail_key], |r| {
            r.get::<_, String>(0)
        })
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
    let db = conn().lock().unwrap();
    db.execute("INSERT OR REPLACE INTO license_cache(token, expires_at) VALUES(?1,?2)", params![token, expires_at])?;
    Ok(())
}

pub fn get_cached_license() -> rusqlite::Result<Option<String>> {
    let db = conn().lock().unwrap();
    Ok(db.query_row("SELECT token FROM license_cache LIMIT 1", [], |r| r.get(0)).ok())
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
    Ok(db.query_row("SELECT last_ok_unix FROM heartbeat LIMIT 1", [], |r| r.get(0)).unwrap_or(0))
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
pub fn record_sale(id: &str, items_json: &str, total_cents: i64, pay_method: &str) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    db.execute(
        "INSERT INTO sales(id, items_json, total_cents, pay_method) VALUES(?1,?2,?3,?4)",
        params![id, items_json, total_cents, pay_method],
    )?;
    let created_at: String = db
        .query_row("SELECT created_at FROM sales WHERE id=?1", params![id], |r| r.get(0))
        .unwrap_or_else(|_| "1970-01-01 00:00:00".into());
    let payload = serde_json::json!({
        "id": id,
        "items_json": items_json,
        "total_cents": total_cents,
        "pay_method": pay_method,
        "created_at": created_at,
    })
    .to_string();
    db.execute(
        "INSERT INTO outbox(id, op, payload) VALUES(?1,'sale',?2)
         ON CONFLICT(id) DO NOTHING",
        params![id, payload],
    )?;
    Ok(())
}

/// Product search: LIKE + LIMIT 50 (debounced 150ms in the webview).
/// Empty query returns the newest 50 (browse mode).
pub fn product_search(q: &str) -> rusqlite::Result<Vec<ProductRow>> {
    let db = conn().lock().unwrap();
    if q.trim().is_empty() {
        let mut st = db.prepare("SELECT id, name, price_cents, stock FROM products ORDER BY name LIMIT 50")?;
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
    Ok(ProductRow { id: r.get(0)?, name: r.get(1)?, price_cents: r.get(2)?, stock: r.get(3)? })
}

/// Member search for the POS "walk-in / lookup" box.
pub fn member_search(q: &str) -> rusqlite::Result<Vec<MemberRow>> {
    let db = conn().lock().unwrap();
    let like = format!("%{}%", q.trim());
    let mut st = db.prepare(
        "SELECT m.id, m.full_name,
                (SELECT al.direction FROM attendance_logs al WHERE al.member_id = m.id ORDER BY al.created_at DESC, al.rowid DESC LIMIT 1) as latest_dir
         FROM members m 
         WHERE m.full_name LIKE ?1 OR m.id LIKE ?1 
         ORDER BY m.full_name 
         LIMIT 20",
    )?;
    let rows = st
        .query_map(params![like], |r| {
            let latest_dir: Option<String> = r.get(2)?;
            let is_inside = latest_dir.as_deref().unwrap_or("out").eq_ignore_ascii_case("in");
            Ok(MemberRow { id: r.get(0)?, full_name: r.get(1)?, is_inside })
        })?
        .collect();
    rows
}

#[derive(serde::Serialize)]
pub struct MemberRow {
    pub id: String,
    pub full_name: String,
    pub is_inside: bool,
}

/// Recent sales for the POS history pane (local-first; cloud rows land via sync pull).
pub fn sale_list(limit: u32) -> rusqlite::Result<Vec<SaleRow>> {
    let db = conn().lock().unwrap();
    let mut st = db.prepare(
        "SELECT id, items_json, total_cents, pay_method, created_at FROM sales ORDER BY created_at DESC LIMIT ?1",
    )?;
    let rows = st.query_map(params![limit], |r| {
        Ok(SaleRow {
            id: r.get(0)?,
            items_json: r.get(1)?,
            total_cents: r.get(2)?,
            pay_method: r.get(3)?,
            created_at: r.get(4)?,
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
}

// ── Face vectors (face_enroll / face_match commands) ──────────────────────────

/// Persist an enrolled embedding (dim-agnostic JSON float array).
pub fn upsert_member_embedding(member_id: &str, full_name: &str, vector: &[f32]) -> rusqlite::Result<()> {
    let db = conn().lock().unwrap();
    let dim = vector.len() as i32;
    let json = serde_json::to_string(vector).map_err(|_| rusqlite::Error::InvalidParameterName("json".into()))?;
    db.execute(
        "INSERT INTO members(id, full_name, embedding_dim, face_vector) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, embedding_dim=excluded.embedding_dim, face_vector=excluded.face_vector",
        params![member_id, full_name, dim, json],
    )?;
    Ok(())
}

/// Load all enrolled vectors into the in-memory FaceStore at startup.
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
    fn dlq_drops_rows_past_cap_and_counts() {
        setup();
        let member = uuid::Uuid::new_v4().to_string();
        let att_id = log_checkin(&member, 0.42).expect("log_checkin");
        for _ in 0..10 {
            bump_outbox_attempts(&[att_id.clone()]).unwrap();
        }
        let dropped = drop_outbox_dead(10).expect("dlq");
        assert!(dropped >= 1);
        assert!(outbox_row(&att_id).is_none(), "dead row must be gone");
        let counter: u64 = get_setting("sync_dropped")
            .unwrap()
            .unwrap_or_else(|| "0".into())
            .parse()
            .unwrap();
        assert!(counter >= 1);
    }

    #[test]
    fn staff_cache_lock_verify_and_reconcile() {
        setup();
        let id = uuid::Uuid::new_v4().to_string();
        let hash = sls_core::auth::hash_password("1234");
        upsert_staff(&id, "frontdesk", &hash, "manager", true).expect("upsert");
        assert!(staff_locked().unwrap(), "active staff => Settings locked");
        assert_eq!(staff_verify("frontdesk", "1234").unwrap().as_deref(), Some("manager"));
        assert!(staff_verify("frontdesk", "9999").unwrap().is_none());
        assert!(staff_verify("ghost", "1234").unwrap().is_none());

        upsert_staff(&id, "frontdesk", &hash, "manager", false).unwrap();
        assert!(staff_verify("frontdesk", "1234").unwrap().is_none(), "inactive = locked out");

        reconcile_staff(&[]).expect("reconcile"); // removed in dashboard → gone next pull
        assert!(!staff_locked().unwrap(), "empty cache => fresh install stays open");
    }
}
