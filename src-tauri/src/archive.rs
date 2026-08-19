//! gallery-004 — archives (.zip/.cbz/.rar/.cbr) browsed as directories.
//!
//! An archive is listed from its INDEX (no bytes decompressed) and an entry's
//! bytes are materialized into a mirror directory in the thumbnail cache only
//! when something needs them. A materialized entry is an ordinary file at a real
//! path under its real name, so every consumer downstream — `media_thumbnail`,
//! `video_duration`, `convertFileSrc`, mpv, the image viewer — needs no
//! knowledge that an archive was involved.
//!
//! This module accepts hostile input by construction: an archive is an untrusted
//! container of arbitrary path strings. `sanitize_entry_path` is the guard, and
//! it runs on the LISTING path, not merely the write path, so an entry that
//! could escape the mirror directory is never even shown.

use std::path::{Path, PathBuf};

use crate::{has_gallery_image_ext, has_queue_video_ext};

/// Archive containers browsed as directories. `.cbz`/`.cbr` are the comic-book
/// spellings of zip/rar and are byte-identical to them.
const ARCHIVE_EXTENSIONS: &[&str] = &["zip", "cbz", "rar", "cbr"];

/// True when `path` names an archive this feature can browse. Mirrors
/// `has_gallery_image_ext` / `has_queue_video_ext` so all three kinds are
/// decided the same way.
pub(crate) fn has_archive_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ARCHIVE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Which decoder an archive needs. The two families differ in more than their
/// library: zip random-accesses one entry, rar must be extracted in one pass.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum ArchiveKind {
    Zip,
    Rar,
}

pub(crate) fn archive_kind(path: &Path) -> Option<ArchiveKind> {
    match path
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "zip" | "cbz" => Some(ArchiveKind::Zip),
        "rar" | "cbr" => Some(ArchiveKind::Rar),
        _ => None,
    }
}

/// Normalize one archive entry name, or reject it.
///
/// This is the zip-slip guard, and it runs while BUILDING THE INDEX rather than
/// only before a write: an entry that could escape the mirror directory is never
/// listed, so it can never be opened either. Rejects absolute paths, drive
/// letters, UNC prefixes, `.` and `..` components, empty components (`a//b`),
/// and NUL bytes. Also rejects any colon, anywhere in the name — not just the
/// drive-letter position — because on NTFS `name:stream` is Alternate Data
/// Stream syntax, and letting it through would attach a hidden stream to an
/// ordinary file instead of creating one. And rejects any component whose stem
/// (the part before the first `.`) is a Windows reserved device name (`CON`,
/// `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, case-insensitive, with or
/// without an extension — `nul.jpg` counts) — materializing one of those opens a
/// device rather than a file. Also rejects any component that STARTS WITH the
/// `.pb-` prefix — reserved for Playback's own cache bookkeeping inside a
/// mirror directory (e.g. `RAR_COMPLETE_MARKER`) — so no archive entry can ever
/// be extracted to the same path as, and thereby forge, one of those files. A
/// prefix rule rather than a blacklist of the one current filename, because it
/// stays correct as bookkeeping files are added; it does not touch ordinary
/// dotfiles (`.hidden.jpg` still survives). Separators are normalized to `/`,
/// and a trailing separator (an explicit directory entry) is trimmed. Pure.
pub(crate) fn sanitize_entry_path(raw: &str) -> Option<String> {
    if raw.contains('\0') || raw.contains(':') {
        return None;
    }
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A leading '/' is rooted (also catches UNC's leading "//").
    if trimmed.starts_with('/') {
        return None;
    }
    let body = trimmed.strip_suffix('/').unwrap_or(trimmed);
    if body.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in body.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || is_reserved_device_name(part)
            || part.starts_with(".pb-")
        {
            return None;
        }
        parts.push(part);
    }
    Some(parts.join("/"))
}

/// True when `component` (a single, already-split path segment) names a Windows
/// reserved device — `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`.
/// Matched on the STEM (the part before the first `.`), case-insensitively,
/// because Windows treats `nul.jpg` as the same device as `NUL`.
fn is_reserved_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON" | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// One level of an archive: the sub-folders, images and videos directly inside
/// `inner` (`""` is the archive root). Paths are INNER paths, relative to the
/// archive root — the frontend never sees, and never constructs, a cache path.
///
/// Serialized to the WebView as `{ folders, images, videos }`, matching
/// `FolderEntries` so the same pure `orderGalleryEntries` orders both.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
pub(crate) struct ArchiveEntries {
    pub folders: Vec<String>,
    pub images: Vec<String>,
    pub videos: Vec<String>,
}

