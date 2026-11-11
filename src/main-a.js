'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const YTM_URL = 'https://music.youtube.com/';
const PARTITION = process.env.POC_PARTITION || 'persist:ytm-poc';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, `capture-a-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const CONTROL_FILE = path.join(__dirname, 'capture-a.html');
const ALLOWED_EVENTS = new Set([
  'app_started', 'ytm_loaded', 'control_loaded', 'display_request_denied',
  'capture_start_requested', 'capture_started', 'capture_stopped', 'capture_error',
  'capture_metrics', 'audio_muted_variant',
]);

let ytmWindow;
let controlWindow;
let variant = 'local_echo_disabled';
let smokeTimer;
let ytmLoaded = false;
let controlLoaded = false;

function appendLog(event, fields = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const record = { t: new Date().toISOString(), event, ...fields };
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
}

function safeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const output = {};
  for (const key of ['sampleRate', 'channels', 'rms', 'nonzero', 'state', 'error', 'variant']) {
    const value = data[key];
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') output[key] = value;
  }
  return output;
}

function isControlFileUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(CONTROL_FILE);
  } catch {
    return false;
  }
}

function isControlSender(event) {
  return Boolean(controlWindow && !controlWindow.isDestroyed() &&
    event.sender === controlWindow.webContents && event.senderFrame === event.sender.mainFrame &&
    isControlFileUrl(event.senderFrame.url));
}

function isYtmUrl(rawUrl) {
  try { return new URL(rawUrl).origin === 'https://music.youtube.com'; } catch { return false; }
}

function maybeFinishSmoke() {
  if (app.commandLine.hasSwitch('smoke') && ytmLoaded && controlLoaded) {
    appendLog('smoke_ready', { state: 'ytm_and_control_loaded' });
    app.quit();
  }
}

function configureCaptureHandler(captureSession) {
  captureSession.setDisplayMediaRequestHandler((request, callback) => {
    const controlFrame = controlWindow?.webContents.mainFrame;
    const originAllowed = ['file://', 'file:///'].includes(request.securityOrigin) || request.securityOrigin === 'null';
    const frameAllowed = Boolean(request.frame && controlFrame && request.frame === controlFrame &&
      request.frame === request.frame.top && isControlFileUrl(request.frame.url));
    const ytmFrame = ytmWindow?.webContents.mainFrame;
    const ytmAllowed = Boolean(ytmWindow && !ytmWindow.isDestroyed() && isYtmUrl(ytmWindow.webContents.getURL()));
    if (!frameAllowed || !originAllowed || !request.audioRequested || !request.videoRequested || !ytmAllowed || !ytmFrame) {
      appendLog('display_request_denied', { state: 'untrusted_or_incomplete_request', variant, frameAllowed, originAllowed, securityOrigin: request.securityOrigin, frameUrl: request.frame?.url, audioRequested: request.audioRequested, videoRequested: request.videoRequested, ytmAllowed, hasYtmFrame: Boolean(ytmFrame) });
      callback(null);
      return;
    }

    try {
      callback({
        video: ytmFrame,
        audio: ytmFrame,
        enableLocalEcho: false,
      });
      appendLog('capture_started', { state: 'granted', variant });
    } catch (error) {
      appendLog('capture_error', { state: 'grant_failed', error: String(error?.message || error), variant });
      callback(null);
    }
  });
}

function createYtmWindow() {
  ytmWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  ytmWindow.webContents.on('did-finish-load', () => {
    if (!isYtmUrl(ytmWindow.webContents.getURL())) return;
    ytmLoaded = true;
    appendLog('ytm_loaded', { state: 'loaded' });
    maybeFinishSmoke();
  });
  ytmWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) appendLog('capture_error', { state: String(code), error: description, variant });
  });
  ytmWindow.on('closed', () => { ytmWindow = undefined; app.quit(); });
  ytmWindow.loadURL(YTM_URL);
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 460,
    height: 380,
    minWidth: 420,
    minHeight: 340,
    title: 'Method A capture control',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload-a.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  controlWindow.webContents.on('did-finish-load', () => {
    if (!isControlFileUrl(controlWindow.webContents.getURL())) return;
    controlLoaded = true;
    appendLog('control_loaded', { state: 'loaded' });
    maybeFinishSmoke();
  });
  controlWindow.on('closed', () => { controlWindow = undefined; app.quit(); });
  controlWindow.loadFile(CONTROL_FILE);
}

ipcMain.on('capture-a:log', (event, name, data) => {
  if (!isControlSender(event) || typeof name !== 'string' || !ALLOWED_EVENTS.has(name)) return;
  appendLog(name, safeData(data));
});

ipcMain.on('capture-a:variant', (event, nextVariant) => {
  if (!isControlSender(event) || !['local_echo_disabled', 'webcontents_muted'].includes(nextVariant)) return;
  variant = nextVariant;
  const mute = variant === 'webcontents_muted';
  if (ytmWindow && !ytmWindow.isDestroyed()) ytmWindow.webContents.setAudioMuted(mute);
  appendLog('audio_muted_variant', { state: mute ? 'muted' : 'unmuted', variant });
});

ipcMain.on('capture-a:restore-audio', (event) => {
  if (!isControlSender(event)) return;
  if (ytmWindow && !ytmWindow.isDestroyed()) ytmWindow.webContents.setAudioMuted(false);
  variant = 'local_echo_disabled';
  appendLog('audio_muted_variant', { state: 'restored', variant });
});

ipcMain.on('capture-a:metrics', (event, metrics) => {
  if (!isControlSender(event)) return;
  const fields = safeData(metrics);
  if (typeof fields.sampleRate !== 'number' || typeof fields.channels !== 'number' ||
      typeof fields.rms !== 'number' || typeof fields.nonzero !== 'number' ||
      !['local_echo_disabled', 'webcontents_muted'].includes(fields.variant)) return;
  appendLog('capture_metrics', fields);
});

app.whenReady().then(() => {
  app.setName('YTM Audio POC Method A');
  app.setPath('userData', path.join(app.getPath('appData'), 'YTM-Audio-POC'));
  appendLog('app_started', { state: 'ready' });
  const captureSession = session.fromPartition(PARTITION);
  configureCaptureHandler(captureSession);
  if (app.commandLine.hasSwitch('smoke')) {
    smokeTimer = setTimeout(() => {
      if (!ytmLoaded || !controlLoaded) appendLog('capture_error', { state: 'smoke_timeout', error: 'YTM and control windows did not both load within 20 seconds', variant });
      app.quit();
    }, 20_000);
  }
  createYtmWindow();
  createControlWindow();
});

app.on('will-quit', () => { if (smokeTimer) clearTimeout(smokeTimer); });
app.on('window-all-closed', () => app.quit());
