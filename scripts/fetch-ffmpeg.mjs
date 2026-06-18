#!/usr/bin/env node
// fetch-ffmpeg.mjs — provision the bundled ffmpeg sidecar (play-016, TS support).
//
// Playback remuxes MPEG-TS (.ts/.m2ts/.mts) files to a temp .mp4 on open via a
// bundled ffmpeg sidecar (Chromium's <video> can't demux the TS container). Tauri
// looks for the sidecar at src-tauri/binaries/ffmpeg-<target-triple><ext>, so this
// script resolves the host triple, finds an ffmpeg on PATH (or honours FFMPEG_PATH),
// and copies it into place. The binary itself is .gitignored (it's large), so run
// this once after a fresh checkout, before `npm run tauri build`/`dev`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(root, "src-tauri", "binaries");

/** The Rust host target triple (e.g. x86_64-pc-windows-msvc), used to name the sidecar. */
function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = /host:\s*(\S+)/.exec(out);
  if (!m) throw new Error("could not parse `rustc -vV` host triple");
  return m[1];
}

/** Locate an ffmpeg executable: FFMPEG_PATH override, else the first one on PATH. */
function findFfmpeg() {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const isWin = process.platform === "win32";
  const probe = isWin ? "where" : "which";
  try {
    const out = execFileSync(probe, ["ffmpeg"], { encoding: "utf8" }).trim();
    const first = out.split(/\r?\n/).find(Boolean);
    if (first && existsSync(first)) {
      // A chocolatey/scoop shim is a tiny launcher (well under a real ~99MB ffmpeg)
      // that resolves the real exe relative to itself — bundling it would break once
      // moved. Detect the small shim and resolve to the real standalone binary.
      if (isWin && statSync(first).size < 5 * 1024 * 1024) {
        const real = "C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffmpeg.exe";
        if (existsSync(real)) return real;
      }
      return first;
    }
  } catch {
    /* not found */
  }
  return null;
}

const triple = hostTriple();
const ext = process.platform === "win32" ? ".exe" : "";
const dest = join(binDir, `ffmpeg-${triple}${ext}`);

if (existsSync(dest)) {
  console.log(`ffmpeg sidecar already present: ${dest}`);
  process.exit(0);
}

const src = findFfmpeg();
if (!src) {
  console.error(
    "ffmpeg not found. Install ffmpeg (e.g. `choco install ffmpeg`) or set FFMPEG_PATH,\n" +
      `then re-run: node scripts/fetch-ffmpeg.mjs (target: ${dest})`,
  );
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ffmpeg sidecar:\n  from ${src}\n  to   ${dest}`);
