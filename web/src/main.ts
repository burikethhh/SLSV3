// Hash router + RBAC guards. Code-split: ceo/owner bundles lazy-load.
import { session, requireRole, roleOf, signIn, signUpOwner, signOut } from "./auth";
import { icon } from "./ui";

const view = () => document.getElementById("view")!;
const nav = () => document.getElementById("nav")!;
const layout = () => document.getElementById("layout")!;

function navFor(role: string | null): [string, string, string][] {
  if (role === "ceo") return [["#/ceo", "Overview", "grid"], ["#/ceo/fleet", "Fleet", "gym"], ["#/ceo/keys", "Key Vault", "key"], ["#/ceo/users", "Users", "users"], ["#/ceo/releases", "Releases", "send"], ["#/ceo/audit", "Audit", "clock"]];
  if (role === "owner" || role === "manager") return [["#/owner", "Overview", "chart"], ["#/owner/catalog", "Catalog", "box"], ["#/owner/plans", "Plans", "money"], ["#/owner/promos", "Promos", "tag"], ["#/owner/txns", "Live feed", "zap"], ["#/owner/staff", "Staff", "users"], ["#/owner/keys", "Keys", "key"]];
  return [];
}

/** Root tabs (#/ceo, #/owner) are active only on exact match; children match their own prefix. */
function isActive(href: string, hash: string): boolean {
  if (hash === href) return true;
  if (href === "#/ceo" || href === "#/owner") return false;
  return hash.startsWith(href + "/");
}

function closeDrawer() {
  layout().classList.remove("open");
}

const homeFor = (role: string | null) => (role === "ceo" ? "#/ceo" : "#/owner");

/** Set hash and render — but render directly when the hash is already there
 *  (no hashchange fires → stale view). Replaces the old set-hash-then-call-
 *  route() pattern that rendered every route twice. */
function go(hash: string) {
  if (location.hash === hash) void route();
  else location.hash = hash;
}

function startProgress() {
  const p = document.getElementById("top-progress");
  if (p) {
    p.classList.remove("done");
    p.hidden = false;
  }
}

function stopProgress() {
  const p = document.getElementById("top-progress");
  if (p) {
    p.classList.add("done");
    setTimeout(() => {
      if (p.classList.contains("done")) p.hidden = true;
    }, 280);
  }
}

async function renderRouteCore() {
  const s = await session();
  const role = s ? roleOf(s) : null;
  document.getElementById("logout")!.hidden = !s;
  const ub = document.getElementById("user-badge");
  if (ub) {
    ub.hidden = !s;
    const rb = document.getElementById("user-role-badge");
    if (rb) {
      if (role === "ceo") { rb.textContent = "S · CEO"; rb.className = "stat-badge badge-ultra"; }
      else if (role === "owner") { rb.textContent = "A · OWNER"; rb.className = "stat-badge badge-pro"; }
      else if (role === "manager") { rb.textContent = "B · MANAGER"; rb.className = "stat-badge badge-basic"; }
      else { rb.textContent = "C · BASIC"; rb.className = "stat-badge badge-basic"; }
    }
  }
  document.getElementById("modal-root")!.innerHTML = ""; // no orphan modals across routes
  nav().innerHTML = "";
  document.getElementById("sidebar")!.style.display = s ? "" : "none";
  closeDrawer();
  const h0 = location.hash || "#/";
  for (const [href, label, ic] of navFor(role)) {
    const b = document.createElement("button");
    b.className = "side-link" + (isActive(href, h0) ? " active" : "");
    b.innerHTML = `<span class="side-ic">${icon(ic)}</span><span class="side-lb">${label}</span>`;
    b.onclick = () => { location.hash = href; closeDrawer(); };
    nav().appendChild(b);
  }

  const h = location.hash || "#/";
  if (h === "#/" || h === "#") {
    if (s) { go(homeFor(roleOf(s))); return; }
    return (await import("./views/public")).renderLanding(view());
  }
  if (!s && !h.startsWith("#/login") && !h.startsWith("#/register") && !h.startsWith("#/verify-license")) {
    location.hash = "#/login";
    return;
  }
  if (h.startsWith("#/login")) return renderLogin();
  if (h.startsWith("#/register")) return renderRegister();
  if (h.startsWith("#/verify-license")) return (await import("./views/public")).renderVerify(view());
  // Signed in but not provisioned (self-registered, role still null) — a dead
  // "No access" screen with no escape used to trap users here.
  if (s && !role) return renderPending();
  if (h.startsWith("#/ceo")) {
    if (!requireRole(s, ["ceo"])) return (view().innerHTML = `<p>No access (CEO only).</p><p><a href="${homeFor(role)}">Go to dashboard</a></p>`);
    const m = await import("./views/ceo");
    return m.renderCEO(view(), h.replace("#/ceo", "") || "/");
  }
  if (h.startsWith("#/owner")) {
    if (!requireRole(s, ["owner", "ceo", "manager"])) return (view().innerHTML = "<p>No access.</p>");
    const m = await import("./views/owner");
    return m.renderOwner(view(), h.replace("#/owner", "") || "/", s);
  }
  // Unknown top-level hash → role home (go() avoids redirect loops).
  go(homeFor(role));
}

export async function route() {
  startProgress();
  try {
    await renderRouteCore();
  } finally {
    stopProgress();
  }
}

