// The Samsung Tizen build: it bundles, contains only syntax a 2019 TV
// (Chromium 63) can parse, and runs in headless Chromium against fake Tizen
// APIs (AVPlay, key registration, product info) with the newer browser APIs
// the TV lacks removed.
/* global EasyPlexVideo, __av */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { chromium } from 'playwright';
import { legacyCss } from '../scripts/build-tizen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

let out, server, base, browser;
before(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'easyplex-tizen-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-tizen.mjs'), '--out', out], { stdio: 'pipe' });
  server = http.createServer(async (req, res) => {
    const file = path.join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(out)) { res.writeHead(403).end(); return; }
    try {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port + '/index.html';
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
  if (out) await rm(out, { recursive: true, force: true });
});

test('bundle parses as ES2018 (no ?. ?? ||= or catch without binding) and has the TV files', async () => {
  const js = await readFile(path.join(out, 'js/easyplex.js'), 'utf8');
  assert.doesNotThrow(() => parse(js, { ecmaVersion: 2018 }));
  const config = await readFile(path.join(out, 'config.xml'), 'utf8');
  assert.match(config, /required_version="5\.0"/);
  assert.match(config, /privilege\/avplay/);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /\$WEBAPIS\/webapis\/webapis\.js/);
  assert.doesNotMatch(html, /type="module"/);
  for (const f of ['icon.png', 'css/app.css', 'css/livetv.css', 'css/vod.css', 'css/tizen.css', 'img/easyplex-logo.jpg', 'fonts/inter-latin-400-normal.woff2']) {
    await readFile(path.join(out, f));
  }
  const css = await readFile(path.join(out, 'css/livetv.css'), 'utf8');
  assert.doesNotMatch(css, /[;{\s]inset\s*:/);
});

test('CSS: inset is expanded and flex gap gets margin fallbacks', () => {
  const css = legacyCss('.a { position: absolute; inset: 0; }\n.b, .c { display: flex; flex-direction: column; gap: 10px; }\n.d { display:flex; gap: 4px 8px; inset: 1px 2px !important; }');
  assert.match(css, /\.a \{ position: absolute; top:0;right:0;bottom:0;left:0; \}/);
  assert.match(css, /top:1px !important;right:2px !important;bottom:1px !important;left:2px !important/);
  assert.match(css, /html\.no-flex-gap \.b > \* \+ \*,\nhtml\.no-flex-gap \.c > \* \+ \* \{ margin-top:10px; \}/);
  assert.match(css, /html\.no-flex-gap \.d > \* \+ \* \{ margin-left:8px; \}/);
});

// Fake Samsung APIs, plus the APIs a 2019 TV doesn't have taken away.
const TIZEN = `
delete window.AbortController; delete window.AbortSignal; delete Promise.allSettled;
window.__av = { calls: [], listener: null, prepare: 'ok', keys: [], exit: 0, screensaver: [] };
const tracks = [
  { index: 1, type: 'AUDIO', extra_info: '{"language":"eng","fourCC":"AC3","channels":"6"}' },
  { index: 2, type: 'AUDIO', extra_info: '{"language":"fra","fourCC":"AAC","channels":"2"}' },
  { index: 3, type: 'TEXT', extra_info: '{"track_lang":"eng","fourCC":"DVB"}' },
];
window.webapis = {
  avplay: {
    open(u) { __av.calls.push(['open', u]); }, close() { __av.calls.push(['close']); }, stop() { __av.calls.push(['stop']); },
    setDisplayRect() {}, setDisplayMethod() {}, setStreamingProperty(k, v) { __av.calls.push(['prop', k, v]); },
    setListener(l) { __av.listener = l; },
    prepareAsync(ok, err) {
      __av.calls.push(['prepare']);
      if (__av.prepare === 'ok') setTimeout(ok, 30);
      else if (__av.prepare === 'fail') setTimeout(() => err({ name: 'PLAYER_ERROR_CONNECTION_FAILED' }), 30);
    },
    play() { __av.calls.push(['play']); }, pause() { __av.calls.push(['pause']); },
    seekTo(ms, ok) { __av.calls.push(['seek', ms]); setTimeout(ok, 10); },
    getCurrentTime() { return 0; }, getDuration() { return 6000000; }, getState() { return 'PLAYING'; },
    getTotalTrackInfo() { return tracks; },
    getCurrentStreamInfo() { return [{ type: 'VIDEO', extra_info: '{"fourCC":"H264","Width":"1920","Height":"1080","Bit_rate":"8000000"}' }]; },
    setSelectTrack(t, i) { __av.calls.push(['track', t, i]); }, setSilentSubtitle(on) { __av.calls.push(['silent', on]); },
    suspend() {}, restore() {},
  },
  productinfo: { getRealModel: () => 'UE55RU7470UXXU', getModel: () => '19_MUSEL_UHD', isUdPanelSupported: () => true },
  appcommon: { AppCommonScreenSaverState: { SCREEN_SAVER_ON: 1, SCREEN_SAVER_OFF: 0 }, setScreenSaver(s) { __av.screensaver.push(s); } },
};
window.tizen = {
  tvinputdevice: {
    getSupportedKeys: () => ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', '0', '1'].map(name => ({ name })),
    registerKey(k) { __av.keys.push(k); },
  },
  application: { getCurrentApplication: () => ({ exit() { __av.exit++; } }), getAppInfo: () => ({ version: '0.1.0' }) },
  systeminfo: { getCapability: () => '5.0' },
};`;
const SIGNED_IN = `
localStorage.setItem('ss.token', JSON.stringify('t'));
localStorage.setItem('ss.user', JSON.stringify({ title: 'Dan' }));
localStorage.setItem('ss.server', JSON.stringify({ uri: 'http://pms.test', token: 't', name: 'Mock Plex', id: 'm1' }));`;
const MOVIE = {
  ratingKey: '101', key: '/library/metadata/101', type: 'movie', title: 'The Long Road', year: 2024,
  duration: 6000000, viewOffset: 1200000, summary: 'A film.', thumb: '/t', art: '/a',
  Media: [{ container: 'mp4', videoCodec: 'h264', Part: [{ id: 9, key: '/library/parts/9/file.mp4',
    Stream: [{ streamType: 2, codec: 'aac', id: 1, selected: true }] }] }],
};
const DTS_MOVIE = { ...MOVIE, ratingKey: '102', key: '/library/metadata/102', title: 'Loud Film',
  Media: [{ container: 'mkv', videoCodec: 'hevc', videoResolution: '4k', Part: [{ id: 10, key: '/library/parts/10/file.mkv',
    Stream: [{ streamType: 2, codec: 'dca', id: 2, selected: true }] }] }] };

