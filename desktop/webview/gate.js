// Gate view — single camera. Rust runs YuNet+EdgeFace+brightness; JS only
// captures canvas frames, invokes gate_scan_frame, and shows the verdict.
const invoke = window.__TAURI__?.core?.invoke;
let timer = null;
let busy = false;

const FRAME_MS = 400; // ~2.5 fps — enough for walk-up gate, cheap on CPU
const HINT_MS = 3000; // hold match/deny message
const DOOR_MS = 5000; // hw_status poll (auto-connect supervisor runs in Rust)

export function initGate() {
  const exposure = document.getElementById("exposure");
  const match = document.getElementById("match");
  if (exposure && !exposure.dataset.bound) {
    exposure.dataset.bound = "1";
    exposure.textContent = "Waiting for camera…";
  }
  if (match && !match.dataset.bound) {
    match.dataset.bound = "1";
    match.textContent = "";
  }
  refreshDoor();
  startLoop();
}

export function stopGate() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function startLoop() {
  if (timer) return;
  let tickCount = 0;
  const tick = async () => {
    timer = setTimeout(tick, FRAME_MS);
    if (tickCount++ % Math.round(DOOR_MS / FRAME_MS) === 0) refreshDoor();
    if (busy || !invoke) return;
    const video = document.getElementById("cam");
    if (!video || video.readyState < 2) return;

    busy = true;
    try {
      const dataUrl = grabFrame(video);
      const scan = await invoke("gate_scan_frame", { dataUrl });
      applyScan(scan);
    } catch (e) {
      const match = document.getElementById("match");
      if (match) match.textContent = String(e);
    } finally {
      busy = false;
    }
  };
  timer = setTimeout(tick, FRAME_MS);
}

function grabFrame(video) {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  let canvas = document.getElementById("gate-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "gate-canvas";
    canvas.width = w;
    canvas.height = h;
    canvas.style.display = "none";
    document.body.appendChild(canvas);
  } else if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function applyScan(scan) {
  const exposure = document.getElementById("exposure");
  const match = document.getElementById("match");
  if (exposure && scan?.exposure) {
    const gamma = scan.gamma && scan.gamma !== 1 ? ` · γ=${scan.gamma.toFixed(2)}` : "";
    exposure.textContent = `${scan.exposure}${gamma}`;
    exposure.style.color =
      scan.exposure === "Good" ? "#3ddc97" : scan.exposure === "Unusable" ? "#ff6b6b" : "#ffd166";
  }
  if (!match) return;

  if (scan?.matched) {
    const [memberId, score] = scan.matched;
    admit(memberId, score);
    return;
  }
  if (scan?.face_score >= 0.6) {
    showHint("Face not recognized — enroll at front desk", "#ffd166");
  } else if (scan?.exposure === "Unusable") {
    showHint("Adjust lighting — face too dark/bright", "#ff6b6b");
  } else {
    showHint("Looking for face…", "#9aa4b2");
  }
}

async function admit(memberId, score) {
  const match = document.getElementById("match");
  try {
    const result = await invoke("gate_checkin", { memberId, confidence: score });
    if (result === "cooldown") {
      showHint("Already checked in", "#ffd166");
      return;
    }
    showHint(`Welcome! (${(score * 100).toFixed(0)}%)`, "#3ddc97");
    try {
      await invoke("hw_unlock", { durationMs: 3000 });
      setDoor("unlocked — maglock pulsed", "#3ddc97");
    } catch (e) {
      // Never swallow: a gate that greets but doesn't open looks "fine" until class starts.
      setDoor(`NOT OPENING — ${e}`, "#ff6b6b");
    }
  } catch (e) {
    showHint(String(e), "#ff6b6b");
  }
}

async function refreshDoor() {
  if (!invoke) return;
  try {
    const st = await invoke("hw_status");
    if (!st?.feature) {
      setDoor("controller disabled in this build", "#ff6b6b");
    } else if (st?.connected) {
      setDoor(`controller on ${st.port}`, "#3ddc97");
    } else {
      setDoor("waiting for ESP32 controller…", "#ffd166");
    }
  } catch (e) {
    setDoor(String(e), "#ff6b6b");
  }
}

function setDoor(text, color) {
  const el = document.getElementById("door");
  if (!el) return;
  el.textContent = text;
  el.style.color = color || "#9aa4b2";
}

function showHint(text, color) {
  const el = document.getElementById("match");
  if (!el) return;
  el.textContent = text;
  el.style.color = color || "#e6e9f0";
  el.dataset.until = String(Date.now() + HINT_MS);
}
