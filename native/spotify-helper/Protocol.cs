using System.Text;
using System.Text.Json;

namespace SpotifyHelper;

// IPC kanallari (Electron child_process ile):
//   stdout -> HAM PCM (little-endian float32, interleaved stereo, 48000 Hz). Baska hicbir sey yazilmaz.
//   stderr -> satir basina bir JSON olay (metadata/timeline/playback/log/ready/error/stats).
//   stdin  -> satir basina bir JSON komut (play/pause/next/previous/seek/stop).
// Bu ayrim sayesinde ses akisi temiz kalir; Electron stdout'u dogrudan ses hattina verir,
// stderr'i satir satir JSON.parse eder.

/// <summary>stderr uzerinden Electron'a satir-JSON olaylari gonderir (thread-safe).</summary>
static class Events
{
    static readonly object _lock = new();
    static readonly Stream _err = Console.OpenStandardError();
    static readonly JsonSerializerOptions _opt = new() { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    public static void Emit(object evt)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(evt, _opt) + "\n");
        lock (_lock) { _err.Write(bytes, 0, bytes.Length); _err.Flush(); }
    }

    public static void Ready(int pid, int sampleRate, int channels, string? deviceId = null, string? deviceName = null) =>
        Emit(new { type = "ready", pid, sampleRate, channels, format = "f32le", deviceId, deviceName });

    public static void SpotifyDevice(string? deviceId, string? deviceName) =>
        Emit(new { type = "spotifyDevice", deviceId, deviceName });

    public static void Waiting(string reason) =>
        Emit(new { type = "waiting", reason });

    public static void Log(string level, string msg) => Emit(new { type = "log", level, msg });
    public static void Info(string msg) => Log("info", msg);
    public static void Warn(string msg) => Log("warn", msg);
    public static void Error(string msg) => Emit(new { type = "error", msg });

    public static void Metadata(string? title, string? artist, string? album, bool hasThumbnail) =>
        Emit(new { type = "metadata", title, artist, album, thumbnail = hasThumbnail });

    public static void Timeline(long positionMs, long durationMs, long updatedAtUnixMs) =>
        Emit(new { type = "timeline", positionMs, durationMs, updatedAtUnixMs });

    public static void Playback(string status, bool canPlay, bool canPause, bool canNext, bool canPrevious, bool canSeek) =>
        Emit(new { type = "playback", status, canPlay, canPause, canNext, canPrevious, canSeek });

    public static void CaptureStats(double rmsDb, long frames) =>
        Emit(new { type = "captureStats", rmsDb, frames });

    public static void Devices(List<AudioRouter.RenderDeviceInfo> devices) =>
        Emit(new { type = "devices", devices });

    public static void RouteResult(bool ok, string? deviceId, string? error) =>
        Emit(new { type = "routeResult", ok, deviceId, error });
}

/// <summary>Electron'dan gelen stdin komutu.</summary>
sealed class Command
{
    public string? cmd { get; set; }
    public long? positionMs { get; set; }
    public string? deviceId { get; set; }
}
