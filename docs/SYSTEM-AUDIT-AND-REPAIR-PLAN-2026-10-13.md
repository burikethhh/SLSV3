# SLS dashboard and GymPOS: audit and repair plan

Audit date: 2026-10-13 (Asia/Manila). Source baseline: `a6e7aad`.
Request: audit, check, and plan the account, licensing, authorization, routing, polling, guidance, and UI problems across both applications.

Implementation follow-up: [Account-first implementation and Gemini handoff](ACCOUNT-FIRST-IMPLEMENTATION-2026-10-13.md) records the authorized implementation, validation and production rollout. Findings below are the historical baseline, not current status. Native operator roles, dashboard write permissions, roster/plan/face reconciliation, and owner report aggregates were addressed; staff PIN visual redesign, qualification and the handoff's explicit backlog remain open.

## Conclusion and scope

The central defect is a disconnected application lifecycle. The web account, gym assignment, subscription, terminal license, local staff PIN, hardware state, and UI navigation are separate mechanisms. Styling changes alone will leave the broken journeys and access gaps intact.

Recommended destination: **sign into GymPOS with the dashboard account, select an authorized gym/branch, register the terminal, and automatically maintain its subscription entitlement**. Signed license tokens remain an internal enforcement mechanism. Ordinary owners and cashiers should never need to copy a key or configure a Supabase URL.

This audit inspected the current source, migrations, existing test coverage, installer timestamps, and local browser rendering. Browser account/cloud/native responses used synthetic fixtures; no live account, production database mutation, or physical unlock was performed. Native enforcement findings below are source-based unless explicitly marked as browser reproductions. The installed user's EXE and live deployment versions were not established.

Existing uncommitted hardware, firmware, and `scratch/` work was preserved. This pass changes documentation only; implementation is the next work item.

## Confirmed findings

P0 means a release-blocking access or tenant-isolation defect. P1 means a broken core journey or unreliable enforcement. P2 means a usability/reporting defect to address in the redesign.

