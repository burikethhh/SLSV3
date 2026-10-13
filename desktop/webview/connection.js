// Account connection is available before activation and after expiry. PINs
// remain an operator workflow, not an obstacle to owner account recovery.
const invoke = window.__TAURI__?.core?.invoke;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let rendered = "";

export function renderConnection(account) {
  const root = document.getElementById("view-connection");
  const signature = `${account.signed_in}:${account.requires_mfa}:${account.gym_id ?? ""}:${account.legacy_imported}:${account.operator?.username || ""}:${JSON.stringify(account.gyms ?? [])}`;
  if (signature === rendered && root.childElementCount) { updateStatus(account); return; }
  rendered = signature;
  root.innerHTML = `<div class="connection-card glass panel">
    <h2>${account.signed_in ? "Your GymPOS connection" : "Welcome to GymPOS"}</h2>
    <p class="hint">Connect using the same owner account as your SLS dashboard. Your trial or paid subscription activates automatically—no key to paste.</p>
    ${!invoke ? '<p class="badge bad">Desktop connection unavailable. Open the installed GymPOS app; browser previews cannot activate a terminal.</p>' : ""}
    ${account.signed_in ? `<p>Signed in as <strong>${esc(account.email)}</strong></p>
      ${account.requires_mfa ? '<form id="connection-mfa"><label for="connection-code">Authenticator code</label><input id="connection-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /><button type="submit" class="primary">Verify two-factor code</button></form>' : ""}
      <form id="connect-facility"><label for="connection-gym">Facility / branch</label>
        <select id="connection-gym" required>${(account.gyms ?? []).map((gym) => `<option value="${esc(gym.id)}" ${gym.id === account.gym_id ? "selected" : ""}>${esc(gym.name)}${gym.disabled ? " (suspended)" : ""}</option>`).join("")}</select>
        <label for="connection-name">Terminal name</label><input id="connection-name" value="${esc(account.device_name || "Front Desk")}" maxlength="100" required />
        <p class="hint">Use a recognizable name, such as Main Entrance. Each facility keeps separate local data and pending uploads.</p>
        <button type="submit" class="primary" ${!account.gyms?.length ? "disabled" : ""}>${account.gym_id ? "Reconnect selected facility" : "Connect this terminal"}</button>
      </form><div class="row"><button id="connection-refresh">Refresh account & subscription</button><button id="connection-logout">Disconnect account</button></div>` : `
      <form id="connection-login"><label for="connection-email">Owner email address</label><input id="connection-email" type="email" autocomplete="username" required />
        <label for="connection-password">Password</label><input id="connection-password" type="password" autocomplete="current-password" required />
        <button type="submit" class="primary" ${!invoke ? "disabled" : ""}>Sign in with SLS account</button>
      </form>`}
    <p id="connection-status" role="status" aria-live="polite"></p><p id="connection-result" role="alert"></p>
    ${account.gym_id ? `<h3>Front-desk operator</h3>${account.operator ? `<p>Operator: ${esc(account.operator.username)} (${esc(account.operator.role)}). Sessions expire automatically; PIN changes/deactivation invalidate staff access on sync.</p><button id="operator-logout">Lock operator session</button>` : `<form id="operator-login"><label for="operator-user">Staff username</label><input id="operator-user" autocomplete="username" required /><label for="operator-pin">Staff PIN (6–12 digits)</label><input id="operator-pin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" required /><button class="primary">Start operator session</button></form><p class="hint">Create cashier and terminal-manager credentials in Dashboard → Staff. A fresh owner sign-in grants 15 minutes for setup; a saved account does not grant administrative operator access.</p>`}` : ""}
    ${account.legacy_rows_retained ? `<p class="badge warn" style="white-space:normal">${account.legacy_imported ? "Legacy recovery is recorded for this facility. Original data and recovery backups are retained; do not reopen the old app or re-enter old sales." : "Previous terminal data is retained separately. Recovery requires its signed facility identity to match this connection and no new local sales/pending records in the destination. Both databases are backed up first; quarantined records remain quarantined."}</p>
      ${account.gym_id && !account.legacy_imported ? '<button id="connection-recover">Back up & recover legacy records</button>' : ""}` : ""}
    <details open><summary>Getting started & help</summary>
      <ol><li>Create an owner account in the dashboard and verify your email.</li><li>Complete gym setup to start the 14-day trial.</li><li>Sign in here, select your gym, and name this terminal.</li><li>Once connected, set up products, membership plans, and staff from your dashboard. Then test the camera and controller.</li></ol>
      <p class="hint">Only owners can connect a terminal. Front-desk operators use their staff PINs after connection; do not share the owner password. CEO approval does not charge or activate a paid subscription until payment is confirmed.</p>
      <p class="hint">Paid subscriptions have a three-day grace period. Offline operation requires a successful verification within seven days and cannot extend expiry. Emergency/free exit is independent of subscription status.</p>
      <a href="https://sls.keth.website/#/owner/start" target="_blank" rel="noopener">Open SLS dashboard / registration / password recovery</a>
    </details></div>`;
  updateStatus(account);
  const run = async (button, action) => {
    if (button.disabled) return;
    button.disabled = true;
    const message = document.getElementById("connection-result");
    message.textContent = "Connecting…";
    try { await action(); message.textContent = ""; await window.__sls_refresh_state?.(); }
    catch (error) { message.textContent = String(error); }
    finally { button.disabled = false; }
  };
  root.querySelector("#connection-login")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = root.querySelector("#connection-password");
    const password = input.value; input.value = "";
    void run(e.submitter || root.querySelector('button[type="submit"]'), () => invoke("account_sign_in", { email: root.querySelector("#connection-email").value.trim(), password }));
  });
  root.querySelector("#connect-facility")?.addEventListener("submit", (e) => {
    e.preventDefault();
    void run(e.submitter || root.querySelector('button[type="submit"]'), async () => {
      await invoke("account_select_gym", { gym_id: root.querySelector("#connection-gym").value, device_name: root.querySelector("#connection-name").value.trim() });
      // Discard all previous facility's in-memory cart/member/PIN UI state.
      location.reload();
    });
  });
  root.querySelector("#connection-mfa")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = root.querySelector("#connection-code");
    const code = input.value; input.value = "";
    void run(e.submitter || root.querySelector("#connection-mfa button"), () => invoke("account_verify_mfa", { code }));
  });
  root.querySelector("#connection-refresh")?.addEventListener("click", (e) => void run(e.currentTarget, () => invoke("account_refresh")));
  root.querySelector("#operator-login")?.addEventListener("submit",e=> {
    e.preventDefault(); const pin=root.querySelector("#operator-pin").value;root.querySelector("#operator-pin").value="";
    void run(e.submitter,()=>invoke("staff_verify",{username:root.querySelector("#operator-user").value,pin}));
  });
  root.querySelector("#operator-logout")?.addEventListener("click",e=>void run(e.currentTarget,()=>invoke("operator_sign_out")));
  root.querySelector("#connection-recover")?.addEventListener("click", (e) => {
    if (!confirm(`Recover old records into ${account.gym_name || "this facility"}? Close any older GymPOS app first. Ownership is verified and backups are retained. Do not re-enter old sales.`)) return;
    void run(e.currentTarget, async () => {
      const result = await invoke("account_recover_legacy", { confirmation: account.gym_id });
      alert(result.already_imported ? "Recovery was already recorded; no pending records were replayed." : `Recovery complete. Backups: ${result.backup_folder}. Review pending/quarantined records before opening to customers.`);
      location.reload();
    });
  });
  root.querySelector("#connection-logout")?.addEventListener("click", (e) => {
    if (!confirm("Disconnect this terminal? Local records and pending uploads are retained for their facility. Operations will be locked.")) return;
    void run(e.currentTarget, async () => { await invoke("account_sign_out"); location.reload(); });
  });
}

function updateStatus(account) {
  const status = document.getElementById("connection-status");
  if (!status) return;
  const expiry = account.expires_at ? new Date(account.expires_at).toLocaleString() : "Not active";
  status.textContent = `${account.gym_name || "No facility connected"} · Subscription: ${account.license?.type || "Unlicensed"} · Expires: ${expiry}. ${account.message || ""}`;
}
