# Phase 0B sonuclari — PCM'i ana is parcacigindan cikarma

**Karar: CONDITIONAL PASS.** PCM, MessagePort ile ana sureci gecmeden ayri bir Worker'a kayipsiz ve dusuk gecikmeyle tasinabiliyor. Stem motoru icin PCM uretim tarafi hala ana iş parcacigindadir (kosul 1).

## Yapilanlar
- B1 (f02e490): capture durdur/baslat. 10 dongu, capture_error=0.
- B2 (6459d98): PCM tasima. Karar yolu: gizli yerel renderer (`pcm-bridge.html`, kendi CSP'si) + Worker.
- 4e1b6df: Stop sonrasi isleme kapali (dry yol), mod/gain kontrolleri Stop'ta pasif. Kullanici dogruladi.

## Bulgular
1. YTM sayfasindan dogrudan Worker: ENGELLI (`TrustedScriptURL assignment`). Atlatma denenmedi.
2. Yerel renderer + Worker yolu calisiyor. Ana surec yalniz portu aktariyor; PCM ana sureçten gecmiyor.
3. Olcumler (loglar, kullanici oturumlari):
   - 16:55 oturumu: 446 blok, 0 kayip, gecikme ort 0.098 / p95 0.2 / max 0.6 ms, besleme sapmasi 4.4 ms.
   - 17:04 oturumu: 91 blok, 0 kayip, ort 0.179 / p95 0.4 / max 0.5 ms, sapma 4.6 ms.
   - Codex 60 sn kosusu (rapor): 660 blok, 0 kayip, ort 0.12 / p95-max 0.4 ms.
   - dropoutBlocks=0, timeGaps=0, capture_error=0.
4. Kullanici dinleme: cit/takilma yok, bypass/LPF calisiyor, Stop-Start ses bozmuyor.
5. Bellek: ilk acilis ~61 MB -> oynatma basladiktan sonra ~0.9-1.0 GB toplam (tum surecler). Kisa oturum; buyume egilimi bu fazda olculmedi (0A'daki 30 dk Test E gecmisti, bu mimariyle tekrarlanmadi).

## Kosullar / riskler
1. **PCM uretimi ana thread'de:** ScriptProcessor onaudioprocess icinde interleave + postMessage hala sayfa ana is parcacigi uzerinde. Agir sayfa yukunde kesinti riski var; AudioWorklet CSP nedeniyle yok.
2. **Gecikme kapsami:** 0.1-0.6 ms yalniz postMessage -> Worker arasi. ScriptProcessor tamponu (4096 ornek, ~93 ms) dahil degil; stem icin toplam gecikme ~93 ms + islem suresi olarak dusunulmeli.
3. **Uzun sureli stabilite:** bu fazda yalniz kisa oturumlar (kullanici karari: yeter); 30 dk + bellek egilimi yeni yolla olculmedi.
4. Her baslatmada bosuna ~800 ms Worker denemesi (kod temizligi).
5. Worker/stem tuketicisi henuz yalnizca sayiyor, PCM'i islemiyor (kapsam disi).

## Guvenlik incelemesi (Claude)
- IPC allowlist ve guvenilir ana frame kontrolleri korunmus; `poc:pcm-port` ve `poc:pcm-worker-url` yalniz music.youtube.com ana frame'inden; metrikler yalniz ana frame veya `pcm-bridge.html`.
- Bridge penceresi: sandbox, contextIsolation, nodeIntegration kapali, CSP `default-src 'self'; connect-src 'none'`. Kritik sorun yok.
- Notlar: `isTrustedBridgeSender` file URL sonunu kontrol ediyor (yol dogrulamasi sikilastirilabilir); bridge penceresi YTM preload'ini paylasiyor.
- Kural ihlali yok: UA degisikligi, atlatma, SharedArrayBuffer, CSP header degisikligi, 3. mimari yok.

## Sonraki adim onerisi (kullanici karari)
Stem/isleme motoru prototipi icin Worker'a gercek bir tuketici baglamak ve 30 dk stabilite testini bu yolla tekrarlamak.
