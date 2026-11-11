# Strong stem separation model benchmark

Generated: 2026-11-11T18:25:10.005Z

Input WAV was present. The benchmark process exceeded its 60 s wall-clock limit before it could write measured results; no timing values are fabricated. Listening outputs were not completed.

| Model | Window | EP | mean / p95 ms | RTF | First ms | Notes / status |
|---|---:|---|---:|---:|---:|---|
| HT-Demucs fp16 | 2s | CPU | — | — | — | fixed input mix [1,2,343980] (7.8 s); short window cannot run |
| HT-Demucs fp16 | 2s | DML | — | — | — | fixed input mix [1,2,343980] (7.8 s); short window cannot run |
| HT-Demucs fp16 | 3s | CPU | — | — | — | fixed input mix [1,2,343980] (7.8 s); short window cannot run |
| HT-Demucs fp16 | 3s | DML | — | — | — | fixed input mix [1,2,343980] (7.8 s); short window cannot run |
| HT-Demucs fp16 | 7.8s | CPU | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |
| HT-Demucs fp16 | 7.8s | DML | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |
| MDX Kim Vocal 2 | 2s | CPU | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |
| MDX Kim Vocal 2 | 2s | DML | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |
| MDX Kim Vocal 2 | 3s | CPU | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |
| MDX Kim Vocal 2 | 3s | DML | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |
| MDX Kim Vocal 2 | 5.921088435374149s | CPU | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |
| MDX Kim Vocal 2 | 5.921088435374149s | DML | — | — | — | NOT COMPLETED: benchmark process exceeded the 60 s wall-clock limit; no latency result recorded |

The model graph was still running at the wall-clock cutoff. The separately observed HT-Demucs fp16 DirectML run was manually stopped after more than two minutes with no completed inference measurement. The model uses a fixed 7.8 s segment, so it cannot meet the requested ~2 s processing window without a different architecture.

## Production utility process stream run

Both runs fed paced synthetic stereo PCM through the actual `src/stem-process.js` utility process for 90 seconds. Timings are total per-window processing, including host preprocessing and stem reconstruction.

| Model | Windows | Mean / p95 ms | Queue mean / p95 ms | Dropped windows / input blocks |
|---|---:|---:|---:|---:|
| UMX-HQ | 89 | 75.364 / 88.828 | 0.034 / 0 | 0 / 0 |
| HT-Demucs fp16 CPU | 22 | 1,063.973 / 1,170.105 | 0.045 / 0 | 0 / 0 |

## MDX Kim CPU profile qualification

The dedicated CPU-only run-strong-style check completed preprocessing, inference, and reconstruction in 2,578.483 ms for a 261,120-frame window (5,921.088 ms). The production utility process measured 3,041.027 ms and 3,099.192 ms on two real windows; both exceed the contract cutoff of 2,960.544 ms (50% of the audio window). Therefore `mdx-kim` is not enabled as a runtime profile. Its model uses the `input` tensor; DirectML was not used.
