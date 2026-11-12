'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parentPort = process.parentPort || require('electron').parentPort;
const ort = require('onnxruntime-node');

const SAMPLE_RATE = 44100;
const MODEL_PROFILES = {
  'umx-hq': { file: path.join(__dirname, '..', 'models', 'umx-hq-vocals.onnx'), windowFrames: SAMPLE_RATE * 2, kind: 'umx' },
  passthrough: { file: null, windowFrames: 343980, kind: 'pass' }, // diagnostic: no model, input goes out as 'vocal'
  htdemucs: { file: path.join(__dirname, '..', 'models', 'htdemucs_fp16.onnx'), windowFrames: 343980, kind: 'ht' },
};
const requestedModel = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
const MODEL_ID = Object.hasOwn(MODEL_PROFILES, requestedModel) ? requestedModel : 'umx-hq';
const PROFILE = MODEL_PROFILES[MODEL_ID];
const WINDOW_FRAMES = PROFILE.windowFrames;
const HOP_FRAMES = WINDOW_FRAMES / 2; // contract: 50% overlap; overlap-add happens in the consumer
const FFT_SIZE = 4096;
const HOP = 1024;
const BINS = FFT_SIZE / 2 + 1;
const WINDOW_COUNT = 1 + Math.floor(WINDOW_FRAMES / HOP);
const BENCH_README = path.join(__dirname, '..', 'bench', 'README.md');

let session;
let shuttingDown = false;
let activePort;
let input = new Float32Array(WINDOW_FRAMES * 2);
let inputOffset = 0;
let windowStartedAt = 0;
let windowSequence = 0;
let nextOutputSequence = 0;
let lastInputSequence = 0;
let droppedWindows = 0;
let droppedInputBlocks = 0;
let inputBlocks = 0;
let windowsDone = 0;
const processingTimes = [];
const queueTimes = [];
const sampleWindow = new Float64Array(FFT_SIZE);

for (let i = 0; i < FFT_SIZE; i += 1) sampleWindow[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_SIZE);

function percentile(values, p) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(p * ordered.length) - 1)];
}

function reportMetrics() {
  const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  parentPort.postMessage({ type: 'stem:metrics', metrics: {
    model: MODEL_ID,
    windowFrames: WINDOW_FRAMES,
    windows: windowsDone,
    droppedWindows,
    droppedInputBlocks,
    processingAvgMs: Number(average(processingTimes).toFixed(3)),
    processingP95Ms: Number(percentile(processingTimes, 0.95).toFixed(3)),
    queueLatencyAvgMs: Number(average(queueTimes).toFixed(3)),
    queueLatencyP95Ms: Number(percentile(queueTimes, 0.95).toFixed(3)),
  } });
}

function reflect(index, length) {
  while (index < 0 || index >= length) {
    if (index < 0) index = -index;
    if (index >= length) index = 2 * length - 2 - index;
  }
  return index;
}

function fft(real, imag, inverse = false) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wLenR = Math.cos(angle), wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const uR = real[i + j], uI = imag[i + j];
        const vR = real[i + j + len / 2] * wr - imag[i + j + len / 2] * wi;
        const vI = real[i + j + len / 2] * wi + imag[i + j + len / 2] * wr;
        real[i + j] = uR + vR; imag[i + j] = uI + vI;
        real[i + j + len / 2] = uR - vR; imag[i + j + len / 2] = uI - vI;
        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR; wr = nextWr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) { real[i] /= n; imag[i] /= n; }
}

function spectrogram(audio) {
  const mag = new Float32Array(2 * BINS * WINDOW_COUNT);
  const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE);
  for (let channel = 0; channel < 2; channel += 1) {
    for (let frame = 0; frame < WINDOW_COUNT; frame += 1) {
      const start = frame * HOP - FFT_SIZE / 2;
      for (let n = 0; n < FFT_SIZE; n += 1) {
        real[n] = audio[2 * reflect(start + n, WINDOW_FRAMES) + channel] * sampleWindow[n];
        imag[n] = 0;
      }
      fft(real, imag);
      for (let bin = 0; bin < BINS; bin += 1) mag[(channel * BINS + bin) * WINDOW_COUNT + frame] = Math.hypot(real[bin], imag[bin]);
    }
  }
  return { tensor: new ort.Tensor('float32', mag, [1, 2, BINS, WINDOW_COUNT]), mag };
}

