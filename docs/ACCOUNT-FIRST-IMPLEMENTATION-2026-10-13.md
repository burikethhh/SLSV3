# Account-first GymPOS 3.0.5 — implementation and release handoff

Date: 2026-10-13 (Asia/Manila). Source baseline: `a6e7aad`.
Codex: programmer/technical lead. Gemini: version-control/release coordinator.
The owner explicitly authorized deployment after passing release checks, and committing/pushing reviewed SLS changes. Unrelated firmware, hardware and scratch work is excluded.

## Current status

Migrations 0013–0016 and nine updated Edge Functions are deployed to `tlfytevjhzcgrttcdipq`.
The dashboard is READY on `https://sls.keth.website` and `https://sls-v3-web.vercel.app`.
Vercel deployment: `dpl_GNZ1fu4qmJbJ8Qf5UZtm4GjBtuZt`.
The existing updater key signed the matching 3.0.5 NSIS installer. Version 3.0.4 was published immutably, then its automatic rollout held at 0% when a final large-outbox review found that 100 face records can exceed the server's 512 KiB request cap. Version 3.0.5 adds byte-bounded requests, preserves deferred IDs/attempts, and isolates malformed/individually oversized records for quarantine instead of blocking valid rows. See final rollout record below.

Do not use or modify the portfolio apex domains. No installed GymPOS, live local SQLite database, physical controller, customer password or account was operated/reset for verification.

## Client and CEO process

1. Owner registers facility details and email/password, then verifies email. The nonprivileged facility draft is saved; resend/reset instructions are visible.
2. Verified setup creates facility, owner assignment and a 14-day trial atomically. Retries return the original trial without extending it.
3. Get Started presents the download/setup checklist. It refuses old or malformed installers; owner uses the same dashboard account in GymPOS, selects a named assigned facility, and names the terminal. No key pasting or cloud URL configuration.
4. Native account credentials use Windows Credential Manager (refresh credential only). Passwords are not saved; access JWTs stay in memory. Enrolled authenticator MFA is required. Managers cannot activate terminals.
5. Fresh owner authentication grants a temporary 15-minute setup operator session. Otherwise a staff username/PIN is required for POS and enrollment. Cashiers cannot manually unlock/admit, manage hardware, or install updates. Managers can; cached owner credentials do not grant an administrative operator session.
6. CEO reviews the facility separately from subscription activation. Approval alone grants no paid time. CEO records confirmed payment and reference to atomically issue a 30-day subscription. This is manual payment attestation, not payment-provider verification.
7. Native account refresh and visible dashboard subscription/fleet views poll with a 30-second pause after attempts. Network/backoff affects delivery time; this is not a 30-second SLA.
8. CEO can suspend a facility, revoke a subscription, or disable a named terminal. Confirmed denial locks ordinary operations; temporary network failures preserve only the bounded offline allowance.

The existing three-day grace (including trial grace) and seven-day verification allowance remain. Runtime checks enforce expiry/grace, selected gym, signed device identity, heartbeat and clock rollback. Emergency/free exit remains independent of commercial licensing.

## Security and correctness changes

- Native operational IPC fails closed without connected owner account, matching facility database and operable signed entitlement. Recognition produces a short-lived native admission ticket; arbitrary webview IDs/confidence cannot authorize entry.
- Facility databases live under `facilities/<gym UUID>/sls_local.sqlite`. Switching accounts/facilities resets operator/admission state and webview carts. A context lock and generation-cancelled singleton prevent old sync responses affecting another facility.
- Staff sessions last at most 30 minutes and validate current active identity/role/PIN hash on use. Deactivation, role/hash changes and expiry invalidate them. This is fixed lifetime, not an inactivity timer.
- Fresh authoritative account metadata drives database permissions. Enrolled MFA is enforced through RLS and privileged server functions, not only frontend routes. A browser authenticator challenge is implemented.
- CEO Accounts uses named facility checkboxes, paginated directory/lookup, verified targets and an atomic audited access RPC. Removing the last CEO is refused. Administrator-removed owners cannot regain privileges via onboarding.
- Dashboard managers are read-only for staff/catalog/pricing. Browsers cannot read staff PHC hashes or raw face vectors, forge attendance/sales contents, provision trials/paid entitlements, mutate terminals, or call account administration RPCs.
- Complete keyset-paginated pulls (500/page; guarded 50,000 maximum) cover roster, catalog, staff, promos and plans. Failure/overflow never pretends to be a complete snapshot.
- Incremental face changes use a server-time cursor. Deleted members are denied and lose local face data; pending local enrollments remain. Metadata/face/plan/cursor writes commit together. Invalid faces roll back the cursor.
- Enrollment requires a synced plan and atomically records its expiry, member and outbox payload. Re-uploading a face cannot reactivate a frozen member or extend an existing cloud expiry.
- Only explicit server rejection or a locally malformed/individually oversized row consumes outbox attempts; network failures and deferred byte-bound records do not. Quarantined rows and IDs are preserved.
- Owner reports aggregate all RLS-visible rows in PostgreSQL using Manila calendar days, signed refunds and line discounts. Native dashboard totals aggregate all local sales, not the displayed recent 20. Labels distinguish upload from settlement.
- Existing peso-entry/cent conversion and low-stock indicators are retained.
- Bootstrap is closed unless a verified intended administrator email is configured. Legacy live-account test harnesses are retired; they previously reset an existing CEO password/mutated live subscriptions.

