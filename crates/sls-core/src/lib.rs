//! SLS v3 core — pure, testable domain logic with no native deps.
//!
//! Modules:
//! - `license`: RSA-2048 PSS license token format `GPOS-<claims>.<sig>`, tiers, grace.
//! - `pos`: integer-cents cart math (optimized: no floats, single pass).
//! - `face`: embedding types + cosine similarity (SIMD-friendly, dimension-agnostic 128/512).
//! - `brightness`: auto-exposure assessment + gamma correction params.
//! - `sync`: offline-first outbox queue types (mirrors Supabase tables).
//! - `auth`: Argon2id PHC hashing (staff PINs; hash-wasm interop fixture).

pub mod auth;
pub mod brightness;
pub mod face;
pub mod license;
pub mod pos;
pub mod sync;
