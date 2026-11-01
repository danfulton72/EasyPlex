// Unit tests for the Dispatcharr-direct EPG helpers (web/js/screens/livetv/epg.js).
// These are pure string/time helpers; pin the zone to UTC so localDate() matches
// the +0000 XMLTV sample dates exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';

import {
  xmltvTsToMillis, decodeEntities, parseXmltv, dayShowsFor, darrIds,
  extractDispatcharrEpgUrl, epgUrlFromHdhrBase, matchPlexAiring,
} from '../web/js/screens/livetv/epg.js';

const NOV1_NOON = Date.UTC(2026, 10, 1, 12, 0, 0);

test('xmltvTsToMillis converts +0000, +0100 and -0500 offsets to UTC', () => {
  assert.equal(xmltvTsToMillis('20261101120000 +0000'), NOV1_NOON);
  // 12:00 in UTC+1 is 11:00 UTC.
  assert.equal(xmltvTsToMillis('20261101120000 +0100'), NOV1_NOON - 3600000);
  // 12:00 in UTC-5 is 17:00 UTC.
  assert.equal(xmltvTsToMillis('20261101120000 -0500'), NOV1_NOON + 5 * 3600000);
});

test('xmltvTsToMillis tolerates surrounding whitespace and rejects garbage', () => {
  assert.equal(xmltvTsToMillis('  20261101120000 +0000  '), NOV1_NOON);
  assert.ok(Number.isNaN(xmltvTsToMillis('2026-11-01T12:00:00Z')));
  assert.ok(Number.isNaN(xmltvTsToMillis('')));
  assert.ok(Number.isNaN(xmltvTsToMillis('nope')));
});

