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
- `stem:block` 4-stem (htdemucs): `instrumental` YOK; bunun yerine ayri `drums`, `bass`, `other`, `vocal` (her biri interleaved Float32, frames*2). `umx-hq` icin `vocal` + `instrumental` aynen kalir. Preload mevcut katmanlari ada gore calar (Vocal/Instr. veya Vocal/Drums/Bass/Other kaydiricilari, modele gore gorunur).

## Studio cekmecesi steampunk deri (sohbet 17) — referans: design/ref/studio-panel-ref.jpg (4344x1448)
Zemin: `design/tex/sk-studio.jpg` (referansin temizlenmis hali: degisken yazilar, EQ ekraninin ici, mikser ici ve vocal chain sirasi bos plaka). Uretim betikleri: `design/tools/studio_*.py`.
Cekmece: tam genislik, `aspect-ratio: 3/1`, yukseklik `min(100vw/3, 84vh)`; 84vh sinirinda panel ortalanir, yanlar mevcut metal/zemin ile dolar. Icerik bir kap (`.skin`, `container-type: inline-size`) icinde; HER konum/boyut referans pikselinden yuzdeye: `left = x/4344*100%`, `top = y/1448*100%`; yazi boyutu `cqw` ile (ref px * 100/4344 cqw). Asagidaki dikdortgenler (x0,y0,x1,y1) ref pikselidir.

### Sprite'lar (design/tex, `T('...')`)
| Dosya | Kullanim | border-image dilimi (L/R ya da T/B, ref px) |
|---|---|---|
| sk-st-cream-big.png | buyuk krem buton (LISTEN, LISTEN WITH STEMS, KARAOKE, START KARAOKE) | 30 / 26 yatay, orta esnek |
| sk-st-cream.png | krem buton (FLAT, BASS BOOST, VOCAL, SAVE, DEL, RESET, ADVANCED, mikser kanal adi, MIC, ANALOG/VINYL/TAPE, EXPORT, REC plakasi) | 30 / 30 |
| sk-st-amber.png | yanan (aktif/.on) buton: EQ ON, ENHANCER, LIMITER, CHAIN ON, AUTO-TUNE, MIC + FX acik | 28 / 28 |
| sk-st-solo.png / sk-st-red.png | SOLO / MUTE (MUTE kirmizi; aktif degilse koyulastir) | 9 / 9 |
| sk-st-select.png | tum `select.sel` (ok sagdaki dilimde) | 20 / 62 |
| sk-st-input.png | metin kutusu (Preset name, MIC SHIFT) | 18 / 18 |
| sk-st-valbox.png | KEY / TEMPO deger kutusu | 15 / 15 |
| sk-st-minus.png / sk-st-plus.png | - / + kucuk butonlar (ikonlu, oldugu gibi) | — |
| sk-st-led-on.png / sk-st-led-off.png | modul LED'i (`.modled`) | — |
| sk-st-reddot.png | KARAOKE / REC kirmizi nokta | — |
| sk-st-k{cream,red,dark,master}-base.png + -cap.png | knob: base sabit, cap `rotate(var(--a))` doner (cap'in gostergesi yukari bakiyor). cream = varsayilan, red = `.red`, dark = Output THRESH, master = `.big` | — |
| sk-st-fslot.png | fader yuvasi (dikey) | T 22 / B 22, orta esnek; parlak seviye cizgisi CSS ile |
| sk-st-fcap.png / sk-st-fcap-red.png | fader kapagi (`.cap`, `.cap.red`) | — |
| sk-st-vu-l.png / sk-st-vu-r.png | ibresiz VU kadrani; ibre canli cizilir, pivot ~ (genislik %50, yukseklik %95) | — |
| sk-st-mod.png | vocal chain modul plakasi (202x388; ust bantta bos baslik plakasi) | L 50 / R 40 / T 82 / B 44, `fill` |

### Ust sira yuvalari (referanstaki yerde, sabit)
- SESSION: LISTEN 108,178,465,250 · LISTEN WITH STEMS 108,285,465,358 · KARAOKE 108,392,465,467 · ADVANCED 158,508,408,568 (gelismis secenekler bu panelin uzerine acilir katman olarak)
- KEY & TEMPO: KEY - 652,178,698,230 · deger 702,175,795,235 · + 802,178,848,230 · TEMPO - 652,265,698,316 · deger 702,262,795,322 · + 802,265,848,316 · RESET 538,343,640,388 · bilgi yazisi 555,410,822,452
- MIXER ici: 903,166,1420,776 (baslik plakasi zeminde). Seritler canli, kanal sayisi degisken (3–5+): yatayda esit dagit; 3 kanalda referanstaki yerler: SOLO/MUTE y 176–224, yuva y 244–628, ad butonu y 640–692, MIC + FX 1252,718,1404,765; EXPORT ve MIC SHIFT (mixview) bu alanin altinda/icinde sigacak sekilde.
- EQUALIZER: canvas 1574,178,2598,478 (grid, olcek, egri, spektrum canvas ciziyor; zemin koyu) · EQ ON 1572,506,1806,566 · FLAT 1833,508,2063,568 · BASS BOOST 2092,508,2325,568 · VOCAL 2355,508,2590,568 · preset select 1572,592,1935,650 · ad kutusu 1962,592,2355,650 · SAVE 2380,592,2490,648 · DEL 2510,592,2598,648 · bant bilgisi 1580,668,2005,708 · Q yazisi 2232,672 · Q surgusu 2280,665,2580,710
- ENHANCER: knob merkezleri (yaricap ~46): DRIVE 2832,210 · WARMTH 2961,210 · AIR 3088,210 · WIDTH(red) 3213,210; etiketler y 270–305 · ENHANCER butonu 2778,333,3262,393 · ANALOG 2780,420,2930,480 · VINYL 2950,420,3097,480 · TAPE 3117,420,3262,480. Gercek Enhancer kontrolleri farkliysa ayni satir/kolon izgarasina yerlestir.
- OUTPUT: VU L 3368,172,3648,365 · VU R 3675,172,3952,365 · MASTER knob merkez 3547,470 yaricap 104 · THRESH knob 3780,469 yaricap 46 · etiketler zeminde (MASTER/THRESH) · LIMITER 3553,655,3743,715
- VOCAL CHAIN basligi zeminde; preset select 973,845,1357,895; aciklama yazisi 1390,852,2320,902 (canli, cqw).
- Durum seridi (canli yazilar, zemindeki plakalarin icinde): MODEL 180,1374,445,1410 · CAPTURE 1968,1376,2182,1412 (yanindaki iki lamba zeminde) · UNDERRUNS 3488,1378,3712,1410 · saat 4035,1378,4198,1414

### Vocal chain sirasi: 108,914,4042,1312
14 modul (INPUT, AUTO-TUNE, GATE, LOW CUT, EQ, COMP, DE-ESS, PRESENCE, SATURATION, DOUBLER, HARMONIZER, REVERB, DELAY, OUTPUT) `sk-st-mod.png` plakasiyla, flex ile soldan saga, aralarda ~1% bosluk; genislik knob sayisina gore (1 knob ~ 200 ref px, 2 knob ~ 280, INPUT/AUTO-TUNE ~ 370). Baslik canli yazi baslik plakasinin icinde, LED sagda. Zincir HER modda gorunur; zincirin calismadigi modda tum sira sonuk (opacity/filtre) ve `pointer-events: none`.
Yazi tipi/rengi: referanstaki gibi krem (#e9d6a8 civari) Barlow Condensed 600 / Oswald, kucuk golge.
