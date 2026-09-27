// Simple view router (no framework = lightweight)
// Views lazy-load so the gate kiosk never pays for POS/dashboard JS.

const modules = {
  pos: () => import("./pos.js").then((m) => m.initPos()),
  gate: () => import("./gate.js").then((m) => m.initGate()),
  members: () => import("./members.js").then((m) => m.initMembers()),
  dash: () => import("./dash.js").then((m) => m.initDash()),
  settings: () => import("./settings.js").then((m) => m.initSettings()),
};

document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("main > section").forEach((s) => (s.hidden = true));
    document.getElementById(`view-${b.dataset.view}`).hidden = false;
    const load = modules[b.dataset.view];
    if (load) load();
  });
});

// Single camera preview (detection/recognition run in Rust via ort; JS only previews + exposure hint)
navigator.mediaDevices?.getUserMedia?.({ video: { width: 640 } })
  .then((s) => { document.getElementById("cam").srcObject = s; })
  .catch((e) => {
    // One "Block" sticks in WebView2 — show it instead of a dead "Waiting for camera…".
    const el = document.getElementById("exposure");
    if (el) {
      el.textContent = `Camera denied: ${e?.message || e} (reset via site settings / reinstall)`;
      el.style.color = "#ff6b6b";
    }
  });

// Auto-load settings on boot so license status is visible immediately.
modules.settings();
