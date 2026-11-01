// Channels: discovering the DVR, guide providers and lineup; favourites and
// which list is shown (favourites / all / a group); typing a channel number.
//
// Favourites and the chosen list are remembered on this box. Groups come from
// the "XX|" prefix Dispatcharr channel names carry (offered only if there are
// two or more). Number entry searches every channel, not just the list shown.
import { h, setText } from '../../util/dom.js';
import { getRaw, setRaw } from '../../util/store.js';
import { signOut } from '../../session.js';
import { showOptions } from '../../ui/options.js';
import { channelLabel, channelGroup, chanKey, findByNumber, epgProviderPaths, channelRowsFrom, safeObject, localDate, airingBounds } from './helpers.js';
import { parseXmltv, extractDispatcharrEpgUrl, epgUrlFromHdhrBase, matchPlexAiring } from './epg.js';

const FAV_KEY = 'easyplexLiveFavourites';
const FILTER_KEY = 'easyplexLiveFilter';
const LAST_KEY = 'easyplexLiveLastChannel';

export function createChannels(ctx) {
  let favourites = new Set();
  try { favourites = new Set(JSON.parse(getRaw(FAV_KEY) || '[]')); } catch (e) { favourites = new Set(); }
  // all = every channel; list = 'auto' | 'fav' | 'all' | 'group:<name>'.
  // debugResponses = what the discovery endpoints returned, for diagnostics.
  // epg = the Dispatcharr-direct guide source. source is 'dispatcharr' once the
  // XMLTV feed is loaded (guide programmes come straight from it) or 'plex' when
  // we fall back to Plex's copy. byChannel is the parsed feed (id -> programmes).
  const state = { dvrs: [], providers: [], all: [], list: getRaw(FILTER_KEY) || 'auto', debugResponses: [],
    epg: { source: 'plex', url: '', byChannel: null, channels: null, fetchedAt: 0, failNotified: false } };
  const digits = { value: '', timer: 0, el: null };

  // ---- loading ----------------------------------------------------------------

  // A 403 from Plex's privileged endpoints (Live TV, status) means the saved
  // sign-in has lost its scope — it still reads the library but no longer
  // authorises DVR. plex.tv rejects such tokens outright, so reconnect() can't
  // mint a fresh one; only a re-sign-in fixes it. Show that clearly and hand
  // back to the login screen instead of leaving a dead "unavailable" message.
  async function reauth(message) {
    setText(ctx.info, message);
    ctx.setView('empty');
    signOut();
    window.dispatchEvent(new Event('easyplex:restart'));
  }

  async function load() {
    ctx.el.classList.remove('ep-grid-active');
    ctx.list.innerHTML = '';
    setText(ctx.info, 'Checking Plex DVR and programme guide…');
    try {
      let d;
      try {
        d = await ctx.server.get('/livetv/dvrs');
      } catch (e) {
        if (e && e.status === 403) {
          return reauth('Plex sign-in expired for Live TV. Re-linking your account…');
        }
        throw e;
      }
      state.dvrs = d.Dvr || d.DVR || d.Directory || [];
      if (!state.dvrs.length) {
        setText(ctx.info, 'No Plex DVR found. Configure a supported tuner in Plex Media Server → Live TV & DVR.');
        ctx.setView('empty');
        return;
      }
      let providersReply = null;
      try { providersReply = await ctx.server.get('/media/providers'); } catch (e) { console.warn('Plex provider discovery:', e.message); }
      state.providers = epgProviderPaths(providersReply, state.dvrs);
      const urls = [];
      for (const prefix of state.providers) {
        urls.push(prefix + '/watchnow/all');
        urls.push(prefix + '/lineups/dvr/channels');
      }
      const replies = await Promise.allSettled(urls.map(url => ctx.server.get(url)));
      state.debugResponses = replies.map((r, i) => ({ name: urls[i], data: r.status === 'fulfilled' ? { keys: Object.keys(r.value), sample: safeObject((r.value.Metadata || r.value.Channel || r.value.Directory || [])[0] || r.value) } : { error: String(r.reason?.message || 'request failed').slice(0, 120) } }));
      const dvrId = String(state.dvrs[0]?.key || state.dvrs[0]?.id || '').replace(/^.*:/, '');
      const rows = channelRowsFrom(urls, replies, dvrId);
      if (!ctx.state.alive) return;
      if (!rows.length) {
        setText(ctx.info, 'DVR found. EPG providers: ' + state.providers.length +
          ' · Successful guide requests: ' + replies.filter(r => r.status === 'fulfilled').length +
          '/' + replies.length + '. Channel listings unavailable; press Green for diagnostics.');
        ctx.setView('empty');
        return;
      }
      state.all = rows;
      // Guide comes straight from Dispatcharr's XMLTV when we can reach it; on
      // any failure we keep Plex's cached copy and note the fallback once.
      await loadDispatcharrEpg();
      if (!ctx.state.alive) return;
      ctx.guide.activate();
    } catch (e) {
      setText(ctx.info, 'Live TV unavailable: ' + e.message);
      ctx.setView('empty');
    }
  }

  // ---- Dispatcharr-direct guide (EPG) ----------------------------------------

  // Fetch Dispatcharr's XMLTV EPG directly, bypassing Plex's cached copy. The
  // url comes from the DVR's lineup attribute (the exact feed Plex pulls from),
  // else is derived from the /hdhr device base. Bounded so an unreachable
  // Dispatcharr can't hold the guide up: on success the guide reads programmes
  // straight from the feed; on any failure we keep Plex's source and note the
  // fallback once.
  async function loadDispatcharrEpg(timeoutMs = 8000) {
    const epg = state.epg;
    const firstDevice = ((state.dvrs[0] && (state.dvrs[0].Device || state.dvrs[0].Devices)) || [])[0] || {};
    epg.url = extractDispatcharrEpgUrl(state.dvrs) || epgUrlFromHdhrBase(firstDevice.uri || '');
    if (!epg.url) { epg.source = 'plex'; return false; }
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    try {
      const response = await fetch(epg.url, { signal: controller ? controller.signal : undefined });
      if (!response.ok) throw new Error('EPG HTTP ' + response.status);
      const xml = await response.text();
      const parsed = parseXmltv(xml);
      if (!parsed.byChannel.size) throw new Error('EPG had no channels');
      epg.byChannel = parsed.byChannel;
      epg.channels = parsed.channels;
      epg.fetchedAt = Date.now();
      epg.source = 'dispatcharr';
      epg.failNotified = false;
      return true;
    } catch (err) {
      epg.source = 'plex';
      epg.failNotified = false;
      notifyEpgFallback();
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Brief, once-per-session note that the guide fell back to Plex.
  function notifyEpgFallback() {
    const epg = state.epg;
    if (epg.failNotified) return;
    epg.failNotified = true;
    ctx.say('Guide: Dispatcharr unavailable — showing Plex listings');
  }

  // Borrow a Plex guid for a Dispatcharr-sourced programme so it can still be
  // recorded. The displayed guide has no Plex guid; one targeted grid fetch for
  // the channel/day, matched by start time, yields the Plex airing to borrow the
  // guid/ratingKey from. Resolves true once m has a usable guid.
  async function resolveGuid(row, m) {
    if (!row || !m) return false;
    if (m.guid || m.ratingKey) return true;
    const target = airingBounds(m).start;
    const date = Number.isFinite(target) ? localDate(target) : localDate(Date.now());
    for (const prefix of state.providers) {
      try {
        const data = await ctx.server.get(prefix + '/grid', { channelGridKey: row.gridKey, date });
        const shows = data.Metadata || data.Airing || data.Media || [];
        const hit = matchPlexAiring(shows, m);
        if (!hit) continue;
        if (hit.guid) m.guid = hit.guid;
        if (hit.ratingKey) m.ratingKey = hit.ratingKey;
        if (hit.grandparentGuid) m.grandparentGuid = hit.grandparentGuid;
        if (m.guid || m.ratingKey) return true;
      } catch (e) { /* try the next provider */ }
    }
    return false;
  }

  // ---- favourites and lists ---------------------------------------------------

  function isFavourite(row) { return favourites.has(chanKey(row)); }

  function groups() {
    const out = [];
    for (const r of state.all) { const name = channelGroup(r); if (name && !out.includes(name)) out.push(name); }
    return out.length > 1 ? out : [];
  }

  // The list actually shown ("auto" means favourites once there are any).
  function effectiveList() {
    const l = state.list;
    if (l === 'auto') return favourites.size ? 'fav' : 'all';
    if (l === 'fav' && !favourites.size) return 'all';
    if (l.startsWith('group:') && !groups().includes(l.slice(6))) return 'all';
    return l;
  }
  function listLabel(l) {
    if (l === 'fav') return 'Favourites';
    if (l.startsWith('group:')) return l.slice(6) + ' channels';
    return 'All channels';
  }
  function listName() { return listLabel(effectiveList()); }
  function showingFavourites() { return effectiveList() === 'fav'; }

  // Rebuild the guide's rows for the current list, keeping keepRow selected.
  function applyList(keepRow) {
    const l = effectiveList();
    let rows = state.all;
    if (l === 'fav') rows = state.all.filter(isFavourite);
    else if (l.startsWith('group:')) rows = state.all.filter(r => channelGroup(r) === l.slice(6));
    ctx.guide.setRows(rows.length ? rows : state.all, keepRow);
  }

  function refreshGuide() {
    if (ctx.state.view === 'grid') { ctx.guide.render(); ctx.guide.fill(); }
  }

  function setList(l) {
    state.list = l;
    setRaw(FILTER_KEY, l);
    applyList(ctx.guide.currentRow());
    refreshGuide();
    ctx.say('Showing ' + listName().toLowerCase());
  }

  function toggleFavourite(row) {
    if (!row) return;
    const k = chanKey(row);
    const adding = !favourites.has(k);
    // Keep showing the current list; the default ("auto") switches to
    // favourites the next time Live TV opens.
    if (state.list === 'auto') state.list = effectiveList();
    if (adding) favourites.add(k); else favourites.delete(k);
    setRaw(FAV_KEY, JSON.stringify([...favourites]));
    const name = channelLabel(row.name || row.channel);
    const watching = ctx.state.view === 'playing';
    if (watching) ctx.playback.banner(row, adding ? '★ Added to favourites' : 'Removed from favourites');
    else ctx.say(adding ? '★ ' + name + ' added to favourites' : name + ' removed from favourites');
    // Removing the last favourite while viewing favourites falls back to all.
    applyList(watching ? ctx.playback.state.playing : ctx.guide.currentRow());
    refreshGuide();
  }

  function openListMenu() {
    const l = effectiveList();
    showOptions({
      eyebrow: 'CHANNELS', title: 'Show channels',
      items: [
        { label: favourites.size ? 'Favourites  (' + favourites.size + ')' : 'Favourites  (none yet)', checked: l === 'fav',
          run: () => favourites.size ? setList('fav') : ctx.say('Hold OK on a channel and choose “Add to favourites”') },
        { label: 'All channels  (' + state.all.length + ')', checked: l === 'all', run: () => setList('all') },
        ...groups().map(name => ({ label: name + '  (' + state.all.filter(r => channelGroup(r) === name).length + ')',
          checked: l === 'group:' + name, run: () => setList('group:' + name) })),
      ],
    });
  }

  function lastChannelKey() { return getRaw(LAST_KEY); }
  function rememberLastChannel(row) { setRaw(LAST_KEY, chanKey(row)); }

  // ---- number entry -------------------------------------------------------------

  function showDigits() {
    const row = findByNumber(state.all, digits.value);
    if (ctx.state.view === 'playing') {
      const v = ctx.native();
      if (row) ctx.playback.banner(row, 'Channel ' + digits.value);
      else if (v && v.setLiveBanner) v.setLiveBanner('Channel ' + digits.value + ' …', -1);
      return;
    }
    if (!digits.el) digits.el = h('div', 'hx-digits', ctx.el);
    digits.el.textContent = '';
    h('b', '', digits.el).textContent = digits.value;
    h('span', '', digits.el).textContent = row ? channelLabel(row.name || row.channel) : '…';
    digits.el.style.display = '';
  }
  function hideDigits() { if (digits.el) digits.el.style.display = 'none'; }

  function addDigit(d) {
    digits.value = (digits.value + d).slice(-6);
    clearTimeout(digits.timer);
    showDigits();
    digits.timer = setTimeout(commitDigits, 1800);
  }
  function cancelDigits() {
    clearTimeout(digits.timer);
    digits.value = '';
    hideDigits();
    const playing = ctx.playback.state.playing;
    if (ctx.state.view === 'playing' && playing) ctx.playback.banner(playing);
  }
  function commitDigits() {
    clearTimeout(digits.timer);
    const n = digits.value;
    digits.value = '';
    hideDigits();
    const row = findByNumber(state.all, n);
    const watching = ctx.state.view === 'playing';
    if (!row) {
      const playing = ctx.playback.state.playing;
      if (watching && playing) ctx.playback.banner(playing, 'No channel ' + n);
      else ctx.say('No channel ' + n);
      return;
    }
    if (!ctx.guide.state.rows.includes(row)) {
      state.list = 'all';
      setRaw(FILTER_KEY, 'all');
      applyList(row);
      ctx.say('Showing all channels');
    }
    if (watching) ctx.playback.tuneNow(row);
    else if (ctx.state.view === 'grid') { ctx.guide.selectRow(row); ctx.guide.render(); ctx.guide.fill(); }
  }

  // Digits, and OK/Back while a number is being typed, in the guide or while watching.
  function digitKey(action) {
    if (/^digit\d$/.test(action)) { addDigit(action.slice(5)); return true; }
    if (digits.value && action === 'enter') { commitDigits(); return true; }
    if (digits.value && action === 'back') { cancelDigits(); return true; }
    return false;
  }

  function destroy() { clearTimeout(digits.timer); }

  return {
    state, load, loadDispatcharrEpg, notifyEpgFallback, resolveGuid,
    isFavourite, listName, showingFavourites, applyList, toggleFavourite, openListMenu,
    lastChannelKey, rememberLastChannel, digitKey, destroy,
  };
}