async function newPage({ movie = MOVIE } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(TIZEN + SIGNED_IN);
  const seen = [];
  await ctx.route('http://pms.test/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    seen.push({ path: u.pathname, query: u.search, headers: req.headers() });
    const p = u.pathname;
    let body = {};
    if (p === '/identity') body = { MediaContainer: { machineIdentifier: 'm1' } };
    else if (p === '/library/sections') body = { MediaContainer: { Directory: [{ key: '1', title: 'Films', type: 'movie' }] } };
    else if (p === '/hubs') body = { MediaContainer: { Hub: [{ hubIdentifier: 'home.continue', title: 'Recently Added', type: 'movie', size: 1, Metadata: [movie] }] } };
    else if (p.startsWith('/library/metadata/')) body = { MediaContainer: { Metadata: [movie] } };
    else if (p.endsWith('/decision')) body = { MediaContainer: { generalDecisionCode: 1000 } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await ctx.route('http://dispatcharr.test/**', route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/hdhr/lineup.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ GuideNumber: '1', GuideName: 'BBC One', URL: 'http://dispatcharr.test/proxy/ts/stream/1' }]) });
    return route.fulfill({ status: 404, body: '' });
  });
  await ctx.route('**/$WEBAPIS/**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await ctx.route('**/plex.tv/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base);
  await page.waitForFunction(() => [...document.querySelectorAll('.home .nav-item')].some(n => n.textContent.includes('Films')), null, { timeout: 10000 });
  await page.waitForSelector('.home .tile', { timeout: 10000 });
  await page.waitForTimeout(300);
  // A remote key, with Samsung key codes, as real keydown/keyup events.
  const press = async (keyCode, { hold = 0, wait = 150 } = {}) => {
    await page.evaluate(([code, holdMs]) => new Promise(resolve => {
      const fire = type => {
        const e = new KeyboardEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'keyCode', { get: () => code });
        (document.activeElement || document.body).dispatchEvent(e);
      };
      fire('keydown');
      setTimeout(() => { fire('keyup'); resolve(); }, holdMs);
    }), [keyCode, hold]);
    await page.waitForTimeout(wait);
  };
  const av = () => page.evaluate(() => window.__av);
  const text = sel => page.evaluate(s => (document.querySelector(s) || {}).textContent || '', sel);
  const list = sel => page.evaluate(s => [...document.querySelectorAll(s)].map(e => e.textContent), sel);
  return { ctx, page, errors, seen, press, av, text, list };
}

const K = { OK: 13, BACK: 10009, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, PLAY: 415, PLAYPAUSE: 10252, RED: 403, CH_UP: 427 };

