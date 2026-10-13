// Local dashboard — recent sales, pending sync, license status.
import { cents } from "./pos.js";

const invoke = window.__TAURI__?.core?.invoke;
let timer;

const PREVIEW_SALES = [
  { created_at: "Today 14:22:15", pay_method: "Cash", total_cents: 8000 },
  { created_at: "Today 12:45:00", pay_method: "Cash", total_cents: 195000 },
  { created_at: "Today 11:10:42", pay_method: "Cash", total_cents: 280000 },
  { created_at: "Today 09:30:18", pay_method: "Cash", total_cents: 75000 },
];

export async function initDash() {
  const root = document.getElementById("view-dash");
  if (!root || root.dataset.bound) {
    await refresh();
    return;
  }
  root.dataset.bound = "1";
  root.innerHTML = `
    <div class="page-head">
      <h2>Terminal Operations Dashboard</h2>
      <span class="muted">Local SQLite · Real-time Offline Cache</span>
    </div>
    <div id="dash-stats" class="cards" style="margin-bottom:16px"></div>
    <div class="glass panel">
      <h3 style="margin:0 0 12px;font-size:1.15rem;color:var(--cyan);letter-spacing:1px">RECENT LOCAL TRANSACTIONS</h3>
      <div id="dash-sales"></div>
      <p class="hint" style="margin-top:12px">Cloud totals sync upstream to the Central Web Command Deck when network connectivity is established.</p>
    </div>`;
  await refresh();
  // Light poll while visible
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, 15000);
}

async function refresh() {
  if (!window.__sls_operable || document.getElementById("view-dash")?.hidden) return;
  const stats = document.getElementById("dash-stats");
  const salesEl = document.getElementById("dash-sales");
  if (!stats) return;

  try {
    let status, pending, sales, summary, account;
    if (invoke) {
      [status, pending, sales,summary,account] = await Promise.all([
        invoke("license_status"),
        invoke("sync_pending"),
        invoke("sale_list", { limit: 20 }),
        invoke("sales_summary"),invoke("account_status"),
      ]);
    } else {
      throw new Error("Open GymPOS desktop; a browser preview is not an operational terminal.");
    }

    const type = String(status?.type ?? "unknown").toLowerCase();
    const tone = type === "valid" ? "badge-ultra" : type === "graceperiod" ? "warn" : "bad";
    let label = type === "valid" ? `${status.tier?.toUpperCase() || "ACTIVE"}` : type === "graceperiod" ? "GRACE PERIOD" : type.toUpperCase();
    if (type === "valid" && status?.days_remaining !== undefined) {
      label = `${status.tier?.toUpperCase() || "ACTIVE"} (${status.days_remaining}d remaining)`;
    } else if (type === "graceperiod" && status?.grace_days_remaining !== undefined) {
      label = `⚠️ GRACE PERIOD (${status.grace_days_remaining}d left)`;
    } else if (type === "expired") {
      label = "❌ EXPIRED (LOCKED)";
    }
    const todayTotal=summary.total_cents;

    stats.innerHTML =
      `<div class="card" style="display:flex;flex-direction:column;gap:6px">` +
      `<span class="hint" style="text-transform:uppercase;letter-spacing:1px;font-size:11px">Hunter Guild License</span>` +
      `<div><span class="badge ${tone}">${label}</span></div>` +
      `<span class="hint" style="font-size:11px">${esc(status?.gym_name || "SLS Terminal Node")}</span>` +
      `</div>` +
      `<div class="card" style="display:flex;flex-direction:column;gap:6px">` +
      `<span class="hint" style="text-transform:uppercase;letter-spacing:1px;font-size:11px">Outbox Sync Queue</span>` +
      `<div style="font-family:Rajdhani,sans-serif;font-size:1.6rem;font-weight:700;color:var(--cyan)">${pending} <span style="font-size:0.9rem;font-weight:400;color:var(--muted)">pending</span></div>` +
      `<span class="hint" style="font-size:11px">${account.online ? "Account verified online" : "Offline / verification pending"}</span>` +
      `</div>` +
      `<div class="card" style="display:flex;flex-direction:column;gap:6px">` +
      `<span class="hint" style="text-transform:uppercase;letter-spacing:1px;font-size:11px">Sales Register Today</span>` +
      `<div style="font-family:Rajdhani,sans-serif;font-size:1.6rem;font-weight:700;color:#34d399">${cents(todayTotal)}</div>` +
      `<span class="hint" style="font-size:11px">${summary.transactions} local sales · Asia/Manila · all rows, not just recent 20</span>` +
      `</div>`;

    salesEl.innerHTML = (sales ?? []).length
      ? `<table><thead><tr><th>Timestamp</th><th>Tender Method</th><th>Amount</th><th>Status</th></tr></thead><tbody>` +
        (sales ?? [])
          .map(
            (s) =>
              `<tr>` +
              `<td class="hint">${esc(s.created_at)}</td>` +
              `<td><span class="badge" style="background:rgba(139,92,246,0.15);border-color:rgba(139,92,246,0.4);color:#d8b4fe">${esc(s.pay_method)}</span></td>` +
              `<td style="font-family:Rajdhani,sans-serif;font-size:1.1rem;font-weight:700;color:var(--cyan)">${cents(s.total_cents)}</td>` +
              `<td><span class="badge ${s.pending ? "warn" : "good"}">${s.pending ? "Pending upload" : "Uploaded"}</span></td>` +
              `</tr>`,
          )
          .join("") +
        `</tbody></table>`
      : `<p class="muted hint">No transactions logged yet.</p>`;
  } catch (e) {
    stats.textContent = String(e);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