| ID | Priority | Finding and consequence | Source evidence |
|---|---|---|---|
| A01 | P0 | Normal manual entry can bypass licensing. `hw_manual_override` checks the staff-cache gate but never checks license operability. An empty staff cache permits the call. Fresh GymPOS opens Entry immediately, and the Unlock gate button remains enabled while unlicensed (browser reproduction). POS checkout and ordinary check-in **do** have license checks; enforcement is incomplete rather than absent everywhere. Emergency/free exit must remain independently available. | [native override](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:497), [staff guard](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:36), [startup navigation](B:/Projects/SoloLeveling/desktop/webview/main.js:129) |
| A02 | P0 | Switching accounts/gyms has no local tenant isolation. SQLite products, members, sales, staff, face vectors, and outbox have no `gym_id`. Each activation starts another worker with a fixed token; workers share the same outbox and license manager. Old workers can upload new rows under an old gym or clear a newer license. Cached licenses can accumulate while startup reads an arbitrary first row. | [local schema](B:/Projects/SoloLeveling/desktop/src-tauri/src/db.rs:39), [license cache](B:/Projects/SoloLeveling/desktop/src-tauri/src/db.rs:611), [worker creation](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:448), [shared outbox upload](B:/Projects/SoloLeveling/desktop/src-tauri/src/sync_worker.rs:79) |
| A03 | P0 | Cloud sync uses service-role member/attendance upserts keyed only by client row ID. There is no existing-row tenant-ownership predicate and attendance does not verify that its member belongs to the signed gym. This permits cross-tenant updates/references if another tenant's IDs are supplied with a valid terminal token. No exploit against production was attempted. | [member upsert](B:/Projects/SoloLeveling/supabase/functions/sync/index.ts:123), [attendance upsert](B:/Projects/SoloLeveling/supabase/functions/sync/index.ts:147), [attendance FK](B:/Projects/SoloLeveling/supabase/migrations/0001_init.sql:40) |
| A04 | P1 | Offline/heartbeat enforcement is checked only at boot. `current_status()` evaluates expiry only; an already-running process can exceed the seven-day verification window. Reapplying a locally signed token records an "online" heartbeat without contacting the cloud, so token possession substitutes for revocation verification. A zero heartbeat also passes the helper. | [runtime status](B:/Projects/SoloLeveling/desktop/src-tauri/src/license_verify.rs:195), [manual apply heartbeat](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:240), [boot check](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:464), [zero-heartbeat behavior](B:/Projects/SoloLeveling/desktop/src-tauri/src/license_verify.rs:23) |
| A05 | P1 | Registration is incompatible with the configured email confirmation. Signup creates an unconfirmed account, then immediately attempts password login. That throws before the friendly verification message or `owner-apply` (browser reproduction: only signup/token calls occur; screen says "Email not confirmed"). Gym details are not durably saved for resumption after email verification. The returning account can land at "Account not provisioned yet" with instructions to ask the CEO, contradicting instant trial onboarding. | [registration](B:/Projects/SoloLeveling/web/src/main.ts:243), [pending account screen](B:/Projects/SoloLeveling/web/src/main.ts:121), [confirmation enabled](B:/Projects/SoloLeveling/supabase/config.toml:15), [signup options](B:/Projects/SoloLeveling/web/src/auth.ts:22) |
| A06 | P1 | "Login with SLS Account" is a one-time activation request hidden inside Settings. It discards the refresh/session information, supplies no sign-out/reconnect journey, and chooses one newest license across all assigned gyms. There is no branch picker or registered-device record. Only owners pass `license-fetch`; managers see dashboard navigation but cannot use the same activation flow. | [cloud login](B:/Projects/SoloLeveling/desktop/webview/settings.js:180), [license lookup](B:/Projects/SoloLeveling/supabase/functions/license-fetch/index.ts:18), [newest-license selection](B:/Projects/SoloLeveling/supabase/functions/license-fetch/index.ts:39) |
| A07 | P1 | Paid approval/renewal does not automatically replace the terminal's trial/old license. Sync continues using its captured token and never fetches an updated entitlement. Approval does not retire the trial. A terminal can expire while its account has a newer paid license, requiring another manual sign-in. A retired worker can also revoke the new activation. | [approval provisioning](B:/Projects/SoloLeveling/supabase/functions/gym-admin/index.ts:57), [fixed worker bearer](B:/Projects/SoloLeveling/desktop/src-tauri/src/sync_worker.rs:106), [sync response](B:/Projects/SoloLeveling/supabase/functions/sync/index.ts:238) |
| A08 | P1 | Local staff authentication provides any successful staff role with the privileged session; the role is not checked against the action. It lasts for the process lifetime and is not invalidated when that staff account is deactivated. With no cached active staff, privileged access becomes open. Dashboard PIN creation allows 6–12 digits but GymPOS input/keypad caps at 6, so 7–12-digit PINs cannot be entered. | [privileged guard](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:36), [session assignment](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:317), [PIN input](B:/Projects/SoloLeveling/desktop/webview/settings.js:49), [PIN creation](B:/Projects/SoloLeveling/web/src/views/owner.ts:657) |
| A09 | P1 | Most tenant RLS policies grant all actions based on JWT `gym_ids`, without separating owner/manager permissions. This includes sales and staff. The migrations do not restrict dashboard reads of staff PIN hashes. Demotion changes auth metadata, while already-issued JWTs retain their old claims; web routing has no auth-state listener that updates the shell. The documented CEO/owner session lifetimes are comments, not implemented role-specific limits. | [scoped policies](B:/Projects/SoloLeveling/supabase/migrations/0003_rls.sql:39), [staff policy](B:/Projects/SoloLeveling/supabase/migrations/0003_rls.sql:56), [role mutation](B:/Projects/SoloLeveling/supabase/functions/user-admin/index.ts:67), [auth wrapper](B:/Projects/SoloLeveling/web/src/auth.ts:1), [route listener](B:/Projects/SoloLeveling/web/src/main.ts:319) |
| A10 | P1 | Gym/license lookup errors are discarded in sync and treated like a confirmed disabled/missing license. A transient database failure can clear a valid cached license and stop the worker permanently. The worker also treats any 2xx/parse-default response as a successful heartbeat without validating the complete response contract. | [lookup and kill decision](B:/Projects/SoloLeveling/supabase/functions/sync/index.ts:91), [response parse/heartbeat](B:/Projects/SoloLeveling/desktop/src-tauri/src/sync_worker.rs:115) |
| A11 | P1 | Member admission fails open for unknown members, unparseable expiry values, and lifecycle-query errors. `gate_checkin` accepts a client-provided member ID/confidence rather than a server-side/native scan authorization tied to that person. The manual admit journey is not a separate role-controlled approval. | [member lifecycle](B:/Projects/SoloLeveling/desktop/src-tauri/src/db.rs:107), [ignored guard errors](B:/Projects/SoloLeveling/desktop/src-tauri/src/db.rs:166), [check-in command](B:/Projects/SoloLeveling/desktop/src-tauri/src/lib.rs:81), [manual admit](B:/Projects/SoloLeveling/desktop/webview/gate.js:480) |
| A12 | P1 | Pulls are capped and lack complete member deletion/expiry reconciliation. Only 500 members are fetched although Ultra advertises 1,000. Member pulls preserve existing face data but do not deliver vectors to another terminal or invalidate deleted members in its face store. Membership plans are advertised as syncing to terminals but are absent from the sync response. Current desktop enrollment collects a name/face without a plan/expiry assignment. | [pull limits and fields](B:/Projects/SoloLeveling/supabase/functions/sync/index.ts:226), [member pull](B:/Projects/SoloLeveling/desktop/src-tauri/src/db.rs:91), [plan claim](B:/Projects/SoloLeveling/web/src/views/owner.ts:541), [enrollment](B:/Projects/SoloLeveling/desktop/webview/members.js:375) |
| A13 | P1 | Signup interpolates the gym name into `innerHTML` without escaping. Account recovery, resend-verification, and MFA challenge journeys are absent. Public first-CEO bootstrap remains available to any authenticated caller whenever no CEO exists; it needs a controlled installation/bootstrap policy. Existing user lookup/approval scans only the first page, relies on email instead of an ownership relation, and approval overwrites rather than merges assigned gym IDs. | [signup HTML](B:/Projects/SoloLeveling/web/src/main.ts:272), [public bootstrap](B:/Projects/SoloLeveling/supabase/functions/bootstrap-ceo/index.ts:16), [CEO claim](B:/Projects/SoloLeveling/supabase/migrations/0011_atomic_first_ceo.sql:10), [owner lookup/update](B:/Projects/SoloLeveling/supabase/functions/gym-admin/index.ts:144) |
| A14 | P1 | Approval marks an application active, signs/inserts a license, then changes auth metadata across separate calls with compensating rollbacks. It is not an atomic activation transaction. Registration's duplicate check also precedes provisioning without a unique user-to-application constraint. Approval issues a paid license without a payment-confirmation record. | [approval sequence](B:/Projects/SoloLeveling/supabase/functions/gym-admin/index.ts:75), [registration duplicate check](B:/Projects/SoloLeveling/supabase/functions/owner-apply/index.ts:39) |
| A15 | P2 | Status UI gives false confidence. Empty outbox is labelled SYNCED even without a connection or successful poll. Any valid tier is labelled S/ULTRA. Pending applications are labelled "trial active" before checking expiry/revocation (browser reproduction with a trial expired beyond grace). CEO says "fleet live" without polling. Missing Tauri bridge automatically activates sample/demo paths instead of showing a production runtime error. | [header status](B:/Projects/SoloLeveling/desktop/webview/main.js:23), [expired-trial banner](B:/Projects/SoloLeveling/web/src/views/owner.ts:96), [license page banner](B:/Projects/SoloLeveling/web/src/views/owner.ts:348), [CEO live badge](B:/Projects/SoloLeveling/web/src/views/ceo.ts:34), [preview fallbacks](B:/Projects/SoloLeveling/desktop/webview/pos.js:20) |
| A16 | P2 | Navigation and guidance expose implementation language instead of tasks. CEO links scroll through a page that loads every section. Account assignment asks for raw gym-ID CSV. Owner/manager share navigation despite different server permissions. There is no first-run setup checklist, terminal login screen, terminal/account connection page, contextual guide, or guided member subscription journey. Login and registration largely use placeholders instead of field labels/forms; passwords are trimmed on signup but not sign-in. | [CEO page routing](B:/Projects/SoloLeveling/web/src/views/ceo.ts:26), [UUID account assignment](B:/Projects/SoloLeveling/web/src/views/ceo.ts:501), [role nav](B:/Projects/SoloLeveling/web/src/main.ts:9), [signup password](B:/Projects/SoloLeveling/web/src/main.ts:229), [GymPOS settings](B:/Projects/SoloLeveling/desktop/webview/settings.js:115) |
| A17 | P2 | Reports silently aggregate limited rows rather than complete periods: owner month/day totals use the latest 500 sales, local today's total uses the latest 20. "Active members" counts all nondeleted members, not current active memberships. Top-product revenue ignores refund sign and discounts. | [owner queries/calculations](B:/Projects/SoloLeveling/web/src/views/owner.ts:66), [top product sum](B:/Projects/SoloLeveling/web/src/views/owner.ts:148), [local sales limit](B:/Projects/SoloLeveling/desktop/webview/dash.js:49) |
| A18 | P1 | Release provenance is unclear. All desktop version fields still say 3.0.3. The local NSIS installer timestamp is 2026-10-10 05:22:39 UTC, before audited commit `a6e7aad` at 06:31:50 UTC; the bare EXE timestamp is later, 06:36:55 UTC. This does not prove which version is installed, but the installer and current source cannot be assumed equivalent. Reusing 3.0.3 also obstructs normal version-based updates. | [desktop version](B:/Projects/SoloLeveling/desktop/src-tauri/tauri.conf.json:5), local artifact timestamps inspected during audit |
| A19 | P1 | Existing live E2E harnesses are unsafe as routine audit checks: the desktop script targets the production project, selects a CEO account, and resets its password. The "production token" Rust test returns successfully without doing an interop check when its environment variable is absent. Passing the unit suite is not evidence of live account/license enforcement. | [E2E harness](B:/Projects/SoloLeveling/scripts/e2e/e2e-desktop.mjs:25), [optional interop test](B:/Projects/SoloLeveling/desktop/src-tauri/src/license_verify.rs:285) |

