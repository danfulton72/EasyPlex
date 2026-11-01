// Live TV screen end to end against a fake Plex server and native shell:
// guide, navigation, schedule, recording, cancelling, options, favourites,
// channel lists, number entry, zapping, failures, lifecycle and resume.
//
// The tests run in order and share one screen, like a viewer using the remote.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, sleep } from './helpers/env.mjs';
import { createFakePlex, fakeFetch } from './helpers/fake-plex.mjs';

setupDom();
const plex = createFakePlex();
const { native } = plex;
globalThis.EasyPlexVideo = native;
window.EasyPlexVideo = native;

const { session } = await import('../web/js/session.js');
session.server = plex.server;
const { LiveTvScreen, localDate } = await import('../web/js/screens/livetv.js');
const options = await import('../web/js/ui/options.js');

const s = LiveTvScreen();
document.getElementById('app').appendChild(s.el);
// Keys go to an open options list first, as the router does.
const press = a => (options.optionsOpen() ? options.optionsKey(a) : s.onKey(a));
const $ = sel => s.el.querySelector(sel);
const $$ = sel => [...s.el.querySelectorAll(sel)];
const menuItems = () => [...document.querySelectorAll('.ep-options .hx-menu-item')].map(x => x.textContent);
const selName = () => $('.hx-row.sel .hx-name').textContent;
const infoTitle = () => $('.hx-info-title').textContent;
const toastText = () => $('.ep-live-detail').textContent;

after(() => { s.destroy(); });

test('guide loads channels in number order with programmes', async () => {
  await sleep(1200);
  const rows = $$('.hx-grid .hx-row');
  assert.equal(rows.length, 7, 'seven rows visible');
  assert.deepEqual(rows.slice(0, 3).map(r => r.querySelector('.hx-name').textContent), ['Chan1', 'Chan2', 'Chan3']);
  assert.ok(rows[0].textContent.includes('gk1 '), 'programme blocks rendered');
  assert.ok($('.hx-now'), 'now line');
  assert.equal(infoTitle(), 'gk1 ' + localDate(Date.now()) + ' ' + new Date().getHours());
});

test('Left/Right move by programme and never into the past', () => {
  const nowTitle = 'gk1 ' + localDate(Date.now()) + ' ' + new Date().getHours();
  const next = new Date(Date.now() + 3600000);
  press('right');
  assert.equal(infoTitle(), 'gk1 ' + localDate(next.getTime()) + ' ' + next.getHours());
  press('left');
  assert.equal(infoTitle(), nowTitle);
  press('left');
  assert.equal(infoTitle(), nowTitle);
});

test('selection stays on screen when moving past the visible rows', () => {
  for (let i = 0; i < 8; i++) press('down');
  const rows = $$('.hx-grid .hx-row');
  const sel = $('.hx-row.sel');
  assert.equal(sel.querySelector('.hx-name').textContent, 'Chan9');
  assert.equal(rows.indexOf(sel), 6);
  for (let i = 0; i < 8; i++) press('up');
  assert.equal($$('.hx-grid .hx-row').indexOf($('.hx-row.sel')), 0);
});

test('guide days are cached, not refetched on every key', async () => {
  await sleep(500);
  const before = plex.state.requests.length;
  press('right'); press('left');
  await sleep(400);
  assert.equal(plex.state.requests.length, before);
});

test('recordings screen lists pending recordings in time order', async () => {
  press('blue');
  await sleep(50);
  assert.ok(s.el.classList.contains('ep-sched-active'));
  const rows = $$('.hx-sched .hx-row').map(r => r.textContent);
  assert.equal(rows.length, 3, 'completed recordings are left out');
  assert.match(rows[0], /Rec0/);
  assert.match(rows[1], /Rec1.*S1 E2 · Pilot.*SKY CINEMA/);
  press('down');
  assert.equal($('.hx-sched .hx-info-sub').textContent, 'S1 E2 · Pilot');
  press('back');
  assert.ok(s.el.classList.contains('ep-grid-active'));
});

test('day guide and diagnostics open and close', async () => {
  press('yellow');
  await sleep(50);
  assert.equal($$('.ep-live-row').length, 24);
  press('back');
  assert.ok(s.el.classList.contains('ep-grid-active'));
  press('green');
  assert.equal($('.ep-live-debug').style.display, '');
  assert.match($('.ep-debug-content').textContent, /PAGE 1/);
  press('back');
  assert.equal($('.ep-live-debug').style.display, 'none');
});

