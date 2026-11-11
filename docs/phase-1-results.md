# Phase 1 — Stem ayristirma PoC (ara rapor)

Karar: **CONDITIONAL PASS (mimari/gecikme), kalite YETERSIZ** — nihai karar kullanici onayina bagli.

## Kanit
- Yol: YTM preload (PCM, kopyalanarak) -> MessagePort -> bridge renderer -> utility process (onnxruntime-node CPU, UMX-HQ vokal) -> 2 sn pencere, %50 ortusme -> Hann overlap-add -> Web Audio zamanlama.
- Islem: 109 pencere, dropped=0, STFT+cikarim+iSTFT ort 71.4 ms / p95 79.6 ms (2 sn pencere), kuyruk 0 ms.
- Bench (yalniz cikarim): CPU RTF ~0.003; DirectML 3-4 sn pencerede CPU'dan yavas (bench/results.md).
- Beklenen gecikme ~2.4-2.6 sn (2 sn pencere + ~93 ms yakalama + islem + 0.3 sn jitter payi). Olculen deger: stem_playout.delayEstimateMs (allowlist hatasi nedeniyle bu kosuda loglanmadi, duzeltildi).
- Kullanici dinlemesi: calisiyor; baslangicta kisa tik sesleri (muhtemelen ilk parcalardaki jitter/underrun), sonra gecti. Vokal/enstrumantal ayrimi CALISIYOR ama kalite iyi DEGIL (UMX-HQ eski/hafif model; vokal sizintisi).

## Bulgular / hatalar
1. Electron MessagePortMain, renderer'dan TRANSFER edilen ArrayBuffer iceren mesaji `null` veri olarak teslim etti -> kopyalayarak gonderme ile cozuldu.
2. S2 dogrulamasi uctan uca degildi (ayri test duzenegi); gercek akis ancak S3 sonrasi kullanici denemesiyle dogrulandi.
3. main.js safeData allowlist'i yeni log alanlarini eliyordu (duzeltildi).

## Acik
- Kalite: daha guclu model (htdemucs/MDX-Net ONNX) gerekli; 4090 icin DirectML/CUDA yolu o zaman yeniden olculmeli.
- Baslangic tikleri: underrun sayisi sonraki kosuda stem_playout.underruns ile dogrulanacak.
- Stem'lerin sadece vokal/enstrumantal (2 stem); seek/pause davranisi test edilmedi; 10 dk stabilite test edilmedi.
