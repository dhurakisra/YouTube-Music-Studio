'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, globalShortcut, session, utilityProcess, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createSpotifyWatcher } = require('./spotify-watcher');

const YTM_URL = 'https://music.youtube.com/';
const PARTITION = process.env.POC_PARTITION || 'persist:ytm-poc';
const LOG_DIR = app.isPackaged ? path.join(process.env.APPDATA || require('node:os').homedir(), 'YTM-Audio-POC', 'logs') : path.join(__dirname, '..', 'logs'); // an installed app must not write into its own folder
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
  'spotify_started', 'spotify_ready', 'spotify_error', 'spotify_stopped',
]);

let mainWindow;
let spotifyWindow;
let tray;
let spotifyWatcher;
let isCompanionMode = false;
let isQuitting = false;
let closingSpotifyForExit = false;
let pcmBridgeWindow;
let autotuneWindow;
let autotuneReady = false;
let autotuneQueue = [];
let autotunePermsSet = false;
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

function isSpotifyStudioUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'file:' && u.pathname.endsWith('/spotify-studio.html');
  } catch { return false; }
}

function isTrustedYtmSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try {
    const u = new URL(frame.url);
    return u.origin === 'https://music.youtube.com' || (u.protocol === 'file:' && u.pathname.endsWith('/spotify-studio.html'));
  } catch { return false; }
}

ipcMain.on('poc:log', (event, level, name, data) => {
  if (!isTrustedSender(event) || !['info', 'warn', 'error'].includes(level)) return;
  if (typeof name !== 'string' || !ALLOWED_EVENTS.has(name)) return;
  if (name === 'capture_start_requested' || name === 'capture_started') captureActive = true;
  if (name === 'capture_stopped') captureActive = false;
  appendLog(name, { level, ...safeData(data) });
});

let textureCache = null;
let stretchSrc = null;
// Signalsmith Stretch (MIT, WASM): high-quality KEY / pitch shifting. The sandboxed preload cannot require files, so it gets the source here.
ipcMain.handle('poc:stretch-src', (event) => {
  if (!isTrustedYtmSender(event)) return '';
  if (stretchSrc === null) {
    try { stretchSrc = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'signalsmith-stretch', 'SignalsmithStretch.js'), 'utf8'); }
    catch (error) { stretchSrc = ''; appendLog('capture_error', { state: 'stretch_src_failed', error: String(error.message).slice(0, 120) }); }
  }
  return stretchSrc;
});

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
    try { // bundled OFL fonts (design/fonts), as data URIs under 'f:<file name>'
      const fdir = path.join(__dirname, '..', 'design', 'fonts');
      for (const name of fs.readdirSync(fdir)) if (name.endsWith('.woff2')) textureCache['f:' + name] = 'data:font/woff2;base64,' + fs.readFileSync(path.join(fdir, name)).toString('base64');
    } catch (error) { appendLog('capture_error', { state: 'fonts_failed', error: String(error.message).slice(0, 120) }); }
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
function publicRec(entry) { return { id: entry.id, name: entry.name, createdAt: entry.createdAt, durationS: entry.durationS, bytes: entry.bytes, layers: (entry.layers || []).map((l) => l.key), kind: entry.kind === 'mix' ? 'mix' : 'raw', micOffsetMs: Number(entry.micOffsetMs) || 0 }; }
const REC_LAYER_KEYS = new Set(['vocal', 'inst', 'drums', 'bass', 'drumsbass', 'other', 'micwet', 'micdry']);
function layersDir(id) { return path.join(recDir(), `${id}.layers`); }
function wavHeader(dataBytes, channels, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

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
    if (payload?.kind === 'mix') entry.kind = 'mix'; // bounced from the Mixer (finished product); everything else is a raw recording block
    writeRecIndex([entry, ...readRecIndex()]);
    appendLog('rec_saved', { state: 'saved', durationS: entry.durationS, bytes: entry.bytes });
    return { ok: true, entry: publicRec(entry) };
  } catch (error) {
    appendLog('capture_error', { state: 'rec_write_failed', error: String(error?.message || error).slice(0, 150) });
    return { ok: false, error: 'could not write the recording' };
  }
});

