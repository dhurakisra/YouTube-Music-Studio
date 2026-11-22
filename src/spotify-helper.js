'use strict';

const { MessageChannelMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BLOCK_FRAMES = 4096;
const ALLOWED_CMDS = new Set(['play', 'pause', 'playpause', 'next', 'previous', 'seek', 'stop']);

function findHelperExe() {
  const candidates = [];
  if (process.env.SPOTIFY_HELPER_EXE) candidates.push(process.env.SPOTIFY_HELPER_EXE);
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'spotify-helper', 'spotify-helper.exe'));
  }
  const base = path.join(__dirname, '..', 'native', 'spotify-helper', 'bin');
  candidates.push(
    path.join(base, 'Release', 'net8.0-windows10.0.19041.0', 'win-x64', 'publish', 'spotify-helper.exe'),
    path.join(base, 'Release', 'net8.0-windows10.0.19041.0', 'win-x64', 'spotify-helper.exe'),
    path.join(base, 'Debug', 'net8.0-windows10.0.19041.0', 'win-x64', 'spotify-helper.exe'),
  );
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function createSpotifyHelper({ appendLog, getMainWindow }) {
  let child = null;
  let pcmPort = null;
  let sampleRate = 48000;
  let channels = 2;
  let sequence = 0;

  function emitEvent(ev) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('poc:spotify-event', ev); } catch {}
    }
  }

  function closePort() {
    if (!pcmPort) return;
    try { pcmPort.close(); } catch {}
    pcmPort = null;
  }

  function start() {
    if (child) return { ok: true, alreadyRunning: true };
    const exe = findHelperExe();
    if (!exe) {
      const error = 'spotify-helper.exe not found (build native/spotify-helper first)';
      appendLog('spotify_error', { state: 'missing_exe', error });
      emitEvent({ type: 'error', msg: error });
      return { ok: false, error };
    }
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: 'main window unavailable' };

    const channel = new MessageChannelMain();
    pcmPort = channel.port2;
    pcmPort.start();
    try {
      win.webContents.postMessage('poc:spotify-pcm-port', { type: 'spotify-pcm-port' }, [channel.port1]);
    } catch (error) {
      closePort();
      const msg = String(error?.message || error).slice(0, 200);
      appendLog('spotify_error', { state: 'port_failed', error: msg });
      return { ok: false, error: msg };
    }

    sampleRate = 48000;
    channels = 2;
    sequence = 0;

    let proc;
    try {
      proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      closePort();
      const msg = String(error?.message || error).slice(0, 200);
      appendLog('spotify_error', { state: 'spawn_failed', error: msg });
      emitEvent({ type: 'error', msg });
      return { ok: false, error: msg };
    }
    child = proc;
    appendLog('spotify_started', { state: 'starting' });

    // stdout: raw f32le stereo 48000 Hz PCM -> fixed 4096-frame blocks over MessagePort
    const blockBytes = BLOCK_FRAMES * 2 * 4;
    let carry = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      if (child !== proc || !pcmPort || !chunk?.length) return;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let offset = 0;
      while (offset + blockBytes <= buf.length) {
        const ab = new ArrayBuffer(blockBytes);
        new Uint8Array(ab).set(buf.subarray(offset, offset + blockBytes));
        try {
          pcmPort.postMessage({
            type: 'spotify:pcm',
            sequence: ++sequence,
            sampleRate,
            channels,
            frames: BLOCK_FRAMES,
            timestampEpochMs: Date.now(),
            data: new Float32Array(ab),
          });
        } catch {}
        offset += blockBytes;
      }
      carry = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
    });

    // stderr: newline-delimited JSON events
    let stderrBuf = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (text) => {
      if (child !== proc) return;
      stderrBuf += text;
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;
        if (ev.type === 'ready') {
          if (Number.isFinite(ev.sampleRate) && ev.sampleRate > 0) sampleRate = ev.sampleRate;
          if (Number.isFinite(ev.channels) && ev.channels > 0) channels = ev.channels;
          appendLog('spotify_ready', { state: 'ready', sampleRate, channels, pos: ev.pid || 0 });
        } else if (ev.type === 'error') {
          appendLog('spotify_error', { state: 'helper_error', error: String(ev.msg || '').slice(0, 300) });
        }
        emitEvent(ev);
      }
    });

    proc.on('error', (error) => {
      const msg = String(error?.message || error).slice(0, 200);
      appendLog('spotify_error', { state: 'proc_error', error: msg });
      emitEvent({ type: 'error', msg });
    });

    proc.on('exit', (code, signal) => {
      if (child === proc) {
        child = null;
        closePort();
      }
      appendLog('spotify_stopped', { state: 'exit', error: code === 0 ? '' : String(code ?? signal ?? '') });
      emitEvent({ type: 'stopped', code: code ?? null, signal: signal ?? null });
    });

    return { ok: true };
  }

  function stop() {
    if (!child) {
      closePort();
      return { ok: true };
    }
    const proc = child;
    child = null;
    closePort();
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write('{"cmd":"stop"}\n');
        proc.stdin.end();
      }
    } catch {}
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
    }, 2000);
    proc.once('exit', () => clearTimeout(timer));
    return { ok: true };
  }

  function sendCommand(raw) {
    if (!child || !child.stdin || child.stdin.destroyed) return { ok: false, error: 'spotify helper not running' };
    if (!raw || typeof raw !== 'object' || typeof raw.cmd !== 'string' || !ALLOWED_CMDS.has(raw.cmd)) {
      return { ok: false, error: 'invalid command' };
    }
    const clean = { cmd: raw.cmd };
    if (raw.cmd === 'seek') {
      if (!Number.isFinite(raw.positionMs) || raw.positionMs < 0) return { ok: false, error: 'invalid positionMs' };
      clean.positionMs = Math.round(raw.positionMs);
    }
    try {
      child.stdin.write(`${JSON.stringify(clean)}\n`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 160) };
    }
  }

  return {
    start,
    stop,
    sendCommand,
    isRunning: () => Boolean(child),
  };
}

module.exports = { createSpotifyHelper, findHelperExe };
