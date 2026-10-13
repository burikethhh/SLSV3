# Recycled → v3 map (orig `SLSNIKETH` → SLS v3 production tree)

## Current account-first implementation (2026-10-13)

Read [Account-first implementation and Gemini release handoff](ACCOUNT-FIRST-IMPLEMENTATION-2026-10-13.md) before using the historical activation instructions below. The local 3.0.4 source uses owner-account sign-in, explicit facility selection, registered terminals, and automatic subscription refresh. Manual key/cloud-URL setup and `boot_license` descriptions below are historical. CEO facility approval no longer issues a paid subscription: recorded payment confirmation is a separate action.

Migrations 0013–0016 and matching functions/dashboard are deployed. GymPOS 3.0.4 has a verified signed updater installer. Live-terminal upgrades require the explicit backed-up recovery procedure in the handoff. The owner authorized Codex to complete rollout and commit/push reviewed application changes; staff PIN visual redesign and listed qualification/backlog items remain open.

Source snapshot: `C:\Users\ketha\AppData\Local\Temp\opencode\SLSNIKETH-orig`
Each entry: what was kept verbatim-adapted, what was slimmed/dropped, and why.

## Core (`crates/sls-core`)

| Orig | v3 | Kept | Dropped |
|---|---|---|---|
| `shared/src/lib.rs` Password/PIN hashing | `src/auth.rs` | Argon2id + legacy SHA256 fallback + `password_is_legacy` upgrade signal (1:1, staff PINs stay compatible) | — |
| `shared/src/lib.rs` LicenseClaims/Tier/evaluate | `src/license.rs` | Tier caps 200/500/1000, $99/199/349, `exp_unix`/`grace_until` mirrors, `expiry_unix`/`grace_unix`, 3-day `evaluate()` → rich `LicenseStatus::Valid/GracePeriod/Expired/Invalid/Unlicensed` + `is_operable` | `tailgate_detection_enabled` (no tailgate cam) |
| `cloud/src/crypto.rs` sign/verify | `src/license.rs::split_token` + `desktop/.../license_verify.rs` | `GPOS-<b64url>.<b64url>` format, whitespace-strip, PSS-SHA256 fail-closed verify | `LicenseSigner` private-key holder (lives in Supabase Edge fn vault, not in repo); HMAC session tokens (Supabase Auth replaces CEO/owner `ceo:` strings) |
| `desktop/.../face.rs` quality/normalize | `src/face.rs::l2_normalize/vector_quality/min_quality_for_dim/probe_passes_quality_gate` | NaN/Inf-zeroing normalize, std-based quality, dim-scaled gate `1.7/sqrt(d)` (0.15 @128, ~0.075 @512) | HNSW index + centroid + multi-angle + EMA adapt + drift guard (re-add after roster >2000 or adapt proven on EdgeFace-512) |
| `desktop/.../commands.rs::checkout_pos_sale` discount path | `src/pos.rs::apply_pct_discount` | Whole-cart `discount_pct` semantics, re-implemented in integer cents (half-up rounding, clamped) | `f64 price` floats (v3 `Money=i64` everywhere), per-line float discounts |
| `cloud/src/rate_limit.rs` | `supabase/functions/_shared/rateLimit.ts` | Fixed-window `check/reset`, 429+`Retry-After`+`RATE_LIMITED` body, same limits (5/15min CEO, 8/10min owner, 5/hr register, success resets) | Axum types, `client_ip` XFF helper (platform provides it), periodic `cleanup` (isolate-local Map; use DB table for strict multi-instance) |

## Desktop (`desktop/src-tauri/src`)

| Orig | v3 | Kept | Dropped |
|---|---|---|---|
| `license.rs` HWID + heartbeat + manager | `license_verify.rs` | HWID anchors (MachineGuid/disk/MAC/hostname → sorted sha256[:32]), `HEARTBEAT_SECONDS=7d`, `TAMPER_GRACE_SECONDS=60s`, key fingerprint, hard-fail HW lock, UNLICENSED start | `winreg`/`machine-uid` crates (reg-query via std), `tracing`, demo-license, tailgate claim fields; **must paste production public key** |
| `hardware.rs` serial manager | `hw_serial.rs` (feature `hardware-serial`) | VID whitelist (0403/10C4/1A86/303A) + scoring, DTR-safe connect, PING best-effort (silence OK), 3x-retry send + auto-clear, `unlock_door`/`deny`/`grant_entry`, 16-deep EVT queue | Exit-lane (`grant_exit` retired), LCD brand screen, tailgate alarm cmds |
| `sync.rs` cloud worker | `sync_worker.rs` (feature `cloud-sync`) + `supabase/functions/sync` | Backoff 5/15/30/60s, idle poll every 6th tick (~30s), revoke on 401/403 or `remote_disabled`, heartbeat refresh, outbox push (attendance/sale/member) + catalog pull | Axum `/sync/push` server (replaced by Edge Fn with service_role writes) |
| `db.rs` schema/unsynced getters | `db.rs` (+ `supabase/migrations/0001_init.sql`) | Table names mirrored (members/attendance/products/sales/outbox/license_cache), 3s anti-passback cooldown, outbox insert on checkin | Interbranch, FTS, staff/terminal tables (re-add per need) |
| `face.rs` store | `face_store.rs` (+ `sls-core::face`) | Cosine match + threshold + cooldown contract | HNSW/centroid/multi-angle (see above) |

