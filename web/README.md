# SLS v3 web dashboard — run + wiring

Single Vite SPA (`web/`), RBAC `/ceo/*` + `/owner/*`. Staff stays terminal-PIN only.

## Run

```powershell
cd web
npm install
$env:VITE_SUPABASE_URL="https://xyz.supabase.co"
$env:VITE_SUPABASE_ANON_KEY="..."
npm run dev     # http://localhost:5173
npm run build   # dist/ → Vercel / Render static / any static host
```

Then: `supabase db push` (applies `0001_init.sql` … `0005_dashboard_fixes.sql`).

## What works now (Supabase-backed skeletons)

- Auth: sign in/up via Supabase Auth; router guards CEO-only and owner(+CEO) routes; JWT
  `app_metadata { role, gym_ids }` drives scoping (`myGymIds`: CEO=null unscoped).
- CEO: overview (MRR view + counts), fleet (filter + kill toggle w/ confirm + audit row),
  Key Vault (masked list + revoke w/ audit + issue via `license-issue` Edge Function),
  releases publish/list, audit log table.
- Owner: overview (sales total + 2h-block check-in bars, no chart lib), keys status,
  catalog CRUD (debounced search, LIMIT 50), plans/promos add + list, live sales feed
  (Realtime INSERT → reload, unsubscribe on leave), staff list + KPIs + add (PIN format-checked).
- Public: `#/verify-license` posts the token to the `license-verify` Edge Function.

## Status (wired)

1. ~~`app_metadata` claims~~ — `bootstrap-ceo` grants the first CEO; RLS in `0003_rls.sql`
   (`current_role()`/`my_gym_ids()`, per-`gym_id` policies, public-read `releases`).
2. ~~`license-issue` signing~~ — full RSA-PSS/SHA-256/salt32 signer (interop-verified
   against the `rsa` crate default); `license-verify` checks sig + revoked + expiry/grace.
   Roundtrip-test sign→desktop-verify after any rotation (Rust test in
   `desktop/src-tauri/src/license_verify.rs::license_sign_verify_roundtrip`).
3. ~~Server-side staff PIN hashing~~ — `staff-create` (hash-wasm argon2id m=19456,t=2,p=1,
   matches `sls-core::auth`); dashboard posts PIN over TLS, never stores plaintext.
4. ~~Kill-switch e2e~~ — `sync` Edge Fn (license-token auth) returns `remote_disabled`
   when `gyms.disabled`/`licenses.revoked`; desktop `sync_worker` (backoff 5/15/30/60s,
   idle poll ~30s) revokes local license + clears cache → gate locks. Unit-tested
   (`should_revoke`, `backoff_secs`, `should_idle_poll`).
5. ~~Realtime scoping + visible-tab polling~~ — owner `sales-feed` channel filtered by
   `gym_id=in.(...)`; overview polls every 60s only while the tab is visible
   (`pollVisible` in `web/src/ui.ts`).
6. ~~Update manifest~~ — `updates-check` Edge Fn (public GET, rate-limited) serves
   version/channel/rollout from `releases` (deterministic rollout bucket via
   hash(current)%100) plus `signature` from the `releases.sig` row; consumed by the
   desktop `update_check` command (Settings shows the download link).

## Still to wire before production

- **Updater signing**: CI minisign key (`TAURI_SIGNING_PRIVATE_KEY`) → paste `.sig`
  into the Releases dashboard row; then (backlog) swap the desktop link flow for
  `tauri-plugin-updater` auto-install.
- **Auth for self-signup**: `mailer_autoconfirm=false` without SMTP means new
  sign-ups need manual confirm — decide autoconfirm for MVP or configure SMTP.
- **License roundtrip** with a real issued key already runs in E2E
  (`e2e-license.mjs`, 26 checks) + Rust `production_token_verifies_with_embedded_key`.