// Layered recordings: each layer is a lossless 16-bit WAV in <id>.layers/. Layers are added to an existing library entry right after its MP3 is saved.
ipcMain.handle('poc:rec-layer', (event, payload) => {
  if (!isTrustedYtmSender(event)) return { ok: false };
  const { id, key, sampleRate, channels } = payload || {};
  const pcm = asArrayBuffer(payload?.pcm);
  if (typeof id !== 'string' || !REC_LAYER_KEYS.has(key) || !pcm || pcm.byteLength < 2 || pcm.byteLength > 900_000_000) return { ok: false, error: 'invalid layer' };
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || ![1, 2].includes(channels) || pcm.byteLength % (2 * channels) !== 0) return { ok: false, error: 'invalid layer' };
  const list = readRecIndex();
  const entry = list.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'unknown recording' };
  try {
    fs.mkdirSync(layersDir(id), { recursive: true });
    const data = Buffer.from(pcm);
    fs.writeFileSync(path.join(layersDir(id), `${key}.wav`), Buffer.concat([wavHeader(data.length, channels, sampleRate), data]));
    entry.layers = [...(entry.layers || []).filter((l) => l.key !== key), { key, file: `${key}.wav`, channels, sampleRate, frames: data.length / (2 * channels) }];
    writeRecIndex(list);
    appendLog('rec_saved', { state: 'layer-' + key, bytes: data.length });
    return { ok: true };
  } catch (error) {
    appendLog('capture_error', { state: 'rec_layer_write_failed', error: String(error?.message || error).slice(0, 150) });
    return { ok: false, error: 'could not write the layer' };
  }
});

ipcMain.handle('poc:rec-read', (event, id) => {
  if (!isTrustedYtmSender(event)) return null;
  const entry = findRec(id);
  if (!entry) return null;
  try { return new Uint8Array(fs.readFileSync(path.join(recDir(), entry.file))); } catch { return null; }
});

// Layer WAV for the library mixer: the renderer sends only an id + a layer key (never a path); key must be one the entry really has.
ipcMain.handle('poc:rec-layer-read', (event, id, key) => {
  if (!isTrustedYtmSender(event)) return null;
  const entry = findRec(id);
  if (!entry || typeof key !== 'string' || !REC_LAYER_KEYS.has(key) || !(entry.layers || []).some((l) => l.key === key)) return null;
  try { return new Uint8Array(fs.readFileSync(path.join(layersDir(entry.id), `${key}.wav`))); } catch { return null; }
});

// Lyrics: several public sources are tried in order (see lyrics-sources.js). Only artist, track, album and duration leave the machine; results are cached in memory.
const { findLyrics } = require('./lyrics-sources');
const lyricsCache = new Map();
ipcMain.handle('poc:lyrics', async (event, q) => {
  if (!isTrustedYtmSender(event)) return null;
  const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 150) : '');
  const artist = clean(q?.artist), title = clean(q?.title), album = clean(q?.album);
  const duration = Number.isFinite(q?.duration) && q.duration > 0 ? Math.round(q.duration) : 0;
  if (!artist || !title) return { notFound: true };
  const key = [artist, title, album, duration].join('|').toLowerCase();
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  const result = await findLyrics({ artist, title, album, duration });
  if (!result.error) lyricsCache.set(key, result); // network trouble is retried later
  return result;
});