## Firmware (`hardware/`)

| Orig v1.2.2 (770 lines) | v3 `src/main.cpp` | Kept | Dropped |
|---|---|---|---|
| Full controller | Single-gate subset | `WELCOME:<name>\|<secs>`, `BYE` (compat), `UNLOCK[:secs]`, `LOCK`, `DENY[:reason]`, `BEEP`/`BEEP_LONG`, `PING`→`ACK:PONG`, `STATUS`, `VERSION`, `READY:fw=`, `ACK:RELOCK`, GPIO3 active-LOW + buzzer IO10, 115200 | `ALERT_TAILGATE`/`ALARM`, LCD/I2C + icons, `IDLE`/NVS brand, `LCD_*`, `FINDRELAY`/`STOPRELAY`, watchdog (re-add with LCD) |

## Explicitly NOT recycled (heavy / retired)
- `cloud/` Axum server (replaced by Supabase), `tract-onnx` + SFace/ArcFace models (replaced by YuNet + EdgeFace-XXS via `ort`), 3-camera + 3-angle pipeline, `app.js` 201KB monolith + vendored Tailwind 2.8MB (replaced by code-split Vite), 50 bundled icons, dual lockfiles in default build.

## Production TODOs
1. ~~License signing~~ — done: production RSA-2048 keypair generated 2026-09-24; public PEM pasted into
   `EMBEDDED_PUBLIC_KEY_PEM`; private half at `supabase/RSA_PRIVATE_KEY_PEM.txt` (gitignored) for
   `supabase secrets set RSA_PRIVATE_KEY_PEM=…`. Roundtrip test `license_sign_verify_roundtrip` passes.
2. ~~Supabase Auth + rate limits~~ — done: dashboard uses Supabase Auth; `rateLimit.ts` in EVERY fn
   (sync 300/min, updates-check 60/h, license-verify 60/h, issue/revoke 30/h, gym-admin 60/h,
   user-admin 30/h, staff-create 60/h, bootstrap-ceo 5/h — all per platform-set IP).
3. ~~Sync ingest~~ — done: `sync` Edge Fn is idempotent (upserts by client uuid + offline
   `created_at`, caps 500/512KiB, fail-closed kill-switch on missing rows, rate-limited) and pulls
   `products` + `product_ids` (delete-reconcile) + `staff` (terminal PIN cache). Desktop
   `sync_worker` (feature `cloud-sync`): backoff/idle-poll, exits on revoke, per-row
   acknowledgements; failed rows quarantine locally after 10 attempts (never silently deleted).
   Heartbeat only on 2xx (7-day boot enforcement).
4. Collect gym faces → tune EdgeFace threshold from 0.40 (never reuse SFace 0.62); re-add HNSW/adapt only with data.
5. Updater signature: paste CI minisign `.sig` into the Releases dashboard row — `updates-check`
   returns it as `signature` (desktop `update_check` shows the download link today; full
   tauri-plugin-updater auto-install is backlog).
6. ~~Staff PIN fixture~~ — done: hash-wasm PHC fixture in `sls-core::auth::tests`.
7. ~~Desktop license/settings UI~~ — done: Settings view (`license_apply`/`license_status`/`settings_*`), Members enroll, local Dashboard; sync + license resume from cache on boot (`boot_license`).
8. ~~Packaged-exe blockers~~ — done 2026-09-27: app-data SQLite, models+CRT+DirectML bundled,
   hardware auto-connect supervisor, release feature set, Tauri CLI wiring (`desktop/package.json`).

