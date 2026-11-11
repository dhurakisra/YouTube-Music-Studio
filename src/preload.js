'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedLogEvents = new Set([
  'capture_button_ready', 'capture_start_requested', 'capture_started',
  'capture_worklet_error', 'media_element_missing', 'drm_or_silence', 'capture_error',
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
  let workletFailed = false;
  let scanQueued = false;
  let lastZeroStart = null;
  let lastMetricsAt = 0;
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
    log('capture_start_requested', { state: 'requested' });
    try {
      const media = findMedia();
      if (!media) {
        log('media_element_missing', { state: 'waiting' });
        return;
      }
      if (!workletSource) {
        log('capture_error', { state: 'waiting', error: 'AudioWorklet source is not ready yet' });
        return;
      }
      if (workletFailed) return;
      let context = activeContext;
      if (!context || context.state === 'closed') {
        context = new AudioContext({ latencyHint: 'interactive' });
        activeContext = context;
        const sourceUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
        try {
          await context.audioWorklet.addModule(sourceUrl);
        } catch (error) {
          workletFailed = true;
          log('capture_worklet_error', { state: 'worklet_load_failed', error: String(error?.message || error) });
          return;
        } finally {
          URL.revokeObjectURL(sourceUrl);
        }
      }
      await context.resume();
      if (!wiredElements.has(media)) {
        const source = context.createMediaElementSource(media);
        wiredElements.add(media);
        const meter = new AudioWorkletNode(context, 'ytm-capture-meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        meter.port.onmessage = ({ data }) => receiveMetrics(data, context);
        source.connect(meter);
        meter.connect(context.destination);
      }
      scanMedia();
      log('capture_started', { sampleRate: context.sampleRate, state: 'capturing' });
      if (button) button.textContent = 'Capture active';
    } catch (error) {
      log('capture_error', { state: 'failed', error: String(error?.message || error) });
    }
  }

  function receiveMetrics(metrics, context) {
    if (!metrics || typeof metrics.rms !== 'number') return;
    const now = Date.now();
    if (now - lastMetricsAt >= 1000) {
      lastMetricsAt = now;
      ipcRenderer.send('poc:metrics', {
        sampleRate: context.sampleRate,
        channels: metrics.channels,
        rms: metrics.rms,
        nonzero: metrics.nonzero,
        state: 'capturing',
      });
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
