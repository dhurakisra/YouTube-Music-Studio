'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedLogEvents = new Set([
  'capture_button_ready', 'capture_start_requested', 'capture_started',
  'capture_worklet_error', 'capture_fallback', 'media_element_missing', 'drm_or_silence', 'capture_error',
]);

function trustedMainFrame() {
  try {
    const u = new URL(location.href);
    return window === window.top && (u.origin === 'https://music.youtube.com' || u.protocol === 'file:');
  } catch { return false; }
}

function onTrustedCommand(callback) {
  if (!trustedMainFrame() || typeof callback !== 'function') return () => {};
  // Mesajlar yalnizca ana surecten gelir; senderFrame ana surec mesajlarinda bos olur.
  // Guven: trustedMainFrame() (origin + top frame) yukarida zaten dogrulandi.
  const listener = (_event, command) => {
    if (!command || typeof command !== 'object') return;
    callback(command);
  };
  ipcRenderer.on('poc:command', listener);
  return () => ipcRenderer.removeListener('poc:command', listener);
}

contextBridge.exposeInMainWorld('poc', Object.freeze({
  log(level, event, data = {}) {
    if (!trustedMainFrame() || !['info', 'warn', 'error'].includes(level) || !allowedLogEvents.has(event)) return;
    ipcRenderer.send('poc:log', level, event, data);
  },
  onCommand(callback) {
    return onTrustedCommand(callback);
  },
}));