test('decodeEntities handles numeric and named entities, with &amp; last', () => {
  assert.equal(decodeEntities('&#x27;'), "'");
  assert.equal(decodeEntities('&#39;'), "'");
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('&quot;quoted&quot;'), '"quoted"');
  // Double-encoding is preserved, not collapsed: &amp;lt; -> &lt;
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="Dispatcharr">
  <channel id="14313">
    <display-name>UK| SKY CINEMA ACTION FHD</display-name>
    <icon src="http://x/logos/1.png" />
  </channel>
  <channel id="14315">
    <display-name>UK| SKY CINEMA FAMILY FHD</display-name>
  </channel>
  <programme start="20261101120000 +0000" stop="20261101130000 +0000" channel="14313">
    <title>Noon News</title>
    <desc>Today's headlines &amp; the weather.</desc>
    <category>News</category>
  </programme>
  <programme start="20261101130000 +0000" stop="20261101140000 +0000" channel="14313">
    <title>Movie</title>
  </programme>
  <programme start="20261101120000 +0000" channel="14315">
    <title>End falls back (stop missing)</title>
  </programme>
  <programme start="20261101233000 +0000" stop="20261102003000 +0000" channel="14315">
    <title>Late show</title>
  </programme>
</tv>`;

test('parseXmltv builds channels and per-channel programmes', () => {
  const { channels, byChannel } = parseXmltv(SAMPLE);
  assert.equal(channels.size, 2);
  assert.equal(channels.get('14313').name, 'UK| SKY CINEMA ACTION FHD');
  assert.equal(channels.get('14313').icon, 'http://x/logos/1.png');

  assert.equal(byChannel.get('14313').length, 2);
  const [first, second] = byChannel.get('14313');
  assert.equal(first.start, NOV1_NOON);
  assert.equal(first.end, NOV1_NOON + 3600000);
  assert.equal(first.title, 'Noon News');
  assert.equal(first.summary, "Today's headlines & the weather.");
  assert.equal(first.genre, 'News');
  assert.equal(second.title, 'Movie');

  // Missing stop -> end defaults to start + 30 minutes.
  const fallback = byChannel.get('14315').find(p => p.title.startsWith('End falls back'));
  assert.equal(fallback.end - fallback.start, 30 * 60000);
});

test('dayShowsFor returns Plex-shaped shows for the channel and local date', () => {
  const { byChannel } = parseXmltv(SAMPLE);
  const day = dayShowsFor(byChannel, '14313', '2026-11-01');
  assert.equal(day.length, 2);
  assert.equal(day[0].title, 'Noon News');
  assert.equal(day[0].Media[0].beginsAt, Math.floor(NOV1_NOON / 1000));
  assert.equal(day[0].Media[0].endsAt, Math.floor((NOV1_NOON + 3600000) / 1000));
  // A channel with nothing on the given date yields an empty list, not an error.
  assert.deepEqual(dayShowsFor(byChannel, '14313', '2026-12-25'), []);
  assert.deepEqual(dayShowsFor(byChannel, '99999', '2026-11-01'), []);
});

test('dayShowsFor includes a programme that spans midnight on both dates', () => {
  const { byChannel } = parseXmltv(SAMPLE);
  const names = d => dayShowsFor(byChannel, '14315', d).map(s => s.title);
  assert.ok(names('2026-11-01').includes('Late show'), 'present on start date');
  assert.ok(names('2026-11-02').includes('Late show'), 'present on end date');
});

test('darrIds returns de-duplicated candidate ids, number first', () => {
  assert.deepEqual(
    darrIds({ channelVcn: '14313', channelId: 'id14313', gridKey: 'gk14313' }),
    ['14313', 'id14313', 'gk14313']);
  assert.deepEqual(darrIds({ channelVcn: '5', channelId: '5', gridKey: '5' }), ['5']);
  assert.deepEqual(darrIds({}), []);
});

test('extractDispatcharrEpgUrl decodes the feed url out of the DVR lineup', () => {
  const lineup = 'lineup://tv.plex.providers.epg.xmltv/' +
    'https%3A%2F%2Fdispatcharr.danfulton.com%2Foutput%2Fepg%3Fcachedlogos%3Dfalse%26prev_days%3D2' +
    '#Dispatcharr';
  assert.equal(extractDispatcharrEpgUrl([{ lineup }]),
    'https://dispatcharr.danfulton.com/output/epg?cachedlogos=false&prev_days=2');
  // No lineup, or a non-HTTP url, yields ''.
  assert.equal(extractDispatcharrEpgUrl([{}]), '');
  assert.equal(extractDispatcharrEpgUrl([{ lineup: 'lineup://id/ftp%3A%2F%2Fx%2Fy' }]), '');
});

test('epgUrlFromHdhrBase derives the feed url from the /hdhr device base', () => {
  assert.equal(epgUrlFromHdhrBase('https://dispatcharr.danfulton.com/hdhr'),
    'https://dispatcharr.danfulton.com/output/epg?cachedlogos=false&prev_days=2');
  assert.equal(epgUrlFromHdhrBase('https://dispatcharr.danfulton.com/hdhr/'),
    'https://dispatcharr.danfulton.com/output/epg?cachedlogos=false&prev_days=2');
  assert.equal(epgUrlFromHdhrBase('ftp://x/hdhr'), '');
  assert.equal(epgUrlFromHdhrBase(''), '');
});

test('matchPlexAiring returns the closest airing within tolerance', () => {
  const base = 1762051200; // 10-digit epoch seconds
  const shows = [
    { title: 'A', Media: [{ beginsAt: base, endsAt: base + 3600 }] },
    { title: 'B', Media: [{ beginsAt: base + 3600, endsAt: base + 7200 }] },
  ];
  const m = { Media: [{ beginsAt: base + 5, endsAt: base + 3605 }] };
  assert.equal(matchPlexAiring(shows, m).title, 'A');
  // Far from every airing -> null.
  const far = { Media: [{ beginsAt: base + 86400, endsAt: base + 86400 + 3600 }] };
  assert.equal(matchPlexAiring(shows, far), null);
  // Unparseable programme -> null.
  assert.equal(matchPlexAiring(shows, { Media: [{ beginsAt: '' }] }), null);
});
