// CEO bundle (lazy). Command Center: overview/MRR, fleet + kill, Key Vault
// (gym picker → issue show-once → revoke), releases, audit, user RBAC.
// Mutations go through Edge Fns (service_role) so RLS cannot no-op them.
import { db } from "../supabase";
import { maskKey, confirmModal, debounce, stat, tierBadge, navcard, emptyState, esc, pollVisible } from "../ui";

let viewToken = 0;

async function callFn(name: string, body: unknown): Promise<Response> {
  const base = import.meta.env.VITE_SUPABASE_URL;
  const { data: { session } } = await db().auth.getSession();
  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res;
}

let stopPolling: (() => void) | null = null;
export async function renderCEO(root: HTMLElement, path: string) {
  stopPolling?.(); stopPolling = null;
  const token = ++viewToken;
  const route = path.split("/")[1] || "overview";
  const titles: Record<string, string> = { overview: "CEO overview", fleet: "Applications & facilities", keys: "Subscriptions", terminals: "Registered terminals", releases: "Releases", users: "Accounts", audit: "Audit" };
  root.innerHTML = `<div class="page-head"><h2>${titles[route] || titles.overview}</h2><button id="ceo-refresh">Refresh</button></div><div id="ceo-section"></div>`;
  document.getElementById("ceo-refresh")!.onclick = () => void renderCEO(root, path);
  const body = document.getElementById("ceo-section")!;
  const loaders: Record<string, () => Promise<unknown>> = {
    overview: () => overview(body), fleet: () => fleet(body, token), keys: () => keys(body),
    terminals: () => terminals(body), releases: () => releases(body), users: () => users(body), audit: () => audit(body),
  };
  try { await (loaders[route] || loaders.overview)(); }
  catch (error) { if (body.isConnected) body.innerHTML = `<p class="pill bad">${esc(String(error))}</p>`; }
  if (["overview", "terminals", "audit"].includes(route)) {
    stopPolling = pollVisible(() => token === viewToken && body.isConnected ? body : null, async () => { await loaders[route](); }, 30000);
  }
}

