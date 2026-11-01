import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeId, normalizeSegments, skipTarget, verifyConnection, segmentsFor } from '../web/js/player/sponsorblock.js';
import * as store from '../web/js/util/store.js';

// store.js persists via localStorage, which node lacks by default. Provide a
// tiny in-memory shim so config can be set/checked in tests.
const _ls = new Map();
globalThis.localStorage = {
  getItem: k => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: k => { _ls.delete(k); },
  clear: () => { _ls.clear(); },
};

test('extracts bracketed YouTube IDs from Tube Archivist filenames', () => {
  assert.equal(youtubeId('/video/Example [dQw4w9WgXcQ].mkv'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('Other video.mkv'), null);
  assert.equal(youtubeId('not-a-video-id.mkv'), null);
});

test('extracts bare-ID stems from Tube Archivist filenames', () => {
  // TA's default naming: <channel>/<youtube_id>.<ext>, no brackets or title.
  assert.equal(youtubeId('/Media/tubearchivist/UCFki_upOKkji8k-ufUEX3cA/SHGauVE2ud4.mp4'), 'SHGauVE2ud4');
  assert.equal(youtubeId('qjYsukKQNvU.mkv'), 'qjYsukKQNvU');
  // A longer stem that merely contains an 11-char run must NOT match.
  assert.equal(youtubeId('dQw4w9WgXcQextra.mp4'), null);
  // Bracketed form still wins when both are present.
  assert.equal(youtubeId('My Video [dQw4w9WgXcQ].mp4'), 'dQw4w9WgXcQ');
});

test('normalizes segments from the video-detail response shape', () => {
  // The live TA endpoint /api/video/<id>/ returns the whole video object with a
  // top-level `sponsorblock` field (no `.data` wrapper, no `/sponsor/` route).
  const payload = {
    youtube_id: '3Qf4ABaXmFM',
    title: 'My 1st Bushcraft Camping Trip in Alaska',
    sponsorblock: {
      is_enabled: true, last_refresh: 1779397623, has_unlocked: true,
      segments: [
        { actionType: 'none', videoDuration: 1452.061, segment: [1446.243, 1452.061], votes: 1, category: 'interaction', locked: 0 },
        { actionType: 'skip', videoDuration: 1452.061, segment: [0.5, 12.2], votes: 9, category: 'sponsor', locked: 0 },
      ],
    },
  };
  assert.deepEqual(normalizeSegments(payload, ['sponsor', 'selfpromo', 'interaction']), [
    { start: 500, end: 12200 }, { start: 1446243, end: 1452061 },
  ]);
});

test('filters and sorts SponsorBlock segments using milliseconds', () => {
  const payload = { data: { sponsorblock: { is_enabled: true, segments: [
    { category: 'interaction', segment: [20, 30] },
    { category: 'sponsor', segment: [4.5, 9.25] },
    { category: 'intro', segment: [1, 4] },
    { category: 'sponsor', segment: [40, 50], actionType: 'mute' },
    { category: 'sponsor', segment: [10, 1] },
  ] } } };
  assert.deepEqual(normalizeSegments(payload, ['sponsor', 'interaction']), [
    { start: 4500, end: 9250 }, { start: 20000, end: 30000 },
  ]);
});

test('skipTarget skips once, merges overlaps, and respects duration', () => {
  const segments = [{ start: 1000, end: 4000 }, { start: 3500, end: 6000 }];
  assert.deepEqual(skipTarget(segments, 1500, 10000), { index: 0, target: 6000 });
  assert.equal(skipTarget(segments, 1500, 10000, new Set([0])), null);
  // A skip that would land within the final 2s of the video is now a no-skip:
  // it would leave ~0.5s and the player would end the video (cut-off).
  assert.equal(skipTarget(segments, 4000, 5200), null);
  assert.equal(skipTarget(segments, 7000, 10000), null);
});

test('skipTarget: does not auto-skip a segment that runs to the end of the video', () => {
  // Real-world repro (LEGO Car vs Giant Speed Bump, 679774ms / 11:19): the
  // last "sponsor" segment [667021, 679772.8] ends exactly at the video's end
  // (really an outro). Old code skipped to duration-500 (679274ms), leaving
  // 500ms so the player finished almost immediately — the video cut off.
  const segments = [
    { start: 208148, end: 275864 },   // normal mid-video sponsor
    { start: 667021, end: 679772.8 }, // runs to the very end
  ];
  const duration = 679774;
  // The mid-video sponsor still skips normally.
  assert.deepEqual(skipTarget(segments, 209000, duration), { index: 0, target: 275864 });
  // The end-running segment is NOT skipped (would end the video 0.5s later).
  assert.equal(skipTarget(segments, 667864, duration), null);
});

// verifyConnection probes a bogus video id: 404 means auth passed (token good),
// 403 means the token was rejected, a network failure means unreachable.
test('verifyConnection: 404 (past auth) counts as connected', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 404, json: async () => ({ error: 'video not found' }) });
  try {
    assert.deepEqual(await verifyConnection('http://ta:8000/', 'tok'), { ok: true });
  } finally { globalThis.fetch = real; }
});