/// Derive one level from the archive's flat list of (already sanitized) file
/// names. Folders are DERIVED rather than read: zip archives frequently carry no
/// explicit directory entries at all, so a listing that trusted them would show
/// a flat wall of pages for a chaptered comic.
///
/// A consequence worth knowing: a folder containing no files at any depth does
/// not appear, because nothing derives it. An empty folder inside an archive is
/// not worth a tile.
///
/// Pure; `files` is not mutated. Output order is the input order for files and
/// sorted-deduped for folders — display ordering is the frontend's pure
/// `orderGalleryEntries`, not this function's job.
pub(crate) fn archive_level(files: &[String], inner: &str) -> ArchiveEntries {
    let prefix = if inner.is_empty() {
        String::new()
    } else {
        format!("{inner}/")
    };
    let mut out = ArchiveEntries::default();
    let mut folders = std::collections::BTreeSet::new();
    for name in files {
        let Some(rest) = name.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        match rest.split_once('/') {
            // Deeper than this level: contribute only its first segment.
            Some((segment, _)) => {
                folders.insert(format!("{prefix}{segment}"));
            }
            None => {
                let as_path = Path::new(name.as_str());
                if has_gallery_image_ext(as_path) {
                    out.images.push(name.clone());
                } else if has_queue_video_ext(as_path) {
                    out.videos.push(name.clone());
                }
            }
        }
    }
    out.folders = folders.into_iter().collect();
    out
}

/// What went wrong, in terms the UI can state honestly. The variants exist so
/// the command layer can map each to ONE stable public string (sec-005) while
/// the native side logs the real cause.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum ArchiveError {
    /// The archive (or the entry) needs a password. gallery-004 does not prompt.
    Encrypted,
    /// An entry or the archive exceeded a materialization ceiling.
    TooLarge,
    /// Corrupt, truncated, or an unreadable container.
    Unreadable,
    /// No such archive, or no such entry inside it.
    NotFound,
    /// A container or codec this build does not decode.
    Unsupported,
}

impl ArchiveError {
    pub(crate) fn public_message(&self) -> &'static str {
        match self {
            ArchiveError::Encrypted => "This archive is password-protected.",
            ArchiveError::TooLarge => "This archive is too large to open.",
            ArchiveError::Unreadable => "This archive could not be read.",
            ArchiveError::NotFound => "That file is no longer there.",
            ArchiveError::Unsupported => "This archive format is not supported.",
        }
    }
}

/// Directory name for one archive's mirror, keyed on the archive's canonical
/// path + size + mtime — so replacing or editing an archive misses the cache
/// rather than serving pages from the old one.
///
/// This deliberately keeps its OWN FNV-1a rather than sharing `thumb_cache_name`'s:
/// the two keys have different lifetimes and different prefixes, and refactoring
/// a live on-disk cache key to save six lines would invalidate every user's
/// existing thumbnails for no behavioural gain. Pure + unit-tested.
pub(crate) fn archive_mirror_name(canonical_archive: &Path, size: u64, mtime_secs: u64) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    mix(canonical_archive.to_string_lossy().as_bytes());
    mix(&size.to_le_bytes());
    mix(&mtime_secs.to_le_bytes());
    format!("pb-ar-{hash:016x}")
}

/// True for a cache entry that is an archive mirror DIRECTORY, so the existing
/// 30-day prune can remove it recursively alongside the `pb-th-*` files.
pub(crate) fn is_prunable_cache_dir(name: &str) -> bool {
    name.starts_with("pb-ar-")
}

/// This archive's mirror directory (created if absent). Mirrors live INSIDE the
/// thumbnail cache so there is one cache directory, one `authorize_dir` grant,
/// and one prune.
pub(crate) fn archive_mirror_dir(canonical_archive: &Path) -> Result<PathBuf, ArchiveError> {
    let meta = std::fs::metadata(canonical_archive).map_err(|_| ArchiveError::NotFound)?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let base = crate::thumb_cache_dir().ok_or(ArchiveError::Unreadable)?;
    let dir = base.join(archive_mirror_name(canonical_archive, meta.len(), mtime_secs));
    std::fs::create_dir_all(&dir).map_err(|_| ArchiveError::Unreadable)?;
    Ok(dir)
}

/// Largest single entry this will ever materialize. A page is kilobytes; a video
/// inside an archive is the case that makes this non-trivial.
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB
/// Largest total this will materialize out of ONE archive, so a zip bomb (a
/// megabyte that expands to terabytes) cannot fill the disk.
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024; // 8 GiB
/// Streaming copy buffer.
const COPY_CHUNK: usize = 64 * 1024;

/// Copy `reader` into `writer`, aborting once more than `cap` bytes have been
/// written. The check is on bytes ACTUALLY WRITTEN rather than on a declared
/// uncompressed size, because an archive header is attacker-controlled and lies.
fn copy_capped(
    reader: &mut impl std::io::Read,
    writer: &mut impl std::io::Write,
    cap: u64,
) -> Result<u64, ArchiveError> {
    let mut buf = vec![0u8; COPY_CHUNK];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|_| ArchiveError::Unreadable)?;
        if n == 0 {
            return Ok(total);
        }
        total += n as u64;
        if total > cap {
            return Err(ArchiveError::TooLarge);
        }
        writer
            .write_all(&buf[..n])
            .map_err(|_| ArchiveError::Unreadable)?;
    }
}

