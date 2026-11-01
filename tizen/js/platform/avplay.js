// AVPlay is one shared player per app. Films/VOD (platform/player.js) and
// live TV (shell.js) take turns: whoever opens next stops the previous user.

let current = null;

export function avplayAvailable() {
  return typeof webapis !== 'undefined' && !!webapis.avplay;
}

// Stop and close the player, whatever state it is in.
function hardStop() {
  try { webapis.avplay.stop(); } catch (e) { /* idle */ }
  try { webapis.avplay.close(); } catch (e) { /* already closed */ }
}

// Take the player. onLost runs if someone else takes it later.
export function claimAvplay(name, onLost) {
  if (current) {
    const prev = current;
    current = null;
    hardStop();
    try { prev.onLost(); } catch (e) { /* ignore */ }
  }
  current = { name, onLost: onLost || (() => {}) };
  return current;
}

export function releaseAvplay(token) {
  if (!token || token !== current) return;
  current = null;
  hardStop();
}

export function avplayOwner() {
  return current ? current.name : null;
}
