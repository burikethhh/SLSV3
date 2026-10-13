// Hash router + RBAC guards. Code-split: ceo/owner bundles lazy-load.
import { session, requireRole, roleOf, signIn, signUpOwner, signOut, completeOwnerSetup, resendVerification, sendPasswordReset } from "./auth";
import { db } from "./supabase";
import { icon, esc } from "./ui";

const view = () => document.getElementById("view")!;
const nav = () => document.getElementById("nav")!;
const layout = () => document.getElementById("layout")!;

function navFor(role: string | null): [string, string, string][] {
  if (role === "ceo") return [["#/ceo", "Overview", "grid"], ["#/ceo/fleet", "Applications & Facilities", "gym"], ["#/ceo/keys", "Subscriptions", "key"], ["#/ceo/terminals", "Terminals", "box"], ["#/ceo/users", "Accounts", "users"], ["#/ceo/releases", "Releases", "send"], ["#/ceo/audit", "Audit", "clock"]];
  if (role === "owner" || role === "manager") return [["#/owner", "Overview", "chart"], ["#/owner/start", "Get Started", "grid"], ["#/owner/catalog", "Products", "box"], ["#/owner/plans", "Membership Plans", "money"], ["#/owner/promos", "Promos", "tag"], ["#/owner/txns", "Live feed", "zap"], ["#/owner/staff", "Staff", "users"], ["#/owner/keys", "Subscription & Terminals", "key"], ["#/owner/help", "Help", "shield"]];
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
  if (s && !h.startsWith("#/login") && !h.startsWith("#/register")) {
    const { data, error } = await db().auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    if (data?.nextLevel === "aal2" && data.currentLevel !== "aal2") return renderMfa();
  }
  if (h === "#/" || h === "#") {
    if (s) { go(homeFor(roleOf(s))); return; }
    return (await import("./views/public")).renderLanding(view());
  }
  if (!s && !h.startsWith("#/login") && !h.startsWith("#/register") && !h.startsWith("#/verify-license") && !h.startsWith("#/reset-password")) {
    location.hash = "#/login";
    return;
  }
  if (h.startsWith("#/login")) return renderLogin();
  if (h.startsWith("#/register")) return renderRegister();
  if (h.startsWith("#/reset-password")) return renderResetPassword();
  if (s && h.startsWith("#/setup")) {
    if (role) { go(homeFor(role)); return; }
    return renderPending();
  }
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
    <h2>Finish your gym setup</h2><p class="muted">Your account is saved. Complete these details to start your 14-day trial. CEO review is needed only for paid activation.</p>
    <form id="setup-form">
      <label for="setup-name">Gym name</label><input id="setup-name" required maxlength="200" />
      <label for="setup-location">Branch location</label><input id="setup-location" maxlength="200" />
      <label for="setup-tier">Trial tier</label><select id="setup-tier"><option value="basic">Basic · 200 members</option><option value="pro">Pro · 500 members</option><option value="ultra">Ultra · 1,000 members</option></select>
      <button class="primary" id="setup-go" type="submit">Start my 14-day trial</button>
    </form><p id="login-msg" role="status" aria-live="polite"></p></div></div>`;
  const form = document.getElementById("setup-form") as HTMLFormElement;
  let busy = false;
  const submit = async () => {
    if (busy || !form.reportValidity()) return;
    busy = true;
    const btn = document.getElementById("setup-go") as HTMLButtonElement;
    btn.disabled = true;
    loginMsg("Preparing your facility and trial…", "#38bdf8");
    try {
      await completeOwnerSetup({
        gym_name: (document.getElementById("setup-name") as HTMLInputElement).value.trim(),
        location: (document.getElementById("setup-location") as HTMLInputElement).value.trim(),
        tier: (document.getElementById("setup-tier") as HTMLSelectElement).value,
      });
      go("#/owner/start");
    } catch (e) { loginMsg(String((e as Error).message ?? e), "#f87171"); btn.disabled = false; }
    finally { busy = false; }
  };
  form.onsubmit = (e) => { e.preventDefault(); void submit(); };
  void session().then((current) => {
    if (!form.isConnected) return;
    const draft = current?.user.user_metadata?.onboarding;
    if (!draft) return;
    (document.getElementById("setup-name") as HTMLInputElement).value = String(draft.gym_name ?? "");
    (document.getElementById("setup-location") as HTMLInputElement).value = String(draft.location ?? "");
    (document.getElementById("setup-tier") as HTMLSelectElement).value = String(draft.tier ?? "basic");
    if (draft.gym_name) void submit();
  });
}

async function renderMfa() {
  const { data, error } = await db().auth.mfa.listFactors();
  if (error) throw error;
  const factors = data.totp.filter(f => f.status === "verified");
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card"><h2>Verify your sign-in</h2>
    <p class="muted">Your account uses two-factor authentication. Enter the current code from your authenticator app before opening your dashboard.</p>
    <form id="mfa-form"><label for="mfa-factor">Authenticator</label><select id="mfa-factor">${factors.map(f => `<option value="${esc(f.id)}">${esc(f.friendly_name || "Authenticator")}</option>`).join("")}</select>
    <label for="mfa-code">6-digit code</label><input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required maxlength="6" />
    <button class="primary" id="mfa-go" ${factors.length ? "" : "disabled"}>Verify sign-in</button></form><p id="login-msg" role="status">${factors.length ? "" : "No supported authenticator found. Contact your account administrator; do not disable MFA to bypass this screen."}</p></div></div>`;
  (document.getElementById("mfa-form") as HTMLFormElement).onsubmit = async event => {
    event.preventDefault(); const button = document.getElementById("mfa-go") as HTMLButtonElement;
    if (button.disabled) return; button.disabled = true;
    try {
      const { error } = await db().auth.mfa.challengeAndVerify({ factorId: (document.getElementById("mfa-factor") as HTMLSelectElement).value,
        code: (document.getElementById("mfa-code") as HTMLInputElement).value });
      if (error) throw error;
      await route();
    } catch (e) { loginMsg(String((e as Error).message ?? e), "#f87171"); button.disabled = false; }
  };
}

