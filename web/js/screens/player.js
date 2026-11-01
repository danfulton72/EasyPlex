// Playback. Direct play whenever the TV can decode the file (hardware, zero
// server load); otherwise ask Plex for HLS with the video passed through and
// only the audio/container converted. Seeking previews locally and only
// commits once the user stops pressing, because seeks on TV players are slow.
import { DEV } from '../config.js';
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { createPlayer } from '../platform/player.js';
import { setScreenSaver, supports4K, canDecodeHW } from '../platform/device.js';
import { session } from '../session.js';
import { clock, episodeLabel, uuid } from '../util/format.js';
import * as icons from '../ui/icons.js';
import * as router from '../router.js';
import { log, warn, error } from '../util/log.js';
import { request } from '../plex/client.js';
import { parseSubtitles, CueTrack } from '../player/subtitles.js';
import { setLastPlayed } from '../util/lastplayed.js';
import { segmentsFor, skipTarget } from '../player/sponsorblock.js';

// What Android TV boxes reliably decode natively with Media3. No DTS.
// av1 is NOT listed here: it's only direct-played when the box has a HARDWARE
// decoder for it (see decideMode / canDecodeHW). A software-only AV1 decoder
// (the generic c2.android.av1.decoder) pegs the CPU and judders on mid-range
// boxes, so those fall back to Plex transcode instead. opus is safe to list —
// Android has had a built-in Opus decoder since 5.0.
const DIRECT = {
  container: { mp4: 1, m4v: 1, mkv: 1 },
  video: { h264: 1, hevc: 1 },
  audio: { aac: 1, ac3: 1, eac3: 1, mp3: 1, opus: 1 },
};
const TEXT_SUBS = { srt: 1, subrip: 1, ass: 1, ssa: 1, mov_text: 1, vtt: 1, webvtt: 1, smi: 1 };

const OSD_HIDE_MS = 4000;
const SEEK_COMMIT_MS = 900;
const TIMELINE_MS = 10000;

function streamsOf(part, type) {
  return (part && part.Stream || []).filter(s => s.streamType === type);
}

function isEmbeddedText(sub) {
  return !!sub && sub.index != null && !sub.key && !!TEXT_SUBS[sub.codec];
}

// External .srt/.ass/.vtt files: we fetch and draw these ourselves.
function isSidecarText(sub) {
  return !!sub && !!sub.key && !!TEXT_SUBS[sub.codec];
}

function subtitleLabel(s) {
  const title = s.displayTitle && s.displayTitle !== 'Unknown' ? s.displayTitle : (s.language || '');
  const kind = (s.codec || '').toUpperCase() + (s.key ? ' · external' : '');
  return title ? title + (s.key ? ' · external' : '') : kind || 'Subtitle';
}

function cleanSubtitle(text) {
  return String(text || '')
    .replace(/\{\\[^}]*\}/g, '')        // ASS override tags
    .replace(/<[^>]+>/g, '')            // <i>, <font> ...
    .replace(/\\N/g, '\n');
}

