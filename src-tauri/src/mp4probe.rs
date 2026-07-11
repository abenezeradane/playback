//! MP4 duration probe (native-001).
//!
//! The user's OBS/Twitch recordings are fragmented MP4s that declare ZERO
//! duration in `moov` (`mvhd`/`tkhd`/`mdhd` all 0, no `mehd`) — play-020 proved
//! this empirically. mpv/libavformat therefore reports no duration at load
//! either (it learns it only as fragments demux). The scrubber/ruler need a
//! duration up front, so the native engine probes it directly:
//!   1. `mvhd` duration, when non-zero (ordinary MP4s — one small head read);
//!   2. otherwise the tail `mfra`/`tfra` fragment index: the LAST entry's
//!      presentation time (in the track's `mdhd` timescale) is the start of the
//!      last fragment — within one fragment (~seconds) of the true duration,
//!      which mpv then refines via `duration` property updates.
//! Files with neither (e.g. an unfinalized crash remnant) return `None`; the
//! UI tolerates a late-arriving duration.
//!
//! Only box HEADERS and tiny fixed payloads are read; bodies (multi-GB `mdat`)
//! are seeked over, so the probe is cheap regardless of file size. Pure over
//! `Read + Seek` → unit-tested with in-memory cursors.

use std::io::{Read, Seek, SeekFrom};

use crate::{read_be_u32, read_be_u64};

/// A probed duration and which structure it came from (`"mvhd"` / `"mfra"`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProbedDuration {
    pub seconds: f64,
    pub source: &'static str,
}

/// Hard cap on boxes walked at any single level (malformed-file guard, same
/// spirit as `scan_boxes_for_fragmentation`).
const MAX_BOXES: u32 = 8192;

/// One parsed box header: (type, header_len, total_size).
fn read_box_header<R: Read + Seek>(
    r: &mut R,
    pos: u64,
    region_end: u64,
) -> std::io::Result<Option<([u8; 4], u64, u64)>> {
    if pos + 8 > region_end {
        return Ok(None);
    }
    r.seek(SeekFrom::Start(pos))?;
    let size32 = read_be_u32(r)?;
    let mut ty = [0u8; 4];
    r.read_exact(&mut ty)?;
    let mut header = 8u64;
    let size = match size32 {
        0 => region_end - pos,
        1 => {
            header = 16;
            read_be_u64(r)?
        }
        n => u64::from(n),
    };
    if size < header || pos + size > region_end {
        return Ok(None); // malformed / truncated
    }
    Ok(Some((ty, header, size)))
}

/// Walk `[start, end)` calling `f(type, body_start, body_end)` per box; `f`
/// may reposition the reader freely. Returns early if `f` returns true.
fn walk_boxes<R: Read + Seek>(
    r: &mut R,
    start: u64,
    end: u64,
    f: &mut impl FnMut(&mut R, [u8; 4], u64, u64) -> std::io::Result<bool>,
) -> std::io::Result<()> {
    let mut pos = start;
    let mut steps = 0u32;
    while let Some((ty, header, size)) = read_box_header(r, pos, end)? {
        steps += 1;
        if steps > MAX_BOXES {
            break;
        }
        if f(r, ty, pos + header, pos + size)? {
            break;
        }
        pos += size;
    }
    Ok(())
}

/// Read a FullBox's version byte + 3 flag bytes at `body_start`.
fn read_version<R: Read + Seek>(r: &mut R, body_start: u64) -> std::io::Result<u8> {
    r.seek(SeekFrom::Start(body_start))?;
    let mut vf = [0u8; 4];
    r.read_exact(&mut vf)?;
    Ok(vf[0])
}

/// `mvhd`: (timescale, duration) — layout differs by version.
fn read_mvhd<R: Read + Seek>(r: &mut R, body_start: u64) -> std::io::Result<(u32, u64)> {
    let version = read_version(r, body_start)?;
    if version == 1 {
        let _creation = read_be_u64(r)?;
        let _modification = read_be_u64(r)?;
        let timescale = read_be_u32(r)?;
        let duration = read_be_u64(r)?;
        Ok((timescale, duration))
    } else {
        let _creation = read_be_u32(r)?;
        let _modification = read_be_u32(r)?;
        let timescale = read_be_u32(r)?;
        let duration = u64::from(read_be_u32(r)?);
        Ok((timescale, duration))
    }
}