function loginMsg(text: string, color: string) {
  const m = document.getElementById("login-msg");
  if (m) { m.textContent = text; m.style.color = color; }
}

function renderLogin() {
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card">
    <h2>Sign in to SLS</h2><p class="muted">Manage your facility here. Use this same owner account to connect GymPOS.</p>
    <form id="login-form">
      <label for="em">Email address</label><input id="em" type="email" autocomplete="username" required />
      <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required />
      <button class="primary" id="go" type="submit">Sign in</button>
    </form><p id="login-msg" role="status" aria-live="polite"></p>
    <div class="auth-links"><a href="#/register">Create a gym owner account</a>
      <button type="button" id="forgot">Reset password</button><button type="button" id="resend">Resend verification email</button></div>
    <p class="muted">Owners manage subscriptions and connect terminals. Staff PINs are for daily GymPOS operations. Gym members do not need dashboard accounts.</p>
  </div></div>`;
  (document.getElementById("login-form") as HTMLFormElement).onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById("go") as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await signIn((document.getElementById("em") as HTMLInputElement).value.trim(), (document.getElementById("pw") as HTMLInputElement).value);
      const current = await session();
      go(current && roleOf(current) ? homeFor(roleOf(current)) : "#/setup");
    } catch (e) { loginMsg(String((e as Error).message ?? e), "#f87171"); }
    finally { btn.disabled = false; btn.textContent = "Sign in"; }
  };
  for (const [id, action] of [["forgot", sendPasswordReset], ["resend", resendVerification]] as const) {
    (document.getElementById(id) as HTMLButtonElement).onclick = async (e) => {
      const input = document.getElementById("em") as HTMLInputElement;
      if (!input.reportValidity()) return;
      const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true;
      try { await action(input.value.trim()); loginMsg("If this account is eligible, an email has been sent. Check your inbox and spam folder.", "#34d399"); }
      catch (error) { loginMsg(String((error as Error).message ?? error), "#f87171"); }
      finally { btn.disabled = false; }
    };
  }
}

function renderRegister() {
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card" style="max-width:520px">
    <h2>Create your gym owner account</h2>
    <p class="muted">1. Register and verify your email. 2. Start your 14-day trial automatically. 3. Sign in to GymPOS with this account—no license key to copy.</p>
    <form id="register-form">
      <label for="em">Owner email address</label><input id="em" type="email" autocomplete="username" required />
      <label for="pw">Password (at least 8 characters)</label><input id="pw" type="password" autocomplete="new-password" minlength="8" required />
      <label for="reg-gym">Gym name</label><input id="reg-gym" maxlength="200" required />
      <label for="reg-loc">Branch location</label><input id="reg-loc" maxlength="200" />
      <label for="reg-tier">Trial tier · paid pricing in USD</label>
      <select id="reg-tier"><option value="basic">Basic · 200 members · $99/month after trial</option><option value="pro" selected>Pro · 500 members · $199/month after trial</option><option value="ultra">Ultra · 1,000 members · $349/month after trial</option></select>
      <button class="primary" id="go" type="submit">Create account</button>
    </form><p id="login-msg" role="status" aria-live="polite"></p>
    <div id="trial-card" hidden class="panel"></div>
    <p class="muted">No payment is taken during registration. CEO facility review and payment confirmation are separate steps before a paid 30-day subscription is activated.</p>
    <div class="auth-links"><a href="#/login">Already registered? Sign in</a></div>
  </div></div>`;
  (document.getElementById("register-form") as HTMLFormElement).onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById("go") as HTMLButtonElement;
    if (btn.disabled) return;
    const email = (document.getElementById("em") as HTMLInputElement).value.trim();
    const password = (document.getElementById("pw") as HTMLInputElement).value; // Never trim passwords.
    const draft = {
      gym_name: (document.getElementById("reg-gym") as HTMLInputElement).value.trim(),
      location: (document.getElementById("reg-loc") as HTMLInputElement).value.trim(),
      tier: (document.getElementById("reg-tier") as HTMLSelectElement).value,
    };
    if (!draft.gym_name) { loginMsg("Enter your gym name.", "#f87171"); return; }
    btn.disabled = true; btn.textContent = "Creating account…";
    try {
      const result = await signUpOwner(email, password, draft);
      if (!result.session) {
        loginMsg("Check your email to verify your account. Your gym details are saved and setup resumes after verification.", "#34d399");
        btn.textContent = "Verification email sent";
        const card = document.getElementById("trial-card")!;
        card.hidden = false;
        card.innerHTML = `<p>Verify <strong>${esc(email)}</strong>, then sign in. Your trial starts when gym setup completes.</p><button id="register-resend" type="button">Resend verification email</button>`;
        document.getElementById("register-resend")!.onclick = async (e) => {
          const resend = e.currentTarget as HTMLButtonElement; resend.disabled = true;
          try { await resendVerification(email); loginMsg("Verification email requested. Check your inbox.", "#34d399"); }
          catch (error) { loginMsg(String((error as Error).message ?? error), "#f87171"); }
          finally { resend.disabled = false; }
        };
        return;
      }
      go("#/setup");
    } catch (e) { loginMsg(String((e as Error).message ?? e), "#f87171"); btn.disabled = false; btn.textContent = "Create account"; }
    finally { const input = document.getElementById("pw") as HTMLInputElement | null; if (input) input.value = ""; }
  };
}

