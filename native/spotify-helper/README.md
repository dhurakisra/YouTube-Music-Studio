# spotify-helper (.NET 8)

Spotify **masaüstü** uygulamasının sesini yakalayan ve Electron'a akıtan yardımcı süreç.
PLAN.md → `DEVIR NOTU (sohbet 19 sonu)` → `SIRADAKI ADIMLAR (1)` adımının uygulamasıdır.

Bu, `native/spotify-capture-spike/` fizibilite deneyinin üretim sürümüdür. Deney kodu
referans/kanıt olarak yerinde bırakıldı; bu klasör onun üzerine kurulu düzenli yardımcıdır.

## Ne yapar

1. **Hedef PID'i otomatik bulur** — çalışan Spotify süreçleri arasından _ses oturumuna sahip_
   olanı seçer (PID her açılışta değişir; sohbet 19'da elle PID 30540 bulunmuştu, artık otomatik).
2. **Sesi yakalar** — WASAPI *process loopback* (`VAD\Process_Loopback`,
   `INCLUDE_TARGET_PROCESS_TREE`). DRM engel değil. **Kendi cihazına hiçbir şey ÇALMAZ** (yalnız yakalar).
3. **PCM akıtır** — ham `float32` little-endian, interleaved stereo, 48000 Hz → **stdout**.
4. **SMTC bilgi + kontrol** — Windows System Media Transport Controls ile şarkı/sanatçı/albüm +
   konum/süre + play/pause/next/previous/**seek** (karaokede başa sarma ve söz zamanlaması için).

## IPC protokolü (Electron `child_process`)

| Kanal | Yön | İçerik |
|-------|-----|--------|
| **stdout** | helper → Electron | Ham PCM: `f32le`, stereo, 48000 Hz. Başka hiçbir şey yazılmaz. |
| **stderr** | helper → Electron | Satır başına bir JSON olay. |
| **stdin**  | Electron → helper | Satır başına bir JSON komut. |

### Olaylar (stderr, her satır bir JSON)

```jsonc
{"type":"ready","pid":30540,"sampleRate":48000,"channels":2,"format":"f32le"}
{"type":"metadata","title":"...","artist":"...","album":"...","thumbnail":true}
{"type":"timeline","positionMs":127502,"durationMs":322846,"updatedAtUnixMs":1795338814482}
{"type":"playback","status":"Playing","canPlay":false,"canPause":true,"canNext":true,"canPrevious":true,"canSeek":true}
{"type":"captureStats","rmsDb":-21.9,"frames":95520}   // ~2 sn'de bir, tanı amaçlı
{"type":"log","level":"info","msg":"..."}
{"type":"error","msg":"..."}
```

> `timeline` anlıktır: `positionMs` değeri `updatedAtUnixMs` anındaki konumdur. Oynatma sürerken
> Electron, duvar saatiyle fark alıp konumu ekstrapole edebilir (söz zamanlaması için).

### Komutlar (stdin, her satır bir JSON)

```jsonc
{"cmd":"play"}
{"cmd":"pause"}
{"cmd":"playpause"}
{"cmd":"next"}
{"cmd":"previous"}
{"cmd":"seek","positionMs":12345}
{"cmd":"stop"}        // helper'ı kapatır
```

stdin **EOF** (Electron boruyu kapatınca) de nazik kapanışı tetikler.

## Derleme ve çalıştırma

Gereken: **.NET 8 SDK** (kullanıcının makinesinde kurulu). MSVC/C++ gerekmez.

```powershell
cd native/spotify-helper
dotnet build
# çalıştır (Spotify açık ve çalar durumdayken):
dotnet run
```

### Self-contained tek dosya exe (Electron ile paketlemek için)

```powershell
dotnet publish -c Release
# çıktı: bin/Release/net8.0-windows10.0.19041.0/win-x64/publish/spotify-helper.exe
```

> `csproj` içinde `win-x64`, `SelfContained`, `PublishSingleFile` zaten tanımlı; ayrı bayrak gerekmez.
> Tek dosya exe ~180 MB (Windows SDK projeksiyonları + tam .NET runtime). Boyut küçültme
> (trimming / ReadyToRun / framework-dependent) sonraki adıma bırakıldı.

### Komut satırı bayrakları

```
spotify-helper [--pid N] [--no-smtc] [--no-pcm] [--seconds S] [--list] [--help]

  --pid N      Oto-bulma yerine bu PID'i yakala
  --list       Spotify süreç/oturumlarını yaz ve çık
  --no-smtc    SMTC bilgi/kontrolü kapat (yalnız yakalama)
  --no-pcm     PCM'i stdout'a yazma (yalnız SMTC/kontrol testi)
  --seconds S  S saniye yakalayıp çık (self-test)
  --help       Bu yardım
```

### Hızlı doğrulama (Git Bash)

```bash
EXE="bin/Debug/net8.0-windows10.0.19041.0/win-x64/spotify-helper.exe"
# 3 sn PCM yakala (stdin açık kalsın diye 'sleep' ile besle; aksi halde EOF hemen kapatır):
sleep 5 | "$EXE" --seconds 3 1>pcm.raw 2>events.log
# pcm.raw ~ 48000*2*4*3 ≈ 1.15 MB olmalı; events.log'da metadata/timeline/captureStats görülür.
```

> **Test tuzağı:** stdin'i boş/kapalı bırakırsan (`echo "" | exe` ya da `< /dev/null`) helper EOF
> görüp hemen kapanır ve hiç PCM üretmez. Test ederken stdin'i açık tut (`sleep` ile besle) ya da
> etkileşimli çalıştır.

## Durum (feat/spotify-helper, ilk adım)

- [x] Hedef PID otomatik bulunuyor (gerçek makinede PID 30540 doğru seçildi).
- [x] Gerçek müzik yakalanıyor (RMS ~ −22 dBFS; spike'ın −25 dBFS'iyle tutarlı).
- [x] SMTC bilgi: metadata + timeline + playback **gerçek makinede doğrulandı** (sohbet 19'da henüz denenmemişti).
- [x] PCM stdout akışı doğrulandı (~1.15 MB / 3 sn).
- [ ] SMTC **kontrol** komutları (play/pause/seek) kullanıcının oynatmasını bozmamak için canlı test edilmedi; kod hazır, `canSeek=true` raporlanıyor.
- [ ] Electron tarafı (`feat/spotify-source`): gelen PCM'i mevcut ses hattına (stem → vokal zinciri → EQ → Key/Tempo) bağlama — **ayrı adım**.
- [ ] Çıkış yönlendirme UX (Settings > System > Sound > Volume mixer > Spotify > Output device) — sonraki adım.
