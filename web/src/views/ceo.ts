// CEO bundle (lazy). Command Center: overview/MRR, fleet + kill, Key Vault
// (gym picker → issue show-once → revoke), releases, audit, user RBAC.
// Mutations go through Edge Fns (service_role) so RLS cannot no-op them.
import { db } from "../supabase";
import { maskKey, confirmModal, debounce } from "../ui";

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

export async function renderCEO(root: HTMLElement, path: string) {
  const token = ++viewToken;
  if (path.startsWith("/fleet")) return fleet(root, token);
  if (path.startsWith("/keys")) return keys(root);
  if (path.startsWith("/releases")) return releases(root);
  if (path.startsWith("/audit")) return audit(root);
  if (path.startsWith("/users")) return users(root);
  return overview(root);
}

async function overview(root: HTMLElement) {
  const { data: mrr, error: mrrErr } = await db().from("fleet_mrr").select("*").maybeSingle();
  const { count: gyms } = await db().from("gyms").select("id", { count: "exact", head: true });
  const { count: members } = await db().from("members").select("id", { count: "exact", head: true });
  const { count: revoked } = await db().from("licenses").select("id", { count: "exact", head: true }).eq("revoked", true);
  const { count: activeKeys } = await db().from("licenses").select("id", { count: "exact", head: true }).eq("revoked", false);
  root.innerHTML = `<h2>CEO overview</h2><div class="cards">
    <div class="card"><div class="k">MRR (est)</div><div class="v">$${mrr?.mrr_usd ?? 0}</div></div>
    <div class="card"><div class="k">Active gyms</div><div class="v">${mrr?.active_gyms ?? gyms ?? 0}</div></div>
    <div class="card"><div class="k">Members</div><div class="v">${members ?? 0}</div></div>
    <div class="card"><div class="k">Keys active</div><div class="v">${activeKeys ?? 0}</div></div>
    <div class="card"><div class="k">Keys revoked</div><div class="v">${revoked ?? 0}</div></div></div>
    <p class="muted">MRR = live gyms × tier (99/199/349), 3-day grace included, disabled gyms excluded.${mrrErr ? ` <span class="pill bad">${mrrErr.message}</span>` : ""}</p>`;
}

async function fleet(root: HTMLElement, token: number) {
  root.innerHTML = `<h2>Fleet</h2>
    <div class="row"><input id="q" placeholder="Filter gyms…" />
    <select id="f"><option value="all">all</option>
    <option value="disabled">disabled</option><option value="live">live</option></select>
    <button class="primary" id="new-gym">+ New gym</button></div>
    <div id="gym-form" hidden class="row" style="margin:8px 0">
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
      tbEl.innerHTML = `<tr><td colspan="5" class="pill bad">${error.message}</td></tr>`;
      return;
    }
    tbEl.innerHTML = (data ?? [])
      .map((g) => `<tr><td>${g.name}</td><td>${g.tier}</td><td class="muted" title="${g.id}">${g.id.slice(0, 8)}…</td>
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

  root.innerHTML = `<h2>Key Vault</h2>
    <p class="muted">Token is show-once at issue. Vault lists inventory + accounting metadata. Revoke via Edge Function (service_role + audit).</p>
    ${error ? `<p class="pill bad">${error.message}</p>` : ""}
    <table><thead><tr><th>Gym</th><th>Tier</th><th>License</th><th>Price</th><th>Issued</th><th>Expires</th><th>By</th><th>Status</th><th></th></tr></thead><tbody>
    ${(data ?? []).map((l) => `<tr>
      <td>${gymName(l.gym_id)}</td>
      <td>${l.tier ?? "—"}</td>
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
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <select id="gid"><option value="">— new gym (type name) —</option>
        ${(gyms ?? []).map((g) => `<option value="${g.id}">${g.name}</option>`).join("")}
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
      show.innerHTML = `<div class="card" style="border:1px solid #f59e0b;margin-top:8px">
        <strong style="color:#f59e0b">Copy this key now — it will not be shown again.</strong>
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
  root.innerHTML = `<h2>Releases</h2><div class="row"><input id="v" placeholder="3.0.1" />
    <select id="ch"><option>stable</option><option>beta</option></select>
    <input id="pct" type="number" min="0" max="100" value="100" style="width:80px" />
    <input id="url" placeholder="download url" style="min-width:280px" />
    <input id="sig" placeholder="minisign .sig (optional)" style="min-width:280px" />
    <button class="primary" id="pub">Publish</button></div>
    <p id="rel-msg" class="muted"></p>
    <table><thead><tr><th>Version</th><th>Channel</th><th>Rollout</th><th>URL</th></tr></thead><tbody>
    ${(data ?? []).map((r) => `<tr><td>${r.version}</td><td>${r.channel}</td><td>${r.rollout_pct}%</td><td class="muted">${r.download_url}</td></tr>`).join("")}
    </tbody></table>`;
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
  root.innerHTML = `<h2>Audit</h2>
    ${error ? `<p class="pill bad">${error.message}</p>` : ""}
    <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>License</th><th>Gym</th><th>Detail</th></tr></thead><tbody>
    ${(data ?? []).map((a) => `<tr>
      <td>${new Date(a.created_at).toLocaleString()}</td>
      <td>${a.actor}</td>
      <td>${a.action}</td>
      <td class="muted">${a.license_id ? maskKey(a.license_id) : "—"}</td>
      <td class="muted">${a.gym_id ? a.gym_id.slice(0, 8) + "…" : "—"}</td>
      <td class="muted">${a.reason || ""}</td></tr>`).join("")
      || `<tr><td colspan="6" class="muted">No audit rows.</td></tr>`}
    </tbody></table>`;
}

async function users(root: HTMLElement) {
  root.innerHTML = `<h2>Users &amp; RBAC</h2>
    <p class="muted">Self-registered accounts have no role until you grant one here (or bootstrap the first CEO).</p>
    <div id="u-list" class="muted">Loading users…</div>
    <div class="row" style="margin-top:12px"><input id="uemail" placeholder="user email" />
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
        <td>${u.email ?? "—"}</td>
        <td>${u.role ? `<span class="pill ${u.role === "ceo" ? "good" : "warn"}">${u.role}</span>` : '<span class="pill bad">none</span>'}</td>
        <td class="muted">${u.gym_ids.length ? u.gym_ids.map((g) => g.slice(0, 8)).join(", ") + (u.gym_ids.length > 1 ? "…" : "") : "—"}</td>
        <td>${u.email ? `<button data-use="${u.email}" data-role="${u.role ?? ""}" data-gyms="${u.gym_ids.join(",")}">Edit</button>` : ""}</td>
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
      msg.textContent = role === "" ? `Removed role from ${email}.` : `Granted ${role} to ${email}.`;
      msg.style.color = "#3ddc97";
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
  };
}
