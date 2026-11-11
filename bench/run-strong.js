const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const ort = require('onnxruntime-node');

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(__dirname, 'input');
const OUT_DIR = path.join(__dirname, 'out');
const MODELS = [
  { id: 'htdemucs-fp16', label: 'HT-Demucs fp16', file: path.join(ROOT, 'models', 'htdemucs_fp16.onnx'), kind: 'ht' },
  { id: 'mdx-kim-vocal-2', label: 'MDX Kim Vocal 2', file: path.join(ROOT, 'models', 'mdx-kim-vocal-2.onnx'), kind: 'mdx' },
];
const SR = 44100, HT_SAMPLES = 343980, HT_SEC = HT_SAMPLES / SR;
const MDX_N = 7680, MDX_HOP = 1024, MDX_BINS = 3072, MDX_FRAMES = 256;
const BENCH_SECONDS = [2, 3, 7.8], RUNS = 1;
const MAX_INFERENCE_MS = 30000;
let inferenceTimedOut = false;

async function boundedInference(model, session, audio) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`inference timed out after ${MAX_INFERENCE_MS} ms`)), MAX_INFERENCE_MS); });
  try { return await Promise.race([timedRun(model, session, audio), timeout]); }
  catch (e) { if (String(e.message).includes('timed out')) inferenceTimedOut = true; throw e; }
  finally { clearTimeout(timer); }
}

