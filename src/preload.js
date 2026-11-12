'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedLogEvents = new Set([
  'capture_button_ready', 'capture_start_requested', 'capture_started',
  'capture_stop_requested', 'capture_stopped', 'capture_start_cycle',
  'capture_worklet_error', 'capture_fallback', 'media_element_missing',
  'drm_or_silence', 'capture_error', 'processing_state', 'latency_info',
  'pcm_worker_attempt', 'pcm_worker_blocked', 'pcm_transport_started', 'pcm_transport_stopped', 'pcm_metrics', 'pcm_port_received', 'pcm_worker_port_ready',
  'stem_jump', 'stem_buffer_changed', 'pcm_capture_mode', 'pcm_capture_error', 'stem_block_received', 'stem_transport_started', 'stem_transport_stopped', 'stem_playout',
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
    if (!button?.isConnected) {
      button = document.createElement('button');
      button.type = 'button';
      button.textContent = captureActive ? 'Stop capture' : 'Start capture';
      button.setAttribute('aria-label', 'Start or stop audio capture');
      Object.assign(button.style, {
        position: 'fixed', top: '12px', right: '16px', zIndex: '2147483647',
        padding: '9px 12px', border: '0', borderRadius: '6px', background: '#1264a3',
        color: 'white', font: '600 13px sans-serif', boxShadow: '0 2px 8px #0008', cursor: 'pointer',
      });
      button.addEventListener('click', toggleCapture);
      document.documentElement.appendChild(button);
      log('capture_button_ready', { state: 'ready' });
    }
    if (overlay?.isConnected) { installStudioDrawer(); return; }

    overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', top: '54px', right: '16px', zIndex: '2147483647',
      display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px',
      borderRadius: '7px', background: '#161616ee', color: '#fff',
      font: '12px sans-serif', boxShadow: '0 2px 8px #0008',
    });
    const label = document.createElement('label');
    label.textContent = 'Mode';
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
    const gainLabel = document.createElement('label');
    gainLabel.textContent = 'Gain';
    gainSlider = document.createElement('input');
    gainSlider.type = 'range';
    gainSlider.min = '-24';
    gainSlider.max = '6';
    gainSlider.step = '1';
    gainSlider.value = '0';
    gainSlider.setAttribute('aria-label', 'Processed gain in dB');
    gainSlider.style.width = '96px';
    gainSlider.addEventListener('input', () => setUserGain(Number(gainSlider.value)));
    const makeStemSlider = () => makeStemState(); // UI lives in the Studio drawer
    const modelLabel = document.createElement('label');
    modelLabel.textContent = 'Model';
    modelSelect = document.createElement('select');
    modelSelect.setAttribute('aria-label', 'Stem separation model (applies on next capture start)');
    for (const [value, text] of [['umx-hq', 'UMX-HQ (fast, ~3 s)'], ['htdemucs', 'HT-Demucs (best, ~10 s)'], ['passthrough', 'TEST: no separation (~9 s)']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      modelSelect.appendChild(option);
    }
    modelSelect.value = 'umx-hq';
    const bufLabel = document.createElement('label');
    bufLabel.textContent = 'Buffer';
    const bufSlider = document.createElement('input');
    bufSlider.type = 'range'; bufSlider.min = '0.3'; bufSlider.max = '3'; bufSlider.step = '0.1'; bufSlider.value = String(stemLeadS);
    bufSlider.style.width = '80px';
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
    overlay.append(modelLabel, modelSelect, bufLabel, bufSlider, bufValue, label, modeSelect, gainLabel, gainSlider);
    vocalSlider = makeStemSlider('Vocal', 'Vocal stem level percent');
    instSlider = makeStemSlider('Instr.', 'Instrumental stem level percent');
    drumsSlider = makeStemSlider('Drums', 'Drums stem level percent');
    bassSlider = makeStemSlider('Bass', 'Bass stem level percent');
    otherSlider = makeStemSlider('Other', 'Other stem level percent');
    const updateSliderVisibility = () => { studioRebuildStrips(); applyStemLevels(); };
    modelSelect.addEventListener('change', updateSliderVisibility);
    updateSliderVisibility();
    overlay.appendChild(installEqPanel(overlay));
    document.documentElement.appendChild(overlay);
    installStudioDrawer();
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
    return ht
      ? [['VOCALS', vocalSlider, 'vocalGain', ''], ['DRUMS', drumsSlider, 'drumsGain', 'red'], ['BASS', bassSlider, 'bassGain', ''], ['OTHER', otherSlider, 'otherGain', 'red']]
      : [['VOCALS', vocalSlider, 'vocalGain', ''], ['INSTR.', instSlider, 'instGain', 'red']];
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
      soloBtn.addEventListener('click', () => { state.stemFlags.solo = !state.stemFlags.solo; refreshFlags(); applyStemLevels(); });
      muteBtn.addEventListener('click', () => { state.stemFlags.mute = !state.stemFlags.mute; refreshFlags(); applyStemLevels(); });
      refreshFlags();
      const track = el.querySelector('.track'), cap = el.querySelector('.cap');
      const setPos = (pos) => {
        state.pos = Math.min(1, Math.max(0, pos));
        state.value = String(faderPosToLevel(state.pos) * 100);
        cap.style.bottom = (state.pos * 100) + '%';
        track.setAttribute('aria-valuenow', String(Math.round(state.pos * 100)));
        applyStemLevels();
      };
      const fromEvent = (e) => { const r = track.getBoundingClientRect(); setPos(1 - (e.clientY - r.top) / r.height); };
      track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); fromEvent(e); });
      track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) fromEvent(e); });
      track.addEventListener('dblclick', () => setPos(STEM_FADER_DEFAULT)); // reset to 0 dB
      cap.style.bottom = (state.pos * 100) + '%';
      studio.strips.push({ leds: [...el.querySelectorAll('.led-meter i')], nodeKey, held: -100 });
    }
  }

  function studioTick() {
    studio.raf = studio.open ? requestAnimationFrame(studioTick) : 0;
    const an = stemNodes?.analysers;
    if (!studio.buf) studio.buf = new Float32Array(512);
    for (const s of studio.strips) {
      let peak = 0;
      const node = an?.[s.nodeKey];
      if (node) {
        node.getFloatTimeDomainData(studio.buf);
        for (let i = 0; i < studio.buf.length; i += 1) { const a = Math.abs(studio.buf[i]); if (a > peak) peak = a; }
      }
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      s.held = Math.max(db, s.held - 1.2); // fast attack, gentle fall
      for (let j = 0; j < s.leds.length; j += 1) s.leds[j].classList.toggle('on', s.held > -42 + j * 2.8);
    }
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
      const section = h('section', 'section');
      for (const pos of ['tl', 'tr', 'bl', 'br']) section.appendChild(h('i', 'screw ' + pos));
      section.append(h('h3', 'title', 'Stems'), h('div', 'channels'));
      const status = h('div', 'status');
      status.append(h('span'), h('span'), h('span'));
      consoleEl.append(section, status);
      drawer.append(h('div', 'wood'), consoleEl, h('div', 'wood'));
      ui.append(drawer, h('button', 'tab', 'STUDIO \u25B2', { type: 'button', 'aria-label': 'Toggle studio drawer' }));
      root.append(style, ui);
      studio.host = host; studio.root = root;
      studio.statusEls = [...root.querySelectorAll('.status span')];
      root.querySelector('.tab').addEventListener('click', () => studioSetOpen(!studio.open));
      studioRebuildStrips();
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
        if (button) button.textContent = 'Stop capture';
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
    if (button) button.textContent = 'Start capture';
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
    const fresh = { enabled: true, limiter: false, bands: EQ_DEFAULT_BANDS.map((b) => ({ ...b })) };
    try {
      const saved = JSON.parse(localStorage.getItem(EQ_STORE_KEY) || 'null');
      if (saved && Array.isArray(saved.bands) && saved.bands.length === fresh.bands.length) {
        fresh.enabled = saved.enabled !== false;
        fresh.limiter = saved.limiter === true; // opt-in only, never automatic
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

  function routeLimiter() {
    if (!masterEq || masterEq.limiterOn === eqState.limiter) return;
    const { eqOut, limiter, context } = masterEq;
    try { eqOut.disconnect(context.destination); } catch {}
    try { eqOut.disconnect(limiter); } catch {}
    try { limiter.disconnect(); } catch {}
    if (eqState.limiter) { eqOut.connect(limiter); limiter.connect(context.destination); }
    else eqOut.connect(context.destination);
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
    // Optional output limiter (user-controlled). Off = filters go straight to destination (clean bypass).
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.1;
    setChannelFormat(limiter);
    const eqOut = prev;
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.8;
    prev.connect(analyser); // tap only: drives the EQ panel spectrum
    masterEq = { context, input, filters, analyser, limiter, eqOut, limiterOn: null };
    routeLimiter();
    for (const [i, b] of eqState.bands.entries()) {
      filters[i].frequency.value = b.freq; filters[i].Q.value = b.q; filters[i].gain.value = eqState.enabled ? b.gain : 0;
    }
    return input;
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

  function installEqPanel(anchor) {
    const W = 560, H = 240, PAD_L = 34, PAD_B = 18, DB = 18, FMIN = 20, FMAX = 20000;
    const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'];
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.textContent = 'EQ'; toggle.setAttribute('aria-label', 'Toggle equalizer panel');
    toggle.style.cssText = 'padding:0 6px;font:inherit;cursor:pointer';
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed', right: '16px', zIndex: '2147483647', display: 'none', padding: '8px 10px',
      borderRadius: '7px', background: '#161616f2', color: '#fff', font: '12px sans-serif', boxShadow: '0 2px 8px #0008',
    });
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:6px';
    const enable = document.createElement('input');
    enable.type = 'checkbox'; enable.checked = eqState.enabled; enable.setAttribute('aria-label', 'Equalizer enabled');
    const enableLabel = document.createElement('label'); enableLabel.append(enable, ' EQ on');
    const reset = document.createElement('button');
    reset.type = 'button'; reset.textContent = 'Reset'; reset.style.cssText = 'font:inherit;cursor:pointer';
    const hint = document.createElement('span');
    hint.style.cssText = 'opacity:.65';
    hint.textContent = 'Drag a point: left/right = frequency, up/down = gain. Scroll on a point = Q. Double-click = 0 dB.';
    const limiterBox = document.createElement('input');
    limiterBox.type = 'checkbox'; limiterBox.checked = eqState.limiter; limiterBox.setAttribute('aria-label', 'Output limiter enabled');
    const limiterLabel = document.createElement('label'); limiterLabel.append(limiterBox, ' Limiter on');
    limiterLabel.title = 'Peak limiter after the EQ (about -2 dB ceiling). Off = no processing.';
    limiterBox.addEventListener('change', () => { eqState.limiter = limiterBox.checked; routeLimiter(); saveEqState(); });
    head.append(enableLabel, limiterLabel, reset, hint);
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.cssText = `width:${W}px;height:${H}px;display:block;touch-action:none;cursor:crosshair;border-radius:4px;background:#0c0c0c`;
    canvas.setAttribute('aria-label', 'Equalizer curve: drag points to adjust bands');
    const info = document.createElement('div');
    info.style.cssText = 'margin-top:6px;display:flex;gap:8px;align-items:center;min-height:20px';
    const infoText = document.createElement('span');
    const qLabel = document.createElement('label'); qLabel.textContent = 'Q ';
    const qSlider = document.createElement('input');
    qSlider.type = 'range'; qSlider.min = '0.1'; qSlider.max = '10'; qSlider.step = '0.05'; qSlider.style.width = '120px';
    qSlider.setAttribute('aria-label', 'Selected band Q');
    qLabel.appendChild(qSlider);
    info.append(infoText, qLabel);
    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
    const presetSelect = document.createElement('select');
    presetSelect.setAttribute('aria-label', 'Equalizer preset');
    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.maxLength = 40; nameInput.placeholder = 'Preset name'; nameInput.style.width = '110px';
    nameInput.setAttribute('aria-label', 'Name for saving the current equalizer as a preset');
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.textContent = 'Save'; saveBtn.style.cssText = 'font:inherit;cursor:pointer';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.textContent = 'Delete'; delBtn.style.cssText = 'font:inherit;cursor:pointer';
    for (const type of ['keydown', 'keyup', 'keypress']) nameInput.addEventListener(type, (e) => e.stopPropagation()); // typing a name must not trigger YouTube Music hotkeys
    presetRow.append('Preset ', presetSelect, nameInput, saveBtn, delBtn);
    panel.append(head, presetRow, canvas, info);

    const ctx = canvas.getContext('2d');
    const plotW = W - PAD_L - 6, plotH = H - PAD_B - 6;
    const xOf = (f) => PAD_L + plotW * Math.log(f / FMIN) / Math.log(FMAX / FMIN);
    const fOf = (x) => FMIN * (FMAX / FMIN) ** ((x - PAD_L) / plotW);
    const yOf = (db) => 6 + plotH * (0.5 - db / (2 * DB));
    const dbOf = (y) => (0.5 - (y - 6) / plotH) * 2 * DB;
    const fmtFreq = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz');
    let selected = 2, dragging = -1, raf = 0, spectrum = null;

    const updateInfo = () => {
      const b = eqState.bands[selected];
      infoText.textContent = `Band ${selected + 1} (${b.type === 'peaking' ? 'bell' : b.type === 'lowshelf' ? 'low shelf' : 'high shelf'}): ${fmtFreq(b.freq)}, ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB`;
      qSlider.value = String(b.q);
    };
    const bandAt = (x, y) => {
      let best = -1, bestD = 14;
      eqState.bands.forEach((b, i) => { const d = Math.hypot(xOf(b.freq) - x, yOf(b.gain) - y); if (d < bestD) { bestD = d; best = i; } });
      return best;
    };
    const draw = () => {
      raf = panel.style.display === 'none' ? 0 : requestAnimationFrame(draw);
      const fs = masterEq?.context.sampleRate || 44100;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
      // grid
      ctx.lineWidth = 1;
      for (const db of [-12, -6, 0, 6, 12]) {
        ctx.strokeStyle = db === 0 ? '#555' : '#2a2a2a'; ctx.beginPath(); ctx.moveTo(PAD_L, yOf(db)); ctx.lineTo(W - 6, yOf(db)); ctx.stroke();
        ctx.fillStyle = '#888'; ctx.textAlign = 'right'; ctx.fillText((db > 0 ? '+' : '') + db, PAD_L - 5, yOf(db));
      }
      ctx.textAlign = 'center';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        ctx.strokeStyle = '#2a2a2a'; ctx.beginPath(); ctx.moveTo(xOf(f), 6); ctx.lineTo(xOf(f), 6 + plotH); ctx.stroke();
        ctx.fillStyle = '#888'; ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), xOf(f), H - PAD_B / 2 + 2);
      }
      // live spectrum (post-EQ, so it shows what you hear)
      if (masterEq?.analyser) {
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
        ctx.fillStyle = '#3b82f655'; ctx.fill();
      }
      // combined response curve
      ctx.beginPath();
      for (let x = PAD_L; x <= W - 6; x += 2) {
        const f = fOf(x);
        let db = 0;
        if (eqState.enabled) for (const b of eqState.bands) db += eqBandDb(b, f, fs);
        db = Math.max(-DB, Math.min(DB, db));
        if (x === PAD_L) ctx.moveTo(x, yOf(db)); else ctx.lineTo(x, yOf(db));
      }
      ctx.strokeStyle = eqState.enabled ? '#fff' : '#666'; ctx.lineWidth = 2; ctx.stroke();
      // band handles
      eqState.bands.forEach((b, i) => {
        const x = xOf(b.freq), y = yOf(b.gain);
        ctx.beginPath(); ctx.arc(x, y, i === selected ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = COLORS[i % COLORS.length]; ctx.globalAlpha = eqState.enabled ? 1 : 0.4; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 2; ctx.strokeStyle = i === selected ? '#fff' : '#000'; ctx.stroke();
        ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, y + 0.5);
      });
    };

    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    let userPresets = loadUserPresets();
    const refreshPresetList = (selectValue) => {
      presetSelect.textContent = '';
      const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; presetSelect.appendChild(o); };
      add('', 'Custom');
      for (const name of Object.keys(EQ_BUILTIN_PRESETS)) add('b:' + name, name);
      for (const name of Object.keys(userPresets)) add('u:' + name, '★ ' + name);
      presetSelect.value = selectValue ?? '';
      if (presetSelect.value !== (selectValue ?? '')) presetSelect.value = '';
      delBtn.disabled = !presetSelect.value.startsWith('u:');
      delBtn.style.opacity = delBtn.disabled ? '0.4' : '1';
    };
    const commit = () => { applyEq(); saveEqState(); updateInfo(); };
    const manualCommit = () => { commit(); refreshPresetList(''); }; // any hand edit leaves the preset: back to "Custom"
    refreshPresetList('');
    presetSelect.addEventListener('change', () => {
      const v = presetSelect.value;
      if (v.startsWith('b:')) {
        const gains = EQ_BUILTIN_PRESETS[v.slice(2)];
        eqState.bands.forEach((b, i) => Object.assign(b, EQ_DEFAULT_BANDS[i], { gain: gains[i] }));
      } else if (v.startsWith('u:') && userPresets[v.slice(2)]) {
        userPresets[v.slice(2)].forEach((p, i) => Object.assign(eqState.bands[i], p));
      } else { refreshPresetList(''); return; }
      commit(); refreshPresetList(v);
    });
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
    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e), i = bandAt(x, y);
      if (i < 0) return;
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
    enable.addEventListener('change', () => { eqState.enabled = enable.checked; applyEq(); saveEqState(); });
    reset.addEventListener('click', () => {
      eqState.bands.forEach((b, i) => Object.assign(b, EQ_DEFAULT_BANDS[i]));
      commit(); refreshPresetList('b:Flat');
    });
    toggle.addEventListener('click', () => {
      const open = panel.style.display === 'none';
      if (open) {
        panel.style.top = Math.round(anchor.getBoundingClientRect().bottom + 6) + 'px';
        panel.style.display = 'block'; updateInfo();
        if (!raf) raf = requestAnimationFrame(draw);
      } else panel.style.display = 'none';
    });
    document.documentElement.appendChild(panel);
    return toggle;
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
    for (const node of [vocalGain, instGain, drumsGain, bassGain, otherGain]) node.connect(stemLimiter);
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
      stemPlayer = { tails: {}, nextTime: 0, chunks: 0, underruns: 0 };
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
    if (p.nextTime < now + 0.02) {
      if (p.chunks > 0) p.underruns += 1;
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
