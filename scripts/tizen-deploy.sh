#!/usr/bin/env bash
# Build, sign, install and launch EasyPlex on the Samsung TV set up by
# ./scripts/tizen-setup.sh.
#   ./scripts/tizen-deploy.sh                 release build, install, launch
#   ./scripts/tizen-deploy.sh --dev           readable build with logging
#   ./scripts/tizen-deploy.sh --app DIR       skip building; use an app folder
#                                             (e.g. the EasyPlex-tizen-app CI artifact)
#   ./scripts/tizen-deploy.sh --build-only    just build build/tizen/app
#   ./scripts/tizen-deploy.sh --no-run        install but don't launch
#
# Adapted from SamSUCKS (https://github.com/rfaile313/samsucks, GPL-3.0).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV=0; RUN=1; INSTALL=1; APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) DEV=1 ;;
    --no-run) RUN=0 ;;
    --build-only) INSTALL=0 ;;
    --app) APP="$(cd "$2" && pwd)"; shift ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# --- build ----------------------------------------------------------------------
if [ -z "$APP" ]; then
  command -v node >/dev/null || { echo "Node 18+ is needed to build (or pass --app with a downloaded app folder)." >&2; exit 1; }
  [ -d "$ROOT/node_modules/esbuild" ] || (cd "$ROOT" && npm ci >/dev/null)
  if [ "$DEV" = 1 ]; then node "$ROOT/scripts/build-tizen.mjs" --dev; else node "$ROOT/scripts/build-tizen.mjs"; fi
  APP="$ROOT/build/tizen/app"
fi
[ -f "$APP/config.xml" ] || { echo "$APP has no config.xml; is it the EasyPlex Tizen app folder?" >&2; exit 1; }
[ "$INSTALL" = 1 ] || exit 0

# --- package, sign, install, launch -------------------------------------------
[ -f "$ROOT/.env" ] || { echo "No .env yet. Run ./scripts/tizen-setup.sh first." >&2; exit 1; }
set -a; source "$ROOT/.env"; set +a
TIZEN_STUDIO="${TIZEN_STUDIO:-$HOME/tizen-studio}"
TIZEN_STUDIO="${TIZEN_STUDIO/\$HOME/$HOME}"
SDB="$TIZEN_STUDIO/tools/sdb"
TIZEN="$TIZEN_STUDIO/tools/ide/bin/tizen"
TARGET="$TV_IP:${TV_SDB_PORT:-26101}"
APP_ID=$(sed -n 's/.*tizen:application id="\([^"]*\)".*/\1/p' "$APP/config.xml")
PKG_DIR="$ROOT/build/tizen"
mkdir -p "$PKG_DIR"

# Package from a clean copy so the CLI's working files never end up in the app.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP/." "$STAGE/"
rm -f "$PKG_DIR"/*.wgt
"$TIZEN" package -t wgt -s "${TIZEN_SIGN_PROFILE:-easyplex}" -o "$PKG_DIR" -- "$STAGE" >/dev/null
WGT="$PKG_DIR/EasyPlex.wgt"
BUILT="$(ls "$PKG_DIR"/*.wgt | head -1)"
[ "$BUILT" = "$WGT" ] || mv "$BUILT" "$WGT"
echo "signed $WGT"

"$SDB" connect "$TARGET" >/dev/null || true
DEVICE=$("$SDB" devices | awk -v t="$TARGET" '$1 == t { print $3 }')
[ -n "$DEVICE" ] || { echo "Can't reach the TV at $TARGET. Is it on, with Developer Mode pointing at this computer? (./scripts/tizen-setup.sh checks)" >&2; exit 1; }

RESULT=$("$TIZEN" install -n "$WGT" -t "$DEVICE" 2>&1 || true)
echo "$RESULT" | grep -E 'install completed|Installed|error|fail|Fail' || true
if echo "$RESULT" | grep -qiE 'certificate|signature'; then
  cat >&2 <<EOF

  The TV refused the signature. It wants a Samsung certificate tied to this TV.
  Create one (free Samsung account; no Tizen Studio needed):
      node scripts/tizen-samsung-cert.mjs
  It signs you in through the browser, makes the certificate for this TV's DUID
  (${TV_DUID:-run ./scripts/tizen-setup.sh first to read it}), and switches .env to it.
  Then run ./scripts/tizen-deploy.sh again. See TIZEN.md for details.
EOF
  exit 1
fi
echo "$RESULT" | grep -qiE 'install completed|Installed' || { echo "$RESULT" >&2; exit 1; }
if [ "$RUN" = 1 ]; then "$TIZEN" run -p "$APP_ID" -t "$DEVICE" | tail -1; fi
