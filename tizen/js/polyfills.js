// Small polyfills for the 2019 Samsung web engine (Chromium 63). Syntax
// (?. ?? ||= and friends) is lowered by the build; these cover missing APIs.

// AbortController (Chromium 66) and fetch({ signal }). The app uses it for
// request timeouts; without it a dead server would hang a screen forever.
if (typeof window.AbortController === 'undefined') {
  class Signal {
    constructor() { this.aborted = false; this.onabort = null; this._listeners = []; }
    addEventListener(type, fn) { if (type === 'abort') this._listeners.push(fn); }
    removeEventListener(type, fn) { this._listeners = this._listeners.filter(f => f !== fn); }
    _fire() {
      if (this.aborted) return;
      this.aborted = true;
      const ev = { type: 'abort', target: this };
      if (typeof this.onabort === 'function') this.onabort(ev);
      this._listeners.slice().forEach(fn => { try { fn(ev); } catch (e) { /* ignore */ } });
    }
  }
  class AbortController {
    constructor() { this.signal = new Signal(); }
    abort() { this.signal._fire(); }
  }
  window.AbortController = AbortController;
  window.AbortSignal = Signal;

  const nativeFetch = window.fetch.bind(window);
  const abortError = () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  };
  window.fetch = function (input, init) {
    const signal = init && init.signal;
    if (!signal || !(signal instanceof Signal)) return nativeFetch(input, init);
    if (signal.aborted) return Promise.reject(abortError());
    const rest = Object.assign({}, init);
    delete rest.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort);
      nativeFetch(input, rest).then(
        res => { signal.removeEventListener('abort', onAbort); resolve(res); },
        err => { signal.removeEventListener('abort', onAbort); reject(err); });
    });
  };
}

// Promise.allSettled (Chromium 76).
if (!Promise.allSettled) {
  Promise.allSettled = list => Promise.all(Array.from(list, p => Promise.resolve(p).then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }))));
}

// Small array/string/object helpers, in case a later change starts using them.
if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true, writable: true,
    value: function flat(depth) {
      const d = depth === undefined ? 1 : Number(depth);
      return d < 1 ? Array.prototype.slice.call(this)
        : Array.prototype.reduce.call(this, (acc, v) => acc.concat(Array.isArray(v) ? flat.call(v, d - 1) : v), []);
    },
  });
}
if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true, writable: true,
    value: function flatMap(fn, thisArg) { return Array.prototype.map.call(this, fn, thisArg).flat(); },
  });
}
if (!Object.fromEntries) {
  Object.fromEntries = entries => {
    const o = {};
    Array.from(entries, ([k, v]) => { o[k] = v; });
    return o;
  };
}
if (!String.prototype.replaceAll) {
  Object.defineProperty(String.prototype, 'replaceAll', {
    configurable: true, writable: true,
    value: function replaceAll(search, replacement) {
      if (search instanceof RegExp) return this.replace(search, replacement);
      return this.split(String(search)).join(String(replacement));
    },
  });
}
if (typeof window.globalThis === 'undefined') window.globalThis = window;

// Flex "gap" arrived in Chromium 84; the build adds margin-based fallbacks
// under html.no-flex-gap (see scripts/build-tizen.mjs).
(function detectFlexGap() {
  const probe = () => {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    box.appendChild(document.createElement('div'));
    box.appendChild(document.createElement('div'));
    document.body.appendChild(box);
    const ok = box.scrollHeight === 1;
    document.body.removeChild(box);
    if (!ok) document.documentElement.classList.add('no-flex-gap');
  };
  if (document.body) probe();
  else document.addEventListener('DOMContentLoaded', probe);
}());