function renderPending() {
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card">
    <h2>Account not provisioned yet</h2>
    <p class="muted">Your account exists but has no role. Ask the CEO to open
    <strong>Users</strong> and grant you <em>owner</em> (plus gym_ids) or <em>manager</em>,
    then sign out and back in to pick up the new claims.</p>
    <p class="muted">First install? The CEO role is granted once via
    <strong>Bootstrap first CEO</strong> on the <a href="#/login">sign-in</a> page.</p></div></div>`;
}

function loginMsg(text: string, color: string) {
  const m = document.getElementById("login-msg");
  if (m) { m.textContent = text; m.style.color = color; }
}

function renderLogin() {
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card">
    <div id="brandlogo" style="margin: 0 auto 16px; width: 56px; height: 56px; border-radius: 14px; overflow: hidden; padding: 0; border: 1.5px solid rgba(139, 92, 246, 0.65); box-shadow: 0 0 20px rgba(139, 92, 246, 0.5);">
      <img src="/icon.jpg" alt="SLS Emblem" style="width: 100%; height: 100%; object-fit: cover;" />
    </div>
    <h2 class="brand">SLS v3</h2>
    <p class="muted" style="margin-top:-6px;margin-bottom:18px">SOLO LEVELING SYSTEM — sign in</p>
    <input id="em" placeholder="email" /><input id="pw" type="password" placeholder="password" />
    <button class="primary" id="go">Sign in</button>
    <p id="login-msg" class="muted"></p>
    <div class="auth-links">
      <button id="bootstrap">Bootstrap first CEO</button>
      <a href="#/register">Register owner account</a>
    </div>
    <p><span id="boot-msg" class="muted"></span></p>
    <ul class="feat-list"><li>Offline-first POS + face gate terminal</li><li>Per-gym licensing with remote kill switch</li><li>CEO / owner / manager roles</li></ul>
    <p class="muted">Bootstrap grants <code>role=ceo</code> to the signed-in user only if no CEO exists yet (5/hr/IP).</p>
  </div></div>`;
  (document.getElementById("go") as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const em = (document.getElementById("em") as HTMLInputElement).value;
    const pw = (document.getElementById("pw") as HTMLInputElement).value;
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Signing in…";
    try {
      await signIn(em, pw);
      // Land on the right dashboard for the role — owners used to bounce off
      // the CEO-only guard with no way forward.
      const s = await session();
      go(homeFor(s ? roleOf(s) : null));
    } catch (e) {
      loginMsg(String((e as Error).message ?? e), "#f87171");
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.textContent = "Sign in";
    }
  };
  (document.getElementById("bootstrap") as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById("boot-msg")!;
    try {
      const s = await session();
      if (!s) { msg.textContent = "Sign in first, then bootstrap."; return; }
      const base = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${base}/functions/v1/bootstrap-ceo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
        body: "{}",
      });
      const text = await res.text();
      if (!res.ok) { msg.textContent = text; msg.style.color = "#ff6b6b"; return; }
      msg.textContent = "CEO granted — sign out/in to refresh claims.";
      msg.style.color = "#3ddc97";
    } catch (e) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
  };
}

function renderRegister() {
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card">
    <div id="brandlogo" style="margin: 0 auto 16px; width: 56px; height: 56px; border-radius: 14px; overflow: hidden; padding: 0; border: 1.5px solid rgba(139, 92, 246, 0.65); box-shadow: 0 0 20px rgba(139, 92, 246, 0.5);">
      <img src="/icon.jpg" alt="SLS Emblem" style="width: 100%; height: 100%; object-fit: cover;" />
    </div>
    <h2 class="brand">SYSTEM REGISTER</h2>
    <p class="muted" style="margin-top:-6px;margin-bottom:18px">Create system owner account</p>
    <input id="em" placeholder="email" /><input id="pw" type="password" placeholder="min 8 chars" />
    <button class="primary" id="go">Register</button>
    <p id="login-msg" class="muted"></p>
    <p class="muted">After register + sign-in, ask CEO to grant <strong>owner</strong> + gym_ids under Users (JWT claims required for RLS).</p>
    <div class="auth-links"><a href="#/login">← Back to sign in</a></div>
  </div></div>`;
  (document.getElementById("go") as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const em = (document.getElementById("em") as HTMLInputElement).value;
    const pw = (document.getElementById("pw") as HTMLInputElement).value;
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Registering…";
    try {
      await signUpOwner(em, pw);
      const s = await session();
      if (s) go(homeFor(roleOf(s)));
      else loginMsg("Check your email to confirm the account, then sign in.", "#34d399");
    } catch (e) {
      loginMsg(String((e as Error).message ?? e), "#f87171");
    } finally {
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.textContent = "Register";
    }
  };
}

document.getElementById("logout")!.onclick = async () => {
  await signOut();
  void route(); // hash may already be #/login → no hashchange → render manually
};
// Collapsing sidebar: rail on desktop (persisted), overlay drawer on mobile.
if (localStorage.getItem("sls.rail") === "1") layout().classList.add("rail");
document.getElementById("nav-toggle")!.onclick = () => {
  if (window.matchMedia("(max-width: 900px)").matches) layout().classList.toggle("open");
  else {
    const rail = !layout().classList.contains("rail");
    layout().classList.toggle("rail", rail);
    localStorage.setItem("sls.rail", rail ? "1" : "0");
  }
};
document.getElementById("scrim")!.onclick = closeDrawer;
window.addEventListener("hashchange", route);
route();
