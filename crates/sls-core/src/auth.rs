//! Recycled from `shared/src/lib.rs` (orig): Argon2id password/PIN hashing
//! with legacy unsalted-SHA256 fallback + transparent upgrade signal.
//!
//! Used by Supabase-synced staff PINs so hashes produced on one side verify
//! on the other. v3 keeps the exact scheme (no re-hash migration needed).

/// Hash a password or numeric PIN with Argon2id + fresh random salt.
/// Returns a self-describing PHC string (`$argon2id$...`) for direct storage.
pub fn hash_password(password: &str) -> String {
    use argon2::password_hash::{PasswordHasher, SaltString};
    use argon2::Argon2;

    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("Argon2 hashing failed")
        .to_string()
}

/// Verify against Argon2id PHC; transparently accepts legacy `sha256(pw)` hex
/// (64 lowercase hex) so pre-migration accounts keep working until next login.
pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    use argon2::Argon2;

    if let Ok(parsed) = PasswordHash::new(stored_hash) {
        return Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok();
    }

    if stored_hash.len() == 64 && stored_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        let legacy = format!("{:x}", hasher.finalize());
        return legacy == stored_hash.to_lowercase();
    }

    false
}

/// True when `stored_hash` is legacy SHA-256 (not `$argon2...`).
/// Call right after successful `verify_password` to re-hash with Argon2id.
pub fn password_is_legacy(stored_hash: &str) -> bool {
    !stored_hash.starts_with("$argon2")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argon2_roundtrip() {
        let h = hash_password("1234");
        assert!(verify_password("1234", &h));
        assert!(!verify_password("4321", &h));
        assert!(!password_is_legacy(&h));
    }
    #[test]
    fn legacy_sha256_still_verifies_then_flags_upgrade() {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"1234");
        let legacy = format!("{:x}", h.finalize());
        assert!(verify_password("1234", &legacy));
        assert!(password_is_legacy(&legacy));
    }

    /// Interop fixture: hash-wasm `argon2id` (same call shape as
    /// `supabase/functions/staff-create`: password "1234", salt = bytes 1..=16,
    /// parallelism 1, iterations 2, memorySize 19456, hashLength 32,
    /// outputType "encoded") → must verify under `Argon2::default()` here.
    /// Regenerate: node script with hash-wasm@4.12.0 if params ever change.
    #[test]
    fn hash_wasm_staff_pin_fixture_verifies() {
        let phc = "$argon2id$v=19$m=19456,t=2,p=1$AQIDBAUGBwgJCgsMDQ4PEA$nktjF+E2PWwprhl6qG9dnTeIj0c3WSWS/aEyH3DBrgM";
        assert!(verify_password("1234", phc));
        assert!(!verify_password("0000", phc));
        assert!(!password_is_legacy(phc));
        // PHC carries the params — even if defaults drift, verification parses m/t/p from the string.
        assert!(phc.contains("m=19456,t=2,p=1"));
    }
}
