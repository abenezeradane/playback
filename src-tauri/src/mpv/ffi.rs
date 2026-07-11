//! Minimal hand-rolled FFI over `libmpv-2.dll` (native-001).
//!
//! Deliberately NOT a crate binding and NOT a link-time dependency:
//! * the DLL is loaded at RUNTIME via `libloading`, so a missing/incompatible
//!   `libmpv-2.dll` is a reported state (`player_engine_status`) — the app still
//!   starts and the frontend falls back to the WebView engine. A linked import
//!   would abort process start before `main` (STATUS_DLL_NOT_FOUND).
//! * we use ~16 of libmpv's symbols; mirroring exactly those keeps the whole
//!   unsafe surface in this one file (plus the wrapper bodies in `mod.rs`).
//!
//! Struct/const values are verbatim mirrors of `mpv/client.h` (API version 2.x,
//! verified against the shipped header of the bundled build). The libmpv C ABI
//! is stable (ABI v2 since mpv 0.35); we additionally verify the major version
//! at load via `mpv_client_api_version`.

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_double, c_int, c_ulong, c_void};
use std::path::PathBuf;
use std::sync::OnceLock;

/// Opaque mpv core handle (thread-safe per client.h).
pub enum mpv_handle {}

// --- mpv_format values we use -----------------------------------------------
pub const MPV_FORMAT_STRING: c_int = 1;
pub const MPV_FORMAT_FLAG: c_int = 3;
pub const MPV_FORMAT_INT64: c_int = 4;
pub const MPV_FORMAT_DOUBLE: c_int = 5;

// --- mpv_event_id values we handle ------------------------------------------
pub const MPV_EVENT_SHUTDOWN: c_int = 1;
pub const MPV_EVENT_LOG_MESSAGE: c_int = 2;
pub const MPV_EVENT_START_FILE: c_int = 6;
pub const MPV_EVENT_END_FILE: c_int = 7;
pub const MPV_EVENT_FILE_LOADED: c_int = 8;
pub const MPV_EVENT_SEEK: c_int = 20;
pub const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;

// --- mpv_end_file_reason ------------------------------------------------------
pub const MPV_END_FILE_REASON_EOF: c_int = 0;
pub const MPV_END_FILE_REASON_STOP: c_int = 2;
pub const MPV_END_FILE_REASON_QUIT: c_int = 3;
pub const MPV_END_FILE_REASON_ERROR: c_int = 4;
pub const MPV_END_FILE_REASON_REDIRECT: c_int = 5;

#[repr(C)]
pub struct mpv_event {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_property {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

/// Only the leading fields are read; the event data is mpv-owned memory read
/// through a pointer, so later-ABI trailing fields are safely ignored.
#[repr(C)]
pub struct mpv_event_end_file {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
}

#[repr(C)]
pub struct mpv_event_log_message {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    pub log_level: c_int,
}

/// The resolved libmpv function table. Obtained once via [`libmpv`]; the
/// underlying `Library` is intentionally leaked (the process never unloads the
/// DLL), which removes every symbol-lifetime / unload-ordering hazard with the
/// event thread.
pub struct LibMpv {
    pub client_api_version: unsafe extern "C" fn() -> c_ulong,
    pub create: unsafe extern "C" fn() -> *mut mpv_handle,
    pub initialize: unsafe extern "C" fn(*mut mpv_handle) -> c_int,
    pub terminate_destroy: unsafe extern "C" fn(*mut mpv_handle),
    pub set_option_string:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, *const c_char) -> c_int,
    pub set_option:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, c_int, *mut c_void) -> c_int,
    pub command: unsafe extern "C" fn(*mut mpv_handle, *mut *const c_char) -> c_int,
    pub set_property:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, c_int, *mut c_void) -> c_int,
    pub get_property:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, c_int, *mut c_void) -> c_int,
    pub observe_property:
        unsafe extern "C" fn(*mut mpv_handle, u64, *const c_char, c_int) -> c_int,
    pub wait_event: unsafe extern "C" fn(*mut mpv_handle, c_double) -> *mut mpv_event,
    pub wakeup: unsafe extern "C" fn(*mut mpv_handle),
    pub request_log_messages: unsafe extern "C" fn(*mut mpv_handle, *const c_char) -> c_int,
    pub error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    pub free: unsafe extern "C" fn(*mut c_void),
}

static LIB: OnceLock<Result<&'static LibMpv, String>> = OnceLock::new();

/// Candidate locations for `libmpv-2.dll`, in resolution order: next to the
/// executable (dev builds + installed layout), the exe-relative `binaries/`
/// folder (Tauri `bundle.resources` layout), then the bare name (system search
/// path — dev convenience only).
fn dll_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("libmpv-2.dll"));
            out.push(dir.join("binaries").join("libmpv-2.dll"));
        }
    }
    out.push(PathBuf::from("libmpv-2.dll"));
    out
}

/// Load and cache the libmpv function table. Idempotent — the failure is cached
/// too, so a missing DLL is probed exactly once per process.
pub fn libmpv() -> Result<&'static LibMpv, String> {
    LIB.get_or_init(|| unsafe { load_libmpv() }).clone()
}

unsafe fn load_libmpv() -> Result<&'static LibMpv, String> {
    let mut last_err = String::from("libmpv-2.dll not found");
    let lib = dll_candidates()
        .into_iter()
        .find_map(|p| match libloading::Library::new(&p) {
            Ok(l) => Some(l),
            Err(e) => {
                last_err = format!("{}: {e}", p.display());
                None
            }
        })
        .ok_or_else(|| last_err.clone())?;
    // Leak the Library: the DLL stays mapped for the process lifetime, so the
    // raw fn pointers below are 'static and the event thread can never outlive
    // its symbols.
    let lib: &'static libloading::Library = Box::leak(Box::new(lib));

    macro_rules! sym {
        ($name:literal) => {
            *lib.get($name)
                .map_err(|e| format!("libmpv symbol {}: {e}", String::from_utf8_lossy($name)))?
        };
    }

    let table = LibMpv {
        client_api_version: sym!(b"mpv_client_api_version\0"),
        create: sym!(b"mpv_create\0"),
        initialize: sym!(b"mpv_initialize\0"),
        terminate_destroy: sym!(b"mpv_terminate_destroy\0"),
        set_option_string: sym!(b"mpv_set_option_string\0"),
        set_option: sym!(b"mpv_set_option\0"),
        command: sym!(b"mpv_command\0"),
        set_property: sym!(b"mpv_set_property\0"),
        get_property: sym!(b"mpv_get_property\0"),
        observe_property: sym!(b"mpv_observe_property\0"),
        wait_event: sym!(b"mpv_wait_event\0"),
        wakeup: sym!(b"mpv_wakeup\0"),
        request_log_messages: sym!(b"mpv_request_log_messages\0"),
        error_string: sym!(b"mpv_error_string\0"),
        free: sym!(b"mpv_free\0"),
    };

    let version = (table.client_api_version)();
    let major = version >> 16;
    if major != 2 {
        return Err(format!(
            "incompatible libmpv (client API {}.{}, need 2.x)",
            major,
            version & 0xffff
        ));
    }
    Ok(Box::leak(Box::new(table)))
}
