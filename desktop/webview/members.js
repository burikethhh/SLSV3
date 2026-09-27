// Members — list local roster + enroll a face via the gate camera.
const invoke = window.__TAURI__?.core?.invoke;
let timer;

export async function initMembers() {
  const root = document.getElementById("view-members");
  if (!root || root.dataset.bound) {
    await list();
    return;
  }
  root.dataset.bound = "1";
  root.innerHTML = `
    <h2>Members</h2>
    <div class="row" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <input id="mem-q" placeholder="Search members…" />
      <input id="mem-name" placeholder="Full name" />
      <button id="mem-enroll" class="primary">Enroll face (uses camera)</button>
      <span id="mem-msg" class="hint"></span>
    </div>
    <div id="member-list"></div>
    <p class="hint">Enroll: stand in front of the gate camera, enter a name, click Enroll.
      Face must be detected (YuNet) and bright enough; embedding is 512-d EdgeFace.</p>`;

  document.getElementById("mem-q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(list, 150);
  });
  document.getElementById("mem-enroll").onclick = enroll;
  await list();
}

async function list() {
  const el = document.getElementById("member-list");
  if (!el || !invoke) return;
  try {
    const q = document.getElementById("mem-q")?.value ?? "";
    const rows = await invoke("member_search", { q });
    el.innerHTML = rows.length
      ? `<table><thead><tr><th>Name</th><th>ID</th></tr></thead><tbody>` +
        rows.map((r) => `<tr><td>${esc(r.full_name)}</td><td class="hint">${esc(r.id)}</td></tr>`).join("") +
        `</tbody></table>`
      : `<p class="muted hint">No members yet — enroll one above.</p>`;
  } catch (e) {
    el.textContent = String(e);
  }
}

async function enroll() {
  const msg = document.getElementById("mem-msg");
  const name = document.getElementById("mem-name")?.value.trim();
  if (!invoke) { msg.textContent = "Tauri shell not detected"; return; }
  if (!name) { msg.textContent = "Enter a full name first."; return; }

  const video = document.getElementById("cam");
  if (!video || video.readyState < 2) { msg.textContent = "Camera not ready — open Gate view once."; return; }

  msg.textContent = "Scanning…";
  try {
    const dataUrl = grabFrame(video);
    const scan = await invoke("gate_scan_frame", { dataUrl });
    if (!scan?.embedding) {
      msg.textContent = scan?.exposure === "Unusable"
        ? "Face unusable (lighting) — adjust and retry."
        : "No face detected — step closer / face the camera.";
      msg.style.color = "#ff6b6b";
      return;
    }
    const memberId = crypto.randomUUID();
    await invoke("face_enroll", { memberId, fullName: name, embedding: scan.embedding });
    msg.textContent = `Enrolled “${name}” (${(scan.face_score * 100).toFixed(0)}% conf).`;
    msg.style.color = "#3ddc97";
    document.getElementById("mem-name").value = "";
    await list();
  } catch (e) {
    msg.textContent = String(e);
    msg.style.color = "#ff6b6b";
  }
}

function grabFrame(video) {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  let canvas = document.getElementById("gate-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "gate-canvas";
    canvas.style.display = "none";
    document.body.appendChild(canvas);
  }
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
