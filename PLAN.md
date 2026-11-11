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

## Durum / devir notu (2026-11-11, sohbet 1 sonu)
Biten (master): T1+T2 iskelet/Method B olcer; POC_PARTITION env; preload senderFrame hata duzeltmesi.
Bulgu: AudioWorklet blob: yuklemesi YTM sayfasinda BASARISIZ ("Failed to load worklet module script blob:https://music.youtube.com/...").
  Kullanici onayi: AudioWorklet yerine AnalyserNode+ScriptProcessorNode yedegi (plandan sapma, raporda yaz).
Acik isciler (Codex, bildirim yeni sohbete gelmeyebilir -> `orca orchestration worker-list` ile sahiplen):
  - T2b dispatch ctx_d9301ede36a7, worktree .../t2b-csp-fallback (CSP tani + data: denemesi + ScriptProcessor yedegi + dugme hata metni)
  - T4  dispatch ctx_a97ed4baae0c, worktree .../t4-method-a (Method A, ayri giris src/main-a.js, npm run start:a)
  Worktree kok: C:/Users/dtbur/orca/workspaces/YTM-Audio-POC/ ; branch'ler dhurakisra/<ad>; master'a `git merge --ff-only` ile al, sonra `npm install`.
Sonraki adimlar: 1) iki isciyi incele (node --check, smoke, diff), master'a birlestir. 2) KULLANICI DURAGI: npm start (girisli profil persist:ytm-poc,
  kullanici zaten giris yapti) -> parca cal -> Start capture -> logs/ oku (CSP satiri, RMS, sampleRate, kanal, fallback). Sonra girissiz:
  POC_PARTITION=persist:ytm-nologin npm start. >=10 parca, DRM/sessizlik kontrolu. 3) T3 (gain+lowpass+bypass+rampa+limiter+sessizlik korumasi+metrics CSV) Codex.
  4) Method A testi (npm run start:a), orijinal ses bastirma olcumu. 5) Test A-F, 30 dk stabilite, docs/phase-0a-results.md (Claude yazar), PASS/CONDITIONAL/FAIL.
Bilinen tuzaklar: Google girisi reddedilirse atlatma YOK; UA degistirme yok; SharedArrayBuffer yok; 3. mimari yok; kullanici onayi olmadan sapma yok.
Kullanici tercihleri: Turkce, kodlamayi Codex yapar, Claude kontrolcu; token ekonomisi icin faz sonunda yeni sohbet + PLAN.md devri.
Yeni sohbet baslangic mesaji: "ajan-ekibi: C:\Projects\YTM-Audio-POC\PLAN.md icindeki devir notundan devam et."
