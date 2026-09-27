# SLS v3 — SoloLeveling System (Lightweight Rebuild)

Rebuild of [SLSNIKETH (GymPOS SaaS)](https://github.com/burikethhh/SLSNIKETH.git)
into a **better, lightweight** version.

## What changed vs v2 (orig)

| v2 (heavy) | v3 (light) |
|---|---|
| Dual lockfiles (root 2.2k lines + desktop 6.3k lines), `tract-onnx` + `image` + `tokio full` + duplicated `sqlx`/`rusqlite` stacks | Single workspace, `crates/sls-core` builds with **8 deps** (all used). Tauri crate excluded from default build, opt-in |
| 3 cameras (In/Out/Tailgate) + 3-angle capture + tailgate legacy fields | **Single camera, gate-IN only**. One capture path, 3s anti-passback cooldown |
| SFace 36.9MB + ArcFace 13MB (dead) + YuNet 0.2MB ≈ 50MB bundled | YuNet (~200KB) + **EdgeFace-XXS (~4.9MB, 512-d, LFW 99.57%, ~2ms/face)**. ~90% smaller, more accurate. `ort` (ONNX Runtime + DirectML) replaces `tract` |
| No brightness handling | **Auto-brightness**: luma assess → gamma + CLAHE-lite equalization before embedding |
| `cloud/` Axum + Postgres (62KB routes, 76KB db) duplicated with desktop `db.rs` 102KB | **Supabase (BaaS)**: Postgres + Auth + Realtime. No Axum to maintain. `supabase/migrations` is the single schema |
| `app.js` 201KB monolith + `index.html` 147KB + vendored `tailwind 2.8MB` | Vite + code-split views (gate/pos/members/dash/settings). POS math in **integer cents**, debounced search (150ms, LIMIT 50) |
| 58 Tauri commands, version must match in 2 files, NSIS + updater signing overhead | 19 Tauri commands, single `product_version` source, models **downloaded not in git** (bundled at build) |

## Layout

```
crates/sls-core/      # pure logic, fast build, unit-tested (license, pos, face types, brightness, sync queue)
desktop/src-tauri/    # slim Tauri v2 shell (single camera, ort+EdgeFace, rusqlite, serial ESP32) — opt-in build
desktop/webview/      # Vite frontend skeleton (gate-in kiosk, POS, members, dashboard)
supabase/             # migrations (single source of truth) + edge functions (9 fns)
hardware/             # ESP32 single-gate firmware (UNLOCK/LOCK/DENY/BEEP only)
scripts/              # download-models.ps1 (YuNet + EdgeFace-XXS, never commit .onnx)
docs/SLSv3-ARCHITECTURE.md
```

## Quickstart

```powershell
# 1. core logic (fast, no native deps)
cargo test -p sls-core

# 2. fetch face models (not in git)
.\scripts\download-models.ps1

# 3. backend (one-time)
supabase init   # inside supabase/
supabase db push

# 4. desktop (needs Rust + MSVC build tools + Node 18+)
cd desktop; npm install; npm run tauri:dev
```

## Face engine (v3 upgrade)

- **Detect**: YuNet (`face_detection_yunet_2023mar.onnx`, ~200KB) — unchanged, still best size/accuracy for kiosk.
- **Recognize**: EdgeFace-XXS (`edgeface_xxs.onnx`, ~4.9MB, 512-d) — replaces SFace/ArcFace.
  LFW 99.57% vs SFace ~99.4%, ~2ms/face CPU, 7× smaller than SFace alone.
  Sources: `edgeface-onnx` releases / UniFace model zoo.
- **Runtime**: `ort` (ONNX Runtime) with DirectML EP on Windows, CPU fallback.
  ~40% faster than `tract` on same CNNs, I/O binding removes per-frame allocs.
  No pure-Rust fallback shipped — CPU EP covers machines without DirectML.
- **Thresholds are per-model** — EdgeFace cosine cutoffs must be re-tuned (≈0.40 start, validate on your gym data). Do NOT reuse SFace 0.62.
- **Brightness**: `assess(mean_luma)` returns an `ExposureVerdict` (TooDark/Good/TooBright/Unusable) and `gamma_for()` drives the pre-embed gamma adjust. Kiosk UI shows a live exposure hint.

## POS optimizations

- Money = `i64` cents everywhere (`Money = i64`). No floats.
- Single `checkout(cart) -> total, change` pure function — unit-tested.
- SQLite: covering indexes, WAL mode, outbox for offline sales sync.
- UI: product grid capped at 50 rows (debounced search 150ms), stock decrement, offline queue.

## License (offline-capable, Supabase-managed)

`GPOS-<b64url_claims>.<b64url_sig>` — RSA-2048 PSS + SHA-256, same wire format as v2
so existing keys verify. Issue = Edge Function (private key in vault), verify = desktop
(embedded public key + HWID + 3-day grace + `revoked` poll on sync).
Heartbeat: the terminal must touch `sync` at least every **7 days** — a boot after
that window refuses the cached license (fail-closed) until the key is re-applied.

## Single-camera gate

No In/Out/Tailgate state machine. `attendance_logs(direction='in')` only.
Cooldown 3s per identity. ESP32 speaks `UNLOCK:<secs>` (cap 30s), `DENY`, `BEEP`.
