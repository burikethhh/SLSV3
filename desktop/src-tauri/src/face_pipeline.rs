//! YuNet detect → 5-pt align → EdgeFace-XXS embed via `ort` (feature `face-ort`).
//! Decode/NMS/alignment transcribed from OpenCV face_detect.cpp (via orig vision.rs).
//! Session I/O is Mutex-guarded: `Session::run` takes `&mut self` in ort 2.0-rc.

use image::imageops::FilterType;
use image::{Rgb, RgbImage};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::brightness_pipe::{decide_frame, FrameDecision};

const DET_INPUT_SIZE: u32 = 640;
const DET_STRIDES: [usize; 3] = [8, 16, 32];
const DET_SCORE_THRESHOLD: f32 = 0.6;
const DET_NMS_THRESHOLD: f32 = 0.3;
const REC_INPUT_SIZE: u32 = 112;
const EDGEFACE_DIM: usize = 512;

/// OpenCV FaceRecognizerSF 112×112 template (R eye, L eye, nose, R mouth, L mouth).
const REFERENCE_LANDMARKS_112: [[f32; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

pub const YUNET_FILENAME: &str = "face_detection_yunet_2023mar.onnx";
pub const EDGEFACE_FILENAME: &str = "edgeface_xxs.onnx";

/// Locate `models/` with both ONNX files (dev CWD layouts + packaged resources).
pub fn find_models_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("desktop/models"),
        PathBuf::from("models"),
        PathBuf::from("../models"),
        PathBuf::from("../../models"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("models"));
            candidates.push(dir.join("resources").join("models"));
            candidates.push(dir.join("_up_").join("resources").join("models"));
            candidates.push(dir.join("..").join("models"));
        }
    }
    candidates.into_iter().find(|d| {
        d.join(YUNET_FILENAME).is_file() && d.join(EDGEFACE_FILENAME).is_file()
    })
}

#[derive(Debug, Clone)]
pub struct DetectedFace {
    /// (x, y, w, h) in ORIGINAL image coords.
    pub rect: (f32, f32, f32, f32),
    pub landmarks: [[f32; 2]; 5],
    pub score: f32,
}

/// Frame scan verdict returned to the webview.
#[derive(serde::Serialize, Clone)]
pub struct GateScan {
    /// Good | TooDark | TooBright | Unusable
    pub exposure: String,
    /// Gamma applied toward mid-gray (1.0 = none).
    pub gamma: f32,
    /// Best YuNet score, 0.0 when no face.
    pub face_score: f32,
    /// Cosine match score when a member was recognized.
    pub matched: Option<(String, f32)>,
    /// 512-d embedding when a face was found (for enroll flows).
    pub embedding: Option<Vec<f32>>,
}

struct Sessions {
    detector: Mutex<ort::session::Session>,
    recognizer: Mutex<ort::session::Session>,
}

fn sessions() -> Result<&'static Sessions, String> {
    static S: OnceLock<Result<Sessions, String>> = OnceLock::new();
    match S.get_or_init(|| {
        let dir = find_models_dir().ok_or_else(|| {
            format!(
                "models dir not found (need {YUNET_FILENAME} + {EDGEFACE_FILENAME}); run scripts\\download-models.ps1"
            )
        })?;
        load_sessions(&dir)
    }) {
        Ok(s) => Ok(s),
        Err(e) => Err(e.clone()),
    }
}

fn load_sessions(dir: &Path) -> Result<Sessions, String> {
    let detector = ort::session::Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .with_intra_threads(1)
        .map_err(|e| e.to_string())?
        .commit_from_file(dir.join(YUNET_FILENAME))
        .map_err(|e| e.to_string())?;
    let recognizer = ort::session::Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .with_intra_threads(1)
        .map_err(|e| e.to_string())?
        .commit_from_file(dir.join(EDGEFACE_FILENAME))
        .map_err(|e| e.to_string())?;
    Ok(Sessions {
        detector: Mutex::new(detector),
        recognizer: Mutex::new(recognizer),
    })
}

