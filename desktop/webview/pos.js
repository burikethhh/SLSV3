// POS view — debounced search (150ms), capped render (50 rows), cents display.
// Cart + checkout wired to Rust `pos_checkout` (SQLite + outbox enqueue).
const invoke = window.__TAURI__?.core?.invoke;
if (!invoke) console.warn("Tauri invoke unavailable — run inside the desktop shell");

let timer;
const cart = new Map(); // id -> {name, unit_cents, qty}

export function initPos() {
  const input = document.getElementById("pos-search");
  const grid = document.getElementById("pos-grid");
  if (!input || input.dataset.bound) return;
  input.dataset.bound = "1";
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!invoke) { grid.textContent = "Tauri shell not detected"; return; }
      try {
        const rows = await invoke("product_search", { q: input.value });
        grid.innerHTML = rows.length
          ? rows
              .map(
                (r) =>
                  `<button class="tile" data-id="${r.id}" data-name="${esc(r.name)}" data-price="${r.price_cents}">` +
                  `<span>${esc(r.name)}</span><span>${cents(r.price_cents)}${r.stock > 0 ? "" : " · OOS"}</span></button>`,
              )
              .join("")
          : `<p class="muted">No products match.</p>`;
        grid.querySelectorAll(".tile").forEach((t) =>
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

function renderCart() {
  const el = document.getElementById("pos-cart");
  if (!el) return;
  const lines = [...cart.entries()].map(([id, l]) => ({ product_id: id, ...l, discount_cents: 0 }));
  const total = lines.reduce((a, l) => a + l.unit_cents * l.qty - l.discount_cents, 0);
  el.innerHTML =
    (lines.length
      ? lines.map((l) => `<div class="row"><span>${esc(l.name)} ×${l.qty}</span><span>${cents(l.unit_cents * l.qty)}</span></div>`).join("")
      : `<p class="muted">Cart empty — tap a product.</p>`) +
    `<div class="row total"><span>Total</span><span>${cents(total)}</span></div>` +
    `<button id="pos-pay">Pay cash</button>`;
  document.getElementById("pos-pay")?.addEventListener("click", async () => {
    if (!invoke) return alert("Tauri shell not detected");
    try {
      const [totalCents] = await invoke("pos_checkout", {
        lines,
        tenderedCents: total, // exact tender; UI can add tendered input later
        method: "cash",
      });
      cart.clear();
      renderCart();
      alert(`Paid ${cents(totalCents)} · change ${cents(total - totalCents)}`);
    } catch (e) {
      alert(String(e));
    }
  });
}

export function cents(n) {
  return `₱${(n / 100).toFixed(2)}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
