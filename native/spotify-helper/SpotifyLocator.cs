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
    /// <summary>Ses oturumu olan Spotify PID'ini dondurur; yoksa pencere basligi olan ilk Spotify'i,
    /// o da yoksa herhangi bir Spotify PID'ini dener. Hicbiri yoksa 0.</summary>
    public static uint FindTargetPid(out string how)
    {
        how = "";
        var procs = Process.GetProcessesByName("Spotify");
        if (procs.Length == 0) { how = "Spotify sureci bulunamadi"; return 0; }
        var pids = procs.Select(p => p.Id).ToHashSet();

        // 1) Varsayilan render cihazindaki ses oturumlarina bak: hangi Spotify PID'inin oturumu varsa odur.
        try
        {
            using var en = new MMDeviceEnumerator();
            var dev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var mgr = dev.AudioSessionManager;
            mgr.RefreshSessions();
            var sessions = mgr.Sessions;
            for (int i = 0; i < sessions.Count; i++)
            {
                var s = sessions[i];
                int pid = (int)s.GetProcessID;
                if (pids.Contains(pid)) { how = "ses oturumu olan PID"; return (uint)pid; }
            }
        }
        catch (Exception e) { Events.Warn("ses oturumu taramasi basarisiz: " + e.Message); }

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
