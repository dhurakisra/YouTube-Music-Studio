'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedLogEvents = new Set([
  'capture_button_ready', 'capture_start_requested', 'capture_started',
  'capture_stop_requested', 'capture_stopped', 'capture_start_cycle',
  'capture_worklet_error', 'capture_fallback', 'media_element_missing',
  'drm_or_silence', 'capture_error', 'processing_state', 'latency_info',
  'pcm_worker_attempt', 'pcm_worker_blocked', 'pcm_transport_started', 'pcm_transport_stopped', 'pcm_metrics', 'pcm_port_received', 'pcm_worker_port_ready',
  'stem_jump', 'stem_buffer_changed', 'pcm_capture_mode', 'pcm_capture_error', 'stem_block_received', 'stem_transport_started', 'stem_transport_stopped', 'stem_playout', 'stem_diag',
]);
const allowedCommandTypes = new Set(['capture:show-button', 'capture:toggle', 'capture:auto-cycle']);

function trustedMainFrame() {
  try {
    const u = new URL(location.href);
    return window === window.top && (u.origin === 'https://music.youtube.com' || u.protocol === 'file:');
  } catch { return false; }
}

function onTrustedCommand(callback) {
  if (!trustedMainFrame() || typeof callback !== 'function') return () => {};
  const listener = (_event, command) => {
    if (command && typeof command === 'object' && allowedCommandTypes.has(command.type)) callback(command);
  };
  ipcRenderer.on('poc:command', listener);
  return () => ipcRenderer.removeListener('poc:command', listener);
}

contextBridge.exposeInMainWorld('poc', Object.freeze({
  log(level, event, data = {}) {
    if (!trustedMainFrame() || !['info', 'warn', 'error'].includes(level) || !allowedLogEvents.has(event)) return;
    ipcRenderer.send('poc:log', level, event, data);
  },
  onCommand(callback) { return onTrustedCommand(callback); },
}));

function isPcmBridgePage() {
  try { return new URL(location.href).protocol === 'file:' && new URL(location.href).pathname.endsWith('/pcm-bridge.html'); } catch { return false; }
}