## Existing terminal recovery — explicit, not automatic

1. Close the old app and retain its original database, WAL/SHM and face assets.
2. Sign into 3.0.5 with the owning account; select and verify the correct licensed facility.
3. Account & Help offers recovery only when legacy records exist. Confirm the facility.
4. Native recovery verifies all cached legacy token signatures and requires their gym identities to match. Missing/invalid/mixed ownership evidence is refused for manual review.
5. SQLite online backups preserve committed WAL data in private app-data `recovery/<UUID>/legacy.sqlite` and `facility-before.sqlite`.
6. Import is transactional, keeps original UUIDs/sales/outbox payloads and attempt counts, preserves authoritative lifecycle, and writes a durable one-time receipt. It refuses a destination that already has sales or pending rows.
7. It does not import old credentials, cloud settings or staff PIN cache. Fresh sync repopulates staff. Reauthenticate the operator after recovery. Verify counts/pending uploads before resuming the desk.

The original database remains read-only and is never pruned before recovery. Unknown/older schemas and ambiguous ownership need manual review. Quarantined records are preserved, not automatically replayed or discarded.

## Exact release checks and results

From repository root unless another directory is named:

| Command | Result |
| --- | --- |
| `cargo test` | 16 shared-core tests passed, doc tests passed |
| `cargo test --lib` in `desktop/src-tauri` | 3.0.5: 30 passed, 0 failed, 1 explicitly ignored interoperability fixture; includes byte-bound draining and malformed/oversize isolation |
| `node scripts/e2e/license-interop.mjs` | Separately ran that ignored test with an offline RSA-PSS fixture from the existing private key; 1 passed; no production writes or token output |
| `node scripts/e2e/account-lifecycle-db.mjs` with `SLS_TEST_DEPENDENCIES=%TEMP%/sls-account-lifecycle-tests` | All repository migrations applied to disposable PGlite; 31 scenarios passed |
| `node scripts/e2e/account-lifecycle-ui.mjs` | 15 isolated synthetic browser scenarios passed; no cloud writes or physical hardware |
| `npm exec -- tsc --noEmit -p tsconfig.json` in `web` | Exit 0, no diagnostics |
| `npm run build` in `web` | Vite 54 modules, exit 0 |
| `npm run build:exe` in `desktop`, with existing `TAURI_SIGNING_PRIVATE_KEY` path and empty password | 3.0.4: 4m20s; 3.0.5: 4m01s; webview 11 modules, NSIS installer and updater signature generated |
| `cargo run --manifest-path scripts/release-verifier/Cargo.toml --offline -- "desktop/src-tauri/target/release/bundle/nsis/SLS v3_3.0.5_x64-setup.exe" "desktop/src-tauri/target/release/bundle/nsis/SLS v3_3.0.5_x64-setup.exe.sig" "C:/Users/ketha/.tauri/sls-update.key.pub"` | Both versions verified against existing fleet key; in-memory one-byte modification rejected |
| `git diff --check` | Exit 0; CRLF warnings only |
| `node --check scripts/release-control.mjs` and the new JS harnesses | Exit 0 |

Deno exact checks (cache outside repo via `DENO_DIR=%TEMP%/sls-audit-20261013-deno`):