async function overview(root: HTMLElement) {
  const [
    { data: mrr, error: mrrErr },
    { count: gyms },
    { count: members },
    { count: revoked },
    { count: activeKeys },
    { data: tiers },
  ] = await Promise.all([
    db().from("fleet_mrr").select("*").maybeSingle(),
    db().from("gyms").select("id", { count: "exact", head: true }),
    db().from("members").select("id", { count: "exact", head: true }),
    db().from("licenses").select("id", { count: "exact", head: true }).eq("revoked", true),
    db().from("licenses").select("id", { count: "exact", head: true }).eq("revoked", false),
    db().from("gyms").select("tier").eq("disabled", false).limit(1000),
  ]);

  const tb = (tiers ?? []).filter((g) => g.tier === "basic").length;
  const tp = (tiers ?? []).filter((g) => g.tier === "pro").length;
  const tu = (tiers ?? []).filter((g) => g.tier === "ultra").length;
  const tm = Math.max(1, tb, tp, tu);

  // Nav-card counts (best-effort concurrent — a failed count shows "—", never blocks).
  let usersN = "—", relV = "—", auditN = "—";
  const day = new Date().toISOString().slice(0, 10);
  const [rUsers, rRel, rAudit] = await Promise.allSettled([
    callFn("user-admin", { action: "list" }).then(async (r) => (await r.json()) as { users: unknown[] }),
    db().from("releases").select("version").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db().from("audit_logs").select("id", { count: "exact", head: true }).gte("created_at", `${day}T00:00:00`),
  ]);
  if (rUsers.status === "fulfilled" && rUsers.value?.users) usersN = String(rUsers.value.users.length);
  if (rRel.status === "fulfilled" && rRel.value.data?.version) relV = String(rRel.value.data.version);
  if (rAudit.status === "fulfilled") auditN = String(rAudit.value.count ?? 0);
  root.innerHTML = `<div class="cards">
    ${stat("License MRR (est)", `$${mrr?.mrr_usd ?? 0}`, "emerald", "money", "live gyms × tier 99 / 199 / 349, 3-day grace")}
    ${stat("Active gyms", String(mrr?.active_gyms ?? gyms ?? 0), "violet", "gym", `${tb} basic · ${tp} pro · ${tu} ultra`)}
    ${stat("Members", String(members ?? 0), "sky", "users", "across all gyms")}
    ${stat("Keys active", String(activeKeys ?? 0), "amber", "key", "unrevoked licenses")}
    ${stat("Keys revoked", String(revoked ?? 0), "red", "shield", "kill-switched")}</div>
    <div class="glass-panel panel">
      <div class="stat-top" style="margin-bottom:12px">
        <span class="stat-k">Live Gyms by Hunter Rank</span>
        <span class="muted" style="font-size:11px;font-family:Rajdhani,sans-serif;letter-spacing:1px">RANK DISTRIBUTION</span>
      </div>
      <div class="tier-bars-wrapper">
        <div class="tier-bar-col">
          <div class="tier-bar tier-bar-basic" title="Basic (C-Rank): ${tb}" style="height:${Math.round((tb / tm) * 85) + 14}px">
            <span class="bar-val">${tb}</span>
          </div>
          <span class="stat-badge badge-basic">C · basic (${tb})</span>
        </div>
        <div class="tier-bar-col">
          <div class="tier-bar tier-bar-pro" title="Pro (A-Rank): ${tp}" style="height:${Math.round((tp / tm) * 85) + 14}px">
            <span class="bar-val">${tp}</span>
          </div>
          <span class="stat-badge badge-pro">A · pro (${tp})</span>
        </div>
        <div class="tier-bar-col">
          <div class="tier-bar tier-bar-ultra" title="Ultra (S-Rank): ${tu}" style="height:${Math.round((tu / tm) * 85) + 14}px">
            <span class="bar-val">${tu}</span>
          </div>
          <span class="stat-badge badge-ultra">S · ultra (${tu})</span>
        </div>
      </div>
    </div>
    <p class="muted">License MRR = live gyms × tier (99/199/349), 3-day grace included, disabled gyms excluded. Owner "POS revenue" is counter sales — a different number.${mrrErr ? ` <span class="pill bad">${mrrErr.message}</span>` : ""}</p>
    <div class="navcards">
    ${navcard("#/ceo/fleet", "gym", "violet", "Fleet", "gyms · kill switches", String(mrr?.active_gyms ?? gyms ?? 0))}
    ${navcard("#/ceo/keys", "key", "amber", "Key Vault", "licenses · issue & revoke", String(activeKeys ?? 0))}
    ${navcard("#/ceo/users", "users", "sky", "Users", "roles · RBAC grants", usersN)}
    ${navcard("#/ceo/releases", "send", "emerald", "Releases", "updater feed", relV)}
    ${navcard("#/ceo/audit", "clock", "red", "Audit", "events today", auditN)}</div>`;
}

