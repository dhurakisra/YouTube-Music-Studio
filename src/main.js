'use strict';

const { app, BrowserWindow, ipcMain, Menu, globalShortcut, session, utilityProcess, dialog, shell } = require('electron');
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
  'pcm_worker_attempt', 'pcm_worker_blocked', 'pcm_bridge_ready', 'pcm_transport_started',
  'pcm_transport_stopped', 'pcm_metrics', 'pcm_port_relayed', 'pcm_port_received', 'pcm_worker_port_ready',
  'stem_jump', 'stem_buffer_changed', 'pcm_capture_mode', 'pcm_capture_error', 'stem_process_started', 'stem_process_ready', 'stem_process_error', 'stem_metrics', 'stem_process_stopped',
  'stem_block_received', 'stem_transport_started', 'stem_transport_stopped', 'stem_model_selected', 'stem_model_selection_rejected',
  'stem_window', 'stem_port_ready', 'stem_input_started', 'stem_playout', 'stem_diag',
]);

let mainWindow;
let pcmBridgeWindow;
let smokeTimer;
let metricsTimer;
let smokePageLoaded = false;
let latestPcmMetrics = {};
let latestStemMetrics = {};
let stemProcess;
let stemProcessRunning = false;
let selectedStemModel = 'umx-hq';
let captureActive = false;
const STEM_MODELS = new Set(['umx-hq', 'htdemucs', 'mdx-kim', 'passthrough']);
const ENABLED_STEM_MODELS = new Set(['umx-hq', 'htdemucs', 'passthrough']);

function appendLog(event, fields = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const record = { t: new Date().toISOString(), event, ...fields };
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
}

function safeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const output = {};
  for (const key of ['sampleRate', 'channels', 'rms', 'nonzero', 'state', 'error', 'dropoutBlocks', 'timeGaps', 'baseLatency', 'outputLatency', 'cycle', 'total', 'receivedBlocks', 'droppedBlocks', 'latencyAvgMs', 'latencyP95Ms', 'latencyMaxMs', 'feedIntervalDeviationMs', 'sequence', 'transport', 'chunks', 'underruns', 'leadMs', 'processingMs', 'delayEstimateMs', 'model', 'windowFrames', 'leadS', 'peak', 'jump', 'jumpRatio', 'pos', 'handleMs', 'rate', 'kind', 'local', 'lagMs', 'step', 'prevStep', 'audioUnderruns', 'audioUnderrunMs', 'outputMs', 'prevOutputMs']) {
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

function isTrustedYtmSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try { return new URL(frame.url).origin === 'https://music.youtube.com'; } catch { return false; }
}

ipcMain.on('poc:log', (event, level, name, data) => {
  if (!isTrustedSender(event) || !['info', 'warn', 'error'].includes(level)) return;
  if (typeof name !== 'string' || !ALLOWED_EVENTS.has(name)) return;
  if (name === 'capture_start_requested' || name === 'capture_started') captureActive = true;
  if (name === 'capture_stopped') captureActive = false;
  appendLog(name, { level, ...safeData(data) });
});

let textureCache = null;
ipcMain.handle('poc:textures', (event) => {
  if (!isTrustedYtmSender(event)) return {};
  if (!textureCache) {
    textureCache = {};
    const dir = path.join(__dirname, '..', 'design', 'tex');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg' };
    try {
      for (const name of fs.readdirSync(dir)) {
        const type = mime[path.extname(name).toLowerCase()];
        if (type) textureCache[name] = 'data:' + type + ';base64,' + fs.readFileSync(path.join(dir, name)).toString('base64');
      }
    } catch (error) { appendLog('capture_error', { state: 'textures_failed', error: String(error.message).slice(0, 120) }); }
  }
  return textureCache;
});

ipcMain.on('poc:stem-model', (event, model) => {
  if (!isTrustedYtmSender(event) || typeof model !== 'string' || !STEM_MODELS.has(model)) return;
  if (captureActive || stemProcessRunning) return;
  if (!ENABLED_STEM_MODELS.has(model)) {
    appendLog('stem_model_selection_rejected', { model, state: 'unavailable', error: 'mdx-kim CPU window processing exceeded the 50% real-time limit' });
    return;
  }
  selectedStemModel = model;
  appendLog('stem_model_selected', { model, state: 'selected' });
});

