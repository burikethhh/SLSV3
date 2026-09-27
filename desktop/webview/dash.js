// Local dashboard — recent sales, pending sync, license status.
import { cents } from "./pos.js";

const invoke = window.__TAURI__?.core?.invoke;
let timer;

export async function initDash() {
  const root = document.getElementById("view-dash");
  if (!root || root.dataset.bound) {
    await refresh();
    return;
  }
  root.dataset.bound = "1";
  root.innerHTML = `
    <h2>Dashboard (local terminal)</h2>
    <div id="dash-stats" class="hint" style="display:flex;gap:24px;margin-bottom:16px"></div>
    <h3>Recent sales</h3>
    <div id="dash-sales"></div>
    <p class="hint">Cloud totals live on the web dashboard once sync is active (Settings → Apply license).</p>`;
  await refresh();
  // Light poll while visible
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, 15000);
}

async function refresh() {
  const stats = document.getElementById("dash-stats");
  const salesEl = document.getElementById("dash-sales");
  if (!stats || !invoke) return;
  try {
    const [status, pending, sales] = await Promise.all([
      invoke("license_status"),
      invoke("sync_pending"),
      invoke("sale_list", { limit: 20 }),
    ]);
    const type = String(status?.type ?? "unknown").toLowerCase();
    const color = type === "valid" ? "#3ddc97" : type === "graceperiod" ? "#ffd166" : "#ff6b6b";
    const label = type === "graceperiod" ? "grace" : type;
    const today = (sales ?? []).filter((s) => s.created_at?.startsWith(new Date().toISOString().slice(0, 10)));
    const todayTotal = today.reduce((a, s) => a + s.total_cents, 0);
    stats.innerHTML =
      `<div>License <strong style="color:${color}">${label}</strong></div>` +
      `<div>Pending sync <strong>${pending}</strong></div>` +
      `<div>Sales today <strong>${cents(todayTotal)}</strong> (${today.length})</div>`;

    salesEl.innerHTML = (sales ?? []).length
      ? `<table><thead><tr><th>When</th><th>Method</th><th>Total</th></tr></thead><tbody>` +
        (sales ?? [])
          .map(
            (s) =>
              `<tr><td class="hint">${esc(s.created_at)}</td><td>${esc(s.pay_method)}</td><td>${cents(s.total_cents)}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`
      : `<p class="muted hint">No sales yet.</p>`;
  } catch (e) {
    stats.textContent = String(e);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
