using System.Diagnostics;
using System.Text.Json;
using NAudio.CoreAudioApi;

namespace SpotifyHelper;

// Spotify masaustu ses yakalama yardimcisi (.NET 8, self-contained).
// Gorev (PLAN.md, DEVIR NOTU sohbet 19 -> SIRADAKI ADIMLAR 1):
//   - Ses oturumu olan Spotify PID'ini otomatik bul
//   - Sesi WASAPI process-loopback ile yakala, HAM PCM'i stdout'tan Electron'a akit (kendi cihazina CALMAZ)
//   - SMTC bilgi (sarki/sanatci/konum/sure) + kontrol (play/pause/next/previous/seek) ekle
// Protokol: Protocol.cs (stdout=PCM, stderr=JSON olay, stdin=JSON komut).
//
// NOT: Yakalama ANA thread'de calisir (kanitlanmis spike yoluyla ayni: COM aktivasyonu + okuma
// ayni thread'de). SMTC ve stdin okuma arka plandadir. stdin EOF (Electron borusu kapanmasi) ->
// nazik kapanis.

static class Program
{
    static int Main(string[] args)
    {
        if (args.Contains("--help") || args.Contains("-h")) { PrintHelp(); return 0; }
        if (args.Contains("--list")) { ListSpotify(); return 0; }
        if (args.Contains("--list-devices")) { Events.Devices(AudioRouter.ListRenderDevices()); return 0; }
        if (args.Contains("--route-device"))
        {
            string? targetDev = ArgString(args, "--route-device");
            uint pid = ArgUint(args, "--pid");
            if (pid == 0) pid = SpotifyLocator.FindTargetPid(out _);
            var (ok, err) = AudioRouter.SetProcessOutputDevice(pid, targetDev);
            Events.RouteResult(ok, targetDev, err);
            return ok ? 0 : 1;
        }
        if (args.Contains("--reset-device"))
        {
            uint pid = ArgUint(args, "--pid");
            if (pid == 0) pid = SpotifyLocator.FindTargetPid(out _);
            var (ok, err) = AudioRouter.SetProcessOutputDevice(pid, null);
            Events.RouteResult(ok, null, err);
            return ok ? 0 : 1;
        }

        bool noSmtc = args.Contains("--no-smtc");
        bool noPcm = args.Contains("--no-pcm");        // yalniz SMTC/kontrol testi
        uint explicitPid = ArgUint(args, "--pid");
        double seconds = ArgDouble(args, "--seconds"); // >0 ise bu kadar yakalayip cikar (self-test)

        var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        // --- SMTC: bilgi yayini + kontrol (arka planda; PID beklenirken de play/pause calisir) ---
        SmtcController? smtc = noSmtc ? null : new SmtcController();
        if (smtc != null)
        {
            _ = Task.Run(async () =>
            {
                try { await smtc.InitAsync(); }
                catch (Exception e) { Events.Warn("SMTC baslatilamadi (bilgi/kontrol olmadan devam): " + e.Message); return; }
                while (!cts.IsCancellationRequested)
                {
                    await smtc.PollAsync();
                    try { await Task.Delay(250, cts.Token); } catch (OperationCanceledException) { break; }
                }
            });
        }

        // --- stdin: Electron komutlari (arka plan thread) ---
        StartStdinReader(smtc, cts);

        // --- sure siniri (self-test) ---
        if (seconds > 0)
            _ = Task.Delay(TimeSpan.FromSeconds(seconds)).ContinueWith(_ => cts.Cancel(), TaskScheduler.Default);

        // --- yakalama dongusu: ANA thread'de, ses oturumlu PID yoksa bekler, degisirse yeniden baglanir ---
        Stream stdout = noPcm ? Stream.Null : Console.OpenStandardOutput();
        int exit = 0;
        bool waitingNotified = false;
        try
        {
            while (!cts.IsCancellationRequested)
            {
                uint pid = explicitPid;
                string how = "--pid ile verildi";
                string devId = "";
                string devName = "";
                if (pid == 0)
                {
                    pid = SpotifyLocator.FindAudioSessionPid(out how, out devId, out devName);
                    if (pid == 0)
                    {
                        if (!waitingNotified)
                        {
                            Events.Waiting("waiting for playback");
                            waitingNotified = true;
                        }
                        try { Task.Delay(500, cts.Token).Wait(); } catch { break; }
                        continue;
                    }
                }
                waitingNotified = false;
                Events.Info($"hedef Spotify PID={pid} ({how})");
                Events.Ready((int)pid, LoopbackCapture.SampleRate, LoopbackCapture.Channels, devId, devName);

                using var capCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
                if (explicitPid == 0)
                {
                    uint trackedPid = pid;
                    string lastDevId = devId;
                    _ = Task.Run(async () =>
                    {
                        while (!capCts.IsCancellationRequested)
                        {
                            try { await Task.Delay(1500, capCts.Token); } catch (OperationCanceledException) { break; }
                            if (!SpotifyLocator.IsProcessAlive(trackedPid))
                            {
                                Events.Info($"hedef PID={trackedPid} kapandi, yeniden aranacak");
                                capCts.Cancel();
                                break;
                            }
                            uint currentPid = SpotifyLocator.FindAudioSessionPid(out _, out string curDevId, out string curDevName);
                            if (!string.IsNullOrEmpty(curDevId) && !string.Equals(curDevId, lastDevId, StringComparison.OrdinalIgnoreCase))
                            {
                                lastDevId = curDevId;
                                Events.SpotifyDevice(curDevId, curDevName);
                            }
                            if (currentPid != 0 && currentPid != trackedPid)
                            {
                                Events.Info($"ses oturumu PID degisti ({trackedPid} -> {currentPid}), yeniden baglaniliyor");
                                capCts.Cancel();
                                break;
                            }
                        }
                    });
                }

                var capture = new LoopbackCapture(pid);
                try
                {
                    capture.Run(capCts.Token,
                        (buf, n) => { if (!noPcm) { stdout.Write(buf, 0, n); stdout.Flush(); } },
                        (rmsDb, frames) => Events.CaptureStats(rmsDb, frames));
                }
                catch (Exception e)
                {
                    if (cts.IsCancellationRequested) break;
                    Events.Warn("yakalama kesildi, yeniden baglanilacak: " + e.Message);
                    try { Task.Delay(500, cts.Token).Wait(); } catch { break; }
                }
            }
        }
        finally { cts.Cancel(); }

        Events.Info("kapaniyor");
        return exit;
    }

