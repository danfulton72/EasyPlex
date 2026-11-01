// Video backend for Samsung Tizen: AVPlay (hardware decode straight to the
// video plane under the web page), with a <video> fallback in desktop Chrome.
// Replaces web/js/platform/player.js in the Tizen build.
//
// listener: { onTime(ms), onBuffering(bool), onEnd(), onError(msg),
//             onDuration?(ms), onSubtitle?(text, durationMs) }
//
// Films and VOD use this with the web page's own on-screen display (the page
// stays visible over the video, as in SamSUCKS). Live TV goes through the
// EasyPlexVideo bridge in tizen/js/shell.js instead.

import { avplayAvailable, claimAvplay, releaseAvplay } from './avplay.js';

function avplayBackend(container, listener) {
  const av = webapis.avplay;
  const obj = document.createElement('object');
  obj.type = 'application/avplayer';
  obj.className = 'av-object';
  container.appendChild(obj);
  let opened = false;
  let owner = null;

  const api = {
    open(url, { uhd = false } = {}) {
      api.close();
      owner = claimAvplay('film', () => { opened = false; });
      av.open(url);
      opened = true;
      av.setDisplayRect(0, 0, 1920, 1080);
      av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      if (uhd) {
        try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (e) { /* not a UHD panel */ }
      }
      av.setListener({
        onbufferingstart: () => listener.onBuffering(true),
        onbufferingprogress: () => {},
        onbufferingcomplete: () => listener.onBuffering(false),
        oncurrentplaytime: ms => listener.onTime(Number(ms)),
        onstreamcompleted: () => listener.onEnd(),
        onerror: e => listener.onError(String(e)),
        onevent: () => {},
        onsubtitlechange: (duration, text) => { if (listener.onSubtitle) listener.onSubtitle(text, Number(duration)); },
        ondrmevent: () => {},
      });
    },
    prepare() {
      return new Promise((resolve, reject) => av.prepareAsync(() => {
        try {
          const d = av.getDuration();
          if (listener.onDuration && d > 0) listener.onDuration(d);
        } catch (e) { /* live or unknown */ }
        resolve();
      }, e => reject(new Error(String((e && e.name) || e)))));
    },
    play() { try { av.play(); } catch (e) { listener.onError(String(e && e.name || e)); } },
    pause() { try { av.pause(); } catch (e) { /* not playing */ } },
    seek(ms) {
      return new Promise((resolve, reject) => av.seekTo(Math.max(0, Math.floor(ms)), resolve,
        e => reject(new Error(String((e && e.name) || e)))));
    },
    time() {
      try { return av.getCurrentTime(); } catch (e) { return 0; }
    },
    state() {
      try { return av.getState(); } catch (e) { return 'NONE'; }
    },
    tracks() {
      let info = [];
      try { info = av.getTotalTrackInfo() || []; } catch (e) { /* not prepared */ }
      return {
        audio: info.filter(t => t.type === 'AUDIO').map(t => t.index),
        text: info.filter(t => t.type === 'TEXT').map(t => t.index),
      };
    },
    selectAudio(avIndex) {
      try { av.setSelectTrack('AUDIO', avIndex); return true; } catch (e) { return false; }
    },
    selectText(avIndex) {
      try {
        if (avIndex == null) { av.setSilentSubtitle(true); return true; }
        av.setSelectTrack('TEXT', avIndex);
        av.setSilentSubtitle(false);
        return true;
      } catch (e) { return false; }
    },
    suspend() { try { av.suspend(); } catch (e) { /* not open */ } },
    restore() { try { av.restore(); } catch (e) { /* not open */ } },
    close() {
      if (!opened) return;
      opened = false;
      releaseAvplay(owner);
      owner = null;
    },
    destroy() {
      api.close();
      if (obj.parentNode) obj.parentNode.removeChild(obj);
    },
  };
  return api;
}

function videoBackend(container, listener) {
  const v = document.createElement('video');
  v.className = 'av-object';
  container.appendChild(v);
  v.addEventListener('timeupdate', () => listener.onTime(v.currentTime * 1000));
  v.addEventListener('waiting', () => listener.onBuffering(true));
  v.addEventListener('playing', () => listener.onBuffering(false));
  v.addEventListener('ended', () => listener.onEnd());
  v.addEventListener('durationchange', () => { if (listener.onDuration && isFinite(v.duration)) listener.onDuration(v.duration * 1000); });
  v.addEventListener('error', () => listener.onError('video error ' + (v.error && v.error.code)));
  return {
    open(url) { v.src = url; },
    prepare() {
      return new Promise((resolve, reject) => {
        v.addEventListener('loadedmetadata', resolve, { once: true });
        v.addEventListener('error', () => reject(new Error('load failed')), { once: true });
        v.load();
      });
    },
    play() { const p = v.play(); if (p && p.catch) p.catch(() => {}); },
    pause() { v.pause(); },
    seek(ms) { v.currentTime = ms / 1000; return Promise.resolve(); },
    time() { return v.currentTime * 1000; },
    state() { return v.paused ? 'PAUSED' : 'PLAYING'; },
    tracks() { return { audio: [], text: [] }; },
    selectAudio() { return false; },
    selectText() { return false; },
    suspend() {},
    restore() {},
    close() { v.removeAttribute('src'); v.load(); },
    destroy() { v.removeAttribute('src'); if (v.parentNode) v.parentNode.removeChild(v); },
  };
}

export function createPlayer(container, listener) {
  if (avplayAvailable()) return avplayBackend(container, listener);
  return videoBackend(container, listener);
}