/// Map a `zip` crate error to our vocabulary. An encrypted entry is the case
/// worth distinguishing: the UI states it rather than showing "unreadable".
fn zip_error(e: zip::result::ZipError) -> ArchiveError {
    match e {
        zip::result::ZipError::FileNotFound => ArchiveError::NotFound,
        zip::result::ZipError::UnsupportedArchive(msg)
            if msg.to_ascii_lowercase().contains("password")
                || msg.to_ascii_lowercase().contains("encrypt") =>
        {
            ArchiveError::Encrypted
        }
        zip::result::ZipError::UnsupportedArchive(_) => ArchiveError::Unsupported,
        _ => ArchiveError::Unreadable,
    }
}

/// Every FILE entry in a zip, as sanitized inner paths.
///
/// This reads only the central directory — no entry is decompressed — so listing
/// a 900-page comic is effectively instant. Directory entries are dropped
/// (`archive_level` derives folders from file names); entries whose names fail
/// `sanitize_entry_path` are dropped, so a hostile name is never even shown.
pub(crate) fn zip_index(archive: &Path) -> Result<Vec<String>, ArchiveError> {
    let file = std::fs::File::open(archive).map_err(|_| ArchiveError::NotFound)?;
    let mut zip = zip::ZipArchive::new(file).map_err(zip_error)?;
    let mut names = Vec::with_capacity(zip.len());
    let mut encrypted_seen = false;
    for i in 0..zip.len() {
        let entry = match zip.by_index_raw(i) {
            Ok(e) => e,
            Err(e) => {
                if zip_error(e) == ArchiveError::Encrypted {
                    encrypted_seen = true;
                }
                continue;
            }
        };
        if entry.is_dir() {
            continue;
        }
        if entry.encrypted() {
            encrypted_seen = true;
            continue;
        }
        if let Some(clean) = sanitize_entry_path(entry.name()) {
            names.push(clean);
        }
    }
    // An archive whose every entry is encrypted is reported as such rather than
    // shown as an empty folder — the user can act on the first, not the second.
    if names.is_empty() && encrypted_seen {
        return Err(ArchiveError::Encrypted);
    }
    Ok(names)
}

/// Materialize ONE zip entry to `dst`, creating parent directories.
///
/// Random access through the central directory, which is what makes per-entry
/// laziness affordable for zip (rar cannot do this — see `rar_extract_all`).
/// A partially written file is removed on failure so a later run cannot cache-hit
/// a truncated page.
pub(crate) fn zip_extract_entry(
    archive: &Path,
    inner: &str,
    dst: &Path,
) -> Result<(), ArchiveError> {
    // Re-sanitize at the write boundary. The listing already dropped hostile
    // names, but this function is reachable from IPC with an arbitrary string.
    let clean = sanitize_entry_path(inner).ok_or(ArchiveError::NotFound)?;
    let file = std::fs::File::open(archive).map_err(|_| ArchiveError::NotFound)?;
    let mut zip = zip::ZipArchive::new(file).map_err(zip_error)?;
    let mut entry = zip.by_name(&clean).map_err(zip_error)?;
    if entry.is_dir() {
        return Err(ArchiveError::NotFound);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|_| ArchiveError::Unreadable)?;
    }
    let mut out = std::fs::File::create(dst).map_err(|_| ArchiveError::Unreadable)?;
    match copy_capped(&mut entry, &mut out, MAX_ENTRY_BYTES) {
        Ok(_) => Ok(()),
        Err(e) => {
            drop(out);
            let _ = std::fs::remove_file(dst);
            Err(e)
        }
    }
}

/// Map an `unrar` crate error to our vocabulary. Mirrors `zip_error`: a missing
/// or wrong password is reported as `Encrypted` rather than folded into a
/// generic failure, because gallery-004 states that case to the user instead of
/// "unreadable".
fn rar_error(e: unrar::error::UnrarError) -> ArchiveError {
    match e.code {
        unrar::error::Code::MissingPassword | unrar::error::Code::BadPassword => {
            ArchiveError::Encrypted
        }
        _ => ArchiveError::Unreadable,
    }
}

/// Written into a mirror once a RAR has been fully extracted, so later calls are
/// pure cache hits rather than a second whole-archive pass.
pub(crate) const RAR_COMPLETE_MARKER: &str = ".pb-complete";

/// Every file entry in a rar, as sanitized inner paths. Listing a rar reads its
/// headers only — the same cheap operation as a zip's central directory.
///
/// Two independent encrypted cases exist, and both are handled: a RAR with
/// encrypted HEADERS fails to read a header at all (`open_for_listing` still
/// succeeds, but the first `next()` returns `Err(MissingPassword)`), while a RAR
/// with only encrypted CONTENT lists its names just fine and instead marks the
/// entry via `FileHeader::is_encrypted`. Either way the entry is dropped rather
/// than shown, matching zip_index's `entry.encrypted()` check.
fn rar_index(archive: &Path) -> Result<Vec<String>, ArchiveError> {
    let list = unrar::Archive::new(archive)
        .open_for_listing()
        .map_err(rar_error)?;
    let mut names = Vec::new();
    let mut encrypted_seen = false;
    for header in list {
        let entry = match header {
            Ok(e) => e,
            Err(_) => {
                // Encrypted headers: the archive cannot be read further either
                // way, so iteration is effectively over after this.
                encrypted_seen = true;
                continue;
            }
        };
        if entry.is_directory() {
            continue;
        }
        if entry.is_encrypted() {
            encrypted_seen = true;
            continue;
        }
        if let Some(clean) = sanitize_entry_path(&entry.filename.to_string_lossy()) {
            names.push(clean);
        }
    }
    // An archive whose every entry is encrypted is reported as such rather than
    // shown as an empty folder — the user can act on the first, not the second.
    if names.is_empty() && encrypted_seen {
        return Err(ArchiveError::Encrypted);
    }
    Ok(names)
}

