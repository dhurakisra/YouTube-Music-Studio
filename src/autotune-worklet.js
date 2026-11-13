'use strict';

// Auto-tune for the karaoke microphone: YIN pitch detection on a decimated copy of the input, then a dual-tap delay-line pitch shifter.
// Mono in, mono out. Added latency is half the shifter window (~12 ms). Runs only in the hidden autotune window (the YTM page CSP blocks AudioWorklet).
const SCALES = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // chromatic
  [0, 2, 4, 5, 7, 9, 11],                 // major
  [0, 2, 3, 5, 7, 8, 10],                 // natural minor
  [0, 2, 4, 7, 9],                        // major pentatonic
  [0, 3, 5, 7, 10],                       // minor pentatonic
];

class YtmAutoTune extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.dec = Math.max(1, Math.round(sr / 12000));
    this.fsd = sr / this.dec;
    this.M = 512;           // decimated analysis length (~43 ms)
    this.W = 256;           // YIN integration window
    this.tMin = Math.max(2, Math.floor(this.fsd / 800));
    this.tMax = Math.min(this.M - this.W - 2, Math.ceil(this.fsd / 70));
    this.ring = new Float32Array(this.M); this.rpos = 0; this.acc = 0; this.accN = 0;
    this.lin = new Float32Array(this.M);
    this.cm = new Float32Array(this.tMax + 2);
    this.hist = [];
    this.N = 8192; this.mask = this.N - 1;
    this.buf = new Float32Array(this.N); this.w = 0;
    this.winLen = Math.round(0.024 * sr);
    this.phase = 0; this.ratio = 1; this.ratioT = 1; this.shift = 0;
    this.key = 0; this.scale = 1; this.speed = 0.7; this.amount = 1;
    this.statusCount = 0;
    this.port.onmessage = (e) => {
      const p = e.data || {};
      if (Number.isFinite(p.key)) this.key = ((Math.round(p.key) % 12) + 12) % 12;
      if (Number.isFinite(p.scale)) this.scale = Math.min(SCALES.length - 1, Math.max(0, Math.round(p.scale)));
      if (Number.isFinite(p.speed)) this.speed = Math.min(1, Math.max(0, p.speed));
      if (Number.isFinite(p.amount)) this.amount = Math.min(1, Math.max(0, p.amount));
    };
  }

  // Returns the fundamental in Hz, or 0 when the block is silent / unvoiced.
  detect() {
    const { M, W, tMin, tMax, lin, cm } = this;
    let e = 0;
    for (let i = 0; i < M; i += 1) e += lin[i] * lin[i];
    if (Math.sqrt(e / M) < 0.004) return 0;
    const base = M - W;
    let run = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tMax; tau += 1) {
      let s = 0;
      for (let j = 0; j < W; j += 1) { const d = lin[base + j] - lin[base + j - tau]; s += d * d; }
      run += s;
      cm[tau] = run > 0 ? (s * tau) / run : 1;
    }
    let tau = -1;
    for (let t = tMin; t <= tMax; t += 1) {
      if (cm[t] < 0.18) { while (t + 1 <= tMax && cm[t + 1] < cm[t]) t += 1; tau = t; break; }
    }
    if (tau < 0) {
      let best = tMin;
      for (let t = tMin + 1; t <= tMax; t += 1) if (cm[t] < cm[best]) best = t;
      if (cm[best] > 0.3) return 0;
      tau = best;
    }
    let t = tau;
    if (tau > 1 && tau < tMax) {
      const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c;
      if (den > 1e-9) t = tau + 0.5 * (a - c) / den;
    }
    return this.fsd / t;
  }

  targetNote(midi) {
    const mask = SCALES[this.scale];
    let best = null;
    for (let n = Math.floor(midi) - 2; n <= Math.ceil(midi) + 2; n += 1) {
      const deg = (((n - this.key) % 12) + 12) % 12;
      if (!mask.includes(deg)) continue;
      if (best === null || Math.abs(n - midi) < Math.abs(best - midi)) best = n;
    }
    return best === null ? Math.round(midi) : best;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const o = out[0];
    const len = o.length;
    const { buf, mask, winLen } = this;
    let { w, phase, ratio } = this;
    const ratioT = this.ratioT;
    for (let i = 0; i < len; i += 1) {
      const x = input ? input[i] : 0;
      buf[w] = x;
      this.acc += x; this.accN += 1;
      if (this.accN >= this.dec) { this.ring[this.rpos] = this.acc / this.accN; this.rpos = (this.rpos + 1) % this.M; this.acc = 0; this.accN = 0; }
      ratio += (ratioT - ratio) * 0.002;
      phase += (1 - ratio) / winLen;
      phase -= Math.floor(phase);
      let p2 = phase + 0.5; if (p2 >= 1) p2 -= 1;
      const s1 = Math.sin(Math.PI * phase), g1 = s1 * s1;
      const pos1 = w - (phase * winLen + 2), pos2 = w - (p2 * winLen + 2);
      const i1 = Math.floor(pos1), f1 = pos1 - i1, i2 = Math.floor(pos2), f2 = pos2 - i2;
      const y1 = buf[i1 & mask] * (1 - f1) + buf[(i1 + 1) & mask] * f1;
      const y2 = buf[i2 & mask] * (1 - f2) + buf[(i2 + 1) & mask] * f2;
      o[i] = y1 * g1 + y2 * (1 - g1);
      w = (w + 1) & mask;
    }
    this.w = w; this.phase = phase; this.ratio = ratio;
    for (let c = 1; c < out.length; c += 1) out[c].set(o);

    // One analysis per render quantum.
    for (let i = 0; i < this.M; i += 1) this.lin[i] = this.ring[(this.rpos + i) % this.M];
    const f0 = this.detect();
    const dt = len / sampleRate;
    let midi = 0, target = 0;
    if (f0 > 0) {
      const m = 69 + 12 * Math.log2(f0 / 440);
      this.hist.push(m); if (this.hist.length > 3) this.hist.shift();
      midi = [...this.hist].sort((a, b) => a - b)[this.hist.length >> 1];
      target = this.targetNote(midi);
      const desired = Math.max(-4, Math.min(4, (target - midi) * this.amount));
      const tau = this.speed >= 0.98 ? 0 : 0.4 * (1 - this.speed) * (1 - this.speed) + 0.004;
      this.shift += (desired - this.shift) * (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
    } else {
      this.hist.length = 0;
      this.shift *= Math.exp(-dt / 0.12);
    }
    this.ratioT = 2 ** (this.shift / 12);
    this.statusCount += 1;
    if (this.statusCount >= 32) { this.statusCount = 0; this.port.postMessage({ f0, midi, target, shift: this.shift }); }
    return true;
  }
}

registerProcessor('ytm-autotune', YtmAutoTune);
