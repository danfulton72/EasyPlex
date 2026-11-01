# Attribution

EasyPlex is a standalone Android TV application, with a Samsung Tizen build. Its user interface in `web/`
was originally derived from [SamSUCKS](https://github.com/rfaile313/samsucks)
(upstream commit `6b00e92`), copyright © 2026 rfaile313 and contributors,
licensed under the GNU General Public License v3.0. EasyPlex has since been
substantially modified and is maintained independently; it is distributed under
the same licence (see [LICENSE](LICENSE)), as GPL-3.0 requires for derived works.

The Samsung Tizen build (`tizen/`, `scripts/tizen-*.sh`) adapts SamSUCKS's
AVPlay player, Tizen key handling and install scripts in the same way.

Bundled third-party components keep their own licences:

- Inter and Barlow Condensed fonts — SIL Open Font License (`web/fonts/LICENSE-*.txt`)
- QR code generator — see the header of `web/js/vendor/qrcode.js`
- AndroidX WebKit and Media3 — Apache License 2.0
- esbuild (build tool only, not shipped) — MIT

EasyPlex is independent of Plex, Humax, Dangbei, Google and Samsung.