function renderResetPassword() {
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card">
    <h2>Choose a new password</h2><p class="muted">Open the password reset link from your email first.</p>
    <form id="reset-form"><label for="reset-pw">New password</label><input id="reset-pw" type="password" autocomplete="new-password" minlength="8" required />
      <button class="primary" id="reset-go" type="submit">Update password</button></form>
    <p id="login-msg" role="status"></p><a href="#/login">Back to sign in</a></div></div>`;
  (document.getElementById("reset-form") as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault(); const btn = document.getElementById("reset-go") as HTMLButtonElement;
    if (btn.disabled) return; btn.disabled = true;
    try {
      if (!await session()) throw new Error("Open a fresh password reset link from your email.");
      const { error } = await db().auth.updateUser({ password: (document.getElementById("reset-pw") as HTMLInputElement).value });
      if (error) throw error;
      await signOut();
      go("#/login");
    } catch (error) { loginMsg(String((error as Error).message ?? error), "#f87171"); }
    finally { btn.disabled = false; }
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
// Avoid calling auth methods inside the auth callback (SDK lock).
db().auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") setTimeout(() => go("#/reset-password"), 0);
  else if (event === "SIGNED_OUT") setTimeout(() => go("#/login"), 0);
  else if (event === "SIGNED_IN" && !location.hash.startsWith("#/register") && !location.hash.startsWith("#/reset-password")) {
    setTimeout(() => { if (location.hash.startsWith("#/login") || location.hash.startsWith("#access_token")) go("#/setup"); }, 0);
  }
});

// Keep routing in step with authoritative role/facility changes. RLS enforces
// them immediately; this refresh updates the account's visible navigation.
let checkingAccount = false;
async function refreshAccountRouting() {
  if (checkingAccount || document.hidden) return;
  checkingAccount = true;
  try {
    const current = await session();
    if (!current) return;
    const { data: { user }, error } = await db().auth.getUser();
    if (error || !user) return; // offline is not proof of revoked access
    const relevant = (metadata: Record<string, unknown>) => JSON.stringify({ role: metadata.role, gyms: metadata.gym_ids });
    if (relevant(user.app_metadata) !== relevant(current.user.app_metadata)) {
      const { error: refreshError } = await db().auth.refreshSession();
      if (!refreshError) go(homeFor(roleOf({ user })));
    }
  } finally { checkingAccount = false; }
}
setInterval(() => void refreshAccountRouting().catch(() => {}), 30000);
window.addEventListener("focus", () => void refreshAccountRouting().catch(() => {}));
