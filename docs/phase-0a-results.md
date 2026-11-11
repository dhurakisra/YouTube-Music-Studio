# Phase 0A sonuc raporu (ARA RAPOR, 2026-11-11)

Karar durumu: **CONDITIONAL PASS (ara)** — Test D/E/F tamamlanmadi.

## Sonuclar
| Konu | Sonuc | Kanit |
|---|---|---|
| YTM CSP, AudioWorklet (blob:/data:) | ENGELLI | logs: csp_console_message |
| Method B (preload, createMediaElementSource) + ScriptProcessor yan olcum | CALISIYOR: 44100 Hz, 2 kanal, nonzero=1 | logs/capture-*.jsonl |
| Girisli oturum, 3-4 parca | Sorunsuz, cit yok, kesinti yok | kullanici dinleme + log |
| Girissiz oturum (persist:ytm-nologin), 10 parca | Sorunsuz; yalniz ilk acilista reklam; DRM sessizligi yok; hata 0 | log 11:23:33 |
| Isleme: gain + low-pass + bypass | Calisiyor; bypass'ta normal ses, LPF bogulma, tek cikis, cift ses yok | kullanici testi |
| Method A (setDisplayMediaRequestHandler) | CALISIYOR, ancak ilk surumde mono + faz iptali; duzeltme: audio kisitlari channelCount:2, EC/NS/AGC kapali -> 2 kanal, temiz, iki varyant da | log 11:44 |
| Google girisi | Gomulu giris reddedilmedi (kullanici yanlislikla yapti, calisti) | oturum |

## Sapmalar ve acik sorunlar
- AudioWorklet yerine ScriptProcessor (CSP nedeniyle); ses yolu yalniz native Web Audio dugumleri.
- Gelecek stem motoru icin ana-is-parcacigi PCM sorunu acik risk. Method A kontrol penceresinde AudioWorklet calisabilir.
- Method A: pencere X ile kapanmiyor (kok neden bilinmiyor); iki varyant (local_echo_disabled / webcontents_muted) arasinda duyulabilir fark yok; ses isleme yok (prototip).
- Method A ilk denemede origin kontrolu 'file:///' kabul etmedigi icin reddediyordu (duzeltildi).

## Yapilmayanlar
Test D (pause/seek/parca/gorunum degisimi), E (30 dk stabilite + metrics csv), F (kurtarma). Nihai karar bunlardan sonra.

## Test D/E sonuclari (Method B, log 14:58-15:53, ~54 dk)
- Test D (pause, seek, parca, gorunum degisimi; bypass/LPF): kullanici dinledi, sorun/cit/kesinti YOK.
- Test E: yakalama 54 dk kesintisiz (44100 Hz, 2 kanal), hata olayi 0. Bellek ~861-879 MB sabit (sizinti yok), CPU %0.07-0.17.
  dropoutBlocks=2 (ikisi de 15:00:27, ilk dakikalar, sonra artmadi); timeGaps=4 (15:00 x3, 15:26, 15:42), duyulabilir etkisi yok.
  15:43:32'den sonuna rms=0: kullanici muzigi durdurmustu (beklenen sessizlik).
- Test F (kurtarma) HENUZ yapilmadi.

## Test F sonuclari (Method B, kullanici)
- Sayfa yenileme: GECTI. Ag kopmasi: GECTI.
- Capture'i yeniden baslatma: UYGULANAMADI. "Processing active" dugmesi tiklamayi islemez; kodda durdurma/yeniden baslatma islevi yok (preload.js beginCapture yalniz baslatir, stop yok). Hata degil, kapsam disi eksik ozellik. createMediaElementSource elemente tek seferlik baglandigi icin "durdur" = sayfa sesini de susturmak olurdu; kurtarma yolu sayfa yenilemedir (gecti).
