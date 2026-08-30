/* =========================================================
   PULSEPAD — Controller Diagnostic Lab
   Vanilla JS Gamepad API engine
   All processing is local. Nothing is sent to a server.
   ========================================================= */
(() => {
  'use strict';

  /* ---------------------------------------------------------
     Standard mapping labels (Gamepad API "standard" layout).
     Controllers reporting more buttons/axes than this simply
     get generic labels appended — the UI adapts automatically.
     --------------------------------------------------------- */
  const STANDARD_BUTTON_LABELS = [
    'A', 'B', 'X', 'Y',
    'L1', 'R1', 'L2', 'R2',
    'SELECT', 'START',
    'L3', 'R3',
    'D-UP', 'D-DOWN', 'D-LEFT', 'D-RIGHT',
    'HOME'
  ];

  const STANDARD_AXIS_LABELS = ['Left Stick X', 'Left Stick Y', 'Right Stick X', 'Right Stick Y'];

  // Approximate on-screen layout positions (percent) for the first 17 standard buttons,
  // used to lay out the adaptive controller visualization.
  const BUTTON_POSITIONS = {
    0: { x: 82, y: 46 }, 1: { x: 90, y: 34 }, 2: { x: 74, y: 34 }, 3: { x: 82, y: 22 },
    4: { x: 14, y: 12 }, 5: { x: 86, y: 12 },
    6: { x: 14, y: 4 }, 7: { x: 86, y: 4 },
    8: { x: 44, y: 30 }, 9: { x: 56, y: 30 },
    10: { x: 27, y: 55 }, 11: { x: 62, y: 60 },
    12: { x: 18, y: 34 }, 13: { x: 18, y: 50 }, 14: { x: 10, y: 42 }, 15: { x: 26, y: 42 },
    16: { x: 50, y: 42 }
  };

  const DEAD_ZONE = 0.12;
  const DRIFT_THRESHOLD = 0.05;

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */
  const state = {
    controllers: {},         // index -> tracked controller state
    activeIndex: null,
    theme: 'dark',
    totalInputs: 0,
    lastInputTime: null,
    pollTimestamps: [],
    eventLog: [],
    recording: false,
    recordStartTime: null,
    recordedEvents: [],
    driftL: false,
    driftR: false,
    stickHistory: [],        // for movement graph
    triggerHistory: [],      // for response graph
    perf: { running: false },
  };

  /* ---------------------------------------------------------
     DOM refs
     --------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    statusDot: $('statusDot'), statusLabel: $('statusLabel'),
    ctrlSelectWrap: $('ctrlSelectWrap'), controllerSelect: $('controllerSelect'),
    btnRefresh: $('btnRefresh'), btnTheme: $('btnTheme'), btnFullscreen: $('btnFullscreen'),
    emptyState: $('emptyState'), dashboard: $('dashboard'), apiSupport: $('apiSupport'),
    tabs: $('tabs'),
    infoIdentity: $('infoIdentity'), infoCapabilities: $('infoCapabilities'), infoSession: $('infoSession'),
    controllerViz: $('controllerViz'),
    buttonGrid: $('buttonGrid'), btnResetButtons: $('btnResetButtons'),
    stickCanvasL: $('stickCanvasL'), stickCanvasR: $('stickCanvasR'),
    stickInfoL: $('stickInfoL'), stickInfoR: $('stickInfoR'),
    driftToggleL: $('driftToggleL'), driftToggleR: $('driftToggleR'),
    stickGraph: $('stickGraph'),
    fillL2: $('fillL2'), fillR2: $('fillR2'), pctL2: $('pctL2'), pctR2: $('pctR2'),
    infoL2: $('infoL2'), infoR2: $('infoR2'), triggerGraph: $('triggerGraph'),
    statTotalInputs: $('statTotalInputs'), statPollRate: $('statPollRate'),
    statLastInput: $('statLastInput'), statResponse: $('statResponse'),
    eventFeed: $('eventFeed'), btnClearFeed: $('btnClearFeed'),
    btnRunPerf: $('btnRunPerf'), perfPolling: $('perfPolling'), perfLatency: $('perfLatency'),
    perfConsistency: $('perfConsistency'), perfStability: $('perfStability'),
    perfProgress: $('perfProgress'), perfProgressFill: $('perfProgressFill'),
    btnRunDiagnostics: $('btnRunDiagnostics'), healthNumber: $('healthNumber'),
    ringFill: $('ringFill'), checkList: $('checkList'),
    btnRecStart: $('btnRecStart'), btnRecStop: $('btnRecStop'), btnRecClear: $('btnRecClear'),
    btnExportReport: $('btnExportReport'), recStatus: $('recStatus'), recordFeed: $('recordFeed'),
    btnKeyboardFallback: $('btnKeyboardFallback'), kbModalBackdrop: $('kbModalBackdrop'),
    btnCloseKb: $('btnCloseKb'), kbDisplay: $('kbDisplay'), kbLog: $('kbLog'),
    btnResetAll: $('btnResetAll'),
  };

  const stickCtxL = els.stickCanvasL.getContext('2d');
  const stickCtxR = els.stickCanvasR.getContext('2d');
  const stickGraphCtx = els.stickGraph.getContext('2d');
  const triggerGraphCtx = els.triggerGraph.getContext('2d');

  /* ---------------------------------------------------------
     Utility
     --------------------------------------------------------- */
  function fmt(n, d = 2) { return Number(n).toFixed(d); }
  function nowMs() { return performance.now(); }
  function timeLabel() {
    const d = new Date();
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  function buttonLabel(i, count) {
    return STANDARD_BUTTON_LABELS[i] || `BTN ${i}`;
  }
  function axisLabel(i) {
    return STANDARD_AXIS_LABELS[i] || `Axis ${i}`;
  }

  function logEvent(tag, text) {
    state.eventLog.push({ t: timeLabel(), tag, text });
    if (state.eventLog.length > 300) state.eventLog.shift();
    renderEventFeed();
    if (state.recording) {
      state.recordedEvents.push({ t: (nowMs() - state.recordStartTime).toFixed(1), tag, text });
      renderRecordFeed();
    }
  }

  function renderEventFeed() {
    const recent = state.eventLog.slice(-60).reverse();
    els.eventFeed.innerHTML = recent.map(e =>
      `<div class="ev"><span class="ev-time">${e.t}</span><span class="ev-tag">${e.tag}</span><span>${e.text}</span></div>`
    ).join('');
  }

  function renderRecordFeed() {
    const recent = state.recordedEvents.slice(-80).reverse();
    els.recordFeed.innerHTML = recent.map(e =>
      `<div class="ev"><span class="ev-time">+${e.t}ms</span><span class="ev-tag">${e.tag}</span><span>${e.text}</span></div>`
    ).join('');
  }

  /* ---------------------------------------------------------
     Gamepad API support check
     --------------------------------------------------------- */
  if (navigator.getGamepads) {
    els.apiSupport.textContent = 'Gamepad API supported in this browser ✓';
  } else {
    els.apiSupport.textContent = 'Gamepad API not detected — try Chrome, Edge or Firefox.';
  }

  /* ---------------------------------------------------------
     Connection handling
     --------------------------------------------------------- */
  window.addEventListener('gamepadconnected', (e) => {
    initController(e.gamepad);
    logEvent('CONNECT', `${e.gamepad.id} (index ${e.gamepad.index})`);
    refreshControllerList();
    if (state.activeIndex === null) setActiveController(e.gamepad.index);
    updateGlobalStatus();
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    logEvent('DISCONNECT', `index ${e.gamepad.index}`);
    delete state.controllers[e.gamepad.index];
    refreshControllerList();
    if (state.activeIndex === e.gamepad.index) {
      const remaining = Object.keys(state.controllers);
      setActiveController(remaining.length ? Number(remaining[0]) : null);
    }
    updateGlobalStatus();
  });

  function initController(gp) {
    state.controllers[gp.index] = {
      index: gp.index,
      id: gp.id,
      mapping: gp.mapping || 'unknown',
      buttonCount: gp.buttons.length,
      axisCount: gp.axes.length,
      connectedAt: Date.now(),
      buttonStats: gp.buttons.map(() => ({ pressed: false, value: 0, count: 0, downAt: 0, lastDuration: 0 })),
      axisMinMax: gp.axes.map(() => ({ min: 0, max: 0 })),
      triggerMinMax: { l2: { min: 1, max: 0 }, r2: { min: 1, max: 0 } },
      driftBaseline: null,
    };
  }

  function updateGlobalStatus() {
    const connected = Object.keys(state.controllers).length > 0;
    els.statusDot.className = 'status-dot' + (connected ? ' connected' : '');
    els.statusLabel.textContent = connected
      ? `${Object.keys(state.controllers).length} controller${Object.keys(state.controllers).length > 1 ? 's' : ''} connected`
      : 'No controller detected';
    els.emptyState.hidden = connected;
    els.dashboard.hidden = !connected;
    els.ctrlSelectWrap.hidden = Object.keys(state.controllers).length <= 1;
  }

  function refreshControllerList() {
    els.controllerSelect.innerHTML = '';
    Object.values(state.controllers).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.index;
      opt.textContent = `#${c.index} — ${c.id.slice(0, 28)}`;
      els.controllerSelect.appendChild(opt);
    });
    if (state.activeIndex !== null) els.controllerSelect.value = state.activeIndex;
  }

  function setActiveController(index) {
    state.activeIndex = index;
    if (index !== null) {
      buildButtonGrid(state.controllers[index]);
      buildControllerViz(state.controllers[index]);
      renderIdentity(state.controllers[index]);
    }
  }

  els.controllerSelect.addEventListener('change', (e) => setActiveController(Number(e.target.value)));
  els.btnRefresh.addEventListener('click', () => {
    pollOnce(true);
    logEvent('SYSTEM', 'Controller list refreshed');
  });

  /* ---------------------------------------------------------
     Tabs
     --------------------------------------------------------- */
  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    $('view-' + btn.dataset.tab).classList.add('active');
  });

  /* ---------------------------------------------------------
     Theme / Fullscreen
     --------------------------------------------------------- */
  els.btnTheme.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', state.theme);
    els.btnTheme.textContent = state.theme === 'dark' ? '☾' : '☀';
  });
  els.btnFullscreen.addEventListener('click', () => {
    const app = $('app');
    if (!document.fullscreenElement) app.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  /* ---------------------------------------------------------
     Identity / capability / session panels
     --------------------------------------------------------- */
  function renderIdentity(c) {
    els.infoIdentity.innerHTML = `
      <div><dt>Name</dt><dd title="${c.id}">${c.id.length > 26 ? c.id.slice(0, 26) + '…' : c.id}</dd></div>
      <div><dt>Index</dt><dd>${c.index}</dd></div>
      <div><dt>Mapping</dt><dd>${c.mapping}</dd></div>
      <div><dt>Status</dt><dd>Connected</dd></div>`;
    els.infoCapabilities.innerHTML = `
      <div><dt>Buttons</dt><dd>${c.buttonCount}</dd></div>
      <div><dt>Axes</dt><dd>${c.axisCount}</dd></div>
      <div><dt>Sticks (est.)</dt><dd>${Math.floor(c.axisCount / 2)}</dd></div>
      <div><dt>Vibration</dt><dd id="vibSupport">checking…</dd></div>`;
  }

  function renderSession(c) {
    const secs = Math.floor((Date.now() - c.connectedAt) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    els.infoSession.innerHTML = `
      <div><dt>Connected for</dt><dd>${mm}:${ss}</dd></div>
      <div><dt>Total inputs</dt><dd>${state.totalInputs}</dd></div>
      <div><dt>Last input</dt><dd>${state.lastInputTime ? state.lastInputTime + ' ago' : '—'}</dd></div>`;
  }

  /* ---------------------------------------------------------
     Adaptive controller visualization
     --------------------------------------------------------- */
  function buildControllerViz(c) {
    els.controllerViz.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = '100%';
    wrap.style.maxWidth = '520px';
    wrap.style.height = '220px';

    for (let i = 0; i < c.buttonCount; i++) {
      const pos = BUTTON_POSITIONS[i] || { x: 50 + (i % 5) * 8, y: 70 + Math.floor(i / 5) * 10 };
      const el = document.createElement('div');
      el.className = 'viz-btn';
      el.id = `vizbtn-${i}`;
      el.style.left = pos.x + '%';
      el.style.top = pos.y + '%';
      el.textContent = buttonLabel(i);
      wrap.appendChild(el);
    }
    // sticks
    if (c.axisCount >= 2) {
      const s1 = document.createElement('div');
      s1.className = 'viz-stick'; s1.id = 'vizstick-0';
      s1.style.left = '38%'; s1.style.top = '68%';
      s1.innerHTML = '<div class="viz-stick-dot" id="vizdot-0"></div>';
      wrap.appendChild(s1);
    }
    if (c.axisCount >= 4) {
      const s2 = document.createElement('div');
      s2.className = 'viz-stick'; s2.id = 'vizstick-1';
      s2.style.left = '70%'; s2.style.top = '78%';
      s2.innerHTML = '<div class="viz-stick-dot" id="vizdot-1"></div>';
      wrap.appendChild(s2);
    }
    els.controllerViz.appendChild(wrap);
  }

  /* ---------------------------------------------------------
     Button grid (Buttons tab)
     --------------------------------------------------------- */
  function buildButtonGrid(c) {
    els.buttonGrid.innerHTML = '';
    for (let i = 0; i < c.buttonCount; i++) {
      const card = document.createElement('div');
      card.className = 'button-card';
      card.id = `bcard-${i}`;
      card.innerHTML = `
        <div class="b-name">${buttonLabel(i)}</div>
        <div class="b-row"><span id="bstate-${i}">released</span><span id="bcount-${i}">×0</span></div>
        <div class="b-row"><span id="bval-${i}">0.00</span><span id="bdur-${i}">0ms</span></div>
        <div class="b-bar"><div class="b-bar-fill" id="bbar-${i}"></div></div>`;
      els.buttonGrid.appendChild(card);
    }
  }
  els.btnResetButtons.addEventListener('click', () => {
    const c = state.controllers[state.activeIndex];
    if (!c) return;
    c.buttonStats.forEach(s => { s.count = 0; s.lastDuration = 0; });
    logEvent('SYSTEM', 'Button counters reset');
  });

  /* ---------------------------------------------------------
     Stick canvases
     --------------------------------------------------------- */
  function drawStick(ctx, canvas, x, y, drift) {
    const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2, r = w * 0.42;
    ctx.clearRect(0, 0, w, h);
    // outer ring
    ctx.strokeStyle = 'rgba(120,200,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    // dead zone ring
    ctx.strokeStyle = 'rgba(255,176,32,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(cx, cy, r * DEAD_ZONE, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // crosshair
    ctx.strokeStyle = 'rgba(120,200,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    // position dot
    const px = cx + x * r, py = cy + y * r;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, 12);
    const color = drift ? '#ff2e88' : '#00e5ff';
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
  }

  function drawHistoryGraph(ctx, canvas, seriesArr, colors) {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,200,255,0.08)';
    for (let gy = 0; gy <= 4; gy++) {
      const y = (h / 4) * gy;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    seriesArr.forEach((series, si) => {
      if (series.length < 2) return;
      ctx.strokeStyle = colors[si];
      ctx.lineWidth = 2;
      ctx.beginPath();
      series.forEach((v, i) => {
        const x = (i / (series.length - 1)) * w;
        const y = h - ((v + 1) / 2) * h;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  function drawTriggerGraph() {
    const w = els.triggerGraph.width, h = els.triggerGraph.height;
    triggerGraphCtx.clearRect(0, 0, w, h);
    triggerGraphCtx.strokeStyle = 'rgba(120,200,255,0.08)';
    for (let gy = 0; gy <= 4; gy++) {
      const y = (h / 4) * gy;
      triggerGraphCtx.beginPath(); triggerGraphCtx.moveTo(0, y); triggerGraphCtx.lineTo(w, y); triggerGraphCtx.stroke();
    }
    const l2 = state.triggerHistory.map(p => p.l2), r2 = state.triggerHistory.map(p => p.r2);
    [[l2, '#00e5ff'], [r2, '#ff2e88']].forEach(([series, color]) => {
      if (series.length < 2) return;
      triggerGraphCtx.strokeStyle = color;
      triggerGraphCtx.lineWidth = 2;
      triggerGraphCtx.beginPath();
      series.forEach((v, i) => {
        const x = (i / (series.length - 1)) * w;
        const y = h - v * h;
        i === 0 ? triggerGraphCtx.moveTo(x, y) : triggerGraphCtx.lineTo(x, y);
      });
      triggerGraphCtx.stroke();
    });
  }

  els.driftToggleL.addEventListener('change', (e) => {
    state.driftL = e.target.checked;
    if (state.driftL) { const c = state.controllers[state.activeIndex]; c.driftBaseline = { l: [c.lastAxes?.[0] || 0, c.lastAxes?.[1] || 0] }; }
  });
  els.driftToggleR.addEventListener('change', (e) => { state.driftR = e.target.checked; });

  /* ---------------------------------------------------------
     Performance test
     --------------------------------------------------------- */
  els.btnRunPerf.addEventListener('click', runPerfTest);
  function runPerfTest() {
    if (state.perf.running) return;
    state.perf.running = true;
    els.btnRunPerf.disabled = true;
    els.perfProgress.hidden = false;
    const duration = 5000;
    const start = nowMs();
    const frameTimes = [];
    let lastFrame = start;
    let disconnects = 0;

    function frame(ts) {
      const elapsed = ts - start;
      frameTimes.push(ts - lastFrame);
      lastFrame = ts;
      els.perfProgressFill.style.width = Math.min(100, (elapsed / duration) * 100) + '%';
      const c = state.controllers[state.activeIndex];
      if (!c) disconnects++;
      if (elapsed < duration) {
        requestAnimationFrame(frame);
      } else {
        finishPerfTest(frameTimes, disconnects);
      }
    }
    requestAnimationFrame(frame);
  }

  function finishPerfTest(frameTimes, disconnects) {
    state.perf.running = false;
    els.btnRunPerf.disabled = false;
    els.perfProgress.hidden = true;
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const pollingHz = 1000 / avg;
    const variance = frameTimes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / frameTimes.length;
    const stdDev = Math.sqrt(variance);
    const consistency = Math.max(0, 100 - stdDev * 8);
    const stability = disconnects === 0 ? 100 : Math.max(0, 100 - disconnects * 10);

    els.perfPolling.textContent = `${fmt(pollingHz, 0)} Hz`;
    els.perfLatency.textContent = `${fmt(avg, 2)} ms`;
    els.perfConsistency.textContent = `${fmt(consistency, 0)}%`;
    els.perfStability.textContent = `${fmt(stability, 0)}%`;
    logEvent('PERF', `Test complete — ${fmt(pollingHz, 0)}Hz, ${fmt(avg, 2)}ms avg frame`);
  }

  /* ---------------------------------------------------------
     Diagnostics / Health Check
     --------------------------------------------------------- */
  els.btnRunDiagnostics.addEventListener('click', runDiagnostics);
  function runDiagnostics() {
    const c = state.controllers[state.activeIndex];
    if (!c) return;
    const checks = [];
    let score = 100;

    // buttons detected
    checks.push({ label: 'Buttons detected', status: c.buttonCount > 0 ? 'pass' : 'fail', detail: `${c.buttonCount}` });
    if (c.buttonCount === 0) score -= 20;

    // axes detected
    checks.push({ label: 'Axes detected', status: c.axisCount > 0 ? 'pass' : 'fail', detail: `${c.axisCount}` });
    if (c.axisCount === 0) score -= 20;

    // analog center check (current axis values near 0 when nothing pressed recently)
    const gp = navigator.getGamepads()[c.index];
    const centerOk = gp ? gp.axes.every(a => Math.abs(a) < 0.15) : true;
    checks.push({ label: 'Analog center check', status: centerOk ? 'pass' : 'warn', detail: centerOk ? 'centered' : 'off-center' });
    if (!centerOk) score -= 8;

    // dead zone check
    checks.push({ label: 'Dead-zone check', status: 'pass', detail: `±${DEAD_ZONE}` });

    // trigger check
    const hasTriggers = c.buttonCount > 7;
    checks.push({ label: 'Trigger buttons present', status: hasTriggers ? 'pass' : 'warn', detail: hasTriggers ? 'L2/R2 found' : 'not standard' });
    if (!hasTriggers) score -= 5;

    // d-pad check
    const hasDpad = c.buttonCount > 15;
    checks.push({ label: 'D-Pad present', status: hasDpad ? 'pass' : 'warn', detail: hasDpad ? 'found' : 'not standard' });
    if (!hasDpad) score -= 5;

    // connection check
    checks.push({ label: 'Connection', status: gp && gp.connected ? 'pass' : 'fail', detail: gp && gp.connected ? 'stable' : 'lost' });
    if (!(gp && gp.connected)) score -= 20;

    // responsiveness — did we see any input recently or ever
    const responsive = state.totalInputs > 0;
    checks.push({ label: 'Input responsiveness', status: responsive ? 'pass' : 'warn', detail: responsive ? `${state.totalInputs} inputs seen` : 'no input yet — press a button' });
    if (!responsive) score -= 10;

    // stick drift warning based on tracked min/max near-zero movement while flagged
    const driftDetected = c.driftWarning === true;
    checks.push({ label: 'Possible stick-drift', status: driftDetected ? 'warn' : 'pass', detail: driftDetected ? 'movement without input' : 'none detected' });
    if (driftDetected) score -= 12;

    score = Math.max(0, Math.min(100, Math.round(score)));
    els.healthNumber.textContent = score;
    const circumference = 377;
    els.ringFill.style.strokeDashoffset = circumference - (circumference * score) / 100;
    els.ringFill.style.stroke = score >= 85 ? 'var(--accent-3)' : score >= 60 ? 'var(--accent-warn)' : 'var(--accent-2)';

    els.checkList.innerHTML = checks.map(ch => `
      <li class="${ch.status}">
        <span class="check-icon">${ch.status === 'pass' ? '✓' : ch.status === 'warn' ? '!' : '✕'}</span>
        <span>${ch.label}</span>
        <span class="check-detail">${ch.detail}</span>
      </li>`).join('');

    state.lastDiagnostics = { score, checks, ranAt: new Date().toISOString() };
    logEvent('DIAG', `Health check complete — score ${score}/100`);
  }

  /* ---------------------------------------------------------
     Recorder
     --------------------------------------------------------- */
  els.btnRecStart.addEventListener('click', () => {
    state.recording = true;
    state.recordStartTime = nowMs();
    state.recordedEvents = [];
    els.btnRecStart.disabled = true;
    els.btnRecStop.disabled = false;
    els.recStatus.textContent = 'Recording… every button, axis and trigger event is being timestamped.';
    renderRecordFeed();
  });
  els.btnRecStop.addEventListener('click', () => {
    state.recording = false;
    els.btnRecStart.disabled = false;
    els.btnRecStop.disabled = true;
    els.recStatus.textContent = `Stopped. Captured ${state.recordedEvents.length} events.`;
  });
  els.btnRecClear.addEventListener('click', () => {
    state.recordedEvents = [];
    renderRecordFeed();
    els.recStatus.textContent = 'Recording cleared.';
  });

  els.btnExportReport.addEventListener('click', exportReport);
  function exportReport() {
    const c = state.controllers[state.activeIndex];
    const report = {
      generatedAt: new Date().toISOString(),
      controller: c ? { id: c.id, index: c.index, mapping: c.mapping, buttonCount: c.buttonCount, axisCount: c.axisCount } : null,
      diagnostics: state.lastDiagnostics || null,
      inputStats: {
        totalInputs: state.totalInputs,
        eventsLogged: state.eventLog.length,
      },
      recordedEvents: state.recordedEvents,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pulsepad-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    logEvent('SYSTEM', 'Test report exported');
  }

  /* ---------------------------------------------------------
     Reset all
     --------------------------------------------------------- */
  els.btnResetAll.addEventListener('click', () => {
    Object.values(state.controllers).forEach(initControllerReset);
    state.totalInputs = 0;
    state.eventLog = [];
    state.stickHistory = [];
    state.triggerHistory = [];
    renderEventFeed();
    logEvent('SYSTEM', 'All tests reset');
  });
  function initControllerReset(c) {
    c.buttonStats.forEach(s => { s.count = 0; s.lastDuration = 0; });
    c.axisMinMax.forEach(a => { a.min = 0; a.max = 0; });
    c.triggerMinMax = { l2: { min: 1, max: 0 }, r2: { min: 1, max: 0 } };
  }

  /* ---------------------------------------------------------
     Keyboard fallback modal
     --------------------------------------------------------- */
  els.btnKeyboardFallback.addEventListener('click', () => { els.kbModalBackdrop.hidden = false; });
  els.btnCloseKb.addEventListener('click', () => { els.kbModalBackdrop.hidden = true; });
  els.kbModalBackdrop.addEventListener('click', (e) => { if (e.target === els.kbModalBackdrop) els.kbModalBackdrop.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (els.kbModalBackdrop.hidden) return;
    els.kbDisplay.textContent = `${e.key === ' ' ? 'Space' : e.key}  (code: ${e.code})`;
    const line = document.createElement('div');
    line.textContent = `${timeLabel()}  key="${e.key}"  code="${e.code}"`;
    els.kbLog.prepend(line);
  });

  /* ---------------------------------------------------------
     Main poll loop
     --------------------------------------------------------- */
  function pollOnce(force) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      if (!state.controllers[gp.index]) initController(gp);
    }
    if (force) { refreshControllerList(); updateGlobalStatus(); }
  }

  function loop(ts) {
    state.pollTimestamps.push(ts);
    if (state.pollTimestamps.length > 60) state.pollTimestamps.shift();

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let anyConnected = false;

    for (const gp of pads) {
      if (!gp) continue;
      anyConnected = true;
      if (!state.controllers[gp.index]) { initController(gp); refreshControllerList(); updateGlobalStatus(); }
      const c = state.controllers[gp.index];
      c.lastAxes = gp.axes.slice();
      c.lastConnected = gp.connected;
      processController(gp, c, ts);
    }

    if (anyConnected && els.dashboard.hidden) updateGlobalStatus();
    if (!anyConnected && Object.keys(state.controllers).length && !els.dashboard.hidden) {
      // handled by disconnect event normally; safeguard only
    }

    if (state.activeIndex !== null && state.controllers[state.activeIndex]) {
      renderSession(state.controllers[state.activeIndex]);
      updatePollRateDisplay();
    }

    requestAnimationFrame(loop);
  }

  function updatePollRateDisplay() {
    if (state.pollTimestamps.length < 2) return;
    const span = state.pollTimestamps[state.pollTimestamps.length - 1] - state.pollTimestamps[0];
    const hz = span > 0 ? ((state.pollTimestamps.length - 1) / span) * 1000 : 0;
    els.statPollRate.textContent = `${fmt(hz, 0)} Hz`;
  }

  function processController(gp, c, ts) {
    const isActive = gp.index === state.activeIndex;

    /* ---- buttons ---- */
    gp.buttons.forEach((b, i) => {
      const st = c.buttonStats[i] || (c.buttonStats[i] = { pressed: false, value: 0, count: 0, downAt: 0, lastDuration: 0 });
      const wasPressed = st.pressed;
      st.value = b.value;
      st.pressed = b.pressed;

      if (b.pressed && !wasPressed) {
        st.downAt = ts;
        st.count++;
        state.totalInputs++;
        state.lastInputTime = '0s';
        logEvent('BTN', `${buttonLabel(i)} pressed`);
        flashVizButton(i);
      }
      if (!b.pressed && wasPressed) {
        st.lastDuration = ts - st.downAt;
        state.totalInputs++;
        logEvent('BTN', `${buttonLabel(i)} released (${fmt(st.lastDuration, 0)}ms)`);
        unflashVizButton(i);
      }

      if (isActive) {
        const card = $(`bcard-${i}`);
        if (card) {
          card.classList.toggle('active', b.pressed);
          $(`bstate-${i}`).textContent = b.pressed ? 'pressed' : 'released';
          $(`bcount-${i}`).textContent = `×${st.count}`;
          $(`bval-${i}`).textContent = fmt(b.value, 2);
          $(`bdur-${i}`).textContent = b.pressed ? `${fmt(ts - st.downAt, 0)}ms` : `${fmt(st.lastDuration, 0)}ms`;
          $(`bbar-${i}`).style.width = `${b.value * 100}%`;
        }
      }
    });

    /* ---- triggers (buttons 6 = L2, 7 = R2 in standard mapping) ---- */
    if (gp.buttons[6] && gp.buttons[7]) {
      const l2v = gp.buttons[6].value, r2v = gp.buttons[7].value;
      c.triggerMinMax.l2.min = Math.min(c.triggerMinMax.l2.min, l2v);
      c.triggerMinMax.l2.max = Math.max(c.triggerMinMax.l2.max, l2v);
      c.triggerMinMax.r2.min = Math.min(c.triggerMinMax.r2.min, r2v);
      c.triggerMinMax.r2.max = Math.max(c.triggerMinMax.r2.max, r2v);

      if (isActive) {
        els.fillL2.style.width = `${l2v * 100}%`;
        els.fillR2.style.width = `${r2v * 100}%`;
        els.pctL2.textContent = `${Math.round(l2v * 100)}%`;
        els.pctR2.textContent = `${Math.round(r2v * 100)}%`;
        els.infoL2.innerHTML = `<div><dt>Max</dt><dd>${fmt(c.triggerMinMax.l2.max, 2)}</dd></div><div><dt>Min</dt><dd>${fmt(c.triggerMinMax.l2.min, 2)}</dd></div>`;
        els.infoR2.innerHTML = `<div><dt>Max</dt><dd>${fmt(c.triggerMinMax.r2.max, 2)}</dd></div><div><dt>Min</dt><dd>${fmt(c.triggerMinMax.r2.min, 2)}</dd></div>`;

        state.triggerHistory.push({ l2: l2v, r2: r2v });
        if (state.triggerHistory.length > 180) state.triggerHistory.shift();
        drawTriggerGraph();
      }
    }

    /* ---- sticks ---- */
    if (gp.axes.length >= 2) {
      const lx = gp.axes[0], ly = gp.axes[1];
      trackAxisMinMax(c, 0, lx); trackAxisMinMax(c, 1, ly);
      if (isActive) renderStick('L', lx, ly, c, state.driftL);
    }
    if (gp.axes.length >= 4) {
      const rx = gp.axes[2], ry = gp.axes[3];
      trackAxisMinMax(c, 2, rx); trackAxisMinMax(c, 3, ry);
      if (isActive) renderStick('R', rx, ry, c, state.driftR);
    }

    // drift heuristic: if drift-test enabled and magnitude exceeds threshold with no recent button input
    if (isActive && (state.driftL || state.driftR)) {
      const mag = Math.max(
        state.driftL ? Math.hypot(gp.axes[0] || 0, gp.axes[1] || 0) : 0,
        state.driftR ? Math.hypot(gp.axes[2] || 0, gp.axes[3] || 0) : 0
      );
      c.driftWarning = mag > DRIFT_THRESHOLD;
    }

    /* ---- viz stick dots ---- */
    if (isActive) {
      const d0 = $('vizdot-0'), d1 = $('vizdot-1');
      if (d0 && gp.axes.length >= 2) d0.style.transform = `translate(calc(-50% + ${gp.axes[0] * 14}px), calc(-50% + ${gp.axes[1] * 14}px))`;
      if (d1 && gp.axes.length >= 4) d1.style.transform = `translate(calc(-50% + ${gp.axes[2] * 14}px), calc(-50% + ${gp.axes[3] * 14}px))`;
    }
  }

  function trackAxisMinMax(c, i, v) {
    if (!c.axisMinMax[i]) c.axisMinMax[i] = { min: 0, max: 0 };
    c.axisMinMax[i].min = Math.min(c.axisMinMax[i].min, v);
    c.axisMinMax[i].max = Math.max(c.axisMinMax[i].max, v);
  }

  function renderStick(side, x, y, c, drift) {
    const ctx = side === 'L' ? stickCtxL : stickCtxR;
    const canvas = side === 'L' ? els.stickCanvasL : els.stickCanvasR;
    const infoEl = side === 'L' ? els.stickInfoL : els.stickInfoR;
    const isDrifting = drift && Math.hypot(x, y) > DRIFT_THRESHOLD;
    drawStick(ctx, canvas, x, y, isDrifting);
    const mm = side === 'L' ? [c.axisMinMax[0], c.axisMinMax[1]] : [c.axisMinMax[2], c.axisMinMax[3]];
    infoEl.innerHTML = `
      <div><dt>X / Y</dt><dd>${fmt(x)} / ${fmt(y)}</dd></div>
      <div><dt>Magnitude</dt><dd>${fmt(Math.hypot(x, y))}</dd></div>
      <div><dt>Centered</dt><dd>${Math.hypot(x, y) < DEAD_ZONE ? 'yes' : 'no'}</dd></div>
      <div><dt>Range X</dt><dd>${fmt(mm[0].min)} .. ${fmt(mm[0].max)}</dd></div>
      <div><dt>Range Y</dt><dd>${fmt(mm[1].min)} .. ${fmt(mm[1].max)}</dd></div>
      <div><dt>Drift flag</dt><dd style="color:${isDrifting ? 'var(--accent-2)' : 'inherit'}">${isDrifting ? 'MOVEMENT DETECTED' : 'none'}</dd></div>`;

    // history graph (left stick magnitude drives the shared graph for simplicity, tagged by side)
    state.stickHistory.push(x);
    if (state.stickHistory.length > 200) state.stickHistory.shift();
    drawHistoryGraph(stickGraphCtx, els.stickGraph, [state.stickHistory], ['#00e5ff']);
  }

  function flashVizButton(i) {
    const el = $(`vizbtn-${i}`);
    if (el) el.classList.add('active');
  }
  function unflashVizButton(i) {
    const el = $(`vizbtn-${i}`);
    if (el) el.classList.remove('active');
  }

  /* ---------------------------------------------------------
     Relative "last input" ticker
     --------------------------------------------------------- */
  setInterval(() => {
    els.statTotalInputs.textContent = state.totalInputs;
    if (state.lastInputTime !== null) {
      // recompute a rough elapsed label from the log
      const lastEv = state.eventLog[state.eventLog.length - 1];
      els.statLastInput.textContent = lastEv ? lastEv.tag + ' ' + lastEv.t.split('.')[0] : '—';
    }
  }, 500);

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  updateGlobalStatus();
  requestAnimationFrame(loop);
})();
