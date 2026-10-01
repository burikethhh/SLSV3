// Gate view — single camera. Rust runs YuNet+EdgeFace+brightness; JS only
// captures canvas frames, invokes gate_scan_frame, and shows the verdict.
// Features: Live Attendance Telemetry Stream on the left, audio synthesizer chimes,
// anti-passback cooldown visualizer, manual search/admit, and camera recovery.

const invoke = window.__TAURI__?.core?.invoke;
let timer = null;
let busy = false;
let cooldownTimer = null;
let knownMembers = new Map();
let streamItems = [];
let todayCount = 0;

const FRAME_MS = 400; // ~2.5 fps — enough for walk-up gate, cheap on CPU
const HINT_MS = 3000; // hold match/deny message
const DOOR_MS = 5000; // hw_status poll (auto-connect supervisor runs in Rust)

export function initGate() {
  const exposure = document.getElementById("exposure");
  const match = document.getElementById("match");
  if (exposure && !exposure.dataset.bound) {
    exposure.dataset.bound = "1";
    exposure.textContent = invoke ? "Waiting for camera…" : "Good · γ=1.00 (Simulator)";
    if (!invoke) exposure.style.color = "#3ddc97";
  }
  if (match && !match.dataset.bound) {
    match.dataset.bound = "1";
    match.textContent = invoke ? "" : "ALIGN FACE TO ENTER · BIOMETRIC GATEWAY";
    if (!invoke) match.style.color = "#d8b4fe";
  }

  // Audio Chime Toggle
  const soundBtn = document.getElementById("gate-sound-btn");
  const updateChimeUI = (btn, on) => {
    if (!btn) return;
    const icon = on
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`
      : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
    btn.innerHTML = `${icon}<span>Chime: ${on ? "ON" : "OFF"}</span>`;
  };
  if (soundBtn && !soundBtn.dataset.bound) {
    soundBtn.dataset.bound = "1";
    const soundOn = localStorage.getItem("sls.gate.sound") !== "0";
    updateChimeUI(soundBtn, soundOn);
    soundBtn.addEventListener("click", () => {
      const cur = localStorage.getItem("sls.gate.sound") !== "0";
      const next = !cur;
      localStorage.setItem("sls.gate.sound", next ? "1" : "0");
      updateChimeUI(soundBtn, next);
      if (next) playChime("admit");
    });
  }

  // Manual Admit Search Box Toggle
  const manualBtn = document.getElementById("gate-manual-btn");
  const manualBox = document.getElementById("stream-manual-box");
  const searchInput = document.getElementById("stream-search-input");
  if (manualBtn && !manualBtn.dataset.bound) {
    manualBtn.dataset.bound = "1";
    manualBtn.addEventListener("click", () => {
      if (!manualBox) return;
      const isHidden = manualBox.style.display === "none";
      manualBox.style.display = isHidden ? "flex" : "none";
      if (isHidden && searchInput) {
        searchInput.focus();
        searchManualMembers(searchInput.value);
      }
    });
  }
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "1";
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => searchManualMembers(searchInput.value), 200);
    });
  }

  // Camera Reconnect Button
  const camRetry = document.getElementById("cam-retry");
  if (camRetry && !camRetry.dataset.bound) {
    camRetry.dataset.bound = "1";
    camRetry.addEventListener("click", () => {
      window.__sls_start_cam?.();
    });
  }

  // Preload known members & attendance stream
  loadAttendanceStream();

  refreshDoor();
  if (invoke) {
    startLoop();
  } else {
    setDoor("SIMULATOR READY · CONTROLLER ONLINE", "#38bdf8");
  }
}

export function stopGate() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// ── Web Audio Chime Synthesizer (Zero external audio files required) ──────────
function playChime(type) {
  try {
    if (localStorage.getItem("sls.gate.sound") === "0") return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    if (type === "admit") {
      // Ascending triumphant dual chime: 880Hz (A5) -> 1320Hz (E6)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === "deny") {
      // Low dual buzz: 180Hz sawtooth wave
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(180, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch {
    // AudioContext blocked or unsupported, fail silently
  }
}

// ── Live Attendance Telemetry Stream ──────────────────────────────────────────
// ── Hunter Attendance Progression & Member Stats ──────────────────────────────
const memberStats = {
  "m-01": { visitsToday: 1, totalVisits: 104, name: "Sung Jinwoo" },
  "m-02": { visitsToday: 2, totalVisits: 72, name: "Cha Hae-In" },
  "m-03": { visitsToday: 1, totalVisits: 38, name: "Choi Jong-In" },
  "m-04": { visitsToday: 1, totalVisits: 19, name: "Baek Yoonho" },
  "m-05": { visitsToday: 1, totalVisits: 8, name: "Yoo Jinho" },
  "m-06": { visitsToday: 1, totalVisits: 3, name: "Kang Taeshik" },
};

function calculateHunterRank(totalVisits) {
  const count = totalVisits || 1;
  if (count >= 100) return { rank: "S", title: "Monarch", badgeCls: "badge-ultra" };
  if (count >= 50) return { rank: "A", title: "Elite", badgeCls: "badge-pro" };
  if (count >= 25) return { rank: "B", title: "Veteran", badgeCls: "badge-rank-b" };
  if (count >= 10) return { rank: "C", title: "Hunter", badgeCls: "badge-rank-c" };
  if (count >= 5) return { rank: "D", title: "Trainee", badgeCls: "badge-rank-d" };
  return { rank: "E", title: "Novice", badgeCls: "badge-rank-e" };
}

function getVisitSuffix(num) {
  const n = num || 1;
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}ST`;
  if (j === 2 && k !== 12) return `${n}ND`;
  if (j === 3 && k !== 13) return `${n}RD`;
  return `${n}TH`;
}

// ── Live Attendance Telemetry Stream ──────────────────────────────────────────
async function loadAttendanceStream() {
  const listEl = document.getElementById("attendance-list");
  if (!listEl) return;

  if (invoke) {
    try {
      const logs = await invoke("attendance_list", { limit: 30 });
      if (logs && logs.length > 0) {
        streamItems = logs.map((l) => {
          const isOverride = l.member_id === "MANUAL_OVERRIDE";
          const visitsToday = l.visits_today || 1;
          const totalVisits = l.total_visits || 1;
          const rankInfo = isOverride ? null : calculateHunterRank(totalVisits);
          if (l.member_id && !isOverride) {
            memberStats[l.member_id] = {
              visitsToday,
              totalVisits,
              name: l.full_name,
            };
          }
          return {
            id: l.member_id,
            name: l.full_name || (isOverride ? "MANUAL GATE OVERRIDE" : "Hunter " + (l.member_id || "").slice(0, 8)),
            confidence: l.confidence,
            time: formatTime(l.created_at),
            visitsToday,
            totalVisits,
            rank: isOverride ? "OVERRIDE" : (l.rank || rankInfo.rank),
          };
        });
        todayCount = logs.length;
      }
    } catch {
      // fallback to initial state
    }
  }

  // Fallback simulator items if no database records exist yet (diversified realistic ranks)
  if (streamItems.length === 0) {
    streamItems = [
      { id: "m-01", name: "Sung Jinwoo", confidence: 0.994, time: "Just now", visitsToday: 1, totalVisits: 104, rank: "S" },
      { id: "m-02", name: "Cha Hae-In", confidence: 0.987, time: "3m ago", visitsToday: 2, totalVisits: 72, rank: "A" },
      { id: "m-03", name: "Choi Jong-In", confidence: 0.952, time: "8m ago", visitsToday: 1, totalVisits: 38, rank: "B" },
      { id: "m-04", name: "Baek Yoonho", confidence: 0.941, time: "14m ago", visitsToday: 1, totalVisits: 19, rank: "C" },
      { id: "m-05", name: "Yoo Jinho", confidence: 0.915, time: "22m ago", visitsToday: 1, totalVisits: 8, rank: "D" },
      { id: "m-06", name: "Kang Taeshik", confidence: 0.884, time: "35m ago", visitsToday: 1, totalVisits: 3, rank: "E" },
    ];
    todayCount = streamItems.length;
  }

  renderAttendanceStream();
}

function formatTime(isoStr) {
  if (!isoStr) return "Just now";
  try {
    const d = new Date(isoStr);
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return "Just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return isoStr;
  }
}

function renderAttendanceStream() {
  const listEl = document.getElementById("attendance-list");
  const countBadge = document.getElementById("stream-count-badge");
  if (!listEl) return;

  if (countBadge) {
    countBadge.textContent = `${todayCount} TODAY`;
  }

  if (streamItems.length === 0) {
    listEl.innerHTML = `
      <div class="att-empty">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" style="opacity:0.4">
          <circle cx="12" cy="12" r="10" stroke-dasharray="4 4" stroke-width="2"/>
          <path d="M12 6v6l4 2" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <div><strong>NO ARRIVALS RECORDED</strong></div>
        <div style="font-size:11px">Verified scans appear here live in real-time</div>
      </div>`;
    return;
  }

  listEl.innerHTML = streamItems
    .map((item) => {
      const isOverride = item.id === "MANUAL_OVERRIDE" || item.rank === "OVERRIDE";
      const totalVisits = item.totalVisits || 1;
      const visitsToday = item.visitsToday || 1;
      const rankInfo = isOverride ? null : calculateHunterRank(totalVisits);
      const rank = item.rank || (rankInfo ? rankInfo.rank : "E");
      const badgeCls = isOverride
        ? "badge-warn"
        : rank === "S"
        ? "badge-ultra"
        : rank === "A"
        ? "badge-pro"
        : rank === "B"
        ? "badge-rank-b"
        : rank === "C"
        ? "badge-rank-c"
        : rank === "D"
        ? "badge-rank-d"
        : "badge-rank-e";

      const pct = Math.round((item.confidence || 0.9) * 100);
      const visitTag = getVisitSuffix(visitsToday);
      const badgeText = isOverride ? "OVERRIDE" : `${rank}-RANK · ${visitTag} VISIT`;

      return `
        <div class="attendance-item ${isOverride ? "att-item-override" : ""}">
          <div class="att-item-top">
            <span class="att-item-name" style="${isOverride ? "color:#fcd34d;font-weight:700;" : ""}" title="${item.name}">${item.name}</span>
            <span class="badge ${badgeCls}" style="padding:1px 7px;font-size:10px;font-weight:700">${badgeText}</span>
          </div>
          <div class="att-item-bot">
            <span class="att-conf" style="${isOverride ? "color:#fbbf24;" : ""}">
              ${isOverride ? "STAFF ACTION" : `${pct}% MATCH · ${totalVisits} SESSIONS`}
            </span>
            <span>${item.time}</span>
          </div>
        </div>`;
    })
    .join("");
}

function prependAttendanceArrival(memberId, name, score) {
  const stat = memberStats[memberId] || { visitsToday: 0, totalVisits: 0, name: name };
  stat.visitsToday = (stat.visitsToday || 0) + 1;
  stat.totalVisits = (stat.totalVisits || 0) + 1;
  if (name) stat.name = name;
  memberStats[memberId] = stat;

  const rankInfo = calculateHunterRank(stat.totalVisits);
  const item = {
    id: memberId,
    name: stat.name || ("Hunter " + memberId.slice(0, 8)),
    confidence: score,
    time: "Just now",
    visitsToday: stat.visitsToday,
    totalVisits: stat.totalVisits,
    rank: rankInfo.rank,
  };
  streamItems.unshift(item);
  if (streamItems.length > 40) streamItems.pop();
  todayCount++;
  renderAttendanceStream();
}

export function prependManualOverride(operator) {
  const item = {
    id: "MANUAL_OVERRIDE",
    name: operator ? `MANUAL OVERRIDE (${operator})` : "MANUAL GATE OVERRIDE",
    confidence: 1.0,
    time: "Just now",
    visitsToday: 1,
    totalVisits: 1,
    rank: "OVERRIDE",
  };
  streamItems.unshift(item);
  if (streamItems.length > 40) streamItems.pop();
  todayCount++;
  renderAttendanceStream();
}
window.__sls_log_override = prependManualOverride;

// ── Manual Search & Admit Lookup ──────────────────────────────────────────────
async function searchManualMembers(q) {
  const resBox = document.getElementById("stream-manual-results");
  if (!resBox) return;

  let results = [];
  if (invoke) {
    try {
      results = await invoke("member_search", { q: q.trim() });
    } catch {
      results = [];
    }
  } else {
    // Simulator mock roster
    const demo = [
      { id: "m-01", full_name: "Sung Jinwoo" },
      { id: "m-02", full_name: "Cha Hae-In" },
      { id: "m-03", full_name: "Choi Jong-In" },
      { id: "m-04", full_name: "Baek Yoonho" },
      { id: "m-05", full_name: "Go Gunhee" },
      { id: "m-06", full_name: "Yoo Jinho" },
    ];
    results = demo.filter((m) => m.full_name.toLowerCase().includes(q.toLowerCase()));
  }

  if (results.length === 0) {
    resBox.innerHTML = `<div class="muted" style="padding:6px;font-size:11px">No members found</div>`;
    return;
  }

  resBox.innerHTML = results
    .map(
      (m) => `
      <div class="stream-manual-row">
        <span style="font-weight:600;color:#f1f5f9">${m.full_name}</span>
        <button class="primary" data-admit-id="${m.id}" data-admit-name="${m.full_name}">Admit</button>
      </div>`,
    )
    .join("");

  resBox.querySelectorAll("[data-admit-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.admitId;
      const name = btn.dataset.admitName;
      admit(id, 1.0, name);
      const manualBox = document.getElementById("stream-manual-box");
      if (manualBox) manualBox.style.display = "none";
    });
  });
}

