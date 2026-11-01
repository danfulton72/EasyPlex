// Films from an Xtream Codes compatible server (Dispatcharr's Xtream output):
// settings, the player_api.php client, stream URLs and local resume points.
import * as store from '../util/store.js';
import { profileKey } from '../session.js';
import { proxiedImage } from '../platform/device.js';

const CONFIG_KEY = 'xtream';
const RESUME_KEY = 'xtreamResume';   // + ':' + Plex profile: each profile has its own
const RESUME_MAX = 40;
const TIMEOUT_MS = 20000;

// "dispatcharr.lan:9191/" -> "http://dispatcharr.lan:9191"; also accepts a
// pasted player_api.php or get.php URL, or a Plex tuner URI ending /hdhr.
export function normaliseServer(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/[?#].*$/, '')
    .replace(/\/(player_api|get|xmltv)\.php$/i, '')
    .replace(/\/hdhr\/?$/i, '')
    .replace(/\/+$/, '');
  return s;
}

export function loadConfig() {
  const c = store.get(CONFIG_KEY, null);
  return c && c.server && c.username ? c : null;
}

export function saveConfig(cfg) {
  store.set(CONFIG_KEY, { server: normaliseServer(cfg.server), username: String(cfg.username || '').trim(), password: String(cfg.password || '') });
}

export function clearConfig() {
  store.set(CONFIG_KEY, undefined);
}

export function isConfigured() {
  return !!loadConfig();
}

// Absolute artwork URLs, through the platform's image proxy when it has one.
export function imageUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return proxiedImage(url) || url;
}

export class XtreamError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// What to tell the viewer for a failed request.
export function friendlyError(err) {
  const s = err && err.status;
  if (s === 401) return 'The username or password was not accepted.';
  if (s === 403) return 'The server refused this box (check Dispatcharr\'s network access settings).';
  if (s === 429) return 'Too many sign-in attempts. Wait a minute and try again.';
  if (s === 404) return 'No Xtream service found at that address.';
  if (s >= 500) return 'The server had a problem (HTTP ' + s + ').';
  if (err && err.name === 'AbortError') return 'The server took too long to answer.';
  return (err && err.message) || 'Could not reach the server.';
}

