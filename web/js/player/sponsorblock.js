// Tube Archivist SponsorBlock metadata; opt-in for a single Plex library.
import * as store from '../util/store.js';

export const CATEGORIES = [
  ['sponsor', 'Sponsored segments'], ['selfpromo', 'Self-promotion'],
  ['interaction', 'Like/subscribe reminders'], ['intro', 'Intros'],
  ['outro', 'Outros'], ['filler', 'Filler content'],
];
const DEFAULT = ['sponsor', 'selfpromo', 'interaction'];
const cache = new Map();

// Minimal synchronous SHA-256 (hex digest) over an ASCII string. Used to build
// the public SponsorBlock API's hash-prefix path. Self-contained so it works in
// any WebView context (crypto.subtle needs a secure origin, which appassets://
// is not).
function sha256Hex(str) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const bytes = [];
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, 8 * i)) & 0xff); // length, big-endian
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export function config() {
  const c = store.get('sponsorBlock', {}) || {};
  return {
    enabled: !!c.enabled, server: String(c.server || '').replace(/\/+$/, ''),
    token: String(c.token || ''), sectionId: String(c.sectionId || ''),
    categories: Array.isArray(c.categories) ? c.categories : DEFAULT,
  };
}

export function saveConfig(c) {
  store.set('sponsorBlock', c);
  cache.clear();
}

// Extract the YouTube ID from a Plex file path. Tube Archivist names files two
// ways: a bare ID stem (`SHGauVE2ud4.mp4`) or a bracketed ID in the title
// (`My Video [dQw4w9WgXcQ].mkv`). Accept both, but only when the ID is the whole
// filename stem (or the bracketed form) so we never grab an arbitrary 11-char
// run out of a longer title.
export function youtubeId(filename) {
  const name = String(filename || '').split('/').pop();
  let m = name.match(/\[([a-zA-Z0-9_-]{11})\](?!\w)/);
  if (m && /\.[^.]+$/.test(name)) return m[1];
  m = name.match(/^([a-zA-Z0-9_-]{11})\.[^.]+$/);
  return m ? m[1] : null;
}

export function normalizeSegments(payload, categories) {
  const data = payload && (payload.data || payload);
  const sponsor = data && (data.sponsorblock || data);
  const segments = Array.isArray(sponsor) ? sponsor : sponsor && sponsor.segments;
  if (!Array.isArray(segments) || sponsor.is_enabled === false) return [];
  return segments.filter(s => categories.includes(s.category) && s.actionType !== 'mute')
    .map(s => {
      const bounds = s.segment || [s.startTime, s.endTime];
      return { start: Number(bounds[0]) * 1000, end: Number(bounds[1]) * 1000 };
    })
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

// A skip target this close to the end of the video leaves only a fraction of a
// second before the player finishes — i.e. it ends the video. Crowd-sourced
// "sponsor" tags frequently run right up to a video's end (they are really
// outros / end cards); auto-skipping one of those would jump the timeline to the
// final moment and cut the video off. Treat such targets as a no-skip so the
// video plays to its true end.
const MIN_TAIL_MS = 2000;

export function skipTarget(segments, position, duration, ignored = new Set()) {
  const i = segments.findIndex((s, n) => !ignored.has(n) && position >= s.start && position < s.end - 300);
  if (i < 0) return null;
  let end = segments[i].end;
  for (let j = i + 1; j < segments.length && segments[j].start <= end; j++) end = Math.max(end, segments[j].end);
  const target = duration > 0 ? Math.min(end, duration - 500) : end;
  if (duration > 0 && target > duration - MIN_TAIL_MS) return null;
  return { index: i, target };
}

// Probe whether the configured Tube Archivist server is reachable AND the
// token is valid, without needing a real video ID. We request a deliberately
// bogus video id: with a valid token TA gets past auth and returns 404
// ("video not found"); with a bad/missing token it returns 403 ("Invalid
// token"). A network failure / timeout means the server is unreachable.
export async function verifyConnection(server, token) {
  const url = String(server || '').replace(/\/+$/, '') + '/api/video/AAAAAAAAAAA/';
  let status, body;
  if (typeof EasyPlexVideo !== 'undefined' && EasyPlexVideo.fetchSponsor) {
    // Native bridge resolves only on 200; anything else surfaces as a reject
    // carrying the HTTP status in the message.
    try {
      await nativeRequest(url, token);
      return { ok: true };
    } catch (e) {
      const m = String(e && e.message || '');
      const code = m.match(/HTTP (\d{3})/);
      if (!code) return { ok: false, reason: 'Could not reach Tube Archivist (' + (m || 'timeout') + ')' };
      const s = Number(code[1]);
      if (s === 0) return { ok: false, reason: 'Could not reach Tube Archivist (no response)' };
      return interpret(s, m);
    }
  }
  try {
    const r = await fetch(url, { headers: { Authorization: 'Token ' + token } });
    status = r.status;
    try { body = await r.json(); } catch (_) { body = {}; }
  } catch (e) {
    return { ok: false, reason: 'Could not reach Tube Archivist at ' + url.split('/api')[0] };
  }
  return interpret(status, body && body.detail);
}

function interpret(status, detail) {
  if (status === 404) return { ok: true };                 // got past auth -> token is good
  if (status === 401 || status === 403)
    return { ok: false, reason: 'Tube Archivist rejected the API token' + (detail ? ' (' + detail + ')' : '') };
  if (status >= 500) return { ok: false, reason: 'Tube Archivist server error (HTTP ' + status + ')' };
  return { ok: false, reason: 'Unexpected response from Tube Archivist (HTTP ' + status + ')' };
}

function nativeRequest(url, token) {
  if (typeof EasyPlexVideo === 'undefined' || !EasyPlexVideo.fetchSponsor) {
    return fetch(url, { headers: { Authorization: 'Token ' + token } })
      .then(r => { if (!r.ok) throw new Error('Tube Archivist HTTP ' + r.status); return r.json(); });
  }
  return new Promise((resolve, reject) => {
    const id = 'sb' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { delete window.__easyplexSponsorCallbacks[id]; reject(new Error('Tube Archivist timeout')); }, 12000);
    window.__easyplexSponsorCallbacks ||= {};
    window.__easyplexSponsorCallbacks[id] = (status, response) => {
      clearTimeout(timer);
      delete window.__easyplexSponsorCallbacks[id];
      if (status !== 200) { reject(new Error('Tube Archivist HTTP ' + status)); return; }
      try { resolve(JSON.parse(response)); } catch (e) { reject(e); }
    };
    EasyPlexVideo.fetchSponsor(url, token, id);
  });
}

