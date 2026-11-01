// The Tizen stand-in for the Android shell (android/.../MainActivity.java).
//
// On Android, a native activity hosts the web UI and provides window.EasyPlexVideo
// (Media3 player, now/next banner, options list over video, HDHomeRun lookup,
// Tube Archivist requests) and turns remote keys into window.__androidAction().
// This file does the same jobs in JavaScript so the shared web UI runs unchanged:
//
//  - EasyPlexVideo for live TV, backed by AVPlay, with an HTML banner and menus
//    drawn above the video while the web UI is hidden;
//  - remote keys: hold OK for options, and the live TV key routing
//    (Right = audio/subtitles, Play/Pause act on the stream directly);
//  - app hidden/shown -> window.__easyplexLifecycle('stop' | 'start').
//
// Films and VOD use platform/player.js (AVPlay under the web page's own OSD),
// so EasyPlexVideo deliberately has no setHud/hideHud.

import { actionFor, registerKeys, setScreenSaver } from './platform/device.js';
import { avplayAvailable, avplayOwner, claimAvplay, releaseAvplay } from './platform/avplay.js';

const LONG_PRESS_MS = 600;
const HUD_HIDE_MS = 5000;
const PREPARE_STALL_MS = 15000;   // AVPlay opening an HTTP TS can take a few seconds
const BUFFER_STALL_MS = 10000;

let layer = null, videoObj = null, hud = null, hudTitle = null, hudText = null, hudBar = null, hudFill = null, subsEl = null;
let hudTimer = 0;

// ---- DOM ------------------------------------------------------------------------

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function ensureLayer() {
  if (layer) return;
  layer = el('div', 'ep-tv', document.body);
  layer.id = 'ep-tv';
  subsEl = el('div', 'ep-tv-subs', layer);
  hud = el('div', 'ep-tv-hud', layer);
  hudTitle = el('div', 'ep-tv-hud-title', hud);
  hudText = el('div', 'ep-tv-hud-text', hud);
  hudBar = el('div', 'ep-tv-hud-bar', hud);
  hudFill = el('div', 'ep-tv-hud-fill', hudBar);
}

function setVideoMode(on) {
  document.documentElement.classList.toggle('ep-video', on);
  if (!on) {
    hideHud();
    closeMenu();
    if (subsEl) subsEl.textContent = '';
  }
}

// ---- now/next banner (the HUD) ----------------------------------------------------

const live = { open: false, mode: false, ready: false, error: null, banner: null, progress: -1,
  url: '', token: null, stallTimer: 0, bufferSince: 0, playing: false };

function showHud() {
  if (!hud || !live.open) return;
  renderHud();
  hud.classList.add('on');
  clearTimeout(hudTimer);
  if (!live.error) hudTimer = setTimeout(() => { if (live.playing) hideHud(); }, HUD_HIDE_MS);
}

function hideHud() {
  clearTimeout(hudTimer);
  if (hud) hud.classList.remove('on');
}

function renderHud() {
  if (!hud) return;
  let text;
  if (live.error) text = 'Playback failed: ' + live.error;
  else if (live.mode) text = live.banner == null ? 'Live TV' : live.banner;
  else text = live.ready ? 'Playing' : 'Opening stream…';
  const lines = String(text).split('\n');
  hudTitle.textContent = lines.length > 1 ? lines[0] : '';
  hudTitle.style.display = lines.length > 1 ? '' : 'none';
  hudText.textContent = (lines.length > 1 ? lines.slice(1) : lines).join('\n');
  const p = live.error ? -1 : live.progress;
  hudBar.style.display = p >= 0 ? '' : 'none';
  if (p >= 0) hudFill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, p / 1000)).toFixed(4) + ')';
}

// ---- options list over the video ------------------------------------------------------

let menu = null;   // { el, items, index, onPick }

