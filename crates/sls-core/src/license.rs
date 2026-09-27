//! Recycled from `shared/src/lib.rs` + `cloud/src/crypto.rs` (orig).
//! Wire format identical to v2 so old keys verify:
//! `GPOS-<base64url(claims_json)>.<base64url(rsa_pss_sha256_sig)>`
//!
//! v3 changes: `tailgate_detection_enabled` dropped (single camera, no
//! tailgate cam). Everything else kept byte-compatible.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Tier caps/pricing (USD/month).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LicenseTier {
    Basic, // 200 members
    Pro,   // 500 members
    Ultra, // 1000 members
}

impl LicenseTier {
    pub fn max_members(self) -> u32 {
        match self {
            Self::Basic => 200,
            Self::Pro => 500,
            Self::Ultra => 1000,
        }
    }
    pub fn monthly_usd(self) -> u32 {
        match self {
            Self::Basic => 99,
            Self::Pro => 199,
            Self::Ultra => 349,
        }
    }
}

/// Claims payload signed by the Supabase license-issue Edge Function.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseClaims {
    pub license_id: Uuid,
    pub gym_id: Uuid,
    pub gym_name: String,
    #[serde(default)]
    pub owner_email: String,
    pub tier: LicenseTier,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    #[serde(default)]
    pub max_members: u32,
    #[serde(default = "default_true")]
    pub hardware_lock_enabled: bool,
    /// Device fingerprint (SHA256 hex[:32] of sorted anchors). Empty = unbound.
    #[serde(default)]
    pub hwid: String,
    #[serde(default)]
    pub ip_hint: String,
    /// Unix mirrors for offline math (fall back to `expires_at` when unset).
    #[serde(default)]
    pub exp_unix: i64,
    #[serde(default)]
    pub grace_until: i64,
}

fn default_true() -> bool {
    true
}

impl LicenseClaims {
    /// Unix-seconds helper for offline expiry maths.
    pub fn expiry_unix(&self) -> i64 {
        if self.exp_unix > 0 {
            self.exp_unix
        } else {
            self.expires_at.timestamp()
        }
    }

    /// Grace deadline; falls back to expiry + 3 days.
    pub fn grace_unix(&self) -> i64 {
        if self.grace_until > 0 {
            self.grace_until
        } else {
            self.expiry_unix() + 3 * 24 * 3600
        }
    }

    /// v2-compatible evaluation: Valid → 3-day GracePeriod → Expired.
    pub fn evaluate(&self, now: DateTime<Utc>) -> LicenseStatus {
        if now <= self.expires_at {
            LicenseStatus::Valid {
                tier: format!("{:?}", self.tier).to_lowercase(),
                gym_name: self.gym_name.clone(),
                days_remaining: (self.expires_at - now).num_days(),
            }
        } else {
            let grace_expiry = self.expires_at + Duration::days(3);
            if now <= grace_expiry {
                LicenseStatus::GracePeriod {
                    tier: format!("{:?}", self.tier).to_lowercase(),
                    grace_days_remaining: (grace_expiry - now).num_days(),
                    expired_at: self.expires_at,
                }
            } else {
                LicenseStatus::Expired { expired_at: self.expires_at }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum LicenseStatus {
    Valid { tier: String, gym_name: String, days_remaining: i64 },
    GracePeriod { tier: String, grace_days_remaining: i64, expired_at: DateTime<Utc> },
    Expired { expired_at: DateTime<Utc> },
    Invalid { reason: String },
    Unlicensed,
}

impl LicenseStatus {
    pub fn is_operable(&self) -> bool {
        matches!(self, LicenseStatus::Valid { .. } | LicenseStatus::GracePeriod { .. })
    }
}

/// Split a `GPOS-...` token into (claims_json, signature) without verifying.
/// Full RSA-PSS verification lives in `desktop/src-tauri/src/license_verify.rs`
/// (recycled fail-closed verifier) — kept out of core to stay light.
pub fn split_token(token: &str) -> Option<(Vec<u8>, Vec<u8>)> {
    use base64::Engine;
    let clean: String = token.chars().filter(|c| !c.is_whitespace()).collect();
    let rest = clean.strip_prefix("GPOS-")?;
    let (c, s) = rest.split_once('.')?;
    if c.is_empty() || s.is_empty() {
        return None;
    }
    let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(c).ok()?;
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()?;
    Some((claims, sig))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tier_caps() {
        assert_eq!(LicenseTier::Basic.max_members(), 200);
        assert_eq!(LicenseTier::Pro.max_members(), 500);
        assert_eq!(LicenseTier::Ultra.max_members(), 1000);
    }
    #[test]
    fn grace_period() {
        let now = Utc::now();
        let c = LicenseClaims {
            license_id: Uuid::new_v4(),
            gym_id: Uuid::new_v4(),
            gym_name: "Test".into(),
            owner_email: "o@t.co".into(),
            tier: LicenseTier::Pro,
            issued_at: now - chrono::Duration::days(30),
            expires_at: now - chrono::Duration::days(1),
            max_members: 500,
            hardware_lock_enabled: true,
            hwid: String::new(),
            ip_hint: String::new(),
            exp_unix: 0,
            grace_until: 0,
        };
        assert!(matches!(c.evaluate(now), LicenseStatus::GracePeriod { .. }));
        assert!(matches!(
            c.evaluate(now + chrono::Duration::days(5)),
            LicenseStatus::Expired { .. }
        ));
        assert!(c.evaluate(now).is_operable());
    }
    #[test]
    fn split_rejects_garbage() {
        assert!(split_token("nope").is_none());
        assert!(split_token("GPOS-abc").is_none()); // no dot part
    }
}