test('watching and zapping open one stream per settled choice', async () => {
  press('enter');
  await sleep(50);
  assert.deepEqual(native.opened, ['http://disp/ch1']);
  assert.match(native.banners.at(-1).t, /^Chan1\nNow .* gk1 .*\nNext /);
  press('up'); press('up');
  assert.match(native.banners.at(-1).t, /^Chan3/, 'banner previews the target straight away');
  await sleep(800);
  assert.deepEqual(native.opened, ['http://disp/ch1', 'http://disp/ch3']);
  press('last');
  await sleep(50);
  assert.equal(native.opened.at(-1), 'http://disp/ch1');
  press('down');
  await sleep(800);
  assert.equal(native.opened.at(-1), 'http://disp/ch10', 'wraps around');
  press('up'); press('up');
  await sleep(800);
  assert.equal(native.opened.at(-1), 'http://disp/ch2');
  press('back');
  assert.equal(native.closed, 1);
  assert.equal(selName(), 'Chan2', 'guide returns to the channel watched');
});

test('record dialog: options, library and folder, Plex Web style request', async () => {
  const posts = [];
  globalThis.fetch = fakeFetch(url => (/targetSectionLocationID=51/.test(url)
    ? { status: 400, body: '<html><head><title>Bad Request</title></head></html>' }
    : { body: JSON.stringify({ MediaContainer: { MediaSubscription: [{ key: '9' }] } }) }), posts);
  press('record');
  await sleep(50);
  const notes = () => $$('.hx-field-note').map(n => n.textContent);
  assert.equal($('.hx-field-value').textContent, 'This Episode');
  assert.equal($$('.hx-field-value')[1].textContent, 'TV Recordings');
  assert.match(notes()[1], /\/tv\/a.*1 of 2/);
  press('up'); press('right');
  assert.match(notes()[1], /\/tv\/b/);
  press('up'); press('right');
  assert.equal($('.hx-field-value').textContent, 'All Episodes');
  assert.match(notes()[1], /\/tv\/b/, 'library choice kept when the option changes');
  press('left');
  press('down'); press('down'); press('enter');
  await sleep(50);
  assert.equal(posts.length, 2, 'retried with a blank folder after 400');
  const raw = posts[1].url;
  assert.match(raw, /hints%5BratingKey%5D=plex%253A%252F%252Fepisode%252Fx/, 'template parameters passed through untouched');
  const q = new URL(raw).searchParams;
  assert.equal(posts[1].method, 'POST');
  assert.equal(q.get('type'), '4');
  assert.equal(q.get('targetLibrarySectionID'), '5');
  assert.equal(q.get('targetSectionLocationID'), '');
  assert.equal(q.get('includeGrabs'), '1');
  assert.equal(q.get('prefs[lineupChannel]'), '', 'blank prefs still sent');
  assert.equal(q.get('prefs[replaceLowerQuality]'), 'false');
  assert.equal(q.get('prefs[endOffsetMinutes]'), '2');
  assert.match(toastText(), /This Episode scheduled.*TV Recordings/);
  press('record');
  await sleep(50);
  assert.match(notes()[1], /\/tv\/b/, 'remembers the last library');
  press('back');
});

test('a rejected recording shows the request in diagnostics', async () => {
  globalThis.fetch = fakeFetch(() => ({ status: 400, body: '<html><head><title>Bad Request</title></head></html>' }));
  press('record');            // open the dialog
  await sleep(50);
  press('record');            // Record again confirms
  await sleep(50);
  assert.match($('.hx-dlg-status').textContent, /Not scheduled: Plex HTTP 400 Bad Request · Green: details/);
  press('green');
  const text = $('.ep-debug-content').textContent;
  assert.match(text, /Last recording request/);
  assert.match(text, /Attempt 2: Plex HTTP 400/);
  press('down');
  assert.match($('.ep-debug-content').textContent, /Option 1: This Episode · type 4 · selected/);
  press('back');
  assert.ok(s.el.classList.contains('ep-grid-active'));
});

