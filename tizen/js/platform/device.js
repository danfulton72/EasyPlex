// Device layer for Samsung Tizen TVs (built for 2019 models: Tizen 5.0,
// Chromium 63). Replaces web/js/platform/device.js in the Tizen build; the
// exports must match that file. Keys reach the page as normal keydown events
// (see tizen/js/shell.js for hold-OK and the live TV key routing).

export const isTizen = typeof window !== 'undefined' && typeof window.tizen !== 'undefined';

// Samsung remote key codes, plus desktop keys so the build also runs in Chrome.
const KEYMAP = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter',
  10009: 'back', 8: 'back', 27: 'back',
  10252: 'playpause', 32: 'playpause', 415: 'play', 19: 'pause', 413: 'stop',
  417: 'ff', 412: 'rw', 416: 'record',
  427: 'pageup', 428: 'pagedown', 33: 'pageup', 34: 'pagedown',
  // Red doubles as Record, as on the Android build.
  403: 'record', 404: 'green', 405: 'yellow', 406: 'blue',
  457: 'info', 10073: 'info', 10190: 'last', 18: 'menu', 77: 'menu',
};
for (let d = 0; d <= 9; d++) KEYMAP[48 + d] = 'digit' + d;

export function actionFor(e) {
  return KEYMAP[e.keyCode] || null;
}

// Remote keys a Tizen app only receives after asking for them. Keys the TV
// doesn't have (or that this remote lacks) are skipped.
const WANTED_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward',
  'MediaRewind', 'MediaRecord', 'ChannelUp', 'ChannelDown', 'PreviousChannel',
  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function registerKeys() {
  if (!isTizen) return;
  let supported = null;
  try { supported = tizen.tvinputdevice.getSupportedKeys().map(k => k.name); } catch (e) { supported = null; }
  WANTED_KEYS.forEach(k => {
    if (supported && supported.indexOf(k) === -1) return;
    try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* not on this model */ }
  });
}

export const PLATFORM_LABEL = 'Plex for Samsung TV';

// Tizen loads http images directly, so Plex's resizer is used (no proxy).
export function proxiedImage() {
  return null;
}

export function exitApp() {
  try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
}

function tizenVersion() {
  try { return String(tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version') || ''); } catch (e) { return ''; }
}

function appVersion() {
  try { return String(tizen.application.getAppInfo().version || ''); } catch (e) { return ''; }
}

// Identity reported to Plex. "Tizen" would select PMS's built-in profile for the
// official Samsung app, which rejects our transcode requests, so we say
// "Samsung" and describe what we can play in profileExtra (as SamSUCKS does).
let cached = null;
export function deviceInfo() {
  if (cached) return cached;
  let model = 'Browser';
  let name = 'EasyPlex';
  try { model = webapis.productinfo.getRealModel() || webapis.productinfo.getModel() || model; } catch (e) { /* desktop */ }
  try { name = 'Samsung ' + (webapis.productinfo.getModel() || 'TV'); } catch (e) { /* desktop */ }
  cached = {
    model,
    name,
    platform: isTizen ? 'Samsung' : 'Web',
    version: tizenVersion(),
    appVersion: appVersion(),
    profileExtra: [
      'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3)',
      'add-direct-play-profile(type=videoProfile&container=mp4,mkv&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3)',
    ],
  };
  return cached;
}

// Samsung's keyboard opens when a text field gets focus.
export function showKeyboard(input) {
  if (input) input.focus();
}

export function hideKeyboard(input) {
  if (input) input.blur();
}

export function supports4K() {
  try { return !!webapis.productinfo.isUdPanelSupported(); } catch (e) { return false; }
}

// What a 2019 Samsung TV decodes in hardware. AV1 only arrived on 2020 models.
const DECODERS = {
  'video/avc': 1, 'video/hevc': 1, 'video/x-vnd.on2.vp9': 1, 'video/vp9': 1,
  'video/mpeg2': 1, 'audio/mp4a-latm': 1, 'audio/ac3': 1, 'audio/eac3': 1, 'audio/mpeg': 1,
};
export function canDecode(mime) {
  return !isTizen || !!DECODERS[String(mime).toLowerCase()];
}
export function canDecodeHW(mime) {
  return canDecode(mime);
}

// Keep the screen saver away during playback.
export function setScreenSaver(on) {
  try {
    const s = webapis.appcommon.AppCommonScreenSaverState;
    webapis.appcommon.setScreenSaver(on ? s.SCREEN_SAVER_ON : s.SCREEN_SAVER_OFF);
  } catch (e) { /* desktop */ }
}
