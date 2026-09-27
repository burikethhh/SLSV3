//! Full terminal sync worker (recycled from orig `sync.rs`, Supabase target).
//! Backoff 5→15→30→60s, idle kill-switch poll every 6th tick (~30s),
//! revoke on 401/403 OR `remote_disabled` (gyms.disabled / licenses.revoked).
//! Push = outbox rows to the `sync` Edge Function (license-token auth);
//! pull = catalog upsert + delete-reconcile against `product_ids`.
//!
//! Kill-switch e2e: dashboard kill → next poll returns remote_disabled=true →
//! license_manager.revoke() + clear_cached_license() → worker EXITS (a revoked
//! token must not keep hammering the endpoint) → gate locks, UI Unlicensed.
//!
//! Heartbeat = only after a real 2xx (idle skips must NOT refresh the 7-day
//! window). Dead-letter: outbox rows with attempts ≥ OUTBOX_DLQ_ATTEMPTS are
//! dropped into the `sync_dropped` setting so one poisoned row can't wedge.

#[cfg(feature = "cloud-sync")]
pub use inner::*;

#[cfg(feature = "cloud-sync")]
mod inner {
    use crate::db;
    use crate::license_verify::LicenseManager;
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::Duration;

    /// Give up on an outbox row after this many failed pushes (dead-letter).
    pub const OUTBOX_DLQ_ATTEMPTS: u32 = 10;
    /// Mirror of the sync fn PRODUCT_IDS_CAP — at the cap the list may be
    /// truncated, so reconcile must be skipped rather than delete real stock.
    pub const PRODUCT_IDS_LIMIT: u64 = 5000;
    /// Mirror of the sync fn staff limit (100) — same truncated-list guard.
    pub const STAFF_PULL_LIMIT: usize = 100;

    /// Backoff stage from consecutive failures (recycled 1:1 from orig).
    pub fn backoff_secs(consecutive_failures: u32) -> u64 {
        match consecutive_failures {
            0 => 5,
            1 => 15,
            2 => 30,
            _ => 60,
        }
    }

    /// Idle terminals (nothing to upload) still poll the kill-switch, but only
    /// every 6th tick (~30s) so we don't hammer the cloud with empty pushes.
    pub fn should_idle_poll(idle_ticks: u32, has_bearer: bool) -> bool {
        has_bearer && idle_ticks % 6 == 1
    }

    /// Revoke decision: 401/403 (bad/rotated token) or explicit remote kill.
    pub fn should_revoke(http_status: u16, remote_disabled: bool) -> bool {
        remote_disabled || http_status == 401 || http_status == 403
    }

    pub struct SyncWorker {
        pub supabase_url: String,
        pub license_token: String,
        pub gym_id: String,
        pub license: Arc<LicenseManager>,
    }

    impl SyncWorker {
        /// Spawn the background loop on Tauri's async runtime.
        pub fn start(self) {
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(8))
                    .build()
                    .unwrap_or_default();
                let endpoint = format!("{}/functions/v1/sync", self.supabase_url.trim_end_matches('/'));

                let mut failures: u32 = 0;
                let mut idle_ticks: u32 = 0;