// ---- Recordings library: MP3 files in <userData>/recordings plus index.json (names, dates). The renderer only ever names a recording by id, never by path. ----
const crypto = require('node:crypto');
function recDir() { return path.join(app.getPath('userData'), 'recordings'); }
function recIndexFile() { return path.join(recDir(), 'index.json'); }
function readRecIndex() {
  try {
    const list = JSON.parse(fs.readFileSync(recIndexFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && /^[\w-]+\.mp3$/.test(String(e.file))) : [];
  } catch { return []; }
}
function writeRecIndex(list) {
  fs.mkdirSync(recDir(), { recursive: true });
  const tmp = recIndexFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf8');
  fs.renameSync(tmp, recIndexFile());
}
function cleanRecName(name) { return String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80); }
function publicRec(entry) { return { id: entry.id, name: entry.name, createdAt: entry.createdAt, durationS: entry.durationS, bytes: entry.bytes }; }
function findRec(id) { return typeof id === 'string' ? readRecIndex().find((e) => e.id === id) : undefined; }
function asArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return null;
}

ipcMain.handle('poc:rec-list', (event) => {
  if (!isTrustedYtmSender(event)) return [];
  return readRecIndex().filter((e) => fs.existsSync(path.join(recDir(), e.file))).map(publicRec);
});

ipcMain.handle('poc:rec-save', async (event, payload) => {
  if (!isTrustedYtmSender(event)) return { ok: false, error: 'untrusted sender' };
  const { sampleRate, name } = payload || {};
  const left = asArrayBuffer(payload?.left), right = asArrayBuffer(payload?.right);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || !left || !right || left.byteLength !== right.byteLength || left.byteLength < 2 || left.byteLength > 800_000_000) {
    return { ok: false, error: 'invalid audio payload' };
  }
  const child = utilityProcess.fork(path.join(__dirname, 'mp3-encode.js'), [], { serviceName: 'YTM audio MP3 encoder' });
  const result = await new Promise((resolve) => {
    child.on('message', (message) => {
      if (message?.type === 'progress') { try { event.sender.send('poc:rec-progress', message.pct); } catch {} }
      else if (message?.type === 'done') resolve({ ok: true, mp3: Buffer.from(message.mp3) });
      else if (message?.type === 'error') resolve({ ok: false, error: String(message.error) });
    });
    child.on('exit', (code) => resolve({ ok: false, error: `encoder exited with code ${code}` }));
    child.postMessage({ type: 'encode', sampleRate, left, right, kbps: 192 });
  });
  try { child.kill(); } catch {}
  if (!result.ok) { appendLog('capture_error', { state: 'rec_encode_failed', error: result.error.slice(0, 150) }); return { ok: false, error: 'encoding failed' }; }
  try {
    const id = crypto.randomUUID();
    const file = `${id}.mp3`;
    fs.mkdirSync(recDir(), { recursive: true });
    fs.writeFileSync(path.join(recDir(), file), result.mp3);
    const entry = {
      id, file, name: cleanRecName(name) || 'Recording', createdAt: new Date().toISOString(),
      durationS: Number(((left.byteLength / 2) / sampleRate).toFixed(2)), bytes: result.mp3.length,
    };
    writeRecIndex([entry, ...readRecIndex()]);
    appendLog('rec_saved', { state: 'saved', durationS: entry.durationS, bytes: entry.bytes });
    return { ok: true, entry: publicRec(entry) };
  } catch (error) {
    appendLog('capture_error', { state: 'rec_write_failed', error: String(error?.message || error).slice(0, 150) });
    return { ok: false, error: 'could not write the recording' };
  }
});

ipcMain.handle('poc:rec-read', (event, id) => {
  if (!isTrustedYtmSender(event)) return null;
  const entry = findRec(id);
  if (!entry) return null;
  try { return new Uint8Array(fs.readFileSync(path.join(recDir(), entry.file))); } catch { return null; }
});

ipcMain.handle('poc:rec-rename', (event, id, name) => {
  if (!isTrustedYtmSender(event)) return null;
  const clean = cleanRecName(name);
  const list = readRecIndex();
  const entry = list.find((e) => e.id === id);
  if (!entry || !clean) return null;
  entry.name = clean;
  writeRecIndex(list);
  return publicRec(entry);
});

ipcMain.handle('poc:rec-delete', (event, id) => {
  if (!isTrustedYtmSender(event)) return false;
  const list = readRecIndex();
  const entry = list.find((e) => e.id === id);
  if (!entry) return false;
  try { fs.rmSync(path.join(recDir(), entry.file), { force: true }); } catch {}
  writeRecIndex(list.filter((e) => e.id !== id));
  return true;
});

ipcMain.handle('poc:rec-reveal', (event, id) => {
  if (!isTrustedYtmSender(event)) return false;
  const entry = findRec(id);
  if (!entry) return false;
  shell.showItemInFolder(path.join(recDir(), entry.file));
  return true;
});

