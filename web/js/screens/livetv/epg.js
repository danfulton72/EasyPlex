// Direct-from-Dispatcharr EPG. Dispatcharr publishes the guide as XMLTV at
// <base>/output/epg; this module parses that feed and turns it into the same
// "shows" shape the guide already renders from Plex, so the rest of the guide
// is source-agnostic. Everything here is pure (string ops only, no DOM and no
// network) and covered by tests/epg.test.mjs. The network fetch + source state
// live in channels.js.
//
// The XMLTV feed is flat and machine-generated, so it is parsed with regular
// expressions rather than a DOMParser: reliable in the WebView and in Node
// tests alike, and it sidesteps jsdom's partial XML support.

import { localDate, airingBounds } from './helpers.js';

const DAY_MS = 86400000;
const ATTR_RE = /([a-zA-Z:_-]+)\s*=\s*"([^"]*)"/g;
const PROG_RE = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
const CHAN_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
const TEXT_RE = /<(title|desc|category|display-name|sub-title|sub-title-en)\b[^>]*>([\s\S]*?)<\/\1>/gi;

// XMLTV timestamps are a compact wall clock plus a UTC offset in hours/minutes:
//   "20261101060000 +0000"
// Returns absolute epoch milliseconds, or NaN if it cannot be parsed.
export function xmltvTsToMillis(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/
    .exec(String(ts == null ? '' : ts).trim());
  if (!m) return NaN;
  const [, Y, Mo, D, h, mi, s, sign, oh, om] = m;
  const asUtc = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s);
  const offsetMin = (+oh * 60 + +om) * (sign === '-' ? -1 : 1);
  return asUtc - offsetMin * 60000;
}

function safeCodePoint(cp) {
  try { return String.fromCodePoint(cp); } catch (e) { return ''; }
}

// Decode XML character entities. &amp; is decoded last so &amp;lt; -> &lt;, not <.
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(str) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(str))) out[m[1].toLowerCase()] = decodeEntities(m[2]);
  return out;
}

function firstTextTags(inner) {
  const out = {};
  TEXT_RE.lastIndex = 0;
  let m;
  while ((m = TEXT_RE.exec(inner))) {
    const name = m[1];
    if (!(name in out)) out[name] = decodeEntities(m[2]).trim();
  }
  return out;
}

// Parse a Dispatcharr XMLTV document. Returns:
//   { channels: Map(id -> { id, name, icon }),
//     byChannel: Map(id -> [ { start, end, title, summary, genre } ]) }
// `start`/`end` are absolute epoch milliseconds (end falls back to start + 30m).
export function parseXmltv(xml) {
  const channels = new Map();
  const byChannel = new Map();
  const src = String(xml == null ? '' : xml);

  CHAN_RE.lastIndex = 0;
  let m;
  while ((m = CHAN_RE.exec(src))) {
    const attrs = parseAttrs(m[1]);
    const id = attrs.id;
    if (!id) continue;
    const text = firstTextTags(m[2]);
    const icon = (/<icon\b[^>]*\bsrc="([^"]*)"/i.exec(m[2]) || [])[1];
    channels.set(id, { id, name: text['display-name'] || '', icon: icon ? decodeEntities(icon) : '' });
  }

  PROG_RE.lastIndex = 0;
  while ((m = PROG_RE.exec(src))) {
    const attrs = parseAttrs(m[1]);
    const id = attrs.channel;
    if (!id) continue;
    const start = xmltvTsToMillis(attrs.start);
    if (!Number.isFinite(start)) continue;
    let end = xmltvTsToMillis(attrs.stop);
    if (!Number.isFinite(end)) end = start + 30 * 60000;
    const text = firstTextTags(m[2]);
    if (!byChannel.has(id)) byChannel.set(id, []);
    byChannel.get(id).push({
      start, end,
      title: text.title || 'Programme',
      summary: text.desc || '',
      genre: text.category || '',
      episode: text['sub-title'] || '',
    });
  }

  for (const progs of byChannel.values()) progs.sort((a, b) => a.start - b.start);
  return { channels, byChannel };
}

// Programmes for one channel that overlap the given LOCAL date, in the Plex
// "shows" shape the guide renders: { title, summary, Media: [{ beginsAt, endsAt }] }.
// Times are epoch SECONDS (matching Plex's beginsAt/endsAt, which toMillis()
// normalises to milliseconds).
export function dayShowsFor(byChannel, channelId, date) {
  const progs = (byChannel && byChannel.get(String(channelId))) || [];
  const out = [];
  for (const p of progs) {
    if (localDate(p.start) !== date && localDate(p.end - 1) !== date) continue;
    out.push({
      title: p.title,
      summary: p.summary || '',
      genre: p.genre || '',
      subtitle: p.episode || '',
      Media: [{ beginsAt: Math.floor(p.start / 1000), endsAt: Math.floor(p.end / 1000) }],
    });
  }
  return out;
}

// Candidate channel ids for a row, in the order most likely to match the
// XMLTV <channel id> / HDHR GuideNumber (the tuner number first).
export function darrIds(row) {
  return [...new Set([row?.channelVcn, row?.channelId, row?.gridKey]
    .filter(v => v != null && String(v).trim() !== '')
    .map(v => String(v).trim()))];
}

// The DVR exposes the EPG it pulls as a "lineup://" URL:
//   lineup://<epgId>/<url-encoded EPG url>#<title>
// Decode the EPG url out of it, or '' if none of the DVRs carry one.
export function extractDispatcharrEpgUrl(dvrs) {
  for (const dvr of dvrs || []) {
    const lineup = dvr && dvr.lineup;
    if (typeof lineup !== 'string' || lineup.indexOf('lineup://') !== 0) continue;
    const hashAt = lineup.indexOf('#');
    const body = hashAt === -1 ? lineup : lineup.slice(0, hashAt);
    const slash = body.indexOf('/', 'lineup://'.length);
    if (slash === -1) continue;
    let url = body.slice(slash + 1);
    try { url = decodeURIComponent(url); } catch (e) { /* keep the raw form */ }
    if (/^https?:\/\//i.test(url)) return url;
  }
  return '';
}

// Fallback: build the EPG url from the tuner's /hdhr base, which is what
// Dispatcharr fronts (it serves the feed at <base>/output/epg).
export function epgUrlFromHdhrBase(baseUri) {
  let u;
  try { u = new URL(String(baseUri || '')); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  u.pathname = (u.pathname.replace(/\/hdhr\/?$/, '') || '') + '/output/epg';
  u.search = '';
  u.searchParams.set('cachedlogos', 'false');
  u.searchParams.set('prev_days', '2');
  return u.toString();
}

// Pick the Plex airing that corresponds to a Dispatcharr-sourced programme,
// so its guid/ratingKey can be borrowed for recording. Match on the start time
// (both come from the same EPG, so the times line up); return the closest
// airing within the tolerance, else null.
export function matchPlexAiring(shows, m, toleranceMs = 5 * 60000) {
  const target = airingBounds(m).start;
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const s of shows || []) {
    const b = airingBounds(s);
    if (!Number.isFinite(b.start)) continue;
    const diff = Math.abs(b.start - target);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best && bestDiff <= toleranceMs ? best : null;
}

export { DAY_MS };
