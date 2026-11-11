# CONTRACT (yalnız koordinatör değiştirir; işçi değişiklik gerekirse `ask` eder)
- Electron: 45.3.0 sabit (caret yok). Node >= 24.
- Dosya sahipliği: src/main.js (ana süreç), src/preload.js (köprü), src/capture-b.js, src/capture-a.*, src/audio-graph.js, src/worklet.js, src/metrics.js.
- Preload köprüsü (contextBridge, allowlist): `poc.log(level,msg,data)`, `poc.onCommand(cb)`; kanallar yalnız `poc:log`, `poc:command`, `poc:metrics`.
- Her IPC'de sender origin/frame doğrulaması (https://music.youtube.com veya yerel dosya).
- Loglar: logs/*.jsonl (git'e girmez). Token/cookie/şifre ASLA loglanmaz.
- Session profili: Electron userData altında `persist:ytm-poc`, repo dışı.
- Örnek log alanları: {t, event, sampleRate, channels, rms, nonzero, state}.
- Yasak: loopback/'loopback' ses kaynağı, sanal kablo, UA değiştirme, güvenlik ayarı kapatma (webSecurity, nodeIntegration).

## Stem modeli secimi (Phase 1b)
- Model kimlikleri (allowlist): `umx-hq` (varsayilan; 2 sn pencere), `htdemucs` (7.8 s sabit pencere, CPU), `mdx-kim` (opsiyonel; ancak CPU'da pencere suresinin ~%50'sinden hizli ise).
- Secim: YTM preload -> ana surec IPC `poc:stem-model` (yalniz string kimlik, allowlist disi reddedilir, yalniz capture KAPALIYKEN gecerli). Ana surec stem surecini `utilityProcess.fork(stem-process.js, ['--model=<id>'])` ile baslatir; stem-process `process.argv` den okur.
- Stem sureci -> preload mesaji `stem:block`: { sequence, sampleRate(44100), channels:2, frames (PENCERE uzunlugu, modele gore), vocal, instrumental (interleaved Float32, frames*2), processingMs, queueLatencyMs }. Pencereler HER ZAMAN %50 ortusur (hop = frames/2); overlap-add tuketicide (preload) yapilir. `instrumental` = vokal disindaki her sey.
- `stem:ready` mesaji ek alanlar: { model, windowFrames }.