The changes committed on October 10 improved isolated paths (stock transactions, outbox retention, token fetch). They did not establish an end-to-end account/terminal lifecycle. These remaining findings explain why the whole product still feels disconnected.

## Polling: what exists and what must change

There is polling today; it is fragmented rather than wholly missing.

| Surface | Current behavior | Required behavior |
|---|---|---|
| Native cloud sync | 5/15/30/60-second backoff; idle polls about every 30 seconds. Starts only with a license; stops on revoke. No cancellation/generation control or renewal fetch. | One supervised worker per selected gym/device. Separate account/entitlement reconnection from operational uploads so expired subscriptions can recover automatically. Stop old workers before switching contexts. |
| GymPOS header | Refreshed on boot/view switch; no continuous subscription to license/sync changes. | Subscribe to native state events; use a small fallback status poll. Update locked screens immediately after expiry/revoke. |
| Gate view | Camera loop and hardware polling continue after navigation; no shared session/license gate before scanning. | Start/stop scanning with the active authorized view. Retain independent safety/exit handling. |
| Local dashboard | 15-second interval stays active while its DOM remains, even when the section is hidden. | Poll only while visible; dispose on exit and refresh on resume. |
| Owner dashboard | Overview polls every 60 seconds; other pages mostly load once. Sales realtime watches INSERT only, with no connection-status/fallback UI. | Poll/realtime per active route, observe updates and subscription changes, handle disconnect with bounded fallback, show last successful refresh and refresh errors. |
| CEO dashboard | Manual refresh; every navigation reloads all sections. | Dedicated routes with scoped refresh/polling and actual connection/last-updated state. |

