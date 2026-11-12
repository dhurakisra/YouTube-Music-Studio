'use strict';

// MP3 encoder utility process: receives 16-bit stereo PCM, returns an MP3. Runs below normal priority so it never competes with live audio.
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const parentPort = process.parentPort || require('electron').parentPort;

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

parentPort.on('message', async (event) => {
  const message = event.data;
  if (message?.type !== 'encode') return;
  try {
    // @breezystack/lamejs is an ES module: it cannot be require()d.
    const lame = await import(pathToFileURL(path.join(__dirname, '..', 'node_modules', '@breezystack', 'lamejs', 'dist', 'lamejs.js')).href);
    const left = new Int16Array(message.left), right = new Int16Array(message.right);
    const encoder = new lame.Mp3Encoder(2, message.sampleRate, message.kbps || 192);
    const parts = [];
    const total = left.length;
    let lastPct = -1;
    for (let i = 0; i < total; i += 1152) {
      const block = encoder.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152));
      if (block.length) parts.push(Buffer.from(block));
      const pct = Math.floor((i / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; parentPort.postMessage({ type: 'progress', pct }); }
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(Buffer.from(tail));
    parentPort.postMessage({ type: 'done', mp3: new Uint8Array(Buffer.concat(parts)) });
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: String(error?.stack || error).slice(0, 400) });
  }
});
