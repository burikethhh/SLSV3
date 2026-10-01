// Owner bundle (lazy). Covers v2 portal tabs: overview, catalog, plans, promos,
// live transactions (realtime), staff, keys. Attendance folded into overview ticker
// + full log under txns page section to keep bundle small.
//
// Concurrency: every render gets a `token`; async work re-checks it right
// before touching the DOM. Prevents in-flight loads / debounced draws from
// clobbering a view the user already navigated away to.
import { db, myGymIds } from "../supabase";
import { pesos, debounce, confirmModal, pollVisible, stat, navcard, emptyState, esc } from "../ui";

type Session = unknown;

let viewToken = 0;

/** Shell (#view) of the current owner render — sub-views re-enter through it
 *  so async redraws never wipe sibling chrome. */
let shell: HTMLElement | null = null;

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
  return `<select id="${id}">${gyms.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>`;
}

export async function renderOwner(root: HTMLElement, path: string, s: Session) {
  const token = ++viewToken;
  shell = root;
  // Sidebar owns navigation now; views render into the body container.
  root.innerHTML = `<div id="owner-body"><div class="skel-stack"><div class="skel" style="height:118px"></div><div class="skel" style="height:220px"></div></div></div>`;
  const body = document.getElementById("owner-body")!;
  if (token !== viewToken) return;
  if (path.startsWith("/catalog")) return catalog(body, s, token);
  if (path.startsWith("/plans")) return plans(body, s, token);
  if (path.startsWith("/promos")) return promos(body, s, token);
  if (path.startsWith("/txns")) return txns(body, s, token);
  if (path.startsWith("/staff")) return staff(body, s, token);
  if (path.startsWith("/keys")) return keys(body, s);
  return overview(body, s, token);
}