    static void StartStdinReader(SmtcController? smtc, CancellationTokenSource cts)
    {
        var t = new Thread(() =>
        {
            string? line;
            while (!cts.IsCancellationRequested && (line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                Command? cmd;
                try { cmd = JsonSerializer.Deserialize<Command>(line); }
                catch (Exception e) { Events.Warn("komut cozulemedi: " + e.Message); continue; }
                if (cmd?.cmd == null) continue;
                if (cmd.cmd == "stop") { cts.Cancel(); break; }
                if (cmd.cmd == "listDevices") { Events.Devices(AudioRouter.ListRenderDevices()); continue; }
                if (cmd.cmd == "setOutput" || cmd.cmd == "resetOutput")
                {
                    uint targetPid = SpotifyLocator.FindTargetPid(out _);
                    string? devId = cmd.cmd == "resetOutput" ? null : cmd.deviceId;
                    var (ok, err) = AudioRouter.SetProcessOutputDevice(targetPid, devId);
                    Events.RouteResult(ok, devId, err);
                    continue;
                }
                if (smtc != null) _ = smtc.HandleAsync(cmd);
                else Events.Warn("SMTC kapali, komut yok sayildi: " + cmd.cmd);
            }
            cts.Cancel(); // stdin EOF (Electron borusu kapandi) -> kapan
        })
        { IsBackground = true, Name = "stdin" };
        t.Start();
    }

    static void ListSpotify()
    {
        var procs = Process.GetProcessesByName("Spotify");
        Events.Info($"Spotify surecleri: {string.Join(",", procs.Select(p => p.Id))}");
        try
        {
            using var en = new MMDeviceEnumerator();
            var dev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            dev.AudioSessionManager.RefreshSessions();
            var ses = dev.AudioSessionManager.Sessions;
            var pids = procs.Select(p => p.Id).ToHashSet();
            var hit = new List<int>();
            for (int i = 0; i < ses.Count; i++) { int p = (int)ses[i].GetProcessID; if (pids.Contains(p)) hit.Add(p); }
            Events.Info($"ses oturumu olan Spotify PID'leri: {string.Join(",", hit)}");
        }
        catch (Exception e) { Events.Warn("oturum listesi alinamadi: " + e.Message); }
        uint target = SpotifyLocator.FindTargetPid(out string how);
        Events.Info($"secilecek hedef: {target} ({how})");
    }

    static void PrintHelp()
    {
        Console.Error.WriteLine(
@"spotify-helper — Spotify masaustu sesini yakalar, PCM'i stdout'tan akitir, SMTC bilgi/kontrol saglar.

Kullanim:
  spotify-helper [--pid N] [--no-smtc] [--no-pcm] [--seconds S] [--list] [--help]

  --pid N      Oto-bulma yerine bu PID'i yakala
  --list       Spotify surec/oturumlarini yaz ve cik
  --no-smtc    SMTC bilgi/kontrolu kapat (yalniz yakalama)
  --no-pcm     PCM'i stdout'a yazma (yalniz SMTC/kontrol testi)
  --seconds S  S saniye yakalayip cik (self-test)
  --help       Bu yardim

Kanallar:  stdout=ham PCM (f32le, stereo, 48000 Hz)  |  stderr=satir-JSON olay  |  stdin=satir-JSON komut
Komutlar:  {""cmd"":""play|pause|playpause|next|previous|stop""}  {""cmd"":""seek"",""positionMs"":12345}");
    }

    static uint ArgUint(string[] a, string name)
    {
        int i = Array.IndexOf(a, name);
        return i >= 0 && i + 1 < a.Length && uint.TryParse(a[i + 1], out uint v) ? v : 0u;
    }
    static double ArgDouble(string[] a, string name)
    {
        int i = Array.IndexOf(a, name);
        return i >= 0 && i + 1 < a.Length && double.TryParse(a[i + 1], System.Globalization.CultureInfo.InvariantCulture, out double v) ? v : 0.0;
    }
    static string? ArgString(string[] a, string name)
    {
        int i = Array.IndexOf(a, name);
        return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
    }
}