async function fleet(root: HTMLElement, token: number) {
  root.innerHTML = `<div id="pending-apps-container" style="margin-bottom:20px"></div>
    <p class="muted" style="margin-top:0">Remote kill switch per gym — terminals lock on next sync poll (~30s).</p>
    <div class="panel row"><input id="q" placeholder="Filter gyms…" />
    <select id="f"><option value="all">all</option>
    <option value="pending">pending approval</option>
    <option value="live">live</option>
    <option value="disabled">disabled</option></select>
    <button class="primary" id="new-gym">+ New gym</button></div>
    <div id="gym-form" hidden class="panel row" style="margin:8px 0">
      <input id="gn" placeholder="Gym name" /><input id="gt" placeholder="gym_id (optional)" />
      <select id="g-tier"><option>basic</option><option>pro</option><option>ultra</option></select>
      <button class="primary" id="g-save">Create gym</button>
      <span id="g-msg" class="muted"></span>
    </div>
    <table><thead><tr><th>Gym</th><th>Tier</th><th>ID</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody id="tb"></tbody></table>`;

  const drawPending = async () => {
    const c = document.getElementById("pending-apps-container");
    if (!c || token !== viewToken) return;
    const { data: pending, error } = await db()
      .from("gyms")
      .select("id,name,location,tier,owner_email,created_at,status")
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) { c.innerHTML = `<p class="pill bad">Application refresh failed: ${esc(error.message)}</p>`; return; }
    if (!pending || pending.length === 0) {
      c.innerHTML = `<div class="glass-panel panel" style="padding:12px 16px;border-left:4px solid #38bdf8">
        <span style="font-weight:600;color:#38bdf8">NO PENDING APPLICATIONS</span>
        <span class="muted" style="margin-left:8px;font-size:13px">— All gym owner registrations are reviewed and active.</span>
      </div>`;
      return;
    }

    c.innerHTML = `<div class="glass-panel panel" style="border:1px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.04)">
      <div class="stat-top" style="margin-bottom:8px">
        <div class="row" style="gap:8px">
          <span class="pulse-dot" style="background:#fbbf24"></span>
          <span class="stat-k" style="color:#fbbf24;font-size:14px;letter-spacing:1px">PENDING GYM OWNER APPLICATIONS (${pending.length})</span>
        </div>
        <span class="muted" style="font-size:12px">Review and payment are separate. Approval does not change the trial.</span>
      </div>
      <table style="margin-top:8px"><thead><tr>
        <th>Gym Name</th><th>Location</th><th>Tier</th><th>Applicant Email</th><th>Applied</th><th>Action</th>
      </tr></thead><tbody>
      ${pending.map((p) => `<tr>
        <td><strong>${esc(p.name)}</strong></td>
        <td>${esc(p.location || "—")}</td>
        <td>${tierBadge(p.tier)}</td>
        <td class="muted">${esc(p.owner_email || "—")}</td>
        <td class="muted">${p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}</td>
        <td>
          <button class="primary" data-approve="${p.id}" style="padding:4px 12px;font-size:12px;background:#10b981;border-color:#059669">
            Approve facility
          </button><button data-reject="${p.id}">Reject application</button>
        </td>
      </tr>`).join("")}
      </tbody></table>
    </div>`;

    c.querySelectorAll("[data-reject]").forEach((btn) => {
      (btn as HTMLButtonElement).onclick = async () => {
        if (!await confirmModal({ title: "Reject application?", body: "This blocks terminal access for the facility.", confirmLabel: "Reject", danger: true })) return;
        try { await callFn("gym-admin", { action: "reject_application", gym_id: (btn as HTMLElement).dataset.reject, reason: "Rejected after CEO review" }); await drawPending(); await draw(); }
        catch (error) { alert(String(error)); }
      };
    });
    c.querySelectorAll("[data-approve]").forEach((btn) => {
      (btn as HTMLButtonElement).onclick = async () => {
        const gymId = (btn as HTMLElement).dataset.approve!;
        const ok = await confirmModal({
          title: "Approve Gym Owner Application?",
          body: "Approve this facility for paid subscriptions. Its trial stays unchanged. Confirm payment separately under Subscriptions.",
          confirmLabel: "Approve facility",
        });
        if (!ok) return;
        (btn as HTMLButtonElement).disabled = true;
        (btn as HTMLButtonElement).textContent = "Approving…";
        try {
          await callFn("gym-admin", { action: "approve_application", gym_id: gymId });
          await drawPending();
          await draw();
        } catch (e) {
          alert(`Approval failed: ${e}`);
          (btn as HTMLButtonElement).disabled = false;
          (btn as HTMLButtonElement).textContent = "Approve facility";
        }
      };
    });
  };

  const draw = async () => {
    const qEl = document.getElementById("q") as HTMLInputElement | null;
    const fEl = document.getElementById("f") as HTMLSelectElement | null;
    const tb = document.getElementById("tb");
    if (token !== viewToken || !qEl || !fEl || !tb) return; // debounced fire after navigation
    const q = qEl.value;
    const f = fEl.value;
    let query = db().from("gyms").select("id,name,tier,disabled,status,owner_email").order("name").limit(50);
    if (q) query = query.ilike("name", `%${q}%`);
    if (f === "disabled") query = query.eq("disabled", true);
    if (f === "live") query = query.eq("disabled", false).eq("status", "active");
    if (f === "pending") query = query.eq("status", "pending");
    const { data, error } = await query;
    const tbEl = document.getElementById("tb");
    if (token !== viewToken || !tbEl) return;
    if (error) {
      tbEl.innerHTML = `<tr><td colspan="6" class="pill bad">${esc(error.message)}</td></tr>`;
      return;
    }
    tbEl.innerHTML = (data ?? [])
      .map((g) => {
        const isPending = g.status === "pending";
        const statusBadge = isPending
          ? '<span class="pill warn" style="background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.4)">pending review</span>'
          : g.disabled
          ? '<span class="pill bad">disabled</span>'
          : g.status === "rejected" ? '<span class="pill bad">rejected</span>' : '<span class="pill good">approved facility</span>';
        const actionBtn = isPending
          ? `<button class="primary" data-quick-approve="${g.id}" style="padding:3px 8px;font-size:11px">Approve</button>`
          : `<button data-kill="${g.id}" data-off="${g.disabled}">${g.disabled ? "Enable" : "Kill"}</button>`;
        return `<tr><td>${esc(g.name)}</td><td>${tierBadge(g.tier)}</td><td class="muted" title="${g.id}">${g.id.slice(0, 8)}…</td>
          <td class="muted">${esc(g.owner_email || "—")}</td>
          <td>${statusBadge}</td>
          <td>${actionBtn}
          <button data-copy="${g.id}">Copy ID</button></td></tr>`;
      })
      .join("") || `<tr><td colspan="6" class="muted">No gyms found.</td></tr>`;
    root.querySelectorAll("[data-kill]").forEach((b) =>
      (b as HTMLButtonElement).onclick = () =>
        toggleKill((b as HTMLElement).dataset.kill!, (b as HTMLElement).dataset.off === "true").then(draw));
    root.querySelectorAll("[data-quick-approve]").forEach((b) =>
      (b as HTMLButtonElement).onclick = async () => {
        const id = (b as HTMLElement).dataset.quickApprove!;
        try {
          if (!await confirmModal({ title: "Approve facility?", body: "Trial stays unchanged. Confirm payment separately under Subscriptions.", confirmLabel: "Approve" })) return;
          await callFn("gym-admin", { action: "approve_application", gym_id: id });
          await drawPending();
          await draw();
        } catch (e) {
          alert(`Approval failed: ${e}`);
        }
      });
    root.querySelectorAll("[data-copy]").forEach((b) =>
      (b as HTMLButtonElement).onclick = () => navigator.clipboard?.writeText((b as HTMLElement).dataset.copy!));
  };

  (document.getElementById("new-gym") as HTMLButtonElement).onclick = () => {
    const form = document.getElementById("gym-form")!;
    form.hidden = !form.hidden;
  };
  (document.getElementById("g-save") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("g-msg")!;
    try {
      await callFn("gym-admin", {
        action: "create",
        name: (document.getElementById("gn") as HTMLInputElement).value.trim(),
        tier: (document.getElementById("g-tier") as HTMLSelectElement).value,
      });
      msg.textContent = "Created.";
      msg.style.color = "#3ddc97";
      (document.getElementById("gn") as HTMLInputElement).value = "";
      await draw();
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
  };

  (document.getElementById("q") as HTMLInputElement).oninput = debounce(draw);
  (document.getElementById("f") as HTMLSelectElement).onchange = draw;
  await drawPending();
  await draw();
  stopPolling = pollVisible(() => token === viewToken && root.isConnected ? root : null, async () => { await drawPending(); await draw(); }, 30000);
}

