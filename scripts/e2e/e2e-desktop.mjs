// Desktop-leg E2E: issue key → Rust verify (separate cargo step) → sync push
// → kill-switch remote_disabled → re-enable → audit.
const base = "https://cjxpsiuvwihanxqccpnf.supabase.co";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = readFileSync("B:/Projects/SoloLeveling/web/.env", "utf8");
const anon = env.match(/VITE_SUPABASE_ANON_KEY=(.+)/)?.[1]?.trim();
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!anon || !SERVICE) throw new Error("need anon + service_role");

const h = (extra = {}) => ({ "Content-Type": "application/json", apikey: anon, ...extra });
const hs = (extra = {}) => ({ "Content-Type": "application/json", apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, ...extra });
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
async function j(res) {
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
}

async function main() {
  const ts = Date.now();
  const ceoEmail = `ceo.e2e.1790267997223@acme.test`;
  const pw = "E2ePassw0rd!xyz"; // shared with e2e-license/e2e-fixes (do NOT diverge)

  // reset CEO password for harness
  const users = await j(await fetch(`${base}/auth/v1/admin/users?page=1&per_page=200`, { headers: hs() }));
  const ceo = (users.body?.users ?? []).find((u) => u.app_metadata?.role === "ceo");
  if (!ceo) throw new Error("no CEO");
  await fetch(`${base}/auth/v1/admin/users/${ceo.id}`, {
    method: "PUT", headers: hs(), body: JSON.stringify({ password: pw, email_confirm: true }),
  });
  const tok = (await j(await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: h(), body: JSON.stringify({ email: ceo.email, password: pw }),
  }))).body;
  const ceoTok = tok.access_token;
  ok("ceo.login", !!ceoTok);

  // gym
  const g = await j(await fetch(`${base}/functions/v1/gym-admin`, {
    method: "POST", headers: h({ Authorization: `Bearer ${ceoTok}` }),
    body: JSON.stringify({ action: "create", name: `DesktopLeg ${ts}`, tier: "ultra" }),
  }));
  ok("gym.create", g.status === 200 && g.body?.ok, JSON.stringify(g.body).slice(0, 150));
  const gymId = g.body.gym.id;

  // issue 90d key
  const iss = await j(await fetch(`${base}/functions/v1/license-issue`, {
    method: "POST", headers: h({ Authorization: `Bearer ${ceoTok}` }),
    body: JSON.stringify({ gym_id: gymId, gym_name: `DesktopLeg ${ts}`, tier: "ultra", days_valid: 90, create_gym: false }),
  }));
  ok("license.issue", iss.status === 200 && !!iss.body?.token, `status=${iss.status}`);
  const token = iss.body.token;
  writeFileSync("C:/Users/ketha/AppData/Local/Temp/opencode/desktop-leg.token", token);

  // ── Rust verify step ──
  try {
    const cargo = `${process.env.USERPROFILE}\\.cargo\\bin\\cargo.exe`;
    execSync(
      `cmd /c ""C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul 2>&1 && set "PATH=%USERPROFILE%\\.cargo\\bin;%PATH%" && cargo test production_token -- --nocapture""`,
      { cwd: "B:/Projects/SoloLeveling/desktop/src-tauri", env: { ...process.env, TEST_LICENSE_TOKEN: token }, stdio: "inherit", shell: true },
    );
    ok("rust.verify_embedded", true);
  } catch (e) {
    ok("rust.verify_embedded", false, String(e).slice(0, 300));
  }

  // ── sync push (heartbeat empty batch) ──
  const sync = await j(await fetch(`${base}/functions/v1/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ attendance: [], sales: [], members: [] }),
  }));
  ok("sync.heartbeat", sync.status === 200 && sync.body?.remote_disabled === false, JSON.stringify(sync.body).slice(0, 200));
  ok("sync.pull_shape", Array.isArray(sync.body?.products) && Array.isArray(sync.body?.product_ids) && Array.isArray(sync.body?.staff),
    JSON.stringify(Object.keys(sync.body ?? {})));

  // push a member + attendance (FK order) — attendance MUST carry a client id
  const memberId = crypto.randomUUID();
  const attId = crypto.randomUUID();
  const saleId = crypto.randomUUID();
  const pushBody = {
    members: [{ id: memberId, full_name: "Desktop Leg Member", embedding_dim: 512, face_vector: null }],
    attendance: [{ id: attId, member_id: memberId, confidence: 0.81, created_at: new Date().toISOString() }],
    sales: [{ id: saleId, items: [{ name: "day-pass", qty: 1, price_cents: 500 }], total_cents: 500, pay_method: "cash" }],
  };
  const push = await j(await fetch(`${base}/functions/v1/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(pushBody),
  }));
  ok("sync.push", push.status === 200 && push.body?.remote_disabled === false && push.body?.skipped === 0,
    JSON.stringify(push.body).slice(0, 250));

  // Idempotency: retrying the SAME batch must not duplicate (upsert by id —
  // this exact retry used to 400/500 on PK conflict and wedge the outbox).
  const retry = await j(await fetch(`${base}/functions/v1/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(pushBody),
  }));
  ok("sync.idempotent_retry", retry.status === 200 && retry.body?.skipped === 0, `status=${retry.status}`);
  const rows = await j(await fetch(`${base}/rest/v1/attendance?select=id&id=eq.${attId}`, { headers: hs() }));
  ok("sync.attendance_single_row", rows.status === 200 && rows.body?.length === 1, `rows=${rows.body?.length}`);
  const salesRow = await j(await fetch(`${base}/rest/v1/sales?select=id&id=eq.${saleId}`, { headers: hs() }));
  ok("sync.sale_single_row", salesRow.status === 200 && salesRow.body?.length === 1, `rows=${salesRow.body?.length}`);

  // updates-check: public GET (verify_jwt=false), no auth header
  const upd = await j(await fetch(`${base}/functions/v1/updates-check?current=0.0.1&channel=stable`));
  ok("updates-check.public_get", upd.status === 200 && typeof upd.body?.update === "boolean", JSON.stringify(upd.body).slice(0, 150));
  ok("updates-check.app_update", upd.body?.update === true && typeof upd.body?.version === "string" && typeof upd.body?.url === "string", `version=${upd.body?.version}`);
  const tm = await j(await fetch(`${base}/functions/v1/updates-check?format=tauri&current=0.0.1&channel=stable`));
  ok("updates-check.tauri_manifest", tm.status === 200 && typeof tm.body?.version === "string" && typeof tm.body?.url === "string" && (tm.body?.signature ?? "").length > 100, `version=${tm.body?.version} sig_len=${(tm.body?.signature ?? "").length}`);
  const tn = await j(await fetch(`${base}/functions/v1/updates-check?format=tauri&current=9.9.9&channel=stable`));
  ok("updates-check.tauri_204", tn.status === 204, `status=${tn.status}`);

  // ── kill → remote_disabled ──
  await j(await fetch(`${base}/functions/v1/gym-admin`, {
    method: "POST", headers: h({ Authorization: `Bearer ${ceoTok}` }),
    body: JSON.stringify({ action: "set_disabled", gym_id: gymId, disabled: true, reason: "desktop-leg kill" }),
  }));
  const killed = await j(await fetch(`${base}/functions/v1/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ attendance: [], sales: [], members: [], heartbeat: true }),
  }));
  ok("sync.remote_disabled", killed.status === 200 && killed.body?.remote_disabled === true, JSON.stringify(killed.body).slice(0, 150));

  // ── revoke → sync also disabled ──
  await j(await fetch(`${base}/functions/v1/gym-admin`, {
    method: "POST", headers: h({ Authorization: `Bearer ${ceoTok}` }),
    body: JSON.stringify({ action: "set_disabled", gym_id: gymId, disabled: false, reason: "enable for revoke test" }),
  }));
  const licId = iss.body.license_id;
  await j(await fetch(`${base}/functions/v1/license-revoke`, {
    method: "POST", headers: h({ Authorization: `Bearer ${ceoTok}` }),
    body: JSON.stringify({ license_id: licId, reason: "desktop-leg revoke" }),
  }));
  const revoked = await j(await fetch(`${base}/functions/v1/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ attendance: [], sales: [], members: [], heartbeat: true }),
  }));
  ok("sync.revoked", revoked.status === 200 && revoked.body?.remote_disabled === true, JSON.stringify(revoked.body).slice(0, 150));

  // bad token → 401 (desktop would revoke)
  const bad = await j(await fetch(`${base}/functions/v1/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer GPOS-aaaa.bbbb` },
    body: JSON.stringify({ attendance: [], sales: [], members: [] }),
  }));
  ok("sync.bad_token_401", bad.status === 401, `status=${bad.status}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