test('hold OK options in the guide', async () => {
  press('menu');
  assert.deepEqual(menuItems(), ['Watch channel', 'Record…', 'Add to favourites', 'Channels: All channels…', 'Recordings', 'Channel day guide', 'Diagnostics']);
  press('down'); press('enter');
  await sleep(50);
  assert.ok($('.hx-dialog .hx-field'), 'Record… opens the record dialog');
  press('back');
  press('menu');
  for (let i = 0; i < 4; i++) press('down');
  press('enter');
  await sleep(50);
  assert.match($('.hx-sched').textContent, /Rec1/, 'Recordings via options');
  press('back');
  press('menu'); press('back');
  assert.ok(!options.optionsOpen());
});

test('cancelling recordings: one-off, skip one episode, whole series', async () => {
  const deletes = [];
  globalThis.fetch = fakeFetch((url, o) => {
    if (o.method !== 'DELETE') return {};
    const path = new URL(url).pathname;
    deletes.push(path);
    const id = decodeURIComponent(path.split('/').pop());
    if (path.startsWith('/media/grabbers/operations/')) plex.state.schedOps = plex.state.schedOps.filter(op => op.id !== id);
    else plex.state.schedOps = plex.state.schedOps.filter(op => op.mediaSubscriptionID !== Number(id));
    return { body: '' };
  });
  const cancelItems = () => $$('.hx-cancel .hx-menu-item').map(x => x.textContent);
  press('blue');
  await sleep(50);
  press('enter');
  await sleep(50);
  assert.deepEqual(cancelItems(), ['Cancel this recording', 'Keep recording']);
  press('down'); press('enter');
  assert.equal(deletes.length, 0, 'Keep changes nothing');
  press('enter'); await sleep(50); press('enter'); await sleep(80);
  assert.deepEqual(deletes, ['/media/subscriptions/11']);
  assert.match(toastText(), /Cancelled: Rec0/);
  press('enter');
  await sleep(50);
  assert.deepEqual(cancelItems(), ['Skip this episode only', 'Cancel series recording (2 scheduled) · Rec1', 'Keep recording']);
  press('enter');
  await sleep(80);
  assert.equal(deletes[1], '/media/grabbers/operations/op-a');
  press('enter'); await sleep(50); press('down'); press('enter'); await sleep(80);
  assert.equal(deletes[2], '/media/subscriptions/12');
  assert.match($('.hx-sched .hx-info-title').textContent, /No scheduled recordings/);
  // A refused cancel leaves the dialog open with the reason.
  plex.state.schedOps = [{ id: 'op-z', mediaSubscriptionID: 13, status: 'scheduled', Metadata: { title: 'Z', Media: [{ beginsAt: plex.nowS + 100, endsAt: plex.nowS + 200 }] } }];
  globalThis.fetch = fakeFetch(() => ({ status: 404, body: '<html><head><title>Not Found</title></head></html>' }));
  press('back'); press('blue');
  await sleep(50);
  press('enter'); await sleep(50); press('enter'); await sleep(50);
  assert.match($('.hx-cancel .hx-dlg-status').textContent, /Not cancelled: Plex HTTP 404 Not Found/);
  press('back');
  press('back');
  assert.ok(s.el.classList.contains('ep-grid-active'));
});

test('favourites and channel lists', async () => {
  globalThis.fetch = fakeFetch(() => ({ body: JSON.stringify({ MediaContainer: { MediaSubscription: [{ key: '9' }] } }) }));
  const head = () => $('.hx-grid .hx-title').textContent;
  for (let i = 0; i < 12; i++) press('up');
  assert.equal(selName(), 'Chan1');
  assert.equal(head(), 'Live TV  ·  All channels');
  press('menu'); press('down'); press('down'); press('enter');
  assert.match(toastText(), /Chan1 added to favourites/);
  assert.equal(selName(), '★ Chan1');
  assert.equal(head(), 'Live TV  ·  All channels', 'adding the first favourite keeps the list');
  assert.match($('.hx-info-ch').textContent, /★ Chan1  ·  1/);
  press('menu'); press('down'); press('down'); press('down'); press('enter');
  assert.deepEqual(menuItems(), ['Favourites  (1)', '✓  All channels  (10)', 'UK  (6)', 'US  (4)']);
  press('down'); press('enter');
  assert.equal(head(), 'Live TV  ·  UK channels');
  assert.equal($$('.hx-grid .hx-row').length, 6);
  press('menu'); press('down'); press('down'); press('down'); press('enter'); press('up'); press('up'); press('enter');
  assert.equal(head(), 'Live TV  ·  Favourites');
  assert.equal($$('.hx-grid .hx-row').length, 1);
});

