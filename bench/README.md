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

## Stronger model candidates (Phase 1b S1b)

`node bench/run-strong.js` benchmarks two publicly downloadable ONNX candidates alongside the original UMX-HQ benchmark. Model files are local under `models/` and ignored by Git; download them once with the URLs below. No Python export/runtime is needed.

| Candidate | Public ONNX / license and provenance | Input contract / limitation |
|---|---|---|
| HT-Demucs fp16 | [StemSplitio/htdemucs-onnx](https://huggingface.co/StemSplitio/htdemucs-onnx), [direct ONNX](https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx); MIT export and upstream HT-Demucs weights; SHA-256 `d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a`. | `mix` float32 `[1,2,343980]` (stereo 44.1 kHz, fixed 7.8 s), `stems` `[1,4,2,343980]`, order drums/bass/other/vocals. STFT/iSTFT embedded in graph. It cannot run a true 2 s or 3 s input; use overlapping 7.8 s segments for longer streams. This is fp16 weights in an fp32 graph, not the fine-tuned HTDemucs-Ft bag. |
| MDX-Net Kim Vocal 2 | [Tellcue public ONNX model card](https://huggingface.co/archgod94/tellcue-models), [direct ONNX](https://huggingface.co/archgod94/tellcue-models/resolve/main/mdx-kim-vocal-2.onnx); MDX Kim Vocal 2 by KimberleyJSN, distributed with the MIT-licensed UVR project; the card says the weights have no separate license and cites UVR's MIT status, so confirm weight terms before redistribution. ONNX SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`. | `input` / `output` float32 `[1,4,3072,256]`; 44.1 kHz stereo complex STFT planes, n_fft 7680, hop 1024, fixed 256 frames (~5.92 s). `run-strong.js` includes JS STFT/iSTFT around the graph. Short incoming windows are edge-padded to the graph's fixed block; reported end-to-end time includes feature extraction and reconstruction. |

Download commands (run from repository root):

```powershell
curl.exe -L --fail -o models/htdemucs_fp16.onnx https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx
curl.exe -L --fail -o models/mdx-kim-vocal-2.onnx https://huggingface.co/archgod94/tellcue-models/resolve/main/mdx-kim-vocal-2.onnx
```

For listening output, place a PCM16/24/32 or float32 mono/stereo WAV in `bench/input/`. The script reads the first WAV (resamples linearly to 44.1 kHz if needed), processes at most its first 30 seconds, and writes `vocals.wav` and `instrumental.wav` to each model's `bench/out/<model>/` directory. `bench/input/` and `bench/out/` are ignored by Git. If there is no WAV, it benchmarks a deterministic synthetic signal and does not create listening stems. A 60-second parent-process limit bounds the run; if native inference does not complete, the results file records the timeout and missing measurements instead of hanging or inventing timings.
