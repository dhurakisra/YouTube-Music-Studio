'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedLogEvents = new Set([
  'capture_button_ready', 'capture_start_requested', 'capture_started',
  'capture_stop_requested', 'capture_stopped', 'capture_start_cycle',
  'capture_worklet_error', 'capture_fallback', 'media_element_missing',
  'drm_or_silence', 'capture_error', 'processing_state', 'latency_info',
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
  let button;
  let overlay;
  let modeSelect;
  let gainSlider;

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
    for (const [value, text] of [['bypass', 'Bypass'], ['processed', 'Processed (LPF)']]) {
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
    overlay.append(label, modeSelect, gainLabel, gainSlider);
    document.documentElement.appendChild(overlay);
  }

  function setChannelFormat(node) {
    try { node.channelCount = 2; } catch {}
    try { node.channelCountMode = 'explicit'; } catch {}
  }

  function beginCapture() {
    if (captureStarting) return Promise.resolve(false);
    captureStarting = true;
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
      return context.resume().then(() => {
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
        startMeasurement(graph, context, media);
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
    return { source, analyser, processor, meterSink, onAudioProcess, counters, previousCallbackAt: () => { previousCallbackAt = 0; }, dryGain, wetGain, userGain, mode, measuring: false };
  }

  function startMeasurement(graph, context) {
    if (graph.measuring) return;
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

  function setMode(mode, shouldLog = true, onlyGraph = null) {
    const selected = mode === 'processed' ? 'processed' : 'bypass';
    const graphsToUpdate = onlyGraph ? [onlyGraph] : [...document.querySelectorAll('audio, video')].map((media) => graphs.get(media)).filter(Boolean);
    const context = activeContext;
    const now = context?.currentTime || 0;
    const theta = selected === 'processed' ? Math.PI / 2 : 0;
    const dryTarget = Math.cos(theta);
    const wetTarget = Math.sin(theta);
    for (const graph of graphsToUpdate) {
      graph.mode = selected;
      graph.dryGain.gain.setTargetAtTime(dryTarget, now, 0.02);
      graph.wetGain.gain.setTargetAtTime(wetTarget, now, 0.02);
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
