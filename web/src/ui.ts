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
