/**
 * Undermania - Main Conservatory Application Engine
 * Colors:
 *  - Principal:  #00FFFF
 *  - Secundario: #6C439C
 *  - Terciario:  #BD8FCC
 */

(function () {
  const COLORS = {
    primary: "#00FFFF",
    secondary: "#6C439C",
    tertiary: "#BD8FCC",
    bgDeep: "#090612",
    bgPanel: "#120C21",
    correct: "#00E676",
    error: "#FF3366",
  };

  // Piano range: A0 (21) to C8 (108), or focused 61/88 key view (C2=36 to C7=96 for crisp readability)
  const MIN_MIDI = 36; // C2
  const MAX_MIDI = 96; // C7

  const state = {
    song: null,
    isPlaying: false,
    currentTime: 0,
    lastFrameTime: 0,

    // 1. Practice Mode settings
    waitForNote: true,
    isWaitingForInput: false,
    waitingNotes: [],
    handMode: "both", // "both" | "right" | "left"
    speedPercent: 100,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 8,

    // 2. Visualization & Reading settings
    showSolfege: true,
    accidentalMode: "sharp", // "sharp" (#) | "flat" (b)
    showFingering: true, // 1-5 above notes
    staffScrollMode: "horizontal", // "horizontal" | "page"
    currentPage: 1,
    totalPages: 1,

    // 3. Execution Analysis state
    pressedKeys: new Map(), // midi -> { status: "correct" | "error", time: number }
    wrongNoteEvents: [], // { midi, time, createdAt } drawn in RED on the staff
    timingHistory: [], // recent ms offsets
    lastTimingDeltaMs: null,
    stats: {
      hits: 0,
      errors: 0,
      streak: 0,
    },
  };

  const audio = new window.UndermaniaAudioMidi.PianoAudioEngine();
  let midiManager = null;

  // DOM Elements
  const els = {};

  function cacheElements() {
    els.repertoireSelect = document.getElementById("repertoireSelect");
    els.fileInput = document.getElementById("fileInput");
    els.uploadBtn = document.getElementById("uploadBtn");
    els.midiDeviceSelect = document.getElementById("midiDeviceSelect");
    els.midiStatusDot = document.getElementById("midiStatusDot");
    els.midiStatusText = document.getElementById("midiStatusText");

    els.statHits = document.getElementById("statHits");
    els.statErrors = document.getElementById("statErrors");
    els.statAccuracy = document.getElementById("statAccuracy");
    els.statStreak = document.getElementById("statStreak");

    els.playPauseBtn = document.getElementById("playPauseBtn");
    els.restartBtn = document.getElementById("restartBtn");
    els.timelineContainer = document.getElementById("timelineContainer");
    els.timelineProgress = document.getElementById("timelineProgress");
    els.timelineLoopRegion = document.getElementById("timelineLoopRegion");
    els.timeCurrentLabel = document.getElementById("timeCurrentLabel");
    els.timeTotalLabel = document.getElementById("timeTotalLabel");
    els.songMetaLabel = document.getElementById("songMetaLabel");

    // Practice controls
    els.waitToggle = document.getElementById("waitToggle");
    els.handButtons = document.querySelectorAll("[data-hand]");
    els.speedSlider = document.getElementById("speedSlider");
    els.speedValueLabel = document.getElementById("speedValueLabel");
    els.speedPresetBtns = document.querySelectorAll("[data-speed]");

    els.loopToggle = document.getElementById("loopToggle");
    els.setLoopABtn = document.getElementById("setLoopABtn");
    els.setLoopBBtn = document.getElementById("setLoopBBtn");
    els.clearLoopBtn = document.getElementById("clearLoopBtn");
    els.loopRangeText = document.getElementById("loopRangeText");

    // Visualization controls
    els.solfegeToggle = document.getElementById("solfegeToggle");
    els.accidentalButtons = document.querySelectorAll("[data-accidental]");
    els.fingeringToggle = document.getElementById("fingeringToggle");
    els.scrollModeButtons = document.querySelectorAll("[data-scrollmode]");

    // Canvases & Indicators
    els.staffCanvas = document.getElementById("staffCanvas");
    els.waterfallCanvas = document.getElementById("waterfallCanvas");
    els.staffPageBadge = document.getElementById("staffPageBadge");
    els.waitBanner = document.getElementById("waitBanner");
    els.waitBannerText = document.getElementById("waitBannerText");

    els.timingIndicator = document.getElementById("timingIndicator");
    els.timingReadout = document.getElementById("timingReadout");
  }

  function isBlackKey(midi) {
    const pc = ((midi % 12) + 12) % 12;
    return [1, 3, 6, 8, 10].includes(pc);
  }

  function isHandActiveForPractice(noteHand) {
    if (state.handMode === "both") return true;
    return noteHand === state.handMode;
  }

  function loadSong(songObj) {
    state.song = JSON.parse(JSON.stringify(songObj));
    state.song.notes.forEach((n) => {
      n.status = "pending";
      n.autoPlayed = false;
    });
    state.currentTime = 0;
    state.isPlaying = false;
    state.isWaitingForInput = false;
    state.waitingNotes = [];
    state.wrongNoteEvents = [];
    state.stats = { hits: 0, errors: 0, streak: 0 };
    state.loopStart = 0;
    state.loopEnd = Math.min(state.song.duration, Math.max(4, Number((state.song.duration * 0.5).toFixed(1))));

    updateStatsUI();
    updateLoopUI();
    updateTransportUI();
    els.songMetaLabel.textContent = `${state.song.title} — ${state.song.composer} (${state.song.format} · ${state.song.bpm} BPM · ${state.song.timeSignature})`;
  }

  function resetNotesInRange(startSec, endSec) {
    if (!state.song) return;
    for (const n of state.song.notes) {
      if (n.startTime >= startSec - 0.05 && n.startTime <= endSec + 0.05) {
        n.status = "pending";
        n.autoPlayed = false;
      }
    }
  }

  function updateStatsUI() {
    els.statHits.textContent = state.stats.hits;
    els.statErrors.textContent = state.stats.errors;
    const total = state.stats.hits + state.stats.errors;
    const acc = total > 0 ? Math.round((state.stats.hits / total) * 100) : 100;
    els.statAccuracy.textContent = `${acc}%`;
    els.statStreak.textContent = state.stats.streak;
  }

  function updateTimingUI(deltaMs) {
    state.lastTimingDeltaMs = deltaMs;
    const clamped = Math.max(-150, Math.min(150, deltaMs));
    const pct = ((clamped + 150) / 300) * 100;
    els.timingIndicator.style.left = `${pct}%`;

    const absMs = Math.abs(Math.round(deltaMs));
    let verdict = "PERFECTO";
    let color = COLORS.primary;

    if (absMs <= 35) {
      verdict = "PERFECTO";
      color = COLORS.correct;
    } else if (deltaMs < 0) {
      verdict = "ANTES (Temprano)";
      color = absMs > 85 ? COLORS.error : "#FFD166";
    } else {
      verdict = "DESPUÉS (Tarde)";
      color = absMs > 85 ? COLORS.error : "#FFD166";
    }

    els.timingIndicator.style.background = color;
    els.timingIndicator.style.boxShadow = `0 0 10px ${color}`;
    const sign = deltaMs > 0 ? "+" : "";
    els.timingReadout.textContent = `${sign}${Math.round(deltaMs)} ms · ${verdict}`;
    els.timingReadout.style.color = color;
  }

  function handleUserNoteOn(midi, velocity = 100) {
    audio.noteOn(midi, velocity);

    if (!state.song) {
      state.pressedKeys.set(midi, { status: "correct", time: performance.now() });
      return;
    }

    // Search for a matching pending note for the active hand(s) near currentTime
    const toleranceSec = state.waitForNote ? 0.45 : 0.28;
    let matchedNote = null;
    let bestDiff = Infinity;

    for (const n of state.song.notes) {
      if (n.status !== "pending") continue;
      if (!isHandActiveForPractice(n.hand)) continue;
      if (n.midi !== midi) continue;

      const diff = state.currentTime - n.startTime; // negative = early, positive = late
      if (Math.abs(diff) <= toleranceSec && Math.abs(diff) < Math.abs(bestDiff)) {
        bestDiff = diff;
        matchedNote = n;
      }
    }

    if (matchedNote) {
      matchedNote.status = "hit";
      state.stats.hits += 1;
      state.stats.streak += 1;
      state.pressedKeys.set(midi, { status: "correct", time: performance.now() });

      const deltaMs = state.isWaitingForInput ? 0 : bestDiff * 1000;
      updateTimingUI(deltaMs);

      // Check if all currently waiting notes have now been hit
      if (state.isWaitingForInput) {
        const remaining = state.waitingNotes.filter((w) => w.status === "pending");
        state.waitingNotes = remaining;
        if (remaining.length === 0) {
          state.isWaitingForInput = false;
          els.waitBanner.classList.remove("visible");
        } else {
          updateWaitBannerText();
        }
      }
    } else {
      // Wrong note pressed! Highlight in RED on the staff and piano
      state.stats.errors += 1;
      state.stats.streak = 0;
      state.pressedKeys.set(midi, { status: "error", time: performance.now() });
      state.wrongNoteEvents.push({
        midi,
        time: state.currentTime,
        createdAt: performance.now(),
      });
    }

    updateStatsUI();
  }

  function handleUserNoteOff(midi) {
    audio.noteOff(midi);
    state.pressedKeys.delete(midi);
  }

  function updateWaitBannerText() {
    if (!state.isWaitingForInput || state.waitingNotes.length === 0) {
      els.waitBanner.classList.remove("visible");
      return;
    }
    const labels = state.waitingNotes.map((n) => {
      const sol = window.UndermaniaParsers.getSolfegeLabel(n.midi, state.accidentalMode);
      const fStr = state.showFingering && n.finger ? ` [Dedo ${n.finger}]` : "";
      return `${sol}${n.octave}${fStr}`;
    });
    els.waitBannerText.textContent = `Modo Práctica: Toca ${labels.join(" + ")} para avanzar`;
    els.waitBanner.classList.add("visible");
  }

  function formatSec(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? "0" : ""}${rem}`;
  }

  function updateTransportUI() {
    if (!state.song) return;
    const dur = Math.max(0.1, state.song.duration);
    const pct = Math.min(100, Math.max(0, (state.currentTime / dur) * 100));
    els.timelineProgress.style.width = `${pct}%`;
    els.timeCurrentLabel.textContent = formatSec(state.currentTime);
    els.timeTotalLabel.textContent = formatSec(dur);
    els.playPauseBtn.textContent = state.isPlaying ? "⏸ Pausar" : "▶ Tocar / Practicar";
  }

  function updateLoopUI() {
    if (!state.song) return;
    const dur = Math.max(0.1, state.song.duration);
    if (state.loopEnabled && state.loopEnd > state.loopStart) {
      els.timelineLoopRegion.style.display = "block";
      const leftPct = (state.loopStart / dur) * 100;
      const widthPct = ((state.loopEnd - state.loopStart) / dur) * 100;
      els.timelineLoopRegion.style.left = `${leftPct}%`;
      els.timelineLoopRegion.style.width = `${widthPct}%`;
      els.loopRangeText.textContent = `Activo: ${formatSec(state.loopStart)} → ${formatSec(state.loopEnd)}`;
    } else {
      els.timelineLoopRegion.style.display = "none";
      els.loopRangeText.textContent = `A: ${formatSec(state.loopStart)} · B: ${formatSec(state.loopEnd)} (Inactivo)`;
    }
  }

  /**
   * Simulation Step (60fps)
   */
  function stepSimulation(now) {
    const dtRaw = (now - state.lastFrameTime) / 1000;
    state.lastFrameTime = now;
    const dt = Math.min(0.08, Math.max(0, dtRaw));

    if (state.isPlaying && state.song) {
      // Check if any active-hand note has reached the hit-line and requires waiting
      if (state.waitForNote) {
        const dueNotes = state.song.notes.filter(
          (n) =>
            n.status === "pending" &&
            isHandActiveForPractice(n.hand) &&
            n.startTime <= state.currentTime + 0.015
        );
        if (dueNotes.length > 0) {
          state.isWaitingForInput = true;
          state.waitingNotes = dueNotes;
          state.currentTime = dueNotes[0].startTime;
          updateWaitBannerText();
        }
      } else {
        state.isWaitingForInput = false;
        els.waitBanner.classList.remove("visible");
      }

      if (!state.isWaitingForInput) {
        const speedFactor = state.speedPercent / 100;
        state.currentTime += dt * speedFactor;

        // Auto-play non-active hand notes (or all notes when waitForNote is off and note passes)
        for (const n of state.song.notes) {
          if (
            !n.autoPlayed &&
            n.startTime <= state.currentTime &&
            n.startTime >= state.currentTime - 0.15
          ) {
            if (!isHandActiveForPractice(n.hand)) {
              n.autoPlayed = true;
              n.status = "hit";
              audio.noteOn(n.midi, 70, n.duration);
            }
          }
          // Mark missed notes if waitForNote is disabled and note passed tolerance window
          if (
            !state.waitForNote &&
            n.status === "pending" &&
            isHandActiveForPractice(n.hand) &&
            state.currentTime > n.startTime + 0.3
          ) {
            n.status = "missed";
            state.stats.errors += 1;
            state.stats.streak = 0;
            updateStatsUI();
          }
        }

        // Loop A-B check
        if (state.loopEnabled && state.loopEnd > state.loopStart && state.currentTime >= state.loopEnd) {
          state.currentTime = state.loopStart;
          resetNotesInRange(state.loopStart, state.loopEnd);
        }

        // End of song check
        if (state.currentTime >= state.song.duration + 0.5) {
          if (state.loopEnabled) {
            state.currentTime = state.loopStart;
            resetNotesInRange(state.loopStart, state.song.duration);
          } else {
            state.isPlaying = false;
          }
        }
      }

      updateTransportUI();
    }

    renderGrandStaff();
    renderWaterfallAndPiano();
    requestAnimationFrame(stepSimulation);
  }

  /**
   * Convert MIDI pitch to diatonic step for Grand Staff positioning
   * Middle C (60) = Do4 = step 0
   */
  function midiToDiatonicStep(midi) {
    const diatonicMap = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
    const octave = Math.floor(midi / 12) - 5; // C4 is 60 -> octave 0
    const pc = ((midi % 12) + 12) % 12;
    return octave * 7 + diatonicMap[pc];
  }

  /**
   * Render Synchronized Grand Staff (Pentagrama en Clave de Sol y Fa)
   * Supports:
   *  - Horizontal Continuous Scrolling ("horizontal")
   *  - Automatic Page Turn ("page")
   *  - Real-time Green (acierto) and Red (error) note heads
   *  - Finger numbers (1-5) and Solfège labels
   */
  function renderGrandStaff() {
    const canvas = els.staffCanvas;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
      canvas.width = Math.floor(rect.width);
      canvas.height = Math.floor(rect.height);
    }
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#100B1D";
    ctx.fillRect(0, 0, w, h);

    const leftMargin = 86;
    const staffWidth = Math.max(200, w - leftMargin - 24);
    const lineSpacing = 10; // 5px per diatonic step
    const stepPx = lineSpacing / 2;

    // Treble staff lines: E4 (step 2), G4 (4), B4 (6), D5 (8), F5 (10)
    // Bass staff lines: G2 (-10), B2 (-8), D3 (-6), F3 (-4), A3 (-2)
    const middleCY = Math.round(h * 0.52);

    const stepToY = (step, hand) => {
      const offset = hand === "left" ? 12 : -12;
      return middleCY - step * stepPx + offset;
    };

    // Draw Staff Lines
    ctx.strokeStyle = "rgba(189, 143, 204, 0.38)";
    ctx.lineWidth = 1;

    // Treble 5 lines (steps 2, 4, 6, 8, 10)
    for (const s of [2, 4, 6, 8, 10]) {
      const y = stepToY(s, "right");
      ctx.beginPath();
      ctx.moveTo(leftMargin - 65, y);
      ctx.lineTo(w - 16, y);
      ctx.stroke();
    }

    // Bass 5 lines (steps -10, -8, -6, -4, -2)
    for (const s of [-10, -8, -6, -4, -2]) {
      const y = stepToY(s, "left");
      ctx.beginPath();
      ctx.moveTo(leftMargin - 65, y);
      ctx.lineTo(w - 16, y);
      ctx.stroke();
    }

    // Brace & Clef Symbols
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(leftMargin - 65, stepToY(10, "right"));
    ctx.lineTo(leftMargin - 65, stepToY(-10, "left"));
    ctx.stroke();

    ctx.fillStyle = COLORS.primary;
    ctx.font = "bold 30px serif";
    ctx.fillText("𝄞", leftMargin - 56, stepToY(4, "right") + 10);
    ctx.font = "bold 24px serif";
    ctx.fillText("𝄢", leftMargin - 55, stepToY(-4, "left") + 8);

    if (!state.song) return;

    // Determine visible time window according to staffScrollMode ("horizontal" vs "page")
    const pageDurationSec = 8.0;
    let windowStartSec = 0;
    let cursorX = leftMargin;
    const pxPerSec = staffWidth / pageDurationSec;

    if (state.staffScrollMode === "horizontal") {
      // Cursor stays at 25% of the staff width while notes scroll horizontally from right to left
      const anchorSec = pageDurationSec * 0.25;
      windowStartSec = state.currentTime - anchorSec;
      cursorX = leftMargin + anchorSec * pxPerSec;
      els.staffPageBadge.textContent = "Desplazamiento Horizontal Continuo";
    } else {
      // Automatic Page Turn ("page")
      const pageIdx = Math.floor(state.currentTime / pageDurationSec);
      const totalPages = Math.max(1, Math.ceil(state.song.duration / pageDurationSec));
      state.currentPage = pageIdx + 1;
      state.totalPages = totalPages;
      windowStartSec = pageIdx * pageDurationSec;
      cursorX = leftMargin + (state.currentTime - windowStartSec) * pxPerSec;
      els.staffPageBadge.textContent = `Salto Automático · Página ${state.currentPage} / ${state.totalPages}`;
    }

    const windowEndSec = windowStartSec + pageDurationSec;

    // Draw Measure Barlines
    const secPerMeasure = (60 / state.song.bpm) * (state.song.beatsPerMeasure || 4);
    const firstMeasure = Math.max(0, Math.floor(windowStartSec / secPerMeasure));
    const lastMeasure = Math.ceil(windowEndSec / secPerMeasure);

    ctx.strokeStyle = "rgba(108, 67, 156, 0.55)";
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.tertiary;
    ctx.font = "10px monospace";

    for (let m = firstMeasure; m <= lastMeasure; m++) {
      const mSec = m * secPerMeasure;
      const x = leftMargin + (mSec - windowStartSec) * pxPerSec;
      if (x >= leftMargin && x <= w - 16) {
        ctx.beginPath();
        ctx.moveTo(x, stepToY(10, "right"));
        ctx.lineTo(x, stepToY(-10, "left"));
        ctx.stroke();
        ctx.fillText(`Compás ${m + 1}`, x + 4, stepToY(10, "right") - 8);
      }
    }

    // Draw Score Notes on the Grand Staff
    for (const n of state.song.notes) {
      if (n.startTime + n.duration < windowStartSec || n.startTime > windowEndSec) continue;
      const x = leftMargin + (n.startTime - windowStartSec) * pxPerSec;
      if (x < leftMargin - 10 || x > w - 16) continue;

      const step = midiToDiatonicStep(n.midi);
      const y = stepToY(step, n.hand);

      // Ledger lines if needed (e.g., Middle C step 0)
      if (step === 0 || step >= 12 || step <= -12) {
        ctx.strokeStyle = "rgba(245, 240, 255, 0.65)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - 10, y);
        ctx.lineTo(x + 10, y);
        ctx.stroke();
      }

      // Color based on execution status (Green for hit, Red for missed, Primary/Secondary for pending)
      let noteColor = n.hand === "right" ? COLORS.primary : COLORS.tertiary;
      if (!isHandActiveForPractice(n.hand)) {
        noteColor = "rgba(189, 143, 204, 0.35)";
      } else if (n.status === "hit") {
        noteColor = COLORS.correct; // Green for correct execution
      } else if (n.status === "missed") {
        noteColor = COLORS.error; // Red for missed execution
      }

      // Note head
      ctx.fillStyle = noteColor;
      ctx.beginPath();
      ctx.ellipse(x, y, 6.5, 4.8, -0.25, 0, Math.PI * 2);
      ctx.fill();

      // Stem
      ctx.strokeStyle = noteColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (n.hand === "right") {
        ctx.moveTo(x + 5.5, y);
        ctx.lineTo(x + 5.5, y - 24);
      } else {
        ctx.moveTo(x - 5.5, y);
        ctx.lineTo(x - 5.5, y + 24);
      }
      ctx.stroke();

      // Solfège label under/over staff note
      if (state.showSolfege) {
        const sol = window.UndermaniaParsers.getSolfegeLabel(n.midi, state.accidentalMode);
        ctx.fillStyle = n.status === "hit" ? COLORS.correct : "#F5F0FF";
        ctx.font = "bold 9px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(sol, x, n.hand === "right" ? y + 14 : y - 9);
      }

      // Finger number 1-5 on staff
      if (state.showFingering && n.finger) {
        ctx.fillStyle = COLORS.primary;
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.fillText(String(n.finger), x, n.hand === "right" ? y - 28 : y + 34);
      }
    }

    // Draw Wrong Notes played by the user in bright RED on the Pentagrama
    for (const err of state.wrongNoteEvents) {
      if (err.time < windowStartSec || err.time > windowEndSec) continue;
      const x = leftMargin + (err.time - windowStartSec) * pxPerSec;
      if (x < leftMargin || x > w - 16) continue;
      const errHand = err.midi >= 60 ? "right" : "left";
      const step = midiToDiatonicStep(err.midi);
      const y = stepToY(step, errHand);

      ctx.fillStyle = COLORS.error;
      ctx.beginPath();
      ctx.ellipse(x, y, 7, 5.2, -0.25, 0, Math.PI * 2);
      ctx.fill();

      const errSol = window.UndermaniaParsers.getSolfegeLabel(err.midi, state.accidentalMode);
      ctx.font = "bold 10px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`✕ ${errSol}`, x, y - 10);
    }

    // Draw Reading Cursor Line
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 2;
    ctx.shadowColor = COLORS.primary;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(cursorX, 10);
    ctx.lineTo(cursorX, h - 10);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /**
   * Render Neothesia-style Falling Notes Waterfall + Interactive Piano Keyboard
   */
  function renderWaterfallAndPiano() {
    const canvas = els.waterfallCanvas;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
      canvas.width = Math.floor(rect.width);
      canvas.height = Math.floor(rect.height);
    }
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    const pianoHeight = Math.min(138, Math.max(105, Math.floor(h * 0.27)));
    const hitLineY = h - pianoHeight;

    ctx.clearRect(0, 0, w, h);

    // Compute white keys geometry
    const whiteKeys = [];
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      if (!isBlackKey(m)) whiteKeys.push(m);
    }
    const whiteKeyWidth = w / whiteKeys.length;
    const keyGeometry = new Map();

    whiteKeys.forEach((m, idx) => {
      keyGeometry.set(m, {
        x: idx * whiteKeyWidth,
        width: whiteKeyWidth,
        isBlack: false,
      });
    });

    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      if (isBlackKey(m)) {
        const prevWhite = keyGeometry.get(m - 1);
        if (prevWhite) {
          const bw = whiteKeyWidth * 0.64;
          keyGeometry.set(m, {
            x: prevWhite.x + whiteKeyWidth - bw / 2,
            width: bw,
            isBlack: true,
          });
        }
      }
    }

    // Draw subtle vertical octave lanes in waterfall
    ctx.strokeStyle = "rgba(189, 143, 204, 0.08)";
    ctx.lineWidth = 1;
    for (const wk of whiteKeys) {
      if (wk % 12 === 0) {
        const g = keyGeometry.get(wk);
        ctx.beginPath();
        ctx.moveTo(g.x, 0);
        ctx.lineTo(g.x, hitLineY);
        ctx.stroke();
      }
    }

    // Draw Loop A-B horizontal markers on waterfall if enabled
    const visibleSeconds = 3.2; // How many seconds of upcoming notes fit in the waterfall height
    const pxPerSec = hitLineY / visibleSeconds;

    if (state.song && state.loopEnabled) {
      for (const [label, lTime] of [
        ["BUCLE A (Inicio)", state.loopStart],
        ["BUCLE B (Fin)", state.loopEnd],
      ]) {
        const y = hitLineY - (lTime - state.currentTime) * pxPerSec;
        if (y >= 0 && y <= hitLineY) {
          ctx.strokeStyle = COLORS.primary;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = COLORS.primary;
          ctx.font = "bold 10px monospace";
          ctx.textAlign = "left";
          ctx.fillText(label, 12, y - 5);
        }
      }
    }

    // Draw Falling Notes
    const activeAutoHighlight = new Set();

    if (state.song) {
      for (const n of state.song.notes) {
        const geom = keyGeometry.get(n.midi);
        if (!geom) continue;

        const timeUntilStart = n.startTime - state.currentTime;
        const timeUntilEnd = n.startTime + n.duration - state.currentTime;

        if (timeUntilEnd < -0.1 || timeUntilStart > visibleSeconds + 0.5) continue;

        const noteBottomY = hitLineY - timeUntilStart * pxPerSec;
        const noteTopY = hitLineY - timeUntilEnd * pxPerSec;
        const clampedBottom = Math.min(hitLineY, noteBottomY);
        const noteHeight = Math.max(18, clampedBottom - noteTopY);

        if (clampedBottom <= 0 || noteTopY >= hitLineY) continue;

        const activeHand = isHandActiveForPractice(n.hand);
        if (timeUntilStart <= 0 && timeUntilEnd >= 0) {
          activeAutoHighlight.add(n.midi);
        }

        // Choose color using Principal (#00FFFF), Secundario (#6C439C), Terciario (#BD8FCC), or Green/Red
        let fillTop = n.hand === "right" ? COLORS.primary : COLORS.secondary;
        let fillBottom = n.hand === "right" ? "#00B8D4" : COLORS.tertiary;
        let borderColor = n.hand === "right" ? "#FFFFFF" : COLORS.tertiary;

        if (!activeHand) {
          fillTop = "rgba(108, 67, 156, 0.28)";
          fillBottom = "rgba(189, 143, 204, 0.22)";
          borderColor = "rgba(189, 143, 204, 0.3)";
        } else if (n.status === "hit") {
          fillTop = COLORS.correct;
          fillBottom = "#00B248";
          borderColor = "#B9F6CA";
        } else if (n.status === "missed") {
          fillTop = COLORS.error;
          fillBottom = "#990033";
          borderColor = "#FF80AB";
        }

        const pad = geom.isBlack ? 1 : 2;
        const nx = geom.x + pad;
        const nw = Math.max(12, geom.width - pad * 2);
        const ny = clampedBottom - noteHeight;

        const grad = ctx.createLinearGradient(nx, ny, nx, clampedBottom);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, fillBottom);

        ctx.fillStyle = grad;
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1.5;

        ctx.beginPath();
        ctx.roundRect(nx, ny, nw, noteHeight, 6);
        ctx.fill();
        ctx.stroke();

        // 2.1 Solfège label (Do Re Mi Fa Sol La Si + #/b) INSIDE the falling note
        if (state.showSolfege) {
          const solLabel = window.UndermaniaParsers.getSolfegeLabel(n.midi, state.accidentalMode);
          ctx.fillStyle = n.hand === "right" && n.status !== "missed" ? "#090612" : "#FFFFFF";
          ctx.font = `800 ${Math.min(12, Math.max(9, Math.floor(nw * 0.44)))}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const textY = Math.min(clampedBottom - 9, Math.max(ny + 10, ny + noteHeight / 2));
          ctx.fillText(solLabel, nx + nw / 2, textY);
        }

        // 2.2 Finger Number (1 to 5) ABOVE the falling note
        if (state.showFingering && n.finger) {
          const badgeR = 9;
          const bx = nx + nw / 2;
          const by = ny - badgeR - 3;
          if (by > 8) {
            ctx.fillStyle = COLORS.secondary;
            ctx.strokeStyle = COLORS.primary;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = COLORS.primary;
            ctx.font = "bold 11px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(n.finger), bx, by);
          }
        }
      }
    }

    // Hit Line Glow
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 3;
    ctx.shadowColor = COLORS.primary;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(0, hitLineY);
    ctx.lineTo(w, hitLineY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw Piano Keys (White keys first, then Black keys)
    for (const wk of whiteKeys) {
      const g = keyGeometry.get(wk);
      const pressed = state.pressedKeys.get(wk);
      let keyFill = "#F7F4FC";

      if (pressed) {
        keyFill = pressed.status === "error" ? COLORS.error : COLORS.correct;
      } else if (activeAutoHighlight.has(wk)) {
        keyFill = COLORS.primary;
      }

      ctx.fillStyle = keyFill;
      ctx.strokeStyle = "#2A1B4E";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(g.x, hitLineY, g.width, pianoHeight, [0, 0, 5, 5]);
      ctx.fill();
      ctx.stroke();

      // Draw Solfège on white keys
      const sol = window.UndermaniaParsers.getSolfegeLabel(wk, state.accidentalMode);
      ctx.fillStyle = wk % 12 === 0 ? COLORS.secondary : "#5E4B8B";
      ctx.font = wk % 12 === 0 ? "bold 10px Inter, sans-serif" : "9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        wk % 12 === 0 ? `${sol}${Math.floor(wk / 12) - 1}` : sol,
        g.x + g.width / 2,
        hitLineY + pianoHeight - 12
      );
    }

    const blackHeight = Math.floor(pianoHeight * 0.63);
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      if (!isBlackKey(m)) continue;
      const g = keyGeometry.get(m);
      if (!g) continue;
      const pressed = state.pressedKeys.get(m);
      let keyFill = "#18102B";

      if (pressed) {
        keyFill = pressed.status === "error" ? COLORS.error : COLORS.correct;
      } else if (activeAutoHighlight.has(m)) {
        keyFill = COLORS.secondary;
      }

      ctx.fillStyle = keyFill;
      ctx.strokeStyle = COLORS.tertiary;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(g.x, hitLineY, g.width, blackHeight, [0, 0, 4, 4]);
      ctx.fill();
      ctx.stroke();
    }

    state.lastKeyGeometry = keyGeometry;
    state.lastHitLineY = hitLineY;
  }

  /**
   * Bind UI Controls, File Upload, Mouse & PC Keyboard Events
   */
  function bindEvents() {
    const repertoire = window.UndermaniaParsers.getBuiltInRepertoire();
    repertoire.forEach((piece, idx) => {
      const opt = document.createElement("option");
      opt.value = piece.id;
      opt.textContent = `${piece.title} (${piece.format})`;
      if (idx === 0) opt.selected = true;
      els.repertoireSelect.appendChild(opt);
    });

    // Also fetch sample files from /api/samples if running via server.py
    fetch("/api/samples")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.samples)) {
          data.samples.forEach((s) => {
            const opt = document.createElement("option");
            opt.value = `url:${s.url}`;
            opt.textContent = `[Archivo Local] ${s.name}`;
            els.repertoireSelect.appendChild(opt);
          });
        }
      })
      .catch(() => {});

    els.repertoireSelect.addEventListener("change", async (e) => {
      const val = e.target.value;
      if (val.startsWith("url:")) {
        const url = val.slice(4);
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        const fname = url.split("/").pop();
        if (fname.toLowerCase().endsWith(".mscz")) {
          const song = await window.UndermaniaParsers.parseMsczArrayBuffer(buf, fname);
          loadSong(song);
        } else {
          const song = window.UndermaniaParsers.parseMidiArrayBuffer(buf, fname);
          loadSong(song);
        }
        return;
      }
      const found = repertoire.find((r) => r.id === val);
      if (found) loadSong(found);
    });

    // File import (.mid, .midi, .mscz, .mscx)
    els.uploadBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const lower = file.name.toLowerCase();
        let parsedSong = null;
        if (lower.endsWith(".mscz")) {
          parsedSong = await window.UndermaniaParsers.parseMsczArrayBuffer(buf, file.name);
        } else if (lower.endsWith(".mscx")) {
          const txt = new TextDecoder().decode(buf);
          parsedSong = window.UndermaniaParsers.parseMscxString(txt, file.name);
        } else {
          parsedSong = window.UndermaniaParsers.parseMidiArrayBuffer(buf, file.name);
        }
        loadSong(parsedSong);
      } catch (err) {
        alert(`Error al leer el archivo ${file.name}: ${err.message}`);
      }
    });

    // Play / Pause / Restart
    els.playPauseBtn.addEventListener("click", () => {
      audio.ensureContext();
      state.isPlaying = !state.isPlaying;
      state.lastFrameTime = performance.now();
      updateTransportUI();
    });

    els.restartBtn.addEventListener("click", () => {
      if (!state.song) return;
      state.currentTime = state.loopEnabled ? state.loopStart : 0;
      resetNotesInRange(0, state.song.duration + 1);
      state.wrongNoteEvents = [];
      state.isWaitingForInput = false;
      els.waitBanner.classList.remove("visible");
      updateTransportUI();
    });

    // Timeline seek click
    els.timelineContainer.addEventListener("click", (e) => {
      if (!state.song) return;
      const rect = els.timelineContainer.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      state.currentTime = ratio * state.song.duration;
      resetNotesInRange(state.currentTime, state.song.duration + 1);
      state.isWaitingForInput = false;
      els.waitBanner.classList.remove("visible");
      updateTransportUI();
    });

    // 1. Practice Mode bindings
    els.waitToggle.addEventListener("change", (e) => {
      state.waitForNote = e.target.checked;
      if (!state.waitForNote) {
        state.isWaitingForInput = false;
        els.waitBanner.classList.remove("visible");
      }
    });

    els.handButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        els.handButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.handMode = btn.getAttribute("data-hand");
        state.isWaitingForInput = false;
        els.waitBanner.classList.remove("visible");
      });
    });

    const setSpeed = (pct) => {
      const clamped = Math.max(25, Math.min(200, Number(pct)));
      state.speedPercent = clamped;
      els.speedSlider.value = String(clamped);
      els.speedValueLabel.textContent = `${clamped}%`;
      els.speedPresetBtns.forEach((b) => {
        b.classList.toggle("active", Number(b.getAttribute("data-speed")) === clamped);
      });
    };

    els.speedSlider.addEventListener("input", (e) => setSpeed(e.target.value));
    els.speedPresetBtns.forEach((btn) => {
      btn.addEventListener("click", () => setSpeed(btn.getAttribute("data-speed")));
    });

    // Loop A-B controls
    els.loopToggle.addEventListener("change", (e) => {
      state.loopEnabled = e.target.checked;
      updateLoopUI();
    });

    els.setLoopABtn.addEventListener("click", () => {
      state.loopStart = Number(state.currentTime.toFixed(2));
      if (state.loopEnd <= state.loopStart + 0.5 && state.song) {
        state.loopEnd = Math.min(state.song.duration, state.loopStart + 4);
      }
      state.loopEnabled = true;
      els.loopToggle.checked = true;
      updateLoopUI();
    });

    els.setLoopBBtn.addEventListener("click", () => {
      if (state.currentTime > state.loopStart + 0.3) {
        state.loopEnd = Number(state.currentTime.toFixed(2));
      }
      state.loopEnabled = true;
      els.loopToggle.checked = true;
      updateLoopUI();
    });

    els.clearLoopBtn.addEventListener("click", () => {
      state.loopEnabled = false;
      els.loopToggle.checked = false;
      updateLoopUI();
    });

    // 2. Visualizations & Reading bindings
    els.solfegeToggle.addEventListener("change", (e) => {
      state.showSolfege = e.target.checked;
    });

    els.accidentalButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        els.accidentalButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.accidentalMode = btn.getAttribute("data-accidental");
        updateWaitBannerText();
      });
    });

    els.fingeringToggle.addEventListener("change", (e) => {
      state.showFingering = e.target.checked;
      updateWaitBannerText();
    });

    els.scrollModeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        els.scrollModeButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.staffScrollMode = btn.getAttribute("data-scrollmode");
      });
    });

    // Mouse / Touch interaction on the Piano Keyboard Canvas
    let mouseActiveMidi = null;
    const getMidiAtCanvasPos = (clientX, clientY) => {
      if (!state.lastKeyGeometry) return null;
      const rect = els.waterfallCanvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (y < state.lastHitLineY) return null;

      const blackHeight = Math.floor((els.waterfallCanvas.height - state.lastHitLineY) * 0.63);
      if (y <= state.lastHitLineY + blackHeight) {
        for (const [m, g] of state.lastKeyGeometry.entries()) {
          if (g.isBlack && x >= g.x && x <= g.x + g.width) return m;
        }
      }
      for (const [m, g] of state.lastKeyGeometry.entries()) {
        if (!g.isBlack && x >= g.x && x <= g.x + g.width) return m;
      }
      return null;
    };

    els.waterfallCanvas.addEventListener("mousedown", (e) => {
      const m = getMidiAtCanvasPos(e.clientX, e.clientY);
      if (m !== null) {
        mouseActiveMidi = m;
        handleUserNoteOn(m, 100);
      }
    });

    window.addEventListener("mouseup", () => {
      if (mouseActiveMidi !== null) {
        handleUserNoteOff(mouseActiveMidi);
        mouseActiveMidi = null;
      }
    });

    // Computer Keyboard Piano mapping (for testing without a physical MIDI controller)
    const keyMap = {
      KeyA: 60, // Do4
      KeyW: 61, // Do#4
      KeyS: 62, // Re4
      KeyE: 63, // Re#4
      KeyD: 64, // Mi4
      KeyF: 65, // Fa4
      KeyT: 66, // Fa#4
      KeyG: 67, // Sol4
      KeyY: 68, // Sol#4
      KeyH: 69, // La4
      KeyU: 70, // La#4
      KeyJ: 71, // Si4
      KeyK: 72, // Do5
      KeyO: 73, // Do#5
      KeyL: 74, // Re5
      KeyP: 75, // Re#5
      Semicolon: 76, // Mi5
      // Lower octave keys (Z-M row)
      KeyZ: 48, // Do3
      KeyX: 50, // Re3
      KeyC: 52, // Mi3
      KeyV: 53, // Fa3
      KeyB: 55, // Sol3
      KeyN: 57, // La3
      KeyM: 59, // Si3
    };
    const heldCodes = new Set();

    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        els.playPauseBtn.click();
        return;
      }
      const midi = keyMap[e.code];
      if (midi !== undefined && !heldCodes.has(e.code)) {
        heldCodes.add(e.code);
        handleUserNoteOn(midi, 100);
      }
    });

    window.addEventListener("keyup", (e) => {
      const midi = keyMap[e.code];
      if (midi !== undefined && heldCodes.has(e.code)) {
        heldCodes.delete(e.code);
        handleUserNoteOff(midi);
      }
    });

    // Initialize Web MIDI Hardware Keyboard Connection
    midiManager = new window.UndermaniaAudioMidi.MidiHardwareManager({
      onNoteOn: (midi, vel) => handleUserNoteOn(midi, vel),
      onNoteOff: (midi) => handleUserNoteOff(midi),
      onDevicesChanged: (inputs, connected, statusText) => {
        els.midiStatusDot.classList.toggle("connected", connected);
        els.midiStatusText.textContent = statusText;
        els.midiDeviceSelect.innerHTML = '<option value="all">Todos los Teclados MIDI</option>';
        inputs.forEach((inp) => {
          const opt = document.createElement("option");
          opt.value = inp.id;
          opt.textContent = inp.name;
          els.midiDeviceSelect.appendChild(opt);
        });
      },
    });
    midiManager.init();

    els.midiDeviceSelect.addEventListener("change", (e) => {
      midiManager.setInputDevice(e.target.value);
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    bindEvents();
    const initialPiece = window.UndermaniaParsers.getBuiltInRepertoire()[0];
    loadSong(initialPiece);
    state.lastFrameTime = performance.now();
    requestAnimationFrame(stepSimulation);
  });
})();
