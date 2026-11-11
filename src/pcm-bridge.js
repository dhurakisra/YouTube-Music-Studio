'use strict';

// The hidden local renderer owns the PCM consumer. It receives only worker
// metrics for diagnostics; audio blocks stay inside the dedicated worker.
window.pcmBridge?.onMetrics((metrics) => {
  document.body.dataset.receivedBlocks = String(metrics.receivedBlocks || 0);
  document.body.dataset.droppedBlocks = String(metrics.droppedBlocks || 0);
});