```powershell
deno lint --rules-exclude=no-import-prefix supabase/functions/_shared/assurance.ts supabase/functions/_shared/assurance.test.ts supabase/functions/_shared/snapshot.ts supabase/functions/_shared/snapshot.test.ts supabase/functions/_shared/entitlement.ts supabase/functions/_shared/entitlement.test.ts supabase/functions/owner-apply/index.ts supabase/functions/gym-admin/index.ts supabase/functions/license-fetch/index.ts supabase/functions/license-issue/index.ts supabase/functions/license-revoke/index.ts supabase/functions/user-admin/index.ts supabase/functions/staff-create/index.ts supabase/functions/sync/index.ts supabase/functions/bootstrap-ceo/index.ts
deno check --no-config --no-lock --node-modules-dir=none supabase/functions/owner-apply/index.ts supabase/functions/gym-admin/index.ts supabase/functions/license-fetch/index.ts supabase/functions/license-issue/index.ts supabase/functions/license-revoke/index.ts supabase/functions/user-admin/index.ts supabase/functions/staff-create/index.ts supabase/functions/sync/index.ts supabase/functions/bootstrap-ceo/index.ts
deno test --no-config --no-lock --node-modules-dir=none --allow-env=RSA_PRIVATE_KEY_PEM supabase/functions/_shared/entitlement.test.ts supabase/functions/_shared/snapshot.test.ts supabase/functions/_shared/assurance.test.ts
```

Results: lint 15 files; all function type checks passed; 5 tests passed. The web packages declare no lint/test npm scripts; type/build and the explicit regression harnesses were used.

UI artifacts: `C:/Users/ketha/AppData/Local/Temp/sls-account-ui-1791880765885`; all 15 scenarios passed with the 3.0.5 download fixture. First-run, CEO named assignments and mobile screenshots visually reviewed.

## Historical 3.0.4 installer and backup evidence

- Installer: `desktop/src-tauri/target/release/bundle/nsis/SLS v3_3.0.4_x64-setup.exe`; 25,162,418 bytes.
- Installer SHA256: `EAA1C71F2D71A63E4328ED375A5DC6726281B01984247EBCE0D18DC484DB7258`.
- Native EXE: `desktop/src-tauri/target/release/GymPOS.exe`; 38,192,128 bytes.
- EXE SHA256: `A2AA8B99E0DF2F97FC29E15FA4FB47D4F6139A854898FC7668AB8779C8269C00`.
- Updater signature verified; Windows Authenticode remains `NotSigned`. Do not imply Windows certificate/SmartScreen certification.
- Generated NSIS script includes both ONNX models and required MSVC/DirectML redistributables. The installer was not run against the user's installed/live terminal.
- Before migration, `node scripts/release-control.mjs backup` captured all 13 public business tables, three accounts' protected app metadata, function definitions, policies and grants in an ACL-restricted local directory:
  `C:/Users/ketha/AppData/Local/SLSReleaseBackups/20261013-042c9e71-05d8-4cb4-a6e3-5d1367f1d31e/pre-migration.json`.
- Backup SHA256: `fa52f8d2bb2c6bf96d1f4c82afb028b6fdeb7d5b5d5452feeac6ce77460916f5`. This is a consistent logical recovery snapshot, not a physical/auth-password/PITR backup. Supabase reported no available physical backups. Never commit or publish its contents.

## Production commands and observed state

- `supabase migration list --linked`: before rollout remote 0001–0012; after rollout 0001–0016 match.
- `supabase db push --linked --dry-run`: listed only 0013–0016; `supabase db push --linked --yes` applied those four successfully.
- `supabase functions deploy owner-apply gym-admin license-fetch license-issue license-revoke user-admin staff-create sync bootstrap-ceo --project-ref tlfytevjhzcgrttcdipq --use-api --jobs 4`: nine ACTIVE functions deployed; sync remains JWT-gateway-disabled with signed-device verification inside.
- `supabase config diff --project-ref tlfytevjhzcgrttcdipq` then `supabase config push --project-ref tlfytevjhzcgrttcdipq --yes`: changed ONLY the alternate SLS dashboard verification redirect; undeclared SMTP/Twilio settings remained untouched.
- `node scripts/release-control.mjs smoke`: seven anonymous privileged-function calls denied (401/403); anonymous account-admin RPC denied (401). Deployed RSA verifier accepts the offline/native key pair's signature but refuses its nonexistent license; sync denies that nonexistent facility/license. No business rows were created. Read-only SQL confirms no attendance insert/staff-hash select/account-admin execute privileges.
- Production business counts stayed at one facility, one license and one CEO; no member/sale/attendance/staff records were created by checks.
- Vercel first failed from `web` (hosted Root Directory is `web`). Root upload initially excluded its parent; corrected `.vercelignore` and used `vercel deploy --dry --json` to verify a web-only upload excluding credentials/firmware/builds.
- From repository root, `VERCEL_ORG_ID=team_VDAgUperPy830hX1OjNTZrrH`, `VERCEL_PROJECT_ID=prj_z7ghbXExN83509Z86Obza4VOoyd3`, `vercel --prod --yes`: READY; production aliases restricted to SLS/existing project aliases. No apex domain command was issued.
- Repo deploys from the root; do not run deployment from `web` or upload the full checkout without the allowlist.