// Fetch skip segments straight from the public SponsorBlock API (no token,
// internet required). The current API keys on a 4-char prefix of SHA-256(video
// id) — not the id itself — so several videos share a path; we filter the
// response down to our exact videoID. Returns an array of segment objects (may
// be empty). Throws on network failure / non-OK so the caller can fall back to
// Tube Archivist.
async function sponsorBlockApi(videoId, categories) {
  const prefix = sha256Hex(videoId).slice(0, 4);
  const url = 'https://sponsor.ajay.app/api/skipSegments/' + prefix + '?' +
    'service=' + encodeURIComponent('YouTube') +
    '&categories=' + encodeURIComponent(JSON.stringify(categories)) +
    '&actionTypes=' + encodeURIComponent(JSON.stringify(['skip', 'poi', 'chapter']));
  let entries;
  if (typeof EasyPlexVideo !== 'undefined' && EasyPlexVideo.fetchSponsor) {
    entries = await new Promise((resolve, reject) => {
      const id = 'sb' + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { delete window.__easyplexSponsorCallbacks[id]; reject(new Error('SponsorBlock timeout')); }, 10000);
      window.__easyplexSponsorCallbacks ||= {};
      window.__easyplexSponsorCallbacks[id] = (status, response) => {
        clearTimeout(timer);
        delete window.__easyplexSponsorCallbacks[id];
        if (status !== 200) { reject(new Error('SponsorBlock HTTP ' + status)); return; }
        try { resolve(JSON.parse(response)); } catch (e) { reject(e); }
      };
      EasyPlexVideo.fetchSponsor(url, '', id); // no token for the public API
    });
  } else {
    const r = await fetch(url);
    if (!r.ok) throw new Error('SponsorBlock HTTP ' + r.status);
    entries = await r.json();
  }
  const hit = Array.isArray(entries) ? entries.find(d => d && d.videoID === videoId) : null;
  return (hit && Array.isArray(hit.segments)) ? hit.segments : [];
}

export async function segmentsFor(item, part) {
  const c = config();
  if (!c.enabled || !c.sectionId || String(item.librarySectionID) !== c.sectionId) return [];
  const id = youtubeId(part && part.file);
  if (!id) return [];
  const key = 'sb/' + id + '/' + c.categories.join(',');
  if (cache.has(key)) return cache.get(key);
  let raw;
  // Primary: public SponsorBlock API (always fresh, no local server needed).
  // Fallback: Tube Archivist's stored copy (works offline / when the public
  // API is down or the box has no internet).
  try {
    raw = await sponsorBlockApi(id, c.categories);
  } catch (e) {
    if (!c.server || !c.token) return [];
    try {
      raw = await nativeRequest(c.server + '/api/video/' + id + '/', c.token);
    } catch (e2) { return []; }
  }
  const result = normalizeSegments(raw, c.categories);
  cache.set(key, result);
  return result;
}
