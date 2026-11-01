// Watching live TV: tuning (Dispatcharr HDHomeRun stream, or Plex's own
// live session), the now/next banner, zapping, the options list while
// watching, and what happens when a stream fails.
import { setText } from '../../util/dom.js';
import { showOptions, closeOptions } from '../../ui/options.js';
import { airingBounds, hhmm, titleOf, rangeOf, channelLabel, liveShape } from './helpers.js';

export function createPlayback(ctx) {
  // playing = row on screen; last = previous channel; target = where zapping
  // is heading; seq invalidates slower tune attempts; plexSession = Plex
  // transcode session to stop when leaving.
  const state = { playing: null, last: null, target: null, seq: 0, plexSession: '',
    forcePlex: false, lastSource: '' };
  let zapTimer = 0, hdhrLineup = null, hdhrPending = null;

  // Native now/next banner over the video (the WebView is hidden while playing).
  function banner(row, extra) {
    const v = ctx.native();
    if (!v || typeof v.setLiveBanner !== 'function' || !row) return;
    const now = Date.now();
    const lines = [channelLabel(row.name || row.channel)];
    let progress = -1;
    const cur = ctx.guide.airingAt(row, now);
    if (cur) {
      const b = airingBounds(cur);
      lines.push('Now   ' + rangeOf(cur) + '  ' + titleOf(cur));
      progress = Math.round(Math.max(0, Math.min(1, (now - b.start) / (b.end - b.start))) * 1000);
      const nxt = ctx.guide.airingAt(row, b.end + 1000);
      if (nxt) lines.push('Next  ' + hhmm(airingBounds(nxt).start) + '  ' + titleOf(nxt));
    } else if (row.title) {
      lines.push('Now   ' + row.title);
    }
    if (extra) lines.push(extra);
    v.setLiveBanner(lines.join('\n'), progress);
  }

  // ---- Dispatcharr ------------------------------------------------------------

  function tunerDeviceUri() {
    for (const dvr of ctx.channels.state.dvrs) {
      for (const device of dvr.Device || dvr.Devices || []) {
        if (typeof device.uri === 'string' && /\/hdhr\/?$/.test(device.uri)) return device.uri;
      }
    }
    return '';
  }

  async function getHdhrLineup() {
    if (hdhrLineup) return hdhrLineup;
    const uri = tunerDeviceUri();
    if (!uri) throw new Error('Plex DVR does not expose a Dispatcharr /hdhr device URL');
    if (!ctx.native()?.loadHdhrLineup) throw new Error('Native HDHomeRun lookup unavailable');
    if (hdhrPending) return hdhrPending;
    hdhrPending = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { window.__easyplexHdhrLineup = null; reject(new Error('HDHR lineup timed out')); }, 16000);
      window.__easyplexHdhrLineup = raw => {
        clearTimeout(timeout);
        try {
          const rows = JSON.parse(raw);
          if (!Array.isArray(rows)) throw new Error(rows.error || 'Invalid HDHR lineup response');
          hdhrLineup = rows;
          resolve(rows);
        } catch (err) { reject(err); }
        finally { window.__easyplexHdhrLineup = null; }
      };
      ctx.native().loadHdhrLineup(uri);
    });
    try { return await hdhrPending; } finally { hdhrPending = null; }
  }

  async function playDispatcharr(row, seq) {
    const rows = await getHdhrLineup();
    if (seq !== state.seq) return;
    const ids = [row.channelVcn, row.channelId, row.gridKey,
      row.item?.Media?.[0]?.channelVcn, row.item?.Media?.[0]?.channelIdentifier]
      .filter(v => v != null && String(v) !== '').map(String);
    let candidate = rows.find(r => ids.includes(String(r.GuideNumber)));
    if (!candidate) {
      const label = String(row.name || row.channel).replace(/^\s*\d+\s+/, '').trim().toLowerCase();
      candidate = rows.find(r => String(r.GuideName || '').trim().toLowerCase() === label);
    }
    if (!candidate) throw new Error('No Dispatcharr lineup match for ' + row.channel +
      ' (ids ' + ids.join(',') + '; ' + rows.length + ' available)');
    const url = String(candidate.URL || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('Channel has no HTTP stream URL');
    state.lastSource = 'direct';
    start(url, row);
  }

  // ---- Plex live session ----------------------------------------------------------

  function stopPlexSession() {
    if (!state.plexSession) return;
    const session = state.plexSession;
    state.plexSession = '';
    ctx.server.get('/video/:/transcode/universal/stop', { session }).catch(() => {});
  }

  async function playViaPlex(row, seq) {
    const dvrs = ctx.channels.state.dvrs;
    const dvr = row.dvrId || String(dvrs[0]?.key || dvrs[0]?.id || '').replace(/^.*:/, '');
    const ids = [...new Set([row.channelId, row.channelVcn, row.gridKey,
      row.item?.Media?.[0]?.channelIdentifier, row.item?.Media?.[0]?.id]
      .filter(v => v !== undefined && v !== null && String(v) !== '').map(String))];
    if (!/^\d+$/.test(dvr) || !ids.length) throw new Error('No numeric DVR ID or channel identifier; press Green for diagnostics');
    const report = ['DVR ID: ' + dvr, 'Programme: ' + row.title,
      'Channel ID: ' + String(row.channelId || 'missing'),
      'Channel VCN: ' + String(row.channelVcn || 'missing'),
      'Guide key: ' + String(row.gridKey || 'missing'),
      'Media ID: ' + String(row.item?.Media?.[0]?.id || 'missing'),
      'Candidate count: ' + ids.length];
    ctx.say('Tuning ' + row.channel + ' via DVR ' + dvr + '…');
    let data = null;
    for (const id of ids) {
      try {
        data = await ctx.api.post('/livetv/dvrs/' + encodeURIComponent(dvr) + '/channels/' + encodeURIComponent(id) + '/tune');
        report.push('Channel ' + id + ': Plex accepted response');
        break;
      } catch (err) {
        report.push('Channel ' + id + ': ' + String(err.message).replace(/<[^>]*>/g, ' ').slice(0, 160));
      }
    }
    if (seq !== state.seq) return;
    if (!data) {
      report.push('All tuning attempts rejected. No HLS request made.');
      if (ctx.state.view !== 'playing') ctx.diagnostics.showTuneReport(report);
      throw new Error('Plex rejected every tune attempt');
    }
    const subscription = (data.MediaSubscription || data.MediaContainer?.MediaSubscription || [])[0];
    const operation = subscription?.MediaGrabOperation?.[0];
    const video = operation?.Video || subscription?.Video;
    const sessionMedia = Array.isArray(video?.Media) ? video.Media[0] : video?.Media;
    const uuid = sessionMedia?.uuid || sessionMedia?.id || operation?.Metadata?.Media?.[0]?.uuid;
    if (!uuid) {
      if (ctx.state.view !== 'playing') ctx.diagnostics.showTuneReport(liveShape(data), 'Plex tuning response (no session UUID) · Back to return');
      throw new Error('Tune response had no live session');
    }
    const playbackSession = 'ep-live-' + Date.now();
    const playUrl = ctx.server.url('/video/:/transcode/universal/start.m3u8', {
      path: '/livetv/sessions/' + uuid, session: playbackSession,
      hasMDE: 1, mediaBufferSize: 102400,
      'X-Plex-Session-Identifier': playbackSession,
      protocol: 'hls', mediaIndex: 0, partIndex: 0,
      directPlay: 0, directStream: 0, directStreamAudio: 1,
      fastSeek: 1, videoQuality: 100, videoResolution: '1920x1080',
      maxVideoBitrate: 12000, subtitles: 'none',
      audioBoost: 100, location: 'lan',
    });
    const response = await fetch(playUrl.replace('/start.m3u8', '/decision'), { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const body = await response.text();
      throw new Error('Plex HLS decision HTTP ' + response.status + ' · ' + body.replace(/<[^>]*>/g, ' ').slice(0, 200));
    }
    if (seq !== state.seq) return;
    state.lastSource = 'plex';
    start(playUrl, row);
    state.plexSession = playbackSession;
  }

  // ---- starting, failing, stopping --------------------------------------------------

  function start(url, row) {
    const v = ctx.native();
    if (!v) throw new Error('Native player unavailable');
    window.__easyplexLivePlayError = failed;
    stopPlexSession();
    v.open(url);
    if (state.playing && state.playing !== row) state.last = state.playing;
    state.playing = row;
    ctx.setView('playing');
    closeOptions();
    ctx.channels.rememberLastChannel(row);
    ctx.guide.selectRow(row);
    setText(ctx.info, 'Live TV · ' + row.channel + ' · Back to close');
    banner(row);
  }

  // The native player gave up (error, or no picture after 8 seconds).
  function failed(msg) {
    if (ctx.state.view !== 'playing' || !state.playing) return;
    const failedRow = state.playing;
    const stalled = String(msg).indexOf('NATIVE_STALL') !== -1;
    stop();
    const rows = ctx.guide.state.rows;
    const i = rows.indexOf(failedRow);
    const next = rows.length > 1 ? rows[(i + 1) % rows.length] : null;
    showOptions({
      eyebrow: 'PLAYBACK PROBLEM',
      title: channelLabel(failedRow.name || failedRow.channel),
      subtitle: stalled ? 'No picture arrived within 8 seconds. This channel may use a format this box can’t decode.'
        : 'The stream stopped: ' + String(msg).slice(0, 120),
      focus: 0,
      items: [
        { label: 'Try again', run: () => tuneRow(failedRow) },
        tunerDeviceUri() && state.lastSource === 'direct' &&
          { label: 'Try via Plex (transcode)', run: () => { state.forcePlex = true; tuneRow(failedRow); state.forcePlex = false; } },
        next && { label: 'Watch next channel  (' + channelLabel(next.name || next.channel) + ')', run: () => tuneRow(next) },
        { label: 'Back to guide', run: () => {} },
      ],
    });
  }

  async function tuneRow(row) {
    if (!row) return;
    const seq = ++state.seq;
    const zapping = ctx.state.view === 'playing';
    if (!zapping) ctx.say('Tuning ' + row.channel + '…');
    const useDirect = tunerDeviceUri() && !state.forcePlex;
    if (useDirect) {
      try {
        await playDispatcharr(row, seq);
        return;
      } catch (err) {
        if (seq !== state.seq) return;
        // Dispatcharr failed (lineup, channel match, or no stream URL): fall
        // back to Plex's live session and say so briefly.
        if (zapping) banner(row, 'Dispatcharr unavailable — trying Plex…');
        else ctx.say('Dispatcharr unavailable — using Plex…');
        try {
          await playViaPlex(row, seq);
          return;
        } catch (plexErr) {
          if (seq !== state.seq) return;
          if (zapping) banner(row, 'Cannot tune: ' + plexErr.message);
          else ctx.say(row.channel + ': ' + plexErr.message);
          return;
        }
      }
    }
    try {
      await playViaPlex(row, seq);
    } catch (err) {
      if (seq !== state.seq) return;
      if (zapping) banner(row, 'Cannot tune: ' + err.message);
      else ctx.say(row.channel + ': ' + err.message);
    }
  }

  // Tune straight away, abandoning any zap in progress (number entry, Last).
  function tuneNow(row) {
    clearTimeout(zapTimer);
    state.target = null;
    tuneRow(row);
  }

  // Up/Down while watching. Presses are collected for a moment (the banner
  // shows the target straight away) so stepping several channels opens one stream.
  function zap(delta) {
    const rows = ctx.guide.state.rows;
    if (!rows.length) return;
    const from = state.target || state.playing || ctx.guide.currentRow();
    let i = rows.indexOf(from);
    if (i < 0) i = ctx.guide.state.index;
    i = (i + delta + rows.length) % rows.length;
    state.target = rows[i];
    banner(state.target);
    clearTimeout(zapTimer);
    zapTimer = setTimeout(() => {
      const target = state.target;
      state.target = null;
      if (target && target !== state.playing) tuneRow(target);
      else if (state.playing) banner(state.playing);
    }, 700);
  }

  // Close the video and go back to the guide.
  function stop() {
    clearTimeout(zapTimer);
    state.target = null;
    state.seq++;
    const v = ctx.native();
    if (v) v.close();
    stopPlexSession();
    state.playing = null;
    ctx.guide.show();
  }

  // Hold OK while watching: record what's on, favourite the channel. The web
  // page is hidden behind the video, so the list is shown natively.
  async function openMenu() {
    const v = ctx.native();
    const row = state.playing;
    if (!v || !v.showMenu || !row) return;
    const m = ctx.guide.airingAt(row, Date.now());
    const choices = [];
    if (m && (m.guid || m.ratingKey)) {
      banner(row, 'Getting recording options…');
      try {
        for (const c of await ctx.record.quickChoices(m)) choices.push([c.label, () => recordNow(c.opt, c.lib, m, row)]);
      } catch (e) {
        choices.push(['Recording unavailable (' + String(e.message).slice(0, 60) + ')', () => banner(row)]);
      }
    }
    choices.push([ctx.channels.isFavourite(row) ? 'Remove from favourites' : 'Add to favourites', () => ctx.channels.toggleFavourite(row)]);
    choices.push(['Back to guide', () => stop()]);
    if (ctx.state.view !== 'playing' || state.playing !== row) return;
    banner(row);
    window.__easyplexMenuChoice = i => { const c = choices[i]; if (c) c[1](); };
    v.showMenu(channelLabel(row.name || row.channel) + (m ? '  ·  ' + titleOf(m) : ''), JSON.stringify(choices.map(c => c[0])));
  }

  async function recordNow(opt, lib, m, row) {
    banner(row, 'Scheduling ' + titleOf(m) + '…');
    const r = await ctx.record.schedule(opt, lib, m);
    if (state.playing === row) banner(row, r.ok ? '● ' + (opt.title || 'Recording') + ' scheduled  →  ' + lib.title : 'Not scheduled: ' + r.error);
  }

  function onKey(action) {
    switch (action) {
      case 'up': case 'pageup': zap(1); return true;
      case 'down': case 'pagedown': zap(-1); return true;
      case 'left': case 'last':
        if (state.last) tuneNow(state.last);
        else banner(state.playing, 'No previous channel');
        return true;
      case 'enter': case 'info': banner(state.target || state.playing); return true;
      case 'menu': openMenu(); return true;
      case 'back': case 'stop': stop(); return true;
      default: return true;
    }
  }

  // Leaving Live TV entirely (screen destroyed) while a channel is on.
  function destroy() {
    clearTimeout(zapTimer);
    if (ctx.state.view === 'playing') { const v = ctx.native(); if (v) v.close(); stopPlexSession(); }
  }

  return { state, banner, tuneRow, tuneNow, stop, onKey, destroy };
}
