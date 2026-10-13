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
//! window). Failed rows remain on disk; after the retry cap they are quarantined
//! for manual recovery rather than silently deleted.

#[cfg(feature = "cloud-sync")]
pub use inner::*;

#[cfg(feature = "cloud-sync")]
mod inner {
    use crate::db;
    use crate::license_verify::LicenseManager;
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::Duration;

    /// Quarantine a failed outbox row after this many attempts.
    pub const OUTBOX_DLQ_ATTEMPTS: u32 = 10;
    const PUSH_BODY_CAP: usize = 512 * 1024 - 1024;

    // Count encoded UTF-8 bytes, not rows: 100 face vectors can exceed the
    // server's 512 KiB limit. Deferred records keep their original IDs/attempts.
    fn prepare_push(
        batch: &[db::OutboxItem],
        cursor: Option<String>,
    ) -> (serde_json::Value, HashSet<String>, Vec<String>) {
        let mut payload =
            serde_json::json!({"face_since":cursor,"attendance":[],"sales":[],"members":[]});
        let mut size = serde_json::to_vec(&payload).unwrap().len();
        let base = size;
        let mut included = HashSet::new();
        let mut rejected = Vec::new();
        for item in batch {
            let field = match item.op.as_str() {
                "attendance" => "attendance",
                "sale" => "sales",
                "member" => "members",
                _ => {
                    rejected.push(item.id.clone());
                    continue;
                }
            };
            let row = match serde_json::from_str::<serde_json::Value>(&item.payload) {
                Ok(row) if row["id"].as_str() == Some(item.id.as_str()) => row,
                _ => {
                    rejected.push(item.id.clone());
                    continue;
                }
            };
            let bytes = serde_json::to_vec(&row).unwrap().len() + 1;
            if base + bytes > PUSH_BODY_CAP {
                rejected.push(item.id.clone());
                continue;
            }
            if size + bytes > PUSH_BODY_CAP {
                continue;
            }
            size += bytes;
            payload[field].as_array_mut().unwrap().push(row);
            included.insert(item.id.clone());
        }
        (payload, included, rejected)
    }

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
        pub generation: u64,
    }

    impl SyncWorker {
        /// Spawn the background loop on Tauri's async runtime.
        pub fn start(self) -> tauri::async_runtime::JoinHandle<()> {
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(8))
                    .build()
                    .unwrap_or_default();
                let endpoint = format!(
                    "{}/functions/v1/sync",
                    self.supabase_url.trim_end_matches('/')
                );

                let mut failures: u32 = 0;
                let mut idle_ticks: u32 = 0;

                loop {
                    tokio::time::sleep(Duration::from_secs(backoff_secs(failures))).await;

                    let (has_bearer, mut batch, face_cursor) = {
                        let _context = crate::terminal_context().read();
                        if self.generation != crate::sync_generation() {
                            return;
                        }
                        if db::get_setting("gym_id").ok().flatten().as_deref() != Some(&self.gym_id)
                        {
                            return;
                        }
                        let active = db::get_cached_license().ok().flatten().as_deref()
                            == Some(&self.license_token);
                        if !active {
                            return;
                        }
                        (
                            active,
                            db::take_outbox(100).unwrap_or_default(),
                            db::get_setting("face_sync_cursor").ok().flatten(),
                        )
                    };
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

                    let (payload, included, rejected) = prepare_push(&batch, face_cursor);
                    if !rejected.is_empty() {
                        let _context = crate::terminal_context().read();
                        if self.generation != crate::sync_generation() {
                            return;
                        }
                        // Local malformed/individually oversized rows are permanent
                        // failures, not network failures; retain them for recovery.
                        let _ = db::bump_outbox_attempts(&rejected);
                    }
                    batch.retain(|row| included.contains(&row.id));

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
                            let _context = crate::terminal_context().read();
                            if self.generation != crate::sync_generation() {
                                return;
                            }
                            let remote_disabled = body
                                .get("remote_disabled")
                                .and_then(|d| d.as_bool())
                                .unwrap_or(false);

                            if should_revoke(status, remote_disabled) {
                                // Kill-switch e2e landed: lock terminal and STOP —
                                // a revoked token must not keep hitting the endpoint.
                                self.license.revoke();
                                let _ = db::clear_cached_license();
                                return;
                            }

                            if status >= 200 && status < 300 {
                                if !valid_sync_response(&body) {
                                    failures = failures.saturating_add(1);
                                    continue;
                                }
                                if (chrono::Utc::now().timestamp_millis()
                                    - body["server_time"].as_i64().unwrap_or(0))
                                .abs()
                                    > 120_000
                                {
                                    failures = failures.saturating_add(1);
                                    continue;
                                }
                                failures = 0;
                                let _ = db::heartbeat_ok();
                                let batch_ids: HashSet<&str> =
                                    batch.iter().map(|b| b.id.as_str()).collect();
                                let accepted: Vec<String> = body
                                    .get("accepted_ids")
                                    .and_then(|v| v.as_array())
                                    .map(|v| {
                                        v.iter()
                                            .filter_map(|id| id.as_str())
                                            .filter(|id| batch_ids.contains(*id))
                                            .map(str::to_string)
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let _ = db::clear_outbox(&accepted);
                                let accepted_set: HashSet<&str> =
                                    accepted.iter().map(String::as_str).collect();
                                let failed: HashSet<&str> = body["failed_ids"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|v| v.as_str())
                                    .collect();
                                let pending: Vec<String> = batch
                                    .iter()
                                    .filter(|b| {
                                        !accepted_set.contains(b.id.as_str())
                                            && failed.contains(b.id.as_str())
                                    })
                                    .map(|b| b.id.clone())
                                    .collect();
                                if !pending.is_empty() {
                                    failures = failures.saturating_add(1);
                                    let _ = db::bump_outbox_attempts(&pending);
                                }
                                // Ingest pull: upsert catalog detail, then delete
                                // locals the owner removed (product_ids = full list).
                                // Remote stock is only authoritative once every
                                // completed local sale has been acknowledged.
                                // Otherwise a pull could restore sold units.
                                let catalog_safe =
                                    db::unsynced_sales_count().map(|n| n == 0).unwrap_or(false);
                                if let Some(products) = body
                                    .get("products")
                                    .and_then(|p| p.as_array())
                                    .filter(|_| catalog_safe)
                                {
                                    for p in products {
                                        let _ = db::upsert_product(
                                            p["id"].as_str().unwrap_or_default(),
                                            p["name"].as_str().unwrap_or_default(),
                                            p["price_cents"].as_i64().unwrap_or(0),
                                            p["stock"].as_i64().unwrap_or(0) as i32,
                                        );
                                    }
                                }
                                if let Some(id_list) = body
                                    .get("product_ids")
                                    .and_then(|p| p.as_array())
                                    .filter(|_| catalog_safe)
                                {
                                    let present: HashSet<String> = id_list
                                        .iter()
                                        .filter_map(|v| v.as_str().map(str::to_string))
                                        .collect();
                                    // Cap hit = list possibly truncated → skip
                                    // reconcile rather than wrongly deleting stock.
                                    if body["catalog_complete"] == true {
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
                                            o.and_then(|x| x.get("username"))
                                                .and_then(|v| v.as_str()),
                                            o.and_then(|x| x.get("pin_hash"))
                                                .and_then(|v| v.as_str()),
                                        ) else {
                                            continue;
                                        };
                                        let role = o
                                            .and_then(|x| x.get("role"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("staff");
                                        let active = o
                                            .and_then(|x| x.get("active"))
                                            .and_then(|v| v.as_bool())
                                            .unwrap_or(true);
                                        let _ =
                                            db::upsert_staff(id, username, pin_hash, role, active);
                                        present.push(id.to_string());
                                    }
                                    if body["catalog_complete"] == true {
                                        let _ = db::reconcile_staff(&present);
                                    }
                                }
                                // Promos cache + reconcile.
                                if let Some(rows) = body.get("promos").and_then(|p| p.as_array()) {
                                    let mut present: Vec<String> = Vec::new();
                                    for r in rows {
                                        let o = r.as_object();
                                        let (Some(code), Some(pct_off)) = (
                                            o.and_then(|x| x.get("code")).and_then(|v| v.as_str()),
                                            o.and_then(|x| x.get("pct_off"))
                                                .and_then(|v| v.as_f64()),
                                        ) else {
                                            continue;
                                        };
                                        let active = o
                                            .and_then(|x| x.get("active"))
                                            .and_then(|v| v.as_bool())
                                            .unwrap_or(true);
                                        let _ = db::upsert_promo(code, pct_off, active);
                                        if active {
                                            present.push(code.to_string());
                                        }
                                    }
                                    let _ = db::reconcile_promos(&present);
                                }
                                if db::apply_member_snapshot(
                                    body["members"].as_array().unwrap(),
                                    body["face_changes"].as_array().unwrap(),
                                    body["plans"].as_array().unwrap(),
                                    body["face_cursor"].as_str().unwrap(),
                                )
                                .is_ok()
                                {
                                    crate::reload_faces();
                                } else {
                                    failures = failures.saturating_add(1);
                                }
                            } else {
                                failures = failures.saturating_add(1);
                            }
                        }
                        Err(_) => {
                            let _context = crate::terminal_context().read();
                            if self.generation != crate::sync_generation() {
                                return;
                            }
                            failures = failures.saturating_add(1);
                        }
                    }
                }
            })
        }
    }

    pub fn valid_sync_response(body: &serde_json::Value) -> bool {
        body["remote_disabled"] == false
            && body["catalog_complete"] == true
            && body["face_cursor"].as_str().is_some()
            && body["server_time"].as_i64().is_some()
            && [
                "accepted_ids",
                "products",
                "product_ids",
                "staff",
                "members",
                "promos",
                "plans",
                "face_changes",
                "failed_ids",
            ]
            .iter()
            .all(|key| body[*key].is_array())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn byte_bounded_face_batches_preserve_all_deferred_rows() {
            let mut rows = Vec::new();
            for _ in 0..100 {
                let id = uuid::Uuid::new_v4().to_string();
                let payload=serde_json::json!({"id":id,"full_name":"Recovery member","face_vector":vec![0.123456789_f64;512]}).to_string();
                rows.push(db::OutboxItem {
                    id,
                    op: "member".into(),
                    payload,
                    attempts: 0,
                    created_at: String::new(),
                });
            }
            let (first, ids, rejected) = prepare_push(&rows, None);
            assert!(serde_json::to_vec(&first).unwrap().len() <= PUSH_BODY_CAP);
            assert!(!ids.is_empty() && ids.len() < 100);
            assert!(rejected.is_empty());
            rows.retain(|row| !ids.contains(&row.id));
            let (second, next, rejected) = prepare_push(&rows, None);
            assert_eq!(next.len() + ids.len(), 100);
            assert!(serde_json::to_vec(&second).unwrap().len() <= PUSH_BODY_CAP);
            assert!(rejected.is_empty());
            assert!(rows.iter().all(|row| row.attempts == 0));
        }

        #[test]
        fn malformed_and_oversized_records_do_not_block_smaller_valid_rows() {
            let make = |id: &str, op: &str, payload: String| db::OutboxItem {
                id: id.into(),
                op: op.into(),
                payload,
                attempts: 0,
                created_at: String::new(),
            };
            let rows = vec![
                make("broken", "sale", "bad json".into()),
                make(
                    "large",
                    "sale",
                    serde_json::json!({"id":"large","items":"x".repeat(PUSH_BODY_CAP)}).to_string(),
                ),
                make(
                    "small",
                    "attendance",
                    serde_json::json!({"id":"small"}).to_string(),
                ),
            ];
            let (body, ids, rejected) = prepare_push(&rows, None);
            assert_eq!(ids.len(), 1);
            assert!(ids.contains("small"));
            assert_eq!(rejected, vec!["broken", "large"]);
            assert_eq!(body["attendance"].as_array().unwrap().len(), 1);
        }

        #[test]
        fn malformed_success_does_not_verify_terminal() {
            assert!(!valid_sync_response(&serde_json::json!({})));
            assert!(!valid_sync_response(
                &serde_json::json!({ "remote_disabled": false })
            ));
            let complete = serde_json::json!({ "remote_disabled": false, "server_time": 123,"catalog_complete":true,"face_cursor":"2026-10-13T00:00:00Z",
                "accepted_ids": [], "products": [], "product_ids": [], "members": [], "staff": [], "promos": [],"plans":[],"face_changes":[],"failed_ids":[] });
            assert!(valid_sync_response(&complete));
        }

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