// Mic latency compensation (ms the mic layer was recorded late), estimated at REC time and fine-tuned by the user in the Mixer.
ipcMain.handle('poc:rec-set-offset', (event, id, ms) => {
  if (!isTrustedYtmSender(event)) return false;
  const list = readRecIndex();
  const entry = list.find((e) => e.id === id);
  if (!entry || !Number.isFinite(ms)) return false;
  entry.micOffsetMs = Math.max(-500, Math.min(500, Math.round(ms)));
  try { writeRecIndex(list); return true; } catch { return false; }
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
  try { fs.rmSync(layersDir(entry.id), { recursive: true, force: true }); } catch {}
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

const { createSpotifyHelper } = require('./spotify-helper');
const spotifyHelper = createSpotifyHelper({
  appendLog,
  getMainWindow: () => (spotifyWindow && !spotifyWindow.isDestroyed() ? spotifyWindow : mainWindow),
});

ipcMain.handle('poc:spotify-start', (event) => {
  if (!isTrustedYtmSender(event)) return { ok: false, error: 'untrusted sender' };
  return spotifyHelper.start();
});

ipcMain.handle('poc:spotify-stop', (event) => {
  if (!isTrustedYtmSender(event)) return { ok: false, error: 'untrusted sender' };
  return spotifyHelper.stop();
});

ipcMain.handle('poc:spotify-cmd', (event, cmd) => {
  if (!isTrustedYtmSender(event)) return { ok: false, error: 'untrusted sender' };
  return spotifyHelper.sendCommand(cmd);
});

ipcMain.on('poc:pcm-metrics', (event, metrics) => {
  if ((!isTrustedBridgeSender(event) && !isTrustedYtmSender(event)) || !metrics || typeof metrics !== 'object') return;
  const fields = safeData(metrics);
  if (typeof fields.receivedBlocks !== 'number' || typeof fields.droppedBlocks !== 'number') return;
  latestPcmMetrics = fields;
  appendLog('pcm_metrics', fields);
});

// ---- Auto-tune: a hidden local window (no restrictive CSP, so AudioWorklet works) pitch-corrects the mic and streams it back to the YTM page over a local WebRTC link. Main only relays signalling. ----
function isTrustedAutotuneSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try { return new URL(frame.url).protocol === 'file:' && frame.url.endsWith('/autotune.html'); } catch { return false; }
}

function cleanAtParams(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (Number.isFinite(p.key)) out.key = Math.min(11, Math.max(0, Math.round(p.key)));
  if (Number.isFinite(p.scale)) out.scale = Math.min(4, Math.max(0, Math.round(p.scale)));
  if (Number.isFinite(p.speed)) out.speed = Math.min(1, Math.max(0, p.speed));
  if (Number.isFinite(p.amount)) out.amount = Math.min(1, Math.max(0, p.amount));
  return out;
}

function cleanAtMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
  const out = { t: m.t };
  switch (m.t) {
    case 'start': out.label = typeof m.label === 'string' ? m.label.slice(0, 200) : ''; out.params = cleanAtParams(m.params); break;
    case 'params': out.params = cleanAtParams(m.params); break;
    case 'offer': case 'answer':
      if (typeof m.sdp !== 'string' || m.sdp.length > 30000) return null;
      out.sdp = m.sdp; break;
    case 'ice':
      if (m.c === null) { out.c = null; break; }
      if (!m.c || typeof m.c.candidate !== 'string' || m.c.candidate.length > 1000) return null;
      out.c = {
        candidate: m.c.candidate,
        sdpMid: typeof m.c.sdpMid === 'string' ? m.c.sdpMid.slice(0, 40) : null,
        sdpMLineIndex: Number.isInteger(m.c.sdpMLineIndex) ? m.c.sdpMLineIndex : null,
        usernameFragment: typeof m.c.usernameFragment === 'string' ? m.c.usernameFragment.slice(0, 80) : undefined,
      };
      break;
    case 'status':
      for (const k of ['f0', 'midi', 'target', 'shift']) out[k] = Number.isFinite(m[k]) ? m[k] : 0;
      break;
    case 'error': out.error = String(m.error || '').slice(0, 200); break;
    case 'stop': case 'ready': break;
    default: return null;
  }
  return out;
}

function closeAutotuneWindow() {
  const w = autotuneWindow;
  autotuneWindow = undefined; autotuneReady = false; autotuneQueue = [];
  if (w && !w.isDestroyed()) w.destroy();
}

function sendToAutotune(msg) {
  if (!autotuneWindow || autotuneWindow.isDestroyed()) return;
  if (autotuneReady) autotuneWindow.webContents.send('poc:at-msg', msg); else autotuneQueue.push(msg);
}

function ensureDefaultSessionMediaPerms() {
  if (autotunePermsSet) return;
  autotunePermsSet = true;
  const isAllowed = (url) => /\/(?:autotune|spotify-studio)\.html$/.test(String(url || '').split(/[?#]/)[0]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission !== 'media') return callback(false);
    const types = details?.mediaTypes || [];
    callback(isAllowed(details?.requestingUrl) && !types.includes('video'));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission !== 'media') return false;
    return isAllowed(details?.requestingUrl || origin) && details?.mediaType !== 'video';
  });
}

function createAutotuneWindow() {
  closeAutotuneWindow();
  ensureDefaultSessionMediaPerms();
  autotuneWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  });
  autotuneWindow.loadFile(path.join(__dirname, 'autotune.html'));
}