Suggested online targets to test: entitlement/revocation visible within 30 seconds; UI expiry state within one second or the next protected command; immediate refresh after login/approval/renewal/resume. Failed requests must not overlap, create duplicate timers, clear valid state as if revoked, or mark old data current.

## Target account and terminal journey

```text
Create owner account → Verify email → Complete/resume gym setup → 14-day trial
        ↓                                                      ↓
Owner dashboard: setup checklist, subscription, team, terminals, operations
        ↓
Install GymPOS → Sign in with same SLS account → Select gym/branch
        ↓
Register device → Fetch verified entitlement → Check hardware → Open operations
        ↓
Cashier/manager signs in locally with an allowed staff credential
        ↓
Renewal/approval changes entitlement automatically; no key copying
```

Verification is automated email confirmation; CEO approval must not block the initial trial. Persist the incomplete onboarding state so closing the tab, retrying, or following the email link does not lose the facility details or create a second application.

Account types need clear descriptions and distinct capabilities. CEO administers the fleet. Owners manage their assigned facilities, subscription, and invitations. Managers receive only assigned operational permissions. Cashier PINs identify a local operator on an already-connected terminal; they do not substitute for owner account authentication or subscription authorization. Owners should invite managers rather than share an owner password with desk staff. Gym members are customers with memberships, not dashboard administrators.

