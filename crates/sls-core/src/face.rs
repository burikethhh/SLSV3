//! Face embedding types. Dimension-agnostic: v2 SFace 128-d,
//! v3 EdgeFace-XXS/XS 512-d. Store dim alongside vector in DB.

/// Cosine similarity in [-1, 1]. Single pass, no alloc.
/// Works for 128-d (legacy) and 512-d (EdgeFace).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "embedding dim mismatch");
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    // 4-wide unrolled loop (matches v2 SIMD intent, autovectorized)
    let chunks = a.len() / 4 * 4;
    for i in (0..chunks).step_by(4) {
        dot += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
        na += a[i] * a[i] + a[i + 1] * a[i + 1] + a[i + 2] * a[i + 2] + a[i + 3] * a[i + 3];
        nb += b[i] * b[i] + b[i + 1] * b[i + 1] + b[i + 2] * b[i + 2] + b[i + 3] * b[i + 3];
    }
    for i in chunks..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = (na * nb).sqrt();
    if denom == 0.0 { 0.0 } else { dot / denom }
}

/// L2-normalize in place (recycled from orig `face.rs`).
/// Guards NaN/Inf — corrupted vectors are zeroed so cosine = 0 (no match).
pub fn l2_normalize(v: &mut [f32]) {
    if !v.iter().all(|x| x.is_finite()) {
        for x in v.iter_mut() {
            *x = 0.0;
        }
        return;
    }
    let sum_sq: f32 = v.iter().map(|x| x * x).sum();
    if !sum_sq.is_finite() {
        for x in v.iter_mut() {
            *x = 0.0;
        }
        return;
    }
    let norm = sum_sq.sqrt();
    if norm > 1e-7 && norm.is_finite() {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Embedding quality 0..1 (std*2.5 clamped). Higher = richer landmark variance.
pub fn vector_quality(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mean: f32 = v.iter().sum::<f32>() / v.len() as f32;
    let var: f32 = v.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / v.len() as f32;
    (var.sqrt() * 2.5).min(1.0).max(0.0)
}

/// Dimension-scaled minimum quality gate (recycled from orig `match_vector`):
/// `1.7/sqrt(d)` reproduces the legacy 0.15 gate at d=128 exactly while
/// admitting genuine 512-d embeddings (typical q ~0.11, gate ~0.075).
/// Flat vectors (std ~ 0) are still rejected at any dimension.
pub fn min_quality_for_dim(dim: usize) -> f32 {
    1.7 / (dim as f32).sqrt()
}

/// True when a probe embedding is worth matching (quality gate).
pub fn probe_passes_quality_gate(probe: &[f32]) -> bool {
    if probe.len() < 16 {
        return !probe.is_empty();
    }
    vector_quality(probe) >= min_quality_for_dim(probe.len())
}

/// Recommended starting thresholds — MUST be re-tuned per model on gym data.
/// Thresholds belong to one model; do not reuse SFace values for EdgeFace.
/// 0.52 = tuned starting point for EdgeFace-XXS 512-d on gym captures
/// (0.40 was the UniFace default and false-accepted across family members).
/// Scores in [REVIEW, MATCH) need staff eyes (PIN / QR / approve button) —
/// face alone must not open the maglock there. No liveness yet: photo or
/// phone video is still a valid key, so treat face as convenience + audit.
pub mod thresholds {
    /// SFace legacy (128-d) starting point carried from v2.
    pub const SFACE_128: f32 = 0.62;
    /// EdgeFace-XXS/XS (512-d) gate threshold — open only at or above this.
    pub const EDGEFACE_512_START: f32 = 0.52;
    /// Below this = no match. At or above this but below MATCH = staff review.
    pub const EDGEFACE_512_REVIEW: f32 = 0.42;
    /// Adaptive-learning promotion bar (v2 used 0.80 for SFace).
    pub const ADAPT_HIGH_CONFIDENCE: f32 = 0.70;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cosine_identity() {
        let v = vec![0.5f32; 512];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-5);
    }
    #[test]
    fn cosine_orthogonal() {
        let mut a = vec![0.0f32; 512];
        let mut b = vec![0.0f32; 512];
        a[0] = 1.0;
        b[1] = 1.0;
        assert!(cosine(&a, &b).abs() < 1e-5);
    }
    #[test]
    fn quality_gate_scales_with_dim() {
        // reproduces legacy 0.15 gate at d=128
        assert!((min_quality_for_dim(128) - 0.15).abs() < 0.002);
        assert!(min_quality_for_dim(512) < min_quality_for_dim(128));
        assert!(!probe_passes_quality_gate(&vec![0.0; 512])); // flat rejected
    }
}