ipcMain.handle('poc:rec-export', async (event, id) => {
  if (!isTrustedYtmSender(event)) return { ok: false };
  const entry = findRec(id);
  if (!entry) return { ok: false };
  const safe = entry.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'recording';
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: 'Export recording as MP3',
    defaultPath: path.join(app.getPath('music'), `${safe}.mp3`),
    filters: [{ name: 'MP3 audio', extensions: ['mp3'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  try { fs.copyFileSync(path.join(recDir(), entry.file), picked.filePath); return { ok: true }; } catch { return { ok: false }; }
});

ipcMain.on('poc:metrics', (event, metrics) => {
  if (!isTrustedSender(event) || !metrics || typeof metrics !== 'object') return;
  const fields = safeData(metrics);
  if (typeof fields.sampleRate !== 'number' || typeof fields.channels !== 'number' ||
      typeof fields.rms !== 'number' || typeof fields.nonzero !== 'number') return;
  appendLog('capture_metrics', { ...fields, ...latestPcmMetrics, state: typeof fields.state === 'string' ? fields.state : 'capturing' });
});

ipcMain.on('poc:pcm-worker-url', (event) => {
  if (!isTrustedYtmSender(event)) return;
  event.returnValue = require('node:url').pathToFileURL(path.join(__dirname, 'pcm-worker.js')).href;
});

ipcMain.on('poc:pcm-port', (event, metadata) => {
  if (!isTrustedYtmSender(event) || !pcmBridgeWindow || pcmBridgeWindow.isDestroyed() || !metadata || metadata.type !== 'pcm-port') return;
  const port = event.ports?.[0];
  if (!port) return;
  // The main process only relays the port. PCM frames never pass through here.
  pcmBridgeWindow.webContents.postMessage('poc:pcm-port', { type: 'pcm-port' }, [port]);
  appendLog('pcm_port_relayed', { state: 'relayed' });
});

function stopStemProcess() {
  if (!stemProcess) return;
  const child = stemProcess;
  stemProcess = undefined;
  try { child.postMessage({ type: 'stem:shutdown' }); } catch {}
  const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 3000);
  child.once('exit', () => clearTimeout(killTimer));
}

function ensureStemProcess() {
  if (stemProcess) return stemProcess;
  const child = utilityProcess.fork(path.join(__dirname, 'stem-process.js'), [`--model=${selectedStemModel}`], { serviceName: 'YTM audio stem separation' });
  stemProcess = child;
  stemProcessRunning = true;
  appendLog('stem_process_started', { state: 'starting' });
  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'stem:ready') appendLog('stem_process_ready', { state: 'ready', model: message.model, windowFrames: message.windowFrames });
    if (message.type === 'stem:debug') appendLog('stem_debug', message.info || {});
    if (message.type === 'stem:port-attached') appendLog('stem_port_ready', { state: 'ready' });
    if (message.type === 'stem:first-input') appendLog('stem_input_started', { sampleRate: message.sampleRate, frames: message.frames });
    if (message.type === 'stem:error') appendLog('stem_process_error', { state: 'failed', error: String(message.error || 'Stem process error').slice(0, 500) });
    if (message.type === 'stem:metrics' && message.metrics && typeof message.metrics === 'object') {
      latestStemMetrics = message.metrics;
      appendLog('stem_metrics', message.metrics);
    }
    if (message.type === 'stem:window' && message.window && typeof message.window === 'object') {
      appendLog('stem_window', message.window);
      appendStemWindowCsv(message.window);
    }
    if (message.type === 'stem:stopped') appendLog('stem_process_stopped', { state: 'stopped' });
  });
  child.on('exit', (code) => {
    stemProcessRunning = false;
    if (stemProcess === child) stemProcess = undefined;
    appendLog('stem_process_stopped', { state: 'exit', error: code === 0 ? '' : String(code) });
  });
  child.on('error', (_type, location, report) => {
    appendLog('stem_process_error', { state: 'process-error', error: `${location || ''} ${report || ''}`.slice(0, 500) });
  });
  return child;
}

ipcMain.on('poc:stem-port', (event, metadata) => {
  if (!isTrustedBridgeSender(event) || metadata?.type !== 'stem-port' || event.ports.length !== 1) return;
  const port = event.ports[0];
  try {
    ensureStemProcess().postMessage({ type: 'stem:port' }, [port]);
    appendLog('pcm_port_received', { state: 'stem-process' });
  } catch (error) {
    try { port.close(); } catch {}
    appendLog('stem_process_error', { state: 'port-transfer-failed', error: String(error?.message || error).slice(0, 300) });
  }
});

ipcMain.on('poc:stem-stop', (event) => {
  if (!isTrustedYtmSender(event)) return;
  stopStemProcess();
});