function makeStems(audio, estimate) {
  const vocal = new Float32Array(WINDOW_FRAMES * 2);
  const denominator = new Float64Array(WINDOW_FRAMES);
  const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE);
  for (let channel = 0; channel < 2; channel += 1) {
    const outOffset = channel;
    for (let frame = 0; frame < WINDOW_COUNT; frame += 1) {
      const start = frame * HOP - FFT_SIZE / 2;
      // Recompute the mixture complex STFT so masking retains its phase.
      for (let n = 0; n < FFT_SIZE; n += 1) {
        real[n] = audio[2 * reflect(start + n, WINDOW_FRAMES) + channel] * sampleWindow[n];
        imag[n] = 0;
      }
      fft(real, imag);
      for (let bin = 0; bin < BINS; bin += 1) {
        const offset = (channel * BINS + bin) * WINDOW_COUNT + frame;
        const magnitude = Math.hypot(real[bin], imag[bin]);
        const target = Math.max(0, estimate[offset]);
        const mask = magnitude > 1e-8 ? Math.min(1, target / magnitude) : 0;
        real[bin] *= mask; imag[bin] *= mask;
        if (bin > 0 && bin < FFT_SIZE / 2) { real[FFT_SIZE - bin] *= mask; imag[FFT_SIZE - bin] *= mask; }
      }
      fft(real, imag, true);
      for (let n = 0; n < FFT_SIZE; n += 1) {
        const index = start + n;
        if (index < 0 || index >= WINDOW_FRAMES) continue;
        const win = sampleWindow[n];
        vocal[index * 2 + outOffset] += real[n] * win;
        if (channel === 0) denominator[index] += win * win;
      }
    }
  }
  const instrumental = new Float32Array(vocal.length);
  for (let i = 0; i < WINDOW_FRAMES; i += 1) {
    const norm = denominator[i] > 1e-12 ? denominator[i] : 1;
    vocal[i * 2] /= norm; vocal[i * 2 + 1] /= norm;
    instrumental[i * 2] = audio[i * 2] - vocal[i * 2];
    instrumental[i * 2 + 1] = audio[i * 2 + 1] - vocal[i * 2 + 1];
  }
  return { vocal, instrumental };
}

function htdemucsStems(data) {
  // Output plane order: drums, bass, other, vocals; each plane is [channel][frame].
  const names = ['drums', 'bass', 'other', 'vocal'];
  const out = {};
  for (const name of names) out[name] = new Float32Array(WINDOW_FRAMES * 2);
  for (let s = 0; s < 4; s += 1) {
    const target = out[names[s]];
    for (let i = 0; i < WINDOW_FRAMES; i += 1) for (let channel = 0; channel < 2; channel += 1) {
      target[2 * i + channel] = data[s * 2 * WINDOW_FRAMES + channel * WINDOW_FRAMES + i];
    }
  }
  return out;
}

// Artifact reduction (HT-Demucs). Env toggles for A/B listening: YTM_POC_RESTORE=0..1, YTM_POC_SHIFT=0|1.
let RESTORE = Math.min(1, Math.max(0, Number(process.env.YTM_POC_RESTORE) || 0));
let SHIFT_FRAMES = process.env.YTM_POC_SHIFT === '1' ? 11025 : 0; // 0.25 s at 44.1 kHz; both can also be set live via 'stem:options'

// One HT-Demucs pass; shift > 0 delays the input by `shift` frames and un-delays the output.
async function htdemucsRun(audio, shift) {
  const planar = new Float32Array(WINDOW_FRAMES * 2);
  for (let i = shift; i < WINDOW_FRAMES; i += 1) {
    planar[i] = audio[2 * (i - shift)]; planar[WINDOW_FRAMES + i] = audio[2 * (i - shift) + 1];
  }
  const result = await session.run({ mix: new ort.Tensor('float32', planar, [1, 2, WINDOW_FRAMES]) });
  const output = result.stems?.data;
  if (!output || output.length !== 4 * 2 * WINDOW_FRAMES) throw new Error('HT-Demucs returned an incompatible stems tensor');
  const stems = htdemucsStems(output);
  if (shift > 0) for (const name of Object.keys(stems)) {
    const s = stems[name];
    s.copyWithin(0, shift * 2, WINDOW_FRAMES * 2);
  }
  return stems;
}

