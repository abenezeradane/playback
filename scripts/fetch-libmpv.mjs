#!/usr/bin/env node
// fetch-libmpv.mjs — provision libmpv-2.dll for the native playback engine (native-001).
//
// The native engine embeds libmpv (loaded at runtime via libloading, so the app
// still starts without it — the frontend then falls back to the WebView engine).
// This script downloads the LGPL x86_64 build of libmpv from zhongfly/mpv-winbuild
// (the mpv-dev-lgpl asset: libmpv-2.dll with FFmpeg statically inside, LGPL-2.1 —
// see licenses/libmpv-NOTICE.md), extracts it with Windows' bsdtar (System32
// tar.exe reads 7z; falls back to 7-Zip if installed), and places the DLL at:
//   * src-tauri/binaries/libmpv-2.dll        (source of truth, .gitignored)
//   * src-tauri/target/{debug,release}/      (next to the exe for dev + smokes;
//                                             build.rs also does this on build)
// Run once after a fresh checkout (like fetch-ffmpeg.mjs), before building.
// LIBMPV_ARCHIVE can point at an already-downloaded mpv-dev-*.7z to skip the network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(root, "src-tauri", "binaries");
const dest = join(binDir, "libmpv-2.dll");

/** Copy the provisioned DLL next to any existing build outputs so a rebuilt or
 *  previously-built exe can load it immediately (build.rs repeats this on build). */
function copyToTargets() {
  for (const profile of ["debug", "release"]) {
    const dir = join(root, "src-tauri", "target", profile);
    if (existsSync(dir)) {
      copyFileSync(dest, join(dir, "libmpv-2.dll"));
      console.log(`  -> ${join(dir, "libmpv-2.dll")}`);
    }
  }
}

if (existsSync(dest) && statSync(dest).size > 10 * 1024 * 1024) {
  console.log(`libmpv already present: ${dest}`);
  copyToTargets();
  process.exit(0);
}

/** Resolve the .7z archive: LIBMPV_ARCHIVE override, else download the latest
 *  mpv-dev-lgpl-x86_64 release asset from zhongfly/mpv-winbuild. */
function resolveArchive() {
  if (process.env.LIBMPV_ARCHIVE && existsSync(process.env.LIBMPV_ARCHIVE)) {
    return process.env.LIBMPV_ARCHIVE;
  }
  console.log("Fetching latest zhongfly/mpv-winbuild release metadata…");
  const meta = execFileSync(
    "curl",
    ["-sL", "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const release = JSON.parse(meta);
  const asset = (release.assets ?? []).find((a) => /^mpv-dev-lgpl-x86_64-2/.test(a.name));
  if (!asset) throw new Error("no mpv-dev-lgpl-x86_64 asset in the latest release");
  const archive = join(tmpdir(), asset.name);
  if (!existsSync(archive)) {
    console.log(`Downloading ${asset.name} (${Math.round(asset.size / 1024 / 1024)} MB)…`);
    execFileSync("curl", ["-sL", asset.browser_download_url, "-o", archive], {
      stdio: "inherit",
    });
  }
  return archive;
}

/** Extract libmpv-2.dll out of the .7z into a temp dir; returns the DLL path. */
function extractDll(archive) {
  const out = join(tmpdir(), `libmpv-extract-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const sysTar = "C:\\Windows\\System32\\tar.exe"; // bsdtar: reads 7z via libarchive
  const sevenZip = "C:\\Program Files\\7-Zip\\7z.exe";
  if (existsSync(sysTar)) {
    execFileSync(sysTar, ["-xf", archive, "-C", out, "libmpv-2.dll"], { stdio: "inherit" });
  } else if (existsSync(sevenZip)) {
    execFileSync(sevenZip, ["e", "-y", `-o${out}`, archive, "libmpv-2.dll"], { stdio: "inherit" });
  } else {
    throw new Error("no extractor found (need Windows tar.exe or 7-Zip)");
  }
  const dll = join(out, "libmpv-2.dll");
  if (!existsSync(dll)) throw new Error("libmpv-2.dll not found in the archive");
  return dll;
}

const archive = resolveArchive();
console.log(`Extracting libmpv-2.dll from ${archive}…`);
const dll = extractDll(archive);
mkdirSync(binDir, { recursive: true });
copyFileSync(dll, dest);
console.log(`Provisioned ${dest} (${Math.round(statSync(dest).size / 1024 / 1024)} MB)`);
copyToTargets();
