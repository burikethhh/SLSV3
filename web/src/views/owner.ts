// Owner bundle (lazy). Covers v2 portal tabs: overview, catalog, plans, promos,
// live transactions (realtime), staff, keys. Attendance folded into overview ticker
// + full log under txns page section to keep bundle small.
//
// Concurrency: every render gets a `token`; async work re-checks it right
// before touching the DOM. Prevents in-flight loads / debounced draws from
// clobbering a view the user already navigated away to.
import { db, myGymIds } from "../supabase";
import { pesos, debounce, confirmModal, pollVisible } from "../ui";

type Session = unknown;

let viewToken = 0;

/** Include `gym_id IS NULL` (global templates) alongside the caller's gyms —
 *  the old `.in()`-only filter hid every global plan/promo from owners. */
function scope<T>(query: T, s: Session, col = "gym_id"): T {
  const ids = myGymIds(s);
  if (!ids) return query; // CEO viewing owner pages = unscoped
  const list = ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (query as any).or(`${col}.is.null,${col}.in.(${list.join(",")})`);
}

/** Gyms this account may write to (CEO with no gym_ids and unprovisioned
 *  owners get an empty list → forms render read-only instead of failing
 *  silently against NOT NULL / RLS). */
async function writableGyms(s: Session): Promise<{ id: string; name: string }[]> {
  const ids = myGymIds(s);
  if (!ids || !ids.length) return [];
  const { data } = await db().from("gyms").select("id,name").in("id", ids).order("name");
  return data ?? [];
}

function gymSelectHtml(gyms: { id: string; name: string }[], id: string): string {
  if (!gyms.length) return "";
  return `<select id="${id}">${gyms.map((g) => `<option value="${g.id}">${g.name}</option>`).join("")}</select>`;
}

export async function renderOwner(root: HTMLElement, path: string, s: Session) {
  const token = ++viewToken;
  if (path.startsWith("/catalog")) return catalog(root, s, token);
  if (path.startsWith("/plans")) return plans(root, s, token);
  if (path.startsWith("/promos")) return promos(root, s, token);
  if (path.startsWith("/txns")) return txns(root, s, token);
  if (path.startsWith("/staff")) return staff(root, s, token);
  if (path.startsWith("/keys")) return keys(root, s);
  return overview(root, s, token);
}

async function overview(root: HTMLElement, s: Session, token: number) {
  const load = async () => {
    if (token !== viewToken || !root.isConnected) return; // navigated away mid-fetch
    const { data: sales } = await scope(db().from("sales").select("total_cents,created_at").order("created_at", { ascending: false }).limit(100), s);
    const total = (sales ?? []).reduce((a, r) => a + Number(r.total_cents), 0);
    const { data: att } = await scope(db().from("attendance").select("id,created_at").order("created_at", { ascending: false }).limit(24), s);
    // Hourly check-in bars: native divs, no chart lib (v2 shipped chart.umd 200KB)
    const hours = new Array(12).fill(0);
    for (const a of att ?? []) {
      const h = new Date(a.created_at).getHours();
      hours[Math.min(11, Math.floor(h / 2))]++;
    }
    const max = Math.max(1, ...hours);
    if (token !== viewToken || !root.isConnected) return; // …and again before the write
    root.innerHTML = `<h2>Revenue & analytics</h2><div class="cards" id="ov-cards">
      <div class="card"><div class="k">Sales (last 100)</div><div class="v">${pesos(total)}</div></div>
      <div class="card"><div class="k">Check-ins (24)</div><div class="v">${(att ?? []).length}</div></div></div>
      <h3>Check-ins by 2h block</h3><div class="row">${hours.map((v) => `<div title="${v}" style="width:22px;background:#8b5cf6;height:${Math.round((v / max) * 80) + 4}px;border-radius:4px"></div>`).join("")}</div>
      <p class="muted">Full tables live under Live feed / Staff / Keys. Auto-refresh: 60s, visible tab only.</p>`;
  };
  await load();
  // Visible-tab 60s poll. Marker + token are BOTH checked: the staff view also
  // renders `.cards`, which used to keep this poll alive and overwrite it.
  pollVisible(
    () => (token === viewToken && root.isConnected ? root.querySelector("#ov-cards") : null),
    load,
    60000,
  );
}

