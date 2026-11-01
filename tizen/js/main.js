// Tizen entry point: polyfills, the shell (Android-bridge stand-in), then the
// shared web UI from web/js. Bundled by scripts/build-tizen.mjs.
import './polyfills.js';
import './install-shell.js';
import '../../web/js/main.js';
