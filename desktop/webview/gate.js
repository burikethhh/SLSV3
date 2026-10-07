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
let offscreenCanvas = null;
let consecutiveNoFace = 0;
let currentHintText = "";
let currentHintColor = "";
let lastDenyAlertTime = 0;

const FRAME_MS = 400; // ~2.5 fps — enough for walk-up gate, cheap on CPU
const HINT_MS = 3000; // hold match/deny message
const DOOR_MS = 5000; // hw_status poll (auto-connect supervisor runs in Rust)

const ADMIT_PASS_COOLDOWN_MS = 5000; // 5s rate limit / cooldown to avoid scan spam
const STREAM_DEDUPE_MS = 5000; // 5s stream deduplication for same entry/exit

const lastAdmitSuccess = new Map(); // memberId -> timestamp of admission

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

  // Exit (Button) Trigger
  const exitBtn = document.getElementById("gate-exit-btn");
  if (exitBtn && !exitBtn.dataset.bound) {
    exitBtn.dataset.bound = "1";
    exitBtn.addEventListener("click", () => triggerExitButton());
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
  busy = false;
  consecutiveNoFace = 0;
  currentHintText = "";
  currentHintColor = "";
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
// Runtime cache only — filled from attendance_list(). No seed names in prod:
// an empty gym shows the empty state, not fake hunters.
const memberStats = {};

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
          const isExit = l.member_id === "EXIT_BUTTON" || (l.direction || "in") === "out";
          const visitsToday = l.visits_today || 1;
          const totalVisits = l.total_visits || 1;
          const rankInfo = (isOverride || isExit) ? null : calculateHunterRank(totalVisits);
          if (l.member_id && !isOverride && !isExit) {
            memberStats[l.member_id] = {
              visitsToday,
              totalVisits,
              name: l.full_name,
            };
          }
          return {
            id: l.member_id,
            name: l.full_name || (isOverride ? "MANUAL GATE OVERRIDE" : isExit ? "EXIT (BUTTON)" : "Hunter " + (l.member_id || "").slice(0, 8)),
            direction: l.direction || "in",
            confidence: l.confidence,
            time: formatTime(l.created_at),
            visitsToday,
            totalVisits,
            rank: isOverride ? "OVERRIDE" : isExit ? "EXIT" : (l.rank || rankInfo?.rank || "E"),
          };
        });
        todayCount = logs.filter((l) => (l.direction || "in") === "in").length;
      }
    } catch {
      // fallback to initial state
    }
  }

  // Empty gym = empty state (renderAttendanceStream shows "no check-ins yet").
  // Never seed fake hunters into a production bundle.
  if (streamItems.length === 0) {
    todayCount = 0;
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
    countBadge.textContent = `${todayCount} IN TODAY`;
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
      const isExit = item.id === "EXIT_BUTTON" || item.direction === "out" || item.rank === "EXIT";
      const isOverride = item.id === "MANUAL_OVERRIDE" || item.rank === "OVERRIDE";
      const totalVisits = item.totalVisits || 1;
      const visitsToday = item.visitsToday || 1;
      const rankInfo = (isOverride || isExit) ? null : calculateHunterRank(totalVisits);
      const rank = item.rank || (rankInfo ? rankInfo.rank : "E");
      const badgeCls = isOverride
        ? "badge-warn"
        : isExit
        ? "badge-rank-b"
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
      const badgeText = isOverride ? "OVERRIDE" : isExit ? "EXIT (BUTTON)" : `${rank}-RANK · ${visitTag} VISIT`;

      const subLine = isOverride
        ? `<span class="att-conf" style="color:#fbbf24;">STAFF ACTION</span>`
        : isExit
        ? `<span class="att-conf" style="color:#38bdf8;">DOOR UNLOCKED</span>`
        : `<span class="att-conf">${pct}% MATCH · ${totalVisits} SESSIONS</span>`;

      return `
        <div class="attendance-item ${isOverride ? "att-item-override" : ""} ${isExit ? "att-item-out" : "att-item-inside"}" data-member-id="${item.id}">
          <div class="att-item-top">
            <span class="att-item-name" style="${isOverride ? "color:#fcd34d;font-weight:700;" : isExit ? "color:#38bdf8;font-weight:600;" : ""}" title="${item.name}">${item.name}</span>
            <div style="display:flex;align-items:center;gap:4px">
              <span class="badge ${badgeCls}" style="padding:1px 7px;font-size:10px;font-weight:700">${badgeText}</span>
            </div>
          </div>
          <div class="att-item-bot">
            ${subLine}
            <div style="display:flex;align-items:center;gap:6px">
              <span>${item.time}</span>
            </div>
          </div>
        </div>`;
    })
    .join("");
}