ipcMain.on('poc:win', (event, cmd) => {
  if (!isTrustedYtmSender(event)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (cmd === 'min') win.minimize();
  else if (cmd === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (cmd === 'close') win.close();
});

ipcMain.on('poc:at-to-lab', (event, raw) => {
  if (!isTrustedYtmSender(event)) return;
  const msg = cleanAtMessage(raw);
  if (!msg || !['start', 'params', 'answer', 'ice', 'stop'].includes(msg.t)) return;
  if (msg.t === 'stop') { closeAutotuneWindow(); return; }
  if (msg.t === 'start') createAutotuneWindow();
  sendToAutotune(msg);
});

ipcMain.on('poc:at-from-lab', (event, raw) => {
  if (!isTrustedAutotuneSender(event) || !autotuneWindow || event.sender !== autotuneWindow.webContents) return;
  const msg = cleanAtMessage(raw);
  if (!msg) return;
  if (msg.t === 'ready') {
    autotuneReady = true;
    for (const queued of autotuneQueue.splice(0)) autotuneWindow.webContents.send('poc:at-msg', queued);
    return;
  }
  if (!['offer', 'ice', 'status', 'error'].includes(msg.t)) return;
  if (msg.t === 'error') appendLog('stem_diag', { kind: 'autotune_error', error: msg.error });
  const targetWin = (spotifyWindow && !spotifyWindow.isDestroyed()) ? spotifyWindow : mainWindow;
  if (targetWin && !targetWin.isDestroyed()) targetWin.webContents.send('poc:at-msg', msg);
});

function sendCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.getURL().startsWith(YTM_URL)) {
    mainWindow.webContents.send('poc:command', command);
  }
}

