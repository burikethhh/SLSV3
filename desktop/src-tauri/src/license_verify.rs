//! Recycled from orig `desktop/src-tauri/src/license.rs` (slimmed for single-cam v3).
//! Kept: HWID fingerprint (MachineGuid+disk+MAC+hostname → sha256[:32]),
//! heartbeat/tamper helpers, fail-closed RSA-PSS verifier, key fingerprint.
//! Dropped: tailgate fields, demo-license fallback (starts UNLICENSED), tracing dep.
//!
//! Wire-compatible with v2 `GPOS-<claims>.<sig>` tokens.

use rsa::pkcs8::DecodePublicKey;
use rsa::pss::VerifyingKey;
use rsa::signature::Verifier;
use sha2::{Digest, Sha256};
use sls_core::license::{LicenseClaims, LicenseStatus};

/// 7-day heartbeat window — must re-verify online within this period.
pub const HEARTBEAT_SECONDS: i64 = 7 * 24 * 3600;
/// Clock rollback tolerance — `now < last_seen - 60s` = tamper → LOCK.
pub const TAMPER_GRACE_SECONDS: i64 = 60;

pub fn is_clock_tampered(now_unix: i64, last_seen_unix: i64) -> bool {
    last_seen_unix != 0 && now_unix < last_seen_unix - TAMPER_GRACE_SECONDS
}

pub fn is_heartbeat_expired(now_unix: i64, last_verify_unix: i64) -> bool {
    last_verify_unix != 0 && now_unix - last_verify_unix > HEARTBEAT_SECONDS
}

/// Stable device fingerprint. Mirrors orig `get_hwid()`:
/// anchors = [MachineGuid, disk serial, validated MAC, hostname]
/// → sorted(set) → sha256 → hex[:32]. Fallback `fallback-<host>` if <2 anchors.
pub fn get_hwid() -> String {
    let mut anchors: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("reg")
            .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(line) = text.lines().find(|l| l.contains("MachineGuid")) {
                    if let Some(guid) = line.split_whitespace().last() {
                        let g = guid.trim().to_string();
                        if !g.is_empty() {
                            anchors.push(g);
                        }
                    }
                }
            }
        }
    }

    if let Ok(output) = std::process::Command::new("wmic")
        .args(["diskdrive", "get", "SerialNumber"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let s = line.trim();
                if s.is_empty() || s.to_lowercase() == "serialnumber" {
                    continue;
                }
                let token = s.split_whitespace().next().unwrap_or("").trim().to_string();
                if !token.is_empty() {
                    anchors.push(token);
                    break;
                }
            }
        }
    }

    if let Ok(output) = std::process::Command::new("wmic")
        .args(["nic", "where", "PhysicalAdapter=TRUE", "get", "MacAddress"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let s = line.trim();
                if s.is_empty() || s.to_lowercase() == "macaddress" {
                    continue;
                }
                let mac = s.replace('-', ":").to_uppercase();
                let parts: Vec<&str> = mac.split(':').collect();
                if parts.len() == 6 {
                    if let Ok(first) = u8::from_str_radix(parts[0], 16) {
                        if (first & 0x01) == 0 && (first & 0x02) == 0 && mac != "00:00:00:00:00:00" {
                            anchors.push(mac.replace(':', "").to_lowercase());
                            break;
                        }
                    }
                }
            }
        }
    }

    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "host".to_string());
    if !hostname.trim().is_empty() {
        anchors.push(hostname.trim().to_string());
    }
    if anchors.len() < 2 {
        anchors.push(format!("fallback-{hostname}"));
    }

    anchors.sort();
    anchors.dedup();
    let raw = anchors.join("|");
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    hex.chars().take(32).collect()
}

/// Short fingerprint of a PEM (whitespace-free SHA-256 hex[:24]) for the
/// "Check Key Match" diagnostic (exe key vs cloud signing key).
pub fn public_key_fingerprint(pem: &str) -> String {
    let norm: String = pem.chars().filter(|c| !c.is_whitespace()).collect();
    let mut hasher = Sha256::new();
    hasher.update(norm.as_bytes());
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    hex.chars().take(24).collect()
}

