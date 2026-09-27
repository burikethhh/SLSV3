# SLS v3 Web Dashboard Plan — single site, RBAC

Decision: **one Vite SPA** (`web/`), route-guarded by role. Staff stays terminal-PIN only (never web) — same guarantee as v2.

## 1. Roles & routes

Auth: Supabase Auth. JWT `app_metadata`: `{ role: 'ceo' | 'owner' | 'manager', gym_ids: [...] }`.
Sessions: CEO 12h, owner 30d (carried from v2 TTLs). Rate limits via `functions/_shared/rateLimit.ts`.

```
 /login  /register (owner self-register; CEO first-time-setup when no CEO exists)
 /verify-license (public key check helper)
 /ceo/*            → role=ceo only
 /owner/*          → role=owner (scoped to own gym_ids)
 /branch/*         → phase 2, role=manager read-only daily numbers (proposed)
```

## 2. CEO pages (`/ceo`) — from orig `index.html` (Key Vault, fleet, kill, releases, MRR)

| Page | What | Data (Supabase) |
|---|---|---|
| Overview | MRR estimator, fleet census, at-risk/grace count, revoked/disabled, total members | `fleet_mrr` view (new) + `gyms/licenses/members` counts |
| Fleet | Owner→branch hierarchy, filters (license status, key released/pending, census search) | `gyms` + `licenses` (latest per gym) |
| Gym detail | Register/update/delete gym, issue branch key | Edge `license-issue`; `gyms` CRUD |
| Key Vault | Licenses table, masked keys, revoke, key fingerprint diagnostic | `licenses`; Edge `license-verify` / revoke |
| Kill switch | Disable/enable gym, reason + double-confirm, audit | `licenses.revoked` (+ `gyms.disabled` — see §4 gap) |
| Releases | Publish/list versions, stable/beta channel, rollout %, download URL | NEW `releases` table (missing in 0001) |
| Audit | Who did what (issue/revoke/kill/release) | `audit_logs` |
| Health | Supabase reachability, edge fn versions | `supabase/functions/_shared` + status query |

## 3. Owner pages (`/owner`) — from orig `portal.html` (7 tabs)

| Tab | What | Data |
|---|---|---|
| Overview | Revenue vs last month (POS+plans+day passes), hourly check-ins, branch table, recent txns | `sales`, `attendance` aggregates |
| Keys | Branch keys, killed/suspended banner | `licenses` (own gyms) |
| Catalog | Products CRUD + “Push to POS” (terminals pull on sync) | `products` |
| Plans | Membership plans grid + save&sync | NEW `plans` table (missing) |
| Promos | Vouchers + push; per-branch overrides | NEW `promos` + `branch_overrides` tables (missing) |
| Transactions | Live POS feed (realtime), filters | `sales` realtime channel |
| Staff | CRUD (username, 4–6 digit PIN, role, branch), total/active KPIs, RBAC notice | NEW `staff` table (missing; PIN via `sls-core::auth`) |
| Attendance | Hourly volume + log (moved out of overview for scale) | `attendance` paginated |

Deferred to desktop-only unless you say otherwise: members directory, face re-enroll, coaches, expenses/EOD (v2 desktop features with no dashboard counterpart).

## 4. Schema gaps (0001 → needs 0002 migration)

`0001_init.sql` has: gyms, licenses, members, attendance, products, sales, coaches, audit_logs.
Missing for dashboards: `releases`, `plans`, `promos`, `branch_overrides`, `staff`, `gyms.disabled` flag (kill-switch currently overloads `licenses.revoked` — confirm semantics), `members.expires_at/status` (renew/freeze came from desktop).

## 5. Edge functions (replace 30+ Axum routes)

| Axum (v2) | v3 |
|---|---|
| `ceo-register/login`, `owner/auth/*` | Supabase Auth + `rateLimit.ts`; first-CEO bootstrap fn |
| `licenses/generate/verify/revoke/public-key` | `license-issue` (sign, vault key) / `license-verify` (revoked+expiry) / revoke = `licenses.revoked=true` + audit |
| `admin/*`, `gyms/*`, `remote/disable` | Direct PostgREST with RLS (CEO bypass via service_role in fns where needed) |
| `sync/push`, `sync/vectors` | `sync` Edge Fn (license-token bearer, service_role writes + catalog pull); desktop outbox → that fn (`sync_worker.rs`) |
| `analytics/fleet`, `owner/analytics\|catalog\|staff` | `fleet_mrr` view + PostgREST range queries (no custom server) |
| `updates/*` | `updates-check` Edge Fn (version/channel/rollout from `releases`; Tauri updater manifest) |

## 6. Realtime vs polling (dashboard-only; gate never depends on it)

- Realtime (Supabase channels, per `gym_id`): Transactions feed, attendance ticker, kill/key status banner.
- Poll 30–60s, visible tab only: catalog/plans/promos, staff, MRR/fleet, releases, health.
- Gate path stays local-SQLite-first; dashboards are observers, never in the unlock loop.

## 7. Lightweight rules (kill the v2 weight)

- No vendored `tailwind 2.8MB` / `chart.umd 200KB` / `htmx`: Tailwind compiled+purged (or CSS vars), charts = native SVG/canvas sparkline + hourly bars, one chart lib only if needed.
- Code-split per route (`/ceo/*`, `/owner/*` lazy); gate kiosk bundle untouched.
- Tables: server pagination (`range`), LIMIT 50–100, debounced search (150ms), virtualize long feeds.
- Keys: show-once full token → masked afterwards; fingerprint compare diagnostic.
- Kill/revoke: double-confirm modal + reason → `audit_logs` row; optimistic UI with rollback on error.
- Responsive: owner overview/approvals usable on phone; CEO fleet table → cards on small screens.
- Solo Leveling dark brand kept as CSS variables, not a 147KB inline-HTML monolith.

## 8. Security / RLS (per table, `gym_id`-scoped)

- `gyms/licenses/members/attendance/products/sales/staff/plans/promos`: owner/manager `USING (gym_id IN (jwt gym_ids))`; CEO via service_role in edge fns only.
- Writes to `licenses` (issue/revoke) and `releases` (publish): edge fn + audit row, never direct from client.
- Staff PINs hashed with `sls-core::auth` (Argon2id, legacy-SHA256 verify) before insert.
- 401/403 or `remote_disabled` on terminal sync → revoke local license (already in `sync_worker.rs`).

## 9. Build phases

- **P0**: Auth + RLS + `0002` gaps; CEO overview/fleet/keys/kill; Owner overview/keys/transactions. Kill-switch e2e (dashboard → terminal revoke).
- **P1**: Catalog/plans/promos + overrides + push-to-POS; staff CRUD; attendance tab; audit log UI.
- **P2**: Releases + updater manifest; MRR polish; manager read-only; members/coaches/EOD web (if wanted); mobile polish.

## 10. Open decisions (need your call)
1. Web members/attendance management, or desktop-only?
2. Coaches + expenses/EOD on web, or desktop-only?
3. Kill semantics: `licenses.revoked` only, or add `gyms.disabled`?
4. Manager role in P0, or CEO+Owner first?
5. Hosting target for `web/` (Vercel/Render/static) + domain?
