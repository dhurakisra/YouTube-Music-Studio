using Windows.Media.Control;

namespace SpotifyHelper;

// Windows System Media Transport Controls (SMTC) kopusu.
// Devir notu: karaokede basa sarma (seek) ve soz zamanlamasi (konum) icin gerekli — sohbet 19'da HENUZ denenmemisti.
// Spotify masaustu uygulamasi SMTC'ye sarki/sanatci/album + konum/sure + play/pause/skip/seek saglar.

/// <summary>Spotify SMTC oturumunu bulur, degisiklikleri stderr olaylarina ceirir, kontrol komutlarini uygular.</summary>
sealed class SmtcController
{
    GlobalSystemMediaTransportControlsSessionManager? _mgr;
    GlobalSystemMediaTransportControlsSession? _session;
    string _lastMeta = "", _lastTimeline = "", _lastPlayback = "";

    public async Task InitAsync()
    {
        _mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        _mgr.SessionsChanged += (s, e) => PickSession();
        PickSession();
    }

    void PickSession()
    {
        if (_mgr == null) return;
        GlobalSystemMediaTransportControlsSession? pick = null;
        foreach (var s in _mgr.GetSessions())
        {
            var id = s.SourceAppUserModelId ?? "";
            if (id.Contains("Spotify", StringComparison.OrdinalIgnoreCase)) { pick = s; break; }
        }
        pick ??= _mgr.GetCurrentSession();
        if (!ReferenceEquals(pick, _session))
        {
            _session = pick;
            _lastMeta = _lastTimeline = _lastPlayback = "";   // yeni oturum: her seyi yeniden yayinla
            Events.Info(_session == null ? "SMTC: oturum yok" : "SMTC: oturum secildi (" + (_session.SourceAppUserModelId ?? "?") + ")");
        }
    }

    /// <summary>Bir kez yoklar; metadata/timeline/playback yalnizca degistiginde yayinlanir.</summary>
    public async Task PollAsync()
    {
        var s = _session;
        if (s == null) return;
        try
        {
            var pb = s.GetPlaybackInfo();
            var c = pb.Controls;
            string status = pb.PlaybackStatus.ToString();
            string pbKey = $"{status}|{c.IsPlayEnabled}{c.IsPauseEnabled}{c.IsNextEnabled}{c.IsPreviousEnabled}{c.IsPlaybackPositionEnabled}";
            if (pbKey != _lastPlayback)
            {
                _lastPlayback = pbKey;
                Events.Playback(status, c.IsPlayEnabled, c.IsPauseEnabled, c.IsNextEnabled, c.IsPreviousEnabled, c.IsPlaybackPositionEnabled);
            }

            var tl = s.GetTimelineProperties();
            long posMs = (long)tl.Position.TotalMilliseconds;
            long durMs = (long)(tl.EndTime - tl.StartTime).TotalMilliseconds;
            long updMs = tl.LastUpdatedTime.ToUnixTimeMilliseconds();
            string tlKey = $"{posMs}|{durMs}|{updMs}";
            if (tlKey != _lastTimeline)
            {
                _lastTimeline = tlKey;
                Events.Timeline(posMs, durMs, updMs);
            }

            var mp = await s.TryGetMediaPropertiesAsync();
            string metaKey = $"{mp.Title}|{mp.Artist}|{mp.AlbumTitle}";
            if (metaKey != _lastMeta)
            {
                _lastMeta = metaKey;
                Events.Metadata(mp.Title, mp.Artist, mp.AlbumTitle, mp.Thumbnail != null);
            }
        }
        catch (Exception e) { Events.Warn("SMTC yoklama hatasi: " + e.Message); }
    }

    // --- Kontrol komutlari (Electron stdin'den) ---
    public async Task HandleAsync(Command cmd)
    {
        var s = _session;
        if (s == null) { Events.Warn("SMTC oturumu yok, komut yok sayildi: " + (cmd.cmd ?? "?")); return; }
        try
        {
            switch (cmd.cmd)
            {
                case "play": await s.TryPlayAsync(); break;
                case "pause": await s.TryPauseAsync(); break;
                case "playpause": await s.TryTogglePlayPauseAsync(); break;
                case "next": await s.TrySkipNextAsync(); break;
                case "previous": await s.TrySkipPreviousAsync(); break;
                case "seek":
                    if (cmd.positionMs is long ms) await s.TryChangePlaybackPositionAsync(ms * 10_000); // 100ns tik
                    else Events.Warn("seek: positionMs eksik");
                    break;
                default: Events.Warn("bilinmeyen komut: " + (cmd.cmd ?? "null")); break;
            }
        }
        catch (Exception e) { Events.Warn("SMTC komut hatasi (" + cmd.cmd + "): " + e.Message); }
    }
}
