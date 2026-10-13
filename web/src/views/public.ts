// Public surface: landing hero + license-verify helper (replaces v2 POST
// /licenses/verify click-through). Verify calls the license-verify Edge
// Function; never exposes the private key (verify_jwt=true → anon key required).
import { icon } from "../ui";

export function renderLanding(root: HTMLElement) {
  root.innerHTML = `<div class="hero">
    <div class="hero-rune-bg" aria-hidden="true">
      <div class="rune-ring ring-outer"></div>
      <div class="rune-ring ring-mid"></div>
      <div class="rune-ring ring-inner"></div>
    </div>
    <div class="hero-brand-crest" style="margin-bottom:20px">
      <img src="/logo.jpg" alt="Solo Leveling System" style="width:130px;height:130px;border-radius:24px;border:2px solid rgba(139,92,246,0.65);box-shadow:0 0 40px rgba(139,92,246,0.55), 0 0 15px rgba(56,189,248,0.4);object-fit:cover" />
    </div>
    <div class="hero-kicker">SOLO LEVELING SYSTEM · GATE v3</div>
    <h1 class="hero-title">ARISE<span class="hero-caret">_</span></h1>
    <p class="hero-sub">Gym management dashboard and offline-capable GymPOS terminal.
    Register, verify your email, and connect your gym with a 14-day trial.</p>
    <div class="row hero-cta">
      <a href="#/login"><button class="primary">Sign in</button></a>
      <a href="#/register"><button>Create owner account · 14-day trial</button></a>
    </div>
    <div class="feat-grid">
      <div class="glass-panel feat">
        <div class="icon-box tone-sky" style="margin-bottom:10px">${icon("zap")}</div>
        <div class="feat-t">Face Gate</div>
        <div class="muted">YuNet + EdgeFace turnstile, 3s anti-passback, ESP32 maglock.</div>
      </div>
      <div class="glass-panel feat">
        <div class="icon-box tone-violet" style="margin-bottom:10px">${icon("box")}</div>
        <div class="feat-t">Offline POS</div>
        <div class="muted">Cents-exact cart, outbox sync, kill-switch aware.</div>
      </div>
      <div class="glass-panel feat">
        <div class="icon-box tone-amber" style="margin-bottom:10px">${icon("key")}</div>
        <div class="feat-t">Licensing</div>
        <div class="muted">Sign in with your owner account. Subscription changes reach connected terminals automatically.</div>
      </div>
      <div class="glass-panel feat">
        <div class="icon-box tone-emerald" style="margin-bottom:10px">${icon("chart")}</div>
        <div class="feat-t">Dashboards</div>
        <div class="muted">CEO fleet, owner revenue, realtime POS feed.</div>
      </div>
    </div></div>`;
}

export async function renderVerify(root: HTMLElement) {
  root.innerHTML = `<div class="auth-wrap"><div class="glass-panel auth-card" style="max-width:640px">
    <h2 class="brand">Verify license key</h2>
    <p class="muted">Paste a <code>GPOS-…</code> token to check tier, expiry and kill-switch state. The signing key never leaves the server.</p>
    <div class="row">
    <input id="tok" placeholder="GPOS-..." style="min-width:min(420px,80vw);flex:1" />
    <button class="primary" id="go">Verify</button></div><pre id="out" class="muted" style="text-align:left;white-space:pre-wrap"></pre>
  </div></div>`;
  (document.getElementById("go") as HTMLButtonElement).onclick = async () => {
    const token = (document.getElementById("tok") as HTMLInputElement).value.trim();
    const base = import.meta.env.VITE_SUPABASE_URL;
    const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const res = await fetch(`${base}/functions/v1/license-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ token }),
    });
    document.getElementById("out")!.textContent = await res.text();
  };
}