/// Extract a WHOLE rar into `mirror`, then write the completion marker.
///
/// Whole-archive rather than per-entry on purpose: solid rar archives (common
/// for `.cbr`) must decompress entries 1..N to reach N, so materializing pages
/// one at a time is quadratic in the page count. One pass is both simpler and
/// strictly faster there.
///
/// The completion marker is the ONLY trustworthy signal that a pass finished —
/// see `ensure_entry`, which gates a rar cache hit on it rather than on any one
/// entry file's bare existence. That only holds if a failed pass never leaves
/// entries behind, so on ANY error this removes the whole partial mirror before
/// propagating it: `rar_extract_all_pass` below never writes the marker itself
/// on a failure path, this wrapper is what guarantees nothing else survives one
/// either. Without this, an aborted pass (most importantly the total-size cap,
/// which the per-entry cap already self-cleans but a later entry pushing the
/// running total over `MAX_ARCHIVE_BYTES` would not) would silently keep
/// serving whichever pages happened to extract before the abort, forever.
fn rar_extract_all(archive: &Path, mirror: &Path) -> Result<(), ArchiveError> {
    match rar_extract_all_pass(archive, mirror) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_dir_all(mirror);
            Err(e)
        }
    }
}

/// The extraction pass itself. Entries whose names fail `sanitize_entry_path`,
/// directories, and encrypted entries are SKIPPED rather than extracted — the
/// unrar library would otherwise happily honour `..`, and an encrypted entry
/// has no bytes worth caching. The cap is enforced against bytes ACTUALLY
/// WRITTEN (read back from disk after `extract_to`), not the header's declared
/// `unpacked_size`, for the same reason `copy_capped` does the same for zip: an
/// archive header is attacker-controlled and lies. Any error return here — a
/// bad header, a write failure, either cap — leaves the mirror partially
/// populated and the marker unwritten by design; `rar_extract_all` above is
/// the layer that cleans that up.
fn rar_extract_all_pass(archive: &Path, mirror: &Path) -> Result<(), ArchiveError> {
    let mut open = unrar::Archive::new(archive)
        .open_for_processing()
        .map_err(rar_error)?;
    let mut total: u64 = 0;
    while let Some(header) = open.read_header().map_err(rar_error)? {
        let name = header.entry().filename.to_string_lossy().into_owned();
        let is_dir = header.entry().is_directory();
        let is_encrypted = header.entry().is_encrypted();
        let clean = if is_dir || is_encrypted {
            None
        } else {
            sanitize_entry_path(&name)
        };
        match clean {
            Some(clean) => {
                let dst = mirror.join(&clean);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent).map_err(|_| ArchiveError::Unreadable)?;
                }
                open = header.extract_to(&dst).map_err(rar_error)?;
                let written = std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
                if written > MAX_ENTRY_BYTES {
                    return Err(ArchiveError::TooLarge);
                }
                total = total.saturating_add(written);
                if total > MAX_ARCHIVE_BYTES {
                    return Err(ArchiveError::TooLarge);
                }
            }
            None => {
                open = header.skip().map_err(rar_error)?;
            }
        }
    }
    std::fs::write(mirror.join(RAR_COMPLETE_MARKER), b"1").map_err(|_| ArchiveError::Unreadable)?;
    Ok(())
}

/// Every file entry in an archive, whichever family it belongs to.
pub(crate) fn archive_index(archive: &Path) -> Result<Vec<String>, ArchiveError> {
    match archive_kind(archive) {
        Some(ArchiveKind::Zip) => zip_index(archive),
        Some(ArchiveKind::Rar) => rar_index(archive),
        None => Err(ArchiveError::Unsupported),
    }
}