async function toggleKill(gymId: string, currentlyOff: boolean) {
  const ok = await confirmModal({
    title: currentlyOff ? "Re-enable gym?" : "Kill gym access?",
    body: currentlyOff
      ? "Terminals resume on next sync poll."
      : "Terminals lock on next sync poll (~30s). Audit row written. Reason optional.",
    confirmLabel: currentlyOff ? "Re-enable" : "Kill now",
    danger: !currentlyOff,
  });
  if (!ok) return;
  try {
    await callFn("gym-admin", { action: "set_disabled", gym_id: gymId, disabled: !currentlyOff, reason: currentlyOff ? "re-enable" : "kill from dashboard" });
  } catch (e) {
    alert(String(e));
  }
}

async function keys(root: HTMLElement) {
  const { data: gyms, error } = await db().from("gyms").select("id,name,tier,status,disabled").order("name");
  if (error) throw error;
  root.innerHTML = `<p class="muted">Approve the facility first, then record payment to activate or renew 30 days. Connected terminals update automatically; no key distribution.</p>
    <form id="subscription-form" class="glass-panel panel" style="display:grid;gap:12px;max-width:680px">
      <label for="subscription-gym">Facility</label><select id="subscription-gym" required><option value="">Select an approved facility</option>${(gyms ?? []).filter((g) => g.status === "active" && !g.disabled).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>
      <div id="subscription-current" role="status">Select a facility to view its subscription.</div>
      <label for="subscription-tier">Paid tier · USD</label><select id="subscription-tier"><option value="basic">Basic · $99/month</option><option value="pro">Pro · $199/month</option><option value="ultra">Ultra · $349/month</option></select>
      <label for="payment-reference">Payment reference / receipt number</label><input id="payment-reference" required minlength="3" maxlength="500" />
      <label><input id="payment-confirmed" type="checkbox" required /> I have verified receipt of payment.</label>
      <button type="submit" class="primary" id="subscription-activate" disabled>Confirm payment & activate 30 days</button>
      <p id="subscription-result" role="status" aria-live="polite"></p>
    </form>`;
  let previous: string | null = null;
  let loaded = false;
  let loadId = 0;
  const picker = document.getElementById("subscription-gym") as HTMLSelectElement;
  picker.onchange = async () => {
    const request = ++loadId;
    loaded = false;
    const btn = document.getElementById("subscription-activate") as HTMLButtonElement;
    btn.disabled = true;
    const current = document.getElementById("subscription-current")!;
    const id = picker.value;
    if (!id) { current.textContent = "Select a facility."; return; }
    (document.getElementById("subscription-tier") as HTMLSelectElement).value = gyms?.find((g) => g.id === id)?.tier ?? "basic";
    const { data: license, error } = await db().from("licenses").select("id,expires_at,is_trial,revoked,tier")
      .eq("gym_id", id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    if (!current.isConnected || request !== loadId) return;
    if (error) { current.textContent = error.message; return; }
    previous = license?.id ?? null; loaded = true; btn.disabled = false;
    current.innerHTML = license ? `<p>${license.is_trial ? "Trial" : "Paid"} · ${esc(license.tier)} · expires ${new Date(license.expires_at).toLocaleString()} · ${license.revoked ? "revoked" : Date.now() > Date.parse(license.expires_at) + 3 * 86400_000 ? "expired" : Date.now() > Date.parse(license.expires_at) ? "grace" : "active"}</p>
      ${license.revoked ? "" : '<button type="button" id="subscription-revoke">Revoke subscription</button>'}` : "No subscription yet.";
    document.getElementById("subscription-revoke")?.addEventListener("click", async () => {
      if (!await confirmModal({ title: "Revoke subscription?", body: "Normal terminal operations lock on the next online verification.", confirmLabel: "Revoke", danger: true })) return;
      try { await callFn("license-revoke", { license_id: previous, reason: "CEO subscription revocation" }); picker.dispatchEvent(new Event("change")); }
      catch (error) { alert(String(error)); }
    });
  };
  (document.getElementById("subscription-form") as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault(); if (!loaded) return;
    const btn = document.getElementById("subscription-activate") as HTMLButtonElement;
    if (btn.disabled) return; btn.disabled = true;
    picker.disabled = true;
    const result = document.getElementById("subscription-result")!;
    try {
      const response = await callFn("license-issue", {
        gym_id: picker.value, tier: (document.getElementById("subscription-tier") as HTMLSelectElement).value,
        previous_license_id: previous, payment_confirmed: (document.getElementById("payment-confirmed") as HTMLInputElement).checked,
        payment_reference: (document.getElementById("payment-reference") as HTMLInputElement).value.trim(),
      });
      const paid = await response.json();
      loaded = false;
      result.textContent = `Subscription activated through ${new Date(paid.expires_at).toLocaleString()}. GymPOS updates automatically.`;
      (document.getElementById("payment-confirmed") as HTMLInputElement).checked = false;
      (document.getElementById("payment-reference") as HTMLInputElement).value = "";
    } catch (error) { loaded = false; result.textContent = String(error) + " Refresh the facility before retrying."; }
    finally { picker.disabled = false; picker.dispatchEvent(new Event("change")); }
  };
}

async function terminals(root: HTMLElement) {
  const { data, error } = await db().from("terminals").select("id,gym_id,name,active,last_seen_at,gyms(name)").order("last_seen_at", { ascending: false }).limit(500);
  if (error) throw error;
  root.innerHTML = `<p class="muted">Revoked terminals cannot reconnect themselves. Re-enable only after reviewing the device.</p>
    <table><thead><tr><th>Facility</th><th>Terminal</th><th>Last contact</th><th>Access</th><th>Action</th></tr></thead><tbody>
    ${(data ?? []).map((device) => `<tr><td>${esc((device.gyms as unknown as { name: string })?.name || device.gym_id)}</td><td>${esc(device.name)}</td><td>${new Date(device.last_seen_at).toLocaleString()}</td><td>${device.active ? "Enabled" : "Revoked"}</td><td><button data-terminal="${device.id}" data-active="${device.active}">${device.active ? "Revoke" : "Re-enable"}</button></td></tr>`).join("") || '<tr><td colspan="5">No connected terminals yet.</td></tr>'}</tbody></table>`;
  root.querySelectorAll("[data-terminal]").forEach((element) => {
    (element as HTMLButtonElement).onclick = async () => {
      const active = (element as HTMLElement).dataset.active === "true";
      if (!await confirmModal({ title: active ? "Revoke terminal?" : "Re-enable terminal?", body: "This changes access for this device only.", confirmLabel: active ? "Revoke" : "Enable", danger: active })) return;
      try { await callFn("gym-admin", { action: "set_terminal_active", terminal_id: (element as HTMLElement).dataset.terminal, active: !active, reason: "CEO device review" }); await terminals(root); }
      catch (error) { alert(String(error)); }
    };
  });
}

async function releases(root: HTMLElement) {
  const { data } = await db().from("releases").select("*").order("created_at", { ascending: false }).limit(20);
  root.innerHTML = `<div class="row" style="justify-content:flex-end;margin-bottom:8px">
    <span class="muted">desktop updater feed</span>
    <button class="primary" id="pub-toggle">+ Publish release</button></div>
  <div class="panel row" id="pub-form" hidden><input id="v" placeholder="3.0.1" />
    <select id="ch"><option>stable</option><option>beta</option></select>
    <input id="pct" type="number" min="0" max="100" value="100" style="width:80px" />
    <input id="url" placeholder="download url" style="min-width:280px" />
    <input id="sig" placeholder="minisign .sig (optional)" style="min-width:280px" />
    <button class="primary" id="pub">Publish</button></div>
    <p id="rel-msg" class="muted"></p>
    <table><thead><tr><th>Version</th><th>Channel</th><th>Rollout</th><th>URL</th></tr></thead><tbody>
    ${(data ?? []).map((r) => `<tr><td>${esc(r.version)}</td><td>${esc(r.channel)}</td><td>${r.rollout_pct}%</td><td class="muted">${esc(r.download_url)}</td></tr>`).join("")
      || `<tr><td colspan="4" class="muted">No releases published.</td></tr>`}
    </tbody></table>`;
  (document.getElementById("pub-toggle") as HTMLButtonElement).onclick = () => {
    const f = document.getElementById("pub-form")!;
    f.hidden = !f.hidden;
  };
  (document.getElementById("pub") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("rel-msg")!;
    const { error } = await db().from("releases").insert({
      version: (document.getElementById("v") as HTMLInputElement).value,
      channel: (document.getElementById("ch") as HTMLSelectElement).value,
      rollout_pct: Number((document.getElementById("pct") as HTMLInputElement).value),
      download_url: (document.getElementById("url") as HTMLInputElement).value,
      sig: (document.getElementById("sig") as HTMLInputElement).value,
    });
    if (error) { msg.textContent = error.message; msg.style.color = "#ff6b6b"; return; }
    releases(root);
  };
}

async function audit(root: HTMLElement) {
  const { data, error } = await db()
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  root.innerHTML = `<p class="muted" style="margin-top:0">Newest first. Every license issue/revoke, kill switch, and role grant lands here.</p>
    ${error ? `<p class="pill bad">${esc(error.message)}</p>` : ""}
    <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>License</th><th>Gym</th><th>Detail</th></tr></thead><tbody>
    ${(data ?? []).map((a) => `<tr>
      <td>${new Date(a.created_at).toLocaleString()}</td>
      <td>${esc(a.actor)}</td>
      <td>${esc(a.action)}</td>
      <td class="muted">${a.license_id ? maskKey(a.license_id) : "—"}</td>
      <td class="muted">${a.gym_id ? a.gym_id.slice(0, 8) + "…" : "—"}</td>
      <td class="muted">${esc(a.reason || "")}</td></tr>`).join("")
      || `<tr><td colspan="6" class="muted">No audit rows.</td></tr>`}
    </tbody></table>`;
}

async function users(root: HTMLElement) {
  const { data: gyms, error } = await db().from("gyms").select("id,name,location").order("name").limit(1000);
  if (error) throw error;
  const facilities = gyms ?? [];
  const names = new Map(facilities.map(g => [g.id, g.name]));
  root.innerHTML = `<p class="muted">Gym owners register and verify their email, then receive their trial automatically. Use this page to assign existing verified accounts, add dashboard managers, or appoint another CEO. Staff PINs are managed under Staff, not here.</p>
    <div id="u-list">Loading accounts…</div><div class="row"><button id="u-prev">Previous page</button><span id="u-page"></span><button id="u-next">Next page</button></div>
    <form id="u-form" class="panel account-access-form"><label for="uemail">Existing account email</label><input id="uemail" type="email" required autocomplete="off" />
    <label for="urole">Dashboard access</label><select id="urole"><option value="owner">Owner · manage and connect GymPOS</option><option value="manager">Manager · read-only dashboard</option><option value="ceo">CEO · administer all facilities</option><option value="">Remove dashboard access</option></select>
    <fieldset id="ugyms"><legend>Assigned facilities (owner or manager)</legend>${facilities.map(g => `<label><input type="checkbox" value="${esc(g.id)}" /> ${esc(g.name)} · ${esc(g.location || "No location")}</label>`).join("") || "Create a facility first."}</fieldset>
    <button class="primary" id="ugrant">Save account access</button><p id="umsg" role="status"></p></form>
    <p class="muted">The server applies assignment removal immediately, including already signed-in clients. The last CEO cannot be removed. Account assignment alone does not create a paid subscription.</p>`;
  let page = 1, busy = false;
  const load = async () => {
    const out = await (await callFn("user-admin", { action: "list", page })).json() as {
      users: { email: string | null; role: string | null; gym_ids: string[]; verified: boolean }[]; has_more: boolean;
    };
    if (!root.isConnected) return;
    document.getElementById("u-page")!.textContent = `Page ${page}`;
    (document.getElementById("u-prev") as HTMLButtonElement).disabled = page === 1;
    (document.getElementById("u-next") as HTMLButtonElement).disabled = !out.has_more;
    const list = document.getElementById("u-list")!;
    list.innerHTML = `<table><thead><tr><th>Email</th><th>Access</th><th>Facilities</th><th></th></tr></thead><tbody>${out.users.map(u => `<tr>
      <td>${esc(u.email ?? "—")} · ${u.verified ? "Verified" : "Email pending"}</td><td>${esc(u.role ?? "Not assigned")}</td>
      <td>${u.role === "ceo" ? "All facilities" : u.gym_ids.map(g => esc(names.get(g) ?? "Unavailable facility")).join(", ") || "—"}</td>
      <td>${u.email ? `<button data-use="${esc(u.email)}" data-role="${esc(u.role ?? "")}" data-gyms="${esc(u.gym_ids.join(","))}">Edit</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="4">No accounts on this page.</td></tr>'}</tbody></table>`;
    list.querySelectorAll<HTMLButtonElement>("[data-use]").forEach(button => button.onclick = () => {
      (document.getElementById("uemail") as HTMLInputElement).value = button.dataset.use!;
      (document.getElementById("urole") as HTMLSelectElement).value = button.dataset.role!;
      const selected = (button.dataset.gyms ?? "").split(",");
      document.querySelectorAll<HTMLInputElement>("#ugyms input").forEach(box => box.checked = selected.includes(box.value));
    });
  };
  for (const [id, offset] of [["u-prev", -1], ["u-next", 1]] as const) {
    (document.getElementById(id) as HTMLButtonElement).onclick = async () => {
      if (busy) return; busy = true;
      try { page += offset; await load(); } catch (e) { document.getElementById("umsg")!.textContent = String(e); }
      finally { busy = false; }
    };
  }
  (document.getElementById("u-form") as HTMLFormElement).onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    const email = (document.getElementById("uemail") as HTMLInputElement).value.trim();
    const role = (document.getElementById("urole") as HTMLSelectElement).value || null;
    const gym_ids = Array.from(document.querySelectorAll<HTMLInputElement>("#ugyms input:checked")).map(box => box.value);
    const msg = document.getElementById("umsg")!;
    if ((role === "owner" || role === "manager") && !gym_ids.length) { msg.textContent = "Select at least one named facility."; return; }
    if (!confirm(`Save ${role ?? "no dashboard"} access for ${email}?`)) return;
    busy = true; (document.getElementById("ugrant") as HTMLButtonElement).disabled = true;
    try { await callFn("user-admin", { email, role, gym_ids }); msg.textContent = "Account access saved and audited."; await load(); }
    catch (e) { msg.textContent = String((e as Error).message ?? e); }
    finally { busy = false; (document.getElementById("ugrant") as HTMLButtonElement).disabled = false; }
  };
  try { await load(); } catch (e) { document.getElementById("u-list")!.textContent = `Could not load accounts: ${String(e)}`; }
}