/// Decode base64 data-URL (or raw base64) JPEG/PNG from the webview canvas.
pub fn decode_base64_image(data_url: &str) -> Result<RgbImage, String> {
    use base64::Engine;
    let b64 = data_url.split(',').next_back().unwrap_or(data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Invalid base64 image: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("Unsupported image: {e}"))?;
    Ok(img.to_rgb8())
}

/// Brightness → detect → align → EdgeFace → L2 normalize. Match is done by caller.
pub fn scan_frame(image: &RgbImage) -> Result<GateScan, String> {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return Ok(GateScan {
            exposure: "Unusable".into(),
            gamma: 1.0,
            face_score: 0.0,
            matched: None,
            embedding: None,
        });
    }

    let decision = decide_frame(image.as_raw());
    let (gamma, exposure) = match &decision {
        FrameDecision::Reject { .. } => {
            return Ok(GateScan {
                exposure: "Unusable".into(),
                gamma: 1.0,
                face_score: 0.0,
                matched: None,
                embedding: None,
            })
        }
        FrameDecision::Proceed { gamma } => {
            let name = match sls_core::brightness::assess(sls_core::brightness::mean_luma_rgb8(
                image.as_raw(),
            ))
            .verdict
            {
                sls_core::brightness::ExposureVerdict::Good => "Good",
                sls_core::brightness::ExposureVerdict::TooDark => "TooDark",
                sls_core::brightness::ExposureVerdict::TooBright => "TooBright",
                sls_core::brightness::ExposureVerdict::Unusable => "Unusable",
            };
            (*gamma, name)
        }
    };

    let s = sessions()?;
    let face = {
        let mut det = s.detector.lock().map_err(|_| "detector lock poisoned")?;
        detect_largest_face(&mut det, image)?
    };

    let mut embedding = None;
    let mut face_score = 0.0;
    if let Some(f) = face {
        face_score = f.score;
        let mut rec = s.recognizer.lock().map_err(|_| "recognizer lock poisoned")?;
        embedding = Some(extract_edgeface(&mut rec, image, &f, gamma)?);
    }

    Ok(GateScan {
        exposure: exposure.into(),
        gamma,
        face_score,
        matched: None,
        embedding,
    })
}

/// Highest-scoring face above threshold, or None.
pub fn detect_largest_face(
    session: &mut ort::session::Session,
    image: &RgbImage,
) -> Result<Option<DetectedFace>, String> {
    let (orig_w, orig_h) = image.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Ok(None);
    }

    let resized = image::imageops::resize(
        image,
        DET_INPUT_SIZE,
        DET_INPUT_SIZE,
        FilterType::Triangle,
    );
    let scale_x = orig_w as f32 / DET_INPUT_SIZE as f32;
    let scale_y = orig_h as f32 / DET_INPUT_SIZE as f32;

    // YuNet blobFromImage: swapRB=false on BGR Mat → wants BGR.
    let input = rgb_to_nchw(&resized, true, 1.0, 1.0, 0.0)?;
    let outputs = session
        .run(ort::inputs![input])
        .map_err(|e| format!("YuNet inference failed: {e}"))?;

    // Output order (verified vs ONNX graph): cls_*, obj_*, bbox_*, kps_* × strides.
    let mut candidates = Vec::new();
    for (i, &stride) in DET_STRIDES.iter().enumerate() {
        let cols = DET_INPUT_SIZE as usize / stride;
        let rows = DET_INPUT_SIZE as usize / stride;
        let cls = extract_f32(&outputs, i).ok_or("missing cls head")?;
        let obj = extract_f32(&outputs, i + 3).ok_or("missing obj head")?;
        let bbox = extract_f32(&outputs, i + 6).ok_or("missing bbox head")?;
        let kps = extract_f32(&outputs, i + 9).ok_or("missing kps head")?;
        if cls.len() < rows * cols || obj.len() < rows * cols {
            return Err("YuNet head size mismatch".into());
        }

        for r in 0..rows {
            for c in 0..cols {
                let idx = r * cols + c;
                let score = (cls[idx].clamp(0.0, 1.0) * obj[idx].clamp(0.0, 1.0)).sqrt();
                if score < DET_SCORE_THRESHOLD {
                    continue;
                }
                let cx = (c as f32 + bbox[idx * 4]) * stride as f32;
                let cy = (r as f32 + bbox[idx * 4 + 1]) * stride as f32;
                let bw = bbox[idx * 4 + 2].exp() * stride as f32;
                let bh = bbox[idx * 4 + 3].exp() * stride as f32;
                let mut landmarks = [[0.0f32; 2]; 5];
                for n in 0..5 {
                    if idx * 10 + 2 * n + 1 >= kps.len() {
                        continue;
                    }
                    landmarks[n][0] = (kps[idx * 10 + 2 * n] + c as f32) * stride as f32;
                    landmarks[n][1] = (kps[idx * 10 + 2 * n + 1] + r as f32) * stride as f32;
                }
                candidates.push(DetectedFace {
                    rect: (cx - bw / 2.0, cy - bh / 2.0, bw, bh),
                    landmarks,
                    score,
                });
            }
        }
    }

    let kept = nms(candidates, DET_NMS_THRESHOLD);
    Ok(kept.into_iter().max_by(|a, b| a.score.total_cmp(&b.score)).map(|mut f| {
        f.rect.0 *= scale_x;
        f.rect.1 *= scale_y;
        f.rect.2 *= scale_x;
        f.rect.3 *= scale_y;
        for p in f.landmarks.iter_mut() {
            p[0] *= scale_x;
            p[1] *= scale_y;
        }
        f
    }))
}

