// Settings — PIN-gated license/cloud config (terminal-PIN architecture:
// locked once staff rows arrive via sync; fresh installs stay open so the
// FIRST license can be applied). Also: update check, sync/DLQ status,
// controller reconnect.
const invoke = window.__TAURI__?.core?.invoke;

const DEFAULT_URL = "https://tlfytevjhzcgrttcdipq.supabase.co";
let unlocked = false; // session-only; a restart re-locks

export async function initSettings() {
  const root = document.getElementById("view-settings");
  if (!root) return;
  if (!root.dataset.bound) {
    root.dataset.bound = "1";
    // In preview mode default to locked once so touch keypad is visible and interactive
    const locked = invoke ? await invoke("settings_lock_state").catch(() => false) : true;
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
          <input id="lock-pin" class="pin-display" type="password" inputmode="numeric" maxlength="6" placeholder="••••" style="width:100%" />
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
      } else if (pinInput.value.length < 6) {
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
        await invoke("staff_verify", { username, pin });
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
  root.innerHTML = `
    <h2>Settings — License &amp; Cloud Gateway</h2>
    <div style="display:flex;flex-direction:column;gap:14px;max-width:680px;margin-top:12px">
      <div class="glass panel" style="border: 1px solid rgba(139, 92, 246, 0.4); background: rgba(139, 92, 246, 0.05);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <h3 style="margin:0;font-size:1.15rem;color:var(--brand);letter-spacing:1px">DIRECT CLOUD ACTIVATION</h3>
          <span class="badge badge-pro" style="font-size:11px">Zero Friction</span>
        </div>
        <p class="hint" style="margin:0 0 12px">Sign in with your SLS Account to automatically fetch your gym's trial or production license and license GymPOS without copying keys.</p>
        <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <label style="font-size:12px;color:var(--muted)">SLS Account Email</label>
            <input id="cloud-email" type="email" placeholder="owner@gym.com" style="width:100%" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--muted)">Password</label>
            <input id="cloud-pass" type="password" placeholder="••••••••" style="width:100%" />
          </div>
        </div>
        <button id="cloud-login-btn" class="primary" style="width:100%;height:42px;font-weight:700;font-size:14px">
          ⚡ Login with SLS Account &amp; License GymPOS
        </button>
        <div id="cloud-msg" class="hint" style="margin-top:8px"></div>
      </div>

      <div class="glass panel">
        <h3 style="margin:0 0 10px;font-size:1.1rem;color:var(--cyan);letter-spacing:1px">MANUAL LICENSE KEY &amp; HUNTER GUILD RANK</h3>
        <label>Terminal License Key (GPOS-…) <textarea id="set-token" rows="3" style="width:100%;font-family:monospace" placeholder="GPOS-…"></textarea></label>
        <div style="margin-top:10px">
          <button id="set-apply" class="primary">Apply &amp; Verify License</button>
        </div>
        <p id="set-msg" class="hint" style="margin-top:8px"></p>
        <div id="set-status" class="hint" style="margin-top:8px"></div>
      </div>

      <div class="glass panel">
        <h3 style="margin:0 0 10px;font-size:1.1rem;color:var(--cyan);letter-spacing:1px">CLOUD GATEWAY CONNECTION</h3>
        <label>Supabase Gateway URL <input id="set-url" placeholder="${DEFAULT_URL}" style="width:100%" /></label>
        <div style="margin-top:10px">
          <button id="set-save-url">Save URL Only</button>
        </div>
      </div>

      <div class="glass panel">
        <h3 style="margin:0 0 10px;font-size:1.1rem;color:var(--cyan);letter-spacing:1px">TERMINAL HARDWARE &amp; RELEASES</h3>
        <div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button id="set-update">Check For Updates</button>
          <button id="set-hw">Reconnect ESP32 Controller</button>
          <span id="set-extra" class="hint"></span>
        </div>
        <div id="set-update-result" class="hint" style="margin-top:8px"></div>
        <div id="set-restart" style="margin-top:8px"></div>
      </div>
    </div>`;

  bindActions();
}

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZnl0ZXZqaHpjZ3J0dGNkaXBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwODgzNTksImV4cCI6MjEwNjY2NDM1OX0.oS15b2wahLDuSeMZ99NX2toZrOFvEOfe2ddYnRwiwc4";

async function bindActions() {
  const url = await invoke?.("settings_get", { key: "supabase_url" }).catch(() => null);
  document.getElementById("set-url").value = url || DEFAULT_URL;

  // ── Direct Cloud Sign-In & Activation ──
  document.getElementById("cloud-login-btn").onclick = async () => {
    const email = document.getElementById("cloud-email").value.trim();
    const password = document.getElementById("cloud-pass").value;
    const supabaseUrl = document.getElementById("set-url").value.trim() || DEFAULT_URL;
    const msg = document.getElementById("cloud-msg");
    if (!email || !password) {
      msg.textContent = "Please enter both your SLS account email and password.";
      msg.style.color = "#fbbf24";
      return;
    }
    msg.textContent = "Signing in with SLS Cloud…";
    msg.style.color = "#38bdf8";

    try {
      // 1. Authenticate with Supabase Auth
      const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      if (!authRes.ok) {
        const err = await authRes.json().catch(() => ({}));
        throw new Error(err.error_description || err.msg || "Authentication failed. Please check credentials.");
      }
      const authData = await authRes.json();
      const accessToken = authData.access_token;

      msg.textContent = "Authenticated! Fetching assigned license key from cloud…";

      // 2. Query license from Supabase with RLS
      const licRes = await fetch(`${supabaseUrl}/rest/v1/licenses?select=id,gym_id,revoked,expires_at,tier,price_usd,is_trial,raw_token&order=created_at.desc&limit=5`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!licRes.ok) throw new Error("Could not fetch licenses: " + (await licRes.text()));
      const licenses = await licRes.json();
      if (!licenses || licenses.length === 0) {
        throw new Error("No license key found for this account. If you just registered, your application is pending review or no gym is linked.");
      }

      const lic = licenses.find((l) => !l.revoked) || licenses[0];
      if (lic.revoked) {
        throw new Error("License has been revoked by system administration. Terminal locked.");
      }

      const now = Date.now();
      const exp = new Date(lic.expires_at).getTime();
      const diffDays = (exp - now) / 86400000;

      if (diffDays < -3) {
        throw new Error(`License expired on ${new Date(lic.expires_at).toLocaleDateString()} and 3-day grace period has elapsed. Please renew subscription on web portal.`);
      }

      if (!lic.raw_token) {
        throw new Error("License record exists but key token is missing. Please contact CEO.");
      }

      // 3. Apply license via Tauri invoke
      if (invoke) {
        await invoke("license_apply", { token: lic.raw_token, supabase_url: supabaseUrl });
      }

      const typeStr = lic.is_trial ? "14-Day Free Trial" : "30-Day Official Subscription";
      if (diffDays <= 0 && diffDays >= -3) {
        const graceLeft = Math.ceil(3 + diffDays);
        msg.innerHTML = `⚠️ <strong style="color:#ffd166">3-Day Grace Period Active (${graceLeft}d left)</strong><br/>` +
          `Account: ${escapeHtml(email)} · ${lic.tier.toUpperCase()} Tier (${typeStr})<br/>` +
          `GymPOS licensed and active under grace period!`;
        msg.style.color = "#ffd166";
      } else {
        const daysLeft = Math.ceil(diffDays);
        msg.innerHTML = `✅ <strong style="color:#3ddc97">Terminal Successfully Licensed!</strong><br/>` +
          `Account: ${escapeHtml(email)} · ${lic.tier.toUpperCase()} Tier (${typeStr})<br/>` +
          `${daysLeft} days remaining on subscription.<br/>` +
          `<span style="font-size:11px;color:#94a3b8">Terminals and gates are now fully operational.</span>`;
        msg.style.color = "#3ddc97";
      }

      document.getElementById("cloud-pass").value = "";
      await refresh();
    } catch (e) {
      msg.textContent = String(e.message || e);
      msg.style.color = "#ff6b6b";
    }
  };

  document.getElementById("set-apply").onclick = async () => {
    const msg = document.getElementById("set-msg");
    const token = document.getElementById("set-token").value.trim();
    const supabaseUrl = document.getElementById("set-url").value.trim();
    if (!token) { msg.textContent = "Paste a license key first."; return; }
    msg.textContent = "Verifying…";
    try {
      const result = await invoke("license_apply", { token, supabase_url: supabaseUrl });
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
          (r.notes ? `<br/>${escapeHtml(String(r.notes))}` : "") +
          `<br/><button id="set-install" class="primary" style="margin-top:8px">Download &amp; install now</button>`;
        document.getElementById("set-install").onclick = async () => {
          out.textContent = "Downloading & installing in the background — the terminal stays usable…";
          try {
            const v = await invoke("update_install");
            out.textContent = v === "already latest" ? "Already on the latest version." : `Installed v${v}.`;
            await renderRestartBanner();
          } catch (e) {
            out.textContent = String(e);
            out.style.color = "#ff6b6b";
          }
        };
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
