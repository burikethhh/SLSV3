//! Native account lifecycle. Refresh credentials live in Windows Credential
//! Manager, never localStorage/SQLite. UI receives status, not auth tokens.
#[cfg(feature = "cloud-sync")]
pub use inner::*;

#[cfg(feature = "cloud-sync")]
mod inner {
    use crate::{db, license_mgr, license_verify, terminal_context};
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use std::sync::OnceLock;

    pub const CLOUD_URL: &str = "https://tlfytevjhzcgrttcdipq.supabase.co";
    // Public publishable/anon key, not a service-role credential.
    const ANON: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJz\
        dXBhYmFzZSIsInJlZiI6InRsZnl0ZXZqaHpjZ3J0dGNkaXBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3\
        OTEwODgzNTksImV4cCI6MjEwNjY2NDM1OX0.oS15b2wahLDuSeMZ99NX2toZrOFvEOfe2ddYnRwiwc4";

    #[derive(Clone, Serialize, Deserialize, Default)]
    struct SavedSession {
        refresh_token: String,
        email: String,
        gym_id: Option<String>,
        device_name: String,
    }
    #[derive(Default)]
    struct Account {
        saved: Option<SavedSession>,
        access_token: String,
        expires_at: i64,
        gyms: Vec<Value>,
        message: String,
        online: bool,
        mfa_factor: Option<String>,
        details: Value,
        setup_authenticated: Option<std::time::Instant>,
    }
    fn state() -> &'static parking_lot::RwLock<Account> {
        static STATE: OnceLock<parking_lot::RwLock<Account>> = OnceLock::new();
        STATE.get_or_init(Default::default)
    }
    fn requests() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }
    fn credential() -> Result<keyring::Entry, String> {
        if !cfg!(target_os = "windows") {
            return Err("Secure account storage requires Windows".into());
        }
        keyring::Entry::new("SLS.GymPOS", "dashboard-account-v1")
            .map_err(|_| "Secure credential storage unavailable".into())
    }
    fn persist(saved: &SavedSession) -> Result<(), String> {
        credential()?
            .set_password(&serde_json::to_string(saved).map_err(|_| "Cannot save account")?)
            .map_err(|_| "Cannot save session in Windows Credential Manager".into())
    }
    fn client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .map_err(|_| "Cannot initialize cloud connection".into())
    }
    async fn post(path: &str, bearer: Option<&str>, body: Value) -> Result<Value, (u16, String)> {
        let mut request = client()
            .map_err(|e| (0, e))?
            .post(format!("{CLOUD_URL}/{path}"))
            .header("apikey", ANON)
            .json(&body);
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| {
            (
                0,
                "Cloud unavailable. Check your internet connection.".into(),
            )
        })?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            // Auth errors have safe fixed wording; never echo token-bearing bodies.
            let message = match status {
                400 | 401 if path.starts_with("auth/") => {
                    "Sign-in failed. Check your password and verify your email."
                }
                401 => "Your account session ended. Sign in again.",
                403 => "This account is not authorized. Use a verified gym owner account.",
                429 => "Too many attempts. Please wait before retrying.",
                _ => "Cloud service unavailable. Please retry shortly.",
            };
            return Err((status, message.into()));
        }
        response.json().await.map_err(|_| {
            (
                0,
                "Invalid cloud response; verification not completed.".into(),
            )
        })
    }
    fn save_auth(body: Value, previous: Option<SavedSession>) -> Result<(), String> {
        let access = body["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Sign-in response missing session")?;
        let refresh = body["refresh_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Sign-in response missing refresh credential")?;
        let mut saved = previous.unwrap_or_default();
        saved.email = body["user"]["email"]
            .as_str()
            .ok_or("Account email missing")?
            .to_string();
        saved.refresh_token = refresh.to_string();
        persist(&saved)?;
        let mut account = state().write();
        account.saved = Some(saved);
        account.access_token = access.to_string();
        account.expires_at =
            chrono::Utc::now().timestamp() + body["expires_in"].as_i64().unwrap_or(3600);
        account.mfa_factor = required_factor(&body);
        Ok(())
    }
    fn required_factor(body: &Value) -> Option<String> {
        use base64::Engine;
        let payload = body["access_token"].as_str()?.split('.').nth(1)?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .ok()?;
        let claims: Value = serde_json::from_slice(&bytes).ok()?;
        if claims["aal"] == "aal2" {
            return None;
        }
        body["user"]["factors"]
            .as_array()?
            .iter()
            .find(|f| f["status"] == "verified" && f["factor_type"] == "totp")?["id"]
            .as_str()
            .map(str::to_string)
    }
    async fn access() -> Result<String, (u16, String)> {
        let (token, deadline, saved) = {
            let account = state().read();
            (
                account.access_token.clone(),
                account.expires_at,
                account.saved.clone(),
            )
        };
        if !token.is_empty() && deadline > chrono::Utc::now().timestamp() + 90 {
            return Ok(token);
        }
        let saved = saved.ok_or((401, "Sign in with your SLS account".into()))?;
        let body = post(
            "auth/v1/token?grant_type=refresh_token",
            None,
            json!({ "refresh_token": saved.refresh_token }),
        )
        .await?;
        save_auth(body, Some(saved)).map_err(|e| (0, e))?;
        Ok(state().read().access_token.clone())
    }
    pub fn connected() -> bool {
        state()
            .read()
            .saved
            .as_ref()
            .and_then(|s| s.gym_id.as_ref())
            .is_some()
    }
    pub fn selected_gym() -> Option<String> {
        state().read().saved.as_ref().and_then(|s| s.gym_id.clone())
    }
    pub fn status() -> Value {
        let _context = terminal_context().read();
        let account = state().read();
        let saved = account.saved.as_ref();
        let claims = license_mgr().current_claims();
        json!({
            "signed_in": saved.is_some(), "email": saved.map(|s| &s.email),
            "gym_id": saved.and_then(|s| s.gym_id.as_ref()), "gyms": account.gyms,
            "device_name": saved.map(|s| &s.device_name), "gym_name": claims.as_ref().map(|c| c.gym_name.clone()).or_else(|| account.details["gym_name"].as_str().map(str::to_string)),
            "expires_at": claims.as_ref().map(|c| c.expires_at.to_rfc3339()).or_else(|| account.details["expires_at"].as_str().map(str::to_string)),
            "license": license_mgr().current_status(), "online": account.online,
            "message": account.message, "last_verified": db::last_heartbeat().unwrap_or(0),
            "requires_mfa": account.mfa_factor.is_some(),
            "operator": crate::operator_status(),
            "legacy_rows_retained": db::legacy_rows_retained(),
            "legacy_imported": db::get_setting("legacy_import_v1").ok().flatten().is_some(),
            "pending_uploads": if connected_saved(saved) { db::outbox_count().unwrap_or(0) } else { 0 },
        })
    }
    fn connected_saved(saved: Option<&SavedSession>) -> bool {
        saved.and_then(|s| s.gym_id.as_ref()).is_some()
    }
    pub async fn sign_in(email: String, password: String) -> Result<Value, String> {
        let _request = requests().lock().await;
        let body = post(
            "auth/v1/token?grant_type=password",
            None,
            json!({ "email": email.trim(), "password": password }),
        )
        .await
        .map_err(|e| e.1)?;
        let token = body["access_token"]
            .as_str()
            .ok_or("Account session missing")?;
        let facilities = if required_factor(&body).is_some() {
            json!({ "gyms": [] })
        } else {
            post("functions/v1/license-fetch", Some(token), json!({}))
                .await
                .map_err(|e| e.1)?
        };
        {
            let _context = terminal_context().write();
            crate::stop_sync();
            license_mgr().revoke();
            crate::reset_operator();
            save_auth(body, None)?;
            let mut account = state().write();
            account.gyms = facilities["gyms"]
                .as_array()
                .cloned()
                .ok_or("Facility list missing")?;
            account.details = Value::Null;
            account.setup_authenticated = if account.mfa_factor.is_none() {
                Some(std::time::Instant::now())
            } else {
                None
            };
            account.online = true;
            account.message = if account.gyms.is_empty() {
                "Finish gym setup in the dashboard, then refresh."
            } else {
                "Choose a facility and name this terminal."
            }
            .into();
        }
        Ok(status())
    }
    pub async fn verify_mfa(code: String) -> Result<Value, String> {
        if code.len() != 6 || !code.bytes().all(|c| c.is_ascii_digit()) {
            return Err("Enter the six-digit authenticator code".into());
        }
        let _request = requests().lock().await;
        let token = access().await.map_err(|e| e.1)?;
        let (factor, saved) = {
            let account = state().read();
            (
                account
                    .mfa_factor
                    .clone()
                    .ok_or("Two-factor verification is not pending")?,
                account.saved.clone(),
            )
        };
        uuid::Uuid::parse_str(&factor).map_err(|_| "Invalid authenticator identity")?;
        let challenge = post(
            &format!("auth/v1/factors/{factor}/challenge"),
            Some(&token),
            json!({}),
        )
        .await
        .map_err(|e| e.1)?;
        let response = post(
            &format!("auth/v1/factors/{factor}/verify"),
            Some(&token),
            json!({ "challenge_id": challenge["id"], "code": code }),
        )
        .await
        .map_err(|e| e.1)?;
        save_auth(response, saved)?;
        state().write().setup_authenticated = Some(std::time::Instant::now());
        refresh_locked().await.map_err(|e| e.1)?;
        Ok(status())
    }
    pub async fn select(gym_id: String, device_name: String) -> Result<Value, String> {
        uuid::Uuid::parse_str(&gym_id).map_err(|_| "Invalid facility")?;
        let name = device_name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err("Enter a terminal name (up to 100 characters)".into());
        }
        let _request = requests().lock().await;
        let token = access().await.map_err(|e| e.1)?;
        let body = post(
            "functions/v1/license-fetch",
            Some(&token),
            json!({ "gym_id": gym_id, "hwid": license_verify::get_hwid(), "device_name": name }),
        )
        .await
        .map_err(|e| e.1)?;
        {
            let _context = terminal_context().write();
            crate::stop_sync();
            license_mgr().revoke();
            crate::reset_operator();
            db::select_gym(&gym_id)?;
            crate::reload_faces();
            let mut saved = state().read().saved.clone().ok_or("Sign in again")?;
            saved.gym_id = Some(gym_id.clone());
            saved.device_name = name.to_string();
            if let Err(error) = persist(&saved) {
                // Never let the previous account's refresh loop operate on a
                // newly selected facility's storage after a credential failure.
                state().write().saved = None;
                return Err(error);
            }
            state().write().saved = Some(saved);
            apply_response(&body, &gym_id)?;
            if license_mgr().current_status().is_operable()
                && state()
                    .write()
                    .setup_authenticated
                    .take()
                    .is_some_and(|at| at.elapsed().as_secs() < 300)
            {
                crate::grant_owner_setup();
            }
        }
        Ok(status())
    }
    fn apply_response(body: &Value, gym_id: &str) -> Result<(), String> {
        if db::get_setting("gym_id")
            .map_err(|e| e.to_string())?
            .as_deref()
            != Some(gym_id)
        {
            return Err("Facility storage mismatch. Reconnect this terminal.".into());
        }
        let remote_state = body["state"]
            .as_str()
            .ok_or("Subscription response missing status")?;
        if !matches!(
            remote_state,
            "valid"
                | "grace"
                | "expired"
                | "revoked"
                | "suspended"
                | "no_subscription"
                | "device_revoked"
                | "invalid"
        ) {
            return Err("Unknown subscription status; verification not completed".into());
        }
        if body["gym"]["id"].as_str() != Some(gym_id) {
            return Err("Facility mismatch; activation refused".into());
        }
        state().write().details =
            json!({ "gym_name": body["gym"]["name"], "expires_at": body["license"]["expires_at"] });
        if remote_state != "valid" && remote_state != "grace" {
            crate::stop_sync();
            crate::reset_operator();
            license_mgr().revoke();
            db::clear_cached_license().map_err(|e| e.to_string())?;
            let mut account = state().write();
            account.online = true;
            account.message = format!(
                "Subscription: {}. Review your dashboard or contact the CEO.",
                remote_state.replace('_', " ")
            );
            return Ok(());
        }
        let token = body["licenses"][0]["raw_token"]
            .as_str()
            .ok_or("Activation credential missing")?;
        let server_ms = body["server_time"]
            .as_i64()
            .ok_or("Server verification time missing")?;
        if (chrono::Utc::now().timestamp_millis() - server_ms).abs() > 120_000 {
            return Err(
                "Your computer clock is incorrect. Correct Windows date/time and reconnect.".into(),
            );
        }
        let claims = license_verify::verify_token(token, license_verify::EMBEDDED_PUBLIC_KEY_PEM)?;
        if claims.gym_id.to_string() != gym_id || claims.hwid != license_verify::get_hwid() {
            return Err("Activation identity mismatch".into());
        }
        if !claims.evaluate(chrono::Utc::now()).is_operable() {
            return Err("Activation has expired".into());
        }
        let changed = license_mgr()
            .current_claims()
            .map(|old| old.license_id != claims.license_id || old.expires_at != claims.expires_at)
            .unwrap_or(true);
        if changed || !crate::sync_running() {
            crate::stop_sync();
            license_mgr().verify_and_apply(token)?;
            db::cache_license(token, &claims.expires_at.to_rfc3339()).map_err(|e| e.to_string())?;
            db::set_setting("supabase_url", CLOUD_URL).map_err(|e| e.to_string())?;
            crate::start_sync(CLOUD_URL.to_string(), token.to_string(), gym_id.to_string());
        }
        db::heartbeat_ok().map_err(|e| e.to_string())?;
        db::set_setting(
            "clock_high_water",
            &chrono::Utc::now().timestamp().to_string(),
        )
        .map_err(|e| e.to_string())?;
        let mut account = state().write();
        account.online = true;
        account.message = "Connected. Subscription updates automatically.".into();
        Ok(())
    }
    async fn refresh_locked() -> Result<(), (u16, String)> {
        let token = access().await?;
        let saved = state()
            .read()
            .saved
            .clone()
            .ok_or((401, "Sign in again".into()))?;
        let facilities = post("functions/v1/license-fetch", Some(&token), json!({})).await?;
        state().write().gyms = facilities["gyms"]
            .as_array()
            .cloned()
            .ok_or((0, "Facility list missing".into()))?;
        let body = post("functions/v1/license-fetch", Some(&token), match saved.gym_id.as_ref() {
            Some(id) => json!({ "gym_id": id, "hwid": license_verify::get_hwid(), "device_name": saved.device_name }),
            None => json!({}),
        }).await?;
        let _context = terminal_context().write();
        match saved.gym_id {
            Some(id) => apply_response(&body, &id).map_err(|e| (0, e))?,
            None => {
                state().write().gyms = body["gyms"]
                    .as_array()
                    .cloned()
                    .ok_or((0, "Facility list missing".into()))?
            }
        }
        Ok(())
    }
    pub async fn refresh() -> Result<Value, String> {
        let _request = requests().lock().await;
        if let Err((code, message)) = refresh_locked().await {
            let _context = terminal_context().write();
            if code == 400 || code == 401 || code == 403 {
                crate::stop_sync();
                license_mgr().revoke();
                let _ = db::clear_cached_license();
                crate::reset_operator();
                // Retain only secure refresh state for an explicit reconnect;
                // a confirmed authorization failure cannot grant offline access.
            }
            let mut account = state().write();
            account.online = false;
            account.message = message.clone();
            return Err(message);
        }
        Ok(status())
    }
    pub async fn sign_out() -> Result<(), String> {
        let _request = requests().lock().await;
        // Local disconnect: must not log the owner out of other terminals.
        match credential()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => return Err("Cannot remove saved account credential".into()),
        }
        let _context = terminal_context().write();
        crate::stop_sync();
        license_mgr().revoke();
        crate::reset_operator();
        *state().write() = Account::default();
        Ok(())
    }
    pub async fn recover_legacy(confirmation: String) -> Result<Value, String> {
        let _request = requests().lock().await;
        // A saved/offline account alone must not authorize a data migration.
        refresh_locked().await.map_err(|e| e.1)?;
        let gym = selected_gym().ok_or("Connect the legacy facility first")?;
        if confirmation != gym || !license_mgr().current_status().is_operable() {
            return Err("Confirm the connected, licensed facility before recovery".into());
        }
        let result = {
            let _context = terminal_context().write();
            crate::stop_sync();
            crate::reset_operator();
            let result = crate::recovery::recover(&gym);
            crate::reload_faces();
            result
        };
        // Restart fresh sync whether recovery succeeds or is safely refused.
        let _ = refresh_locked().await;
        result
    }
    pub fn boot() {
        if let Ok(entry) = credential() {
            if let Ok(secret) = entry.get_password() {
                if let Ok(saved) = serde_json::from_str::<SavedSession>(&secret) {
                    if let Some(ref id) = saved.gym_id {
                        if db::select_gym(id).is_ok() {
                            crate::reload_faces();
                            if let Ok(Some(token)) = db::get_cached_license() {
                                if let Ok(claims) = license_verify::verify_token(
                                    &token,
                                    license_verify::EMBEDDED_PUBLIC_KEY_PEM,
                                ) {
                                    if claims.gym_id.to_string() == *id
                                        && claims.hwid == license_verify::get_hwid()
                                    {
                                        let _ = license_mgr().verify_and_apply(&token);
                                        // Sync resumes only after fresh account verification.
                                    }
                                }
                            }
                        }
                    }
                    state().write().saved = Some(saved);
                }
            }
        }
        tauri::async_runtime::spawn(async {
            loop {
                if state().read().saved.is_some() {
                    let _ = refresh().await;
                }
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn verified_totp_requires_second_factor() {
            use base64::Engine;
            let make = |aal: &str| {
                format!(
                    "header.{}.signature",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .encode(format!("{{\"aal\":\"{aal}\"}}"))
                )
            };
            let user = json!({ "factors": [{ "id": "factor-1", "status": "verified", "factor_type": "totp" }] });
            assert_eq!(
                required_factor(&json!({ "access_token": make("aal1"), "user": user })),
                Some("factor-1".into())
            );
            assert_eq!(
                required_factor(&json!({ "access_token": make("aal2"), "user": user })),
                None
            );
        }
        #[test]
        fn saved_credentials_exclude_password_and_access_token() {
            let saved = SavedSession {
                refresh_token: "test-refresh".into(),
                email: "test@example.invalid".into(),
                gym_id: None,
                device_name: "Desk".into(),
            };
            let value = serde_json::to_value(saved).unwrap();
            assert!(value.get("password").is_none());
            assert!(value.get("access_token").is_none());
        }
        #[test]
        #[cfg(target_os = "windows")]
        fn windows_credential_store_roundtrip() {
            // Dedicated disposable credential, never the user's connection.
            let username = uuid::Uuid::new_v4().to_string();
            let entry = keyring::Entry::new("SLS.GymPOS.Tests", &username).unwrap();
            entry.set_password("synthetic-test-session").unwrap();
            assert_eq!(entry.get_password().unwrap(), "synthetic-test-session");
            entry.delete_credential().unwrap();
            assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        }
    }
}

#[cfg(not(feature = "cloud-sync"))]
pub fn connected() -> bool {
    false
}
#[cfg(not(feature = "cloud-sync"))]
pub fn selected_gym() -> Option<String> {
    None
}