/// Align 5-pt landmarks → 112×112, gamma-correct, EdgeFace embed, L2-normalize.
pub fn extract_edgeface(
    session: &mut ort::session::Session,
    image: &RgbImage,
    face: &DetectedFace,
    gamma: f32,
) -> Result<Vec<f32>, String> {
    let transform = similarity_transform(&face.landmarks);
    let mut aligned = warp_affine_112(image, &transform);
    if (gamma - 1.0).abs() > 0.01 {
        apply_gamma(&mut aligned, gamma);
    }

    // edgeface-onnx prep: BGR source → swap to RGB → (x-127.5)/127.5.
    let input = rgb_to_nchw(&aligned, false, 1.0 / 127.5, 1.0, 127.5)?;
    let outputs = session
        .run(ort::inputs![input])
        .map_err(|e| format!("EdgeFace inference failed: {e}"))?;
    let mut emb = extract_f32(&outputs, 0).ok_or("missing embedding output")?;
    if emb.len() != EDGEFACE_DIM {
        // Some exports pad/flatten oddly — hard-fail rather than store garbage.
        if emb.len() < EDGEFACE_DIM {
            return Err(format!("EdgeFace output dim {}, want {EDGEFACE_DIM}", emb.len()));
        }
        emb.truncate(EDGEFACE_DIM);
    }
    sls_core::face::l2_normalize(&mut emb);
    Ok(emb)
}

// ── Preprocess ────────────────────────────────────────────────────────────────

fn rgb_to_nchw(
    img: &RgbImage,
    swap_to_bgr: bool,
    scale: f32,
    mul: f32,
    sub: f32,
) -> Result<ort::value::Tensor<f32>, String> {
    let (w, h) = img.dimensions();
    let plane = (w * h) as usize;
    let mut data = vec![0f32; 3 * plane];
    for (x, y, px) in img.enumerate_pixels() {
        let Rgb([r, g, b]) = *px;
        let (c0, c1, c2) = if swap_to_bgr { (b, g, r) } else { (r, g, b) };
        let off = y as usize * w as usize + x as usize;
        data[off] = (c0 as f32 - sub) * scale * mul;
        data[plane + off] = (c1 as f32 - sub) * scale * mul;
        data[2 * plane + off] = (c2 as f32 - sub) * scale * mul;
    }
    // Fix: mean/std form (x - sub) * (scale*mul) when sub!=0 → use (x - sub)/std.
    // rgb_to_nchw callers pass (scale=1/std, sub=mean) for EdgeFace: (x-127.5)/127.5.
    // For YuNet: sub=0, scale=1 → raw 0..255.
    ort::value::Tensor::from_array(([1usize, 3, h as usize, w as usize], data))
        .map_err(|e| e.to_string())
}

