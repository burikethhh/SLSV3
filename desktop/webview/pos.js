// POS view — debounced search (150ms), capped render (50 rows), cents display.
// Cart + checkout wired to Rust `pos_checkout` (SQLite + outbox enqueue).
const invoke = window.__TAURI__?.core?.invoke;
if (!invoke) console.warn("Tauri invoke unavailable — running in preview mode");

let timer;
const cart = new Map(); // id -> {name, unit_cents, qty}

const PREVIEW_PRODUCTS = [
  { id: "prod-1", name: "Mana Recovery Water (500ml)", price_cents: 8000, stock: 42 },
  { id: "prod-2", name: "Hunter Whey Isolate (2lb Double Dutch)", price_cents: 280000, stock: 8 },
  { id: "prod-3", name: "Shadow Pre-Workout Surge", price_cents: 195000, stock: 3 },
  { id: "prod-4", name: "SLS Lifting Straps & Wrist Wraps", price_cents: 75000, stock: 15 },
  { id: "prod-5", name: "Monarch Stainless Shaker Flask", price_cents: 120000, stock: 0 },
  { id: "prod-6", name: "Single Gate Entry Pass", price_cents: 35000, stock: 999 },
];

export function initPos() {
  const input = document.getElementById("pos-search");
  const grid = document.getElementById("pos-grid");
  if (!input || input.dataset.bound) return;
  input.dataset.bound = "1";

  // In preview mode, add a sample item to the cart so it renders nicely
  if (!invoke && cart.size === 0) {
    cart.set("prod-1", { name: "Mana Recovery Water (500ml)", unit_cents: 8000, qty: 2 });
    renderCart();
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        let rows = [];
        if (invoke) {
          rows = await invoke("product_search", { q: input.value });
        } else {
          const q = (input.value || "").toLowerCase().trim();
          rows = PREVIEW_PRODUCTS.filter((p) => !q || p.name.toLowerCase().includes(q));
        }

        grid.innerHTML = rows.length
          ? rows
              .map((r) => {
                const stockBadge =
                  r.stock <= 0
                    ? `<span class="stock-badge oos">Out of Stock</span>`
                    : r.stock <= 5
                    ? `<span class="stock-badge low">${r.stock} Left</span>`
                    : `<span class="stock-badge instock">${r.stock} in Stock</span>`;
                const isDisabled = r.stock <= 0;
                return (
                  `<button class="tile${isDisabled ? " disabled" : ""}" data-id="${r.id}" data-name="${esc(r.name)}" data-price="${r.price_cents}" ${isDisabled ? "disabled" : ""}>` +
                  `<div class="tile-top"><span class="tile-category">Item</span>${stockBadge}</div>` +
                  `<span class="tile-name">${esc(r.name)}</span>` +
                  `<div class="tile-bottom">` +
                  `<span class="tile-price">${cents(r.price_cents)}</span>` +
                  `<span class="tile-action">${isDisabled ? "OOS" : "+ Add"}</span>` +
                  `</div></button>`
                );
              })
              .join("")
          : `<p class="muted">No products match search criteria.</p>`;

        grid.querySelectorAll(".tile:not(.disabled)").forEach((t) =>
          t.addEventListener("click", () => {
            addToCart(t.dataset.id, t.dataset.name, Number(t.dataset.price));
          }),
        );
      } catch (e) {
        grid.textContent = String(e);
      }
    }, 150);
  });
  input.dispatchEvent(new Event("input"));
}

function addToCart(id, name, price) {
  const line = cart.get(id) || { name, unit_cents: price, qty: 0 };
  line.qty += 1;
  cart.set(id, line);
  renderCart();
}

function changeQty(id, delta) {
  const line = cart.get(id);
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) {
    cart.delete(id);
  } else {
    cart.set(id, line);
  }
  renderCart();
}

let selectedMethod = "cash";
let cashTenderedVal = null;

