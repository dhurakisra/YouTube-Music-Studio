'use strict';

(() => {
  const select = document.querySelector('#variant');
  const startButton = document.querySelector('#start');
  const stopButton = document.querySelector('#stop');
  const status = document.querySelector('#status');
  let stream;
  let context;
  let source;
  let analyser;
  let animationFrame;
  let workletUrl;
  let lastMetricsAt = 0;
  let quietSince = null;

  function log(event, data = {}) {
    window.captureA.log(event, data);
  }

  function currentVariant() {
    return select.value;
  }

  select.addEventListener('change', () => {
    window.captureA.setVariant(currentVariant());
    status.textContent = currentVariant() === 'webcontents_muted'
      ? 'Muted variant selected. YTM output will be muted during capture.'
      : 'Local echo disabled variant selected.';
  });

  function measure() {
    if (!analyser || !context || context.state === 'closed') return;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    let nonzero = 0;
    for (const sample of samples) {
      sumSquares += sample * sample;
      if (sample !== 0) nonzero++;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    const now = Date.now();
    if (now - lastMetricsAt >= 1000) {
      lastMetricsAt = now;
      const trackChannels = stream?.getAudioTracks()[0]?.getSettings().channelCount;
      const channels = Number.isInteger(trackChannels) && trackChannels > 0 ? trackChannels : Math.max(1, analyser.channelCount);
      const metrics = { sampleRate: context.sampleRate, channels, rms, nonzero, variant: currentVariant(), state: 'capturing' };
      window.captureA.metrics(metrics);
      if (rms === 0) {
        if (quietSince === null) quietSince = now;
        status.textContent = `Capturing (${currentVariant()})\nRMS 0, nonzero 0${now - quietSince >= 5000 ? '\nCaptured stream has remained silent for 5+ seconds.' : ''}`;
      } else {
        quietSince = null;
        status.textContent = `Capturing (${currentVariant()})\n${context.sampleRate} Hz · ${channels} channel(s) · RMS ${rms.toFixed(5)} · ${nonzero} nonzero samples`;
      }
    }
    animationFrame = requestAnimationFrame(measure);
  }

  async function startCapture() {
    if (stream) return;
    const variant = currentVariant();
    startButton.disabled = true;
    status.textContent = `Requesting YTM tab audio (${variant})…`;
    log('capture_start_requested', { state: 'requested', variant });
    // Call getDisplayMedia directly from this click handler to retain the user gesture.
    let capturePromise;
    try {
      capturePromise = navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } catch (error) {
      startButton.disabled = false;
      status.textContent = `Capture failed: ${error?.message || error}`;
      log('capture_error', { state: 'request_failed', error: String(error?.message || error), variant });
      return;
    }
    try {
      stream = await capturePromise;
      for (const track of stream.getVideoTracks()) track.stop();
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) throw new Error('No audio track was granted');

      context = new AudioContext({ latencyHint: 'interactive' });
      await context.audioWorklet.addModule(workletUrl);
      await context.resume();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      // The control window is the only output path. The worklet is a pass-through
      // gate so all monitor output stays local to this file-origin renderer.
      const output = new AudioWorkletNode(context, 'capture-a-output', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      analyser.connect(output);
      output.connect(context.destination);
      audioTracks.forEach((track) => track.addEventListener('ended', stopCapture, { once: true }));
      stopButton.disabled = false;
      log('capture_started', { state: 'capturing', sampleRate: context.sampleRate, channels: audioTracks[0].getSettings().channelCount || 1, variant });
      measure();
    } catch (error) {
      status.textContent = `Capture failed: ${error?.message || error}`;
      log('capture_error', { state: 'setup_failed', error: String(error?.message || error), variant });
      await stopCapture();
      startButton.disabled = false;
    }
  }

  async function stopCapture() {
    const stoppedVariant = currentVariant();
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
    for (const track of stream?.getTracks() || []) track.stop();
    stream = undefined;
    source?.disconnect();
    analyser?.disconnect();
    source = undefined;
    analyser = undefined;
    if (context && context.state !== 'closed') await context.close().catch(() => {});
    context = undefined;
    window.captureA.restoreAudio();
    select.value = 'local_echo_disabled';
    startButton.disabled = false;
    stopButton.disabled = true;
    status.textContent = 'Capture stopped. YTM audio mute has been restored.';
    log('capture_stopped', { state: 'stopped', variant: stoppedVariant });
  }

  startButton.addEventListener('click', startCapture);
  stopButton.addEventListener('click', stopCapture);

  const workletSource = `class CaptureAOutput extends AudioWorkletProcessor { process(inputs, outputs) { const input = inputs[0] || []; const output = outputs[0] || []; for (let channel = 0; channel < output.length; channel++) { const source = input[channel] || input[0]; if (source) output[channel].set(source); } return true; } } registerProcessor('capture-a-output', CaptureAOutput);`;
  workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
  window.addEventListener('beforeunload', () => {
    URL.revokeObjectURL(workletUrl);
    for (const track of stream?.getTracks() || []) track.stop();
  }, { once: true });
})();