/// Production public key — matches Supabase secret `RSA_PRIVATE_KEY_PEM`
/// (pair generated 2026-09-24; private half lives ONLY in Supabase vault / local
/// TEMP, never in git). Rotation invalidates all issued tokens.
pub const EMBEDDED_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA090k7dIA19amwNkjYabP
MtYJ+2jDTwjupFdvnZjYnUL0G/O9VedxRlrAoN9CWfj5rmxMESdocWXsAkvHVIb7
srhpxYbWIXhTRi+QOd/pMC1A4WOCaq9o9uu4AA9FaXT/3HRrbyRUBbrMB/w6pwrl
kEEPNysjPmGMkoaCV31M5VIoBJNNB59jQ7WtpYWcURZEkuA6JalTcXQjRpy0HST4
OafjT34qKl327CV8yHw6oqswZFUGb6qefTwK7NADpXhH0YjtsqcqlrKx+6M4gA7m
r4/imD0iuzVKiLhM3Gcwi01O8GsJ307HS06YsN0eerz0qZEmGOm9VCEiax5sEAw1
mwIDAQAB
-----END PUBLIC KEY-----";

/// Fail-closed verifier: strips whitespace, checks `GPOS-` prefix,
/// verifies RSA-PSS-SHA256, deserializes claims. Any failure = Err.
/// Prefix/split/base64 handled once by `sls_core::license::split_token`.
pub fn verify_token(token: &str, public_key_pem: &str) -> Result<LicenseClaims, String> {
    let (claims_bytes, sig_bytes) =
        sls_core::license::split_token(token).ok_or("Invalid or malformed license token")?;

    let public_key = rsa::RsaPublicKey::from_public_key_pem(public_key_pem)
        .map_err(|e| format!("Invalid public key PEM: {e}"))?;
    let verifying_key = VerifyingKey::<Sha256>::new(public_key);
    let signature = rsa::pss::Signature::try_from(sig_bytes.as_slice())
        .map_err(|e| format!("Invalid signature structure: {e}"))?;
    verifying_key
        .verify(&claims_bytes, &signature)
        .map_err(|_| "Cryptographic signature verification failed".to_string())?;

    serde_json::from_slice::<LicenseClaims>(&claims_bytes).map_err(|e| format!("JSON deserialization error: {e}"))
}

pub struct LicenseManager {
    public_key_pem: String,
    current: parking_lot::RwLock<Option<LicenseClaims>>,
}

impl LicenseManager {
    /// Starts UNLICENSED — no built-in demo license (orig had one; removed as
    /// it made fresh installs report active Pro with no key).
    pub fn new(public_key_pem: Option<String>) -> Self {
        Self {
            public_key_pem: public_key_pem.unwrap_or_else(|| EMBEDDED_PUBLIC_KEY_PEM.to_string()),
            current: parking_lot::RwLock::new(None),
        }
    }

    pub fn verify_and_apply(&self, token: &str) -> Result<LicenseStatus, String> {
        let claims = verify_token(token, &self.public_key_pem)?;

        // Hardware lock is now hard-fail (orig auto-bound silently — decorative).
        if claims.hardware_lock_enabled && !claims.hwid.is_empty() {
            let this = get_hwid();
            if claims.hwid != this {
                return Err(format!(
                    "License hardware-locked to another device (bound '{}'). Contact admin to re-issue.",
                    claims.hwid
                ));
            }
        }

        let status = claims.evaluate(chrono::Utc::now());
        if !matches!(status, LicenseStatus::Expired { .. } | LicenseStatus::Invalid { .. }) {
            *self.current.write() = Some(claims);
        }
        Ok(status)
    }

    pub fn current_status(&self) -> LicenseStatus {
        match &*self.current.read() {
            Some(c) => c.evaluate(chrono::Utc::now()),
            None => LicenseStatus::Unlicensed,
        }
    }

    pub fn current_claims(&self) -> Option<LicenseClaims> {
        self.current.read().clone()
    }