function renderCart() {
  const el = document.getElementById("pos-cart");
  if (!el) return;
  const lines = [...cart.entries()].map(([id, l]) => ({ product_id: id, ...l, discount_cents: 0 }));
  const total = lines.reduce((a, l) => a + l.unit_cents * l.qty - l.discount_cents, 0);

  const itemsHtml = lines.length
    ? `<div class="cart-items">` +
      lines
        .map(
          (l) =>
            `<div class="cart-row">` +
            `<div><div class="cart-item-name">${esc(l.name)}</div><div class="cart-item-unit">${cents(l.unit_cents)} ea</div></div>` +
            `<div class="cart-qty-ctrl">` +
            `<button type="button" class="qty-btn" data-action="dec" data-id="${l.product_id}">−</button>` +
            `<span class="qty-val">${l.qty}</span>` +
            `<button type="button" class="qty-btn" data-action="inc" data-id="${l.product_id}">+</button>` +
            `</div>` +
            `<span class="cart-price">${cents(l.unit_cents * l.qty)}</span>` +
            `</div>`,
        )
        .join("") +
      `</div>`
    : `<p class="muted">Cart empty — tap a product to add.</p>`;

  const methodsHtml = `
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-top:10px">Payment Tender</div>
    <div class="pay-methods">
      <button type="button" class="pay-btn ${selectedMethod === "cash" ? "active" : ""}" data-method="cash">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2"></circle><path d="M6 12h.01M18 12h.01"></path></svg>
        <span>Cash</span>
      </button>
      <button type="button" class="pay-btn ${selectedMethod === "gcash" ? "active" : ""}" data-method="gcash">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
        <span>GCash</span>
      </button>
      <button type="button" class="pay-btn ${selectedMethod === "card" ? "active" : ""}" data-method="card">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>
        <span>Card</span>
      </button>
    </div>`;

  let cashTenderedCents = total;
  if (cashTenderedVal !== null) {
    const parsed = Math.round(Number(cashTenderedVal) * 100);
    cashTenderedCents = isNaN(parsed) ? 0 : parsed;
  }
  const isCash = selectedMethod === "cash";
  const changeDueCents = isCash ? cashTenderedCents - total : 0;
  const isInsufficient = isCash && lines.length > 0 && cashTenderedCents < total;

  let cashBoxHtml = "";
  if (isCash && lines.length > 0) {
    const quickBills = [50, 100, 200, 500, 1000].filter((b) => b * 100 >= total).slice(0, 4);
    cashBoxHtml = `
      <div class="pos-cash-box">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:600">
          <span>Cash Tendered</span>
          <span style="color:#94a3b8">Total: ${cents(total)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
          <span style="font-weight:700;color:var(--cyan);font-size:16px">₱</span>
          <input id="pos-cash-input" type="number" step="any" min="0" value="${cashTenderedVal !== null ? cashTenderedVal : (total > 0 ? (total / 100).toFixed(2) : '')}" style="flex:1;padding:6px 10px;font-size:15px;font-weight:700;color:#fff" placeholder="${(total / 100).toFixed(2)}" />
        </div>
        <div class="pos-quick-bills">
          <button type="button" class="quick-bill-btn" data-bill="exact">Exact (${cents(total)})</button>
          ${quickBills.map((b) => `<button type="button" class="quick-bill-btn" data-bill="${b}">₱${b}</button>`).join("")}
        </div>
        <div class="change-due-row">
          <span style="color:var(--muted)">Change Due:</span>
          <span id="pos-change-display" class="change-due-val ${changeDueCents < 0 ? "insufficient" : ""}">${changeDueCents >= 0 ? cents(changeDueCents) : `Short ${cents(-changeDueCents)}`}</span>
        </div>
      </div>`;
  }

  el.innerHTML =
    `<div class="cart-title"><span>CURRENT CART</span><span class="muted" style="font-size:12px">${lines.length} items</span></div>` +
    itemsHtml +
    methodsHtml +
    cashBoxHtml +
    `<div class="row total"><span>Total Due</span><span>${cents(total)}</span></div>` +
    `<div class="cart-actions">` +
    `<button id="pos-pay" style="flex:1;margin-top:0" ${lines.length === 0 || isInsufficient ? "disabled" : ""}>${isInsufficient ? `Insufficient Cash (${cents(total)})` : `Pay ${selectedMethod.toUpperCase()} (${cents(total)})`}</button>` +
    (lines.length ? `<button type="button" id="pos-clear-cart" class="btn-clear-cart" title="Clear all items in cart">Clear</button>` : "") +
    `</div>`;

  el.querySelectorAll(".qty-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const delta = b.dataset.action === "inc" ? 1 : -1;
      changeQty(b.dataset.id, delta);
    });
  });

  el.querySelectorAll(".pay-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedMethod = btn.dataset.method;
      renderCart();
    });
  });

  const cashInput = el.querySelector("#pos-cash-input");
  if (cashInput) {
    cashInput.addEventListener("input", (e) => {
      cashTenderedVal = e.target.value;
      const parsed = Math.round(Number(cashTenderedVal) * 100);
      const tendered = isNaN(parsed) ? 0 : parsed;
      const diff = tendered - total;
      const changeEl = document.getElementById("pos-change-display");
      const payBtn = document.getElementById("pos-pay");
      if (changeEl) {
        changeEl.textContent = diff >= 0 ? cents(diff) : `Short ${cents(-diff)}`;
        changeEl.className = `change-due-val ${diff < 0 ? "insufficient" : ""}`;
      }
      if (payBtn) {
        if (diff < 0) {
          payBtn.disabled = true;
          payBtn.textContent = `Insufficient Cash (${cents(total)})`;
        } else {
          payBtn.disabled = lines.length === 0;
          payBtn.textContent = `Pay CASH (${cents(total)})`;
        }
      }
    });
  }

  el.querySelectorAll(".quick-bill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const bill = btn.dataset.bill;
      if (bill === "exact") {
        cashTenderedVal = (total / 100).toFixed(2);
      } else {
        cashTenderedVal = Number(bill).toFixed(2);
      }
      renderCart();
      document.getElementById("pos-cash-input")?.focus();
    });
  });

  document.getElementById("pos-clear-cart")?.addEventListener("click", () => {
    cashTenderedVal = null;
    cart.clear();
    renderCart();
  });

  document.getElementById("pos-pay")?.addEventListener("click", async () => {
    if (!lines.length) return;
    const linesSnapshot = lines.map((l) => ({ ...l }));
    const totalDue = total;
    const finalTenderedCents = selectedMethod === "cash"
      ? (cashTenderedVal !== null ? Math.round(Number(cashTenderedVal) * 100) : totalDue)
      : totalDue;
    if (selectedMethod === "cash" && finalTenderedCents < totalDue) {
      alert("Insufficient cash tendered.");
      return;
    }
    let totalCents = totalDue;
    let changeCents = Math.max(0, finalTenderedCents - totalDue);
    const txnId = "SLS-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase();

    if (!invoke) {
      playSaleSuccessChime();
      showReceiptModal({
        lines: linesSnapshot,
        totalCents,
        tenderedCents: finalTenderedCents,
        changeCents,
        method: selectedMethod,
        txnId,
      });
      cashTenderedVal = null;
      cart.clear();
      renderCart();
      return;
    }

    try {
      const res = await invoke("pos_checkout", {
        lines,
        tendered_cents: finalTenderedCents,
        method: selectedMethod,
      });
      if (Array.isArray(res)) {
        totalCents = res[0];
        changeCents = res[1];
      }
      playSaleSuccessChime();
      showReceiptModal({
        lines: linesSnapshot,
        totalCents,
        tenderedCents: finalTenderedCents,
        changeCents,
        method: selectedMethod,
        txnId,
      });
      cashTenderedVal = null;
      cart.clear();
      renderCart();
    } catch (e) {
      alert("Checkout error: " + String(e));
    }
  });

  setupReceiptModal();
}

