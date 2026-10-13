# Gemini handoff — version control and release coordination

Current update (2026-10-13): read [Account-first implementation and release handoff](ACCOUNT-FIRST-IMPLEMENTATION-2026-10-13.md) first. Below is historical October 10 guidance. Approval/payment are separate; migrations 0013–0016 and matching functions/dashboard are deployed. The owner authorized Codex to finish rollout and commit/push reviewed SLS changes. Live legacy recovery remains explicit and backed up. Preserve unrelated firmware/scratch work.

Date: 2026-10-10. Repo: `B:\Projects\SoloLeveling` (`master`, `origin` is `burikethhh/SLSV3`).

## Your role and authority

You are the version-control manager for this handoff. Codex is handling implementation and technical decisions as programmer/CTO. Review, organize, and verify the current changes; report risks and coordinate the release. Do not silently rewrite product behavior to make a commit pass—send implementation findings back to Codex/the owner.

Read `B:\Projects\AGENTS.md`, this repo's `AGENTS.md`, and `docs/REUSE.md` first. The older `docs/HANDOVER-GEMINI.md` is historical (2026-10-04) and its “clean worktree” and migration counts are no longer current.

This file is a handoff, **not authorization to commit, push, deploy, rotate credentials, or publish an EXE**. Obtain the owner's explicit instruction for each external/release action. Do not use `git reset --hard`, discard edits, force-push, or fold in unrelated user changes.

## Current change set to review

The worktree is dirty. Modified: `desktop/src-tauri/{Cargo.toml,Cargo.lock,src/db.rs,src/lib.rs,src/sync_worker.rs}`, `desktop/webview/{gate.js,pos.js,settings.js}`, `web/src/views/owner.ts`, `docs/REUSE.md`, `supabase/functions/{bootstrap-ceo,gym-admin,owner-apply,sync}/index.ts`, and `supabase/migrations/0009_gym_applications.sql`. New/untracked: `supabase/functions/license-fetch/index.ts` and migrations `0010_atomic_stock_sales.sql`, `0011_atomic_first_ceo.sql`, `0012_license_trial_read.sql` (plus this handoff). Re-run `git status --short`; do not assume this list stays fixed.

The changes address: immediate 14-day trial registration; CEO approval of a 30-day license; GymPOS cloud sign-in activation; peso input with integer-cent storage; low-stock warnings; strict license grace behavior; gate unlock regression; atomic local checkout/stock; per-row sync acknowledgement and retained failed rows; license-fetch authorization; and first-CEO bootstrap hardening. Inspect the actual diff—this summary is not a substitute for review.

## Version-control checklist

1. Review `git diff --check`, `git diff`, untracked files, and the staged diff before any commit. Confirm migrations and the new Edge Function are included. Do not stage `.env*`, RSA PEMs, API keys, test tokens, `node_modules`, build outputs, or the signing key. Do not print secret values in logs or chat.
2. Confirm no SLS deployment/configuration touches `keth.website` or `www.keth.website`. SLS dashboard may use **only** `https://sls.keth.website` and `https://sls-v3-web.vercel.app`; the apex and `www` belong to the personal portfolio.
3. Re-run verification in the relevant directories and record the exact commands, results, and any warnings:
   - `deno lint --rules-exclude=no-import-prefix supabase/functions/sync/index.ts supabase/functions/license-fetch/index.ts supabase/functions/owner-apply/index.ts supabase/functions/gym-admin/index.ts supabase/functions/bootstrap-ceo/index.ts`
   - `cargo test` from repo root (shared `sls-core`).
   - `cargo test --lib` and `cargo check` from `desktop/src-tauri`.
   - `npm exec -- tsc --noEmit -p tsconfig.json` and `npm run build` from `web`.
   - `npm run build:web` from `desktop`.
   - `git diff --check` from repo root.
4. Codex's last run passed: 16 core tests, 19 desktop tests, Rust check, web TypeScript/build, desktop webview build, Edge Function lint, and diff check (line-ending warnings only). Deno **type-check** did not complete because of local dependency/cache setup; do not claim it passed. No live Supabase smoke test, physical gate test, release-EXE build, or production deployment was performed.
5. Flag any failing check or suspicious change to Codex/the owner. When the owner explicitly authorizes a commit, stage only the reviewed files and use a descriptive commit message. Before any authorized push, confirm the destination branch and show the final commit hash and diff summary to the owner. Do not assume a commit authorizes a push or deployment.

## Release order and unresolved decisions

If separately authorized to coordinate release: review and apply migrations **0010–0012**, deploy `sync` and the new `license-fetch` Edge Function (plus changed `owner-apply`, `gym-admin`, and `bootstrap-ceo` as appropriate), verify function JWT settings, then distribute the updated GymPOS build. The new desktop worker expects `accepted_ids` from `sync`; against the old function it deliberately retains its outbox rather than deleting sales. Follow `docs/REUSE.md`; never infer live deployment state from files alone.

Do **not** label this feature fully production-certified yet. CEO approval currently issues a paid license without independent payment confirmation; the owner must decide the billing proof/process. Cloud sale sync can quarantine failed rows after 10 attempts but has no in-app recovery control yet. Approval/registration span multiple external systems and still need live concurrency and rollback tests. Hardware RFID/face/door checks, actual SMTP signup, live Supabase migration/function tests, and installer/signature verification remain to be performed.

Report back with: what you reviewed, exact validation output, files proposed for commit, any secrets/domain-policy findings, commit/push/deploy status (explicitly distinguish “not done” from “done”), and technical blockers for Codex.
