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
  view().innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card" style="max-width:520px">
    <div id="brandlogo" style="margin: 0 auto 16px; width: 56px; height: 56px; border-radius: 14px; overflow: hidden; padding: 0; border: 1.5px solid rgba(139, 92, 246, 0.65); box-shadow: 0 0 20px rgba(139, 92, 246, 0.5);">
      <img src="/icon.jpg" alt="SLS Emblem" style="width: 100%; height: 100%; object-fit: cover;" />
    </div>
    <h2 class="brand">GYM OWNER APPLICATION</h2>
    <p class="muted" style="margin-top:-6px;margin-bottom:16px">Apply for gym owner role &amp; receive an instant 14-day trial key</p>
    
    <label style="display:block;text-align:left;font-size:11px;color:var(--muted);margin-bottom:4px">ACCOUNT CREDENTIALS</label>
    <input id="em" placeholder="Email address" type="email" style="margin-bottom:8px;width:100%" />
    <input id="pw" type="password" placeholder="Password (minimum 8 characters)" style="margin-bottom:14px;width:100%" />
    
    <label style="display:block;text-align:left;font-size:11px;color:var(--muted);margin-bottom:4px">GYM FACILITY DETAILS</label>
    <input id="reg-gym" placeholder="Gym name (e.g. Iron Forge Fitness)" style="margin-bottom:8px;width:100%" />
    <input id="reg-loc" placeholder="Branch location (e.g. Makati, Metro Manila)" style="margin-bottom:8px;width:100%" />
    
    <label style="display:block;text-align:left;font-size:11px;color:var(--muted);margin-bottom:4px">SUBSCRIPTION TIER</label>
    <select id="reg-tier" style="margin-bottom:14px;width:100%">
      <option value="basic">Basic Tier — up to 200 Hunters ($99/mo)</option>
      <option value="pro" selected>Pro Tier — up to 500 Hunters ($199/mo)</option>
      <option value="ultra">Ultra Tier — up to 1,000 Hunters ($349/mo)</option>
    </select>
    
    <button class="primary" id="go" style="width:100%;height:44px;font-size:15px;margin-top:6px">Submit Application &amp; Get Trial Key</button>
    <p id="login-msg" class="muted" style="margin-top:10px"></p>
    
    <div id="trial-card" hidden class="panel" style="margin-top:14px;border:1px solid rgba(52,211,153,0.4);background:rgba(52,211,153,0.08);text-align:left"></div>
    
    <div class="auth-links" style="margin-top:12px"><a href="#/login">← Already have an account? Sign in</a></div>
  </div></div>`;

  (document.getElementById("go") as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const em = (document.getElementById("em") as HTMLInputElement).value.trim();
    const pw = (document.getElementById("pw") as HTMLInputElement).value.trim();
    const gymName = (document.getElementById("reg-gym") as HTMLInputElement).value.trim();
    const location = (document.getElementById("reg-loc") as HTMLInputElement).value.trim();
    const tier = (document.getElementById("reg-tier") as HTMLSelectElement).value;

    if (!em || !pw) { loginMsg("Email and password are required.", "#f87171"); return; }
    if (pw.length < 8) { loginMsg("Password must be at least 8 characters.", "#f87171"); return; }
    if (!gymName) { loginMsg("Gym name is required.", "#f87171"); return; }

    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Creating account & trial key…";

    try {
      await signUpOwner(em, pw);
      let s = await session();
      if (!s) {
        await signIn(em, pw);
        s = await session();
      }
      if (!s) {
        loginMsg("Account created! Please check your email to verify, then sign in.", "#34d399");
        return;
      }

      const base = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${base}/functions/v1/owner-apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.access_token}`,
        },
        body: JSON.stringify({ gym_name: gymName, location, tier }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Application error: ${text}`);
      }

      const applyData = await res.json();
      const trialCard = document.getElementById("trial-card")!;
      trialCard.hidden = false;
      trialCard.innerHTML = `
        <div style="font-weight:700;color:#34d399;font-size:14px;margin-bottom:6px">✓ APPLICATION SUBMITTED &amp; TRIAL KEY ACTIVE</div>
        <p style="font-size:12px;margin:4px 0" class="muted">
          Your gym <strong>${gymName}</strong> is registered. While awaiting CEO verification, your <strong>14-day free trial key</strong> is active!
        </p>
        <div style="margin:8px 0">
          <div style="font-size:11px;color:var(--cyan);font-weight:700">TRIAL LICENSE KEY:</div>
          <textarea readonly rows="2" style="width:100%;font-size:11px;font-family:monospace;background:#0d1117;color:#c9d1d9;padding:6px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);margin-top:2px">${applyData.token || "Active in Cloud"}</textarea>
        </div>
        <p style="font-size:11px;color:#94a3b8;margin:4px 0">
          💡 <strong>GymPOS Tip:</strong> On your turnstile terminal, simply click <em>"Login with SLS Account"</em> using this email &amp; password — the trial license activates automatically!
        </p>
        <button id="go-owner-dash" class="primary" style="width:100%;margin-top:10px">Enter Owner Dashboard →</button>
      `;

      loginMsg("Application submitted successfully!", "#34d399");
      btn.style.display = "none";

      document.getElementById("go-owner-dash")?.addEventListener("click", async () => {
        await signIn(em, pw);
        const refreshed = await session();
        go(homeFor(refreshed ? roleOf(refreshed) : "owner"));
      });
    } catch (e) {
      loginMsg(String((e as Error).message ?? e), "#f87171");
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.textContent = "Submit Application & Get Trial Key";
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
