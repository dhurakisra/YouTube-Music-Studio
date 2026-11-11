'use strict';

// Method B is bootstrapped by preload.js in the isolated world. The media
// observer, one-time WeakSet wiring, user-gesture button, and metrics forwarding
// live there because sandboxed Electron preloads cannot load local CommonJS files.
// This module documents the capture state machine and keeps its metrics shape
// explicit for the main-process allowlist.
const CAPTURE_METRIC_FIELDS = Object.freeze(['sampleRate', 'channels', 'rms', 'nonzero', 'state']);

if (typeof module !== 'undefined') module.exports = { CAPTURE_METRIC_FIELDS };