let receiptModalInitialized = false;

function setupReceiptModal() {
  if (receiptModalInitialized) return;
  receiptModalInitialized = true;

  const modal = document.getElementById("pos-receipt-modal");
  const closeBtn = document.getElementById("receipt-close-btn");
  const doneBtn = document.getElementById("receipt-done-btn");
  const printBtn = document.getElementById("receipt-print-btn");

  const hide = () => {
    if (modal) modal.style.display = "none";
    document.getElementById("pos-search")?.focus();
  };

  closeBtn?.addEventListener("click", hide);
  doneBtn?.addEventListener("click", hide);
  printBtn?.addEventListener("click", () => {
    window.print();
  });

  modal?.addEventListener("click", (e) => {
    if (e.target === modal) hide();
  });

  window.addEventListener("keydown", (e) => {
    if (modal && modal.style.display !== "none") {
      if (e.key === "Escape") {
        hide();
      }
    }
  });
}

function showReceiptModal({ lines, totalCents, tenderedCents, changeCents, method, txnId }) {
  const modal = document.getElementById("pos-receipt-modal");
  const paper = document.getElementById("pos-receipt-paper");
  if (!modal || !paper) return;

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const vatAmt = Math.round(totalCents - totalCents / 1.12);

  const itemRowsHtml = lines
    .map((l) => {
      const lineTotal = l.unit_cents * l.qty - (l.discount_cents || 0);
      return (
        `<div class="receipt-item-row">` +
        `<div class="receipt-item-desc">` +
        `<div>${esc(l.name)}</div>` +
        `<div style="font-size:10px;color:#64748b">${l.qty} × ${cents(l.unit_cents)}</div>` +
        `</div>` +
        `<div class="receipt-item-amt">${cents(lineTotal)}</div>` +
        `</div>`
      );
    })
    .join("");

  paper.innerHTML = `
    <div class="receipt-brand-title">SOLO LEVELING SYSTEM</div>
    <div class="receipt-brand-sub">HUNTER ASSOCIATION DISPENSARY &amp; POS<br>GATE TERMINAL 01 · OFFICIAL RECEIPT</div>
    <div class="receipt-divider"></div>
    <div class="receipt-meta-row"><span>DATE: ${dateStr}</span><span>TIME: ${timeStr}</span></div>
    <div class="receipt-meta-row"><span>TXN REF:</span><span style="font-weight:700">${txnId}</span></div>
    <div class="receipt-meta-row"><span>PAYMENT METHOD:</span><span>${method.toUpperCase()}</span></div>
    <div class="receipt-divider"></div>
    <div class="receipt-items-head">
      <span>ITEM / QTY</span>
      <span>TOTAL</span>
    </div>
    ${itemRowsHtml}
    <div class="receipt-divider"></div>
    <div class="receipt-meta-row"><span>SUBTOTAL</span><span>${cents(totalCents)}</span></div>
    <div class="receipt-meta-row"><span>VAT (12% INCLUDED)</span><span>${cents(vatAmt)}</span></div>
    <div class="receipt-total-row"><span>TOTAL AMOUNT DUE</span><span>${cents(totalCents)}</span></div>
    <div class="receipt-tender-row"><span>TENDERED (${method.toUpperCase()})</span><span>${cents(tenderedCents)}</span></div>
    <div class="receipt-change-row"><span>CHANGE DUE</span><span>${cents(changeCents)}</span></div>
    <div class="receipt-divider"></div>
    <div class="receipt-barcode">
      ${generateBarcodeSvg(txnId)}
      <span class="receipt-barcode-txt">*${txnId}*</span>
    </div>
    <div class="receipt-footer-msg">
      Thank you for powering up with SLS.<br>
      Items valid for hunter inventory &amp; vault intake.<br>
      Keep receipt for gate warranty claims.
    </div>
  `;

  modal.style.display = "flex";
}

function generateBarcodeSvg(code) {
  const bars = [2, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 1, 2, 2, 1, 1, 3, 2, 1, 2, 1, 1, 3, 1, 2, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1];
  let x = 10;
  let rects = "";
  for (let i = 0; i < bars.length; i++) {
    const w = bars[i];
    if (i % 2 === 0) {
      rects += `<rect x="${x}" y="0" width="${w * 1.5}" height="30" fill="#0f172a" />`;
    }
    x += w * 1.5;
  }
  return `<svg viewBox="0 0 ${x + 10} 30" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:240px;height:30px">${rects}</svg>`;
}

function playSaleSuccessChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);
      gain.gain.setValueAtTime(0.18, now + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.3);
    });
  } catch (e) {
    // AudioContext blocked or unsupported, fail silently
  }
}

export function cents(n) {
  return `₱${(n / 100).toFixed(2)}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}