async function keys(root: HTMLElement, s: Session) {
  const [{ data: gyms }, { data, error }] = await Promise.all([
    db().from("gyms").select("id,name,tier,disabled").order("name"),
    scope(db().from("licenses").select("id,gym_id,revoked,expires_at,created_at,tier,price_usd,days_valid"), s),
  ]);
  const gym = (id: string) => gyms?.find((g) => g.id === id);
  root.innerHTML = `<h2>Branch keys</h2>
    <p class="muted">Your gym's license inventory. Tokens are show-once at issue (CEO Key Vault) — not re-downloadable here. Suspended = CEO kill/revoke; terminals lock on next sync (~30s).</p>
    ${error ? `<p class="pill bad">${error.message}</p>` : ""}
    ${(gyms ?? []).some((g) => g.disabled) ? `<p class="pill bad">At least one gym is disabled — terminals are locked.</p>` : ""}
    <table><thead><tr><th>Gym</th><th>Tier</th><th>Key</th><th>Price</th><th>Expires</th><th>Status</th></tr></thead><tbody>
    ${(data ?? []).map((l) => {
      const g = gym(l.gym_id);
      return `<tr>
        <td>${g?.name ?? l.gym_id.slice(0, 8) + "…"}</td>
        <td>${l.tier ?? g?.tier ?? "—"}</td>
        <td class="muted">${l.id.slice(0, 8)}…</td>
        <td>${l.price_usd ? `$${l.price_usd}/mo` : "—"}</td>
        <td>${new Date(l.expires_at).toLocaleDateString()}</td>
        <td>${l.revoked || g?.disabled
          ? '<span class="pill bad">suspended</span>'
          : '<span class="pill good">active</span>'}</td></tr>`;
    }).join("") || `<tr><td colspan="6" class="muted">No keys for your gyms yet — ask CEO to issue.</td></tr>`}
    </tbody></table>`;
}

