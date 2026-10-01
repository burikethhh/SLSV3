// Sidebar router + terminal header (license/hw badges, quick unlock).
// Views lazy-load so the gate kiosk never pays for POS/dashboard JS.
const invoke = window.__TAURI__?.core?.invoke;

const modules = {
  pos: () => import("./pos.js").then((m) => m.initPos()),
  gate: () => import("./gate.js").then((m) => m.initGate()),
  members: () => import("./members.js").then((m) => m.initMembers()),
  dash: () => import("./dash.js").then((m) => m.initDash()),
  settings: () => import("./settings.js").then((m) => m.initSettings()),
};

function setBadge(id, text, tone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `badge${tone ? " " + tone : ""}`;
  el.textContent = text;
}

/** Header mirrors the gate/hw state without duplicating the views' own
 *  polling — refreshed on boot + every view switch. All guarded: a missing
 *  shell (plain-browser preview) just shows neutral badges. */
async function refreshHeader() {
  if (!invoke) {
    setBadge("hdr-sync", "SYNCED", "good");
    setBadge("hdr-license", "S · ULTRA", "badge-ultra");
    setBadge("hdr-hw", "ESP32 ONLINE", "good");
    const gym = document.getElementById("hdr-gym");
    if (gym) gym.textContent = "SOLO LEVELING SYSTEM";
    return;
  }
  try {
    const st = await invoke("license_status");
    const t = String(st?.type ?? "unknown").toLowerCase();
    const rankBadge = t === "valid" ? "badge-ultra" : t === "graceperiod" ? "warn" : "bad";
    const rankLabel = t === "valid" ? "S · ULTRA" : t === "graceperiod" ? "GRACE PERIOD" : t;
    setBadge("hdr-license", rankLabel, rankBadge);
    const gym = document.getElementById("hdr-gym");
    if (gym && st?.gym_name) gym.textContent = String(st.gym_name).toUpperCase();
  } catch {
    setBadge("hdr-license", "license error", "bad");
  }
  try {
    const hw = await invoke("hw_status");
    if (!hw?.feature) setBadge("hdr-hw", "no controller", "bad");
    else if (hw?.connected) setBadge("hdr-hw", `ESP32 ${hw.port ?? ""}`.trim(), "good");
    else setBadge("hdr-hw", "waiting ESP32…", "warn");
  } catch {
    setBadge("hdr-hw", "controller error", "bad");
  }
  try {
    const pending = await invoke("sync_pending");
    if (pending > 0) {
      setBadge("hdr-sync", `${pending} QUEUE`, "warn");
    } else {
      setBadge("hdr-sync", "SYNCED", "good");
    }
  } catch {
    if (!invoke) setBadge("hdr-sync", "LOCAL SQLITE", "badge-pro");
  }
}

document.querySelectorAll(".nav-item").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll("main > section").forEach((s) => (s.hidden = true));
    document.getElementById(`view-${b.dataset.view}`).hidden = false;
    const load = modules[b.dataset.view];
    if (load) load();
    void refreshHeader();
  });
});

document.getElementById("hdr-unlock")?.addEventListener("click", async () => {
  const btn = document.getElementById("hdr-unlock");
  if (btn) {
    btn.style.filter = "brightness(1.4)";
    setTimeout(() => { btn.style.filter = ""; }, 1000);
  }
  window.__sls_log_override?.("Staff Override");
  if (!invoke) {
    setBadge("hdr-hw", "unlocked — maglock pulsed (demo)", "good");
    setTimeout(() => refreshHeader(), 3000);
    return;
  }
  try {
    await invoke("hw_manual_override", { operator: "Kiosk Staff", durationMs: 3000 });
    setBadge("hdr-hw", "unlocked — maglock pulsed", "good");
  } catch (e) {
    // Never swallow: a gate that greets but doesn't open looks "fine" until class starts.
    setBadge("hdr-hw", `NOT OPENING — ${e}`, "bad");
  }
});

// Single camera preview (detection/recognition run in Rust via ort; JS only previews + exposure hint)
export function startCamera() {
  const retryBtn = document.getElementById("cam-retry");
  if (retryBtn) retryBtn.style.display = "none";
  navigator.mediaDevices?.getUserMedia?.({ video: { width: 640 } })
    .then((s) => {
      window.__sls_media_stream = s;
      const cam = document.getElementById("cam");
      if (cam) cam.srcObject = s;
      const enrollCam = document.getElementById("enroll-cam");
      if (enrollCam) enrollCam.srcObject = s;
      if (retryBtn) retryBtn.style.display = "none";
    })
    .catch((e) => {
      // One "Block" sticks in WebView2 — show it instead of a dead "Waiting for camera…".
      const el = document.getElementById("exposure");
      if (el) {
        el.textContent = `Camera denied: ${e?.message || e} (reset site settings / reconnect)`;
        el.style.color = "#ff6b6b";
      }
      if (retryBtn) retryBtn.style.display = "block";
    });
}
window.__sls_start_cam = startCamera;
startCamera();

// Auto-load gate and settings on boot so initial view is initialized.
modules.gate();
modules.settings();
void refreshHeader();

// Collapsing sidebar rail (persisted per terminal).
try {
  if (localStorage.getItem("sls.rail") === "1") {
    document.getElementById("workspace")?.classList.add("rail");
  }
} catch { /* private mode: rail just won't persist */ }
document.getElementById("side-toggle")?.addEventListener("click", () => {
  const ws = document.getElementById("workspace");
  if (!ws) return;
  const rail = !ws.classList.contains("rail");
  ws.classList.toggle("rail", rail);
  try { localStorage.setItem("sls.rail", rail ? "1" : "0"); } catch { /* ignore */ }
});

// ── Kiosk Keyboard Shortcuts (F1-F5 views, Spacebar gate unlock, Esc close) ──
window.addEventListener("keydown", (e) => {
  const target = e.target;
  const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

  if (e.key === "Escape") {
    const manualBox = document.getElementById("stream-manual-box");
    if (manualBox) manualBox.style.display = "none";
    return;
  }

  if (isInput) return;

  if (e.key === "F1") { e.preventDefault(); document.querySelector('.nav-item[data-view="gate"]')?.click(); }
  else if (e.key === "F2") { e.preventDefault(); document.querySelector('.nav-item[data-view="pos"]')?.click(); }
  else if (e.key === "F3") { e.preventDefault(); document.querySelector('.nav-item[data-view="members"]')?.click(); }
  else if (e.key === "F4") { e.preventDefault(); document.querySelector('.nav-item[data-view="dash"]')?.click(); }
  else if (e.key === "F5") { e.preventDefault(); document.querySelector('.nav-item[data-view="settings"]')?.click(); }
  else if (e.code === "Space") {
    e.preventDefault();
    document.getElementById("hdr-unlock")?.click();
  }
});
