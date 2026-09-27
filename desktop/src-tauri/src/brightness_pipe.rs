//! Brightness pipe: assess frame luma via sls-core, decide boost/reject.
//! Real pixel loop (gamma + histogram equalization) runs here once the
//! `face-ort` feature enables the `image` crate.
//!
//! Mapping of sls-core verdicts to kiosk UX:
//! Good → proceed | TooDark/TooBright → correct + proceed | Unusable → show hint, skip frame.

use sls_core::brightness::{assess, gamma_for, mean_luma_rgb8, ExposureVerdict};

#[derive(Debug)]
pub enum FrameDecision {
    Proceed { gamma: f32 },
    Reject { hint: &'static str },
}

pub fn decide_frame(rgb8: &[u8]) -> FrameDecision {
    let mean = mean_luma_rgb8(rgb8);
    match assess(mean).verdict {
        ExposureVerdict::Good | ExposureVerdict::TooDark | ExposureVerdict::TooBright => {
            FrameDecision::Proceed { gamma: gamma_for(mean) }
        }
        ExposureVerdict::Unusable => FrameDecision::Reject { hint: "Adjust lighting — face too dark/bright" },
    }
}

// TODO(face-ort): `apply_gamma_equalize(img, gamma)` with `image` crate:
//   1. per-pixel `out = 255*(in/255)^(1/gamma)`
//   2. luma-histogram equalization (CLAHE-lite, tile 8x8, clip 2.0)
//   3. feed corrected 112x112 face crop to YuNet→EdgeFace via `ort` DirectML session
//      with pre-allocated I/O binding (no per-frame alloc).