// ── Camera Frame Grab & YuNet / EdgeFace Pipeline Loop ────────────────────────
function startLoop() {
  if (timer) return;
  let tickCount = 0;
  const tick = async () => {
    timer = setTimeout(tick, FRAME_MS);
    if (tickCount++ % Math.round(DOOR_MS / FRAME_MS) === 0) refreshDoor();
    if (busy || !invoke) return;
    const video = document.getElementById("cam");
    if (!video || video.readyState < 2) return;

    busy = true;
    try {
      const dataUrl = grabFrame(video);
      const scan = await invoke("gate_scan_frame", { dataUrl });
      applyScan(scan);
    } catch (e) {
      const match = document.getElementById("match");
      if (match) match.textContent = String(e);
    } finally {
      busy = false;
    }
  };
  timer = setTimeout(tick, FRAME_MS);
}

function grabFrame(video) {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  let canvas = document.getElementById("gate-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "gate-canvas";
    canvas.width = w;
    canvas.height = h;
    canvas.style.display = "none";
    document.body.appendChild(canvas);
  } else if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function applyScan(scan) {
  const exposure = document.getElementById("exposure");
  const match = document.getElementById("match");
  if (exposure && scan?.exposure) {
    const gamma = scan.gamma && scan.gamma !== 1 ? ` · γ=${scan.gamma.toFixed(2)}` : "";
    exposure.textContent = `${scan.exposure}${gamma}`;
    exposure.style.color =
      scan.exposure === "Good" ? "#3ddc97" : scan.exposure === "Unusable" ? "#ff6b6b" : "#ffd166";
  }
  if (!match) return;

  if (scan?.matched) {
    const [memberId, score] = scan.matched;
    admit(memberId, score);
    return;
  }
  if (scan?.review) {
    const [, score] = scan.review;
    showHint(`Lookalike ${(score * 100).toFixed(0)}% — ask staff to verify PIN`, "#ffd166");
    return;
  }
  if (scan?.face_score >= 0.6) {
    showHint("Face not recognized — enroll at front desk", "#ffd166");
  } else if (scan?.exposure === "Unusable") {
    showHint("Adjust lighting — face too dark/bright", "#ff6b6b");
  } else {
    showHint("Looking for face…", "#9aa4b2");
  }
}

// ── Verdict Execution & Door Control ──────────────────────────────────────────
async function admit(memberId, score, optionalName) {
  try {
    let result = "ok";
    if (invoke) {
      result = await invoke("gate_checkin", { memberId, confidence: score });
    }

    if (result === "cooldown") {
      showHint("Already checked in — 3s Anti-Passback", "#ffd166");
      playChime("deny");
      triggerCooldownGuard();
      return;
    }

    // Success: Audio Chime + Visual Flash + Telemetry Stream prepend
    playChime("admit");
    const stat = memberStats[memberId] || { visitsToday: 0, totalVisits: 0, name: optionalName };
    const nextToday = (stat.visitsToday || 0) + 1;
    const nextTotal = (stat.totalVisits || 0) + 1;
    const rankInfo = calculateHunterRank(nextTotal);
    const displayName = optionalName || stat.name || ("Hunter " + memberId.slice(0, 8));
    showHint(`Welcome, ${displayName}! [${rankInfo.rank}-Rank · Visit #${nextToday} today]`, "#3ddc97");

    // Prepend arrival to the stream
    prependAttendanceArrival(memberId, optionalName, score);

    if (invoke) {
      try {
        await invoke("hw_unlock", { durationMs: 3000 });
        setDoor("unlocked — maglock pulsed", "#3ddc97");
      } catch (e) {
        // Never swallow: a gate that greets but doesn't open looks "fine" until class starts.
        setDoor(`NOT OPENING — ${e}`, "#ff6b6b");
      }
    } else {
      setDoor("UNLOCKED · MAGLOCK PULSED (SIMULATOR)", "#34d399");
      setTimeout(() => setDoor("SIMULATOR READY · CONTROLLER ONLINE", "#38bdf8"), 3000);
    }
  } catch (e) {
    showHint(String(e), "#ff6b6b");
    playChime("deny");
  }
}

function triggerCooldownGuard() {
  const wrap = document.getElementById("cooldown-wrap");
  if (!wrap) return;
  wrap.style.display = "block";
  const bar = wrap.querySelector(".cooldown-bar");
  if (bar) {
    bar.style.animation = "none";
    void bar.offsetWidth; // reset CSS animation
    bar.style.animation = "cooldownDrain 3s linear forwards";
  }
  clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    wrap.style.display = "none";
  }, 3000);
}