/// `tkhd`: track_ID.
fn read_tkhd_track_id<R: Read + Seek>(r: &mut R, body_start: u64) -> std::io::Result<u32> {
    let version = read_version(r, body_start)?;
    if version == 1 {
        let _creation = read_be_u64(r)?;
        let _modification = read_be_u64(r)?;
        read_be_u32(r)
    } else {
        let _creation = read_be_u32(r)?;
        let _modification = read_be_u32(r)?;
        read_be_u32(r)
    }
}

/// `mdhd`: (timescale, duration).
fn read_mdhd<R: Read + Seek>(r: &mut R, body_start: u64) -> std::io::Result<(u32, u64)> {
    let version = read_version(r, body_start)?;
    if version == 1 {
        let _creation = read_be_u64(r)?;
        let _modification = read_be_u64(r)?;
        let timescale = read_be_u32(r)?;
        let duration = read_be_u64(r)?;
        Ok((timescale, duration))
    } else {
        let _creation = read_be_u32(r)?;
        let _modification = read_be_u32(r)?;
        let timescale = read_be_u32(r)?;
        let duration = u64::from(read_be_u32(r)?);
        Ok((timescale, duration))
    }
}

/// Per-track info gathered from `moov`: track_ID → media timescale.
#[derive(Default)]
struct MoovInfo {
    mvhd: Option<(u32, u64)>,
    /// (track_id, mdhd_timescale, mdhd_duration)
    tracks: Vec<(u32, u32, u64)>,
}

fn scan_moov<R: Read + Seek>(r: &mut R, start: u64, end: u64) -> std::io::Result<MoovInfo> {
    let mut info = MoovInfo::default();
    let mut trak_ranges: Vec<(u64, u64)> = Vec::new();
    walk_boxes(r, start, end, &mut |r, ty, bs, be| {
        match &ty {
            b"mvhd" => info.mvhd = Some(read_mvhd(r, bs)?),
            b"trak" => trak_ranges.push((bs, be)),
            _ => {}
        }
        Ok(false)
    })?;
    for (ts, te) in trak_ranges {
        let mut track_id: Option<u32> = None;
        let mut mdia_range: Option<(u64, u64)> = None;
        walk_boxes(r, ts, te, &mut |r, ty, bs, be| {
            match &ty {
                b"tkhd" => track_id = Some(read_tkhd_track_id(r, bs)?),
                b"mdia" => mdia_range = Some((bs, be)),
                _ => {}
            }
            Ok(false)
        })?;
        if let (Some(id), Some((ms, me))) = (track_id, mdia_range) {
            let mut mdhd: Option<(u32, u64)> = None;
            walk_boxes(r, ms, me, &mut |r, ty, bs, _be| {
                if &ty == b"mdhd" {
                    mdhd = Some(read_mdhd(r, bs)?);
                    return Ok(true);
                }
                Ok(false)
            })?;
            if let Some((timescale, duration)) = mdhd {
                info.tracks.push((id, timescale, duration));
            }
        }
    }
    Ok(info)
}

/// Parse one `tfra` box: (track_ID, last entry's time in media-timescale units).
fn read_tfra_last_time<R: Read + Seek>(
    r: &mut R,
    body_start: u64,
    body_end: u64,
) -> std::io::Result<Option<(u32, u64)>> {
    let version = read_version(r, body_start)?;
    let track_id = read_be_u32(r)?;
    let sizes = read_be_u32(r)?;
    let len_traf = ((sizes >> 4) & 0x3) as u64 + 1;
    let len_trun = ((sizes >> 2) & 0x3) as u64 + 1;
    let len_sample = (sizes & 0x3) as u64 + 1;
    let count = u64::from(read_be_u32(r)?);
    if count == 0 {
        return Ok(None);
    }
    let entry_size = if version == 1 { 16 } else { 8 } + len_traf + len_trun + len_sample;
    // Seek directly to the LAST entry (the index can hold thousands of entries
    // for a multi-hour recording; only the last one matters here).
    let entries_start = body_start + 4 + 4 + 4 + 4; // version/flags + track_ID + sizes + count
    let last = entries_start + (count - 1) * entry_size;
    if last + entry_size > body_end {
        return Ok(None); // malformed
    }
    r.seek(SeekFrom::Start(last))?;
    let time = if version == 1 { read_be_u64(r)? } else { u64::from(read_be_u32(r)?) };
    Ok(Some((track_id, time)))
}

