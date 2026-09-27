# SLS v3 Architecture (final)

Lightweight rebuild of SLSNIKETH v2. Goals (from your answers):
1. Slim Tauri v2, **single camera gate-IN only**, optimize all compute incl. POS.
2. **Level-up face**: YuNet detect + EdgeFace recognize via `ort`/DirectML + **auto-brightness**.
3. **Supabase BaaS** replaces Axum cloud. Offline-first via local SQLite outbox.
4. MVP: Licensing + Access core + Dashboards + POS. ✅ shipped.

## Face engine
- v2: SFace-2021 128-d 36.9MB (~99.4% LFW) + ArcFace 13MB dead + `tract` CPU-only.
- v3: **YuNet 200KB + EdgeFace-XXS 4.9MB 512-d (LFW 99.57%, ~2ms/face)**.
  EdgeFace won IJCB'23 compact track; UniFace 2026 bench: fastest of 6 families,
  keeps most of AdaFace-IR101 margin at 1/50 size.
- Runtime: **`ort` (ONNX Runtime)** — DirectML EP on Windows, CPU fallback,
  I/O binding (no per-frame alloc), ~40% faster than tract on same CNNs.
  No pure-Rust fallback is shipped.
- Thresholds are per-model: start **0.40** for EdgeFace-512, validate FAR/FRR on gym data.
- Licensing note: EdgeFace/ArcFace weights derive from WebFace/MS1M research-only
  lineages — confirm commercial terms for production.

## Auto-brightness
`sls-core::brightness` — `assess(mean_luma) -> Exposure{verdict, …}` with verdicts
`TooDark / Good / TooBright / Unusable`, `gamma_for(mean_luma)` toward ~110 target.
`brightness_pipe::decide_frame` (face-ort) applies gamma + CLAHE-lite to the 112×112
crop pre-embedding; kiosk shows the live verdict and rejects Unusable frames.

## Database (single schema, `supabase/migrations/`)
- `0001_init.sql` — gyms, licenses, members, attendance (in-only), products,
  sales (cents), coaches, audit_logs. RLS per `gym_id`.
- `0002_dashboards.sql` — plans, promos, branch_overrides, **staff** (Argon2id
  `pin_hash`, unique(gym_id, username)), releases, `fleet_mrr` view, `gyms.disabled`.
- `0003_rls.sql` — RLS for owner/manager/ceo JWT roles + realtime publication.
- `0004_license_dashboard.sql` — license accounting columns, audit meta, MRR helpers.
- `0005_dashboard_fixes.sql` — realtime publication includes `sales`, CEO
  `releases` policies, `releases.sig` column (minisign).

## Edge Functions (`supabase/functions/`, all CORS-wrapped via `_shared/cors.ts`)

| fn | auth | rate (/IP) | contract |
|---|---|---|---|
| `sync` | **GPOS license token** (`verify_jwt=false`) | 300/min | POST push+pull, see below |
| `license-issue` | CEO JWT | 30/h | sign `GPOS-<claims>.<sig>`, creates gym row if asked |
| `license-verify` | public JWT | 60/h | POST `{token}` → `{valid, status, tier, …}`; row = truth |
| `license-revoke` | CEO JWT | 30/h | POST `{license_id, reason}` → audit |
| `gym-admin` | CEO JWT | 60/h | `create` / `set_disabled` (404 on missing, bool strict) |
| `user-admin` | CEO JWT | 30/h | `list` / grant `{email, role, gym_ids}` / `role:null` demote |
| `staff-create` | owner/CEO JWT | 60/h | hashes PIN (hash-wasm Argon2id = sls-core params), audit |
| `bootstrap-ceo` | any valid JWT | 5/h | first user gets `role=ceo`, one-shot, audit |
| `updates-check` | **public GET** (`verify_jwt=false`) | 60/h | `{current, update, version, pub_date, url, notes, signature}` |

Shared: `_shared/rateLimit.ts` (fixed window, platform-set `x-forwarded-for`),
`_shared/licenseCrypto.ts` (RSA-2048 PSS, salt 32), `cors.ts` (generic 500s,
`GET, POST, OPTIONS`). Postgres errors are logged server-side, never echoed.

### Sync contract (desktop `sync_worker` ↔ `sync` fn)
- **Auth**: raw `GPOS-…` token re-verified per request (fail-closed).
- **Push** `{attendance[], sales[], members[]}` — client-supplied uuid `id` +
  `created_at` (offline timestamps); server **upserts by id** so a retry after a
  lost response can't duplicate. Caps: 500/array, 512 KiB body.