(() => {
  const wiredElements = new WeakSet();
  let workletSource = '';
  let activeContext = null;
  let workletMode = null;
  let workletFailure = null;
  let captureStarting = false;
  let scanQueued = false;
  let lastZeroStart = null;
  let lastMetricsAt = 0;
  let wiredMode = new WeakMap();
  let button;

  function log(event, data) {
    if (!trustedMainFrame() || !allowedLogEvents.has(event)) return;
    const level = event === 'capture_worklet_error' || event === 'capture_error' ? 'error' : 'info';
    ipcRenderer.send('poc:log', level, event, data);
  }

  function findMedia() {
    return document.querySelector('video, audio');
  }

  function installButton() {
    if (!document.documentElement || button?.isConnected) return;
    button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Start capture';
    button.setAttribute('aria-label', 'Start audio capture');
    Object.assign(button.style, {
      position: 'fixed', top: '12px', right: '16px', zIndex: '2147483647',
      padding: '10px 14px', border: '0', borderRadius: '6px',
      background: '#1264a3', color: 'white', font: '600 14px sans-serif',
      boxShadow: '0 2px 8px #0008', cursor: 'pointer',
    });
    button.addEventListener('click', beginCapture);
    document.documentElement.appendChild(button);
    log('capture_button_ready', { state: 'ready' });
  }

  async function beginCapture() {
    if (captureStarting) return;
    captureStarting = true;
    log('capture_start_requested', { state: 'requested' });
    try {
      const media = findMedia();
      if (!media) {
        log('media_element_missing', { state: 'waiting' });
        return;
      }
      if (!workletSource) throw new Error('Capture source not ready');
      let context = activeContext;
      if (!context || context.state === 'closed') {
        context = new AudioContext({ latencyHint: 'interactive' });
        activeContext = context;
        workletMode = null;
        workletFailure = null;
      }
      await context.resume();
      if (!wiredElements.has(media)) {
        const source = context.createMediaElementSource(media);
        wiredElements.add(media);
        const mode = await connectCaptureGraph(source, context);
        wiredMode.set(media, mode);
      }
      scanMedia();
      log('capture_started', { sampleRate: context.sampleRate, state: 'capturing' });
      if (button) button.textContent = wiredMode.get(media) === 'fallback' ? 'Capture active (fallback)' : 'Capture active';
    } catch (error) {
      log('capture_error', { state: 'failed', error: String(error?.message || error).slice(0, 180) });
      if (button) button.textContent = `Capture error: ${String(error?.message || error).slice(0, 48)}`;
    } finally {
      captureStarting = false;
    }
  }

  async function connectCaptureGraph(source, context) {
    if (workletMode === null) {
      try {
        const blobUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
        try { await context.audioWorklet.addModule(blobUrl); }
        finally { URL.revokeObjectURL(blobUrl); }
        workletMode = 'worklet';
      } catch (error) {
        log('capture_worklet_error', { state: 'blob_failed', error: String(error?.message || error).slice(0, 180) });
        try {
          const dataUrl = `data:text/javascript,${encodeURIComponent(workletSource)}`;
          await context.audioWorklet.addModule(dataUrl);
          workletMode = 'worklet';
        } catch (dataError) {
          workletFailure = dataError || error;
          workletMode = 'fallback';
          log('capture_worklet_error', { state: 'data_failed', error: String(dataError?.message || dataError).slice(0, 180) });
        }
      }
    }
    if (workletMode === 'worklet') {
      const meter = new AudioWorkletNode(context, 'ytm-capture-meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      meter.port.onmessage = ({ data }) => receiveMetrics(data, context);
      source.connect(meter);
      meter.connect(context.destination);
      return 'worklet';
    }
    return connectFallbackGraph(source, context, workletFailure);
  }

  function connectFallbackGraph(source, context, cause) {
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const processor = context.createScriptProcessor(2048, 2, 2);
    const meterBuffer = new Float32Array(analyser.fftSize);
    const blockDurationMs = 2048 / context.sampleRate * 1000;
    let previousCallbackAt = 0;
    let dropoutBlocks = 0;
    let timeGaps = 0;
    processor.onaudioprocess = (event) => {
      const now = performance.now();
      if (previousCallbackAt && now - previousCallbackAt > blockDurationMs * 1.5) timeGaps += 1;
      previousCallbackAt = now;
      const input = event.inputBuffer;
      const output = event.outputBuffer;
      let hasInput = false;
      let nonzero = 0;
      for (let channel = 0; channel < output.numberOfChannels; channel += 1) {
        const out = output.getChannelData(channel);
        if (channel < input.numberOfChannels) {
          const data = input.getChannelData(channel);
          out.set(data);
          if (data.length) hasInput = true;
          for (let i = 0; i < data.length; i += 1) if (data[i] !== 0) nonzero += 1;
        } else out.fill(0);
      }
      if (!hasInput || nonzero === 0) dropoutBlocks += 1;
      analyser.getFloatTimeDomainData(meterBuffer);
      let sumSquares = 0;
      let measuredNonzero = 0;
      for (const sample of meterBuffer) {
        sumSquares += sample * sample;
        if (sample !== 0) measuredNonzero += 1;
      }
      receiveMetrics({ rms: Math.sqrt(sumSquares / meterBuffer.length), nonzero: measuredNonzero / meterBuffer.length, channels: input.numberOfChannels, dropoutBlocks, timeGaps }, context);
    };
    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(context.destination);
    log('capture_fallback', { state: 'script_processor', error: String(cause?.message || cause).slice(0, 180) });
    return 'fallback';
  }

  function receiveMetrics(metrics, context) {
    if (!metrics || typeof metrics.rms !== 'number') return;
    const now = Date.now();
    if (now - lastMetricsAt >= 1000) {
      lastMetricsAt = now;
      const payload = {
        sampleRate: context.sampleRate,
        channels: metrics.channels,
        rms: metrics.rms,
        nonzero: metrics.nonzero,
        state: 'capturing',
      };
      if (typeof metrics.dropoutBlocks === 'number') payload.dropoutBlocks = metrics.dropoutBlocks;
      if (typeof metrics.timeGaps === 'number') payload.timeGaps = metrics.timeGaps;
      ipcRenderer.send('poc:metrics', payload);
    }
    const media = findMedia();
    if (media && !media.paused && !media.ended && metrics.rms === 0) {
      if (lastZeroStart === null) lastZeroStart = now;
      if (now - lastZeroStart >= 5000) {
        log('drm_or_silence', { sampleRate: context.sampleRate, channels: metrics.channels, rms: 0, nonzero: metrics.nonzero, state: 'playing_silent' });
        lastZeroStart = now;
      }
    } else {
      lastZeroStart = null;
    }
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

  const observer = new MutationObserver(() => {
    installButton();
    scheduleScan();
  });
  observer.observe(document, { childList: true, subtree: true });
  installButton();

  onTrustedCommand((command) => {
    if (command.type === 'capture:init' && typeof command.workletSource === 'string') {
      workletSource = command.workletSource;
    } else if (command.type === 'capture:show-button') {
      installButton();
      button?.scrollIntoView({ block: 'nearest' });
    }
  });
})();
