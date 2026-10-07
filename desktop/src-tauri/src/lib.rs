//! SLS v3 Tauri shell — slim single-camera gate.
//! ~17 commands (v2 had 58). Default features = full gate flavor
//! (face-ort + hardware-serial + cloud-sync); `--no-default-features`
//! builds a UI+SQLite shell that degrades loudly, not silently.

pub mod brightness_pipe;
pub mod db;
#[cfg(feature = "face-ort")]
pub mod face_pipeline;
pub mod face_store;
pub mod hw_serial;
pub mod license_verify;
pub mod sync_worker;

use face_store::FaceStore;
use sls_core::pos::{checkout, CartLine, PayMethod};
use std::sync::{Arc, OnceLock};
use tauri::Manager;

#[tauri::command(rename_all = "snake_case")]
fn pos_checkout(lines: Vec<CartLineDto>, tendered_cents: i64, method: String) -> Result<(i64, i64), String> {
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
    db::log_checkin(&member_id, confidence).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
fn gate_checkout(member_id: String) -> Result<String, String> {
    db::log_checkout(&member_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn gate_exit_button() -> Result<String, String> {
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
    db::attendance_list(limit.unwrap_or(20)).map_err(|e| e.to_string())
}

// ── Face pipeline: canvas frame → YuNet+EdgeFace → match FaceStore ────────────

#[cfg(feature = "face-ort")]
#[tauri::command(rename_all = "snake_case")]
fn gate_scan_frame(data_url: String) -> Result<face_pipeline::GateScan, String> {
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
    db::product_search(&q).map_err(|e| e.to_string())
}

#[tauri::command]
fn member_search(q: String) -> Result<Vec<db::MemberRow>, String> {
    db::member_search(&q).map_err(|e| e.to_string())
}

#[tauri::command]
fn sale_list(limit: Option<u32>) -> Result<Vec<db::SaleRow>, String> {
    db::sale_list(limit.unwrap_or(50)).map_err(|e| e.to_string())
}

/// Outbox depth for the status bar ("3 pending sync") — COUNT only, never
/// pulls payloads (face vectors are huge, status polls often).
#[tauri::command]
fn sync_pending() -> Result<u32, String> {
    Ok(db::outbox_count().unwrap_or(0))
}

// ── Face enroll/match (camera pipeline feeds embeddings; store is always on) ──

#[tauri::command(rename_all = "snake_case")]
fn face_enroll(member_id: String, full_name: String, embedding: Vec<f32>) -> Result<String, String> {
    // v3 FaceStore is EdgeFace 512-d only (legacy 128-d rows are skipped on load).
    if embedding.len() != 512 {
        return Err(format!("expected 512-d EdgeFace embedding, got {}", embedding.len()));
    }
    // Quality gate before accepting (rejects flat/blurry captures).
    let q = sls_core::face::vector_quality(&embedding);
    if q < sls_core::face::min_quality_for_dim(embedding.len()) {
        return Err(format!("embedding quality {q:.3} below gate {:.3} — retake photo", sls_core::face::min_quality_for_dim(embedding.len())));
    }
    db::upsert_member_embedding(&member_id, &full_name, &embedding).map_err(|e| e.to_string())?;
    db::enqueue_member(&member_id, &full_name, &embedding).map_err(|e| e.to_string())?;
    face_store().write().upsert(member_id, embedding);
    Ok("enrolled".into())
}

#[tauri::command]
fn face_match(embedding: Vec<f32>) -> Result<Option<(String, f32)>, String> {
    // Wrong-dim probes reach `cosine`'s assert → would panic the command.
    if embedding.len() != 512 {
        return Err(format!("expected 512-d EdgeFace embedding, got {}", embedding.len()));
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

// ── Apply a license key: fail-closed verify → cache → start sync worker ───────

#[tauri::command(rename_all = "snake_case")]
fn license_apply(token: String, supabase_url: Option<String>) -> Result<String, String> {
    let mgr = license_mgr();
    let status = mgr.verify_and_apply(&token)?;
    let claims = mgr.current_claims().ok_or("license not active")?;
    db::cache_license(&token, &claims.expires_at.to_rfc3339()).map_err(|e| e.to_string())?;
    // Manual apply = human proved key possession → counts as the heartbeat
    // (recovery path when the 7-day window lapsed while offline).
    let _ = db::heartbeat_ok();

    let url = supabase_url
        .filter(|u| !u.trim().is_empty())
        .or_else(|| db::get_setting("supabase_url").ok().flatten());
    if let Some(url) = url {
        let _ = db::set_setting("supabase_url", &url);
        #[cfg(feature = "cloud-sync")]
        start_sync(url, token, claims.gym_id.to_string());
    }

    Ok(format!("{status:?}"))
}

#[tauri::command]
fn settings_get(key: String) -> Result<Option<String>, String> {
    db::get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(key: String, value: String) -> Result<(), String> {
    db::set_setting(&key, &value).map_err(|e| e.to_string())
}

// ── Terminal-PIN lock: Settings (license/config) unlocks with a staff PIN ─────
// Locked only after staff rows arrive via sync — fresh installs must stay open
// so the first license can be applied. Architecture: staff = terminal-PIN only.

/// True = Settings requires a PIN (any active staff row exists locally).
#[tauri::command]
fn settings_lock_state() -> Result<bool, String> {
    db::staff_locked().map_err(|e| e.to_string())
}

/// Verify a terminal PIN against the local staff cache (Argon2id PHC).
/// Returns the staff role on success.
#[tauri::command]
fn staff_verify(username: String, pin: String) -> Result<String, String> {
    db::staff_verify(&username, &pin)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Invalid username or PIN".to_string())
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
    let resp = client.get(&endpoint).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("updates-check HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
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
async fn fetch_update(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
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
        match install_update(&app).await {
            Ok(v) if v != "already latest" => {
                eprintln!("auto-update installed v{v} — restart pending")
            }
            Ok(_) => {
                let _ = db::set_setting("pending_restart", "");
            }
            Err(e) => eprintln!("auto-update check failed (offline?): {e}"),
        }
    });
}

#[cfg(feature = "cloud-sync")]
fn start_sync(url: String, token: String, gym_id: String) {
    let worker = sync_worker::SyncWorker {
        supabase_url: url,
        license_token: token,
        gym_id,
        license: license_mgr(),
    };
    worker.start();
}

/// Apply the cached license on startup — runs with or without `cloud-sync`
/// so an offline build survives a restart without re-pasting the key.
/// With `cloud-sync`, also resumes the outbox/kill-switch worker.
/// Fail-closed: heartbeat older than 7d (or a clock rolled back past the
/// tamper grace) refuses the cached license — a human must re-apply the key,
/// which heartbeats on success.
fn boot_license() {
    let Ok(Some(token)) = db::get_cached_license() else { return };
    let now = chrono::Utc::now().timestamp();
    let last = db::last_heartbeat().unwrap_or(0);
    if license_verify::is_heartbeat_expired(now, last) || license_verify::is_clock_tampered(now, last) {
        return;
    }
    let Ok(claims) = license_verify::verify_token(&token, license_verify::EMBEDDED_PUBLIC_KEY_PEM) else { return };
    let _ = license_mgr().verify_and_apply(&token);
    #[cfg(feature = "cloud-sync")]
    if let Ok(Some(url)) = db::get_setting("supabase_url") {
        start_sync(url, token, claims.gym_id.to_string());
    }
    #[cfg(not(feature = "cloud-sync"))]
    let _ = (&token, &claims);
}

/// CEO kill/revoke state visible locally (drives gate lock screen).
/// Returns the `LicenseStatus` enum serialized via serde tag (`{"type":"valid",...}`).
#[tauri::command]
fn license_status() -> Result<sls_core::license::LicenseStatus, String> {
    Ok(license_mgr().current_status())
}

static LICENSE: OnceLock<Arc<license_verify::LicenseManager>> = OnceLock::new();

fn license_mgr() -> Arc<license_verify::LicenseManager> {
    LICENSE.get_or_init(|| Arc::new(license_verify::LicenseManager::new(None))).clone()
}

// ── Hardware — stubs without `hardware-serial` so generate_handler stays static ─

#[tauri::command(rename_all = "snake_case")]
fn hw_manual_override(operator: Option<String>, duration_ms: Option<u32>) -> Result<String, String> {
    let op = operator.as_deref().unwrap_or("Kiosk Staff Button");
    let _ = db::log_manual_override(Some(op));
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
    hw().unlock_door(duration_ms.unwrap_or(3000))
}

#[cfg(not(feature = "hardware-serial"))]
#[tauri::command(rename_all = "snake_case")]
fn hw_unlock(_duration_ms: Option<u32>) -> Result<String, String> {
    Ok("unlocked (no hardware-serial)".into())
}

#[cfg(feature = "hardware-serial")]
#[tauri::command]
fn hw_connect(port: Option<String>) -> Result<String, String> {
    let mgr = hw();
    if let Some(p) = port {
        return mgr.connect(&p, 115200);
    }
    let ports = mgr.find_esp_ports();
    let first = ports.first().cloned().ok_or("No ESP32-class serial port found")?;
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
    HW.get_or_init(|| Arc::new(hw_serial::HardwareManager::new())).clone()
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
            // Kiosk retention (90d local, cloud is truth) — never blocks boot.
            let _ = db::prune_old_logs(90);
            // Restore cached license (offline-safe) + resume sync when enabled.
            boot_license();
            spawn_hw_supervisor();
            #[cfg(feature = "cloud-sync")]
            {
                // Updater must never break the gate: init failure just logs.
                if let Err(e) = app.handle().plugin(tauri_plugin_updater::Builder::new().build()) {
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
            sale_list,
            sync_pending,
            face_enroll,
            face_match,
            license_apply,
            license_status,
            settings_get,
            settings_set,
            settings_lock_state,
            staff_verify,
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
