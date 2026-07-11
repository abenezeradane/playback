# libmpv attribution & source offer

Playback's native playback engine (native-001) dynamically loads **libmpv**
(`libmpv-2.dll`), the client library of the [mpv media player](https://mpv.io),
which statically includes [FFmpeg](https://ffmpeg.org) and other libraries.

- The bundled build is the **LGPL** variant (`-Dgpl=false`) produced by the
  [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild) CI
  (asset family `mpv-dev-lgpl-x86_64-*.7z`), which builds
  [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake).
- License: **GNU Lesser General Public License v2.1 or later** — see
  [`LGPL-2.1.txt`](./LGPL-2.1.txt) in this directory. mpv's own licensing notes:
  <https://github.com/mpv-player/mpv/blob/master/Copyright>.
- libmpv is kept as a **separate, user-replaceable DLL** (loaded at runtime;
  the app runs without it). You may replace `libmpv-2.dll` next to the
  executable with any ABI-2-compatible build.
- **Source offer**: `libmpv-SOURCE.txt` (next to this file in an installed
  copy; `src-tauri/binaries/libmpv-2.dll.source.txt` in a checkout) records the
  bundled DLL's SHA-256, provisioning date, and the exact
  zhongfly/mpv-winbuild release it was downloaded from. The complete
  corresponding source is published with that release (each release names the
  mpv/FFmpeg git revisions it was built from). Provision/update the DLL with
  `node scripts/fetch-libmpv.mjs`, which (re)writes that record.

Playback itself does not link libmpv at build time and contains no mpv code.
