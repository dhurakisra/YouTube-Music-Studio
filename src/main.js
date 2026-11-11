'use strict';

const { app, BrowserWindow, ipcMain, Menu, globalShortcut, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const YTM_URL = 'https://music.youtube.com/';
const PARTITION = process.env.POC_PARTITION || 'persist:ytm-poc';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const METRICS_FILE = path.join(LOG_DIR, `metrics-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
const ALLOWED_EVENTS = new Set([
  'app_started', 'page_loaded', 'page_load_error', 'capture_button_ready',
  'capture_start_requested', 'capture_started', 'capture_stop_requested', 'capture_stopped',
  'capture_start_cycle', 'capture_worklet_error',
  'capture_fallback', 'capture_error', 'media_element_missing', 'capture_metrics',
  'drm_or_silence', 'csp_policy', 'csp_console_message', 'processing_state', 'latency_info',
]);

let mainWindow;
let smokeTimer;
let metricsTimer;
let smokePageLoaded = false;

function appendLog(event, fields = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const record = { t: new Date().toISOString(), event, ...fields };
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
}

function safeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const output = {};
  for (const key of ['sampleRate', 'channels', 'rms', 'nonzero', 'state', 'error', 'dropoutBlocks', 'timeGaps', 'baseLatency', 'outputLatency', 'cycle', 'total']) {
    if (Object.hasOwn(data, key) && (typeof data[key] === 'number' || typeof data[key] === 'string')) {
      output[key] = data[key];
    }
  }
  return output;
}

function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(frame.url);
    return url.origin === 'https://music.youtube.com' || url.protocol === 'file:';
  } catch {
    return false;
  }
}

ipcMain.on('poc:log', (event, level, name, data) => {
  if (!isTrustedSender(event) || !['info', 'warn', 'error'].includes(level)) return;
  if (typeof name !== 'string' || !ALLOWED_EVENTS.has(name)) return;
  appendLog(name, { level, ...safeData(data) });
});

ipcMain.on('poc:metrics', (event, metrics) => {
  if (!isTrustedSender(event) || !metrics || typeof metrics !== 'object') return;
  const fields = safeData(metrics);
  if (typeof fields.sampleRate !== 'number' || typeof fields.channels !== 'number' ||
      typeof fields.rms !== 'number' || typeof fields.nonzero !== 'number') return;
  appendLog('capture_metrics', { ...fields, state: typeof fields.state === 'string' ? fields.state : 'capturing' });
});

function sendCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.getURL().startsWith(YTM_URL)) {
    mainWindow.webContents.send('poc:command', command);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!isYtmUrl(mainWindow.webContents.getURL())) return;
    appendLog('page_loaded', { state: 'loaded' });
    smokePageLoaded = true;
    if (app.commandLine.hasSwitch('smoke')) app.quit();
  });

  mainWindow.webContents.on('console-message', (details) => {
    const message = typeof details === 'object' && details ? details.message : '';
    if (typeof message !== 'string' || !/worklet|content security policy|\bcsp\b|refused to (?:load|connect)/i.test(message)) return;
    // Keep this diagnostic limited to CSP/worklet failures; never record arbitrary page console output.
    appendLog('csp_console_message', { message: message.replace(/nonce-[A-Za-z0-9+/_=-]+/gi, 'nonce-[REDACTED]').slice(0, 1000) });
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) appendLog('page_load_error', { state: String(code), error: description });
  });

  mainWindow.on('closed', () => { mainWindow = undefined; });
  const ytmSession = session.fromPartition(PARTITION);
  ytmSession.webRequest.onHeadersReceived({ urls: ['https://music.youtube.com/*'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame' && isYtmUrl(details.url)) {
      const headers = details.responseHeaders || {};
      const cspHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-security-policy');
      if (cspHeader) {
        const policies = Array.isArray(cspHeader[1]) ? cspHeader[1] : [cspHeader[1]];
        const wanted = policies.flatMap((policy) => String(policy).split(';'))
          .map((part) => part.trim().replace(/nonce-[A-Za-z0-9+/_=-]+/gi, 'nonce-[REDACTED]'))
          .filter((part) => /^(?:script-src|worker-src|default-src)(?:\s|$)/i.test(part));
        appendLog('csp_policy', { directives: wanted });
      }
    }
    callback({ responseHeaders: details.responseHeaders });
  });
  mainWindow.loadURL(YTM_URL);
}

function writeAppMetrics() {
  const metrics = app.getAppMetrics();
  const cpuPercentTotal = metrics.reduce((sum, item) => sum + (Number(item.cpu?.percentCPUUsage) || 0), 0);
  const memoryKB = metrics.reduce((sum, item) => sum + (Number(item.memory?.workingSetSize) || 0), 0);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(METRICS_FILE)) fs.writeFileSync(METRICS_FILE, 't,cpuPercentTotal,memoryKB\n', 'utf8');
  fs.appendFileSync(METRICS_FILE, `${new Date().toISOString()},${cpuPercentTotal.toFixed(2)},${memoryKB}\n`, 'utf8');
}

function isYtmUrl(rawUrl) {
  try { return new URL(rawUrl).origin === 'https://music.youtube.com'; } catch { return false; }
}

app.whenReady().then(() => {
  app.setName('YTM Audio POC');
  app.setPath('userData', path.join(app.getPath('appData'), 'YTM-Audio-POC'));
  appendLog('app_started', { state: 'ready' });
  writeAppMetrics();
  metricsTimer = setInterval(writeAppMetrics, 5000);
  if (app.commandLine.hasSwitch('smoke')) {
    smokeTimer = setTimeout(() => {
      if (!smokePageLoaded) appendLog('page_load_error', { state: 'smoke_timeout', error: 'Main page did not load within 30 seconds' });
      app.quit();
    }, 30_000);
  }
  createWindow();

  const template = [{
    label: 'Capture',
    submenu: [
      { label: 'Show capture button', accelerator: 'CommandOrControl+Shift+C', click: () => sendCommand({ type: 'capture:show-button' }) },
      { label: 'Stop / start capture', accelerator: 'CommandOrControl+Shift+X', click: () => sendCommand({ type: 'capture:toggle' }) },
    ],
  }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  globalShortcut.register('CommandOrControl+Shift+C', () => sendCommand({ type: 'capture:show-button' }));
  globalShortcut.register('CommandOrControl+Shift+X', () => sendCommand({ type: 'capture:toggle' }));
  const requestedCycles = Number.parseInt(process.env.POC_CAPTURE_CYCLES || '0', 10);
  if (Number.isInteger(requestedCycles) && requestedCycles > 0) {
    const cycles = Math.min(requestedCycles, 100);
    const autoCycleOnLoad = () => setTimeout(() => sendCommand({ type: 'capture:auto-cycle', cycles }), 1200);
    if (smokePageLoaded) autoCycleOnLoad();
    else mainWindow?.webContents.once('did-finish-load', autoCycleOnLoad);
  }
});

app.on('will-quit', () => {
  if (smokeTimer) clearTimeout(smokeTimer);
  if (metricsTimer) clearInterval(metricsTimer);
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());