test('verifyConnection: 403 reports an invalid token', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 403, json: async () => ({ detail: 'Invalid token.' }) });
  try {
    const r = await verifyConnection('http://ta:8000', 'bad');
    assert.equal(r.ok, false);
    assert.match(r.reason, /rejected the API token/);
  } finally { globalThis.fetch = real; }
});

test('verifyConnection: network failure reports unreachable', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  try {
    const r = await verifyConnection('http://unreachable:8000', 'tok');
    assert.equal(r.ok, false);
    assert.match(r.reason, /Could not reach Tube Archivist/);
  } finally { globalThis.fetch = real; }
});

test('verifyConnection: server 5xx is reported as a server error', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 502, json: async () => ({}) });
  try {
    const r = await verifyConnection('http://ta:8000', 'tok');
    assert.equal(r.ok, false);
    assert.match(r.reason, /server error/i);
  } finally { globalThis.fetch = real; }
});

// segmentsFor: public SponsorBlock API is primary, Tube Archivist is fallback.
// In node there's no EasyPlexVideo bridge, so both sources go through fetch —
// we route by URL host to simulate each backend independently.
const ITEM = { librarySectionID: 32 };
const PART = { file: '/Media/tubearchivist/chan/kBUxiiyfO4Y.mp4' };

function routeFetch({ sb, ta }) {
  return async (url) => {
    if (String(url).includes('sponsor.ajay.app')) return sb(String(url));
    return ta(String(url));
  };
}

test('segmentsFor: uses public SponsorBlock API when it succeeds', async () => {
  store.set('sponsorBlock', { enabled: true, sectionId: '32', categories: ['sponsor', 'selfpromo'] });
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = routeFetch({
    sb: (u) => { calls.push(u); return { ok: true, json: async () => [{ videoID: 'kBUxiiyfO4Y', segments: [{ category: 'selfpromo', actionType: 'skip', segment: [3.4, 6.3] }] }, { videoID: 'OTHERVIDEO12', segments: [{ category: 'sponsor', segment: [0, 5] }] }] }; },
    ta: (u) => { calls.push(u); throw new Error('TA should not be called'); },
  });
  try {
    const segs = await segmentsFor(ITEM, PART);
    assert.deepEqual(segs, [{ start: 3400, end: 6300 }]);
    // Only the public API was hit, keyed on the sha256 prefix with JSON-array params.
    assert.equal(calls.length, 1);
    assert.match(calls[0], /sponsor\.ajay\.app\/api\/skipSegments\/[0-9a-f]{4}\?/);
    assert.match(calls[0], /categories=%5B%22sponsor%22/); // JSON array, url-encoded
  } finally { globalThis.fetch = real; store.set('sponsorBlock', {}); }
});

test('segmentsFor: falls back to Tube Archivist when the public API fails', async () => {
  store.set('sponsorBlock', { enabled: true, server: 'http://ta:8000', token: 'tok', sectionId: '32', categories: ['interaction'] });
  const real = globalThis.fetch;
  globalThis.fetch = routeFetch({
    sb: () => { throw new Error('no internet'); },
    ta: (u) => {
      assert.match(u, /ta:8000\/api\/video\/kBUxiiyfO4Y\//);
      return { ok: true, json: async () => ({ sponsorblock: { is_enabled: true, segments: [{ category: 'interaction', segment: [10, 20] }] } }) };
    },
  });
  try {
    const segs = await segmentsFor(ITEM, PART);
    assert.deepEqual(segs, [{ start: 10000, end: 20000 }]);
  } finally { globalThis.fetch = real; store.set('sponsorBlock', {}); }
});

test('segmentsFor: returns empty when both sources fail', async () => {
  store.set('sponsorBlock', { enabled: true, server: 'http://ta:8000', token: 'tok', sectionId: '32', categories: ['sponsor'] });
  const real = globalThis.fetch;
  globalThis.fetch = routeFetch({ sb: () => { throw new Error('down'); }, ta: () => { throw new Error('down too'); } });
  try {
    assert.deepEqual(await segmentsFor(ITEM, PART), []);
  } finally { globalThis.fetch = real; store.set('sponsorBlock', {}); }
});

test('segmentsFor: no-op outside the configured library or when disabled', async () => {
  store.set('sponsorBlock', { enabled: true, sectionId: '32', categories: ['sponsor'] });
  const real = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => { called = true; return Promise.resolve({ ok: true, json: async () => [] }); };
  try {
    assert.deepEqual(await segmentsFor({ librarySectionID: 99 }, PART), []); // wrong library
    assert.deepEqual(await segmentsFor(ITEM, { file: 'no-id.mp4' }), []);     // no youtube id
    assert.equal(called, false);                                              // never fetched
  } finally { globalThis.fetch = real; store.set('sponsorBlock', {}); }
});
