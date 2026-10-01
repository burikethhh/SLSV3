// Tiny UI helpers: tables, confirm modal, key masking, debounce.
export function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function maskKey(token: string): string {
  if (token.length <= 18) return "••••";
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}

/** Escape user-controlled text before injecting into innerHTML (stored-XSS guard). */
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"'`]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;",
  })[c]!);
}

export function confirmModal(opts: { title: string; body: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root")!;
    root.innerHTML = "";
    const back = el(`<div class="modal-back"><div class="modal">
      <h3>${opts.title}</h3><p class="muted">${opts.body}</p>
      <div class="row"><button id="m-ok" class="${opts.danger ? "danger" : "primary"}">${opts.confirmLabel}</button>
      <button id="m-cancel">Cancel</button></div></div></div>`);
    root.appendChild(back);
    // Escape/backdrop must resolve too — otherwise the Promise hangs forever.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); };
    const done = (v: boolean) => {
      document.removeEventListener("keydown", onKey);
      root.innerHTML = "";
      resolve(v);
    };
    document.addEventListener("keydown", onKey);
    back.addEventListener("click", (e) => { if (e.target === back) done(false); });
    back.querySelector("#m-ok")!.addEventListener("click", () => done(true));
    back.querySelector("#m-cancel")!.addEventListener("click", () => done(false));
  });
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms = 150): T {
  let t: ReturnType<typeof setTimeout>;
  return ((...a: never[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

/** Poll `fn` every `ms` ONLY while the document tab is visible + element exists.
 *  Returns a cleanup fn that also detaches the visibility listener (no leaks
 *  across route changes). Dashboards use this instead of unconditional 60s timers
 *  (idle tabs don't hammer Supabase; see dashboard plan §6). */
export function pollVisible(el: () => HTMLElement | null, fn: () => void | Promise<void>, ms = 60000): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let dead = false;
  const stop = () => {
    dead = true;
    if (timer) { clearInterval(timer); timer = null; }
    document.removeEventListener("visibilitychange", onVis);
  };
  const start = () => {
    if (!dead && !timer && !document.hidden && el()) timer = setInterval(tick, ms);
  };
  const tick = () => {
    if (document.hidden || !el()) return stop();
    void fn();
  };
  const onVis = () => { document.hidden ? (timer && (clearInterval(timer), (timer = null))) : start(); };
  document.addEventListener("visibilitychange", onVis);
  start();
  return stop;
}

export function pesos(cents: number): string {
  return `₱${(cents / 100).toFixed(2)}`;
}

// ── Recycled v2 portal visuals: heroicon chips + glass stat cards ──
const ICONS: Record<string, string> = {
  gym: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>',
  money: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  users: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/>',
  key: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>',
  chart: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>',
  zap: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>',
  shield: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>',
  box: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>',
  tag: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5.586a1 1 0 01.707.293l7.414 7.414a1 1 0 010 1.414l-5.414 5.414a1 1 0 01-1.414 0l-7.414-7.414A1 1 0 013 10V4a1 1 0 011-1z"/>',
  clock: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  grid: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/>',
  send: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 12L3.269 3.125A59.769 59.769 0 0121.485 12 59.768 59.768 0 013.27 20.875L5.999 12zm0 0h7.5"/>',
};

export function icon(name: string): string {
  const p = ICONS[name] ?? ICONS.box;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${p}</svg>`;
}

/** Glass stat card: label row + icon chip, big Rajdhani value, caption. */
export function stat(label: string, value: string, tone: string, iconName: string, caption = ""): string {
  return `<div class="glass-panel card stat">
    <div class="stat-top"><span class="stat-k">${label}</span>
    <span class="icon-box tone-${tone}">${icon(iconName)}</span></div>
    <div class="stat-v txt-${tone}">${value}</div>
    ${caption ? `<div class="stat-cap">${caption}</div>` : ""}</div>`;
}

/** Navigation card: icon + title + caption + live value + arrow. Whole card links. */
export function navcard(href: string, iconName: string, tone: string, title: string, desc: string, value: string): string {
  return `<a class="navcard glass-panel" href="${href}">
    <span class="icon-box tone-${tone}">${icon(iconName)}</span>
    <span class="navcard-body"><span class="navcard-t">${title}</span><span class="muted">${desc}</span></span>
    <span class="navcard-v txt-${tone}">${value}</span>
    <span class="navcard-arrow">→</span></a>`;
}

/** Tier pill in the v2 portal badge language (basic=C blue, pro=A violet, ultra=S gold aura). */
export function tierBadge(tier: string | null | undefined): string {
  const t = (tier ?? "").toLowerCase();
  if (t === "basic") return `<span class="stat-badge badge-basic" title="Rank C">C · basic</span>`;
  if (t === "pro") return `<span class="stat-badge badge-pro" title="Rank A">A · pro</span>`;
  if (t === "ultra") return `<span class="stat-badge badge-ultra" title="Rank S">S · ultra</span>`;
  return "—";
}

/** Empty state art: stylized Solo Leveling System window placeholder */
export function emptyState(title: string, sub: string, iconName = "shield"): string {
  return `<div class="empty-state glass-panel">
    <div class="empty-rune-circle" aria-hidden="true">
      <div class="empty-icon tone-violet">${icon(iconName)}</div>
    </div>
    <div class="empty-title">${title}</div>
    <div class="empty-sub muted">${sub}</div>
  </div>`;
}

/** Chart.js is an optional CDN script — render only when it loaded. */
declare global {
  interface Window { Chart?: {
    new (ctx: CanvasRenderingContext2D, cfg: unknown): { destroy(): void };
  } }
}