                loop {
                    tokio::time::sleep(Duration::from_secs(backoff_secs(failures))).await;

                    let has_bearer = db::get_cached_license().ok().flatten().is_some();
                    let batch = db::take_outbox(100).unwrap_or_default();
                    let is_idle = batch.is_empty();

                    if is_idle {
                        idle_ticks = idle_ticks.saturating_add(1);
                        if !should_idle_poll(idle_ticks, has_bearer) {
                            // Skip network — and do NOT touch the heartbeat:
                            // only a real 2xx refreshes the 7-day window.
                            continue;
                        }
                    } else {
                        idle_ticks = 0;
                    }

                    let payload = serde_json::json!({
                        "attendance": batch.iter().filter(|b| b.op == "attendance").map(|b| {
                            serde_json::from_str::<serde_json::Value>(&b.payload).unwrap_or_default()
                        }).collect::<Vec<_>>(),
                        "sales": batch.iter().filter(|b| b.op == "sale").map(|b| {
                            serde_json::from_str::<serde_json::Value>(&b.payload).unwrap_or_default()
                        }).collect::<Vec<_>>(),
                        "members": batch.iter().filter(|b| b.op == "member").map(|b| {
                            serde_json::from_str::<serde_json::Value>(&b.payload).unwrap_or_default()
                        }).collect::<Vec<_>>(),
                    });

                    let resp = client
                        .post(&endpoint)
                        .bearer_auth(&self.license_token)
                        .json(&payload)
                        .send()
                        .await;

                    match resp {
                        Ok(r) => {
                            let status = r.status().as_u16();
                            let body = r.json::<serde_json::Value>().await.unwrap_or_default();
                            let remote_disabled =
                                body.get("remote_disabled").and_then(|d| d.as_bool()).unwrap_or(false);

                            if should_revoke(status, remote_disabled) {
                                // Kill-switch e2e landed: lock terminal and STOP —
                                // a revoked token must not keep hitting the endpoint.
                                self.license.revoke();
                                let _ = db::clear_cached_license();
                                return;
                            }

                            if status >= 200 && status < 300 {
                                failures = 0;
                                let _ = db::heartbeat_ok();
                                let ids: Vec<String> = batch.iter().map(|b| b.id.clone()).collect();
                                let _ = db::clear_outbox(&ids);
                                // Ingest pull: upsert catalog detail, then delete
                                // locals the owner removed (product_ids = full list).
                                if let Some(products) = body.get("products").and_then(|p| p.as_array()) {
                                    for p in products {
                                        let _ = db::upsert_product(
                                            p["id"].as_str().unwrap_or_default(),
                                            p["name"].as_str().unwrap_or_default(),
                                            p["price_cents"].as_i64().unwrap_or(0),
                                            p["stock"].as_i64().unwrap_or(0) as i32,
                                        );
                                    }
                                }
                                if let Some(id_list) = body.get("product_ids").and_then(|p| p.as_array()) {
                                    let present: HashSet<String> = id_list
                                        .iter()
                                        .filter_map(|v| v.as_str().map(str::to_string))
                                        .collect();
                                    // Cap hit = list possibly truncated → skip
                                    // reconcile rather than wrongly deleting stock.
                                    if (present.len() as u64) < PRODUCT_IDS_LIMIT {
                                        let keep: Vec<String> = present.into_iter().collect();
                                        let _ = db::reconcile_products(&keep);
                                    }
                                }
                                // Staff PIN cache (Settings lock) + reconcile.
                                if let Some(rows) = body.get("staff").and_then(|s| s.as_array()) {
                                    let mut present: Vec<String> = Vec::new();
                                    for r in rows {
                                        let o = r.as_object();
                                        let (Some(id), Some(username), Some(pin_hash)) = (
                                            o.and_then(|x| x.get("id")).and_then(|v| v.as_str()),
                                            o.and_then(|x| x.get("username")).and_then(|v| v.as_str()),
                                            o.and_then(|x| x.get("pin_hash")).and_then(|v| v.as_str()),
                                        ) else { continue };
                                        let role = o.and_then(|x| x.get("role")).and_then(|v| v.as_str()).unwrap_or("staff");
                                        let active = o.and_then(|x| x.get("active")).and_then(|v| v.as_bool()).unwrap_or(true);
                                        let _ = db::upsert_staff(id, username, pin_hash, role, active);
                                        present.push(id.to_string());
                                    }
                                    if present.len() < STAFF_PULL_LIMIT {
                                        let _ = db::reconcile_staff(&present);
                                    }
                                }
                            } else {
                                failures = failures.saturating_add(1);
                                let ids: Vec<String> = batch.iter().map(|b| b.id.clone()).collect();
                                let _ = db::bump_outbox_attempts(&ids);
                                let _ = db::drop_outbox_dead(OUTBOX_DLQ_ATTEMPTS);
                            }
                        }
                        Err(_) => {
                            failures = failures.saturating_add(1);
                            let ids: Vec<String> = batch.iter().map(|b| b.id.clone()).collect();
                            let _ = db::bump_outbox_attempts(&ids);
                            let _ = db::drop_outbox_dead(OUTBOX_DLQ_ATTEMPTS);
                        }
                    }
                }
            });
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn backoff_stages() {
            assert_eq!(backoff_secs(0), 5);
            assert_eq!(backoff_secs(1), 15);
            assert_eq!(backoff_secs(2), 30);
            assert_eq!(backoff_secs(99), 60);
        }

        #[test]
        fn idle_poll_every_6th() {
            // 1 % 6 == 1 → first idle tick polls (kill-switch check soon after idle)
            assert!(should_idle_poll(1, true));
            assert!(!should_idle_poll(2, true));
            assert!(should_idle_poll(7, true)); // 7 % 6 == 1 → next poll
            assert!(!should_idle_poll(7, false)); // no bearer → never
        }

        #[test]
        fn revoke_triggers() {
            assert!(should_revoke(401, false));
            assert!(should_revoke(403, false));
            assert!(should_revoke(200, true)); // remote kill with healthy HTTP
            assert!(!should_revoke(200, false));
        }
    }
}
