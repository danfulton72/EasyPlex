#!/usr/bin/env bash
# One-time setup for installing EasyPlex on a Samsung TV (written for a 2019
# UE55RU7470, Tizen 5.0; newer Samsung TVs work too). Installs Samsung's
# command-line tools, finds the TV, creates a signing certificate and writes
# .env. Safe to run again; finished steps are skipped.
#   ./scripts/tizen-setup.sh
#
# Adapted from SamSUCKS (https://github.com/rfaile313/samsucks, GPL-3.0).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/.env"
TIZEN_VERSION=6.1

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\n  \033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

get_env() { [ -f "$ENV" ] && sed -n "s/^$1=//p" "$ENV" | tail -1 || true; }
set_env() {
  if grep -q "^$1=" "$ENV"; then KEY="$1" VAL="$2" perl -pi -e 's/^\Q$ENV{KEY}\E=.*/$ENV{KEY}=$ENV{VAL}/' "$ENV"
  else printf '%s=%s\n' "$1" "$2" >> "$ENV"; fi
}

# --- 1. Tizen command-line tools ----------------------------------------------
bold "1/5  Samsung Tizen tools"
case "$(uname -s)" in
  Darwin) INSTALLER="web-cli_Tizen_Studio_${TIZEN_VERSION}_macos-64.bin" ;;
  Linux) INSTALLER="web-cli_Tizen_Studio_${TIZEN_VERSION}_ubuntu-64.bin" ;;
  *) fail "Only macOS and Linux are supported by this script. On Windows, see TIZEN.md (Tizen Studio)." ;;
esac
[ -f "$ENV" ] || cp "$ROOT/tizen/env.example" "$ENV"
TIZEN_STUDIO="$(get_env TIZEN_STUDIO)"; TIZEN_STUDIO="${TIZEN_STUDIO/\$HOME/$HOME}"; TIZEN_STUDIO="${TIZEN_STUDIO:-$HOME/tizen-studio}"
TIZEN="$TIZEN_STUDIO/tools/ide/bin/tizen"
SDB="$TIZEN_STUDIO/tools/sdb"
PM="$TIZEN_STUDIO/package-manager/package-manager-cli.bin"

if [ -x "$TIZEN" ]; then
  ok "already installed in $TIZEN_STUDIO"
else
  echo "  Downloading $INSTALLER (~270 MB)…"
  TMP="$(mktemp -d)"
  curl -fL --progress-bar -o "$TMP/$INSTALLER" "https://download.tizen.org/sdk/Installer/tizen-studio_${TIZEN_VERSION}/$INSTALLER"
  chmod +x "$TMP/$INSTALLER"
  "$TMP/$INSTALLER" --accept-license "$TIZEN_STUDIO" >/dev/null
  rm -rf "$TMP"
  ok "installed in $TIZEN_STUDIO"
fi

PACKAGES="cert-add-on TV-SAMSUNG-Public-WebAppDevelopment TV-SAMSUNG-Extension-Tools Certificate-Manager"
INSTALLED=$("$PM" show-pkgs 2>/dev/null | awk '$1 == "i" { print $2 }')
MISSING=""
for p in $PACKAGES; do echo "$INSTALLED" | grep -qx "$p" || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  echo "  Installing Samsung TV extensions (a few minutes)…"
  "$PM" install --accept-license $MISSING >/dev/null
fi
ok "Samsung TV extensions"

# --- 2. Node (to build the app) --------------------------------------------------
bold "2/5  Build tools"
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  if [ ! -d "$ROOT/node_modules/esbuild" ]; then (cd "$ROOT" && npm ci >/dev/null); fi
  ok "Node $(node -v) and esbuild"
else
  warn "Node 18+ not found. Install it (https://nodejs.org) to build, or download the"
  warn "EasyPlex-tizen-app artifact from GitHub Actions and use: ./scripts/tizen-deploy.sh --app <folder>"
fi

# --- 3. Find the TV -------------------------------------------------------------
bold "3/5  Finding your TV"
if [ "$(uname -s)" = Darwin ]; then
  IFACE=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')
  MY_IP=$(ipconfig getifaddr "${IFACE:-en0}" 2>/dev/null || true)
else
  MY_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
fi
[ -n "$MY_IP" ] || fail "Couldn't work out this computer's IP address. Are you on Wi-Fi or Ethernet?"
ok "this computer is $MY_IP"