// Residual (mix minus sum of stems) is shared between stems by their window energy, scaled by `amount`.
function restoreResidual(audio, stems, amount) {
  const arrays = Object.values(stems), count = arrays.length;
  const energy = arrays.map((s) => { let e = 1e-12; for (let i = 0; i < s.length; i += 1) e += s[i] * s[i]; return e; });
  const total = energy.reduce((a, b) => a + b, 0);
  const share = energy.map((e) => (e / total) * amount);
  for (let i = 0; i < audio.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < count; k += 1) sum += arrays[k][i];
    const residual = audio[i] - sum;
    for (let k = 0; k < count; k += 1) arrays[k][i] += residual * share[k];
  }
}

async function runWindow(audio, sequence, readyEpochMs) {
  const queuedAt = Date.now() - readyEpochMs;
  const start = process.hrtime.bigint();
  try {
    let stems;
    if (PROFILE.kind === 'umx') {
      const { tensor, mag } = spectrogram(audio);
      const result = await session.run({ mag: tensor });
      const estimate = result.estimate?.data;
      if (!estimate || estimate.length !== mag.length) throw new Error('Model returned an incompatible estimate tensor');
      stems = makeStems(audio, estimate);
    } else if (PROFILE.kind === 'pass') {
      const zeros = () => new Float32Array(WINDOW_FRAMES * 2);
      stems = { drums: zeros(), bass: zeros(), other: zeros(), vocal: Float32Array.from(audio) };
    } else if (PROFILE.kind === 'ht') {
      stems = await htdemucsRun(audio, 0);
      if (SHIFT_FRAMES > 0) {
        // Shift averaging: second pass on the input delayed by SHIFT_FRAMES, un-shifted and averaged (tail keeps pass 1 only).
        const second = await htdemucsRun(audio, SHIFT_FRAMES);
        for (const name of Object.keys(stems)) {
          const a = stems[name], b = second[name];
          const end = (WINDOW_FRAMES - SHIFT_FRAMES) * 2;
          for (let i = 0; i < end; i += 1) a[i] = 0.5 * (a[i] + b[i]);
        }
      }
      if (RESTORE > 0) restoreResidual(audio, stems, RESTORE);
    }
    const processingMs = Number(process.hrtime.bigint() - start) / 1e6;
    processingTimes.push(processingMs); queueTimes.push(Math.max(0, queuedAt));
    windowsDone += 1;
    if (processingTimes.length > 300) processingTimes.shift();
    if (queueTimes.length > 300) queueTimes.shift();
    parentPort.postMessage({ type: 'stem:window', window: {
      sequence: nextOutputSequence + 1, sourceSequence: sequence,
      processingMs: Number(processingMs.toFixed(3)),
      queueLatencyMs: Number(Math.max(0, queuedAt).toFixed(3)),
      droppedWindows, droppedInputBlocks, model: MODEL_ID, windowFrames: WINDOW_FRAMES,
    } });
    activePort.postMessage({
      type: 'stem:block', sequence: ++nextOutputSequence, sourceSequence: sequence,
      sampleRate: SAMPLE_RATE, channels: 2, frames: WINDOW_FRAMES,
      ...Object.fromEntries(Object.entries(stems).map(([k, v]) => [k, v.buffer])),
      processingMs: Number(processingMs.toFixed(3)), queueLatencyMs: Number(Math.max(0, queuedAt).toFixed(3)),
    });
    reportMetrics();
  } catch (error) {
    droppedWindows += 1;
    parentPort.postMessage({ type: 'stem:error', error: `Window ${sequence} failed: ${error?.stack || error}` });
    reportMetrics();
  }
}

const pendingWindows = [];
let processing = false;
async function pump() {
  if (processing || !activePort) return;
  processing = true;
  while (pendingWindows.length) {
    const next = pendingWindows.shift();
    await runWindow(next.audio, next.sequence, next.readyEpochMs);
  }
  processing = false;
  if (shuttingDown) await shutdown();
}

