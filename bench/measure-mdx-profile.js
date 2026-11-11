'use strict';

// One-shot CPU qualification for the optional MDX Kim stem profile.
const path = require('node:path');
const ort = require('onnxruntime-node');

const SR = 44100, N = 7680, HOP = 1024, BINS = 3072, FRAMES = 256;
const MODEL = path.join(__dirname, '..', 'models', 'mdx-kim-vocal-2.onnx');
const WINDOW_FRAMES = (FRAMES - 1) * HOP;

function fftPow2(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = (inverse ? 2 : -2) * Math.PI / len, wr0 = Math.cos(ang), wi0 = Math.sin(ang); for (let i = 0; i < n; i += len) { let wr = 1, wi = 0; for (let j = 0; j < len / 2; j++) { const u = i + j, v = u + len / 2, vr = re[v] * wr - im[v] * wi, vi = re[v] * wi + im[v] * wr; re[v] = re[u] - vr; im[v] = im[u] - vi; re[u] += vr; im[u] += vi; const nr = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nr; } } }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function dft(input, inverse = false) {
  const m = 1 << Math.ceil(Math.log2(2 * N - 1)), ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
  for (let j = 0; j < N; j++) { const q = (j * j) % (2 * N), a = (inverse ? 1 : -1) * Math.PI * q / N; ar[j] = input[j] * Math.cos(a); ai[j] = input[j] * Math.sin(a); const c = Math.cos(-a), s = Math.sin(-a); br[j] = c; bi[j] = s; if (j) { br[m - j] = c; bi[m - j] = s; } }
  fftPow2(ar, ai); fftPow2(br, bi); for (let i = 0; i < m; i++) { const r = ar[i] * br[i] - ai[i] * bi[i], im = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; ai[i] = im; } fftPow2(ar, ai, true);
  const outR = new Float32Array(N), outI = new Float32Array(N);
  for (let k = 0; k < N; k++) { const q = (k * k) % (2 * N), a = (inverse ? 1 : -1) * Math.PI * q / N, r = ar[k] * Math.cos(a) - ai[k] * Math.sin(a), im = ar[k] * Math.sin(a) + ai[k] * Math.cos(a); outR[k] = inverse ? r / N : r; outI[k] = inverse ? im / N : im; }
  return [outR, outI];
}
function reflect(i, length) { while (i < 0 || i >= length) { if (i < 0) i = -i; if (i >= length) i = 2 * length - 2 - i; } return i; }
function features(audio) {
  const data = new Float32Array(4 * BINS * FRAMES), win = new Float64Array(N);
  for (let n = 0; n < N; n++) win[n] = .5 - .5 * Math.cos(2 * Math.PI * n / N);
  for (let c = 0; c < 2; c++) for (let f = 0; f < FRAMES; f++) {
    const frame = new Float64Array(N), start = f * HOP - N / 2;
    for (let n = 0; n < N; n++) frame[n] = audio[c][reflect(start + n, audio[c].length)] * win[n];
    const [re, im] = dft(frame);
    for (let k = 0; k < BINS; k++) { data[(c * 2 * BINS + k) * FRAMES + f] = re[k]; data[(c * 2 * BINS + BINS + k) * FRAMES + f] = im[k]; }
  }
  return new ort.Tensor('float32', data, [1, 4, BINS, FRAMES]);
}
function reconstruct(tensor) {
  const a = tensor.data, count = WINDOW_FRAMES, out = [new Float64Array(count), new Float64Array(count)], norm = new Float64Array(count), win = new Float64Array(N);
  for (let n = 0; n < N; n++) win[n] = .5 - .5 * Math.cos(2 * Math.PI * n / N);
  for (let f = 0; f < FRAMES; f++) for (let c = 0; c < 2; c++) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < BINS; k++) { re[k] = a[(c * 2 * BINS + k) * FRAMES + f]; im[k] = a[(c * 2 * BINS + BINS + k) * FRAMES + f]; if (k) { re[N - k] = re[k]; im[N - k] = -im[k]; } }
    const [ir] = dft(re, true), start = f * HOP - N / 2;
    for (let j = 0; j < N; j++) { const ix = start + j; if (ix >= 0 && ix < count) { out[c][ix] += ir[j] * win[j]; norm[ix] += win[j] * win[j]; } }
  }
  return out.map(ch => Float32Array.from(ch, (v, i) => v / (norm[i] || 1)));
}
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; }

async function main() {
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: true, enableMemPattern: true });
  const audio = [new Float32Array(WINDOW_FRAMES), new Float32Array(WINDOW_FRAMES)];
  for (let i = 0; i < WINDOW_FRAMES; i++) { const t = i / SR; audio[0][i] = .2 * Math.sin(2 * Math.PI * 220 * t); audio[1][i] = .18 * Math.sin(2 * Math.PI * 220 * t + .12); }
  const t0 = process.hrtime.bigint();
  const input = features(audio);
  const result = await session.run({ input });
  const vocals = reconstruct(result.output);
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(JSON.stringify({ model: 'mdx-kim', executionProvider: 'cpu', windowFrames: WINDOW_FRAMES, windowMs: WINDOW_FRAMES / SR * 1000, totalMs: Number(totalMs.toFixed(3)), inferWithPrePostMs: Number(totalMs.toFixed(3)), outputSamples: vocals[0].length }));
  await session.release();
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
