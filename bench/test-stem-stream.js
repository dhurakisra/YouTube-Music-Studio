'use strict';

// Exercises the real stem utility process with paced synthetic PCM.
const path = require('node:path');
const { app, MessageChannelMain, utilityProcess } = require('electron');

const SR = 44100;
const STEM_PROCESS = path.join(__dirname, '..', 'src', 'stem-process.js');
const SECONDS = Math.max(1, Number(process.argv.find((arg) => arg.startsWith('--seconds='))?.slice(10)) || 90);
const requestedModel = process.argv.find((arg) => arg.startsWith('--model='))?.slice(8);
const MODELS = requestedModel
  ? [requestedModel]
  : ['umx-hq', 'htdemucs'];
const AVAILABLE_MODELS = new Set(['umx-hq', 'htdemucs']);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function runModel(model) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(STEM_PROCESS, [`--model=${model}`], { serviceName: `Stem stream test ${model}` });
    const { port1, port2 } = new MessageChannelMain();
    const processing = [], queues = [];
    let latestMetrics = {}, portReady = false, frameOffset = 0, timer, stopped = false;
    const stopTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const finish = (error) => {
      if (stopped) return;
      stopped = true; stopTimer();
      try { port1.close(); } catch {}
      if (error) { try { child.kill(); } catch {} reject(error); return; }
      const result = {
        model, seconds: SECONDS, windows: processing.length,
        processingAvgMs: Number((processing.reduce((sum, value) => sum + value, 0) / (processing.length || 1)).toFixed(3)),
        processingP95Ms: Number(percentile(processing, 0.95).toFixed(3)),
        queueAvgMs: Number((queues.reduce((sum, value) => sum + value, 0) / (queues.length || 1)).toFixed(3)),
        queueP95Ms: Number(percentile(queues, 0.95).toFixed(3)),
        droppedWindows: latestMetrics.droppedWindows ?? 0,
        droppedInputBlocks: latestMetrics.droppedInputBlocks ?? 0,
      };
      console.log(JSON.stringify(result));
      resolve(result);
    };
    child.on('message', (message) => {
      if (message?.type === 'stem:window') {
        processing.push(Number(message.window?.processingMs) || 0);
        queues.push(Number(message.window?.queueLatencyMs) || 0);
        latestMetrics = { ...latestMetrics, droppedWindows: message.window?.droppedWindows, droppedInputBlocks: message.window?.droppedInputBlocks };
      }
      if (message?.type === 'stem:started') {
        try { child.postMessage({ type: 'stem:port' }, [port2]); } catch (error) { finish(error); }
      }
      if (message?.type === 'stem:error') finish(new Error(message.error || `Stem process failed for ${model}`));
      if (message?.type === 'stem:metrics') latestMetrics = message.metrics || {};
      if (message?.type === 'stem:stopped') finish();
    });
    child.on('exit', (code) => { if (!stopped) finish(new Error(`Stem process exited early with code ${code}`)); });
    child.on('error', (_type, location, report) => finish(new Error(`${location || ''} ${report || ''}`)));
    port1.on('message', (event) => {
      const message = event.data;
      if (message?.type === 'stem:ready' && !portReady) {
        portReady = true;
        if (message.model !== model) { finish(new Error(`Expected ${model} but process selected ${message.model}`)); return; }
        feed();
      }
    });
    port1.start();

    function feed() {
      if (stopped) return;
      if (frameOffset >= SR * SECONDS) {
        port1.postMessage({ type: 'pcm:stop' });
        return;
      }
      const frames = Math.min(SR / 10, SR * SECONDS - frameOffset);
      const pcm = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i += 1) {
        const t = (frameOffset + i) / SR;
        pcm[2 * i] = 0.21 * Math.sin(2 * Math.PI * 220 * t) + 0.06 * Math.sin(2 * Math.PI * 440 * t);
        pcm[2 * i + 1] = 0.19 * Math.sin(2 * Math.PI * 220 * t + 0.13) + 0.05 * Math.sin(2 * Math.PI * 330 * t);
      }
      const data = pcm.buffer;
      port1.postMessage({ type: 'pcm:block', sequence: frameOffset / frames + 1, sampleRate: SR, channels: 2, frames, timestampEpochMs: Date.now(), data });
      frameOffset += frames;
      timer = setTimeout(feed, 100);
    }
  });
}

app.whenReady().then(async () => {
  try {
    if (MODELS.some((model) => !AVAILABLE_MODELS.has(model))) throw new Error(`Unsupported stream test profile: ${MODELS.find((model) => !AVAILABLE_MODELS.has(model))}`);
    const results = [];
    for (const model of MODELS) results.push(await runModel(model));
    const failed = results.find((item) => item.droppedWindows > 0 || item.droppedInputBlocks > 0 || !item.windows);
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