tv_info() { curl -s -m 2 "http://$1:8001/api/v2/" 2>/dev/null || true; }
field() { sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" <<<"$2" | head -1; }

TV_IP="$(get_env TV_IP)"
INFO=""
[ -n "$TV_IP" ] && INFO=$(tv_info "$TV_IP")
if [ -z "$INFO" ]; then
  echo "  Scanning ${MY_IP%.*}.0/24 for Samsung TVs (make sure the TV is on)…"
  FOUND=()
  TMP="$(mktemp -d)"
  for i in $(seq 1 254); do
    ( r=$(tv_info "${MY_IP%.*}.$i"); grep -q '"type" *: *"Samsung SmartTV"' <<<"$r" && echo "$r" > "$TMP/${MY_IP%.*}.$i" ) &
  done
  wait
  for f in "$TMP"/*; do [ -e "$f" ] && FOUND+=("$(basename "$f")"); done
  if [ ${#FOUND[@]} -eq 0 ]; then
    rm -rf "$TMP"
    echo "  No TV answered. If you know its IP (TV: Settings → General → Network → Network Status → IP Settings),"
    read -rp "  type it here (or press Enter to stop): " TV_IP
    [ -n "$TV_IP" ] || fail "No Samsung TV found. Is it on, and on the same network as this computer?"
    INFO=$(tv_info "$TV_IP")
  else
    if [ ${#FOUND[@]} -eq 1 ]; then
      TV_IP="${FOUND[0]}"
    else
      echo "  Found ${#FOUND[@]} TVs:"
      for n in "${!FOUND[@]}"; do echo "    $((n + 1))) ${FOUND[$n]}  $(field name "$(cat "$TMP/${FOUND[$n]}")")"; done
      read -rp "  Which one? [1] " PICK
      TV_IP="${FOUND[$(( ${PICK:-1} - 1 ))]}"
    fi
    INFO=$(cat "$TMP/$TV_IP")
    rm -rf "$TMP"
  fi
fi
TV_NAME=$(field name "$INFO"); TV_MODEL=$(field modelName "$INFO")
ok "${TV_NAME:-Samsung TV} (${TV_MODEL:-model unknown}) at $TV_IP"
set_env TV_IP "$TV_IP"
set_env TV_MODEL "$TV_MODEL"

# --- 4. Developer Mode ---------------------------------------------------------------
bold "4/5  Developer Mode"
DEV_MODE=$(field developerMode "$INFO"); DEV_IP=$(field developerIP "$INFO")
dev_mode_help() {
  cat <<EOF

  On the TV:
    1. Press Home and open Apps.
    2. On the Apps screen, type 1 2 3 4 5 on the remote.
       (No number keys? Press the 123 button for the on-screen keypad.
        Nothing happened? Try again a little faster.)
    3. Turn Developer mode On, and enter this computer's IP: $MY_IP
    4. Choose OK, then restart the TV: hold the Power button until it turns off and back on
       (a quick press only puts it in standby, which does not apply the change).

  Then run ./scripts/tizen-setup.sh again.
EOF
}
if [ -z "$DEV_MODE" ]; then
  # Some firmware doesn't report it; try connecting instead.
  warn "this TV doesn't report Developer Mode; checking by connecting"
elif [ "$DEV_MODE" != 1 ] || [ "$DEV_IP" != "$MY_IP" ]; then
  if [ "$DEV_MODE" = 1 ]; then echo "  Developer Mode is on, but it points at $DEV_IP instead of this computer."
  else echo "  Developer Mode is off."; fi
  dev_mode_help
  exit 1
else
  ok "Developer Mode is on and points at this computer"
fi

"$SDB" connect "$TV_IP:26101" >/dev/null 2>&1 || true
if ! "$SDB" devices | grep -q "^$TV_IP:26101"; then
  echo "  The TV didn't accept a connection."
  dev_mode_help
  exit 1
fi
ok "connected"
DUID=$("$SDB" -s "$TV_IP:26101" shell 0 getduid 2>/dev/null | tr -d '\r' | tail -1 || true)
[ -n "$DUID" ] && set_env TV_DUID "$DUID" && ok "TV DUID $DUID (only needed for a Samsung certificate)"

# --- 5. Signing certificate -----------------------------------------------------
bold "5/5  Signing certificate"
PROFILE="$(get_env TIZEN_SIGN_PROFILE)"; PROFILE="${PROFILE:-easyplex}"
set_env TIZEN_SIGN_PROFILE "$PROFILE"
if "$TIZEN" security-profiles list 2>/dev/null | grep -q "^$PROFILE "; then
  ok "profile '$PROFILE' already exists"
else
  PW="$(get_env TIZEN_CERT_PASSWORD)"
  [ -n "$PW" ] || PW=$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 24)
  set_env TIZEN_CERT_PASSWORD "$PW"
  "$TIZEN" certificate -a "$PROFILE" -p "$PW" -f "$PROFILE" >/dev/null
  "$TIZEN" security-profiles add -n "$PROFILE" -a "$HOME/tizen-studio-data/keystore/author/$PROFILE.p12" -p "$PW" >/dev/null
  ok "created profile '$PROFILE' (password saved in .env)"
fi
"$TIZEN" cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml" >/dev/null

printf '\n\033[1mAll set.\033[0m Install EasyPlex on your TV with:\n\n    ./scripts/tizen-deploy.sh\n\n'
