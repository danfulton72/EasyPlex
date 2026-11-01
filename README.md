# EasyPlex

A fast, remote-friendly Plex client for Android TV boxes, with a Live TV guide,
DVR recording, direct Dispatcharr playback and Dispatcharr films (VOD).

Tested on the Humax FVP-4KGTR (Android 9). Intended to work on other Android TV
and Google TV devices such as the Dangbei DBOX02 (Android 11). Not affiliated
with Plex, Humax, Dangbei, Google or Samsung.

**Samsung TVs:** there is also a Tizen build for Samsung smart TVs from 2019
onwards (written for a UE55RU7470). See [TIZEN.md](TIZEN.md) to install it.

## Project layout

| Path | What it is |
| --- | --- |
| `web/` | The user interface (HTML, CSS and JavaScript), packaged into the APK as-is |
| `web/js/screens/livetv.js` + `livetv/` | Live TV: a small coordinator plus modules for channels, guide, day guide, recordings, recording, playback and diagnostics; pure helpers in `livetv/helpers.js` |
| `web/css/livetv.css` | Live TV, options lists and dialogs |
| `web/js/xtream/api.js` | Xtream Codes client for Dispatcharr VOD: settings, `player_api.php`, stream URLs, resume points |
| `web/js/screens/vod*.js`, `web/css/vod.css` | VOD: setup, category browser, film details and player |
| `tests/` | Lint, unit, Live TV and browser tests (see BUILDING.md) |
| `android/` | The Android shell: WebView, Media3 video player and remote-key handling |
| `tizen/` | The Samsung TV build: AVPlay player, Samsung keys and a JavaScript stand-in for the Android shell (see TIZEN.md) |
| `scripts/build-tizen.mjs`, `scripts/tizen-*.sh` | Build the Samsung app for 2019 TVs (Chromium 63); set up and install it on the TV |
| `scripts/make_tv_banner.py` | Generates the Android TV launcher banner from the app icon |

Everything needed to build is in this repository; nothing is downloaded or
patched at build time.

## Build

### GitHub Actions (recommended)

Select **Actions → Build EasyPlex debug APK → Run workflow** (it also runs on
every push to `main`) and download the `EasyPlex-debug-apk` artifact. The
artifact is a ZIP; extract the APK before installing.

### Android Studio

Install Android Studio with JDK 17, SDK Platform 35 and Build-Tools. Optionally
run `python scripts/make_tv_banner.py` (needs Pillow) to generate the launcher
banner. Open `android/`, use Gradle 8.7 if asked (no wrapper is included), sync,
then **Build → Build APK(s)**. Output:
`android/app/build/outputs/apk/debug/EasyPlex-debug.apk`.

## APK updates and permanent signing

The GitHub Actions APK is signed with a persistent certificate and a version
code derived from the run number, so new builds install over old ones. **Four
repository Actions secrets must be configured once.** An APK signed with a
different key cannot upgrade an installed one.

1. Generate a keystore (JDK 17 `keytool`):

   ```bash
   keytool -genkeypair -v -keystore easyplex-release.jks -alias easyplex -keyalg RSA -keysize 3072 -validity 10000
   ```

   Back up `easyplex-release.jks` and its passwords. Never commit the keystore.

2. Encode it to one line:

   ```bash
   python -c "import base64;print(base64.b64encode(open('easyplex-release.jks','rb').read()).decode())"
   ```

3. In **Repository → Settings → Secrets and variables → Actions**, create:

   | Secret | Value |
   | --- | --- |
   | `EASYPLEX_KEYSTORE_BASE64` | Base64 text from step 2 |
   | `EASYPLEX_KEYSTORE_PASSWORD` | Keystore password |
   | `EASYPLEX_KEY_ALIAS` | Key alias (`easyplex` above) |
   | `EASYPLEX_KEY_PASSWORD` | Key password (often the keystore password) |

   Secrets created under the earlier `HUMAX_*` names are still accepted.

The workflow fails deliberately when signing secrets are missing rather than
producing a differently signed APK.

## Installing

Copy the APK to a USB stick or use a file manager / "Send files to TV" app,
then open it and allow installation from that source when prompted. Root and
ADB are not needed. EasyPlex appears in the TV's app list.

EasyPlex has its own package ID (`io.github.danfulton72.easyplex`), so it
installs alongside the older HumaxPlex app rather than replacing it; uninstall
HumaxPlex once you are happy.

## Remote keys

Remotes without colour, record or number keys (such as Google TV remotes) can
**hold OK** on any screen for an options list with the same actions.