async function refreshDoor() {
  if (!invoke) return;
  try {
    const st = await invoke("hw_status");
    if (!st?.feature) {
      setDoor("controller disabled in this build", "#ff6b6b");
    } else if (st?.connected) {
      setDoor(`controller on ${st.port}`, "#3ddc97");
    } else {
      setDoor("waiting for ESP32 controller…", "#ffd166");
    }
  } catch (e) {
    setDoor(String(e), "#ff6b6b");
  }
  // Staged-update banner (boot auto-install or Settings manual install).
  try {
    const pending = await invoke("settings_get", { key: "pending_restart" }).catch(() => null);
    const banner = document.getElementById("update-banner");
    if (banner) {
      if (pending && banner.dataset.v !== pending) {
        banner.dataset.v = pending;
        banner.hidden = false;
        banner.textContent = `Update v${pending} installed — restart when class ends. `;
        const b = document.createElement("button");
        b.textContent = "Restart";
        b.onclick = () => invoke("restart_app");
        banner.appendChild(b);
      } else if (!pending) {
        banner.hidden = true;
        banner.dataset.v = "";
      }
    }
  } catch { /* banner is best-effort; the gate loop must not die */ }
}

function setDoor(text, color) {
  const el = document.getElementById("door");
  if (!el) return;
  el.textContent = text;
  el.style.color = color || "#9aa4b2";
}