export function PlayerScreen(initial, { offset = null } = {}) {
  const el = h('div', 'screen player');
  const stage = h('div', 'player-stage', el);
  const subs = h('div', 'subs', el);
  const spinner = h('div', 'spinner', el);
  const pauseBig = h('div', 'pause-big', el);
  pauseBig.innerHTML = icons.pause;

  const osd = h('div', 'osd', el);
  const osdTop = h('div', 'osd-top', osd);
  const osdTitle = h('div', 'osd-title', osdTop);
  const osdSub = h('div', 'osd-sub', osdTop);
  const osdBottom = h('div', 'osd-bottom', osd);
  const bar = h('div', 'osd-bar', osdBottom);
  const barFill = h('div', 'osd-fill', bar);
  const knob = h('div', 'osd-knob', bar);
  const seekLabel = h('div', 'osd-seek', knob);
  const times = h('div', 'osd-times', osdBottom);
  const tNow = h('span', 'osd-now', times);
  const tInfo = h('span', 'osd-info', times);
  const tLeft = h('span', 'osd-left', times);
  const hintEl = h('div', 'osd-hint', osdBottom);
  hintEl.innerHTML = '▼ Audio &amp; subtitles';

  const panel = h('div', 'tracks hidden', el);
  const upnext = h('div', 'upnext hidden', el);
  // Failed playback: what went wrong and what to try next.
  const errorEl = h('div', 'hx-dialog ep-fail hidden', el);
  const errorBox = h('div', 'hx-dlg hx-menu', errorEl);
  h('div', 'hx-dlg-eyebrow', errorBox).textContent = 'PLAYBACK PROBLEM';
  const errorTitle = h('h2', 'hx-dlg-title', errorBox);
  const errorMsg = h('div', 'hx-dlg-sub', errorBox);
  const errorList = h('div', 'hx-menu-list', errorBox);
  h('div', 'hx-dlg-hint', errorBox).textContent = '▲▼ choose · OK select · Back to leave';
  let errorItems = [], errorIndex = 0;

  let item = initial;
  let media = null;
  let part = null;
  let mode = 'direct';
  let nativeQuality = null;
  window.__easyplexSetQuality = (bitrate, resolution) => {
    if (!alive || !media || !part) return;
    nativeQuality = bitrate > 0 ? { bitrate, resolution } : null;
    mode = nativeQuality ? 'hls' : decideMode();
    triedFallback = false;
    open(position).catch(e => failed(e.message || String(e)));
  };
  let triedFallback = false;
  let base = 0;             // stays 0: with copyts=1 the player clock is already absolute (includes the offset)
  let position = offset || 0;
  let duration = initial.duration || 0;
  let paused = false;
  let started = false;
  let alive = true;
  let audioStream = null;
  let subStream = null;
  let seekTarget = null;
  let seekCount = 0;
  let lastSeekAt = 0;
  let seekTimer = 0;
  let osdTimer = 0;
  let timelineTimer = 0;
  let subTimer = 0;
  let lastText = 0;
  let upnextTimer = 0;
  let nextItem = null;
  let cueTrack = null;
  let cueTimer = 0;
  let cueFor = null;
  const playSession = uuid();
  let sponsorSegments = [];
  const skippedSegments = new Set();
  let autoSkipping = false;

  const player = createPlayer(stage, {
    onTime(ms) {
      if (!started) return;
      let pos = base + ms;
      // Plex HLS segment timestamps can drift ahead of real time (notably on
      // transcodes), so the player may report a position past the end. Clamp it
      // to the known length so the HUD never shows "33 min of 22 min".
      if (duration > 0 && pos > duration) pos = duration;
      position = pos;
      if (seekTarget == null) renderProgress(position);
      if (started && !paused && !autoSkipping && seekTarget == null && sponsorSegments.length) {
        const skip = skipTarget(sponsorSegments, position, duration, skippedSegments);
        if (skip && skip.target > position + 300) {
          skippedSegments.add(skip.index);
          autoSkipping = true;
          jumpTo(skip.target).catch(e => warn('SponsorBlock skip failed', e.message))
            .finally(() => { autoSkipping = false; });
        }
      }
    },
    onBuffering(on) { toggleClass(spinner, 'on', on); },
    onEnd() { finished(); },
    onError(msg) { failed(msg); },
    onSubtitle(text, ms) {
      clearTimeout(subTimer);
      setText(subs, cleanSubtitle(text));
      if (ms > 0) subTimer = setTimeout(() => setText(subs, ''), ms);
    },
  });

  // --- OSD --------------------------------------------------------------

  function endsAt(ms) {
    const ends = new Date(Date.now() + Math.max(0, duration - ms));
    const pad = n => (n < 10 ? '0' : '') + n;
    return pad(ends.getHours()) + ':' + pad(ends.getMinutes());
  }

  function renderProgress(ms) {
    const p = duration ? Math.max(0, Math.min(1, ms / duration)) : 0;
    setTransform(barFill, 'scaleX(' + p.toFixed(4) + ')');
    setTransform(knob, 'translateX(' + Math.round(p * 1728) + 'px)');
    const now = Date.now();
    if (now - lastText > 900 || seekTarget != null) {
      lastText = now;
      setText(tNow, clock(ms));
      setText(tLeft, '−' + clock(duration - ms));
      setText(tInfo, 'Ends at ' + endsAt(ms));
      pushHud(false);
    }
  }

  // The native player hides this page while video plays, so mirror the OSD
  // onto its progress bar: title, times, seek preview, paused state.
  const nativeHud = () => (typeof EasyPlexVideo !== 'undefined' && EasyPlexVideo.setHud ? EasyPlexVideo : null);
  function hudTitle() {
    return item.type === 'episode' ? item.grandparentTitle + '  ·  ' + episodeLabel(item) + '  ' + item.title :
      item.title + (item.year ? '  (' + item.year + ')' : '');
  }
  function pushHud(show) {
    const n = nativeHud();
    if (!n || !started) return;
    const ms = seekTarget != null ? seekTarget : position;
    const p = duration ? Math.round(Math.max(0, Math.min(1, ms / duration)) * 1000) : -1;
    const line = (seekTarget != null ? 'Seek to ' + clock(seekTarget) + '  ·  ' : '') +
      (paused && seekTarget == null ? 'Paused  ·  ' : '') +
      clock(ms) + ' / ' + clock(duration) + '  ·  Ends ' + endsAt(ms);
    n.setHud(hudTitle(), line, p, !!show, paused || seekTarget != null);
  }

  function showOsd(sticky) {
    toggleClass(el, 'osd-on', true);
    clearTimeout(osdTimer);
    if (!sticky && !paused) osdTimer = setTimeout(() => toggleClass(el, 'osd-on', false), OSD_HIDE_MS);
    pushHud(true);
  }

  function hideOsd() {
    clearTimeout(osdTimer);
    toggleClass(el, 'osd-on', false);
    const n = nativeHud();
    if (n && n.hideHud) n.hideHud();
  }

  function renderTitles() {
    if (item.type === 'episode') {
      setText(osdTitle, item.grandparentTitle);
      setText(osdSub, episodeLabel(item) + '   ' + item.title);
    } else {
      setText(osdTitle, item.title);
      setText(osdSub, item.year || '');
    }
  }

  // --- Timeline ---------------------------------------------------------

  function report(state) {
    if (!item.ratingKey) return;
    if (DEV && window.__ss && window.__ss.muteTimeline) return;
    session.server.timeline({
      ratingKey: item.ratingKey,
      key: '/library/metadata/' + item.ratingKey,
      state,
      time: Math.floor(position),
      duration: Math.floor(duration),
      'X-Plex-Session-Identifier': playSession,
    });
  }

  function startTimeline() {
    clearInterval(timelineTimer);
    timelineTimer = setInterval(() => report(paused ? 'paused' : 'playing'), TIMELINE_MS);
  }

  // --- Opening ----------------------------------------------------------

  function decideMode() {
    // Base codecs are always direct-playable; AV1 only if this box has a
    // HARDWARE decoder for it (asked once, cached). A software-only AV1 path
    // judders on mid-range boxes, and a missing decoder risks the
    // black-screen-with-audio trap — so both cases fall back to transcode.
    const videoOk = DIRECT.video[media.videoCodec] ||
      (media.videoCodec === 'av1' && canDecodeHW('video/av01'));
    const directOk = DIRECT.container[media.container] && videoOk &&
      (!audioStream || DIRECT.audio[audioStream.codec]);
    const subsOk = !subStream || isEmbeddedText(subStream) || isSidecarText(subStream);
    return directOk && subsOk ? 'direct' : 'hls';
  }

  async function open(atMs) {
    const server = session.server;
    const t0 = Date.now();
    started = false;
    toggleClass(spinner, 'on', true);
    let url;
    if (mode === 'direct') {
      base = 0;
      url = server.url(part.key);
    } else {
      // copyts=1 makes the transcode stream's timestamps start at the offset,
      // so ExoPlayer's clock (ms) is already absolute (starts at atMs). base
      // must stay 0, or onTime (pos = base + ms) double-counts the offset and
      // the timeline jumps ahead after every skip/resume.
      base = 0;
      // Burn in only what we can't draw ourselves (image subs, embedded text).
      const burn = subStream && !isSidecarText(subStream);
      url = server.transcodeUrl(item, {
        session: playSession, offsetMs: atMs,
        audioStreamID: audioStream && audioStream.id,
        subtitleStreamID: burn ? subStream.id : undefined,
        maxBitrate: nativeQuality ? nativeQuality.bitrate : 40000,
        resolution: nativeQuality ? nativeQuality.resolution : '3840x2160',
      });
      // PMS 1.42+ rejects start.m3u8 unless a decision was made for the session first.
      const decision = await request(url.replace('/start.m3u8', '/decision'));
      const mc = decision.MediaContainer || {};
      if (mc.generalDecisionCode && mc.generalDecisionCode >= 2000) throw new Error(mc.generalDecisionText || 'Server refused to convert this file');
    }
    log('play', mode, item.title, media.container + '/' + media.videoCodec + '/' + (audioStream && audioStream.codec), 'at', clock(atMs));
    player.open(url, { uhd: media.videoResolution === '4k' && supports4K() });
    await player.prepare();
    if (!alive) return;
    if (mode === 'direct') {
      applyTracks();
      if (atMs > 0) await player.seek(atMs);
    }
    syncSidecar();
    player.play();
    paused = false;
    started = true;
    position = atMs;
    toggleClass(el, 'paused', false);
    toggleClass(spinner, 'on', false);
    log('playing after ' + (Date.now() - t0) + 'ms (' + mode + ')');
    report('playing');
    startTimeline();
    pushHud(true);
  }

  // Map Plex's chosen streams onto the player's track list (same file order).
  function applyTracks() {
    const t = player.tracks();
    if (audioStream && t.audio.length > 1) {
      const pos = streamsOf(part, 2).indexOf(audioStream);
      if (pos >= 0 && t.audio[pos] != null) player.selectAudio(t.audio[pos]);
    }
    if (isEmbeddedText(subStream)) {
      const pos = streamsOf(part, 3).filter(isEmbeddedText).indexOf(subStream);
      if (pos >= 0 && t.text[pos] != null) player.selectText(t.text[pos]);
    } else {
      player.selectText(null);
      setText(subs, '');
    }
  }

  // Start/stop drawing an external subtitle file for the current selection.
  function syncSidecar() {
    if (!isSidecarText(subStream)) {
      cueTrack = null;
      cueFor = null;
      clearInterval(cueTimer);
      if (!isEmbeddedText(subStream)) setText(subs, '');
      return;
    }
    if (cueFor === subStream) return;
    cueFor = subStream;
    const stream = subStream;
    cueTrack = null;
    fetch(session.server.url(stream.key, { encoding: 'utf-8' }))
      .then(r => r.text())
      .then(text => {
        if (cueFor !== stream || !alive) return;
        cueTrack = new CueTrack(parseSubtitles(text, stream.codec));
        log('subtitles loaded', stream.displayTitle, cueTrack.cues.length + ' cues');
      })
      .catch(e => warn('subtitle fetch failed', e.message));
    clearInterval(cueTimer);
    cueTimer = setInterval(() => {
      if (cueTrack && started) setText(subs, cueTrack.at(base + player.time()));
    }, 120);
  }

  async function start() {
    try {
      const full = await session.server.metadata(item.ratingKey);
      if (!alive) return;
      item = full;
      setLastPlayed(item);
      duration = item.duration || duration;
      media = (item.Media || [])[0];
      part = media && media.Part && media.Part[0];
      if (!part) throw new Error('No playable media');
      const audios = streamsOf(part, 2);
      audioStream = audios.find(s => s.selected) || audios[0] || null;
      subStream = null;
      renderTitles();
      mode = decideMode();
      if (offset == null) offset = item.viewOffset || 0;
      position = offset;
      // Metadata lookup must never prevent video playback.
      segmentsFor(item, part).then(segments => { if (alive) sponsorSegments = segments; })
        .catch(e => warn('SponsorBlock lookup failed', e.message));
      renderProgress(position);
      showOsd();
      await open(offset);
    } catch (e) {
      failed(e.message || String(e));
    }
  }

  function failed(msg) {
    if (!alive) return;
    if (mode === 'direct' && !triedFallback && media) {
      // The file looked direct-playable but the TV choked: let Plex convert it.
      warn('direct play failed (' + msg + '), falling back to HLS');
      triedFallback = true;
      mode = 'hls';
      open(position).catch(e => failed(e.message));
      return;
    }
    error('playback failed', msg);
    toggleClass(spinner, 'on', false);
    started = false;
    // Take the native video down so this page (and the choices) can be seen.
    try { player.close(); } catch (e) { /* already closed */ }
    showFailure(msg);
  }

  function friendly(msg) {
    const m = String(msg || '');
    if (/NATIVE_STALL|no video/i.test(m)) return 'The video started but no picture arrived. The file may use a format this box can\'t decode.';
    if (/HTTP 4\d\d|401|403/.test(m)) return 'Plex refused the request (' + m.replace(/^.*?(HTTP \d+).*$/, '$1') + ').';
    if (/HTTP 5\d\d|refused to convert|transcode/i.test(m)) return 'Plex couldn\'t prepare this video for streaming.';
    if (/network|timeout|ENOTFOUND|Failed to fetch|IO_/i.test(m)) return 'The connection to the Plex server dropped.';
    return 'Something went wrong while playing.';
  }

  function showFailure(msg) {
    setText(errorTitle, item.type === 'episode' ? item.grandparentTitle + '  ·  ' + episodeLabel(item) : (item.title || 'This video'));
    setText(errorMsg, friendly(msg) + '  (' + String(msg || 'unknown error').slice(0, 120) + ')');
    errorItems = [
      { label: 'Try again', run: () => retry(null) },
      { label: 'Try again at lower quality (720p)', run: () => retry({ bitrate: 4000, resolution: '1280x720' }) },
      { label: 'Back', run: () => exit() },
    ];
    errorIndex = 0;
    renderFailure();
    errorEl.classList.remove('hidden');
    hideOsd();
  }

  function renderFailure() {
    errorList.textContent = '';
    errorItems.forEach((it, i) => {
      h('div', 'hx-btn hx-menu-item' + (i === errorIndex ? ' focus' : ''), errorList).textContent = it.label;
    });
  }

  function retry(quality) {
    errorEl.classList.add('hidden');
    triedFallback = !!quality;           // a lower-quality retry is already a transcode
    nativeQuality = quality;
    mode = quality ? 'hls' : decideMode();
    if (!media) { start(); return; }
    open(position).catch(e => failed(e.message || String(e)));
  }

  function failureKey(action) {
    if (action === 'up') { errorIndex = Math.max(0, errorIndex - 1); renderFailure(); }
    else if (action === 'down') { errorIndex = Math.min(errorItems.length - 1, errorIndex + 1); renderFailure(); }
    else if (action === 'enter') errorItems[errorIndex].run();
    else if (action === 'back' || action === 'stop') exit();
    return true;
  }

  // Leaving the app pauses playback (and tells Plex).
  function onLifecycle(e) {
    if (e.detail === 'stop' && started && !paused) togglePause();
  }

  // --- Controls ---------------------------------------------------------

  function togglePause() {
    if (!started) return;
    if (paused) {
      player.play();
      paused = false;
      showOsd();
    } else {
      player.pause();
      paused = true;
      showOsd(true);
    }
    toggleClass(el, 'paused', paused);
    report(paused ? 'paused' : 'playing');
    pushHud(true);
  }

  function seekBy(dir) {
    if (!started) return;
    const now = Date.now();
    seekCount = now - lastSeekAt < 700 ? seekCount + 1 : 0;
    lastSeekAt = now;
    const step = seekCount < 3 ? 10000 : seekCount < 8 ? 30000 : seekCount < 16 ? 60000 : 180000;
    const from = seekTarget == null ? position : seekTarget;
    seekTarget = Math.max(0, Math.min(duration - 3000, from + dir * step));
    toggleClass(el, 'seeking', true);
    setText(seekLabel, clock(seekTarget));
    renderProgress(seekTarget);
    showOsd(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }

  async function jumpTo(target) {
    position = target;
    if (mode === 'direct') {
      await player.seek(target);
    } else {
      await open(target);
    }
  }

  async function commitSeek() {
    clearTimeout(seekTimer);
    if (seekTarget == null) return;
    const target = seekTarget;
    seekTarget = null;
    toggleClass(el, 'seeking', false);
    showOsd();
    position = target;
    // Rewinding into a segment should allow the user to watch it again.
    if (target < duration) sponsorSegments.forEach((s, i) => { if (target <= s.start) skippedSegments.delete(i); });
    try {
      if (mode === 'direct') {
        toggleClass(spinner, 'on', true);
        await jumpTo(target);
        toggleClass(spinner, 'on', false);
        if (paused) togglePause();
      } else {
        await jumpTo(target);
      }
    } catch (e) {
      warn('seek failed, reopening', e.message);
      open(target).catch(err => failed(err.message));
    }
  }

  // --- Audio / subtitle picker ------------------------------------------

  let panelCol = 0;
  let panelIndex = [0, 0];
  let panelLists = [[], []];

  function openPanel() {
    const audios = streamsOf(part, 2);
    const texts = streamsOf(part, 3);
    panelLists = [
      audios.map(s => ({ label: s.displayTitle || s.language || 'Track', stream: s, on: s === audioStream })),
      [{ label: 'Off', stream: null, on: !subStream }].concat(texts.map(s => ({ label: subtitleLabel(s), stream: s, on: s === subStream }))),
    ];
    panelIndex = panelLists.map(l => Math.max(0, l.findIndex(x => x.on)));
    panelCol = 0;
    renderPanel();
    panel.classList.remove('hidden');
    hideOsd();
  }

  function renderPanel() {
    panel.innerHTML = '';
    ['Audio', 'Subtitles'].forEach((name, c) => {
      const col = h('div', 'tracks-col', panel);
      const head = h('div', 'tracks-head', col);
      head.innerHTML = c === 0 ? icons.audio : icons.subtitles;
      h('span', '', head).textContent = name;
      panelLists[c].forEach((opt, i) => {
        const row = h('div', 'tracks-opt', col);
        row.textContent = opt.label;
        toggleClass(row, 'on', opt.on);
        toggleClass(row, 'focus', c === panelCol && i === panelIndex[c]);
      });
    });
  }

  async function choose(col, opt) {
    const server = session.server;
    if (col === 0) audioStream = opt.stream;
    else subStream = opt.stream;
    server.selectStreams(part.id, {
      audioStreamID: audioStream ? audioStream.id : undefined,
      subtitleStreamID: subStream ? subStream.id : 0,
    });
    panel.classList.add('hidden');
    const wanted = decideMode();
    if (wanted === 'direct' && mode === 'direct') {
      applyTracks();
      syncSidecar();
    } else if (mode === 'hls' && wanted === 'hls' && col === 1 && isSidecarText(subStream)) {
      syncSidecar();
    } else {
      mode = wanted;
      triedFallback = false;
      await open(position).catch(e => failed(e.message));
    }
  }

  function panelKey(action) {
    if (action === 'back' || action === 'up' && panelIndex[panelCol] === 0) { panel.classList.add('hidden'); return true; }
    if (action === 'left' || action === 'right') panelCol = action === 'left' ? 0 : 1;
    if (action === 'up') panelIndex[panelCol]--;
    if (action === 'down') panelIndex[panelCol] = Math.min(panelLists[panelCol].length - 1, panelIndex[panelCol] + 1);
    if (action === 'enter') {
      const opt = panelLists[panelCol][panelIndex[panelCol]];
      if (opt) choose(panelCol, opt);
      return true;
    }
    renderPanel();
    return true;
  }

  // --- Ending -----------------------------------------------------------

  async function nextEpisode() {
    const server = session.server;
    const eps = await server.children(item.parentRatingKey);
    const i = eps.findIndex(e => e.ratingKey === item.ratingKey);
    if (i >= 0 && i < eps.length - 1) return eps[i + 1];
    const seasons = (await server.children(item.grandparentRatingKey)).filter(s => s.type === 'season');
    const si = seasons.findIndex(s => s.ratingKey === item.parentRatingKey);
    if (si >= 0 && si < seasons.length - 1) return (await server.children(seasons[si + 1].ratingKey))[0] || null;
    return null;
  }

  async function finished() {
    position = duration;
    report('stopped');
    clearInterval(timelineTimer);
    player.close();
    if (item.type !== 'episode') { exit(); return; }
    try { nextItem = await nextEpisode(); } catch (e) { nextItem = null; }
    if (!alive) return;
    if (!nextItem) { exit(); return; }
    let left = 10;
    upnext.classList.remove('hidden');
    const render = () => {
      upnext.innerHTML = '';
      h('div', 'upnext-label', upnext).textContent = 'Up next in ' + left;
      h('div', 'upnext-title', upnext).textContent = episodeLabel(nextItem) + '   ' + nextItem.title;
      h('div', 'upnext-hint', upnext).textContent = 'OK to play now · Back to stop';
    };
    render();
    upnextTimer = setInterval(() => {
      left--;
      if (left <= 0) playNext();
      else render();
    }, 1000);
  }

  function playNext() {
    clearInterval(upnextTimer);
    router.replace(PlayerScreen(nextItem, { offset: 0 }));
  }

  function exit() {
    router.back();
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    if (started && position < duration) report('stopped');
    [seekTimer, osdTimer, subTimer].forEach(clearTimeout);
    clearInterval(timelineTimer);
    clearInterval(upnextTimer);
    clearInterval(cueTimer);
    if (window.__easyplexSetQuality) delete window.__easyplexSetQuality;
    player.destroy();
    if (mode === 'hls') session.server.stopTranscode(playSession);
    document.documentElement.classList.remove('playing');
    setScreenSaver(true);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('easyplex:lifecycle', onLifecycle);
  }

  function onVisibility() {
    if (document.hidden) {
      if (started && !paused) togglePause();
      player.suspend();
    } else {
      player.restore();
    }
  }

  return {
    el,
    name: 'player',
    onShow() {
      document.documentElement.classList.add('playing');
      setScreenSaver(false);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('easyplex:lifecycle', onLifecycle);
      renderTitles();
      if (!started) start();
    },
    onKey(action) {
      if (!errorEl.classList.contains('hidden')) return failureKey(action);
      if (!upnext.classList.contains('hidden')) {
        if (action === 'enter') { playNext(); return true; }
        if (action === 'back' || action === 'stop') { exit(); return true; }
        return true;
      }
      if (!panel.classList.contains('hidden')) return panelKey(action);
      switch (action) {
        case 'enter':
          if (seekTarget != null) commitSeek();
          else if (el.classList.contains('osd-on') || paused) togglePause();
          else showOsd();
          return true;
        case 'playpause': if (seekTarget != null) commitSeek(); else togglePause(); return true;
        case 'play': if (paused) togglePause(); return true;
        case 'pause': if (!paused) togglePause(); return true;
        case 'left': case 'rw': seekBy(-1); return true;
        case 'right': case 'ff': seekBy(1); return true;
        case 'up': case 'info': showOsd(); return true;
        case 'down': if (part) openPanel(); return true;
        case 'stop': exit(); return true;
        case 'back':
          if (seekTarget != null) { seekTarget = null; toggleClass(el, 'seeking', false); renderProgress(position); showOsd(); return true; }
          if (el.classList.contains('osd-on') && !paused) { hideOsd(); return true; }
          exit();
          return true;
      }
      return true;
    },
    onHide() {},
    destroy: teardown,
  };
}
