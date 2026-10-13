// One native terminal state controls navigation and operational access.
import { renderConnection } from "./connection.js";
const invoke = window.__TAURI__?.core?.invoke;
const modules = {
  pos: () => import("./pos.js").then((m) => m.initPos()),
  gate: () => import("./gate.js").then((m) => m.initGate()),
  members: () => import("./members.js").then((m) => m.initMembers()),
  dash: () => import("./dash.js").then((m) => m.initDash()),
  settings: () => import("./settings.js").then((m) => m.initSettings()),
};
let activeView = "connection";
let polling = false;
let lastGym = null;
window.__sls_operable = false;
const stage = document.getElementById("stage");
const connection = document.createElement("section");
connection.id = "view-connection";
stage.prepend(connection);
const link = document.createElement("button");
link.className = "nav-item"; link.dataset.view = "connection";
link.innerHTML = '<span class="lbl">Account & Help</span>';
document.getElementById("sidebar").prepend(link);

function setBadge(id, text, tone) {
  const el = document.getElementById(id);
  if (el) { el.className = `badge ${tone || ""}`; el.textContent = text; }
}
async function showView(view) {
  if (view !== "connection" && !window.__sls_operable) view = "connection";
  activeView = view;
  document.querySelectorAll("#stage > section").forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  window.dispatchEvent(new CustomEvent("sls:view", { detail: view }));
  if (view !== "connection") {
    try { await modules[view]?.(); }
    catch (error) { setBadge("hdr-sync", String(error), "bad"); }
  }
}
window.__sls_open_connection = () => showView("connection");
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => void showView(button.dataset.view)));
document.getElementById("hdr-unlock").disabled = true;
document.getElementById("hdr-unlock").addEventListener("click", async () => {
  if (!invoke || !window.__sls_operable) return;
  try {
    await invoke("hw_manual_override", { operator: "Kiosk Staff", duration_ms: 3000 });
    setBadge("hdr-hw", "Gate unlock sent", "good");
  } catch (error) { setBadge("hdr-hw", String(error), "bad"); }
});

async function refreshHeader() {
  if (polling) return;
  polling = true;
  try {
    const account = invoke ? await invoke("account_status") : {
      signed_in: false, gyms: [], online: false, license: { type: "Unlicensed" },
      message: "Open the installed GymPOS desktop app to connect.",
    };
    renderConnection(account);
    const type = String(account.license?.type || "unlicensed").toLowerCase();
    const operable = !!invoke && !!account.gym_id && ["valid", "graceperiod"].includes(type);
    const wasOperable = window.__sls_operable;
    if (lastGym && account.gym_id && lastGym !== account.gym_id) { location.reload(); return; }
    lastGym = account.gym_id;
    window.__sls_operable = operable;
    document.getElementById("hdr-unlock").disabled = !operable || !["owner", "manager"].includes(account.operator?.role);
    if (activeView === "settings") await modules.settings();
    document.querySelectorAll(".nav-item").forEach((button) => { button.disabled = button.dataset.view !== "connection" && !operable; });
    const label = type === "valid" ? `${account.license.tier?.toUpperCase() || "ACTIVE"} · ${account.license.days_remaining}d`
      : type === "graceperiod" ? `GRACE · ${account.license.grace_days_remaining}d` : type.toUpperCase();
    setBadge("hdr-license", label, operable ? (type === "graceperiod" ? "warn" : "good") : "bad");
    setBadge("hdr-sync", `${account.online ? "CLOUD VERIFIED" : "OFFLINE"} · ${account.pending_uploads || 0} pending`, account.online ? "good" : "warn");
    document.getElementById("hdr-gym").textContent = account.gym_name || "GymPOS · Connect your account";
    if (invoke) {
      const hardware = await invoke("hw_status");
      setBadge("hdr-hw", hardware.connected ? `Controller · ${hardware.port || "connected"}` : "Controller disconnected", hardware.connected ? "good" : "warn");
    } else setBadge("hdr-hw", "DESKTOP BRIDGE UNAVAILABLE", "bad");
    if (!operable) {
      window.__sls_media_stream?.getTracks().forEach((track) => track.stop());
      window.__sls_media_stream = null;
      if (activeView !== "connection" || !wasOperable) await showView("connection");
    } else if (!wasOperable) {
      startCamera();
      await showView("gate");
    }
  } catch (error) {
    window.__sls_operable = false;
    document.getElementById("hdr-unlock").disabled = true;
    setBadge("hdr-license", "STATUS UNAVAILABLE", "bad");
    await showView("connection");
  } finally { polling = false; }
}
window.__sls_refresh_state = refreshHeader;
void showView("connection");
void refreshHeader();
setInterval(() => void refreshHeader(), 1000);
window.addEventListener("focus", () => {
  if (invoke) void invoke("account_refresh").catch(() => {}).finally(refreshHeader);
});
// Single camera preview (detection/recognition run in Rust via ort; JS only previews + exposure hint)
export function startCamera() {
  if (!window.__sls_operable || window.__sls_media_stream) return;
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

// ── Kiosk Keyboard Shortcuts (F1-F5 views, Esc close) ──
// NOTE: no Spacebar unlock — a stray keypress must never pulse the maglock.
// Staff opens the gate via the header button or Gate view manual admit.
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
});
