# YTM-Audio-POC — PLAN (Phase 0A)

Hedef: Electron içinde gömülü music.youtube.com sesini DAHİLİ olarak (loopback/sanal kablo YOK) PCM olarak alıp
işlenmiş sesi tek çıkıştan vermek mümkün mü? Kanıta dayalı PASS / CONDITIONAL PASS / FAIL (docs/phase-0a-results.md).
Orijinal tam spec: kullanıcının "PHASE 0A" metni (kapsam: min. pencere, kalıcı partition, yakalama, worklet, gain/LPF/bypass,
ölçüm, rapor). Kapsam DIŞI: özel UI, stem ayrıştırma, söz/karaoke, indirme, WASAPI, sanal kablo, eklenti, Chromium fork.

## Kararlar (kullanıcı onayladı)
- Electron sabit sürüm: 45.3.0 (npm latest, 2026-11-11). API'yi kodlamadan önce doküman/çalıştırmayla teyit et.
- Ana aday = Method B (preload, isolated world, createMediaElementSource + AudioWorklet). Method A (setDisplayMediaRequestHandler,
  audio: WebFrameMain, enableLocalEcho:false, gerekirse setAudioMuted varyantı) karşılaştırma için kısa ve ölçülü.
- Test sırası: önce girişsiz PCM/DRM (>=10 parça), sonra Google girişi.
- Google girişi reddedilirse: hatayı kaydet, o yolu DURDUR. User-Agent'ı değiştirme/atlatma YOK.
- SharedArrayBuffer kullanma (uzak sayfada cross-origin isolation yok); PCM taşıma = MessagePort/IPC.
- Erken risk: YouTube CSP'si worklet (blob:/data:) yüklemeyi engelleyebilir -> engellenirse DUR, kullanıcıya bildir (3. mimariye geçme).
- Sessizlik koruması: işlenmiş yolda sessizlik algılanırsa bypass.
- Üçüncü yakalama mimarisi yok; ikisi de başarısızsa FAIL raporu.

## Roller
- Claude: koordinatör, doğrulama, rapor, güvenlik incelemesi.  Codex: ana uygulayıcı.  Qwen: yok (bu fazda).
- Kullanıcı: Google girişi + dinleme testleri (durak noktaları).

## Görevler
| # | Görev | Sahip | Bağımlılık | Dosyalar | Bitti |
|---|---|---|---|---|---|
| T1 | İskelet: npm init, electron@45.3.0 sabit, ana süreç, kalıcı partition `persist:ytm-poc`, güvenlik (contextIsolation, sandbox, allowlist IPC), loglama (logs/ gitignore) | Codex | - | package.json, src/main.js, src/preload.js, .gitignore | `npm start` pencere açar, YTM yüklenir |
| T2 | Method B yakalama: media element bulma, tek seferlik createMediaElementSource, element değişimine dayanıklı, worklet yükleme (CSP testi), RMS/nonzero/örnek hızı/kanal logu | Codex | T1 | src/preload.js, src/capture-b.js, src/worklet.js | log: nonzero PCM veya net hata |
| T3 | İşleme: gain + low-pass + bypass, rampa, limiter, sessizlik koruması, tek çıkış; ölçüm (dropout, app.getAppMetrics CSV) | Codex | T2 | src/audio-graph.js, src/metrics.js | dinleme testi için hazır |
| T4 | Method A karşılaştırma (ayrı yerel renderer, setDisplayMediaRequestHandler) | Codex | T1 | src/capture-a.js, src/capture-a.html | A için ölçüm logu |
| T5 | Güvenlik incelemesi + test koşuları + docs/phase-0a-results.md | Claude | T1-T4 | docs/ | rapor |

Durak noktaları (kullanıcı): T1 sonrası Google girişi denemesi; T3 sonrası dinleme; 30 dk stabilite.

## Durum / devir notu (2026-11-11, sohbet 1 sonu, GUNCEL)
Master'da: T1+T2, T2b (CSP tani + ScriptProcessor yedegi), T4 (Method A prototipi, `npm run start:a`). Tum isci branch'leri birlestirildi.
KANITLAR (logs/): (1) YTM CSP script-src blob: VE data: worklet'i KESIN engelliyor (csp_console_message). AudioWorklet sayfada yok.
  (2) Method B yedek ile PCM GELIYOR: 44100 Hz, 2 kanal, rms~0.02-0.04, nonzero=1 (girisli oturum, 2-3 parca, DRM sessizligi gorulmedi).
  (3) Kullanici: capture aktif oldu, ama ScriptProcessor uzerinden gecen sesde ufak citlar. Log: 11:12:21-11:12:34 arasi ~13 sn sifir blok (279) -> parca gecisi/duraklatma mi, yoksa starvation mi: KULLANICI YANITI muzikte kesinti yoktu, yalniz citlar; buyuk olasilikla duraklatma/sarki degisimi sessizligi (T3 duraklatilmisken saymaz).
  (4) Girissiz test henuz yapilmadi; Google girisi kullanici yanlislikla yapti ve CALISTI (embedded giris reddedilmedi, persist:ytm-poc).
KARAR: ses yolu yalniz native Web Audio dugumleri (Gain/Biquad/Compressor); ScriptProcessor yalniz yan olcum (bufferSize 4096). Gelecekteki stem motoru icin ana-is-parcacigi PCM sorunu acik risk (Method A kontrol penceresinde AudioWorklet calisir).
Acik isci: T3 (Codex, dispatch yeni, worktree .../t3-processing): gain+LPF+bypass+rampa+limiter+sessizlik korumasi+metrics CSV. `orca orchestration worker-list` ile sahiplen.
Sonraki: 1) T3'u incele/birlestir, kullanici durak: dinleme testi (cit gitti mi, bypass ses farki, tek cikis). 2) Girissiz: POC_PARTITION=persist:ytm-nologin npm start, >=10 parca. 3) Method A testi: npm run start:a (orijinal ses bastirma: enableLocalEcho vs setAudioMuted; akis susuyor mu). 4) Test D (pause/seek/sarki/gorunum degisimi), E (30 dk, metrics csv), F (kurtarma). 5) docs/phase-0a-results.md (Claude), PASS/CONDITIONAL/FAIL. Raporda sapma: AudioWorklet yerine ScriptProcessor.
Tuzaklar: atlatma yok, UA degistirme yok, SharedArrayBuffer yok, 3. mimari yok, CSP header degistirme yok. Kullanici: Turkce, Codex kodlar, Claude kontrolcu, token ekonomisi icin yeni sohbet.
Yeni sohbet baslangic mesaji: "ajan-ekibi: C:\Projects\YTM-Audio-POC\PLAN.md icindeki devir notundan devam et."