function openMenu(title, labels, onPick, eyebrow) {
  ensureLayer();
  closeMenu();
  const overlay = el('div', 'hx-dialog ep-tv-menu', layer);
  const box = el('div', 'hx-dlg hx-menu', overlay);
  el('div', 'hx-dlg-eyebrow', box).textContent = eyebrow || 'OPTIONS';
  const t = el('h2', 'hx-dlg-title ep-options-title', box);
  t.textContent = title || '';
  if (!title) t.style.display = 'none';
  const list = el('div', 'hx-menu-list', box);
  el('div', 'hx-dlg-hint', box).textContent = '▲▼ choose · OK select · Back close';
  menu = { el: overlay, list, items: labels, index: 0, onPick };
  renderMenu();
}

function renderMenu() {
  if (!menu) return;
  menu.list.textContent = '';
  const first = Math.max(0, Math.min(menu.index - 3, menu.items.length - 7));
  menu.items.slice(first, first + 7).forEach((label, i) => {
    el('div', 'hx-btn hx-menu-item' + (first + i === menu.index ? ' focus' : ''), menu.list).textContent = label;
  });
}

function closeMenu() {
  if (menu && menu.el.parentNode) menu.el.parentNode.removeChild(menu.el);
  menu = null;
}

function menuKey(action) {
  if (!menu) return;
  if (action === 'up') menu.index = Math.max(0, menu.index - 1);
  else if (action === 'down') menu.index = Math.min(menu.items.length - 1, menu.index + 1);
  else if (action === 'enter') {
    const pick = menu.onPick, i = menu.index;
    closeMenu();
    pick(i);
    return;
  } else if (action === 'back') { closeMenu(); return; }
  renderMenu();
}

// ---- AVPlay tracks (Right while watching live TV; hold OK during a VOD film) ---------

function parseExtra(t) {
  try { return JSON.parse(t.extra_info) || {}; } catch (e) { return {}; }
}

function trackList(type) {
  let info = [];
  try { info = webapis.avplay.getTotalTrackInfo() || []; } catch (e) { info = []; }
  return info.filter(t => t.type === type);
}

function trackLabel(t) {
  const x = parseExtra(t);
  const lang = x.language || x.track_lang || 'Unknown';
  const bits = [lang];
  if (x.fourCC) bits.push(String(x.fourCC));
  if (x.channels) bits.push(x.channels + 'ch');
  return bits.join(' - ');
}

function chooseTracks(type) {
  const tracks = trackList(type);
  const labels = tracks.map(trackLabel);
  if (type === 'TEXT') labels.unshift('Off');
  if (!tracks.length) { openMenu(type === 'AUDIO' ? 'Audio tracks' : 'Subtitles', ['No selectable tracks'], () => {}); return; }
  openMenu(type === 'AUDIO' ? 'Audio tracks' : 'Subtitles', labels, i => {
    try {
      if (type === 'TEXT' && i === 0) { webapis.avplay.setSilentSubtitle(true); if (subsEl) subsEl.textContent = ''; }
      else {
        const t = tracks[type === 'TEXT' ? i - 1 : i];
        webapis.avplay.setSelectTrack(type, t.index);
        if (type === 'TEXT') webapis.avplay.setSilentSubtitle(false);
      }
    } catch (e) { /* track switch refused */ }
    showHud();
  });
}

function videoInfo() {
  let line = 'Not available';
  try {
    const v = (webapis.avplay.getCurrentStreamInfo() || []).filter(s => s.type === 'VIDEO')[0];
    if (v) {
      const x = parseExtra(v);
      line = (x.Width || '?') + 'x' + (x.Height || '?') + ' • ' + (x.fourCC || 'video') +
        (x.Bit_rate ? ' • ' + Math.round(Number(x.Bit_rate) / 1000) + ' kbps' : '');
    }
  } catch (e) { /* not playing */ }
  return line;
}

function showTrackMenu() {
  openMenu('Playback settings', ['Audio tracks', 'Subtitles', 'Video information'], i => {
    if (i === 0) chooseTracks('AUDIO');
    if (i === 1) chooseTracks('TEXT');
    if (i === 2) openMenu('Video information', [videoInfo(), 'Back'], () => showTrackMenu());
  });
}