fn extract_f32(outputs: &ort::session::SessionOutputs, index: usize) -> Option<Vec<f32>> {
    let out = &outputs[index];
    // try_extract_tensor returns Result<(&Shape, &[f32])> for f32 tensors.
    match out.try_extract_tensor::<f32>() {
        Ok((_shape, data)) => Some(data.iter().copied().collect()),
        Err(_) => None,
    }
}

fn apply_gamma(img: &mut RgbImage, gamma: f32) {
    // out = 255 * (in/255)^(1/gamma); precompute LUT for speed.
    let mut lut = [0u8; 256];
    for (i, v) in lut.iter_mut().enumerate() {
        let x = (i as f32) / 255.0;
        *v = (255.0 * x.powf(1.0 / gamma)).round().clamp(0.0, 255.0) as u8;
    }
    for p in img.pixels_mut() {
        p.0[0] = lut[p.0[0] as usize];
        p.0[1] = lut[p.0[1] as usize];
        p.0[2] = lut[p.0[2] as usize];
    }
}

// ── Detection post-process (OpenCV NMS + similarity align) ────────────────────

fn nms(mut faces: Vec<DetectedFace>, thr: f32) -> Vec<DetectedFace> {
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<DetectedFace> = Vec::new();
    'outer: for f in faces {
        for k in &kept {
            if iou(f.rect, k.rect) > thr {
                continue 'outer;
            }
        }
        kept.push(f);
    }
    kept
}

fn iou(a: (f32, f32, f32, f32), b: (f32, f32, f32, f32)) -> f32 {
    let ix1 = a.0.max(b.0);
    let iy1 = a.1.max(b.1);
    let ix2 = (a.0 + a.2).min(b.0 + b.2);
    let iy2 = (a.1 + a.3).min(b.1 + b.3);
    let iw = (ix2 - ix1).max(0.0);
    let ih = (iy2 - iy1).max(0.0);
    let inter = iw * ih;
    let union = a.2 * a.3 + b.2 * b.3 - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// Least-squares similarity transform src 5-pts → REFERENCE_LANDMARKS_112.
/// Returns `[[a,-b,tx],[b,a,ty]]`.
fn similarity_transform(src: &[[f32; 2]; 5]) -> [[f64; 3]; 2] {
    let dst = REFERENCE_LANDMARKS_112;
    let mean = |p: &[[f32; 2]; 5]| {
        (
            p.iter().map(|q| q[0] as f64).sum::<f64>() / 5.0,
            p.iter().map(|q| q[1] as f64).sum::<f64>() / 5.0,
        )
    };
    let (msx, msy) = mean(src);
    let (mdx, mdy) = mean(&dst);
    let mut sxx = 0.0f64;
    let mut sxy = 0.0f64;
    let mut syx = 0.0f64;
    for i in 0..5 {
        let sx = src[i][0] as f64 - msx;
        let sy = src[i][1] as f64 - msy;
        let dx = dst[i][0] as f64 - mdx;
        let dy = dst[i][1] as f64 - mdy;
        sxx += sx * sx + sy * sy;
        sxy += sx * dx + sy * dy;
        syx += sx * dy - sy * dx;
    }
    if sxx.abs() < 1e-9 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    }
    let a = sxy / sxx;
    let b = syx / sxx;
    let tx = mdx - a * msx + b * msy;
    let ty = mdy - b * msx - a * msy;
    [[a, -b, tx], [b, a, ty]]
}

