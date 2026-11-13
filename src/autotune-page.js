'use strict';

// Hidden auto-tune window: mic -> AudioWorklet pitch corrector -> local WebRTC loopback -> the YTM page (which plays it into the Vocal Lab chain).
// This page has no restrictive CSP, so AudioWorklet works here. Signalling goes through the main process (preload bridge: window.autotuneIpc).
(() => {
  const ipc = window.autotuneIpc;
  let ctx = null, stream = null, node = null, pc = null, token = 0;

  async function stop() {
    token += 1;
    try { pc?.close(); } catch {}
    try { node?.disconnect(); } catch {}
    for (const t of stream?.getTracks() || []) { try { t.stop(); } catch {} }
    try { await ctx?.close(); } catch {}
    ctx = stream = node = pc = null;
  }

  async function start(msg) {
    await stop();
    const mine = token;
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('autotune-worklet.js');
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (msg.label) { // device ids differ per origin: match the page's choice by label
      try {
        const hit = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label === msg.label && d.deviceId);
        const current = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
        if (hit && hit.deviceId !== current) {
          const next = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: hit.deviceId } } });
          for (const t of stream.getTracks()) t.stop();
          stream = next;
        }
      } catch {}
    }
    if (mine !== token) return;
    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'ytm-autotune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    node.port.postMessage(msg.params || {});
    node.port.onmessage = (e) => ipc.send({ t: 'status', ...e.data });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    source.connect(node); node.connect(dest);
    await ctx.resume();

    pc = new RTCPeerConnection({ iceServers: [] });
    const track = dest.stream.getAudioTracks()[0];
    pc.addTrack(track, dest.stream);
    pc.onicecandidate = (e) => { if (e.candidate) ipc.send({ t: 'ice', c: e.candidate.toJSON() }); };
    const offer = await pc.createOffer();
    // 10 ms Opus packets instead of the default 20 ms: less latency on the loopback.
    const sdp = String(offer.sdp).replace(/(a=fmtp:111[^\r\n]*\r\n)/, '$1a=ptime:10\r\n');
    await pc.setLocalDescription({ type: 'offer', sdp });
    ipc.send({ t: 'offer', sdp });
  }

  ipc.onMessage(async (m) => {
    try {
      if (m.t === 'start') await start(m);
      else if (m.t === 'params') node?.port.postMessage(m.params || {});
      else if (m.t === 'answer' && pc) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      else if (m.t === 'ice' && pc) await pc.addIceCandidate(m.c || null);
      else if (m.t === 'stop') await stop();
    } catch (error) {
      ipc.send({ t: 'error', error: String(error?.name || '') + ' ' + String(error?.message || error).slice(0, 160) });
    }
  });
  ipc.send({ t: 'ready' });
})();
