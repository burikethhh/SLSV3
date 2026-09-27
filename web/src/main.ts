// Hash router + RBAC guards. Code-split: ceo/owner bundles lazy-load.
import { session, requireRole, roleOf, signIn, signUpOwner, signOut } from "./auth";

const view = () => document.getElementById("view")!;
const nav = () => document.getElementById("nav")!;

function navFor(role: string | null) {
  if (role === "ceo") return [["#/ceo", "Overview"], ["#/ceo/fleet", "Fleet"], ["#/ceo/keys", "Key Vault"], ["#/ceo/users", "Users"], ["#/ceo/releases", "Releases"], ["#/ceo/audit", "Audit"]];
  if (role === "owner" || role === "manager") return [["#/owner", "Overview"], ["#/owner/catalog", "Catalog"], ["#/owner/plans", "Plans"], ["#/owner/promos", "Promos"], ["#/owner/txns", "Live feed"], ["#/owner/staff", "Staff"], ["#/owner/keys", "Keys"]];
  return [];
}

const homeFor = (role: string | null) => (role === "ceo" ? "#/ceo" : "#/owner");

/** Set hash and render — but render directly when the hash is already there
 *  (no hashchange fires → stale view). Replaces the old set-hash-then-call-
 *  route() pattern that rendered every route twice. */
function go(hash: string) {
  if (location.hash === hash) void route();
  else location.hash = hash;
}

export async function route() {
  const s = await session();
  const role = s ? roleOf(s) : null;
  document.getElementById("logout")!.hidden = !s;
  document.getElementById("modal-root")!.innerHTML = ""; // no orphan modals across routes
  nav().innerHTML = "";
  for (const [href, label] of navFor(role)) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => (location.hash = href);
    nav().appendChild(b);
  }

  const h = location.hash || "#/login";
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

function renderPending() {
  view().innerHTML = `<h2>Account not provisioned yet</h2>
    <p class="muted">Your account exists but has no role. Ask the CEO to open
    <strong>Users</strong> and grant you <em>owner</em> (plus gym_ids) or <em>manager</em>,
    then sign out and back in to pick up the new claims.</p>
    <p class="muted">First install? The CEO role is granted once via
    <strong>Bootstrap first CEO</strong> on the <a href="#/login">sign-in</a> page.</p>`;
}

function loginMsg(text: string, color: string) {
  const m = document.getElementById("login-msg");
  if (m) { m.textContent = text; m.style.color = color; }
}

function renderLogin() {
  view().innerHTML = `<h2>Sign in</h2><div class="row">
    <input id="em" placeholder="email" /><input id="pw" type="password" placeholder="password" />
    <button class="primary" id="go">Sign in</button></div>
    <p id="login-msg" class="muted"></p>
    <div class="row" style="margin-top:12px">
      <button id="bootstrap">Bootstrap first CEO</button>
      <a href="#/register">Register owner account</a>
      <span id="boot-msg" class="muted"></span>
    </div>
    <p class="muted">Bootstrap grants <code>role=ceo</code> to the signed-in user only if no CEO exists yet (5/hr/IP).</p>`;
  (document.getElementById("go") as HTMLButtonElement).onclick = async () => {
    const em = (document.getElementById("em") as HTMLInputElement).value;
    const pw = (document.getElementById("pw") as HTMLInputElement).value;
    try {
      await signIn(em, pw);
      // Land on the right dashboard for the role — owners used to bounce off
      // the CEO-only guard with no way forward.
      const s = await session();
      go(homeFor(s ? roleOf(s) : null));
    } catch (e) {
      loginMsg(String((e as Error).message ?? e), "#f87171");
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
  view().innerHTML = `<h2>Owner register</h2><div class="row">
    <input id="em" placeholder="email" /><input id="pw" type="password" placeholder="min 8 chars" />
    <button class="primary" id="go">Register</button></div>
    <p id="login-msg" class="muted"></p>
    <p class="muted">After register + sign-in, ask CEO to grant <strong>owner</strong> + gym_ids under Users (JWT claims required for RLS).</p>`;
  (document.getElementById("go") as HTMLButtonElement).onclick = async () => {
    const em = (document.getElementById("em") as HTMLInputElement).value;
    const pw = (document.getElementById("pw") as HTMLInputElement).value;
    try {
      await signUpOwner(em, pw);
      const s = await session();
      if (s) go(homeFor(roleOf(s)));
      else loginMsg("Check your email to confirm the account, then sign in.", "#34d399");
    } catch (e) {
      loginMsg(String((e as Error).message ?? e), "#f87171");
    }
  };
}

document.getElementById("logout")!.onclick = async () => {
  await signOut();
  void route(); // hash may already be #/login → no hashchange → render manually
};
window.addEventListener("hashchange", route);
route();