async function catalog(root: HTMLElement, s: Session, token: number) {
  const gyms = await writableGyms(s);
  const canWrite = gyms.length > 0;
  root.innerHTML = `<h2>POS products & pricing</h2><div class="row">
    <input id="q" placeholder="Search…" />
    ${gymSelectHtml(gyms, "gym")}
    <input id="n" placeholder="Name" /><input id="p" type="number" placeholder="price cents" style="width:120px" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Add</button></div>
    <table><thead><tr><th>Name</th><th>Price</th><th>Stock</th><th></th></tr></thead><tbody id="tb"></tbody></table>
    <p id="cat-msg" class="muted">${canWrite ? "Saves push to terminals on next sync pull. Per-branch overrides: phase next (table ready)." : "Read-only — no gym assigned to this account."}</p>`;

  const draw = async () => {
    const qEl = document.getElementById("q") as HTMLInputElement | null;
    const tb = document.getElementById("tb");
    if (token !== viewToken || !qEl || !tb) return; // debounced fire after navigation
    const q = qEl.value;
    let query = scope(db().from("products").select("id,name,price_cents,stock").order("name").limit(50), s);
    if (q) query = query.ilike("name", `%${q}%`);
    const { data, error } = await query;
    if (token !== viewToken || !document.getElementById("tb")) return;
    if (error) {
      const m = document.getElementById("cat-msg");
      if (m) { m.textContent = error.message; m.style.color = "#f87171"; }
      return;
    }
    document.getElementById("tb")!.innerHTML = (data ?? [])
      .map((p) => `<tr><td>${p.name}</td><td>${pesos(Number(p.price_cents))}</td><td>${p.stock}</td>
        <td><button data-del="${p.id}">Delete</button></td></tr>`).join("");
    root.querySelectorAll("[data-del]").forEach((b) =>
      (b as HTMLButtonElement).onclick = async () => {
        if (!await confirmModal({ title: "Delete product?", body: "Terminals drop it on next pull.", confirmLabel: "Delete", danger: true })) return;
        const ids = myGymIds(s);
        let del = db().from("products").delete().eq("id", (b as HTMLElement).dataset.del!);
        if (ids) del = del.in("gym_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
        const { error: delErr } = await del;
        if (delErr) {
          // CEO / gym-less accounts hit RLS here — used to vanish silently.
          const m = document.getElementById("cat-msg");
          if (m) { m.textContent = `Delete failed: ${delErr.message}`; m.style.color = "#f87171"; }
          return;
        }
        draw();
      });
  };
  (document.getElementById("q") as HTMLInputElement).oninput = debounce(draw);
  (document.getElementById("add") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("cat-msg")!;
    const gymId = (document.getElementById("gym") as HTMLSelectElement | null)?.value;
    const name = (document.getElementById("n") as HTMLInputElement).value.trim();
    if (!canWrite || !gymId) { msg.textContent = "No gym selected — read-only account."; return; }
    if (!name) { msg.textContent = "Name required."; return; }
    const { error } = await db().from("products").insert({
      gym_id: gymId,
      name,
      price_cents: Number((document.getElementById("p") as HTMLInputElement).value),
    });
    if (error) { msg.textContent = `Add failed: ${error.message}`; msg.style.color = "#f87171"; return; }
    msg.textContent = "Added.";
    msg.style.color = "#34d399";
    draw();
  };
  await draw();
}

async function plans(root: HTMLElement, s: Session, token: number) {
  const gyms = await writableGyms(s);
  const canWrite = gyms.length > 0;
  const { data } = await scope(db().from("plans").select("*").order("price_cents").limit(50), s, "gym_id");
  root.innerHTML = `<h2>Membership plans</h2><div class="row">
    ${gymSelectHtml(gyms, "gym")}
    <input id="n" placeholder="Plan name" />
    <input id="p" type="number" placeholder="price cents" style="width:120px" />
    <input id="d" type="number" placeholder="days" value="30" style="width:80px" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Add plan</button></div>
    <p id="plan-msg" class="muted">${canWrite ? "" : "Read-only — no gym assigned to this account."}</p>
    <table><thead><tr><th>Plan</th><th>Price</th><th>Days</th></tr></thead><tbody>
    ${(data ?? []).map((p) => `<tr><td>${p.name}</td><td>${pesos(Number(p.price_cents))}</td><td>${p.duration_days}</td></tr>`).join("")}
    </tbody></table>`;
  (document.getElementById("add") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("plan-msg")!;
    const gymId = (document.getElementById("gym") as HTMLSelectElement | null)?.value;
    const name = (document.getElementById("n") as HTMLInputElement).value.trim();
    if (!canWrite || !gymId) { msg.textContent = "No gym selected — read-only account."; return; }
    if (!name) { msg.textContent = "Plan name required."; return; }
    const { error } = await db().from("plans").insert({
      gym_id: gymId,
      name,
      price_cents: Number((document.getElementById("p") as HTMLInputElement).value),
      duration_days: Number((document.getElementById("d") as HTMLInputElement).value) || 30,
    });
    if (error) { msg.textContent = `Add failed: ${error.message}`; msg.style.color = "#f87171"; return; }
    renderOwner(root, "/plans", s);
  };
}

async function promos(root: HTMLElement, s: Session, token: number) {
  const gyms = await writableGyms(s);
  const canWrite = gyms.length > 0;
  const { data } = await scope(db().from("promos").select("*").order("created_at", { ascending: false }).limit(50), s, "gym_id");
  root.innerHTML = `<h2>Promo vouchers</h2><div class="row">
    ${gymSelectHtml(gyms, "gym")}
    <input id="c" placeholder="CODE" />
    <input id="pct" type="number" placeholder="% off" style="width:90px" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Push promo</button></div>
    <p id="promo-msg" class="muted">${canWrite ? "" : "Read-only — no gym assigned to this account."}</p>
    <table><thead><tr><th>Code</th><th>Off</th><th>Active</th></tr></thead><tbody>
    ${(data ?? []).map((p) => `<tr><td>${p.code}</td><td>${p.pct_off}%</td><td>${p.active ? "yes" : "no"}</td></tr>`).join("")}
    </tbody></table>`;
  (document.getElementById("add") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("promo-msg")!;
    const gymId = (document.getElementById("gym") as HTMLSelectElement | null)?.value;
    const code = (document.getElementById("c") as HTMLInputElement).value.trim().toUpperCase();
    if (!canWrite || !gymId) { msg.textContent = "No gym selected — read-only account."; return; }
    if (!code) { msg.textContent = "Code required."; return; }
    const { error } = await db().from("promos").insert({
      gym_id: gymId,
      code,
      pct_off: Number((document.getElementById("pct") as HTMLInputElement).value) || 0,
    });
    if (error) { msg.textContent = `Add failed: ${error.message}`; msg.style.color = "#f87171"; return; }
    renderOwner(root, "/promos", s);
  };
}

async function txns(root: HTMLElement, s: Session, token: number) {
  // tbody id is feed-specific: the catalog view also uses #tb, and a shared id
  // kept the realtime channel (and its writes) alive across navigation.
  root.innerHTML = `<h2>Live POS feed</h2><p class="muted">Realtime INSERTs on <i>sales</i> (scoped). Older rows via pagination.</p>
    <table><thead><tr><th>When</th><th>Total</th><th>Method</th></tr></thead><tbody id="feed-tbody"></tbody></table>`;
  const ids = myGymIds(s);
  const load = async () => {
    const tb = document.getElementById("feed-tbody");
    if (token !== viewToken || !tb) return;
    let q = db().from("sales").select("total_cents,pay_method,created_at").order("created_at", { ascending: false }).limit(50);
    if (ids) q = q.in("gym_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const { data } = await q;
    const tb2 = document.getElementById("feed-tbody");
    if (token !== viewToken || !tb2) return;
    tb2.innerHTML = (data ?? [])
      .map((t) => `<tr><td>${new Date(t.created_at).toLocaleString()}</td><td>${pesos(Number(t.total_cents))}</td><td>${t.pay_method}</td></tr>`).join("");
  };
  await load();
  // Realtime scoped to this terminal's gyms (dashboard plan §6: gate never waits on this).
  // CEO (ids=null) gets the global feed; owners filter to their gym_ids.
  const filter = ids && ids.length ? `gym_id=in.(${ids.join(",")})` : undefined;
  const ch = db().channel(`sales-feed-${token}`) // unique name — no cross-view channel collisions
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "sales", ...(filter ? { filter } : {}) },
      () => load(),
    )
    .subscribe();
  // Detach when leaving the view (watch OUR tbody id, not a shared one)
  const obs = new MutationObserver(() => { if (!document.getElementById("feed-tbody")) { ch.unsubscribe(); obs.disconnect(); } });
  obs.observe(root, { childList: true });
}