- **Pull** `{products[≤500], product_ids[≤5000], staff[≤100], server_time}` —
  terminal upserts products, **reconciles deletes** against `product_ids`
  (skipped at the cap), keeps a local **staff PIN cache** (`staff_cache`).
- **Kill-switch FAIL-CLOSED**: missing gym/license row OR `gyms.disabled` OR
  `licenses.revoked` → `remote_disabled:true` → worker revokes locally and
  **exits** (no hammering with a dead token).
- **DLQ**: outbox rows with `attempts ≥ 10` are dropped into the `sync_dropped`
  setting (shown in Settings) so one poisoned row can't wedge the queue.
- **Backoff** 5/15/30/60 s; idle terminals poll the kill-switch every 6th tick.

## Licensing (offline-capable, Supabase-managed)
- Wire: `GPOS-<b64url(claims)>.<b64url(sig)>` — RSA-2048 PSS/SHA-256, salt 32.
  Same format as v2 so old keys still verify. Tiers basic/pro/ultra = $99/199/349
  (200/500/1000 members).
- Verify = desktop `license_verify::verify_token` (embedded pubkey, HWID bind,
  claims evaluate) + **3-day grace** after `expires_at`.
- **Heartbeat**: every successful `sync` 2xx refreshes `last_ok`; a boot with a
  heartbeat older than **7 days** (or a clock rolled back >60 s) refuses the
  cached license until the key is re-applied (`license_apply` heartbeats).
- Kill-switch: dashboard revokes license / disables gym → next poll → gate locks.

## Desktop (`desktop/src-tauri`, features: `face-ort`, `hardware-serial`, `cloud-sync` all default)
- **19 commands**: `pos_checkout, gate_checkin, gate_scan_frame, product_search,
  member_search, sale_list, sync_pending, face_enroll, face_match, license_apply,
  license_status, settings_get, settings_set, settings_lock_state, staff_verify,
  update_check, hw_unlock, hw_connect, hw_status`.
- Boot path: app-data dir → SQLite migrate → FaceStore warm → `boot_license`
  (heartbeat/tamper fail-closed) → `spawn_hw_supervisor` (auto-connect/reconnect
  ESP32 every 5 s).
- **Terminal-PIN lock**: Settings (license/config) requires a staff PIN once
  `staff_cache` has an active row (fresh installs stay open so the first license
  can land). Architecture: staff = terminal-PIN only, never web.
- Update check: `update_check` command → `updates-check` fn → Settings shows a
  download link (auto-updater plugin + CI signing = backlog).
- DB: `%APPDATA%\com.sls.v3\sls_local.sqlite` (WAL). Outbox = push queue.
- Firmware protocol: `UNLOCK:<ms>`, `DENY`, `BEEP` (serial 115200).

## Web (`web/`, Vercel: sls-v3-web.vercel.app)
- Hash-router SPA, RBAC = client guards (`main.ts`) + JWT `app_metadata
  {role, gym_ids}` + RLS + Edge Fns for CEO writes (service_role).
- Roles: `ceo` (fleet/users/releases), `owner`/`manager` (gym-scoped ops),
  unprovisioned (role=null) → dead account. Staff never signs in to web.
- Realtime: `sales` feed (owner-scoped, CEO global).

## POS
- `Money=i64` cents, single-pass `checkout()`, saturating math, pure + unit-tested.
- SQLite WAL, covering `products` index, LIMIT 50 + 150 ms debounce search,
  outbox-backed offline sales.

## Single-camera simplification (deleted vs v2)
- Deleted: Out/Tailgate cameras, 3-angle enroll, tailgate fields, In→Out state
  machine, sister-branch sync, vendored Tailwind, dual lockfiles, Axum cloud.
- Kept wire-compatible: `GPOS-<claims>.<sig>` license format, ESP32 prefix.

## Backlog (known, deliberate)
1. Auto-updater: sign releases (minisign key in CI), `tauri-plugin-updater`,
   paste `.sig` into the Releases row (`updates-check` already returns it).
2. Auth: `mailer_autoconfirm=false` without SMTP blocks self-signup — decide
   autoconfirm for MVP or configure SMTP.
3. POS/members PIN prompts at the terminal (Settings is gated today).
4. Threshold tuning on real gym data (target FAR < 0.1%).
5. Realtime attendance on dashboards (feed is sales-only today).
