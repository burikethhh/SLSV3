//! SLS v3 Tauri shell — slim single-camera gate.
//! ~17 commands (v2 had 58). Default features = full gate flavor
//! (face-ort + hardware-serial + cloud-sync); `--no-default-features`
//! builds a UI+SQLite shell that degrades loudly, not silently.

pub mod account;
pub mod brightness_pipe;
pub mod db;
#[cfg(feature = "face-ort")]
pub mod face_pipeline;
pub mod face_store;
pub mod hw_serial;
pub mod license_verify;
pub mod recovery;
pub mod sync_worker;

use face_store::FaceStore;
use sls_core::pos::{checkout, CartLine, PayMethod};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Clone)]
struct OperatorSession {
    username: String,
    role: String,
    pin_hash: Option<String>,
    expires: Instant,
}
static STAFF_ROLE: OnceLock<parking_lot::RwLock<Option<OperatorSession>>> = OnceLock::new();
static GATE_UNLOCK_TICKET: OnceLock<parking_lot::Mutex<Option<Instant>>> = OnceLock::new();
static CONTEXT: OnceLock<parking_lot::RwLock<()>> = OnceLock::new();
static SCAN_TICKET: OnceLock<parking_lot::Mutex<Option<(String, Instant)>>> = OnceLock::new();

pub(crate) fn terminal_context() -> &'static parking_lot::RwLock<()> {
    CONTEXT.get_or_init(|| parking_lot::RwLock::new(()))
}

fn require_operational() -> Result<parking_lot::RwLockReadGuard<'static, ()>, String> {
    let context = terminal_context().read();
    if !account::connected() || !license_mgr().current_status().is_operable() {
        return Err(
            "Terminal locked. Connect your SLS owner account and an active subscription.".into(),
        );
    }
    let id = account::selected_gym().ok_or("No facility selected")?;
    if db::get_setting("gym_id")
        .map_err(|e| e.to_string())?
        .as_deref()
        != Some(&id)
        || license_mgr()
            .current_claims()
            .map(|claims| claims.gym_id.to_string())
            .as_deref()
            != Some(&id)
    {
        return Err("Facility identity mismatch. Reconnect your account.".into());
    }
    Ok(context)
}

fn reset_operator() {
    *staff_role().write() = None;
    *gate_unlock_ticket().lock() = None;
    *SCAN_TICKET
        .get_or_init(|| parking_lot::Mutex::new(None))
        .lock() = None;
}

fn reload_faces() {
    let mut next = FaceStore::edgeface();
    for (id, vector) in db::load_face_vectors().unwrap_or_default() {
        if vector.len() == 512 {
            next.upsert(id, vector);
        }
    }
    *face_store().write() = next;
}

fn staff_role() -> &'static parking_lot::RwLock<Option<OperatorSession>> {
    STAFF_ROLE.get_or_init(|| parking_lot::RwLock::new(None))
}

fn gate_unlock_ticket() -> &'static parking_lot::Mutex<Option<Instant>> {
    GATE_UNLOCK_TICKET.get_or_init(|| parking_lot::Mutex::new(None))
}

fn successful_checkin(result: &str) -> bool {
    uuid::Uuid::parse_str(result).is_ok()
}

fn require_privileged_terminal_session() -> Result<(), String> {
    let session = current_operator()
        .ok_or("Terminal manager PIN required. Use Account & Help to sign in as an operator.")?;
    if !matches!(session.role.as_str(), "manager" | "owner") {
        return Err("This action requires a terminal manager, not a cashier PIN".into());
    }
    Ok(())
}