function prependAttendanceArrival(memberId, name, score) {
  const now = Date.now();
  // Prevent duplicate repetition on the live stream
  const top = streamItems[0];
  if (top && top.id === memberId && top.direction === "in" && (now - (top._ts || 0) < STREAM_DEDUPE_MS)) {
    return;
  }

  const stat = memberStats[memberId] || { visitsToday: 0, totalVisits: 0, name: name };
  stat.visitsToday = (stat.visitsToday || 0) + 1;
  stat.totalVisits = (stat.totalVisits || 0) + 1;
  stat.is_inside = true;
  if (name) stat.name = name;
  memberStats[memberId] = stat;

  const rankInfo = calculateHunterRank(stat.totalVisits);
  const item = {
    id: memberId,
    name: stat.name || ("Hunter " + memberId.slice(0, 8)),
    direction: "in",
    is_inside: true,
    confidence: score,
    time: "Just now",
    visitsToday: stat.visitsToday,
    totalVisits: stat.totalVisits,
    rank: rankInfo.rank,
    _ts: now,
  };
  streamItems.unshift(item);
  if (streamItems.length > 40) streamItems.pop();
  todayCount++;
  renderAttendanceStream();
}

export function prependAttendanceExit() {
  const now = Date.now();
  const top = streamItems[0];
  if (top && top.id === "EXIT_BUTTON" && (now - (top._ts || 0) < STREAM_DEDUPE_MS)) {
    return;
  }

  const item = {
    id: "EXIT_BUTTON",
    name: "EXIT (BUTTON)",
    direction: "out",
    is_inside: false,
    confidence: 1.0,
    time: "Just now",
    visitsToday: 1,
    totalVisits: 1,
    rank: "EXIT",
    _ts: now,
  };
  streamItems.unshift(item);
  if (streamItems.length > 40) streamItems.pop();
  renderAttendanceStream();
}
window.__sls_log_exit = prependAttendanceExit;

export async function triggerExitButton() {
  try {
    if (invoke) {
      await invoke("gate_exit_button");
      setDoor("unlocked for exit", "#38bdf8");
    } else {
      setDoor("UNLOCKED FOR EXIT (SIMULATOR)", "#38bdf8");
      setTimeout(() => setDoor("SIMULATOR READY · CONTROLLER ONLINE", "#38bdf8"), 3000);
    }
    playChime("admit");
    showHint("EXIT (BUTTON) — Door Unlocked", "#38bdf8");
    prependAttendanceExit();
  } catch (e) {
    showHint(`Exit failed: ${e}`, "#ff6b6b");
    playChime("deny");
  }
}
window.__sls_trigger_exit = triggerExitButton;

export async function checkoutMember(memberId, optionalName) {
  return triggerExitButton();
}
window.__sls_checkout = checkoutMember;

