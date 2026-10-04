# SoloLeveling — AI instructions

Read `B:\Projects\AGENTS.md` first for workspace-wide rules, tooling and the vibe-coding workflow.

## Project

- Path: `B:\Projects\SoloLeveling`
- Type: Git repo + Node + Rust
- Workspace member: no (standalone)
- Git repo: yes

## Run it

Web dashboard (Vite SPA → Supabase):

```powershell
cd B:\Projects\SoloLeveling\web
npm install
npm run dev
```

Desktop gate app (Tauri v2, NSIS exe):

```powershell
cd B:\Projects\SoloLeveling\desktop
npm install
npm run tauri:dev     # dev window
npm run build:exe     # release: GymPOS.exe + SLS v3_3.0.0_x64-setup.exe
```

Rust crates: `crates/sls-core` via workspace; `desktop/src-tauri` is EXCLUDED from the
workspace (needs MSVC + system webview) — run cargo from `desktop/src-tauri`.

## Scripts

- `dev` / `build` / `preview` — web only
- `build:web` — desktop webview bundle
- `tauri:dev` / `build:exe` — desktop app (from `desktop/`)

## Packages

- `SoloLeveling/web` (sls-v3-web, deployed on Vercel)
- `SoloLeveling/desktop` (GymPOS Tauri app)

## Domain & Deployment Policy (CRITICAL)

- **NEVER use, bind, alias, or route `keth.website` or `www.keth.website` to this project (SoloLeveling / SLS).**
- `keth.website` and `www.keth.website` are strictly reserved for the user's personal portfolio (`keth-website`).
- The web dashboard for SoloLeveling must strictly and exclusively use **`https://sls.keth.website`** (and `https://sls-v3-web.vercel.app`).
- Any deployment scripts, Vercel commands, or configuration files must NEVER assign or touch `keth.website` or `www.keth.website`.

## Conventions

- Prefer editing existing files over creating new ones; match the style already in the repo.
- Never commit `.env`, secrets, API keys or `node_modules`.
- After changing code run the project's `lint` / `build` / `test` before declaring done.
- Report the exact commands you ran and their output.
- Deploy notes + migration/Edge-Fn runbooks: `docs/REUSE.md`.