if (isPcmBridgePage()) {
  let bridgeWorker = null;
  const metricListeners = new Set();
  function ensureBridgeWorker() {
    if (bridgeWorker) return bridgeWorker;
    bridgeWorker = new Worker(new URL('./pcm-worker.js', location.href));
    bridgeWorker.onmessage = (event) => {
      if (event.data?.type === 'pcm:stats') {
        ipcRenderer.send('poc:pcm-metrics', event.data.metrics);
        for (const listener of metricListeners) listener(event.data.metrics);
      }
      if (event.data?.type === 'pcm:consumer-ready') ipcRenderer.send('poc:log', 'info', 'pcm_worker_port_ready', { state: 'ready' });
      if (event.data?.type === 'pcm:consumer-stopped') {
        bridgeWorker?.terminate();
        bridgeWorker = null;
      }
    };
    bridgeWorker.onerror = (event) => {
      ipcRenderer.send('poc:log', 'error', 'capture_error', { state: 'pcm_worker_error', error: String(event.message || 'PCM worker error').slice(0, 180) });
      bridgeWorker?.terminate();
      bridgeWorker = null;
    };
    return bridgeWorker;
  }
  ipcRenderer.on('poc:pcm-port', (event, metadata) => {
    if (metadata?.type !== 'pcm-port' || event.ports.length !== 1) return;
    ipcRenderer.send('poc:log', 'info', 'pcm_port_received', { state: 'received' });
    ipcRenderer.postMessage('poc:stem-port', { type: 'stem-port' }, [event.ports[0]]);
  });
  contextBridge.exposeInMainWorld('pcmBridge', Object.freeze({
    onMetrics(callback) {
      if (typeof callback !== 'function') return () => {};
      metricListeners.add(callback);
      return () => metricListeners.delete(callback);
    },
  }));
} else {

(() => {
  const wiredElements = new WeakSet();
  const graphs = new WeakMap();
  let activeContext = null;
  let captureStarting = false;
  let captureActive = false;
  let autoCycleRunning = false;
  let scanQueued = false;
  let lastMetricsAt = 0;
  let lastZeroStart = null;
  let currentPcmTransport = null;
  let nextSequence = 0;
  let button;
  let overlay;
  let sessionEls = null;
  let modeSelect;
  let gainSlider;
  let vocalSlider;
  let instSlider;
  let drumsSlider;
  let bassSlider;
  let otherSlider;
  let modelSelect;
  let stemNodes = null;
  let stemPlayer = null;

  function log(event, data = {}) {
    if (!trustedMainFrame() || !allowedLogEvents.has(event)) return;
    const level = event === 'capture_error' ? 'error' : 'info';
    ipcRenderer.send('poc:log', level, event, data);
  }

  function findMedia() { return document.querySelector('video, audio'); }

  function installControls() {
    if (!document.documentElement) return;
    if (overlay) { installStudioDrawer(); return; }

    // Session controls are built once and mounted in the Studio drawer's "Session" section (no floating overlay).
    overlay = { built: true };
    button = h('button', 'btn capture', captureActive ? 'STOP' : 'START', { type: 'button', 'aria-label': 'Start or stop audio capture' });
    button.addEventListener('click', toggleCapture);
    log('capture_button_ready', { state: 'ready' });
    modeSelect = document.createElement('select');
    modeSelect.setAttribute('aria-label', 'Audio processing mode');
    for (const [value, text] of [['bypass', 'Bypass'], ['processed', 'Processed (LPF)'], ['stems', 'Stems (vocal/instr.)']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      modeSelect.appendChild(option);
    }
    modeSelect.value = 'bypass';
    modeSelect.addEventListener('change', () => setMode(modeSelect.value, true));
    gainSlider = document.createElement('input');
    gainSlider.type = 'range';
    gainSlider.min = '-24';
    gainSlider.max = '6';
    gainSlider.step = '1';
    gainSlider.value = '0';
    gainSlider.setAttribute('aria-label', 'Processed gain in dB');
    gainSlider.className = 'qrange';
    ctrlReset(gainSlider, () => 0);
    gainSlider.addEventListener('input', () => setUserGain(Number(gainSlider.value)));
    const makeStemSlider = () => makeStemState(); // UI lives in the Studio drawer
    modelSelect = document.createElement('select');
    modelSelect.setAttribute('aria-label', 'Stem separation model (applies on next capture start)');
    for (const [value, text] of [['umx-hq', 'UMX-HQ (fast, ~3 s)'], ['htdemucs', 'HT-Demucs (best, ~10 s)'], ['passthrough', 'TEST: no separation (~9 s)']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      modelSelect.appendChild(option);
    }
    modelSelect.value = 'umx-hq';
    const bufSlider = document.createElement('input');
    bufSlider.type = 'range'; bufSlider.min = '0.3'; bufSlider.max = '3'; bufSlider.step = '0.1'; bufSlider.value = String(stemLeadS);
    bufSlider.className = 'qrange';
    ctrlReset(bufSlider, () => 1.0);
    bufSlider.setAttribute('aria-label', 'Stem jitter buffer in seconds (higher = fewer dropouts, more delay)');
    const bufValue = document.createElement('span');
    bufValue.textContent = stemLeadS.toFixed(1) + ' s';
    bufSlider.addEventListener('input', () => {
      const next = Number(bufSlider.value);
      stemLeadS = next;
      bufValue.textContent = next.toFixed(1) + ' s';
    });
    // Apply once on release: top the queued lead up to the new target (never shifts the schedule down or accumulates).
    bufSlider.addEventListener('change', () => {
      if (stemPlayer && activeContext) {
        const lead = stemPlayer.nextTime - activeContext.currentTime;
        if (lead < stemLeadS) stemPlayer.nextTime = activeContext.currentTime + stemLeadS;
      }
      log('stem_buffer_changed', { leadS: stemLeadS });
    });
    modelSelect.disabled = captureActive;
    sessionEls = { bufSlider, bufValue };
    vocalSlider = makeStemSlider('Vocal', 'Vocal stem level percent');
    instSlider = makeStemSlider('Instr.', 'Instrumental stem level percent');
    drumsSlider = makeStemSlider('Drums', 'Drums stem level percent');
    bassSlider = makeStemSlider('Bass', 'Bass stem level percent');
    otherSlider = makeStemSlider('Other', 'Other stem level percent');
    const updateSliderVisibility = () => { studioRebuildStrips(); applyStemLevels(); };
    modelSelect.addEventListener('change', updateSliderVisibility);
    updateSliderVisibility();
    installStudioDrawer();
  }

  function studioBuildSession(sec) {
    const row = (label, ...els) => { const r = h('div', 'eqinfo-row'); r.append(h('span', null, label), ...els); return r; };
    for (const el of [modelSelect, modeSelect]) { el.classList.add('sel'); for (const k of ['keydown', 'keyup', 'keypress']) el.addEventListener(k, (e) => e.stopPropagation()); }
    sec.append(
      row('MODEL', modelSelect),
      row('MODE', modeSelect),
      row('GAIN', gainSlider),
      row('BUFFER', sessionEls.bufSlider, sessionEls.bufValue),
      row('', button),
    );
  }

  // ---- Studio drawer: slide-up console in a Shadow DOM (isolated from YTM CSS). Stems section is live; the other sections come later. ----
  const STEM_FADER_DEFAULT = 0.8; // 0 dB
  const STEM_SCALE = ['+10', '0', '-10', '-20', '-40', '-∞'];
  function faderPosToLevel(pos) { // piecewise dB: 1=+10, .8=0, .6=-10, .4=-20, .2=-40, 0=-inf
    if (pos <= 0.005) return 0;
    const pts = [[0, -80], [0.2, -40], [0.4, -20], [0.6, -10], [0.8, 0], [1, 10]];
    for (let i = 1; i < pts.length; i += 1) {
      if (pos <= pts[i][0]) { const [p0, d0] = pts[i - 1], [p1, d1] = pts[i]; return 10 ** ((d0 + (d1 - d0) * (pos - p0) / (p1 - p0)) / 20); }
    }
    return 10 ** 0.5;
  }
  function makeStemState() { return { value: '100', pos: STEM_FADER_DEFAULT, stemFlags: { solo: false, mute: false } }; }
  const studio = { host: null, root: null, open: false, strips: [], statusEls: null, raf: 0, installing: false, buf: null, lastStatus: 0 };

  // Ctrl+click on a range slider puts it back to its default and fires its normal input/change handlers.
  function ctrlReset(el, getDefault) {
    el.addEventListener('click', (e) => {
      if (!e.ctrlKey) return;
      el.value = String(getDefault());
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // YTM enforces Trusted Types: no innerHTML. Build DOM with this helper.
  function h(tag, cls, text, attrs) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function studioStemLayout() {
    const ht = modelSelect?.value === 'htdemucs' || modelSelect?.value === 'passthrough';
    const layout = ht
      ? [['VOCALS', vocalSlider, 'vocalGain', ''], ['DRUMS', drumsSlider, 'drumsGain', 'red'], ['BASS', bassSlider, 'bassGain', ''], ['OTHER', otherSlider, 'otherGain', 'red']]
      : [['VOCALS', vocalSlider, 'vocalGain', ''], ['INSTR.', instSlider, 'instGain', 'red']];
    layout.push(['KARAOKE', micStrip, 'mic', 'red']); // the live microphone; its fader is the same control as the Mic LEVEL knob
    return layout;
  }

  function studioRebuildStrips() {
    if (!studio.root) return;
    const wrap = studio.root.querySelector('.channels');
    wrap.textContent = '';
    studio.strips = [];
    for (const [name, state, nodeKey, capClass] of studioStemLayout()) {
      const el = document.createElement('div');
      el.className = 'strip';
      const btns = h('div', 'btns');
      btns.append(h('button', 'btn solo', 'SOLO', { type: 'button', 'aria-label': name + ' solo' }), h('button', 'btn mute', 'MUTE', { type: 'button', 'aria-label': name + ' mute' }));
      const faderWrap = h('div', 'fader-wrap');
      const scale = h('div', 'scale');
      for (const m of STEM_SCALE) scale.appendChild(h('span', null, m));
      const trackEl = h('div', 'track', null, { role: 'slider', 'aria-label': name + ' level', 'aria-valuemin': '0', 'aria-valuemax': '100' });
      trackEl.appendChild(h('div', 'cap ' + capClass));
      const meter = h('div', 'led-meter');
      for (let i = 0; i < 16; i += 1) meter.appendChild(h('i', i > 12 ? 'r' : i > 9 ? 'y' : 'g'));
      faderWrap.append(scale, trackEl, meter);
      el.append(btns, faderWrap, h('div', 'name', name));
      wrap.appendChild(el);
      const soloBtn = el.querySelector('.solo'), muteBtn = el.querySelector('.mute');
      const refreshFlags = () => {
        const f = state.stemFlags;
        soloBtn.classList.toggle('on', f.solo); muteBtn.classList.toggle('on', f.mute);
        soloBtn.setAttribute('aria-pressed', String(f.solo)); muteBtn.setAttribute('aria-pressed', String(f.mute));
        soloBtn.disabled = f.mute; muteBtn.disabled = f.solo; // S and M are mutually exclusive
      };
      const apply = () => (state.apply ? state.apply() : applyStemLevels());
      soloBtn.addEventListener('click', () => { state.stemFlags.solo = !state.stemFlags.solo; refreshFlags(); apply(); });
      muteBtn.addEventListener('click', () => { state.stemFlags.mute = !state.stemFlags.mute; refreshFlags(); apply(); });
      refreshFlags();
      if (state.noSolo) soloBtn.style.display = 'none';
      const track = el.querySelector('.track'), cap = el.querySelector('.cap');
      const setPos = (pos) => {
        state.pos = Math.min(1, Math.max(0, pos));
        state.value = String(faderPosToLevel(state.pos) * 100);
        cap.style.bottom = (state.pos * 100) + '%';
        track.setAttribute('aria-valuenow', String(Math.round(state.pos * 100)));
        apply();
      };
      const fromEvent = (e) => { const r = track.getBoundingClientRect(); setPos(1 - (e.clientY - r.top) / r.height); };
      track.addEventListener('pointerdown', (e) => { if (e.ctrlKey) { setPos(STEM_FADER_DEFAULT); return; } track.setPointerCapture(e.pointerId); fromEvent(e); }); // Ctrl+click = reset
      track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) fromEvent(e); });
      track.addEventListener('dblclick', () => setPos(STEM_FADER_DEFAULT)); // reset to 0 dB
      cap.style.bottom = (state.pos * 100) + '%';
      if (nodeKey === 'mic') studio.micFaderRefresh = () => { cap.style.bottom = (state.pos * 100) + '%'; };
      studio.strips.push({ leds: [...el.querySelectorAll('.led-meter i')], nodeKey, held: -100 });
    }
  }

  function studioTick() {
    studio.raf = studio.open ? requestAnimationFrame(studioTick) : 0;
    const t0 = performance.now();
    if (t0 - (studio.lastFrame || 0) < 30) return; // ~30 fps is plenty for meters and keeps the main thread free for audio scheduling
    studio.lastFrame = t0;
    const an = stemNodes?.analysers;
    if (!studio.buf) studio.buf = new Float32Array(512);
    for (const s of studio.strips) {
      let peak = 0;
      const node = s.nodeKey === 'mic' ? mic?.an : an?.[s.nodeKey];
      if (node) {
        node.getFloatTimeDomainData(studio.buf);
        for (let i = 0; i < studio.buf.length; i += 1) { const a = Math.abs(studio.buf[i]); if (a > peak) peak = a; }
      }
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      s.held = Math.max(db, s.held - 1.2); // fast attack, gentle fall
      for (let j = 0; j < s.leds.length; j += 1) s.leds[j].classList.toggle('on', s.held > -42 + j * 2.8);
    }
    studio.eqDraw?.();
    studio.vuDraw?.();
    studio.micTick?.();
    const now = performance.now();
    if (now - studio.lastStatus > 250) {
      studio.lastStatus = now;
      const names = { 'umx-hq': 'UMX-HQ', htdemucs: 'HT-DEMUCS', passthrough: 'TEST PASSTHROUGH' };
      const [m, b, u] = studio.statusEls;
      m.textContent = 'MODEL: ' + (names[modelSelect?.value] || '-');
      if (captureActive && stemPlayer && activeContext) {
        b.textContent = 'BUFFER ' + Math.max(0, stemPlayer.nextTime - activeContext.currentTime).toFixed(1) + ' s · TARGET ' + stemLeadS.toFixed(1) + ' s';
        u.textContent = 'UNDERRUNS ' + stemPlayer.underruns;
      } else { b.textContent = captureActive ? 'WAITING FOR STEMS...' : 'CAPTURE OFF'; u.textContent = 'UNDERRUNS -'; }
    }
    const took = performance.now() - t0; // diagnostic: a slow UI frame competes with chunk scheduling
    if (took > 20 && t0 - (studio.lastSlowLog || 0) > 1000) { studio.lastSlowLog = t0; stemDiag('ui_slow', { lagMs: Math.round(took) }); }
  }

  function studioSetOpen(open) {
    studio.open = open;
    studio.root.querySelector('.drawer').classList.toggle('open', open);
    const tab = studio.root.querySelector('.tab');
    tab.classList.toggle('open', open);
    tab.textContent = open ? 'STUDIO ▼' : 'STUDIO ▲';
    try { localStorage.setItem('ytm-poc-drawer-open', open ? '1' : '0'); } catch {}
    if (open && !studio.raf) studio.raf = requestAnimationFrame(studioTick);
  }

  function studioMakeSection(title) {
    const sec = h('section', 'section');
    for (const pos of ['tl', 'tr', 'bl', 'br']) sec.appendChild(h('i', 'screw ' + pos));
    sec.appendChild(h('h3', 'title', title));
    return sec;
  }

  function studioKnob(label, cls, getV, setV, dflt, onEnd) {
    const box = h('div', 'knob-box');
    const knob = h('div', 'knob ' + cls, null, { role: 'slider', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' });
    const draw = () => { knob.style.setProperty('--a', (-135 + getV() * 270) + 'deg'); knob.setAttribute('aria-valuenow', String(Math.round(getV() * 100))); };
    let y0 = 0, v0 = 0;
    knob.addEventListener('pointerdown', (e) => { if (e.ctrlKey) { setV(dflt); draw(); onEnd?.(); return; } knob.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = getV(); });
    let pending = null, frame = 0; // pointer events can arrive far faster than frames: apply at most once per animation frame
    knob.addEventListener('pointermove', (e) => {
      if (!knob.hasPointerCapture(e.pointerId)) return;
      pending = Math.min(1, Math.max(0, v0 + (y0 - e.clientY) / 150));
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (pending != null) { setV(pending); draw(); pending = null; } });
    });
    knob.addEventListener('dblclick', () => { setV(dflt); draw(); onEnd?.(); });
    const finish = () => { if (pending != null) { setV(pending); draw(); pending = null; } onEnd?.(); }; // flush the last position before committing
    knob.addEventListener('pointerup', finish);
    knob.addEventListener('pointercancel', finish);
    draw();
    box.append(knob, document.createTextNode(label));
    box.redraw = draw;
    return box;
  }

  function studioBuildEq(sec) {
    const PAD_L = 30, PAD_B = 16, DB = 18, FMIN = 20, FMAX = 20000;
    const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'];
    const canvas = h('canvas', 'eq-screen', null, { 'aria-label': 'Equalizer curve: drag points to adjust bands' });
    const ctx = canvas.getContext('2d');
    let W = 520, H = 150, plotW = 1, plotH = 1, dpr = window.devicePixelRatio || 1;
    const layout = () => {
      const w = canvas.clientWidth, hh = canvas.clientHeight;
      if (!w || !hh) return false;
      dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
      W = w; H = hh; plotW = W - PAD_L - 6; plotH = H - PAD_B - 6;
      return true;
    };
    const xOf = (f) => PAD_L + plotW * Math.log(f / FMIN) / Math.log(FMAX / FMIN);
    const fOf = (x) => FMIN * (FMAX / FMIN) ** ((x - PAD_L) / plotW);
    const yOf = (db) => 6 + plotH * (0.5 - db / (2 * DB));
    const dbOf = (y) => (0.5 - (y - 6) / plotH) * 2 * DB;
    const fmtFreq = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz');

    const eqOn = h('button', 'btn solo', 'EQ ON', { type: 'button', 'aria-label': 'Equalizer enabled' });
    const quick = [['FLAT', 'Flat'], ['BASS BOOST', 'Bass boost'], ['VOCAL', 'Vocal boost']].map(([text, preset]) => h('button', 'btn', text, { type: 'button', 'data-preset': preset }));
    const row1 = h('div', 'switches fill');
    row1.append(eqOn, ...quick);
    const presetSelect = h('select', 'sel', null, { 'aria-label': 'Equalizer preset' });
    const nameInput = h('input', 'txt', null, { type: 'text', maxlength: '40', placeholder: 'Preset name', 'aria-label': 'Name for saving the current equalizer as a preset' });
    for (const type of ['keydown', 'keyup', 'keypress']) nameInput.addEventListener(type, (e) => e.stopPropagation()); // typing a name must not trigger YouTube Music hotkeys
    const saveBtn = h('button', 'btn', 'SAVE', { type: 'button' });
    const delBtn = h('button', 'btn', 'DEL', { type: 'button' });
    const row2 = h('div', 'switches fill eqrow');
    row2.append(presetSelect, nameInput, saveBtn, delBtn);
    const infoText = h('span', 'eqinfo');
    const qSlider = h('input', 'qrange', null, { type: 'range', min: '0.1', max: '10', step: '0.05', 'aria-label': 'Selected band Q' });
    const info = h('div', 'eqinfo-row');
    info.append(infoText, h('span', null, 'Q'), qSlider);
    sec.append(canvas, row1, row2, info);
    ctrlReset(qSlider, () => EQ_DEFAULT_BANDS[selected].q);

    let selected = 2, dragging = -1, spectrum = null;
    const userPresets = loadUserPresets();
    const syncOn = () => { eqOn.classList.toggle('on', eqState.enabled); eqOn.setAttribute('aria-pressed', String(eqState.enabled)); };
    const updateInfo = () => {
      const b = eqState.bands[selected];
      infoText.textContent = `BAND ${selected + 1} (${b.type === 'peaking' ? 'BELL' : b.type === 'lowshelf' ? 'LOW SHELF' : 'HIGH SHELF'}): ${fmtFreq(b.freq)}, ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB`;
      qSlider.value = String(b.q);
    };
    const refreshPresetList = (selectValue) => {
      presetSelect.textContent = '';
      const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; presetSelect.appendChild(o); };
      add('', 'Custom');
      for (const name of Object.keys(EQ_BUILTIN_PRESETS)) add('b:' + name, name);
      for (const name of Object.keys(userPresets)) add('u:' + name, '★ ' + name);
      presetSelect.value = selectValue ?? '';
      if (presetSelect.value !== (selectValue ?? '')) presetSelect.value = '';
      delBtn.disabled = !presetSelect.value.startsWith('u:');
    };
    const commit = () => { applyEq(); saveEqState(); updateInfo(); };
    const manualCommit = () => { commit(); refreshPresetList(''); }; // any hand edit leaves the preset: back to "Custom"
    const applyPreset = (v) => {
      if (v.startsWith('b:')) {
        const gains = EQ_BUILTIN_PRESETS[v.slice(2)];
        eqState.bands.forEach((b, i) => Object.assign(b, EQ_DEFAULT_BANDS[i], { gain: gains[i] }));
      } else if (v.startsWith('u:') && userPresets[v.slice(2)]) {
        userPresets[v.slice(2)].forEach((p, i) => Object.assign(eqState.bands[i], p));
      } else { refreshPresetList(''); return; }
      commit(); refreshPresetList(v);
    };
    refreshPresetList(''); syncOn(); updateInfo();
    for (const b of quick) b.addEventListener('click', () => applyPreset('b:' + b.getAttribute('data-preset')));
    presetSelect.addEventListener('change', () => applyPreset(presetSelect.value));
    eqOn.addEventListener('click', () => { eqState.enabled = !eqState.enabled; syncOn(); applyEq(); saveEqState(); });
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim().slice(0, 40);
      if (!name || name in EQ_BUILTIN_PRESETS) { nameInput.focus(); return; } // built-in names are reserved
      userPresets[name] = eqState.bands.map((b) => ({ freq: b.freq, gain: b.gain, q: b.q }));
      saveUserPresets(userPresets); nameInput.value = ''; refreshPresetList('u:' + name);
    });
    delBtn.addEventListener('click', () => {
      if (!presetSelect.value.startsWith('u:')) return;
      delete userPresets[presetSelect.value.slice(2)];
      saveUserPresets(userPresets); refreshPresetList('');
    });

    const bandAt = (x, y) => {
      let best = -1, bestD = 14;
      eqState.bands.forEach((b, i) => { const d = Math.hypot(xOf(b.freq) - x, yOf(b.gain) - y); if (d < bestD) { bestD = d; best = i; } });
      return best;
    };
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    canvas.addEventListener('pointerdown', (e) => {
      layout();
      const [x, y] = pos(e), i = bandAt(x, y);
      if (i < 0) return;
      if (e.ctrlKey) { Object.assign(eqState.bands[i], EQ_DEFAULT_BANDS[i]); selected = i; manualCommit(); return; } // Ctrl+click = band back to defaults
      selected = i; dragging = i; canvas.setPointerCapture(e.pointerId); updateInfo();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging < 0) return;
      const [x, y] = pos(e), b = eqState.bands[dragging];
      b.freq = Math.round(Math.min(FMAX, Math.max(FMIN, fOf(Math.min(W - 6, Math.max(PAD_L, x))))));
      b.gain = Math.round(Math.min(DB, Math.max(-DB, dbOf(y))) * 2) / 2;
      manualCommit();
    });
    const endDrag = () => { dragging = -1; };
    canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', (e) => {
      const [x, y] = pos(e), i = bandAt(x, y);
      if (i >= 0) { eqState.bands[i].gain = 0; selected = i; manualCommit(); }
    });
    canvas.addEventListener('wheel', (e) => {
      const [x, y] = pos(e), i = bandAt(x, y);
      if (i < 0) return;
      e.preventDefault(); selected = i;
      const b = eqState.bands[i];
      b.q = Math.min(10, Math.max(0.1, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      manualCommit();
    }, { passive: false });
    qSlider.addEventListener('input', () => { eqState.bands[selected].q = Number(qSlider.value); manualCommit(); });

    studio.eqDraw = () => {
      if (!layout()) return;
      const fs = masterEq?.context.sampleRate || 44100;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
      for (const db of [-12, -6, 0, 6, 12]) {
        ctx.strokeStyle = db === 0 ? '#1f6a1f' : '#0f3a0f'; ctx.beginPath(); ctx.moveTo(PAD_L, yOf(db)); ctx.lineTo(W - 6, yOf(db)); ctx.stroke();
        ctx.fillStyle = '#3c9a3c'; ctx.textAlign = 'right'; ctx.fillText((db > 0 ? '+' : '') + db, PAD_L - 5, yOf(db));
      }
      ctx.textAlign = 'center';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        ctx.strokeStyle = '#0f3a0f'; ctx.beginPath(); ctx.moveTo(xOf(f), 6); ctx.lineTo(xOf(f), 6 + plotH); ctx.stroke();
        ctx.fillStyle = '#3c9a3c'; ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), xOf(f), H - PAD_B / 2 + 2);
      }
      if (masterEq?.analyser) { // live spectrum (post-EQ, so it shows what you hear)
        const an = masterEq.analyser;
        if (!spectrum || spectrum.length !== an.frequencyBinCount) spectrum = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(spectrum);
        ctx.beginPath(); ctx.moveTo(PAD_L, 6 + plotH);
        const binHz = fs / an.fftSize;
        for (let x = PAD_L; x <= W - 6; x += 2) {
          const bin = Math.min(spectrum.length - 1, Math.max(1, Math.round(fOf(x) / binHz)));
          const level = Math.max(0, Math.min(1, (spectrum[bin] + 100) / 80)); // -100..-20 dBFS
          ctx.lineTo(x, 6 + plotH - level * plotH * 0.9);
        }
        ctx.lineTo(W - 6, 6 + plotH); ctx.closePath();
        ctx.fillStyle = '#1d6a1d88'; ctx.fill();
      }
      ctx.beginPath(); // combined response curve
      for (let x = PAD_L; x <= W - 6; x += 2) {
        const f = fOf(x);
        let db = 0;
        if (eqState.enabled) for (const b of eqState.bands) db += eqBandDb(b, f, fs);
        db = Math.max(-DB, Math.min(DB, db));
        if (x === PAD_L) ctx.moveTo(x, yOf(db)); else ctx.lineTo(x, yOf(db));
      }
      ctx.strokeStyle = eqState.enabled ? '#6dff6d' : '#2d5a2d'; ctx.lineWidth = 2.5;
      ctx.shadowColor = '#6dff6d'; ctx.shadowBlur = eqState.enabled ? 8 : 0; ctx.stroke(); ctx.shadowBlur = 0;
      eqState.bands.forEach((b, i) => {
        const x = xOf(b.freq), y = yOf(b.gain);
        ctx.beginPath(); ctx.arc(x, y, i === selected ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = COLORS[i % COLORS.length]; ctx.globalAlpha = eqState.enabled ? 1 : 0.4; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 2; ctx.strokeStyle = i === selected ? '#fff' : '#000'; ctx.stroke();
        ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, y + 0.5);
      });
    };
  }

  function studioBuildOutput(sec) {
    const vus = h('div', 'vus');
    const needles = [];
    for (const label of ['L', 'R']) {
      const d = h('div', 'vu');
      d.append(h('span', 'lbl l', label), h('span', 'lbl c', 'VU'), h('i', 'nd'));
      vus.appendChild(d); needles.push(d.querySelector('.nd'));
    }
    const knobs = h('div', 'row');
    knobs.append(
      studioKnob('MASTER', 'red big', () => eqState.master, (v) => { eqState.master = v; applyOutput(); saveEqState(); }, 0.8),
      studioKnob('THRESH', '', () => eqState.thresh, (v) => { eqState.thresh = v; applyOutput(); saveEqState(); }, 5 / 6));
    const lim = h('button', 'btn solo limiter', null, { type: 'button', 'aria-label': 'Output limiter enabled' });
    const led = h('span', 'led');
    lim.append(led, document.createTextNode('LIMITER'));
    lim.title = 'Peak limiter after the EQ and master gain. Off = no processing.';
    const syncLim = () => { lim.classList.toggle('on', eqState.limiter); led.classList.toggle('on', eqState.limiter); lim.setAttribute('aria-pressed', String(eqState.limiter)); };
    lim.addEventListener('click', () => { eqState.limiter = !eqState.limiter; routeLimiter(); saveEqState(); syncLim(); });
    syncLim();
    const sw = h('div', 'switches'); sw.appendChild(lim);
    const master = h('div', 'master'); master.append(knobs, sw);
    sec.append(vus, master);

    const buf = new Float32Array(2048), angles = [-39, -39];
    const rmsDb = (an) => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i += 1) s += buf[i] * buf[i];
      return s > 0 ? 10 * Math.log10(s / buf.length) : -100;
    };
    // Needle: 0 VU (= -18 dBFS RMS) sits at the start of the red zone (+20 deg); ends at +-39 deg.
    const angleOf = (db) => Math.max(-39, Math.min(39, db <= -18 ? 20 + (db + 18) * 2.95 : 20 + (db + 18) * 1.9));
    studio.vuDraw = () => {
      const ans = masterEq?.anL ? [masterEq.anL, masterEq.anR] : null;
      needles.forEach((n, i) => {
        const target = ans ? angleOf(rmsDb(ans[i])) : -39;
        angles[i] += (target - angles[i]) * 0.25; // ~VU ballistics
        n.style.transform = `rotate(${angles[i].toFixed(1)}deg)`;
      });
    };
  }

  // Switch button with an LED, bound to a boolean in fxState.
  function studioToggle(text, group, key, onChange) {
    const btn = h('button', 'btn solo fxon', null, { type: 'button', 'aria-label': text });
    const led = h('span', 'led');
    btn.append(led, document.createTextNode(text));
    const sync = () => { const v = fxState[group][key]; btn.classList.toggle('on', v); led.classList.toggle('on', v); btn.setAttribute('aria-pressed', String(v)); };
    btn.addEventListener('click', () => { fxState[group][key] = !fxState[group][key]; sync(); saveFx(); onChange(); });
    sync();
    btn.syncFn = sync;
    return btn;
  }

  // Reverb/delay presets (rev = reverb send, decay 0..1 = 0.4..4 s, dly = delay send, time 0..1 = 0.12..0.72 s).
  const REVERB_PRESETS = {
    'Dry': { rev: 0, dly: 0 },
    'Small Room': { rev: 0.22, decay: 0.08, dly: 0 },
    'Vocal Booth': { rev: 0.14, decay: 0.03, dly: 0 },
    'Studio Plate': { rev: 0.3, decay: 0.28, dly: 0 },
    'Bright Hall': { rev: 0.36, decay: 0.55, dly: 0 },
    'Cathedral': { rev: 0.46, decay: 0.95, dly: 0 },
    'Slapback': { rev: 0.12, decay: 0.05, dly: 0.35, time: 0 },
    'Tape Echo': { rev: 0.2, decay: 0.3, dly: 0.4, time: 0.45 },
    'Karaoke Classic': { rev: 0.38, decay: 0.4, dly: 0.18, time: 0.35 },
    'Stadium': { rev: 0.5, decay: 0.8, dly: 0.3, time: 0.6 },
  };
  function studioBuildVocalLab(sec) {
    const group = 'voc', row = h('div', 'row fxknobs');
    const defs = [['COMP', 'comp', ''], ['DE-ESS', 'deess', ''], ['PRES', 'pres', ''], ['REVERB', 'rev', 'red'], ['DECAY', 'decay', 'red'], ['DELAY', 'dly', 'red'], ['TIME', 'time', 'red']];
    const boxes = [];
    const presetSel = h('select', 'sel', null, { 'aria-label': 'Reverb and delay preset' });
    for (const k of ['keydown', 'keyup', 'keypress']) presetSel.addEventListener(k, (e) => e.stopPropagation());
    const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; presetSel.appendChild(o); };
    add('', 'Custom');
    for (const name of Object.keys(REVERB_PRESETS)) add(name, name);
    const near = (x, y) => Math.abs(x - y) < 0.005;
    const syncPreset = () => { // show the preset the knobs currently match, otherwise Custom
      const v = fxState.voc;
      const hit = Object.entries(REVERB_PRESETS).find(([, p]) => Object.entries(p).every(([k, val]) => near(v[k], val)));
      presetSel.value = hit ? hit[0] : '';
    };
    for (const [label, key, cls] of defs) {
      const dflt = key === 'decay' ? 0.4 : key === 'time' ? 0.4 : 0;
      const box = studioKnob(label, cls, () => fxState[group][key], (v) => { fxState[group][key] = v; applyVocalFxAll(key === 'decay'); saveFx(); syncPreset(); }, dflt, key === 'decay' ? () => applyVocalFxAll() : undefined);
      boxes.push(box); row.appendChild(box);
    }
    presetSel.addEventListener('change', () => {
      const p = REVERB_PRESETS[presetSel.value];
      if (!p) return;
      Object.assign(fxState.voc, p); saveFx(); applyVocalFxAll();
      boxes.forEach((bx) => bx.redraw());
    });
    syncPreset();
    const pr = h('div', 'eqinfo-row'); pr.append(h('span', null, 'PRESET'), presetSel);
    const labBtn = studioToggle('VOCAL LAB', group, 'on', applyVocalFxAll);
    studio.syncVocalLab = labBtn.syncFn;
    const sw = h('div', 'switches'); sw.appendChild(labBtn);
    sec.append(pr, row, sw);
  }

  function studioBuildEnhancer(sec) {
    const group = 'enh', row = h('div', 'row fxknobs');
    const defs = [['DRIVE', 'drive', '', 0], ['WARMTH', 'warmth', '', 0], ['AIR', 'air', '', 0], ['WIDTH', 'width', 'red', 0.5]];
    const presets = [['ANALOG', [0.25, 0.5, 0.2, 0.5]], ['VINYL', [0.15, 0.7, 0, 0.45]], ['TAPE', [0.35, 0.6, 0.1, 0.5]]]; // [drive, warmth, air, width]
    const presetBtns = [];
    const matches = (v) => [fxState.enh.drive, fxState.enh.warmth, fxState.enh.air, fxState.enh.width].every((x, i) => Math.abs(x - v[i]) < 0.005);
    const syncPresets = () => presetBtns.forEach(([b, v]) => { const on = matches(v); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const build = () => {
      row.textContent = '';
      for (const [label, key, cls, dflt] of defs) {
        row.appendChild(studioKnob(label, cls, () => fxState[group][key], (v) => { fxState[group][key] = v; applyEnhancer(); saveFx(); syncPresets(); }, dflt));
      }
    };
    build();
    const sw = h('div', 'switches fill');
    const onBtn = studioToggle('ENHANCER', group, 'on', () => { routeEnhancer(); applyEnhancer(); });
    sw.appendChild(onBtn);
    for (const [name, v] of presets) {
      const b = h('button', 'btn', name, { type: 'button' });
      b.addEventListener('click', () => {
        [fxState.enh.drive, fxState.enh.warmth, fxState.enh.air, fxState.enh.width] = v;
        fxState.enh.on = true; saveFx(); build(); routeEnhancer(); applyEnhancer();
        onBtn.classList.add('on'); onBtn.firstChild.classList.add('on'); onBtn.setAttribute('aria-pressed', 'true');
        syncPresets();
      });
      presetBtns.push([b, v]);
      sw.appendChild(b);
    }
    syncPresets();
    sec.append(row, sw);
  }

  // Karaoke: one click = capture on, Stems mode, vocal stem muted, mic on, Vocal Lab on. Clicking again restores the previous mode, vocal mute/solo and Vocal Lab state.
  let karaoke = null;
  function karaokeOff() {
    if (!karaoke) return;
    const k = karaoke; karaoke = null;
    stopMic();
    fxState.voc.on = k.prev.lab; saveFx(); applyVocalFxAll(); studio.syncVocalLab?.();
    if (vocalSlider) { vocalSlider.stemFlags.mute = k.prev.mute; vocalSlider.stemFlags.solo = k.prev.solo; }
    studioRebuildStrips(); applyStemLevels();
    if (captureActive) setMode(k.prev.mode, true);
    stemDiag('karaoke_off', { state: 'off' });
  }
  async function karaokeToggle(info) {
    if (karaoke) { karaokeOff(); return; }
    const flags = vocalSlider?.stemFlags || { mute: false, solo: false };
    karaoke = { prev: { mode: modeSelect?.value || 'bypass', mute: !!flags.mute, solo: !!flags.solo, lab: fxState.voc.on } };
    try {
      if (!captureActive && !(await beginCapture())) throw new Error('capture did not start');
      flags.mute = true; flags.solo = false;
      studioRebuildStrips(); applyStemLevels();
      setMode('stems', true);
      await startMic();
      fxState.voc.on = true; saveFx(); applyVocalFxAll(); studio.syncVocalLab?.(); // Vocal Lab onto the mic
      stemDiag('karaoke_on', { state: 'on' });
    } catch (error) {
      karaokeOff();
      const text = String(error?.name === 'Error' || !error?.name ? error?.message : error.name).slice(0, 40);
      info.textContent = 'KARAOKE ERROR: ' + text;
      stemDiag('karaoke_error', { error: text });
    }
  }

  function studioBuildMic(sec) {
    const select = h('select', 'sel', null, { 'aria-label': 'Microphone input device' });
    for (const k of ['keydown', 'keyup', 'keypress']) select.addEventListener(k, (e) => e.stopPropagation());
    const refresh = async () => {
      let devices = [];
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch {}
      select.textContent = '';
      const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; select.appendChild(o); };
      add('', 'Default input');
      devices.forEach((d, i) => { if (d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications') add(d.deviceId, d.label || 'Input ' + (i + 1)); });
      select.value = micState.device;
      if (select.value !== micState.device) select.value = '';
    };
    refresh();
    const onBtn = h('button', 'btn solo fxon', null, { type: 'button', 'aria-label': 'Microphone on' });
    const led = h('span', 'led');
    onBtn.append(led, document.createTextNode('MIC'));
    const info = h('span', 'eqinfo', 'USE HEADPHONES');
    const sync = () => { const on = !!mic; onBtn.classList.toggle('on', on); led.classList.toggle('on', on); onBtn.setAttribute('aria-pressed', String(on)); };
    onBtn.addEventListener('click', async () => {
      if (mic) { stopMic(); sync(); info.textContent = 'USE HEADPHONES'; return; }
      onBtn.disabled = true;
      try { await startMic(); await refresh(); } catch (error) {
        info.textContent = 'MIC ERROR: ' + String(error?.name || error).slice(0, 40);
        stemDiag('mic_error', { error: String(error?.name || error).slice(0, 80) });
      }
      onBtn.disabled = false; sync();
    });
    select.addEventListener('change', async () => {
      micState.device = select.value; saveMic();
      if (mic) { stopMic(); try { await startMic(); } catch (error) { info.textContent = 'MIC ERROR: ' + String(error?.name || error).slice(0, 40); } sync(); }
    });
    const row = h('div', 'row fxknobs');
    const lvl = studioKnob('LEVEL', 'red', () => micState.level, (v) => { micState.level = v; applyMicLevel(); studio.micFaderRefresh?.(); }, STEM_FADER_DEFAULT, saveMic);
    studio.micKnobRedraw = lvl.redraw;
    row.appendChild(lvl);
    const sw = h('div', 'switches'); sw.appendChild(onBtn);
    const ir = h('div', 'eqinfo-row'); ir.append(h('span', null, 'INPUT'), select);
    const ir2 = h('div', 'eqinfo-row'); ir2.appendChild(info);
    const right = h('div', 'micctl'); right.append(ir, row, sw, ir2);
    const karaokeBtn = h('button', 'micbtn', null, { type: 'button', 'aria-label': 'Karaoke mode' });
    karaokeBtn.title = 'Karaoke: starts capture, Stems mode, mutes the vocal stem, turns the mic and Vocal Lab on. Click again to restore.';
    const kcol = h('div', 'mickcol'); kcol.append(karaokeBtn, h('div', 'miclabel', 'KARAOKE'));
    const wrap = h('div', 'micwrap'); wrap.append(kcol, right);
    sec.append(wrap);
    const syncK = () => { karaokeBtn.classList.toggle('on', !!karaoke); karaokeBtn.setAttribute('aria-pressed', String(!!karaoke)); };
    karaokeBtn.addEventListener('click', async () => {
      karaokeBtn.disabled = true;
      try { await karaokeToggle(info); } finally { karaokeBtn.disabled = false; sync(); syncK(); }
    });
    syncK();
    studio.micTick = () => { // input peak, so the level can be set without clipping
      if (!mic) return;
      mic.an.getFloatTimeDomainData(mic.buf);
      let pk = 0;
      for (let i = 0; i < mic.buf.length; i += 1) { const a = Math.abs(mic.buf[i]); if (a > pk) pk = a; }
      const db = pk > 0 ? 20 * Math.log10(pk) : -100;
      info.textContent = 'IN ' + (db > -99 ? db.toFixed(0) + ' dB' : '-inf dB') + (db > -1 ? '  CLIP' : '');
    };
  }

  const STUDIO_CSS = (T) => `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { --edge: #3a322c; --edge-hi: #5a4c40; --ink-dim: #cdbfa9; --brass: #d9b07a; --amber: #ffb347;
      font-family: "Bahnschrift", "Segoe UI Condensed", "Arial Narrow", system-ui, sans-serif; color: #e9dfd0; }
    .tab { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%); z-index: 2147483646; padding: 6px 22px 8px;
      border: 1px solid var(--edge-hi); border-bottom: 0; border-radius: 10px 10px 0 0; cursor: pointer;
      background: linear-gradient(#2c2622, #1b1816); color: var(--brass); font: 700 12px "Bahnschrift", system-ui, sans-serif; letter-spacing: .2em;
      transition: bottom .35s cubic-bezier(.2,.8,.2,1); }
    .tab:hover { color: var(--amber); }
    .tab.open { bottom: 330px; }
    .drawer { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483645; height: 330px; transform: translateY(100%); visibility: hidden;
      transition: transform .35s cubic-bezier(.2,.8,.2,1), visibility 0s .35s; display: grid; grid-template-columns: 24px 1fr 24px;
      background: ${T('metal.jpg')} 0 0 / 256px 256px, #14110f; border-top: 2px solid var(--edge-hi); box-shadow: 0 -12px 40px #000c; }
    .drawer.open { transform: none; visibility: visible; transition: transform .35s cubic-bezier(.2,.8,.2,1); }
    .wood { background: ${T('wood.jpg')} center / 100% 100% no-repeat, #3a2012; box-shadow: inset 0 0 10px #000b, inset 0 0 0 1px #0006; }
    .drawer > .wood:last-child { transform: scaleX(-1); }
    .console { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8px; padding: 8px; min-width: 0; }
    .section.session { width: 210px; flex: 0 0 auto; }
    .section.session .eqinfo-row { justify-content: space-between; }
    .section.session .qrange { width: 100px; }
    .btn.capture { width: 100%; height: 28px; margin-top: 4px; }
    .section.fx { width: 232px; flex: 0 0 auto; }
    .section.fx.enh { width: 238px; }
    .section.fx.mic { width: 308px; }
    .micwrap { display: flex; gap: 8px; align-items: flex-start; }
    .micctl { flex: 1; min-width: 0; }
    .mickcol { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: none; }
    .micbtn { position: relative; width: 58px; height: 182px; padding: 0; border: 0; cursor: pointer; background: ${T('mic.png')} center / contain no-repeat; }
    .micbtn::after { content: ""; position: absolute; inset: 0; opacity: 0; pointer-events: none; transition: opacity .25s;
      -webkit-mask: ${T('mic.png')} center / contain no-repeat; mask: ${T('mic.png')} center / contain no-repeat;
      background: radial-gradient(ellipse 90% 55% at 50% 24%, #ffc25aee, #ff8a1f66 55%, transparent 80%); mix-blend-mode: screen; }
    .micbtn.on { filter: drop-shadow(0 0 9px #ffb347cc) brightness(1.08); }
    .micbtn.on::after { opacity: 1; }
    .micbtn:active { transform: translateY(1px); }
    .micbtn:disabled { opacity: .6; cursor: default; }
    .miclabel { font-size: 10px; font-weight: 800; letter-spacing: .16em; color: var(--ink-dim); text-shadow: 0 1px 2px #000; }
    .micctl .row.fxknobs { padding-left: 0; }
    .row.fxknobs { flex-wrap: wrap; justify-content: flex-start; gap: 10px 12px; padding-left: 6px; }
    .btn.fxon { width: 100%; height: 26px; }
    .switches.fill .btn.fxon { flex: 1 1 100%; }
    .console { overflow-y: auto; }
    .section.eq { flex: 1 1 360px; max-width: 560px; min-width: 0; }
    .eq-screen { width: 100%; height: 150px; border-radius: 6px; display: block; background: #031003; touch-action: none; cursor: crosshair;
      box-shadow: inset 0 0 22px #000, 0 0 0 2px #0a0f0a, 0 0 0 3px var(--edge); }
    .switches { display: flex; gap: 6px; margin: 8px 0 0 4px; flex-wrap: wrap; align-items: center; }
    .switches.fill .btn { flex: 1; width: auto; height: 26px; font-size: 10px; }
    .switches.eqrow .btn { flex: 0 0 46px; }
    .sel, .txt { height: 24px; min-width: 0; border: 1px solid #000; border-radius: 4px; background: #1b1713; color: #e9dfd0; font: 700 11px "Bahnschrift", system-ui, sans-serif; padding: 0 6px; }
    .sel { flex: 1 1 90px; } .txt { flex: 1 1 80px; width: 80px; }
    .eqinfo-row { display: flex; gap: 8px; align-items: center; margin: 6px 4px 0; font-size: 10px; font-weight: 700; letter-spacing: .1em; color: var(--ink-dim); text-shadow: 0 1px 2px #000; }
    .eqinfo { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qrange { width: 110px; }
    .vus { display: flex; gap: 8px; margin-bottom: 8px; }
    .vu { width: 128px; height: 80px; border-radius: 4px; position: relative; overflow: hidden;
      background: ${T('vu-face.png')} center / 100% 100% no-repeat; box-shadow: inset 0 0 14px #000a, 0 0 0 2px #0a0807, 0 0 0 3px var(--edge); }
    .vu .nd { position: absolute; left: 50%; bottom: -24.4%; width: 2px; height: 107%; margin-left: -1px; border-radius: 1px;
      background: linear-gradient(#1a1208, #3a2a10); transform-origin: 50% 100%; transform: rotate(-39deg); box-shadow: 3px 2px 3px #0005; }
    .vu .lbl { position: absolute; font-weight: 800; font-size: 12px; color: #3a2a10; letter-spacing: .1em; }
    .vu .lbl.l { left: 8px; bottom: 6px; } .vu .lbl.c { left: 50%; bottom: 26%; transform: translateX(-50%); font-size: 15px; }
    .vu::after { content: ""; position: absolute; inset: 0; background: linear-gradient(160deg, #ffffff38, transparent 38%); pointer-events: none; }
    .master { display: flex; flex-direction: column; gap: 8px; width: 190px; }
    .row { display: flex; gap: 12px; align-items: flex-end; justify-content: center; }
    .knob-box { display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 10px; font-weight: 700; color: var(--ink-dim); letter-spacing: .12em; text-shadow: 0 1px 2px #000; }
    .knob { position: relative; width: 38px; height: 38px; cursor: ns-resize; touch-action: none;
      background: ${T('knob-cream.png')} center / 100% 100% no-repeat; border-radius: 50%; box-shadow: 0 3px 4px #000b; }
    .knob::after { content: ""; position: absolute; left: 50%; top: 8px; width: 2.5px; height: 10px; margin-left: -1.25px;
      background: ${T('pointer.png')} center / 100% 100% no-repeat; transform-origin: 50% 11px; transform: rotate(var(--a, 0deg)); }
    .knob:not(.red):not(.blue):not(.big)::after { filter: brightness(.12) contrast(1.2); }
    .knob.red { background-image: ${T('knob-red.png')}; }
    .knob.big { width: 62px; height: 62px; background-image: ${T('knob-master.png')}; }
    .knob.big::after { top: 12px; width: 4px; height: 17px; margin-left: -2px; transform-origin: 50% 19px; }
    .btn.limiter { width: 80px; }
    .led { width: 8px; height: 8px; border-radius: 50%; background: #3a2a14; display: inline-block; margin-right: 4px; }
    .led.on { background: var(--amber); box-shadow: 0 0 8px var(--amber); }
    .section { position: relative; padding: 8px; border: 1px solid #0009; border-radius: 6px;
      background: linear-gradient(#ffffff0d, transparent 30%, #0006), ${T('metal.jpg')} 0 0 / 256px 256px; box-shadow: inset 0 1px 0 #ffffff14, inset 0 0 18px #000a, 0 2px 4px #000a; }
    .screw { position: absolute; width: 10px; height: 10px; background: ${T('screw.png')} center / 100% 100% no-repeat; filter: drop-shadow(0 1px 1px #000c); }
    .screw.tl { top: 3px; left: 3px } .screw.tr { top: 3px; right: 3px } .screw.bl { bottom: 3px; left: 3px } .screw.br { bottom: 3px; right: 3px }
    .title { font-size: 12px; font-weight: 700; text-shadow: 0 1px 2px #000; letter-spacing: .22em; color: #f0c88e; margin: 0 0 6px 12px; text-transform: uppercase; }
    .channels { display: flex; gap: 6px; }
    .strip { width: 84px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 4px; }
    .strip .name { width: 70px; text-align: center; padding: 6px 0 5px; background: ${T('label.png')} center / 100% 100% no-repeat;
      color: #2a241c; font-weight: 800; font-size: 12px; letter-spacing: .12em; filter: drop-shadow(0 1px 2px #000a); }
    .btns { display: flex; gap: 4px; }
    .btn { --src: ${T('btn-cream.png')}; position: relative; width: 38px; height: 22px; padding: 0; cursor: pointer;
      border: 6px solid transparent; border-image: var(--src) 16 fill / 6px stretch; background: none;
      font: 800 9px/10px "Bahnschrift", system-ui, sans-serif; letter-spacing: .06em; color: #2a241c; filter: drop-shadow(0 2px 1px #000a); }
    .btn.mute { --src: ${T('btn-red.png')}; color: #ffe9e4; text-shadow: 0 1px 1px #000a; }
    .btn.on, .btn:active { --src: ${T('btn-cream-down.png')}; transform: translateY(1px); filter: drop-shadow(0 1px 0 #000a); }
    .btn.mute.on, .btn.mute:active { --src: ${T('btn-red-down.png')}; }
    .btn.solo.on { filter: drop-shadow(0 0 7px #ffb347); }
    .btn.mute.on { filter: drop-shadow(0 0 7px #ff5a4a); }
    .btn:disabled { opacity: .4; cursor: default; }
    .fader-wrap { display: flex; gap: 6px; height: 160px; }
    .scale { display: flex; flex-direction: column; justify-content: space-between; font-size: 10px; text-shadow: 0 1px 1px #000; color: var(--ink-dim); text-align: right; padding: 2px 0; min-width: 22px; }
    .track { position: relative; width: 10px; border-radius: 5px; background: #050404; box-shadow: inset 0 0 4px #000, 0 1px 0 #ffffff14; touch-action: none; cursor: ns-resize; }
    .cap { position: absolute; left: 50%; width: 24px; height: 46px; transform: translate(-50%, 50%); border-radius: 3px;
      background: ${T('cap-cream.png')} center / 100% 100% no-repeat; box-shadow: 0 3px 5px #000c; }
    .cap.red { background-image: ${T('cap-red.png')}; }
    .led-meter { display: flex; flex-direction: column-reverse; gap: 2px; width: 7px; padding: 1px; background: #050404; border-radius: 2px; }
    .led-meter i { flex: 1; border-radius: 1px; background: #1c1916; }
    .led-meter i.g.on { background: #51e36a; box-shadow: 0 0 4px #51e36a; }
    .led-meter i.y.on { background: #ffd24a; box-shadow: 0 0 4px #ffd24a; }
    .led-meter i.r.on { background: #ff4a3a; box-shadow: 0 0 5px #ff4a3a; }
    .clock { font: 700 13px Consolas, monospace; letter-spacing: .12em; color: var(--amber); text-shadow: 0 0 6px #ffb34766; }
    .status { flex-basis: 100%; display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; text-shadow: 0 1px 2px #000; letter-spacing: .14em; color: var(--ink-dim); padding: 0 6px; }
  `;

  async function installStudioDrawer() {
    if (studio.host?.isConnected || studio.installing || studio.failed >= 3 || !document.documentElement) return;
    studio.installing = true;
    try {
      let tex = {};
      try { tex = await ipcRenderer.invoke('poc:textures'); } catch {}
      const T = (name) => (tex && typeof tex[name] === 'string' && tex[name].startsWith('data:image/') ? `url("${tex[name]}")` : 'none');
      const host = document.createElement('div');
      host.id = 'ytm-poc-studio';
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STUDIO_CSS(T);
      const ui = h('div', 'ui');
      const drawer = h('div', 'drawer');
      const consoleEl = h('div', 'console');
      const section = studioMakeSection('Mixer');
      section.appendChild(h('div', 'channels'));
      const eqSection = studioMakeSection('Equalizer');
      eqSection.classList.add('eq');
      const outSection = studioMakeSection('Output');
      const sessSection = studioMakeSection('Session');
      sessSection.classList.add('session');
      const status = h('div', 'status');
      const clock = h('span', 'clock', '--:--:--');
      status.append(h('span'), h('span'), h('span'), clock);
      const tick = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
      tick(); setInterval(tick, 500); // local time, to match skips heard against the UTC logs (+3 h here)
      const micSection = studioMakeSection('Mic');
      micSection.classList.add('fx', 'mic');
      const labSection = studioMakeSection('Vocal Lab');
      labSection.classList.add('fx');
      const enhSection = studioMakeSection('Enhancer');
      enhSection.classList.add('fx', 'enh');
      consoleEl.append(sessSection, micSection, section, eqSection, labSection, enhSection, outSection, status);
      drawer.append(h('div', 'wood'), consoleEl, h('div', 'wood'));
      ui.append(drawer, h('button', 'tab', 'STUDIO \u25B2', { type: 'button', 'aria-label': 'Toggle studio drawer' }));
      root.append(style, ui);
      studio.host = host; studio.root = root;
      studio.statusEls = [...root.querySelectorAll('.status span')];
      root.querySelector('.tab').addEventListener('click', () => studioSetOpen(!studio.open));
      studioRebuildStrips();
      studioBuildEq(eqSection);
      studioBuildOutput(outSection);
      studioBuildSession(sessSection);
      studioBuildMic(micSection);
      studioBuildVocalLab(labSection);
      studioBuildEnhancer(enhSection);
      applyOutput();
      document.documentElement.appendChild(host);
      let wasOpen = false;
      try { wasOpen = localStorage.getItem('ytm-poc-drawer-open') === '1'; } catch {}
      studioSetOpen(wasOpen);
    } catch (error) {
      log('capture_error', { state: 'studio_drawer_failed', error: String(error?.message || error).slice(0, 180) });
      studio.failed = (studio.failed || 0) + 1;
    } finally { studio.installing = false; }
  }

  function setChannelFormat(node) {
    try { node.channelCount = 2; } catch {}
    try { node.channelCountMode = 'explicit'; } catch {}
  }

  async function beginCapture() {
    if (captureStarting) return Promise.resolve(false);
    captureStarting = true;
    // Must precede the capture_start_requested log: the main process locks model changes once capture is requested.
    ipcRenderer.send('poc:stem-model', modelSelect?.value || 'umx-hq');
    log('capture_start_requested', { state: 'requested' });
    try {
      const media = findMedia();
      if (!media) {
        log('media_element_missing', { state: 'waiting' });
        captureStarting = false;
        return Promise.resolve(false);
      }
      if (!activeContext || activeContext.state === 'closed') activeContext = new AudioContext({ latencyHint: 'interactive' });
      const context = activeContext;
      return context.resume().then(async () => {
        if (!wiredElements.has(media)) {
          const source = context.createMediaElementSource(media);
          wiredElements.add(media);
          graphs.set(media, connectAudioGraph(source, context, media));
        }
        const graph = graphs.get(media);
        if (graph) {
          setMode(graph.mode, false, graph);
          setUserGain(Number(gainSlider?.value || 0), graph);
        }
        if (modelSelect) modelSelect.disabled = true;
        currentPcmTransport = await openPcmTransport();
        startMeasurement(graph, context, media, currentPcmTransport);
        if (modeSelect) modeSelect.disabled = false;
        if (gainSlider) gainSlider.disabled = false;
        captureActive = true;
        log('capture_started', { sampleRate: context.sampleRate, state: 'capturing' });
        log('latency_info', {
          baseLatency: typeof context.baseLatency === 'number' ? context.baseLatency : null,
          outputLatency: typeof context.outputLatency === 'number' ? context.outputLatency : null,
        });
        if (button) button.textContent = 'STOP';
        scanMedia();
        return true;
      }).catch((error) => {
        log('capture_error', { state: 'failed', error: String(error?.message || error).slice(0, 180) });
        return false;
      }).finally(() => { captureStarting = false; });
    } catch (error) {
      log('capture_error', { state: 'failed', error: String(error?.message || error).slice(0, 180) });
      captureStarting = false;
      return Promise.resolve(false);
    }
  }

  function toggleCapture() { return captureActive ? stopCapture() : beginCapture(); }

  function stopCapture() {
    if (!captureActive) return false;
    log('capture_stop_requested', { state: 'stopping' });
    for (const media of document.querySelectorAll('audio, video')) {
      const graph = graphs.get(media);
      if (graph) stopMeasurement(graph);
    }
    closePcmTransport();
    // Capture off => no processing: force the dry path but remember the selected mode for restart.
    for (const media of document.querySelectorAll('audio, video')) {
      const graph = graphs.get(media);
      if (!graph) continue;
      const now = activeContext?.currentTime || 0;
      graph.dryGain.gain.setTargetAtTime(1, now, 0.02);
      graph.wetGain.gain.setTargetAtTime(0, now, 0.02);
      graph.stemBus.gain.setTargetAtTime(0, now, 0.02);
    }
    if (modeSelect) modeSelect.disabled = true;
    if (gainSlider) gainSlider.disabled = true;
    if (modelSelect) modelSelect.disabled = false;
    captureActive = false;
    lastMetricsAt = 0;
    lastZeroStart = null;
    if (button) button.textContent = 'START';
    log('capture_stopped', { state: 'stopped' });
    return true;
  }

  async function runAutoCycles(cycles) {
    if (autoCycleRunning) return;
    autoCycleRunning = true;
    try {
      for (let i = 1; i <= cycles; i += 1) {
        if (!captureActive) {
          const started = await beginCapture();
          if (!started) return;
        }
        stopCapture();
        log('capture_start_cycle', { state: 'stopped', cycle: i, total: cycles });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const started = await beginCapture();
        if (!started) return;
        log('capture_start_cycle', { state: 'started', cycle: i, total: cycles });
      }
      stopCapture();
      log('capture_start_cycle', { state: 'complete', total: cycles });
    } finally { autoCycleRunning = false; }
  }

  // Master parametric EQ: every audible path (dry, processed, stems) feeds eqInput; the chain ends at destination.
  const EQ_STORE_KEY = 'ytm-poc-eq-v1';
  const EQ_DEFAULT_BANDS = [
    { type: 'lowshelf', freq: 80, gain: 0, q: 0.707 },
    { type: 'peaking', freq: 250, gain: 0, q: 1 },
    { type: 'peaking', freq: 1000, gain: 0, q: 1 },
    { type: 'peaking', freq: 3000, gain: 0, q: 1 },
    { type: 'peaking', freq: 8000, gain: 0, q: 1 },
    { type: 'highshelf', freq: 12000, gain: 0, q: 0.707 },
  ];
  const eqState = (() => {
    const fresh = { enabled: true, limiter: false, master: 0.8, thresh: 5 / 6, bands: EQ_DEFAULT_BANDS.map((b) => ({ ...b })) };
    try {
      const saved = JSON.parse(localStorage.getItem(EQ_STORE_KEY) || 'null');
      if (saved && Array.isArray(saved.bands) && saved.bands.length === fresh.bands.length) {
        fresh.enabled = saved.enabled !== false;
        fresh.limiter = saved.limiter === true; // opt-in only, never automatic
        if (Number.isFinite(saved.master)) fresh.master = Math.min(1, Math.max(0, saved.master));
        if (Number.isFinite(saved.thresh)) fresh.thresh = Math.min(1, Math.max(0, saved.thresh));
        saved.bands.forEach((b, i) => {
          const f = Number(b.freq), g = Number(b.gain), q = Number(b.q);
          if (Number.isFinite(f)) fresh.bands[i].freq = Math.min(20000, Math.max(20, f));
          if (Number.isFinite(g)) fresh.bands[i].gain = Math.min(18, Math.max(-18, g));
          if (Number.isFinite(q)) fresh.bands[i].q = Math.min(10, Math.max(0.1, q));
        });
      }
    } catch {}
    return fresh;
  })();
  const EQ_PRESETS_KEY = 'ytm-poc-eq-presets-v1';
  // Built-in presets: gains for the 6 bands (low shelf 80, 250, 1k, 3k, 8k, high shelf 12k); freq/Q stay at defaults.
  const EQ_BUILTIN_PRESETS = {
    'Flat': [0, 0, 0, 0, 0, 0],
    'Bass boost': [6, 3, 0, 0, 0, 0],
    'Treble boost': [0, 0, 0, 1, 3, 5],
    'Vocal boost': [-2, -2, 2, 4, 1, 0],
    'Rock (V shape)': [5, -2, -1, 2, 4, 4],
    'Loudness': [6, 0, -2, -1, 3, 5],
  };
  function loadUserPresets() {
    try {
      const raw = JSON.parse(localStorage.getItem(EQ_PRESETS_KEY) || '{}');
      const out = {};
      for (const [name, bands] of Object.entries(raw)) {
        if (Array.isArray(bands) && bands.length === EQ_DEFAULT_BANDS.length) out[String(name).slice(0, 40)] = bands.map((b, i) => ({
          freq: Math.min(20000, Math.max(20, Number(b.freq) || EQ_DEFAULT_BANDS[i].freq)),
          gain: Math.min(18, Math.max(-18, Number(b.gain) || 0)),
          q: Math.min(10, Math.max(0.1, Number(b.q) || EQ_DEFAULT_BANDS[i].q)),
        }));
      }
      return out;
    } catch { return {}; }
  }
  function saveUserPresets(presets) { try { localStorage.setItem(EQ_PRESETS_KEY, JSON.stringify(presets)); } catch {} }
  let masterEq = null;

  function saveEqState() { try { localStorage.setItem(EQ_STORE_KEY, JSON.stringify(eqState)); } catch {} }

  function applyEq() {
    if (!masterEq) return;
    const t = masterEq.context.currentTime;
    eqState.bands.forEach((b, i) => {
      const f = masterEq.filters[i];
      f.frequency.setTargetAtTime(b.freq, t, 0.01);
      f.Q.setTargetAtTime(b.q, t, 0.01);
      f.gain.setTargetAtTime(eqState.enabled ? b.gain : 0, t, 0.01); // disabled = 0 dB on every band (transparent)
    });
  }

  // Output stage: eq -> master gain -> [limiter] -> out -> destination; out also feeds the L/R VU analysers.
  function masterDb(v) { return v <= 0.8 ? -24 + (v / 0.8) * 24 : ((v - 0.8) / 0.2) * 6; } // knob 0.8 = 0 dB
  function threshDb(v) { return -12 + v * 12; } // knob 5/6 = -2 dB (the old fixed ceiling)

  function applyOutput() {
    if (!masterEq) return;
    const t = masterEq.context.currentTime;
    masterEq.master.gain.setTargetAtTime(10 ** (masterDb(eqState.master) / 20), t, 0.02);
    masterEq.limiter.threshold.setTargetAtTime(threshDb(eqState.thresh), t, 0.02);
  }

  function routeLimiter() {
    if (!masterEq || masterEq.limiterOn === eqState.limiter) return;
    const { master, limiter, outNode } = masterEq;
    try { master.disconnect(); } catch {}
    try { limiter.disconnect(); } catch {}
    if (eqState.limiter) { master.connect(limiter); limiter.connect(outNode); }
    else master.connect(outNode);
    masterEq.limiterOn = eqState.limiter;
  }

  function getEqInput(context) {
    if (masterEq && masterEq.context === context) return masterEq.input;
    const input = context.createGain();
    setChannelFormat(input);
    let prev = input;
    const filters = eqState.bands.map((b) => {
      const f = context.createBiquadFilter();
      f.type = b.type;
      setChannelFormat(f);
      prev.connect(f);
      prev = f;
      return f;
    });
    // Optional output limiter (user-controlled). Off = master goes straight to the output (clean bypass).
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = threshDb(eqState.thresh); limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.1;
    setChannelFormat(limiter);
    const master = context.createGain();
    master.gain.value = 10 ** (masterDb(eqState.master) / 20);
    setChannelFormat(master);
    const outNode = context.createGain();
    setChannelFormat(outNode);
    outNode.connect(context.destination);
    const splitter = context.createChannelSplitter(2);
    outNode.connect(splitter);
    const anL = context.createAnalyser(), anR = context.createAnalyser();
    anL.fftSize = 2048; anR.fftSize = 2048;
    splitter.connect(anL, 0); splitter.connect(anR, 1); // taps only: drive the VU meters
    const eqOut = prev;
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.8;
    prev.connect(analyser); // tap only: drives the EQ screen spectrum
    enhancer = buildEnhancer(context); // wired in routeEnhancer(): while off, none of its nodes are connected to the destination
    masterEq = { context, input, filters, analyser, limiter, eqOut, master, outNode, anL, anR, limiterOn: null, enhOn: null };
    routeEnhancer(); applyEnhancer(); // Enhancer off = eqOut goes straight to master (clean bypass)
    routeLimiter();
    for (const [i, b] of eqState.bands.entries()) {
      filters[i].frequency.value = b.freq; filters[i].Q.value = b.q; filters[i].gain.value = eqState.enabled ? b.gain : 0;
    }
    return input;
  }

  // ---- Enhancer (master bus) and Vocal Lab (vocal stem): native Web Audio nodes only, the YTM CSP blocks AudioWorklet. ----
  const FX_KEY = 'ytm-poc-fx-v1';
  const fxState = (() => {
    const fresh = {
      enh: { on: false, drive: 0, warmth: 0, air: 0, width: 0.5 }, // width 0.5 = 100% (neutral), 0 = mono, 1 = 200%
      voc: { on: false, comp: 0, deess: 0, pres: 0, rev: 0, decay: 0.4, dly: 0, time: 0.4 },
    };
    try {
      const saved = JSON.parse(localStorage.getItem(FX_KEY) || 'null');
      for (const group of Object.keys(fresh)) for (const k of Object.keys(fresh[group])) {
        const v = saved?.[group]?.[k];
        if (typeof fresh[group][k] === 'boolean') fresh[group][k] = v === true;
        else if (Number.isFinite(v)) fresh[group][k] = Math.min(1, Math.max(0, v));
      }
    } catch {}
    return fresh;
  })();
  let saveFxTimer = 0; // debounced: a synchronous localStorage write on every pointer move stalls the main thread
  function saveFx() { clearTimeout(saveFxTimer); saveFxTimer = setTimeout(() => { try { localStorage.setItem(FX_KEY, JSON.stringify(fxState)); } catch {} }, 400); }
  let enhancer = null;
  const vocalFxInstances = [];
  const fxGain = (context) => { const g = context.createGain(); setChannelFormat(g); return g; };
  const fxBiquad = (context, type, freq, q) => {
    const n = context.createBiquadFilter(); n.type = type; n.frequency.value = freq; if (q) n.Q.value = q; setChannelFormat(n); return n;
  };

  function buildEnhancer(context) {
    const input = fxGain(context), output = fxGain(context);
    const warmLow = fxBiquad(context, 'lowshelf', 180), warmHigh = fxBiquad(context, 'highshelf', 7000), air = fxBiquad(context, 'highshelf', 11000);
    const dry = fxGain(context), shaperIn = fxGain(context), shaperOut = fxGain(context), wet = fxGain(context), sum = fxGain(context);
    const shaper = context.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i += 1) curve[i] = Math.tanh(2 * ((i / (curve.length - 1)) * 2 - 1)) / Math.tanh(2);
    shaper.curve = curve; shaper.oversample = '2x';
    input.connect(warmLow); warmLow.connect(warmHigh); warmHigh.connect(air);
    air.connect(dry); dry.connect(sum);
    air.connect(shaperIn); shaperIn.connect(shaper); shaper.connect(shaperOut); shaperOut.connect(wet); wet.connect(sum);
    // Width: mid/side. M = (L+R)/2, S = (L-R)/2 * width; L = M+S, R = M-S.
    const split = context.createChannelSplitter(2), merge = context.createChannelMerger(2);
    const mid = fxGain(context), side = fxGain(context), sideInv = fxGain(context);
    const lm = fxGain(context), rm = fxGain(context), ls = fxGain(context), rs = fxGain(context);
    lm.gain.value = 0.5; rm.gain.value = 0.5; ls.gain.value = 0.5; rs.gain.value = -0.5; sideInv.gain.value = -1;
    sum.connect(split);
    split.connect(lm, 0); split.connect(ls, 0); split.connect(rm, 1); split.connect(rs, 1);
    lm.connect(mid); rm.connect(mid); ls.connect(side); rs.connect(side); side.connect(sideInv);
    mid.connect(merge, 0, 0); side.connect(merge, 0, 0); mid.connect(merge, 0, 1); sideInv.connect(merge, 0, 1);
    merge.connect(output);
    return { context, input, output, warmLow, warmHigh, air, dry, wet, shaperIn, shaperOut, side, sideInv };
  }

  function applyEnhancer() {
    if (!enhancer) return;
    const e = enhancer, s = fxState.enh, on = s.on, t = e.context.currentTime;
    if (!on && e.wasOn === false) return; // off and already neutral: nothing to update
    e.wasOn = on;
    const set = (p, v) => p.setTargetAtTime(v, t, 0.02);
    set(e.warmLow.gain, on ? s.warmth * 4 : 0);
    set(e.warmHigh.gain, on ? -s.warmth * 2.5 : 0);
    set(e.air.gain, on ? s.air * 8 : 0);
    const k = 1 + (on ? s.drive : 0) * 5, w = on ? Math.min(1, s.drive * 2) : 0;
    set(e.shaperIn.gain, k); set(e.shaperOut.gain, 1 / (1 + 0.25 * (k - 1)));
    set(e.wet.gain, w); set(e.dry.gain, 1 - w);
    const width = on ? s.width * 2 : 1;
    set(e.side.gain, width); // sideInv is fed by `side`, so it inherits the width
  }

  function routeEnhancer() {
    if (!masterEq || !enhancer) return;
    const want = fxState.enh.on;
    if (masterEq.enhOn === want) return;
    const { eqOut, master } = masterEq;
    try { eqOut.disconnect(master); } catch {}
    try { eqOut.disconnect(enhancer.input); } catch {}
    try { enhancer.output.disconnect(master); } catch {}
    if (want) { eqOut.connect(enhancer.input); enhancer.output.connect(master); } else eqOut.connect(master);
    masterEq.enhOn = want;
  }

  // Generated reverb impulse response: decaying stereo noise with a darkening tail and a short pre-delay.
  function makeReverbIR(context, seconds) {
    const rate = context.sampleRate, len = Math.max(1, Math.floor(rate * seconds)), pre = Math.floor(rate * 0.015), fadeIn = Math.floor(rate * 0.005);
    const buf = context.createBuffer(2, len + pre, rate);
    for (let c = 0; c < 2; c += 1) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i += 1) {
        const t = i / len;
        lp += ((Math.random() * 2 - 1) - lp) * Math.max(0.08, 0.9 - 0.8 * t);
        d[pre + i] = lp * Math.exp(-6.9 * t) * (i < fadeIn ? i / fadeIn : 1);
      }
    }
    return buf;
  }

  // One vocal effects chain: [LR4 split: highs -> de-esser] -> compressor -> presence/air -> out, plus reverb and delay sends.
  function buildVocalFx(context, destination, source) {
    const input = fxGain(context), sum = fxGain(context), out = fxGain(context);
    const lp = [fxBiquad(context, 'lowpass', 6500, 0.707), fxBiquad(context, 'lowpass', 6500, 0.707)];
    const hp = [fxBiquad(context, 'highpass', 6500, 0.707), fxBiquad(context, 'highpass', 6500, 0.707)];
    const ess = context.createDynamicsCompressor(); setChannelFormat(ess);
    input.connect(lp[0]); lp[0].connect(lp[1]); lp[1].connect(sum);
    input.connect(hp[0]); hp[0].connect(hp[1]); hp[1].connect(ess); ess.connect(sum);
    const comp = context.createDynamicsCompressor(); setChannelFormat(comp);
    const makeup = fxGain(context), pres = fxBiquad(context, 'peaking', 3200, 0.8), airShelf = fxBiquad(context, 'highshelf', 10000);
    sum.connect(comp); comp.connect(makeup); makeup.connect(pres); pres.connect(airShelf); airShelf.connect(out);
    const revSend = fxGain(context), conv = context.createConvolver(), revOut = fxGain(context);
    out.connect(revSend); revSend.connect(conv); conv.connect(revOut);
    const dlySend = fxGain(context), delay = context.createDelay(2), fb = fxGain(context), fbLp = fxBiquad(context, 'lowpass', 3500, 0.707), dlyOut = fxGain(context);
    fb.gain.value = 0.38;
    out.connect(dlySend); dlySend.connect(delay); delay.connect(fbLp); fbLp.connect(fb); fb.connect(delay); delay.connect(dlyOut);
    const fx = { outs: [out, revOut, dlyOut], context, input, source, destination, routed: null, ess, comp, makeup, pres, airShelf, revSend, conv, delay, dlySend, irKey: null, irTimer: 0 };
    vocalFxInstances.push(fx);
    applyVocalFx(fx, true);
    routeVocalFx(fx);
    // Build the reverb impulse response once, shortly after setup, so switching Vocal Lab on mid-song costs nothing (the convolver is not connected while off).
    setTimeout(() => {
      if (fx.irKey != null) return;
      const seconds = Math.round((0.4 + fxState.voc.decay * 3.6) * 10) / 10;
      fx.irKey = seconds; fx.conv.buffer = makeReverbIR(context, seconds);
    }, 3000);
    return fx;
  }

  // Vocal Lab off = the source goes straight to the destination; the chain (convolver, compressors, delay loop) gets no signal at all.
  function routeVocalFx(fx) {
    const want = fxState.voc.on;
    if (fx.routed === want) return;
    try { fx.source.disconnect(fx.input); } catch {}
    try { fx.source.disconnect(fx.destination); } catch {}
    for (const o of fx.outs) { try { o.disconnect(fx.destination); } catch {} }
    if (want) { for (const o of fx.outs) o.connect(fx.destination); fx.source.connect(fx.input); } else fx.source.connect(fx.destination);
    fx.routed = want;
  }

  function applyVocalFx(fx, immediate, deferIR) {
    const s = fxState.voc, on = s.on, t = fx.context.currentTime;
    if (!on && fx.wasOn === false && !immediate) return; // off and already neutral: nothing to update
    fx.wasOn = on;
    const set = (p, v) => (immediate ? (p.value = v) : p.setTargetAtTime(v, t, 0.03));
    const a = on ? s.comp : 0, d = on ? s.deess : 0;
    set(fx.comp.threshold, -8 - a * 22); set(fx.comp.ratio, 1 + a * 5);
    if (immediate) { fx.comp.knee.value = 10; fx.comp.attack.value = 0.008; fx.comp.release.value = 0.15; } // static settings: not re-scheduled on every knob move
    set(fx.makeup.gain, 10 ** (a * 5 / 20));
    set(fx.ess.threshold, -20 - d * 20); set(fx.ess.ratio, 1 + d * 9);
    if (immediate) { fx.ess.knee.value = 0; fx.ess.attack.value = 0.001; fx.ess.release.value = 0.04; }
    set(fx.pres.gain, on ? s.pres * 6 : 0); set(fx.airShelf.gain, on ? s.pres * 3 : 0);
    set(fx.revSend.gain, on ? s.rev * 0.8 : 0);
    set(fx.dlySend.gain, on ? s.dly * 0.6 : 0); set(fx.delay.delayTime, 0.12 + s.time * 0.6);
    const seconds = Math.round((0.4 + s.decay * 3.6) * 10) / 10;
    if (on && !deferIR && fx.irKey !== seconds) { // the impulse response is rebuilt only when not mid-drag (heavy on the main thread)
      fx.irKey = seconds;
      clearTimeout(fx.irTimer);
      const swap = () => { fx.conv.buffer = makeReverbIR(fx.context, seconds); };
      if (immediate) swap(); else fx.irTimer = setTimeout(swap, 50);
    }
  }
  function applyVocalFxAll(deferIR) { for (const fx of vocalFxInstances) { routeVocalFx(fx); applyVocalFx(fx, false, deferIR === true); } }

  // ---- Live microphone (karaoke): mic -> level -> Vocal Lab chain -> master stage (after EQ/Enhancer, before master gain and limiter). ----
  const MIC_KEY = 'ytm-poc-mic-v1';
  const micState = (() => {
    const f = { device: '', level: STEM_FADER_DEFAULT }; // same law as the mixer faders: 0.8 = 0 dB; never starts switched on (feedback safety)
    try {
      const sv = JSON.parse(localStorage.getItem(MIC_KEY) || 'null');
      if (typeof sv?.device === 'string') f.device = sv.device.slice(0, 300);
      if (Number.isFinite(sv?.level)) f.level = Math.min(1, Math.max(0, sv.level));
    } catch {}
    return f;
  })();
  let mic = null;
  let saveMicTimer = 0;
  function saveMic() { clearTimeout(saveMicTimer); saveMicTimer = setTimeout(() => { try { localStorage.setItem(MIC_KEY, JSON.stringify(micState)); } catch {} }, 400); }
  // Mixer strip for the microphone: the fader position IS micState.level (so the Mic LEVEL knob and the fader are one control).
  const micStrip = {
    get pos() { return micState.level; }, set pos(v) { micState.level = v; },
    value: '100', stemFlags: { solo: false, mute: false }, noSolo: true,
    apply() { applyMicLevel(); saveMic(); studio.micKnobRedraw?.(); },
  };
  function micGainOf(v) { return micStrip.stemFlags.mute ? 0 : faderPosToLevel(v); }
  function applyMicLevel() { if (mic) mic.gain.gain.setTargetAtTime(micGainOf(micState.level), mic.context.currentTime, 0.02); }

  async function startMic() {
    if (mic) return true;
    if (!activeContext || activeContext.state === 'closed') activeContext = new AudioContext({ latencyHint: 'interactive' });
    const context = activeContext;
    await context.resume();
    getEqInput(context); // makes sure the master stage exists even when capture was never started
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    if (micState.device) audio.deviceId = { ideal: micState.device };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    const source = context.createMediaStreamSource(stream);
    const gain = fxGain(context);
    gain.gain.value = micGainOf(micState.level);
    const an = context.createAnalyser(); an.fftSize = 1024;
    source.connect(gain); gain.connect(an);
    const fx = buildVocalFx(context, masterEq.master, gain);
    mic = { stream, source, gain, an, fx, context, buf: new Float32Array(1024) };
    stemDiag('mic_on', { state: 'on' });
    return true;
  }

  function stopMic() {
    if (!mic) return;
    const m = mic; mic = null;
    try { m.source.disconnect(); } catch {}
    try { m.gain.disconnect(); } catch {}
    for (const o of m.fx.outs) { try { o.disconnect(); } catch {} }
    clearTimeout(m.fx.irTimer);
    const i = vocalFxInstances.indexOf(m.fx);
    if (i >= 0) vocalFxInstances.splice(i, 1);
    for (const t of m.stream.getTracks()) t.stop();
    stemDiag('mic_off', { state: 'off' });
  }

  // RBJ biquad magnitude (dB) so the curve can be drawn without an audio node.
  function eqBandDb(b, f, fs) {
    const A = 10 ** (b.gain / 40), w0 = 2 * Math.PI * b.freq / fs, cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * b.q), sq = 2 * Math.sqrt(A) * alpha;
    let b0, b1, b2, a0, a1, a2;
    if (b.type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq);
      a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq;
    } else if (b.type === 'highshelf') {
      b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq);
      a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq;
    } else {
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    }
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  // The audible paths stay entirely in Web Audio; the main thread only receives measurement blocks.
  function connectAudioGraph(source, context, media) {
    setChannelFormat(source);
    const dryGain = context.createGain();
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1000;
    lowpass.Q.value = 0.707;
    const userGain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    const wetGain = context.createGain();
    for (const node of [dryGain, lowpass, userGain, limiter, wetGain]) setChannelFormat(node);

    source.connect(dryGain);
    const eqInput = getEqInput(context);
    dryGain.connect(eqInput);
    source.connect(lowpass);
    lowpass.connect(userGain);
    userGain.connect(limiter);
    limiter.connect(wetGain);
    wetGain.connect(eqInput);
    dryGain.gain.value = 1;
    wetGain.gain.value = 0;

    // Stem path: delayed vocal/instrumental chunks are scheduled into these gains (see playStemBlock).
    const vocalGain = context.createGain();
    const instGain = context.createGain();
    const drumsGain = context.createGain(), bassGain = context.createGain(), otherGain = context.createGain();
    const stemBus = context.createGain();
    const stemLimiter = context.createDynamicsCompressor();
    stemLimiter.threshold.value = -6; stemLimiter.ratio.value = 20; stemLimiter.attack.value = 0; stemLimiter.release.value = 0.1; stemLimiter.knee.value = 6;
    for (const node of [vocalGain, instGain, drumsGain, bassGain, otherGain, stemBus, stemLimiter]) setChannelFormat(node);
    for (const node of [instGain, drumsGain, bassGain, otherGain]) node.connect(stemLimiter);
    buildVocalFx(context, stemLimiter, vocalGain); // Vocal Lab sits after the vocal fader, so mute/solo also silence its reverb tail
    stemLimiter.connect(stemBus); stemBus.connect(eqInput);
    stemBus.gain.value = 0;
    stemNodes = { vocalGain, instGain, drumsGain, bassGain, otherGain, stemBus };
    stemNodes.analysers = {};
    for (const key of ["vocalGain", "instGain", "drumsGain", "bassGain", "otherGain"]) {
      const an = context.createAnalyser();
      an.fftSize = 512;
      stemNodes[key].connect(an); // meter tap only, not connected onward
      stemNodes.analysers[key] = an;
    }

    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    setChannelFormat(analyser);
    const processor = context.createScriptProcessor(4096, 2, 2);
    setChannelFormat(processor);
    const meterSink = context.createGain();
    meterSink.gain.value = 0;
    setChannelFormat(meterSink);
    const meterBuffer = new Float32Array(analyser.fftSize);
    const blockDurationMs = 4096 / context.sampleRate * 1000;
    let previousCallbackAt = 0;
    const counters = { dropoutBlocks: 0, timeGaps: 0 };
    let mode = 'bypass';
    let graph_mstp_active = false;
    const onAudioProcess = (event) => {
      const now = performance.now();
      const playing = !media.paused && !media.ended;
      if (playing && previousCallbackAt && now - previousCallbackAt > blockDurationMs * 1.5) counters.timeGaps += 1;
      previousCallbackAt = playing ? now : 0;
      const input = event.inputBuffer;
      const output = event.outputBuffer;
      let nonzero = 0;
      for (let channel = 0; channel < output.numberOfChannels; channel += 1) output.getChannelData(channel).fill(0);
      for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
        const data = input.getChannelData(channel);
        for (let i = 0; i < data.length; i += 1) if (data[i] !== 0) nonzero += 1;
      }
      if (currentPcmTransport?.port && !graph_mstp_active) {
        const frames = input.length;
        const channels = input.numberOfChannels;
        const pcm = new Float32Array(frames * channels);
        for (let channel = 0; channel < channels; channel += 1) {
          const sourceSamples = input.getChannelData(channel);
          for (let frame = 0; frame < frames; frame += 1) pcm[frame * channels + channel] = sourceSamples[frame];
        }
        currentPcmTransport.port.postMessage({
          type: 'pcm:block', sequence: ++nextSequence, sampleRate: context.sampleRate,
          channels, frames, timestampEpochMs: performance.timeOrigin + performance.now(), data: pcm,
        });
      }
      analyser.getFloatTimeDomainData(meterBuffer);
      let sumSquares = 0;
      let measuredNonzero = 0;
      for (const sample of meterBuffer) {
        sumSquares += sample * sample;
        if (sample !== 0) measuredNonzero += 1;
      }
      const rms = Math.sqrt(sumSquares / meterBuffer.length);
      if (playing && nonzero === 0) counters.dropoutBlocks += 1;
      receiveMetrics({ rms, nonzero: measuredNonzero / meterBuffer.length, channels: input.numberOfChannels, ...counters }, context, media);
    };
    return { source, analyser, processor, meterSink, onAudioProcess, setMstpActive: (v) => { graph_mstp_active = v; }, counters, previousCallbackAt: () => { previousCallbackAt = 0; }, dryGain, wetGain, userGain, stemBus, mode, measuring: false };
  }

  function startMeasurement(graph, context, media, transport) {
    if (graph.measuring) return;
    nextSequence = 0;
    currentPcmTransport = transport;
    graph.source.connect(graph.analyser);
    startStreamCapture(graph, context);
    graph.analyser.connect(graph.processor);
    graph.processor.connect(graph.meterSink);
    graph.meterSink.connect(context.destination);
    graph.processor.onaudioprocess = graph.onAudioProcess;
    graph.measuring = true;
  }

  // PCM capture off the main thread's audio callback: ScriptProcessor drops input blocks when the main thread is busy
  // (audible as random clicks). MediaStreamTrackProcessor queues frames instead, so a late main thread only delays them.
  function startStreamCapture(graph, context) {
    if (typeof MediaStreamTrackProcessor !== 'function') { log('pcm_capture_mode', { transport: 'script-processor' }); return; }
    try {
      const dest = context.createMediaStreamDestination();
      dest.channelCount = 2; dest.channelCountMode = 'explicit';
      graph.source.connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      graph.mstp = { dest, track, reader, stopped: false };
      graph.setMstpActive(true);
      log('pcm_capture_mode', { transport: 'media-stream-track-processor' });
      const BLOCK = 4096;
      let left = new Float32Array(BLOCK), right = new Float32Array(BLOCK), fill = 0;
      (async () => {
        while (!graph.mstp.stopped) {
          const { value: audio, done } = await reader.read();
          if (done) break;
          try {
            const n = audio.numberOfFrames;
            const l = new Float32Array(n), r = new Float32Array(n);
            audio.copyTo(l, { planeIndex: 0, format: 'f32-planar' });
            if (audio.numberOfChannels > 1) audio.copyTo(r, { planeIndex: 1, format: 'f32-planar' }); else r.set(l);
            let off = 0;
            while (off < n) {
              const take = Math.min(BLOCK - fill, n - off);
              left.set(l.subarray(off, off + take), fill); right.set(r.subarray(off, off + take), fill);
              fill += take; off += take;
              if (fill === BLOCK) {
                const pcm = new Float32Array(BLOCK * 2);
                for (let i = 0; i < BLOCK; i += 1) { pcm[2 * i] = left[i]; pcm[2 * i + 1] = right[i]; }
                if (currentPcmTransport?.port) {
                  currentPcmTransport.port.postMessage({
                    type: 'pcm:block', sequence: ++nextSequence, sampleRate: context.sampleRate,
                    channels: 2, frames: BLOCK, timestampEpochMs: performance.timeOrigin + performance.now(), data: pcm,
                  });
                }
                fill = 0;
              }
            }
          } finally { audio.close(); }
        }
      })().catch((error) => log('pcm_capture_error', { error: String(error?.message || error).slice(0, 200) }));
    } catch (error) {
      log('pcm_capture_error', { error: String(error?.message || error).slice(0, 200) });
      graph.setMstpActive(false);
    }
  }

  function stopStreamCapture(graph) {
    const m = graph.mstp;
    if (!m) return;
    m.stopped = true;
    try { m.reader.cancel(); } catch {}
    try { m.track.stop(); } catch {}
    try { graph.source.disconnect(m.dest); } catch {}
    graph.mstp = null;
    graph.setMstpActive(false);
  }

  function stopMeasurement(graph) {
    if (!graph.measuring) return;
    stopStreamCapture(graph);
    graph.processor.onaudioprocess = null;
    try { graph.source.disconnect(graph.analyser); } catch {}
    try { graph.analyser.disconnect(); } catch {}
    try { graph.processor.disconnect(); } catch {}
    try { graph.meterSink.disconnect(); } catch {}
    graph.previousCallbackAt();
    graph.measuring = false;
  }

  function waitForWorker(worker, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Worker did not become ready')); }, timeoutMs);
      const onMessage = (event) => {
        if (event.data?.type !== 'pcm:ready') return;
        cleanup(); resolve();
      };
      const onError = (event) => { cleanup(); reject(new Error(event.message || 'Worker load blocked')); };
      function cleanup() { clearTimeout(timer); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); }
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
    });
  }

  async function openPcmTransport() {
    log('stem_transport_started', { state: 'starting', transport: 'utility-process' });
    const channel = new MessageChannel();
    try {
      ipcRenderer.postMessage('poc:pcm-port', { type: 'pcm-port' }, [channel.port1]);
      channel.port2.onmessage = (event) => {
        if (event.data?.type === 'stem:block') playStemBlock(event.data);
      };
      channel.port2.start();
      return { port: channel.port2, transport: 'utility-process' };
    } catch (error) {
      channel.port2.close();
      throw error;
    }
  }

  function closePcmTransport() {
    if (!currentPcmTransport) return;
    const transport = currentPcmTransport;
    try { transport.port.postMessage({ type: 'pcm:stop' }); } catch {}
    setTimeout(() => { try { transport.port.close(); } catch {} }, 1000);
    if (transport.worker) setTimeout(() => transport.worker.terminate(), 50);
    log('pcm_transport_stopped', { state: 'stopped', transport: transport.transport });
    ipcRenderer.send('poc:stem-stop');
    if (stemPlayer?.lagTimer) clearInterval(stemPlayer.lagTimer);
    stemPlayer = null;
    log('stem_transport_stopped', { state: 'stopped', transport: transport.transport });
    currentPcmTransport = null;
  }

  function applyStemLevels() {
    if (!stemNodes || !activeContext) return;
    const now = activeContext.currentTime;
    const ht = modelSelect?.value === 'htdemucs' || modelSelect?.value === 'passthrough';
    const entries = [[vocalSlider, 'vocalGain', true], [instSlider, 'instGain', !ht], [drumsSlider, 'drumsGain', ht], [bassSlider, 'bassGain', ht], [otherSlider, 'otherGain', ht]];
    const anySolo = entries.some(([sl, , visible]) => visible && sl?.stemFlags?.solo);
    for (const [sl, key] of entries) {
      const f = sl?.stemFlags || {};
      const level = Number(sl?.value ?? 100) / 100;
      const audible = !f.mute && (!anySolo || f.solo);
      stemNodes[key].gain.setTargetAtTime(audible ? level * STEM_HEADROOM : 0, now, 0.03);
    }
  }

  // Overlap-add for 2 s windows with 50% overlap (periodic Hann halves sum to 1), then gapless scheduling.
  const STEM_RATE = 44100;
  const STEM_HEADROOM = 0.7; // ~-3 dB so the 4-stem sum stays clear of clipping
  let stemLeadS = 1.0; // user-adjustable jitter buffer (extra delay vs. dropout safety)
  function playStemBlock(msg) {
    const t0 = performance.now();
    try { playStemBlockInner(msg); } finally {
      if (stemPlayer) stemPlayer.handleMaxMs = Math.max(stemPlayer.handleMaxMs || 0, performance.now() - t0);
    }
  }
  function playStemBlockInner(msg) {
    const context = activeContext;
    if (!context || !stemNodes || !msg.vocal?.byteLength) return;
    const frames = msg.frames, hop = frames / 2;
    const layers = [['vocal', 'vocalGain'], ['instrumental', 'instGain'], ['drums', 'drumsGain'], ['bass', 'bassGain'], ['other', 'otherGain']]
      .filter(([name]) => msg[name]?.byteLength);
    const inputs = {};
    for (const [name] of layers) {
      inputs[name] = new Float32Array(msg[name]);
      if (inputs[name].length !== frames * 2) return;
    }
    if (!stemPlayer) {
      stemPlayer = { tails: {}, nextTime: 0, chunks: 0, underruns: 0, lastSource: null, lastStep: null, audioUnderruns: 0, lastOutputMs: null };
      // Diagnostics: local wall clock on every record so heard skips can be matched by time; main-thread stall monitor (25 ms heartbeat).
      let lastBeat = performance.now();
      stemPlayer.lagTimer = setInterval(() => {
        const t = performance.now(), lag = t - lastBeat - 25;
        lastBeat = t;
        if (lag > 50) stemDiag('mainthread_stall', { lagMs: Math.round(lag) });
      }, 25);
      stemDiag('playbackstats', { state: context.playbackStats ? 'available' : 'unavailable' });
      applyStemLevels();
    }
    const p = stemPlayer;
    const outs = {};
    for (const [name] of layers) {
      const input = inputs[name], tail = p.tails[name];
      const out = new Float32Array(hop * 2), newTail = new Float32Array(hop * 2);
      for (let n = 0; n < hop; n += 1) {
        const rise = tail ? 0.5 - 0.5 * Math.cos(Math.PI * n / hop) : 1; // first window: no previous tail, use it unweighted
        const fall = 0.5 + 0.5 * Math.cos(Math.PI * n / hop);
        for (let c = 0; c < 2; c += 1) {
          const i = 2 * n + c;
          out[i] = input[i] * rise + (tail ? tail[i] : 0);
          newTail[i] = input[2 * (hop + n) + c] * fall;
        }
      }
      outs[name] = out; p.tails[name] = newTail;
    }
    let peak = 0, maxJump = 0, maxJumpAt = 0, diffSq = 0;
    const prevLast = p.lastSum || [0, 0];
    const lastSum = [0, 0];
    const prevSum = [prevLast[0], prevLast[1]];
    for (let n = 0; n < hop; n += 1) {
      for (let c = 0; c < 2; c += 1) {
        const i = 2 * n + c;
        let sum = 0;
        for (const [name] of layers) sum += outs[name][i];
        const a = Math.abs(sum);
        if (a > peak) peak = a;
        const d = Math.abs(sum - prevSum[c]);
        if (p.chunks > 0 || n > 0) { diffSq += d * d; if (d > maxJump) { maxJump = d; maxJumpAt = n; } }
        prevSum[c] = sum; lastSum[c] = sum;
      }
    }
    p.lastSum = lastSum;
    const rmsDiff = Math.sqrt(diffSq / (hop * 2)) || 1e-9;
    if (p.chunks > 0 && maxJump > 0.004 && maxJump / rmsDiff > 12) {
      log('stem_jump', { chunks: p.chunks, jump: Number(maxJump.toFixed(4)), jumpRatio: Number((maxJump / rmsDiff).toFixed(1)), pos: maxJumpAt });
    }
    p.peakMax = Math.max(p.peakMax || 0, peak);
    const now = context.currentTime;
    const leadBefore = p.nextTime - now;
    if (p.chunks > 0 && leadBefore >= 0.02 && leadBefore < 0.12) stemDiag('low_lead', { leadMs: Number((leadBefore * 1000).toFixed(1)), chunks: p.chunks, rate: Number((p.rate || 1).toFixed(4)) });
    if (typeof msg.sourceSequence === 'number') { // windows normally advance by a constant number of input blocks; a different step means capture dropped/added input
      if (p.lastSource != null) {
        const step = msg.sourceSequence - p.lastSource;
        if (p.lastStep != null && step !== p.lastStep) stemDiag('seq_step', { step, prevStep: p.lastStep, chunks: p.chunks });
        p.lastStep = step;
      }
      p.lastSource = msg.sourceSequence;
    }
    const ps = context.playbackStats; // Chromium audio-output underrun counters, when this build has them
    if (ps && typeof ps.underrunEvents === 'number' && ps.underrunEvents > p.audioUnderruns) {
      p.audioUnderruns = ps.underrunEvents;
      stemDiag('audio_underrun', { audioUnderruns: ps.underrunEvents, audioUnderrunMs: Math.round((ps.underrunDuration || 0) * 1000), chunks: p.chunks });
    }
    const outMs = (typeof context.outputLatency === 'number' ? context.outputLatency : 0) * 1000;
    if (p.lastOutputMs != null && Math.abs(outMs - p.lastOutputMs) > 5) stemDiag('output_latency', { outputMs: Math.round(outMs), prevOutputMs: Math.round(p.lastOutputMs), chunks: p.chunks });
    p.lastOutputMs = outMs;
    if (p.nextTime < now + 0.02) {
      if (p.chunks > 0) { p.underruns += 1; stemDiag('underrun', { leadMs: Number((leadBefore * 1000).toFixed(1)), chunks: p.chunks, rate: Number((p.rate || 1).toFixed(4)) }); }
      p.nextTime = now + stemLeadS;
    }
    const startAt = Math.round(p.nextTime * (msg.sampleRate || STEM_RATE)) / (msg.sampleRate || STEM_RATE); // whole-sample start: no 1-sample gaps/overlaps between chunks
    const rate = msg.sampleRate || STEM_RATE;
    // Capture clock runs ~0.4-0.7% slower than the playout clock: steer playbackRate from the lead error so the buffer stays level instead of draining into an underrun.
    const leadErrS = (startAt - now) - stemLeadS;
    const pr = 1 + Math.max(-0.015, Math.min(0.015, leadErrS * 0.02));
    p.rate = pr;
    for (const [name, gainKey] of layers) {
      const data = outs[name], target = stemNodes[gainKey];
      const buffer = context.createBuffer(2, hop, rate);
      const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      for (let n = 0; n < hop; n += 1) { left[n] = data[2 * n]; right[n] = data[2 * n + 1]; }
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = pr;
      node.connect(target);
      node.start(startAt);
    }
    p.nextTime = startAt + hop / rate / pr;
    p.chunks += 1;
    if (p.chunks % 5 === 1) {
      const leadMs = (startAt - now) * 1000;
      const outputMs = (typeof context.outputLatency === 'number' ? context.outputLatency : 0) * 1000;
      log('stem_playout', {
        chunks: p.chunks, underruns: p.underruns, peak: Number(p.peakMax.toFixed(3)), handleMs: Number((p.handleMaxMs || 0).toFixed(1)), leadMs: Number(leadMs.toFixed(1)), rate: Number(p.rate.toFixed(4)),
        processingMs: msg.processingMs,
        delayEstimateMs: Math.round(frames / rate * 1000 + 93 + (msg.processingMs || 0) + leadMs + outputMs),
      });
    }
  }

  function stemDiag(kind, fields = {}) {
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    log('stem_diag', { kind, local: p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()), ...fields });
  }

  function setMode(mode, shouldLog = true, onlyGraph = null) {
    const selected = mode === 'processed' || mode === 'stems' ? mode : 'bypass';
    const graphsToUpdate = onlyGraph ? [onlyGraph] : [...document.querySelectorAll('audio, video')].map((media) => graphs.get(media)).filter(Boolean);
    const context = activeContext;
    const now = context?.currentTime || 0;
    const theta = selected === 'processed' ? Math.PI / 2 : 0;
    // 'stems' silences both live paths; the delayed stem chunks are then the only audible signal.
    const dryTarget = selected === 'stems' ? 0 : Math.cos(theta);
    const wetTarget = selected === 'stems' ? 0 : Math.sin(theta);
    const stemTarget = selected === 'stems' ? 1 : 0;
    for (const graph of graphsToUpdate) {
      graph.mode = selected;
      graph.dryGain.gain.setTargetAtTime(dryTarget, now, 0.02);
      graph.wetGain.gain.setTargetAtTime(wetTarget, now, 0.02);
      graph.stemBus.gain.setTargetAtTime(stemTarget, now, 0.05);
    }
    if (modeSelect) modeSelect.value = selected;
    if (shouldLog) log('processing_state', { state: selected });
  }

  function setUserGain(db, onlyGraph = null) {
    const safeDb = Math.max(-24, Math.min(6, Number.isFinite(db) ? db : 0));
    const linear = 10 ** (safeDb / 20);
    const graphsToUpdate = onlyGraph ? [onlyGraph] : [...document.querySelectorAll('audio, video')].map((media) => graphs.get(media)).filter(Boolean);
    for (const graph of graphsToUpdate) graph.userGain.gain.setTargetAtTime(linear, activeContext.currentTime, 0.02);
  }

  function receiveMetrics(metrics, context, media) {
    if (!metrics || typeof metrics.rms !== 'number') return;
    const now = Date.now();
    if (now - lastMetricsAt >= 1000) {
      lastMetricsAt = now;
      ipcRenderer.send('poc:metrics', {
        sampleRate: context.sampleRate, channels: metrics.channels, rms: metrics.rms,
        nonzero: metrics.nonzero, state: 'capturing', dropoutBlocks: metrics.dropoutBlocks, timeGaps: metrics.timeGaps,
      });
    }
    if (!media.paused && !media.ended && metrics.rms === 0) {
      if (lastZeroStart === null) lastZeroStart = now;
      if (now - lastZeroStart >= 5000) {
        log('drm_or_silence', { sampleRate: context.sampleRate, channels: metrics.channels, rms: 0, nonzero: metrics.nonzero, state: 'playing_silent' });
        setMode('bypass', true);
        lastZeroStart = now;
      }
    } else lastZeroStart = null;
  }

  function scanMedia() {
    scanQueued = false;
    if (!activeContext || activeContext.state === 'closed') return;
    const media = findMedia();
    if (media && !wiredElements.has(media)) beginCapture();
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(scanMedia);
  }

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      const current = modeSelect?.value || 'bypass';
      setMode(current === 'bypass' ? 'processed' : 'bypass', true);
    }
  }, true);
  new MutationObserver(() => { installControls(); scheduleScan(); }).observe(document, { childList: true, subtree: true });
  installControls();
  onTrustedCommand((command) => {
    if (command.type === 'capture:show-button') {
      installControls();
      button?.scrollIntoView({ block: 'nearest' });
    }
    if (command.type === 'capture:toggle') toggleCapture();
    if (command.type === 'capture:auto-cycle' && Number.isInteger(command.cycles)) runAutoCycles(Math.max(1, Math.min(command.cycles, 100)));
  });
})();
}