| Where | Key | Action |
| --- | --- | --- |
| Anywhere | Hold OK / Menu | Options for the focused item or screen |
| Home | Back, Back | Exit (first press shows a reminder) |
| Library | Hold OK | Sort, unwatched only, jump to letter, item options |
| Film / show | Left / Right (hold to speed up) | Seek, with a preview before it jumps |
| Film / show | OK / Play-Pause | Show progress / pause |
| Film / show | Down or hold OK | Audio, subtitles, quality |
| Guide | OK / Play | Watch channel |
| Guide | 0–9 | Go to channel number |
| Guide | Hold OK / Menu | Watch, record, favourites, choose channel list, recordings, day guide, diagnostics |
| Guide | Left / Right | Previous / next programme |
| Guide | Up / Down, CH+ / CH− | Channel / page of channels |
| Guide | Record / Red | Record: choose episode or series and the library to save into |
| Guide | FF / RW | Forward / back one day |
| Guide | Green · Yellow · Blue | Diagnostics · channel day guide · recordings |
| Recordings | OK / Red | Cancel: one-off recording, skip one episode, or cancel a series |
| Watching | Up / CH+, Down / CH− | Next / previous channel in the current list |
| Watching | 0–9 | Go to channel number |
| Watching | Left / Last | Previous channel |
| Watching | OK / Info | Now & next banner |
| Watching | Hold OK | Record what's on, add/remove favourite |
| Watching | Right | Audio and subtitle tracks |
| Watching | Back | Return to guide |
| VOD | Up / Down, Right | Choose a category, move into its films |
| VOD | OK · Play | Film details · play (resumes where you left off) |
| VOD | Yellow · hold OK | Sort · options (resume, play from start, sort, reload, settings) |

Live TV opens on the channel you last watched. **Settings → Start screen**
can open EasyPlex straight into the Live TV guide or the last channel.

## Dispatcharr VOD (films)

EasyPlex can browse and play films from Dispatcharr's **Xtream Codes output**.
In Dispatcharr, give your user Xtream credentials (**Users** tab), then in
EasyPlex open **Settings → Dispatcharr VOD**. The server address is filled in
from your Plex Live TV tuner when Dispatcharr is set up as one; enter the
username and password with the TV keyboard and choose **Test and save**. A
**VOD** item then appears on the home bar.

Only the Plex Home admin profile can change these settings. Under **Settings →
Dispatcharr VOD → Categories for each profile** the admin can limit which film
categories each Plex Home profile (for example a child's) sees. A limited
profile only sees the ticked categories; categories your provider adds later
stay hidden until ticked, and a profile with none ticked has no VOD item at
all. Give the admin profile a PIN in Plex so the children can't switch to it.
The limits are kept on the box, and only control what EasyPlex shows: for a
second layer, give the children their own Dispatcharr user with **Hide mature
content** on.

Films play straight from Dispatcharr in the native player, with the same
seeking, HUD and failure screen as Plex films. Where you stopped is remembered
on the box for each Plex profile (Continue watching), not in Plex. The Xtream password is stored on
the box in the app's own storage, as the Plex sign-in is.

## YouTube SponsorBlock (Tube Archivist)

EasyPlex can automatically skip Tube Archivist's SponsorBlock segments in a dedicated
Plex YouTube library. This is optional and **off by default**. Source files are
never modified.

1. Enable SponsorBlock in Tube Archivist and confirm the video files have a
   bracketed 11-character YouTube ID before the extension
   (for example `My Video [dQw4w9WgXcQ].mkv`).
2. In EasyPlex sign in as the Plex Home admin and open
   **Settings → YouTube SponsorBlock**.
3. Enter the Tube Archivist server URL (reachable from the TV), the Tube
   Archivist API token from Tube Archivist's settings, and select the
   matching Plex library.
4. Select categories and enable automatic skipping.

The app requests `GET /api/video/<youtube-id>/sponsor/` with Tube Archivist's
`Authorization: Token` header. On Android the native bridge makes this
request (to avoid WebView CORS issues); in the browser preview, the server
must allow cross-origin requests. The token is kept locally in EasyPlex
settings, like Dispatcharr VOD credentials; don't expose it publicly.
For cleartext HTTP servers the token travels unencrypted on the network:
prefer HTTPS, or use HTTP only on a trusted LAN.

Library scoping is enforced by Plex's `librarySectionID`; playback in all
other libraries is unaffected. If a video has no matching filename/segment
data or the API is unreachable, it plays normally. Direct-play seeks use
Media3 seeking; HLS seeks restart the Plex transcode at the target position.

## Licence

EasyPlex is free software under the GNU GPL v3; see [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md) for attribution. See [BUILDING.md](BUILDING.md) for
troubleshooting.
