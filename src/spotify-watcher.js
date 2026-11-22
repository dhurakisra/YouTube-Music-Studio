'use strict';

const { execFile } = require('node:child_process');

/**
 * Watches for the Spotify desktop process (Spotify.exe) on Windows.
 * Polls via `tasklist` (fast, no PowerShell startup cost, hidden window).
 */
function createSpotifyWatcher({ intervalMs = 2000, onStart, onStop, onStatusChange } = {}) {
  let timer = null;
  let running = false;
  let checking = false;
  let initialized = false;

  function checkOnce(callback) {
    if (checking) {
      if (callback) callback(running);
      return;
    }
    checking = true;
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq Spotify.exe', '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        checking = false;
        const found = !err && typeof stdout === 'string' && /"Spotify\.exe"/i.test(stdout);
        const changed = !initialized || found !== running;
        const prev = running;
        running = found;
        initialized = true;
        if (changed) {
          try { onStatusChange?.(running); } catch {}
          if (running && !prev) {
            try { onStart?.(); } catch {}
          } else if (!running && prev) {
            try { onStop?.(); } catch {}
          }
        }
        if (callback) callback(running);
      }
    );
  }

  function start() {
    if (timer) return;
    checkOnce();
    timer = setInterval(() => checkOnce(), intervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    checkOnce,
    isRunning: () => running,
  };
}

module.exports = { createSpotifyWatcher };