fn current_operator() -> Option<OperatorSession> {
    let session = staff_role().read().clone()?;
    let identity = session
        .pin_hash
        .as_ref()
        .and_then(|_| db::staff_identity(&session.username).ok().flatten());
    if !operator_valid_at(&session, Instant::now(), identity) {
        let mut stored = staff_role().write();
        // Do not clear a newly authenticated session while checking the old one.
        if stored.as_ref().map(|s| s.expires) == Some(session.expires) {
            *stored = None;
        }
        return None;
    }
    Some(session)
}
fn operator_valid_at(
    session: &OperatorSession,
    now: Instant,
    identity: Option<(String, String)>,
) -> bool {
    now < session.expires
        && match &session.pin_hash {
            Some(hash) => identity == Some((session.role.clone(), hash.clone())),
            None => session.role == "owner",
        }
}
fn require_operator() -> Result<(), String> {
    current_operator().ok_or("Operator PIN required. Open Account & Help; the owner account connects the terminal, not the cashier session.".into()).map(|_| ())
}
pub(crate) fn grant_owner_setup() {
    *staff_role().write() = Some(OperatorSession {
        username: "Owner setup".into(),
        role: "owner".into(),
        pin_hash: None,
        expires: Instant::now() + Duration::from_secs(15 * 60),
    });
}
pub(crate) fn operator_status() -> serde_json::Value {
    current_operator().map(|session|serde_json::json!({"username":session.username,"role":session.role,"seconds_remaining":session.expires.saturating_duration_since(Instant::now()).as_secs()})).unwrap_or(serde_json::Value::Null)
}
#[tauri::command]
fn operator_sign_out() {
    reset_operator();
}

#[tauri::command(rename_all = "snake_case")]
fn pos_checkout(
    lines: Vec<CartLineDto>,
    tendered_cents: i64,
    method: String,
) -> Result<(i64, i64), String> {
    let _context = require_operational()?;
    require_operator()?;
    let pay = match method.as_str() {
        "card" => PayMethod::Card,
        "gcash" => PayMethod::Gcash,
        _ => PayMethod::Cash,
    };
    let cart: Vec<CartLine> = lines
        .iter()
        .map(|l| CartLine {
            product_id: l.product_id.clone(),
            unit_cents: l.unit_cents,
            qty: l.qty,
            discount_cents: l.discount_cents,
        })
        .collect();
    let (total, change) = checkout(&cart, tendered_cents, pay).map_err(|e| e.to_string())?;

    // Persist locally + enqueue outbox (sync_worker pushes op='sale').
    let id = uuid::Uuid::new_v4().to_string();
    let items_json = serde_json::to_string(&lines).map_err(|e| e.to_string())?;
    db::record_sale(&id, &items_json, total, &method).map_err(|e| e.to_string())?;
    Ok((total, change))
}

#[derive(serde::Deserialize, serde::Serialize)]
struct CartLineDto {
    product_id: String,
    unit_cents: i64,
    qty: u32,
    discount_cents: i64,
}

