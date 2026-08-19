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
/// device rather than a file. Separators are normalized to `/`, and a trailing
/// separator (an explicit directory entry) is trimmed. Pure.
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
        if part.is_empty() || part == "." || part == ".." || is_reserved_device_name(part) {
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
}