function appendPcm(message) {
  if (ArrayBuffer.isView(message.data)) message = { ...message, data: message.data.buffer.slice(message.data.byteOffset, message.data.byteOffset + message.data.byteLength) };
  if (!(message.data instanceof ArrayBuffer) || !Number.isFinite(message.sampleRate) || message.sampleRate <= 0 || message.channels !== 2) return;
  if (lastInputSequence && message.sequence > lastInputSequence + 1) {
    const missing = message.sequence - lastInputSequence - 1;
    droppedInputBlocks += missing;
    // Any missing input block makes at least one output window incomplete.
    droppedWindows += 1;
    inputOffset = 0;
  }
  lastInputSequence = message.sequence;
  inputBlocks += 1;
  if (inputBlocks === 1) parentPort.postMessage({ type: 'stem:first-input', sampleRate: message.sampleRate, channels: message.channels, frames: message.frames });
  const source = new Float32Array(message.data);
  const sourceFrames = Math.min(message.frames || Math.floor(source.length / 2), Math.floor(source.length / 2));
  const targetFrames = Math.round(sourceFrames * SAMPLE_RATE / message.sampleRate);
  if (!windowStartedAt) { windowStartedAt = Number(message.timestampEpochMs) || Date.now(); windowSequence = message.sequence; }
  for (let i = 0; i < targetFrames; i += 1) {
    const sourcePosition = targetFrames <= 1 ? 0 : i * (sourceFrames - 1) / (targetFrames - 1);
    const leftIndex = Math.floor(sourcePosition), rightIndex = Math.min(sourceFrames - 1, leftIndex + 1), mix = sourcePosition - leftIndex;
    for (let channel = 0; channel < 2; channel += 1) {
      const value = source[2 * leftIndex + channel] * (1 - mix) + source[2 * rightIndex + channel] * mix;
      input[2 * inputOffset + channel] = value;
    }
    inputOffset += 1;
    if (inputOffset === WINDOW_FRAMES) {
      pendingWindows.push({ audio: input.slice(), sequence: windowSequence, readyEpochMs: Date.now() });
      input.copyWithin(0, HOP_FRAMES * 2, WINDOW_FRAMES * 2);
      inputOffset = WINDOW_FRAMES - HOP_FRAMES;
      windowStartedAt = 0;
      if (pendingWindows.length > 4) {
        pendingWindows.shift();
        droppedWindows += 1;
      }
      pump();
    }
  }
}

let debugSeen = 0;
function attachPort(port) {
  activePort = port;
  parentPort.postMessage({ type: 'stem:port-attached' });
  inputOffset = 0;
  lastInputSequence = 0;
  port.on('message', (event) => {
    const message = event.data;
    if (debugSeen < 5) { debugSeen += 1; parentPort.postMessage({ type: 'stem:debug', info: { n: debugSeen, inspect: require('node:util').inspect(event?.data, { depth: 2, maxArrayLength: 4 }).slice(0, 400), own: Reflect.ownKeys(event?.data || {}).map(String).slice(0, 12).join(','), proto: String(Object.getPrototypeOf(event?.data || {}) === null ? 'null' : 'obj'), json: (() => { try { return JSON.stringify(event?.data).slice(0, 200); } catch (e) { return 'err ' + e.message; } })() } }); }
    if (message?.type === 'pcm:block') appendPcm(message);
    if (message?.type === 'pcm:stop') {
      shuttingDown = true;
      if (!processing) pump();
    }
  });
  port.start();
  port.postMessage({ type: 'stem:ready', sampleRate: SAMPLE_RATE, model: MODEL_ID, windowFrames: WINDOW_FRAMES });
}

async function shutdown() {
  if (pendingWindows.length && !processing) return pump();
  if (session) { try { await session.release(); } catch {} session = null; }
  if (activePort) { try { activePort.close(); } catch {} activePort = undefined; }
  parentPort.postMessage({ type: 'stem:stopped' });
  setTimeout(() => process.exit(0), 20);
}

parentPort.on('message', async (event) => {
  const message = event.data;
  if (message?.type === 'stem:options') {
    RESTORE = Math.min(1, Math.max(0, Number(message.restore) || 0));
    SHIFT_FRAMES = message.shift === true ? 11025 : 0;
    return;
  }
  if (message?.type === 'stem:shutdown') {
    shuttingDown = true;
    if (!processing) await pump();
  }
  if (message?.type === 'stem:port' && event.ports?.length === 1) {
    try {
      if (PROFILE.kind !== 'pass' && !fs.existsSync(PROFILE.file)) throw new Error(`Model not found for profile "${MODEL_ID}": ${PROFILE.file}. Download it using the steps in ${BENCH_README}.`);
      if (PROFILE.kind !== 'pass') session = await ort.InferenceSession.create(PROFILE.file, {
        executionProviders: ['cpu'], graphOptimizationLevel: 'all',
        enableCpuMemArena: true, enableMemPattern: true,
      });
      parentPort.postMessage({ type: 'stem:ready', model: MODEL_ID, windowFrames: WINDOW_FRAMES });
      attachPort(event.ports[0]);
    } catch (error) {
      parentPort.postMessage({ type: 'stem:error', error: error?.stack || String(error) });
      try { event.ports?.[0]?.close(); } catch {}
      await shutdown();
    }
  }
});

parentPort.postMessage({ type: 'stem:started' });
