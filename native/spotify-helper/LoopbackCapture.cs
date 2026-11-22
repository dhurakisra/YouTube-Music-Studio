using System.Runtime.InteropServices;

namespace SpotifyHelper;

// WASAPI "process loopback" (VAD\Process_Loopback, INCLUDE_TARGET_PROCESS_TREE):
// yalnizca hedef surecin (ve agacinin) sesini yakalar, cihaza bir sey CALMAZ.
// COM arayuzleri dogrudan tanimlandi (NAudio 2.x process-loopback'i sarmalamaz).

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
sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEventSlim Done = new(false);
    public IActivateAudioInterfaceAsyncOperation? Op;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { Op = op; Done.Set(); return 0; }
}

static class CaptureNative
{
    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid iid,
        IntPtr activationParams, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);
}

/// <summary>Tek bir surecin sesini float32 PCM olarak yakalar ve bir callback'e akitir.</summary>
sealed class LoopbackCapture
{
    public const int SampleRate = 48000, Channels = 2;
    const uint CaptureFlagSilent = 0x2;      // AUDCLNT_BUFFERFLAGS_SILENT
    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;

    readonly uint _pid;
    public LoopbackCapture(uint pid) { _pid = pid; }

    IAudioClient OpenLoopback()
    {
        IntPtr blob = Marshal.AllocHGlobal(12), pv = Marshal.AllocHGlobal(24);
        Marshal.WriteInt32(blob, 0, 1);          // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
        Marshal.WriteInt32(blob, 4, (int)_pid);  // hedef PID
        Marshal.WriteInt32(blob, 8, 0);          // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
        Marshal.WriteInt16(pv, 0, 65);           // VT_BLOB
        Marshal.WriteInt32(pv, 8, 12);           // cbSize
        Marshal.WriteIntPtr(pv, 16, blob);

        var h = new ActivationHandler();
        var iid = typeof(IAudioClient).GUID;
        CaptureNative.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pv, h, out _);
        if (!h.Done.Wait(5000)) throw new InvalidOperationException("ses arayuzu aktivasyonu zaman asimi");
        h.Op!.GetActivateResult(out int hr, out object ifc);
        if (hr != 0) throw new InvalidOperationException($"ActivateAudioInterface hr=0x{hr:X8}");
        var client = (IAudioClient)ifc;

        IntPtr fmt = Marshal.AllocHGlobal(18);   // WAVEFORMATEX, float32 stereo 48k
        Marshal.WriteInt16(fmt, 0, 3);           // WAVE_FORMAT_IEEE_FLOAT
        Marshal.WriteInt16(fmt, 2, Channels);
        Marshal.WriteInt32(fmt, 4, SampleRate);
        Marshal.WriteInt32(fmt, 8, SampleRate * Channels * 4);
        Marshal.WriteInt16(fmt, 12, Channels * 4);
        Marshal.WriteInt16(fmt, 14, 32);
        Marshal.WriteInt16(fmt, 16, 0);
        int r = client.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            2_000_000, 0, fmt, IntPtr.Zero);
        if (r != 0) throw new InvalidOperationException($"IAudioClient.Initialize hr=0x{r:X8}");
        return client;
    }

    /// <summary>Yakalamayi baslatir ve iptal edilene kadar her pakette onData(buf, byteCount) cagirir.
    /// onStats periyodik olarak (rmsDb, toplamFrame) raporlar.</summary>
    public void Run(CancellationToken ct, Action<byte[], int> onData, Action<double, long>? onStats = null)
    {
        var client = OpenLoopback();
        var g = typeof(IAudioCaptureClient).GUID;
        client.GetService(ref g, out object o);
        var cap = (IAudioCaptureClient)o;
        client.Start();

        var byteBuf = new byte[SampleRate * Channels * 4 / 4];   // ~0.25 sn; gerekirse buyur
        double sum = 0; long statFrames = 0, totalFrames = 0;
        var statSw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            while (!ct.IsCancellationRequested)
            {
                cap.GetNextPacketSize(out uint next);
                if (next == 0) { Thread.Sleep(4); continue; }
                while (next > 0 && !ct.IsCancellationRequested)
                {
                    cap.GetBuffer(out IntPtr data, out uint frames, out uint flags, out _, out _);
                    int byteCount = (int)frames * Channels * 4;
                    if (byteCount > byteBuf.Length) byteBuf = new byte[byteCount];
                    if ((flags & CaptureFlagSilent) != 0 || data == IntPtr.Zero)
                    {
                        Array.Clear(byteBuf, 0, byteCount);     // sessizligi de ak: zaman hizasi korunur
                    }
                    else
                    {
                        Marshal.Copy(data, byteBuf, 0, byteCount);
                        // istatistik: ucuz RMS
                        int floats = (int)frames * Channels;
                        for (int i = 0; i < floats; i++)
                        {
                            float s = BitConverter.ToSingle(byteBuf, i * 4);
                            sum += (double)s * s;
                        }
                        statFrames += floats;
                    }
                    onData(byteBuf, byteCount);
                    totalFrames += frames;
                    cap.ReleaseBuffer(frames);
                    cap.GetNextPacketSize(out next);
                }
                if (onStats != null && statSw.Elapsed.TotalSeconds >= 2.0)
                {
                    double rms = statFrames > 0 ? Math.Sqrt(sum / statFrames) : 0;
                    onStats(rms > 0 ? 20 * Math.Log10(rms) : double.NegativeInfinity, totalFrames);
                    sum = 0; statFrames = 0; statSw.Restart();
                }
            }
        }
        finally
        {
            try { client.Stop(); } catch { }
        }
    }
}