## Remaining manual qualification / backlog

- Real verification-email delivery and full fresh-install/upgrade/native cloud sign-in need an owner-controlled test account/device. No customer account/password was reset or trial/paid billing changed to simulate tests.
- Supabase's verification-email limit is currently **2/hour** despite the local desired 60 setting. The CLI explicitly does not manage that property. An administrator must raise Auth → Rate limits → email-sent using the existing custom SMTP. SMTP transport remains configured; delivery was not exercised.
- Rotate any CEO password previously shared with the historical public test harness and enroll MFA; those harnesses are disabled and must not be restored as production smoke tests.
- Operator PIN visual redesign is deferred as requested. Quarantine inspection/retry workflow, PIN rotation/rate-lockout UX, mandatory CEO MFA enrollment, per-role cloud session-lifetime policy, large-scale concurrency/load tests and broader visual polish remain follow-up work.
- Do a supervised RFID/camera/controller/free-egress bench check before opening a real gate. Software tests and the signed updater are not hardware or Windows certificate certification.
- Do not restore old manual-key activation, unrestricted native Settings, capped member pulls, historical browser write permissions or silent update installs.
- Rollback is coordinated: use retained backup/previous installer and restore compatible server contracts only after reviewing tenant permissions and pending-record ownership. Never simply revert migrations or re-upload an older mutable installer.

## Final rollout record

Account-first source commit `4c3ca1f1a180a68f5ebb62f6e6ffee5c613c47d6` was pushed atomically to origin/master and origin/main (both started at the same baseline). Immutable GitHub 3.0.4 release was published, its downloaded installer hash and feed signature matched, and current-version requests returned HTTP 204. A final audit then found byte-overflow risk in bulk pending enrollment, so `node scripts/release-control.mjs hold` set only 3.0.4 rollout to 0%; public updater requests correctly returned 204.

Version 3.0.5 is built with the byte-bounded fix and 30 passing native tests; offline RSA interoperability and all 15 UI tests passed again. Installer signature and tamper rejection passed again.

- Patch source commit `4be75dc3074901983d98fcaaabc8b5d2ddfd53b2` was pushed atomically to origin/master and origin/main. `git ls-remote origin refs/tags/v3.0.5` resolves to that exact commit.
- `gh release create v3.0.5 <installer> <signature> --repo burikethhh/SLSV3 --target 4be75dc3074901983d98fcaaabc8b5d2ddfd53b2 --draft` uploaded the two verified artifacts. Both GitHub asset digests/lengths match local evidence. `gh release edit v3.0.5 --repo burikethhh/SLSV3 --draft=false --latest` published them without changing 3.0.4 assets.
- [Published 3.0.5 release](https://github.com/burikethhh/SLSV3/releases/tag/v3.0.5) · [installer](https://github.com/burikethhh/SLSV3/releases/download/v3.0.5/SLS.v3_3.0.5_x64-setup.exe).
- With `SLS_PUBLISH_RELEASE=3.0.5`, `node scripts/release-control.mjs feed` downloaded and SHA256-verified the public installer before inserting its stable release row (rollout 100%, matching minisign). 3.0.4's rollout remains 0%.
- Public `updates-check?format=tauri&current=3.0.3&channel=stable` and `current=3.0.4` returned HTTP 200 with exact 3.0.5 version, download URL and local verified signature. `current=3.0.5` returned HTTP 204.
- Both SLS dashboard aliases returned HTTP 200 with the matching `index-C7cfat_J.js` production bundle. Supabase migration list matches through 0016. Unrelated firmware/scratch changes remain uncommitted and untouched.
- Historical live-test implementations remain recoverable from Git baseline `a6e7aad`; their current stubs cannot reset passwords or mutate billing. Test servers are stopped after validation.

- 3.0.5 installer: 25,171,241 bytes; SHA256 `911F9FBDED637734823C181759A1FABA16DFC4D9D612E2B750A1ECE6B828F1FF`.
- 3.0.5 updater-signature file SHA256: `64069A8B58A505F5DE7ABB9207BED44DB69E82751AA10871EE9874468FF3F1F1`.
- 3.0.5 EXE: 38,203,392 bytes; SHA256 `6234D2DFEFA4CD98C15E80E6537590CBE0B6604CC388ACA245C784AEFEA63948`.

Gemini must preserve unrelated hardware/firmware/scratch files, keep secrets/models/builds/backups out of Git, and use the published tag's matching source. No published binary or signing key was overwritten or rotated.
