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
T3 (gain+LPF+bypass+limiter+sessizlik korumasi+metrics CSV) master'da, kullanici dinleme testi BEKLIYOR. Acik isci yok.
Sonraki: 1) T3'u incele/birlestir, kullanici durak: dinleme testi (cit gitti mi, bypass ses farki, tek cikis). 2) Girissiz: POC_PARTITION=persist:ytm-nologin npm start, >=10 parca. 3) Method A testi: npm run start:a (orijinal ses bastirma: enableLocalEcho vs setAudioMuted; akis susuyor mu). 4) Test D (pause/seek/sarki/gorunum degisimi), E (30 dk, metrics csv), F (kurtarma). 5) docs/phase-0a-results.md (Claude), PASS/CONDITIONAL/FAIL. Raporda sapma: AudioWorklet yerine ScriptProcessor.
Tuzaklar: atlatma yok, UA degistirme yok, SharedArrayBuffer yok, 3. mimari yok, CSP header degistirme yok. Kullanici: Turkce, Codex kodlar, Claude kontrolcu, token ekonomisi icin yeni sohbet.
Yeni sohbet baslangic mesaji: "ajan-ekibi: C:\Projects\YTM-Audio-POC\PLAN.md icindeki devir notundan devam et."

## Guncelleme (sohbet 2): T3 dinleme testi GECTI (kullanici, girisli oturum, 3-4 parca)
Cit gitti; parca gecisinde takilma/kesinti yok; bypass=normal ses; LPF=bogulma; gain LPF aktifken calisiyor, bypass'ta etkisiz (beklenen); cift ses yok, tek cikis.
Sonraki: girissiz test (POC_PARTITION=persist:ytm-nologin npm start, >=10 parca) -> Method A (npm run start:a) -> Test D/E/F -> docs/phase-0a-results.md.
Girissiz test (persist:ytm-nologin, log 11:23:33): GECTI. Ilk acilista reklam, sonra 10 parcada reklam yok; ses geldi, cit yok, bypass/LPF her parcada calisti. Ilk parcada kisa bosluk = kullanici yanlislikla mute. Hata logu: 0. Sonraki: Method A (npm run start:a).
Method A (11:36 log): origin kontrolu 'file:///' kabul etmedigi icin reddediliyordu -> duzeltildi. Yakalama CALISTI (44100 Hz, rapor edilen kanal=1, rms~0.001-0.076), ~19 sn deneme. Varyant local_echo_disabled: kullanici faz iptali benzeri ses (vokalde yuksek, vokal yokken kisik) duydu => orijinal ses bastirilmadi, yakalanan kopya ustune biniyor (comb/faz). Muted varyanti HENUZ denenmedi. Pencere kapanmama: yalniz diger pencere acik kaldigi icin olabilir; iki pencerede de closed->app.quit eklendi (dogrulanmadi).
Method A muted varyant (11:39 log): ayni bozulma (vokal yuksek, vokal yokken arka plan dusuk). Orijinal susturulsa da surdugu icin ust uste binme (echo) aciklamasi ZAYIF; bozulma yakalanan sinyalde. Log: channels=1 (mono). Hipotez: A yolu mono/yanlis kanal duzeniyle geliyor (stereo->mono toplama faz iptali, arka plan/genis stereo duser). Dogrulanmadi. Method B 2 kanal, temiz. KARAR ONERISI: Method A = bu fazda basarisiz/uygun degil, B ile D/E/F'ye gec.
Hata: Method A penceresi X ile kapanmiyor (app.quit eklendi, yine kapanmadi) -> kok neden bilinmiyor; surec elle sonlandirildi.
A duzeltme denemesi (tek): getDisplayMedia audio kisitlari channelCount:2 + echoCancellation/noiseSuppression/autoGainControl kapali. Hala mono/bozuksa A kapatilir, B ile D/E/F.
A duzeltme SONUCU (log 11:44, kullanici dinledi): channels=2 (47 olcum), bozulma/faz iptali GITTI, iki varyant (local_echo_disabled, webcontents_muted) da temiz, defalarca ac-kapa sorunsuz, capture_error=0. Kok neden: getDisplayMedia ses kisitlari (channelCount:2, AGC/NS/EC kapali). A artik GECERLI aday. Acik: pencere X ile kapanmama, A'da ses isleme (gain/LPF) yok, orijinal/cift ses bastirma ayrimi (iki varyant da duyulabilir fark vermedi).