## Dashboard deploy — Vercel (2026-09-25)
Project `sls-v3-web` under `christiankethaguacito-codes-projects` · CLI logged in.
- **Production:** https://sls.keth.website (SLS v3 dashboard; root `keth.website` reserved for portfolio)
- **Inspect:** https://vercel.com/christiankethaguacito-codes-projects/sls-v3-web
- Config: `web/vercel.json` (vite build → `dist`, SPA rewrite, immutable `/assets` cache)
- Env (Config type, production + preview): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon is public by design)
```powershell
$vc = "$env:APPDATA\npm\vercel.cmd"
Set-Location B:\Projects\SoloLeveling\web
& $vc deploy --prod --yes
```
- All 9 Edge Fns import `serve` from `_shared/cors.ts` (OPTIONS 204 + `Access-Control-Allow-Origin: *`);
  PostgREST/Auth already echo Origin. Redeploy fns after editing CORS.

## Desktop exe — GymPOS NSIS build (2026-09-27)
```powershell
cd B:\Projects\SoloLeveling\desktop
npm install            # once: installs @tauri-apps/cli
npm run build:exe      # vite webview build + cargo release + NSIS bundle
```
Output: `desktop/src-tauri/target/release/GymPOS.exe` (portable) and
`.../bundle/nsis/SLS v3_3.0.0_x64-setup.exe` (~21 MiB installer).
- **Default cargo features = full gate flavor** (`face-ort,hardware-serial,cloud-sync`);
  `--no-default-features` builds a shell that degrades with visible errors (gate shows
  feature-off state, door line shows controller state via `hw_status`).
- SQLite lives in `%APPDATA%\com.sls.v3\sls_local.sqlite` (`db::init_data_dir` from Tauri
  `setup` — NSIS launches with CWD=System32, relative paths die there).
- License restores from cache on every boot (`boot_license`, works without `cloud-sync`);
  sync worker resumes when URL+token cached.
- ONNX models + VC CRT + DirectML ship in the installer: `bundle.resources` maps
  `../models/ → resources/models/` and `redist/ → ""` (exe-dir). `redist/` holds
  Microsoft.VC143.CRT DLLs (from `VC\Redist\MSVC\<ver>\x64\Microsoft.VC143.CRT`) +
  `DirectML.dll` — without them the exe won't launch on a clean gym PC (hard imports).
- Hardware supervisor auto-connects the VID-scored ESP32 at boot and reconnects ≤5s after
  a drop (`spawn_hw_supervisor`); gate UI polls `hw_status` every ~5s.
- Release profile lives in `desktop/src-tauri/Cargo.toml` (root workspace excludes it):
  `opt-level 3, codegen-units 1, lto, strip`.