fn warp_affine_112(src: &RgbImage, m: &[[f64; 3]; 2]) -> RgbImage {
    let a = m[0][0];
    let b = m[1][0];
    let tx = m[0][2];
    let ty = m[1][2];
    let det = a * a + b * b;
    let mut out = RgbImage::new(REC_INPUT_SIZE, REC_INPUT_SIZE);
    if det.abs() < 1e-12 {
        return out;
    }
    let (sw, sh) = src.dimensions();
    for oy in 0..REC_INPUT_SIZE {
        for ox in 0..REC_INPUT_SIZE {
            let dx = ox as f64 - tx;
            let dy = oy as f64 - ty;
            let sx = (a * dx + b * dy) / det;
            let sy = (-b * dx + a * dy) / det;
            out.put_pixel(ox, oy, bilinear(src, sx, sy, sw, sh));
        }
    }
    out
}

fn bilinear(img: &RgbImage, x: f64, y: f64, w: u32, h: u32) -> Rgb<u8> {
    if x < -0.5 || y < -0.5 || x > w as f64 - 0.5 || y > h as f64 - 0.5 {
        return Rgb([0, 0, 0]);
    }
    let x0 = x.floor().clamp(0.0, (w as i64 - 1) as f64) as u32;
    let y0 = y.floor().clamp(0.0, (h as i64 - 1) as f64) as u32;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = (x - x0 as f64).clamp(0.0, 1.0);
    let fy = (y - y0 as f64).clamp(0.0, 1.0);
    let p00 = img.get_pixel(x0, y0).0;
    let p10 = img.get_pixel(x1, y0).0;
    let p01 = img.get_pixel(x0, y1).0;
    let p11 = img.get_pixel(x1, y1).0;
    let mut out = [0u8; 3];
    for c in 0..3 {
        let top = p00[c] as f64 * (1.0 - fx) + p10[c] as f64 * fx;
        let bot = p01[c] as f64 * (1.0 - fx) + p11[c] as f64 * fx;
        out[c] = (top * (1.0 - fy) + bot * fy).round().clamp(0.0, 255.0) as u8;
    }
    Rgb(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nms_suppresses_overlap() {
        let faces = vec![
            DetectedFace { rect: (10., 10., 50., 50.), landmarks: [[0.; 2]; 5], score: 0.95 },
            DetectedFace { rect: (12., 12., 50., 50.), landmarks: [[0.; 2]; 5], score: 0.70 },
            DetectedFace { rect: (500., 500., 40., 40.), landmarks: [[0.; 2]; 5], score: 0.65 },
        ];
        let kept = nms(faces, 0.3);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn similarity_recovers_known() {
        let ca = 0.8 * 0.15_f64.cos();
        let cb = 0.8 * 0.15_f64.sin();
        let (tx, ty) = (12.0, -5.0);
        let det = ca * ca + cb * cb;
        let mut src = [[0.0f32; 2]; 5];
        for i in 0..5 {
            let dx = REFERENCE_LANDMARKS_112[i][0] as f64 - tx;
            let dy = REFERENCE_LANDMARKS_112[i][1] as f64 - ty;
            src[i] = [((ca * dx + cb * dy) / det) as f32, ((-cb * dx + ca * dy) / det) as f32];
        }
        let m = similarity_transform(&src);
        assert!((m[0][0] - ca).abs() < 1e-6);
        assert!((m[1][0] - cb).abs() < 1e-6);
        assert!((m[0][2] - tx).abs() < 1e-4);
    }

    #[test]
    fn blank_frame_no_face_or_soft_fail() {
        // Models may be absent in CI — skip rather than fail.
        if find_models_dir().is_none() {
            eprintln!("skipping: models not present");
            return;
        }
        let blank = RgbImage::from_pixel(480, 640, Rgb([128, 128, 128]));
        let scan = scan_frame(&blank).expect("pipeline should run");
        assert!(scan.embedding.is_none(), "flat gray should not embed");
        assert!(scan.face_score < DET_SCORE_THRESHOLD);
    }
}
