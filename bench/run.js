const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ort = require('onnxruntime-node');

const ROOT = path.resolve(__dirname, '..');
const MODEL = path.join(ROOT, 'models', 'umx-hq-vocals.onnx');
const FIXTURE = path.join(__dirname, 'synthetic.wav');
const RESULTS = path.join(__dirname, 'results.md');
const SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const HOP = 1024;
const BINS = FFT_SIZE / 2 + 1;
const WINDOW_SECONDS = [2, 3, 4];
const RUNS = 12;

function makeFixture(seconds = 5) {
  const frames = SAMPLE_RATE * seconds;
  const dataBytes = frames * 4;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22); wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const left = 0.23 * Math.sin(2 * Math.PI * 220 * t) + 0.11 * Math.sin(2 * Math.PI * 440 * t) + 0.04 * Math.sin(2 * Math.PI * 2.7 * t);
    const right = 0.20 * Math.sin(2 * Math.PI * 220 * t + 0.15) + 0.13 * Math.sin(2 * Math.PI * 330 * t) + 0.03 * Math.sin(2 * Math.PI * 3.1 * t);
    wav.writeInt16LE(Math.round(left * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(right * 32767), 46 + i * 4);
  }
  fs.writeFileSync(FIXTURE, wav);
}

function readPcm16Stereo(file) {
  const wav = fs.readFileSync(file);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Fixture is not RIFF/WAVE');
  let offset = 12, dataOffset = -1, dataBytes = 0, sampleRate = 0, channels = 0, bits = 0, format = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') { format = wav.readUInt16LE(body); channels = wav.readUInt16LE(body + 2); sampleRate = wav.readUInt32LE(body + 4); bits = wav.readUInt16LE(body + 14); }
    if (id === 'data') { dataOffset = body; dataBytes = size; break; }
    offset = body + size + (size & 1);
  }
  if (format !== 1 || channels !== 2 || bits !== 16 || sampleRate !== SAMPLE_RATE || dataOffset < 0) throw new Error('Expected 44.1kHz stereo PCM16 WAV');
  const frameCount = dataBytes / 4;
  const audio = [new Float32Array(frameCount), new Float32Array(frameCount)];
  for (let i = 0; i < frameCount; i++) {
    audio[0][i] = wav.readInt16LE(dataOffset + i * 4) / 32768;
    audio[1][i] = wav.readInt16LE(dataOffset + i * 4 + 2) / 32768;
  }
  return audio;
}

function reflect(index, length) {
  while (index < 0 || index >= length) {
    if (index < 0) index = -index;
    if (index >= length) index = 2 * length - 2 - index;
  }
  return index;
}

function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wLenR = Math.cos(angle), wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
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
}

function spectrogram(audio, seconds) {
  const length = seconds * SAMPLE_RATE;
  const frames = 1 + Math.floor(length / HOP);
  const mag = new Float32Array(2 * BINS * frames);
  const window = new Float64Array(FFT_SIZE);
  for (let n = 0; n < FFT_SIZE; n++) window[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / FFT_SIZE);
  const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE);
  for (let ch = 0; ch < 2; ch++) {
    for (let frame = 0; frame < frames; frame++) {
      const start = frame * HOP - FFT_SIZE / 2;
      for (let n = 0; n < FFT_SIZE; n++) { real[n] = audio[ch][reflect(start + n, length)] * window[n]; imag[n] = 0; }
      fft(real, imag);
      for (let bin = 0; bin < BINS; bin++) mag[(ch * BINS + bin) * frames + frame] = Math.hypot(real[bin], imag[bin]);
    }
  }
  return new ort.Tensor('float32', mag, [1, 2, BINS, frames]);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function gpuMemoryMiB() {
  try {
    return execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000 }).trim().split(/\r?\n/).map(Number).filter(Number.isFinite).join(', ');
  } catch { return null; }
}

