// Home: hero for the focused item, nav bar, and Plex's home hubs as rows.
// The last hub payload is cached so a cold start paints instantly.
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { Row } from '../ui/row.js';
import { useAmbience, HeroArt } from '../ui/backdrop.js';
import { session } from '../session.js';
import { profileKey } from '../session.js';
import { metaLine } from '../util/format.js';
import { isFast } from '../input.js';
import * as store from '../util/store.js';
import * as router from '../router.js';
import * as icons from '../ui/icons.js';
import { openItem, playItem, openLibrary, openSearch, openSettings, itemOptions } from '../nav.js';
import { toast, showOptions } from '../ui/options.js';
import { LiveTvScreen } from './livetv.js';
import { VodScreen } from './vod.js';
import { isConfigured as vodConfigured } from '../xtream/api.js';
import { allowedForUser } from '../xtream/limits.js';
import { isAdmin } from '../session.js';
import { PLATFORM_LABEL } from '../platform/device.js';

// VOD shows once set up, unless the admin allowed this profile no categories.
function vodVisible() {
  if (!vodConfigured()) return false;
  const allow = isAdmin() ? null : allowedForUser(session.user);
  return !allow || allow.length > 0;
}
import { error, log } from '../util/log.js';

const ROWS_TOP = 600;
const NAV_PAD = 80; // wider than the 64px edge fade in app.css
const NAV_ORDER_BASE = 'navOrder';   // user's preferred library order (array of section keys)
const NAV_HIDDEN_BASE = 'navHidden'; // libraries hidden from nav + recents (favourites by exclusion)

// Per-profile store keys: each profile (Dan, Aiden, ...) gets its own order and
// its own hidden set, so a kid's box can show only kids' libraries.
const orderKey = () => NAV_ORDER_BASE + ':' + profileKey();
const hiddenKey = () => NAV_HIDDEN_BASE + ':' + profileKey();
// Bump when the cached Home shape changes so stale caches are discarded.
const HOME_CACHE_V = 2;

// Apply a saved order (array of section keys) to a sections array. Keys not in
// the saved list keep their original relative order and sort after the known
// ones, so newly added libraries still appear. Returns a new array.
function orderedSections(sections, order) {
  if (!Array.isArray(order) || !order.length) return sections;
  const rank = new Map(order.map((k, i) => [k, i]));
  return [...sections].sort((a, b) => {
    const ra = rank.has(a.key) ? rank.get(a.key) : Infinity;
    const rb = rank.has(b.key) ? rank.get(b.key) : Infinity;
    return ra - rb; // stable: equal ranks (both unknown) keep original order
  });
}

function slimHub(hub) {
  // Keep the cache small: only fields the home screen renders.
  const keep = ['ratingKey', 'key', 'type', 'title', 'grandparentTitle', 'parentTitle', 'year', 'thumb', 'art',
    'grandparentThumb', 'grandparentArt', 'parentThumb', 'index', 'parentIndex', 'duration', 'viewOffset',
    'viewCount', 'leafCount', 'viewedLeafCount', 'childCount', 'contentRating', 'audienceRating', 'summary',
    'originallyAvailableAt', 'UltraBlurColors', 'grandparentRatingKey', 'parentRatingKey', 'Image'];
  return {
    hubIdentifier: hub.hubIdentifier, title: hub.title, type: hub.type,
    Metadata: hub.Metadata.map(m => {
      const o = {};
      for (const k of keep) if (m[k] !== undefined) o[k] = m[k];
      return o;
    }),
  };
}

export function heroArtPath(item) {
  if (item.type === 'episode' || item.type === 'season') return item.grandparentArt || item.art;
  return item.art;
}

export function clearLogo(item) {
  const img = (item.Image || []).find(i => i.type === 'clearLogo');
  return img ? img.url : '';
}