test('number entry in the guide', async () => {
  press('digit7');
  assert.match($('.hx-digits').textContent, /7Chan7/);
  press('enter');
  assert.equal($('.hx-grid .hx-title').textContent, 'Live TV  ·  All channels', 'shows all to reach a channel outside the list');
  assert.equal(selName(), 'Chan7');
  press('digit9'); press('digit9');
  await sleep(1900);
  assert.match(toastText(), /No channel 99/);
});

test('hold OK while watching records what is on', async () => {
  press('enter');
  await sleep(50);
  assert.equal(native.opened.at(-1), 'http://disp/ch7');
  press('menu');
  await sleep(80);
  const menu = native.menus.at(-1);
  assert.ok(menu.items[0].startsWith('Record: This Episode  →  TV Recordings'));
  assert.deepEqual(menu.items.slice(-2), ['Add to favourites', 'Back to guide']);
  window.__easyplexMenuChoice(0);
  await sleep(80);
  assert.match(native.banners.at(-1).t, /● This Episode scheduled  →  TV Recordings/);
});

test('number entry while watching', async () => {
  press('digit2');
  assert.match(native.banners.at(-1).t, /^Chan2[\s\S]*Channel 2$/);
  press('enter');
  await sleep(50);
  assert.equal(native.opened.at(-1), 'http://disp/ch2');
});

test('a failed stream offers retry, next channel, back', async () => {
  const closed = native.closed;
  window.__easyplexLivePlayError('NATIVE_STALL');
  assert.equal(native.closed, closed + 1);
  assert.ok(s.el.classList.contains('ep-grid-active'));
  // The failed stream was a direct Dispatcharr one, so a Plex fallback is offered.
  assert.deepEqual(menuItems(), ['Try again', 'Try via Plex (transcode)', 'Watch next channel  (Chan3)', 'Back to guide']);
  press('enter');
  await sleep(50);
  assert.equal(native.opened.at(-1), 'http://disp/ch2');
});

test('leaving the app stops live TV', () => {
  window.dispatchEvent(new window.CustomEvent('easyplex:lifecycle', { detail: 'stop' }));
  assert.ok(s.el.classList.contains('ep-grid-active'));
});

test('reopening resumes on the last channel; autoplay plays it', async () => {
  const s2 = LiveTvScreen();
  document.body.appendChild(s2.el);
  await sleep(400);
  assert.equal(s2.el.querySelector('.hx-row.sel .hx-name').textContent, 'Chan2');
  const n = native.opened.length;
  const s3 = LiveTvScreen({ autoplay: true });
  document.body.appendChild(s3.el);
  await sleep(400);
  assert.equal(native.opened.length, n + 1);
  assert.equal(native.opened.at(-1), 'http://disp/ch2');
  s2.destroy();
  s3.destroy();
});

test('an expired sign-in (403 on DVR discovery) re-links instead of dead-ending', async () => {
  // Simulate the stale-token case: /livetv/dvrs rejects with 403 while the
  // library still reads fine. The screen must say why and hand back to login.
  plex.state.dvrFailure = { status: 403 };
  let restarted = false;
  const onRestart = () => { restarted = true; };
  window.addEventListener('easyplex:restart', onRestart);
  const tokenBefore = session.token;
  const sAuth = LiveTvScreen();
  document.body.appendChild(sAuth.el);
  await sleep(400);
  assert.match(sAuth.el.querySelector('.ep-live-status').textContent, /sign-in expired/i, 'explains the 403 as an expired sign-in');
  assert.ok(restarted, 'dispatches easyplex:restart so app.js routes to login');
  assert.notEqual(session.token, tokenBefore, 'signs out so the next start() goes to the PIN screen');
  window.removeEventListener('easyplex:restart', onRestart);
  plex.state.dvrFailure = null;
  sAuth.destroy();
});