ipcMain.on('poc:pcm-metrics', (event, metrics) => {
  if ((!isTrustedBridgeSender(event) && !isTrustedYtmSender(event)) || !metrics || typeof metrics !== 'object') return;
  const fields = safeData(metrics);
  if (typeof fields.receivedBlocks !== 'number' || typeof fields.droppedBlocks !== 'number') return;
  latestPcmMetrics = fields;
  appendLog('pcm_metrics', fields);
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

  // YouTube Music registers a beforeunload handler while a song plays; Electron then silently refuses to close the window. Let the close through.
  mainWindow.webContents.on('will-prevent-unload', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = undefined;
    if (pcmBridgeWindow && !pcmBridgeWindow.isDestroyed()) pcmBridgeWindow.close();
  });
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
  // Microphone (karaoke input): audio-only capture is allowed for YouTube Music itself; every other permission keeps Electron's default (granted).
  ytmSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission !== 'media') return callback(true);
    const types = details?.mediaTypes || [];
    callback(isYtmUrl(details?.requestingUrl || '') && !types.includes('video'));
  });
  ytmSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission !== 'media') return true;
    return isYtmUrl(requestingOrigin || details?.requestingUrl || '') && details?.mediaType !== 'video';
  });
  mainWindow.loadURL(YTM_URL);
}

function isTrustedBridgeSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try { return new URL(frame.url).protocol === 'file:' && frame.url.endsWith('/pcm-bridge.html'); } catch { return false; }
}

function createPcmBridgeWindow() {
  pcmBridgeWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  pcmBridgeWindow.on('closed', () => { pcmBridgeWindow = undefined; });
  pcmBridgeWindow.webContents.on('did-finish-load', () => appendLog('pcm_bridge_ready', { state: 'ready' }));
  pcmBridgeWindow.loadFile(path.join(__dirname, 'pcm-bridge.html'));
}

function writeAppMetrics() {
  const metrics = app.getAppMetrics();
  const cpuPercentTotal = metrics.reduce((sum, item) => sum + (Number(item.cpu?.percentCPUUsage) || 0), 0);
  const memoryKB = metrics.reduce((sum, item) => sum + (Number(item.memory?.workingSetSize) || 0), 0);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const columns = 't,cpuPercentTotal,memoryKB,pcmReceivedBlocks,pcmDroppedBlocks,pcmLatencyAvgMs,pcmLatencyP95Ms,pcmLatencyMaxMs,pcmFeedIntervalDeviationMs,stemWindows,stemDroppedWindows,stemProcessingAvgMs,stemProcessingP95Ms,stemQueueLatencyAvgMs,stemQueueLatencyP95Ms,stemWindowSequence,stemWindowProcessingMs,stemWindowQueueLatencyMs,stemModel,stemWindowFrames';
  if (!fs.existsSync(METRICS_FILE)) fs.writeFileSync(METRICS_FILE, `${columns}\n`, 'utf8');
  const p = latestPcmMetrics;
  const s = latestStemMetrics;
  fs.appendFileSync(METRICS_FILE, `${new Date().toISOString()},${cpuPercentTotal.toFixed(2)},${memoryKB},${p.receivedBlocks ?? ''},${p.droppedBlocks ?? ''},${p.latencyAvgMs ?? ''},${p.latencyP95Ms ?? ''},${p.latencyMaxMs ?? ''},${p.feedIntervalDeviationMs ?? ''},${s.windows ?? ''},${s.droppedWindows ?? ''},${s.processingAvgMs ?? ''},${s.processingP95Ms ?? ''},${s.queueLatencyAvgMs ?? ''},${s.queueLatencyP95Ms ?? ''},,,,${s.model ?? ''},${s.windowFrames ?? ''}\n`, 'utf8');
}

function appendStemWindowCsv(window) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const s = latestStemMetrics;
  if (!fs.existsSync(METRICS_FILE)) writeAppMetrics();
  fs.appendFileSync(METRICS_FILE, `${new Date().toISOString()},,,,,,,,,${s.windows ?? ''},${window.droppedWindows ?? s.droppedWindows ?? ''},${s.processingAvgMs ?? ''},${s.processingP95Ms ?? ''},${s.queueLatencyAvgMs ?? ''},${s.queueLatencyP95Ms ?? ''},${window.sequence ?? ''},${window.processingMs ?? ''},${window.queueLatencyMs ?? ''},${window.model ?? s.model ?? ''},${window.windowFrames ?? s.windowFrames ?? ''}\n`, 'utf8');
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
  createPcmBridgeWindow();
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
  stopStemProcess();
});

app.on('window-all-closed', () => app.quit());

