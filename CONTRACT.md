# CONTRACT (yalnız koordinatör değiştirir; işçi değişiklik gerekirse `ask` eder)
- Electron: 45.3.0 sabit (caret yok). Node >= 24.
- Dosya sahipliği: src/main.js (ana süreç), src/preload.js (köprü), src/capture-b.js, src/capture-a.*, src/audio-graph.js, src/worklet.js, src/metrics.js.
- Preload köprüsü (contextBridge, allowlist): `poc.log(level,msg,data)`, `poc.onCommand(cb)`; kanallar yalnız `poc:log`, `poc:command`, `poc:metrics`.
- Her IPC'de sender origin/frame doğrulaması (https://music.youtube.com veya yerel dosya).
- Loglar: logs/*.jsonl (git'e girmez). Token/cookie/şifre ASLA loglanmaz.
- Session profili: Electron userData altında `persist:ytm-poc`, repo dışı.
- Örnek log alanları: {t, event, sampleRate, channels, rms, nonzero, state}.
- Yasak: loopback/'loopback' ses kaynağı, sanal kablo, UA değiştirme, güvenlik ayarı kapatma (webSecurity, nodeIntegration).