/// Materialize one entry and return its real path in the mirror directory.
///
/// This is THE seam: everything above it is format-agnostic, and everything
/// below it is the per-format strategy — zip random-accesses the one entry, rar
/// extracts the whole archive once. Idempotent, but the two families are NOT
/// gated the same way: zip extracts exactly one entry per call, so that
/// entry's own bare existence on disk already means "this call is done" — a
/// plain stat is a valid cache hit. Rar extracts everything in one pass, so an
/// entry file existing on its own proves nothing: it could be a survivor of a
/// pass that was aborted partway (a size cap, a bad header) before the
/// completion marker was ever written. A rar cache hit is therefore gated on
/// `RAR_COMPLETE_MARKER`, never on the entry file alone; `rar_extract_all`
/// pairs with this by deleting its own partial output on any failure, so the
/// marker's absence and the mirror's incompleteness can never drift apart.
/// Either way this still stats the archive on disk to (re)compute the cache
/// key, so a cache hit does not survive the archive itself being removed.
pub(crate) fn ensure_entry(archive: &Path, inner: &str) -> Result<PathBuf, ArchiveError> {
    let clean = sanitize_entry_path(inner).ok_or(ArchiveError::NotFound)?;
    // Canonicalize for the cache key, but fall back to the raw path when the
    // archive is gone — a cache hit must still resolve.
    let key = std::fs::canonicalize(archive).unwrap_or_else(|_| archive.to_path_buf());
    let mirror = archive_mirror_dir(&key)?;
    let dst = mirror.join(&clean);
    match archive_kind(archive) {
        Some(ArchiveKind::Zip) => {
            if std::fs::metadata(&dst).map(|m| m.len() > 0).unwrap_or(false) {
                return Ok(dst);
            }
            zip_extract_entry(archive, &clean, &dst)?;
        }
        Some(ArchiveKind::Rar) => {
            if !mirror.join(RAR_COMPLETE_MARKER).exists() {
                rar_extract_all(archive, &mirror)?;
            }
            if !std::fs::metadata(&dst).map(|m| m.len() > 0).unwrap_or(false) {
                return Err(ArchiveError::NotFound);
            }
        }
        None => return Err(ArchiveError::Unsupported),
    }
    Ok(dst)
}

/// Map an `ArchiveError` to what crosses the IPC boundary (sec-005): a stable,
/// generic string, with the real cause logged natively.
fn to_ipc(context: &str, e: ArchiveError) -> String {
    crate::ipc_error(context, format!("{e:?}"), e.public_message())
}

/// One level of an archive, as INNER paths (`ch1/page01.jpg`), never cache paths
/// — the frontend cannot construct a mirror path, only `archive_entry_file` can
/// mint one. Reads the index only; no entry is decompressed.
#[tauri::command]
pub(crate) fn list_archive_entries(
    allow: tauri::State<'_, crate::AllowList>,
    archive: String,
    inner: String,
) -> Result<ArchiveEntries, String> {
    // sec-002: the ARCHIVE FILE must already be inside the allow-list. Inner
    // paths never touch the filesystem outside the mirror, so nothing else here
    // widens the app's reach.
    let canonical = crate::ensure_allowed(&allow, &archive)?;
    let names = archive_index(&canonical).map_err(|e| to_ipc("list_archive_entries", e))?;
    Ok(archive_level(&names, &inner))
}

/// Materialize one entry and return its real path, authorizing the directory it
/// landed in so the WebView may actually load it.
#[tauri::command]
pub(crate) fn archive_entry_file(
    app: tauri::AppHandle,
    allow: tauri::State<'_, crate::AllowList>,
    archive: String,
    inner: String,
) -> Result<String, String> {
    let canonical = crate::ensure_allowed(&allow, &archive)?;
    let file = ensure_entry(&canonical, &inner).map_err(|e| to_ipc("archive_entry_file", e))?;
    // Authorize the ENTRY'S OWN directory, not just the mirror root: the
    // asset-protocol grant is non-recursive, so a page inside `ch1/` would
    // otherwise be readable by the IPC gate (a prefix check) but not loadable by
    // convertFileSrc.
    if let Some(dir) = file.parent() {
        let canonical_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        crate::authorize_dir(&app, &allow, canonical_dir, Some(dir));
    }
    Ok(file.to_string_lossy().into_owned())
}

