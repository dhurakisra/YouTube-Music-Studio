# Offline ONNX stem benchmark

This PoC benchmarks the **Open-Unmix UMX-HQ vocals** ONNX graph. It is a single-stem vocal estimator; an instrumental estimate can be formed as mixture minus estimated vocals. The model card lists a dynamic-frame input of `float32[1, 2, 2049, frames]`, 44.1 kHz stereo, 4096 point centered periodic-Hann STFT, and 1024 hop length. The graph contains the spectrogram model; STFT and reconstruction stay outside the graph.

## Model and license

- ONNX file: [`models/umx-hq-vocals.onnx`](https://huggingface.co/edgetools/umx-hq/resolve/main/vocals.onnx) (17,820,856 bytes; SHA-256 `3d05709ff7197bbd4a33aee759e4e82002acb491f41c94770227ab57507b6ccb`). It is downloaded locally and ignored by Git.
- Model card, interface, and license: [edgetools/umx-hq](https://huggingface.co/edgetools/umx-hq).
- The model card declares the exported graph and UMX-HQ weights **MIT** and attributes the published checkpoint to [Open-Unmix](https://github.com/sigsep/open-unmix-pytorch) and [Zenodo record 3370489](https://zenodo.org/records/3370489). This export contains vocals only; its model card says UMX-HQ is MIT licensed, unlike UMX-L's noncommercial license.
- ONNX Runtime Node.js is installed as a dev dependency: [official package README](https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md). On Windows the Node binding supports DirectML; its published platform matrix lists CUDA for Linux x64, so this benchmark tries CPU and DirectML (`dml`) on Windows.

## Run

```powershell
node bench/run.js
```

The script generates a deterministic 5-second synthetic PCM16 stereo WAV at `bench/synthetic.wav`, with simple tones and no copyrighted recording. It computes centered STFT features for 2, 3, and 4 second windows, then measures first inference separately from 12 repeated inferences per model/window/provider. The fixture is decoded and STFT is prepared before the timer, so reported model latency excludes audio feature preparation.

`bench/results.md` is rewritten with mean and p95 inference times, mean RTF, warmup, host process RSS, and provider failures. DML attempts to report whole-system memory via `nvidia-smi`, when installed; that number is not process-specific VRAM. ORT may place unsupported or shape-related operations on CPU even when DML is requested.
