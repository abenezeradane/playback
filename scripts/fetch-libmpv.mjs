#!/usr/bin/env node
// fetch-libmpv.mjs — provision libmpv-2.dll for the native playback engine (native-001).
//
// The native engine embeds libmpv (loaded at runtime via libloading, so the app
// still starts without it — the frontend then falls back to the WebView engine).
// This script downloads the LGPL x86_64 build of libmpv from zhongfly/mpv-winbuild
// (the mpv-dev-lgpl asset: libmpv-2.dll with FFmpeg statically inside, LGPL-2.1 —
// see licenses/libmpv-NOTICE.md), extracts it with Windows' bsdtar (System32
// tar.exe reads 7z; falls back to 7-Zip if installed), and places the DLL at:
//   * src-tauri/binaries/libmpv-2.dll        (source of truth, .gitignored;
//                                             the installer bundles from here —
//                                             see src-tauri/tauri.bundle.conf.json)
//   * src-tauri/target/{debug,release}/      (next to the exe for dev + smokes)
// Run once after a fresh checkout (like fetch-ffmpeg.mjs), before building.
// LIBMPV_ARCHIVE can point at an already-downloaded mpv-dev-*.7z to skip the network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(root, "src-tauri", "binaries");
const dest = join(binDir, "libmpv-2.dll");
// LGPL source-offer record: which exact zhongfly/mpv-winbuild release the DLL
// came from + its SHA-256. Shipped INTO the installer as licenses/libmpv-SOURCE.txt
// (see src-tauri/tauri.bundle.conf.json), so a recipient can fetch the complete
// corresponding source for the exact binary they received.
const sourceRecord = join(binDir, "libmpv-2.dll.source.txt");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Write the source-offer record. `release` is null when the provenance is not
 *  known (DLL provisioned before this script recorded it, or a local archive). */
function writeSourceRecord(release) {
  const lines = [
    "libmpv-2.dll provenance (LGPL-2.1 source offer — see libmpv-NOTICE.md)",
    "",
    `sha256(libmpv-2.dll) = ${sha256(dest)}`,
    `provisioned = ${new Date().toISOString()}`,
  ];
  if (release?.tag) {
    lines.push(`release = https://github.com/zhongfly/mpv-winbuild/releases/tag/${release.tag}`);
  } else {
    lines.push(
      "release = (tag not recorded at provisioning time — match the sha256/date",
      "          against the assets on https://github.com/zhongfly/mpv-winbuild/releases)",
    );
  }
  if (release?.asset) lines.push(`asset = ${release.asset}`);
  lines.push(
    "",
    "Each zhongfly/mpv-winbuild release names the mpv/FFmpeg git revisions it was",
    "built from and links the corresponding source.",
    "",
  );
  writeFileSync(sourceRecord, lines.join("\n"));
  console.log(`Recorded provenance: ${sourceRecord}`);
}

/** Copy the provisioned DLL next to any existing build outputs so a rebuilt or
 *  previously-built exe can load it immediately. */
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
  if (!existsSync(sourceRecord)) writeSourceRecord(null); // pre-tracking DLL: record its hash
  copyToTargets();
  process.exit(0);
}

/** Resolve the .7z archive: LIBMPV_ARCHIVE override, else download the latest
 *  mpv-dev-lgpl-x86_64 release asset from zhongfly/mpv-winbuild. Returns
 *  { archive, release } — release is null when provenance is unknown. */
function resolveArchive() {
  if (process.env.LIBMPV_ARCHIVE && existsSync(process.env.LIBMPV_ARCHIVE)) {
    return { archive: process.env.LIBMPV_ARCHIVE, release: null };
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
  return { archive, release: { tag: release.tag_name, asset: asset.name } };
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

const { archive, release } = resolveArchive();
console.log(`Extracting libmpv-2.dll from ${archive}…`);
const dll = extractDll(archive);
mkdirSync(binDir, { recursive: true });
copyFileSync(dll, dest);
console.log(`Provisioned ${dest} (${Math.round(statSync(dest).size / 1024 / 1024)} MB)`);
writeSourceRecord(release ?? { tag: null, asset: basename(archive) });
copyToTargets();