/// The inner path of a cover image for an archive (`inner: ""`) or for one folder
/// inside it. Searches the whole subtree, not just that level, so a `.cbz` whose
/// pages all live under `ch1/` still gets a picture instead of a bare glyph.
///
/// Returns a PATH rather than a rendered thumbnail, for the same reason
/// `folder_cover_image` does: the tile then goes through the existing
/// `media_thumbnail` command — one cache, one render pipeline.
#[tauri::command]
pub(crate) fn archive_cover_entry(
    allow: tauri::State<'_, crate::AllowList>,
    archive: String,
    inner: String,
) -> Result<Option<String>, String> {
    let canonical = crate::ensure_allowed(&allow, &archive)?;
    let names = archive_index(&canonical).map_err(|e| to_ipc("archive_cover_entry", e))?;
    let prefix = if inner.is_empty() {
        String::new()
    } else {
        format!("{inner}/")
    };
    // Lowest name wins, so a cover is stable across visits rather than depending
    // on the archive's storage order. Images only: a video cover would cost a
    // full extraction plus a demux to draw one tile.
    Ok(names
        .into_iter()
        .filter(|n| n.starts_with(&prefix) && has_gallery_image_ext(Path::new(n)))
        .min_by_key(|n| n.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_archive_ext_matches_archive_containers_only() {
        assert!(has_archive_ext(Path::new("C:/c/book.cbz")));
        assert!(has_archive_ext(Path::new("C:/c/pack.zip")));
        assert!(has_archive_ext(Path::new("C:/c/book.cbr")));
        assert!(has_archive_ext(Path::new("C:/c/pack.rar")));
        assert!(has_archive_ext(Path::new("C:/c/SHOUTY.CBZ"))); // case-insensitive
        assert!(!has_archive_ext(Path::new("C:/c/photo.jpg")));
        assert!(!has_archive_ext(Path::new("C:/c/clip.mp4")));
        assert!(!has_archive_ext(Path::new("C:/c/archive.7z"))); // not in this feature
        assert!(!has_archive_ext(Path::new("C:/c/noext")));
    }

    #[test]
    fn archive_kind_routes_each_family_to_its_decoder() {
        assert_eq!(archive_kind(Path::new("a/b.zip")), Some(ArchiveKind::Zip));
        assert_eq!(archive_kind(Path::new("a/b.cbz")), Some(ArchiveKind::Zip));
        assert_eq!(archive_kind(Path::new("a/b.rar")), Some(ArchiveKind::Rar));
        assert_eq!(archive_kind(Path::new("a/b.CBR")), Some(ArchiveKind::Rar));
        assert_eq!(archive_kind(Path::new("a/b.jpg")), None);
    }

    #[test]
    fn sanitize_entry_path_rejects_everything_that_could_escape_the_mirror() {
        // Benign names survive, with separators normalized to '/'.
        assert_eq!(sanitize_entry_path("p1.jpg"), Some("p1.jpg".to_string()));
        assert_eq!(sanitize_entry_path("ch1/p1.jpg"), Some("ch1/p1.jpg".to_string()));
        assert_eq!(sanitize_entry_path("ch1\\p1.jpg"), Some("ch1/p1.jpg".to_string()));
        assert_eq!(sanitize_entry_path("a/b/c/d.png"), Some("a/b/c/d.png".to_string()));
        // A trailing slash (an explicit directory entry) is trimmed, not rejected.
        assert_eq!(sanitize_entry_path("ch1/"), Some("ch1".to_string()));

        // Traversal, in both separators and in the middle of a path.
        assert_eq!(sanitize_entry_path("../evil.exe"), None);
        assert_eq!(sanitize_entry_path("..\\evil.exe"), None);
        assert_eq!(sanitize_entry_path("a/../../evil.exe"), None);
        assert_eq!(sanitize_entry_path("a/b/.."), None);
        assert_eq!(sanitize_entry_path(".."), None);
        // Absolute + rooted forms.
        assert_eq!(sanitize_entry_path("/etc/passwd"), None);
        assert_eq!(sanitize_entry_path("\\windows\\system32\\x"), None);
        assert_eq!(sanitize_entry_path("C:/evil.exe"), None);
        assert_eq!(sanitize_entry_path("C:evil.exe"), None);
        // UNC.
        assert_eq!(sanitize_entry_path("//server/share/x"), None);
        // Degenerate.
        assert_eq!(sanitize_entry_path(""), None);
        assert_eq!(sanitize_entry_path("   "), None);
        assert_eq!(sanitize_entry_path("a//b.jpg"), None); // empty component
        assert_eq!(sanitize_entry_path("./a.jpg"), None); // '.' component
        assert_eq!(sanitize_entry_path("a\0b.jpg"), None); // NUL

        // Alternate Data Stream syntax: a colon anywhere, not just the
        // drive-letter position, would attach a hidden stream to a real file.
        assert_eq!(sanitize_entry_path("notes.txt:hidden.exe"), None);
        assert_eq!(sanitize_entry_path("a/C:evil.exe"), None);
        // Windows reserved device names: matched on the stem, case-insensitive,
        // with or without an extension.
        assert_eq!(sanitize_entry_path("CON/evil.exe"), None);
        assert_eq!(sanitize_entry_path("nul.jpg"), None);
        assert_eq!(sanitize_entry_path("com1"), None);
        // A stem with dots must not be mistaken for a reserved name, and an
        // ordinary hyphenated name must still survive untouched.
        assert_eq!(sanitize_entry_path("Ch2/p-3.jpg"), Some("Ch2/p-3.jpg".to_string()));
        assert_eq!(
            sanitize_entry_path("my.notes.2024.jpg"),
            Some("my.notes.2024.jpg".to_string())
        );

        // Playback's own cache bookkeeping prefix: rejected structurally by
        // prefix (not by matching the one marker filename), at any depth, so no
        // archive entry can forge RAR_COMPLETE_MARKER or a future ".pb-*" file.
        assert_eq!(sanitize_entry_path(".pb-complete"), None);
        assert_eq!(sanitize_entry_path("a/.pb-complete"), None);
        assert_eq!(sanitize_entry_path(".pb-anything"), None);
        // This is a PREFIX ban, not a blanket dotfile ban — an ordinary hidden
        // file must still survive.
        assert_eq!(
            sanitize_entry_path(".hidden.jpg"),
            Some(".hidden.jpg".to_string())
        );
    }

    #[test]
    fn archive_level_derives_folders_from_entry_names() {
        // ZIPs frequently carry NO explicit directory entries, so a level's
        // folders must be derived from the file names themselves.
        let files = vec![
            "a.jpg".to_string(),
            "ch1/p1.jpg".to_string(),
            "ch1/p2.jpg".to_string(),
            "ch1/sub/p3.jpg".to_string(),
            "clip.mp4".to_string(),
            "notes.txt".to_string(),
        ];
        let root = archive_level(&files, "");
        assert_eq!(root.folders, vec!["ch1".to_string()]); // deduped, not once per file
        assert_eq!(root.images, vec!["a.jpg".to_string()]);
        assert_eq!(root.videos, vec!["clip.mp4".to_string()]);
        // A non-media file is listed as nothing at all.
        assert!(!root.images.contains(&"notes.txt".to_string()));

        let ch1 = archive_level(&files, "ch1");
        assert_eq!(ch1.folders, vec!["ch1/sub".to_string()]);
        assert_eq!(
            ch1.images,
            vec!["ch1/p1.jpg".to_string(), "ch1/p2.jpg".to_string()]
        );
        assert!(ch1.videos.is_empty());

        // A leaf level, and a level that does not exist, are both simply empty.
        assert!(archive_level(&files, "ch1/sub").folders.is_empty());
        assert_eq!(archive_level(&files, "nope"), ArchiveEntries::default());
        assert_eq!(archive_level(&[], ""), ArchiveEntries::default());
    }

    #[test]
    fn archive_level_does_not_confuse_a_prefix_sibling_for_a_child() {
        // "ch10/..." starts with "ch1" as a STRING but is not inside it.
        let files = vec!["ch1/a.jpg".to_string(), "ch10/b.jpg".to_string()];
        let ch1 = archive_level(&files, "ch1");
        assert_eq!(ch1.images, vec!["ch1/a.jpg".to_string()]);
    }

    #[test]
    fn archive_mirror_name_is_deterministic_and_invalidates_on_change() {
        let src = Path::new("C:/comics/book.cbz");
        let base = archive_mirror_name(src, 1024, 999);
        assert_eq!(base, archive_mirror_name(src, 1024, 999)); // stable
        assert!(base.starts_with("pb-ar-"));
        assert_eq!(base.len(), "pb-ar-".len() + 16);
        // Any identifying input changing yields a different mirror, so a replaced
        // or edited archive re-extracts rather than serving stale pages.
        assert_ne!(base, archive_mirror_name(src, 2048, 999));
        assert_ne!(base, archive_mirror_name(src, 1024, 1000));
        assert_ne!(base, archive_mirror_name(Path::new("C:/comics/other.cbz"), 1024, 999));
    }

    #[test]
    fn is_prunable_cache_dir_matches_only_archive_mirrors() {
        assert!(is_prunable_cache_dir("pb-ar-0123456789abcdef"));
        assert!(!is_prunable_cache_dir("pb-th-0123456789abcdef.jpg")); // a thumbnail FILE
        assert!(!is_prunable_cache_dir("my-documents"));
        assert!(!is_prunable_cache_dir(""));
    }

    #[test]
    fn archive_error_messages_are_generic_and_actionable() {
        // sec-005: what crosses the IPC boundary carries no path or OS detail.
        assert_eq!(
            ArchiveError::Encrypted.public_message(),
            "This archive is password-protected."
        );
        for e in [
            ArchiveError::TooLarge,
            ArchiveError::Unreadable,
            ArchiveError::NotFound,
            ArchiveError::Unsupported,
        ] {
            let msg = e.public_message();
            assert!(!msg.is_empty());
            assert!(!msg.contains(':')); // no "context: detail" leakage
        }
    }

    use std::io::Write as _;

    /// Build a throwaway zip on disk and return its path. Uses the `zip` crate's
    /// writer so the fixture is a REAL archive, not a hand-rolled approximation.
    fn write_test_zip(tag: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pb-ar-test-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.cbz");
        let file = std::fs::File::create(&path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in entries {
            zw.start_file(*name, opts).unwrap();
            zw.write_all(body).unwrap();
        }
        zw.finish().unwrap();
        path
    }

    #[test]
    fn zip_index_lists_sanitized_file_entries_only() {
        let zip_path = write_test_zip(
            "index",
            &[
                ("a.jpg", b"AAA"),
                ("ch1/b.png", b"BBB"),
                ("ch1/", b""), // explicit directory entry
                ("notes.txt", b"hello"),
            ],
        );
        let mut names = zip_index(&zip_path).unwrap();
        names.sort();
        // Directory entries are dropped (folders are DERIVED by archive_level);
        // non-media names are kept here — filtering by kind is archive_level's job.
        assert_eq!(
            names,
            vec!["a.jpg".to_string(), "ch1/b.png".to_string(), "notes.txt".to_string()]
        );
    }

    #[test]
    fn zip_extract_entry_writes_the_real_bytes_and_refuses_a_hostile_name() {
        let zip_path = write_test_zip("extract", &[("ch1/b.png", b"PNGBYTES")]);
        let out_dir = zip_path.parent().unwrap().join("out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let dst = out_dir.join("b.png");
        zip_extract_entry(&zip_path, "ch1/b.png", &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"PNGBYTES");

        // An entry that is not in the archive is NotFound, not a panic.
        assert_eq!(
            zip_extract_entry(&zip_path, "ch1/missing.png", &out_dir.join("x.png")),
            Err(ArchiveError::NotFound)
        );
        // A traversal name is refused before any file is opened.
        assert_eq!(
            zip_extract_entry(&zip_path, "../evil.exe", &out_dir.join("evil.exe")),
            Err(ArchiveError::NotFound)
        );
    }

    #[test]
    fn copy_capped_aborts_once_the_ceiling_is_passed() {
        // The ceiling is enforced against bytes ACTUALLY WRITTEN, because a
        // malicious header's declared size cannot be trusted.
        let src = vec![7u8; 5000];
        let mut sink: Vec<u8> = Vec::new();
        assert_eq!(copy_capped(&mut src.as_slice(), &mut sink, 10_000), Ok(5000));
        let mut small: Vec<u8> = Vec::new();
        assert_eq!(
            copy_capped(&mut src.as_slice(), &mut small, 1_000),
            Err(ArchiveError::TooLarge)
        );
    }

    #[test]
    fn ensure_entry_is_idempotent_and_serves_the_second_call_from_cache() {
        let zip_path = write_test_zip("ensure", &[("ch1/b.png", b"PNGBYTES")]);
        let first = ensure_entry(&zip_path, "ch1/b.png").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"PNGBYTES");
        // The materialized file keeps its REAL NAME at a REAL PATH — that is what
        // lets every downstream consumer stay archive-unaware.
        assert_eq!(first.file_name().unwrap(), "b.png");
        assert!(first.parent().unwrap().ends_with("ch1"));

        let mtime_after_first = std::fs::metadata(&first).unwrap().modified().unwrap();

        // A second call for the same entry returns the SAME path with the bytes
        // intact, and is proven to be a cache hit rather than a re-extraction by
        // the destination file's mtime not moving between the two calls.
        let second = ensure_entry(&zip_path, "ch1/b.png").unwrap();
        assert_eq!(second, first);
        assert_eq!(std::fs::read(&second).unwrap(), b"PNGBYTES");
        assert_eq!(
            std::fs::metadata(&second).unwrap().modified().unwrap(),
            mtime_after_first
        );
    }

    #[test]
    fn ensure_entry_rejects_a_hostile_inner_path_before_writing_anything() {
        let zip_path = write_test_zip("hostile", &[("a.jpg", b"AAA")]);
        assert_eq!(ensure_entry(&zip_path, "../escape.jpg"), Err(ArchiveError::NotFound));
        assert_eq!(ensure_entry(&zip_path, "C:/escape.jpg"), Err(ArchiveError::NotFound));
        let mirror = archive_mirror_dir(&std::fs::canonicalize(&zip_path).unwrap()).unwrap();
        // Nothing escaped, and nothing was created next to the mirror either.
        assert!(!mirror.parent().unwrap().join("escape.jpg").exists());
    }

    #[test]
    fn archive_index_routes_by_extension_and_rejects_a_non_archive() {
        let zip_path = write_test_zip("route", &[("a.jpg", b"AAA")]);
        assert_eq!(archive_index(&zip_path).unwrap(), vec!["a.jpg".to_string()]);
        let not_archive = zip_path.parent().unwrap().join("photo.jpg");
        std::fs::write(&not_archive, b"not an archive").unwrap();
        assert_eq!(archive_index(&not_archive), Err(ArchiveError::Unsupported));
    }

    /// Fix round 1, Finding 1: a rar mirror with an entry already on disk but
    /// NO completion marker is exactly what an aborted `rar_extract_all` used
    /// to leave behind. `ensure_entry` must not serve that stale file as a
    /// cache hit on the strength of its bare existence alone — it must
    /// re-attempt extraction. Driving a real `rar_extract_all` abort is
    /// impractical without a rar-writing crate, so this proves the gate
    /// directly: the "archive" here is deliberately not a valid rar, so if the
    /// stale file WERE served as a hit this returns `Ok`, and if the marker
    /// gate is honoured this returns `Err` instead (extraction against a
    /// corrupt archive fails) — which is also, incidentally, live proof of the
    /// abort-cleanup half of the fix, since that failed attempt removes the
    /// stale file from the mirror too.
    #[test]
    fn ensure_entry_for_rar_ignores_a_partial_mirror_without_the_completion_marker() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "pb-ar-test-partial-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let archive_path = dir.join("book.cbr");
        // Deliberately not a valid rar: this test only needs archive_kind to
        // route it to the rar arm, and needs extraction against it to fail.
        std::fs::write(&archive_path, b"not actually a valid rar").unwrap();

        let canonical = std::fs::canonicalize(&archive_path).unwrap();
        let mirror = archive_mirror_dir(&canonical).unwrap();
        std::fs::create_dir_all(mirror.join("ch1")).unwrap();
        std::fs::write(mirror.join("ch1/p1.jpg"), b"STALE").unwrap();
        // Deliberately no RAR_COMPLETE_MARKER written.

        let result = ensure_entry(&archive_path, "ch1/p1.jpg");
        assert!(
            result.is_err(),
            "a partial rar mirror without the completion marker must not be served as a cache hit, got {result:?}"
        );
        // The failed re-extraction attempt must also have cleaned up the stale
        // entry it found on disk, not just failed to add a marker.
        assert!(!mirror.join("ch1/p1.jpg").exists());
    }
}
