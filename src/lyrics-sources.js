'use strict';
// Lyrics lookup across several public sources, tried in order until one has the song:
//   1. LRCLIB (synced)   2. NetEase Cloud Music (synced)   3. Kugou (synced)   4. lyrics.ovh (plain text)
// Only artist, track, album and duration are sent. Every source is best-effort: a failing or slow one is skipped.

const UA = 'YTM-Audio-POC (local player)';
const TIMEOUT_MS = 7000;

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const line = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const st of stamps) out.push({ t: Number(st[1]) * 60 + Number(st[2]), text: line });
  }
  return out.sort((a, b) => a.t - b.t);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/g, ' ').trim();
// title similarity: 1 = identical after normalising, 0 = nothing in common
function similarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const xs = new Set(x.split(' ')), ys = new Set(y.split(' '));
  let hit = 0; for (const w of xs) if (ys.has(w)) hit += 1;
  return hit / Math.max(xs.size, ys.size);
}
function pickBest(cands, { artist, title, duration }) {
  let best = null, bestScore = 0.55; // below this the match is too doubtful to show
  for (const c of cands) {
    let score = similarity(c.title, title) * 0.7 + similarity(c.artist, artist) * 0.3;
    if (duration && c.duration) { const d = Math.abs(c.duration - duration); score -= d > 8 ? 0.4 : d / 40; }
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

async function fromLrclib(q) {
  const base = 'https://lrclib.net/api/';
  const params = { artist_name: q.artist, track_name: q.title };
  if (q.album) params.album_name = q.album;
  if (q.duration) params.duration = String(q.duration);
  let rec = await getJson(base + 'get?' + new URLSearchParams(params));
  if (!rec) {
    const list = await getJson(base + 'search?' + new URLSearchParams({ artist_name: q.artist, track_name: q.title }));
    if (Array.isArray(list)) {
      const usable = list.filter((e) => e && (e.syncedLyrics || e.plainLyrics)).map((e) => ({ ...e, title: e.trackName, artist: e.artistName }));
      usable.sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0));
      rec = pickBest(usable, q);
    }
  }
  if (!rec || !(rec.syncedLyrics || rec.plainLyrics)) return null;
  return { synced: rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [], plain: String(rec.plainLyrics || ''), artist: rec.artistName, title: rec.trackName, album: rec.albumName };
}

async function fromNetease(q) {
  const kw = `${q.title} ${q.artist}`;
  const res = await getJson('https://music.163.com/api/search/get?' + new URLSearchParams({ s: kw, type: '1', limit: '8', offset: '0' }), { Referer: 'https://music.163.com/' });
  const songs = res?.result?.songs;
  if (!Array.isArray(songs) || !songs.length) return null;
  const best = pickBest(songs.map((s) => ({ id: s.id, title: s.name, artist: (s.artists || []).map((a) => a.name).join(' '), duration: (s.duration || 0) / 1000 })), q);
  if (!best) return null;
  const lyr = await getJson('https://music.163.com/api/song/lyric?' + new URLSearchParams({ id: String(best.id), lv: '1', kv: '1', tv: '-1' }), { Referer: 'https://music.163.com/' });
  const lrc = lyr?.lrc?.lyric;
  const synced = lrc ? parseLrc(lrc) : [];
  if (synced.length < 4) return null; // metadata-only entries ("no lyrics" placeholders)
  return { synced, plain: '', artist: best.artist, title: best.title, album: q.album };
}

async function fromKugou(q) {
  const kw = `${q.artist} ${q.title}`;
  const res = await getJson('https://mobileservice.kugou.com/api/v3/search/song?' + new URLSearchParams({ format: 'json', keyword: kw, page: '1', pagesize: '8' }));
  const items = res?.data?.info;
  if (!Array.isArray(items) || !items.length) return null;
  const best = pickBest(items.map((s) => ({ hash: s.hash, title: s.songname, artist: s.singername, duration: s.duration })), q);
  if (!best) return null;
  const found = await getJson('https://krcs.kugou.com/search?' + new URLSearchParams({ ver: '1', man: 'yes', client: 'mobi', keyword: kw, duration: String((best.duration || q.duration || 0) * 1000), hash: best.hash }));
  const cand = found?.candidates?.[0];
  if (!cand) return null;
  const dl = await getJson('https://lyrics.kugou.com/download?' + new URLSearchParams({ ver: '1', client: 'pc', id: String(cand.id), accesskey: String(cand.accesskey), fmt: 'lrc', charset: 'utf8' }));
  if (!dl?.content) return null;
  let text = '';
  try { text = Buffer.from(dl.content, 'base64').toString('utf8').replace(/^﻿/, ''); } catch { return null; }
  const synced = parseLrc(text);
  if (synced.length < 4) return null;
  return { synced, plain: '', artist: best.artist, title: best.title, album: q.album };
}

async function fromLyricsOvh(q) {
  const res = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(q.artist)}/${encodeURIComponent(q.title)}`);
  const text = res?.lyrics ? String(res.lyrics).trim() : '';
  if (text.length < 40) return null;
  return { synced: [], plain: text.slice(0, 20000), artist: q.artist, title: q.title, album: q.album };
}

const SOURCES = [['LRCLIB', fromLrclib], ['NetEase', fromNetease], ['Kugou', fromKugou], ['lyrics.ovh', fromLyricsOvh]];

// Returns { synced, plain, artist, title, album, source } | { notFound: true } | { error: true } (every source failed on the network).
async function findLyrics(q) {
  let failures = 0;
  for (const [name, fn] of SOURCES) {
    try {
      const r = await fn(q);
      if (r && (r.synced.length || r.plain)) return { ...r, source: name };
    } catch { failures += 1; }
  }
  return failures === SOURCES.length ? { error: true } : { notFound: true };
}

module.exports = { findLyrics, parseLrc, similarity };