function notifySpotifyStudioClosedUnexpectedly(reason = 'closed') {
  const title = 'Spotify Studio kapandı';
  const body = reason === 'crashed'
    ? 'Spotify Studio beklenmedik şekilde kapandı. Spotify sesi boş bir cihaza (SP-DF) yönlendirilmişse ses gelmeyebilir; tray ikonundan yeniden açabilirsiniz.'
    : 'Spotify hâlâ çalışıyor. Spotify sesi boş bir cihaza (SP-DF) yönlendirilmişse ses gelmeyebilir; tray ikonundan yeniden açın veya Volume mixer\'dan çıkışı geri alın.';
  appendLog('spotify_error', { state: 'studio_closed_unexpectedly', error: reason });
  try {
    if (tray && !tray.isDestroyed() && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({ title, content: body, iconType: 'warning' });
    } else if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch {}
}

function getLoginItemArgs() {
  return app.isPackaged ? ['--spotify-companion'] : [path.resolve(__dirname, '..'), '--spotify-companion'];
}

function isAutoStartEnabled() {
  try {
    return Boolean(app.getLoginItemSettings({ path: process.execPath, args: getLoginItemArgs() }).openAtLogin);
  } catch { return false; }
}

function setAutoStartEnabled(enable) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enable),
      path: process.execPath,
      args: getLoginItemArgs(),
    });
  } catch (error) {
    appendLog('spotify_error', { state: 'autostart_failed', error: String(error?.message || error).slice(0, 160) });
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const spRunning = Boolean(spotifyWatcher?.isRunning());
  const studioOpen = Boolean(spotifyWindow && !spotifyWindow.isDestroyed());
  const menu = Menu.buildFromTemplate([
    { label: spRunning ? 'Spotify: Çalışıyor' : 'Spotify: Bekleniyor', enabled: false },
    { type: 'separator' },
    {
      label: studioOpen ? 'Spotify Studio\'yu Göster' : 'Spotify Studio\'yu Aç',
      click: () => {
        if (spotifyWindow && !spotifyWindow.isDestroyed()) {
          if (spotifyWindow.isMinimized()) spotifyWindow.restore();
          spotifyWindow.show();
          spotifyWindow.focus();
        } else {
          createSpotifyStudioWindow();
        }
      },
    },
    {
      label: 'YouTube Music Studio\'yu Aç',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Windows açılışında başlat',
      type: 'checkbox',
      checked: isAutoStartEnabled(),
      click: (item) => {
        setAutoStartEnabled(item.checked);
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(spRunning ? 'Spotify Studio (Spotify aktif)' : 'Spotify Studio (Spotify bekleniyor)');
}

function setupCompanionTray() {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(path.join(__dirname, '..', 'build', 'icon.png'));
  tray.on('double-click', () => {
    if (spotifyWindow && !spotifyWindow.isDestroyed()) {
      if (spotifyWindow.isMinimized()) spotifyWindow.restore();
      spotifyWindow.show();
      spotifyWindow.focus();
    } else {
      createSpotifyStudioWindow();
    }
  });
  updateTrayMenu();
}

function createSpotifyStudioWindow() {
  if (spotifyWindow && !spotifyWindow.isDestroyed()) {
    if (spotifyWindow.isMinimized()) spotifyWindow.restore();
    spotifyWindow.show();
    spotifyWindow.focus();
    return spotifyWindow;
  }
  ensureDefaultSessionMediaPerms();
  closingSpotifyForExit = false;
  spotifyWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    backgroundColor: '#0e0906',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  spotifyWindow.webContents.on('did-finish-load', () => {
    if (!isSpotifyStudioUrl(spotifyWindow.webContents.getURL())) return;
    appendLog('page_loaded', { state: 'spotify-studio-loaded' });
    smokePageLoaded = true;
    if (app.commandLine.hasSwitch('smoke')) app.quit();
  });

  spotifyWindow.webContents.on('render-process-gone', (_event, details) => {
    if (!isQuitting && !closingSpotifyForExit && spotifyWatcher?.isRunning()) {
      notifySpotifyStudioClosedUnexpectedly('crashed');
    }
    appendLog('spotify_error', { state: 'renderer_gone', error: String(details?.reason || 'unknown') });
  });

  spotifyWindow.on('closed', () => {
    const wasExpected = isQuitting || closingSpotifyForExit;
    closingSpotifyForExit = false;
    spotifyWindow = undefined;
    spotifyHelper.stop();
    stopStemProcess();
    closeAutotuneWindow();
    updateTrayMenu();
    if (!wasExpected && spotifyWatcher?.isRunning()) {
      notifySpotifyStudioClosedUnexpectedly('closed');
    }
  });

  spotifyWindow.loadFile(path.join(__dirname, 'spotify-studio.html'));
  updateTrayMenu();
  return spotifyWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden', // no native title bar: our top bar is the window's header; the native min/max/close buttons stay as an overlay
    // window buttons are drawn by the page (small, in the top bar) and sent here
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
    spotifyHelper.stop();
    if (pcmBridgeWindow && !pcmBridgeWindow.isDestroyed()) pcmBridgeWindow.close();
    closeAutotuneWindow();
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
        // KEY on plain listening runs in an AudioWorklet (real-time audio thread: no clicks under page load). Worklet modules are
        // built in the preload as blob: URLs, so only `blob:` is added to script-src; nothing else in YouTube Music's policy changes.
        cspHeader[1] = policies.map((policy) => String(policy).replace(/(^|;)\s*script-src(?![\w-])([^;]*)/gi, (m, sep, rest) => `${sep} script-src${rest} blob:`));
        headers[cspHeader[0]] = cspHeader[1];
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

// The auto-tune loopback is local-only: real host candidates (no mDNS obfuscation) so the hidden window and the page connect reliably.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

app.whenReady().then(() => {
  app.setName('YTM Audio POC');
  app.setPath('userData', process.env.YTM_POC_USERDATA || path.join(app.getPath('appData'), 'YTM-Audio-POC')); // YTM_POC_USERDATA: dev aid, e.g. a signed-out profile
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
  isCompanionMode = app.commandLine.hasSwitch('spotify-companion');
  const openSpotifyDirect = app.commandLine.hasSwitch('spotify-studio');
  if (isCompanionMode) {
    setupCompanionTray();
    spotifyWatcher = createSpotifyWatcher({
      intervalMs: 2000,
      onStart: () => {
        appendLog('spotify_started', { state: 'process_detected' });
        createSpotifyStudioWindow();
        updateTrayMenu();
      },
      onStop: () => {
        appendLog('spotify_stopped', { state: 'process_exited' });
        if (spotifyWindow && !spotifyWindow.isDestroyed()) {
          closingSpotifyForExit = true;
          spotifyWindow.close();
        }
        updateTrayMenu();
      },
      onStatusChange: () => updateTrayMenu(),
    });
    spotifyWatcher.start();
  } else if (openSpotifyDirect) {
    createSpotifyStudioWindow();
  } else {
    createWindow();
  }
  try { require('./updater').setupUpdater(() => mainWindow, appendLog); } catch (error) { appendLog('updater_error', { state: 'setup_failed', error: String(error.message).slice(0, 120) }); }

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
  isQuitting = true;
  if (smokeTimer) clearTimeout(smokeTimer);
  if (metricsTimer) clearInterval(metricsTimer);
  if (spotifyWatcher) spotifyWatcher.stop();
  globalShortcut.unregisterAll();
  spotifyHelper.stop();
  stopStemProcess();
});

app.on('window-all-closed', () => {
  if (!isCompanionMode) app.quit();
});

