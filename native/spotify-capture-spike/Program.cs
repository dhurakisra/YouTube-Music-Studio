// Feasibility spike: capture ONE application's audio (Spotify desktop) with WASAPI process loopback, and test whether muting
// Spotify's own session volume (so it does not double-play) still leaves the capture intact.
using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler { [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op); }

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation { [PreserveSig] int GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }

[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject { }

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, uint flags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint n);
    [PreserveSig] int GetStreamLatency(out long l);
    [PreserveSig] int GetCurrentPadding(out uint p);
    [PreserveSig] int IsFormatSupported(int mode, IntPtr fmt, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr fmt);
    [PreserveSig] int GetDevicePeriod(out long def, out long min);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr h);
    [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpc);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint n);
}

[ClassInterface(ClassInterfaceType.None)]
class Handler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEventSlim Done = new(false);
    public IActivateAudioInterfaceAsyncOperation? Op;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { Op = op; Done.Set(); return 0; }
}

static class Native
{
    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid iid, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);
}

record Result(double RmsDb, int Packets, int SilentPackets, long Frames, string? Error);

static class Program
{
    const int SampleRate = 48000, Channels = 2;

    static IAudioClient? OpenLoopback(uint pid, out string? err)
    {
        err = null;
        IntPtr blob = Marshal.AllocHGlobal(12), pv = Marshal.AllocHGlobal(24);
        Marshal.WriteInt32(blob, 0, 1);          // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
        Marshal.WriteInt32(blob, 4, (int)pid);   // target process id
        Marshal.WriteInt32(blob, 8, 0);          // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
        Marshal.WriteInt16(pv, 0, 65);           // VT_BLOB
        Marshal.WriteInt32(pv, 8, 12);           // cbSize
        Marshal.WriteIntPtr(pv, 16, blob);
        try
        {
            var h = new Handler();
            var iid = typeof(IAudioClient).GUID;
            Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pv, h, out var op);
            if (!h.Done.Wait(5000)) { err = "activation timeout"; return null; }
            h.Op!.GetActivateResult(out int hr, out object ifc);
            if (hr != 0) { err = $"activate hr=0x{hr:X8}"; return null; }
            var client = (IAudioClient)ifc;
            IntPtr fmt = Marshal.AllocHGlobal(18);
            Marshal.WriteInt16(fmt, 0, 3);                 // WAVE_FORMAT_IEEE_FLOAT
            Marshal.WriteInt16(fmt, 2, Channels);
            Marshal.WriteInt32(fmt, 4, SampleRate);
            Marshal.WriteInt32(fmt, 8, SampleRate * Channels * 4);
            Marshal.WriteInt16(fmt, 12, Channels * 4);
            Marshal.WriteInt16(fmt, 14, 32);
            Marshal.WriteInt16(fmt, 16, 0);
            const uint LOOPBACK = 0x00020000, AUTOCONVERT = 0x80000000, SRC = 0x08000000;
            int r = client.Initialize(0, LOOPBACK | AUTOCONVERT | SRC, 2_000_000, 0, fmt, IntPtr.Zero);
            if (r != 0) { err = $"Initialize hr=0x{r:X8}"; return null; }
            return client;
        }
        catch (Exception e) { err = e.GetType().Name + ": " + e.Message; return null; }
    }

    static Result Capture(uint pid, double seconds)
    {
        var client = OpenLoopback(pid, out var err);
        if (client == null) return new Result(double.NaN, 0, 0, 0, err);
        var g = typeof(IAudioCaptureClient).GUID;
        client.GetService(ref g, out object o);
        var cap = (IAudioCaptureClient)o;
        client.Start();
        double sum = 0; long n = 0; int pk = 0, silent = 0; var sw = Stopwatch.StartNew();
        while (sw.Elapsed.TotalSeconds < seconds)
        {
            Thread.Sleep(10);
            cap.GetNextPacketSize(out uint next);
            while (next > 0)
            {
                cap.GetBuffer(out IntPtr data, out uint frames, out uint flags, out _, out _);
                pk++;
                if ((flags & 2) != 0) silent++;
                else
                {
                    int cnt = (int)frames * Channels; var buf = new float[cnt];
                    Marshal.Copy(data, buf, 0, cnt);
                    foreach (var s in buf) sum += (double)s * s;
                    n += cnt;
                }
                cap.ReleaseBuffer(frames);
                cap.GetNextPacketSize(out next);
            }
        }
        client.Stop();
        double rms = n > 0 ? Math.Sqrt(sum / n) : 0;
        return new Result(rms > 0 ? 20 * Math.Log10(rms) : double.NegativeInfinity, pk, silent, n / Channels, null);
    }

    static void Print(string label, Result r) =>
        Console.WriteLine($"{label,-34} {(r.Error != null ? "ERROR " + r.Error : $"rms={r.RmsDb,7:F1} dBFS  packets={r.Packets} silentFlagged={r.SilentPackets} frames={r.Frames}")}");

    static IEnumerable<AudioSessionControl> SpotifySessions(HashSet<int> pids)
    {
        using var en = new MMDeviceEnumerator();
        var dev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        dev.AudioSessionManager.RefreshSessions();
        var sessions = dev.AudioSessionManager.Sessions;
        var list = new List<AudioSessionControl>();
        for (int i = 0; i < sessions.Count; i++) { var s = sessions[i]; if (pids.Contains((int)s.GetProcessID)) list.Add(s); }
        return list;
    }

    static int Main(string[] args)
    {
        var spot = Process.GetProcessesByName("Spotify");
        var pids = spot.Select(p => p.Id).ToHashSet();
        Console.WriteLine($"Spotify processes: {string.Join(",", pids)}");
        var sess = SpotifySessions(pids).ToList();
        Console.WriteLine($"Spotify audio sessions on default output: {sess.Count} (pids {string.Join(",", sess.Select(s => s.GetProcessID))})");

        // 1) which PID gives sound with include-tree mode?
        Console.WriteLine("\n-- step 1: capture 1.5 s per Spotify PID (should be playing) --");
        uint best = 0; double bestDb = double.NegativeInfinity;
        foreach (var pid in pids)
        {
            var r = Capture((uint)pid, 1.5); Print($"pid {pid}", r);
            if (r.Error == null && r.RmsDb > bestDb) { bestDb = r.RmsDb; best = (uint)pid; }
        }
        if (best == 0) { Console.WriteLine("No PID gave a working capture."); return 1; }
        Console.WriteLine($"best pid: {best}");

        if (args.Contains("nomute")) { Print("capture 4 s (no mute)", Capture(best, 4)); return 0; }
        // 2) mute test
        Console.WriteLine("\n-- step 2: Spotify session volume test (listen: the speakers should go quiet in phase B) --");
        try {
        Print("A. normal (3 s)", Capture(best, 3));
        foreach (var s in sess) s.SimpleAudioVolume.Mute = true;
        Console.WriteLine("   [Spotify session MUTED]");
        Print("B. muted (3 s)", Capture(best, 3));
        foreach (var s in sess) s.SimpleAudioVolume.Mute = false;
        foreach (var s in sess) s.SimpleAudioVolume.Volume = 0.0f;
        Console.WriteLine("   [Spotify session volume = 0]");
        Print("C. volume 0 (3 s)", Capture(best, 3));
        } finally { foreach (var s in sess) { s.SimpleAudioVolume.Mute = false; s.SimpleAudioVolume.Volume = 1.0f; } }
        Console.WriteLine("   [restored: unmuted, volume 100%]");
        Print("D. restored (3 s)", Capture(best, 3));
        return 0;
    }
}
