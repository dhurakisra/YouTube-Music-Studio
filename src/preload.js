'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedLogEvents = new Set([
  'capture_button_ready', 'capture_start_requested', 'capture_started',
  'capture_stop_requested', 'capture_stopped', 'capture_start_cycle',
  'capture_worklet_error', 'capture_fallback', 'media_element_missing',
  'drm_or_silence', 'capture_error', 'processing_state', 'latency_info',
  'pcm_worker_attempt', 'pcm_worker_blocked', 'pcm_transport_started', 'pcm_transport_stopped', 'pcm_metrics', 'pcm_port_received', 'pcm_worker_port_ready',
  'stem_block_received', 'stem_transport_started', 'stem_transport_stopped', 'stem_playout',
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
    if (overlay?.isConnected) return;

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
    const makeStemSlider = (text, aria) => {
      const caption = document.createElement('label');
      caption.textContent = text;
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = '100';
      slider.setAttribute('aria-label', aria);
      slider.style.width = '80px';
      slider.addEventListener('input', applyStemLevels);
      const flags = { solo: false, mute: false };
      slider.stemFlags = flags;
      const makeToggle = (label, key, aria) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.setAttribute('aria-label', aria); b.setAttribute('aria-pressed', 'false');
        b.style.cssText = 'margin:0 2px;padding:0 5px;font:inherit;cursor:pointer';
        b.addEventListener('click', () => {
          if (b.disabled) return;
          flags[key] = !flags[key];
          refresh();
          applyStemLevels();
        });
        b.stemKey = key;
        return b;
      };
      const refresh = () => {
        for (const btn of [soloBtn, muteBtn]) {
          const on = flags[btn.stemKey];
          btn.setAttribute('aria-pressed', String(on));
          btn.style.background = on ? (btn.stemKey === 'solo' ? '#e8b400' : '#d33') : '';
        }
        muteBtn.disabled = flags.solo; // S and M are mutually exclusive
        soloBtn.disabled = flags.mute;
        for (const btn of [soloBtn, muteBtn]) btn.style.opacity = btn.disabled ? '0.4' : '1';
      };
      const soloBtn = makeToggle('S', 'solo', aria + ' solo'), muteBtn = makeToggle('M', 'mute', aria + ' mute');
      slider.extraEls = [soloBtn, muteBtn];
      overlay.append(caption, slider, soloBtn, muteBtn);
      return slider;
    };
    const modelLabel = document.createElement('label');
    modelLabel.textContent = 'Model';
    modelSelect = document.createElement('select');
    modelSelect.setAttribute('aria-label', 'Stem separation model (applies on next capture start)');
    for (const [value, text] of [['umx-hq', 'UMX-HQ (fast, ~3 s)'], ['htdemucs', 'HT-Demucs (best, ~10 s)']]) {
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
    const updateSliderVisibility = () => {
      const ht = modelSelect.value === 'htdemucs';
      const setHidden = (slider, hidden) => { slider.hidden = hidden; slider.previousSibling.hidden = hidden; for (const el of slider.extraEls) el.hidden = hidden; };
      setHidden(instSlider, ht);
      for (const slider of [drumsSlider, bassSlider, otherSlider]) setHidden(slider, !ht);
      applyStemLevels();
    };
    modelSelect.addEventListener('change', updateSliderVisibility);
    updateSliderVisibility();
    document.documentElement.appendChild(overlay);
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
    dryGain.connect(context.destination);
    source.connect(lowpass);
    lowpass.connect(userGain);
    userGain.connect(limiter);
    limiter.connect(wetGain);
    wetGain.connect(context.destination);
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
    stemLimiter.connect(stemBus); stemBus.connect(context.destination);
    stemBus.gain.value = 0;
    stemNodes = { vocalGain, instGain, drumsGain, bassGain, otherGain, stemBus };

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
      if (currentPcmTransport?.port) {
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
    return { source, analyser, processor, meterSink, onAudioProcess, counters, previousCallbackAt: () => { previousCallbackAt = 0; }, dryGain, wetGain, userGain, stemBus, mode, measuring: false };
  }

  function startMeasurement(graph, context, media, transport) {
    if (graph.measuring) return;
    nextSequence = 0;
    currentPcmTransport = transport;
    graph.source.connect(graph.analyser);
    graph.analyser.connect(graph.processor);
    graph.processor.connect(graph.meterSink);
    graph.meterSink.connect(context.destination);
    graph.processor.onaudioprocess = graph.onAudioProcess;
    graph.measuring = true;
  }

  function stopMeasurement(graph) {
    if (!graph.measuring) return;
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
    const ht = modelSelect?.value === 'htdemucs';
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
    for (const [name, gainKey] of layers) {
      const data = outs[name], target = stemNodes[gainKey];
      const buffer = context.createBuffer(2, hop, rate);
      const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      for (let n = 0; n < hop; n += 1) { left[n] = data[2 * n]; right[n] = data[2 * n + 1]; }
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(target);
      node.start(startAt);
    }
    p.nextTime = startAt + hop / rate;
    p.chunks += 1;
    if (p.chunks % 5 === 1) {
      const leadMs = (startAt - now) * 1000;
      const outputMs = (typeof context.outputLatency === 'number' ? context.outputLatency : 0) * 1000;
      log('stem_playout', {
        chunks: p.chunks, underruns: p.underruns, peak: Number(p.peakMax.toFixed(3)), handleMs: Number((p.handleMaxMs || 0).toFixed(1)), leadMs: Number(leadMs.toFixed(1)),
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