/// Probe the container's duration. See the module docs for the strategy.
pub fn probe_mp4_duration<R: Read + Seek>(r: &mut R) -> std::io::Result<Option<ProbedDuration>> {
    let end = r.seek(SeekFrom::End(0))?;

    // Pass 1: moov (mvhd + per-track timescales).
    let mut moov: Option<MoovInfo> = None;
    walk_boxes(r, 0, end, &mut |r, ty, bs, be| {
        if &ty == b"moov" {
            moov = Some(scan_moov(r, bs, be)?);
            return Ok(true);
        }
        Ok(false)
    })?;
    let moov = match moov {
        Some(m) => m,
        None => return Ok(None),
    };

    if let Some((timescale, duration)) = moov.mvhd {
        if duration > 0 && timescale > 0 {
            return Ok(Some(ProbedDuration {
                seconds: duration as f64 / f64::from(timescale),
                source: "mvhd",
            }));
        }
    }
    // Some files zero mvhd but carry per-track mdhd durations.
    let mdhd_best = moov
        .tracks
        .iter()
        .filter(|(_, ts, dur)| *dur > 0 && *ts > 0)
        .map(|(_, ts, dur)| *dur as f64 / f64::from(*ts))
        .fold(0.0_f64, f64::max);
    if mdhd_best > 0.0 {
        return Ok(Some(ProbedDuration { seconds: mdhd_best, source: "mvhd" }));
    }

    // Pass 2: the tail mfra index. The file ends with an `mfro` box (16 bytes)
    // whose last field is the full mfra size measured from end-of-file.
    if end < 16 {
        return Ok(None);
    }
    r.seek(SeekFrom::Start(end - 16))?;
    let mfro_size = read_be_u32(r)?;
    let mut ty = [0u8; 4];
    r.read_exact(&mut ty)?;
    if mfro_size != 16 || &ty != b"mfro" {
        return Ok(None);
    }
    let _version_flags = read_be_u32(r)?;
    let mfra_size = u64::from(read_be_u32(r)?);
    if mfra_size < 16 || mfra_size > end {
        return Ok(None);
    }
    let mfra_start = end - mfra_size;
    let Some((mty, mheader, msize)) = read_box_header(r, mfra_start, end)? else {
        return Ok(None);
    };
    if &mty != b"mfra" {
        return Ok(None);
    }

    let mut best = 0.0_f64;
    walk_boxes(r, mfra_start + mheader, mfra_start + msize, &mut |r, ty, bs, be| {
        if &ty == b"tfra" {
            if let Some((track_id, time)) = read_tfra_last_time(r, bs, be)? {
                let timescale = moov
                    .tracks
                    .iter()
                    .find(|(id, _, _)| *id == track_id)
                    .map(|(_, ts, _)| *ts)
                    .unwrap_or(0);
                if timescale > 0 {
                    best = best.max(time as f64 / f64::from(timescale));
                }
            }
        }
        Ok(false)
    })?;

    if best > 0.0 {
        Ok(Some(ProbedDuration { seconds: best, source: "mfra" }))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// size(4 BE) + type(4) + body — same helper shape as the play-020 tests.
    fn boxed(ty: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((8 + body.len()) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(ty);
        v.extend_from_slice(body);
        v
    }

    fn full_box_body(version: u8, rest: &[u8]) -> Vec<u8> {
        let mut v = vec![version, 0, 0, 0];
        v.extend_from_slice(rest);
        v
    }

    fn mvhd_v0(timescale: u32, duration: u32) -> Vec<u8> {
        let mut rest = Vec::new();
        rest.extend_from_slice(&0u32.to_be_bytes()); // creation
        rest.extend_from_slice(&0u32.to_be_bytes()); // modification
        rest.extend_from_slice(&timescale.to_be_bytes());
        rest.extend_from_slice(&duration.to_be_bytes());
        rest.extend_from_slice(&[0u8; 80]); // rate/volume/matrix/… (unread)
        boxed(b"mvhd", &full_box_body(0, &rest))
    }

    fn tkhd_v0(track_id: u32) -> Vec<u8> {
        let mut rest = Vec::new();
        rest.extend_from_slice(&0u32.to_be_bytes());
        rest.extend_from_slice(&0u32.to_be_bytes());
        rest.extend_from_slice(&track_id.to_be_bytes());
        rest.extend_from_slice(&[0u8; 72]);
        boxed(b"tkhd", &full_box_body(0, &rest))
    }

    fn mdhd_v0(timescale: u32, duration: u32) -> Vec<u8> {
        let mut rest = Vec::new();
        rest.extend_from_slice(&0u32.to_be_bytes());
        rest.extend_from_slice(&0u32.to_be_bytes());
        rest.extend_from_slice(&timescale.to_be_bytes());
        rest.extend_from_slice(&duration.to_be_bytes());
        rest.extend_from_slice(&[0u8; 4]);
        boxed(b"mdhd", &full_box_body(0, &rest))
    }

    fn trak(track_id: u32, timescale: u32, duration: u32) -> Vec<u8> {
        let mdia = boxed(b"mdia", &mdhd_v0(timescale, duration));
        let mut body = tkhd_v0(track_id);
        body.extend_from_slice(&mdia);
        boxed(b"trak", &body)
    }

    /// A v1 tfra with `times` entries for `track_id` (1-byte traf/trun/sample nums).
    fn tfra_v1(track_id: u32, times: &[u64]) -> Vec<u8> {
        let mut rest = Vec::new();
        rest.extend_from_slice(&track_id.to_be_bytes());
        rest.extend_from_slice(&0u32.to_be_bytes()); // length sizes = 0 -> 1 byte each
        rest.extend_from_slice(&(times.len() as u32).to_be_bytes());
        for &t in times {
            rest.extend_from_slice(&t.to_be_bytes()); // time
            rest.extend_from_slice(&0u64.to_be_bytes()); // moof_offset
            rest.extend_from_slice(&[1u8, 1, 1]); // traf/trun/sample numbers
        }
        boxed(b"tfra", &full_box_body(1, &rest))
    }

    /// mfra + trailing mfro whose size field covers the whole mfra..mfro span.
    fn mfra_with_mfro(tfras: &[Vec<u8>]) -> Vec<u8> {
        let mfro_len = 16u32;
        let body: Vec<u8> = tfras.concat();
        // mfro is a CHILD of mfra, and its mfra-size field counts the full mfra box.
        let mfra_total = 8 + body.len() as u32 + mfro_len;
        let mut mfro_body = full_box_body(0, &mfra_total.to_be_bytes());
        let mfro = boxed(b"mfro", &mfro_body.split_off(0));
        let mut full = body;
        full.extend_from_slice(&mfro);
        boxed(b"mfra", &full)
    }

    #[test]
    fn probe_reads_mvhd_duration_for_plain_mp4() {
        let ftyp = boxed(b"ftyp", b"isom\0\0\0\0");
        let moov = boxed(b"moov", &[mvhd_v0(1000, 30_000), trak(1, 90_000, 2_700_000)].concat());
        let mdat = boxed(b"mdat", &[0u8; 64]);
        let file = [ftyp, moov, mdat].concat();
        let got = probe_mp4_duration(&mut Cursor::new(file)).unwrap().unwrap();
        assert_eq!(got.source, "mvhd");
        assert!((got.seconds - 30.0).abs() < 1e-9);
    }

    #[test]
    fn probe_falls_back_to_mfra_tail_for_zero_duration_fragmented_mp4() {
        // The play-020 file shape: mvhd/mdhd all 0, duration only derivable from
        // the tail tfra index (track 1 @ 90kHz, last fragment starts at 18,000,000
        // units = 200 s).
        let ftyp = boxed(b"ftyp", b"isom\0\0\0\0");
        let moov = boxed(b"moov", &[mvhd_v0(1000, 0), trak(1, 90_000, 0)].concat());
        let moof = boxed(b"moof", &[0u8; 16]);
        let mdat = boxed(b"mdat", &[0u8; 64]);
        let mfra = mfra_with_mfro(&[tfra_v1(1, &[0, 9_000_000, 18_000_000])]);
        let file = [ftyp, moov, moof, mdat, mfra].concat();
        let got = probe_mp4_duration(&mut Cursor::new(file)).unwrap().unwrap();
        assert_eq!(got.source, "mfra");
        assert!((got.seconds - 200.0).abs() < 1e-9);
    }

    #[test]
    fn probe_takes_max_across_tracks_and_ignores_unknown_track_ids() {
        let ftyp = boxed(b"ftyp", b"isom\0\0\0\0");
        let moov = boxed(
            b"moov",
            &[mvhd_v0(1000, 0), trak(1, 90_000, 0), trak(2, 48_000, 0)].concat(),
        );
        // track 2's audio index reaches further (60 s) than track 1 (50 s);
        // track 9 has no mdhd -> skipped rather than dividing by zero.
        let mfra = mfra_with_mfro(&[
            tfra_v1(1, &[4_500_000]),      // 50 s @ 90k
            tfra_v1(2, &[2_880_000]),      // 60 s @ 48k
            tfra_v1(9, &[999_999_999]),    // unknown track -> ignored
        ]);
        let file = [ftyp, moov, mfra].concat();
        let got = probe_mp4_duration(&mut Cursor::new(file)).unwrap().unwrap();
        assert_eq!(got.source, "mfra");
        assert!((got.seconds - 60.0).abs() < 1e-9);
    }

    #[test]
    fn probe_handles_missing_everything_without_panicking() {
        // No moov at all.
        assert!(probe_mp4_duration(&mut Cursor::new(boxed(b"ftyp", b"isom")))
            .unwrap()
            .is_none());
        // moov but zero durations and no mfra.
        let moov = boxed(b"moov", &[mvhd_v0(1000, 0), trak(1, 90_000, 0)].concat());
        let file = [boxed(b"ftyp", b"isom\0\0\0\0"), moov, boxed(b"mdat", &[0u8; 32])].concat();
        assert!(probe_mp4_duration(&mut Cursor::new(file)).unwrap().is_none());
        // Empty / tiny inputs.
        assert!(probe_mp4_duration(&mut Cursor::new(Vec::<u8>::new())).unwrap().is_none());
        assert!(probe_mp4_duration(&mut Cursor::new(vec![0u8; 10])).unwrap().is_none());
        // Garbage tail that is not an mfro.
        let mut junk = boxed(b"moov", &mvhd_v0(1000, 0));
        junk.extend_from_slice(&[0u8; 16]);
        assert!(probe_mp4_duration(&mut Cursor::new(junk)).unwrap().is_none());
    }

    #[test]
    fn tfra_seeks_directly_to_last_entry_of_large_index() {
        // 1000 entries; only the last (999 * 90k units = 999 s) matters.
        let times: Vec<u64> = (0..1000u64).map(|i| i * 90_000).collect();
        let ftyp = boxed(b"ftyp", b"isom\0\0\0\0");
        let moov = boxed(b"moov", &[mvhd_v0(1000, 0), trak(7, 90_000, 0)].concat());
        let mfra = mfra_with_mfro(&[tfra_v1(7, &times)]);
        let file = [ftyp, moov, mfra].concat();
        let got = probe_mp4_duration(&mut Cursor::new(file)).unwrap().unwrap();
        assert!((got.seconds - 999.0).abs() < 1e-9);
    }
}