// ---- the EasyPlexVideo bridge -------------------------------------------------------

function videoEvent(name, value) {
  if (window.__easyplexVideoEvent) window.__easyplexVideoEvent(name, value);
}

function liveFailed(msg) {
  if (window.__easyplexLivePlayError) window.__easyplexLivePlayError(msg);
}

function clearStall() {
  clearTimeout(live.stallTimer);
  live.stallTimer = 0;
}

function stalled() {
  if (!live.open) return;
  clearStall();
  live.error = 'Native decode stalled (no video after ' + Math.round((live.ready ? BUFFER_STALL_MS : PREPARE_STALL_MS) / 1000) + 's)';
  showHud();
  videoEvent('error', 'NATIVE_STALL');
  liveFailed('NATIVE_STALL');
}

function playbackFailed(msg) {
  if (!live.open) return;
  clearStall();
  live.playing = false;
  setScreenSaver(true);
  live.error = String(msg || 'AVPlay error');
  showHud();
  videoEvent('error', live.error);
  liveFailed(live.error);
}

function closeVideo() {
  clearStall();
  const wasOpen = live.open;
  live.open = false;
  live.mode = false;
  live.ready = false;
  live.playing = false;
  live.error = null;
  live.banner = null;
  live.progress = -1;
  if (live.token) { releaseAvplay(live.token); live.token = null; }
  if (videoObj && videoObj.parentNode) videoObj.parentNode.removeChild(videoObj);
  videoObj = null;
  if (wasOpen) setScreenSaver(true);
  setVideoMode(false);
}

function openVideo(url) {
  closeVideo();
  ensureLayer();
  // AVPlay's display object exists only while live TV plays, so films (which
  // add their own in the player screen) never find two on the page.
  videoObj = el('object', 'av-object ep-tv-video', null);
  videoObj.type = 'application/avplayer';
  layer.insertBefore(videoObj, layer.firstChild);
  const av = webapis.avplay;
  live.open = true;
  live.url = url;
  live.token = claimAvplay('live', () => { live.token = null; closeVideo(); });
  setVideoMode(true);
  showHud();
  try {
    av.open(url);
    av.setDisplayRect(0, 0, 1920, 1080);
    av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
    try { av.setSilentSubtitle(true); } catch (e) { /* no subtitle support */ }
    av.setListener({
      onbufferingstart: () => {
        live.bufferSince = Date.now();
        videoEvent('buffer', true);
        if (live.ready) { clearStall(); live.stallTimer = setTimeout(stalled, BUFFER_STALL_MS); }
      },
      onbufferingprogress: () => {},
      onbufferingcomplete: () => {
        live.bufferSince = 0;
        if (live.ready) clearStall();
        videoEvent('buffer', false);
      },
      oncurrentplaytime: ms => videoEvent('time', Number(ms)),
      onstreamcompleted: () => { live.playing = false; videoEvent('end', null); },
      onerror: e => playbackFailed(String(e)),
      onevent: () => {},
      onsubtitlechange: (duration, text) => { if (subsEl) subsEl.textContent = String(text || '').replace(/<[^>]+>/g, ''); },
      ondrmevent: () => {},
    });
  } catch (e) {
    playbackFailed('Could not open stream: ' + ((e && e.name) || e));
    return;
  }
  const token = live.token;
  live.stallTimer = setTimeout(stalled, PREPARE_STALL_MS);
  av.prepareAsync(() => {
    if (!live.open || live.token !== token) return;
    clearStall();
    live.ready = true;
    try { av.play(); } catch (e) { playbackFailed('Could not start: ' + ((e && e.name) || e)); return; }
    live.playing = true;
    setScreenSaver(false);
    videoEvent('ready', null);
    videoEvent('buffer', false);
    try {
      const d = av.getDuration();
      if (d > 0) videoEvent('duration', d);
    } catch (e) { /* live: no duration */ }
    renderHud();
  }, e => {
    if (!live.open || live.token !== token) return;
    playbackFailed('Stream could not be opened (' + ((e && e.name) || e) + ')');
  });
}