test('home on a UE55RU7470: identity, keys, Samsung label, polyfills', async () => {
  const { ctx, page, errors, seen, press, av, text, list } = await newPage();
  assert.equal(await text('.brand-by'), 'Plex for Samsung TV');
  const plexHeaders = seen.find(r => r.path === '/hubs').headers;
  assert.equal(plexHeaders['x-plex-platform'], 'Samsung');
  assert.equal(plexHeaders['x-plex-device'], 'UE55RU7470UXXU');
  assert.equal(plexHeaders['x-plex-platform-version'], '5.0');
  const keys = (await av()).keys;
  assert.ok(keys.includes('ColorF0Red') && keys.includes('MediaPlayPause') && keys.includes('0'));
  assert.ok(!keys.includes('MediaRecord'), 'keys the TV lacks are not registered');
  assert.equal(await page.evaluate(() => typeof AbortController), 'function');
  assert.equal(await page.evaluate(() => typeof Promise.allSettled), 'function');
  assert.equal(await page.evaluate(() => typeof EasyPlexVideo.setHud), 'undefined');
  // Artwork comes straight from Plex's resizer, not the Android image proxy.
  assert.ok(seen.every(r => !r.path.includes('pleximg')));
  assert.equal(await page.evaluate(() => [...document.images].some(i => i.src.includes('androidplatform'))), false);

  // Hold OK: options list. Short OK inside it picks; Back closes.
  await press(K.OK, { hold: 750 });
  assert.deepEqual(await list('.ep-options .hx-menu-item'), ['Resume from 20:00', 'Play from the start', 'Details', 'Mark as watched']);
  await press(K.BACK);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ep-options')).display), 'none');

  // Back twice exits through the Tizen application API.
  await press(K.BACK);
  assert.match(await text('.ep-toast'), /Press Back again to exit/);
  await press(K.BACK);
  assert.equal((await av()).exit, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('film: AVPlay direct play under the web OSD, seek, pause, 4K mode for HEVC', async () => {
  const { ctx, page, errors, press, av, text } = await newPage();
  await press(K.PLAY);
  await page.waitForFunction(() => __av.calls.some(c => c[0] === 'play'), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  let calls = (await av()).calls;
  assert.deepEqual(calls.find(c => c[0] === 'open'), ['open', 'http://pms.test/library/parts/9/file.mp4?X-Plex-Token=t']);
  assert.ok(calls.some(c => c[0] === 'seek' && c[1] === 1200000), 'resumes where it was left');
  assert.ok(calls.some(c => c[0] === 'play'));
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('playing')));
  assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('#app')).visibility !== 'hidden'));
  assert.match(await text('.osd-title'), /The Long Road/);
  assert.ok((await av()).screensaver.includes(0), 'screensaver off while playing');
  await press(K.PLAYPAUSE);
  calls = (await av()).calls;
  assert.equal(calls.at(-1)[0], 'pause');
  assert.ok(await page.evaluate(() => document.querySelector('.player').classList.contains('paused')));
  await press(K.BACK, { wait: 400 });
  calls = (await av()).calls;
  assert.ok(calls.some(c => c[0] === 'close'));
  assert.deepEqual(errors, []);
  await ctx.close();

  // DTS audio: Plex converts it (HLS with the Samsung transcode target).
  const p2 = await newPage({ movie: DTS_MOVIE });
  await p2.press(K.PLAY);
  await p2.page.waitForFunction(() => __av.calls.some(c => c[0] === 'open'), null, { timeout: 10000 });
  const open = (await p2.av()).calls.find(c => c[0] === 'open')[1];
  assert.match(open, /\/video\/:\/transcode\/universal\/start\.m3u8/);
  assert.match(decodeURIComponent(open), /add-transcode-target\(type=videoProfile&context=streaming&protocol=hls&container=mpegts/);
  assert.match(open, /X-Plex-Platform=Samsung/);
  assert.ok((await p2.av()).calls.some(c => c[0] === 'prop' && c[1] === 'SET_MODE_4K'));
  assert.deepEqual(p2.errors, []);
  await p2.ctx.close();
});

