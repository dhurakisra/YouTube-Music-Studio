'use strict';

class YtmCaptureMeter extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const channels = inputs[0] || [];
    const outputChannels = outputs[0] || [];
    const channelCount = channels.length;
    let sumSquares = 0;
    let nonzero = 0;
    let samples = 0;
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i += 1) {
        const sample = channel[i];
        sumSquares += sample * sample;
        if (sample !== 0) nonzero += 1;
        samples += 1;
      }
    }
    for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
      const output = outputChannels[channelIndex];
      const input = channels[channelIndex] || channels[0];
      if (input) output.set(input);
      else output.fill(0);
    }
    this.port.postMessage({
      rms: samples ? Math.sqrt(sumSquares / samples) : 0,
      nonzero: samples ? nonzero / samples : 0,
      channels: channelCount,
    });
    return true;
  }
}

registerProcessor('ytm-capture-meter', YtmCaptureMeter);
