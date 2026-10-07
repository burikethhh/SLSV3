# Handover — SoloLeveling (SLS v3) → Gemini

Date: 2026-10-04. Previous assistant: HORMACHUELOS (code agent). Next: Gemini.

## 1. What this project is

SoloLeveling (SLS v3) = anime-styled gym system:
- `web/` — Vite SPA dashboards (CEO / owner). Canonical URL: `https://sls.keth.website`.
  NEVER bind `keth.website` or `www.keth.website` to this project (reserved for portfolio).
- `desktop/` — Tauri v2 gate terminal (GymPOS.exe) + `desktop/webview/` counter UI (gate, POS, members, dash, settings).
- `desktop/src-tauri/` — Rust brain (face check, sync, license, gate hardware). Excluded from Cargo workspace.
- `crates/sls-core/` — shared rules (license, POS cents, face types).
- `supabase/` — 7 migrations (0001–0007) + 9 Edge Functions.
- `hardware/` — ESP32 gate lock (`UNLOCK / LOCK / DENY / BEEP`).

## 2. Recent commits (all on disk, work tree clean except `.hormachuelos/`)

```
f12a43e Note SMTP rate-limit raise (dashboard-managed setting)
e34fc7e Switch cloud target to new Supabase project tlfytevjhzcgrttcdipq
906eedf Domain rule: keep keth.website off SoloLeveling, use sls.keth.website only
304056f GymPOS exe 3.0.3: gate offline badge + sync pending, POS stock guard, members fix, retention prune
afc49d3 Web dashboard + auth/accounting hardening, gate/POS webview refresh
fce94ec SLS v3: Tauri gate terminal, web dashboards, Supabase BaaS
```

## 3. What was done this session

1. **Web dashboard hardening** — route guards, `viewToken` anti-race, XSS `esc()` helper, sale/refund/void status, `pay_method` allow-list, CEO vs POS revenue labels.
2. **GymPOS exe 3.0.3** — built + signed (`SLS v3_3.0.3_x64-setup.exe` + `.sig` match, Oct 1 11:38 PM). Gate offline badge, POS stock guard, member fixes. Version bumped in `tauri.conf.json`, `desktop/package.json`, `Cargo.toml`.
3. **Cloud switch** — old project `cjxpsiuvwihanxqccpnf` → new project `tlfytevjhzcgrttcdipq`.
   Files rewritten: `web/.env`, `desktop/webview/settings.js`, `desktop/src-tauri/tauri.conf.json` (updater URL), `scripts/e2e/*.mjs` (3 files), `supabase/config.toml`, `docs/REUSE.md`.
4. **Database** — `supabase db push` done: migrations 0001–0007 live, incl. `0006_ceo_bypass.sql` (CEO reads `branch_overrides` + `coaches`) and `0007_auth_accounting.sql` (sales.status, pay-method check, blocks owner null-gym inserts).
5. **Edge Functions** — all 9 deployed and ACTIVE: sync, updates-check, license-issue, license-verify, license-revoke, gym-admin, user-admin, staff-create, bootstrap-ceo. `sync` + `updates-check` re-patched to `verify_jwt=false` (terminals get 401 otherwise). RSA public+private secrets set on new project.
6. **Resend SMTP** — domain `sls.keth.website` added in Resend, 3 DNS records (MX + SPF TXT + DKIM TXT under `send.sls` / `resend._domainkey.sls`) added via `vercel dns`, status now **Verified** in Resend. Supabase SMTP box NOT yet filled (dashboard-only).

## 4. What is LEFT (Gemini: start here)

- [x] **Supabase SMTP** — custom SMTP enabled on `tlfytevjhzcgrttcdipq` with Resend (`smtp.resend.com:465`, sender `noreply@sls.keth.website`, name `SLS`).
- [x] **Raise email rate limit** — Auth → Configuration → Rate limits → Emails sent raised to 60/hr.
- [x] **Vercel project environment & live deployment** — Vercel project env vars updated to `https://tlfytevjhzcgrttcdipq.supabase.co` and new anon key; `sls.keth.website` verified running new project.
- [ ] **Rotate exposed keys** — delete exposed Resend key, rotate `service_role` in Settings → API if not yet done.
- [ ] **Verify live** — test signup mail arrives, no 429 in Auth Logs; smoke-test exe 3.0.3 install (gate, POS, sync).

## 5. Key commands

```powershell
supabase link --project-ref tlfytevjhzcgrttcdipq
supabase db push
foreach ($fn in @('sync','updates-check','license-issue','license-verify','license-revoke','gym-admin','user-admin','staff-create','bootstrap-ceo')) { supabase functions deploy $fn }
# re-patch public fns to verify_jwt=false via Management API after every deploy
cd B:\Projects\SoloLeveling\web; npm run build
cd B:\Projects\SoloLeveling\desktop; npm run build:exe
```

## 6. Runbooks

- Deploy notes, key rotation, updater signing, e2e harness: `docs/REUSE.md` (long, read it).
- Design rules (look-and-feel only): `DESIGN-HANDOFF.md`.
- Project rules: `AGENTS.md`.

## 7. Warnings for Gemini

- Never print secrets. Never commit `.env`, keys, `node_modules`. RSA PEMs in `supabase/` are gitignored — keep them out of chat.
- `rate_limit_email_sent` can only be raised AFTER custom SMTP exists (API 400s otherwise).
- After ANY exe rebuild, re-upload exe AND update the `releases` row `sig` (per-binary signatures).
- Signing key at `%USERPROFILE%\.tauri\sls-update.key` — never lose, never commit.
- Signing-key env for builds: `$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\sls-update.key"`.
