// Recording, following Plex's own model: the template lists what can be
// recorded (this airing, all episodes, …) and each choice is saved into a
// library of the right kind (movie or TV) and one of its folders.
import { h } from '../../util/dom.js';
import { getRaw, setRaw } from '../../util/store.js';
import {
  localDate, airingBounds, hhmm, dayLabel, titleOf, mainTitle, subTitle, channelLabel,
  templateOptions, libraryKind, librariesFor, defaultLibrary, subscriptionQuery, decodeQuery,
} from './helpers.js';

const REC_PREF = 'easyplexRecordLibrary:';   // + 'movie' | 'show' -> "sectionId:locId"

export function createRecord(ctx) {
  // template = last template Plex sent; attempts = last request(s) and results.
  const state = { dialog: null, template: null, attempts: [] };
  let dlgEl = null;
  const d = {};

  function savedLibrary(opt) { return getRaw(REC_PREF + libraryKind(opt)); }
  function pickLibrary(opt, libs) { return defaultLibrary(opt, libs, savedLibrary(opt)); }

  // Template and libraries for a programme.
  async function fetchOptions(m) {
    const [template, sections] = await Promise.all([
      ctx.server.get('/media/subscriptions/template', m.guid ? { guid: m.guid } : { ratingKey: m.ratingKey }),
      ctx.server.sections(),
    ]);
    state.template = template;
    return { opts: templateOptions(template), sections };
  }

  // ---- dialog ---------------------------------------------------------------

  function build() {
    dlgEl = h('div', 'hx-dialog', ctx.el);
    const box = h('div', 'hx-dlg', dlgEl);
    h('div', 'hx-dlg-eyebrow', box).textContent = 'RECORD';
    d.title = h('h2', 'hx-dlg-title', box);
    d.sub = h('div', 'hx-dlg-sub', box);
    const field = label => {
      const row = h('div', 'hx-field', box);
      h('div', 'hx-field-label', row).textContent = label;
      const mid = h('div', 'hx-field-mid', row);
      const value = h('div', 'hx-field-value', mid);
      const note = h('div', 'hx-field-note', mid);
      h('div', 'hx-field-arrows', row).textContent = '◀ ▶';
      return { row, value, note };
    };
    d.what = field('WHAT');
    d.where = field('SAVE TO');
    const buttons = h('div', 'hx-dlg-buttons', box);
    d.ok = h('div', 'hx-btn', buttons); d.ok.textContent = 'Record';
    d.cancel = h('div', 'hx-btn', buttons); d.cancel.textContent = 'Cancel';
    d.status = h('div', 'hx-dlg-status', box);
    h('div', 'hx-dlg-hint', box).textContent = '▲▼ choose · ◀▶ change · OK confirm · Back cancel';
  }

  function render() {
    const dlg = state.dialog;
    if (!dlgEl) build();
    dlgEl.style.display = '';
    const opt = dlg.opts[dlg.optIdx];
    const lib = dlg.libs[dlg.libIdx];
    d.title.textContent = dlg.title;
    d.sub.textContent = dlg.when;
    d.what.value.textContent = opt ? (opt.title || 'Record') : '';
    d.what.note.textContent = dlg.opts.length > 1 ? (dlg.optIdx + 1) + ' of ' + dlg.opts.length + (opt?.airingsType ? ' · ' + opt.airingsType : '') :
      (opt?.airingsType || '');
    d.where.value.textContent = lib ? lib.title : 'No ' + (libraryKind(opt) === 'movie' ? 'movie' : 'TV') + ' library in Plex';
    d.where.note.textContent = lib ? (lib.path + (dlg.libs.length > 1 ? '  ·  ' + (dlg.libIdx + 1) + ' of ' + dlg.libs.length : '')) :
      'Add one in Plex Media Server, then try again';
    d.what.row.classList.toggle('focus', dlg.focus === 0);
    d.where.row.classList.toggle('focus', dlg.focus === 1);
    d.ok.classList.toggle('focus', dlg.focus === 2 && dlg.btn === 0);
    d.cancel.classList.toggle('focus', dlg.focus === 2 && dlg.btn === 1);
    d.ok.classList.toggle('disabled', !lib || dlg.busy);
    d.status.textContent = dlg.status || '';
  }

  function close() {
    if (dlgEl) dlgEl.style.display = 'none';
    if (state.dialog) ctx.setView(state.dialog.returnTo);
    state.dialog = null;
  }

  // Record the programme selected in the guide or the day guide.
  async function open() {
    const view = ctx.state.view;
    const selected = view === 'grid' ? ctx.guide.selected() : null;
    const m = selected?.programme || (view === 'guide' ? ctx.dayguide.selectedProgramme() : null);
    if (!m) { ctx.say('No programme selected for recording'); return; }
    const row = selected?.row || ctx.dayguide.state.channel;
    // A Dispatcharr-sourced guide programme has no Plex guid. Borrow one with a
    // single targeted grid lookup (matched by time) so it can still be recorded;
    // this touches Plex only now, not for the whole guide.
    if (!m.guid && !m.ratingKey) {
      if (!row) { ctx.say('Plex EPG lacks a programme GUID; cannot create a recording.'); return; }
      ctx.say('Looking up this programme in Plex…');
      await ctx.channels.resolveGuid(row, m);
      if (!m.guid && !m.ratingKey) { ctx.say('Could not find this programme in Plex to record it.'); return; }
    }
    const { start, end } = airingBounds(m);
    ctx.say('Getting recording options for ' + titleOf(m) + '…');
    try {
      const { opts, sections } = await fetchOptions(m);
      if (!opts.length) throw new Error('Plex returned no recording options for this programme');
      if (ctx.state.view !== 'grid' && ctx.state.view !== 'guide') return;
      const optIdx = Math.max(0, opts.findIndex(o => o.selected));
      const libs = librariesFor(opts[optIdx], sections);
      state.dialog = {
        m, opts, optIdx, sections, libs, libIdx: pickLibrary(opts[optIdx], libs),
        focus: libs.length ? 2 : 1, btn: 0, busy: false, status: '', returnTo: ctx.state.view,
        title: mainTitle(m),
        when: [row ? channelLabel(row.name || row.channel) : '', (localDate(start) === localDate(Date.now()) ? '' : dayLabel(start) + ' ') +
          hhmm(start) + ' – ' + hhmm(end), subTitle(m)].filter(Boolean).join('  ·  '),
      };
      ctx.say('');
      ctx.setView('record');
      render();
    } catch (err) { ctx.say('Recording not available: ' + err.message); }
  }

  function change(delta) {
    const dlg = state.dialog;
    if (dlg.focus === 0 && dlg.opts.length > 1) {
      dlg.optIdx = (dlg.optIdx + delta + dlg.opts.length) % dlg.opts.length;
      const opt = dlg.opts[dlg.optIdx];
      const prev = dlg.libs[dlg.libIdx];
      dlg.libs = librariesFor(opt, dlg.sections);
      const same = prev ? dlg.libs.findIndex(l => l.sectionId === prev.sectionId && l.locId === prev.locId) : -1;
      dlg.libIdx = same >= 0 ? same : pickLibrary(opt, dlg.libs);
    } else if (dlg.focus === 1 && dlg.libs.length > 1) {
      dlg.libIdx = (dlg.libIdx + delta + dlg.libs.length) % dlg.libs.length;
    } else if (dlg.focus === 2) {
      dlg.btn = dlg.btn ? 0 : 1;
    }
    dlg.status = '';
    render();
  }

  async function submit() {
    const dlg = state.dialog;
    if (!dlg || dlg.busy) return;
    const opt = dlg.opts[dlg.optIdx], lib = dlg.libs[dlg.libIdx], m = dlg.m;
    if (!lib) { dlg.status = 'Choose a library to save into.'; render(); return; }
    dlg.busy = true; dlg.status = 'Scheduling…'; render();
    const r = await schedule(opt, lib, m);
    if (!r.ok) {
      if (!state.dialog) return;
      dlg.busy = false;
      dlg.status = 'Not scheduled: ' + r.error + ' · Green: details';
      render();
      return;
    }
    const what = opt.title || 'Recording';
    close();
    if (ctx.state.view === 'grid') ctx.guide.render();
    ctx.say(what + ' scheduled: ' + mainTitle(m) + ' → ' + lib.title + ' · Blue shows recordings');
  }

  // Create the recording rule; shared by the dialog and the while-watching
  // options. Resolves { ok } or { ok: false, error }.
  async function schedule(opt, lib, m) {
    state.attempts = [];
    // Plex Web leaves the folder blank and lets Plex pick; try the chosen folder
    // first, then blank if Plex rejects the request.
    const tries = lib.locId ? [true, false] : [false];
    let lastErr = null;
    for (const withLocation of tries) {
      const q = subscriptionQuery(opt, lib, m, withLocation);
      try {
        await ctx.api.post('/media/subscriptions', {}, q);
        state.attempts.push({ result: 'OK', query: decodeQuery(q) });
        lastErr = null;
        break;
      } catch (err) {
        state.attempts.push({ result: err.message, query: decodeQuery(q) });
        lastErr = err;
        if (err.status !== 400) break;
      }
    }
    if (lastErr) return { ok: false, error: lastErr.message };
    setRaw(REC_PREF + libraryKind(opt), lib.sectionId + ':' + lib.locId);
    const guids = ctx.guide.state.scheduledGuids;
    if (m.guid) guids.add(m.guid);
    if (Number(opt.type) !== 4 && m.grandparentGuid) guids.add(m.grandparentGuid);
    ctx.guide.loadScheduled();
    return { ok: true };
  }

  // Ready-made choices for recording a programme straight away (while
  // watching): [{ label, opt, lib }] using each option's preselected library.
  async function quickChoices(m) {
    const { opts, sections } = await fetchOptions(m);
    const out = [];
    for (const o of opts) {
      const libs = librariesFor(o, sections);
      const lib = libs[pickLibrary(o, libs)];
      if (lib) out.push({ label: 'Record: ' + (o.title || 'this programme') + '  →  ' + lib.title, opt: o, lib });
    }
    return out;
  }

  function onKey(action) {
    const dlg = state.dialog;
    if (!dlg) return true;
    switch (action) {
      case 'up': dlg.focus = Math.max(0, dlg.focus - 1); render(); return true;
      case 'down': dlg.focus = Math.min(2, dlg.focus + 1); render(); return true;
      case 'left': change(-1); return true;
      case 'right': change(1); return true;
      case 'enter':
        if (dlg.focus < 2) { dlg.focus++; render(); }
        else if (dlg.btn === 0) submit();
        else close();
        return true;
      case 'record': case 'red': submit(); return true;
      case 'green': {                       // show what was sent and what Plex offered
        close();
        ctx.diagnostics.show(3);
        return true;
      }
      case 'back': close(); return true;
      default: return true;
    }
  }

  return { state, open, schedule, quickChoices, onKey };
}
