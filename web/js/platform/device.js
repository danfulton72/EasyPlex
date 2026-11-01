// Device layer for Android TV. The native shell (MainActivity) exposes
// window.EasyPlexVideo; in a desktop browser the fallbacks keep the UI usable.

// keyCode → action, for keyboards in a desktop browser. On the TV the native
// shell maps remote keys and calls window.__androidAction directly.
const KEYMAP = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter',
  8: 'back', 27: 'back', 32: 'playpause', 19: 'pause',
  33: 'pageup', 34: 'pagedown', 77: 'menu',
};

export function actionFor(e) {
  return KEYMAP[e.keyCode] || null;
}

function native() {
  return typeof EasyPlexVideo !== 'undefined' ? EasyPlexVideo : null;
}

// Shown under the EasyPlex wordmark on Home.
export const PLATFORM_LABEL = 'Plex for Android TV';

// Absolute artwork URLs go through the shell's image proxy on the box (the
// WebView can't always load plain http images from the https page).
export function proxiedImage(url) {
  return native() ? 'https://appassets.androidplatform.net/pleximg?url=' + encodeURIComponent(url) : null;
}

export function exitApp() {
  const n = native();
  if (n && typeof n.exit === 'function') n.exit();
  else window.close();
}

// Identity reported to Plex. The platform stays "Android" so the server uses
// its generic profile plus our own X-Plex-Client-Profile-Extra.
let cached = null;
export function deviceInfo() {
  if (cached) return cached;
  let info = {};
  try {
    const n = native();
    if (n && typeof n.deviceInfo === 'function') info = JSON.parse(n.deviceInfo()) || {};
  } catch (e) { info = {}; }
  const maker = String(info.manufacturer || '').trim();
  const model = String(info.model || '').trim() || 'Browser';
  const name = maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? maker + ' ' + model : model;
  cached = {
    model,
    name: name || 'EasyPlex',
    platform: 'Android',
    version: String(info.release || ''),
    appVersion: String(info.appVersion || ''),
  };
  return cached;
}

// Raise the on-screen keyboard for a text field. Remote keys reach the page as
// actions from the native shell, so input.focus() alone never counts as the
// user selecting the field and Android keeps the keyboard down.
export function showKeyboard(input) {
  if (input) input.focus();
  const n = native();
  if (n && typeof n.showKeyboard === 'function') setTimeout(() => n.showKeyboard(), 60);
}

export function hideKeyboard(input) {
  if (input) input.blur();
  const n = native();
  if (n && typeof n.hideKeyboard === 'function') n.hideKeyboard();
}

// Transcode targets stay at 1080p-friendly defaults; the native player asks
// for higher quality explicitly through the quality menu.
export function supports4K() {
  return false;
}

// Can this box decode the given MIME type (e.g. 'video/av01')? Asks the native
// shell, which checks MediaCodecList. Cached per type. In a desktop browser we
// can't know, so report true and let the HTML5 <video> fallback handle it.
const decodeCache = {};
export function canDecode(mime) {
  if (mime in decodeCache) return decodeCache[mime];
  let result = true; // browser default: we can't query, so assume yes and let <video> handle it
  try {
    const n = native();
    if (n && typeof n.canDecode === 'function') {
      const r = n.canDecode(mime);
      // Native answers "1" (yes), "0" (no), or "" (query failed). On failure we
      // err toward transcoding only for codecs we specifically gate, so treat
      // "" as "unknown -> don't direct-play the exotic codec".
      result = r === '1';
    }
  } catch (e) { result = true; }
  decodeCache[mime] = result;
  return result;
}

// Can this box decode the MIME type in HARDWARE? Same contract as canDecode but
// the native side ignores the generic software decoder (android.* / c2.android.*).
// Used to avoid direct-playing a codec that only has a slow software path (which
// pegs the CPU and judders on mid-range boxes). Browser default is true so the
// HTML5 <video> fallback still applies when there's no native shell.
const hwDecodeCache = {};
export function canDecodeHW(mime) {
  if (mime in hwDecodeCache) return hwDecodeCache[mime];
  let result = true; // browser default
  try {
    const n = native();
    if (n && typeof n.canDecodeHW === 'function') {
      result = n.canDecodeHW(mime) === '1';
    }
  } catch (e) { result = true; }
  hwDecodeCache[mime] = result;
  return result;
}

// The native shell keeps the screen awake while video plays.
export function setScreenSaver() {}