function httpGet(url, headers, maxBytes, timeoutMs, done) {
  const xhr = new XMLHttpRequest();
  let finished = false;
  const finish = (status, body) => { if (!finished) { finished = true; done(status, body); } };
  try {
    xhr.open('GET', url, true);
    Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]));
    xhr.timeout = timeoutMs;
    xhr.onload = () => {
      const body = String(xhr.responseText || '');
      if (body.length > maxBytes) finish(-1, 'Response too large');
      else finish(xhr.status, body);
    };
    xhr.onerror = () => finish(0, '');
    xhr.ontimeout = () => finish(0, '');
    xhr.send();
  } catch (e) { finish(0, ''); }
}

const bridge = {
  open(url) { openVideo(String(url)); },
  play() {
    if (!live.open) return;
    try { webapis.avplay.play(); live.playing = true; setScreenSaver(false); } catch (e) { /* not ready */ }
  },
  pause() {
    if (!live.open) return;
    try { webapis.avplay.pause(); live.playing = false; } catch (e) { /* not ready */ }
    showHud();
  },
  seek(ms) {
    if (!live.open) return;
    try { webapis.avplay.seekTo(Math.max(0, Math.floor(ms)), () => {}, () => {}); } catch (e) { /* live */ }
  },
  time() {
    try { return live.open ? webapis.avplay.getCurrentTime() : 0; } catch (e) { return 0; }
  },
  close() { closeVideo(); },
  exit() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
  },
  imageFailed() {},
  showKeyboard() {},
  hideKeyboard() {},
  deviceInfo() { return '{}'; },

  // Marks the stream as live TV and shows the now/next banner (progress 0-1000, or -1).
  setLiveBanner(text, progress) {
    if (!live.open) return;
    live.mode = true;
    live.banner = text == null ? null : String(text);
    live.progress = Number(progress);
    showHud();
  },

  // A list of choices over the video; the chosen index goes to __easyplexMenuChoice.
  showMenu(title, itemsJson) {
    let labels;
    try { labels = JSON.parse(itemsJson).map(String); } catch (e) { return; }
    if (!labels.length) return;
    openMenu(title, labels, i => { if (window.__easyplexMenuChoice) window.__easyplexMenuChoice(i); });
  },

  // Dispatcharr's HDHomeRun lineup (<device>/lineup.json), same checks as Android.
  loadHdhrLineup(deviceUri) {
    const reply = payload => setTimeout(() => { if (window.__easyplexHdhrLineup) window.__easyplexHdhrLineup(payload); }, 0);
    const fail = msg => reply(JSON.stringify({ error: msg }));
    let endpoint;
    try {
      const m = /^(https?:\/\/[^?#]*?)\/*(?:[?#].*)?$/i.exec(String(deviceUri));
      if (!m) throw new Error('Tuner URL must be HTTP(S)');
      if (!/\/hdhr$/i.test(m[1])) throw new Error('Tuner URL does not end in /hdhr');
      endpoint = m[1] + '/lineup.json';
    } catch (e) { fail('IllegalArgumentException: ' + e.message); return; }
    httpGet(endpoint, {}, 500000, 12000, (status, body) => {
      if (status !== 200) { fail('IOException: HDHR lineup ' + (status > 0 ? 'HTTP ' + status : status < 0 ? body : 'unreachable')); return; }
      try { JSON.parse(body); } catch (e) { fail('JSONException: lineup is not JSON'); return; }
      reply(body);
    });
  },

  // Tube Archivist / public SponsorBlock lookups, same URL checks as Android.
  fetchSponsor(endpoint, token, requestId) {
    const reply = (status, body) => setTimeout(() => {
      const cbs = window.__easyplexSponsorCallbacks;
      if (cbs && cbs[requestId]) cbs[requestId](status, body);
    }, 0);
    const m = /^(https?):\/\/([^/:?#]+)(?::\d+)?(\/[^?#]*)/i.exec(String(endpoint));
    const path = m ? m[3] : '';
    const ta = /^\/api\/video\/[A-Za-z0-9_-]{11}\/$/.test(path);
    const sb = !!m && m[2].toLowerCase() === 'sponsor.ajay.app' && /^\/api\/skipSegments\/[0-9a-f]{4}$/.test(path);
    if (!m || !(ta || sb)) { reply(0, ''); return; }
    httpGet(endpoint, token ? { Authorization: 'Token ' + token } : {}, 1024 * 1024, 7000,
      (status, body) => reply(status > 0 ? status : 0, status === 200 ? body : ''));
  },
};

// ---- keys -------------------------------------------------------------------------------

let selectHeld = false, selectLongSent = false, selectTimer = 0;

function send(action) {
  if (window.__androidAction) window.__androidAction(action);
}

function vodFilmPlaying() {
  return avplayOwner() === 'film' && !!document.querySelector('.vod-player:not(.hidden)');
}

function longPress() {
  if (!selectHeld) return;
  selectLongSent = true;
  if (menu) return;
  if (vodFilmPlaying()) showTrackMenu();
  else send('menu');
}

function typing() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}

function swallow(e) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onKeyDown(e) {
  const action = actionFor(e);
  if (!action) return;
  // Options list drawn by the shell (over live video, or a film's tracks).
  if (menu) {
    swallow(e);
    // Still holding the OK press that opened this list: wait for a fresh press.
    if (action === 'enter' && (e.repeat || selectHeld)) return;
    menuKey(action);
    return;
  }
  if (typing()) return;           // the TV keyboard and input.js handle text fields

  // OK: short press = enter (on release), hold = options.
  if (action === 'enter') {
    swallow(e);
    if (e.repeat || selectHeld) return;
    selectHeld = true;
    selectLongSent = false;
    clearTimeout(selectTimer);
    selectTimer = setTimeout(longPress, LONG_PRESS_MS);
    return;
  }

  if (live.open) {
    swallow(e);
    showHud();
    switch (action) {
      case 'right': if (!e.repeat) showTrackMenu(); return;
      case 'playpause': if (!e.repeat) { if (live.playing) bridge.pause(); else bridge.play(); } return;
      case 'play': bridge.play(); return;
      case 'pause': bridge.pause(); return;
    }
    send(action);
    return;
  }

  // Down during a VOD film opens AVPlay's track list (Android does this natively).
  if (action === 'down' && vodFilmPlaying()) {
    swallow(e);
    if (!e.repeat) showTrackMenu();
  }
  // Everything else goes through web/js/input.js as usual.
}

function onKeyUp(e) {
  if (actionFor(e) !== 'enter' || !selectHeld) return;
  swallow(e);
  clearTimeout(selectTimer);
  const wasLong = selectLongSent;
  selectHeld = false;
  selectLongSent = false;
  if (wasLong) return;
  if (live.open) showHud();
  send('enter');
}

// ---- start-up -------------------------------------------------------------------------------

export function installShell() {
  registerKeys();
  if (avplayAvailable()) window.EasyPlexVideo = bridge;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  // Leaving the app (Home, source change, screen off): live TV stops so the
  // Dispatcharr stream is released; films pause themselves.
  document.addEventListener('visibilitychange', () => {
    selectHeld = false;
    clearTimeout(selectTimer);
    if (document.hidden) {
      if (live.open) closeVideo();
      if (window.__easyplexLifecycle) window.__easyplexLifecycle('stop');
    } else if (window.__easyplexLifecycle) {
      window.__easyplexLifecycle('start');
    }
  });
  if (document.body) ensureLayer();
  else document.addEventListener('DOMContentLoaded', ensureLayer);
}

// For tests.
export const _internal = { live, bridge, closeVideo, menuOpen: () => !!menu };
