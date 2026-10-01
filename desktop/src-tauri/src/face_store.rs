//! In-memory face vector store — single-camera, dim-agnostic (128 legacy / 512 EdgeFace).
//! Sub-ms cosine match via sls-core; centroid pre-screen omitted for clarity
//! (add back when members > 2000). 3s cooldown enforced in db.rs.

use sls_core::face::cosine;
use std::collections::HashMap;

pub struct FaceStore {
    dim: usize,
    threshold: f32,
    review_threshold: f32,
    vectors: HashMap<String, Vec<f32>>,
}

impl FaceStore {
    pub fn edgeface() -> Self {
        Self { dim: 512, threshold: sls_core::face::thresholds::EDGEFACE_512_START, review_threshold: sls_core::face::thresholds::EDGEFACE_512_REVIEW, vectors: HashMap::new() }
    }
    /// Gate threshold (maglock opens at or above this).
    pub fn threshold(&self) -> f32 {
        self.threshold
    }
    /// Review floor (staff eyes needed in [review, threshold)).
    pub fn review_threshold(&self) -> f32 {
        self.review_threshold
    }
    pub fn upsert(&mut self, member_id: String, v: Vec<f32>) {
        assert_eq!(v.len(), self.dim, "expected {}-d EdgeFace vector", self.dim);
        self.vectors.insert(member_id, v);
    }
    /// Returns (member_id, score) of best match above threshold.
    /// Scores in [review, threshold) are NOT returned here — use
    /// `best_candidate` for the staff-review prompt so a lookalike
    /// never opens the maglock on face alone.
    pub fn match_best(&self, probe: &[f32]) -> Option<(String, f32)> {
        self.best_candidate(probe)
            .filter(|(_, s)| *s >= self.threshold)
    }
    /// Best candidate above the review floor (match OR needs-review).
    /// Gate UI: Some + score >= threshold = open; Some + below = show
    /// "ask staff" with the score logged; None = unknown face.
    pub fn best_candidate(&self, probe: &[f32]) -> Option<(String, f32)> {
        let mut best: Option<(String, f32)> = None;
        for (id, v) in &self.vectors {
            if v.len() != probe.len() {
                continue;
            }
            let s = cosine(probe, v);
            if s >= self.review_threshold && best.as_ref().map(|(_, b)| s > *b).unwrap_or(true) {
                best = Some((id.clone(), s));
            }
        }
        best
    }
}
