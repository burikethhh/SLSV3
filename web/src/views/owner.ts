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
  if ((s as { user?: { app_metadata?: { role?: string } } })?.user?.app_metadata?.role === "manager") return [];
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
  if (path.startsWith("/start") || path.startsWith("/help")) return gettingStarted(body, s);
  return overview(body, s, token);
}

async function overview(root: HTMLElement, s: Session, token: number) {
  const charts: { destroy(): void }[] = [];
  const load = async () => {
    if (token !== viewToken || !root.isConnected) return; // navigated away mid-fetch
    const [{ data: rawReport, error: reportError }, { data: gyms },
      { count: nProducts }, { count: nPlans }, { count: nPromos }, { count: nStaff }, { data: lics }] = await Promise.all([
      db().rpc("owner_report"),
      db().from("gyms").select("id,name,status,disabled").order("name"),
      scope(db().from("products").select("id", { count: "exact", head: true }), s),
      scope(db().from("plans").select("id", { count: "exact", head: true }), s),
      scope(db().from("promos").select("id", { count: "exact", head: true }).eq("active", true), s),
      scope(db().from("staff").select("id", { count: "exact", head: true }), s),
      scope(db().from("current_subscriptions").select("id,gym_id,expires_at,revoked,is_trial").order("created_at", { ascending: false }), s),
    ]);
    if (token !== viewToken || !root.isConnected) return;
    if (reportError || !rawReport || !Array.isArray(rawReport.daily)) {
      root.innerHTML = `<p class="pill bad">Complete report unavailable: ${esc(reportError?.message || "invalid report response")}. Refresh after checking cloud connectivity; unavailable totals are not shown as zero.</p>`;
      return;
    }
    const report = rawReport as {
      month_revenue_cents: number; today_revenue_cents: number; today_transactions: number;
      today_checkins: number; today_exits: number; active_members: number;
      daily: { day: string; total_cents: number }[];
      top_products: { id: string; name: string; total_cents: number }[];
      hours: { hour: number; entries: number }[];
      branches: { name: string; total_cents: number; transactions: number; checkins: number }[];
    };
    const nKeys = (lics ?? []).length;
    const monthRev = Number(report.month_revenue_cents);
    const todayRev = Number(report.today_revenue_cents);
    const members = Number(report.active_members);
    const ovBanner = subscriptionSummary(gyms ?? [], lics ?? []);
    const days = report.daily.map(d => new Date(d.day + "T12:00:00+08:00").toLocaleDateString("en-PH", {month: "short", day: "numeric", timeZone: "Asia/Manila"}));
    const dayTotals = report.daily.map(d => Number(d.total_cents)/100);
    const prodName = new Map(report.top_products.map(p => [p.id,p.name]));
    const top: [string,number][] = report.top_products.map(p => [p.id,Number(p.total_cents)/100]);
    const hours = new Array<number>(24).fill(0);
    for (const hour of report.hours) if (hour.hour>=0 && hour.hour<24) hours[hour.hour]=Number(hour.entries);
    const hmax = Math.max(1,...hours);
    const rows = report.branches.map(g => ({name:g.name,sales:Number(g.total_cents),n:Number(g.transactions),att:Number(g.checkins)})).sort((a,b)=>b.sales-a.sales);
    if (token !== viewToken || !root.isConnected) return; // …and again before the write
    for (const c of charts.splice(0)) c.destroy();
    root.innerHTML = `<div class="page-head"><h2>POS revenue & analytics</h2>
      <span class="row">
        <span class="muted" style="margin-right:8px">auto-refresh 60s</span>
        <button id="ov-print" class="btn-subtle" title="Print analytics report">Print Report</button>
      </span></div>
      ${ovBanner}
      <div class="cards" id="ov-cards">
      ${stat("Month POS revenue", pesos(monthRev), "emerald", "money", "POS sales this calendar month (refunds subtracted, voids excluded)")}
      ${stat("Today POS revenue", pesos(todayRev), "emerald", "chart", `${report.today_transactions} transactions · Asia/Manila · complete totals`)}
      ${stat("Check-ins today", String(report.today_checkins), "sky", "zap", `${report.today_exits} exits · since midnight Asia/Manila`)}
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
          <span class="muted" style="font-size:11px;font-family:Rajdhani,sans-serif;letter-spacing:0.8px">${report.today_checkins} CHECK-INS · ASIA/MANILA</span>
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
      ${navcard("#/owner/txns", "zap", "sky", "Live feed", "today's transactions", String(report.today_transactions))}
      ${navcard("#/owner/staff", "users", "violet", "Staff", "terminal PINs", String(nStaff ?? 0))}
      ${navcard("#/owner/keys", "key", "red", "Subscriptions", "branch entitlements", String(nKeys ?? 0))}</div>
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

type Facility = { id: string; name: string; status: string; disabled?: boolean };
type Subscription = { gym_id: string; expires_at: string; revoked: boolean; is_trial: boolean; tier?: string };
function subscriptionSummary(gyms: Facility[], licenses: Subscription[]): string {
  return gyms.map((gym) => {
    const license = licenses.find((l) => l.gym_id === gym.id); // newest, including revoked
    const expiry = license ? Date.parse(license.expires_at) : NaN;
    const state = gym.disabled || gym.status === "rejected" ? "Suspended" : !license ? "No subscription" : license.revoked ? "Revoked"
      : !Number.isFinite(expiry) ? "Invalid expiry" : Date.now() <= expiry ? "Active" : Date.now() <= expiry + 3 * 86400_000 ? "Three-day grace" : "Expired · terminal operations locked";
    const active = state === "Active";
    return `<div class="glass-panel panel" style="margin-bottom:12px">
      <strong>${esc(gym.name)}</strong> · <span class="pill ${active ? "good" : "warn"}">${state}</span>
      <p class="muted">${license?.is_trial ? "14-day trial" : "Subscription"}${license ? " · expires " + new Date(license.expires_at).toLocaleString() : ""}
      · Facility review: ${esc(gym.status)}. Review is separate from subscription status.</p>
      <a href="#/owner/start">Connect GymPOS</a> · <a href="#/owner/keys">Subscription & terminals</a></div>`;
  }).join("");
}

async function keys(root: HTMLElement, s: Session) {
  const token = viewToken;
  const load = async () => {
    const [{ data: gyms, error: gymError }, { data: licenses, error: licenseError }, { data: devices, error: deviceError }] = await Promise.all([
      db().from("gyms").select("id,name,status,disabled").order("name"),
      scope(db().from("current_subscriptions").select("gym_id,expires_at,revoked,is_trial,tier").order("created_at", { ascending: false }), s),
      db().from("terminals").select("id,gym_id,name,active,last_seen_at").order("last_seen_at", { ascending: false }),
    ]);
    if (token !== viewToken || !root.isConnected) return;
    if (gymError || licenseError || deviceError) {
      root.innerHTML = `<p class="pill bad">${esc((gymError || licenseError || deviceError)!.message)}</p>`; return;
    }
    root.innerHTML = `<h2>Subscription & connected terminals</h2>
      <p class="muted">CEO approval reviews your facility. A paid subscription starts only after the CEO records payment. Renewal is delivered automatically to connected GymPOS terminals.</p>
      ${subscriptionSummary(gyms ?? [], licenses ?? [])}
      <h3>Terminals</h3><table><thead><tr><th>Facility</th><th>Terminal</th><th>Last cloud contact</th><th>Access</th></tr></thead><tbody>
      ${(devices ?? []).map((device) => `<tr><td>${esc(gyms?.find((g) => g.id === device.gym_id)?.name || device.gym_id)}</td><td>${esc(device.name)}</td><td>${new Date(device.last_seen_at).toLocaleString()}</td><td>${device.active ? "Enabled" : "Revoked · contact CEO"}</td></tr>`).join("") || '<tr><td colspan="4">No terminals yet. Open GymPOS and sign in with your owner account.</td></tr>'}</tbody></table>
      <p class="muted">Expiry beyond the three-day grace blocks normal terminal operations. Reconnect online at least every seven days. Emergency/free exit remains independent. Contact the CEO to confirm payment or resolve a suspension.</p>`;
  };
  await load();
  pollVisible(() => token === viewToken && root.isConnected ? root : null, load, 30000);
}

async function gettingStarted(root: HTMLElement, s: Session) {
  const token = viewToken;
  const [{ data: gyms }, { data: devices }, { count: products }, { count: plans }, { count: staff }, { data: release }] = await Promise.all([
    db().from("gyms").select("id,name,status"),
    db().from("terminals").select("id").eq("active", true),
    scope(db().from("products").select("id", { count: "exact", head: true }), s),
    scope(db().from("plans").select("id", { count: "exact", head: true }), s),
    scope(db().from("staff").select("id", { count: "exact", head: true }).eq("active", true), s),
    db().from("releases").select("version,download_url").eq("channel", "stable").gt("rollout_pct", 0).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (token !== viewToken || !root.isConnected) return;
  const version = String(release?.version ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const accountReady = version && (version[0] > 3 || (version[0] === 3 && (version[1] > 0 || version[2] >= 4)));
  const download = accountReady && release?.download_url && /^https:\/\//.test(release.download_url) ? `<a href="${esc(release.download_url)}" rel="noopener" target="_blank">Download GymPOS ${esc(release.version)}</a>` : "The account-activation installer (3.0.4 or later) is not published yet. Contact the CEO for the tested GymPOS installer.";
  root.innerHTML = `<div class="page-head"><h2>Get started with your gym</h2></div>
    <div class="glass-panel panel"><h3>Setup checklist</h3>
      <ol style="line-height:2">
        <li>${gyms?.length ? "✓" : "○"} Facility registered: ${esc(gyms?.map((g) => g.name).join(", ") || "Finish gym setup")}. Trial starts after verified registration.</li>
        <li>${download}. Install on your Windows front-desk or gate terminal.</li>
        <li>${devices?.length ? "✓" : "○"} Open GymPOS → Sign in with SLS account → select your gym → name the terminal. No license key or cloud URL is needed.</li>
        <li>${products ? "✓" : "○"} <a href="#/owner/catalog">Add products</a> and stock. Prices are entered in pesos.</li>
        <li>${plans ? "✓" : "○"} <a href="#/owner/plans">Set up membership plans</a>.</li>
        <li>${staff ? "✓" : "○"} <a href="#/owner/staff">Create front-desk staff PINs</a>. These are separate from owner account credentials.</li>
        <li>In GymPOS, test camera/controller connectivity, register a test member, and verify one entry and one sale before opening to customers.</li>
      </ol></div>
    <div class="glass-panel panel"><h3>Accounts explained</h3>
      <p><strong>Owner:</strong> your dashboard and terminal-connection account. Keep its password private.</p>
      <p><strong>Manager:</strong> an assigned dashboard account with operational access. Managers cannot activate a terminal; the owner connects it first.</p>
      <p><strong>Staff PIN:</strong> identifies the front-desk operator on an already-connected terminal.</p>
      <p><strong>Gym member:</strong> a customer membership, not a dashboard login.</p>
      <h3>Trial, payment & recovery</h3><p>Your 14-day trial does not wait for CEO approval. CEO facility review and payment confirmation are separate. After payment is recorded, the 30-day subscription updates GymPOS automatically. An early paid renewal preserves remaining paid days.</p>
      <p>If blocked: open GymPOS Account & Help, check the selected facility, correct the computer clock, reconnect the internet, and refresh. Check <a href="#/owner/keys">Subscription & Terminals</a> for expiry or revocation. Password recovery and verification resend are on the sign-in page.</p>
      <p class="muted">Emergency/free exit is never dependent on a subscription. A hardware safety and release test is still required before using the system on a real door.</p></div>`;
}

async function catalog(root: HTMLElement, s: Session, token: number) {
  const gyms = await writableGyms(s);
  const canWrite = gyms.length > 0;
  root.innerHTML = `<div class="page-head"><h2>POS products & pricing</h2><span class="muted">pushes to terminals on sync</span></div>
  <div class="panel row" style="flex-wrap:wrap;gap:8px">
    <input id="q" placeholder="Search products…" style="min-width:160px" />
    ${gymSelectHtml(gyms, "gym")}
    <input id="n" placeholder="Product name" style="flex:1;min-width:140px" />
    <input id="p" type="number" step="0.01" min="0" placeholder="Price (₱)" style="width:120px" />
    <input id="stk" type="number" min="0" placeholder="Stock" style="width:90px" value="50" />
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>+ Add Product</button></div>
    <table><thead><tr><th>Name</th><th>Price (₱)</th><th>Stock Level</th><th>Status</th><th></th></tr></thead><tbody id="tb"></tbody></table>
    <p id="cat-msg" class="muted">${canWrite ? "Saves push to terminals on next sync pull. Low-stock triggers at ≤ 5 units." : "Read-only — no gym assigned to this account."}</p>`;

  const draw = async () => {
    const qEl = document.getElementById("q") as HTMLInputElement | null;
    const tb = document.getElementById("tb");
    if (token !== viewToken || !qEl || !tb) return;
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
      .map((p) => {
        const stock = Number(p.stock ?? 0);
        const isOos = stock <= 0;
        const isLow = stock <= 5 && !isOos;
        const badge = isOos
          ? `<span class="pill bad" style="font-size:11px">Out of stock (0)</span>`
          : isLow
          ? `<span class="pill bad" style="font-size:11px;background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.4)">⚠️ Low Stock (${stock} left)</span>`
          : `<span class="pill good" style="font-size:11px">${stock} in stock</span>`;

        return `<tr>
          <td><strong>${esc(p.name)}</strong></td>
          <td style="font-weight:700;color:var(--cyan)">${pesos(Number(p.price_cents))}</td>
          <td>${stock} units</td>
          <td>${badge}</td>
          <td><button data-del="${p.id}">Delete</button></td></tr>`;
      }).join("")
      || `<tr><td colspan="5" style="padding:0">${emptyState("Catalog is empty", "Add products above to push items to your POS terminals", "box")}</td></tr>`;
    root.querySelectorAll("[data-del]").forEach((b) =>
      (b as HTMLButtonElement).onclick = async () => {
        if (!await confirmModal({ title: "Delete product?", body: "Terminals drop it on next pull.", confirmLabel: "Delete", danger: true })) return;
        const ids = myGymIds(s);
        let del = db().from("products").delete().eq("id", (b as HTMLElement).dataset.del!);
        if (ids) del = del.in("gym_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
        const { error: delErr } = await del;
        if (delErr) {
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
    const pricePesos = parseFloat((document.getElementById("p") as HTMLInputElement).value || "0");
    const stockVal = parseInt((document.getElementById("stk") as HTMLInputElement).value || "0", 10);
    if (!canWrite || !gymId) { msg.textContent = "No gym selected — read-only account."; return; }
    if (!name) { msg.textContent = "Name required."; return; }
    if (isNaN(pricePesos) || pricePesos < 0) { msg.textContent = "Valid price in Pesos required."; return; }

    const { error } = await db().from("products").insert({
      gym_id: gymId,
      name,
      price_cents: Math.round(pricePesos * 100),
      stock: isNaN(stockVal) ? 0 : Math.max(0, stockVal),
    });
    if (error) { msg.textContent = `Add failed: ${error.message}`; msg.style.color = "#f87171"; return; }
    msg.textContent = "Added product.";
    msg.style.color = "#34d399";
    (document.getElementById("n") as HTMLInputElement).value = "";
    (document.getElementById("p") as HTMLInputElement).value = "";
    draw();
  };
  await draw();
}

async function plans(root: HTMLElement, s: Session, token: number) {
  const gyms = await writableGyms(s);
  const canWrite = gyms.length > 0;
  const { data } = await scope(db().from("plans").select("*").order("price_cents").limit(50), s, "gym_id");
  root.innerHTML = `<div class="page-head"><h2>Membership plans</h2><span class="muted">global templates + branch plans</span></div>
  <div class="panel row" style="flex-wrap:wrap;gap:8px">
    ${gymSelectHtml(gyms, "gym")}
    <input id="n" placeholder="Plan name" style="flex:1;min-width:140px" />
    <input id="p" type="number" step="0.01" min="0" placeholder="Price (₱)" style="width:120px" />
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
    const pricePesos = parseFloat((document.getElementById("p") as HTMLInputElement).value || "0");
    if (!canWrite || !gymId) { msg.textContent = "No gym selected — read-only account."; return; }
    if (!name) { msg.textContent = "Plan name required."; return; }
    if (isNaN(pricePesos) || pricePesos < 0) { msg.textContent = "Valid price in Pesos required."; return; }

    const { error } = await db().from("plans").insert({
      gym_id: gymId,
      name,
      price_cents: Math.round(pricePesos * 100),
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
    <input id="pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="6-12 digit PIN" maxlength="12" style="width:120px" />
    <select id="staff-role" aria-label="Terminal role"><option value="staff">Cashier / front desk</option><option value="manager">Terminal manager (manual entry & settings)</option></select>
    <button class="primary" id="add" ${canWrite ? "" : "disabled"}>Save credential</button></div>
    <p id="staff-msg" class="muted">${canWrite ? "" : "Read-only — staff credentials need a gym assigned to this account."}</p>
    <table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>
    ${(data ?? []).map((x) => `<tr><td>${esc(x.full_name)}</td><td>${esc(x.username)}</td><td>${esc(x.role)}</td><td>${x.active ? "yes" : "no"}</td><td>${canWrite ? `<button data-staff="${esc(x.id)}" data-active="${x.active}">${x.active ? "Deactivate" : "Reactivate"}</button>` : "Read-only"}</td></tr>`).join("")}
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
        role: (document.getElementById("staff-role") as HTMLSelectElement).value,
      }),
    });
    if (!res.ok) { msg.textContent = await res.text(); msg.style.color = "#f87171"; return; }
    if (shell) renderOwner(shell, "/staff", s);
  };
  root.querySelectorAll<HTMLButtonElement>("[data-staff]").forEach(button => button.onclick = async () => {
    button.disabled=true;
    const {error}=await db().from("staff").update({active:button.dataset.active!=="true"}).eq("id",button.dataset.staff!);
    if(error) { document.getElementById("staff-msg")!.textContent=error.message;button.disabled=false;return; }
    if(shell) void renderOwner(shell,"/staff",s);
  });
}
