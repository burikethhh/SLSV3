// Spot-checks for 0005 + user-admin list + owner scope fix.
const base = "https://cjxpsiuvwihanxqccpnf.supabase.co";
import { readFileSync } from "node:fs";
const env = readFileSync("B:/Projects/SoloLeveling/web/.env", "utf8");
const anon = env.match(/VITE_SUPABASE_ANON_KEY=(.+)/)?.[1]?.trim();
const ceo = "ceo.e2e.1790267997223@acme.test";
const owner = process.argv[2] ?? "owner.e2e.1790507038514@acme.test";
const pw = "E2ePassw0rd!xyz";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, extra); }
};
async function login(email) {
  const r = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
    body: JSON.stringify({ email, password: pw }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`${email}: ${JSON.stringify(b)}`);
  return b;
}
const H = (t, jwt) => ({
  "Content-Type": "application/json",
  apikey: anon,
  Authorization: `Bearer ${jwt ?? t.access_token}`,
});

// 1. CEO user directory
const c = await login(ceo);
const lu = await fetch(`${base}/functions/v1/user-admin`, {
  method: "POST", headers: H(c), body: JSON.stringify({ action: "list" }),
});
const lb = await lu.json();
ok("user-admin.list 200", lu.ok && Array.isArray(lb.users), JSON.stringify(lb).slice(0, 200));
ok("user-admin.list sees ceo role", lb.users?.some((u) => u.role === "ceo"), "no ceo row");

// 2. CEO can now publish a release (was 42501 before 0005)
const ver = `0.0.0-e2e-${Date.now()}`;
const ins = await fetch(`${base}/rest/v1/releases`, {
  method: "POST", headers: H(c, c.access_token), body: JSON.stringify({
    version: ver, channel: "stable", rollout_pct: 100, download_url: "https://x/y.exe", sig: "untrusted comment: e2e",
  }),
});
ok("releases.insert CEO", ins.ok, `${ins.status} ${await ins.text()}`);
const rd = await fetch(`${base}/rest/v1/releases?version=eq.${ver}`, { method: "DELETE", headers: H(c, c.access_token) });
ok("releases.delete CEO (cleanup)", rd.ok, `${rd.status}`);

// 3. Owner scope query shape: .or(null-inclusive) must not 400 on plans/promos/products
let o = null;
try { o = await login(owner); } catch (e) { console.log("WARN owner login:", e.message); }
if (o) {
  const gid = o.user.app_metadata.gym_ids?.[0];
  const list = gid ? `gym_id.is.null,gym_id.in.(${gid})` : "gym_id.is.null";
  for (const table of ["plans", "promos", "products", "sales"]) {
    const r = await fetch(`${base}/rest/v1/${table}?select=*&or=(${encodeURIComponent(list)})&limit=1`, { headers: H(o) });
    ok(`owner scope ${table}`, r.ok, `${r.status} ${await r.text()}`);
  }
  // realtime publication actually attached (metadata check via RPC not exposed; done via SQL earlier)
  // grant+list roundtrip already covered by harness
}
// 4. user-admin demote roundtrip on a sacrificial user (role:null support)
const sacr = `sacr.${Date.now()}@acme.test`;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (svc) {
  const sh = { "Content-Type": "application/json", apikey: svc, Authorization: `Bearer ${svc}` };
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST", headers: sh, body: JSON.stringify({ email: sacr, password: "SacrPass99!", email_confirm: true }),
  });
  const cj = await created.json();
  ok("sacr.user created", created.ok, `${created.status} ${JSON.stringify(cj).slice(0, 150)}`);
  if (created.ok) {
    const grant = await fetch(`${base}/functions/v1/user-admin`, {
      method: "POST", headers: H(c), body: JSON.stringify({ email: sacr, role: "owner", gym_ids: [] }),
    });
    ok("user-admin.grant owner", grant.ok, `${grant.status} ${await grant.text()}`);
    const demote = await fetch(`${base}/functions/v1/user-admin`, {
      method: "POST", headers: H(c), body: JSON.stringify({ email: sacr, role: null, gym_ids: [] }),
    });
    ok("user-admin.demote null", demote.ok, `${demote.status} ${await demote.text()}`);
    const after = await (await fetch(`${base}/functions/v1/user-admin`, {
      method: "POST", headers: H(c), body: JSON.stringify({ action: "list" }),
    })).json();
    ok("user-admin.role stripped", after.users?.find((u) => u.email === sacr)?.role === null);
    await fetch(`${base}/auth/v1/admin/users/${cj.id}`, { method: "DELETE", headers: sh });
  }
} else {
  console.log("WARN no SUPABASE_SERVICE_ROLE_KEY — skipping demote checks");
}

// 5. gym-admin strictness: unknown gym → 404, bad disabled type → 400
const g404 = await fetch(`${base}/functions/v1/gym-admin`, {
  method: "POST", headers: H(c),
  body: JSON.stringify({ action: "set_disabled", gym_id: "00000000-0000-4000-8000-000000000000", disabled: true }),
});
ok("gym-admin.missing_gym 404", g404.status === 404, `status=${g404.status}`);
const g400 = await fetch(`${base}/functions/v1/gym-admin`, {
  method: "POST", headers: H(c),
  body: JSON.stringify({ action: "set_disabled", gym_id: "00000000-0000-4000-8000-000000000000", disabled: "yes" }),
});
ok("gym-admin.strict_bool 400", g400.status === 400, `status=${g400.status}`);

// 6. staff-create validation: bad username → 400 (was accepted verbatim)
const sc = await fetch(`${base}/functions/v1/staff-create`, {
  method: "POST", headers: H(c),
  body: JSON.stringify({ gym_id: "00000000-0000-4000-8000-000000000000", full_name: "X", username: "Bad User!", pin: "1234" }),
});
ok("staff-create.bad_username 400", sc.status === 400, `status=${sc.status}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
