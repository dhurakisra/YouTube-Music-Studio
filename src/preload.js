'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

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

function isAutotunePage() {
  try { return new URL(location.href).protocol === 'file:' && new URL(location.href).pathname.endsWith('/autotune.html'); } catch { return false; }
}

if (isAutotunePage()) {
  // Hidden auto-tune window: a tiny message bridge to the main process (signalling only).
  contextBridge.exposeInMainWorld('autotuneIpc', Object.freeze({
    send(msg) { ipcRenderer.send('poc:at-from-lab', msg); },
    onMessage(callback) { if (typeof callback === 'function') ipcRenderer.on('poc:at-msg', (_event, msg) => callback(msg)); },
  }));
} else if (isPcmBridgePage()) {
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
  // Studio is "on" while capture runs OR while the Studio drawer is open: its EQ, Enhancer, Key & Tempo and Output then own the sound
  // and the top graphic EQ is locked flat. The mixer is live only with capture (stems) or a loaded layered recording.
  let studioOpen = false;
  // EQ ownership follows the drawer only: open = Studio's parametric EQ, closed = the top graphic EQ. Everything else Studio does
  // (Enhancer, KEY, Output) stays on once Studio has been opened, so browsing with the drawer down keeps the sound.
  let studioEngaged = false;
  const studioActive = () => studioOpen;
  const studioSound = () => captureActive || studioEngaged;
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
  // ONE captureStream per media element for every passive tap (VU meters, spectrum, chords): each captureStream() call hands out fresh
  // tracks and the earlier stream goes silent, so the chord tap used to kill the VU tap.
  const mediaStreams = new WeakMap();
  function mediaStreamFor(m) { let st = mediaStreams.get(m); if (!st) { st = m.captureStream(); mediaStreams.set(m, st); } return st; }
  // A stream grabbed too early (cold start: page still wiring its audio) can stay dead for good; the VU loop calls this after ~2 s of
  // digital silence while the song plays audibly, and every tap rebuilds on the fresh stream (taps compare stream identity).
  function mediaStreamReset(m) { mediaStreams.delete(m); }
  function liveTrack(st) { const ts = st.getAudioTracks(); return ts.find((t) => t.readyState === 'live') || ts[0]; }

  // Song clock. YTM can keep the same media element (and its buffer) across consecutive songs, so element.currentTime / .duration then
  // run on from the previous song (a 3:00 song followed by a 5:00 one reports 8:00). The page's own player API knows the real position and
  // length: it is polled from the main world, and the element time is corrected by the measured offset between the two.
  const ytmClock = { dur: 0, delta: 0 };
  setInterval(() => {
    try {
      webFrame.executeJavaScript('(function(){var p=document.getElementById("movie_player");return p&&p.getDuration?[p.getCurrentTime(),p.getDuration()]:null})()').then((r) => {
        const m = findMedia();
        if (Array.isArray(r) && r[1] > 0 && m) { ytmClock.dur = r[1]; ytmClock.delta = m.currentTime - r[0]; } else ytmClock.dur = 0;
      }).catch(() => { ytmClock.dur = 0; });
    } catch { ytmClock.dur = 0; }
  }, 400);
  function songDur(m) { return ytmClock.dur > 0 ? ytmClock.dur : (m && Number.isFinite(m.duration) ? m.duration : 0); }
  function songPos(m) { return m ? Math.max(0, m.currentTime - (ytmClock.dur > 0 ? ytmClock.delta : 0)) : 0; }
  function songSeek(t) {
    const m = findMedia();
    if (ytmClock.dur > 0) {
      try { webFrame.executeJavaScript('(function(){var p=document.getElementById("movie_player");if(p&&p.seekTo)p.seekTo(' + Number(t) + ',true)})()'); return; } catch {}
    }
    if (m) { try { m.currentTime = t; } catch {} }
  }

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
    for (const [value, text] of [['umx-hq', 'UMX-HQ (fast, ~3 s)'], ['htdemucs', 'HT-Demucs (best, ~10 s)']]) {
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
    const listenBtn = h('button', 'btn bigbtn solo', 'LISTEN', { type: 'button', 'aria-label': 'Listen mode' });
    listenBtn.classList.add('st-listen');
    listenBtn.title = 'Plain listening: YouTube Music as usual. Optionally listen with stem separation.';
    const karaokeBtn = h('button', 'btn bigbtn solo recbig', 'KARAOKE', { type: 'button', 'aria-label': 'Karaoke mode' });
    karaokeBtn.classList.add('st-karaoke');
    karaokeBtn.title = 'Sing over a song. Nothing starts until you press START KARAOKE.';
    const info = h('div', 'eqinfo sessinfo', '');
    const adv = h('div', 'adv');
    adv.append(row('MODEL', modelSelect), row('MODE', modeSelect), row('GAIN', gainSlider), row('BUFFER', sessionEls.bufSlider, sessionEls.bufValue), row('', button));
    const advToggle = h('button', 'advtoggle', 'ADVANCED \u25BE', { type: 'button' });
    advToggle.addEventListener('click', () => { const o = adv.classList.toggle('open'); advToggle.classList.toggle('on', o); advToggle.textContent = o ? 'ADVANCED \u25B4' : 'ADVANCED \u25BE'; });
    const stemBtn = h('button', 'btn bigbtn solo stemb', 'LISTEN WITH STEMS', { type: 'button', 'aria-label': 'Listen with system separation' });
    stemBtn.classList.add('st-stems');
    stemBtn.title = 'Splits the song into vocals, drums, bass and other so you can mix them live (Mixer), change the key and more. It needs about 10 seconds of buffering before you hear anything. Leave it off to listen to YouTube Music as usual, in real time.';
    const startBtn = h('button', 'btn bigbtn solo recbig startk', 'START KARAOKE', { type: 'button', 'aria-label': 'Start karaoke and recording' });
    startBtn.title = 'Starts the song from the beginning, opens the microphone and the vocal chain, and records. It needs about 10 seconds of buffering first. Press again to finish and save.';
    let busy = false;
    // Interlocked push buttons: the active one stays down and does nothing when pressed again; the other one releases it.
    // Neither mode starts any sound by itself: LISTEN = normal YouTube Music (stems are optional), KARAOKE = armed, waiting for START KARAOKE.
    const enter = async (target) => {
      if (busy || rec.saving || takePrep) return;
      const fromMixer = !!libPlayer.mix;
      if (appMode === target && !fromMixer && !(target === 'listen' && captureActive)) return; // LISTEN also leaves Listen with stems
      busy = true;
      try {
        if (rec.active) await stopTake(info);
        if (libPlayer.mix) { libPause(); libDropMix(); } // leave the recording mixer
        if (karaoke) karaokeOff();
        if (captureActive) stopCapture(); // back to plain YouTube Music playback
        if (fxState.voc.on) { fxState.voc.on = false; saveFx(); applyVocalFxAll(); studio.syncVocalLab?.(); } // the chain only belongs to karaoke
        if (target === 'listen') { setAppMode('listen'); info.textContent = ''; }
        else {
          const m = findMedia(); if (m && !m.paused) { try { m.pause(); } catch {} } // nothing plays until START KARAOKE
          setAppMode('karaoke'); info.textContent = 'READY - START KARAOKE';
        }
      } catch (error) { info.textContent = 'ERROR: ' + String(error?.message || error).slice(0, 60); stemDiag('ui_error', { error: String(error?.stack || error).slice(0, 400) }); } finally { busy = false; }
    };
    let stemPrep = false;
    stemBtn.addEventListener('click', async () => {
      if (stemPrep || busy) return;
      if (appMode !== 'listen' || libPlayer.mix) { await enter('listen'); if (appMode !== 'listen' || libPlayer.mix) return; } // from karaoke / the recording mixer: switch over first
      else if (captureActive) { stopCapture(); info.textContent = ''; return; } // pressing again returns to normal listening
      stemPrep = true;
      try {
        ensureHt(); startMusic();
        info.textContent = 'BUFFERING, PLEASE WAIT...';
        if (!(await beginCapture())) { info.textContent = 'NO MUSIC PLAYING - OPEN A SONG FIRST'; return; }
        setMode('stems', true);
        const t0 = Date.now();
        for (;;) { // you hear the song again after the stem delay: count it down
          const total = Math.max(3000, Math.round(stemPlayer?.delayEstimateMs || 10000));
          const left = Math.ceil((t0 + total - Date.now()) / 1000);
          if (!captureActive || appMode !== 'listen') break;
          if (left <= 0) { if (stemPlayer || Date.now() - t0 > 60000) break; info.textContent = 'BUFFERING, PLEASE WAIT...'; } else info.textContent = 'BUFFERING, PLEASE WAIT ' + left;
          await sleepMs(200);
        }
        if (captureActive) info.textContent = '';
      } catch (error) { info.textContent = 'ERROR: ' + String(error?.message || error).slice(0, 60); stemDiag('ui_error', { error: String(error?.stack || error).slice(0, 400) }); } finally { stemPrep = false; }
    });
    startBtn.addEventListener('click', async () => { if (busy) return; if (appMode !== 'karaoke' || libPlayer.mix) { await enter('karaoke'); if (appMode !== 'karaoke') return; } takeToggle(info).catch((error) => { info.textContent = 'ERROR: ' + String(error?.message || error).slice(0, 60); stemDiag('ui_error', { error: String(error?.stack || error).slice(0, 400) }); }); });
    listenBtn.addEventListener('click', () => enter('listen'));
    karaokeBtn.addEventListener('click', () => enter('karaoke'));
    setInterval(() => {
      const inMix = !!libPlayer.mix;
      const l = appMode === 'listen' && !inMix, k = appMode === 'karaoke' && !inMix;
      const plain = l && !captureActive; listenBtn.classList.toggle('on', plain); listenBtn.setAttribute('aria-pressed', String(plain)); // LISTEN and LISTEN WITH STEMS light up one at a time
      karaokeBtn.classList.toggle('on', k); karaokeBtn.setAttribute('aria-pressed', String(k));
      const stemsOn = l && captureActive; stemBtn.classList.toggle('on', stemsOn); stemBtn.setAttribute('aria-pressed', String(stemsOn));
      const running = rec.active || takePrep;
      startBtn.classList.toggle('on', running); startBtn.setAttribute('aria-pressed', String(running));
      startBtn.textContent = rec.active ? 'STOP & SAVE' : rec.saving ? 'SAVING...' : takePrep ? 'BUFFERING...' : 'START KARAOKE';
    }, 300);
    sec.append(listenBtn, stemBtn, karaokeBtn, startBtn, info, advToggle, adv);
    // Centred notice (top middle of the window) so the wait is impossible to miss; it follows the status text and disappears when buffering is over.
    const toast = h('div', 'toastc');
    const toastTitle = h('div', 'toasttitle'), toastSub = h('div', 'toastsub');
    toast.append(toastTitle, toastSub);
    studio.root.querySelector('.ui')?.appendChild(toast);
    studio.infoEls = [info];
    setInterval(() => {
      const t = studio.infoEls.map((e) => e.textContent).find((x) => /^(BUFFERING|STARTING|PREPARING|SAVING)/.test(x));
      if (!t) { toast.classList.remove('show'); return; }
      toastTitle.textContent = t;
      toastSub.textContent = /^SAVING/.test(t) ? 'Encoding your recording' : 'Separating the song takes about 10 seconds. Nothing is wrong, the music starts right after.';
      toast.classList.add('show');
    }, 200);
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
    if (libPlayer.mix) return libPlayer.mix.keys.map((k, i) => [LIB_LAYER_NAMES[k], libPlayer.mix.states[k], k, i % 2 ? 'red' : '']); // library recording with layers: its own channels
    layout.push(['KARAOKE', micStrip, 'mic', 'red']); // the live microphone; its fader is the same control as the Mic LEVEL knob
    return layout;
  }

  function studioRebuildStrips() {
    if (!studio.root) return;
    const wrap = studio.root.querySelector('.channels');
    wrap.textContent = '';
    studio.strips = [];
    studio.syncExport?.(); studio.syncOffset?.();
    studio.consoleEl?.classList.toggle('mixview', !!libPlayer.mix); // MIX view while a layered recording is loaded
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
      if (nodeKey === 'mic' && !libPlayer.mix) { // practice: sing over the stems with the vocal chain, no recording
        // practice switch (brass toggle): MIC title above, state on the left (green ON = lever up, red OFF = lever down); mic + vocal chain, never recorded
        const fxb = h('button', 'micsw', null, { type: 'button', 'aria-label': 'Activate mic: practice with the vocal chain (not recorded)' });
        fxb.append(h('span', 'micsw-mic', 'MIC'), h('span', 'micsw-on', 'ON'), h('span', 'micsw-off', 'OFF'), h('i', 'micsw-lever'));
        fxb.title = 'Activate mic: sing over the song through the vocal chain while listening. Nothing is recorded.';
        const sync = () => { fxb.classList.toggle('on', !!practice.on); fxb.setAttribute('aria-pressed', String(!!practice.on)); };
        fxb.addEventListener('click', () => { practiceToggle().then(sync, sync); });
        practice.sync = sync; sync(); el.appendChild(fxb);
      }
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
      if (state.noSolo) soloBtn.disabled = true; // Keep MIC SOLO visible, but block self-monitoring feedback.
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
      const node = libPlayer.mix?.ans[s.nodeKey] || (s.nodeKey === 'mic' ? mic?.an : an?.[s.nodeKey]);
      if (node) {
        node.getFloatTimeDomainData(studio.buf);
        for (let i = 0; i < studio.buf.length; i += 1) { const a = Math.abs(studio.buf[i]); if (a > peak) peak = a; }
      }
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      s.held = Math.max(db, s.held - 1.2); // fast attack, gentle fall
      for (let j = 0; j < s.leds.length; j += 1) s.leds[j].classList.toggle('on', s.held > -42 + j * 2.8);
    }
    const gfx = libPlayer.mix?.fx || mic?.fx;
    if (studio.gr && gfx) { // gain-reduction bars of the de-esser and compressor
      studio.gr.comp.style.width = Math.min(100, -gfx.comp.reduction * 5) + '%';
      studio.gr.ess.style.width = Math.min(100, -gfx.ess.reduction * 5) + '%';
      if (studio.gr.gate) studio.gr.gate.style.width = (gfx.gateRouted ? Math.round((1 - gfx.gate.gain) * 100) : 0) + '%';
    }
    studio.eqDraw?.();
    studio.vuDraw?.();
    studio.micTick?.();
    const now = performance.now();
    if (now - studio.lastStatus > 250) {
      studio.lastStatus = now;
      const names = { 'umx-hq': 'UMX-HQ', htdemucs: 'HT-DEMUCS' };
      const [m, b, u] = studio.statusEls;
      m.textContent = 'SEPARATION MODEL: ' + (names[modelSelect?.value] || '-');
      if (captureActive && stemPlayer && activeContext) {
        b.textContent = 'BUF ' + Math.max(0, stemPlayer.nextTime - activeContext.currentTime).toFixed(1) + 's / ' + stemLeadS.toFixed(1) + 's';
        u.textContent = 'UNDERRUNS ' + stemPlayer.underruns;
      } else { b.textContent = captureActive ? 'WAITING...' : 'CAPTURE OFF'; u.textContent = 'UNDERRUNS -'; }
    }
    const took = performance.now() - t0; // diagnostic: a slow UI frame competes with chunk scheduling
    if (took > 20 && t0 - (studio.lastSlowLog || 0) > 1000) { studio.lastSlowLog = t0; stemDiag('ui_slow', { lagMs: Math.round(took) }); }
  }

  function studioSetOpen(open) {
    studio.open = open;
    studioOpen = !!open; if (open) studioEngaged = true; captureModeChanged(); if (open) { geqGesture = true; ensurePassiveGraph(); } // opening Studio = Studio sound on (stays on)
    try { document.documentElement.classList.toggle('ytmpoc-open', open); } catch {}
    studio.root.querySelector('.drawer').classList.toggle('open', open);
    const tab = studio.root.querySelector('.tab');
    tab.classList.toggle('open', open);
    tab.textContent = open ? 'STUDIO ▼' : 'STUDIO ▲';
    if (studio.npEl) {
      studio.npEl.classList.toggle('float', !open); studio.npEl.classList.toggle('st-lift', open);
      (studio.root.querySelector('.ui') || studio.uiEl || studio.root).appendChild(studio.npEl);
    }
    studio.root.querySelector('.tab').classList.toggle('np-up', !open);
    studio.lyrEl?.classList.toggle('lift', open); studio.libEl?.classList.toggle('lift', open); // side panels end where the drawer begins
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
    const modeBtns = [['PARAMETRIC', 'param'], ['GRAPHIC EQ', 'graphic']].map(([text, mode]) => h('button', 'btn', text, { type: 'button', 'data-mode': mode }));
    const row1 = h('div', 'switches fill');
    row1.append(eqOn, ...modeBtns);
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
    const geqHost = h('div', 'eq-geq'), geqPreHost = h('div', 'eq-geqpre');
    studio.eqGeqHost = geqHost; studio.eqGeqPreHost = geqPreHost;
    studio.geqMount?.();
    sec.append(canvas, geqHost, row1, row2, geqPreHost, info, h('i', 'eq-tube l'), h('i', 'eq-tube r'));
    ctrlReset(qSlider, () => EQ_DEFAULT_BANDS[selected].q);

    let selected = 2, dragging = -1, spectrum = null;
    const userPresets = loadUserPresets();
    const isGeq = () => eqState.mode === 'graphic';
    const syncOn = () => {
      const on = isGeq() ? geqState.on : eqState.enabled;
      eqOn.classList.toggle('on', on); eqOn.setAttribute('aria-pressed', String(on));
      sec.classList.toggle('mode-graphic', isGeq()); sec.classList.toggle('eq-off', !on);
      for (const b of modeBtns) { const a = on && b.getAttribute('data-mode') === eqState.mode; b.classList.toggle('on', a); b.setAttribute('aria-pressed', String(a)); }
    };
    studio.eqModeSync = syncOn;
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
    for (const b of modeBtns) b.addEventListener('click', () => {
      eqState.mode = b.getAttribute('data-mode');
      if (isGeq()) geqState.on = true; else eqState.enabled = true; // choosing a mode switches it on
      syncOn(); applyEq(); applyGeq(); saveEqState(); saveGeq(); ensurePassiveGraph(); studio.geqSync?.();
    });
    presetSelect.addEventListener('change', () => applyPreset(presetSelect.value));
    eqOn.addEventListener('click', () => { if (isGeq()) { geqState.on = !geqState.on; saveGeq(); } else { eqState.enabled = !eqState.enabled; saveEqState(); } syncOn(); applyEq(); applyGeq(); studio.geqSync?.(); ensurePassiveGraph(); });
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
      studioKnob('THRESH', 'dark', () => eqState.thresh, (v) => { eqState.thresh = v; applyOutput(); saveEqState(); }, 5 / 6));
    const lim = h('button', 'btn solo limiter', null, { type: 'button', 'aria-label': 'Output limiter enabled' });
    const led = h('span', 'led');
    lim.append(led, document.createTextNode('LIMITER'));
    lim.title = 'Peak limiter after the EQ and master gain. Off = no processing.';
    const syncLim = () => { lim.classList.toggle('on', eqState.limiter); led.classList.toggle('on', eqState.limiter); lim.setAttribute('aria-pressed', String(eqState.limiter)); knobs.classList.toggle('lim-off', !eqState.limiter); };
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
    const angleOf = (db) => Math.max(-44, Math.min(44, db <= -18 ? 25.5 + (db + 18) * 3.48 : 25.5 + (db + 18) * 2.1)) // dial: ends +-44 deg, 0 VU (red zone) at +25.5;
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
  // Per-module presets and whole-chain presets.
  const MOD_PRESETS = {
    gate: { 'Off': { gOn: false }, 'Light': { gOn: true, gate: 0.2 }, 'Medium': { gOn: true, gate: 0.4 }, 'Tight': { gOn: true, gate: 0.65 } },
    eq: { 'Flat': { low: 0.5, mud: 0.5 }, 'Warm': { low: 0.62, mud: 0.4 }, 'Clear (cut mud)': { low: 0.45, mud: 0.28 }, 'Fuller': { low: 0.7, mud: 0.5 } },
    comp: { 'Gentle': { comp: 0.3 }, 'Medium': { comp: 0.55 }, 'Heavy': { comp: 0.8 } },
    deess: { 'Soft': { deess: 0.3 }, 'Medium': { deess: 0.55 }, 'Strong': { deess: 0.8 } },
    pres: { 'Subtle': { pres: 0.25 }, 'Bright': { pres: 0.5 }, 'Air': { pres: 0.8 } },
    sat: { 'Warm': { saOn: true, drive: 0.25, smix: 0.4 }, 'Crunch': { saOn: true, drive: 0.55, smix: 0.5 }, 'Fuzz': { saOn: true, drive: 0.9, smix: 0.7 } },
    dbl: { 'Subtle': { dbOn: true, dbl: 0.25, dspr: 0.4 }, 'Wide': { dbOn: true, dbl: 0.5, dspr: 0.8 }, 'Thick': { dbOn: true, dbl: 0.75, dspr: 0.6 } },
    har: { 'Octave down': { hrOn: true, hint: 0, hlvl: 0.4 }, 'Third up': { hrOn: true, hint: 0.5, hlvl: 0.4 }, 'Fifth up': { hrOn: true, hint: 0.75, hlvl: 0.45 }, 'Octave up': { hrOn: true, hint: 1, hlvl: 0.35 } },
    delay: { 'Off': { dly: 0 }, 'Slapback': { dly: 0.35, time: 0 }, 'Echo': { dly: 0.3, time: 0.45 }, 'Long echo': { dly: 0.4, time: 0.9 } },
  };
  const CHAIN_BASE = { gOn: false, gate: 0.3, cutOn: true, cut: 0.4, eqOn: true, low: 0.5, mud: 0.5, cpOn: true, comp: 0, esOn: true, deess: 0, prOn: true, pres: 0,
    saOn: false, drive: 0, smix: 0.5, dbOn: false, dbl: 0, dspr: 0.5, hrOn: false, hint: 0.5, hlvl: 0.4, rvOn: true, rev: 0, decay: 0.4, dlOn: true, dly: 0, time: 0.4 };
  const CHAIN_PRESETS = Object.fromEntries(Object.entries({
    'Flat (all neutral)': {},
    'Clean Pop': { gOn: true, gate: 0.25, cut: 0.45, low: 0.52, mud: 0.38, comp: 0.5, deess: 0.45, pres: 0.45, rev: 0.22, decay: 0.25 },
    'Rock Edge': { gOn: true, gate: 0.4, cut: 0.5, mud: 0.35, comp: 0.7, deess: 0.4, pres: 0.5, saOn: true, drive: 0.35, smix: 0.45, dbOn: true, dbl: 0.25, rev: 0.15, decay: 0.15 },
    'Hip-Hop': { gOn: true, gate: 0.45, cut: 0.5, mud: 0.3, comp: 0.75, deess: 0.6, pres: 0.4, saOn: true, drive: 0.2, smix: 0.4, rev: 0.1, decay: 0.1, dly: 0.22, time: 0.35 },
    'Ballad': { cut: 0.35, low: 0.58, mud: 0.45, comp: 0.4, deess: 0.4, pres: 0.3, dbOn: true, dbl: 0.2, rev: 0.38, decay: 0.6, dly: 0.15, time: 0.5 },
    'Karaoke Fun': { cut: 0.4, comp: 0.55, deess: 0.4, pres: 0.5, dbOn: true, dbl: 0.3, rev: 0.38, decay: 0.4, dly: 0.18, time: 0.35 },
    'Radio / Lo-fi': { cut: 0.8, low: 0.35, mud: 0.6, comp: 0.85, pres: 0.3, saOn: true, drive: 0.6, smix: 0.6 },
    'Stadium': { comp: 0.55, deess: 0.4, pres: 0.5, dbOn: true, dbl: 0.4, dspr: 0.8, rev: 0.5, decay: 0.85, dly: 0.3, time: 0.6 },
    'Harmony Stack': { comp: 0.5, deess: 0.45, pres: 0.4, hrOn: true, hint: 0.75, hlvl: 0.5, dbOn: true, dbl: 0.3, rev: 0.3, decay: 0.4 },
    'Podcast': { gOn: true, gate: 0.4, cut: 0.55, low: 0.55, mud: 0.35, comp: 0.6, deess: 0.5, pres: 0.35 },
  }).map(([name, o]) => [name, { ...CHAIN_BASE, ...o, on: true }]));

  // Vocal chain, in signal-flow order like a vocal recording session: input -> auto-tune -> low cut -> de-esser -> compressor -> presence/air -> reverb -> delay -> chain on / REC.
  function studioBuildChain(sec) {
    const row = h('div', 'chainrow st-chainrow');
    const boxes = [];
    const nl = ['keydown', 'keyup', 'keypress'];
    const mod = (title, cls) => { const m = h('div', 'mod st-mod' + (cls ? ' ' + cls : ''));  m.appendChild(h('div', 'modtitle', title)); return m; };
    const toggles = [], selects = [];
    const refreshAll = () => { boxes.forEach((bx) => bx.redraw()); selects.forEach((f) => f()); toggles.forEach((f) => f()); };
    const modT = (title, flag, cls) => { // module with its own on/off LED
      const m = mod(title, cls);
      const led = h('button', 'modled', null, { type: 'button', 'aria-label': title + ' on or off', title: 'On / off' });
      const sync = () => { const v = fxState.voc[flag]; led.classList.toggle('on', v); m.classList.toggle('off', !v); };
      led.addEventListener('click', () => { fxState.voc[flag] = !fxState.voc[flag]; saveFx(); applyVocalFxAll(); sync(); });
      m.firstChild.appendChild(led); toggles.push(sync); sync();
      return m;
    };
    const presetSelect = (map, label) => {
      const sl = h('select', 'sel', null, { 'aria-label': label });
      for (const k of ['keydown', 'keyup', 'keypress']) sl.addEventListener(k, (e) => e.stopPropagation());
      const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sl.appendChild(o); };
      add('', 'Preset...'); for (const name of Object.keys(map)) add(name, name);
      const sync = () => { const v = fxState.voc; const hit = Object.entries(map).find(([, pr]) => Object.entries(pr).every(([k, val]) => k === 'on' || (typeof val === 'boolean' ? v[k] === val : Math.abs(v[k] - val) < 0.005))); sl.value = hit ? hit[0] : ''; };
      sl.addEventListener('change', () => { const pr = map[sl.value]; if (!pr) return; Object.assign(fxState.voc, pr); saveFx(); applyVocalFxAll(); refreshAll(); studio.syncVocalLab?.(); });
      selects.push(sync); sync();
      return sl;
    };
    const body = (...els) => { const b = h('div', 'modbody'); b.append(...els); return b; };
    const arrow = (cls) => h('div', 'modarrow' + (cls ? ' ' + cls : ''), '\u25B8');
    const fxKnob = (label, key, cls, dflt) => {
      const box = studioKnob(label, cls, () => fxState.voc[key], (v) => { fxState.voc[key] = v; applyVocalFxAll(key === 'decay'); saveFx(); selects.forEach((f) => f()); }, dflt, key === 'decay' ? () => applyVocalFxAll() : undefined);
      boxes.push(box);
      return box;
    };
    const gr = (key) => { const bar = h('div', 'grbar', null, { title: 'Gain reduction' }); const i = h('i'); bar.appendChild(i); (studio.gr ||= {})[key] = i; return bar; };

    // 1. INPUT (live only)
    const select = h('select', 'sel', null, { 'aria-label': 'Microphone input device' });
    for (const k of nl) select.addEventListener(k, (e) => e.stopPropagation());
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
    const syncMic = () => { const on = !!mic; onBtn.classList.toggle('on', on); led.classList.toggle('on', on); onBtn.setAttribute('aria-pressed', String(on)); };
    setInterval(syncMic, 500);
    onBtn.addEventListener('click', async () => {
      if (mic) { stopMic(); syncMic(); info.textContent = 'USE HEADPHONES'; return; }
      onBtn.disabled = true;
      try { await startMic(); await refresh(); } catch (error) {
        info.textContent = 'MIC ERROR: ' + String(error?.name || error).slice(0, 40);
        stemDiag('mic_error', { error: String(error?.name || error).slice(0, 80) });
      }
      onBtn.disabled = false; syncMic();
    });
    select.addEventListener('change', async () => {
      micState.device = select.value; saveMic();
      if (mic) { stopMic(); try { await startMic(); } catch (error) { info.textContent = 'MIC ERROR: ' + String(error?.name || error).slice(0, 40); } syncMic(); }
    });
    const lvl = studioKnob('LEVEL', 'red', () => micState.level, (v) => { micState.level = v; applyMicLevel(); studio.micFaderRefresh?.(); }, STEM_FADER_DEFAULT, saveMic);
    studio.micKnobRedraw = lvl.redraw;
    const mInput = mod('INPUT', 'live input');
    mInput.append(select, body(lvl, onBtn), info);
    studio.micTick = () => { // input peak, so the level can be set without clipping
      if (!mic) return;
      mic.an.getFloatTimeDomainData(mic.buf);
      let pk = 0;
      for (let i = 0; i < mic.buf.length; i += 1) { const a = Math.abs(mic.buf[i]); if (a > pk) pk = a; }
      const db = pk > 0 ? 20 * Math.log10(pk) : -100;
      info.textContent = 'IN ' + (db > -99 ? db.toFixed(0) + ' dB' : '-inf dB') + (db > -1 ? '  CLIP' : '');
    };

    // 2. AUTO-TUNE (live only)
    const pick = (label, items, key) => {
      const sl = h('select', 'sel', null, { 'aria-label': label });
      for (const k of nl) sl.addEventListener(k, (e) => e.stopPropagation());
      items.forEach((t, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = t; sl.appendChild(o); });
      sl.value = String(Math.round(fxState.at[key]));
      sl.addEventListener('change', () => { fxState.at[key] = Number(sl.value); saveFx(); atSendParams(); });
      return sl;
    };
    const atInfo = h('span', 'eqinfo', 'MIC OFF');
    const idle = () => (mic ? 'LISTENING' : 'MIC OFF');
    const atBtn = studioToggle('AUTO-TUNE', 'at', 'on', () => {
      atInfo.textContent = fxState.at.on ? (mic ? 'CONNECTING' : 'TURN MIC ON') : 'OFF';
      if (mic) micAttachSource(mic).catch((error) => { atInfo.textContent = 'MIC ERROR: ' + String(error?.name || error).slice(0, 40); });
    });
    studio.atStatus = (m) => {
      if (!fxState.at.on) { atInfo.textContent = 'OFF'; return; }
      if (m.t === 'error') atInfo.textContent = 'AUTO-TUNE UNAVAILABLE';
      else if (m.t === 'idle') atInfo.textContent = 'TURN MIC ON';
      else if (m.f0 > 0) { const c = Math.round((m.midi - m.target) * 100); atInfo.textContent = atNoteName(m.target) + '  ' + (c >= 0 ? '+' : '') + c + 'c'; }
      else atInfo.textContent = idle();
    };
    const mTune = mod('AUTO-TUNE', 'live tune');
    const keyRow = h('div', 'eqinfo-row'); keyRow.append(pick('Auto-tune key', AT_KEYS, 'key'), pick('Auto-tune scale', AT_SCALES, 'scale'));
    mTune.append(keyRow, body(
      studioKnob('SPEED', '', () => fxState.at.speed, (v) => { fxState.at.speed = v; atSendParams(); saveFx(); }, 0.7),
      studioKnob('AMOUNT', 'red', () => fxState.at.amount, (v) => { fxState.at.amount = v; atSendParams(); saveFx(); }, 1)), atBtn, atInfo);

    // signal-flow modules
    const mGate = modT('GATE', 'gOn'); mGate.append(body(fxKnob('THRESH', 'gate', '', 0.3)), gr('gate'), presetSelect(MOD_PRESETS.gate, 'Gate preset'));
    const mCut = modT('LOW CUT', 'cutOn'); mCut.append(body(fxKnob('FREQ', 'cut', '', 0.4)));
    const mEq = modT('EQ', 'eqOn'); mEq.append(body(fxKnob('LOW', 'low', '', 0.5), fxKnob('MUD', 'mud', '', 0.5)), presetSelect(MOD_PRESETS.eq, 'EQ preset'));
    const mComp = modT('COMP', 'cpOn'); mComp.append(body(fxKnob('AMOUNT', 'comp', '', 0)), gr('comp'), presetSelect(MOD_PRESETS.comp, 'Compressor preset'));
    const mEss = modT('DE-ESS', 'esOn'); mEss.append(body(fxKnob('AMOUNT', 'deess', '', 0)), gr('ess'), presetSelect(MOD_PRESETS.deess, 'De-esser preset'));
    const mPres = modT('PRESENCE', 'prOn'); mPres.append(body(fxKnob('AIR', 'pres', '', 0)), presetSelect(MOD_PRESETS.pres, 'Presence preset'));
    const mSat = modT('SATURATION', 'saOn'); mSat.append(body(fxKnob('DRIVE', 'drive', 'red', 0), fxKnob('MIX', 'smix', 'red', 0.5)), presetSelect(MOD_PRESETS.sat, 'Saturation preset'));
    const mDbl = modT('DOUBLER', 'dbOn'); mDbl.append(body(fxKnob('AMOUNT', 'dbl', 'red', 0), fxKnob('WIDTH', 'dspr', 'red', 0.5)), presetSelect(MOD_PRESETS.dbl, 'Doubler preset'));
    const mHar = modT('HARMONIZER', 'hrOn');
    const harSel = h('select', 'sel', null, { 'aria-label': 'Harmony interval' });
    for (const k of nl) harSel.addEventListener(k, (e) => e.stopPropagation());
    HARM_INTERVALS.forEach(([, t], i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = t; harSel.appendChild(o); });
    const syncHar = () => { harSel.value = String(Math.round(fxState.voc.hint * 4)); };
    harSel.addEventListener('change', () => { fxState.voc.hint = Number(harSel.value) / 4; saveFx(); applyVocalFxAll(); selects.forEach((f) => f()); });
    selects.push(syncHar); syncHar();
    mHar.append(harSel, body(fxKnob('LEVEL', 'hlvl', 'red', 0.4)), presetSelect(MOD_PRESETS.har, 'Harmonizer preset'));
    const mRev = modT('REVERB', 'rvOn'); mRev.append(body(fxKnob('SEND', 'rev', 'red', 0), fxKnob('DECAY', 'decay', 'red', 0.4)), presetSelect(REVERB_PRESETS, 'Reverb and delay preset'));
    const mDly = modT('DELAY', 'dlOn'); mDly.append(body(fxKnob('SEND', 'dly', 'red', 0), fxKnob('TIME', 'time', 'red', 0.4)), presetSelect(MOD_PRESETS.delay, 'Delay preset'));

    // 9. chain on + take (REC)
    const labBtn = studioToggle('CHAIN ON', 'voc', 'on', applyVocalFxAll);
    studio.syncVocalLab = labBtn.syncFn;
    const mOut = mod('OUTPUT');
    const takeBtn = h('button', 'btn solo recbig takebtn', 'REC', { type: 'button', 'aria-label': 'Record a take' });
    takeBtn.classList.add('st-rec');
    takeBtn.title = 'Records every layer (music stems, mic dry and with effects). Press again to finish and save.';
    const takeInfo = h('span', 'eqinfo', '');
    studio.infoEls?.push(takeInfo);
    takeBtn.addEventListener('click', () => { takeToggle(takeInfo).catch((error) => { takeInfo.textContent = 'ERROR: ' + String(error?.name || error).slice(0, 30); }); });
    setInterval(() => {
      takeBtn.classList.toggle('on', rec.active || rec.saving); takeBtn.setAttribute('aria-pressed', String(rec.active));
      if (rec.active) takeInfo.textContent = 'REC ' + fmtTime((Date.now() - rec.startedAt) / 1000);
    }, 300);
    const takeWrap = h('div', 'live'); takeWrap.append(takeBtn, takeInfo);
    mOut.append(labBtn, takeWrap);

    row.append(mInput, arrow('live'), mTune, arrow('live'), mGate, arrow(), mCut, arrow(), mEq, arrow(), mComp, arrow(), mEss, arrow(), mPres, arrow(), mSat, arrow(), mDbl, arrow(), mHar, arrow(), mRev, arrow(), mDly, arrow(), mOut);
    const bar = h('div', 'chainbar st-chainbar');
    const chainSel = presetSelect(CHAIN_PRESETS, 'Whole vocal chain preset');
    chainSel.options[0].textContent = 'Choose a chain preset...';
    bar.append(h('span', 'offlbl', 'VOCAL CHAIN PRESET'), chainSel);
    sec.append(bar, row);
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
    const gearSync = () => sec.classList.toggle('enh-on', onBtn.classList.contains('on'));
    new MutationObserver(gearSync).observe(onBtn, { attributes: true, attributeFilter: ['class'] }); gearSync();
    for (const n of ['big', 'r', 'l']) sec.appendChild(h('div', 'enh-gear ' + n, null)).appendChild(h('i'));
  }

  // ---- Recorder (master output -> MP3 in the recordings library) and the library player ----
  const rec = { layers: [], taps: null, layerMap: null, active: false, saving: false, recorder: null, dest: null, chunks: [], startedAt: 0, ctx: null, progress: 0 };
  let recLib = [];
  ipcRenderer.on('poc:rec-progress', (_event, pct) => { if (Number.isFinite(pct)) rec.progress = pct; });

  async function recRefresh() {
    try { recLib = await ipcRenderer.invoke('poc:rec-list'); } catch { recLib = []; }
    if (!Array.isArray(recLib)) recLib = [];
    studio.libRender?.();
  }

  function defaultRecName() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
  }

  // ---- Layered recording: each layer is captured losslessly (PCM) at the point where it is heard, before faders/EQ/Enhancer/master:
  // stems come from the playout sources (raw), the mic is taken after the Vocal Lab chain (wet, what the singer hears) plus a dry copy for pitch analysis.
  const REC_LAYER_MIME = 'audio/webm;codecs=pcm';
  function recStartLayers(context) {
    rec.layers = []; rec.taps = null; rec.layerMap = null;
    if (!MediaRecorder.isTypeSupported(REC_LAYER_MIME)) return;
    const map = {}, list = [];
    const make = (key, channels) => {
      const dest = context.createMediaStreamDestination();
      dest.channelCount = channels;
      const input = context.createGain();
      input.connect(dest);
      const recorder = new MediaRecorder(dest.stream, { mimeType: REC_LAYER_MIME });
      const layer = { key, channels, input, dest, recorder, chunks: [] };
      recorder.ondataavailable = (e) => { if (e.data?.size) layer.chunks.push(e.data); };
      map[key] = layer; list.push(layer);
      return layer;
    };
    if (stemNodes && stemPlayer && modeSelect?.value === 'stems') {
      const ht = modelSelect?.value === 'htdemucs' || modelSelect?.value === 'passthrough';
      const vocal = make('vocal', 2);
      if (ht) {
        const drums = make('drums', 2), bass = make('bass', 2), other = make('other', 2);
        rec.taps = { vocalGain: vocal.input, drumsGain: drums.input, bassGain: bass.input, otherGain: other.input };
      } else {
        const inst = make('inst', 2);
        rec.taps = { vocalGain: vocal.input, instGain: inst.input };
      }
    }
    if (mic) {
      make('micwet', 1); make('micdry', 1);
      // The singer follows what they HEAR (output latency), then the mic delivers it late (input latency): the mic layer lands about this much after the music.
      let inLat = 0;
      try { inLat = Number(mic.stream?.getAudioTracks?.()[0]?.getSettings?.().latency) || 0; } catch {}
      rec.micOffsetMs = Math.max(0, Math.min(400, Math.round(((context.outputLatency || 0) + (context.baseLatency || 0) + inLat) * 1000)));
    }
    rec.layerMap = map; rec.layers = list;
    recWireTaps();
    if (map.micdry) mic.gain.connect(map.micdry.input);
    recTapMic();
    for (const layer of list) layer.recorder.start(1000);
    rec.ctxT0 = context.currentTime;
  }

  // Wet mic tap follows the Vocal Lab routing: chain outputs while it is on, the plain mic otherwise.
  function recTapMic() {
    const wet = rec.layerMap?.micwet;
    if (!wet || !mic) return;
    try { mic.gain.disconnect(wet.input); } catch {}
    for (const o of mic.fx.outs) { try { o.disconnect(wet.input); } catch {} }
    if (fxState.voc.on) for (const o of mic.fx.outs) o.connect(wet.input); else mic.gain.connect(wet.input);
  }

  // Stops every layer recorder and returns 16-bit interleaved PCM per non-silent layer.
  async function recStopLayers() {
    const layers = rec.layers || [];
    recUnwireTaps();
    rec.taps = null; rec.layerMap = null; rec.layers = [];
    const ctx = rec.ctx, tStop = ctx.currentTime;
    await Promise.all(layers.map((layer) => new Promise((resolve) => {
      if (layer.recorder.state === 'inactive') return resolve();
      layer.recorder.onstop = resolve;
      try { layer.recorder.stop(); } catch { resolve(); }
    })));
    for (const layer of layers) {
      try { layer.input.disconnect(); } catch {}
      if (mic && layer.key === 'micdry') { try { mic.gain.disconnect(layer.input); } catch {} }
      if (mic && layer.key === 'micwet') { try { mic.gain.disconnect(layer.input); } catch {} for (const o of mic.fx.outs) { try { o.disconnect(layer.input); } catch {} } }
    }
    const out = [];
    for (const layer of layers) {
      try {
        const blob = new Blob(layer.chunks, { type: 'audio/webm' });
        layer.chunks = [];
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        const ch = Math.min(decoded.numberOfChannels, layer.channels), n = decoded.length;
        const pcm = new Int16Array(n * ch);
        let peak = 0;
        for (let c = 0; c < ch; c += 1) {
          const d = decoded.getChannelData(c);
          for (let i = 0; i < n; i += 1) { const v = Math.max(-1, Math.min(1, d[i])); if (Math.abs(v) > peak) peak = Math.abs(v); pcm[i * ch + c] = Math.round(v * 32767); }
        }
        if (peak < 0.0005) { stemDiag('rec_layer_skipped', { kind: layer.key }); continue; } // never carried any signal
        out.push({ key: layer.key, channels: ch, sampleRate: decoded.sampleRate, pcm: pcm.buffer });
      } catch (error) { stemDiag('rec_error', { kind: layer.key, error: String(error?.name || error).slice(0, 60) }); }
    }
    // A recorder stops writing once its source goes silent/ends: pad every layer with silence to one common length so the layers stay aligned.
    let want = Math.round((tStop - (rec.ctxT0 || tStop)) * (out[0]?.sampleRate || 0));
    for (const o of out) want = Math.max(want, o.pcm.byteLength / 2 / o.channels);
    for (const o of out) {
      if (o.pcm.byteLength / 2 / o.channels >= want) continue;
      const padded = new Int16Array(want * o.channels);
      padded.set(new Int16Array(o.pcm));
      o.pcm = padded.buffer;
    }
    return out;
  }

  async function startRec() {
    if (rec.active || rec.saving) return false;
    if (!activeContext || activeContext.state === 'closed') activeContext = new AudioContext({ latencyHint: 'interactive' });
    const context = activeContext;
    await context.resume();
    getEqInput(context);
    const dest = context.createMediaStreamDestination();
    masterEq.outNode.connect(dest); // taps the final output: music stems, mic, effects, master gain and limiter
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : undefined);
    rec.chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) rec.chunks.push(e.data); };
    recorder.start(1000);
    try { recStartLayers(context); } catch (error) { rec.layers = []; rec.taps = null; rec.layerMap = null; stemDiag('rec_error', { error: String(error?.name || error).slice(0, 60) }); }
    Object.assign(rec, { active: true, recorder, dest, startedAt: Date.now(), ctx: context, progress: 0 });
    stemDiag('rec_start', { state: 'recording' });
    return true;
  }

  // Stops, decodes the recording, hands 16-bit PCM to the main process which encodes the MP3 and files it in the library.
  async function stopRec() {
    if (!rec.active) return { ok: false, error: 'not recording' };
    const { recorder, dest, ctx } = rec;
    rec.active = false; rec.saving = true; rec.progress = 0;
    try {
      await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
      try { masterEq.outNode.disconnect(dest); } catch {}
      let layerData = [];
      try { layerData = await recStopLayers(); } catch {}
      const blob = new Blob(rec.chunks, { type: recorder.mimeType || 'audio/webm' });
      rec.chunks = [];
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const n = decoded.length, l = decoded.getChannelData(0), r = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : l;
      const li = new Int16Array(n), ri = new Int16Array(n);
      for (let i = 0; i < n; i += 1) {
        li[i] = Math.round(Math.max(-1, Math.min(1, l[i])) * 32767);
        ri[i] = Math.round(Math.max(-1, Math.min(1, r[i])) * 32767);
      }
      const result = await ipcRenderer.invoke('poc:rec-save', { sampleRate: decoded.sampleRate, left: li.buffer, right: ri.buffer, name: defaultRecName() });
      if (result?.ok && result.entry?.id) {
        if (layerData.some((l) => l.key === 'micwet')) { try { await ipcRenderer.invoke('poc:rec-set-offset', result.entry.id, rec.micOffsetMs || 0); } catch {} }
        for (const layer of layerData) {
          try { await ipcRenderer.invoke('poc:rec-layer', { id: result.entry.id, key: layer.key, sampleRate: layer.sampleRate, channels: layer.channels, pcm: layer.pcm }); } catch {}
        }
        await recRefresh();
      }
      stemDiag(result?.ok ? 'rec_saved' : 'rec_error', result?.ok ? { state: 'saved' } : { error: String(result?.error || 'unknown').slice(0, 80) });
      await recRefresh();
      return result || { ok: false, error: 'no result' };
    } catch (error) {
      try { masterEq.outNode.disconnect(dest); } catch {}
      stemDiag('rec_error', { error: String(error?.name || error).slice(0, 80) });
      return { ok: false, error: String(error?.name || error) };
    } finally { rec.saving = false; }
  }

  // Mixer EXPORT: renders the layered recording with the current fader/solo/mute settings offline, files the result as a finished MP3 in the MIXED tab.
  let mixExporting = false;
  async function exportMix() {
    const mix = libPlayer.mix;
    if (!mix || mixExporting) return { ok: false, error: 'nothing to export' };
    mixExporting = true;
    try {
      const sr = mix.bufs[mix.keys[0]].sampleRate;
      const length = Math.ceil((Math.max(...mix.keys.map((k) => mix.bufs[k].duration)) + (mix.keys.includes('micdry') ? 3 : 0)) * sr); // + room for the reverb/delay tail
      const off = new OfflineAudioContext(2, length, sr);
      const bus = off.createDynamicsCompressor();
      bus.threshold.value = -6; bus.ratio.value = 20; bus.attack.value = 0; bus.release.value = 0.1; bus.knee.value = 6;
      const master = off.createGain();
      master.gain.value = masterEq.master.gain.value;
      bus.connect(master); master.connect(off.destination);
      const anySolo = mix.keys.some((k) => mix.states[k].stemFlags.solo);
      for (const k of mix.keys) {
        const st = mix.states[k];
        const audible = !st.stemFlags.mute && (!anySolo || st.stemFlags.solo);
        const g = off.createGain();
        g.gain.value = audible ? faderPosToLevel(st.pos) * (isMicLayer(k) ? 1 : STEM_HEADROOM) : 0;
        const src = off.createBufferSource();
        src.buffer = mix.bufs[k];
        src.connect(g);
        if (k === 'micdry') { // offline copy of the Vocal Lab chain with the current lab settings
          const fx = buildVocalFx(off, bus, g);
          const ix = vocalFxInstances.indexOf(fx);
          if (ix >= 0) vocalFxInstances.splice(ix, 1);
          applyVocalFx(fx, true);
          const sec = Math.round((0.4 + fxState.voc.decay * 3.6) * 10) / 10;
          fx.irKey = sec; fx.conv.buffer = makeReverbIR(off, sec);
          await fx.harm.ready; // the harmony voice's worklet must exist before the offline render starts
        } else g.connect(bus);
        const shiftS = isMicLayer(k) ? (libPlayer.micOffsetMs || 0) / 1000 : 0;
        if (shiftS >= 0) src.start(0, Math.min(shiftS, Math.max(0, mix.bufs[k].duration - 0.001))); else src.start(-shiftS, 0);
      }
      const out = await off.startRendering();
      const l = out.getChannelData(0), r = out.getChannelData(1), n = out.length;
      const li = new Int16Array(n), ri = new Int16Array(n);
      for (let i = 0; i < n; i += 1) {
        li[i] = Math.round(Math.max(-1, Math.min(1, l[i])) * 32767);
        ri[i] = Math.round(Math.max(-1, Math.min(1, r[i])) * 32767);
      }
      const base = recLib.find((e) => e.id === libPlayer.id)?.name || 'Recording';
      const result = await ipcRenderer.invoke('poc:rec-save', { sampleRate: sr, left: li.buffer, right: ri.buffer, name: (base + ' (mix)').slice(0, 80), kind: 'mix' });
      await recRefresh();
      return result || { ok: false, error: 'no result' };
    } catch (error) {
      stemDiag('rec_error', { error: String(error?.name || error).slice(0, 80) });
      return { ok: false, error: String(error?.name || error) };
    } finally { mixExporting = false; }
  }

  // Library player: decoded MP3 -> master gain + limiter only (EQ and Enhancer are skipped: they are already baked into the recording). No <audio> element, no CSP media rules involved.
  const libPlayer = { micOffsetMs: 0, id: null, buffer: null, source: null, sources: [], mix: null, ctx: null, offset: 0, startedAt: 0, playing: false };
  // Layered recordings: every layer WAV gets its own gain (= a Mixer channel) and meter, summed into a small limiter, then master gain + limiter. EQ/Enhancer/Vocal Lab are NOT applied (layers are raw; micwet already carries the Vocal Lab).
  const LIB_LAYER_NAMES = { vocal: 'VOCALS', inst: 'INSTR.', drums: 'DRUMS', bass: 'BASS', drumsbass: 'DRUMS+BASS', other: 'OTHER', micwet: 'MIC', micdry: 'MIC' };
  const LIB_LAYER_ORDER = ['vocal', 'inst', 'drums', 'bass', 'drumsbass', 'other', 'micwet', 'micdry'];
  const isMicLayer = (k) => k === 'micwet' || k === 'micdry';
  function libMixApply() {
    const mix = libPlayer.mix;
    if (!mix) return;
    const now = mix.ctx.currentTime;
    const anySolo = mix.keys.some((k) => mix.states[k].stemFlags.solo);
    for (const k of mix.keys) {
      const st = mix.states[k];
      const audible = !st.stemFlags.mute && (!anySolo || st.stemFlags.solo);
      mix.gains[k].gain.setTargetAtTime(audible ? faderPosToLevel(st.pos) * (isMicLayer(k) ? 1 : STEM_HEADROOM) : 0, now, 0.03);
    }
  }
  function libDropMix() {
    const mix = libPlayer.mix;
    if (!mix) return;
    libKillSource();
    for (const k of mix.keys) { try { mix.gains[k].disconnect(); } catch {} }
    try { mix.bus.disconnect(); } catch {}
    if (mix.fx) {
      const i = vocalFxInstances.indexOf(mix.fx);
      if (i >= 0) vocalFxInstances.splice(i, 1);
      clearTimeout(mix.fx.irTimer);
      mix.fx.dispose?.();
      for (const o of mix.fx.outs) { try { o.disconnect(); } catch {} }
    }
    libPlayer.mix = null;
    Object.assign(libPlayer, { id: null, buffer: null, offset: 0, playing: false });
    studioRebuildStrips();
    studio.libRender?.();
  }
  async function libLoadMix(ctx, id, keys) {
    const bufs = {};
    for (const k of keys) {
      const bytes = await ipcRenderer.invoke('poc:rec-layer-read', id, k);
      if (!bytes) return null;
      bufs[k] = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    const bus = ctx.createDynamicsCompressor();
    bus.threshold.value = -6; bus.ratio.value = 20; bus.attack.value = 0; bus.release.value = 0.1; bus.knee.value = 6;
    bus.connect(masterEq.master);
    const gains = {}, ans = {}, states = {};
    let micFx = null;
    for (const k of keys) {
      const g = ctx.createGain();
      if (k === 'micdry') micFx = buildVocalFx(ctx, bus, g); // the raw mic goes through the LIVE Vocal Lab (fader first, then effects), so the lab knobs shape it while mixing
      else g.connect(bus);
      const an = ctx.createAnalyser(); an.fftSize = 512; g.connect(an); // meter tap
      gains[k] = g; ans[k] = an;
      states[k] = { value: String(faderPosToLevel(STEM_FADER_DEFAULT) * 100), pos: STEM_FADER_DEFAULT, stemFlags: { solo: false, mute: false }, apply: libMixApply };
    }
    return { ctx, keys, bufs, gains, ans, states, bus, fx: micFx };
  }
  const libPos = () => (libPlayer.playing ? libPlayer.offset + (libPlayer.ctx.currentTime - libPlayer.startedAt) : libPlayer.offset);
  function libKillSource() {
    const all = [libPlayer.source, ...libPlayer.sources];
    libPlayer.source = null; libPlayer.sources = [];
    for (const src of all) {
      if (!src) continue;
      src.onended = null;
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
  }
  // While a library recording plays, YouTube Music must be silent: its element is paused and every capture path (dry, processed, stems incl. the queued stem tail) is muted.
  let ytmHeld = false;
  function ytmHold(on) {
    if (on === ytmHeld) return;
    ytmHeld = on;
    const medias = [...document.querySelectorAll('audio, video')];
    if (on) {
      for (const m of medias) { try { if (!m.paused) m.pause(); } catch {} }
      const now = activeContext?.currentTime || 0;
      for (const m of medias) {
        const g = graphs.get(m);
        if (!g) continue;
        g.dryGain.gain.setTargetAtTime(0, now, 0.02); g.wetGain.gain.setTargetAtTime(0, now, 0.02); g.stemBus.gain.setTargetAtTime(0, now, 0.02);
      }
    } else if (captureActive) setMode(modeSelect?.value || 'bypass', false);
    else {
      const now = activeContext?.currentTime || 0;
      for (const m of medias) {
        const g = graphs.get(m);
        if (!g) continue;
        g.dryGain.gain.setTargetAtTime(1, now, 0.02); g.wetGain.gain.setTargetAtTime(0, now, 0.02); g.stemBus.gain.setTargetAtTime(0, now, 0.02);
      }
    }
  }
  // Pressing play in YouTube Music while a recording plays: the recording gives way (one thing at a time).
  document.addEventListener('play', (e) => {
    if (!ytmHeld || !(e.target instanceof HTMLMediaElement)) return;
    if (libPlayer.playing) libPause();
    else ytmHold(false);
    libDropMix(); // the layered mixer gives the channels back to the live session
    studio.libRender?.();
  }, true);

  function libPause(keepHold) {
    if (!libPlayer.playing) return;
    libPlayer.offset = Math.min(libPos(), libPlayer.buffer?.duration || 0);
    libKillSource();
    libPlayer.playing = false;
    if (keepHold !== true) ytmHold(false);
  }
  function libStartAt(offset) {
    const { ctx, buffer } = libPlayer;
    libKillSource();
    ytmHold(true);
    const mix = libPlayer.mix;
    const srcs = [];
    const t0 = ctx.currentTime + 0.05; // all layers start on the same sample
    if (mix) {
      libMixApply();
      for (const k of mix.keys) { const s2 = ctx.createBufferSource(); s2.buffer = mix.bufs[k]; s2.connect(mix.gains[k]); srcs.push(s2); }
    }
    const micShiftS = (mix && libPlayer.micOffsetMs ? libPlayer.micOffsetMs : 0) / 1000; // mic layer was recorded late: read it earlier
    const src = mix ? srcs[0] : ctx.createBufferSource();
    if (!mix) src.buffer = buffer;
    if (!mix) src.connect(masterEq.master); // after EQ and Enhancer: the recording already contains them, so only master gain + limiter apply (no double processing)
    src.onended = () => {
      if (libPlayer.source !== src) return;
      libPlayer.source = null; libPlayer.playing = false; libPlayer.offset = 0;
      ytmHold(false);
      studio.libRender?.();
    };
    const at = Math.max(0, Math.min(offset, buffer.duration - 0.01));
    if (mix) {
      mix.keys.forEach((k, i) => {
        if (!isMicLayer(k)) { srcs[i].start(t0, at); return; }
        const pos = at + micShiftS;
        if (pos >= 0) srcs[i].start(t0, Math.min(pos, Math.max(0, mix.bufs[k].duration - 0.001))); else srcs[i].start(t0 - pos, at);
      });
      libPlayer.sources = srcs.slice(1); } else src.start(0, at);
    libPlayer.source = src; libPlayer.offset = offset; libPlayer.startedAt = mix ? t0 : ctx.currentTime; libPlayer.playing = true;
  }
  async function libToggle(id) {
    if (libPlayer.id === id && libPlayer.buffer) {
      if (libPlayer.playing) libPause();
      else { await libPlayer.ctx.resume(); libStartAt(libPlayer.offset >= libPlayer.buffer.duration - 0.05 ? 0 : libPlayer.offset); }
      studio.libRender?.();
      return;
    }
    libPause(true);
    libDropMix();
    if (!activeContext || activeContext.state === 'closed') activeContext = new AudioContext({ latencyHint: 'interactive' });
    const ctx = activeContext;
    await ctx.resume();
    getEqInput(ctx);
    const entry = recLib.find((r) => r.id === id);
    let keys = LIB_LAYER_ORDER.filter((k) => entry?.layers?.includes(k));
    if (keys.includes('micdry')) keys = keys.filter((k) => k !== 'micwet'); // the dry mic is the source; the Vocal Lab is applied live
    let mix = null;
    if (keys.length >= 1) { try { mix = await libLoadMix(ctx, id, keys); } catch (error) { stemDiag('rec_error', { error: String(error?.name || error).slice(0, 60) }); } }
    if (mix) {
      libPlayer.mix = mix;
      libPlayer.micOffsetMs = Number(entry?.micOffsetMs) || 0;
      Object.assign(libPlayer, { id, buffer: mix.bufs[keys[0]], ctx, offset: 0 });
      studio.syncOffset?.();
      if (mix.fx && !fxState.voc.on) { fxState.voc.on = true; saveFx(); applyVocalFxAll(); studio.syncVocalLab?.(); } // a vocal recording opens with the Vocal Lab on
      studioRebuildStrips();
    } else {
      const bytes = await ipcRenderer.invoke('poc:rec-read', id);
      if (!bytes) { ytmHold(false); return; }
      const buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      Object.assign(libPlayer, { id, buffer, ctx, offset: 0 });
    }
    libStartAt(0); // pauses YouTube Music and mutes its capture paths (ytmHold)
    studio.libRender?.();
  }
  function libSeek(frac) {
    if (!libPlayer.buffer) return;
    const t = Math.max(0, Math.min(1, frac)) * libPlayer.buffer.duration;
    if (libPlayer.playing) libStartAt(t); else libPlayer.offset = t;
    studio.libRender?.();
  }
  function libForget(id) {
    if (libPlayer.id !== id) return;
    libPause(); libKillSource(); libDropMix();
    Object.assign(libPlayer, { id: null, buffer: null, offset: 0, playing: false });
  }

  const fmtTime = (sec) => { const s = Math.max(0, Math.round(sec || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  // REC button + status line (lives in the Output section)
  function studioBuildRec() {
    const btn = h('button', 'btn solo recbtn', null, { type: 'button', 'aria-label': 'Record the output as MP3' });
    const led = h('span', 'led rec');
    btn.append(led, document.createTextNode('REC'));
    btn.title = 'Records everything you hear (music, mic, effects) to an MP3 in your recordings library.';
    const info = h('div', 'eqinfo recinfo', 'RECORDINGS: IDLE');
    const sync = () => { btn.classList.toggle('on', rec.active); led.classList.toggle('on', rec.active); btn.setAttribute('aria-pressed', String(rec.active)); btn.disabled = rec.saving; };
    setInterval(() => {
      if (rec.active) info.textContent = 'REC ' + fmtTime((Date.now() - rec.startedAt) / 1000);
      else if (rec.saving) info.textContent = rec.progress > 0 ? 'ENCODING MP3 ' + rec.progress + '%' : 'PREPARING...';
    }, 500);
    btn.addEventListener('click', async () => {
      if (rec.saving) return;
      if (!rec.active) {
        try { await startRec(); } catch (error) { info.textContent = 'REC ERROR: ' + String(error?.name || error).slice(0, 30); }
        sync(); return;
      }
      info.textContent = 'PREPARING...';
      const pending = stopRec();
      sync();
      const result = await pending;
      info.textContent = result.ok ? 'SAVED: ' + result.entry.name : 'SAVE FAILED';
      sync();
      if (result.ok) studio.libOpen?.(true);
    });
    sync();
    return { btn, info };
  }

  // Recordings panel: slides in from the left edge; play / rename / export / reveal / delete.
  function studioBuildLibrary(ui) {
    const panel = h('aside', 'lib');
    const head = h('div', 'libhead');
    const title = h('span', 'libtitle', 'MY RECORDINGS');
    const closeBtn = h('button', 'libclose', '✕', { type: 'button', 'aria-label': 'Close recordings' });
    head.append(title, closeBtn);
    const list = h('div', 'liblist');
    let libTab = 'raw'; // 'raw' = unmixed layer blocks, 'mix' = finished exports
    const tabs = h('div', 'libtabs');
    const tabRaw = h('button', 'btn libsub on', 'LAYERS', { type: 'button', 'aria-label': 'Show unmixed recordings (layers)' });
    const tabMix = h('button', 'btn libsub', 'MIXED', { type: 'button', 'aria-label': 'Show finished mixes' });
    tabs.append(tabRaw, tabMix);
    const setTab = (t) => { libTab = t; tabRaw.classList.toggle('on', t === 'raw'); tabMix.classList.toggle('on', t === 'mix'); render(); };
    tabRaw.addEventListener('click', () => setTab('raw'));
    tabMix.addEventListener('click', () => setTab('mix'));
    studio.libShowTab = setTab;
    panel.append(h('i', 'screw tl'), h('i', 'screw tr'), head, tabs, list);
    const tab = h('button', 'libtab', 'RECORDINGS', { type: 'button', 'aria-label': 'Toggle recordings panel' });
    ui.append(panel, tab);
    let open = false;
    const setOpen = (v) => { open = v; panel.classList.toggle('open', v); tab.classList.toggle('open', v); if (v) recRefresh(); };
    studio.libOpen = setOpen; studio.libEl = panel;
    tab.addEventListener('click', () => setOpen(!open));
    closeBtn.addEventListener('click', () => setOpen(false));
    let confirmId = null, renamingId = null;

    const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
    const bars = new Map();
    const render = () => {
      list.textContent = ''; bars.clear();
      const shown = recLib.filter((e) => (e.kind === 'mix') === (libTab === 'mix'));
      const nMix = recLib.filter((e) => e.kind === 'mix').length;
      title.textContent = 'MY RECORDINGS (' + recLib.length + ')';
      tabRaw.textContent = 'LAYERS (' + (recLib.length - nMix) + ')'; tabMix.textContent = 'MIXED (' + nMix + ')';
      if (!shown.length) list.appendChild(h('div', 'libempty', libTab === 'mix' ? 'No mixes yet. Play a layered recording and press EXPORT in the Mixer.' : 'No recordings yet. Press REC in the Output section.'));
      for (const e of shown) {
        const row = h('div', 'librow');
        const isCur = libPlayer.id === e.id;
        const play = h('button', 'btn libplay' + (isCur && libPlayer.playing ? ' on' : ''), isCur && libPlayer.playing ? '❚❚' : '▶', { type: 'button', 'aria-label': 'Play or pause ' + e.name });
        play.addEventListener('click', () => { libToggle(e.id).catch((error) => stemDiag('rec_error', { error: String(error?.name || error).slice(0, 60) })); });
        const main = h('div', 'libmain');
        let nameEl;
        if (renamingId === e.id) {
          nameEl = h('input', 'txt libname', null, { type: 'text', maxlength: '80', 'aria-label': 'Recording name' });
          nameEl.value = e.name;
          for (const k of ['keydown', 'keyup', 'keypress']) nameEl.addEventListener(k, (ev) => ev.stopPropagation()); // typing must not trigger YouTube Music hotkeys
          const commit = async (save) => {
            const v = nameEl.value.trim();
            renamingId = null;
            if (save && v && v !== e.name) { try { await ipcRenderer.invoke('poc:rec-rename', e.id, v); } catch {} await recRefresh(); } else render();
          };
          nameEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(true); else if (ev.key === 'Escape') commit(false); });
          nameEl.addEventListener('blur', () => { if (renamingId === e.id) commit(true); });
          setTimeout(() => { nameEl.focus(); nameEl.select(); }, 0);
        } else {
          nameEl = h('div', 'libname-text', e.name, { title: 'Double-click to rename' });
          nameEl.addEventListener('dblclick', () => { renamingId = e.id; render(); });
        }
        const meta = h('div', 'libmeta', fmtDate(e.createdAt) + ' · ' + fmtTime(e.durationS));
        const bar = h('div', 'libbar'); const fill = h('div', 'libfill'); bar.appendChild(fill);
        bar.addEventListener('click', (ev) => { if (libPlayer.id !== e.id) return; const r = bar.getBoundingClientRect(); libSeek((ev.clientX - r.left) / r.width); });
        bars.set(e.id, { fill, meta, e });
        main.append(nameEl, meta, bar);
        const acts = h('div', 'libacts');
        const mk = (text, label, fn, cls) => { const b = h('button', 'btn libact' + (cls ? ' ' + cls : ''), text, { type: 'button', 'aria-label': label + ' ' + e.name, title: label }); b.addEventListener('click', fn); return b; };
        const rename = mk('✎', 'Rename', () => { renamingId = e.id; render(); });
        const exp = mk('↓', 'Export MP3...', () => { ipcRenderer.invoke('poc:rec-export', e.id).catch(() => {}); });
        const reveal = mk('⌖', 'Show in folder', () => { ipcRenderer.invoke('poc:rec-reveal', e.id).catch(() => {}); });
        const del = mk(confirmId === e.id ? 'SURE?' : '✕', confirmId === e.id ? 'Click again to delete' : 'Delete', async () => {
          if (confirmId !== e.id) { confirmId = e.id; render(); setTimeout(() => { if (confirmId === e.id) { confirmId = null; render(); } }, 3000); return; }
          confirmId = null; libForget(e.id);
          try { await ipcRenderer.invoke('poc:rec-delete', e.id); } catch {}
          await recRefresh();
        }, 'mute');
        acts.append(rename, exp, reveal, del);
        row.append(play, main, acts);
        list.appendChild(row);
      }
      tick();
    };
    const tick = () => { // progress bars follow the player
      for (const [id, { fill, meta, e }] of bars) {
        if (libPlayer.id === id && libPlayer.buffer) {
          const pos = Math.min(libPos(), libPlayer.buffer.duration);
          fill.style.width = (pos / libPlayer.buffer.duration * 100) + '%';
          meta.textContent = fmtTime(pos) + ' / ' + fmtTime(libPlayer.buffer.duration);
        } else { fill.style.width = '0%'; }
      }
    };
    setInterval(() => { if (open && libPlayer.playing) tick(); }, 250);
    studio.libRender = render;
    recRefresh();
  }

  // ---- Key & Tempo (karaoke / listen) ----
  // TEMPO: the YouTube Music element itself is slowed or sped up with pitch preserved (browser time-stretch), so the stems, the lyrics and the recording all follow it.
  // KEY: every stem layer passes a Signalsmith Stretch pitch shifter (below) before its fader and before the recording taps, so layers are recorded in the key the singer sang in.
  const tuneState = { semis: 0, tempo: 1 };
  const STEM_SLOTS = ['vocalGain', 'instGain', 'drumsGain', 'bassGain', 'otherGain'];
  // KEY on the stems: one stereo Signalsmith Stretch node per stem (AudioWorklet + WASM, spectral). Two paths per stem: 'direct' (KEY 0)
  // and 'wet' (shifted), crossfaded; until a node is ready its stem simply stays on the direct path.
  function buildStemPitch(context, nodes) {
    const ins = {}, outs = {}, paths = [];
    const self = { ins, outs };
    let shifted = false;
    STEM_SLOTS.forEach((key) => {
      const input = fxGain(context), output = fxGain(context), direct = fxGain(context), wet = fxGain(context);
      input.connect(direct); direct.connect(output); wet.connect(output); output.connect(nodes[key]);
      direct.gain.value = 1; wet.gain.value = 0;
      const path = { direct, wet, node: null, last: null };
      paths.push(path);
      ins[key] = input; outs[key] = output;
      createStretch(context).then((node) => {
        if (nodes.pitch !== self) return; // superseded by a newer capture graph
        input.connect(node); node.connect(wet); path.node = node; route(true);
      }).catch((error) => stemDiag('stem_pitch', { state: 'unavailable', error: String(error?.message || error).slice(0, 120) }));
    });
    const route = (force) => {
      if (nodes.pitch !== self) return;
      const semis = tuneState.semis, want = semis !== 0, t = context.currentTime;
      for (const p of paths) if (p.node && p.last !== semis) { p.last = semis; p.node.schedule({ semitones: semis }); }
      if (want === shifted && !force) return;
      shifted = want;
      for (const p of paths) {
        const on = want && !!p.node;
        p.direct.gain.setTargetAtTime(on ? 0 : 1, t, 0.02); p.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
      }
    };
    self.route = route; setInterval(route, 150);
    return self;
  }
  // Recording taps hang on the shifter outputs: layers are recorded after the key change, exactly as heard.
  function recWireTaps() {
    rec.tapWires = [];
    const pitch = stemNodes?.pitch;
    if (!pitch || !rec.taps) return;
    for (const [key, tap] of Object.entries(rec.taps)) { const o = pitch.outs[key]; if (o && tap) { o.connect(tap); rec.tapWires.push([o, tap]); } }
  }
  function recUnwireTaps() {
    for (const [o, tap] of rec.tapWires || []) { try { o.disconnect(tap); } catch {} }
    rec.tapWires = [];
  }
  let tempoTouched = false;
  function applyTempo() {
    const m = findMedia();
    if (!m) return;
    const want = (appMode !== 'idle' && !libPlayer.mix) ? tuneState.tempo : 1; // only while listening / singing
    if (want === 1 && !tempoTouched) return;
    try { m.preservesPitch = true; m.webkitPreservesPitch = true; } catch {}
    if (Math.abs(m.playbackRate - want) > 0.001) { try { m.playbackRate = want; } catch {} }
    tempoTouched = want !== 1;
  }
  setInterval(applyTempo, 700); // also wins back the rate if YouTube Music resets it on a new song

  function studioBuildTune(sec) {
    const val = (cls) => h('div', 'tunevalue' + (cls ? ' ' + cls : ''), '');
    const keyV = val(), tempoV = val();
    const step = (label, fn) => { const b = h('button', 'btn tunebtn', label, { type: 'button', 'aria-label': label }); b.addEventListener('click', fn); return b; };
    const wheelEl = h('i'), wheel = { dir: 0, speed: 0, ang: 0, last: 0, raf: 0 };
    wheel.tick = (now) => {
      wheel.ang = (wheel.ang + wheel.dir * wheel.speed * Math.min(0.1, (now - wheel.last) / 1000) + 360) % 360; wheel.last = now;
      wheelEl.style.transform = 'rotate(' + wheel.ang.toFixed(2) + 'deg)';
      wheel.raf = wheel.dir ? requestAnimationFrame(wheel.tick) : 0;
    };
    const show = () => {
      keyV.textContent = (tuneState.semis > 0 ? '+' : '') + tuneState.semis;
      tempoV.textContent = Math.round(tuneState.tempo * 100) + '%';
      // KEY and TEMPO both drive the wheel; whichever one is further from neutral (more steps) wins. Up/faster = right, down/slower = left, neutral = stops.
      const keySteps = Math.abs(tuneState.semis), tempoSteps = Math.round(Math.abs(tuneState.tempo - 1) / 0.05 * 100) / 100;
      const useKey = keySteps >= tempoSteps, steps = useKey ? keySteps : tempoSteps;
      const dir = steps === 0 ? 0 : Math.sign(useKey ? tuneState.semis : tuneState.tempo - 1);
      wheel.dir = dir; wheel.speed = 22 * steps; // deg/s
      if (dir && !wheel.raf) { wheel.last = performance.now(); wheel.raf = requestAnimationFrame(wheel.tick); }
    };
    const setKey = (v) => { tuneState.semis = Math.max(-8, Math.min(8, v)); show(); stemNodes?.pitch?.route?.(); masterEq?.mixPitch?.route(); };
    const setTempo = (v) => { tuneState.tempo = Math.max(0.5, Math.min(1.5, Math.round(v * 100) / 100)); show(); applyTempo(); };
    const keyRow = h('div', 'tunerow'); keyRow.append(h('span', 'tunelbl', 'KEY'), step('\u2212', () => setKey(tuneState.semis - 1)), keyV, step('+', () => setKey(tuneState.semis + 1)));
    const tempoRow = h('div', 'tunerow'); tempoRow.append(h('span', 'tunelbl', 'TEMPO'), step('\u2212', () => setTempo(tuneState.tempo - 0.05)), tempoV, step('+', () => setTempo(tuneState.tempo + 0.05)));
    const reset = h('button', 'btn', 'RESET', { type: 'button', 'aria-label': 'Reset key and tempo' });
    reset.addEventListener('click', () => { setKey(0); setTempo(1); });
    const note = h('div', 'eqinfo', 'KEY IN SEMITONES');
    sec.append(keyRow, tempoRow, h('div', 'switches'), note);
    sec.lastChild.previousSibling.appendChild(reset);
    sec.appendChild(h('div', 'st-wheel k')).appendChild(wheelEl);
    show();
  }

  // Now-playing window: floats above the open Studio drawer so the song stays visible and controllable while mixing.
  function studioBuildNowPlaying(ui) {
    const win = h('div', 'np');
    const art = h('img', 'npart', null, { alt: '' });
    const info = h('div', 'npinfo');
    const title = h('div', 'nptitle'), artist = h('div', 'npartist');
    const bar = h('div', 'libbar npbar'); const fill = h('div', 'libfill'); bar.appendChild(fill);
    const times = h('div', 'npmeta');
    const ticks = h('div', 'npticks'); let tickDur = 0;
    const buildTicks = (dur) => {
      tickDur = dur; ticks.textContent = '';
      if (!(dur > 20)) return;
      const major = [60, 120, 300, 600, 900].find((st) => dur / st <= 12) || 1800; // label step chosen from the song length
      const minor = major === 60 ? 30 : major;
      for (let t = minor; t < dur - 3; t += minor) {
        const isMajor = t % major === 0;
        const tk = h('button', 'nptick' + (isMajor ? ' major' : ''), null, { type: 'button', 'aria-label': 'Jump to ' + fmtTime(t) });
        tk.style.left = (t / dur * 100) + '%';
        tk.appendChild(h('i', 'tkline'));
        tk.appendChild(h('span', 'tklbl', Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0')));
        tk.addEventListener('click', (ev) => { ev.stopPropagation(); songSeek(t); });
        ticks.appendChild(tk);
      }
    };
    info.append(title, artist, bar, ticks, times);
    const q = (sel) => document.querySelector('ytmusic-player-bar ' + sel);
    const mk = (text, label, fn, cls) => { const b = h('button', 'btn npbtn' + (cls ? ' ' + cls : ''), text, { type: 'button', 'aria-label': label }); b.addEventListener('click', fn); return b; };
    const prev = mk('\u23EE', 'Previous song', () => q('.previous-button')?.click());
    const playBtn = mk('\u25B6', 'Play or pause', () => { const pb = q('.play-pause-button'); if (pb) pb.click(); else { const m = findMedia(); if (m) { if (m.paused) m.play()?.catch?.(() => {}); else m.pause(); } } }, 'solo');
    const next = mk('\u23ED', 'Next song', () => q('.next-button')?.click());
    const shuf = mk('', 'Shuffle', () => q('.shuffle')?.click(), 'shuf');
    const rpt = mk('', 'Repeat', () => q('.repeat')?.click(), 'rpt');
    const ctl = h('div', 'npctl'); ctl.append(shuf, prev, playBtn, next, rpt);
    // Live spectrum over the waveform track: log-spaced frequency columns (40 Hz left .. 16 kHz right), mirrored around the centre line,
    // orange glow with a white-hot core; the played part burns brighter. Fed by the same analysers as the top VU meters.
    const cv = document.createElement('canvas'); cv.className = 'npviz'; bar.appendChild(cv);
    const g2 = cv.getContext('2d'); let fbuf = null, lv = null, raw = null, peak = 0.2;
    let lastDraw = 0;
    const draw = (ts) => {
      requestAnimationFrame(draw);
      if (document.hidden || ts - lastDraw < 31) return; // 30 fps is plenty for the bars and halves the main-thread cost
      lastDraw = ts;
      const W = bar.clientWidth, H = bar.clientHeight + 24; if (!W) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const ans = studio.vuAns, m = findMedia(), live = !!(ans && m && !m.paused);
      const step = 4, n = Math.floor(W / step);
      if (!lv || lv.length !== n) lv = new Float32Array(n);
      if (live) {
        const an = ans[0]; if (!fbuf || fbuf.length !== an.frequencyBinCount) fbuf = new Uint8Array(an.frequencyBinCount);
        const nyq = (an.context.sampleRate || 48000) / 2, bins = an.frequencyBinCount, tmp = new Uint8Array(bins);
        for (const a of ans) if (a && a.maxDecibels !== -12) { a.minDecibels = -85; a.maxDecibels = -12; } // byte-spectrum range only (VU reads the time domain)
        an.getByteFrequencyData(fbuf); if (ans[1]) { ans[1].getByteFrequencyData(tmp); for (let i = 0; i < bins; i += 1) fbuf[i] = Math.max(fbuf[i], tmp[i]); }
        if (!raw || raw.length !== n) raw = new Float32Array(n);
        let fmax = 0;
        for (let i = 0; i < n; i += 1) {
          const f0 = 40 * Math.pow(400, i / n), f1 = 40 * Math.pow(400, (i + 1) / n);
          let b0 = Math.floor(f0 / nyq * bins), b1 = Math.max(b0 + 1, Math.ceil(f1 / nyq * bins)), mx = 0;
          for (let b = b0; b < b1 && b < bins; b += 1) if (fbuf[b] > mx) mx = fbuf[b];
          const tilt = 0.6 + 0.9 * i / n; // lift the highs so the right side moves too
          raw[i] = Math.pow(mx / 255, 2.8) * tilt; if (raw[i] > fmax) fmax = raw[i];
        }
        // auto gain: whatever the source level (passive tap or capture graph), the loudest column reaches ~90 %, quiet parts stay low
        peak = Math.max(fmax, peak * 0.997, 0.05);
        for (let i = 0; i < n; i += 1) { const v = Math.min(0.95, Math.max(0, (raw[i] / peak - 0.15) / 0.85) * 0.92); lv[i] = v > lv[i] ? v : lv[i] * 0.86; } // fast attack, slow fall
      } else for (let i = 0; i < n; i += 1) lv[i] *= 0.9;
      g2.setTransform(dpr, 0, 0, dpr, 0, 0); g2.clearRect(0, 0, W, H);
      const cy = H / 2, half = H / 2 - 2, played = (parseFloat(fill.style.width) || 0) / 100 * W;
      g2.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i += 1) {
        const v = lv[i]; if (v < 0.02) continue;
        const x = i * step + 1.5, hh = Math.max(1, v * half), hot = x <= played ? 1 : 0.55;
        g2.fillStyle = 'rgba(255,110,20,' + (0.35 * hot) + ')'; g2.fillRect(x - 2, cy - hh * 1.08, 5, hh * 2.16);
        g2.fillStyle = 'rgba(255,170,60,' + (0.85 * hot) + ')'; g2.fillRect(x - 0.75, cy - hh, 2, hh * 2);
        if (v > 0.35) { g2.fillStyle = 'rgba(255,240,200,' + (0.9 * hot * (v - 0.3)) + ')'; g2.fillRect(x - 0.5, cy - hh * 0.6, 1.2, hh * 1.2); }
      }
      g2.fillStyle = 'rgba(255,200,120,' + (live ? 0.55 : 0.25) + ')'; g2.fillRect(0, cy - 0.5, played, 1);
      g2.globalCompositeOperation = 'source-over';
    };
    requestAnimationFrame(draw);
    bar.addEventListener('click', (ev) => { const d = songDur(findMedia()); if (!(d > 0)) return; const r = bar.getBoundingClientRect(); songSeek(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * d); });
    win.append(h('i', 'screw tl'), h('i', 'screw tr'), h('i', 'screw bl'), h('i', 'screw br'), art, info, ctl);
    (studio.consoleEl || ui).appendChild(win);
    studio.npEl = win; studio.npHome = studio.consoleEl;
    let lastArt = '';
    setInterval(() => {
      const md = navigator.mediaSession?.metadata;
      title.textContent = md?.title || '\u2014'; artist.textContent = md?.artist || '';
      const src = md?.artwork?.length ? md.artwork[md.artwork.length - 1].src : '';
      if (src !== lastArt) { lastArt = src; if (src) art.src = src; else art.removeAttribute('src'); art.style.visibility = src ? 'visible' : 'hidden'; }
      const m = findMedia();
      const playing = !!m && !m.paused;
      playBtn.textContent = playing ? '\u275A\u275A' : '\u25B6'; playBtn.classList.toggle('on', playing);
      const sd = songDur(m), sp = Math.min(songPos(m), sd || 0);
      const dur = sd > 0 ? Math.round(sd) : 0;
      if (dur !== tickDur) buildTicks(dur);
      if (sd > 0) { fill.style.width = (sp / sd * 100) + '%'; times.textContent = fmtTime(sp) + ' / ' + fmtTime(sd); }
      else { fill.style.width = '0%'; times.textContent = ''; }
    }, 500);
  }

  // Top-bar meters: two analog VUs + master volume knob beside the YTM search bar. They show what YouTube Music plays even without capture:
  // if the stem/EQ graph is not running, a passive media.captureStream() tap (analyser only, not connected to any output) feeds them.
  function studioBuildBrand(ui) {
    const plate = h('a', 'brand', null, { 'aria-label': 'YouTube Music home', href: 'https://music.youtube.com/' });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 40 28'); svg.setAttribute('class', 'brandicon');
    const rect = document.createElementNS(NS, 'rect'); rect.setAttribute('width', '40'); rect.setAttribute('height', '28'); rect.setAttribute('rx', '8'); rect.setAttribute('fill', '#e0221b');
    const tri = document.createElementNS(NS, 'path'); tri.setAttribute('d', 'M16 8l11 6-11 6z'); tri.setAttribute('fill', '#fff');
    svg.append(rect, tri);
    const name = h('div', 'brandname'); name.append(h('span', 'by', 'YouTube'), h('span', 'bm', ' Music'));
    const sub = h('div', 'brandsub', 'STUDIO');
    const txt = h('div', 'brandtxt'); txt.append(name, sub);
    plate.append(svg, txt);
    ui.appendChild(plate);
    // The visible logo is a light-DOM copy of the shelf-title neon plate (same wires, current, flicker, heat, cables, sparks: one CSS system in skinCss).
    const mount = () => {
      if (!document.body) { setTimeout(mount, 300); return; }
      if (document.getElementById('poc-brand')) return;
      const a = document.createElement('a'); a.id = 'poc-brand'; a.href = 'https://music.youtube.com/'; a.setAttribute('aria-label', 'YouTube Music home');
      const t = document.createElement('span'); t.className = 'poc-ntitle';
      const logo = document.createElement('span'); logo.className = 'poc-logo';
      logo.append(svg.cloneNode(true), txt.cloneNode(true)); t.appendChild(logo);
      a.appendChild(t); document.body.appendChild(a);
    };
    mount();
  }

  // Living background: an overlay in the background image's own pixel space (1920x1081, scaled like 'cover'), so lamps flicker,
  // the red valve wheel turns, steam rises and the small gauge's needle wanders exactly over the painted objects.
  function studioBgFx() {
    const IW = 1920, IH = 1081;
    const mk = (cls, x, y, w, hh, extra) => { const e = document.createElement('i'); e.className = 'fx ' + cls; Object.assign(e.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' }, extra || {}); return e; };
    const mount = () => {
      if (!document.body) { setTimeout(mount, 300); return; }
      if (document.getElementById('poc-bgfx')) return;
      const box = document.createElement('div'); box.id = 'poc-bgfx';
      const sp = document.createElement('div'); sp.className = 'fxspace'; box.appendChild(sp);
      // lamps (centre x, centre y, w, h, delay)
      for (const [x, y, w, hh, d] of [[274, 596, 46, 78, 0], [1840, 280, 52, 76, -1.7], [1741, 698, 34, 56, -3.1], [1856, 690, 86, 116, -0.8]]) sp.appendChild(mk('lamp', x - w, y - hh, w * 2, hh * 2, { animationDelay: d + 's', animationDuration: (2.6 + Math.abs(d) * 0.37) + 's' }));
      sp.appendChild(mk('valvebg', 1618, 675, 72, 72));
      sp.appendChild(mk('valve', 1618, 675, 72, 72));
      sp.appendChild(mk('gauge', 278, 817, 60, 60));
      const ndl = mk('needle', 307, 829, 2, 19); sp.appendChild(ndl); sp.appendChild(mk('hub', 305, 844, 6, 6));
      // the painted steam itself (cut out by differencing the background against its smoke-free twin), looped as 3 overlapping rising copies per vent
      for (const [cls, x, y, w, hh] of [['smoke r', 1707, 395, 142, 177], ['smoke l', 77, 452, 114, 160]]) for (let i = 0; i < 3; i += 1) sp.appendChild(mk(cls, x, y, w, hh, { animationDelay: (-i * 1.6) + 's' }));
      document.body.appendChild(box);
      const fit = () => { const vw = document.documentElement.clientWidth, vh = window.innerHeight; const sc = Math.max(vw / IW, vh / IH); sp.style.transform = 'translate(' + (vw - IW * sc) / 2 + 'px,' + (vh - IH * sc) / 2 + 'px) scale(' + sc + ')'; };
      fit(); window.addEventListener('resize', fit);
    };
    mount();
  }

  // Steampunk strip under the header: caps + stretchy tubes + a centre ornament (gauge, lamps, gears), all pre-cut from one panel image.
  function studioSparks() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const arm = (sp) => {
      sp.style.left = rnd(3, 97) + '%'; // anywhere along the grid wires
      sp.style.top = rnd(10, 92) + '%';
      const ang = rnd(0, Math.PI * 2), dist = rnd(14, 44); // any direction: up, down, left, right, diagonal
      sp.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      sp.style.setProperty('--dy', Math.sin(ang) * dist * 0.8 + 'px');
      sp.style.animationDuration = rnd(0.5, 3.2) + 's'; // burst = first ~7 % of the cycle (35-220 ms)
    };
    setInterval(() => {
      let titles = [];
      try { titles = document.querySelectorAll(':is(ytmusic-carousel-shelf-basic-header-renderer yt-formatted-string.title, .poc-ntitle)'); } catch { return; }
      for (const t of titles) {
        if (t.querySelector(':scope > .poc-spark')) continue;
        for (let i = 0; i < 8; i += 1) {
          const sp = document.createElement('i'); sp.className = 'poc-spark';
          arm(sp); sp.style.animationDelay = rnd(0, 2.5) + 's';
          sp.addEventListener('animationiteration', () => arm(sp));
          t.appendChild(sp);
        }
      }
    }, 1500);
  }

  // Two chains run down both sides of the page content and move with the scroll; every framed shelf is hooked onto them with brass brackets,
  // so scrolling looks like the chains haul the plates up.
  function studioBuildChains(ui) {
    const l = h('div', 'chain l'), r = h('div', 'chain r');
    const gl = h('i', 'chgear l'), gr = h('i', 'chgear r');
    ui.append(l, r, gl, gr);
    const scroller = () => document.scrollingElement || document.documentElement;
    let frame = 0;
    const draw = () => { frame = 0; const y = '0 ' + (-Math.round(scroller().scrollTop)) + 'px'; l.style.backgroundPosition = y; r.style.backgroundPosition = y; };
    window.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(draw); }, { capture: true, passive: true });
    const sel = 'ytmusic-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)), ytmusic-shelf-renderer:not(:has(ytmusic-two-row-item-renderer))';
    const place = () => {
      if (document.hidden) return;
      const guide = document.getElementById('guide');
      const gw = guide ? guide.getBoundingClientRect().right : 300;
      const left = gw, right = window.innerWidth - 26; // chain strip: just right of the left panel, just left of the page scrollbar
      l.style.left = left + 'px'; r.style.left = (right - 38) + 'px'; gl.style.left = (left + 19 - 62) + 'px'; gr.style.left = (right - 19 - 62) + 'px';
      let shelves = []; try { shelves = document.querySelectorAll(sel); } catch { return; }
      for (const sh of shelves) {
        const rc = sh.getBoundingClientRect(); if (!rc.width) continue;
        let hooks = sh.querySelectorAll(':scope > .poc-hook');
        if (hooks.length < 4) {
          for (const x of hooks) x.remove();
          for (const side of ['l', 'r']) for (const pos of ['t', 'b']) { const k = document.createElement('i'); k.className = 'poc-hook ' + side + ' ' + pos; sh.appendChild(k); }
          hooks = sh.querySelectorAll(':scope > .poc-hook');
        }
        const cs = getComputedStyle(sh), bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
        const cl = left + 19, cr = right - 19, HW = 44; // chain centres; a clamp is centred on its chain and reaches in to just inside the shelf frame
        const lx0 = cl - HW, lx1 = Math.max(cl + HW, rc.left + 14), rx1 = cr + HW, rx0 = Math.min(cr - HW, rc.right - 14);
        for (const k of hooks) {
          if (k.classList.contains('l')) { k.style.width = (lx1 - lx0) + 'px'; k.style.left = (lx0 - rc.left - bl) + 'px'; k.style.right = ''; }
          else { k.style.width = (rx1 - rx0) + 'px'; k.style.right = ((rc.right - br) - rx1) + 'px'; k.style.left = ''; }
                }
      }
    };
    setInterval(place, 600); window.addEventListener('resize', place); place(); draw();
  }

  function studioBuildSteamPanel(ui) {
    const strip = h('div', 'steam');
    strip.append(h('i', 'sp capl'), h('i', 'sp tubel'), h('i', 'sp orn'), h('i', 'sp tuber'), h('i', 'sp capr'));
    ui.appendChild(strip);
  }

  function studioBuildWinButtons(ui) {
    const wrap = h('div', 'winbtns');
    for (const [cmd, glyph, label] of [['min', '–', 'Minimize'], ['max', '□', 'Maximize or restore'], ['close', '✕', 'Close']]) {
      const b = h('button', 'winbtn' + (cmd === 'close' ? ' x' : ''), glyph, { type: 'button', 'aria-label': label });
      b.addEventListener('click', () => ipcRenderer.send('poc:win', cmd));
      wrap.appendChild(b);
    }
    ui.append(h('div', 'dragstrip'), wrap);
  }

  // Graphic EQ: a compact strip in the header (between search and VU meters) and, under it, a fold-down full-size panel of the same
  // width. Both views drive the same geqState. Faders: drag / mouse wheel (1 dB) / double-click = 0 dB.
  function studioBuildGeq(ui) {
    const LBL = ['32', '63', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
    const views = []; // { caps, fills, trks, capH }
    let changed = () => {};
    const set = (i, v) => { geqState.gains[i] = Math.max(-12, Math.min(12, Math.round(v))); geqState.preset = ''; changed(); };
    const buildBands = (parent, capH, cls) => {
      const v = { caps: [], fills: [], trks: [], capH };
      if (capH) parent.style.setProperty('--caph', capH + 'px');
      GEQ_FREQS.forEach((fq, i) => {
        const col = h('div', 'geqcol ' + cls), tr = h('div', 'geqtrk'), fl = h('i', 'geqfill'), cp = h('i', 'geqcap');
        tr.append(fl, cp); col.append(h('span', 'geqlbl', LBL[i]), tr); parent.appendChild(col);
        v.caps.push(cp); v.fills.push(fl); v.trks.push(tr);
        const fromY = (y) => { const r = tr.getBoundingClientRect(), ch = cp.getBoundingClientRect().height || capH; set(i, (1 - (y - r.top - ch / 2) / Math.max(1, r.height - ch)) * 24 - 12); };
        tr.addEventListener('pointerdown', (e) => {
          e.preventDefault(); try { tr.setPointerCapture(e.pointerId); } catch {}
          fromY(e.clientY);
          const mv = (ev) => fromY(ev.clientY);
          const up = () => { tr.removeEventListener('pointermove', mv); tr.removeEventListener('pointerup', up); tr.removeEventListener('pointercancel', up); };
          tr.addEventListener('pointermove', mv); tr.addEventListener('pointerup', up); tr.addEventListener('pointercancel', up);
        });
        tr.addEventListener('dblclick', () => set(i, 0));
        tr.addEventListener('wheel', (e) => { e.preventDefault(); set(i, geqState.gains[i] + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
      });
      views.push(v);
    };
    const names = Object.keys(GEQ_PRESETS);
    const step = (d) => { let k = names.indexOf(geqState.preset); k = k < 0 ? (d > 0 ? 0 : names.length - 1) : (k + d + names.length) % names.length; geqState.preset = names[k]; geqState.gains = GEQ_PRESETS[names[k]].slice(); changed(); };
    const nameEls = [], pwEls = [];
    const buildPreset = () => {
      const pl = h('button', 'geqarr', '\u25C0', { type: 'button', 'aria-label': 'Previous EQ preset' });
      const pr = h('button', 'geqarr', '\u25B6', { type: 'button', 'aria-label': 'Next EQ preset' });
      const pn = h('div', 'geqname'); nameEls.push(pn);
      pl.addEventListener('click', () => step(-1)); pr.addEventListener('click', () => step(1));
      const pre = h('div', 'geqpre'); pre.append(pl, pn, pr); return pre;
    };
    const buildPower = (cls) => {
      const pw = h('button', 'geqpw ' + (cls || ''), null, { type: 'button', 'aria-label': 'Graphic EQ on / off' });
      pw.addEventListener('click', () => { geqState.on = !geqState.on; changed(); }); pwEls.push(pw); return pw;
    };
    // compact strip
    const box = h('div', 'geq');
    const bands = h('div', 'geqbands');
    buildBands(bands, 14, 'sm');
    const tab = h('button', 'geqtab', 'EQ \u25BC', { type: 'button', 'aria-label': 'Open the graphic equalizer panel' });
    box.append(buildPower(), bands, buildPreset(), tab, h('div', 'geqlock', 'STUDIO EQ ACTIVE'));
    // fold-down panel
    const pan = h('div', 'geqpan');
    const scr = h('div', 'geqscr'), grid = h('div', 'geqgrid'), pbands = h('div', 'geqbands big');
    for (const side of ['l', 'r']) { const sc = h('div', 'geqscale ' + side); for (const t of ['+12', '+6', '0', '\u22126', '\u221212']) sc.appendChild(h('span', null, t)); scr.appendChild(sc); }
    scr.append(grid, pbands, h('span', 'geqhz', 'Hz'));
    buildBands(pbands, 26, 'lg');
    const reset = h('button', 'geqreset', null, { type: 'button', 'aria-label': 'Reset all bands to 0 dB' });
    reset.addEventListener('click', () => { geqState.gains = GEQ_PRESETS.Flat.slice(); geqState.preset = 'Flat'; changed(); });
    const foot = h('div', 'geqfoot'); foot.append(buildPower('big'), buildPreset(), reset);
    pan.append(h('i', 'geqtitle'), h('i', 'geqlamp l'), h('i', 'geqlamp r'), scr, foot, h('div', 'geqlock', 'STUDIO EQ ACTIVE'));
    let mounted = false;
    studio.geqMount = () => { if (mounted || !studio.eqGeqHost) return; mounted = true; const H = studio.eqGeqHost; for (const side of ['l', 'r']) { const sc = h('div', 'geqscale ' + side); for (const t of ['+12', '+6', '0', '−6', '−12']) sc.appendChild(h('span', null, t)); H.appendChild(sc); }
      const bb = h('div', 'geqbands big'); H.append(h('div', 'geqgrid'), bb, h('span', 'geqhz', 'Hz')); buildBands(bb, 0, 'md'); studio.eqGeqPreHost.append(buildPreset()); draw(); };
    ui.append(box, pan);
    const setOpen = (o) => { pan.classList.toggle('open', o); tab.textContent = o ? 'EQ \u25B2' : 'EQ \u25BC'; tab.setAttribute('aria-label', o ? 'Close the graphic equalizer panel' : 'Open the graphic equalizer panel'); };
    tab.addEventListener('click', () => setOpen(!pan.classList.contains('open')));
    studio.geqOpen = setOpen;
    // the panel stays open until the EQ button is pressed again (no outside-click / Esc close)
    const draw = () => {
      for (const el of [box, pan]) { el.classList.toggle('off', !geqState.on); el.classList.toggle('locked', paramLive()); }
      studio.eqModeSync?.();
      for (const pw of pwEls) pw.setAttribute('aria-pressed', String(geqState.on));
      for (const pn of nameEls) pn.textContent = geqState.preset || 'Custom';
      for (const v of views) geqState.gains.forEach((g, i) => {
        const p = (g + 12) / 24;
        v.caps[i].style.bottom = 'calc(' + p + ' * (100% - var(--caph)))';
        v.fills[i].style.height = 'calc(' + p + ' * (100% - var(--caph)) + var(--caph) / 2)';
        v.trks[i].title = LBL[i] + ' Hz: ' + (g > 0 ? '+' : '') + g + ' dB';
      });
    };
    changed = () => { applyGeq(); saveGeq(); draw(); ensurePassiveGraph(); };
    studio.geqSync = draw;
    studio.geqMount();
    const place = () => {
      const sb = document.querySelector('ytmusic-search-box');
      const vu = box.parentNode && box.parentNode.querySelector('.topvu');
      const l = (sb ? sb.getBoundingClientRect().right : 700) + 20;
      const r = vu && vu.style.display !== 'none' ? vu.getBoundingClientRect().left - 20 : window.innerWidth - 220;
      const w = Math.min(640, r - l), show = w >= 430;
      box.style.display = show ? 'flex' : 'none'; box.style.left = l + 'px'; box.style.width = w + 'px';
      pan.style.left = l + 'px'; pan.style.width = Math.max(w, 560) + 'px'; pan.style.height = Math.round(Math.max(w, 560) * 0.5) + 'px';
      if (!show) setOpen(false);
    };
    window.addEventListener('resize', place); setInterval(place, 1000); place(); draw();
  }

  function studioBuildTopMeters(ui) {
    const box = h('div', 'topvu');
    const needles = [];
    for (const label of ['L', 'R']) {
      const d = h('div', 'vu');
      d.append(h('span', 'lbl l', label), h('span', 'lbl c', 'VU'), h('i', 'nd'));
      const w = h('div', 'vuw'); w.appendChild(d); box.appendChild(w); needles.push(d.querySelector('.nd'));
    }
    const vol = (() => { const m = findMedia(); return m ? m.volume : 1; })();
    let volume = vol, dragging = false;
    let holdUntil = 0;
    const setVol = (v) => { // YTM keeps its own volume state: set it through the page's player API (main world), and the element directly
      volume = v; holdUntil = performance.now() + 1500; const m = findMedia(); if (m) m.volume = v;
      try { webFrame.executeJavaScript('(function(){var p=document.getElementById("movie_player");if(p&&p.setVolume)p.setVolume(' + Math.round(v * 100) + ');})()'); } catch {}
    };
    let kn = null; // 3 pre-rendered frames of the knob's ribbed skirt, each 7.5 deg of rotation on (36 steps over the sweep): the ribs travel as it turns
    const frame = () => { if (kn) { const i = Math.floor(volume * 36 + 1e-6) % 3; for (let k = 0; k < 3; k += 1) kn.classList.toggle('f' + k, k === i); } };
    const knob = studioKnob('VOLUME', 'red big vk f0', () => { frame(); return volume; }, (v) => { dragging = true; setVol(v); }, 1, () => { dragging = false; });
    kn = knob.querySelector('.knob'); frame();
    const kw = h('div', 'knobw'); kw.appendChild(knob); box.appendChild(kw);
    ui.appendChild(box);
    let tapCtx = null, tapMedia = null, tapStream = null, tapKey = '', tapAn = null;
    const ensureTap = () => {
      const m = findMedia(); if (!m || typeof m.captureStream !== 'function') return null;
      try {
        if (mediaStreamFor(m) !== tapStream) { tapMedia = m; tapStream = mediaStreamFor(m); tapKey = ''; tapAn = null; } // ONE stream per element: captureStream() returns fresh tracks every call
        const tr = liveTrack(tapStream); if (!tr) return tapAn;
        if (tr.id === tapKey && tapAn) return tapAn;
        if (!tapCtx || tapCtx.state === 'closed') tapCtx = new AudioContext({ latencyHint: 'playback' });
        if (tapCtx.state === 'suspended') tapCtx.resume().catch(() => {});
        const src = tapCtx.createMediaStreamSource(new MediaStream([tr]));
        const sp = tapCtx.createChannelSplitter(2), a = [tapCtx.createAnalyser(), tapCtx.createAnalyser()];
        a[0].fftSize = a[1].fftSize = 2048; src.connect(sp); sp.connect(a[0], 0); sp.connect(a[1], 1);
        tapKey = tr.id; tapAn = a; return a;
      } catch { return null; }
    };
    const buf = new Float32Array(2048), angles = [-39, -39];
    const rmsDb = (an) => { an.getFloatTimeDomainData(buf); let t = 0; for (let i = 0; i < buf.length; i += 1) t += buf[i] * buf[i]; return t > 0 ? 10 * Math.log10(t / buf.length) : -100; };
    const angleOf = (db) => Math.max(-39, Math.min(39, db <= -18 ? 20 + (db + 18) * 2.95 : 20 + (db + 18) * 1.9));
    const fit = () => { // the meter block shrinks with the window and hides when it would collide with the search field
      try { document.documentElement.style.setProperty('--poc-rz', String(Math.max(1, Math.min(1.5, (window.innerWidth - 940) / 220)).toFixed(2))); } catch {}
      const z = Math.min(1, (window.innerWidth - 240 - 850) / 540);
      const only = z < 0.45; // too narrow for the meters: keep just the volume knob
      box.classList.toggle('knob-only', only); box.style.display = 'flex'; box.style.zoom = only ? '1' : String(Math.max(0.45, z));
      if (only) { // order in the narrow header: search | VOLUME | cast | account: the knob sits just left of the right-hand icons
        const rc = document.querySelector('ytmusic-nav-bar #right-content');
        const xs = rc ? [...rc.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 8).map((r) => r.left) : [];
        const left = xs.length ? Math.min(...xs) : window.innerWidth - 150;
        box.style.right = 'auto'; box.style.left = Math.max(0, left - 96) + 'px';
      } else { box.style.left = ''; box.style.right = ''; }
    };
    window.addEventListener('resize', fit); fit(); setInterval(fit, 1000);
    let lastTapCheck = 0, deadTicks = 0, lastHeal = 0;
    setInterval(() => {
      if (document.hidden) return;
      let ans = masterEq?.anL ? [masterEq.anL, masterEq.anR] : null;
      if (!ans) { const now = performance.now(); if (!tapAn || now - lastTapCheck > 1500) { lastTapCheck = now; ensureTap(); } ans = tapAn; }
      if (tapCtx && tapCtx.state === 'suspended') tapCtx.resume().catch(() => {});
      studio.vuAns = ans; // shared with the player-bar spectrum
      if (ans && ans === tapAn) { // self-heal a dead passive tap
        const m = findMedia(), audible = m && !m.paused && !m.muted && m.volume > 0.01 && m.currentTime > 1;
        if (audible && rmsDb(ans[0]) < -95 && rmsDb(ans[1]) < -95) { deadTicks += 1; } else deadTicks = 0;
        if (deadTicks > 25 && performance.now() - lastHeal > 2000) { lastHeal = performance.now(); deadTicks = 0; mediaStreamReset(m); tapAn = null; lastTapCheck = 0; }
      }
      needles.forEach((n, i) => {
        const target = ans ? angleOf(rmsDb(ans[i])) : -39;
        angles[i] += (target - angles[i]) * 0.3;
        n.style.transform = 'rotate(' + angles[i].toFixed(1) + 'deg)';
      });
      if (!dragging && performance.now() > holdUntil) { const m = findMedia(); if (m && Math.abs(m.volume - volume) > 0.01) { volume = m.volume; knob.redraw(); } }
    }, 40);
  }

  // Chord detection prototype (listens to the full stereo mix). Source: the capture graph's output when it runs, else a passive media.captureStream() tap.
  // Method: 16384-point spectrum -> peak-picked, tuning-tolerant chroma (12 pitch classes) + a bass chroma for the root -> cosine match with 24 major/minor triads
  // -> exponential smoothing + hysteresis so the chord only changes when a new one wins for ~0.5 s.
  function studioBuildChords(ui) {
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const box = h('div', 'chordbox');
    const cur = h('div', 'chcur', '\u2014'), lbl = h('div', 'chlbl', 'CHORD'), hist = h('div', 'chhist');
    box.append(lbl, cur, hist);
    ui.appendChild(box);
    const tmpl = []; // [{name, root, v}]
    for (let r = 0; r < 12; r += 1) {
      for (const [suffix, third] of [['', 4], ['m', 3]]) {
        const v = new Float32Array(12); v[r] = 1.1; v[(r + third) % 12] = 0.9; v[(r + 7) % 12] = 0.95;
        let n = 0; for (let i = 0; i < 12; i += 1) n += v[i] * v[i]; n = Math.sqrt(n); for (let i = 0; i < 12; i += 1) v[i] /= n;
        tmpl.push({ name: NAMES[r] + suffix, root: r, v });
      }
    }
    const FFT = 16384;
    let tapCtx = null, tapMedia = null, tapStream = null, tapTrack = '', tapAn = null;
    const getAnalyser = () => {
      if (masterEq?.context && masterEq.outNode) { // capture / stems running: tap its output
        if (!masterEq.chordAn) { const a = masterEq.context.createAnalyser(); a.fftSize = FFT; a.smoothingTimeConstant = 0; masterEq.outNode.connect(a); masterEq.chordAn = a; }
        return { an: masterEq.chordAn, sr: masterEq.context.sampleRate };
      }
      const m = findMedia(); if (!m || typeof m.captureStream !== 'function') return null;
      try {
        if (mediaStreamFor(m) !== tapStream) { tapMedia = m; tapStream = mediaStreamFor(m); tapTrack = ''; tapAn = null; }
        const tr = liveTrack(tapStream); if (!tr) return tapAn ? { an: tapAn, sr: tapCtx.sampleRate } : null;
        if (tr.id !== tapTrack || !tapAn) {
          if (!tapCtx || tapCtx.state === 'closed') tapCtx = new AudioContext({ latencyHint: 'playback' });
          if (tapCtx.state === 'suspended') tapCtx.resume().catch(() => {});
          const src = tapCtx.createMediaStreamSource(new MediaStream([tr]));
          const a = tapCtx.createAnalyser(); a.fftSize = FFT; a.smoothingTimeConstant = 0; src.connect(a);
          tapTrack = tr.id; tapAn = a;
        }
        return { an: tapAn, sr: tapCtx.sampleRate };
      } catch { return null; }
    };
    let buf = null, chr = new Float32Array(12), bas = new Float32Array(12);
    let curIdx = -1, candIdx = -1, candN = 0, songKey = '', log = [];
    const render = () => {
      cur.textContent = curIdx >= 0 ? tmpl[curIdx].name : '\u2014';
      hist.textContent = log.slice(-6).map((e) => fmtTime(e.t) + ' ' + e.name).join('   ');
    };
    const step = () => {
      if (document.hidden) return;
      const md = navigator.mediaSession?.metadata, key = md ? md.artist + '|' + md.title : '';
      if (key !== songKey) { songKey = key; log = []; curIdx = -1; chr.fill(0); bas.fill(0); render(); }
      const src = getAnalyser(); if (!src) return;
      const an = src.an, sr = src.sr;
      if (!buf || buf.length !== an.frequencyBinCount) buf = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(buf);
      let mx = -200; for (let k = 4; k < 1200; k += 1) if (buf[k] > mx) mx = buf[k];
      const c = new Float32Array(12), b = new Float32Array(12);
      if (mx > -85) {
        const hz = sr / FFT, kmin = Math.ceil(65 / hz), kmax = Math.min(buf.length - 2, Math.floor(2500 / hz));
        for (let k = kmin; k <= kmax; k += 1) {
          const v = buf[k]; if (v < mx - 45 || v < buf[k - 1] || v <= buf[k + 1]) continue; // spectral peaks within 45 dB of the loudest
          const f = k * hz, midi = 69 + 12 * Math.log2(f / 440), r = Math.round(midi), dev = Math.abs(midi - r);
          if (dev > 0.4) continue;
          const mag = Math.sqrt(10 ** (v / 20)) * (1 - dev) / (1 + f / 900), pc = ((r % 12) + 12) % 12;
          c[pc] += mag; if (f < 260) b[pc] += mag;
        }
      }
      let cs = 0, bs = 0; for (let i = 0; i < 12; i += 1) { cs += c[i]; bs += b[i]; }
      if (cs > 0) for (let i = 0; i < 12; i += 1) { chr[i] = chr[i] * 0.7 + 0.3 * (c[i] / cs); bas[i] = bas[i] * 0.7 + 0.3 * (bs > 0 ? b[i] / bs : 0); }
      else for (let i = 0; i < 12; i += 1) { chr[i] *= 0.85; bas[i] *= 0.85; }
      if (cs <= 0) { if (curIdx !== -1) { curIdx = -1; render(); } return; }
      let cn = 0; for (let i = 0; i < 12; i += 1) cn += chr[i] * chr[i]; cn = Math.sqrt(cn) || 1;
      let best = -1, bestScore = -1, curScore = -1;
      for (let t = 0; t < tmpl.length; t += 1) {
        let dot = 0; const v = tmpl[t].v; for (let i = 0; i < 12; i += 1) dot += chr[i] * v[i];
        const score = dot / cn + 0.3 * bas[tmpl[t].root];
        if (score > bestScore) { bestScore = score; best = t; }
        if (t === curIdx) curScore = score;
      }
      if (best === curIdx) { candN = 0; return; }
      if (best === candIdx) candN += 1; else { candIdx = best; candN = 1; }
      if (curIdx < 0 || (candN >= 4 && bestScore - curScore > 0.03)) {
        curIdx = best; candN = 0;
        log.push({ t: songPos(findMedia()), name: tmpl[best].name });
        render();
      }
    };
    setInterval(step, 120);
  }

  // Lyrics panel (right edge, mirror of the recordings panel): artist / album / title on top, synced lines scrolling below.
  // The song heard through the stems runs ~10 s behind the YouTube Music element, so the clock used for the lines subtracts that delay.
  const lyrState = { key: '', data: null, status: '', idx: -2, offset: 0, lines: [], busy: false, retryAt: 0 };
  try { lyrState.offset = Number(localStorage.getItem('ytm-poc-lyr-offset')) || 0; } catch {}
  function studioBuildLyrics(ui) {
    const panel = h('aside', 'lyr');
    const head = h('div', 'libhead');
    const closeBtn = h('button', 'libclose', '\u2715', { type: 'button', 'aria-label': 'Close lyrics' });
    head.append(h('span', 'libtitle', 'LYRICS'), closeBtn);
    const meta = h('div', 'lyrmeta');
    const artistEl = h('div', 'lyrartist'), albumEl = h('div', 'lyralbum'), titleEl = h('div', 'lyrsong');
    const sourceEl = h('div', 'lyralbum');
    meta.append(artistEl, albumEl, titleEl, sourceEl);
    const list = h('div', 'lyrlist');
    const sync = h('div', 'lyrsync');
    const offLbl = h('span', 'offlbl', '');
    const mk = (t, d) => { const b = h('button', 'btn libact', t, { type: 'button', 'aria-label': 'Lyrics ' + (d < 0 ? 'earlier' : 'later') }); b.addEventListener('click', () => { lyrState.offset = Math.round((lyrState.offset + d) * 10) / 10; try { localStorage.setItem('ytm-poc-lyr-offset', String(lyrState.offset)); } catch {} showOff(); }); return b; };
    const showOff = () => { offLbl.textContent = 'SYNC ' + (lyrState.offset >= 0 ? '+' : '') + lyrState.offset.toFixed(1) + ' s' + (lyrState.bufS ? ' \u00B7 BUFFER ' + lyrState.bufS.toFixed(1) + ' s' : ''); };
    sync.append(mk('\u2212', -0.5), offLbl, mk('+', 0.5));
    showOff();
    panel.append(h('i', 'screw tl'), h('i', 'screw tr'), head, meta, list, sync);
    const tab = h('button', 'lyrtab', 'LYRICS', { type: 'button', 'aria-label': 'Toggle lyrics panel' });
    ui.append(panel, tab);
    let open = false;
    const setOpen = (v) => { open = v; panel.classList.toggle('open', v); tab.classList.toggle('open', v); };
    studio.lyrOpen = setOpen; studio.lyrEl = panel;
    tab.addEventListener('click', () => setOpen(!open));
    closeBtn.addEventListener('click', () => setOpen(false));

    let lineEls = [];
    const renderLines = () => {
      list.textContent = ''; lineEls = [];
      const d = lyrState.data;
      if (!d || d.notFound || d.error) { list.appendChild(h('div', 'libempty', lyrState.status || 'No lyrics.')); return; }
      if (d.synced?.length) {
        lyrState.lines = d.synced;
        for (const l of d.synced) {
          const e = h('div', 'lyrline sync', l.text || '\u266A', { role: 'button', tabindex: '0', title: 'Jump the song to this line' });
          // click = jump the song to this line (lyric time minus the user's SYNC offset is the song position)
          // the clicked line stays lit until the lyric clock reaches it (with stems the heard audio arrives one buffer later)
          const go = () => { songSeek(Math.max(0, l.t - lyrState.offset)); lyrState.hold = { idx: lineEls.indexOf(e), t: l.t, until: Date.now() + 20000 }; lyrState.idx = -2; };
          e.addEventListener('click', go); e.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
          list.appendChild(e); lineEls.push(e);
        }
      }
      else { lyrState.lines = []; for (const t of d.plain.split(/\r?\n/)) list.appendChild(h('div', 'lyrline plain', t || '\u00A0')); }
      lyrState.idx = -2;
    };
    const load = async (md, media) => {
      lyrState.busy = true; lyrState.status = 'Searching lyrics...'; lyrState.data = null; renderLines();
      let res = null;
      try { res = await ipcRenderer.invoke('poc:lyrics', { artist: md.artist, title: md.title, album: md.album, duration: songDur(media) }); } catch {}
      lyrState.busy = false;
      if (lyrState.key !== [md.artist, md.title].join('|')) return; // the song changed meanwhile
      if (!res || res.error) { lyrState.status = 'Could not reach the lyrics service.'; lyrState.retryAt = Date.now() + 30000; lyrState.data = { error: true }; }
      else if (res.notFound) { lyrState.status = 'No lyrics found for this song.'; lyrState.data = res; }
      else { lyrState.data = res; sourceEl.textContent = res.source ? 'via ' + res.source + (res.synced?.length ? '' : ' (not synced)') : ''; }
      renderLines();
    };
    setInterval(() => {
      const md = navigator.mediaSession?.metadata;
      const media = findMedia();
      const song = md?.title ? { artist: md.artist || '', title: md.title, album: md.album || '' } : null;
      if (!song) { if (lyrState.key) { lyrState.key = ''; titleEl.textContent = ''; artistEl.textContent = ''; albumEl.textContent = ''; lyrState.data = null; lyrState.status = 'Play a song to see its lyrics.'; renderLines(); } return; }
      const key = [song.artist, song.title].join('|');
      const retry = lyrState.data?.error && Date.now() > lyrState.retryAt;
      if ((key !== lyrState.key || retry) && !lyrState.busy) {
        lyrState.key = key;
        artistEl.textContent = song.artist; albumEl.textContent = song.album; titleEl.textContent = song.title;
        load(song, media);
        return;
      }
      if (!open || !media || !lyrState.lines.length) return;
      const stems = captureActive && modeSelect?.value === 'stems' && stemPlayer; // only while stems are really playing; plain listening = no buffer
      const bufS = stems ? (stemPlayer.delayEstimateMs || 10000) / 1000 : 0; // the measured stem buffer: lyrics follow what is heard
      if (Math.abs(bufS - (lyrState.bufS || 0)) > 0.05) { lyrState.bufS = bufS; showOff(); }
      const now = songPos(media) - bufS * (media.playbackRate || 1) + lyrState.offset; // the buffer is real seconds; the lyric clock runs in song seconds, which pass at the tempo rate
      let idx = -1;
      for (let i = 0; i < lyrState.lines.length && lyrState.lines[i].t <= now; i += 1) idx = i;
      const hd = lyrState.hold;
      if (hd) { if (now >= hd.t - 0.05 || Date.now() > hd.until || now < hd.t - 30) lyrState.hold = null; else idx = hd.idx; }
      if (idx === lyrState.idx) return;
      lyrState.idx = idx;
      lineEls.forEach((e, i) => { e.classList.toggle('cur', i === idx); e.classList.toggle('past', i < idx); });
      const cur = lineEls[idx];
      if (cur) list.scrollTo({ top: Math.max(0, cur.offsetTop - list.clientHeight / 2 + cur.offsetHeight / 2), behavior: 'smooth' });
    }, 250);
    renderLines();
  }

  // Karaoke: one click = capture on, Stems mode, vocal stem muted, mic on, Vocal Lab on. Clicking again restores the previous mode, vocal mute/solo and Vocal Lab state.
  let karaoke = null;
  // Practice (Listen mode): microphone + Vocal Chain on, nothing recorded. The chain section is shown so it can be tweaked.
  const practice = { on: false, prevLab: false, sync: null };
  async function practiceToggle() {
    if (practice.on) { practiceOff(); return; }
    if (appMode !== 'listen' || karaoke) return;
    practice.prevLab = fxState.voc.on;
    await startMic();
    fxState.voc.on = true; saveFx(); applyVocalFxAll(); studio.syncVocalLab?.();
    practice.on = true; studio.consoleEl?.classList.add('practice');
  }
  function practiceOff() {
    if (!practice.on) return;
    practice.on = false; studio.consoleEl?.classList.remove('practice');
    if (!karaoke) { stopMic(); fxState.voc.on = practice.prevLab; saveFx(); applyVocalFxAll(); studio.syncVocalLab?.(); }
    practice.sync?.();
  }
  // LISTEN and KARAOKE are interlocked modes: the console shows only what the current mode needs ('idle' until one is chosen).
  let appMode = 'listen'; // the program opens in LISTEN (plain YouTube Music playback)
  function setAppMode(m) {
    if (m !== 'listen') practiceOff();
    appMode = m;
    studio.consoleEl?.classList.toggle('m-karaoke', m === 'karaoke');
    studio.consoleEl?.classList.toggle('m-listen', m === 'listen');
    if (m === 'karaoke') studio.lyrOpen?.(true); // the words are what you sing from
  }
  async function stopTake(info) { // finish and save the running take (stays in karaoke mode)
    info.textContent = 'SAVING...';
    const res = await stopRec();
    info.textContent = res.ok ? 'SAVED: ' + res.entry.name : 'SAVE FAILED';
    if (res.ok) { studio.libOpen?.(true); studio.libShowTab?.('raw'); }
  }
  let takePrep = false;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  function ensureHt() { // best separation, and the only one that splits drums and bass; the model is locked once capture runs
    if (captureActive || modelSelect.value === 'htdemucs') return;
    modelSelect.value = 'htdemucs'; modelSelect.dispatchEvent(new Event('change'));
  }
  function startMusic() { const m = findMedia(); if (m?.paused) { try { m.play()?.catch?.(() => {}); } catch {} } }
  async function endKaraokeRun() { // after a saved take: mic and stems off, music paused; the mode stays armed for the next take
    karaokeOff();
    if (captureActive) stopCapture();
    const m = findMedia(); if (m && !m.paused) { try { m.pause(); } catch {} }
  }
  // START KARAOKE / REC: set everything up, wait out the stem buffer with a visible countdown, then record from the top of the song.
  async function takeToggle(info) {
    if (rec.saving || takePrep) return;
    if (rec.active) { await stopTake(info); await endKaraokeRun(); return; }
    takePrep = true;
    let started = false;
    const bus = () => [...document.querySelectorAll('audio, video')].map((m) => graphs.get(m)).filter(Boolean);
    try {
      if (!karaoke) {
        ensureHt();
        info.textContent = 'BUFFERING, PLEASE WAIT...';
        if (libPlayer.mix) { libPause(); libDropMix(); }
        await karaokeToggle(info); // capture + stems + vocal muted + mic + vocal chain
        if (!karaoke) return; // karaokeToggle wrote the error
        setAppMode('karaoke');
      }
      const t0 = Date.now();
      while (!stemPlayer && karaoke && Date.now() - t0 < 60000) { info.textContent = 'BUFFERING, PLEASE WAIT...'; await sleepMs(250); }
      if (!stemPlayer || !karaoke) { if (karaoke) { info.textContent = 'STEMS DID NOT START'; await endKaraokeRun(); } return; }
      // Take from the top of the song: mute the stems, restart the song, and open them again exactly when the fresh audio reaches the output (the stems run ~10 s behind) -- recording starts at that moment.
      for (const g of bus()) g.stemBus.gain.setTargetAtTime(0, activeContext.currentTime, 0.02);
      const media = findMedia();
      if (media) { songSeek(0); if (media.paused) { try { media.play()?.catch?.(() => {}); } catch {} } }
      const tEnd = Date.now() + Math.max(3000, Math.round(stemPlayer.delayEstimateMs || 10000));
      for (;;) {
        const left = Math.ceil((tEnd - Date.now()) / 1000);
        if (left <= 0 || !karaoke) break;
        info.textContent = 'BUFFERING, PLEASE WAIT ' + left;
        await sleepMs(200);
      }
      if (!karaoke) return;
      for (const g of bus()) g.stemBus.gain.setTargetAtTime(1, activeContext.currentTime, 0.02);
      await startRec();
      started = rec.active;
      info.textContent = 'RECORDING - SING!';
    } finally {
      takePrep = false;
      if (!started && captureActive && karaoke) setMode('stems', false); // never leave the stems muted
    }
  }
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

  const STUDIO_CSS = (T) => `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { --dh: min(calc(100vw / 3), 84vh); --edge: #3a322c; --edge-hi: #5a4c40; --ink-dim: #cdbfa9; --brass: #d9b07a; --amber: #ffb347;
      font-family: "Bahnschrift", "Segoe UI Condensed", "Arial Narrow", system-ui, sans-serif; color: #e9dfd0; }
    .tab { position: fixed; left: calc(50% - 2.07vw); bottom: 0; transform: translateX(-50%); z-index: 2147483646; padding: 6px 22px 8px;
      border: 1px solid var(--edge-hi); border-bottom: 0; border-radius: 10px 10px 0 0; cursor: pointer;
      background: linear-gradient(#2c2622, #1b1816); color: var(--brass); font: 700 12px "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; letter-spacing: .2em;
      transition: bottom .35s cubic-bezier(.2,.8,.2,1); }
    .tab:hover { color: var(--amber); }
    .tab.open { bottom: var(--dh); }
    .drawer { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483645; height: var(--dh); transform: translateY(100%); visibility: hidden;
      transition: transform .35s cubic-bezier(.2,.8,.2,1), visibility 0s .35s; display: grid; grid-template-columns: 24px 1fr 24px;
      background: ${T('metal.jpg')} 0 0 / 256px 256px, #14110f; border-top: 2px solid var(--edge-hi); box-shadow: 0 -12px 40px #000c; }
    .drawer.open { transform: none; visibility: visible; transition: transform .35s cubic-bezier(.2,.8,.2,1); }
    .wood { background: ${T('wood.jpg')} center / 100% 100% no-repeat, #3a2012; box-shadow: inset 0 0 10px #000b, inset 0 0 0 1px #0006; }
    .drawer > .wood:last-child { transform: scaleX(-1); }
    .led.rec.on { background: #ff3b2f; box-shadow: 0 0 8px #ff3b2f; }
    .btn.recbtn { width: 64px; }
    .recinfo { margin: 6px 4px 0; font-size: 10px; font-weight: 700; letter-spacing: .1em; color: var(--ink-dim); text-shadow: 0 1px 2px #000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .libtab { position: fixed; left: 0; top: 38%; z-index: 2147483644; padding: 12px 6px; writing-mode: vertical-rl; cursor: pointer;
      border: 1px solid var(--edge-hi); border-left: 0; border-radius: 0 10px 10px 0; background: linear-gradient(90deg, #2c2622, #1b1816);
      color: var(--brass); font: 700 12px "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; letter-spacing: .2em; transition: left .3s cubic-bezier(.2,.8,.2,1); }
    .libtab:hover { color: var(--amber); }
        .np { position: relative; flex: 1 0 100%; display: flex; align-items: center; gap: 18px; box-sizing: border-box; margin-top: 4px;
      padding: 10px 18px; border: 1px solid #0009; border-radius: 10px; box-shadow: inset 0 0 18px #000a;
      background: linear-gradient(#ffffff0d, transparent 30%, #0006), ${T('metal.jpg')} 0 0 / 256px 256px, #14110f; }
    .chain.l, .chain.r { position: fixed; top: 144px; bottom: 124px; width: 38px; z-index: 2147483637; pointer-events: none; background: ${T('sk-chain.png')} 0 0 / 38px 74px repeat-y; filter: drop-shadow(1px 0 1px #000c); opacity: .95; }
    .chgear { position: fixed; top: 82px; width: 124px; height: 124px; z-index: 2147483638; pointer-events: none; background: ${T('sk-gear.png')} center / contain no-repeat; filter: drop-shadow(0 3px 5px #000c); animation: chg 60s linear infinite; }
    .chgear.r { animation-direction: reverse; } @keyframes chg { to { transform: rotate(360deg); } }
    .chain.l::after, .chain.r::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 26px; background: linear-gradient(#0d0a08, transparent); }
    .chordbox { display: none !important; } /* chord detection keeps running (experimental); the box is hidden until it gets a new home */
    .chordbox { position: fixed; left: 64px; top: 116px; height: 38px; z-index: 2147483639; display: flex; align-items: center; gap: 12px; padding: 0 14px; max-width: 560px; box-sizing: border-box; overflow: hidden;
      background: #0d0a08d9; border: 1px solid #5a4630; border-radius: 6px; box-shadow: inset 0 0 8px #000, 0 2px 6px #000a; pointer-events: none; }
    .chlbl { font: 700 9px "Barlow Condensed", sans-serif; letter-spacing: .2em; color: var(--brass); }
    .chcur { min-width: 56px; font: 400 28px/1 "Metamorphous", serif; color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99; }
    .chhist { font: 600 12px "Barlow Condensed", sans-serif; letter-spacing: .06em; color: #cdbfa9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .steam { display: none !important; } /* pipe strip under the header removed (user): the copper header plate sits directly on the content */
    .steam { position: fixed; left: 0; right: 0; top: 112px; height: 46px; z-index: 2147483638; display: flex; align-items: center; pointer-events: none; box-sizing: border-box; padding: 0 14px;
      background: linear-gradient(#0000008c, #00000030 30%, #0000005a), ${T('metal.jpg')} 0 0 / 256px 256px, #14110f; border-bottom: 2px solid #0a0807; box-shadow: 0 5px 14px #000c, inset 0 1px 0 #ffffff14; }
    .steam .sp { display: block; height: 44px; flex: none; background-repeat: no-repeat; background-position: center; background-size: 100% 100%; filter: drop-shadow(0 2px 2px #000a); }
    .steam .capl { width: 42px; background-image: ${T('sk-pan-capl.png')}; }
    .steam .capr { width: 42px; background-image: ${T('sk-pan-capr.png')}; }
    .steam .orn { width: 346px; background-image: ${T('sk-pan-orn.png')}; }
    .steam .tubel, .steam .tuber { flex: 1 1 0; min-width: 0; background-repeat: repeat-x; background-size: auto 100%; }
    .steam .tubel { background-image: ${T('sk-pan-tubel.png')}; }
    .steam .tuber { background-image: ${T('sk-pan-tuber.png')}; }
    .dragstrip { -webkit-app-region: drag; position: fixed; left: 0; top: 0; right: 130px; height: 10px; z-index: 2147483639; }
    .winbtns { -webkit-app-region: no-drag; position: fixed; top: 6px; right: 8px; z-index: 2147483641; display: flex; gap: 4px; }
    .winbtn { width: 24px; height: 18px; padding: 0; border: 1px solid #0009; border-radius: 4px; cursor: pointer; font: 700 11px/1 "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; color: var(--brass);
      background: linear-gradient(#3a322a, #1b1816); box-shadow: inset 0 1px 0 #ffffff1a, 0 1px 2px #000a; }
    .winbtn:hover { color: var(--amber); } .winbtn.x:hover { background: #7a2218; color: #fff; }
    .topvu { -webkit-app-region: no-drag; position: fixed; top: 8px; right: 240px; z-index: 2147483640; display: flex; align-items: center; gap: 14px; }
    .topvu .vuw { padding: 8px; border: 0; box-sizing: content-box; border-image: ${T('sk-logo.png')} 46 / 18px stretch; background: #0a0807; border-style: solid; border-color: transparent; border-width: 14px; padding: 0; background-clip: padding-box; }
    .topvu .vu { width: 112px; height: 64px; box-shadow: inset 0 0 10px #000a; border-radius: 2px; }
    .topvu .knob.big { background-image: ${T('sk-knob.png')}; }
    .topvu .vu .lbl { font-size: 10px; } .topvu .vu .lbl.c { font-size: 12px; }
    .topvu .knob-box { flex-direction: column; font-size: 9px; gap: 1px; }
    .topvu .knobw { padding: 0; border: 0; background: none; margin-left: 56px; }
    .topvu.knob-only { right: 22px; top: 6px; } .topvu.knob-only .vuw { display: none; } .topvu.knob-only .knobw { margin-left: 0; }
    .topvu .knobw .knob-box { position: relative; width: 88px; height: 100px; box-sizing: border-box; padding-top: 86px; display: block; text-align: center; }
    .topvu .knobw .knob-box::before { content: none; }
    .topvu .knobw .knob.big { position: absolute; left: 13px; top: 12px; width: 62px; height: 62px; background-image: ${T('sk-kn0.png')}; box-shadow: none; z-index: 1; border-radius: 0; }
    .topvu .knobw .knob.big.f0 { background-image: ${T('sk-kn0.png')}; }
    .topvu .knobw .knob.big.f1 { background-image: ${T('sk-kn1.png')}; }
    .topvu .knobw .knob.big.f2 { background-image: ${T('sk-kn2.png')}; }
    .topvu .knobw .knob.big::after { top: 2px; left: 49.5%; height: 9px; width: 1.5px; margin-left: -0.75px; border-radius: 1px; background: #24160a; box-shadow: 0 0 1px #ffe9b8aa; transform-origin: 50% 18.8px; transform: scaleY(.89) rotate(var(--a, 0deg)); filter: none; }
    .brand { -webkit-app-region: no-drag; position: fixed; left: 64px; top: 12px; width: 252px; height: 88px; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 0 14px; text-decoration: none; cursor: pointer;
      border: 16px solid transparent; border-width: 16px 14px; border-image: ${T('sk-logo.png')} 46 / 16px 14px stretch; background: #0a0807; background-clip: padding-box; z-index: 2147483640; }
    .brandicon { width: 34px; height: 24px; flex: none; filter: drop-shadow(0 1px 2px #000); }
    .brandtxt { min-width: 0; }
    .brandname { font: 700 21px/1 "Oswald", "Barlow Condensed", system-ui, sans-serif; color: #f1e6d3; white-space: nowrap; text-shadow: 0 1px 2px #000; letter-spacing: -.01em; }
    .brandname .bm { color: #ff6a3d; }
    .brandsub { margin-top: 5px; font: italic 700 9px/1 "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; letter-spacing: .18em; color: var(--brass); white-space: nowrap; } .topvu .knob.big::after { top: 9px; height: 16px; width: 4px; margin-left: -2px; transform-origin: 50% 21px; }
    .np.float { position: fixed; left: 12px; right: 12px; bottom: 10px; z-index: 2147483643; margin: 0; border-radius: 10px; height: 104px; padding: 6px 24px; }
    .tab.np-up { bottom: 124px; }
    .geq { -webkit-app-region: no-drag; position: fixed; top: 12px; height: 88px; z-index: 2147483640; display: flex; align-items: center; gap: 12px; box-sizing: border-box; padding: 4px 12px;
      border: 12px solid transparent; border-image: ${T('sk-geq-frame.png')} 46 / 12px stretch; background: radial-gradient(ellipse at 50% 0, #ff8a1f14, transparent 70%), #0d0907eb; background-clip: padding-box; box-shadow: 0 3px 8px #000a; }
    .geqpw { width: 42px; height: 42px; flex: none; padding: 0; border: 0; border-radius: 50%; cursor: pointer; background: ${T('sk-geq-pwr.png')} center / contain no-repeat; filter: drop-shadow(0 0 6px #ff9a3a99); transition: filter .15s; }
    .geq.off .geqpw { filter: grayscale(.9) brightness(.5); }
    .geqbands { flex: 1; min-width: 0; height: 100%; display: flex; justify-content: space-between; }
    .geqcol { width: 22px; display: flex; flex-direction: column; align-items: center; }
    .geqlbl { font: 600 9px/11px "Oswald", "Barlow Condensed", sans-serif; color: #f0d9a8; letter-spacing: .02em; text-shadow: 0 1px 1px #000; }
    .geqtrk { position: relative; flex: 1; width: 22px; margin-top: 1px; cursor: ns-resize; touch-action: none; }
    .geqtrk::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 7px; margin-left: -3.5px; border-radius: 4px; background: #050302; box-shadow: inset 0 1px 2px #000, 0 0 0 1px #6a4a26, 0 0 0 2px #140c06; }
    .geqfill { position: absolute; left: 50%; bottom: 0; width: 3px; margin-left: -1.5px; border-radius: 2px; background: linear-gradient(#ffd27a, #ff8a1f); box-shadow: 0 0 5px #ff8a1fcc; pointer-events: none; }
    .geqcap { position: absolute; left: 50%; width: 22px; height: 14px; margin-left: -11px; border-radius: 3px; background: ${T('sk-geq-cap.png')} center / 100% 100%; box-shadow: 0 2px 3px #000c; pointer-events: none; }
    .geqtrk:hover .geqcap { filter: brightness(1.2) drop-shadow(0 0 3px #ffb347); }
    .geq.off .geqfill { opacity: .25; box-shadow: none; }
    .geqpre { flex: none; display: flex; align-items: center; height: 30px; padding: 0 2px; border-radius: 15px; background: #070504; box-shadow: inset 0 1px 3px #000, 0 0 0 1px #6a4a26, 0 0 0 2px #140c06; }
    .geqarr { border: 0; background: none; color: #ffb347; font-size: 11px; padding: 0 6px; cursor: pointer; } .geqarr:hover { color: #ffe0a0; text-shadow: 0 0 4px #ffb347; }
    .geqname { min-width: 84px; text-align: center; font: 600 13px "Barlow Condensed", sans-serif; color: #f6e6c6; white-space: nowrap; }
    .geq.locked .geqbands, .geq.locked .geqpw, .geq.locked .geqpre { opacity: .3; pointer-events: none; filter: grayscale(.7); }
    .geqlock { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; pointer-events: none; font: 700 11px "Oswald", sans-serif; letter-spacing: .24em; color: #ffb347; text-shadow: 0 0 6px #ff8a1f, 0 1px 2px #000; }
    .geq.locked .geqlock { display: flex; }
    .geqtab { flex: none; height: 26px; padding: 0 9px; border: 0; border-radius: 13px; cursor: pointer; font: 700 10px "Oswald", sans-serif; letter-spacing: .12em; color: #ffd9a0;
      background: linear-gradient(#5a3a1c, #2a1a0c); box-shadow: inset 0 1px 0 #ffcf8a55, 0 0 0 1px #8a5a26, 0 2px 3px #000a; text-shadow: 0 1px 1px #000; }
    .geqtab:hover { color: #fff1d0; box-shadow: inset 0 1px 0 #ffcf8a88, 0 0 0 1px #c08a44, 0 0 8px #ff9a3a88; }
    .geq.locked .geqtab { opacity: 1; pointer-events: auto; filter: none; }
    /* fold-down full-size panel (same look as the reference artwork) */
    .geqpan { -webkit-app-region: no-drag; position: fixed; top: 104px; z-index: 2147483641; box-sizing: border-box; display: none;
      border: 18px solid transparent; border-image: ${T('sk-geq-frame.png')} 46 / 18px stretch; background: radial-gradient(ellipse at 50% 20%, #ff8a1f1a, transparent 65%), #0d0907; background-clip: padding-box; box-shadow: 0 10px 28px #000e; }
    .geqpan.open { display: block; animation: geqdrop .18s ease-out; }
    @keyframes geqdrop { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }
    .geqtitle { position: absolute; left: 50%; top: -22px; width: 54%; aspect-ratio: 770 / 96; transform: translateX(-50%); background: ${T('sk-geq-title.png')} center / 100% 100% no-repeat; filter: drop-shadow(0 3px 4px #000c); }
    /* lamps centred in the side gutters (between the frame and the screen, 11 % each), mirrored; they go dark when the EQ is off */
    .geqlamp { position: absolute; top: 15%; width: 8%; height: 60%; background: center / contain no-repeat; animation: poc-lamp 4.7s linear infinite; filter: drop-shadow(0 0 10px #ff9a3a88); transition: filter .25s; }
    .geqpan.off .geqlamp { animation: none; filter: grayscale(1) brightness(.32); }
    .geqlamp.l { left: 1.5%; background-image: ${T('sk-geq-lamp-l.png')}; } .geqlamp.r { right: 1.5%; background-image: ${T('sk-geq-lamp-r.png')}; animation-delay: -1.9s; }
    @keyframes poc-lamp { 0%, 40%, 44%, 100% { opacity: 1; } 41% { opacity: .55; } 42% { opacity: .95; } 43% { opacity: .7; } }
    .geqscr { position: absolute; left: 11%; right: 11%; top: 13%; bottom: 25%; border-radius: 8px; background: linear-gradient(#ffffff06, #00000040); box-shadow: inset 0 0 14px #000, 0 0 0 1px #6a4a26, 0 0 0 3px #1a0f08; }
    .geqgrid { position: absolute; left: 34px; right: 34px; top: calc(22px + 13px); bottom: 21px; pointer-events: none;
      background: linear-gradient(#c8954a40, #c8954a40) 0 0 / 100% 1px no-repeat, linear-gradient(#c8954a40, #c8954a40) 0 25% / 100% 1px no-repeat, linear-gradient(#e0b06a66, #e0b06a66) 0 50% / 100% 1px no-repeat, linear-gradient(#c8954a40, #c8954a40) 0 75% / 100% 1px no-repeat, linear-gradient(#c8954a40, #c8954a40) 0 100% / 100% 1px no-repeat; }
    .geqscale { position: absolute; top: calc(22px + 13px); bottom: 21px; width: 30px; display: flex; flex-direction: column; justify-content: space-between; font: 600 11px/0 "Oswald", sans-serif; color: #f0d9a8; text-shadow: 0 1px 1px #000; }
    .geqscale.l { left: 4px; text-align: right; } .geqscale.r { right: 2px; text-align: left; }
    .geqscale span { display: block; height: 0; }
    .geqhz { position: absolute; right: 8px; top: 6px; font: 600 11px "Oswald", sans-serif; color: #f0d9a8; }
    .geqbands.big { position: absolute; left: 38px; right: 38px; top: 6px; bottom: 8px; height: auto; }
    .geqcol.lg { width: 40px; } .geqcol.lg .geqlbl { font-size: 13px; line-height: 16px; }
    .geqcol.lg .geqtrk { width: 40px; margin-top: 4px; }
    .geqcol.lg .geqtrk::before { width: 13px; margin-left: -6.5px; border-radius: 7px; box-shadow: inset 0 2px 4px #000, 0 0 0 1px #8a6030, 0 0 0 3px #140c06; }
    .geqcol.lg .geqfill { width: 5px; margin-left: -2.5px; border-radius: 3px; box-shadow: 0 0 8px #ff8a1f; }
    .geqcol.lg .geqcap { width: 38px; height: 26px; margin-left: -19px; border-radius: 4px; box-shadow: 0 3px 5px #000d; }
    .geqfoot { position: absolute; left: 11%; right: 11%; bottom: 3%; height: 17%; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .geqpw.big { width: 54px; height: 54px; }
    .geqfoot .geqpre { flex: 1; height: 38px; max-width: 300px; justify-content: space-between; border-radius: 8px; }
    .geqfoot .geqname { font-size: 18px; } .geqfoot .geqarr { font-size: 15px; padding: 0 12px; }
    .geqreset { width: 46px; height: 46px; flex: none; padding: 0; border: 0; border-radius: 50%; cursor: pointer; background: ${T('sk-geq-reset.png')} center / contain no-repeat; filter: drop-shadow(0 2px 3px #000c); }
    .geqreset:hover { filter: drop-shadow(0 0 6px #ffb347aa) brightness(1.15); }
    .geqpan.off .geqfill { opacity: .25; box-shadow: none; } .geqpan.off .geqpw { filter: grayscale(.9) brightness(.5); }
    .geqpan.locked .geqscr, .geqpan.locked .geqfoot { opacity: .3; pointer-events: none; filter: grayscale(.7); }
    .geqpan.locked .geqlock { display: flex; font-size: 16px; }
    /* header: rounded brass logo plate (same pill frame as the search box), spaced STUDIO line, two glass lamps hanging over the pipe strip */
    .brand { display: none !important; }
    .brand { top: 16px; height: 76px; border-width: 20px 26px; border-image: ${T('sk-pill.png')} 72 / 20px 26px stretch; border-radius: 38px; padding: 0 4px; box-shadow: 0 4px 12px #000b; }
    .brandname { font-size: 24px; }
    .brandsub { margin-top: 6px; font: 600 11px/1 "Oswald", "Barlow Condensed", sans-serif; letter-spacing: .62em; color: #e6d3ad; text-align: center; padding-left: .62em; }
    .steam::before, .steam::after { content: ""; position: absolute; top: -14px; width: 26px; height: 64px; background: ${T('sk-lamp.png')} center / contain no-repeat; filter: drop-shadow(0 0 8px #ff9a3acc) drop-shadow(0 3px 3px #000c); animation: poc-lamp 5.3s linear infinite; }
    .steam::before { left: calc(50% - 250px); } .steam::after { right: calc(50% - 250px); animation-delay: -2.1s; }
    @keyframes poc-lamp { 0%, 40%, 44%, 100% { opacity: 1; } 41% { opacity: .55; } 42% { opacity: .95; } 43% { opacity: .7; } }
    .npticks { position: relative; height: 22px; margin-top: 1px; }
    .nptick { position: absolute; top: 0; transform: translateX(-50%); width: 28px; height: 22px; padding: 0; border: 0; background: none; cursor: pointer; color: var(--ink-dim); font: 700 9px "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; letter-spacing: .06em; }
    .nptick .tkline { position: absolute; left: 50%; top: 0; width: 1px; height: 5px; background: var(--brass); opacity: .6; }
    .nptick.major .tkline { height: 8px; opacity: 1; }
    .nptick .tklbl { position: absolute; left: 50%; top: 9px; transform: translateX(-50%); white-space: nowrap; }
    .nptick:hover { color: var(--amber); }
    .nptick:hover .tkline { background: var(--amber); }
    .npart { width: 64px; height: 64px; flex: none; border-radius: 4px; object-fit: cover; background: #050404; box-shadow: 0 0 0 2px #0a0807, 0 0 0 3px var(--edge); }
    .npinfo { flex: 1; min-width: 0; }
    .nptitle { font-size: 15px; font-weight: 800; color: #f1e6d3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px #000; }
    .npartist { font-size: 11px; letter-spacing: .12em; color: var(--brass); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .npmeta { font-size: 10px; letter-spacing: .08em; color: var(--ink-dim); margin-top: 4px; }
    .npctl { display: flex; gap: 6px; flex: none; }
    .btn.npbtn { width: 44px; height: 34px; font-size: 14px; }
    /* steampunk player bar: dark plate under a copper rod, glowing waveform as the progress track, round brass transport buttons */
    .np:is(.float,.st-lift) { left: 0; right: 0; bottom: 0; height: 124px; border-radius: 0; padding: 14px 30px 18px; border: 0; gap: 20px;
      background: #0b0806; border-image: ${T('sk-topplate.png')} 64 fill / 22px round;
      box-shadow: 0 -6px 18px #000c, inset 0 -1px 0 #ffffff12; }
    .np:is(.float,.st-lift) .npart { width: 62px; height: 62px; box-shadow: 0 0 0 2px #0a0807, 0 0 0 4px #9a6a2c, 0 0 10px #ff9a3a55; }
    .np:is(.float,.st-lift) .nptitle { font: 700 19px/1.15 "Barlow Condensed", "Barlow", sans-serif; letter-spacing: .02em; }
    .np:is(.float,.st-lift) .npartist { font: 600 14px "Barlow Condensed", "Barlow", sans-serif; letter-spacing: .04em; color: #cdbfa9; }
    .npbar.libbar { position: relative; height: 30px; margin-top: 4px; border: 0; border-radius: 0; cursor: pointer; overflow: visible;
      background: linear-gradient(transparent calc(50% - 1px), #ff9a3a59 calc(50% - 1px), #ff9a3a59 calc(50% + 1px), transparent calc(50% + 1px)) !important; box-shadow: none; }
    .npbar .libfill { position: relative; height: 100%; background: linear-gradient(transparent calc(50% - 1px), #ffc46b calc(50% - 1px), #ffc46b calc(50% + 1px), transparent calc(50% + 1px)) !important; box-shadow: none; filter: drop-shadow(0 0 3px #ff8a1fcc); }
    .npbar .npviz { position: absolute; left: 0; top: -12px; width: 100%; height: calc(100% + 24px); pointer-events: none; z-index: 1; }
    .npbar .libfill::after { content: ""; position: absolute; right: -1px; top: 2px; bottom: 2px; width: 2px; background: #ffe2a8; box-shadow: 0 0 6px 2px #ffb347; }
    .np:is(.float,.st-lift) .npticks { height: 16px; margin-top: 0; } .np:is(.float,.st-lift) .nptick .tklbl { top: 6px; } .np:is(.float,.st-lift) .nptick .tkline { height: 3px; } .np:is(.float,.st-lift) .nptick.major .tkline { height: 5px; }
    .npctl { align-items: center; gap: 10px; }
    .btn.npbtn { width: 42px; height: 42px; padding: 0; border: 0 !important; border-radius: 50%; font-size: 0 !important; color: transparent !important; background: center / contain no-repeat !important; box-shadow: none !important; filter: drop-shadow(0 2px 3px #000c); transition: filter .15s; }
    .btn.npbtn:hover { filter: drop-shadow(0 0 6px #ffb347aa) brightness(1.15); }
    .btn.npbtn.shuf { background-image: ${T('sk-t-shuf.png')} !important; }
    .btn.npbtn.rpt { background-image: ${T('sk-t-rep.png')} !important; }
    .npctl .btn.npbtn:nth-child(2) { background-image: ${T('sk-t-prev.png')} !important; }
    .npctl .btn.npbtn:nth-child(4) { background-image: ${T('sk-t-next.png')} !important; }
    .btn.npbtn.solo { width: 58px; height: 58px; background-image: ${T('sk-t-play.png')} !important; }
    .btn.npbtn.solo.on { background-image: ${T('sk-t-pause.png')} !important; filter: drop-shadow(0 0 8px #ff9a3acc); }
    .lyrtab { position: fixed; right: 0; top: 38%; z-index: 2147483644; padding: 12px 6px; writing-mode: vertical-rl; cursor: pointer;
      border: 1px solid var(--edge-hi); border-right: 0; border-radius: 10px 0 0 10px; background: linear-gradient(270deg, #2c2622, #1b1816);
      color: var(--brass); font: 700 12px "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; letter-spacing: .2em; transition: right .3s cubic-bezier(.2,.8,.2,1); }
    .lyrtab:hover { color: var(--amber); }
    .lyrtab.open { right: 340px; }
    .lyr { position: fixed; right: 0; top: 166px; bottom: 126px; width: 340px; z-index: 2147483643; display: flex; flex-direction: column; padding: 10px 8px 8px;
      transform: translateX(102%); visibility: hidden; transition: transform .3s cubic-bezier(.2,.8,.2,1), visibility 0s .3s;
      border: 1px solid #0009; border-right: 0; border-radius: 8px 0 0 8px; box-shadow: 0 0 30px #000c, inset 0 0 18px #000a;
      background: linear-gradient(#ffffff0d, transparent 30%, #0006), ${T('metal.jpg')} 0 0 / 256px 256px, #14110f; }
    .lyr.lift, .lib.lift { bottom: calc(var(--dh) + 8px); }
    .toastc { position: fixed; left: 50%; top: 84px; transform: translateX(-50%); z-index: 2147483647; display: none; text-align: center; max-width: min(520px, 90vw);
      padding: 16px 30px; border: 1px solid var(--edge-hi); border-radius: 10px; box-shadow: 0 10px 40px #000d, inset 0 0 18px #000a;
      background: linear-gradient(#ffffff0d, transparent 30%, #0006), ${T('metal.jpg')} 0 0 / 256px 256px, #14110f; pointer-events: none; }
    .toastc.show { display: block; }
    .toasttitle { font-size: 20px; font-weight: 800; letter-spacing: .14em; color: var(--amber); text-shadow: 0 0 12px #ffb34777; }
    .toastsub { margin-top: 6px; font-size: 12px; letter-spacing: .06em; color: var(--ink-dim); }
    .lyr.open { transform: none; visibility: visible; transition: transform .3s cubic-bezier(.2,.8,.2,1); }
    .lyrmeta { margin: 0 12px 8px; text-align: center; text-shadow: 0 1px 2px #000; }
    .lyrartist { font-size: 11px; letter-spacing: .16em; color: var(--brass); text-transform: uppercase; }
    .lyralbum { font-size: 10px; letter-spacing: .1em; color: var(--ink-dim); margin-top: 2px; }
    .lyrsong { font-size: 17px; font-weight: 800; color: #f1e6d3; margin-top: 4px; }
    .lyrlist { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 10px 80px; text-align: center; scroll-behavior: auto; }
    .lyrline { font-size: 15px; line-height: 1.5; padding: 3px 0; color: #9d907d; text-shadow: 0 1px 2px #000; transition: color .2s, transform .2s; }
    .lyrline.past { color: #b9ab95; }
    .lyrline.cur { color: var(--amber); font-weight: 800; font-size: 17px; text-shadow: 0 0 10px #ffb34755; }
    .lyrline.plain { color: #d6c9b3; }
    .lyrline.sync { cursor: pointer; border-radius: 4px; padding-left: 6px; padding-right: 6px; }
    .lyrline.sync:hover { color: #f3e3c6; background: #ffb34714; box-shadow: inset 2px 0 0 var(--amber); }
    .lyrline.sync:focus-visible { outline: 1px solid var(--amber); }
    .lyrsync { display: flex; justify-content: center; align-items: center; gap: 10px; padding-top: 6px; }
    .libtab.open { left: 320px; }
    .lib { position: fixed; left: 0; top: 166px; bottom: 126px; width: 320px; z-index: 2147483643; display: flex; flex-direction: column; padding: 10px 8px 8px;
      transform: translateX(-102%); visibility: hidden; transition: transform .3s cubic-bezier(.2,.8,.2,1), visibility 0s .3s;
      border: 1px solid #0009; border-left: 0; border-radius: 0 8px 8px 0; box-shadow: 0 0 30px #000c, inset 0 0 18px #000a;
      background: linear-gradient(#ffffff0d, transparent 30%, #0006), ${T('metal.jpg')} 0 0 / 256px 256px, #14110f; }
    .lib.open { transform: none; visibility: visible; transition: transform .3s cubic-bezier(.2,.8,.2,1); }
    .libhead { display: flex; justify-content: space-between; align-items: center; margin: 0 8px 8px 14px; }
    .libtitle { font-size: 12px; font-weight: 700; text-shadow: 0 1px 2px #000; letter-spacing: .22em; color: #f0c88e; }
    .libclose { background: none; border: 0; color: var(--ink-dim); cursor: pointer; font-size: 14px; }
    .libclose:hover { color: var(--amber); }
    .liblist { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 0 4px; }
    .libtabs { display: flex; gap: 6px; margin: 0 8px 8px 14px; }
    .btn.libsub { flex: 1; height: 26px; font-size: 10px; letter-spacing: .12em; }
    .offrow { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
    .offlbl { font-size: 10px; letter-spacing: .12em; color: var(--ink-dim); }
    .offin { width: 64px; }
    .libempty { padding: 14px 8px; font-size: 11px; letter-spacing: .06em; color: var(--ink-dim); }
    .librow { display: flex; gap: 8px; align-items: center; padding: 8px; border: 1px solid #0008; border-radius: 6px; background: #0000002e; box-shadow: inset 0 0 10px #0008; }
    .btn.libplay { width: 36px; height: 36px; flex: none; font-size: 12px; }
    .libmain { flex: 1; min-width: 0; }
    .libname-text { font-weight: 700; font-size: 12px; color: #f1e6d3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
    .txt.libname { width: 100%; flex: none; }
    .libmeta { font-size: 10px; letter-spacing: .08em; color: var(--ink-dim); margin-top: 2px; }
    .libbar { height: 6px; margin-top: 5px; border-radius: 3px; background: #050404; box-shadow: inset 0 0 3px #000; cursor: pointer; }
    .libfill { height: 100%; width: 0; border-radius: 3px; background: linear-gradient(90deg, #ffb347, #ff8a1f); }
    .libacts { display: flex; flex-direction: column; gap: 3px; flex: none; }
    .btn.libact { width: 30px; height: 20px; font-size: 11px; }
    .btn.libact.mute { min-width: 30px; width: auto; }
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
    .sel, .txt { height: 24px; min-width: 0; border: 1px solid #000; border-radius: 4px; background: #1b1713; color: #e9dfd0; font: 700 11px "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; padding: 0 6px; }
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
      font: 800 9px/10px "Barlow Condensed", "Bahnschrift", system-ui, sans-serif; letter-spacing: .06em; color: #2a241c; filter: drop-shadow(0 2px 1px #000a); }
    .btn.mute { --src: ${T('btn-red.png')}; color: #ffe9e4; text-shadow: 0 1px 1px #000a; }
    .btn.on, .btn:active { --src: ${T('btn-cream-down.png')}; transform: translateY(1px); filter: drop-shadow(0 1px 0 #000a); }
    .btn.mute.on, .btn.mute:active { --src: ${T('btn-red-down.png')}; }
    .btn.solo.on { filter: drop-shadow(0 0 7px #ffb347); }
    .btn.mute.on { filter: drop-shadow(0 0 7px #ff5a4a); }
    .btn:disabled { opacity: .4; cursor: default; }
    .fader-wrap { display: flex; gap: 6px; height: var(--fh, 160px); }
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
    /* Studio reference skin: all coordinates use the 4344x1448 artboard. */
    .drawer { display:block; background:${T('metal.jpg')} 0 0 / 256px 256px, #14110f; border:0; box-shadow:0 -12px 40px #000c; }
    .drawer > .wood { display:none; }
    .skin { position:absolute; inset:0 auto 0 50%; transform:translateX(-50%); width:min(100vw, calc(84vh * 3)); height:100%; overflow:hidden;
      container-type:inline-size; background:${T('sk-studio.jpg')} center / 100% 100% no-repeat; }
    .skin.console { display:block; padding:0; min-width:0; overflow:hidden; --fh:calc(384 / 1448 * 100cqh); }
    .skin .section { position:absolute; inset:0; width:100%; height:100%; padding:0; margin:0; border:0; border-radius:0; background:none; box-shadow:none; overflow:visible; }
    .skin .section > .title, .skin .section > .screw { display:none; }
    .skin.mixview .live { display:none; }
    .skin:not(.mixview) .offrow, .skin:not(.mixview) .expbtn { display:none; }
    .skin.mixview .section.session .advtoggle, .skin.mixview .section.session .adv { display:none; }
    .skin .section.session > .btn.stemb, .skin .section.session > .btn.startk { display:none !important; }
    .skin.m-listen .section.session > .btn.stemb, .skin.m-karaoke .section.session > .btn.startk { display:flex !important; }
    .skin.m-karaoke .section.session > .btn.recbig:not(.startk) { display:none; }
    .skin.mixview .btn.stemb, .skin.mixview .btn.startk { display:none; }
    .skin .section.session { left:0; top:0; width:100%; height:100%; }
    .skin .section.tune { left:0; top:0; width:100%; height:100%; display:block !important; }
    .skin .section.mixer { left:0; top:0; width:100%; height:100%; }
    .skin .section.eq { left:0; top:0; width:100%; height:100%; max-width:none; min-width:0; }
    .skin .section.enh { left:0; top:0; width:100%; height:100%; }
    .skin .section.fx.enh { display:block; }
    .skin .section.output { left:0; top:0; width:100%; height:100%; }
    .skin.mixview .section.eq, .skin.mixview .section.enh { display:none; }
    .skin .st-placed { position:absolute !important; box-sizing:border-box; margin:0; max-width:none; min-width:0; }
    .skin .section.session > .bigbtn, .skin .section.session .btn.startk { display:flex; align-items:center; justify-content:center; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream-big.png')} 30 26 fill / calc(30 / 4344 * 100cqw) calc(26 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 1.15cqw/1 'Barlow Condensed','Oswald',sans-serif; letter-spacing:.12em; filter:drop-shadow(0 calc(2 / 4344 * 100cqw) calc(2 / 4344 * 100cqw) #0009); }
    .skin .section.session > .bigbtn.on, .skin .section.session > .bigbtn:active { filter:brightness(.8) drop-shadow(0 1px 1px #0009); }
    .skin .section.session > .bigbtn.recBig::before, .skin .section.session > .bigbtn.recbig::before { content:''; width:1.25cqw; height:1.25cqw; margin-right:.7cqw; background:${T('sk-st-reddot.png')} center/contain no-repeat; }
    .skin .section.session .sessinfo { color:#ead9b2; text-align:center; font:600 .65cqw/1.2 'Barlow Condensed',sans-serif; text-shadow:0 1px 2px #000; }
    .skin .advtoggle { display:flex; align-items:center; justify-content:center; border:calc(20 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(20 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .85cqw 'Barlow Condensed',sans-serif; letter-spacing:.1em; }
    .skin .adv { display:none; z-index:8; padding:2.7cqw 1.1cqw 1cqw; background:#20190fee; border:calc(16 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-mod.png')} 82 40 44 50 fill / calc(18 / 4344 * 100cqw) calc(10 / 4344 * 100cqw) calc(12 / 4344 * 100cqw) calc(12 / 4344 * 100cqw) stretch; }
    .skin .adv.open { display:block; }
    .skin .adv .eqinfo-row { display:grid; grid-template-columns:1fr 1.5fr; margin:0 0 .4cqw; color:#e9d6a8; font:600 .7cqw 'Barlow Condensed',sans-serif; }
    .skin .adv .sel, .skin .adv input { width:100%; }
    .skin .tunerow { position:absolute; left:0; width:100%; height:4.1%; margin:0; display:flex; gap:0; }
    .skin .tunelbl { display:none; }
    .skin .tunebtn { padding:0; border:0; background:transparent center/100% 100% no-repeat; font-size:0; filter:drop-shadow(0 1px 2px #0008); }
    .skin .tunerow .tunebtn:first-of-type { background-image:${T('sk-st-minus.png')}; }
    .skin .tunerow .tunebtn:last-of-type { background-image:${T('sk-st-plus.png')}; }
    .skin .tunevalue { display:flex; align-items:center; justify-content:center; border:calc(15 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-valbox.png')} 15 fill / calc(15 / 4344 * 100cqw) stretch; border-radius:0; background:none; color:#ead9b2; font:700 1.1cqw 'Oswald',sans-serif; text-shadow:0 calc(1 / 4344 * 100cqw) calc(2 / 4344 * 100cqw) #000; }
    .skin .section.tune .switches { display:block; margin:0; }
    .skin .section.tune .switches .btn { width:100%; height:100%; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(30 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .9cqw 'Barlow Condensed',sans-serif; }
    .skin .section.tune > .eqinfo { color:#ead9b2; text-align:center; font:600 .72cqw 'Barlow Condensed',sans-serif; white-space:normal; }
    .skin .st-channels { position:absolute; inset:auto; display:flex; gap:calc(10 / 4344 * 100cqw); }
    .skin .st-channels > .strip { position:relative; flex:1 1 0; min-width:0; width:auto; height:100%; display:flex; flex-direction:column; align-items:center; gap:0; padding:0; container-type:inline-size; }
    .skin .strip .btns { position:absolute; left:4%; top:0; width:92%; height:8.15%; display:flex; gap:4%; }
    .skin .strip .btns .btn { flex:1; width:48%; height:100%; border:calc(9 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-solo.png')} 9 fill / calc(9 / 4344 * 100cqw) stretch; background:none; color:#e9d6a8; font:600 .75cqw 'Barlow Condensed',sans-serif; }
    .skin .strip .btns .btn.mute { border-image:${T('sk-st-red.png')} 9 fill / calc(9 / 4344 * 100cqw) stretch; color:#f1d6bd; }
    .skin .strip .btns .btn.on { filter:brightness(1.15) drop-shadow(0 0 4px #ffb34788); }
    .skin .strip .btns .btn.mute:not(.on) { filter:brightness(.55); }
    .skin .fader-wrap { position:absolute; top:11.5%; bottom:23.3%; left:9%; width:82%; height:auto; display:flex; gap:0; }
    .skin .scale { display:none; }
    .skin .track { position:relative; flex:1; width:auto; border:calc(22 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-fslot.png')} 22 fill / calc(22 / 4344 * 100cqw) 0 stretch; border-left-width:0; border-right-width:0; border-radius:0; background:linear-gradient(90deg,transparent 48%,#f4d78b 49%,#fff0b4 50%,#a77738 51%,transparent 52%) center / 100% 72% no-repeat; box-shadow:none; }
    .skin .cap { width:70%; height:9%; min-height:calc(12 / 4344 * 100cqw); transform:translate(-50%,50%); border-radius:0; background:${T('sk-st-fcap.png')} center/100% 100% no-repeat; box-shadow:none; }
    .skin .cap.red { background-image:${T('sk-st-fcap-red.png')}; }
    .skin .led-meter { width:14%; padding:2%; gap:calc(1 / 4344 * 100cqw); border-radius:0; background:#17100b; }
    .skin .led-meter i { border-radius:0; background:${T('sk-st-led-off.png')} center/100% 100% no-repeat; }
    .skin .led-meter i.on { background:${T('sk-st-led-on.png')} center/100% 100% no-repeat; box-shadow:none; }
    .skin .strip .name { position:absolute; left:4%; bottom:12%; width:92%; height:10%; display:flex; align-items:center; justify-content:center; padding:0; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(30 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .85cqw 'Barlow Condensed',sans-serif; }
    .skin .strip .btn.micfx { left:4%; bottom:0; width:92%; height:8%; position:absolute; display:none; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(30 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .68cqw 'Barlow Condensed',sans-serif; }
    .skin .strip .btn.micfx.on { border-image:${T('sk-st-amber.png')} 28 fill / calc(28 / 4344 * 100cqw) stretch; }
    .skin.m-listen .btn.micfx { display:flex; align-items:center; justify-content:center; }
    .skin .expbtn, .skin .offrow { z-index:3; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(30 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .7cqw 'Barlow Condensed',sans-serif; }
    .skin .offrow { display:flex; align-items:center; gap:calc(2 / 4344 * 100cqw); padding:0 calc(3 / 4344 * 100cqw); }
    .skin .offlbl { font:600 .55cqw 'Barlow Condensed',sans-serif; color:#ead9b2; }
    .skin .eq-screen { position:absolute; border-radius:0; background:#15130d; box-shadow:inset 0 0 0 2px #50391e, inset 0 0 18px #000; }
    .skin .section.eq .switches { position:absolute; inset:0; margin:0; display:block; }
    .skin .section.eq .btn { display:flex; align-items:center; justify-content:center; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(30 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .9cqw 'Barlow Condensed',sans-serif; }
    .skin .section.eq .btn.on { border-image:${T('sk-st-amber.png')} 28 fill / calc(28 / 4344 * 100cqw) stretch; }
    .skin .eqrow .sel, .skin .eqrow .txt { border:calc(20 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-select.png')} 20 62 fill / calc(20 / 4344 * 100cqw) calc(62 / 4344 * 100cqw) stretch; border-radius:0; background:none; color:#ead9b2; font:600 .7cqw 'Barlow Condensed',sans-serif; padding:0 .5cqw; }
    .skin .eqrow .txt { border-image:${T('sk-st-input.png')} 18 fill / calc(18 / 4344 * 100cqw) stretch; }
    .skin .sel { border:calc(20 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-select.png')} 20 62 fill / calc(20 / 4344 * 100cqw) calc(62 / 4344 * 100cqw) stretch; border-radius:0; background:none; color:#ead9b2; font:600 .7cqw 'Barlow Condensed',sans-serif; }
    .skin .sel.st-select-wrap { position:relative; display:flex; align-items:center; overflow:hidden; padding:0 calc(62 / 4344 * 100cqw) 0 calc(20 / 4344 * 100cqw); appearance:none; -webkit-appearance:none; white-space:nowrap; line-height:1; border:0 !important; border-image:none !important; background:none; }
    .skin .st-select-wrap::before { content:''; position:absolute; inset:0; z-index:0; pointer-events:none; border:calc(20 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-select.png')} 20 62 fill / calc(20 / 4344 * 100cqw) calc(62 / 4344 * 100cqw) stretch; }
    .skin .st-select-label { position:absolute; z-index:3; left:calc(20 / 4344 * 100cqw); right:calc(62 / 4344 * 100cqw); top:0; height:100%; display:flex; align-items:center; overflow:hidden; white-space:nowrap; text-overflow:clip; color:#ead9b2; font:inherit; line-height:1; background:#15100b; pointer-events:none; }
    .skin .st-select-native { position:absolute !important; inset:0 !important; width:100% !important; height:100% !important; min-width:0 !important; max-width:none !important; margin:0 !important; padding:0 !important; border:0 !important; opacity:1 !important; z-index:2 !important; cursor:pointer; appearance:none !important; -webkit-appearance:none !important; background:transparent !important; background-color:transparent !important; color:transparent !important; -webkit-text-fill-color:transparent !important; text-shadow:none !important; font-size:inherit !important; text-indent:0 !important; }
    .skin .txt { border:calc(18 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-input.png')} 18 fill / calc(18 / 4344 * 100cqw) stretch; border-radius:0; background:none; color:#ead9b2; font:600 .7cqw 'Barlow Condensed',sans-serif; }
    .skin .offrow .offin { width:28%; min-width:0; height:100%; }
    .skin .qrange { accent-color:#bd8640; }
    .skin .eqinfo-row { position:absolute; margin:0; color:#ead9b2; font:600 .62cqw 'Barlow Condensed',sans-serif; }
    .skin .eqinfo-row .qrange { position:absolute; left:0; top:0; }
    .skin .section.enh .fxknobs { position:absolute; inset:0; display:block; }
    .skin .knob-box { position:absolute; display:flex; justify-content:flex-end; gap:0; padding-bottom:0; color:#e9d6a8; font:600 .7cqw 'Barlow Condensed',sans-serif; letter-spacing:.09em; }
    .skin .knob { position:absolute; inset:0; width:100%; height:100%; border-radius:0; background:none !important; box-shadow:none; cursor:ns-resize; }
    .skin .knob::before, .skin .knob::after { content:''; position:absolute; inset:0; background-position:center; background-size:100% 100%; background-repeat:no-repeat; }
    .skin .knob::before { background-image:${T('sk-st-kcream-base.png')}; }
    .skin .knob::after { background-image:${T('sk-st-kcream-cap.png')}; transform:rotate(var(--a,0deg)); transform-origin:50% 50%; }
    .skin .knob.big::after, .skin .knob::after { top:0; left:0; width:100%; height:100%; margin:0; filter:none !important; border-radius:0; box-shadow:none; }
    /* cap sprite size relative to its base (cut from the same reference): cream/dark 62/92, red 64/92, master 128/208 */
    .skin .knob::after { background-size:67.4% 67.4%; }
    .skin .knob.red::after { background-size:69.6% 69.6%; }
    .skin .knob.big::after { background-size:62.5% 62.5%; }
    .skin .knob.dark::after { background-size:69.6% 69.6%; }

    .skin .knob.red::before { background-image:${T('sk-st-kred-base.png')}; }
    .skin .knob.red::after { background-image:${T('sk-st-kred-cap.png')}; }
    .skin .knob.big::before { background-image:${T('sk-st-kmaster-base.png')}; }
    .skin .knob.big::after { background-image:${T('sk-st-kmaster-cap.png')}; }
    .skin .knob:not(.red):not(.big).dark::before { background-image:${T('sk-st-kdark-base.png')}; }
    .skin .knob:not(.red):not(.big).dark::after { background-image:${T('sk-st-kdark-cap.png')}; }
    .skin .section.enh .knob-box .knob { inset:0 0 26% 0; }
    .skin .section.enh .knob-box { text-align:center; }
    .skin .section.enh .knob-box::first-line { color:#e9d6a8; }
    .skin .section.enh .switches { position:absolute; inset:0; margin:0; display:block; }
    .skin .section.enh .switches > .btn { display:flex; align-items:center; justify-content:center; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(30 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .9cqw 'Barlow Condensed',sans-serif; }
    .skin .section.enh .switches > .btn.on { border-image:${T('sk-st-amber.png')} 28 fill / calc(28 / 4344 * 100cqw) stretch; }
    .skin .section.output .vus { position:absolute; inset:0; display:block; }
    .skin .section.output .vu { position:absolute; inset:0; width:auto; height:auto; border-radius:0; overflow:visible; box-shadow:none; background-position:center; background-size:100% 100%; }
    .skin .section.output .vu:first-child { background-image:${T('sk-st-vu-l.png')}; }
    .skin .section.output .vu:last-child { background-image:${T('sk-st-vu-r.png')}; }
    .skin .section.output .vu .lbl { display:none; }
    /* Output MASTER / THRESH: new knobs (design/ref/outknobs-ref.png); base and cap share one centre, the cap is only the pointer */
    .skin .section.output .knob-box .knob { inset:-5.5% !important; }
    /* measured on screen: the MASTER knob drew ~12 ref px left of its slot centre (= the VU gap, where MASTER and LIMITER sit) */
    .skin .section.output .knob.big { transform:translateX(calc(12 / 4344 * 100cqw)); }
    .skin .section.output .knob::before, .skin .section.output .knob::after { background-size:100% 100% !important; transform-origin:50% 50% !important; }
    .skin .section.output .knob.big::before { background-image:${T('sk-st-kout-master-base.png')} !important; }
    .skin .section.output .knob.big::after { background-image:${T('sk-st-kout-master-cap.png')} !important; }
    .skin .section.output .knob.dark::before { background-image:${T('sk-st-kout-thresh-base.png')} !important; }
    .skin .section.output .knob.dark::after { background-image:${T('sk-st-kout-thresh-cap.png')} !important; }
    /* Output MASTER / THRESHOLD: whole artwork (design/ref/outknobs2-ref.png, name plates included); only the needle turns with the value */
    .skin .section.output .knob-box { font-size:0 !important; filter:brightness(.8) saturate(.92); }
    .skin .section.output .knob-box::after { content:none !important; }
    .skin .section.output .knob-box .knob { inset:0 !important; transform:none !important; }
    .skin .section.output .knob::before { background-size:100% 100% !important; }
    .skin .section.output .knob.big::before { background-image:${T('sk-st-ko2-master-base.png')} !important; }
    .skin .section.output .knob.dark::before { background-image:${T('sk-st-ko2-thresh-base.png')} !important; }
    .skin .section.output .knob::after { content:''; position:absolute; background-repeat:no-repeat !important; background-position:center !important; transform:rotate(var(--a,0deg)); transform-origin:50% 50% !important; filter:drop-shadow(0 1px 2px #000a) !important; }
    .skin .section.output .knob.big::after { left:calc(((530 - 268 - 65) / 885) * 100%); top:calc(((415 - 268 - 16) / 890) * 100%); width:calc(536 / 885 * 100%); height:calc(536 / 890 * 100%); background-image:${T('sk-st-ko2-master-needle.png')} !important; background-size:100% 100% !important; }
    .skin .section.output .knob.dark::after { left:calc(((1350 - 158 - 1060) / 571) * 100%); top:calc(((455 - 158 - 181) / 628) * 100%); width:calc(316 / 571 * 100%); height:calc(316 / 628 * 100%); background-image:${T('sk-st-ko2-thresh-needle.png')} !important; background-size:100% 100% !important; }
    .skin .section.output .knob-box .hubdisc { position:absolute; pointer-events:none; background:center / 100% 100% no-repeat; }
    .eq-geq, .eq-geqpre { display:none; }
    .skin .section.eq.mode-graphic .eq-screen, .skin .section.eq.mode-graphic .eqrow, .skin .section.eq.mode-graphic .eqinfo-row { display:none !important; }
    .skin .section.eq.mode-graphic .eq-geq { display:block; position:absolute; box-sizing:border-box; --u:calc(100cqw / 4344); --caph:calc(52 * var(--u)); border-radius:calc(14 * var(--u)); background:linear-gradient(#ffffff06,#00000040), #0c0805; box-shadow:inset 0 0 14px #000, 0 0 0 1px #6a4a26; }
    .skin .section.eq.mode-graphic .eq-geqpre { display:flex; position:absolute; align-items:center; justify-content:center; }
    /* Enhancer wheels: rotating sprites cut from the backdrop (design/tools/studio_gears.py); spin only while the Enhancer is on */
    .enh-gear { position:absolute; pointer-events:none; -webkit-mask:center / 100% 100% no-repeat; }
    .enh-gear i { position:absolute; inset:0; background:center / 100% 100% no-repeat; animation:enh-spin 16s linear infinite; animation-play-state:paused; }
    .section.enh.enh-on .enh-gear i { animation-play-state:running; }
    .enh-gear.big { -webkit-mask-image:${T('sk-st-gear-big-mask.png')}; } .enh-gear.big i { background-image:${T('sk-st-gear-big.png')}; }
    .enh-gear.r { -webkit-mask-image:${T('sk-st-sfx-er-mask.png')}; } .enh-gear.r i { background-image:${T('sk-st-sfx-er.png')}; animation-duration:9s; animation-direction:reverse; }
    .enh-gear.l { -webkit-mask-image:${T('sk-st-sfx-el-mask.png')}; } .enh-gear.l i { background-image:${T('sk-st-sfx-el.png')}; animation-duration:11s; animation-direction:reverse; }
    @keyframes enh-spin { to { transform:rotate(360deg); } }
    /* Session and Key&Tempo wheels (design/tools/studio_wheels.py): turn while a session mode is lit / key or tempo is changed */
    .st-wheel { position:absolute; pointer-events:none; -webkit-mask:center / 100% 100% no-repeat; }
    .st-wheel i { position:absolute; inset:0; background:center / 100% 100% no-repeat; animation:enh-spin 18s linear infinite; animation-play-state:paused; }
    .section.wheel-on .st-wheel i { animation-play-state:running; }
    .st-wheel.sg-big, .st-wheel.sg-right, .st-wheel.sg-top { }
    .sess-g1 .sg-big i, .sess-g2 .sg-right i, .sess-g3 .sg-top i { animation-play-state:running; }
    .st-wheel.sg-big { -webkit-mask-image:${T('sk-st-sgear-big-mask.png')}; } .st-wheel.sg-big i { background-image:${T('sk-st-sgear-big.png')}; animation-duration:20s; }
    .st-wheel.sg-right { -webkit-mask-image:${T('sk-st-sgear-right-mask.png')}; } .st-wheel.sg-right i { background-image:${T('sk-st-sgear-right.png')}; animation-duration:14s; animation-direction:reverse; }
    .st-wheel.sg-top { -webkit-mask-image:${T('sk-st-sgear-top-mask.png')}; } .st-wheel.sg-top i { background-image:${T('sk-st-sgear-top.png')}; animation-duration:10s; }
    .st-wheel.k { -webkit-mask-image:${T('sk-st-wheel-k-mask.png')}; } .st-wheel.k i { background-image:${T('sk-st-wheel-k.png')}; animation:none; }
    /* side pillars / corners (design/tools/studio_sidefx.py) */
    .st-fx { position:absolute; inset:0; pointer-events:none; }
    .st-sfx { pointer-events:none; }
    .st-sfx i { position:absolute; inset:0; background:center / 100% 100% no-repeat; animation:enh-spin 24s linear infinite; }
    .st-sfx.sfx-g1 i, .st-sfx.sfx-g2 i { animation-play-state:paused; }
    .voc-on:is(.m-karaoke,.mixview,.practice) .st-sfx.sfx-g1 i, .voc-on:is(.m-karaoke,.mixview,.practice) .st-sfx.sfx-g2 i { animation-play-state:running; }
    .st-sfx.sfx-g2 i { animation-direction:reverse; } .st-sfx.sfx-bl i { animation-direction:reverse; animation-duration:30s; } .st-sfx.sfx-br i { animation-duration:30s; } .st-sfx.sfx-v i { animation-duration:40s; }
    .st-sfx.sfx-v { -webkit-mask:${T('sk-st-sfx-v-mask.png')} center / 100% 100% no-repeat; } .st-sfx.sfx-v i { background-image:${T('sk-st-sfx-v.png')}; }
    .st-sfx.sfx-g1 { -webkit-mask:${T('sk-st-sfx-g1-mask.png')} center / 100% 100% no-repeat; } .st-sfx.sfx-g1 i { background-image:${T('sk-st-sfx-g1.png')}; }
    .st-sfx.sfx-g2 { -webkit-mask:${T('sk-st-sfx-g2-mask.png')} center / 100% 100% no-repeat; } .st-sfx.sfx-g2 i { background-image:${T('sk-st-sfx-g2.png')}; }
    .st-sfx.sfx-br { -webkit-mask:${T('sk-st-sfx-br-mask.png')} center / 100% 100% no-repeat; } .st-sfx.sfx-br i { background-image:${T('sk-st-sfx-br.png')}; }
    .st-sfx.sfx-bl { -webkit-mask:${T('sk-st-sfx-bl-mask.png')} center / 100% 100% no-repeat; } .st-sfx.sfx-bl i { background-image:${T('sk-st-sfx-bl.png')}; }
    /* capacitor tubes: dark and unlit unless the Vocal Lab is on (then a gentle flicker on top of the painted glow) */
    .st-vtube { pointer-events:none; background:center / 100% 100% no-repeat; opacity:0; transition:opacity .6s ease; }
    .st-vtube.t1 { background-image:${T('sk-st-glow-t1.png')}; } .st-vtube.t2 { background-image:${T('sk-st-glow-t2.png')}; } .st-vtube.t3 { background-image:${T('sk-st-glow-t3.png')}; } .st-vtube.tl { background-image:${T('sk-st-glow-tl.png')}; }
    .voc-on:is(.m-karaoke,.mixview,.practice) .st-vtube { opacity:1; }
    .st-vsteam { pointer-events:none; opacity:0; background:${T('sk-smoke-r.png')} center / 100% 100% no-repeat; transform-origin:14% 96%; }
    .voc-on:is(.m-karaoke,.mixview,.practice) .st-vsteam { animation:st-vsteam 4.8s linear infinite; }
    @keyframes st-vsteam { 0% { opacity:0; transform:translate(-3%,14%) scale(.55,.45); } 12% { opacity:.95; } 45% { opacity:.9; transform:translate(3%,2%) scale(.95,.92) skewX(-4deg); } 75% { opacity:.55; transform:translate(10%,-13%) scale(1.12,1.15) skewX(3deg); } 100% { opacity:0; transform:translate(19%,-27%) scale(1.3,1.35) skewX(-2deg); } }
    .st-presetlbl { display:flex; align-items:center; justify-content:flex-start; color:#e6d3ad; font:600 .62cqw 'Barlow Condensed',sans-serif; letter-spacing:.08em; white-space:nowrap; pointer-events:none; z-index:8; text-shadow:0 1px 2px #000; }
    .skin .section.tune .switches .btn { border:calc(11 / 4344 * 100cqw) solid transparent !important; border-image:${T('sk-st-cream.png')} 22 30 22 30 fill / calc(11 / 4344 * 100cqw) stretch !important; padding:0 !important; }
    .skin .section.tune .switches .btn { color:#3a2412 !important; font-size:clamp(8px,.46cqw,15px) !important; letter-spacing:.08em; text-shadow:0 1px 0 #ffffff55; }
    .skin .section.tune .eqinfo { text-align:center; display:flex; align-items:center; justify-content:center; }
    .st-cables { background:center / 100% 100% no-repeat; pointer-events:none; z-index:1; }
    .st-cables.top { background-image:${T('sk-st-cables-top.png')}; } .st-cables.bot { background-image:${T('sk-st-cables-bot.png')}; }
    .skin .st-chainbar, .skin .status { z-index:8; }
    .skin .section.output .hubdisc.hm { background-image:${T('sk-st-ko2-master-hub.png')}; } .skin .section.output .hubdisc.ht { background-image:${T('sk-st-ko2-thresh-hub.png')}; }
    .eq-tube { position:absolute; pointer-events:none; border-radius:30%; z-index:3; transition:backdrop-filter .3s, background .3s; }
    .section.eq.eq-off .eq-tube { backdrop-filter:brightness(.28) saturate(.25); -webkit-backdrop-filter:brightness(.28) saturate(.25); background:#0a060255; }
    .skin .section.eq.eq-off .eq-geq .geqfill { opacity:.25; box-shadow:none; }
    .skin .section.eq.eq-off .eq-geq .geqcap { filter:brightness(.6) saturate(.5); }
    .eq-geq .geqgrid { left:calc(110 * var(--u)); right:calc(110 * var(--u)); top:calc(60 * var(--u)); bottom:calc(14 * var(--u)); }
    .eq-geq .geqscale { top:calc(60 * var(--u)); bottom:calc(14 * var(--u)); width:calc(100 * var(--u)); font-size:calc(30 * var(--u)); }
    .eq-geq .geqscale.l { left:calc(6 * var(--u)); } .eq-geq .geqscale.r { right:calc(6 * var(--u)); width:calc(78 * var(--u)); padding-left:calc(14 * var(--u)); box-sizing:content-box; text-align:left; }
    .eq-geq .geqhz { font-size:calc(30 * var(--u)); right:calc(6 * var(--u)); width:calc(78 * var(--u)); padding-left:calc(14 * var(--u)); box-sizing:content-box; text-align:left; top:calc(8 * var(--u)); }
    .eq-geq .geqbands.big { left:calc(110 * var(--u)); right:calc(110 * var(--u)); top:calc(6 * var(--u)); bottom:calc(8 * var(--u)); }
    .geqcol.md { width:calc(84 * var(--u)); } .geqcol.md .geqlbl { font-size:calc(34 * var(--u)); line-height:calc(44 * var(--u)); }
    .geqcol.md .geqtrk { width:calc(84 * var(--u)); margin-top:calc(8 * var(--u)); }
    .geqcol.md .geqtrk::before { width:calc(24 * var(--u)); margin-left:calc(-12 * var(--u)); border-radius:calc(12 * var(--u)); box-shadow:inset 0 2px 4px #000, 0 0 0 1px #8a6030, 0 0 0 3px #140c06; }
    .geqcol.md .geqfill { width:calc(10 * var(--u)); margin-left:calc(-5 * var(--u)); box-shadow:0 0 8px #ff8a1f; }
    .geqcol.md .geqcap { width:calc(80 * var(--u)); height:var(--caph); margin-left:calc(-40 * var(--u)); border-radius:calc(8 * var(--u)); box-shadow:0 3px 5px #000d; }
    .skin .section.output .knob::after { filter:drop-shadow(0 2px 2px #000a) !important; }
    /* THRESH follows the LIMITER: limiter off = dimmed, unlit knob */
    .skin .section.output .knob-box:has(.knob.dark) { transition:filter .25s; }
    .skin .section.output .row.lim-off .knob-box:has(.knob.dark) { filter:brightness(.45) saturate(.75); }
    .skin .section.output .knob-box::after { position:absolute; left:-60%; right:-60%; top:104%; text-align:center; color:#e9d6a8; text-shadow:0 1px 2px #000, 0 0 4px #0008;
      font:600 calc(34 / 4344 * 100cqw)/1 'Barlow Condensed','Oswald',sans-serif; letter-spacing:.06em; pointer-events:none; }
    .skin .section.output .knob-box:has(.knob.big)::after { content:'MASTER'; }
    .skin .section.output .knob-box:has(.knob.dark)::after { content:'THRESH'; font-size:calc(28 / 4344 * 100cqw); }
    /* new dials: pivot at the bottom centre (behind the L/R bezel); the bezel cover sprite sits above the needle */
    .skin .section.output .vu .nd { bottom:-1% !important; height:70% !important; width:.9% !important; transform-origin:50% 97% !important; z-index:1; }
    .skin .section.output .vu::after { content:''; position:absolute; inset:0; z-index:2; pointer-events:none; background:center / 100% 100% no-repeat; }
    .skin .section.output .vu:first-child::after { background-image:${T('sk-st-vu-l-cover.png')}; }
    .skin .section.output .vu:last-child::after { background-image:${T('sk-st-vu-r-cover.png')}; }
    .skin .section.output .vu .nd { position:absolute; left:50%; bottom:5%; width:1.1%; height:55%; margin:0; border-radius:100% 100% 0 0; transform-origin:50% 95%; background:linear-gradient(90deg,#1b1009,#e0bd75 48%,#2b1a0d); box-shadow:0 1px 2px #000; z-index:2; }
    .skin .section.output .master { position:absolute; inset:0; width:auto; display:block; }
    .skin .section.output .master .row { position:absolute; inset:0; display:block; }
    .skin .section.output .knob-box { padding:0; }
    .skin .section.output .knob-box .knob { inset:0 0 22% 0; }
    .skin .section.output .switches { position:absolute; inset:0; margin:0; }
    .skin .section.output .limiter { display:flex; align-items:center; justify-content:center; border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(30 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .9cqw 'Barlow Condensed',sans-serif; }
    .skin .section.output .limiter.on { border-image:${T('sk-st-amber.png')} 28 fill / calc(28 / 4344 * 100cqw) stretch; }
    .skin .section.output .limiter .led { display:none; }
    .skin .section.output .limiter { font-size:clamp(9px,.52cqw,16px) !important; }
    .skin .section.chain { display:block !important; left:0; top:0; width:100%; height:100%; }
    .skin .st-chainbar { display:flex; align-items:center; gap:1%; padding:0; color:#ead9b2; font:600 .62cqw 'Barlow Condensed',sans-serif; }
    .skin .st-chainbar .offlbl:first-child { display:none; }
    .skin .st-chainbar .sel { position:absolute; left:0; top:0; width:28.6%; height:100%; border:calc(20 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-select.png')} 20 62 fill / calc(20 / 4344 * 100cqw) calc(38 / 4344 * 100cqw) stretch; border-radius:0; background:none; color:#ead9b2; font:600 .72cqw 'Barlow Condensed',sans-serif; }
    .skin .st-chainbar .offlbl:last-child { position:absolute; left:32%; top:0; width:68%; height:100%; display:flex; align-items:center; overflow:hidden; }
    .skin .st-chainrow { position:absolute; left:2.486%; top:62.5%; width:90.976%; height:29.28%; display:flex; flex-wrap:nowrap; gap:calc(39 / 4344 * 100cqw); align-items:stretch; padding:0; }
    .skin .st-chain-module { position:relative; align-self:stretch; min-width:0; min-height:0; height:100%; max-height:100%; max-width:none; padding:calc(4 / 4344 * 100cqw) calc(10 / 4344 * 100cqw) calc(6 / 4344 * 100cqw); border:calc(82 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-mod.png')} 82 40 44 50 fill / calc(82 / 4344 * 100cqw) calc(40 / 4344 * 100cqw) calc(44 / 4344 * 100cqw) calc(50 / 4344 * 100cqw) stretch; background:none; box-shadow:none; border-radius:0; display:flex; flex-direction:column; justify-content:space-between; gap:2%; overflow:hidden; }
    .skin .st-chain-module .st-modtitle { position:absolute; left:18%; right:17%; top:4%; height:12%; display:flex; align-items:center; justify-content:center; gap:4%; color:#e9d6a8; font:600 .78cqw 'Barlow Condensed','Oswald',sans-serif; text-shadow:0 1px 2px #000; white-space:nowrap; }
    .skin .st-chain-module .modled { position:absolute; right:10%; top:6%; width:8%; height:8%; border:0; border-radius:0; background:${T('sk-st-led-off.png')} center/contain no-repeat; cursor:pointer; }
    .skin .st-chain-module .modled.on { background-image:${T('sk-st-led-on.png')}; box-shadow:none; }
    .skin .st-chain-module .modbody { display:flex; align-items:center; justify-content:center; gap:3%; min-height:30%; }
    .skin .st-chain-module .grbar { height:calc(8 / 4344 * 100cqw); min-height:3px; border-radius:0; overflow:hidden; background:#090705; box-shadow:inset 0 0 3px #000; }
    .skin .st-chain-module .grbar i { display:block; height:100%; width:0; background:linear-gradient(90deg,#d5ae6b,#f5d891); }
    .skin .st-chain-module .knob-box { position:relative; flex:1 1 0; min-width:0; height:55%; padding-top:0; }
    .skin .st-chain-module .knob { position:relative; flex:none; width:100%; height:auto; aspect-ratio:1; }
    .skin .st-chain-module .knob-box { font-size:.56cqw; }
    .skin .st-chain-module .sel { width:100%; max-width:none; height:13%; min-height:calc(14 / 4344 * 100cqw); border:calc(20 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-select.png')} 20 62 fill / calc(12 / 4344 * 100cqw) calc(24 / 4344 * 100cqw) stretch; border-radius:0; background:none; color:#ead9b2; font:600 .5cqw 'Barlow Condensed',sans-serif; }
    .skin .st-chain-module .eqinfo, .skin .st-chain-module .mod .eqinfo { color:#ead9b2; font:600 .52cqw 'Barlow Condensed',sans-serif; }
    .skin .st-chain-module .btn.fxon, .skin .st-chain-module .btn.takebtn { width:100%; height:16%; min-height:calc(18 / 4344 * 100cqw); border:calc(30 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 30 fill / calc(14 / 4344 * 100cqw) stretch; background:none; color:#422c16; font:600 .65cqw 'Barlow Condensed',sans-serif; }
    .skin .st-chain-module .btn.fxon.on { border-image:${T('sk-st-amber.png')} 28 fill / calc(14 / 4344 * 100cqw) stretch; }
    .skin .st-chain-module .switches { margin:0; }
    .skin .st-chain-module.off { filter:brightness(.58) saturate(.55); }
    .skin:not(.m-karaoke):not(.mixview):not(.practice) .st-chainrow { opacity:.55; filter:grayscale(.35); pointer-events:none; }
    .skin .st-chainrow .modarrow { display:none; }
    .np.st-lift { position:fixed; left:0; right:0; bottom:var(--dh); height:124px; margin:0; z-index:2147483644; }
    /* Full-artboard layout layers must not swallow clicks: only real controls take pointer events. */
    .skin .section, .skin .section .switches, .skin .section .fxknobs, .skin .section .vus, .skin .section .master, .skin .section .master .row,
      .skin .st-chainrow, .skin .st-chain-module, .skin .st-module-content, .skin .st-select-label, .skin .status { pointer-events:none; }
    .skin .section :is(button, select, input, textarea, canvas, .knob, .track, [role=slider], .lyrline) { pointer-events:auto; }
    .skin:not(.m-karaoke):not(.mixview):not(.practice) .st-chainrow * { pointer-events:none !important; }
    /* mixer is live only with capture (stems) or a loaded layered recording: otherwise dimmed and locked like the chain */
    .skin:not(.st-capture):not(.mixview) .section.mixer .channels, .skin:not(.st-capture):not(.mixview) .section.mixer .st-mixer-extra { opacity:.55; filter:grayscale(.35); }
    .skin:not(.st-capture):not(.mixview) .section.mixer .channels, .skin:not(.st-capture):not(.mixview) .section.mixer .st-mixer-extra { opacity:1; filter:none; }
    .skin:not(.st-capture):not(.mixview) .section.mixer .strip > :not(.micsw), .skin:not(.st-capture):not(.mixview) .section.mixer .st-mixer-extra { opacity:.55; filter:grayscale(.35); }
    .skin:not(.st-capture):not(.mixview) .section.mixer *:not(.micsw):not(.micsw *) { pointer-events:none !important; }
    /* Activate-mic practice switch under the mic channel (Listen / Listen with stems only) */
    .skin .strip .micsw { display:none; position:absolute; left:50%; bottom:-2.5%; transform:translateX(-50%); height:16%; width:90%;
      padding:0; margin:0; border:0; background:none; cursor:pointer; pointer-events:auto !important;
      grid-template-columns:1fr auto 1fr; grid-template-rows:auto 1fr; align-items:center; justify-items:center; column-gap:6%; }
    .skin.m-listen:not(.mixview) .strip .micsw { display:grid; }
    .skin .strip .micsw .micsw-mic { grid-column:1 / 4; grid-row:1; font:700 clamp(7px,9cqi,13px)/1 'Barlow Condensed','Oswald',sans-serif; letter-spacing:.12em; color:#e9d6a8; text-shadow:0 1px 2px #000; padding-bottom:4%; }
    .skin .strip .micsw .micsw-lever { grid-column:2; grid-row:2; display:block; height:100%; aspect-ratio:230/300; background:${T('sk-st-toggle-off.png')} center / contain no-repeat; filter:drop-shadow(0 0 3px #ffb34755); }
    .skin .strip .micsw.on .micsw-lever { background-image:${T('sk-st-toggle-on.png')}; filter:drop-shadow(0 0 6px #ffb347aa); }
    .skin .strip .micsw .micsw-on, .skin .strip .micsw .micsw-off { grid-column:1; grid-row:2; justify-self:end; font:700 clamp(7px,9cqi,13px)/1 'Barlow Condensed','Oswald',sans-serif; letter-spacing:.06em; display:none; }
    .skin .strip .micsw .micsw-on { color:#5dff7a; text-shadow:0 0 5px #5dff7acc; }
    .skin .strip .micsw .micsw-off { color:#ff4a3a; text-shadow:0 0 5px #ff4a3acc; }
    .skin .strip .micsw.on .micsw-on, .skin .strip .micsw:not(.on) .micsw-off { display:block; }
    /* Session buttons: whole plates from design/ref/session-{off,on}-ref.png (icon + text baked in); off = not pressed, on = pressed.
       START KARAOKE keeps live text (it changes) on the KARAOKE plate with the text cleared. */
    .skin .section.session > .bigbtn, .skin .section.session > .advtoggle { border:0 !important; border-image:none !important; padding:0 !important;
      background:transparent center / 100% 100% no-repeat !important; filter:none !important; box-shadow:none !important; }
    .skin .section.session > .bigbtn:not(.startk), .skin .section.session > .advtoggle { color:transparent !important; -webkit-text-fill-color:transparent !important; text-shadow:none !important; font-size:0 !important; }
    .skin .section.session > .bigbtn::before { content:none !important; }
    .skin .section.session > .st-listen { background-image:${T('sk-st-ses-listen-off.png')} !important; }
    .skin .section.session > .st-listen.on { background-image:${T('sk-st-ses-listen-on.png')} !important; }
    .skin .section.session > .st-stems { background-image:${T('sk-st-ses-stems-off.png')} !important; }
    .skin .section.session > .st-stems.on { background-image:${T('sk-st-ses-stems-on.png')} !important; }
    .skin .section.session > .st-karaoke { background-image:${T('sk-st-ses-karaoke-off.png')} !important; }
    .skin .section.session > .st-karaoke.on { background-image:${T('sk-st-ses-karaoke-on.png')} !important; }
    .skin .section.session > .startk { background-image:${T('sk-st-ses-start-off.png')} !important; box-sizing:border-box !important; padding:0 calc(18 / 4344 * 100cqw) 0 calc(62 / 4344 * 100cqw) !important; /* % padding would follow the whole artboard */
      justify-content:center !important; white-space:nowrap; overflow:hidden;
      color:#2a1a0c !important; -webkit-text-fill-color:#2a1a0c !important; text-shadow:0 1px 1px #fff4 !important; }
    .skin .section.session > .startk.on { background-image:${T('sk-st-ses-start-on.png')} !important;
      color:#ffd98a !important; -webkit-text-fill-color:#ffd98a !important; text-shadow:0 0 6px #ffb347, 0 0 2px #ff9a2a !important; }
    .skin .section.session > .advtoggle { background-image:${T('sk-st-ses-adv-off.png')} !important; }
    .skin .section.session > .advtoggle.on { background-image:${T('sk-st-ses-adv-on.png')} !important; }
    .skin .section.session > .bigbtn:active, .skin .section.session > .advtoggle:active { transform:translateY(1px); }
    /* Enhancer buttons: whole plates from design/ref/enh-{off,on}-ref.png (text baked in); off = not pressed, on = active */
    .skin .section.enh .switches > .btn { border:0 !important; border-image:none !important; padding:0 !important; box-shadow:none !important; filter:none !important;
      background:transparent center / 100% 100% no-repeat !important; color:transparent !important; -webkit-text-fill-color:transparent !important; text-shadow:none !important; font-size:0 !important; }
    .skin .section.enh .switches > .btn .led, .skin .section.enh .switches > .btn .st-label { display:none !important; }
    .skin .section.enh .switches > .btn:nth-child(1) { background-image:${T('sk-st-enh-main-off.png')} !important; }
    .skin .section.enh .switches > .btn:nth-child(1).on { background-image:${T('sk-st-enh-main-on.png')} !important; }
    .skin .section.enh .switches > .btn:nth-child(2) { background-image:${T('sk-st-enh-analog-off.png')} !important; }
    .skin .section.enh .switches > .btn:nth-child(2).on { background-image:${T('sk-st-enh-analog-on.png')} !important; }
    .skin .section.enh .switches > .btn:nth-child(3) { background-image:${T('sk-st-enh-vinyl-off.png')} !important; }
    .skin .section.enh .switches > .btn:nth-child(3).on { background-image:${T('sk-st-enh-vinyl-on.png')} !important; }
    .skin .section.enh .switches > .btn:nth-child(4) { background-image:${T('sk-st-enh-tape-off.png')} !important; }
    .skin .section.enh .switches > .btn:nth-child(4).on { background-image:${T('sk-st-enh-tape-on.png')} !important; }
    .skin .section.enh .switches > .btn:active { transform:translateY(1px); }
    /* ADVANCED overlay: a plain stacked form over the three big buttons (label left, control right) */
    .skin .section.session .adv.open { display:flex !important; flex-direction:column; justify-content:center; gap:calc(14 / 4344 * 100cqw); box-sizing:border-box;
      padding:calc(40 / 4344 * 100cqw) calc(22 / 4344 * 100cqw) !important; pointer-events:auto; }
    .skin .section.session .adv .eqinfo-row { position:static !important; display:grid !important; grid-template-columns:calc(64 / 4344 * 100cqw) 1fr auto; align-items:center;
      column-gap:calc(10 / 4344 * 100cqw); width:auto !important; height:calc(46 / 4344 * 100cqw) !important; margin:0 !important; left:auto !important; top:auto !important;
      color:#e9d6a8; font:700 calc(22 / 4344 * 100cqw)/1 'Barlow Condensed','Oswald',sans-serif !important; letter-spacing:.06em; }
    .skin .section.session .adv .eqinfo-row > * { position:relative !important; left:auto !important; top:auto !important; transform:none !important; min-width:0; }
    .skin .section.session .adv .eqinfo-row > span:first-child { grid-column:1; }
    .skin .section.session .adv .eqinfo-row > :nth-child(2) { grid-column:2; width:100% !important; height:calc(40 / 4344 * 100cqw) !important; }
    .skin .section.session .adv .eqinfo-row > span:nth-child(3) { grid-column:3; font-size:calc(20 / 4344 * 100cqw) !important; }
    .skin .section.session .adv .st-select-label { font-size:calc(19 / 4344 * 100cqw) !important; right:calc(40 / 4344 * 100cqw) !important; text-overflow:ellipsis; }
    .skin .section.session .adv input.qrange { height:calc(14 / 4344 * 100cqw) !important; align-self:center; }
    .skin .section.session .adv .btn.capture { grid-column:2; justify-self:start; width:calc(150 / 4344 * 100cqw) !important; height:calc(44 / 4344 * 100cqw) !important;
      display:flex !important; align-items:center; justify-content:center; font:700 calc(20 / 4344 * 100cqw)/1 'Barlow Condensed','Oswald',sans-serif !important; }
    .skin .status { position:absolute; inset:0; pointer-events:none; display:block; padding:0; font:600 .68cqw 'Barlow Condensed',sans-serif; color:#ead9b2; letter-spacing:.08em; text-shadow:0 1px 2px #000; }
    .skin .status > span { position:absolute; display:flex; align-items:center; overflow:hidden; white-space:nowrap; }
    .skin .clock { justify-content:center; font:600 .78cqw 'Oswald',sans-serif; color:#ead9b2; }
    .skin .status > span:first-child { color:#ead9b2; }
    .skin .status > span:nth-child(2), .skin .status > span:nth-child(3) { justify-content:center; }
    .skin .section.tune .tunerow:nth-of-type(1) { top:12.3%; }
    .skin .section.tune .tunerow:nth-of-type(2) { top:18.2%; }
    /* Reference scale and fixed text fitting for the steampunk control plates. */
    .skin .section > h3.title { display:none !important; }
    .skin button, .skin .btn { box-sizing:border-box; white-space:nowrap; padding:0; line-height:1; overflow:hidden; }
    .skin .section.session > .bigbtn, .skin .section.session .btn.startk { display:flex; align-items:center; justify-content:center; font:700 .72cqw/1 'Barlow Condensed','Oswald',sans-serif !important; color:#422c16 !important; -webkit-text-fill-color:#422c16; letter-spacing:.08em; line-height:1; white-space:nowrap; padding:0; }
    .skin .section.session > .btn.stemb { display:flex !important; }
    .skin .section.session > .btn.startk { display:none !important; }
    /* LISTEN WITH STEMS stays a real button in every mode (the plate is also painted on the backdrop): it switches over by itself */
    .skin.m-karaoke .section.session > .btn.recbig:not(.startk) { display:none !important; }
    .skin.m-karaoke .section.session > .btn.startk { display:flex !important; }
    .skin .section.session .advtoggle { font-size:0; line-height:1; }
    .skin .section.tune .tunevalue { font-size:.55cqw; white-space:nowrap; }
    .skin .section.tune .switches .btn, .skin .section.eq .btn, .skin .section.enh .switches > .btn,
    .skin .section.output .limiter { font-size:.4cqw; line-height:1; white-space:nowrap; padding:0; }
    .skin .section.tune .switches .btn, .skin .section.enh .switches > .btn { display:flex; align-items:center; justify-content:center; font-size:.62cqw; }
    .skin .section.eq .btn { font-size:.62cqw; }
    .skin .strip .btns { left:0; width:100%; gap:5%; }
    .skin .strip .btns .btn { flex:0 0 47.5%; width:47.5%; font-size:.58cqw; line-height:1; white-space:nowrap; padding:0; }
    .skin .strip .btns .btn:disabled { opacity:1; }
    .skin .strip .name { font-size:.5cqw; line-height:1; white-space:nowrap; }
    .skin .strip .btn.micfx { font-size:.6cqw; line-height:1; white-space:nowrap; padding:0; }
    .skin .expbtn, .skin .offrow { font-size:.38cqw; line-height:1; white-space:nowrap; padding:0; }
    .skin .eqrow .sel, .skin .st-chainbar .sel, .skin .st-chain-module .sel, .skin .sel {
      box-sizing:border-box; min-width:0; padding:0 calc(62 / 4344 * 100cqw) 0 calc(20 / 4344 * 100cqw);
      appearance:none; -webkit-appearance:none; white-space:nowrap; overflow:hidden; text-overflow:clip;
      line-height:1; font-size:.52cqw;
    }
    .skin .eqrow .txt, .skin .txt { box-sizing:border-box; min-width:0; padding:0 calc(20 / 4344 * 100cqw); line-height:1; font-size:.43cqw; }
    .skin .eqrow .sel { padding:0 calc(8 / 4344 * 100cqw) 0 calc(12 / 4344 * 100cqw); }
    .skin .eqrow .st-select-label { background:transparent; }
    /* EQ preset picker: a flat dropdown field (no 3D plate, no separate text layer) */
    .skin .eqrow .st-select-wrap { background:#120d08; border-radius:calc(14 / 4344 * 100cqw); box-shadow:inset 0 0 0 1px #6a4a26, inset 0 2px 6px #000; padding:0 calc(60 / 4344 * 100cqw) 0 calc(24 / 4344 * 100cqw); }
    .skin .eqrow .st-select-wrap::before { display:none; }
    .skin .eqrow .st-select-wrap::after { content:''; position:absolute; right:calc(26 / 4344 * 100cqw); top:50%; width:calc(14 / 4344 * 100cqw); height:calc(14 / 4344 * 100cqw); margin-top:calc(-11 / 4344 * 100cqw); border:solid #e9d6a8; border-width:0 calc(4 / 4344 * 100cqw) calc(4 / 4344 * 100cqw) 0; transform:rotate(45deg); z-index:1; pointer-events:none; }
    .skin .eqrow .txt { border:0 !important; border-image:none !important; background:#120d08 !important; border-radius:calc(14 / 4344 * 100cqw); box-shadow:inset 0 0 0 1px #6a4a26, inset 0 2px 6px #000; padding:0 calc(24 / 4344 * 100cqw); outline:none; }
    .skin .eqrow .txt:focus { box-shadow:inset 0 0 0 1px #c8954a, inset 0 2px 6px #000; }
    .skin .eqrow .st-select-label { left:calc(24 / 4344 * 100cqw); right:calc(60 / 4344 * 100cqw); }
    /* Vocal Chain dropdowns: thinner and a touch higher */
    .skin .st-chain-module .st-module-content > .st-select-wrap { height:calc(40 / 4344 * 100cqw) !important; min-height:0 !important; }
    .skin .st-chain-module .st-module-content > .st-select-wrap[style], .skin .st-chain-module .st-module-content > .st-select-wrap { margin-top:0; }
    .skin .st-chain-module:not(.st-chain-m0):not(.st-chain-m1):not(.st-chain-m10) .st-module-content > .st-select-wrap { top:auto !important; bottom:calc(36 / 4344 * 100cqw) !important; }
    .skin .st-chain-module.st-chain-m10 .st-module-content > .st-select-wrap:not(:nth-child(2)) { top:auto !important; bottom:calc(36 / 4344 * 100cqw) !important; }
    /* Vocal Chain dropdowns: same flat field as the EQ preset picker (no plate, no 3D button) */
    .skin .st-chain-module .st-select-wrap, .skin .st-chainbar .st-select-wrap { background:#120d08; border-radius:calc(12 / 4344 * 100cqw); box-shadow:inset 0 0 0 1px #6a4a26, inset 0 2px 5px #000; padding:0 calc(40 / 4344 * 100cqw) 0 calc(18 / 4344 * 100cqw); }
    .skin .st-chain-module .st-select-wrap::before, .skin .st-chainbar .st-select-wrap::before { display:none; }
    .skin .st-chain-module .st-select-wrap::after, .skin .st-chainbar .st-select-wrap::after { content:''; position:absolute; right:calc(18 / 4344 * 100cqw); top:50%; width:calc(10 / 4344 * 100cqw); height:calc(10 / 4344 * 100cqw); margin-top:calc(-8 / 4344 * 100cqw); border:solid #e9d6a8; border-width:0 calc(3 / 4344 * 100cqw) calc(3 / 4344 * 100cqw) 0; transform:rotate(45deg); z-index:1; pointer-events:none; }
    .skin .st-chain-module .st-select-label, .skin .st-chainbar .st-select-label { background:transparent; left:calc(18 / 4344 * 100cqw); right:calc(40 / 4344 * 100cqw); }
    .skin .section.enh .knob-box { font-size:0; }
    /* preset buttons rebuild the Enhancer knobs: place them by position, not once by script */
    .skin .section.enh .fxknobs > .knob-box:nth-child(1) { position:absolute; left:64.1344%; top:11.3260%; width:2.1179%; height:6.3536%; }
    .skin .section.enh .fxknobs > .knob-box:nth-child(2) { position:absolute; left:67.1041%; top:11.3260%; width:2.1179%; height:6.3536%; }
    .skin .section.enh .fxknobs > .knob-box:nth-child(3) { position:absolute; left:70.0276%; top:11.3260%; width:2.1179%; height:6.3536%; }
    .skin .section.enh .fxknobs > .knob-box:nth-child(4) { position:absolute; left:72.9052%; top:11.3260%; width:2.1179%; height:6.3536%; }
    .skin .section.enh .knob-box .knob { inset:auto; left:50%; top:0; width:calc(92 / 4344 * 100cqw); height:calc(92 / 4344 * 100cqw); transform:translateX(-50%); }
    .skin .section.output .knob-box { font-size:0; }
    .skin .section.output .knob-box .knob { inset:0; }
    .skin .section.enh .switches > .btn { font-size:.6cqw; line-height:1; white-space:nowrap; padding:0; }
    .skin .st-chain-module {
      display:block; position:relative; padding:0; overflow:hidden; opacity:1; filter:none;
      border:0; background:none; box-shadow:none;
    }
    .skin .st-chain-module::before { content:''; position:absolute; inset:0; z-index:0; pointer-events:none; border:calc(82 / 4344 * 100cqw) solid transparent; border-width:calc(82 / 4344 * 100cqw) calc(40 / 4344 * 100cqw) calc(44 / 4344 * 100cqw) calc(50 / 4344 * 100cqw); border-image:${T('sk-st-mod.png')} 82 40 44 50 fill / calc(82 / 4344 * 100cqw) calc(40 / 4344 * 100cqw) calc(44 / 4344 * 100cqw) calc(50 / 4344 * 100cqw) stretch; }
    .skin .st-chain-module .st-module-content { position:absolute; inset:0; z-index:1; }
    .skin .st-mod-label { position:relative; z-index:20; display:inline-block; }
    .skin .st-chain-module .st-modtitle { left:4%; right:4%; top:2%; height:14%; font-size:.62cqw; line-height:1; text-align:center; z-index:2; }
    .skin .st-chain-module .modled { right:7%; top:5%; width:10%; height:9%; }
    .skin .st-chain-module .st-module-content > .modbody { position:absolute; left:calc(50 / 4344 * 100cqw); right:calc(40 / 4344 * 100cqw); top:21%; height:49%; min-height:0; display:flex; align-items:stretch; justify-content:center; gap:2%; overflow:visible; }
    .skin .st-chain-module .knob-box { position:relative; flex:1 1 0; width:0; min-width:0; height:100%; padding:0; display:flex; align-items:flex-end; justify-content:center; font:600 .48cqw/1 'Barlow Condensed',sans-serif; letter-spacing:.02em; white-space:nowrap; }
    .skin .st-chain-module .knob { position:absolute; inset:auto; left:50%; top:0; width:calc(92 / 4344 * 100cqw); height:calc(92 / 4344 * 100cqw); transform:translateX(-50%); }
    .skin .st-chain-module .st-module-content > .sel { position:absolute; left:calc(50 / 4344 * 100cqw); right:calc(40 / 4344 * 100cqw); bottom:4%; width:auto; height:9%; min-height:0; font-size:.48cqw; }
    .skin .st-chain-module .grbar { position:absolute; left:calc(50 / 4344 * 100cqw + 4%); right:calc(40 / 4344 * 100cqw + 4%); top:73%; height:calc(8 / 4344 * 100cqw); min-height:2px; }
    .skin .st-chain-module .st-module-content > .eqinfo { position:absolute; left:calc(50 / 4344 * 100cqw); right:calc(40 / 4344 * 100cqw); bottom:5%; display:flex; justify-content:center; font-size:.39cqw; line-height:1; white-space:nowrap; }
    .skin .st-chain-module .st-module-content > .btn.fxon, .skin .st-chain-module .st-module-content > .btn.takebtn { position:absolute; left:calc(50 / 4344 * 100cqw); right:calc(40 / 4344 * 100cqw); bottom:18%; width:auto; height:14%; min-height:0; display:flex; align-items:center; justify-content:center; font-size:.5cqw; line-height:1; white-space:nowrap; padding:0; }
    .skin .st-chain-module .live { position:absolute; left:7%; right:7%; bottom:4%; height:12%; display:flex; align-items:center; justify-content:center; }
    .skin .st-chain-module .live .eqinfo { font-size:.39cqw; white-space:nowrap; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .sel { top:18%; bottom:auto; height:10%; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .modbody { top:36%; height:39%; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .eqinfo { bottom:4%; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .eqinfo-row { position:absolute; left:calc(50 / 4344 * 100cqw + 3%); right:calc(40 / 4344 * 100cqw + 3%); top:17%; height:13%; display:flex; gap:3%; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .eqinfo-row .sel { width:48%; height:100%; font-size:.4cqw; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .modbody { top:33%; height:36%; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .btn { position:absolute; left:calc(50 / 4344 * 100cqw); right:calc(40 / 4344 * 100cqw); bottom:17%; width:auto; height:13%; font-size:.46cqw; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .eqinfo { bottom:4%; }
    .skin .st-chain-module.st-chain-m10 .st-module-content > .sel:first-of-type { top:18%; bottom:auto; height:10%; }
    .skin .st-chain-module.st-chain-m10 .st-module-content > .modbody { top:35%; height:39%; }
    .skin .st-chain-module.off { filter:brightness(.8) saturate(.7); }
    .skin:not(.m-karaoke):not(.mixview):not(.practice) .st-chainrow { opacity:.55; filter:grayscale(.35); pointer-events:none; }
    /* Match the reference's bold, high contrast labels and keep native selects interactive but invisible. */
    .skin .st-select-native { opacity:1 !important; color:transparent !important; -webkit-text-fill-color:transparent !important; text-shadow:none !important; font-size:inherit !important; text-indent:0 !important; }
    .skin .st-select-native option { font:700 14px 'Barlow Condensed','Oswald',sans-serif; color:#e9d6a8; background:#1a120a; text-indent:0; }
    .skin .st-select-wrap .st-select-label { font:700 .62cqw/1 'Barlow Condensed','Oswald',sans-serif; letter-spacing:.01em; }
    .skin .st-chain-module .st-select-label { font-size:.59cqw; }
    .skin .st-chain-module .st-modtitle { font-size:.76cqw; font-weight:700; letter-spacing:.02em; }
    .skin .st-chain-module .knob-box { font:700 .65cqw/1 'Barlow Condensed','Oswald',sans-serif; letter-spacing:.01em; text-shadow:0 1px 2px #000; overflow:visible; }
    .skin .st-chain-module .knob-box .st-knob-label { position:absolute; left:-8%; right:-8%; bottom:calc(100% - (92 / 4344 * 100cqw) - (15 / 4344 * 100cqw) - .65cqw); display:block; text-align:center; white-space:nowrap; line-height:1; }
    .skin .st-chain-module .st-module-content > .sel { left:10%; right:10%; bottom:4%; height:calc(55 / 4344 * 100cqw); font-size:.59cqw; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .st-select-wrap { left:8%; right:8%; top:18%; bottom:auto; height:13%; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .modbody { left:8%; right:8%; top:34%; height:34%; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .modbody > .fxon { position:absolute; left:0; right:0; top:100%; width:100%; height:44%; min-height:0; font-size:.72cqw; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .eqinfo { bottom:2%; height:9%; font-size:.6cqw; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .eqinfo-row { left:8%; right:8%; top:18%; height:13%; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .eqinfo-row .sel { width:48%; height:100%; font-size:.57cqw; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .modbody { left:8%; right:8%; top:35%; height:34%; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .btn { left:8%; right:8%; top:69%; bottom:auto; width:auto; height:17%; font-size:.7cqw; }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .eqinfo { bottom:2%; height:9%; font-size:.6cqw; }
    .skin .st-chain-module.st-chain-m13 .st-module-content > .btn.fxon { left:10%; right:10%; top:30%; bottom:auto; width:auto; height:14%; font-size:.68cqw; }
    .skin .st-chain-module.st-chain-m13 .st-module-content > .live { position:absolute; left:10%; right:10%; bottom:4%; height:19%; display:block; }
    .skin .st-chain-module.st-chain-m13 .st-module-content > .live .takebtn { left:0; right:0; top:0; bottom:auto; width:100%; height:75%; font-size:.7cqw; }
    .skin .st-chain-module.st-chain-m13 .st-module-content > .live .eqinfo { left:0; right:0; top:auto; bottom:0; height:20%; font-size:.5cqw; }
    .skin .st-chain-module.st-chain-m0 .st-module-content > .eqinfo,
    .skin .st-chain-module.st-chain-m1 .st-module-content > .eqinfo { font-size:.6cqw; }
    .skin .section.session > .bigbtn { position:absolute; }
    .skin .section.session > .bigbtn.recBig::before, .skin .section.session > .bigbtn.recbig::before { position:absolute; left:8%; top:50%; transform:translateY(-50%); margin:0; width:.72em; height:.72em; }
    .skin .st-listen::before { content:''; position:absolute; left:8%; top:50%; transform:translateY(-50%); width:0; height:0; border-top:.42em solid transparent; border-bottom:.42em solid transparent; border-left:.62em solid currentColor; }
    .skin .st-stems::before { content:''; position:absolute; left:7%; top:50%; transform:translateY(-50%); box-sizing:border-box; width:.78em; height:.68em; border:.09em solid currentColor; border-bottom:0; border-radius:.7em .7em 0 0; background:linear-gradient(currentColor,currentColor) left bottom/.16em .25em no-repeat,linear-gradient(currentColor,currentColor) right bottom/.16em .25em no-repeat; }
    .skin .status > span { font-size:clamp(7px,.5cqw,13px); line-height:1; }
    .skin .status > span.clock { justify-content:center; text-align:center; font:700 .7cqw/1 'Oswald',sans-serif; letter-spacing:.02em; }
    .skin .strip .name { font:700 .82cqw/1 'Barlow Condensed','Oswald',sans-serif; letter-spacing:.02em; white-space:nowrap; }
    /* chain-module buttons (MIC / AUTO-TUNE / CHAIN ON / REC): 9-slice like the EQ buttons, corners keep their shape instead of the plate being stretched */
    .skin .st-chain-module .st-module-content .btn.fxon, .skin .st-chain-module .st-module-content .btn.takebtn { box-sizing:border-box; border:calc(11 / 4344 * 100cqw) solid transparent; border-image:${T('sk-st-cream.png')} 22 30 22 30 fill / calc(11 / 4344 * 100cqw) stretch; background:none; padding:0; display:flex; align-items:center; justify-content:center; }
    .skin .st-chain-module .st-module-content .btn.fxon.on { border-image:${T('sk-st-amber.png')} 22 28 22 28 fill / calc(11 / 4344 * 100cqw) stretch; }
    .skin .st-chain-module .st-module-content .btn.fxon, .skin .st-chain-module .st-module-content .btn.takebtn { color:#3a2412 !important; text-shadow:0 1px 0 #ffffff55 !important; }
    .skin .st-chain-module .st-module-content .btn.fxon.on { color:#8a1a0a !important; }
    /* Vocal Chain buttons: whole plates (pressed / unpressed, text + LED painted in) from design/ref/chainbtn-*-ref.png; live label hidden */
    .skin .st-chain-module .st-module-content .btn.fxon, .skin .st-chain-module .st-module-content .btn.takebtn { border:0 !important; border-image:none !important; background-color:transparent !important; background-repeat:no-repeat !important; background-position:center !important; background-size:100% 100% !important; font-size:0 !important; color:transparent !important; text-shadow:none !important; filter:none !important; box-shadow:none !important; }
    .skin .st-chain-module .st-module-content .btn.fxon *, .skin .st-chain-module .st-module-content .btn.takebtn * { display:none !important; }
    .skin .st-chain-module .st-module-content .btn.takebtn::before { display:none !important; }
    .skin .st-chain-module.st-chain-m0 .st-module-content .btn.fxon { background-image:${T('sk-st-cb-mic-off.png')} !important; } .skin .st-chain-module.st-chain-m0 .st-module-content .btn.fxon.on { background-image:${T('sk-st-cb-mic-on.png')} !important; }
    .skin .st-chain-module.st-chain-m1 .st-module-content .btn.fxon { background-image:${T('sk-st-cb-at-off.png')} !important; } .skin .st-chain-module.st-chain-m1 .st-module-content .btn.fxon.on { background-image:${T('sk-st-cb-at-on.png')} !important; }
    /* MIC / AUTO-TUNE: smaller, plate-shaped (no stretching): narrower than the module and lower in height */
    .skin .st-chain-module.st-chain-m0 .st-module-content > .modbody > .fxon { left:19% !important; right:19% !important; width:62% !important; height:30% !important; margin-top:calc(22 / 4344 * 100cqw) !important; }
    /* knobs + their labels sit a little lower in the modules (Gate ... Delay); Input / Auto-Tune keep their own layout */
    .skin .st-chain-module:not(.st-chain-m0):not(.st-chain-m1) .st-module-content > .modbody { transform:translateY(calc(34 / 4344 * 100cqw)); }
    .skin .st-chain-module.st-chain-m1 .st-module-content > .btn { left:20% !important; right:20% !important; width:auto !important; height:11.5% !important; top:74% !important; }
    .skin .st-chain-module.st-chain-m13 .st-module-content .btn.fxon { background-image:${T('sk-st-cb-chain-off.png')} !important; } .skin .st-chain-module.st-chain-m13 .st-module-content .btn.fxon.on { background-image:${T('sk-st-cb-chain-on.png')} !important; }
    .skin .st-chain-module.st-chain-m13 .st-module-content .btn.takebtn { background-image:${T('sk-st-cb-rec-off.png')} !important; } .skin .st-chain-module.st-chain-m13 .st-module-content .btn.takebtn.on { background-image:${T('sk-st-cb-rec-on.png')} !important; }
    .skin:not(.m-karaoke):not(.mixview):not(.practice) .st-chainrow .st-chain-module .btn.fxon,
    .skin:not(.m-karaoke):not(.mixview):not(.practice) .st-chainrow .st-chain-module .btn.takebtn { filter:brightness(1.65); }
    .skin .st-chain-module.st-chain-m10 .st-module-content > .st-select-wrap:nth-child(2) { left:10%; right:10%; top:18%; bottom:auto; width:auto; height:calc(55 / 4344 * 100cqw); }
    .skin .st-chain-module .btn.fxon, .skin .st-chain-module .btn.takebtn { color:#f1d6bd; text-shadow:0 1px 2px #120b05; }
    .skin .st-channels > .strip .btn, .skin .strip .name, .skin .strip .micfx { display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.82cqw; line-height:1; white-space:nowrap; padding:0; }
    .skin .strip .btns .btn { display:flex; align-items:center; justify-content:center; font-size:clamp(12px,20cqi,24px); }
    .skin .strip .name { font-size:clamp(12px,20cqi,24px); }
    .skin .strip .micfx { font-size:clamp(12px,18cqi,22px); }
    .skin .section.session .advtoggle { font:700 .68cqw/1 'Barlow Condensed','Oswald',sans-serif; }
    .skin .section.session > .bigbtn { font-size:clamp(11px,.72cqw,19px) !important; line-height:1 !important; letter-spacing:.03em; }
    .skin .section.session > .startk { font-size:clamp(9px,.58cqw,16px) !important; }
    .skin .section.tune .switches .btn, .skin .section.eq .btn, .skin .section.enh .switches > .btn, .skin .section.output .limiter { font-size:clamp(10px,.62cqw,20px); font-weight:700; }
    .skin .section.eq .btn.on, .skin .section.enh .switches > .btn.on, .skin .section.output .limiter.on { color:#8a1a0a; }
    .skin .st-chain-module .st-module-content > .btn.fxon, .skin .st-chain-module .st-module-content > .btn.takebtn { font-size:.7cqw; font-weight:700; line-height:1; white-space:nowrap; }
    .skin .st-chain-module .st-module-content > .btn.fxon.on { color:#8a1a0a; text-shadow:0 1px 1px #fff4; }
    .skin .section.session > .bigbtn, .skin .section.session .btn.startk,
    .skin .section.eq .switches .btn, .skin .section.enh .switches > .btn,
    .skin .section.output .limiter, .skin .st-mixer .strip .name,
    .skin .st-mixer .strip .btns .btn, .skin .st-mixer .strip .micfx,
    .skin .expbtn, .skin .offrow {
      opacity:1; overflow:visible; text-align:center; text-shadow:0 1px 1px #fff4;
      color:#2a1a0c !important; -webkit-text-fill-color:#2a1a0c !important;
    }
    .skin .section.session > .startk { font-size:clamp(10px,.58cqw,16px) !important; letter-spacing:.02em; }
    .skin .section.session > .bigbtn.recBig::before, .skin .section.session > .bigbtn.recbig::before { left:7%; }
    .skin .section.eq .btn.on, .skin .section.enh .switches > .btn.on,
    .skin .section.output .limiter.on, .skin .section.session > .bigbtn.on {
      color:#8a1a0a !important; -webkit-text-fill-color:#8a1a0a !important;
    }
    .skin .st-mixer .strip .btns .btn.mute { color:#f1d6bd !important; -webkit-text-fill-color:#f1d6bd !important; text-shadow:0 1px 2px #120b05; }
    .skin button:disabled, .skin .btn:disabled { opacity:.5 !important; }
    .skin .section.session .sessinfo { font-size:clamp(5px,.42cqw,12px); line-height:1; white-space:nowrap; text-overflow:clip; }
    .skin .status > span { min-width:0; overflow:hidden; text-overflow:clip; white-space:nowrap; }
    .skin .st-mixer .strip .name { font-size:clamp(7px,22cqi,22px); letter-spacing:0; color:#f0d6a5 !important; -webkit-text-fill-color:#f0d6a5 !important; text-shadow:0 1px 2px #120b05; }
    .skin .st-mixer .strip .btns .btn { font-size:clamp(7px,16cqi,20px); letter-spacing:0; }
    .skin .st-mixer .fader-wrap { left:8%; width:84%; }
    .skin .st-mixer .scale { display:flex; flex:0 0 clamp(12px,34cqi,22px); width:clamp(12px,34cqi,22px); min-width:0; font-size:clamp(6px,13cqi,10px); line-height:1; }
    .skin .st-mixer .strip .btns .btn.mute:not(.on) { color:#f1d6bd !important; -webkit-text-fill-color:#f1d6bd !important; }
    @container (max-width:45px) {
      .skin .st-mixer .strip .btns { height:17%; flex-direction:column; gap:2%; }
      .skin .st-mixer .strip .btns .btn { flex:1 1 0; width:100%; font-size:clamp(5px,20cqi,10px); }
      .skin .st-mixer .fader-wrap { top:20%; left:18%; width:68%; }
      .skin .st-mixer .scale { display:none; }
      .skin .st-mixer .strip .name { font-size:clamp(5px,24cqi,11px); }
    }
    .skin .st-chain-module .btn.fxon.on, .skin .section.eq .btn.on, .skin .section.enh .btn.on, .skin .section.output .limiter.on { color:#8a1a0a; text-shadow:0 1px 1px #fff4; }
    .skin .st-chain-module .st-rec::before { content:''; flex:none; width:.55em; height:.55em; border-radius:50%; background:#bd1f0e; box-shadow:inset 0 0 0 .08em #65120a,0 0 1px #000; margin-right:.42em; }
    .skin .btn:not(.mute):not(.modled):active { transform:translateY(1px); }  `;

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
      const consoleEl = h('div', 'console skin');
      studio.consoleEl = consoleEl;
      const section = studioMakeSection('Mixer');
      section.classList.add('mixer');
      section.appendChild(h('div', 'channels'));
      const expBtn = h('button', 'btn solo expbtn', 'EXPORT', { type: 'button', 'aria-label': 'Export the current mix as MP3' });
      expBtn.title = 'Bounces the library recording with the current Mixer settings to a finished MP3 (MIXED tab).';
      expBtn.style.marginTop = '6px';
      const syncExp = () => { expBtn.disabled = !libPlayer.mix || mixExporting; expBtn.classList.toggle('on', mixExporting); expBtn.textContent = mixExporting ? 'EXPORTING...' : 'EXPORT'; };
      studio.syncExport = syncExp;
      expBtn.addEventListener('click', async () => {
        if (!libPlayer.mix || mixExporting) return;
        const pending = exportMix(); syncExp();
        const res = await pending; syncExp();
        if (res.ok) { studio.libOpen?.(true); studio.libShowTab?.('mix'); } else { expBtn.textContent = 'FAILED'; setTimeout(syncExp, 1500); }
      });
      section.appendChild(expBtn);
      const offRow = h('div', 'offrow');
      offRow.title = 'Mic delay compensation: how many ms the mic layer was recorded late. Measured automatically at REC time; fine-tune by ear (raise it if the voice still trails the music).';
      const offIn = h('input', 'txt offin', null, { type: 'number', min: '-500', max: '500', step: '5', 'aria-label': 'Mic delay compensation in milliseconds' });
      for (const k of ['keydown', 'keyup', 'keypress']) offIn.addEventListener(k, (ev) => ev.stopPropagation());
      offRow.append(h('span', 'offlbl', 'MIC SHIFT'), offIn, h('span', 'offlbl', 'ms'));
      studio.syncOffset = () => { offIn.value = String(libPlayer.micOffsetMs || 0); offIn.disabled = !libPlayer.mix || !libPlayer.mix.keys.some(isMicLayer); };
      offIn.addEventListener('change', () => {
        const v = Math.max(-500, Math.min(500, Math.round(Number(offIn.value) || 0)));
        libPlayer.micOffsetMs = v; offIn.value = String(v);
        if (libPlayer.id) ipcRenderer.invoke('poc:rec-set-offset', libPlayer.id, v).then(() => recRefresh()).catch(() => {});
        if (libPlayer.playing) libStartAt(libPos()); // re-time the running mix
      });
      section.appendChild(offRow);
      studio.syncOffset();
      syncExp();
      const eqSection = studioMakeSection('Equalizer');
      eqSection.classList.add('eq');
      const outSection = studioMakeSection('Output'); outSection.classList.add('output');
      const sessSection = studioMakeSection('Session');
      sessSection.classList.add('session');
      const tuneSection = studioMakeSection('Key & Tempo');
      tuneSection.classList.add('tune');
      const status = h('div', 'status');
      const clock = h('span', 'clock', '--:--:--');
      status.append(h('span'), h('span'), h('span'), clock);
      const tick = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
      tick(); setInterval(tick, 500); // local time, to match skips heard against the UTC logs (+3 h here)
      const chainSection = studioMakeSection('Vocal Chain');
      chainSection.classList.add('chain');
      const enhSection = studioMakeSection('Enhancer');
      enhSection.classList.add('fx', 'enh');
      consoleEl.append(sessSection, tuneSection, section, eqSection, enhSection, outSection, chainSection, status);
      drawer.append(h('div', 'wood'), consoleEl, h('div', 'wood'));
      ui.append(drawer, h('button', 'tab', 'STUDIO \u25B2', { type: 'button', 'aria-label': 'Toggle studio drawer' }));
      studioBuildLibrary(ui);
      studioBuildLyrics(ui);
      studioBuildNowPlaying(ui);
      studioBuildTopMeters(ui); studioBuildGeq(ui);
      const CHORDS_ENABLED = false; // experimental chord detection: code kept intact, switched off (no box, no analysis, no audio tap); set true to bring it back
      if (CHORDS_ENABLED) studioBuildChords(ui);
      studioBuildWinButtons(ui);
      studioBuildBrand(ui); studioBgFx();
      studioBuildSteamPanel(ui);
      studioSparks();
      studioBuildChains(ui);
      // bundled fonts (OFL): Oswald = headings, Barlow Condensed = song/playlist names + studio labels, Barlow = body text
      const LAT = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
      const LEX = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
      const FACE = (fam, w, file) => ['latin', 'latin-ext'].map((sub) => { const d = tex && tex['f:' + file + '-' + sub + '.woff2']; return d ? `@font-face { font-family: '${fam}'; font-weight: ${w}; font-style: normal; font-display: swap; src: url("${d}") format('woff2'); unicode-range: ${sub === 'latin' ? LAT : LEX}; }` : ''; }).join('\n');
      const fontCss = [FACE('Cinzel Decorative', 700, 'cinzel-decorative-700'), FACE('Oswald', 600, 'oswald-600'), FACE('Oswald', 700, 'oswald-700'), FACE('Barlow Condensed', 500, 'barlow-condensed-500'), FACE('Barlow Condensed', 600, 'barlow-condensed-600'), FACE('Barlow', 400, 'barlow-400'), FACE('Barlow', 600, 'barlow-600')].join('\n');
      // YTM page skin, step 1: top bar (rust/metal plate with corner screws, inset brass-rimmed search field)
      const skinCss = `
        ${fontCss}
        .background-gradient { background: none !important; } ytmusic-fullbleed-thumbnail-renderer { display: none !important; }
        html, body { background: ${T('sk-bg.jpg')} center / cover no-repeat fixed, #0b0806 !important; }
        html { overflow-x: hidden !important; }
        ytmusic-app, ytmusic-app-layout, ytmusic-browse-response, ytmusic-tabbed-search-results-renderer, #main-panel, #content { --ytmusic-general-background-c: transparent; background: transparent !important; }
        ytmusic-nav-bar, ytmusic-nav-bar #left-content { --ytmusic-nav-bar-background: transparent; }
        /* header = one riveted copper plate (user-supplied sk-topplate.png): 9-slice so corners/rivets stay sharp; edges repeat the rivet row */
        ytmusic-nav-bar { background: #0b0806 !important; border: 0 !important; box-shadow: 0 5px 16px #000c !important;
          border-image: ${T('sk-topplate.png')} 64 fill / 22px round !important; }
        ytmusic-nav-bar #left-content { background: transparent !important; }
        ytmusic-nav-bar ytmusic-logo { visibility: hidden !important; }
        /* fonts: Barlow = body, Barlow Condensed = song / playlist / menu names, Oswald = headings */
        html, body, ytmusic-app, ytmusic-app tp-yt-paper-item, ytmusic-app yt-formatted-string, ytmusic-app a, ytmusic-app span, ytmusic-app button, ytmusic-app input { font-family: 'Barlow', 'Segoe UI', sans-serif !important; }
        ytmusic-app h1, ytmusic-app h2, ytmusic-app h3, ytmusic-app h2 *, ytmusic-app h1 *, ytmusic-carousel-shelf-basic-header-renderer .title, ytmusic-carousel-shelf-basic-header-renderer .title *,
        ytmusic-shelf-renderer .title, ytmusic-shelf-renderer .title *, ytmusic-section-list-renderer .title.ytmusic-carousel-shelf-basic-header-renderer { font-family: 'Cinzel Decorative', 'Oswald', serif !important; font-weight: 700 !important; letter-spacing: .03em; color: #ffc46b !important; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; animation: poc-neon 7s linear infinite; }
        /* shelf titles: a small dark plate with faint filament wires; the lettering burns on the wires and flickers now and then */
        :is(ytmusic-carousel-shelf-basic-header-renderer yt-formatted-string.title, .poc-ntitle) { position: relative; isolation: isolate; overflow: visible !important; display: inline-block !important; box-sizing: border-box; padding: 4px 20px 4px !important; margin: 10px 58px !important; font-size: 28px !important; line-height: 1.25 !important;
          background: repeating-linear-gradient(0deg, rgba(var(--gw), calc(.17 + var(--gh) * .5)) 0 1px, transparent 1px 6px), repeating-linear-gradient(90deg, rgba(var(--gw), calc(.17 + var(--gh) * .5)) 0 1px, transparent 1px 6px), radial-gradient(ellipse at center, rgba(255, 70, 20, calc(var(--gh) * .22)), transparent 75%), #0d0a08e6; border: 1px solid #6a5636; border-radius: 6px; box-shadow: inset 0 0 12px #000, 0 2px 6px #000a, 0 0 calc(var(--gh) * 38px) calc(var(--gh) * 8px) rgba(255, 55, 20, calc(var(--gh) * .55)); animation: poc-glow 4.5s linear infinite, poc-heat 7s ease-in-out infinite !important; opacity: 1 !important; }
        /* current in the wires, irregular: three independent windows (own speed, own period) reveal a dim bright copy of the grid, flaring and jumping about */
        @property --p1 { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
        @property --a1 { syntax: '<number>'; inherits: false; initial-value: 0; }
        @property --p2 { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
        @property --a2 { syntax: '<number>'; inherits: false; initial-value: 0; }
        @property --p3 { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
        @property --a3 { syntax: '<number>'; inherits: false; initial-value: 0; }
        :is(ytmusic-carousel-shelf-basic-header-renderer yt-formatted-string.title, .poc-ntitle)::before { content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: 5px; opacity: .5;
          background: repeating-linear-gradient(0deg, #ffc46b 0 1px, transparent 1px 6px), repeating-linear-gradient(90deg, #ffc46b 0 1px, transparent 1px 6px); filter: drop-shadow(0 0 1px #ffb34788);
          -webkit-mask-image: linear-gradient(90deg, transparent calc(var(--p1) - 9%), rgba(0, 0, 0, var(--a1)) var(--p1), transparent calc(var(--p1) + 9%)), linear-gradient(90deg, transparent calc(var(--p2) - 6%), rgba(0, 0, 0, var(--a2)) var(--p2), transparent calc(var(--p2) + 6%)), linear-gradient(90deg, transparent calc(var(--p3) - 12%), rgba(0, 0, 0, var(--a3)) var(--p3), transparent calc(var(--p3) + 12%));
          mask-image: linear-gradient(90deg, transparent calc(var(--p1) - 9%), rgba(0, 0, 0, var(--a1)) var(--p1), transparent calc(var(--p1) + 9%)), linear-gradient(90deg, transparent calc(var(--p2) - 6%), rgba(0, 0, 0, var(--a2)) var(--p2), transparent calc(var(--p2) + 6%)), linear-gradient(90deg, transparent calc(var(--p3) - 12%), rgba(0, 0, 0, var(--a3)) var(--p3), transparent calc(var(--p3) + 12%));
          -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; animation: poc-z1 4.3s linear infinite, poc-z2 6.1s linear infinite, poc-z3 9.7s linear infinite; }
        @keyframes poc-z1 { 0% { --p1: 15%; --a1: 0; } 7% { --p1: 15%; --a1: 0.8; } 9% { --p1: 19%; --a1: 0.2; } 10% { --p1: 52%; --a1: 0.9; } 13% { --p1: 56%; --a1: 0; } 34% { --p1: 56%; --a1: 0; } 35% { --p1: 81%; --a1: 0.7; } 38% { --p1: 70%; --a1: 0.1; } 39% { --p1: 40%; --a1: 0.8; } 41% { --p1: 44%; --a1: 0; } 70% { --p1: 44%; --a1: 0; } 72% { --p1: 5%; --a1: 0.6; } 76% { --p1: 30%; --a1: 0.9; } 79% { --p1: 33%; --a1: 0; } 100% { --p1: 33%; --a1: 0; } }
        @keyframes poc-z2 { 0% { --p2: 70%; --a2: 0; } 12% { --p2: 70%; --a2: 0; } 13% { --p2: 62%; --a2: 0.9; } 15% { --p2: 66%; --a2: 0.1; } 16% { --p2: 30%; --a2: 0.7; } 20% { --p2: 22%; --a2: 0; } 46% { --p2: 22%; --a2: 0; } 47% { --p2: 90%; --a2: 0.8; } 49% { --p2: 84%; --a2: 0.3; } 50% { --p2: 88%; --a2: 0; } 62% { --p2: 88%; --a2: 0; } 63% { --p2: 48%; --a2: 0.9; } 64% { --p2: 50%; --a2: 0.1; } 66% { --p2: 12%; --a2: 0.8; } 69% { --p2: 8%; --a2: 0; } 100% { --p2: 8%; --a2: 0; } }
        @keyframes poc-z3 { 0% { --p3: 40%; --a3: 0; } 18% { --p3: 40%; --a3: 0; } 19% { --p3: 36%; --a3: 0.7; } 23% { --p3: 60%; --a3: 0.5; } 26% { --p3: 64%; --a3: 0; } 41% { --p3: 64%; --a3: 0; } 42% { --p3: 10%; --a3: 0.9; } 43% { --p3: 14%; --a3: 0.2; } 44% { --p3: 78%; --a3: 0.8; } 48% { --p3: 72%; --a3: 0; } 75% { --p3: 72%; --a3: 0; } 76% { --p3: 28%; --a3: 0.6; } 79% { --p3: 46%; --a3: 0.9; } 82% { --p3: 50%; --a3: 0; } 100% { --p3: 50%; --a3: 0; } }
        /* a bolted cable connector (brass terminals, red / green / blue leads) feeds the plate from each side */
        :is(ytmusic-carousel-shelf-basic-header-renderer yt-formatted-string.title, .poc-ntitle)::after { content: ""; position: absolute; left: -52px; right: -52px; top: -10px; bottom: -10px; pointer-events: none; z-index: -1;
          background: ${T('sk-cable-l.png')} left center / auto 100% no-repeat, ${T('sk-cable-r.png')} right center / auto 100% no-repeat; filter: drop-shadow(0 2px 3px #000b); }
        :is(ytmusic-carousel-shelf-basic-header-renderer yt-formatted-string.title, .poc-ntitle) > * { position: relative; }
        @property --gh { syntax: '<number>'; inherits: false; initial-value: 0; }
        @property --gw { syntax: '<number>#'; inherits: false; initial-value: 255, 157, 61; }
        i.poc-hook { position: absolute; height: 46px; pointer-events: none; z-index: 2; box-sizing: border-box; border: solid transparent; border-width: 0 24px; border-image: ${T('sk-hook.png')} 0 60 fill / 0 24px / 0 stretch; filter: drop-shadow(0 2px 3px #000c);
 }
        i.poc-hook.t { top: 16%; } i.poc-hook.b { bottom: 16%; }
        :is(ytmusic-carousel-shelf-basic-header-renderer yt-formatted-string.title, .poc-ntitle) > i.poc-spark { position: absolute; z-index: 3; width: 1.5px; height: 1.5px; border-radius: 50%; pointer-events: none; opacity: 0; background: #fffbe6; box-shadow: 0 0 2px 1px #ffd27a, 0 0 5px 1px #ff7a1fcc; animation: poc-fall 1.5s linear infinite; }
        @keyframes poc-fall { 0% { opacity: 0; transform: translate(0, 0) scale(1); } 0.3% { opacity: 1; transform: translate(0, 0) scale(1.8); } 2.5% { opacity: 1; transform: translate(calc(var(--dx) * .8), calc(var(--dy) * .8)) scale(1); } 5% { opacity: .7; transform: translate(var(--dx), calc(var(--dy) + 6px)) scale(.7); } 7% { opacity: 0; transform: translate(calc(var(--dx) * 1.1), calc(var(--dy) + 12px)) scale(.4); } 100% { opacity: 0; transform: translate(calc(var(--dx) * 1.1), calc(var(--dy) + 12px)); } }
        @keyframes poc-heat { 0%, 12% { --gh: 0; --gw: 255, 157, 61; } 32% { --gh: .45; --gw: 255, 120, 45; } 46% { --gh: 1; --gw: 255, 82, 35; } 52% { --gh: .9; --gw: 255, 82, 35; } 76% { --gh: .25; --gw: 255, 130, 50; } 92%, 100% { --gh: 0; --gw: 255, 157, 61; } }
        @keyframes poc-glow { 0% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 58% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 59% { color: #8a5c2e; text-shadow: none; } 60% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 61% { color: #8a5c2e; text-shadow: none; } 62% { color: #d9a45c; text-shadow: 0 0 2px #ffb347, 0 0 5px #ff8a1f66; } 63% { color: #8a5c2e; text-shadow: none; } 64% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 65% { color: #8a5c2e; text-shadow: none; } 67% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 80% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 81% { color: #d9a45c; text-shadow: 0 0 2px #ffb347, 0 0 5px #ff8a1f66; } 82% { color: #8a5c2e; text-shadow: none; } 84% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 85% { color: #8a5c2e; text-shadow: none; } 86% { color: #8a5c2e; text-shadow: none; } 88% { color: #d9a45c; text-shadow: 0 0 2px #ffb347, 0 0 5px #ff8a1f66; } 89% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } 100% { color: #ffc46b; text-shadow: 0 0 3px #ffb347, 0 0 10px #ff8a1f99, 0 0 22px #ff6a0055; } }
        @keyframes poc-wire { 0%, 44%, 48%, 52%, 100% { opacity: .34; } 45% { opacity: .08; } 46% { opacity: .4; } 47% { opacity: .14; } 50% { opacity: .24; } 51% { opacity: .34; } }
        @keyframes poc-neon { 0%, 44%, 48%, 52%, 100% { opacity: 1; } 45% { opacity: .78; } 46% { opacity: 1; } 47% { opacity: .85; } 50% { opacity: .92; } 51% { opacity: 1; } }
        ytmusic-two-row-item-renderer .title, ytmusic-two-row-item-renderer .title *, ytmusic-responsive-list-item-renderer .title, ytmusic-responsive-list-item-renderer .title *,
        ytmusic-guide-entry-renderer tp-yt-paper-item, ytmusic-guide-entry-renderer yt-formatted-string, ytmusic-chip-cloud-chip-renderer *, ytmusic-search-box input { font-family: 'Barlow Condensed', 'Barlow', sans-serif !important; font-weight: 600 !important; letter-spacing: .02em; }
        ytmusic-guide-entry-renderer tp-yt-paper-item, ytmusic-guide-entry-renderer yt-formatted-string { font-size: 17px !important; }
        /* shelf cards: thin metal frame on a textured plate */
        ytmusic-two-row-item-renderer { box-sizing: border-box !important; padding: 7px 7px 6px !important; border: 7px solid transparent !important; border-image: ${T('sk-thin.png')} 30 / 9px stretch !important;
          background: linear-gradient(#00000040, #00000099), ${T('metal.jpg')} 0 0 / 256px 256px, #14110f !important; background-clip: padding-box !important; border-radius: 0 !important; }
        ytmusic-two-row-item-renderer { transition: box-shadow .15s; }
        ytmusic-two-row-item-renderer:hover { box-shadow: 0 0 16px 3px #ffb34780, 0 0 4px 1px #ffd27acc !important; }
        /* song-list shelves (Quick picks, Trending songs, Covers & remixes, Long listens ...): one steampunk plate per shelf; the small song rows stay unframed */
        ytmusic-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)), ytmusic-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)), ytmusic-immersive-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)) { position: relative; box-sizing: border-box !important; width: calc(100% + 28px) !important; max-width: none; margin: 76px auto 24px !important; padding: 12px 20px 16px !important; border: 26px solid transparent !important;
          border-image: ${T('sk-shelf-body.png')} 120 fill / 26px stretch !important; background: none !important; transition: box-shadow .15s; }
        ytmusic-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer))::before, ytmusic-shelf-renderer:not(:has(ytmusic-two-row-item-renderer))::before, ytmusic-immersive-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer))::before { content: ""; position: absolute; left: -26px; right: -26px; top: -94px; height: 72px; pointer-events: none;
          background: ${T('sk-shelf-bl.png')} left top / calc((100% - 545px) / 2) 100% no-repeat, ${T('sk-shelf-bc.png')} center top / 545px 100% no-repeat, ${T('sk-shelf-br.png')} right top / calc((100% - 545px) / 2) 100% no-repeat; }
        /* the two glass lamps and the gauge light up (5-step flicker) while the mouse is over the shelf */
        ytmusic-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer))::after, ytmusic-shelf-renderer:not(:has(ytmusic-two-row-item-renderer))::after, ytmusic-immersive-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer))::after { content: ""; position: absolute; left: calc(50% - 272px); width: 545px; top: -94px; height: 72px; pointer-events: none; opacity: 0; mix-blend-mode: screen;
          background: radial-gradient(circle at 53px 42px, #ffc15ccc 0, #ff8a1f77 9px, transparent 22px), radial-gradient(circle at 491px 42px, #ffc15ccc 0, #ff8a1f77 9px, transparent 22px), radial-gradient(circle at 270px 50px, #ffe9b077 0, #ffb34744 15px, transparent 31px); }
        ytmusic-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)):hover::after, ytmusic-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)):hover::after, ytmusic-immersive-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)):hover::after { animation: poc-flick 2.4s linear infinite; }
        @keyframes poc-flick { 0% { opacity: 0.25; } 6% { opacity: 0.55; } 11% { opacity: 0.95; } 15% { opacity: 0.7; } 19% { opacity: 1; } 26% { opacity: 0.8; } 31% { opacity: 0.35; } 35% { opacity: 0.6; } 41% { opacity: 1; } 47% { opacity: 0.9; } 52% { opacity: 0.45; } 57% { opacity: 0.85; } 63% { opacity: 1; } 69% { opacity: 0.6; } 74% { opacity: 0.3; } 80% { opacity: 0.75; } 87% { opacity: 0.95; } 93% { opacity: 0.5; } 100% { opacity: 0.25; } }
        ytmusic-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)):hover, ytmusic-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)):hover, ytmusic-immersive-carousel-shelf-renderer:not(:has(ytmusic-two-row-item-renderer)):hover { box-shadow: 0 0 18px 3px #ffb34775, 0 0 4px 1px #ffd27aaa; }
        /* left guide: framed metal panel with its own textured inner plate */
        ytmusic-app-layout #guide-wrapper { background: linear-gradient(#0b0806e6, #0b0806f2) !important; }
        ytmusic-app-layout, ytmusic-app { --ytmusic-guide-width: 300px !important; }
        html.ytmpoc-open ytmusic-guide-renderer { height: max(0px, calc(100vh - 112px - min(calc(100vw / 3), 84vh))) !important; }
        ytmusic-guide-renderer { box-sizing: border-box !important; margin: 0 !important; width: 100% !important; height: calc(100vh - 112px - 124px) !important; overflow-y: auto !important; overflow-x: hidden !important;
          border: 16px solid transparent !important; border-image: ${T('sk-sideplate.png')} 64 fill / 24px stretch !important; background: none !important; }
        ytmusic-guide-entry-renderer tp-yt-paper-item { background: transparent !important; border: 1px solid transparent !important; border-radius: 4px !important; color: #e9dcc2 !important; font-weight: 700 !important; letter-spacing: .05em; text-shadow: 0 1px 2px #000; }
        ytmusic-guide-entry-renderer:hover tp-yt-paper-item { background: #ffffff0f !important; color: #fff3d6 !important; }
        ytmusic-guide-entry-renderer[active] tp-yt-paper-item { background: linear-gradient(#3a2a18, #1d140b) !important; border-color: #c58a3a !important; color: #ffb85a !important; box-shadow: 0 0 10px #ff9a3a44, inset 0 0 8px #000a; }
        ytmusic-guide-renderer #divider, ytmusic-guide-renderer #divider * { border-color: #5a4630 !important; background-color: #5a4630 !important; }
        ytmusic-guide-section-renderer h3, ytmusic-guide-section-renderer #guide-section-title { color: #b49568 !important; letter-spacing: .14em; text-transform: uppercase; font-size: 11px !important; }
        ytmusic-guide-signin-promo-renderer .descriptive-text { color: #bfae8f !important; }
        ytmusic-guide-signin-promo-renderer button { background: linear-gradient(#3a322a, #1b1816) !important; color: #e9dcc2 !important; border: 1px solid #6a5636 !important; }
        ytmusic-nav-bar #right-content ytmusic-settings-button { zoom: 1; }
        /* cast + account: two small framed squares, close together (the avatar is a square picture inside a thin frame, not a circle) */
        ytmusic-nav-bar #right-content { gap: 8px !important; right: 66px !important; }
        @media (max-width: 1360px) { ytmusic-nav-bar #right-content { right: 22px !important; } ytmusic-nav-bar #right-content:has(> a) ytmusic-cast-button { display: none !important; } }
        /* signed out: the white SIGN IN pill becomes the brass plate (design/ref/signin-ref.png) */
        ytmusic-nav-bar #right-content > a { display: block !important; box-sizing: border-box; width: 88px !important; height: 44px !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: ${T('sk-signin.png')} center / 100% 100% no-repeat !important; font-size: 0 !important; color: transparent !important; overflow: hidden; filter: brightness(.86) saturate(.78) drop-shadow(0 2px 3px #000b); }
        ytmusic-nav-bar #right-content > a * { opacity: 0 !important; }
        ytmusic-nav-bar #right-content ytmusic-cast-button, ytmusic-nav-bar #right-content ytmusic-settings-button { display: flex !important; align-items: center; justify-content: center; box-sizing: border-box !important; width: 44px !important; height: 44px !important; margin: 0 !important; padding: 3px !important; overflow: hidden; border: 1px solid #8a6a3c !important; border-radius: 5px !important; background: #0b0806 !important; box-shadow: inset 0 0 6px #000c, 0 0 0 1px #0a0807; }
        ytmusic-nav-bar #right-content ytmusic-settings-button #avatar, ytmusic-nav-bar #right-content ytmusic-settings-button yt-img-shadow, ytmusic-nav-bar #right-content ytmusic-settings-button img { border-radius: 2px !important; box-shadow: none !important; width: 34px !important; height: 34px !important; object-fit: cover; }
        ytmusic-nav-bar #right-content ytmusic-settings-button yt-icon-button, ytmusic-nav-bar #right-content ytmusic-settings-button #button { padding: 0 !important; width: 36px !important; height: 36px !important; border-radius: 3px !important; overflow: hidden !important; background: transparent !important; }
        ytmusic-nav-bar #right-content { position: fixed !important; top: calc(11px + (1.5 - var(--poc-rz, 1)) * 44px); right: 14px; width: max-content !important; justify-content: flex-end; zoom: var(--poc-rz, 1); z-index: 2147483640; display: flex !important; align-items: center; }
        ytmusic-search-box .search-box { background: #0a0807 !important; background-clip: border-box !important; border: 14px solid transparent !important; border-image: ${T('sk-pill.png')} 72 / 28px stretch !important; border-radius: 26px !important; box-shadow: none !important; height: 56px !important; box-sizing: border-box !important; }
        ytmusic-app-layout { --ytmusic-nav-bar-height: 112px !important; }
        ytmusic-nav-bar { height: 112px !important; padding-right: 120px !important; box-sizing: border-box !important; }
        ytmusic-nav-bar ytmusic-search-box { margin-top: 0 !important; }
        ytmusic-search-box input { color: #eadfca !important; }
        /* the scrolling content column sits one background plate seam further left (user-aligned; the background scales with the width, so vw) */
        ytmusic-browse-response ytmusic-section-list-renderer { position: relative; left: -2.35vw; }
        /* mood chips, Play all / More, carousel arrows: brass plates cut from the asset sheet */
        ytmusic-chip-cloud-renderer, ytmusic-chip-cloud-renderer * { scrollbar-color: #c08a44 #0a0705aa !important; scrollbar-width: thin !important; }
        ytmusic-chip-cloud-renderer *::-webkit-scrollbar-track { background: #0a0705aa; border-radius: 3px; box-shadow: inset 0 0 2px #000; }
        ytmusic-chip-cloud-renderer *::-webkit-scrollbar-thumb { background: linear-gradient(#e0a95a, #8a5a24); border-radius: 3px; box-shadow: 0 0 4px #ff9a3a66; }
        ytmusic-chip-cloud-chip-renderer { --ytmusic-chip-background: transparent; background: none !important; border: 0 !important; border-radius: 0 !important; height: auto !important; padding: 0 !important; margin-right: 6px !important; filter: drop-shadow(0 2px 3px #000b); transition: filter .15s; }
        ytmusic-chip-cloud-chip-renderer .gradient-box { background: none !important; border: 0 !important; box-shadow: none !important; padding: 0 !important; }
        ytmusic-chip-cloud-chip-renderer a { display: flex !important; align-items: center; box-sizing: border-box; height: 38px !important; padding: 0 22px !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; background: none !important;
          border-image: ${T('sk-chip.png')} 38 44 fill / 13px 15px stretch !important; }
        ytmusic-chip-cloud-chip-renderer a, ytmusic-chip-cloud-chip-renderer a * { color: #e6d3ad !important; text-shadow: 0 1px 2px #000; }
        ytmusic-chip-cloud-chip-renderer:hover { filter: drop-shadow(0 0 6px #ffb34799) brightness(1.15); }
        ytmusic-chip-cloud-chip-renderer[is-selected] a, ytmusic-chip-cloud-chip-renderer a[aria-selected=true] { border-image: ${T('sk-chip-on.png')} 40 40 fill / 13px 15px stretch !important; }
        ytmusic-chip-cloud-chip-renderer[is-selected] a, ytmusic-chip-cloud-chip-renderer[is-selected] a *, ytmusic-chip-cloud-chip-renderer a[aria-selected=true], ytmusic-chip-cloud-chip-renderer a[aria-selected=true] * { color: #fff4dc !important; text-shadow: 0 1px 2px #000, 0 0 6px #ffb34799; }
        ytmusic-carousel-shelf-basic-header-renderer yt-button-renderer button, ytmusic-carousel-shelf-basic-header-renderer yt-button-shape button { background: none !important; border: 13px solid transparent !important; border-radius: 0 !important; height: 40px !important; padding: 0 10px !important; box-sizing: border-box;
          border-image: ${T('sk-btn-sm.png')} 34 40 fill / 13px 15px stretch !important; color: #fff4dc !important; font-weight: 700 !important; letter-spacing: .04em; text-shadow: 0 1px 2px #000, 0 0 6px #ffb34799; filter: drop-shadow(0 2px 3px #000b); }
        ytmusic-carousel-shelf-basic-header-renderer yt-button-renderer button:hover, ytmusic-carousel-shelf-basic-header-renderer yt-button-shape button:hover { filter: drop-shadow(0 0 6px #ffb347aa) brightness(1.12); }
        ytmusic-carousel-shelf-basic-header-renderer yt-button-renderer button * { color: #fff4dc !important; }
        ytmusic-carousel-shelf-renderer #previous-items-button, ytmusic-carousel-shelf-renderer #next-items-button { width: 40px !important; height: 40px !important; padding: 0 !important; border-radius: 50%; background: center / contain no-repeat !important; filter: drop-shadow(0 2px 3px #000c); }
        ytmusic-carousel-shelf-renderer #previous-items-button { background-image: ${T('sk-arr-l.png')} !important; }
        ytmusic-carousel-shelf-renderer #next-items-button { background-image: ${T('sk-arr-r.png')} !important; }
        ytmusic-carousel-shelf-renderer #previous-items-button > *, ytmusic-carousel-shelf-renderer #next-items-button > * { opacity: 0 !important; }
        ytmusic-carousel-shelf-renderer #previous-items-button:hover, ytmusic-carousel-shelf-renderer #next-items-button:hover { filter: drop-shadow(0 0 6px #ffb347aa) brightness(1.15); }
        ytmusic-carousel-shelf-renderer #previous-items-button[disabled], ytmusic-carousel-shelf-renderer #next-items-button[disabled] { opacity: .35; }
        #poc-bgfx { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
        #poc-bgfx .fxspace { position: absolute; left: 0; top: 0; width: 1920px; height: 1081px; transform-origin: 0 0; }
        #poc-bgfx .fx { position: absolute; display: block; will-change: transform, opacity; }
        #poc-bgfx .lamp { border-radius: 50%; background: radial-gradient(ellipse at center, #ffd88aaa 0, #ffa03a66 22%, #ff7a1a22 48%, transparent 70%); will-change: opacity; animation: poc-lampfx 3s linear infinite; }
        @keyframes poc-lampfx { 0%, 100% { opacity: .55; } 7% { opacity: .9; } 9% { opacity: .35; } 11% { opacity: .85; } 30% { opacity: .7; } 46% { opacity: 1; } 48% { opacity: .2; } 50% { opacity: .95; } 53% { opacity: .5; } 70% { opacity: .8; } 83% { opacity: .4; } 86% { opacity: .9; } }
        #poc-bgfx .valvebg { background: ${T('sk-fx-valvebg.png')} center / 100% 100%; }
        #poc-bgfx .valve { background: ${T('sk-fx-valve.png')} center / 100% 100%; animation: poc-spin 26s linear infinite; }
        @keyframes poc-spin { to { transform: rotate(360deg); } }
        #poc-bgfx .gauge { background: ${T('sk-fx-gauge.png')} center / 100% 100%; }
        #poc-bgfx .needle { background: linear-gradient(#1a0f08, #2a1a0e); border-radius: 1px 1px 0 0; transform-origin: 50% 100%; box-shadow: 0 0 1px #000; animation: poc-needle 9s ease-in-out infinite; }
        @keyframes poc-needle { 0% { transform: rotate(-55deg); } 12% { transform: rotate(-20deg); } 15% { transform: rotate(-27deg); } 30% { transform: rotate(35deg); } 33% { transform: rotate(28deg); } 36% { transform: rotate(40deg); } 52% { transform: rotate(-5deg); } 55% { transform: rotate(4deg); } 70% { transform: rotate(60deg); } 73% { transform: rotate(52deg); } 88% { transform: rotate(-35deg); } 92% { transform: rotate(-42deg); } 100% { transform: rotate(-55deg); } }
        #poc-bgfx .hub { border-radius: 50%; background: radial-gradient(circle at 35% 35%, #f0c070, #6a4010); }
        #poc-bgfx .puff { border-radius: 50%; background: radial-gradient(circle, #f6f3eeee 0, #e2ddd6c0 30%, #cfc8c060 55%, transparent 72%); filter: blur(3px); opacity: 0; animation: poc-steam 4.4s cubic-bezier(.25,.6,.4,1) infinite; }
        #poc-bgfx .puff.b { animation-name: poc-steam2; }
        #poc-bgfx .smoke { background: center / 100% 100% no-repeat; opacity: 0; animation: poc-smoke-r 4.8s linear infinite; }
        #poc-bgfx .smoke.r { background-image: ${T('sk-smoke-r.png')}; transform-origin: 14% 96%; }
        #poc-bgfx .smoke.l { background-image: ${T('sk-smoke-l.png')}; transform-origin: 86% 96%; animation-name: poc-smoke-l; }
        @keyframes poc-smoke-r { 0% { opacity: 0; transform: translate(-4px, 26px) scale(.55, .45) skewX(0deg); } 12% { opacity: .95; } 45% { opacity: .9; transform: translate(4px, 4px) scale(.95, .92) skewX(-4deg); } 75% { opacity: .55; transform: translate(14px, -24px) scale(1.12, 1.15) skewX(3deg); } 100% { opacity: 0; transform: translate(26px, -52px) scale(1.3, 1.35) skewX(-2deg); } }
        @keyframes poc-smoke-l { 0% { opacity: 0; transform: translate(4px, 24px) scale(.55, .45) skewX(0deg); } 12% { opacity: .95; } 45% { opacity: .9; transform: translate(-4px, 4px) scale(.95, .92) skewX(4deg); } 75% { opacity: .55; transform: translate(-14px, -22px) scale(1.12, 1.15) skewX(-3deg); } 100% { opacity: 0; transform: translate(-26px, -48px) scale(1.3, 1.35) skewX(2deg); } }
        @keyframes poc-steam { 0% { opacity: 0; transform: translate(0, 0) scale(.4); } 5% { opacity: .95; } 40% { opacity: .75; transform: translate(34px, -78px) scale(1.6); } 70% { opacity: .45; transform: translate(70px, -150px) scale(2.4); } 100% { opacity: 0; transform: translate(112px, -225px) scale(3.3); } }
        @keyframes poc-steam2 { 0% { opacity: 0; transform: translate(0, 0) scale(.35); } 5% { opacity: .9; } 40% { opacity: .7; transform: translate(52px, -66px) scale(1.5); } 70% { opacity: .4; transform: translate(84px, -140px) scale(2.2); } 100% { opacity: 0; transform: translate(130px, -205px) scale(3.1); } }
        #poc-brand { position: fixed; left: 112px; top: 30px; z-index: 2147483640; text-decoration: none; -webkit-app-region: no-drag; }
        #poc-brand .poc-ntitle { margin: 0 !important; padding: 8px 26px !important; font-size: 0 !important; line-height: 1 !important; }
        #poc-brand .poc-logo { display: flex !important; align-items: center; gap: 10px; text-shadow: none; filter: drop-shadow(0 0 3px #ffb34799) drop-shadow(0 0 8px #ff8a1f55); will-change: opacity; animation: poc-logo-glow 4.5s linear infinite; }
        @keyframes poc-logo-glow { 0% { opacity: 1; } 58% { opacity: 1; } 59% { opacity: 0.42; } 60% { opacity: 1; } 61% { opacity: 0.42; } 62% { opacity: 0.75; } 63% { opacity: 0.42; } 64% { opacity: 1; } 65% { opacity: 0.42; } 67% { opacity: 1; } 80% { opacity: 1; } 81% { opacity: 0.75; } 82% { opacity: 0.42; } 84% { opacity: 1; } 85% { opacity: 0.42; } 86% { opacity: 0.42; } 88% { opacity: 0.75; } 89% { opacity: 1; } 100% { opacity: 1; } } /* opacity only: runs on the compositor (an animated filter repainted every frame on the main thread) */
        #poc-brand .brandicon { width: 34px; height: 24px; flex: none; filter: drop-shadow(0 1px 2px #000); }
        #poc-brand .brandname, #poc-brand .brandname * { font: 700 22px/1 'Oswald', 'Barlow Condensed', sans-serif !important; color: #f1e6d3 !important; white-space: nowrap; text-shadow: 0 1px 2px #000 !important; letter-spacing: -.01em; }
        #poc-brand .brandname .bm { color: #ff6a3d !important; }
        #poc-brand .brandsub { margin-top: 5px; font: 600 10px/1 'Oswald', 'Barlow Condensed', sans-serif !important; letter-spacing: .62em; padding-left: .62em; color: #e6d3ad !important; text-align: center; text-shadow: 0 1px 2px #000 !important; }
        ytmusic-nav-bar ytmusic-search-box { position: relative; left: clamp(0px, calc(560px - 33vw), 130px); width: min(480px, calc(100vw - 940px)) !important; min-width: 240px; }
      `;
      root.append(style, ui);
      try { const gs = document.createElement('style'); gs.textContent = 'ytmusic-player-bar { opacity: 0 !important; pointer-events: none !important; }' + skinCss; (document.head || document.documentElement).appendChild(gs); } catch {} // our own bar replaces the native one (kept alive: its buttons are still clicked programmatically)
      studio.host = host; studio.root = root;
      studio.statusEls = [...root.querySelectorAll('.status span')];
      root.querySelector('.tab').addEventListener('click', () => studioSetOpen(!studio.open));
      studioRebuildStrips();
      studioBuildEq(eqSection);
      studioBuildOutput(outSection);
      studioBuildSession(sessSection);
      studioBuildTune(tuneSection);
      for (const n of ['top', 'right', 'big']) sessSection.appendChild(h('div', 'st-wheel sg-' + n)).appendChild(h('i')); // big last = on top, its tooth gaps show the other gears
      { // gears: LISTEN lit = 1 gear turns, LISTEN WITH STEMS = 2, KARAOKE = 3
        const sessModes = [...sessSection.querySelectorAll(':scope > .bigbtn')];
        const count = (b) => (b.classList.contains('stemb') ? 2 : b.classList.contains('recbig') ? 3 : 1);
        const sessSync = () => { const n = Math.max(0, ...sessModes.filter((b) => b.classList.contains('on') && !b.classList.contains('startk')).map(count)); for (let i = 1; i <= 3; i++) sessSection.classList.toggle('sess-g' + i, n >= i); };
        sessModes.forEach((b) => new MutationObserver(sessSync).observe(b, { attributes: true, attributeFilter: ['class'] })); sessSync();
      }
      setAppMode(appMode); // shows the LISTEN controls from the start
      studioBuildChain(chainSection);
      studioBuildEnhancer(enhSection);
      // Reference image is 4344x1448; map its pixel slots into the 3:1 skin.
      const stPlace = (el, x0, y0, x1, y1) => {
        if (!el) return;
        el.classList.add('st-placed');
        el.style.left = (x0 / 4344 * 100) + '%'; el.style.top = (y0 / 1448 * 100) + '%';
        el.style.width = ((x1 - x0) / 4344 * 100) + '%'; el.style.height = ((y1 - y0) / 1448 * 100) + '%';
      };
      const q = (root, selector) => root.querySelector(selector);
      const qa = (root, selector) => [...root.querySelectorAll(selector)];
      const sessBtns = qa(sessSection, ':scope > .btn');
      stPlace(sessBtns[0],108,178,465,250); stPlace(sessBtns[1],108,285,465,358); stPlace(sessBtns[2],108,392,465,467); stPlace(sessBtns[3],108,392,465,467);
      stPlace(q(sessSection,'.advtoggle'),158,508,408,568); stPlace(q(sessSection,'.sessinfo'),108,572,465,618);
      // Advanced controls stay on the session plate as an overlay, preserving their existing events.
      const adv=q(sessSection,'.adv'); if(adv){ adv.classList.add('st-adv'); stPlace(adv,108,178,465,467); }
      const tuneRows=qa(tuneSection,'.tunerow');
      for(const [row,y0,y1] of [[tuneRows[0],178,235],[tuneRows[1],265,322]]) { const c=[...row.children]; row.style.top=(y0/1448*100)+'%'; row.style.height=((y1-y0)/1448*100)+'%'; [[c[1],652,698],[c[2],702,795],[c[3],802,848]].forEach(([el,x0,x1])=>{el.classList.add('st-placed'); el.style.left=(x0/4344*100)+'%'; el.style.top='0'; el.style.width=((x1-x0)/4344*100)+'%'; el.style.height='100%';}); }
      stPlace(q(tuneSection,'.switches button'),646,374,730,410); stPlace(q(tuneSection,'.eqinfo'),555,458,822,500);
      // Mixer controls adapt to the number of active stems while filling the reference mixer bay.
      const mixer=consoleEl.querySelector('.section.mixer'); mixer.classList.add('st-mixer');
      const channels=q(mixer,'.channels'); channels.classList.add('st-channels');
      stPlace(channels,903,176,1420,765);
      const exp=q(mixer,'.expbtn'), off=q(mixer,'.offrow'); if(exp) exp.classList.add('st-mixer-extra'); if(off) off.classList.add('st-mixer-extra');
      q(mixer,'.micfx')?.classList.add('st-micfx');
      // Mix export and mic shift remain inside the mixer bay in mixview.
      stPlace(exp,1080,718,1235,765); stPlace(off,905,710,1068,765);
      const eq=q(eqSection,'.eq-screen'); stPlace(eq,1574,178,2598,478); stPlace(q(eqSection,'.eq-geq'),1574,178,2598,478); stPlace(q(eqSection,'.eq-geqpre'),1572,592,2598,650); stPlace(q(eqSection,'.eq-tube.l'),1462,332,1526,490); stPlace(q(eqSection,'.eq-tube.r'),2638,332,2700,490);
      const eqRow=qa(eqSection,'.switches');
      const eqBtns=qa(eqRow[0],'.btn'); [[1572,1900],[1935,2255],[2290,2598]].forEach(([x0,x1],i)=>stPlace(eqBtns[i],x0,506,x1,566));
      const er=qa(eqSection,'.eqrow > *'); [[1572,1935],[1962,2355],[2380,2490],[2510,2598]].forEach(([x0,x1],i)=>stPlace(er[i],x0,592,x1,650));
      const info=q(eqSection,'.eqinfo-row'); stPlace(info,1580,668,2005,708); const qlabel=info.children[1], qr=q(info,'.qrange'); if(qlabel){qlabel.classList.add('st-placed'); qlabel.style.left=((2232-1580)/(2005-1580)*100)+'%'; qlabel.style.top='0'; qlabel.style.width='11%'; qlabel.style.height='100%';} if(qr){qr.classList.add('st-placed'); qr.style.left=((2280-1580)/(2005-1580)*100)+'%'; qr.style.top='0'; qr.style.width=((2580-2280)/(2005-1580)*100)+'%'; qr.style.height='100%';}
      const enhRow=q(enhSection,'.fxknobs'); const enhKnobs=qa(enhRow,'.knob-box');
      [[2786,164,2878,256],[2915,164,3007,256],[3042,164,3134,256],[3167,164,3259,256]].forEach(([x0,y0,x1,y1],i)=>stPlace(enhKnobs[i],x0,y0,x1,y1));
      q(enhSection,'.switches')?.classList.add('st-enh-switches');
      stPlace(q(sessSection,'.sg-big'),97,602,341,846); stPlace(q(sessSection,'.sg-right'),319,639,465,785); stPlace(q(sessSection,'.sg-top'),294,589,396,691); stPlace(q(tuneSection,'.st-wheel.k'),579,538,817,776);
      { // side pillars and corners: wheels (valve + 2 corner gears always turn; the 2 pipe gears, capacitor glow and steam only while the Vocal Lab is on)
        const fxLayer=h('div','st-fx'); consoleEl.prepend(fxLayer);
        for (const [n,x0,y0,x1,y1] of [['v',4050,555,4154,659],['g1',4046,834,4254,1042],['g2',4094,1193,4298,1397],['br',4218,1329,4336,1447],['bl',16,1331,128,1443]]) { const w=h('div','st-sfx sfx-'+n); w.appendChild(h('i')); fxLayer.appendChild(w); stPlace(w,x0,y0,x1,y1); }
        for (const [n,x0,y0,x1,y1] of [['t1',4048,190,4176,420],['t2',4170,345,4296,592],['t3',4262,1112,4308,1194],['tl',40,1066,82,1142]]) { const t=h('div','st-vtube '+n); fxLayer.appendChild(t); stPlace(t,x0,y0,x1,y1); }
        for (let i=0;i<3;i++) { const sm=h('div','st-vsteam'); sm.style.animationDelay=(-i*1.6)+'s'; fxLayer.appendChild(sm); stPlace(sm,4205,23,4345,213); }
        consoleEl.classList.toggle('voc-on', !!fxState.voc.on);
      }
      stPlace(q(enhSection,'.enh-gear.big'),2889,527,3149,787); stPlace(q(enhSection,'.enh-gear.r'),3080,578,3218,716); stPlace(q(enhSection,'.enh-gear.l'),2816,579,2966,729);
      const enhBtns=qa(enhSection,'.switches > .btn'); stPlace(enhBtns[0],2778,333,3262,393);
      enhBtns.slice(1).forEach((el,i)=>stPlace(el,[[2780,420,2930,480],[2950,420,3097,480],[3117,420,3262,480]][i][0],420,[[2780,420,2930,480],[2950,420,3097,480],[3117,420,3262,480]][i][2],480));
      const vus=q(outSection,'.vus'); qa(vus,'.vu').forEach((el,i)=>stPlace(el,...(i===0?[3368,172,3648,365]:[3675,172,3952,365])));
      const outKnobs=qa(outSection,'.knob-box'); outKnobs.forEach((el,i)=>stPlace(el,...(i===0?[3548,412,3762,627]:[3784,456,3912,596])));
      outKnobs.forEach((box,i)=>{ const hd=h('i','hubdisc'); const K=i===0?{ax:65,ay:16,aw:885,ah:890,hx:530,hy:415,hr:59,img:'sk-st-ko2-master-hub.png'}:{ax:1060,ay:181,aw:571,ah:628,hx:1350,hy:455,hr:32,img:'sk-st-ko2-thresh-hub.png'}; hd.style.left=((K.hx-K.hr-K.ax)/K.aw*100)+'%'; hd.style.top=((K.hy-K.hr-K.ay)/K.ah*100)+'%'; hd.style.width=(2*K.hr/K.aw*100)+'%'; hd.style.height=(2*K.hr/K.ah*100)+'%'; hd.classList.add(i===0?'hm':'ht'); box.appendChild(hd); });
      stPlace(q(outSection,'.limiter'),3580,672,3740,722); // centred in the module (x 3660), lower, smaller
      const chainRow=q(chainSection,'.st-chainrow'); qa(chainRow,'.st-mod').forEach((el,i)=>{el.style.flex='0 1 calc('+[434,428,166,164,251,164,164,166,255,255,246,255,255,240][i]+' / 4344 * 100cqw)';});
      { const pl=h('div','st-presetlbl','VOCAL CHAIN PRESET'); chainSection.appendChild(pl); stPlace(pl,692,853,950,883); } // moved off the backdrop so it can be positioned
      { const ct=h('div','st-cables top'), cb=h('div','st-cables bot'); chainSection.append(ct,cb); stPlace(ct,57.7,856.6,4099.7,1117.1); stPlace(cb,57.7,1095.1,4099.7,1402.2); } // user's cable mock (studio_cables.py), above the modules
      const chainbar=q(chainSection,'.st-chainbar'); stPlace(chainbar,973,845,2320,902); chainbar.classList.add('st-placed');
      const modules=qa(chainRow,'.st-mod'); modules.forEach((el,i)=>{
        const content=h('div','st-module-content'); while(el.firstChild) content.appendChild(el.firstChild); el.appendChild(content);
        el.classList.add('st-chain-module','st-chain-m'+i);
        qa(content,'.knob-box').forEach((box)=>[...box.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()).forEach((n)=>{const label=h('span','st-knob-label',n.textContent.trim());box.replaceChild(label,n);}));
        const title=el.querySelector('.modtitle'); if(title){ title.classList.add('st-modtitle'); [...title.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()).forEach(n=>{const label=h('span','st-mod-label',n.textContent.trim()); title.replaceChild(label,n);}); }
      });
      qa(consoleEl,'select').forEach((select)=>{
        const wrap=h('div',select.className+' st-select-wrap'), label=h('span','st-select-label');
        wrap.style.cssText=select.style.cssText;
        select.parentNode.insertBefore(wrap,select); wrap.append(select,label);
        select.className='st-select-native';
        label.setAttribute('aria-hidden','true');
        const sync=()=>{label.textContent=select.selectedOptions[0]?.textContent||'';};
        const valueDescriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
        const indexDescriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'selectedIndex');
        if(valueDescriptor?.get&&valueDescriptor?.set) Object.defineProperty(select,'value',{configurable:true,get(){return valueDescriptor.get.call(this);},set(value){valueDescriptor.set.call(this,value);sync();}});
        if(indexDescriptor?.get&&indexDescriptor?.set) Object.defineProperty(select,'selectedIndex',{configurable:true,get(){return indexDescriptor.get.call(this);},set(value){indexDescriptor.set.call(this,value);sync();}});
        select.addEventListener('change',sync); select.addEventListener('input',sync);
        new MutationObserver(sync).observe(select,{childList:true,subtree:true,characterData:true}); sync();
      });
      const statusEls=[...status.querySelectorAll('span')];
      [[180,1374,640,1410],[1968,1376,2182,1412],[3488,1378,3712,1410],[4035,1378,4198,1414]].forEach((r,i)=>stPlace(statusEls[i],...r));
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
        captureModeChanged();
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
    captureModeChanged();
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
    const fresh = { enabled: true, mode: 'param', limiter: false, master: 0.8, thresh: 5 / 6, bands: EQ_DEFAULT_BANDS.map((b) => ({ ...b })) };
    try {
      const saved = JSON.parse(localStorage.getItem(EQ_STORE_KEY) || 'null');
      if (saved && Array.isArray(saved.bands) && saved.bands.length === fresh.bands.length) {
        fresh.enabled = saved.enabled !== false; fresh.mode = saved.mode === 'graphic' ? 'graphic' : 'param';
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

  // Graphic EQ (top bar): 10 bands for plain listening. It sits in front of the parametric master EQ and is live only while
  // capture is OFF; once Studio capture runs (stems etc.) it goes flat/locked and the parametric EQ takes over (and vice versa).
  const GEQ_FREQS = [32, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const GEQ_PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], Rock: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5], Pop: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
    Jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3], Classical: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4], 'Bass Boost': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
    'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7], Vocal: [-2, -2, -1, 1, 3, 4, 4, 2, 0, -1], Electronic: [5, 4, 1, 0, -2, 2, 1, 2, 4, 5],
    Loudness: [6, 4, 1, 0, -1, 0, 1, 3, 5, 6],
  };
  const GEQ_KEY = 'ytm-poc-geq-v1';
  const geqState = (() => {
    const fresh = { on: true, gains: GEQ_PRESETS.Flat.slice(), preset: 'Flat' };
    try {
      const saved = JSON.parse(localStorage.getItem(GEQ_KEY) || 'null');
      if (saved && Array.isArray(saved.gains) && saved.gains.length === 10) {
        fresh.on = saved.on !== false; fresh.gains = saved.gains.map((v) => Math.max(-12, Math.min(12, Math.round(Number(v) || 0)))); fresh.preset = typeof saved.preset === 'string' ? saved.preset : '';
      }
    } catch {}
    return fresh;
  })();
  function saveGeq() { try { localStorage.setItem(GEQ_KEY, JSON.stringify(geqState)); } catch {} }
  const paramLive = () => studioActive() && eqState.mode === 'param';
  function geqLive() { return geqState.on && !paramLive(); }
  function applyGeq() {
    if (!masterEq || !masterEq.geq) return;
    const t = masterEq.context.currentTime;
    masterEq.geq.forEach((f, i) => f.gain.setTargetAtTime(geqLive() ? geqState.gains[i] : 0, t, 0.02));
  }
  // Plain listening has no Web Audio graph. Once the graphic EQ is on and not flat, the page media is wired (dry path, no PCM worker,
  // no stems) into the master stage, the same graph capture reuses later. Only after a user gesture: a media element wired into a
  // still-suspended AudioContext would go silent.
  let geqGesture = false;
  function geqNeedsGraph() { return studioEngaged || (geqState.on && geqState.gains.some((g) => g !== 0)); }
  function ensurePassiveGraph() {
    if (!geqGesture || !geqNeedsGraph()) return;
    const media = findMedia(); if (!media || wiredElements.has(media)) return;
    if (!activeContext || activeContext.state === 'closed') activeContext = new AudioContext({ latencyHint: 'interactive' });
    const context = activeContext;
    context.resume().then(() => {
      if (context.state !== 'running' || wiredElements.has(media)) return;
      const source = context.createMediaElementSource(media);
      wiredElements.add(media);
      graphs.set(media, connectAudioGraph(source, context, media));
      applyEq(); applyGeq(); routeEnhancer();
    }).catch(() => {});
  }
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { geqGesture = true; ensurePassiveGraph(); }, { capture: true });
  setInterval(ensurePassiveGraph, 2000);
  function captureModeChanged() { applyEq(); applyGeq(); routeEnhancer(); masterEq?.mixPitch?.route(); studio.geqSync?.(); studio.consoleEl?.classList.toggle('st-capture', captureActive); }

  function saveEqState() { try { localStorage.setItem(EQ_STORE_KEY, JSON.stringify(eqState)); } catch {} }

  function applyEq() {
    if (!masterEq) return;
    const t = masterEq.context.currentTime;
    eqState.bands.forEach((b, i) => {
      const f = masterEq.filters[i];
      f.frequency.setTargetAtTime(b.freq, t, 0.01);
      f.Q.setTargetAtTime(b.q, t, 0.01);
      f.gain.setTargetAtTime(eqState.enabled && paramLive() ? b.gain : 0, t, 0.01); // disabled (or plain listening: graphic EQ's turn) = 0 dB on every band
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

  // Signalsmith Stretch (MIT, WASM, spectral; built for full mixes) is the one pitch engine: KEY on the mix, KEY on the stems,
  // and the Harmonizer. The sandboxed preload cannot require files, so main.js hands over the library source.
  let stretchFactory = null;
  function createStretch(context) {
    stretchFactory ||= ipcRenderer.invoke('poc:stretch-src').then((src) => {
      if (!src) throw new Error('stretch source missing');
      return new Function([src, 'return SignalsmithStretch;'].join(String.fromCharCode(10)))(); // local, bundled MIT library
    });
    return stretchFactory.then((create) => create(context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' }))
      .then((node) => { node.start(); return node; });
  }
  // KEY on the whole mix for plain listening (capture running: the stems shift themselves). 'direct' and 'wet' paths, crossfaded.
  function buildMixPitch(context, input) {
    const output = fxGain(context), direct = fxGain(context), wet = fxGain(context);
    input.connect(direct); direct.connect(output); wet.connect(output);
    direct.gain.value = 1; wet.gain.value = 0;
    let shifted = false, node = null, last = null;
    const route = () => {
      const want = !!node && tuneState.semis !== 0 && !captureActive && studioEngaged;
      const v = want ? tuneState.semis : 0;
      if (node && v !== last) { last = v; node.schedule({ semitones: v }); }
      if (want === shifted) return;
      shifted = want;
      const t = context.currentTime;
      direct.gain.setTargetAtTime(want ? 0 : 1, t, 0.02); wet.gain.setTargetAtTime(want ? 1 : 0, t, 0.02);
    };
    createStretch(context).then((n) => { input.connect(n); n.connect(wet); node = n; route(); stemDiag('mix_pitch', { state: 'signalsmith' }); })
      .catch((error) => stemDiag('mix_pitch', { state: 'unavailable', error: String(error?.message || error).slice(0, 120) }));
    setInterval(route, 150);
    return { output, route };
  }

  function getEqInput(context) {
    if (masterEq && masterEq.context === context) return masterEq.input;
    const input = context.createGain();
    setChannelFormat(input);
    let prev = input;
    const mixPitch = buildMixPitch(context, input); // KEY for plain listening (passive graph); capture shifts the stems instead
    prev = mixPitch.output;
    const geq = GEQ_FREQS.map((fq, i) => {
      const f = context.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === GEQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = fq; f.Q.value = 1.41; f.gain.value = geqLive() ? geqState.gains[i] : 0;
      setChannelFormat(f); prev.connect(f); prev = f; return f;
    });
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
    masterEq = { context, input, mixPitch, geq, filters, analyser, limiter, eqOut, master, outNode, anL, anR, limiterOn: null, enhOn: null };
    routeEnhancer(); applyEnhancer(); // Enhancer off = eqOut goes straight to master (clean bypass)
    routeLimiter();
    for (const [i, b] of eqState.bands.entries()) {
      filters[i].frequency.value = b.freq; filters[i].Q.value = b.q; filters[i].gain.value = eqState.enabled && paramLive() ? b.gain : 0;
    }
    return input;
  }

  // ---- Enhancer (master bus) and Vocal Lab (vocal stem): native Web Audio nodes only, the YTM CSP blocks AudioWorklet. ----
  const FX_KEY = 'ytm-poc-fx-v1';
  const fxState = (() => {
    const fresh = {
      enh: { on: false, drive: 0, warmth: 0, air: 0, width: 0.5 }, // width 0.5 = 100% (neutral), 0 = mono, 1 = 200%
      voc: {
        on: false,
        gOn: false, gate: 0.3, cutOn: true, cut: 0.4, eqOn: true, low: 0.5, mud: 0.5, cpOn: true, comp: 0, esOn: true, deess: 0, prOn: true, pres: 0,
        saOn: false, drive: 0, smix: 0.5, dbOn: false, dbl: 0, dspr: 0.5, hrOn: false, hint: 0.5, hlvl: 0.4, rvOn: true, rev: 0, decay: 0.4, dlOn: true, dly: 0, time: 0.4,
      },
      at: { on: false, key: 0, scale: 1, speed: 0.7, amount: 1 }, // auto-tune; key 0..11, scale 0..4 (index), speed/amount 0..1
    };
    try {
      const saved = JSON.parse(localStorage.getItem(FX_KEY) || 'null');
      for (const group of Object.keys(fresh)) for (const k of Object.keys(fresh[group])) {
        const v = saved?.[group]?.[k];
        if (typeof fresh[group][k] === 'boolean') fresh[group][k] = typeof v === 'boolean' ? v : fresh[group][k]; // new switches keep their default until saved
        else if (Number.isFinite(v)) fresh[group][k] = Math.min(group === 'at' && k === 'key' ? 11 : group === 'at' && k === 'scale' ? 4 : 1, Math.max(0, v));
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
    const want = fxState.enh.on && studioSound(); // the Enhancer is a Studio tool: plain listening stays clean
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

  // Noise gate (ScriptProcessor, 512 frames = ~12 ms): envelope follower with hysteresis, hold and smoothed attack/release. Only in the signal path while switched on.
  function buildGate(context) {
    if (!(typeof OfflineAudioContext === 'function' && context instanceof OfflineAudioContext)) return buildLiveGate(context);
    const input = fxGain(context), output = fxGain(context);
    const proc = context.createScriptProcessor(512, 2, 2);
    proc.channelCount = 2; proc.channelCountMode = 'explicit'; proc.channelInterpretation = 'speakers';
    input.connect(proc); proc.connect(output);
    const g = { input, output, proc, thr: 0.003, floor: 0.02, gain: 1, env: 0, open: false, hold: 0 };
    const sr = context.sampleRate;
    const envRel = Math.exp(-1 / (0.03 * sr)), atk = 1 - Math.exp(-1 / (0.003 * sr)), rel = 1 - Math.exp(-1 / (0.09 * sr)), holdS = Math.round(0.06 * sr);
    proc.onaudioprocess = (e) => {
      const iL = e.inputBuffer.getChannelData(0), iR = e.inputBuffer.getChannelData(1), oL = e.outputBuffer.getChannelData(0), oR = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < iL.length; i += 1) {
        const a = Math.max(Math.abs(iL[i]), Math.abs(iR[i]));
        g.env = a > g.env ? a : g.env * envRel;
        if (g.env > g.thr) { g.open = true; g.hold = holdS; } else if (g.hold > 0) g.hold -= 1; else if (g.env < g.thr * 0.7) g.open = false;
        const target = g.open ? 1 : g.floor;
        g.gain += (target - g.gain) * (target > g.gain ? atk : rel);
        oL[i] = iL[i] * g.gain; oR[i] = iR[i] * g.gain;
      }
    };
    return g;
  }

  // Harmonizer: a pitch-shifted copy of the voice (WSOLA, same shifter as the music key change), blended in as a second voice.
  const HARM_INTERVALS = [[-12, 'OCTAVE DOWN'], [3, 'THIRD +3'], [4, 'THIRD +4'], [7, 'FIFTH +7'], [12, 'OCTAVE UP']];
  // Live gate without a ScriptProcessor: the audio itself only flows through native nodes (10 ms delay -> gain), so a busy main thread
  // can never punch holes into the voice (the 512-frame ScriptProcessor gate crackled whenever the page stalled for > 12 ms).
  // An analyser on the undelayed signal is read every ~5 ms; the computed gain is scheduled ahead with setTargetAtTime, so the
  // 10 ms delay acts as look-ahead and a late timer only delays the next decision.
  function buildLiveGate(context) {
    const input = fxGain(context), output = fxGain(context);
    const delay = context.createDelay(0.05); delay.delayTime.value = 0.01;
    const vca = fxGain(context);
    const an = context.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0;
    input.connect(delay); delay.connect(vca); vca.connect(output); input.connect(an);
    const buf = new Float32Array(an.fftSize);
    const g = { input, output, proc: null, thr: 0.003, floor: 0.02, gain: 1, env: 0, open: false, holdUntil: 0, live: true };
    let target = 1;
    const tick = () => {
      if (context.state === 'closed') { clearInterval(timer); return; }
      an.getFloatTimeDomainData(buf);
      let peak = 0; for (let i = 0; i < buf.length; i += 1) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
      const now = context.currentTime;
      g.env = Math.max(peak, g.env * 0.7);
      if (g.env > g.thr) { g.open = true; g.holdUntil = now + 0.06; } else if (now > g.holdUntil && g.env < g.thr * 0.7) g.open = false;
      const want = g.open ? 1 : g.floor;
      if (want !== target) { target = want; vca.gain.cancelScheduledValues(now); vca.gain.setTargetAtTime(want, now, want > g.gain ? 0.003 : 0.09); }
      g.gain = want;
    };
    const timer = setInterval(tick, 5);
    g.dispose = () => { clearInterval(timer); for (const n of [input, delay, vca, an]) { try { n.disconnect(); } catch {} } };
    return g;
  }

  // Harmony voice: the vocal through a Signalsmith Stretch node at a fixed interval; silent (gain 0) while the module is off.
  function buildHarmonizer(context) {
    const input = fxGain(context), output = fxGain(context), gate = fxGain(context);
    gate.gain.value = 0; gate.connect(output);
    const h2 = { input, output, node: null, _active: false, _factor: 1.26 };
    const apply = () => {
      gate.gain.setTargetAtTime(h2._active && h2.node ? 1 : 0, context.currentTime, 0.02);
      h2.node?.schedule({ semitones: 12 * Math.log2(h2._factor), active: h2._active });
    };
    Object.defineProperty(h2, 'active', { get: () => h2._active, set: (v) => { if (v !== h2._active) { h2._active = v; apply(); } } });
    Object.defineProperty(h2, 'factor', { get: () => h2._factor, set: (v) => { if (v !== h2._factor) { h2._factor = v; apply(); } } });
    h2.ready = createStretch(context).then((n) => { input.connect(n); n.connect(gate); h2.node = n; apply(); })
      .catch((error) => stemDiag('harmonizer', { state: 'unavailable', error: String(error?.message || error).slice(0, 120) }));
    h2.dispose = () => { for (const n of [input, h2.node, gate, output].filter(Boolean)) { try { n.disconnect(); } catch {} } };
    return h2;
  }

  // One vocal effects chain, in recording-studio order:
  //   [gate] -> low cut -> EQ (low shelf, mud cut) -> compressor -> de-esser (LR4 split) -> presence/air -> saturation -> out
  // with parallel sends from out: reverb, delay, doubler (two detuned/modulated short delays, panned) and harmonizer. Every module has its own on/off.
  function buildVocalFx(context, destination, source) {
    const input = fxGain(context), sum = fxGain(context), out = fxGain(context);
    const gate = buildGate(context), harm = buildHarmonizer(context);
    const hpf = fxBiquad(context, 'highpass', 20, 0.707); // low cut
    const eqLow = fxBiquad(context, 'lowshelf', 120), eqMud = fxBiquad(context, 'peaking', 300, 1.0);
    const comp = context.createDynamicsCompressor(); setChannelFormat(comp);
    const makeup = fxGain(context);
    const lp = [fxBiquad(context, 'lowpass', 6500, 0.707), fxBiquad(context, 'lowpass', 6500, 0.707)];
    const hp = [fxBiquad(context, 'highpass', 6500, 0.707), fxBiquad(context, 'highpass', 6500, 0.707)];
    const ess = context.createDynamicsCompressor(); setChannelFormat(ess);
    const pres = fxBiquad(context, 'peaking', 3200, 0.8), airShelf = fxBiquad(context, 'highshelf', 10000);
    hpf.connect(eqLow); eqLow.connect(eqMud); eqMud.connect(comp); comp.connect(makeup);
    makeup.connect(lp[0]); lp[0].connect(lp[1]); lp[1].connect(sum);
    makeup.connect(hp[0]); hp[0].connect(hp[1]); hp[1].connect(ess); ess.connect(sum);
    sum.connect(pres); pres.connect(airShelf);
    // saturation (parallel tanh shaper: drive in, dry/wet mix)
    const satPre = fxGain(context), satWet = fxGain(context), satDry = fxGain(context);
    const shaper = context.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i += 1) curve[i] = Math.tanh(3 * ((i / (curve.length - 1)) * 2 - 1)) / Math.tanh(3);
    shaper.curve = curve; shaper.oversample = '2x';
    airShelf.connect(satDry); satDry.connect(out);
    airShelf.connect(satPre); satPre.connect(shaper); shaper.connect(satWet); satWet.connect(out);
    // sends
    const revSend = fxGain(context), conv = context.createConvolver(), revOut = fxGain(context);
    out.connect(revSend); revSend.connect(conv); conv.connect(revOut);
    const dlySend = fxGain(context), delay = context.createDelay(2), fb = fxGain(context), fbLp = fxBiquad(context, 'lowpass', 3500, 0.707), dlyOut = fxGain(context);
    fb.gain.value = 0.38;
    out.connect(dlySend); dlySend.connect(delay); delay.connect(fbLp); fbLp.connect(fb); fb.connect(delay); delay.connect(dlyOut);
    const dblSend = fxGain(context), dblOut = fxGain(context), oscs = [];
    const voices = [[0.018, 0.4], [0.031, 0.55]].map(([t, hz]) => {
      const dl = context.createDelay(0.1); dl.delayTime.value = t;
      const lfo = context.createOscillator(); lfo.frequency.value = hz;
      const depth = context.createGain(); depth.gain.value = 0.0012; // slow pitch wobble: the second take never matches exactly
      lfo.connect(depth); depth.connect(dl.delayTime); lfo.start(); oscs.push(lfo);
      const pan = context.createStereoPanner();
      dblSend.connect(dl); dl.connect(pan); pan.connect(dblOut);
      return pan;
    });
    out.connect(dblSend);
    const harSend = fxGain(context), harOut = fxGain(context);
    out.connect(harSend); harSend.connect(harm.input); harm.output.connect(harOut);
    const fx = { hpf, eqLow, eqMud, satPre, satWet, satDry, voices, dblSend, harSend, gate, harm, oscs, gateRouted: null, outs: [out, revOut, dlyOut, dblOut, harOut], context, input, source, destination, routed: null, ess, comp, makeup, pres, airShelf, revSend, conv, delay, dlySend, irKey: null, irTimer: 0 };
    routeGate(fx, false);
    vocalFxInstances.push(fx);
    applyVocalFx(fx, true);
    routeVocalFx(fx);
    // Build the reverb impulse response once, shortly after setup, so switching Vocal Lab on mid-song costs nothing (the convolver is not connected while off).
    setTimeout(() => {
      if (fx.irKey != null) return;
      const seconds = Math.round((0.4 + fxState.voc.decay * 3.6) * 10) / 10;
      fx.irKey = seconds; fx.conv.buffer = makeReverbIR(context, seconds);
    }, 3000);
    fx.dispose = () => {
      for (const o of oscs) { try { o.stop(); } catch {} }
      if (gate.proc) gate.proc.onaudioprocess = null; harm.dispose(); gate.dispose?.();
      for (const n of [gate.proc, gate.output, harm.output].filter(Boolean)) { try { n.disconnect(); } catch {} }
    };
    return fx;
  }

  // The gate sits in the path only while it is on (its block latency is not paid otherwise).
  function routeGate(fx, want) {
    if (fx.gateRouted === want) return;
    try { fx.input.disconnect(fx.hpf); } catch {}
    try { fx.input.disconnect(fx.gate.input); } catch {}
    try { fx.gate.output.disconnect(fx.hpf); } catch {}
    if (want) { fx.input.connect(fx.gate.input); fx.gate.output.connect(fx.hpf); } else fx.input.connect(fx.hpf);
    fx.gateRouted = want;
  }

  // Vocal Lab off = the source goes straight to the destination; the chain (convolver, compressors, delay loop) gets no signal at all.
  function routeVocalFx(fx) {
    const want = fxState.voc.on && !fx.stemBypass;
    if (fx.routed === want) return;
    try { fx.source.disconnect(fx.input); } catch {}
    try { fx.source.disconnect(fx.destination); } catch {}
    for (const o of fx.outs) { try { o.disconnect(fx.destination); } catch {} }
    if (want) { for (const o of fx.outs) o.connect(fx.destination); fx.source.connect(fx.input); } else fx.source.connect(fx.destination);
    fx.routed = want;
    if (mic && fx === mic.fx && rec.layerMap) recTapMic();
  }

  function applyVocalFx(fx, immediate, deferIR) {
    const s = fxState.voc, on = s.on && !fx.stemBypass, t = fx.context.currentTime;
    if (!on && fx.wasOn === false && !immediate) return; // off and already neutral: nothing to update
    fx.wasOn = on;
    const set = (p, v) => (immediate ? (p.value = v) : p.setTargetAtTime(v, t, 0.03));
    const amt = (flag, v) => (on && s[flag] ? v : 0); // a module that is switched off contributes nothing
    routeGate(fx, on && s.gOn);
    fx.gate.thr = 10 ** ((-70 + s.gate * 45) / 20);
    set(fx.hpf.frequency, on && s.cutOn ? 20 * 12.5 ** s.cut : 20); // 20 Hz (off) .. 250 Hz
    set(fx.eqLow.gain, amt('eqOn', (s.low - 0.5) * 18)); set(fx.eqMud.gain, amt('eqOn', (s.mud - 0.5) * 18));
    const a = amt('cpOn', s.comp), d = amt('esOn', s.deess), pr = amt('prOn', s.pres);
    set(fx.comp.threshold, -8 - a * 22); set(fx.comp.ratio, 1 + a * 5);
    if (immediate) { fx.comp.knee.value = 10; fx.comp.attack.value = 0.008; fx.comp.release.value = 0.15; } // static settings: not re-scheduled on every knob move
    set(fx.makeup.gain, 10 ** (a * 5 / 20));
    set(fx.ess.threshold, -20 - d * 20); set(fx.ess.ratio, 1 + d * 9);
    if (immediate) { fx.ess.knee.value = 0; fx.ess.attack.value = 0.001; fx.ess.release.value = 0.04; }
    set(fx.pres.gain, pr * 6); set(fx.airShelf.gain, pr * 3);
    const dr = amt('saOn', s.drive);
    set(fx.satPre.gain, 1 + dr * 9); set(fx.satWet.gain, dr > 0 ? s.smix * 0.7 : 0); set(fx.satDry.gain, dr > 0 ? 1 - s.smix : 1);
    set(fx.revSend.gain, amt('rvOn', s.rev) * 0.8);
    set(fx.dlySend.gain, amt('dlOn', s.dly) * 0.6); set(fx.delay.delayTime, 0.12 + s.time * 0.6);
    set(fx.dblSend.gain, amt('dbOn', s.dbl) * 0.9);
    fx.voices[0].pan.value = -(0.3 + 0.7 * s.dspr); fx.voices[1].pan.value = 0.3 + 0.7 * s.dspr;
    fx.harm.active = on && s.hrOn;
    fx.harm.factor = 2 ** (HARM_INTERVALS[Math.round(s.hint * 4)][0] / 12);
    set(fx.harSend.gain, amt('hrOn', s.hlvl) * 0.9);
    const seconds = Math.round((0.4 + s.decay * 3.6) * 10) / 10;
    if (on && !deferIR && fx.irKey !== seconds) { // the impulse response is rebuilt only when not mid-drag (heavy on the main thread)
      fx.irKey = seconds;
      clearTimeout(fx.irTimer);
      const swap = () => { fx.conv.buffer = makeReverbIR(fx.context, seconds); };
      if (immediate) swap(); else fx.irTimer = setTimeout(swap, 50);
    }
  }
  function applyVocalFxAll(deferIR) { for (const fx of vocalFxInstances) { routeVocalFx(fx); applyVocalFx(fx, false, deferIR === true); } studio.consoleEl?.classList.toggle('voc-on', !!fxState.voc.on); }
  setInterval(() => studio.consoleEl?.classList.toggle('voc-on', !!fxState.voc.on), 700); // safety net: side-pillar effects follow the Vocal Lab switch

  // ---- Auto-tune (mic): pitch correction runs in a hidden local window and returns over a local WebRTC link; this page plays it into the Vocal Lab chain. ----
  const AT_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const AT_SCALES = ['Chromatic', 'Major', 'Minor', 'Major Pent.', 'Minor Pent.'];
  let atLink = null; // { pc, audioEl, done, fail }
  function atParams() { const s = fxState.at; return { key: Math.round(s.key), scale: Math.round(s.scale), speed: s.speed, amount: s.amount }; }
  function atSend(msg) { try { ipcRenderer.send('poc:at-to-lab', msg); } catch {} }
  function atSendParams() { if (atLink?.done) atSend({ t: 'params', params: atParams() }); }
  function atNoteName(n) { return AT_KEYS[((Math.round(n) % 12) + 12) % 12] + (Math.floor(Math.round(n) / 12) - 1); }
  ipcRenderer.on('poc:at-msg', async (_event, m) => {
    const link = atLink;
    if (!link || !m || typeof m !== 'object') return;
    try {
      if (m.t === 'offer') {
        await link.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        atSend({ t: 'answer', sdp: answer.sdp });
      } else if (m.t === 'ice') await link.pc.addIceCandidate(m.c || null);
      else if (m.t === 'status') studio.atStatus?.(m);
      else if (m.t === 'error') link.fail(new Error(String(m.error || 'autotune')));
    } catch (error) { link.fail(error); }
  });
  function atDisconnect() {
    const link = atLink;
    if (!link) return;
    atLink = null; link.done = false;
    try { link.pc.close(); } catch {}
    try { if (link.audioEl) link.audioEl.srcObject = null; } catch {}
    atSend({ t: 'stop' });
  }
  // Resolves with the corrected MediaStream once the hidden window's track arrives.
  function atConnect(label) {
    atDisconnect();
    return new Promise((resolve, reject) => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const link = { pc, audioEl: null, done: false, fail: null };
      let settled = false;
      const timer = setTimeout(() => link.fail(new Error('timeout')), 8000);
      link.fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); if (atLink === link) atDisconnect(); reject(error); };
      atLink = link;
      pc.onicecandidate = (e) => { if (e.candidate) atSend({ t: 'ice', c: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') link.fail(new Error('webrtc failed')); };
      pc.ontrack = (e) => {
        if (settled) return;
        const stream = e.streams[0] || new MediaStream([e.track]);
        try { e.receiver.jitterBufferTarget = 10; } catch {} // ms: keep the receive buffer as small as the link allows
        // Chromium only feeds a remote stream into Web Audio while it is also attached to a media element.
        const el = new Audio(); el.muted = true; el.srcObject = stream; el.play?.().catch(() => {});
        link.audioEl = el; link.done = true; settled = true; clearTimeout(timer);
        resolve(stream);
      };
      atSend({ t: 'start', label, params: atParams() });
    });
  }

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
    const gain = fxGain(context);
    gain.channelCount = 1; // the mic is one signal: summed to mono here, then fed equally to left and right everywhere downstream
    gain.gain.value = micGainOf(micState.level);
    const an = context.createAnalyser(); an.fftSize = 1024;
    gain.connect(an);
    const fx = buildVocalFx(context, masterEq.master, gain);
    const m = { stream: null, source: null, atOn: false, gain, an, fx, context, buf: new Float32Array(1024) };
    mic = m;
    try { await micAttachSource(m); } catch (error) { if (mic === m) stopMic(); throw error; }
    stemDiag('mic_on', { state: m.atOn ? 'autotune' : 'on' });
    return true;
  }

  // (Re)connects the mic's input: the raw microphone, or the auto-tuned stream when fxState.at.on. Falls back to the raw mic if auto-tune cannot start.
  async function micAttachSource(m) {
    const wantAt = fxState.at.on;
    let stream = null, usedAt = false;
    if (wantAt) {
      try {
        let label = '';
        if (micState.device) {
          try { label = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.deviceId === micState.device)?.label || ''; } catch {}
        }
        stream = await atConnect(label); usedAt = true;
      } catch (error) {
        atDisconnect();
        stemDiag('autotune_error', { error: String(error?.message || error).slice(0, 80) });
        studio.atStatus?.({ t: 'error' });
      }
    }
    if (!usedAt) {
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (micState.device) audio.deviceId = { ideal: micState.device };
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    if (mic !== m) { // switched off while connecting
      if (usedAt) atDisconnect(); else for (const t of stream.getTracks()) t.stop();
      return;
    }
    const source = m.context.createMediaStreamSource(stream);
    source.connect(m.gain);
    const old = { source: m.source, stream: m.stream, atOn: m.atOn };
    m.source = source; m.stream = stream; m.atOn = usedAt;
    try { old.source?.disconnect(); } catch {}
    if (old.stream && !old.atOn) for (const t of old.stream.getTracks()) t.stop();
    if (old.atOn && !usedAt) atDisconnect();
  }

  function stopMic() {
    if (!mic) return;
    const m = mic; mic = null;
    try { m.source?.disconnect(); } catch {}
    try { m.gain.disconnect(); } catch {}
    for (const o of m.fx.outs) { try { o.disconnect(); } catch {} }
    clearTimeout(m.fx.irTimer);
    m.fx.dispose?.();
    const i = vocalFxInstances.indexOf(m.fx);
    if (i >= 0) vocalFxInstances.splice(i, 1);
    for (const t of m.stream?.getTracks() || []) t.stop();
    atDisconnect();
    studio.atStatus?.({ t: 'idle' });
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
    { const vfx = buildVocalFx(context, stemLimiter, vocalGain); vfx.stemBypass = true; routeVocalFx(vfx); applyVocalFx(vfx, true); } // the song's vocal stem: never processed (the Vocal Chain is for the singer's mic only)
    stemLimiter.connect(stemBus); stemBus.connect(eqInput);
    stemBus.gain.value = 0;
    stemNodes = { vocalGain, instGain, drumsGain, bassGain, otherGain, stemBus };
    stemNodes.analysers = {};
    stemNodes.pitch = buildStemPitch(context, stemNodes);
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
      // maxBufferSize: the default queue is only a few ~10 ms frames, so any main-thread stall over ~100 ms silently dropped audio
      // (input fell to ~75 % of real time and the stems underran). 500 frames = ~5 s of slack: a stall now only delays blocks.
      const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 500 }).readable.getReader();
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
      const pin = stemNodes.pitch?.ins[gainKey];
      node.connect(pin || target);
      if (!pin) { const tap = rec.taps?.[gainKey]; if (tap) node.connect(tap); }
      node.start(startAt);
    }
    p.nextTime = startAt + hop / rate / pr;
    p.chunks += 1;
    { // how far behind the YouTube Music element the stems are heard (window + processing + jitter buffer + output): the lyrics clock uses it
      const est = frames / rate * 1000 + 93 + (msg.processingMs || 0) + (startAt - now) * 1000 + (typeof context.outputLatency === 'number' ? context.outputLatency : 0) * 1000;
      p.delayEstimateMs = p.delayEstimateMs ? p.delayEstimateMs * 0.8 + est * 0.2 : est;
    }
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