## DEVIR NOTU (sohbet 2 sonu, GUNCEL — bunu esas al)
Bitti: T3 dinleme PASS, girissiz test PASS, Method A duzeltildi ve calisiyor (ayrintilar yukarida), ara rapor docs/phase-0a-results.md yazildi. Acik isci YOK.
Karar: Method B ana aday, D/E/F B ile yapilacak. Bunlar kullanici dinleme/30 dk testi; isci ajan gerektirmez (kullanici durak).
Sonraki: 1) Test D (npm start: pause, seek, parca, YTM sayfa/gorunum degisimi; bypass/LPF acikken kesinti/cit?) 2) Test E: 30 dk calma, sonra logs/metrics-*.csv (bellek/cpu artisi, dropoutBlocks, timeGaps) incele 3) Test F: kurtarma (ag kopmasi / sayfa yenileme / capture yeniden baslatma) 4) raporu tamamla -> PASS/CONDITIONAL/FAIL. 5) Istege bagli: Method A kapanma sorunu.
Tuzaklar: UA degistirme yok, atlatma yok, SharedArrayBuffer yok, 3. mimari yok, CSP header degistirme yok. Takili electron surecini Get-CimInstance ile bulup kapat. Kullanici Turkce.
Yeni sohbet baslangic mesaji: "ajan-ekibi: C:\Projects\YTM-Audio-POC\PLAN.md icindeki DEVIR NOTU'ndan devam et."

## Guncelleme (sohbet 3): Test D PASS, Test E PASS (kullanici dinledi + metrics analizi, docs'a islendi). Kalan: Test F (ag kopmasi / sayfa yenileme / capture yeniden baslatma), sonra nihai karar. Istege bagli: Method A kapanma sorunu.

## KAPANIS (sohbet 3): Phase 0A bitti. Nihai karar CONDITIONAL PASS (docs/phase-0a-results.md). Acik isci yok. Sonraki faz kullanici karari.

## PHASE 0B (sohbet 4) — PCM'i ana is parcacigindan cikarma (kullanici onayladi)
Hedef: Method B PCM'ini MessagePort ile Worker/AudioWorklet'e (Method A kontrol penceresinde worklet calisir) tasimak; gecikme+kesinti olcmek; capture durdur/baslat eklemek. Kapsam DISI: stem ayrisirma. Tuzaklar 0A ile ayni (atlatma/UA/SAB/CSP header/3. mimari yok).
| # | Gorev | Sahip | Bagimlilik | Dosyalar | Bitti |
|---|---|---|---|---|---|
| B1 | Capture durdur/baslat (IPC allowlist, temiz yeniden baslatma) | Codex | - | src/main.js, src/preload.js, src/capture-b.js | stop/start 10x sorunsuz, log |
| B2 | PCM'i MessagePort ile ayri Worker/worklet'e tasima + gecikme/dropout olcumu (metrics CSV) | Codex | B1 | src/pcm-bridge.js, src/pcm-worker.js, src/metrics.js | log: PCM Worker'a ulasiyor, gecikme ms |
| B3 | Guvenlik incelemesi + test + docs/phase-0b-results.md | Claude | B1,B2 | docs/ | rapor |
Durak: B2 sonrasi kullanici dinleme + 10 dk stabilite. Karar: PASS/CONDITIONAL/FAIL.

B1 BITTI (f02e490): capture durdur/baslat, 10 dongu capture_error=0, diff Claude tarafindan incelendi. Sonraki: B2 (Codex).

B2 BITTI (6459d98): YTM preload Worker TrustedScriptURL ile ENGELLI; yerel gizli renderer (pcm-bridge.html) + Worker yolu calisiyor. Codex olcumu 60 sn: 660 blok, 0 kayip, gecikme ort 0.12 / p95-max 0.4 ms (NOT: gecikme postMessage->Worker; ScriptProcessor 4096 tampon ~93 ms dahil degil), besleme sapmasi 4.6 ms. Claude diff incelemesi: kritik sorun yok; notlar: (a) PCM interleave+postMessage hala ana thread'de, (b) her baslatmada bosuna 800 ms Worker denemesi. SIRADAKI: kullanici dinleme + 10 dk stabilite (npm start), sonra B3 rapor.

KAPANIS (sohbet 4): Phase 0B CONDITIONAL PASS (docs/phase-0b-results.md). Acik isci yok. Sonraki faz kullanici karari.