async function main() {
  if (!fs.existsSync(MODEL)) throw new Error(`Model not found: ${MODEL}. See bench/README.md.`);
  makeFixture();
  const audio = readPcm16Stereo(FIXTURE);
  const outcomes = [];
  const details = [];
  for (const ep of ['cpu', 'dml']) {
    let session;
    try {
      session = await ort.InferenceSession.create(MODEL, {
        executionProviders: [ep], graphOptimizationLevel: 'all',
        enableCpuMemArena: true, enableMemPattern: ep !== 'dml',
      });
    } catch (error) {
      const message = String(error).replace(/`/g, "'");
      details.push(`- **${ep.toUpperCase()} session:** failed: \`${message}\``);
      outcomes.push({ ep, error: message });
      continue;
    }
    details.push(`- **${ep.toUpperCase()} session:** created; requested EP \`${ep}\`. ORT may assign unsupported/shape operators to CPU.`);
    for (const seconds of WINDOW_SECONDS) {
      const tensor = spectrogram(audio, seconds);
      const rssBefore = process.memoryUsage().rss / 1048576;
      const gpuBefore = ep === 'dml' ? gpuMemoryMiB() : null;
      try {
        let t0 = process.hrtime.bigint();
        await session.run({ mag: tensor });
        const warmupMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const times = [];
        for (let i = 0; i < RUNS; i++) {
          t0 = process.hrtime.bigint();
          await session.run({ mag: tensor });
          times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        const rssAfter = process.memoryUsage().rss / 1048576;
        const gpuAfter = ep === 'dml' ? gpuMemoryMiB() : null;
        const avg = times.reduce((sum, time) => sum + time, 0) / times.length;
        const p95 = percentile(times, 0.95);
        outcomes.push({ ep, window: seconds, warmupMs, avg, p95, rtf: avg / (seconds * 1000), rssAfter });
        details.push(`- **${ep.toUpperCase()} ${seconds}s:** warmup ${warmupMs.toFixed(2)} ms; process RSS ${rssBefore.toFixed(1)} → ${rssAfter.toFixed(1)} MiB${gpuBefore == null ? '' : `; system GPU memory ${gpuBefore} → ${gpuAfter ?? 'unavailable'} MiB`}.`);
      } catch (error) {
        const message = String(error).replace(/`/g, "'");
        outcomes.push({ ep, window: seconds, error: message });
        details.push(`- **${ep.toUpperCase()} ${seconds}s:** inference failed: \`${message}\``);
      }
    }
    await session.release();
  }

  const rows = outcomes.map(x => x.error
    ? `| UMX-HQ vocals | ${x.window ? `${x.window}s` : '—'} | ${x.ep.toUpperCase()} | — | — | — | ERROR: ${x.error.replace(/\|/g, '/')} |`
    : `| UMX-HQ vocals | ${x.window}s | ${x.ep.toUpperCase()} | ${x.avg.toFixed(2)} / ${x.p95.toFixed(2)} | ${x.rtf.toFixed(4)} | ${x.warmupMs.toFixed(2)} | OK |`);
  const rssMax = Math.max(...outcomes.filter(x => !x.error).map(x => x.rssAfter), process.memoryUsage().rss / 1048576);
  const gpuRan = outcomes.some(x => x.ep === 'dml' && !x.error && x.window);
  const memoryNote = gpuRan
    ? 'DML model inference ran. `nvidia-smi` figures, when available, are whole-system GPU memory rather than process-attributed VRAM; DML does not expose session VRAM here.'
    : 'GPU model unavailable or failed as recorded above. Host process RSS is recorded; per-process GPU memory was not available from this DML session.';
  const markdown = `# Offline stem separation benchmark results\n\nGenerated: ${new Date().toISOString()}\n\nModel: Open-Unmix UMX-HQ vocals (MIT weights and ONNX export). Fixture: deterministic synthetic stereo PCM16 WAV at 44.1 kHz, generated by this script; no copyrighted audio. Timings cover ONNX inference only after WAV decode and STFT feature preparation; p95 is nearest-rank percentile over ${RUNS} post-warmup runs. Warmup is the first inference separately, and RTF = mean inference ms / window ms.\n\n| Model | Window | EP | mean / p95 ms | mean RTF | first inference ms | Status / error |\n|---|---:|---|---:|---:|---:|---|\n${rows.join('\n')}\n\n## Warmup and memory\n\n${details.join('\n')}\n\nPeak process RSS observed after inference: **${rssMax.toFixed(1)} MiB**. ${memoryNote}\n\nInference timing excludes WAV decode, synthetic fixture generation, and STFT preprocessing. GPU memory numbers, if present, are whole-device totals. This benchmark records speed and whether the selected provider can execute the model, not separation quality.\n`;
  fs.writeFileSync(RESULTS, markdown);
  console.log(markdown);
  if (outcomes.every(x => x.error)) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
