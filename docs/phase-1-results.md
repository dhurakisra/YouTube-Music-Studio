# Phase 1 / 1b — Stem ayristirma PoC (nihai rapor)

Karar: **PASS (kullanici onayli, 2026-11-11)** — HT-Demucs 4 stem canli dinlemede "muthis" bulundu. Acik kalem: 10 dk temiz-yakalama stabilite olcumu.

## Mimari
YTM preload (YTM CSP AudioWorklet'i engelledigi icin ScriptProcessor DEGIL, `MediaStreamTrackProcessor` ile PCM yakalama) -> MessagePort (kopyalanarak) -> bridge renderer -> utility process (onnxruntime-node, CPU) -> pencere (HT-Demucs 7.8 sn, UMX-HQ 2 sn), %50 ortusme -> preload'da Hann overlap-add -> katman basina Web Audio zamanlama -> stem kazanclari -> limiter.

## Modeller
| Model | Pencere | Islem | Gecikme | Kalite | Stem |
|---|---|---|---|---|---|
| UMX-HQ | 2 sn | ~70 ms | ~2.5 sn | yetersiz (vokal sizintisi) | vokal + instrumental |
| HT-Demucs (fp16, CPU) | 7.8 sn (sabit, model girisi) | ~0.9-1.1 sn | ~9-10 sn | cok iyi | drums, bass, other, vocal |
- Model secici: UI + `poc:stem-model` IPC (yalniz capture kapaliyken).
- MDX-Kim: CPU ~3.0 sn > 2.96 sn esigi, devre disi. DirectML HT-Demucs'ta 3 dk+ surdu, CPU kullanilir.
- Gecikme = pencere + islem + jitter tamponu. Pencere model tarafindan sabit; ayarlanabilen tek parca tampon (Buffer kaydiricisi, 0.3-3 sn, varsayilan 1.0). Hizli islemci yalniz islem suresini kisaltir (~0.7 sn kazanc).

## Ozellikler
4 stem kaydiricisi (HT-Demucs) / 2 (UMX), her birinde Solo ve Mute (karsilikli dislayan), ayarlanabilir buffer, -3 dB headroom + limiter.

## Cit sorunu — kok neden
Kullanici dinlemesinde rastgele, degisik siddette citlar vardi. Elenenler: underrun (0-4), klip (peak <= 0.30), ayirici ciktisi (passthrough testinde de vardi), ORT thread cekismesi (sinirlamak kotulestirdi, geri alindi), parca birlesimi. Kok neden: ana is parcacigindaki `ScriptProcessor` yakalama, is parcacigi mesgulken giris bloklarini sessizce dusuruyor (sira numarasi bunu gostermiyordu). Cozum: `MediaStreamTrackProcessor` (kareleri kuyruga alir). Sonuc: cit tamamen gitti (kullanici dogruladi).

## Dersler / tuzaklar
1. MessagePortMain, renderer'dan TRANSFER edilen ArrayBuffer'i null verir -> kopyala.
2. Log allowlist'leri (main.js ALLOWED_EVENTS + safeData, preload allowedLogEvents) yeni olay/alani SESSIZCE eler; bu yuzden `stem_jump` "bulgusu" bir sure yanlis (sifir) gorundu.
3. Capture acikken Stems'e gecince sarki ~gecikme kadar geri sicrar (canli yol -> gecikmeli yol; beklenen).
4. Tani amacli `passthrough` modeli ve `stem_jump`/`peak`/`handleMs` loglari kodda duruyor.

## Acik
- 10 dk stabilite (underruns, bellek/CPU metrics CSV) temiz yakalamayla olculmedi.
- seek/pause davranisi ve gecis UX'i test edilmedi.
- Tani kodu (passthrough, jump dedektoru) sadelestirilebilir.