## Required architecture

1. Define one terminal state model covering account identity, selected gym, registered device, operator identity/capabilities, entitlement, connection, last verified time, and pending sync. Native commands enforce the same model that the UI displays. UI visibility alone is not access control.
2. Separate authentication (who signed in), authorization (which actions/gym they may use), and entitlement (which subscription features are active). Check current authoritative membership in server/database policies for changes requiring prompt revocation, rather than relying exclusively on an old JWT's metadata.
3. Use dashboard-account sign-in as GymPOS's first-run route. Keep password/refresh credentials out of diagnostic output; persist refresh credentials in Windows secure credential storage and manage refresh/sign-out through the native layer. Add verification/recovery/MFA screens when required by the account. Make the production endpoint configuration internal.
4. Register each terminal against a selected gym and device identity. Issue/refresh a signed device-scoped entitlement internally. Validate server status before first activation. Present the gym, account, device, tier, expiry, and connection as human-readable state, never a raw key.
5. Make context changes transactional: stop the previous worker, clear operator authorization, switch to the correct tenant's local storage/face store, and restart one worker. Bind every local and queued row to its gym at creation. Preserve unsynced historical rows when disconnecting; never upload them under a different gym. Back up/migrate existing SQLite data; quarantine ambiguous legacy ownership rather than guessing or deleting it.
6. Enforce license and role checks on every protected native write/normal admission. Prevent unknown/invalid lifecycle data from granting entry. Bind automatic admission authorization to the native recognition result or a role-authorized manual approval. Keep emergency/free egress independent of billing and network state.
7. Apply expiry, three-day grace, verified offline allowance, and clock protection during operation as well as startup. Re-pasting/reusing a token must not reset online verification. The current seven-day offline allowance is a proposed preserved policy, not a reason to extend subscription expiry/grace. Preserve queued transactions and enable an authorized recovery path after renewal.
8. Use one canonical subscription/entitlement decision shared by issuance, sync, native evaluation, and dashboard presentation. Return explicit reasons such as verification required, setup incomplete, no assigned gym, expired, suspended, device revoked, and temporarily offline. Keep application-review status separate from trial expiry.

## UI and guidance redesign

Retain SLS branding, but use plain operational language and quieter visual hierarchy. Replace "Hunter Guild Rank", "512-d cryptographic vector", "Supabase Gateway", "gym_ids", and "outbox" in ordinary user flows with member, subscription, connection, facility, and pending uploads. Technical details belong in an admin diagnostics panel. POS prices stay in pesos with integer cents internally; subscription billing currency must be stated explicitly rather than silently changed from the existing USD policy.

| Application/user | Proposed navigation |
|---|---|
| CEO | Overview, Applications, Facilities, Accounts, Subscriptions, Terminals, Releases, Audit |
| Owner | Overview, Get Started, Members, Products, Memberships, Sales, Team, Terminals, Subscription, Help |
| Manager | Only the permitted operational sections, with the selected facility always visible |
| GymPOS first run/blocked | Sign In, setup or subscription status, connection troubleshooting, Help |
| GymPOS authorized | Gate, Point of Sale, Members, Today's Activity, Connection Status, permitted Settings, Help |

Each route should render its own screen, handle direct links/back navigation, and dispose its listeners/timers on departure. Route based on validated account/setup/device/entitlement state. An expired owner account must retain access to renewal/support in the dashboard; operational terminal access should remain blocked as specified.

The owner Get Started checklist should guide facility setup, GymPOS download, account connection/branch selection, camera/controller test, products and membership plans, staff setup, first member, test entry, and first sale. Show completion from real saved state. Provide a visible Help link and short contextual instructions beside empty states and tasks.

Use properly labelled forms, Enter-to-submit, correct autocomplete, password visibility controls, recovery/resend-verification links, field-level errors, and a single primary action per task. Do not trim passwords. Buttons need clear action labels, disabled/loading behavior, touch-sized targets, keyboard focus, and predictable confirmation for significant actions. Account assignment should select named facilities, not pasted UUIDs. Guides must explain owner accounts versus manager invitations, cashier PINs, and customer memberships.