export function HomeScreen() {
  const el = h('div', 'screen home');
  const ambience = useAmbience();
  const hero = new HeroArt(el, 'hero-art home-art');

  const top = h('header', 'topbar', el);
  const brand = h('div', 'brand', top);
  h('img', 'brand-mark', brand).src = 'img/easyplex-logo.jpg';
  const brandText = h('div', 'brand-text', brand);
  h('div', 'ep-wordmark', brandText).textContent = 'EasyPlex';
  h('div', 'brand-by', brandText).textContent = PLATFORM_LABEL;
  // The nav is a clip with a sliding track, so any number of libraries fits.
  const navEl = h('nav', 'nav', top);
  const navTrack = h('div', 'nav-track', navEl);
  const who = h('div', 'topbar-who', top);
  setText(who, session.server ? session.server.name : '');

  const info = h('div', 'hero-info', el);
  const heroLogo = h('img', 'hero-logo', info);
  const heroTitle = h('h1', 'hero-title', info);
  const heroMeta = h('div', 'hero-meta', info);
  const heroSummary = h('p', 'hero-summary', info);

  const rowsClip = h('div', 'home-rows', el);
  rowsClip.style.top = ROWS_TOP + 'px';
  const track = h('div', 'rows-track', rowsClip);
  const empty = h('div', 'home-empty', el);

  let rows = [];
  let offsets = [];
  let rowIndex = 0;
  let zone = 'rows';
  let navItems = [];
  let navIndex = 0;
  let navScroll = 0;
  let loadedAt = 0;
  let heroTimer = 0;
  let artTimer = 0;
  let reportedPaint = false;

  let navSections = [];      // visible (ordered, non-hidden) sections
  let allSections = [];      // every movie/show section (for the More list)
  let hiddenKeys = new Set(); // section keys hidden for this profile
  let navHasVod = false;
  // Library reordering: hold Select on a library to pick it up, move left/right
  // to slide it, Select again to place (saves), Down to hide it, Back to cancel.
  let reorderMode = false;
  let dragIndex = -1;
  function buildNav(sections) {
    // Callers pass already-ordered, non-hidden sections (see load()); render them.
    navSections = sections;
    navHasVod = vodVisible();
    const was = navItems && navItems[navIndex];
    navTrack.innerHTML = '';
    navItems = [{ label: 'Home', id: 'home' }]
      .concat(sections.map(s => ({ label: s.title, id: 'section', section: s })))
      .concat([{ label: 'Live TV & DVR', id: 'livetv' }])
      .concat(navHasVod ? [{ label: 'VOD', id: 'vod' }] : [])
      .concat(hiddenKeys.size ? [{ label: 'More ▸', id: 'more' }] : [])
      .concat([{ label: 'Search', id: 'search', icon: icons.search }, { label: 'Settings', id: 'settings', icon: icons.gear }]);
    // Keep focus on the same item when entries are added or removed.
    const same = was ? navItems.findIndex(n => n.id === was.id && (n.id !== 'section' || n.section.key === was.section.key)) : -1;
    navIndex = same >= 0 ? same : Math.min(navIndex, navItems.length - 1);
    navItems.forEach((n, i) => {
      if (n.icon && !navItems[i - 1].icon) h('i', 'nav-sep', navTrack);
      n.el = h('div', 'nav-item' + (n.icon ? ' nav-icon' : ''), navTrack);
      if (n.icon) n.el.innerHTML = n.icon;
      else h('span', '', n.el).textContent = n.label;
    });
    renderNav();
  }

  // Slide the track just enough to keep the focused item clear of the edge fades.
  function scrollNav() {
    const room = navEl.clientWidth;
    if (!room) return; // hidden screen: nothing to measure
    const max = Math.max(0, navTrack.offsetWidth - room);
    const n = navItems[navIndex];
    if (zone === 'nav' && n) {
      const left = n.el.offsetLeft;
      const right = left + n.el.offsetWidth;
      if (left - NAV_PAD < navScroll) navScroll = left - NAV_PAD;
      else if (right + NAV_PAD > navScroll + room) navScroll = right + NAV_PAD - room;
    }
    navScroll = Math.round(Math.max(0, Math.min(max, navScroll)));
    setTransform(navTrack, 'translateX(' + (-navScroll) + 'px)');
    toggleClass(navEl, 'more-left', navScroll > 0);
    toggleClass(navEl, 'more-right', navScroll < max - 1);
  }

  function renderNav() {
    scrollNav(); // measure before the class writes below dirty the style
    navItems.forEach((n, i) => {
      toggleClass(n.el, 'focus', zone === 'nav' && i === navIndex);
      toggleClass(n.el, 'current', n.id === 'home');
      toggleClass(n.el, 'dragging', reorderMode && i === dragIndex);
    });
    toggleClass(el, 'in-nav', zone === 'nav');
    toggleClass(navEl, 'reordering', reorderMode);
  }

  // --- Library reordering -------------------------------------------------
  // Hold Select on a library to pick it up; left/right slides it; Select places
  // it (saving the new order); Back cancels. Only the section items are movable
  // — Home, Live TV, VOD, Search and Settings stay pinned at their ends.
  function firstSectionIdx() { return navItems.findIndex(n => n.id === 'section'); }
  function lastSectionIdx() { let i = -1; navItems.forEach((n, k) => { if (n.id === 'section') i = k; }); return i; }

  function startReorder() {
    const cur = navItems[navIndex];
    if (!cur || cur.id !== 'section') return false;   // only libraries are draggable
    reorderMode = true;
    dragIndex = navIndex;
    renderNav();
    toast('Move “' + cur.label + '” · OK to place · Down to hide · Back to cancel', 4500);
    return true;
  }

  // Physically slide the dragged item to a new position in both the array and
  // the DOM so the user sees it move live.
  function moveDrag(dir) {
    const target = Math.max(firstSectionIdx(), Math.min(lastSectionIdx(), dragIndex + dir));
    if (target === dragIndex) return;
    const [moved] = navItems.splice(dragIndex, 1);
    navItems.splice(target, 0, moved);
    // Re-insert its element at the matching DOM position.
    const prev = navItems[target - 1];
    if (prev) navTrack.insertBefore(moved.el, prev.el.nextSibling);
    else navTrack.appendChild(moved.el);
    dragIndex = target;
    navIndex = target;
    renderNav();
  }

  function commitReorder() {
    // Persist the section keys in their current (possibly rearranged) order.
    const order = navItems.filter(n => n.id === 'section').map(n => n.section.key);
    store.set(orderKey(), order);
    endReorder();
    toast('Library order saved', 2500);
  }

  function endReorder() {
    reorderMode = false;
    dragIndex = -1;
    renderNav();
  }

  function cancelReorder() {
    // Rebuild from the saved order to discard the in-progress move.
    endReorder();
    buildNav(navSections);
    navIndex = Math.min(navIndex, navItems.length - 1);
    renderNav();
  }

  // --- Hide / show libraries (per-profile favourites by exclusion) ---------
  function saveHidden() { store.set(hiddenKey(), [...hiddenKeys]); }

  function hideSection(key, label) {
    if (!key || hiddenKeys.has(key)) return;
    hiddenKeys.add(key);
    saveHidden();
    endReorder();
    toast('Hidden “' + label + '” · open More to bring it back', 3500);
    load();   // refresh nav + recents without the hidden library
  }

  // The "More ▸" overflow: list every hidden library; Select one to restore it.
  function showMore() {
    const hidden = allSections.filter(s => hiddenKeys.has(s.key));
    if (!hidden.length) return;
    showOptions({
      title: 'Hidden libraries',
      subtitle: 'Select to show again',
      focus: 0,
      items: hidden.map(s => ({
        label: s.title,
        run: () => { hiddenKeys.delete(s.key); saveHidden(); load(); },
      })),
    });
  }

  function showHero(item) {
    if (!item) return;
    const logoPath = clearLogo(item);
    const server = session.server;
    if (logoPath && item.type !== 'episode') {
      heroLogo.src = server.image(logoPath, 640, 200, { format: 'png' });
      heroLogo.style.display = '';
      heroTitle.style.display = 'none';
    } else {
      heroLogo.style.display = 'none';
      heroTitle.style.display = '';
      setText(heroTitle, item.type === 'episode' ? item.grandparentTitle : item.title);
    }
    setText(heroMeta, (item.type === 'episode' ? item.title + '  ·  ' : '') + metaLine(item));
    setText(heroSummary, item.summary || '');
    ambience.set(item.UltraBlurColors);
    clearTimeout(artTimer);
    artTimer = setTimeout(() => hero.set(server.image(heroArtPath(item), 1344, 756)), isFast() ? 350 : 120);
  }

  function onFocusItem(item) {
    clearTimeout(heroTimer);
    // While a key is held, skip the text repaint until the user settles.
    if (isFast()) heroTimer = setTimeout(() => showHero(item), 160);
    else showHero(item);
  }

  function layoutRows() {
    offsets = [];
    let y = 0;
    rows.forEach(r => {
      offsets.push(y);
      setTransform(r.el, 'translateY(' + y + 'px)');
      y += r.height;
    });
  }

  function renderRows() {
    rows.forEach((r, i) => {
      r.setActive(zone === 'rows' && i === rowIndex);
      toggleClass(r.el, 'above', i < rowIndex);
    });
    setTransform(track, 'translateY(' + (-(offsets[rowIndex] || 0)) + 'px)');
  }

  function setHubs(hubs) {
    const sameShape = hubs.length === rows.length && hubs.every((hb, i) => rows[i].hubId === hb.hubIdentifier);
    const focusedKey = rows[rowIndex] && rows[rowIndex].current() && rows[rowIndex].current().ratingKey;
    if (sameShape) {
      hubs.forEach((hb, i) => rows[i].setItems(hb.Metadata, i === rowIndex ? focusedKey : null));
    } else {
      track.innerHTML = '';
      rows = hubs.map(hb => {
        // Continue/On Deck are wide; show-type rows (TV shows, YouTube, and the
        // per-library "Recent <lib>" rows) hold episodes (16:9 tiles); everything
        // else is a poster row.
        let kind = 'poster';
        if (/continue|ondeck/i.test(hb.hubIdentifier)) kind = 'wide';
        else if (hb.type === 'show') kind = 'episode';
        const row = new Row({
          title: hb.title, kind, items: hb.Metadata,
          onFocus: onFocusItem, onSelect: item => openItem(item),
        });
        row.hubId = hb.hubIdentifier;
        track.appendChild(row.el);
        return row;
      });
      rowIndex = Math.min(rowIndex, Math.max(0, rows.length - 1));
      layoutRows();
    }
    renderRows();
    setText(empty, rows.length ? '' : 'Nothing here yet. Add some media to your Plex server.');
    const cur = rows[rowIndex] && rows[rowIndex].current();
    if (cur) showHero(cur);
    if (!reportedPaint && rows.length) {
      reportedPaint = true;
      log('home rows ready at ' + Math.round(performance.now()) + 'ms after page start');
    }
  }

  async function load() {
    const server = session.server;
    const profile = profileKey();
    // A profile switch can happen while Plex requests are in flight.
    const stillCurrent = () => session.server === server && profileKey() === profile;
    loadedAt = Date.now();
    try {
      // Sections first (recent rows are per-library), then hubs + recents in parallel.
      // Order the libraries by this profile's saved preference and drop any it has
      // hidden, so BOTH the nav bar and the "Recent <lib>" rows follow the same
      // curated order.
      const rawSections = await server.sections();
      if (!stillCurrent()) {
        // Legacy sessions can gain a UUID during ensureUserRole(). Restart
        // under the now-stable identity, but never revive a switched server.
        if (session.server === server) load();
        return;
      }
      allSections = rawSections;
      hiddenKeys = new Set(store.get(hiddenKey(), []));
      const ordered = orderedSections(rawSections, store.get(orderKey(), []));
      const sections = ordered.filter(s => !hiddenKeys.has(s.key));
      buildNav(sections);
      const [hubs, recent] = await Promise.all([server.hubs(), server.recentByLibrary(sections, { limit: 12 })]);
      if (!stillCurrent()) {
        if (session.server === server) load();
        return;
      }
      // Show only the two standard in-progress hubs on Home. Everything else Plex
      // returns — cross-library "Recently Added" (replaced by the per-library rows
      // below), "Recently Added Videos", and curated collections like "Oh, The
      // Horror!" — is dropped so Home stays clean.
      const stdHubs = hubs.filter(h => h.hubIdentifier === 'home.continue' || h.hubIdentifier === 'home.ondeck');
      setHubs(stdHubs.concat(recent));
      store.set('homeCache', { v: HOME_CACHE_V, server: server.id, profile, sections, hubs: stdHubs.map(slimHub), recent: recent.map(slimHub) });
    } catch (e) {
      error('home load failed', e);
      if (!rows.length) setText(empty, 'Couldn\'t load from ' + server.name + '. Press OK to retry.');
    }
  }

  const cached = store.get('homeCache');
  // Load this profile's hidden set up front so the "More ▸" item renders even
  // on the instant cached paint (before load() refetches).
  hiddenKeys = new Set(store.get(hiddenKey(), []));
  // Bump HOME_CACHE_V whenever the hub shape changes so an old cached Home
  // (e.g. one still holding "Recently Added Videos") is discarded, not flashed.
  if (cached && session.server && cached.server === session.server.id && cached.profile === profileKey() && cached.v === HOME_CACHE_V) {
    allSections = cached.sections || [];
    // Cached sections may predate a visibility or order change; apply this
    // profile's current preferences before the first paint.
    const orderedCached = orderedSections(cached.sections || [], store.get(orderKey(), []));
    buildNav(orderedCached.filter(s => !hiddenKeys.has(s.key)));
    setHubs((cached.hubs || []).concat(cached.recent || []));
  } else {
    buildNav([]);
  }
  // Inter swaps in after first paint and changes the label widths.
  if (document.fonts) document.fonts.ready.then(renderNav);
  load();

  function activateNav(n) {
    if (n.id === 'section') openLibrary(n.section);
    else if (n.id === 'livetv') router.push(LiveTvScreen());
    else if (n.id === 'vod') router.push(VodScreen());
    else if (n.id === 'search') openSearch();
    else if (n.id === 'settings') openSettings();
    else if (n.id === 'more') showMore();
  }

  return {
    el,
    name: 'home',
    onShow() {
      ambience.restore();
      if (navHasVod !== vodVisible()) buildNav(navSections); // VOD set up or removed in Settings
      renderNav(); // widths can't be measured while the screen was hidden
      // Coming back from playback: progress and Continue Watching changed.
      if (Date.now() - loadedAt > 5000) load();
    },
    onKey(action) {
      if (zone === 'nav') {
        if (reorderMode) {
          // Dragging a library: slide it, place it, hide it, or cancel.
          const cur = navItems[navIndex];
          if (action === 'left') { moveDrag(-1); return true; }
          if (action === 'right') { moveDrag(1); return true; }
          if (action === 'enter' || action === 'menu') { commitReorder(); return true; }
          if (action === 'back' || action === 'up') { cancelReorder(); return true; }
          if (action === 'down' && cur && cur.id === 'section') { hideSection(cur.section.key, cur.label); return true; }
          return true;   // swallow everything else while reordering
        }
        if (action === 'left') { navIndex = Math.max(0, navIndex - 1); renderNav(); return true; }
        if (action === 'right') { navIndex = Math.min(navItems.length - 1, navIndex + 1); renderNav(); return true; }
        if (action === 'down' && rows.length) { zone = 'rows'; renderNav(); renderRows(); return true; }
        if (action === 'enter') { activateNav(navItems[navIndex]); return true; }
        if (action === 'menu') { startReorder(); return true; }   // hold Select on a library
        if (action === 'back') return false;
        return true;
      }
      const row = rows[rowIndex];
      if (!row) {
        if (action === 'up') { zone = 'nav'; renderNav(); return true; }
        if (action === 'enter') { load(); return true; }
        return false;
      }
      switch (action) {
        case 'left': row.move(-1); return true;
        case 'right': row.move(1); return true;
        case 'up':
          if (rowIndex === 0) { zone = 'nav'; renderNav(); renderRows(); return true; }
          rowIndex--; renderRows(); onFocusItem(rows[rowIndex].current()); return true;
        case 'down':
          if (rowIndex < rows.length - 1) { rowIndex++; renderRows(); onFocusItem(rows[rowIndex].current()); }
          return true;
        case 'enter': row.select(); return true;
        case 'play': case 'playpause': if (row.current()) playItem(row.current()); return true;
        case 'menu': itemOptions(row.current(), { onChanged: load }); return true;
        case 'back':
          // Back from deep in the rows returns to the top first.
          if (rowIndex > 0 || row.index > 0) {
            rowIndex = 0; rows.forEach(r => r.focusIndex(0)); renderRows(); onFocusItem(rows[0].current());
            return true;
          }
          return false;
      }
      return false;
    },
  };
}