async function overview(root: HTMLElement, s: Session, token: number) {
  const charts: { destroy(): void }[] = [];
  const load = async () => {
    if (token !== viewToken || !root.isConnected) return; // navigated away mid-fetch
    const [{ data: sales }, { data: att }, { count: members }, { data: products }, { data: gyms },
      { count: nProducts }, { count: nPlans }, { count: nPromos }, { count: nStaff }, { count: nKeys }] = await Promise.all([
      scope(db().from("sales").select("total_cents,created_at,gym_id,items,status").order("created_at", { ascending: false }).limit(500), s),
      scope(db().from("attendance").select("created_at,gym_id,member_id").order("created_at", { ascending: false }).limit(500), s),
      scope(db().from("members").select("id", { count: "exact", head: true }).is("deleted_at", null), s),
      scope(db().from("products").select("id,name").limit(500), s),
      db().from("gyms").select("id,name").order("name"),
      scope(db().from("products").select("id", { count: "exact", head: true }), s),
      scope(db().from("plans").select("id", { count: "exact", head: true }), s, "gym_id"),
      scope(db().from("promos").select("id", { count: "exact", head: true }).eq("active", true), s, "gym_id"),
      scope(db().from("staff").select("id", { count: "exact", head: true }), s),
      scope(db().from("licenses").select("id", { count: "exact", head: true }), s),
    ]);
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const salesRows = (sales ?? []).filter((r) => (r.status ?? "sale") !== "void");
    const signed = (r: { total_cents: number; status?: string }) =>
      (r.status ?? "sale") === "refund" ? -Number(r.total_cents) : Number(r.total_cents);
    // Manual gate overrides sync with member_id=null — keep them out of
    // foot-traffic stats (audit trail only, not visits).
    const attRows = (att ?? []).filter((a) => a.member_id);
    const monthRev = salesRows.filter((r) => new Date(r.created_at) >= monthStart).reduce((a, r) => a + signed(r), 0);
    const todaySales = salesRows.filter((r) => new Date(r.created_at) >= dayStart);
    const todayRev = todaySales.reduce((a, r) => a + signed(r), 0);
    const todayAtt = attRows.filter((a) => new Date(a.created_at) >= dayStart);
    // 30-day revenue trend
    const days: string[] = [];
    const dayTotals = new Array(30).fill(0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    }
    for (const r of salesRows) {
      const diff = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 86400000);
      if (diff >= 0 && diff < 30) dayTotals[29 - diff] += signed(r) / 100;
    }
    // Top products donut from sale line items {product_id, qty, unit_cents}
    const prodName = new Map((products ?? []).map((p) => [p.id, p.name]));
    const byProd = new Map<string, number>();
    for (const r of salesRows) {
      for (const it of (r.items as { product_id: string; qty: number; unit_cents: number }[] | null) ?? []) {
        byProd.set(it.product_id, (byProd.get(it.product_id) ?? 0) + Number(it.qty) * Number(it.unit_cents) / 100);
      }
    }
    const top = [...byProd.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    // 24h foot-traffic heatmap (today's check-ins by hour)
    const hours = new Array(24).fill(0);
    for (const a of todayAtt) hours[new Date(a.created_at).getHours()]++;
    const hmax = Math.max(1, ...hours);
    // Branch leaderboard: per-gym sales + check-ins
    const gymName = new Map((gyms ?? []).map((g) => [g.id, g.name]));
    const board = new Map<string, { sales: number; n: number; att: number }>();
    for (const r of salesRows) {
      const e = board.get(r.gym_id) ?? { sales: 0, n: 0, att: 0 };
      e.sales += signed(r); e.n++;
      board.set(r.gym_id, e);
    }
    for (const a of attRows) {
      const e = board.get(a.gym_id) ?? { sales: 0, n: 0, att: 0 };
      e.att++;
      board.set(a.gym_id, e);
    }
    const rows = [...board.entries()]
      .map(([gid, e]) => ({ name: gymName.get(gid) ?? gid.slice(0, 8) + "…", ...e }))
      .sort((a, b) => b.sales - a.sales);
    if (token !== viewToken || !root.isConnected) return; // …and again before the write
    for (const c of charts.splice(0)) c.destroy();
    root.innerHTML = `<div class="page-head"><h2>POS revenue & analytics</h2>
      <span class="row">
        <span class="muted" style="margin-right:8px">auto-refresh 60s</span>
        <button id="ov-print" class="btn-subtle" title="Print analytics report">Print Report</button>
      </span></div>
      <div class="cards" id="ov-cards">
      ${stat("Month POS revenue", pesos(monthRev), "emerald", "money", "POS sales this calendar month (refunds subtracted, voids excluded)")}
      ${stat("Today POS revenue", pesos(todayRev), "emerald", "chart", `${todaySales.length} sales today`)}
      ${stat("Check-ins today", String(todayAtt.length), "sky", "zap", "gate entries since midnight")}
      ${stat("Active members", String(members ?? 0), "violet", "users", "across your gyms")}</div>
      <div class="charts-grid">
        <div class="glass-panel panel"><div class="stat-k" style="margin-bottom:8px">30-day revenue trend (₱)</div>
          <div class="chart-box"><canvas id="rev-chart"></canvas></div></div>
        <div class="glass-panel panel"><div class="stat-k" style="margin-bottom:8px">Top products by revenue (₱)</div>
          <div class="chart-box" style="display:flex;align-items:center;justify-content:center">${top.length ? `<canvas id="cat-chart"></canvas>` : emptyState("No product sales yet", "Item breakdown lights up as cashiers tender products", "box")}</div></div>
      </div>
      <div class="glass-panel panel">
        <div class="stat-top" style="margin-bottom:8px">
          <span class="stat-k">Hourly foot traffic — today</span>
          <span class="muted" style="font-size:11px;font-family:Rajdhani,sans-serif;letter-spacing:0.8px">${todayAtt.length ? `${todayAtt.length} CHECK-INS LOGGED` : "SENSORS ACTIVE · STANDBY"}</span>
        </div>
        <div class="bars traffic-bars">${hours.map((v, h) => `<div title="${String(h).padStart(2, "0")}:00 — ${v} entries" class="${v > 0 ? "active-hour" : ""}" style="height:${v > 0 ? Math.round((v / hmax) * 75) + 8 : 4}px"></div>`).join("")}</div>
        <div class="traffic-hours">
          <span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>23:00</span>
        </div>
      </div>
      <h3>Gym leaderboard</h3>
      <table><thead><tr><th>Gym</th><th>Sales</th><th>Txns</th><th>Check-ins</th></tr></thead><tbody>
      ${rows.map((g) => `<tr><td>${esc(g.name)}</td><td>${pesos(g.sales)}</td><td>${g.n}</td><td>${g.att}</td></tr>`).join("")
        || `<tr><td colspan="4" style="padding:0">${emptyState("No branch telemetry yet", "Gate check-ins and POS sales appear here in realtime", "zap")}</td></tr>`}
      </tbody></table>
      <h3>Manage</h3>
      <div class="navcards">
      ${navcard("#/owner/catalog", "box", "violet", "Catalog", "products · pricing", String(nProducts ?? 0))}
      ${navcard("#/owner/plans", "money", "emerald", "Plans", "memberships", String(nPlans ?? 0))}
      ${navcard("#/owner/promos", "tag", "amber", "Promos", "active vouchers", String(nPromos ?? 0))}
      ${navcard("#/owner/txns", "zap", "sky", "Live feed", "today's sales", String(todaySales.length))}
      ${navcard("#/owner/staff", "users", "violet", "Staff", "terminal PINs", String(nStaff ?? 0))}
      ${navcard("#/owner/keys", "key", "red", "Keys", "branch licenses", String(nKeys ?? 0))}</div>
      <p class="muted">Full tables live under Live feed / Staff / Keys.</p>`;
    document.getElementById("ov-print")?.addEventListener("click", () => window.print());
    const grid = { color: "rgba(139, 92, 246, 0.12)" };
    const ticks = { color: "#94a3b8", font: { family: "Inter, sans-serif", size: 10 } };
    const mk = (id: string, cfg: unknown) => {
      const cv = document.getElementById(id) as HTMLCanvasElement | null;
      if (!cv) return;
      if (!window.Chart) {
        const box = cv.parentElement;
        if (box && !box.querySelector(".chart-fallback-msg")) {
          cv.style.display = "none";
          const d = document.createElement("div");
          d.className = "chart-fallback-msg muted";
          d.textContent = "Charts unavailable offline — the figures above are live.";
          box.appendChild(d);
        }
        return;
      }
      charts.push(new window.Chart(cv.getContext("2d")!, cfg));
    };
    mk("rev-chart", {
      type: "line",
      data: {
        labels: days,
        datasets: [{
          data: dayTotals,
          borderColor: "#8b5cf6",
          borderWidth: 2.5,
          backgroundColor: (ctx: { chart: { ctx: CanvasRenderingContext2D } }) => {
            const chart = ctx.chart;
            const gradient = chart.ctx.createLinearGradient(0, 0, 0, 200);
            gradient.addColorStop(0, "rgba(139, 92, 246, 0.35)");
            gradient.addColorStop(1, "rgba(139, 92, 246, 0.0)");
            return gradient;
          },
          fill: true,
          tension: 0.38,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#c4b5fd",
          pointHoverBorderColor: "#fff",
          pointHoverBorderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(13, 16, 28, 0.95)",
            titleColor: "#ede9fe",
            bodyColor: "#c4b5fd",
            borderColor: "rgba(139, 92, 246, 0.4)",
            borderWidth: 1,
            padding: 10,
            cornerRadius: 8,
            titleFont: { family: "Rajdhani, sans-serif", size: 13, weight: "700" },
            bodyFont: { family: "Inter, sans-serif", size: 12 },
            callbacks: {
              label: (ctx: { parsed: { y: number } }) => ` ₱${(ctx.parsed.y ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            },
          },
        },
        scales: { x: { ticks, grid }, y: { ticks, grid } },
      },
    });
    if (top.length) mk("cat-chart", {
      type: "doughnut",
      data: {
        labels: top.length ? top.map(([id]) => prodName.get(id) ?? "Unknown") : ["No sales recorded"],
        datasets: [{
          data: top.length ? top.map(([, v]) => Math.round(v * 100) / 100) : [1],
          backgroundColor: top.length ? ["#8b5cf6", "#34d399", "#38bdf8", "#fbbf24", "#f472b6"] : ["rgba(100, 116, 139, 0.25)"],
          borderColor: "#0d101c",
          borderWidth: 2,
          hoverOffset: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "66%",
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: "#94a3b8",
              boxWidth: 12,
              padding: 10,
              font: { family: "Inter, sans-serif", size: 11 },
            },
          },
          tooltip: {
            backgroundColor: "rgba(13, 16, 28, 0.95)",
            titleColor: "#ede9fe",
            bodyColor: "#c4b5fd",
            borderColor: "rgba(139, 92, 246, 0.4)",
            borderWidth: 1,
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (ctx: { parsed: number }) => top.length ? ` ₱${ctx.parsed.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : " No sales yet",
            },
          },
        },
      },
    });
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
  root.innerHTML = `<div class="page-head"><h2>Branch keys</h2><span class="muted">license inventory</span></div>
    <p class="muted">Your gym's license inventory. Tokens are show-once at issue (CEO Key Vault) — not re-downloadable here. Suspended = CEO kill/revoke; terminals lock on next sync (~30s).</p>
    ${error ? `<p class="pill bad">${esc(error.message)}</p>` : ""}
    ${(gyms ?? []).some((g) => g.disabled) ? `<p class="pill bad">At least one gym is disabled — terminals are locked.</p>` : ""}
    <table><thead><tr><th>Gym</th><th>Tier</th><th>Key</th><th>Price</th><th>Expires</th><th>Status</th></tr></thead><tbody>
    ${(data ?? []).map((l) => {
      const g = gym(l.gym_id);
      return `<tr>
        <td>${esc(g?.name ?? l.gym_id.slice(0, 8) + "…")}</td>
        <td>${esc(l.tier ?? g?.tier ?? "—")}</td>
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
  root.innerHTML = `<div class="page-head"><h2>POS products & pricing</h2><span class="muted">pushes to terminals on sync</span></div>
  <div class="panel row">
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
      .map((p) => `<tr><td>${esc(p.name)}</td><td>${pesos(Number(p.price_cents))}</td><td>${p.stock}</td>
        <td><button data-del="${p.id}">Delete</button></td></tr>`).join("")
      || `<tr><td colspan="4" style="padding:0">${emptyState("Catalog is empty", "Add products above to push items to your POS terminals", "box")}</td></tr>`;
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
  root.innerHTML = `<div class="page-head"><h2>Membership plans</h2><span class="muted">global templates + branch plans</span></div>
  <div class="panel row">
    ${gymSelectHtml(gyms, "gym")}
    <input id="n" placeholder="Plan name" />
    <input id="p" type="number" placeholder="price cents" style="width:120px" />
    <input id="d" type="number" placeholder="days" value="30" style="width:80px" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Add plan</button></div>
    <p id="plan-msg" class="muted">${canWrite ? "" : "Read-only — no gym assigned to this account."}</p>
    <div class="plans-grid">
    ${(data ?? []).length ? (data ?? []).map((p) => `<div class="glass-panel plan-card">
      <div class="row" style="justify-content:space-between"><span class="plan-name">${esc(p.name)}</span>
      ${p.gym_id ? '<span class="stat-badge badge-pro">branch</span>' : '<span class="stat-badge badge-basic">global</span>'}</div>
      <div class="plan-price txt-emerald">${pesos(Number(p.price_cents))}</div>
      <div class="plan-meta">${p.duration_days} days · syncs to terminals on pull</div>
    </div>`).join("") : emptyState("No plans available", "Create a membership plan or day pass above to sync to terminals", "money")}
    </div>`;
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
    if (shell) renderOwner(shell, "/plans", s);
  };
}

async function promos(root: HTMLElement, s: Session, token: number) {
  const gyms = await writableGyms(s);
  const canWrite = gyms.length > 0;
  const { data } = await scope(db().from("promos").select("*").order("created_at", { ascending: false }).limit(50), s, "gym_id");
  root.innerHTML = `<div class="page-head"><h2>Promo vouchers</h2><span class="muted">POS discounts</span></div>
  <div class="panel row">
    ${gymSelectHtml(gyms, "gym")}
    <input id="c" placeholder="CODE" />
    <input id="pct" type="number" placeholder="% off" style="width:90px" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Push promo</button></div>
    <p id="promo-msg" class="muted">${canWrite ? "" : "Read-only — no gym assigned to this account."}</p>
    <table><thead><tr><th>Code</th><th>Off</th><th>Active</th></tr></thead><tbody>
    ${(data ?? []).map((p) => `<tr><td>${esc(p.code)}</td><td>${p.pct_off}%</td><td>${p.active ? "yes" : "no"}</td></tr>`).join("")
      || `<tr><td colspan="3" style="padding:0">${emptyState("No active vouchers", "Create discount promo codes to push directly to POS terminals", "tag")}</td></tr>`}
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
    if (shell) renderOwner(shell, "/promos", s);
  };
}

async function txns(root: HTMLElement, s: Session, token: number) {
  // tbody id is feed-specific: the catalog view also uses #tb, and a shared id
  // kept the realtime channel (and its writes) alive across navigation.
  root.innerHTML = `<div class="page-head"><h2>Live POS feed</h2>
    <span class="row">
      <span class="pill good">realtime</span>
      <button id="print-feed-btn" class="btn-subtle" title="Print transaction ledger">Print Ledger</button>
    </span>
  </div>
  <p class="muted">Realtime INSERTs on <i>sales</i> (scoped). Older rows via pagination.</p>
    <table><thead><tr><th>When</th><th>Total</th><th>Method</th><th>Status</th></tr></thead><tbody id="feed-tbody"></tbody></table>`;
  document.getElementById("print-feed-btn")?.addEventListener("click", () => window.print());
  const ids = myGymIds(s);
  const load = async () => {
    const tb = document.getElementById("feed-tbody");
    if (token !== viewToken || !tb) return;
    let q = db().from("sales").select("total_cents,pay_method,created_at,status").order("created_at", { ascending: false }).limit(50);
    if (ids) q = q.in("gym_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const { data } = await q;
    const tb2 = document.getElementById("feed-tbody");
    if (token !== viewToken || !tb2) return;
    tb2.innerHTML = (data ?? [])
      .map((t) => {
        const st = t.status ?? "sale";
        const amt = st === "refund" ? -Number(t.total_cents) : Number(t.total_cents);
        return `<tr><td>${new Date(t.created_at).toLocaleString()}</td><td>${pesos(amt)}</td><td>${esc(t.pay_method)}</td><td>${esc(st)}</td></tr>`;
      }).join("")
      || `<tr><td colspan="4" style="padding:0">${emptyState("No live transactions yet", "Realtime sales will appear as cashiers check out members", "zap")}</td></tr>`;
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
  // Detach when leaving the view. `root` here is the body container (replaced
  // on navigation), so watch its parent — the shell — for the teardown.
  const obs = new MutationObserver(() => { if (!document.getElementById("feed-tbody")) { ch.unsubscribe(); obs.disconnect(); } });
  obs.observe(root.parentElement ?? root, { childList: true });
}

async function staff(root: HTMLElement, s: Session, token: number) {
  const [gyms, { data }] = await Promise.all([
    writableGyms(s),
    scope(db().from("staff").select("id,full_name,username,role,active").order("full_name").limit(50), s),
  ]);
  const canWrite = gyms.length > 0;
  const total = (data ?? []).length;
  const active = (data ?? []).filter((x) => x.active).length;
  const managers = (data ?? []).filter((x) => (x.role ?? "").toLowerCase() === "manager").length;
  root.innerHTML = `<div class="page-head"><h2>Staff & cashiers</h2><span class="muted">terminal PINs only</span></div>
  <div class="cards">
    ${stat("Total staff", String(total), "violet", "users", "all credentials")}
    ${stat("Active", String(active), "emerald", "zap", "can unlock terminals")}
    ${stat("Managers", String(managers), "amber", "shield", "role = manager")}</div>
    <p class="muted">Staff unlock POS + check-ins on the terminal only. Revenue, keys, pricing stay protected. PINs hashed Argon2id (see sls-core::auth).</p>
    <div class="panel row">${gymSelectHtml(gyms, "gym")}<input id="fn" placeholder="Full name" /><input id="un" placeholder="username" />
    <input id="pin" placeholder="6-12 digit PIN" maxlength="12" style="width:120px" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Save credential</button></div>
    <p id="staff-msg" class="muted">${canWrite ? "" : "Read-only — staff credentials need a gym assigned to this account."}</p>
    <table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Active</th></tr></thead><tbody>
    ${(data ?? []).map((x) => `<tr><td>${esc(x.full_name)}</td><td>${esc(x.username)}</td><td>${esc(x.role)}</td><td>${x.active ? "yes" : "no"}</td></tr>`).join("")}
    </tbody></table>`;
  (document.getElementById("add") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("staff-msg")!;
    const pin = (document.getElementById("pin") as HTMLInputElement).value;
    const gymId = (document.getElementById("gym") as HTMLSelectElement | null)?.value;
    if (!/^\d{6,12}$/.test(pin)) { msg.textContent = "PIN must be 6-12 digits."; return; }
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
    if (shell) renderOwner(shell, "/staff", s);
  };
}