Display last successful cloud contact, pending upload count, account/branch/device, actual tier, subscription deadline/grace, and hardware connectivity as separate facts. "No queued uploads" is not "Connected". Do not display sample success as a fallback in a packaged app. Demo mode, if retained, must be explicitly selected and clearly labelled.

Membership enrollment must guide plan/expiry assignment and identity capture. RFID should be advertised only after a tested credential-to-member-to-native-admission path exists; the inspected desktop serial reader currently handles button events, not a card UID admission path. Coordinate its interface with the user's ongoing firmware work.

## Implementation sequence and exit criteria

### Phase 1 — Close access and tenant-isolation gaps

Implement a central native capability/license guard, fail-closed normal admission, operator-session expiry/revocation, and gym-bound local/outbox records. Replace duplicate worker spawning with a supervised cancellable worker. Enforce tenant ownership and member/gym consistency in cloud sync and least-privilege RLS; restrict PIN-hash distribution to authorized devices.

Exit criteria: a fresh unlicensed terminal cannot sell, enroll, normally admit, or read another facility's private data; emergency exit works; switching gym cannot change ownership of queued rows; revoked/unauthorized staff cannot configure/unlock via stale sessions; direct IPC and direct database/API checks enforce the same rules as the UI.

### Phase 2 — Implement the account-first connection lifecycle

Build native dashboard-account login, session refresh/secure persistence, branch selection, device registration, automatic entitlement retrieval/renewal, account sign-out, and blocked-state routing. Remove manual key entry and cloud URL configuration from normal screens. Allow the reconnect/subscription journey to work after operational access expires. Audit/migrate existing license caches rather than assuming a fresh installation.

Exit criteria: one dashboard account connects an authorized terminal without copying a key; no license/no branch/manager denied/MFA/verification-required cases each lead to a useful screen; renewal updates the terminal automatically; only one active worker exists and credentials are cleared on sign-out as designed.

### Phase 3 — Repair registration, invitations, and subscription provisioning

Persist/resume the verified-email onboarding wizard; add reset-password/resend-verification; escape all user input; provision the application/trial idempotently against an auth-user relation. Use named-gym membership/invitation workflows, checked role transitions, controlled first-CEO setup, and paginated account administration. Make application/subscription activation atomic where possible and recoverable where auth spans systems. Record CEO payment confirmation separately from facility review if manual billing is retained.

Exit criteria: signup → email verification → facility/trial → dashboard → GymPOS works without asking CEO to manually repair metadata; retries do not create duplicate gyms/trials; approved subscriptions do not clobber multi-gym access or leave half-provisioned accounts.

### Phase 4 — Make sync, polling, and status trustworthy

Separate confirmed revoke/disable from transient service errors. Validate complete response contracts before recording successful verification. Add paginated/cursor-based pulls, member tombstones/face-store invalidation, supported plan delivery, and retained-row recovery. Connect native status events and visible-route polling/realtime fallback. Expose sync reasons/last-success timestamps and correct subscription/tier labels. Replace row-limited report totals with complete database/date-scoped aggregates.

Exit criteria: online state changes meet the stated refresh targets; sleeping/resuming, disconnecting, changing views, and logging out leave no duplicate worker/timer; no missing rows are interpreted as deletions from a partial pull; refunds/discounts/today/month totals reconcile to the ledger.

### Phase 5 — Rebuild navigation and guided task screens

Implement the proposed route structure, account/branch header, Get Started checklist, task-focused forms, contextual Help, plain wording, and responsive layouts. Review at 1280×800 and small mobile widths. Finish members/plan assignment and staff workflows. Make empty, loading, offline, permission-denied, and blocked states intentional screens rather than raw exceptions.

Exit criteria: a new owner can create/connect a facility and a desk operator can enroll a member/check out a sale using the in-app instructions; every primary button has a clear outcome, relevant loading/error state, and keyboard/touch access.

### Phase 6 — Validate and release the exact build

Use an isolated test Supabase project and disposable tenant/accounts/devices. Fix the harnesses so tests cannot reset real CEO credentials or write production data. Build the signed installer from the reviewed commit with an incremented consistent version; verify EXE, installer, signatures, updater manifest, deployed function contract, and migration state together. Gemini handles version control/release coordination; Codex owns implementation and regression fixes.

