// Native manager-session gated settings. Account activation is separate.
const invoke = window.__TAURI__?.core?.invoke;

let unlocked = false; // session-only; a restart re-locks

export async function initSettings() {
  const root = document.getElementById("view-settings");
  if (!root) return;
  const locked = invoke ? await invoke("settings_lock_state").catch(() => true) : true;
  if (locked) {
    unlocked = false;
    if (root.dataset.mode !== "lock") {
      renderLock(root);
    }
    await showStatus(root);
    return;
  }
  if (root.dataset.mode !== "settings") {
    renderSettings(root);
    await refresh();
    return;
  }
  await refresh();
}

function renderLock(root) {
  root.dataset.mode = "lock";
  root.innerHTML = `
    <h2>Settings — Terminal Security</h2>
    <div class="pin-lock-container glass">
      <div class="pin-head">
        <div class="pin-emblem">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--brand);filter:drop-shadow(0 0 6px var(--brand));"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        </div>
        <div>
          <div class="pin-title">STAFF AUTHENTICATION</div>
          <p class="hint" style="margin:2px 0 0">Enter staff PIN to access terminal &amp; gateway settings.</p>
        </div>
      </div>
      <label>Staff Username <input id="lock-user" value="admin" autocomplete="off" style="width:100%" /></label>
      <label>PIN Code
        <div class="pin-display-wrap">
          <input id="lock-pin" class="pin-display" type="password" inputmode="numeric" maxlength="12" placeholder="6–12 digit PIN" style="width:100%" />
        </div>
      </label>
      <div class="pin-grid">
        <button type="button" class="pin-key" data-val="1">1</button>
        <button type="button" class="pin-key" data-val="2">2</button>
        <button type="button" class="pin-key" data-val="3">3</button>
        <button type="button" class="pin-key" data-val="4">4</button>
        <button type="button" class="pin-key" data-val="5">5</button>
        <button type="button" class="pin-key" data-val="6">6</button>
        <button type="button" class="pin-key" data-val="7">7</button>
        <button type="button" class="pin-key" data-val="8">8</button>
        <button type="button" class="pin-key" data-val="9">9</button>
        <button type="button" class="pin-key pin-clear" data-val="clear">CLR</button>
        <button type="button" class="pin-key" data-val="0">0</button>
        <button type="button" class="pin-key pin-back" data-val="back" aria-label="Backspace">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path><line x1="18" y1="9" x2="12" y2="15"></line><line x1="12" y1="9" x2="18" y2="15"></line></svg>
        </button>
      </div>
      <div class="row" style="display:flex;gap:8px;margin-top:6px">
        <button id="lock-go" class="primary" style="width:100%;height:44px;font-size:15px">Unlock Settings</button>
      </div>
      <p id="lock-msg" class="hint" style="text-align:center;min-height:1.2em"></p>
      <div id="set-status" class="hint" style="margin-top:4px"></div>
    </div>`;

  const pinInput = document.getElementById("lock-pin");
  root.querySelectorAll(".pin-key").forEach((k) => {
    k.addEventListener("click", () => {
      const v = k.dataset.val;
      if (v === "clear") {
        pinInput.value = "";
      } else if (v === "back") {
        pinInput.value = pinInput.value.slice(0, -1);
      } else if (pinInput.value.length < 12) {
        pinInput.value += v;
      }
      pinInput.dispatchEvent(new Event("input"));
    });
  });

  const go = async () => {
    const msg = document.getElementById("lock-msg");
    const username = document.getElementById("lock-user").value.trim();
    const pin = document.getElementById("lock-pin").value.trim();
    if (!username || !pin) { msg.textContent = "Username and PIN required."; msg.style.color = "#fbbf24"; return; }
    try {
      if (invoke) {
        const role = await invoke("staff_verify", { username, pin });
        if (!["manager", "owner"].includes(role)) throw new Error("Cashier signed in. Terminal settings require a manager PIN.");
      }
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
  root.innerHTML = `<h2>Terminal settings</h2><div class="glass panel" style="max-width:680px;margin-top:16px">
    <h3>Account & subscription</h3><p class="hint">Activation and renewal are managed by your connected owner account. License keys and cloud addresses are handled automatically.</p>
    <button id="settings-connection">Open account & connection help</button><div id="set-status" class="hint"></div>
    <h3>Hardware & updates</h3><div class="row"><button id="set-update">Check for updates</button><button id="set-hw">Reconnect controller</button></div>
    <p id="set-update-result" role="status"></p><p id="set-extra" role="status"></p><div id="set-restart"></div></div>`;
  document.getElementById("settings-connection").onclick = () => window.__sls_open_connection?.();
  document.getElementById("set-hw").onclick = async () => {
    const el = document.getElementById("set-extra");
    try { el.textContent = String(await invoke("hw_connect", {})); } catch (error) { el.textContent = String(error); }
  };
  document.getElementById("set-update").onclick = async () => {
    const el = document.getElementById("set-update-result");
    el.textContent = "Checking…";
    try {
      const response = await invoke("update_check");
      if (!response?.update) { el.textContent = "No newer release available."; return; }
      el.innerHTML = `Version ${escapeHtml(response.version)} available. <button id="set-install">Install update</button>`;
      document.getElementById("set-install").onclick = async () => {
        if (!confirm("Install this update? GymPOS may close during installation.")) return;
        try { await invoke("update_install"); await renderRestartBanner(); }
        catch (error) { el.textContent = String(error); }
      };
    } catch (error) { el.textContent = String(error); }
  };
}

async function showStatus(root) {
  const el = root.querySelector("#set-status");
  if (!el) return;
  await fillStatus(el);
}

async function fillStatus(el) {
  if (!invoke) {
    el.innerHTML =
      `License: <strong style="color:#fbbf24">S · Ultra (Active · 30d remaining)</strong> · Solo Leveling System HQ<br/>` +
      `Pending sync: 0 · Controller: Connected`;
    return;
  }
  try {
    const status = await invoke("license_status");
    const pending = await invoke("sync_pending");
    const dropped = await invoke("settings_get", { key: "sync_dropped" }).catch(() => null);
    const quarantined = await invoke("settings_get", { key: "sync_quarantined" }).catch(() => null);
    const type = status?.type ?? "unknown";
    const t = String(type).toLowerCase();
    const color = t === "valid" ? "#3ddc97" : t === "graceperiod" ? "#ffd166" : "#ff6b6b";
    const detail = status?.gym_name ? ` · ${status.gym_name}` : "";
    let label = t;
    if (t === "valid") {
      const d = status?.days_remaining;
      label = d !== undefined ? `valid (${d}d remaining)` : "valid";
    } else if (t === "graceperiod") {
      const g = status?.grace_days_remaining;
      label = g !== undefined ? `⚠️ grace period (${g}d left before lock)` : "grace period";
    } else if (t === "expired") {
      label = "❌ expired (terminal locked)";
    }
    const dlq = `${Number(quarantined) > 0 ? ` · ${quarantined} quarantined (needs recovery)` : ""}${Number(dropped) > 0 ? ` · ${dropped} previously dropped` : ""}`;
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
  await renderRestartBanner();
}

/** Restart banner once an update (boot auto-install or manual) is staged. */
async function renderRestartBanner() {
  const host = document.getElementById("set-restart");
  if (!host) return; // lock screen has no banner slot
  const v = invoke ? await invoke("settings_get", { key: "pending_restart" }).catch(() => null) : null;
  if (!v) { host.innerHTML = ""; return; }
  host.innerHTML = `<div class="update-banner">Installed <strong>v${escapeHtml(String(v))}</strong>&nbsp;— restart the terminal to apply.&nbsp;<button id="set-restart-go" class="primary">Restart now</button></div>`;
  document.getElementById("set-restart-go").onclick = () => invoke("restart_app");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
