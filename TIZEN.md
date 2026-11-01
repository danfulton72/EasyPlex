# EasyPlex on Samsung TVs (Tizen)

EasyPlex also runs on Samsung smart TVs. This build was written for a 2019
**UE55RU7470UXXU** (Tizen 5.0) and works on Samsung TVs from 2019 onwards.

It is the same app as the Android version (`web/`): Plex libraries, Live TV
guide and DVR, direct Dispatcharr playback, Dispatcharr films and SponsorBlock.
Only the layer underneath changes: Samsung's hardware video player (AVPlay)
instead of Media3, and Samsung remote keys.

## Why a 2019 TV needs its own build

[SamSUCKS](https://github.com/rfaile313/samsucks), which EasyPlex's UI started
from, ships its code unbundled and needs a 2020 or newer Samsung (Tizen 5.5+,
Chromium 69+). A 2019 TV runs **Chromium 63**, which can't run EasyPlex's code
as written, so `scripts/build-tizen.mjs`:

| 2019 limitation | What the build does |
| --- | --- |
| No `?.`, `??`, `\|\|=`, `catch {}` (Chromium 80/85/66) | esbuild bundles everything into one script lowered to Chromium 63 |
| ES module loading from the app package is unreliable | One classic `<script>`; no module graph to fetch |
| No `AbortController` (66), `Promise.allSettled` (76) | Polyfills in `tizen/js/polyfills.js`, so request timeouts still work |
| No flex `gap` (84), no `inset` (87) | `inset` expanded; `gap` gets margin fallbacks, switched on only when the TV lacks it |
| SamSUCKS's `config.xml` requires Tizen 6.5 | `required_version="5.0"` |
| No AV1 decoder; no DTS | AV1 isn't offered for direct play; DTS audio is converted by Plex (AC3), video untouched |

## Install

You need a Mac or Linux computer (Windows: see below) on the same network as
the TV, and either Node 18+ (to build) or the `EasyPlex-tizen-app` artifact
from GitHub Actions.

**1. Get the code**

```sh
git clone https://github.com/danfulton72/EasyPlex.git
cd EasyPlex
```

**2. Turn on Developer Mode on the TV**

1. Press **Home** and open **Apps**.
2. On the Apps screen, type **1 2 3 4 5** with the remote's number keys. No
   number keys? Press the **123** button for the on-screen keypad. Nothing
   happened? Try again a little faster.
3. Switch **Developer mode** **On** and enter your computer's IP address
   (the setup script prints it).
4. Choose **OK**, then **hold** the Power button until the TV turns off and
   back on. A quick press only puts it in standby, which doesn't apply the
   change. The Apps screen then shows **Develop mode** at the top.

**3. Run setup** (one time)

```sh
./scripts/tizen-setup.sh
```

It installs Samsung's command-line tools (about 270 MB, into `~/tizen-studio`),
finds the TV, checks Developer Mode, connects, reads the TV's DUID and creates a
signing certificate. Settings are kept in `.env` (git-ignored). Run it again
after fixing anything it reports; finished steps are skipped.

**4. Install**

```sh
./scripts/tizen-deploy.sh
```

This builds `build/tizen/app`, signs it into `build/tizen/EasyPlex.wgt`,
installs it and starts it. Sign in with the code at
[plex.tv/link](https://plex.tv/link) as on Android.

No Node? Download **EasyPlex-tizen-app** from the latest **Tests** run in
GitHub Actions, unzip it and run `./scripts/tizen-deploy.sh --app <that folder>`.

### Opening it later

**Home → Apps**, scroll to the bottom. To pin it, highlight EasyPlex, hold OK
(or press Down) and choose **Add to Home**.

### "Check certificate error" when installing

Some Samsung firmware only accepts apps signed with a **Samsung certificate**
tied to the TV. If the install fails with a certificate or signature error:

1. Install [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
   with the GUI and, in Package Manager → Extension SDK, add **Samsung
   Certificate Extension**.
2. Open **Certificate Manager** → **+** → **Samsung** → **TV**. Sign in with a
   (free) Samsung account and create a new author certificate.
3. For the distributor certificate choose privilege **Public** and add your
   TV's DUID (setup saved it in `.env` as `TV_DUID`).
4. Put the new profile's name in `.env` as `TIZEN_SIGN_PROFILE=` and run
   `./scripts/tizen-deploy.sh` again.

### Windows

Use Tizen Studio (GUI) instead of the scripts: build the app folder with
`npm ci && npm run build:tizen` (or download the CI artifact), then in Tizen
Studio use **Device Manager** to connect to the TV's IP (port 26101), create a
certificate in **Certificate Manager**, and install the folder with:

```bat
%USERPROFILE%\tizen-studio\tools\ide\bin\tizen.bat package -t wgt -s <profile> -o out -- build\tizen\app
%USERPROFILE%\tizen-studio\tools\ide\bin\tizen.bat install -n out\EasyPlex.wgt -t <device name from sdb devices>
```

### Troubleshooting

| Problem | Fix |
| --- | --- |
| Typing 12345 does nothing | Be on the **Apps** screen; use the **123** on-screen keypad if needed; type quickly. |
| "No Samsung TV found" | Turn the TV on, same network as the computer; or type its IP when asked. |
| Developer Mode points at another IP | Re-enter your computer's IP in the popup and hold Power to restart the TV. |
| "Can't reach the TV" | Restart the TV and run `./scripts/tizen-setup.sh` again; your computer's IP may have changed. |
| App disappeared | Firmware updates can remove sideloaded apps. Run `./scripts/tizen-deploy.sh` again. |

## Remote keys on a Samsung remote

Everything in the README's key table works. Samsung specifics:

| Samsung key | Acts as |
| --- | --- |
| Hold **OK** | Options / Menu (same as Android "hold OK") |
| **Return** (↩) | Back |
| **Red** | Record (Live TV), as Red does on Android |
| **Green · Yellow · Blue** | Diagnostics · day guide · recordings (Live TV) |
| **CH ▲ / CH ▼** | Page / channel up and down |
| **0–9** | Go to channel number |
| **Prev Ch** (if your remote has it) | Last channel |
| **Play/Pause, ▶, ❚❚, ■, ◀◀, ▶▶** | As on Android |

Remotes without colour or number keys (the slim Smart Remote): press **123**
for the on-screen keypad, which has colour and number keys; or hold OK for the
options list, which has every action.

While watching **live TV**: Up/Down (or CH ▲▼) zap, Left is the previous
channel, OK shows now & next, **Right** opens audio/subtitles/video
information, hold OK records or favourites, Return goes back to the guide.
**Films and shows** use EasyPlex's on-screen controls over the video (Down for
audio and subtitles); **Dispatcharr films** show audio and subtitle tracks on
Down or hold OK.

## How it fits together

| Path | What it is |
| --- | --- |
| `tizen/config.xml`, `tizen/index.html`, `tizen/icon.png` | The Tizen app package |
| `tizen/js/platform/device.js` | Replaces `web/js/platform/device.js`: Samsung keys, identity (`X-Plex-Platform: Samsung`), decoders, screen saver |
| `tizen/js/platform/player.js` | Replaces `web/js/platform/player.js`: AVPlay for films, VOD and episodes |
| `tizen/js/shell.js` | Does the Android shell's jobs in JavaScript: `EasyPlexVideo` for live TV (AVPlay, now/next banner, options over video, HDHomeRun lineup, Tube Archivist requests), hold-OK, live key routing, app hidden/shown |
| `tizen/js/polyfills.js`, `tizen/css/tizen.css` | Chromium 63 support; the live TV layer's styles |
| `scripts/build-tizen.mjs` | The build described above |
| `scripts/tizen-setup.sh`, `scripts/tizen-deploy.sh` | Install tooling, adapted from SamSUCKS |
| `tests/tizen.test.mjs` | Builds, checks the output parses as ES2018, and runs it in Chromium against fake Tizen APIs with the newer APIs removed |

The web UI in `web/` is shared, so a feature added for Android appears on the
TV at the next deploy. Keep `web/` code to things the build can lower or the
polyfills cover; `npm run test:tizen` fails if the bundle stops parsing as
ES2018.

### Developing

```sh
npm ci
npm run build:tizen -- --dev     # readable bundle, DEV logging
python -m http.server -d build/tizen/app 8000   # UI in desktop Chrome (no AVPlay there)
npm run test:tizen
```

Plex, Dispatcharr and Tube Archivist requests are made from the app itself;
`config.xml` grants network access to any server (`<access origin="*">`). If
the Dispatcharr lineup can't be read, live TV falls back to Plex's own live
session, as on Android. Films play
straight from Plex or Dispatcharr through AVPlay, so playback compatibility
depends on the TV's decoders; when direct play fails EasyPlex asks Plex to
convert, and live TV has the on-screen diagnostics (Green) as on Android.
