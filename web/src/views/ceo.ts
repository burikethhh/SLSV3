// CEO bundle (lazy). Command Center: overview/MRR, fleet + kill, Key Vault
// (gym picker → issue show-once → revoke), releases, audit, user RBAC.
// Mutations go through Edge Fns (service_role) so RLS cannot no-op them.
import { db } from "../supabase";
import { maskKey, confirmModal, debounce, stat, tierBadge, navcard, emptyState, esc } from "../ui";

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

const CEO_SECTIONS: [string, string][] = [
  ["/", "sec-overview"], ["/fleet", "sec-fleet"], ["/keys", "sec-keys"],
  ["/releases", "sec-releases"], ["/users", "sec-users"], ["/audit", "sec-audit"],
];

/** Single scrolling command page (v2 CEO dashboard pattern): metrics on top,
 *  every section collapsible. Hash routes still work — they scroll to the
 *  matching section after the full render. */
export async function renderCEO(root: HTMLElement, path: string) {
  const token = ++viewToken;
  root.innerHTML = `
    <div class="page-head"><h2>CEO command center</h2>
      <span class="row">
        <span class="pill good"><span class="pulse-dot" style="margin-right:6px"></span>fleet live</span>
        <button id="ceo-print" class="btn-subtle" title="Print command center report">Print Report</button>
        <button id="ceo-refresh">Refresh</button>
      </span></div>
    <section id="sec-overview"><div class="skel-stack"><div class="skel" style="height:118px"></div><div class="skel" style="height:118px"></div></div></section>
    <details class="glass-panel panel cmd-section" open id="sec-fleet"><summary>Fleet</summary><div class="sec-body" id="sec-fleet-body"><div class="skel-stack"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div></div></details>
    <details class="glass-panel panel cmd-section" open id="sec-keys"><summary>Key Vault</summary><div class="sec-body" id="sec-keys-body"><div class="skel-stack"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div></div></details>
    <details class="glass-panel panel cmd-section" open id="sec-releases"><summary>Releases</summary><div class="sec-body" id="sec-releases-body"><div class="skel" style="height:64px"></div></div></details>
    <details class="glass-panel panel cmd-section" id="sec-users"><summary>Users &amp; RBAC</summary><div class="sec-body" id="sec-users-body"><div class="skel-stack"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div></div></details>
    <details class="glass-panel panel cmd-section" id="sec-audit"><summary>Audit</summary><div class="sec-body" id="sec-audit-body"><div class="skel-stack"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div></div></details>`;
  (document.getElementById("ceo-refresh") as HTMLButtonElement).onclick = () => renderCEO(root, "/");
  document.getElementById("ceo-print")?.addEventListener("click", () => window.print());
  // Section gate: viewToken only invalidates CEO-internal navigation, so a
  // CEO→owner hop mid-render must ALSO stop on the missing element —
  // otherwise body() hands a null root to the section and it throws.
  const section = async (id: string, fn: (el: HTMLElement) => Promise<unknown>): Promise<boolean> => {
    if (token !== viewToken) return false;
    const el = document.getElementById(id);
    if (!el) return false;
    await fn(el);
    return true;
  };
  // Sections are independent queries into independent containers — run them
  // concurrently so one slow table doesn't serialize the whole page.
  await Promise.all([
    section("sec-overview", (el) => overview(el)),
    section("sec-fleet-body", (el) => fleet(el, token)),
    section("sec-keys-body", (el) => keys(el)),
    section("sec-releases-body", (el) => releases(el)),
    section("sec-users-body", (el) => users(el)),
    section("sec-audit-body", (el) => audit(el)),
  ]);
  const hit = CEO_SECTIONS.find(([p]) => p !== "/" && path.startsWith(p));
  const sec = document.getElementById(hit ? hit[1] : "sec-overview");
  if (sec) {
    if (sec instanceof HTMLDetailsElement) sec.open = true;
    sec.scrollIntoView();
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
  root.innerHTML = `<p class="muted" style="margin-top:0">Remote kill switch per gym — terminals lock on next sync poll (~30s).</p>
    <div class="panel row"><input id="q" placeholder="Filter gyms…" />
    <select id="f"><option value="all">all</option>
    <option value="disabled">disabled</option><option value="live">live</option></select>
    <button class="primary" id="new-gym">+ New gym</button></div>
    <div id="gym-form" hidden class="panel row" style="margin:8px 0">
      <input id="gn" placeholder="Gym name" /><input id="gt" placeholder="gym_id (optional)" />
      <select id="g-tier"><option>basic</option><option>pro</option><option>ultra</option></select>
      <button class="primary" id="g-save">Create gym</button>
      <span id="g-msg" class="muted"></span>
    </div>
    <table><thead><tr><th>Gym</th><th>Tier</th><th>ID</th><th>Status</th><th></th></tr></thead><tbody id="tb"></tbody></table>`;

  const draw = async () => {
    const qEl = document.getElementById("q") as HTMLInputElement | null;
    const fEl = document.getElementById("f") as HTMLSelectElement | null;
    const tb = document.getElementById("tb");
    if (token !== viewToken || !qEl || !fEl || !tb) return; // debounced fire after navigation
    const q = qEl.value;
    const f = fEl.value;
    let query = db().from("gyms").select("id,name,tier,disabled").order("name").limit(50);
    if (q) query = query.ilike("name", `%${q}%`);
    if (f === "disabled") query = query.eq("disabled", true);
    if (f === "live") query = query.eq("disabled", false);
    const { data, error } = await query;
    const tbEl = document.getElementById("tb");
    if (token !== viewToken || !tbEl) return;
    if (error) {
      tbEl.innerHTML = `<tr><td colspan="5" class="pill bad">${esc(error.message)}</td></tr>`;
      return;
    }
    tbEl.innerHTML = (data ?? [])
      .map((g) => `<tr><td>${esc(g.name)}</td><td>${tierBadge(g.tier)}</td><td class="muted" title="${g.id}">${g.id.slice(0, 8)}…</td>
        <td>${g.disabled ? '<span class="pill bad">disabled</span>' : '<span class="pill good">live</span>'}</td>
        <td><button data-kill="${g.id}" data-off="${g.disabled}">${g.disabled ? "Enable" : "Kill"}</button>
        <button data-copy="${g.id}">Copy ID</button></td></tr>`)
      .join("") || `<tr><td colspan="5" class="muted">No gyms — create one to issue a key.</td></tr>`;
    root.querySelectorAll("[data-kill]").forEach((b) =>
      (b as HTMLButtonElement).onclick = () =>
        toggleKill((b as HTMLElement).dataset.kill!, (b as HTMLElement).dataset.off === "true").then(draw));
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
  await draw();
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
  const [{ data: gyms }, { data, error }] = await Promise.all([
    db().from("gyms").select("id,name,tier").order("name"),
    db()
      .from("licenses")
      .select("id,gym_id,revoked,expires_at,created_at,tier,owner_email,issued_by,price_usd,days_valid")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  const gymName = (id: string) => gyms?.find((g) => g.id === id)?.name ?? id?.slice(0, 8) ?? "—";

  root.innerHTML = `<p class="muted" style="margin-top:0">Vault lists inventory + accounting metadata. Tokens are show-once at issue. Revoke via Edge Function (service_role + audit).</p>
    ${error ? `<p class="pill bad">${error.message}</p>` : ""}
    <table><thead><tr><th>Gym</th><th>Tier</th><th>License</th><th>Price</th><th>Issued</th><th>Expires</th><th>By</th><th>Status</th><th></th></tr></thead><tbody>
    ${(data ?? []).map((l) => `<tr>
      <td>${gymName(l.gym_id)}</td>
      <td>${tierBadge(l.tier)}</td>
      <td class="muted">${maskKey(l.id)}</td>
      <td>${l.price_usd ? `$${l.price_usd}` : "—"}</td>
      <td class="muted">${l.created_at ? new Date(l.created_at).toLocaleDateString() : "—"}</td>
      <td>${new Date(l.expires_at).toLocaleDateString()}</td>
      <td class="muted">${l.issued_by || "—"}</td>
      <td>${l.revoked ? '<span class="pill bad">revoked</span>' : '<span class="pill good">active</span>'}</td>
      <td>${l.revoked ? "" : `<button data-rv="${l.id}">Revoke</button>`}</td></tr>`).join("")
      || `<tr><td colspan="9" class="muted">No keys yet.</td></tr>`}
    </tbody></table>

    <h3>Issue key</h3>
    <div class="panel row" style="flex-wrap:wrap;gap:8px">
      <select id="gid"><option value="">— new gym (type name) —</option>
        ${(gyms ?? []).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}
      </select>
      <input id="gn" placeholder="gym name" />
      <select id="tier"><option>basic</option><option>pro</option><option>ultra</option></select>
      <input id="days" type="number" min="1" max="3650" value="30" style="width:80px" title="days" />
      <input id="oemail" placeholder="owner email (optional)" />
      <button class="primary" id="issue">Issue</button>
    </div>
    <p id="issue-msg" class="muted"></p>
    <div id="show-once" hidden></div>`;

  root.querySelectorAll("[data-rv]").forEach((b) =>
    (b as HTMLButtonElement).onclick = async () => {
      const id = (b as HTMLElement).dataset.rv!;
      if (!await confirmModal({ title: "Revoke license?", body: "Terminals holding this key lock on next sync (~30s).", confirmLabel: "Revoke", danger: true })) return;
      try {
        await callFn("license-revoke", { license_id: id, reason: "revoked from Key Vault" });
        keys(root);
      } catch (e) {
        alert(String(e));
      }
    });

  (document.getElementById("gid") as HTMLSelectElement).onchange = () => {
    const sel = (document.getElementById("gid") as HTMLSelectElement).value;
    const nameIn = document.getElementById("gn") as HTMLInputElement;
    if (sel) {
      nameIn.value = gyms?.find((g) => g.id === sel)?.name ?? "";
      nameIn.disabled = true;
    } else {
      nameIn.disabled = false;
    }
  };

  (document.getElementById("issue") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("issue-msg")!;
    const show = document.getElementById("show-once")!;
    const gym_id = (document.getElementById("gid") as HTMLSelectElement).value || null;
    const gym_name = (document.getElementById("gn") as HTMLInputElement).value.trim();
    const tier = (document.getElementById("tier") as HTMLSelectElement).value;
    const days_valid = Number((document.getElementById("days") as HTMLInputElement).value) || 30;
    const owner_email = (document.getElementById("oemail") as HTMLInputElement).value.trim();
    if (!gym_name) { msg.textContent = "Gym name required."; return; }
    msg.textContent = "Issuing…";
    show.hidden = true;
    try {
      const res = await callFn("license-issue", {
        gym_id,
        gym_name,
        tier,
        days_valid,
        owner_email,
        create_gym: !gym_id,
      });
      const out = await res.json();
      msg.textContent = `Issued ${out.tier} key · $${out.price_usd}/mo · expires ${new Date(out.expires_at).toLocaleDateString()} · gym ${out.gym_id}`;
      msg.style.color = "#3ddc97";
      show.hidden = false;
      show.innerHTML = `<div class="quest">
        <div class="quest-title">[ QUEST REWARD ] — LICENSE KEY</div>
        <div class="muted" style="margin-bottom:8px">Copy this key now — it will not be shown again.</div>
        <div class="row" style="margin-top:8px">
          <textarea id="tok" rows="4" style="width:100%;font-family:monospace">${out.token}</textarea>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="primary" id="copy-tok">Copy key</button>
          <button id="ack">I saved it</button>
        </div></div>`;
      (document.getElementById("copy-tok") as HTMLButtonElement).onclick = () => {
        navigator.clipboard?.writeText(out.token);
        (document.getElementById("copy-tok") as HTMLButtonElement).textContent = "Copied";
      };
      (document.getElementById("ack") as HTMLButtonElement).onclick = () => {
        show.innerHTML = "";
        show.hidden = true;
        keys(root);
      };
      // Refresh vault without wiping the show-once panel: only table is rebuilt on ack.
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
  };
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
  root.innerHTML = `<p class="muted" style="margin-top:0">Self-registered accounts have no role until granted here (JWT claims) or via first-CEO bootstrap.</p>
    <div id="u-list" class="muted">Loading users…</div>
    <div class="panel row" style="margin-top:12px"><input id="uemail" placeholder="user email" />
    <select id="urole"><option>owner</option><option>manager</option><option>ceo</option><option value="">remove role</option></select>
    <input id="ugyms" placeholder="gym_ids CSV (optional)" style="min-width:240px" />
    <button class="primary" id="ugrant">Grant role</button>
    <span id="umsg" class="muted"></span></div>
    <p class="muted">Owner needs ≥1 gym_id in JWT to pass RLS. CEO is first-user via <a href="#/login">bootstrap</a> on login page.</p>`;

  // Directory — was a write-only form: you could grant a role to an email you
  // already knew, but never see who had one or pick a user.
  try {
    const res = await callFn("user-admin", { action: "list" });
    const out = await res.json() as { users: { email: string | null; role: string | null; gym_ids: string[] }[] };
    const list = document.getElementById("u-list");
    if (!list) return;
    list.innerHTML = `<table><thead><tr><th>Email</th><th>Role</th><th>Gym IDs</th><th></th></tr></thead><tbody>
      ${out.users.map((u) => `<tr>
        <td>${esc(u.email ?? "—")}</td>
        <td>${u.role ? `<span class="pill ${u.role === "ceo" ? "good" : "warn"}">${esc(u.role)}</span>` : '<span class="pill bad">none</span>'}</td>
        <td class="muted">${u.gym_ids.length ? u.gym_ids.map((g) => g.slice(0, 8)).join(", ") + (u.gym_ids.length > 1 ? "…" : "") : "—"}</td>
        <td>${u.email ? `<button data-use="${esc(u.email)}" data-role="${esc(u.role ?? "")}" data-gyms="${esc(u.gym_ids.join(","))}">Edit</button>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">No users yet.</td></tr>`}
    </tbody></table>`;
    list.querySelectorAll("[data-use]").forEach((b) =>
      (b as HTMLButtonElement).onclick = () => {
        (document.getElementById("uemail") as HTMLInputElement).value = (b as HTMLElement).dataset.use!;
        const role = (b as HTMLElement).dataset.role;
        if (role === "owner" || role === "manager" || role === "ceo") (document.getElementById("urole") as HTMLSelectElement).value = role;
        else (document.getElementById("urole") as HTMLSelectElement).value = "";
        (document.getElementById("ugyms") as HTMLInputElement).value = (b as HTMLElement).dataset.gyms ?? "";
      });
  } catch (e) {
    const list = document.getElementById("u-list");
    if (list) list.textContent = `Could not load users: ${String((e as Error).message ?? e)}`;
  }

  (document.getElementById("ugrant") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("umsg")!;
    const email = (document.getElementById("uemail") as HTMLInputElement).value.trim();
    const role = (document.getElementById("urole") as HTMLSelectElement).value;
    const gym_ids = (document.getElementById("ugyms") as HTMLInputElement).value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!email) { msg.textContent = "Email required."; return; }
    try {
      // Empty select = demote (strip RBAC claims; account can still sign in).
      await callFn("user-admin", { email, role: role === "" ? null : role, gym_ids });
      msg.textContent = role === "" ? `Removed role from ${email}. They keep old access until they sign out/in.` : `Granted ${role} to ${email}. They must sign out/in to pick it up.`;
      msg.style.color = "#3ddc97";
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
  };
}
