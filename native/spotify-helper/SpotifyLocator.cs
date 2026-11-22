using System.Diagnostics;
using NAudio.CoreAudioApi;

namespace SpotifyHelper;

/// <summary>
/// Calisan Spotify surecleri arasindan SES OTURUMUNA sahip olani bulur.
/// Devir notu (sohbet 19): yalnizca ses oturumu olan Spotify alt sureci gercek muzigi yakalatir;
/// PID her acilista degisir, bu yuzden otomatik bulunur.
/// </summary>
static class SpotifyLocator
{
    /// <summary>Yalnizca gercek ses oturumuna sahip Spotify PID'ini dondurur (tum aktif render cihazlarini tarar).
    /// Aktif calan oturumu onceliklendirir. Oturum yoksa 0 dondurur.</summary>
    public static uint FindAudioSessionPid(out string how)
    {
        how = "";
        var procs = Process.GetProcessesByName("Spotify");
        if (procs.Length == 0) { how = "Spotify sureci bulunamadi"; return 0; }
        var pids = procs.Select(p => p.Id).ToHashSet();

        uint fallbackSessionPid = 0;
        try
        {
            using var en = new MMDeviceEnumerator();
            var devices = en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
            foreach (var dev in devices)
            {
                try
                {
                    var mgr = dev.AudioSessionManager;
                    mgr.RefreshSessions();
                    var sessions = mgr.Sessions;
                    for (int i = 0; i < sessions.Count; i++)
                    {
                        var s = sessions[i];
                        int pid = (int)s.GetProcessID;
                        if (!pids.Contains(pid)) continue;
                        if (s.State == NAudio.CoreAudioApi.Interfaces.AudioSessionState.AudioSessionStateActive)
                        {
                            how = $"aktif ses oturumu ({dev.FriendlyName})";
                            return (uint)pid;
                        }
                        if (fallbackSessionPid == 0) fallbackSessionPid = (uint)pid;
                    }
                }
                catch { /* cihaz erisilemez olabilir, sonraki cihaza gec */ }
            }
        }
        catch (Exception e) { Events.Warn("ses oturumu taramasi basarisiz: " + e.Message); }

        if (fallbackSessionPid != 0)
        {
            how = "ses oturumu olan PID";
            return fallbackSessionPid;
        }
        how = "ses oturumu henuz yok";
        return 0;
    }

    public static bool IsProcessAlive(uint pid)
    {
        try
        {
            using var p = Process.GetProcessById((int)pid);
            return !p.HasExited;
        }
        catch { return false; }
    }

    /// <summary>Ses oturumu olan Spotify PID'ini dondurur; yoksa pencere basligi olan ilk Spotify'i,
    /// o da yoksa herhangi bir Spotify PID'ini dener. Hicbiri yoksa 0.</summary>
    public static uint FindTargetPid(out string how)
    {
        uint sessionPid = FindAudioSessionPid(out how);
        if (sessionPid != 0) return sessionPid;

        var procs = Process.GetProcessesByName("Spotify");
        if (procs.Length == 0) { how = "Spotify sureci bulunamadi"; return 0; }

        // 2) Pencere basligi olan ilk Spotify (muzik henuz hic calmamis, oturum yok ama hedef bu).
        foreach (var p in procs)
        {
            try { if (!string.IsNullOrWhiteSpace(p.MainWindowTitle)) { how = "pencere basligi olan PID"; return (uint)p.Id; } }
            catch { /* erisim reddi olabilir, gec */ }
        }

        // 3) Son care: ilk Spotify PID'i (include-tree yakalama agacin tamamini dinler).
        how = "ilk Spotify PID (son care)";
        return (uint)procs[0].Id;
    }
}