## Supabase deploy — done (2026-09-24, 0005 added 2026-09-27)
Project ref `tlfytevjhzcgrttcdipq` · CLI 2.117.0 · secrets + `db push` (0001–0005) + 9 Edge Fns deployed.
`sync` AND `updates-check` have `verify_jwt=false` (sync auth = GPOS license token; updates-check is a
public desktop GET with in-fn rate limit; both pinned in `supabase/config.toml`).
**All other fns must stay `verify_jwt=true`** — a `functions deploy` without the flag flips the
deployed flag (happened to `user-admin` on 09-27; re-patch with the API snippet below).
```powershell
# Redeploy later (already logged in + linked)
$sa = "$env:APPDATA\npm\supabase.cmd"
& $sa db push
foreach ($fn in @('sync','updates-check','license-issue','license-verify','license-revoke','license-fetch','owner-apply','gym-admin','user-admin','staff-create','bootstrap-ceo')) {
  & $sa functions deploy $fn
}
# Apply migrations 0010–0012 and deploy the new sync Edge Function before
# distributing the updated GymPOS exe. Old sync responses lack accepted_ids;
# updated terminals deliberately retain their outbox until server deploy.
# deploy resets verify_jwt=true — re-patch the two public fns (terminals get 401 otherwise):
# foreach ($fn in @('sync','updates-check')) {
#   Invoke-RestMethod -Method Patch "https://api.supabase.com/v1/projects/tlfytevjhzcgrttcdipq/functions/$fn" `
#     -Headers @{Authorization="Bearer $PAT"} -Body '{"verify_jwt":false}' -ContentType "application/json"
# }
# Rotate license key: edit supabase/RSA_PRIVATE_KEY_PEM.txt then set BOTH PEM secrets
# via --env-file (PowerShell multiline args get truncated; env-file is one NAME=VALUE
# line with literal \n escapes — licenseCrypto.pemToDer normalizes them):
$priv = [IO.File]::ReadAllText("supabase\RSA_PRIVATE_KEY_PEM.txt").Trim() -replace "`r`n","`n" -replace "`n",'\n'
$pub  = [IO.File]::ReadAllText("supabase\RSA_PUBLIC_KEY_PEM.txt").Trim()  -replace "`r`n","`n" -replace "`n",'\n'
@("RSA_PRIVATE_KEY_PEM=$priv","RSA_PUBLIC_KEY_PEM=$pub") | Set-Content "$env:TEMP\rsa.env" -Encoding ascii
& $sa secrets set --env-file "$env:TEMP\rsa.env"
# Production key interop test (Edge-fn token → desktop embedded pubkey):
# $env:TEST_LICENSE_TOKEN='GPOS-…'; cargo test production_token -- --nocapture
```

## E2E harness key (2026-09-27)
`e2e-*.mjs` need `SUPABASE_SERVICE_ROLE_KEY` env. Use the **legacy** service_role
JWT from the api-keys list — a freshly POSTed `{"type":"secret"}` key (`sb_secret_…`)
is rejected by `/auth/v1/admin` with `Invalid API key`:
```powershell
$pat = "sbp_…"; $ref = "tlfytevjhzcgrttcdipq"
$list = Invoke-RestMethod -Headers @{Authorization="Bearer $pat"} "https://api.supabase.com/v1/projects/$ref/api-keys"
$env:SUPABASE_SERVICE_ROLE_KEY = ($list | Where-Object { $_.type -eq "legacy" -and $_.name -eq "service_role" }).api_key
node scripts\e2e\e2e-license.mjs   # 26 checks
node scripts\e2e\e2e-fixes.mjs      # 15 checks (needs the env key)
node scripts\e2e\e2e-desktop.mjs    # 14 checks (runs cargo test too)
```

## Auto-update pipeline (2026-09-28, v3.0.1+)
Terminals self-update: boot task (30s delay, never blocks boot) checks
`updates-check?format=tauri`, downloads + installs via tauri-plugin-updater
(passive NSIS, no interaction), records `pending_restart` in SQLite; gate +
settings views show a restart banner → `restart_app`. Manual path: Settings →
Check → Download & install → Restart. Offline failures only log.
- **Signing key:** `%USERPROFILE%\.tauri\sls-update.key` (+`.pub`), generated via
  `npx tauri signer generate -w <path> --ci` (passwordless). **NEVER lose it,
  NEVER commit it** — rotation orphans installed terminals (old pubkey baked
  into their `tauri.conf.json` can't verify new signatures; fleet-wide manual
  reinstall). Pubkey lives in `desktop/src-tauri/tauri.conf.json` → `plugins.updater`.
- **Release build (signing happens automatically):**
  ```powershell
  $env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\sls-update.key"
  cd B:\Projects\SoloLeveling\desktop; npm run build:exe   # + .sig next to the setup exe
  ```
- **Publish:** upload `SLS v3_<ver>_x64-setup.exe` to the public `releases`
  Storage bucket (service_role), then insert/update the `releases` row
  (version/channel/rollout_pct/download_url/notes/**sig** = `.sig` content).
  `updates-check` serves the Tauri manifest (`?format=tauri`) or 204; the app
  shape is unchanged for the Settings button.
- **Footguns:** `tokio::spawn` in Tauri `setup` panics (exit 101, no runtime yet)
  — always `tauri::async_runtime::spawn`. After ANY rebuild, re-upload the exe
  AND update the row's `sig` (signatures are per-binary). `rate_limit_email_sent`
  can only be raised once custom SMTP exists (API 400s otherwise).
- **Harness passwords:** all three `scripts/e2e/*.mjs` share `E2ePassw0rd!xyz`
  and the pinned `ceo.e2e.1790267997223` / `owner.e2e.1790507038514` accounts
  (e2e-desktop resets the CEO pw each run — keep them in sync).

## Domain `sls.keth.website` — Vercel DNS (2026-09-28)
The SLS dashboard is bound only to `sls.keth.website` and the Vercel deployment URL.
The apex `keth.website` and `www.keth.website` belong exclusively to the personal portfolio
and must never be added to this project:
```powershell
$vc = "$env:APPDATA\npm\vercel.cmd"
Set-Location B:\Projects\SoloLeveling\web
& $vc domains add sls.keth.website sls-v3-web    # canonical app URL
# future projects: & $vc domains add <sub>.keth.website <project-name>
```
- Supabase auth now: `site_url=https://sls.keth.website` (+ old vercel alias & `http://localhost:5173/*` allowed).
- **`uri_allow_list` API quirk:** the management API strips space/newline separators (and won't
  accept an array), so only a **single** pattern survives intact — currently `http://localhost:5173/*`.
  Everything else falls back to `site_url` (evil URLs too — safe, they never leak). Multi-entry
  lists must be set via the dashboard if ever needed.
- **`rate_limit_email_sent` is stuck at 2 until custom SMTP exists** (PATCH → 400
  "Custom SMTP required…"); once SMTP is configured, raise it (e.g. 60). Without SMTP, public
  sign-ups 429 when the window is spent — CEO-created accounts unaffected.

