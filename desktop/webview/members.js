// Members — list local roster + enroll face with live biometric viewfinder.
const invoke = window.__TAURI__?.core?.invoke;
let filterTimer;
let previewLoopTimer = null;

const PREVIEW_MEMBERS = [
  { id: "sls-sjw-9999", full_name: "Sung Jin-Woo", rank: "S", totalVisits: 104 },
  { id: "sls-chi-8888", full_name: "Cha Hae-In", rank: "A", totalVisits: 72 },
  { id: "sls-cji-5555", full_name: "Choi Jong-In", rank: "B", totalVisits: 38 },
  { id: "sls-yjh-3333", full_name: "Yoo Jin-Ho", rank: "D", totalVisits: 8 },
  { id: "sls-ggh-7777", full_name: "Go Gun-Hee", rank: "S", totalVisits: 120 },
  { id: "sls-kts-1111", full_name: "Kang Taeshik", rank: "E", totalVisits: 3 },
];

export async function initMembers() {
  const root = document.getElementById("view-members");
  if (!root) return;

  if (!root.dataset.bound) {
    root.dataset.bound = "1";
    root.innerHTML = `
      <div class="page-head">
        <h2>Hunter Roster &amp; Biometric Enrollment</h2>
        <span class="badge badge-brand">512-d EdgeFace · YuNet Landmarks</span>
      </div>

      <div class="enroll-grid">
        <!-- LEFT: Live Biometric Viewfinder -->
        <div class="glass panel enroll-viewfinder-card">
          <div class="enroll-cam-wrap">
            <video id="enroll-cam" autoplay playsinline muted></video>
            <div id="enroll-cam-overlay" class="enroll-cam-overlay">
              <div class="reticle-corner tl"></div>
              <div class="reticle-corner tr"></div>
              <div class="reticle-corner bl"></div>
              <div class="reticle-corner br"></div>
              <div class="enroll-reticle-center">
                <div id="enroll-oval" class="enroll-oval"></div>
              </div>
              <div class="enroll-hud-top">
                <span class="hud-pulse"><span class="hud-dot"></span> <span id="enroll-hud-status">CAMERA ACTIVE</span></span>
                <span id="enroll-hud-exp" class="badge good" style="font-size:10px;padding:2px 8px">GOOD · γ=1.00</span>
              </div>
              <div id="enroll-flash" class="enroll-flash-overlay"></div>
            </div>
          </div>
          <div class="enroll-meter-row">
            <div class="enroll-meter-label">
              <span>BIOMETRIC LOCK</span>
              <span id="enroll-meter-val" style="color:var(--cyan)">TARGETING</span>
            </div>
            <div class="enroll-meter-bar-wrap">
              <div id="enroll-meter-bar" class="enroll-meter-bar" style="width:30%"></div>
            </div>
          </div>
        </div>

        <!-- RIGHT: Hunter Enrollment Controls -->
        <div class="glass panel enroll-form-card">
          <div>
            <div class="enroll-form-head">
              <div class="enroll-emblem">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--brand);filter:drop-shadow(0 0 6px var(--brand));"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              </div>
              <div>
                <div class="enroll-form-title">ENROLL NEW HUNTER</div>
                <p class="hint" style="margin:2px 0 0">Register 512-dimensional facial embedding vectors into local vault.</p>
              </div>
            </div>

            <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:6px">
              Hunter Full Name
              <input id="mem-name" placeholder="e.g. Sung Jin-Woo" autocomplete="off" style="width:100%;margin-top:6px;font-size:14px" />
            </label>
            <label for="mem-plan">Membership plan</label><select id="mem-plan" required><option value="">Waiting for synced plans…</option></select>
            <p class="hint">The plan sets a membership expiry. Create plans in the dashboard and wait for sync. Record any membership payment through your approved process.</p>

            <div class="enroll-guidance">
              <div class="guidance-step">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#34d399;flex:none"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span>Position face inside illuminated targeting brackets</span>
              </div>
              <div class="guidance-step">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#34d399;flex:none"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span>Verify lighting quality and green biometric lock meter</span>
              </div>
              <div class="guidance-step">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#34d399;flex:none"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span>Click Enroll to extract cryptographic 512-d vector</span>
              </div>
            </div>
          </div>

          <div>
            <button id="mem-enroll" class="primary" style="width:100%;height:46px;font-size:15px;display:flex;align-items:center;justify-content:center;gap:8px">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
              <span>Enroll Biometric Face</span>
            </button>
            <div id="mem-msg" class="hint" style="min-height:1.4em;margin-top:8px;text-align:center;font-weight:600"></div>
          </div>
        </div>
      </div>

      <div class="glass panel" style="margin-top:14px">
        <div class="page-head" style="margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <h3 style="margin:0;font-size:1.15rem;color:var(--cyan);letter-spacing:1px">ENROLLED HUNTER ROSTER</h3>
            <span id="mem-count-badge" class="badge badge-brand">0 REGISTERED</span>
          </div>
          <input id="mem-q" placeholder="Filter hunters by name…" style="width:260px" />
        </div>
        <div id="member-list"></div>
      </div>`;

    document.getElementById("mem-q")?.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(list, 150);
    });
    const enrollBtn = document.getElementById("mem-enroll");
    if (enrollBtn) enrollBtn.onclick = enroll;
  }

  // Bind video stream
  bindEnrollCamera();
  startEnrollLoop();
  await list();
  if(invoke) {
    const plans=await invoke("plans_list");const select=document.getElementById("mem-plan");const previous=select.value;
    select.innerHTML='<option value="">Select a membership plan…</option>'+plans.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${p.duration_days} days · ₱ ${(p.price_cents/100).toFixed(2)}</option>`).join("");
    select.value=previous;
  }
}

function bindEnrollCamera() {
  const enrollCam = document.getElementById("enroll-cam");
  if (!enrollCam) return;
  if (window.__sls_media_stream) {
    enrollCam.srcObject = window.__sls_media_stream;
  } else if (navigator.mediaDevices?.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { width: 640 } })
      .then((s) => {
        window.__sls_media_stream = s;
        enrollCam.srcObject = s;
        const cam = document.getElementById("cam");
        if (cam && !cam.srcObject) cam.srcObject = s;
      })
      .catch(() => {
        const hud = document.getElementById("enroll-hud-status");
        if (hud) hud.textContent = "CAM PERMISSION NEEDED";
      });
  }
}

function startEnrollLoop() {
  if (previewLoopTimer) return;
  const loop = async () => {
    previewLoopTimer = setTimeout(loop, 450);
    const v = document.getElementById("enroll-cam");
    const statusEl = document.getElementById("enroll-hud-status");
    const expEl = document.getElementById("enroll-hud-exp");
    const meterVal = document.getElementById("enroll-meter-val");
    const meterBar = document.getElementById("enroll-meter-bar");
    const oval = document.getElementById("enroll-oval");

    if (!v || v.readyState < 2) {
      if (!invoke) {
        // Simulator preview fallback
        if (statusEl) statusEl.textContent = "SIMULATOR ACTIVE";
        if (expEl) { expEl.textContent = "GOOD · γ=1.00"; expEl.className = "badge good"; }
        if (meterVal) { meterVal.textContent = "98% READY"; meterVal.style.color = "#34d399"; }
        if (meterBar) { meterBar.style.width = "98%"; meterBar.className = "enroll-meter-bar locked"; }
        if (oval) oval.classList.add("locked");
      }
      return;
    }

    if (!invoke) {
      if (statusEl) statusEl.textContent = "SIMULATOR ACTIVE";
      if (expEl) { expEl.textContent = "GOOD · γ=1.00"; expEl.className = "badge good"; }
      if (meterVal) { meterVal.textContent = "98% READY"; meterVal.style.color = "#34d399"; }
      if (meterBar) { meterBar.style.width = "98%"; meterBar.className = "enroll-meter-bar locked"; }
      if (oval) oval.classList.add("locked");
      return;
    }

    try {
      const dataUrl = grabFrame(v);
      const scan = await invoke("gate_scan_frame", { data_url: dataUrl });
      if (expEl && scan?.exposure) {
        const gamma = scan.gamma && scan.gamma !== 1 ? ` · γ=${scan.gamma.toFixed(2)}` : "";
        expEl.textContent = `${scan.exposure.toUpperCase()}${gamma}`;
        expEl.className = `badge ${scan.exposure === "Good" ? "good" : scan.exposure === "Unusable" ? "bad" : "warn"}`;
      }

      const score = scan?.face_score || 0;
      const isLocked = score >= 0.6 && scan?.exposure === "Good";

      if (oval) oval.classList.toggle("locked", isLocked);

      if (meterBar) {
        meterBar.style.width = `${Math.max(15, Math.round(score * 100))}%`;
        meterBar.className = `enroll-meter-bar ${isLocked ? "locked" : ""}`;
      }

      if (meterVal) {
        if (isLocked) {
          meterVal.textContent = `${Math.round(score * 100)}% LOCKED`;
          meterVal.style.color = "#34d399";
        } else if (score >= 0.3) {
          meterVal.textContent = "ALIGNING FACE…";
          meterVal.style.color = "#fbbf24";
        } else {
          meterVal.textContent = "LOOKING FOR FACE";
          meterVal.style.color = "var(--muted)";
        }
      }

      if (statusEl) {
        statusEl.textContent = isLocked ? "READY TO CAPTURE" : "TARGETING FACE";
      }
    } catch {
      // transient scan failure during camera focus
    }
  };
  previewLoopTimer = setTimeout(loop, 450);
}

export function stopEnrollLoop() {
  if (previewLoopTimer) clearTimeout(previewLoopTimer);
  previewLoopTimer = null;
}

async function list() {
  const el = document.getElementById("member-list");
  const countBadge = document.getElementById("mem-count-badge");
  if (!el) return;

  try {
    const q = (document.getElementById("mem-q")?.value ?? "").toLowerCase().trim();
    let rows = [];
    if (invoke) {
      rows = await invoke("member_search", { q });
    } else {
      rows = PREVIEW_MEMBERS.filter((m) => !q || m.full_name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    }

    if (countBadge) {
      countBadge.textContent = `${rows.length} REGISTERED`;
    }

    if (rows.length === 0) {
      el.innerHTML = `<p class="muted hint" style="padding:16px 0;text-align:center">No hunters match search criteria.</p>`;
      return;
    }

    el.innerHTML = `
      <table style="width:100%">
        <thead>
          <tr>
            <th>Hunter Name</th>
            <th>Rank</th>
            <th>System Member ID</th>
            <th>Biometric Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((r, idx) => {
              const rank = r.rank || (idx === 0 ? "S" : idx === 1 ? "A" : idx === 2 ? "B" : idx === 3 ? "D" : "C");
              const rankBadgeCls = rank === "S" ? "badge-ultra" : rank === "A" ? "badge-pro" : rank === "B" ? "badge-rank-b" : rank === "C" ? "badge-rank-c" : rank === "D" ? "badge-rank-d" : "badge-rank-e";
              const isFrozen = (r.status || "").toLowerCase() === "frozen";
              const isCancelled = (r.status || "").toLowerCase() === "cancelled";
              const isExpired = r.expires_at && !isNaN(Date.parse(r.expires_at)) && new Date(r.expires_at) < new Date();
              let statusBadge = `<span class="badge good"><span class="dot live"></span> Active · 512-d Vector</span>`;
              if (isFrozen) {
                statusBadge = `<span class="badge" style="background:rgba(234,179,8,0.2);color:#fbbf24;border:1px solid rgba(234,179,8,0.35)"><span class="dot" style="background:#fbbf24"></span> Frozen</span>`;
              } else if (isCancelled) {
                statusBadge = `<span class="badge" style="background:rgba(239,68,68,0.2);color:#f87171;border:1px solid rgba(239,68,68,0.35)"><span class="dot" style="background:#f87171"></span> Cancelled</span>`;
              } else if (isExpired) {
                const expDate = new Date(r.expires_at).toLocaleDateString();
                statusBadge = `<span class="badge" style="background:rgba(239,68,68,0.2);color:#f87171;border:1px solid rgba(239,68,68,0.35)"><span class="dot" style="background:#f87171"></span> Expired (${expDate})</span>`;
              }

              return `
                <tr>
                  <td style="font-weight:600;color:#fff">${esc(r.full_name)}</td>
                  <td><span class="badge ${rankBadgeCls}" style="padding:1px 7px;font-size:10px;font-weight:700">${rank}-RANK</span></td>
                  <td>
                    <div style="display:inline-flex;align-items:center;gap:6px">
                      <code class="hint" style="font-family:monospace;background:rgba(15,23,42,0.8);padding:3px 8px;border-radius:4px;border:1px solid rgba(56,189,248,0.2)">${esc(r.id)}</code>
                      <button class="mem-copy-btn" data-copy="${esc(r.id)}" title="Copy System ID">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                      </button>
                    </div>
                  </td>
                  <td>${statusBadge}</td>
                </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;

    // Bind copy buttons
    el.querySelectorAll(".mem-copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        if (text) {
          navigator.clipboard?.writeText(text);
          btn.style.color = "#3ddc97";
          setTimeout(() => { btn.style.color = ""; }, 1200);
        }
      });
    });
  } catch (e) {
    el.textContent = String(e);
  }
}

async function enroll() {
  const msg = document.getElementById("mem-msg");
  const nameInput = document.getElementById("mem-name");
  const name = nameInput?.value.trim();
  if (!name) {
    if (msg) {
      msg.textContent = "Please enter hunter full name before scanning.";
      msg.style.color = "#fbbf24";
    }
    nameInput?.focus();
    return;
  }

  // Trigger camera shutter flash animation
  const flash = document.getElementById("enroll-flash");
  if (flash) {
    flash.classList.add("flash");
    setTimeout(() => flash.classList.remove("flash"), 250);
  }

  // Synthesize triumphant capture sound
  playEnrollChime();

  if (!invoke) {
    const fakeId = "sls-" + Math.random().toString(36).substring(2, 8);
    PREVIEW_MEMBERS.unshift({ id: fakeId, full_name: name, rank: "E", totalVisits: 1 });
    if (msg) {
      msg.textContent = `Enrolled “${name}” — E-Rank Novice registered (100% vector generated).`;
      msg.style.color = "#3ddc97";
    }
    if (nameInput) nameInput.value = "";
    await list();
    return;
  }

  const video = document.getElementById("enroll-cam") || document.getElementById("cam");
  if (!video || video.readyState < 2) {
    if (msg) {
      msg.textContent = "Camera not ready — ensure webcam is plugged in and accessible.";
      msg.style.color = "#ff6b6b";
    }
    return;
  }

  if (msg) {
    msg.textContent = "Extracting 512-d cryptographic facial vector…";
    msg.style.color = "#38bdf8";
  }

  try {
    const dataUrl = grabFrame(video);
    const scan = await invoke("gate_scan_frame", { data_url: dataUrl });
    if (!scan?.embedding) {
      if (msg) {
        msg.textContent = scan?.exposure === "Unusable"
          ? "Lighting unusable — adjust lamp/ambient brightness and face camera."
          : "No face detected — center face inside illuminated brackets.";
        msg.style.color = "#ff6b6b";
      }
      return;
    }

    const memberId = crypto.randomUUID();
    const planId=document.getElementById("mem-plan")?.value;
    if(!planId) throw new Error("Select a membership plan before enrolling. Create plans in the dashboard if none are available.");
    await invoke("face_enroll", { member_id: memberId, full_name: name, embedding: scan.embedding, plan_id:planId });

    if (msg) {
      msg.textContent = `Successfully Enrolled “${name}” (${(scan.face_score * 100).toFixed(0)}% lock confidence).`;
      msg.style.color = "#3ddc97";
    }
    if (nameInput) nameInput.value = "";
    await list();
  } catch (e) {
    if (msg) {
      msg.textContent = String(e);
      msg.style.color = "#ff6b6b";
    }
  }
}

function playEnrollChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(523.25, now); // C5
    osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.15); // C6
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch {
    // Audio context unavailable
  }
}

function grabFrame(video) {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  let canvas = document.getElementById("enroll-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "enroll-canvas";
    canvas.style.display = "none";
    document.body.appendChild(canvas);
  }
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