function synthetic(seconds = 8) {
  const x = [new Float32Array(SR * seconds), new Float32Array(SR * seconds)];
  for (let i = 0; i < x[0].length; i++) {
    const t = i / SR;
    x[0][i] = .23 * Math.sin(2 * Math.PI * 220 * t) + .11 * Math.sin(2 * Math.PI * 440 * t);
    x[1][i] = .2 * Math.sin(2 * Math.PI * 220 * t + .15) + .13 * Math.sin(2 * Math.PI * 330 * t);
  }
  return x;
}
function wavRead(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw Error('Expected RIFF/WAVE');
  let o = 12, fmt, channels, rate, bits, data;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4), p = o + 8;
    if (id === 'fmt ') { fmt = b.readUInt16LE(p); channels = b.readUInt16LE(p + 2); rate = b.readUInt32LE(p + 4); bits = b.readUInt16LE(p + 14); }
    if (id === 'data') { data = b.subarray(p, p + n); break; }
    o = p + n + (n & 1);
  }
  if (![1, 3].includes(fmt) || ![16, 24, 32].includes(bits) || (fmt === 3 && bits !== 32) || ![1, 2].includes(channels) || !rate || !data) throw Error('Expected PCM16/24/32 or IEEE float32 mono/stereo WAV');
  const bytes = bits / 8, count = data.length / (bytes * channels), x = [new Float32Array(count), new Float32Array(count)];
  const sample = (at) => {
    if (fmt === 3) return data.readFloatLE(at);
    if (bits === 16) return data.readInt16LE(at) / 32768;
    if (bits === 24) { let v = data[at] | data[at + 1] << 8 | data[at + 2] << 16; if (v & 0x800000) v |= 0xff000000; return v / 8388608; }
    return data.readInt32LE(at) / 2147483648;
  };
  for (let i = 0; i < count; i++) {
    x[0][i] = sample(i * channels * bytes);
    x[1][i] = channels === 2 ? sample(i * channels * bytes + bytes) : x[0][i];
  }
  if (rate !== SR) return [resample(x[0], rate), resample(x[1], rate)];
  return x;
}
function resample(a, rate) {
  const n = Math.round(a.length * SR / rate), b = new Float32Array(n), ratio = rate / SR;
  for (let i = 0; i < n; i++) { const q = i * ratio, j = Math.min(a.length - 1, Math.floor(q)), f = q - j; b[i] = a[j] * (1 - f) + (a[Math.min(j + 1, a.length - 1)] || 0) * f; }
  return b;
}
function wavWrite(file, audio, rate = SR) {
  const n = Math.min(audio[0].length, audio[1].length), bytes = Buffer.alloc(44 + n * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + n * 4, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { for (let c = 0; c < 2; c++) bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio[c][i] * 32767))), 44 + i * 4 + c * 2); }
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
function slicePad(x, start, length) { const out = [new Float32Array(length), new Float32Array(length)]; for (let c = 0; c < 2; c++) for (let i = 0; i < length; i++) out[c][i] = x[c][Math.min(start + i, x[c].length - 1)] || 0; return out; }
function percentile(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; }
function rss() { return process.memoryUsage().rss / 1048576; }
function gpu() { try { return execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000 }).trim().split(/\r?\n/).map(Number).join(','); } catch { return null; } }
function failRow(model, sec, ep, note) { return { model, sec, ep, error: String(note).replace(/[|`\r\n]/g, ' ') }; }

// Complex radix-2 FFT plus Bluestein for the MDX graph's 7680-point transform.
function fftPow2(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = (inverse ? 2 : -2) * Math.PI / len, wr0 = Math.cos(ang), wi0 = Math.sin(ang); for (let i = 0; i < n; i += len) { let wr = 1, wi = 0; for (let j = 0; j < len / 2; j++) { const u = i + j, v = u + len / 2, vr = re[v] * wr - im[v] * wi, vi = re[v] * wi + im[v] * wr; re[v] = re[u] - vr; im[v] = im[u] - vi; re[u] += vr; im[u] += vi; const nr = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nr; } } }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function dft7680(input, inverse = false) {
  const n = MDX_N, m = 1 << Math.ceil(Math.log2(2 * n - 1)), ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
  for (let j = 0; j < n; j++) { const q = (j * j) % (2 * n), a = (inverse ? 1 : -1) * Math.PI * q / n; ar[j] = input[j] * Math.cos(a); ai[j] = input[j] * Math.sin(a); const c = Math.cos(-a), s = Math.sin(-a); br[j] = c; bi[j] = s; if (j) { br[m - j] = c; bi[m - j] = s; } }
  fftPow2(ar, ai); fftPow2(br, bi); for (let i = 0; i < m; i++) { const r = ar[i] * br[i] - ai[i] * bi[i], im = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; ai[i] = im; } fftPow2(ar, ai, true);
  const outR = new Float32Array(n), outI = new Float32Array(n);
  for (let k = 0; k < n; k++) { const q = (k * k) % (2 * n), a = (inverse ? 1 : -1) * Math.PI * q / n, r = ar[k] * Math.cos(a) - ai[k] * Math.sin(a), im = ar[k] * Math.sin(a) + ai[k] * Math.cos(a); outR[k] = inverse ? r / n : r; outI[k] = inverse ? im / n : im; }
  return [outR, outI];
}
function mdxFeatures(audio) {
  const data = new Float32Array(4 * MDX_BINS * MDX_FRAMES), win = new Float64Array(MDX_N);
  for (let n = 0; n < MDX_N; n++) win[n] = .5 - .5 * Math.cos(2 * Math.PI * n / MDX_N);
  for (let c = 0; c < 2; c++) for (let f = 0; f < MDX_FRAMES; f++) {
    const frame = new Float64Array(MDX_N), start = f * MDX_HOP - MDX_N / 2;
    for (let n = 0; n < MDX_N; n++) { let i = start + n; while (i < 0 || i >= audio[c].length) { if (i < 0) i = -i; if (i >= audio[c].length) i = 2 * audio[c].length - 2 - i; } frame[n] = audio[c][i] * win[n]; }
    const [re, im] = dft7680(frame);
    for (let k = 0; k < MDX_BINS; k++) { data[(c * 2 * MDX_BINS + k) * MDX_FRAMES + f] = re[k]; data[(c * 2 * MDX_BINS + MDX_BINS + k) * MDX_FRAMES + f] = im[k]; }
  }
  return new ort.Tensor('float32', data, [1, 4, MDX_BINS, MDX_FRAMES]);
}
function mdxReconstruct(tensor, frames = MDX_FRAMES) {
  const a = tensor.data, nSamp = (frames - 1) * MDX_HOP, out = [new Float64Array(nSamp), new Float64Array(nSamp)], norm = new Float64Array(nSamp), win = new Float64Array(MDX_N);
  for (let n = 0; n < MDX_N; n++) win[n] = .5 - .5 * Math.cos(2 * Math.PI * n / MDX_N);
  for (let f = 0; f < frames; f++) for (let c = 0; c < 2; c++) {
    const re = new Float64Array(MDX_N), im = new Float64Array(MDX_N);
    for (let k = 0; k < MDX_BINS; k++) { re[k] = a[(c * 2 * MDX_BINS + k) * MDX_FRAMES + f]; im[k] = a[(c * 2 * MDX_BINS + MDX_BINS + k) * MDX_FRAMES + f]; if (k) { re[MDX_N - k] = re[k]; im[MDX_N - k] = -im[k]; } }
    const [ir] = dft7680(re, true), start = f * MDX_HOP - MDX_N / 2;
    for (let j = 0; j < MDX_N; j++) { const ix = start + j; if (ix >= 0 && ix < nSamp) { out[c][ix] += ir[j] * win[j]; norm[ix] += win[j] * win[j]; } }
  }
  return out.map(ch => Float32Array.from(ch, (v, i) => v / (norm[i] || 1)));
}

async function timedRun(model, session, audio) {
  if (model.kind === 'ht') {
    const block = slicePad(audio, 0, HT_SAMPLES), input = new ort.Tensor('float32', Float32Array.from([...block[0], ...block[1]]), [1, 2, HT_SAMPLES]);
    const result = await session.run({ mix: input });
    const d = result.stems.data, len = HT_SAMPLES;
    return { vocals: [Float32Array.from(d.slice(3 * 2 * len, 3 * 2 * len + len)), Float32Array.from(d.slice(3 * 2 * len + len, 4 * 2 * len))] };
  }
  const inputAudio = slicePad(audio, 0, (MDX_FRAMES - 1) * MDX_HOP);
  const input = mdxFeatures(inputAudio), result = await session.run({ input });
  const vocals = mdxReconstruct(result.output);
  return { vocals };
}
async function measure(model, sec, ep, audio, session) {
  const beforeRss = rss(), beforeGpu = ep === 'dml' ? gpu() : null;
  try {
    const warmStart = process.hrtime.bigint();
    await boundedInference(model, session, audio);
    const first = Number(process.hrtime.bigint() - warmStart) / 1e6, times = [];
    for (let i = 0; i < RUNS; i++) { const t = process.hrtime.bigint(); await boundedInference(model, session, audio); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { model: model.label, sec, ep, first, avg, p95: percentile(times, .95), rtf: avg / (sec * 1000), rssBefore: beforeRss, rssAfter: rss(), gpuBefore: beforeGpu, gpuAfter: ep === 'dml' ? gpu() : null, status: 'OK' };
  } catch (e) { return failRow(model.label, sec, ep, e.message || e); }
}
async function separateFile(model, session, audio, outDir) {
  // 7.8s HT segment, 5.92s MDX spectral block; 50% overlap and linear crossfade.
  const block = model.kind === 'ht' ? HT_SAMPLES : (MDX_FRAMES - 1) * MDX_HOP, hop = Math.floor(block / 2), n = Math.min(audio[0].length, SR * 30), vocals = [new Float32Array(n), new Float32Array(n)], weights = new Float32Array(n);
  for (let start = 0; start < n; start += hop) {
    const res = await timedRun(model, session, slicePad(audio, start, block)), v = res.vocals;
    for (let i = 0; i < Math.min(block, n - start, v[0].length); i++) { const w = Math.min(1, (i + 1) / hop, (block - i) / hop); vocals[0][start + i] += v[0][i] * w; vocals[1][start + i] += v[1][i] * w; weights[start + i] += w; }
    if (start + block >= n) break;
  }
  for (let i = 0; i < n; i++) { vocals[0][i] /= weights[i] || 1; vocals[1][i] /= weights[i] || 1; }
  const instrumental = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) instrumental[c][i] = audio[c][i] - vocals[c][i];
  wavWrite(path.join(outDir, 'vocals.wav'), vocals); wavWrite(path.join(outDir, 'instrumental.wav'), instrumental);
}

async function main() {
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  const wavs = fs.readdirSync(INPUT_DIR).filter(f => f.toLowerCase().endsWith('.wav')).sort();
  const audio = wavs.length ? wavRead(path.join(INPUT_DIR, wavs[0])) : synthetic(9);
  const source = wavs.length ? ("user WAV " + wavs[0] + " (first 30 seconds for listening)") : 'deterministic synthetic 9-second stereo fixture; no user WAV found';
  const rows = [], notes = [];
  for (const model of MODELS) {
    if (!fs.existsSync(model.file)) { for (const ep of ['cpu', 'dml']) rows.push(failRow(model.label, 'all', ep, 'Model file missing; see bench/README.md')); continue; }
    const windows = model.kind === 'ht' ? [2, 3, 7.8] : [2, 3, (MDX_FRAMES - 1) * MDX_HOP / SR];
    for (const ep of ['cpu', 'dml']) {
      let session;
      try { session = await ort.InferenceSession.create(model.file, { executionProviders: [ep], graphOptimizationLevel: 'all', enableCpuMemArena: true, enableMemPattern: ep !== 'dml' }); }
      catch (e) { rows.push(failRow(model.label, 'all', ep, `session create failed: ${e.message || e}`)); continue; }
      for (const sec of windows) {
        if (inferenceTimedOut) { rows.push(failRow(model.label, `${sec}s`, ep, 'skipped after prior inference exceeded the 30 s hard timeout')); continue; }
        if (model.kind === 'ht' && sec !== 7.8) { rows.push(failRow(model.label, `${sec}s`, ep, `fixed input mix [1,2,343980] = ${HT_SEC.toFixed(2)} s; this window cannot run`)); continue; }
        // benchmark shape is always the graph's native segment; named short windows expose the fixed-shape limit.
        const result = await measure(model, sec, ep, slicePad(audio, 0, model.kind === 'ht' ? HT_SAMPLES : Math.ceil(sec * SR)), session);
        rows.push(result);
        if (inferenceTimedOut) break;
      }
      if (inferenceTimedOut) { notes.push(`${model.label} ${ep.toUpperCase()}: timed out; remaining benchmarks and listening outputs skipped`); break; }
      if (wavs.length && session) {
        try { await separateFile(model, session, audio, path.join(OUT_DIR, model.id)); notes.push(`${model.label}: wrote vocals.wav and instrumental.wav`); }
        catch (e) { notes.push(`${model.label}: output failed: ${e.message || e}`); }
      }
      if (session && !inferenceTimedOut) await session.release();
    }
    if (inferenceTimedOut) break;
  }
  if (inferenceTimedOut) {
    for (const model of MODELS) {
      const windows = model.kind === 'ht' ? [2, 3, 7.8] : [2, 3, (MDX_FRAMES - 1) * MDX_HOP / SR];
      for (const ep of ['cpu', 'dml']) for (const sec of windows) {
        if (!rows.some(r => r.model === model.label && r.ep === ep && String(r.sec) === `${sec}s`)) rows.push(failRow(model.label, `${sec}s`, ep, 'not attempted after another inference exceeded the 30 s hard timeout'));
      }
    }
  }
  const table = rows.map(x => x.error
    ? `| ${x.model} | ${x.sec} | ${x.ep.toUpperCase()} | — | — | — | ERROR: ${x.error} |`
    : `| ${x.model} | ${x.sec}s | ${x.ep.toUpperCase()} | ${x.avg.toFixed(2)} / ${x.p95.toFixed(2)} | ${x.rtf.toFixed(4)} | ${x.first.toFixed(2)} | OK; RSS ${x.rssBefore.toFixed(0)}→${x.rssAfter.toFixed(0)} MiB${x.gpuBefore == null ? '' : `; system GPU memory ${x.gpuBefore}→${x.gpuAfter ?? 'n/a'} MiB`} |`);
  const text = ['# Strong stem separation model benchmark', '', `Generated: ${new Date().toISOString()}`, '', `Input: ${source}. Timings include model-required preprocessing and reconstruction; first inference is reported separately, mean/p95 over ${RUNS} post-warmup repeats. RTF = mean total milliseconds / nominal audio window milliseconds. GPU memory is whole-device nvidia-smi usage, not process-attributed VRAM.`, '', '| Model | Window | EP | mean / p95 ms | RTF | First ms | Notes / status |', '|---|---:|---|---:|---:|---:|---|', ...table, '', '## Notes', '', `- HT-Demucs ONNX has a static 343,980-sample (7.8 s) input. 2 s and 3 s rows record the fixed-shape limitation, not a padded inference result.`, `- MDX Kim Vocal 2 uses fixed [1,4,3072,256] spectrogram blocks; the supplied host path computes 7680-point STFT and inverse STFT in JS. Its native block spans ${((MDX_FRAMES - 1) * MDX_HOP / SR).toFixed(2)}s.`, `- Listening outputs: ${wavs.length ? notes.join('; ') : 'not generated because bench/input contains no WAV file'}`, '- Stems for HT-Demucs use output stem index 3 (vocals); instrumental is mixture minus vocals. MDX output is used as the vocal estimate and instrumental is mixture minus vocals.', '- GPU memory figures are system-wide and include unrelated processes.', ''].join('\n');
  fs.writeFileSync(path.join(__dirname, 'results-strong.md'), text, 'utf8');
  console.log(text);
  if (inferenceTimedOut) process.exit(0);
}
if (process.env.STRONG_BENCH_CHILD === '1') {
  main().catch(e => { console.error(e); process.exitCode = 1; });
} else {
  const child = spawn(process.execPath, [__filename], { env: { ...process.env, STRONG_BENCH_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', done = false;
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => {
    if (done) return;
    child.kill('SIGKILL');
    const rows = [];
    for (const model of MODELS) {
      const windows = model.kind === 'ht' ? [2, 3, 7.8] : [2, 3, (MDX_FRAMES - 1) * MDX_HOP / SR];
      for (const sec of windows) for (const ep of ['cpu', 'dml']) {
        const error = model.kind === 'ht' && sec !== 7.8
          ? 'fixed input mix [1,2,343980] (7.8 s); short window cannot run'
          : 'NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded';
        rows.push(`| ${model.label} | ${sec}s | ${ep.toUpperCase()} | — | — | — | ${error} |`);
      }
    }
    const report = ['# Strong stem separation model benchmark', '', `Generated: ${new Date().toISOString()}`, '', 'Input WAV was present. The benchmark process exceeded its 60 s wall-clock limit before it could write measured results; no timing values are fabricated. Listening outputs were not completed.', '', '| Model | Window | EP | mean / p95 ms | RTF | First ms | Notes / status |', '|---|---:|---|---:|---:|---:|---|', ...rows, '', 'The model graph was still running at the wall-clock cutoff. The separately observed HT-Demucs fp16 DirectML run was manually stopped after more than two minutes with no completed inference measurement. The model uses a fixed 7.8 s segment, so it cannot meet the requested ~2 s processing window without a different architecture.', ''].join('\n');
    fs.writeFileSync(path.join(__dirname, 'results-strong.md'), report, 'utf8');
    console.log(report);
    done = true;
  }, 60000);
  child.on('close', code => { clearTimeout(timer); done = true; if (stdout) process.stdout.write(stdout); if (stderr) process.stderr.write(stderr); if (code !== 0) process.exitCode = code; });
}
