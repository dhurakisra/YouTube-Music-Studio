'use strict';

const { app, BrowserWindow, ipcMain, Menu, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const YTM_URL = 'https://music.youtube.com/';
const PARTITION = 'persist:ytm-poc';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const ALLOWED_EVENTS = new Set([
  'app_started', 'page_loaded', 'page_load_error', 'capture_button_ready',
  'capture_start_requested', 'capture_started', 'capture_worklet_error',
  'media_element_missing', 'capture_metrics', 'drm_or_silence', 'capture_error',
]);

let mainWindow;
let smokeTimer;
let smokePageLoaded = false;

function appendLog(event, fields = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const record = { t: new Date().toISOString(), event, ...fields };
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
}

function safeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const output = {};
  for (const key of ['sampleRate', 'channels', 'rms', 'nonzero', 'state', 'error']) {
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
    const workletSource = fs.readFileSync(path.join(__dirname, 'worklet.js'), 'utf8');
    sendCommand({ type: 'capture:init', workletSource });
    if (app.commandLine.hasSwitch('smoke')) app.quit();
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) appendLog('page_load_error', { state: String(code), error: description });
  });

  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.loadURL(YTM_URL);
}

function isYtmUrl(rawUrl) {
  try { return new URL(rawUrl).origin === 'https://music.youtube.com'; } catch { return false; }
}

app.whenReady().then(() => {
  app.setName('YTM Audio POC');
  app.setPath('userData', path.join(app.getPath('appData'), 'YTM-Audio-POC'));
  appendLog('app_started', { state: 'ready' });
  if (app.commandLine.hasSwitch('smoke')) {
    smokeTimer = setTimeout(() => {
      if (!smokePageLoaded) appendLog('page_load_error', { state: 'smoke_timeout', error: 'Main page did not load within 10 seconds' });
      app.quit();
    }, 10_000);
  }
  createWindow();

  const template = [{
    label: 'Capture',
    submenu: [{ label: 'Show capture button', accelerator: 'CommandOrControl+Shift+C', click: () => sendCommand({ type: 'capture:show-button' }) }],
  }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  globalShortcut.register('CommandOrControl+Shift+C', () => sendCommand({ type: 'capture:show-button' }));
});

app.on('will-quit', () => {
  if (smokeTimer) clearTimeout(smokeTimer);
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());

