# SoloLeveling — Design Handoff

> **TL;DR:** GymSaaS v3 — a Solo Leveling-anime-themed gym system. Face-gate
> terminal (Tauri desktop app) + cloud dashboards (Vite SPA on
> `https://sls.keth.website`). Dark violet "System window" aesthetic
> (Rajdhani + Inter, glass panels, glow, hunter-rank badges). All functions
> work; the job is look-and-feel only. **Do not change data logic, queries,
> routes, or Tauri commands** — presentation only.

## What lives here (`B:\Projects\SoloLeveling`)

| Path | What it is | UI relevance |
|---|---|---|
| `web/` | Vite SPA dashboards (CEO / owner / public). **Deployed on Vercel as `sls-v3-web`** | PRIMARY design surface |
| `desktop/webview/` | Terminal UI (gate, POS, members, dash, settings). Bundled into `GymPOS.exe` via Tauri | SECONDARY surface (kiosk) |
| `desktop/src-tauri/` | Rust backend (face, sync, license, updater). No UI, but `tauri.conf.json` holds the app version | Don't touch for design |
| `supabase/` | Postgres migrations + 9 Edge Functions. No UI | Don't touch for design |
| `hardware/` | ESP32 gate firmware. No UI | Don't touch |
| `crates/sls-core` | Shared Rust logic. No UI | Don't touch |
| `scripts/e2e/` | E2E harnesses (license/fixes/desktop). Useful reference for what each view does | Read-only reference |
| `docs/` | `SLSv3-ARCHITECTURE.md` (system contract), `REUSE.md` (runbooks) | Read `REUSE.md` deploy sections before shipping UI |

## UI surfaces and routes

**Web SPA** — hash router (`web/src/main.ts`), role-gated (CEO / owner / manager):
- `#/` landing hero ("ARISE"), `#/login`, `#/register`, `#/verify-license` (public)
- `#/ceo` single scrolling command page (metrics → Fleet → Key Vault → Releases → Users → Audit collapsibles); `#/ceo/<section>` deep-links scroll to sections
- `#/owner/*` overview (KPIs, 3 Chart.js charts, leaderboard, nav cards) + catalog / plans / promos / txns / staff / keys
- Views: `web/src/views/{ceo,owner,public}.ts`. Shared helpers: `web/src/ui.ts` (`stat`, `navcard`, `tierBadge`, `icon`, modal). All styling: `web/src/styles.css` (vanilla CSS, ~400 lines, CSS vars). Fonts + Chart.js via CDN in `web/index.html`.

**Desktop terminal** — sidebar layout (`desktop/webview/index.html` inline `<style>`, vanilla CSS, **offline-first: no CDN ever**). Views: gate (camera card + scanline + verdict), POS (tiles + cart), members, dash, settings (PIN lock). Logic in `*.js` via `window.__TAURI__.core.invoke` — keep every element id.

## Design system (already established — extend, don't replace)

- Palette: bg `#07090e`, violet `#8b5cf6/#7c3aed`, emerald/amber/red/sky accents, desktop brand blue `#2563eb`
- Type: Rajdhani (display) + Inter (body); letter-spaced uppercase labels
- Components: `.glass-panel` (system glow + top light-line), `.stat` cards, `.navcard` links, `.stat-badge` tiers (**basic=C blue, pro=A violet, ultra=S gold aura**), `.tab-btn`, `.btn-purple`/`.emerald`, `.input-dark`, `.quest` banners, `.skel` shimmer loaders, `.bars` XP shimmer
- Motion: view enter slide, modal pop, rank aura pulse, unlock breathe, gate scanline sweep, admit flash
- Responsive: tables collapse to cards ≤720px; web sidebar → overlay drawer ≤900px

## Test logins (throwaway E2E accounts — safe to use and screenshot)

- CEO: `ceo.e2e.1790267997223@acme.test` / `E2ePassw0rd!xyz` (sees everything)
- Owner: `owner.e2e.1790507038514@acme.test` / `E2ePassw0rd!xyz` (scoped, mostly empty data)
- No real users, gyms, or sales exist — dashboards show E2E leftovers; empty states are part of the design surface.

## Preview & verify (Windows / PowerShell)

```powershell
cd B:\Projects\SoloLeveling\web
npm install; npm run dev        # web preview (needs Supabase .env — see web/.env)
npx tsc --noEmit; npm run build # must pass before any deploy
& "$env:APPDATA\npm\vercel.cmd" deploy --prod --yes   # ship web
cd B:\Projects\SoloLeveling\desktop
npm install; npm run build:exe  # GymPOS.exe + NSIS installer (needs MSVC + models/)
```

- After every Vercel deploy, **verify live asset hashes** (`sls.keth.website` must serve the new chunk names) — deploys have silently failed before; edge caches `index.html` for minutes (mitigated with `no-store`, still confirm).
- Headless screenshots: `C:\Users\ketha\AppData\Local\Temp\opencode\uishots\` has puppeteer scripts (`shots*.js`, `termshots.js`) + 60+ reference PNGs of every view. Reuse the pattern to review your own changes.
- Never touch: auth/RLS, Edge Fns, sync protocol, license crypto, signing keys (`%USERPROFILE%\.tauri\`), version numbers (they drive the auto-updater — bump only when shipping a terminal release).

## Conventions

- Edit existing files; match the style in the repo. Vanilla CSS/JS only — no frameworks, no new deps without asking.
- `tsc --noEmit` + `vite build` green before declaring done; report exact commands + output.
- No `git commit/push`, no secret printing (`.env`, keys, tokens stay out of chat and commits).
- Sibling workspace projects (`mern-stack`, `sern-stack`, `PUPLasangpinoy`, …) are unrelated — ignore them.

## Suggested design backlog (pick any)

1. Page-transition topbar progress + route fade polish
2. Gate kiosk idle attract state ("look at the camera" pulse) and deny shake
3. POS tiles with stock badges + cart slide-over on small screens
4. Chart polish (tooltips, empty-data art) + printable reports styling
5. Login/landing background art (needs supplied image assets — no image gen available here)
6. Desktop settings PIN pad (big touch buttons for kiosk PIN entry)