export function prependManualOverride(operator) {
  const now = Date.now();
  const top = streamItems[0];
  if (top && top.id === "MANUAL_OVERRIDE" && (now - (top._ts || 0) < 4000)) {
    return;
  }
  const item = {
    id: "MANUAL_OVERRIDE",
    name: operator ? `MANUAL OVERRIDE (${operator})` : "MANUAL GATE OVERRIDE",
    direction: "in",
    is_inside: false,
    confidence: 1.0,
    time: "Just now",
    visitsToday: 1,
    totalVisits: 1,
    rank: "OVERRIDE",
    _ts: now,
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
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:600;color:#f1f5f9">${m.full_name}</span>
          </div>
          <div style="display:flex;gap:4px">
            <button class="primary" data-admit-id="${m.id}" data-admit-name="${m.full_name}">Admit (Entry)</button>
          </div>
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
    if (tickCount % 2 === 0) pollHardwareButtons();
    if (busy || !invoke) return;
    const video = document.getElementById("cam");
    if (!video || video.readyState < 2) return;

    busy = true;
    try {
      const dataUrl = grabFrame(video);
      const scan = await invoke("gate_scan_frame", { data_url: dataUrl });
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
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
  } else if (offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
  }
  const ctx = offscreenCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  return offscreenCanvas.toDataURL("image/jpeg", 0.85);
}


async function pollHardwareButtons() {
  if (!invoke) return;
  try {
    const btnEvents = await invoke("hw_poll_buttons");
    if (btnEvents && btnEvents.length > 0) {
      for (const ev of btnEvents) {
        if (ev.kind === "exit_btn") {
          playChime("admit");
          showHint("EXIT (BUTTON) — Door Unlocked", "#38bdf8");
          setDoor("unlocked for exit", "#38bdf8");
          prependAttendanceExit();
        }
      }
    }
  } catch {}
}

function applyScan(scan) {
  const exposure = document.getElementById("exposure");
  const match = document.getElementById("match");
  if (exposure && scan?.exposure) {
    const gamma = scan.gamma && scan.gamma !== 1 ? ` · γ=${scan.gamma.toFixed(2)}` : "";
    const expText = `${scan.exposure}${gamma}`;
    if (exposure.textContent !== expText) {
      exposure.textContent = expText;
      exposure.style.color =
        scan.exposure === "Good" ? "#3ddc97" : scan.exposure === "Unusable" ? "#ff6b6b" : "#ffd166";
    }
  }
  if (!match) return;

  if (scan?.matched) {
    consecutiveNoFace = 0;
    const [memberId, score] = scan.matched;
    const now = Date.now();
    const lastAdmit = lastAdmitSuccess.get(memberId) || 0;
    if (now - lastAdmit < ADMIT_PASS_COOLDOWN_MS) {
      const stat = memberStats[memberId];
      const displayName = stat?.name || ("Hunter " + memberId.slice(0, 8));
      showHint(`PASSING THROUGH · Welcome, ${displayName}`, "#3ddc97");
      return;
    }
    admit(memberId, score);
    return;
  }
  if (scan?.review) {
    consecutiveNoFace = 0;
    const [, score] = scan.review;
    showHint(`Lookalike ${(score * 100).toFixed(0)}% — ask staff to verify PIN`, "#ffd166");
    return;
  }
  if (scan?.face_score >= 0.55) {
    consecutiveNoFace = 0;
    showHint("Face not recognized — enroll at front desk", "#ffd166");
  } else if (scan?.exposure === "Unusable") {
    consecutiveNoFace = 0;
    showHint("Adjust lighting — face too dark/bright", "#ff6b6b");
  } else {
    consecutiveNoFace++;
    if (consecutiveNoFace >= 3) {
      showHint("Looking for face…", "#9aa4b2");
    }
  }
}

// ── Verdict Execution & Door Control ──────────────────────────────────────────
async function admit(memberId, score, optionalName) {
  const now = Date.now();
  const lastAdmit = lastAdmitSuccess.get(memberId) || 0;
  if (now - lastAdmit < ADMIT_PASS_COOLDOWN_MS) {
    const stat = memberStats[memberId] || { name: optionalName };
    const displayName = optionalName || stat.name || ("Hunter " + memberId.slice(0, 8));
    showHint(`PASSING THROUGH · Welcome, ${displayName}`, "#3ddc97");
    return;
  }

  try {
    let result = "ok";
    if (invoke) {
      result = await invoke("gate_checkin", { member_id: memberId, confidence: score });
    }

    if (result === "cooldown") {
      showHint("Already checked in — 5s Anti-Passback", "#ffd166");
      playChime("deny");
      triggerCooldownGuard();
      return;
    }

    // Success checkin:
    lastAdmitSuccess.set(memberId, now);

    // Audio Chime + Visual Flash + Telemetry Stream prepend
    playChime("admit");
    const stat = memberStats[memberId] || { visitsToday: 0, totalVisits: 0, name: optionalName };
    const nextToday = (stat.visitsToday || 0) + 1;
    const nextTotal = (stat.totalVisits || 0) + 1;
    const rankInfo = calculateHunterRank(nextTotal);
    const displayName = optionalName || stat.name || ("Hunter " + memberId.slice(0, 8));
    showHint(`Welcome, ${displayName}! [${rankInfo.rank}-Rank · Entry recorded]`, "#3ddc97");

    // Prepend arrival to the stream: records member name and checkin timestamp
    prependAttendanceArrival(memberId, optionalName, score);

    if (invoke) {
      try {
        await invoke("hw_unlock", { duration_ms: 3000 });
        setDoor("unlocked — maglock pulsed", "#3ddc97");
      } catch (e) {
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
    bar.style.animation = "cooldownDrain 5s linear forwards";
  }
  clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    wrap.style.display = "none";
  }, 5000);
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

  const stateUnchanged = currentHintText === text && currentHintColor === color;
  currentHintText = text;
  currentHintColor = color || "#e6e9f0";

  if (el.textContent !== text) el.textContent = text;
  if (el.style.color !== currentHintColor) el.style.color = currentHintColor;

  const card = document.querySelector(".cam-card");
  const retStatus = document.getElementById("reticle-status");
  const attract = document.querySelector(".reticle-attract");

  if (color === "#3ddc97") {
    if (retStatus && retStatus.textContent !== "VERIFIED // ADMITTED") {
      retStatus.textContent = "VERIFIED // ADMITTED";
      retStatus.style.color = "#34d399";
    }
    if (attract && attract.style.display !== "none") attract.style.display = "none";
    if (card) {
      card.classList.remove("admit-flash", "deny-shake");
      void card.offsetWidth;
      card.classList.add("admit-flash");
      setTimeout(() => card.classList.remove("admit-flash"), 1600);
    }
  } else if (color === "#ff6b6b" || (color === "#ffd166" && text.includes("not recognized"))) {
    if (retStatus && retStatus.textContent !== "DENIED // UNRECOGNIZED") {
      retStatus.textContent = "DENIED // UNRECOGNIZED";
      retStatus.style.color = "#f87171";
    }
    if (attract && attract.style.display !== "none") attract.style.display = "none";
    // Only pulse deny alert if it's a new state or after 4s cooldown
    const now = Date.now();
    if (card && (!stateUnchanged || now - lastDenyAlertTime > 4000)) {
      lastDenyAlertTime = now;
      card.classList.remove("admit-flash", "deny-shake");
      void card.offsetWidth;
      card.classList.add("deny-shake");
      setTimeout(() => card.classList.remove("deny-shake"), 800);
    }
  } else {
    if (retStatus && retStatus.textContent !== "TARGETING ACTIVE") {
      retStatus.textContent = "TARGETING ACTIVE";
      retStatus.style.color = "";
    }
    if (attract && attract.style.display !== "") attract.style.display = "";
    if (card && card.classList.contains("deny-shake")) {
      card.classList.remove("deny-shake");
    }
  }

  el.dataset.until = String(Date.now() + HINT_MS);
}
