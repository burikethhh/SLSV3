// Settings — PIN-gated license/cloud config (terminal-PIN architecture:
// locked once staff rows arrive via sync; fresh installs stay open so the
// FIRST license can be applied). Also: update check, sync/DLQ status,
// controller reconnect.
const invoke = window.__TAURI__?.core?.invoke;

const DEFAULT_URL = "https://cjxpsiuvwihanxqccpnf.supabase.co";
let unlocked = false; // session-only; a restart re-locks

export async function initSettings() {
  const root = document.getElementById("view-settings");
  if (!root) return;
  if (!root.dataset.bound) {
    root.dataset.bound = "1";
    const locked = invoke ? await invoke("settings_lock_state").catch(() => false) : false;
    if (locked && !unlocked) {
      renderLock(root);
      await showStatus(root);
      return;
    }
  }
  if (!root.dataset.mode) {
    renderSettings(root);
    await refresh();
    return;
  }
  await refresh();
}

function renderLock(root) {
  root.dataset.mode = "lock";
  root.innerHTML = `
    <h2>Settings — locked</h2>
    <div class="row" style="display:flex;flex-direction:column;gap:8px;max-width:420px">
      <p class="hint">Enter a staff PIN to change license or cloud settings.</p>
      <label>Username <input id="lock-user" autocomplete="off" style="width:100%" /></label>
      <label>PIN <input id="lock-pin" type="password" inputmode="numeric" maxlength="6" style="width:100%" /></label>
      <div class="row" style="display:flex;gap:8px">
        <button id="lock-go" class="primary">Unlock</button>
      </div>
      <p id="lock-msg" class="hint"></p>
      <div id="set-status" class="hint"></div>
    </div>`;

  const go = async () => {
    const msg = document.getElementById("lock-msg");
    const username = document.getElementById("lock-user").value.trim();
    const pin = document.getElementById("lock-pin").value.trim();
    if (!username || !pin) { msg.textContent = "Username and PIN required."; return; }
    try {
      await invoke("staff_verify", { username, pin });
      unlocked = true;
      delete root.dataset.mode;
      root.dataset.bound = "1";
      renderSettings(root);
      await refresh();
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
      document.getElementById("lock-pin").value = "";
    }
  };
  document.getElementById("lock-go").onclick = go;
  document.getElementById("lock-pin").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

function renderSettings(root) {
  root.dataset.mode = "settings";
  root.innerHTML = `
    <h2>Settings — license &amp; cloud</h2>
    <div class="row" style="display:flex;flex-direction:column;gap:8px;max-width:640px">
      <label>Supabase URL <input id="set-url" placeholder="${DEFAULT_URL}" style="width:100%" /></label>
      <label>License key (GPOS-…) <textarea id="set-token" rows="4" style="width:100%" placeholder="GPOS-…"></textarea></label>
      <div class="row" style="display:flex;gap:8px">
        <button id="set-apply" class="primary">Apply license</button>
        <button id="set-save-url">Save URL only</button>
      </div>
      <p id="set-msg" class="hint"></p>
      <div id="set-status" class="hint"></div>
      <hr style="border-color:#2a2f3a" />
      <div class="row" style="display:flex;gap:8px;align-items:center">
        <button id="set-update">Check for updates</button>
        <button id="set-hw">Reconnect controller</button>
        <span id="set-extra" class="hint"></span>
      </div>
      <div id="set-update-result" class="hint"></div>
    </div>`;

  bindActions();
}

async function bindActions() {
  const url = await invoke?.("settings_get", { key: "supabase_url" }).catch(() => null);
  document.getElementById("set-url").value = url || DEFAULT_URL;

  document.getElementById("set-apply").onclick = async () => {
    const msg = document.getElementById("set-msg");
    const token = document.getElementById("set-token").value.trim();
    const supabaseUrl = document.getElementById("set-url").value.trim();
    if (!token) { msg.textContent = "Paste a license key first."; return; }
    msg.textContent = "Verifying…";
    try {
      const result = await invoke("license_apply", { token, supabaseUrl });
      msg.textContent = `Applied: ${result}`;
      msg.style.color = "#3ddc97";
      document.getElementById("set-token").value = "";
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
    await refresh();
  };

  document.getElementById("set-save-url").onclick = async () => {
    const msg = document.getElementById("set-msg");
    try {
      await invoke("settings_set", { key: "supabase_url", value: document.getElementById("set-url").value.trim() });
      msg.textContent = "URL saved.";
      msg.style.color = "#3ddc97";
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
  };

  document.getElementById("set-update").onclick = async () => {
    const out = document.getElementById("set-update-result");
    out.textContent = "Checking…";
    out.style.color = "";
    try {
      const r = await invoke("update_check");
      if (r?.update) {
        out.innerHTML = `Update available: <strong>v${escapeHtml(String(r.version))}</strong> — ` +
          `<a href="${escapeHtml(String(r.url))}" target="_blank" rel="noopener" style="color:#4cc9f0">download installer</a>` +
          (r.notes ? `<br/>${escapeHtml(String(r.notes))}` : "");
      } else {
        out.textContent = r?.version ? `You're on the latest version (v${r.version}).` : "No releases published yet.";
      }
    } catch (e) {
      out.textContent = String(e);
      out.style.color = "#ff6b6b";
    }
  };

  document.getElementById("set-hw").onclick = async () => {
    const extra = document.getElementById("set-extra");
    try {
      const res = await invoke("hw_connect", {});
      extra.textContent = String(res);
      extra.style.color = "#3ddc97";
    } catch (e) {
      extra.textContent = String(e);
      extra.style.color = "#ff6b6b";
    }
  };
}

async function showStatus(root) {
  const el = root.querySelector("#set-status");
  if (!el || !invoke) return;
  await fillStatus(el);
}

async function fillStatus(el) {
  try {
    const status = await invoke("license_status");
    const pending = await invoke("sync_pending");
    const dropped = await invoke("settings_get", { key: "sync_dropped" }).catch(() => null);
    const type = status?.type ?? "unknown";
    const t = String(type).toLowerCase();
    const color = t === "valid" ? "#3ddc97" : t === "graceperiod" ? "#ffd166" : "#ff6b6b";
    const detail = status?.gym_name ? ` · ${status.gym_name}` : "";
    const label = t === "graceperiod" ? "grace period" : t;
    const dlq = dropped ? ` · ${dropped} dropped (dead-letter)` : "";
    el.innerHTML =
      `License: <strong style="color:${color}">${label}</strong>${detail}<br/>` +
      `Pending sync: ${pending}${dlq}`;
  } catch (e) {
    el.textContent = String(e);
  }
}

async function refresh() {
  const el = document.getElementById("set-status");
  if (el) await fillStatus(el);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