Exit criteria: automated scenario matrix passes, physical device tests pass with the agreed firmware, fresh-install and upgrade migrations both pass, and the distributed installer is traceable to the tested commit. SLS web release uses only `sls.keth.website`/`sls-v3-web.vercel.app` and never the portfolio's apex or `www` domain.

## Required scenario coverage

| Area | Cases to verify |
|---|---|
| Licensing | No cache, malformed token, expired beyond grace, exact grace boundary, revoke, suspended gym, renewed license, trial → paid, offline within/outside policy, running app exceeds offline window, clock rollback, reused revoked token |
| Accounts | Verified/unverified signup, refresh, sign-out, password reset, invitation acceptance, no gym, multiple gyms, wrong role, role removal while logged in, first-CEO setup closed after completion |
| Isolation | Two tenants; two terminals; account/branch switch with pending sales; colliding/malicious row IDs; mismatched attendance member; old worker response after switch; protected PIN hashes |
| Operators | Owner/manager/cashier capabilities, staff removal during a session, inactivity relock, 6- and 12-digit PINs, incorrect PIN lockout, direct IPC attempts, normal manual admission versus safety exit |
| Sync | Lost response/retry without duplicates, transient 5xx, rejected row recovery, member deletion/expiry update, more than 500 members/products, network sleep/resume, stale catalog, persisted queue across restart |
| UI | First run, direct routes/back button, no bridge in packaged app, disabled actions, reliable status, verification/onboarding resumption, responsive navigation, keyboard/touch forms, empty/error/loading screens, novice walkthrough |
| Deployment | Fresh install, upgrade existing SQLite/cache, correct version/signatures, approved migrations/functions, matching contract/installer, no unintended portfolio domain changes |

## Audit checks and evidence

These checks ran against the current source, not a released installer:

- `cargo test` at repo root: **16 tests passed**, doc tests passed.
- `cargo test --lib` in `desktop/src-tauri`: **19 tests passed**. The production-token test may return without testing when its environment is unset; its successful test result does not establish live key interop.
- `npm exec -- tsc --noEmit -p tsconfig.json` in `web`: exit 0, no errors.
- `npm run build` in `web`: Vite build passed, 54 modules transformed.
- `npm run build:web` in `desktop`: Vite webview build passed, 10 modules transformed.
- `deno lint --rules-exclude=no-import-prefix` on `license-fetch`, `owner-apply`, `gym-admin`, `sync`, `user-admin`, `bootstrap-ceo`, `staff-create`: **7 files checked**, exit 0.
- With `DENO_DIR` set to `Join-Path $env:TEMP 'sls-audit-20261013-deno'`, `deno check --no-config --no-lock --node-modules-dir=none` on the same seven functions: exit 0. This resolves the earlier machine-cache/dependency obstruction without adding repository dependencies.
- Local Vite servers ran on ports 5177 (web) and 5187 (desktop webview). A headless Chrome audit used isolated browser contexts, synthetic Supabase responses, and a mock native bridge. It does not certify hardware or real authentication.

Browser evidence is stored outside the repo at:

`C:\Users\ketha\.codex\visualizations\2026\10\10\01a1245e-b7a8-7521-9938-f9bf9d657786\audit-2026-10-13`

Files include `browser-findings.json`, `gympos-unlicensed-gate.png`, `gympos-unlicensed-pos.png`, `gympos-unlicensed-settings.png`, `web-register.png`, `web-mobile-login.png`, `web-owner-expired-trial-fixture.png`, `web-ceo-users-fixture.png`, and `web-signup-email-confirmation-fixture.png`. The reproducible audit script is in the parent visualization directory (`audit-ui.mjs`).

## Product policies to settle during implementation

Preserve the stated 14-day trial, CEO-controlled 30-day subscription, and three-day grace unless the owner changes them. Decide whether the trial itself receives grace, how payment is confirmed, the allowed number of registered terminals per gym, manager activation permissions, and the exact offline allowance. Use the current seven-day heartbeat as the starting proposal while enforcing it throughout runtime. Emergency egress remains independent of those commercial policies.

The first implementation slice should be Phase 1 plus the blocked/startup shell from Phase 2. That makes the user's central complaint—GymPOS functioning without proper authorization—a testable release gate before the wider visual redesign.
