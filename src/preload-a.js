'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function trustedLocalMainFrame() {
  try {
    const url = new URL(location.href);
    return window === window.top && url.protocol === 'file:' && url.pathname.endsWith('/capture-a.html');
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld('captureA', Object.freeze({
  log(event, data = {}) {
    if (!trustedLocalMainFrame()) return;
    ipcRenderer.send('capture-a:log', event, data);
  },
  setVariant(variant) {
    if (!trustedLocalMainFrame() || !['local_echo_disabled', 'webcontents_muted'].includes(variant)) return;
    ipcRenderer.send('capture-a:variant', variant);
  },
  restoreAudio() {
    if (!trustedLocalMainFrame()) return;
    ipcRenderer.send('capture-a:restore-audio');
  },
  metrics(data) {
    if (!trustedLocalMainFrame()) return;
    ipcRenderer.send('capture-a:metrics', data);
  },
}));
