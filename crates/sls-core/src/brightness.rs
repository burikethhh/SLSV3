//! Brightness auto-adjust for the single gate camera.
//! Pipeline: assess luma → reject if unusable → gamma lift + equalize before embedding.
//! Pure-math core (no `image` dep) so `sls-core` stays light; Tauri shell
//! applies it to actual frames via the `image` crate.

/// Mean luma in [0, 255] + verdict for the kiosk UI hint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Exposure {
    pub mean_luma: f32,
    pub verdict: ExposureVerdict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposureVerdict {
    /// 60..180 — proceed directly.
    Good,
    /// < 60 — apply boost then proceed if boosted mean lands in range.
    TooDark,
    /// > 180 — apply compress then proceed.
    TooBright,
    /// < 12 or > 245 — reject frame, show "adjust lighting" hint.
    Unusable,
}

pub fn assess(mean_luma: f32) -> Exposure {
    let verdict = if mean_luma < 12.0 || mean_luma > 245.0 {
        ExposureVerdict::Unusable
    } else if mean_luma < 60.0 {
        ExposureVerdict::TooDark
    } else if mean_luma > 180.0 {
        ExposureVerdict::TooBright
    } else {
        ExposureVerdict::Good
    };
    Exposure { mean_luma, verdict }
}

/// Gamma value to normalize `mean` toward target 110.
/// Applied as `out = 255 * (in/255)^(1/gamma)`; gamma > 1 brightens.
pub fn gamma_for(mean_luma: f32) -> f32 {
    const TARGET: f32 = 110.0;
    if mean_luma <= 1.0 {
        return 2.5;
    }
    (TARGET / mean_luma).clamp(0.4, 2.5)
}

/// Compute mean luma from an RGB8 buffer (ITU-R BT.601).
pub fn mean_luma_rgb8(px: &[u8]) -> f32 {
    assert_eq!(px.len() % 3, 0);
    if px.is_empty() {
        return 0.0;
    }
    let mut sum = 0u64;
    for c in px.chunks_exact(3) {
        sum += (299 * c[0] as u64 + 587 * c[1] as u64 + 114 * c[2] as u64) / 1000;
    }
    sum as f32 / (px.len() / 3) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verdicts() {
        assert_eq!(assess(110.0).verdict, ExposureVerdict::Good);
        assert_eq!(assess(30.0).verdict, ExposureVerdict::TooDark);
        assert_eq!(assess(200.0).verdict, ExposureVerdict::TooBright);
        assert_eq!(assess(5.0).verdict, ExposureVerdict::Unusable);
    }
    #[test]
    fn gamma_dark_brightens() {
        assert!(gamma_for(30.0) > 1.0);
        assert!(gamma_for(200.0) < 1.0);
    }
}
