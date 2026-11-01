// The guide grid: channel rows against a two-hour timeline, the info panel for
// the selected programme, guide data fetching and caching, moving by programme.
import { h } from '../../util/dom.js';
import {
  SLOT, HOUR, DAY, GUIDE_TTL, SPAN, ROWS, localDate, airingBounds, airingIn, hhmm, dayLabel, mins,
  titleOf, mainTitle, subTitle, channelLabel, chanKey, scheduledGuidSet,
} from './helpers.js';
import { darrIds, dayShowsFor } from './epg.js';

// Guide days survive leaving and reopening Live TV during one app session.
// Keys are "<local YYYY-MM-DD>:<gridKey>", values { time, shows }.
const sharedGuideCache = new Map();

const slotFloor = t => Math.floor(t / SLOT) * SLOT;
const minFocus = () => slotFloor(Date.now());
const maxFocus = () => Date.now() + 7 * DAY;

export function createGuide(ctx) {
  const cache = sharedGuideCache;
  // rows = channels in the current list; index = selected row; top = first
  // visible row; focusTime = the cursor's moment; windowStart = timeline start.
  const state = { rows: [], index: 0, top: 0, focusTime: 0, windowStart: 0, scheduledGuids: new Set() };
  let gridEl = null, clockTimer = 0;
  const g = {};

  // ---- data -----------------------------------------------------------------

  function cached(date, row) { return cache.get(date + ':' + row.gridKey); }

  function airingAt(row, when) {
    if (!row?.gridKey) return null;
    for (const date of [localDate(when), localDate(when - DAY), localDate(when + DAY)]) {
      const hit = airingIn(cached(date, row)?.shows || [], when);
      if (hit) return hit;
    }
    return null;
  }

  async function fetchDay(row, date) {
    const cacheKey = date + ':' + row.gridKey;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.time < GUIDE_TTL) return hit.shows;
    // Prefer Dispatcharr's own EPG when it loaded and carries this channel —
    // the guide's programme data comes straight from it, not from Plex.
    const epg = ctx.channels.state.epg;
    if (epg.source === 'dispatcharr' && epg.byChannel) {
      const id = darrIds(row).find(x => epg.byChannel.has(x));
      if (id) {
        const shows = dayShowsFor(epg.byChannel, id, date);
        cache.set(cacheKey, { time: Date.now(), shows });
        return shows;
      }
      // This channel isn't in the feed: serve it from Plex below (silent — a
      // single missing channel isn't the same as Dispatcharr being down).
    }
    let anyOk = false;
    for (const prefix of ctx.channels.state.providers) {
      try {
        const data = await ctx.server.get(prefix + '/grid', { channelGridKey: row.gridKey, date });
        anyOk = true;
        const shows = data.Metadata || data.Airing || data.Media || [];
        if (shows.length) {
          cache.set(cacheKey, { time: Date.now(), shows });
          return shows;
        }
      } catch (e) { /* try next provider */ }
    }
    // Remember genuinely empty days so they are not re-requested on every key press.
    if (anyOk) cache.set(cacheKey, { time: Date.now(), shows: [] });
    return [];
  }

  const pending = new Set();
  let renderQueued = false, fillToken = 0;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; if (ctx.state.alive && ctx.state.view === 'grid') render(); }, 350);
  }

  // Fetch every local date the visible window touches (plus a margin before it,
  // in case the server files late-night programmes under the UTC date), visible
  // channels first. A newer call supersedes older workers so priority follows
  // the cursor.
  async function fill() {
    const token = ++fillToken;
    const start = state.windowStart, end = state.windowStart + SPAN;
    const dates = [...new Set([localDate(start - 2 * HOUR), localDate(start), localDate(end)])];
    const rows = state.rows;
    const ordered = rows.slice(state.top, state.top + ROWS)
      .concat(rows.slice(0, state.top), rows.slice(state.top + ROWS));
    const jobs = [];
    for (const row of ordered) if (row?.gridKey) for (const date of dates) jobs.push({ row, date });
    let next = 0;
    async function worker() {
      while (next < jobs.length && ctx.state.alive && token === fillToken) {
        const { row, date } = jobs[next++];
        const key = date + ':' + row.gridKey;
        const hit = cache.get(key);
        if ((hit && Date.now() - hit.time < GUIDE_TTL) || pending.has(key)) continue;
        pending.add(key);
        try { await fetchDay(row, date); queueRender(); }
        finally { pending.delete(key); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, () => worker()));
  }

  // Programmes overlapping [a, b) on a channel, from whichever cached days hold them.
  function showsBetween(row, a, b) {
    if (!row?.gridKey) return [];
    const seen = new Set(), out = [];
    for (const date of new Set([localDate(a - DAY), localDate(a), localDate(b)])) {
      for (const m of cached(date, row)?.shows || []) {
        const bd = airingBounds(m);
        if (!Number.isFinite(bd.start) || bd.end <= a || bd.start >= b) continue;
        const k = bd.start + ':' + titleOf(m);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ m, start: bd.start, end: bd.end });
      }
    }
    return out.sort((x, y) => x.start - y.start);
  }

  function isScheduled(m) {
    return !!m && ((m.guid && state.scheduledGuids.has(m.guid)) || (m.grandparentGuid && state.scheduledGuids.has(m.grandparentGuid)));
  }

  // Best effort: which programmes (and series) are set to record, for the red dots.
  async function loadScheduled() {
    try {
      state.scheduledGuids = scheduledGuidSet(await ctx.server.get('/media/subscriptions/scheduled'));
      if (ctx.state.alive && ctx.state.view === 'grid') render();
    } catch (e) { /* no markers */ }
  }

  function selected() {
    const row = state.rows[state.index];
    if (!row) return null;
    return { row, programme: airingAt(row, state.focusTime) };
  }

  function currentRow() { return state.rows[state.index] || null; }

  // Replace the channel list, keeping keepRow selected if it is in it.
  function setRows(rows, keepRow) {
    state.rows = rows;
    const keep = keepRow ? rows.indexOf(keepRow) : -1;
    state.index = keep >= 0 ? keep : Math.min(state.index, Math.max(0, rows.length - 1));
    state.top = Math.max(0, state.index - 3);
  }

  function selectRow(row) {
    const i = state.rows.indexOf(row);
    if (i >= 0) state.index = i;
  }

  // ---- drawing --------------------------------------------------------------

  function build() {
    gridEl = h('div', 'hx-grid', ctx.el);
    const top = h('div', 'hx-top', gridEl);
    g.head = h('div', 'hx-title', top);
    g.head.textContent = 'Live TV';
    g.clock = h('div', 'hx-clock', top);
    const panel = h('section', 'hx-info', gridEl);
    const main = h('div', 'hx-info-main', panel);
    g.ch = h('div', 'hx-info-ch', main);
    g.title = h('h2', 'hx-info-title', main);
    g.sub = h('div', 'hx-info-sub', main);
    g.meta = h('div', 'hx-info-meta', main);
    const side = h('div', 'hx-info-side', panel);
    g.summary = h('p', 'hx-info-summary', side);
    g.chips = h('div', 'hx-chips', side);
    const times = h('div', 'hx-times', gridEl);
    g.day = h('div', 'hx-day', times);
    g.hours = h('div', 'hx-hours', times);
    g.rows = h('div', 'hx-rows', gridEl);
    const keys = h('footer', 'hx-keys', gridEl);
    const key = (label, kind, value) => {
      const item = h('span', '', keys);
      const k = h('span', kind, item);
      if (kind === 'hx-dot') k.style.background = value; else k.textContent = value;
      item.appendChild(document.createTextNode(label));
    };
    key('Watch', 'hx-key', 'OK');
    key('Record', 'hx-dot', '#E5383B');
    key('Channels', 'hx-glyph', '▲▼');
    key('Programmes', 'hx-glyph', '◀▶');
    key('Day', 'hx-glyph', 'FF RW');
    key('Number', 'hx-glyph', '0–9');
    key('More', 'hx-key', 'Hold OK');
    h('span', 'hx-sp', keys);
    key('Diagnostics', 'hx-dot', '#2FA84F');
    key('Day guide', 'hx-dot', '#F2C230');
    key('Recordings', 'hx-dot', '#3A7BE0');
  }

  function renderInfo(row, p) {
    const now = Date.now();
    g.ch.textContent = (ctx.channels.isFavourite(row) ? '★ ' : '') + channelLabel(row.name || row.channel) +
      (row.channelVcn ? '  ·  ' + row.channelVcn : '');
    g.meta.textContent = '';
    g.chips.textContent = '';
    if (!p) {
      const onNow = state.focusTime <= now + 60000 && row.title;
      g.title.textContent = onNow ? row.title : 'No programme information';
      g.sub.textContent = '';
      g.summary.textContent = onNow ? (row.subtitle && row.subtitle !== row.title ? row.subtitle : '') :
        (row.gridKey ? (cached(localDate(state.focusTime), row) ? 'The guide has nothing listed for this time.' : 'Loading guide…') :
          'This channel has no guide data in Plex.');
      return;
    }
    const { start, end } = airingBounds(p);
    g.title.textContent = mainTitle(p);
    g.sub.textContent = subTitle(p);
    const when = (localDate(start) === localDate(now) ? '' : dayLabel(start) + ' ') + hhmm(start) + ' – ' + hhmm(end);
    h('span', '', g.meta).textContent = when;
    if (start <= now && end > now) {
      const bar = h('div', 'hx-bar', g.meta);
      h('i', '', bar).style.width = Math.round((now - start) / (end - start) * 100) + '%';
      h('span', '', g.meta).textContent = mins(end - now) + ' left';
    } else if (start > now) {
      h('span', '', g.meta).textContent = (start - now < DAY ? 'Starts in ' + mins(start - now) : mins(end - start));
    }
    g.summary.textContent = p.summary || '';
    const chips = [];
    if (isScheduled(p)) chips.push(['● Recording', 'rec']);
    for (const genre of (p.Genre || []).slice(0, 3)) if (genre?.tag) chips.push([genre.tag, '']);
    if (p.year) chips.push([String(p.year), '']);
    chips.push([mins(end - start), '']);
    for (const [text, cls] of chips) h('span', cls, g.chips).textContent = text;
  }

  function render() {
    if (!gridEl) build();
    ctx.el.classList.remove('ep-sched-active');
    ctx.el.classList.add('ep-grid-active');
    const now = Date.now();
    g.clock.textContent = new Date(now).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ';
    h('b', '', g.clock).textContent = hhmm(now);
    // Keep the selected row inside the visible window: no measuring, no scrolling.
    if (state.index < state.top) state.top = state.index;
    if (state.index >= state.top + ROWS) state.top = state.index - ROWS + 1;
    state.top = Math.max(0, Math.min(state.top, Math.max(0, state.rows.length - ROWS)));
    const a = state.windowStart, b = state.windowStart + SPAN;
    const pct = t => ((t - a) / SPAN * 100).toFixed(3) + '%';
    const listName = ctx.channels.listName();
    g.head.textContent = 'Live TV  ·  ' + listName;
    g.day.textContent = dayLabel(a).toUpperCase();
    g.hours.textContent = '';
    for (let k = 0; k < 4; k++) {
      const span = h('span', '', g.hours);
      span.style.left = (k * 25) + '%';
      span.textContent = hhmm(a + k * SLOT);
    }
    g.rows.textContent = '';
    const sel = selected();
    const starInRows = !ctx.channels.showingFavourites();
    state.rows.slice(state.top, state.top + ROWS).forEach((row, i) => {
      const ri = state.top + i;
      const line = h('div', 'hx-row' + (ri === state.index ? ' sel' : ''), g.rows);
      const ch = h('div', 'hx-ch', line);
      h('span', 'hx-name', ch).textContent = (starInRows && ctx.channels.isFavourite(row) ? '★ ' : '') +
        channelLabel(row.name || row.channel);
      const track = h('div', 'hx-track', line);
      const shows = showsBetween(row, a, b);
      const block = (start, end, cls, title, sub, rec) => {
        if (cls === 'empty' && ri === state.index && !sel?.programme && state.focusTime >= start && state.focusTime < end) {
          cls = 'focus';
          title = title || 'No guide data';
        }
        const l = Math.max(start, a), r = Math.min(end, b);
        const node = h('div', 'hx-prog ' + cls + ((r - l) < 15 * 60000 ? ' narrow' : ''), track);
        node.style.left = pct(l);
        node.style.width = 'calc(' + pct(r) + ' - ' + pct(l) + ' - 6px)';
        h('div', 'hx-pt' + (rec ? ' rec' : ''), node).textContent = (start < a ? '‹ ' : '') + title;
        if (sub) h('div', 'hx-pm', node).textContent = sub;
      };
      if (!shows.length) {
        const label = a <= now && row.title ? row.title :
          (!row.gridKey || cached(localDate(a), row) ? 'No guide data' : 'Loading…');
        block(a, b, ri === state.index ? 'focus' : 'empty', label, '', false);
        return;
      }
      let cursor = a;
      for (const s of shows) {
        if (s.end <= cursor) continue;           // overlapping listing: keep the earlier one
        const st = s.start < cursor && cursor > a ? cursor : s.start;
        if (st >= b) continue;
        if (st > cursor) block(cursor, st, 'empty', '', '', false);
        const focused = ri === state.index && sel?.programme === s.m;
        const onNow = s.start <= now && s.end > now;
        block(st, s.end, focused ? 'focus' : onNow ? 'on' : '', titleOf(s.m),
          hhmm(s.start) + ' – ' + hhmm(s.end), isScheduled(s.m));
        cursor = Math.max(cursor, s.end);
      }
      if (cursor < b) block(cursor, b, 'empty', '', '', false);
    });
    if (now >= a && now < b) {
      const line = h('div', 'hx-now', g.rows);
      line.style.left = 'calc(272px + (100% - 272px) * ' + ((now - a) / SPAN).toFixed(4) + ')';
    }
    const row = currentRow();
    if (row) renderInfo(row, sel?.programme);
  }

  // ---- moving: by programme, not by fixed time slot --------------------------

  function revealFocus() {
    if (state.focusTime < state.windowStart) state.windowStart = Math.max(minFocus(), slotFloor(state.focusTime));
    if (state.focusTime >= state.windowStart + SPAN) state.windowStart = slotFloor(state.focusTime);
  }
  function moveRight() {
    const p = airingAt(currentRow(), state.focusTime);
    const next = p ? airingBounds(p).end : slotFloor(state.focusTime) + SLOT;
    state.focusTime = Math.min(maxFocus(), next);
    revealFocus();
  }
  function moveLeft() {
    const row = currentRow();
    const p = airingAt(row, state.focusTime);
    const cur = p ? airingBounds(p).start : slotFloor(state.focusTime);
    if (cur <= Date.now()) {               // already on what is on now
      state.focusTime = Math.max(state.focusTime, Date.now());
      state.windowStart = minFocus();
      return;
    }
    const prev = airingAt(row, cur - 1);
    state.focusTime = Math.max(Date.now(), prev ? airingBounds(prev).start : slotFloor(cur - 1));
    revealFocus();
  }
  function moveDays(n) {
    state.focusTime = Math.max(Date.now(), Math.min(maxFocus(), state.focusTime + n * DAY));
    state.windowStart = Math.max(minFocus(), slotFloor(state.focusTime));
  }

  // ---- showing --------------------------------------------------------------

  function show() {
    ctx.diagnostics.hide();
    if (!state.rows.length) { ctx.setView('loading'); ctx.channels.load(); return; }
    // Never leave the guide pointing at the past after it has been open a while.
    if (state.windowStart < minFocus()) state.windowStart = minFocus();
    if (state.focusTime < Date.now()) state.focusTime = Date.now();
    ctx.setView('grid');
    ctx.say('');
    render();
    fill();
  }

  // First show after channels load: open on the last channel watched.
  function activate() {
    ctx.channels.applyList(null);
    const last = ctx.channels.lastChannelKey();
    const lastIdx = last ? state.rows.findIndex(r => chanKey(r) === last) : -1;
    if (lastIdx >= 0) { state.index = lastIdx; state.top = Math.max(0, state.index - 3); }
    state.focusTime = Date.now();
    state.windowStart = minFocus();
    show();
    loadScheduled();
    clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (!ctx.state.alive || ctx.state.view !== 'grid') return;
      if (state.windowStart < minFocus()) state.windowStart = minFocus();
      if (state.focusTime < Date.now()) state.focusTime = Date.now();
      render();
    }, 30000);
    if (ctx.state.autoplay) {
      ctx.state.autoplay = false;
      if (lastIdx >= 0) ctx.playback.tuneRow(currentRow());
    }
  }

  function onKey(action) {
    switch (action) {
      case 'up': state.index = Math.max(0, state.index - 1); render(); if (state.index < state.top + 1) fill(); return true;
      case 'down': state.index = Math.min(state.rows.length - 1, state.index + 1); render(); if (state.index >= state.top + ROWS - 1) fill(); return true;
      case 'left': moveLeft(); render(); fill(); return true;
      case 'right': moveRight(); render(); fill(); return true;
      case 'rw': moveDays(-1); render(); fill(); return true;
      case 'ff': moveDays(1); render(); fill(); return true;
      case 'pageup': state.index = Math.max(0, state.index - ROWS); state.top = state.index; render(); fill(); return true;
      case 'pagedown': state.index = Math.min(state.rows.length - 1, state.index + ROWS); state.top = state.index; render(); fill(); return true;
      case 'enter': case 'play': case 'playpause': ctx.playback.tuneRow(currentRow()); return true;
      case 'record': case 'red': ctx.record.open(); return true;
      case 'blue': ctx.schedule.show(); return true;
      case 'yellow': ctx.dayguide.openFor(currentRow()); return true;
      case 'green': ctx.diagnostics.show(0); return true;
      case 'info': return true; // the info panel already shows the details
      case 'back': return false;
      default: return true;
    }
  }

  function destroy() { clearInterval(clockTimer); }

  return {
    state, cache, airingAt, fetchDay, fill, render, show, activate, selected, currentRow, setRows, selectRow,
    isScheduled, loadScheduled, onKey, destroy,
  };
}