export class XtreamClient {
  constructor(cfg, fetchImpl) {
    this.server = normaliseServer(cfg.server);
    this.username = cfg.username;
    this.password = cfg.password;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  apiUrl(params) {
    const q = new URLSearchParams(Object.assign({ username: this.username, password: this.password }, params));
    return this.server + '/player_api.php?' + q.toString();
  }

  async call(params = {}) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : 0;
    let res;
    try {
      res = await this.fetch(this.apiUrl(params), { headers: { Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new XtreamError('Could not reach ' + this.server + '.', 0);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new XtreamError('HTTP ' + res.status, res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new XtreamError('The server did not answer like an Xtream service.', 0); }
  }

  // Sign in. Resolves user_info; rejects with a 401 XtreamError if refused.
  async auth() {
    const r = await this.call();
    const info = r && r.user_info;
    if (!info || Number(info.auth) !== 1) throw new XtreamError('Unauthorized', 401);
    if (info.status && String(info.status).toLowerCase() !== 'active') throw new XtreamError('This account is ' + info.status + '.', 403);
    return info;
  }

  async categories() {
    const r = await this.call({ action: 'get_vod_categories' });
    return (Array.isArray(r) ? r : []).map(c => ({ id: String(c.category_id), name: String(c.category_name || 'Films') }));
  }

  async movies(categoryId) {
    const r = await this.call(categoryId != null ? { action: 'get_vod_streams', category_id: categoryId } : { action: 'get_vod_streams' });
    return (Array.isArray(r) ? r : []).map(movieItem);
  }

  async info(id) {
    const r = await this.call({ action: 'get_vod_info', vod_id: id });
    return movieInfo(r, id);
  }

  streamUrl(id, ext) {
    return this.server + '/movie/' + encodeURIComponent(this.username) + '/' + encodeURIComponent(this.password) + '/' +
      encodeURIComponent(id) + '.' + (ext || 'mp4');
  }
}

// Titles often carry the year, e.g. "Heat (1995)".
function splitYear(name, year) {
  const m = /^(.*?)\s*[([](\d{4})[)\]]\s*$/.exec(name);
  if (m) return { title: m[1], year: year || m[2] };
  return { title: name, year: year || '' };
}

function yearOf(v) {
  const m = /(\d{4})/.exec(String(v || ''));
  return m ? m[1] : '';
}

// One entry from get_vod_streams, shaped like a Plex item so tiles can show it.
export function movieItem(s) {
  const { title, year } = splitYear(String(s.name || 'Untitled').trim(), yearOf(s.year || s.release_date));
  return {
    type: 'xtream-movie',
    id: String(s.stream_id),
    title,
    year,
    posterUrl: s.stream_icon || '',
    rating: Number(s.rating) || 0,
    ext: s.container_extension || 'mp4',
    plot: s.plot || '',
    genre: s.genre || '',
    added: Number(s.added) || 0,
    categoryId: s.category_id != null ? String(s.category_id) : '',
  };
}

function seconds(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const parts = String(v).split(':').map(Number);
  if (parts.some(isNaN)) return Number(v) || 0;
  return parts.reduce((t, p) => t * 60 + p, 0);
}

// get_vod_info -> detail fields.
export function movieInfo(r, id) {
  const i = (r && r.info) || {};
  const d = (r && r.movie_data) || {};
  const { title, year } = splitYear(String(i.name || d.name || 'Untitled').trim(), yearOf(i.year || i.release_date || i.releasedate));
  const backdrops = Array.isArray(i.backdrop_path) ? i.backdrop_path : (i.backdrop_path ? [i.backdrop_path] : []);
  const dur = seconds(i.duration_secs) || seconds(i.duration);
  return {
    type: 'xtream-movie',
    id: String(d.stream_id != null ? d.stream_id : id),
    title,
    year,
    posterUrl: i.cover_big || i.movie_image || i.cover || '',
    backdropUrl: backdrops.find(Boolean) || '',
    plot: i.plot || i.description || '',
    genre: i.genre || '',
    director: i.director || '',
    cast: i.cast || i.actors || '',
    country: i.country || '',
    rating: Number(i.rating) || 0,
    duration: dur * 1000,
    ext: d.container_extension || 'mp4',
  };
}

// ---- resume points --------------------------------------------------------
// Kept on the box per Plex profile:
// { id, title, year, posterUrl, ext, categoryId, position, duration, at }.

function resumeKey() { return RESUME_KEY + ':' + profileKey(); }

export function resumeList() {
  const list = store.get(resumeKey(), []);
  return Array.isArray(list) ? list : [];
}

export function resumeFor(id) {
  return resumeList().find(r => r.id === String(id)) || null;
}

// Save where playback stopped. Near the start or end clears the entry.
export function saveResume(movie, position, duration) {
  const id = String(movie.id);
  let list = resumeList().filter(r => r.id !== id);
  const finished = duration > 0 && position > duration - Math.max(120000, duration * 0.05);
  if (position > 60000 && !finished) {
    list.unshift({
      id, title: movie.title, year: movie.year || '', posterUrl: movie.posterUrl || '', ext: movie.ext || 'mp4',
      categoryId: movie.categoryId || '',
      position: Math.floor(position), duration: Math.floor(duration || 0), at: Date.now(),
    });
  }
  list = list.slice(0, RESUME_MAX);
  store.set(resumeKey(), list);
}

export function clearResume(id) {
  store.set(resumeKey(), resumeList().filter(r => r.id !== String(id)));
}

// Resume entries as tile items (the progress bar reads viewOffset/duration).
export function resumeItems() {
  return resumeList().map(r => ({
    type: 'xtream-movie', id: r.id, title: r.title, year: r.year, posterUrl: r.posterUrl, ext: r.ext,
    categoryId: r.categoryId || '', viewOffset: r.position, duration: r.duration,
  }));
}