#[tauri::command(rename_all = "snake_case")]
fn gate_checkin(member_id: String, confidence: f32) -> Result<String, String> {
    let _context = require_operational()?;
    uuid::Uuid::parse_str(&member_id).map_err(|_| "Select a registered member")?;
    let recognized = SCAN_TICKET
        .get_or_init(|| parking_lot::Mutex::new(None))
        .lock()
        .take()
        .map(|(id, until)| id == member_id && Instant::now() <= until)
        .unwrap_or(false);
    if !recognized {
        require_privileged_terminal_session()?;
    }
    let result = db::log_checkin(&member_id, confidence).map_err(|e| e.to_string())?;
    if successful_checkin(&result) {
        *gate_unlock_ticket().lock() = Some(Instant::now() + Duration::from_secs(5));
    }
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
fn gate_checkout(member_id: String) -> Result<String, String> {
    let _context = require_operational()?;
    db::log_checkout(&member_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn gate_exit_button() -> Result<String, String> {
    let _context = terminal_context().read();
    #[cfg(feature = "hardware-serial")]
    {
        let _ = hw().unlock_door(3000);
    }
    db::log_exit_button().map_err(|e| e.to_string())
}

#[tauri::command]
fn hw_poll_buttons() -> Result<Vec<hw_serial::HardwareButtonEvent>, String> {
    #[cfg(feature = "hardware-serial")]
    {
        Ok(hw().drain_button_events())
    }
    #[cfg(not(feature = "hardware-serial"))]
    {
        Ok(vec![])
    }
}

#[tauri::command]
fn attendance_list(limit: Option<u32>) -> Result<Vec<db::AttendanceRow>, String> {
    let _context = require_operational()?;
    db::attendance_list(limit.unwrap_or(20)).map_err(|e| e.to_string())
}

// ── Face pipeline: canvas frame → YuNet+EdgeFace → match FaceStore ────────────

#[cfg(feature = "face-ort")]
#[tauri::command(rename_all = "snake_case")]
fn gate_scan_frame(data_url: String) -> Result<face_pipeline::GateScan, String> {
    let _context = require_operational()?;
    let img = face_pipeline::decode_base64_image(&data_url)?;
    let mut scan = face_pipeline::scan_frame(&img)?;
    if let Some(emb) = scan.embedding.as_ref() {
        let store = face_store().read();
        scan.matched = store.match_best(emb);
        // Lookalike path: score in [review, gate) → UI shows "ask staff"
        // with the score logged via gate_checkin confidence on manual approve.
        // Never opens the maglock on face alone.
        scan.review = if scan.matched.is_none() {
            store.best_candidate(emb)
        } else {
            None
        };
    }
    if let Some((id, _)) = &scan.matched {
        *SCAN_TICKET
            .get_or_init(|| parking_lot::Mutex::new(None))
            .lock() = Some((id.clone(), Instant::now() + Duration::from_secs(5)));
    }
    Ok(scan)
}

#[cfg(not(feature = "face-ort"))]
#[tauri::command(rename_all = "snake_case")]
fn gate_scan_frame(_data_url: String) -> Result<serde_json::Value, String> {
    Err("face-ort feature not enabled in this build".into())
}

// ── POS lookups (webview debounces 150ms, caps render 50) ─────────────────────

#[tauri::command]
fn product_search(q: String) -> Result<Vec<db::ProductRow>, String> {
    let _context = require_operational()?;
    db::product_search(&q).map_err(|e| e.to_string())
}

#[tauri::command]
fn member_search(q: String) -> Result<Vec<db::MemberRow>, String> {
    let _context = require_operational()?;
    db::member_search(&q).map_err(|e| e.to_string())
}

#[tauri::command]
fn sale_list(limit: Option<u32>) -> Result<Vec<db::SaleRow>, String> {
    let _context = require_operational()?;
    db::sale_list(limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command]
fn sales_summary() -> Result<serde_json::Value, String> {
    let _context = require_operational()?;
    db::sales_summary().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
fn pos_validate_promo(code: String) -> Result<Option<f64>, String> {
    let _context = require_operational()?;
    db::validate_promo(&code).map_err(|e| e.to_string())
}

/// Outbox depth for the status bar ("3 pending sync") — COUNT only, never
/// pulls payloads (face vectors are huge, status polls often).
#[tauri::command]
fn sync_pending() -> Result<u32, String> {
    let _context = terminal_context().read();
    Ok(db::outbox_count().unwrap_or(0))
}

// ── Face enroll/match (camera pipeline feeds embeddings; store is always on) ──

#[tauri::command(rename_all = "snake_case")]
fn face_enroll(
    member_id: String,
    full_name: String,
    embedding: Vec<f32>,
    plan_id: Option<String>,
) -> Result<String, String> {
    let _context = require_operational()?;
    require_operator()?;
    // v3 FaceStore is EdgeFace 512-d only (legacy 128-d rows are skipped on load).
    if embedding.len() != 512 {
        return Err(format!(
            "expected 512-d EdgeFace embedding, got {}",
            embedding.len()
        ));
    }
    // Quality gate before accepting (rejects flat/blurry captures).
    let q = sls_core::face::vector_quality(&embedding);
    if q < sls_core::face::min_quality_for_dim(embedding.len()) {
        return Err(format!(
            "embedding quality {q:.3} below gate {:.3} — retake photo",
            sls_core::face::min_quality_for_dim(embedding.len())
        ));
    }
    db::enroll_with_plan(
        &member_id,
        &full_name,
        &embedding,
        &plan_id
            .ok_or("Choose a membership plan; indefinite access is not issued by enrollment")?,
    )?;
    face_store().write().upsert(member_id, embedding);
    Ok("enrolled".into())
}

#[tauri::command]
fn face_match(embedding: Vec<f32>) -> Result<Option<(String, f32)>, String> {
    let _context = require_operational()?;
    // Wrong-dim probes reach `cosine`'s assert → would panic the command.
    if embedding.len() != 512 {
        return Err(format!(
            "expected 512-d EdgeFace embedding, got {}",
            embedding.len()
        ));
    }
    Ok(face_store().read().match_best(&embedding))
}

fn face_store() -> &'static parking_lot::RwLock<FaceStore> {
    static STORE: OnceLock<parking_lot::RwLock<FaceStore>> = OnceLock::new();
    STORE.get_or_init(|| {
        let mut s = FaceStore::edgeface();
        for (id, v) in db::load_face_vectors().unwrap_or_default() {
            // Tolerate dim mismatch from legacy rows (128-d) — skip, re-enroll needed.
            if v.len() == 512 {
                s.upsert(id, v);
            }
        }
        parking_lot::RwLock::new(s)
    })
}

#[tauri::command]
fn plans_list() -> Result<Vec<serde_json::Value>, String> {
    let _context = require_operational()?;
    db::plans_list().map_err(|e| e.to_string())
}

// Legacy IPC retained for a clear error instead of manual activation.

#[tauri::command(rename_all = "snake_case")]
fn license_apply(token: String, supabase_url: Option<String>) -> Result<String, String> {
    let _ = (token, supabase_url);
    Err("Manual license activation is disabled. Sign in with your SLS owner account.".into())
}

#[tauri::command]
fn settings_get(key: String) -> Result<Option<String>, String> {
    let _context = terminal_context().read();
    if ![
        "pending_restart",
        "sync_quarantined",
        "sync_dropped",
        "supabase_url",
    ]
    .contains(&key.as_str())
    {
        return Err("Setting is not available to the UI".into());
    }
    if key == "sync_quarantined" {
        return db::outbox_quarantined_count()
            .map(|n| Some(n.to_string()))
            .map_err(|e| e.to_string());
    }
    db::get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(key: String, value: String) -> Result<(), String> {
    let _ = (key, value);
    Err("Cloud configuration is managed by the account connection.".into())
}

#[cfg(test)]
fn allowed_supabase_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return false;
    }
    match (parsed.scheme(), parsed.host_str(), parsed.port()) {
        ("https", Some("tlfytevjhzcgrttcdipq.supabase.co"), None) => true,
        ("http", Some("localhost" | "127.0.0.1"), Some(port)) => port > 0,
        _ => false,
    }
}

#[cfg(test)]
mod terminal_guard_tests {
    use super::*;

    #[test]
    fn operator_expiry_deactivation_and_identity_changes_fail_closed() {
        let now = Instant::now();
        let session = OperatorSession {
            username: "cashier".into(),
            role: "staff".into(),
            pin_hash: Some("phc".into()),
            expires: now + Duration::from_secs(1800),
        };
        assert!(operator_valid_at(
            &session,
            now,
            Some(("staff".into(), "phc".into()))
        ));
        assert!(!operator_valid_at(
            &session,
            session.expires,
            Some(("staff".into(), "phc".into()))
        ));
        assert!(!operator_valid_at(&session, now, None));
        assert!(!operator_valid_at(
            &session,
            now,
            Some(("manager".into(), "phc".into()))
        ));
        assert!(!operator_valid_at(
            &session,
            now,
            Some(("staff".into(), "changed".into()))
        ));
        let owner = OperatorSession {
            username: "Owner setup".into(),
            role: "owner".into(),
            pin_hash: None,
            expires: now + Duration::from_secs(900),
        };
        assert!(operator_valid_at(&owner, now, None));
        assert!(!operator_valid_at(&owner, owner.expires, None));
    }

    #[test]
    fn fresh_terminal_rejects_every_operational_command() {
        // These calls must fail before opening a database, scanning, or touching
        // hardware. Never invoke the license-independent emergency exit here.
        assert!(pos_checkout(vec![], 0, "cash".into()).is_err());
        assert!(gate_checkin(uuid::Uuid::new_v4().to_string(), 0.99).is_err());
        assert!(gate_checkout("member".into()).is_err());
        assert!(hw_manual_override(None, None).is_err());
        assert!(hw_unlock(None).is_err());
        assert!(product_search("".into()).is_err());
        assert!(member_search("".into()).is_err());
        assert!(sale_list(None).is_err());
        assert!(attendance_list(None).is_err());
        assert!(pos_validate_promo("".into()).is_err());
        assert!(face_enroll("member".into(), "Name".into(), vec![], None).is_err());
        assert!(face_match(vec![]).is_err());
        assert!(license_apply("GPOS-reused-token".into(), None).is_err());
        assert!(settings_set("gym_id".into(), "other".into()).is_err());
    }

    #[test]
    fn only_persisted_checkins_authorize_gate_unlock() {
        assert!(successful_checkin("550e8400-e29b-41d4-a716-446655440000"));
        for rejected in ["ok", "cooldown", "expired", "frozen", "unlicensed"] {
            assert!(!successful_checkin(rejected));
        }
    }

    #[test]
    fn supabase_url_must_match_host_exactly() {
        assert!(allowed_supabase_url(
            "https://tlfytevjhzcgrttcdipq.supabase.co"
        ));
        assert!(allowed_supabase_url("http://localhost:54321"));
        assert!(!allowed_supabase_url("http://localhost:54321@evil.example"));
        assert!(!allowed_supabase_url(
            "https://tlfytevjhzcgrttcdipq.supabase.co.evil.example"
        ));
        assert!(!allowed_supabase_url("http://localhost:54321/redirect"));
    }
}

// ── Terminal-PIN lock: Settings (license/config) unlocks with a staff PIN ─────
// Locked only after staff rows arrive via sync — fresh installs must stay open
// so the first license can be applied. Architecture: staff = terminal-PIN only.

/// True = Settings requires a PIN (any active staff row exists locally).
#[tauri::command]
fn settings_lock_state() -> Result<bool, String> {
    Ok(!current_operator()
        .map(|s| matches!(s.role.as_str(), "manager" | "owner"))
        .unwrap_or(false))
}

/// Verify a terminal PIN against the local staff cache (Argon2id PHC).
/// Returns the staff role on success.
#[tauri::command]
fn staff_verify(username: String, pin: String) -> Result<String, String> {
    let _context = require_operational()?;
    let role = db::staff_verify(&username, &pin)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Invalid username or PIN".to_string())?;
    let identity = db::staff_identity(&username)
        .map_err(|e| e.to_string())?
        .ok_or("Staff account is inactive")?;
    *staff_role().write() = Some(OperatorSession {
        username: username.trim().to_lowercase(),
        role: role.clone(),
        pin_hash: Some(identity.1),
        expires: Instant::now() + Duration::from_secs(30 * 60),
    });
    Ok(role)
}

// ── Update check (updates-check Edge Fn; Settings shows a download link) ──────

#[cfg(feature = "cloud-sync")]
#[tauri::command]
async fn update_check() -> Result<serde_json::Value, String> {
    let url = db::get_setting("supabase_url")
        .ok()
        .flatten()
        .filter(|u| !u.trim().is_empty())
        .ok_or("Supabase URL not set in Settings")?;
    let endpoint = format!(
        "{}/functions/v1/updates-check?current={}&channel=stable",
        url.trim_end_matches('/'),
        env!("CARGO_PKG_VERSION")
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&endpoint)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("updates-check HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "cloud-sync"))]
#[tauri::command]
async fn update_check() -> Result<serde_json::Value, String> {
    Err("cloud-sync feature not enabled in this build".into())
}

// ── Auto-update (tauri-plugin-updater; signed NSIS via updates-check) ───────
// Boot installs silently in the background — offline-safe, any failure just
// logs and the gate keeps running. Completion is recorded in the
// `pending_restart` setting, which the gate + settings views surface as a
// restart banner. Manual path: Settings → Check → Install → Restart.

#[cfg(feature = "cloud-sync")]
async fn fetch_update(
    app: &tauri::AppHandle,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    app.updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(feature = "cloud-sync")]
async fn install_update(app: &tauri::AppHandle) -> Result<String, String> {
    let Some(update) = fetch_update(app).await? else {
        return Ok("already latest".into());
    };
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    db::set_setting("pending_restart", &version).map_err(|e| e.to_string())?;
    Ok(version)
}

/// Headless-safe probe: is there anything newer on the releases feed?
/// Downloads nothing — used by E2E + Settings.
#[cfg(feature = "cloud-sync")]
#[tauri::command]
async fn update_pending(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(fetch_update(&app).await?.map(|u| u.version))
}

#[cfg(not(feature = "cloud-sync"))]
#[tauri::command]
async fn update_pending() -> Result<Option<String>, String> {
    Err("cloud-sync feature not enabled in this build".into())
}

/// Check + download + install. On Windows the app exits during install (NSIS
/// limitation) — the caller restarts via `restart_app` after user confirmation.
#[cfg(feature = "cloud-sync")]
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<String, String> {
    require_privileged_terminal_session()?;
    install_update(&app).await
}

#[cfg(not(feature = "cloud-sync"))]
#[tauri::command]
async fn update_install() -> Result<String, String> {
    Err("cloud-sync feature not enabled in this build".into())
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(feature = "cloud-sync")]
fn start_update_task(app: tauri::AppHandle) {
    // tauri::async_runtime, NOT tokio::spawn: setup has no Tokio runtime
    // context yet and a bare spawn panics (exit 101) on boot.
    tauri::async_runtime::spawn(async move {
        // Let the gate come up first; a slow/failed check must never block boot.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        // Don't re-download while a restart is already pending.
        let pending = db::get_setting("pending_restart")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty());
        if pending.is_some() {
            return;
        }
        // A gate process must not silently exit for an installer. Discovery is
        // automatic; a manager explicitly schedules installation in Settings.
        match fetch_update(&app).await {
            Ok(Some(update)) => eprintln!(
                "update v{} available; manager installation required",
                update.version
            ),
            Ok(None) => {}
            Err(e) => eprintln!("auto-update check failed (offline?): {e}"),
        }
    });
}

#[cfg(feature = "cloud-sync")]
fn start_sync(url: String, token: String, gym_id: String) {
    stop_sync();
    let worker = sync_worker::SyncWorker {
        supabase_url: url,
        license_token: token,
        gym_id,
        license: license_mgr(),
        generation: sync_generation(),
    };
    *sync_task().lock() = Some(worker.start());
}

static SYNC_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn sync_generation() -> u64 {
    SYNC_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}
#[cfg(feature = "cloud-sync")]
fn sync_task() -> &'static parking_lot::Mutex<Option<tauri::async_runtime::JoinHandle<()>>> {
    static TASK: OnceLock<parking_lot::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> =
        OnceLock::new();
    TASK.get_or_init(Default::default)
}
fn stop_sync() {
    SYNC_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    #[cfg(feature = "cloud-sync")]
    if let Some(task) = sync_task().lock().take() {
        task.abort();
    }
}
#[cfg(feature = "cloud-sync")]
fn sync_running() -> bool {
    sync_task()
        .lock()
        .as_ref()
        .map(|t| !t.inner().is_finished())
        .unwrap_or(false)
}

#[tauri::command]
fn account_status() -> serde_json::Value {
    #[cfg(feature = "cloud-sync")]
    {
        account::status()
    }
    #[cfg(not(feature = "cloud-sync"))]
    {
        serde_json::json!({ "signed_in": false, "message": "Cloud support is not included in this build.", "license": { "type": "Unlicensed" } })
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn account_recover_legacy(confirmation: String) -> Result<serde_json::Value, String> {
    #[cfg(feature = "cloud-sync")]
    {
        account::recover_legacy(confirmation).await
    }
    #[cfg(not(feature = "cloud-sync"))]
    {
        let _ = confirmation;
        Err("Cloud account verification is required for recovery".into())
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn account_sign_in(email: String, password: String) -> Result<serde_json::Value, String> {
    #[cfg(feature = "cloud-sync")]
    {
        account::sign_in(email, password).await
    }
    #[cfg(not(feature = "cloud-sync"))]
    {
        let _ = (email, password);
        Err("Cloud support is required".into())
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn account_select_gym(
    gym_id: String,
    device_name: String,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "cloud-sync")]
    {
        account::select(gym_id, device_name).await
    }
    #[cfg(not(feature = "cloud-sync"))]
    {
        let _ = (gym_id, device_name);
        Err("Cloud support is required".into())
    }
}

#[tauri::command]
async fn account_refresh() -> Result<serde_json::Value, String> {
    #[cfg(feature = "cloud-sync")]
    {
        account::refresh().await
    }
    #[cfg(not(feature = "cloud-sync"))]
    {
        Err("Cloud support is required".into())
    }
}

#[tauri::command]
async fn account_sign_out() -> Result<(), String> {
    #[cfg(feature = "cloud-sync")]
    {
        account::sign_out().await
    }
    #[cfg(not(feature = "cloud-sync"))]
    {
        Ok(())
    }
}

#[tauri::command]
async fn account_verify_mfa(code: String) -> Result<serde_json::Value, String> {
    #[cfg(feature = "cloud-sync")]
    {
        account::verify_mfa(code).await
    }
    #[cfg(not(feature = "cloud-sync"))]
    {
        let _ = code;
        Err("Cloud support is required".into())
    }
}

/// CEO kill/revoke state visible locally (drives gate lock screen).
/// Returns the `LicenseStatus` enum serialized via serde tag (`{"type":"valid",...}`).
#[tauri::command]
fn license_status() -> Result<sls_core::license::LicenseStatus, String> {
    let _context = terminal_context().read();
    Ok(license_mgr().current_status())
}

static LICENSE: OnceLock<Arc<license_verify::LicenseManager>> = OnceLock::new();

fn license_mgr() -> Arc<license_verify::LicenseManager> {
    LICENSE
        .get_or_init(|| Arc::new(license_verify::LicenseManager::new(None)))
        .clone()
}

// ── Hardware — stubs without `hardware-serial` so generate_handler stays static ─

#[tauri::command(rename_all = "snake_case")]
fn hw_manual_override(
    operator: Option<String>,
    duration_ms: Option<u32>,
) -> Result<String, String> {
    let _context = require_operational()?;
    require_privileged_terminal_session()?;
    let op = operator.as_deref().unwrap_or("Kiosk Staff Button");
    db::log_manual_override(Some(op)).map_err(|e| e.to_string())?;
    #[cfg(feature = "hardware-serial")]
    {
        hw().unlock_door(duration_ms.unwrap_or(3000))
    }
    #[cfg(not(feature = "hardware-serial"))]
    {
        let _ = duration_ms;
        Ok("unlocked manual override (no hardware-serial)".into())
    }
}

#[cfg(feature = "hardware-serial")]
#[tauri::command(rename_all = "snake_case")]
fn hw_unlock(duration_ms: Option<u32>) -> Result<String, String> {
    let _context = require_operational()?;
    let allowed = gate_unlock_ticket()
        .lock()
        .take()
        .map(|expires| Instant::now() <= expires)
        .unwrap_or(false);
    if !allowed {
        return Err("gate unlock requires a successful licensed check-in".into());
    }
    hw().unlock_door(duration_ms.unwrap_or(3000))
}

#[cfg(not(feature = "hardware-serial"))]
#[tauri::command(rename_all = "snake_case")]
fn hw_unlock(_duration_ms: Option<u32>) -> Result<String, String> {
    let _context = require_operational()?;
    let allowed = gate_unlock_ticket()
        .lock()
        .take()
        .map(|expires| Instant::now() <= expires)
        .unwrap_or(false);
    if !allowed {
        return Err("gate unlock requires a successful licensed check-in".into());
    }
    Ok("unlocked (no hardware-serial)".into())
}

#[cfg(feature = "hardware-serial")]
#[tauri::command]
fn hw_connect(port: Option<String>) -> Result<String, String> {
    let _context = require_operational()?;
    require_privileged_terminal_session()?;
    let mgr = hw();
    if let Some(p) = port {
        return mgr.connect(&p, 115200);
    }
    let ports = mgr.find_esp_ports();
    let first = ports
        .first()
        .cloned()
        .ok_or("No ESP32-class serial port found")?;
    mgr.connect(&first, 115200)
}

#[cfg(not(feature = "hardware-serial"))]
#[tauri::command]
fn hw_connect(_port: Option<String>) -> Result<String, String> {
    Err("hardware-serial feature not enabled in this build".into())
}

#[cfg(feature = "hardware-serial")]
fn hw() -> Arc<hw_serial::HardwareManager> {
    static HW: OnceLock<Arc<hw_serial::HardwareManager>> = OnceLock::new();
    HW.get_or_init(|| Arc::new(hw_serial::HardwareManager::new()))
        .clone()
}

/// Gate UI polls this so a missing controller is visible instead of silent.
#[tauri::command]
fn hw_status() -> Result<serde_json::Value, String> {
    #[cfg(feature = "hardware-serial")]
    {
        let (connected, port) = hw().get_status();
        Ok(serde_json::json!({ "connected": connected, "port": port, "feature": true }))
    }
    #[cfg(not(feature = "hardware-serial"))]
    {
        Ok(serde_json::json!({ "connected": false, "port": null, "feature": false }))
    }
}

/// Background supervisor: auto-connect the VID-scored ESP32 port at boot and
/// reconnect within ~5s of a drop. Nothing else ever called `hw_connect`,
/// so without this the maglock could never open.
#[cfg(feature = "hardware-serial")]
fn spawn_hw_supervisor() {
    std::thread::spawn(|| {
        let mgr = hw();
        loop {
            if !mgr.get_status().0 {
                if let Some(port) = mgr.find_esp_ports().into_iter().next() {
                    if mgr.connect(&port, 115200).is_ok() {
                        continue;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

#[cfg(not(feature = "hardware-serial"))]
fn spawn_hw_supervisor() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Packaged launches have an unwritable/absent CWD — pin SQLite to
            // app data BEFORE anything touches conn().
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            db::init_data_dir(dir);
            // Warm FaceStore from SQLite before the first frame.
            let _ = face_store();
            // Restore cached license (offline-safe) + resume sync when enabled.
            #[cfg(feature = "cloud-sync")]
            account::boot();
            // Never prune the unscoped legacy database before recovery.
            if account::selected_gym().as_deref()
                == db::get_setting("gym_id").ok().flatten().as_deref()
                && account::selected_gym().is_some()
            {
                let _ = db::prune_old_logs(90);
            }
            spawn_hw_supervisor();
            #[cfg(feature = "cloud-sync")]
            {
                // Updater must never break the gate: init failure just logs.
                if let Err(e) = app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                {
                    eprintln!("updater plugin init failed: {e}");
                }
                start_update_task(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pos_checkout,
            gate_checkin,
            gate_checkout,
            gate_exit_button,
            hw_poll_buttons,
            attendance_list,
            gate_scan_frame,
            product_search,
            member_search,
            plans_list,
            sale_list,
            sales_summary,
            pos_validate_promo,
            sync_pending,
            face_enroll,
            face_match,
            license_apply,
            license_status,
            account_status,
            account_sign_in,
            account_select_gym,
            account_refresh,
            account_sign_out,
            account_verify_mfa,
            account_recover_legacy,
            settings_get,
            settings_set,
            settings_lock_state,
            staff_verify,
            operator_sign_out,
            update_check,
            update_pending,
            update_install,
            restart_app,
            hw_unlock,
            hw_manual_override,
            hw_connect,
            hw_status,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SLS v3");
}