function showHint(text, color) {
  const el = document.getElementById("match");
  if (!el) return;
  el.textContent = text;
  el.style.color = color || "#e6e9f0";
  // Admitted verdict goes big — the kiosk moment.
  el.style.fontSize = color === "#3ddc97" ? "2.2rem" : "";

  const card = document.querySelector(".cam-card");
  const retStatus = document.getElementById("reticle-status");
  const attract = document.querySelector(".reticle-attract");

  if (color === "#3ddc97") {
    if (retStatus) {
      retStatus.textContent = "VERIFIED // ADMITTED";
      retStatus.style.color = "#34d399";
    }
    if (attract) attract.style.display = "none";
    if (card) {
      card.classList.remove("admit-flash", "deny-shake");
      void card.offsetWidth; // restart the animation
      card.classList.add("admit-flash");
      setTimeout(() => card.classList.remove("admit-flash"), 1600);
    }
  } else if (color === "#ff6b6b" || (color === "#ffd166" && text.includes("not recognized"))) {
    if (retStatus) {
      retStatus.textContent = "DENIED // UNRECOGNIZED";
      retStatus.style.color = "#f87171";
    }
    if (card) {
      card.classList.remove("admit-flash", "deny-shake");
      void card.offsetWidth; // restart the animation
      card.classList.add("deny-shake");
      setTimeout(() => card.classList.remove("deny-shake"), 800);
    }
  } else {
    if (retStatus) {
      retStatus.textContent = "TARGETING ACTIVE";
      retStatus.style.color = "";
    }
    if (attract) attract.style.display = "";
  }

  el.dataset.until = String(Date.now() + HINT_MS);
}