async function staff(root: HTMLElement, s: Session, token: number) {
  const [gyms, { data }] = await Promise.all([
    writableGyms(s),
    scope(db().from("staff").select("id,full_name,username,role,active").order("full_name").limit(50), s),
  ]);
  const canWrite = gyms.length > 0;
  const total = (data ?? []).length;
  const active = (data ?? []).filter((x) => x.active).length;
  root.innerHTML = `<h2>Staff & cashiers</h2><div class="cards">
    <div class="card"><div class="k">Total</div><div class="v">${total}</div></div>
    <div class="card"><div class="k">Active</div><div class="v">${active}</div></div></div>
    <p class="muted">Staff unlock POS + check-ins on the terminal only. Revenue, keys, pricing stay protected. PINs hashed Argon2id (see sls-core::auth).</p>
    <div class="row">${gymSelectHtml(gyms, "gym")}<input id="fn" placeholder="Full name" /><input id="un" placeholder="username" />
    <input id="pin" placeholder="4-6 digit PIN" maxlength="6" style="width:120px" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Save credential</button></div>
    <p id="staff-msg" class="muted">${canWrite ? "" : "Read-only — staff credentials need a gym assigned to this account."}</p>
    <table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Active</th></tr></thead><tbody>
    ${(data ?? []).map((x) => `<tr><td>${x.full_name}</td><td>${x.username}</td><td>${x.role}</td><td>${x.active ? "yes" : "no"}</td></tr>`).join("")}
    </tbody></table>`;
  (document.getElementById("add") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("staff-msg")!;
    const pin = (document.getElementById("pin") as HTMLInputElement).value;
    const gymId = (document.getElementById("gym") as HTMLSelectElement | null)?.value;
    if (!/^\d{4,6}$/.test(pin)) { msg.textContent = "PIN must be 4-6 digits."; return; }
    if (!canWrite || !gymId) { msg.textContent = "No gym selected — staff-create needs a gym_id."; return; }
    // Server-side Argon2id via staff-create Edge Function (sls-core-compatible hash).
    const base = import.meta.env.VITE_SUPABASE_URL;
    const { data: { session } } = await db().auth.getSession();
    const res = await fetch(`${base}/functions/v1/staff-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
      body: JSON.stringify({
        gym_id: gymId,
        full_name: (document.getElementById("fn") as HTMLInputElement).value,
        username: (document.getElementById("un") as HTMLInputElement).value,
        pin,
        role: "staff",
      }),
    });
    if (!res.ok) { msg.textContent = await res.text(); msg.style.color = "#f87171"; return; }
    renderOwner(root, "/staff", s);
  };
}