test('live TV bridge: hidden UI, banner, keys, track menu, options, failure, lineup', async () => {
  const { ctx, page, errors, press, av, text, list } = await newPage();
  await page.evaluate(() => {
    window.__actions = [];
    window.__androidAction = a => { window.__actions.push(a); };
    window.__events = [];
    window.__easyplexVideoEvent = (n, v) => window.__events.push([n, v]);
    window.__fail = [];
    window.__easyplexLivePlayError = m => window.__fail.push(m);
    EasyPlexVideo.open('http://dispatcharr.test/proxy/ts/stream/1');
    EasyPlexVideo.setLiveBanner('1 BBC One\nNow   18:00–19:00  News\nNext  19:00  Weather', 400);
  });
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('ep-video')));
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#app')).visibility), 'hidden');
  assert.equal(await text('.ep-tv-hud-title'), '1 BBC One');
  assert.match(await text('.ep-tv-hud-text'), /Now {3}18:00–19:00 {2}News\nNext/);
  assert.ok(await page.evaluate(() => document.querySelector('.ep-tv-hud').classList.contains('on')));
  assert.deepEqual((await page.evaluate(() => window.__events.map(e => e[0]))).slice(0, 2), ['ready', 'buffer']);
  assert.ok((await av()).calls.some(c => c[0] === 'play'));

  // Channel keys and Back go to the web app; OK shows the banner and sends enter.
  await press(K.CH_UP); await press(K.UP); await press(K.BACK);
  await press(K.OK, { hold: 50 });
  assert.deepEqual(await page.evaluate(() => window.__actions), ['pageup', 'up', 'back', 'enter']);
  // Hold OK -> menu action for the live options.
  await press(K.OK, { hold: 750 });
  assert.equal(await page.evaluate(() => window.__actions.at(-1)), 'menu');

  // Play/Pause acts on the stream directly.
  await press(K.PLAYPAUSE);
  assert.equal((await av()).calls.at(-1)[0], 'pause');
  await press(K.PLAYPAUSE);
  assert.equal((await av()).calls.at(-1)[0], 'play');

  // Right: audio/subtitle tracks from AVPlay.
  await press(K.RIGHT);
  assert.deepEqual(await list('.ep-tv-menu .hx-menu-item'), ['Audio tracks', 'Subtitles', 'Video information']);
  await press(K.OK, { hold: 50 });
  assert.deepEqual(await list('.ep-tv-menu .hx-menu-item'), ['eng - AC3 - 6ch', 'fra - AAC - 2ch']);
  await press(K.DOWN); await press(K.OK, { hold: 50 });
  assert.deepEqual((await av()).calls.at(-1), ['track', 'AUDIO', 2]);
  assert.equal(await page.evaluate(() => !!document.querySelector('.ep-tv-menu')), false);

  // showMenu: the live options list over the video.
  await page.evaluate(() => {
    window.__picked = null;
    window.__easyplexMenuChoice = i => { window.__picked = i; };
    EasyPlexVideo.showMenu('1 BBC One  ·  News', JSON.stringify(['Record this episode', 'Add to favourites', 'Back to guide']));
  });
  assert.equal(await text('.ep-tv-menu .hx-dlg-title'), '1 BBC One  ·  News');
  await press(K.DOWN); await press(K.DOWN); await press(K.OK, { hold: 50 });
  assert.equal(await page.evaluate(() => window.__picked), 2);

  // A stream that fails to open reports to the Live TV screen.
  await page.evaluate(() => { window.__av.prepare = 'fail'; EasyPlexVideo.open('http://dispatcharr.test/proxy/ts/stream/2'); });
  await page.waitForTimeout(200);
  assert.match((await page.evaluate(() => window.__fail))[0], /PLAYER_ERROR_CONNECTION_FAILED/);
  assert.match(await text('.ep-tv-hud-text'), /Playback failed/);

  // Close: the UI comes back.
  await page.evaluate(() => EasyPlexVideo.close());
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ep-video')), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#app')).visibility), 'visible');
  assert.ok((await av()).screensaver.includes(1));

  // Dispatcharr HDHomeRun lineup through the bridge (and its URL checks).
  const lineup = await page.evaluate(() => new Promise(resolve => {
    window.__easyplexHdhrLineup = raw => resolve(raw);
    EasyPlexVideo.loadHdhrLineup('http://dispatcharr.test/hdhr/');
  }));
  assert.equal(JSON.parse(lineup)[0].GuideName, 'BBC One');
  const bad = await page.evaluate(() => new Promise(resolve => {
    window.__easyplexHdhrLineup = raw => resolve(raw);
    EasyPlexVideo.loadHdhrLineup('http://dispatcharr.test/other');
  }));
  assert.match(JSON.parse(bad).error, /does not end in \/hdhr/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('flex gap fallback lays out like gap does', async () => {
  // Same dialog twice: native gap, and gap removed with the fallback on.
  const css = '.hx-dlg { display:flex; flex-direction:column; gap:16px; width:400px } .hx-dlg div { height:20px } .row { display:flex; gap:12px } .row span { width:30px; height:10px }';
  const html = '<div class="hx-dlg"><div></div><div></div><div class="row"><span></span><span></span><span></span></div></div>';
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const measure = async (style, cls) => {
    await page.setContent('<html class="' + cls + '"><style>' + style + '</style>' + html + '</html>');
    return page.evaluate(() => [...document.querySelectorAll('.hx-dlg > div, .row span')].map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y]; }));
  };
  const native = await measure(css, '');
  const fallback = await measure(legacyCss(css).replace(/(^|[;{\s])gap:[^;}]+;?/g, '$1'), 'no-flex-gap');
  assert.deepEqual(fallback, native);
  await ctx.close();
});