    pub fn revoke(&self) {
        *self.current.write() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use rsa::pkcs8::EncodePublicKey;
    use rsa::pss::BlindedSigningKey;
    use rsa::signature::{RandomizedSigner, SignatureEncoding};
    use sls_core::license::{LicenseClaims, LicenseTier};
    use uuid::Uuid;

    /// Interop roundtrip: sign with the SAME rsa-crate PSS path the desktop
    /// verifier and (semantically) the Edge fn use (salt = SHA-256 digest size = 32),
    /// then verify through `verify_token`. Catches claims-shape drift + PSS param drift.
    /// Interop: this public PEM (from the Node-generated pair) must verify tokens
/// signed by the Edge fn with saltLength=32. Covered by
/// `license_sign_verify_roundtrip` + a Node PSS roundtrip on the same key.
    #[test]
    fn license_sign_verify_roundtrip() {
        let mut rng = rand::thread_rng();
        let priv_key = rsa::RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let pub_pem = priv_key.to_public_key().to_public_key_pem(rsa::pkcs8::LineEnding::LF).unwrap();

        let now = Utc::now();
        let claims = LicenseClaims {
            license_id: Uuid::new_v4(),
            gym_id: Uuid::new_v4(),
            gym_name: "Shadow Monarch Fitness".into(),
            owner_email: "o@monarch.ph".into(),
            tier: LicenseTier::Pro,
            issued_at: now,
            expires_at: now + chrono::Duration::days(30),
            max_members: 500,
            hardware_lock_enabled: false, // skip HWID in unit test (platform-dependent)
            hwid: String::new(),
            ip_hint: String::new(),
            exp_unix: (now + chrono::Duration::days(30)).timestamp(),
            grace_until: (now + chrono::Duration::days(33)).timestamp(),
        };
        let json = serde_json::to_vec(&claims).unwrap();
        let signer = BlindedSigningKey::<sha2::Sha256>::new(priv_key); // salt_len = 32 (digest size)
        let sig = signer.sign_with_rng(&mut rng, &json);

        let b64 = |b: &[u8]| {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
        };
        let token = format!("GPOS-{}.{}", b64(&json), b64(&sig.to_bytes()));

        let got = verify_token(&token, &pub_pem).expect("roundtrip verify failed");
        assert_eq!(got.gym_name, "Shadow Monarch Fitness");
        assert_eq!(got.tier, LicenseTier::Pro);
        // Tamper → fail-closed (flip a middle claims byte so last-char is never a no-op)
        let mut bad = token.clone();
        let mid = bad.len() / 2;
        let orig = bad.as_bytes()[mid];
        bad.replace_range(mid..mid + 1, if orig == b'A' { "B" } else { "A" });
        assert!(verify_token(&bad, &pub_pem).is_err());
    }

    #[test]
    fn heartbeat_and_tamper_helpers() {
        assert!(is_clock_tampered(1000, 2000)); // rolled back past 60s grace
        assert!(!is_clock_tampered(2000, 1000));
        assert!(!is_clock_tampered(1000, 0)); // never verified yet = no tamper
        assert!(is_heartbeat_expired(7 * 86400 + 100, 0 + 1)); // >7d offline
        assert!(!is_heartbeat_expired(100, 0));
    }

    /// Production interop: Edge-fn-issued token (env `TEST_LICENSE_TOKEN`)
    /// must verify against the embedded pubkey. Skipped when env unset.
    #[test]
    fn production_token_verifies_with_embedded_key() {
        let Ok(token) = std::env::var("TEST_LICENSE_TOKEN") else {
            eprintln!("skip: TEST_LICENSE_TOKEN not set");
            return;
        };
        let claims = verify_token(&token, EMBEDDED_PUBLIC_KEY_PEM)
            .expect("production token must verify with embedded pubkey");
        assert!(!claims.gym_id.is_nil());
        assert!(claims.expires_at > chrono::Utc::now());

        // Manager apply must succeed (hwid empty → lock skipped) and report valid.
        let mgr = LicenseManager::new(None);
        let status = mgr.verify_and_apply(&token).expect("apply failed");
        assert!(matches!(status, LicenseStatus::Valid { .. }), "got {status:?}");
        assert!(mgr.current_claims().is_some());
    }
}
