'use strict';

const activePorts = new Set();

function consumePort(port) {
  let receivedBlocks = 0;
  let droppedBlocks = 0;
  let previousSequence = 0;
  let previousArrival = 0;
  let expectedIntervalMs = 0;
  let latencySum = 0;
  let latencyMaxMs = 0;
  let intervalDeviationSum = 0;
  let intervalSamples = 0;
  const latencySamples = [];

  function sendStats() {
    const latencySorted = [...latencySamples].sort((a, b) => a - b);
    const p95Index = latencySorted.length ? Math.ceil(latencySorted.length * 0.95) - 1 : 0;
    self.postMessage({
      type: 'pcm:stats',
      metrics: {
        receivedBlocks, droppedBlocks,
        latencyAvgMs: receivedBlocks ? Number((latencySum / receivedBlocks).toFixed(3)) : 0,
        latencyP95Ms: latencySorted.length ? Number(latencySorted[p95Index].toFixed(3)) : 0,
        latencyMaxMs: Number(latencyMaxMs.toFixed(3)),
        feedIntervalDeviationMs: intervalSamples ? Number((intervalDeviationSum / intervalSamples).toFixed(3)) : 0,
        state: 'receiving', transport: 'worker',
      },
    });
  }

  let statsTimer = setInterval(sendStats, 1000);
  port.onmessage = (event) => {
    const message = event.data;
    if (message?.type === 'pcm:stop') {
      clearInterval(statsTimer);
      sendStats();
      port.close();
      activePorts.delete(port);
      self.postMessage({ type: 'pcm:consumer-stopped' });
      return;
    }
    if (message?.type !== 'pcm:block' || !(message.data instanceof ArrayBuffer)) return;

    // Deliberately consume metadata only. Reading the buffer's size confirms
    // receipt without running any stem or audio processing code.
    const arrival = performance.timeOrigin + performance.now();
    const latencyMs = Math.max(0, arrival - message.timestampEpochMs);
    receivedBlocks += 1;
    if (previousSequence && message.sequence > previousSequence + 1) droppedBlocks += message.sequence - previousSequence - 1;
    if (previousArrival) {
      intervalDeviationSum += Math.abs((arrival - previousArrival) - expectedIntervalMs);
      intervalSamples += 1;
    }
    expectedIntervalMs = (message.frames / message.sampleRate) * 1000;
    previousArrival = arrival;
    previousSequence = message.sequence;
    latencySum += latencyMs;
    latencySamples.push(latencyMs);
    latencyMaxMs = Math.max(latencyMaxMs, latencyMs);
    void message.data.byteLength;
  };
  port.start();
  activePorts.add(port);
  self.postMessage({ type: 'pcm:consumer-ready' });
}

self.onmessage = (event) => {
  if (event.data?.type !== 'pcm:port' || event.ports.length !== 1) return;
  consumePort(event.ports[0]);
};

self.postMessage({ type: 'pcm:ready' });
