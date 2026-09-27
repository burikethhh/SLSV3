//! In-memory face vector store — single-camera, dim-agnostic (128 legacy / 512 EdgeFace).
//! Sub-ms cosine match via sls-core; centroid pre-screen omitted for clarity
//! (add back when members > 2000). 3s cooldown enforced in db.rs.

use sls_core::face::cosine;
use std::collections::HashMap;

pub struct FaceStore {
    dim: usize,
    threshold: f32,
    vectors: HashMap<String, Vec<f32>>,
}

impl FaceStore {
    pub fn edgeface() -> Self {
        Self { dim: 512, threshold: sls_core::face::thresholds::EDGEFACE_512_START, vectors: HashMap::new() }
    }
    pub fn upsert(&mut self, member_id: String, v: Vec<f32>) {
        assert_eq!(v.len(), self.dim, "expected {}-d EdgeFace vector", self.dim);
        self.vectors.insert(member_id, v);
    }
    /// Returns (member_id, score) of best match above threshold.
    pub fn match_best(&self, probe: &[f32]) -> Option<(String, f32)> {
        let mut best: Option<(String, f32)> = None;
        for (id, v) in &self.vectors {
            let s = cosine(probe, v);
            if s >= self.threshold && best.as_ref().map(|(_, b)| s > *b).unwrap_or(true) {
                best = Some((id.clone(), s));
            }
        }
        best
    }
}
