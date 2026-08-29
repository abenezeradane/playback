//! tags.rs — the tag index (tags-001).

use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// The schema version this binary understands. Bump it, and add a migration
/// step below, whenever the schema changes.
pub(crate) const SCHEMA_VERSION: i32 = 2;

const SCHEMA_V1: &str = "
CREATE TABLE items (
  id       INTEGER PRIMARY KEY,
  archive  TEXT    NOT NULL DEFAULT '',
  path     TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  name     TEXT    NOT NULL,
  sort_key TEXT    NOT NULL,
  added_at INTEGER NOT NULL,
  UNIQUE(archive, path)
);
CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  folded     TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX idx_item_tags_tag ON item_tags(tag_id, item_id);
CREATE INDEX idx_items_sort    ON items(sort_key, path, id);
";
// Deliberate deviation from the design doc, which also lists an
// `idx_tags_folded`: `folded TEXT NOT NULL UNIQUE` already creates a unique
// index on that column, so a second one would be dead weight on every write.

// tags-003. `ON DELETE CASCADE` is load-bearing rather than tidiness: tags-004
// deletes a tag once its files are gone, and without the cascade the blacklist
// would keep a row pointing at a tag id that no longer exists — which a later
// tag reusing that id would silently inherit. `open_db` enables `foreign_keys`,
// without which this clause would parse and never fire.
const SCHEMA_V2: &str = "
CREATE TABLE tag_blacklist (
  tag_id     INTEGER PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
";

/// Open (creating if needed) the tag database at `path`, run migrations, and
/// return the connection.
///
/// The path is a PARAMETER rather than resolved inside: the tests open a temp
/// database, and only the command layer resolves the real one. Without that the
/// test suite would write to the developer's own tag library.
pub(crate) fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("tags: mkdir: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("tags: open: {e}"))?;
    // PRAGMA journal_mode returns the mode it actually ended up in, and SQLite
    // can decline the switch silently. pragma_update alone would report success
    // in exactly that case, so read the result back and insist on WAL.
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(|e| format!("tags: wal: {e}"))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(format!("tags: journal_mode is {mode}, not WAL"));
    }
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("tags: sync: {e}"))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| format!("tags: fk: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("tags: busy: {e}"))?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("tags: version: {e}"))?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "tags: database is newer (v{version}) than this build understands (v{SCHEMA_VERSION})"
        ));
    }
    if version < 1 {
        // One transaction: SQLite DDL is transactional, so either every table
        // and the user_version stamp land together, or none of them do. Without
        // this, a failure partway leaves tables on disk with user_version still
        // 0, and the next open re-runs the batch and dies on "table already
        // exists" — a database wedged permanently.
        let sql = format!("BEGIN;\n{SCHEMA_V1}\nPRAGMA user_version = 1;\nCOMMIT;");
        if let Err(e) = conn.execute_batch(&sql) {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(format!("tags: create: {e}"));
        }
    }
    if version < 2 {
        // Same one-transaction discipline as v1, and for the same reason: DDL
        // and the stamp must land together or a failure leaves the table on
        // disk with the old user_version, and the next open dies on "table
        // already exists" with the database wedged for good.
        let sql = format!("BEGIN;\n{SCHEMA_V2}\nPRAGMA user_version = 2;\nCOMMIT;");
        if let Err(e) = conn.execute_batch(&sql) {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(format!("tags: migrate v2: {e}"));
        }
    }
    Ok(())
}

use rusqlite::params;

/// The tag database connection, opened on first use.
///
/// Lazy on purpose: a database that cannot be opened (a full disk, a locked
/// profile) must degrade to "tagging does not work" rather than stopping the app
/// from starting. The Arc is what lets a command hand the connection to
/// `spawn_blocking`, which needs an owned, 'static value.
#[derive(Default, Clone)]
pub(crate) struct TagsDb(pub Arc<Mutex<Option<Connection>>>);

/// Run `f` against the open connection, opening it if this is the first call.
fn with_db<T, F>(db: &TagsDb, f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    // A poisoned lock fails every later call for the life of the process. That
    // is deliberate and matches AllowList's handling in lib.rs: a panic while
    // holding the connection means we no longer know the database's state, and
    // failing closed beats writing to it on a guess.
    let mut guard = db.0.lock().map_err(|_| "tags: lock poisoned".to_string())?;
    if guard.is_none() {
        let path = crate::tags_db_path().ok_or_else(|| "tags: no config directory".to_string())?;
        *guard = Some(open_db(&path)?);
    }
    let conn = guard.as_ref().expect("just opened");
    f(conn)
}

/// Move the work onto the blocking pool.
///
/// The same reasoning as archive.rs's `blocking`: an `async fn` whose body never
/// yields still pins a runtime worker for the whole call, and the popover can
/// fire a suggestion query on every keystroke. `spawn_blocking` is the pool built
/// for work that sits and computes.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => result,
        Err(_) => Err("tags: worker failed".to_string()),
    }
}

/// Upper bound on a tag name, mirrored by MAX_TAG_NAME in src/player-core.ts.
/// This side is the authority; the TypeScript one is a courtesy that avoids a
/// doomed round trip.
pub(crate) const MAX_TAG_NAME: usize = 64;
/// Upper bound on how many tags one item may carry.
pub(crate) const MAX_TAGS_PER_ITEM: i64 = 64;

/// The item a tag is attached to. `archive` is "" for a real file or folder on
/// disk; otherwise `path` is the path INSIDE that archive.
pub(crate) struct ItemRef<'a> {
    pub archive: &'a str,
    pub path: &'a str,
    pub kind: &'a str,
    pub name: &'a str,
    pub sort_key: &'a str,
}

/// Validate a tag name and return `(display, folded)`.
///
/// `folded` is the identity: trimmed, inner whitespace collapsed, lowercased.
/// Rust owns this so there is exactly one authority on when two spellings are
/// the same tag — the TypeScript side cleans input but never decides identity.
pub(crate) fn fold_tag(raw: &str) -> Result<(String, String), String> {
    let display = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if display.is_empty() {
        return Err("a tag needs a name".to_string());
    }
    if display.chars().count() > MAX_TAG_NAME {
        return Err("that tag name is too long".to_string());
    }
    if display.chars().any(char::is_control) {
        return Err("that tag name has characters that are not allowed".to_string());
    }
    let folded = display.to_lowercase();
    Ok((display, folded))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Apply `tag` to `item`, creating the item row and the tag as needed. Returns
/// the item's full tag list afterwards — the frontend renders what this returns
/// rather than keeping an optimistic copy that could drift.
pub(crate) fn apply_tag(
    conn: &Connection,
    item: &ItemRef,
    tag: &str,
) -> Result<Vec<String>, String> {
    let (display, folded) = fold_tag(tag)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("tags: tx: {e}"))?;

    tx.execute(
        "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(archive, path) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, sort_key = excluded.sort_key",
        params![item.archive, item.path, item.kind, item.name, item.sort_key, now_secs()],
    )
    .map_err(|e| format!("tags: upsert item: {e}"))?;

    let item_id: i64 = tx
        .query_row(
            "SELECT id FROM items WHERE archive = ?1 AND path = ?2",
            params![item.archive, item.path],
            |r| r.get(0),
        )
        .map_err(|e| format!("tags: item id: {e}"))?;

    // The cap counts only NEW tags: re-applying one an item already carries is a
    // no-op and must not fail just because the item is full.
    let already: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM item_tags it JOIN tags t ON t.id = it.tag_id
             WHERE it.item_id = ?1 AND t.folded = ?2",
            params![item_id, folded],
            |r| r.get(0),
        )
        .map_err(|e| format!("tags: already: {e}"))?;
    if already == 0 {
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM item_tags WHERE item_id = ?1",
                params![item_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("tags: count: {e}"))?;
        if count >= MAX_TAGS_PER_ITEM {
            return Err("that item already has as many tags as it can hold".to_string());
        }
    }

    tx.execute(
        "INSERT INTO tags (name, folded, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(folded) DO NOTHING",
        params![display, folded, now_secs()],
    )
    .map_err(|e| format!("tags: upsert tag: {e}"))?;

    let tag_id: i64 = tx
        .query_row("SELECT id FROM tags WHERE folded = ?1", params![folded], |r| r.get(0))
        .map_err(|e| format!("tags: tag id: {e}"))?;

    tx.execute(
        "INSERT INTO item_tags (item_id, tag_id) VALUES (?1, ?2)
         ON CONFLICT(item_id, tag_id) DO NOTHING",
        params![item_id, tag_id],
    )
    .map_err(|e| format!("tags: link: {e}"))?;

    tx.commit().map_err(|e| format!("tags: commit: {e}"))?;
    tags_for(conn, item.archive, item.path)
}

/// Remove `tag` from the item, deleting the item row if that was its last tag.
/// Returns the item's remaining tags.
pub(crate) fn unapply_tag(
    conn: &Connection,
    archive: &str,
    path: &str,
    tag: &str,
) -> Result<Vec<String>, String> {
    let (_, folded) = fold_tag(tag)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("tags: tx: {e}"))?;

    tx.execute(
        "DELETE FROM item_tags
         WHERE item_id = (SELECT id FROM items WHERE archive = ?1 AND path = ?2)
           AND tag_id  = (SELECT id FROM tags  WHERE folded = ?3)",
        params![archive, path, folded],
    )
    .map_err(|e| format!("tags: unlink: {e}"))?;

    // An item row exists ONLY to carry tags.
    tx.execute(
        "DELETE FROM items
         WHERE archive = ?1 AND path = ?2
           AND NOT EXISTS (SELECT 1 FROM item_tags WHERE item_id = items.id)",
        params![archive, path],
    )
    .map_err(|e| format!("tags: prune item: {e}"))?;

    tx.commit().map_err(|e| format!("tags: commit: {e}"))?;
    tags_for(conn, archive, path)
}

/// The tags on one item, ordered by their folded name so the chips are stable.
pub(crate) fn tags_for(
    conn: &Connection,
    archive: &str,
    path: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON it.tag_id = t.id
             JOIN items i      ON i.id = it.item_id
             WHERE i.archive = ?1 AND i.path = ?2
             ORDER BY t.folded",
        )
        .map_err(|e| format!("tags: prepare: {e}"))?;
    let rows = stmt
        .query_map(params![archive, path], |r| r.get::<_, String>(0))
        .map_err(|e| format!("tags: query: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("tags: row: {e}"))?);
    }
    Ok(out)
}

/// Upper bound on any command's `limit`, applied server-side no matter what the
/// caller asks for.
pub(crate) const MAX_LIMIT: u32 = 1000;

/// A tag and how many items carry it.
#[derive(Serialize)]
pub(crate) struct TagSummary {
    pub name: String,
    pub count: i64,
}

/// Escape a user-typed prefix for use with `LIKE ... ESCAPE '\'`.
///
/// LIKE is a pattern language: a typed `%` or `_` would otherwise match far more
/// than the user asked for — `%` alone would return the entire library. The
/// backslash must be escaped FIRST, or the escapes inserted for `%` and `_`
/// would themselves be escaped.
fn like_prefix(prefix: &str) -> String {
    format!(
        "{}%",
        prefix
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

/// The tag library, most-used first, for the Home chips and the all-tags index.
///
/// An empty `query` lists every tag; a non-empty one matches on a folded prefix.
/// Only tags with members can appear — the JOIN is an inner one, so a tag row
/// with no `item_tags` rows can never surface with a count of zero.
///
/// tags-003 final review (Finding 5, documented not fixed): this inner join is
/// asymmetric with `list_blacklist`, which has no such join and lists a tag
/// regardless of membership. Blacklist a tag, then untag its last member: the
/// row disappears from THIS list even with `include_blacklisted` on, while
/// `list_blacklist` still reports it blacklisted. Re-applying that tag name
/// later silently starts hidden again. Left as-is because it is recoverable —
/// the row returns the moment the tag has a member again, same as any other
/// zero-member tag — and turning this into an outer join (plus teaching every
/// caller to handle a NULL count) is a larger change than a self-healing edge
/// case warrants.
pub(crate) fn list_tags(
    conn: &Connection,
    include_blacklisted: bool,
    query: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<TagSummary>, String> {
    let limit = limit.min(MAX_LIMIT);
    let pattern = like_prefix(query);
    let mut stmt = conn
        .prepare(
            "SELECT t.name, COUNT(it.item_id) AS n
             FROM tags t
             JOIN item_tags it ON it.tag_id = t.id
             WHERE (?1 = '' OR t.folded LIKE ?2 ESCAPE '\\')
               AND (?5 OR t.id NOT IN (SELECT tag_id FROM tag_blacklist))
             GROUP BY t.id
             ORDER BY n DESC, t.folded ASC
             LIMIT ?3 OFFSET ?4",
        )
        .map_err(|e| format!("tags: prepare list: {e}"))?;
    let rows = stmt
        .query_map(params![query, pattern, limit, offset, include_blacklisted], |r| {
            Ok(TagSummary { name: r.get(0)?, count: r.get(1)? })
        })
        .map_err(|e| format!("tags: list: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("tags: list row: {e}"))?);
    }
    Ok(out)
}

/// Tags whose folded name starts with `prefix` (all tags when it is empty),
/// most-used first. Only tags that actually have members are returned.
pub(crate) fn suggest_tags(
    conn: &Connection,
    prefix: &str,
    limit: u32,
) -> Result<Vec<TagSummary>, String> {
    let limit = limit.min(MAX_LIMIT);
    let pattern = like_prefix(prefix);
    // Typeahead has no "show blacklisted" affordance, so it always excludes:
    // suggesting a tag the user has hidden would put it straight back on screen.
    let mut stmt = conn
        .prepare(
            "SELECT t.name, COUNT(it.item_id) AS n
             FROM tags t
             JOIN item_tags it ON it.tag_id = t.id
             WHERE (?1 = '' OR t.folded LIKE ?2 ESCAPE '\\')
               AND t.id NOT IN (SELECT tag_id FROM tag_blacklist)
             GROUP BY t.id
             ORDER BY n DESC, t.folded ASC
             LIMIT ?3",
        )
        .map_err(|e| format!("tags: prepare suggest: {e}"))?;
    let rows = stmt
        .query_map(params![prefix, pattern, limit], |r| {
            Ok(TagSummary { name: r.get(0)?, count: r.get(1)? })
        })
        .map_err(|e| format!("tags: suggest: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("tags: suggest row: {e}"))?);
    }
    Ok(out)
}

/// Blacklist or un-blacklist one tag (tags-003).
///
/// This writes NOTHING but a row in `tag_blacklist`: the tag keeps its name, its
/// members keep the tag, and no file is touched. Un-blacklisting restores the
/// previous state exactly, which is what makes the feature safe to try.
///
/// A tag that does not exist is an error rather than a silent no-op — the only
/// way to reach this is from a list of real tags, so a miss means the caller and
/// the store disagree about what exists, and swallowing that would hide it.
pub(crate) fn set_blacklist(conn: &Connection, tag: &str, on: bool) -> Result<(), String> {
    let (_, folded) = fold_tag(tag)?;
    let id: i64 = conn
        .query_row("SELECT id FROM tags WHERE folded = ?1", params![folded], |r| r.get(0))
        .map_err(|e| format!("tags: blacklist unknown tag: {e}"))?;
    if on {
        // OR IGNORE, not an existence check: blacklisting twice is something a
        // double-click does, and it must be a no-op rather than an error.
        conn.execute(
            "INSERT OR IGNORE INTO tag_blacklist (tag_id, created_at) VALUES (?1, ?2)",
            params![id, now_secs()],
        )
        .map_err(|e| format!("tags: blacklist insert: {e}"))?;
    } else {
        conn.execute("DELETE FROM tag_blacklist WHERE tag_id = ?1", params![id])
            .map_err(|e| format!("tags: blacklist delete: {e}"))?;
    }
    Ok(())
}

/// The display names of every blacklisted tag, for the index's toggle state.
pub(crate) fn list_blacklist(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN tag_blacklist b ON b.tag_id = t.id
             ORDER BY t.folded ASC",
        )
        .map_err(|e| format!("tags: prepare blacklist list: {e}"))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("tags: blacklist list: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("tags: blacklist list row: {e}"))?);
    }
    Ok(out)
}

/// The identity of every item carrying ANY blacklisted tag (tags-003).
///
/// The blacklist is a veto, not a vote: `DISTINCT` over the join means an item
/// with five ordinary tags and one blacklisted one appears exactly once, and is
/// hidden. Rust owns the key format so there is one authority on it — the
/// TypeScript side compares against these strings and never rebuilds them.
///
/// NUL is the separator because it cannot occur in a path, so an archive page
/// ("book.cbz" + page) can never collide with a real file of the joined name.
pub(crate) fn hidden_keys(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT i.archive, i.path
             FROM items i
             JOIN item_tags it      ON it.item_id = i.id
             JOIN tag_blacklist b   ON b.tag_id   = it.tag_id",
        )
        .map_err(|e| format!("tags: prepare hidden keys: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(format!("{}\u{0}{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| format!("tags: hidden keys: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("tags: hidden keys row: {e}"))?);
    }
    Ok(out)
}

/// The path that must exist on disk for an item to be taggable. For a page
/// inside an archive that is the ARCHIVE itself: the page is a cache artifact
/// that the 30-day prune may already have deleted.
pub(crate) fn disk_target<'a>(archive: &'a str, path: &'a str) -> &'a str {
    if archive.is_empty() {
        path
    } else {
        archive
    }
}

/// The identity an item is stored under, with the path canonicalized so the
/// same file cannot land in two rows because it was reached by a differently
/// spelled path (a lowercase drive letter, a mapped drive, a junction, an
/// 8.3 short name — all of which Windows treats as the same file).
///
/// For a page inside an archive the ARCHIVE is what exists on disk, so that is
/// what gets canonicalized; the inner path is not a filesystem path and is left
/// exactly as it is.
///
/// A path that cannot be canonicalized (the file is gone, the drive is
/// unplugged) falls back to what the caller gave, so reading the tags of a
/// missing file still finds the row that was written when it was present.
///
/// `fs::canonicalize` is a BLOCKING syscall, so every caller must invoke this
/// INSIDE the `blocking(...)` closure, never on the async runtime thread.
///
/// All three commands that take an item identity must apply this identically:
/// a read that skipped it would miss the row a write created.
pub(crate) fn canonical_identity(archive: &str, path: &str) -> (String, String) {
    // canonicalize returns the `\\?\C:\...` verbatim form, which must never be
    // what gets stored — the same file would then differ from every path the
    // rest of the app hands us.
    fn resolve(raw: &str) -> String {
        match std::fs::canonicalize(raw) {
            Ok(p) => crate::strip_extended_prefix(&p.to_string_lossy()),
            Err(_) => raw.to_string(),
        }
    }
    if archive.is_empty() {
        (String::new(), resolve(path))
    } else {
        (resolve(archive), path.to_string())
    }
}

/// The tags on one item. `archive` is "" for a real file or folder.
#[tauri::command]
pub(crate) async fn tags_for_item(
    db: tauri::State<'_, TagsDb>,
    archive: String,
    path: String,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    blocking(move || {
        // canonicalize is a blocking syscall, so it happens on THIS side of the
        // hop — and it must match what tag_apply stored, or the read misses the
        // row the write created.
        let (archive, path) = canonical_identity(&archive, &path);
        with_db(&db, |conn| tags_for(conn, &archive, &path))
    })
    .await
    .map_err(|e| crate::ipc_error("tags_for_item", e, "could not read tags"))
}

/// Apply one tag to one item; returns the item's tags afterwards.
#[tauri::command]
pub(crate) async fn tag_apply(
    db: tauri::State<'_, TagsDb>,
    archive: String,
    path: String,
    kind: String,
    name: String,
    sort_key: String,
    tag: String,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    // fold_tag is pure and its message is written for a person to read, so it is
    // checked out here and passed through verbatim.
    fold_tag(&tag)?;
    blocking(move || {
        // The existence check is a BLOCKING syscall — a network share or a
        // stalled disk can hold it for a long time — so it belongs on this side
        // of the hop, not on the async runtime thread. The store must not fill
        // with rows for paths that were never real.
        let target = disk_target(&archive, &path);
        if std::fs::metadata(target).is_err() {
            return Err(crate::ipc_error(
                "tag_apply: target missing",
                target,
                "that file is no longer there",
            ));
        }
        // Canonicalize AFTER the existence check (both are blocking syscalls and
        // both belong here): the store's key must be the resolved path, or the
        // same file tagged through two spellings becomes two rows with two
        // separate tag sets — silently losing tagging work.
        let (archive, path) = canonical_identity(&archive, &path);
        with_db(&db, |conn| {
            let item = ItemRef {
                archive: &archive,
                path: &path,
                kind: &kind,
                name: &name,
                sort_key: &sort_key,
            };
            apply_tag(conn, &item, &tag)
        })
        .map_err(|e| crate::ipc_error("tag_apply", e, "could not save that tag"))
    })
    .await
}

/// Remove one tag from one item; returns the item's remaining tags.
#[tauri::command]
pub(crate) async fn tag_unapply(
    db: tauri::State<'_, TagsDb>,
    archive: String,
    path: String,
    tag: String,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    blocking(move || {
        // Same identity as tag_apply wrote, resolved on the blocking side.
        let (archive, path) = canonical_identity(&archive, &path);
        with_db(&db, |conn| unapply_tag(conn, &archive, &path, &tag))
    })
    .await
    .map_err(|e| crate::ipc_error("tag_unapply", e, "could not remove that tag"))
}

/// Tags starting with `prefix`, most-used first, for the popover's autocomplete.
#[tauri::command]
pub(crate) async fn tag_suggest(
    db: tauri::State<'_, TagsDb>,
    prefix: String,
    limit: u32,
) -> Result<Vec<TagSummary>, String> {
    let db = db.inner().clone();
    blocking(move || with_db(&db, |conn| suggest_tags(conn, &prefix, limit)))
        .await
        .map_err(|e| crate::ipc_error("tag_suggest", e, "could not read tags"))
}

/// One member of a tag, as the grid needs it. `missing` is filled in for the
/// rows in THIS page only — statting a whole tag on every open would cost a full
/// filesystem scan of a library that may hold tens of thousands of members.
#[derive(Serialize)]
pub(crate) struct TaggedItem {
    pub archive: String,
    pub path: String,
    pub kind: String,
    pub name: String,
    pub missing: bool,
}

/// A page of a tag, plus the total so the header can say "1,248 items" without
/// fetching them all.
#[derive(Serialize)]
pub(crate) struct TagPage {
    pub total: i64,
    pub offset: i64,
    pub items: Vec<TaggedItem>,
}

/// One page of a tag's members, ordered `sort_key, path, id`.
///
/// That ordering is total and stable, which is what lets the caller page without
/// a row appearing twice or falling between pages. The filesystem is touched
/// only for the rows being returned.
pub(crate) fn tag_page(
    conn: &Connection,
    tag: &str,
    limit: u32,
    offset: u32,
) -> Result<TagPage, String> {
    let (_, folded) = fold_tag(tag)?;
    let limit = limit.min(MAX_LIMIT);

    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM item_tags it
             JOIN tags t ON t.id = it.tag_id
             WHERE t.folded = ?1",
            params![folded],
            |r| r.get(0),
        )
        .map_err(|e| format!("tags: page total: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT i.archive, i.path, i.kind, i.name
             FROM items i
             JOIN item_tags it ON it.item_id = i.id
             JOIN tags t       ON t.id = it.tag_id
             WHERE t.folded = ?1
             ORDER BY i.sort_key, i.path, i.id
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| format!("tags: prepare page: {e}"))?;
    let rows = stmt
        .query_map(params![folded, limit, offset], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| format!("tags: page: {e}"))?;

    let mut items = Vec::new();
    for row in rows {
        let (archive, path, kind, name) = row.map_err(|e| format!("tags: page row: {e}"))?;
        // For a page inside an archive the ARCHIVE is what must exist: the
        // extracted page is a cache artifact a 30-day prune may already have
        // deleted, and its absence says nothing about the tag.
        let missing = std::fs::metadata(disk_target(&archive, &path)).is_err();
        items.push(TaggedItem { archive, path, kind, name, missing });
    }
    Ok(TagPage { total, offset: offset as i64, items })
}

/// Count — and optionally remove — the members of `tag` whose file is gone.
///
/// Two-step by design: the caller asks with `apply = false` to get an honest
/// count for its confirmation, then with `apply = true` to act. Tags are never
/// removed as a side effect of browsing; a file on an unplugged drive comes back
/// when the drive does.
///
/// Only the named tag is touched. An item carried by another tag keeps its row —
/// the row is deleted only when the prune took its LAST tag.
///
/// Test-only: production uses the two-phase `missing_ids`/`delete_tag_members`
/// split below (it doesn't hold the DB lock while statting files). This stays as
/// the reference implementation a parity test compares that split against, on an
/// independent store, to prove the split preserves items still held by another tag.
#[cfg(test)]
pub(crate) fn prune_missing(conn: &Connection, tag: &str, apply: bool) -> Result<u32, String> {
    let (_, folded) = fold_tag(tag)?;
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.archive, i.path
             FROM items i
             JOIN item_tags it ON it.item_id = i.id
             JOIN tags t       ON t.id = it.tag_id
             WHERE t.folded = ?1",
        )
        .map_err(|e| format!("tags: prepare prune: {e}"))?;
    let rows = stmt
        .query_map(params![folded], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| format!("tags: prune scan: {e}"))?;

    let mut gone = Vec::new();
    for row in rows {
        let (id, archive, path) = row.map_err(|e| format!("tags: prune row: {e}"))?;
        if std::fs::metadata(disk_target(&archive, &path)).is_err() {
            gone.push(id);
        }
    }
    if !apply || gone.is_empty() {
        return Ok(gone.len() as u32);
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("tags: prune tx: {e}"))?;
    for id in &gone {
        tx.execute(
            "DELETE FROM item_tags
             WHERE item_id = ?1 AND tag_id = (SELECT id FROM tags WHERE folded = ?2)",
            params![id, folded],
        )
        .map_err(|e| format!("tags: prune unlink: {e}"))?;
        // An items row exists only to carry tags — but only delete it when this
        // was its last one, or a prune of `keep` would destroy `edit`'s member.
        tx.execute(
            "DELETE FROM items
             WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM item_tags WHERE item_id = ?1)",
            params![id],
        )
        .map_err(|e| format!("tags: prune item: {e}"))?;
    }
    tx.commit().map_err(|e| format!("tags: prune commit: {e}"))?;
    Ok(gone.len() as u32)
}

/// The (id, archive, path) of every member of `tag`, for a caller that wants to
/// stat them WITHOUT holding the database lock (tags-002).
///
/// `prune_missing` does its scan inline, which is fine for a test but not for a
/// command: statting thousands of members — some possibly on a disconnected
/// network share — while holding the shared connection would block every other
/// tag command for the duration.
pub(crate) fn tag_member_paths(
    conn: &Connection,
    tag: &str,
) -> Result<Vec<(i64, String, String)>, String> {
    let (_, folded) = fold_tag(tag)?;
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.archive, i.path
             FROM items i
             JOIN item_tags it ON it.item_id = i.id
             JOIN tags t       ON t.id = it.tag_id
             WHERE t.folded = ?1",
        )
        .map_err(|e| format!("tags: prepare member paths: {e}"))?;
    let rows = stmt
        .query_map(params![folded], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| format!("tags: member paths scan: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("tags: member paths row: {e}"))?);
    }
    Ok(out)
}

/// What a tag-delete actually did (tags-004). Five numbers rather than one,
/// because "deleted the tag" is not the same claim as "recycled every file it
/// named", and the UI must be able to say which happened.
///
/// `rename_all = "camelCase"` is load-bearing, not style: serde's default would
/// send `skipped_in_archive` and the TypeScript side reads `skippedInArchive`,
/// so without it every skip count silently arrives as `undefined` and the UI
/// reports a clean sweep over files it never touched.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagDeleteResult {
    pub recycled: u32,
    pub skipped_in_archive: u32,
    pub skipped_missing: u32,
    pub skipped_folders: u32,
    pub failed: u32,
}

/// Members split by what can be done with them.
pub(crate) struct Classified {
    /// `(item id, path on disk)` for members that exist and can be recycled.
    pub to_recycle: Vec<(i64, String)>,
    pub skipped_in_archive: u32,
    pub skipped_missing: u32,
    pub skipped_folders: u32,
}

/// Decide, for each member, whether it can be recycled — the whole of the
/// sweep's phase 2 decision-making (tags-004).
///
/// Split out from the command so it is testable against real files with no
/// database and no Tauri state, and because the `fs::metadata` calls in here
/// are precisely the slow work that must run with the connection RELEASED.
///
/// A member with a non-empty `archive` lives inside a .zip/.cbr. It is skipped,
/// never recycled: removing it would mean rewriting the user's archive, which is
/// a far larger and more dangerous action than this button promises. It is
/// counted so the result can say so rather than quietly dropping it.
pub(crate) fn classify_for_delete(rows: Vec<(i64, String, String)>) -> Classified {
    let mut out = Classified {
        to_recycle: Vec::new(),
        skipped_in_archive: 0,
        skipped_missing: 0,
        skipped_folders: 0,
    };
    for (id, archive, path) in rows {
        if !archive.is_empty() {
            out.skipped_in_archive += 1;
            continue;
        }
        // disk_target is the shared authority on which path must exist for a
        // member to be real; for a non-archive member that is the path itself.
        let target = disk_target(&archive, &path).to_string();
        let meta = match std::fs::metadata(&target) {
            Ok(meta) => meta,
            Err(_) => {
                out.skipped_missing += 1;
                continue;
            }
        };
        // recycle_file (recycle.rs) already refuses a directory outright: "a
        // recursive folder delete is a materially different promise from
        // removing one file — one this app does not make anywhere." A tag can
        // carry a folder (TagTarget::kind includes "folder"), so this bulk path
        // needs the same refusal or a confirmed "delete 5 files" could sweep an
        // entire tree. Checked against the metadata just fetched, not the
        // stored `kind`, so it also catches a row whose path happens to now
        // point at a directory for any other reason.
        if meta.is_dir() {
            out.skipped_folders += 1;
            continue;
        }
        out.to_recycle.push((id, target));
    }
    out
}

/// The per-id unlink work shared by `delete_tag_members` and `tag_delete_all`'s
/// phase 3. Pulled out so `tag_delete_all` can run it inside a transaction IT
/// already holds, alongside a live recount and the tag-row delete — SQLite has
/// no nested `BEGIN`, so this cannot itself open a transaction, unlike
/// `delete_tag_members` below which is free to because it is always called
/// standalone.
///
/// Scoped exactly as `prune_missing`: the `item_tags` row goes first, so the
/// `NOT EXISTS` guard on the `items` delete sees this same transaction's own
/// delete and fires only when no tag at all remains.
fn unlink_members(conn: &Connection, folded: &str, ids: &[i64]) -> Result<(), String> {
    for id in ids {
        conn.execute(
            "DELETE FROM item_tags
             WHERE item_id = ?1 AND tag_id = (SELECT id FROM tags WHERE folded = ?2)",
            params![id, folded],
        )
        .map_err(|e| format!("tags: delete members unlink: {e}"))?;
        // An items row exists only to carry tags — but only delete it when this
        // was its last one, or a prune of `keep` would destroy `edit`'s member.
        conn.execute(
            "DELETE FROM items
             WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM item_tags WHERE item_id = ?1)",
            params![id],
        )
        .map_err(|e| format!("tags: delete members item: {e}"))?;
    }
    Ok(())
}

/// Delete the given item ids from `tag`, in one transaction, dropping any item
/// row whose LAST tag this was. Returns how many were removed.
pub(crate) fn delete_tag_members(
    conn: &Connection,
    tag: &str,
    ids: &[i64],
) -> Result<u32, String> {
    let (_, folded) = fold_tag(tag)?;
    if ids.is_empty() {
        return Ok(0);
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("tags: delete members tx: {e}"))?;
    unlink_members(&tx, &folded, ids)?;
    tx.commit().map_err(|e| format!("tags: delete members commit: {e}"))?;
    // The count is what phase 2 identified, not rows-affected. The three-phase
    // split releases the lock between the scan and this delete, so a concurrent
    // untag could make an id stale — the delete stays a safe no-op, but the
    // number reported to the UI can overstate by that much.
    Ok(ids.len() as u32)
}

/// Delete the `tags` row for `tag` (tags-004).
///
/// The counterpart `delete_tag_members` deliberately does NOT do this: a prune
/// removes memberships and must leave the tag itself, or pruning a tag whose
/// files are temporarily on an unplugged drive would destroy the tag too.
/// tags-004 wants the opposite — once its sweep has emptied a tag there is
/// nothing left for the tag to name, so it goes.
///
/// An unknown tag is a no-op rather than an error. The sweep can race a
/// concurrent untag that already emptied and removed it, and reporting a
/// failure for work that is already done would be wrong.
///
/// The `tag_blacklist` row, if any, goes with it via the schema's
/// `ON DELETE CASCADE` (tags-003) — `open_db` enables `foreign_keys`, without
/// which that clause would parse and never fire.
pub(crate) fn delete_tag(conn: &Connection, tag: &str) -> Result<(), String> {
    let (_, folded) = fold_tag(tag)?;
    conn.execute("DELETE FROM tags WHERE folded = ?1", params![folded])
        .map_err(|e| format!("tags: delete tag: {e}"))?;
    Ok(())
}

/// The tag library for the Home chips and the all-tags index.
///
/// `include_blacklisted` is false everywhere except the index's "Show
/// blacklisted" mode — which exists because a tag you cannot see is a tag you
/// cannot un-blacklist, and a hide with no way back is a trap.
#[tauri::command]
pub(crate) async fn tag_list(
    db: tauri::State<'_, TagsDb>,
    query: String,
    limit: u32,
    offset: u32,
    include_blacklisted: bool,
) -> Result<Vec<TagSummary>, String> {
    let db = db.inner().clone();
    blocking(move || {
        with_db(&db, |conn| list_tags(conn, include_blacklisted, &query, limit, offset))
    })
    .await
    .map_err(|e| crate::ipc_error("tag_list", e, "could not read tags"))
}

/// Blacklist or un-blacklist one tag (tags-003). Writes no file and removes no
/// tag from any item — see `set_blacklist`.
#[tauri::command]
pub(crate) async fn tag_blacklist_set(
    db: tauri::State<'_, TagsDb>,
    tag: String,
    on: bool,
) -> Result<(), String> {
    let db = db.inner().clone();
    // fold_tag's message is written for a person to read, so it is checked out
    // here and passed through verbatim rather than flattened by ipc_error.
    fold_tag(&tag)?;
    blocking(move || with_db(&db, |conn| set_blacklist(conn, &tag, on)))
        .await
        .map_err(|e| crate::ipc_error("tag_blacklist_set", e, "could not change that tag"))
}

/// Every blacklisted tag's display name, so the index can mark its rows.
#[tauri::command]
pub(crate) async fn tag_blacklist_list(
    db: tauri::State<'_, TagsDb>,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    blocking(move || with_db(&db, |conn| list_blacklist(conn)))
        .await
        .map_err(|e| crate::ipc_error("tag_blacklist_list", e, "could not read tags"))
}

/// The identity of every item carrying a blacklisted tag, for the frontend's
/// browsing filter (tags-003). One call per blacklist change, not per item.
#[tauri::command]
pub(crate) async fn tag_hidden_keys(db: tauri::State<'_, TagsDb>) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    blocking(move || with_db(&db, |conn| hidden_keys(conn)))
        .await
        .map_err(|e| crate::ipc_error("tag_hidden_keys", e, "could not read tags"))
}

/// One page of a tag's members, with the total and a per-row missing flag.
#[tauri::command]
pub(crate) async fn tag_items(
    db: tauri::State<'_, TagsDb>,
    tag: String,
    limit: u32,
    offset: u32,
) -> Result<TagPage, String> {
    let db = db.inner().clone();
    // fold_tag's message is written for a person to read, so it is checked here
    // and passed through verbatim rather than being flattened by ipc_error.
    fold_tag(&tag)?;
    blocking(move || with_db(&db, |conn| tag_page(conn, &tag, limit, offset)))
        .await
        .map_err(|e| crate::ipc_error("tag_items", e, "could not read that tag"))
}

/// Count — and optionally remove — the members of a tag whose file is gone.
/// The frontend calls this twice: once to confirm, once to act.
///
/// Split into three phases so the slow part never runs under the database lock
/// (tags-002 review of Task 3's `prune_missing`, which stats inline while
/// `with_db` holds the shared connection): a large tag whose files sit on a
/// slow or disconnected network share would otherwise block every other tag
/// command — typeahead, applying a chip, counts — for the whole scan.
#[tauri::command]
pub(crate) async fn tag_prune_missing(
    db: tauri::State<'_, TagsDb>,
    tag: String,
    apply: bool,
) -> Result<u32, String> {
    let db = db.inner().clone();
    fold_tag(&tag)?;
    blocking(move || {
        // Phase 1 — read the candidates under the lock.
        let rows = with_db(&db, |conn| tag_member_paths(conn, &tag))?;
        // Phase 2 — stat them with the lock RELEASED. These syscalls are the
        // slow part and need no database at all; holding the connection across
        // them would freeze every other tag command, and a disconnected network
        // share can make that tens of seconds.
        let gone: Vec<i64> = rows
            .into_iter()
            .filter(|(_, archive, path)| std::fs::metadata(disk_target(archive, path)).is_err())
            .map(|(id, _, _)| id)
            .collect();
        if !apply || gone.is_empty() {
            return Ok(gone.len() as u32);
        }
        // Phase 3 — delete under the lock, bounded to what phase 2 identified.
        with_db(&db, |conn| delete_tag_members(conn, &tag, &gone))
    })
    .await
    .map_err(|e| crate::ipc_error("tag_prune_missing", e, "could not check that tag"))
}

/// Recycle every file a tag carries, then delete the emptied tag (tags-004).
///
/// The WebView passes only a tag NAME and the count its confirmation showed.
/// The paths come from this store, never from the caller — so `ensure_allowed`
/// (sec-002) is not widened for a tag that spans drives; it is simply not
/// needed, because the untrusted side never names a file.
///
/// Three phases, the same shape and the same reason as `tag_prune_missing`:
/// the recycling pass can run for minutes on a large tag, and holding the
/// shared connection across it would freeze every other tag command for the
/// duration.
#[tauri::command]
pub(crate) async fn tag_delete_all(
    db: tauri::State<'_, TagsDb>,
    tag: String,
    expect_count: u32,
) -> Result<TagDeleteResult, String> {
    let db = db.inner().clone();
    fold_tag(&tag)?;
    blocking(move || {
        // Phase 1 — read the members under the lock. Wrapped here, not with a
        // blanket wrap on the whole function's result: that would also catch —
        // and flatten to a generic string — the interlock's own `Err` below,
        // which is the one message the UI most needs to show verbatim.
        let rows = with_db(&db, |conn| tag_member_paths(conn, &tag))
            .map_err(|e| crate::ipc_error("tag_delete_all: read members", e, "could not read that tag"))?;

        // The interlock. The count the user confirmed against is the count we
        // must still be looking at; if a concurrent tag-apply changed it, abort
        // having deleted NOTHING rather than sweep a different set than the one
        // the confirmation described. This does not go through with_db, so it
        // passes through the `?` below untouched by either ipc_error wrap.
        if rows.len() as u32 != expect_count {
            return Err(crate::ipc_error(
                "tag_delete_all: count changed",
                format!("expected {expect_count}, found {}", rows.len()),
                "this tag changed while you were confirming - open it again",
            ));
        }

        // Phase 2 — stat and recycle with the lock RELEASED.
        let plan = classify_for_delete(rows);
        let mut result = TagDeleteResult {
            recycled: 0,
            skipped_in_archive: plan.skipped_in_archive,
            skipped_missing: plan.skipped_missing,
            skipped_folders: plan.skipped_folders,
            failed: 0,
        };
        let mut done: Vec<i64> = Vec::new();
        for (id, path) in plan.to_recycle {
            // A per-file failure is counted and the run CONTINUES. One file
            // locked by another process must not strand the other 399. There is
            // deliberately no fallback to a permanent delete: when the Recycle
            // Bin is unavailable the file stays where it is.
            match crate::recycle::recycle(std::path::Path::new(&path)) {
                Ok(()) => {
                    result.recycled += 1;
                    done.push(id);
                }
                Err(e) => {
                    eprintln!("[playback] tag_delete_all: {path}: {e}");
                    result.failed += 1;
                }
            }
        }

        // Phase 3 — under the lock again, bounded to what phase 2 actually
        // recycled.
        with_db(&db, |conn| {
            let (_, folded) = fold_tag(&tag)?;
            // Unlinking `done` and the tag-row decision share ONE transaction.
            // The phase-1 -> phase-3 gap is the whole point of releasing the
            // lock for phase 2, and on a large tag that gap is minutes long — a
            // tag_apply landing in it adds an item_tags row phase 1 never saw.
            // If that unlink and the tag-row delete were two separate commits
            // (as delete_tag_members does on its own), the new member could
            // land in the gap between them and get cascade-dropped along with
            // the tag it was just given. One transaction closes that window.
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("tags: delete-all tx: {e}"))?;
            unlink_members(&tx, &folded, &done)?;
            // The tag goes only when nothing it named survives — checked with a
            // live re-COUNT inside this same transaction, not by trusting the
            // phase-1 snapshot's arithmetic (failed + skipped_in_archive +
            // skipped_missing + skipped_folders). That arithmetic still decided
            // WHICH ids ended up in `done`; but only the live table can see a
            // member phase 1 never knew about, so it alone gets to decide
            // whether the row is actually empty now.
            let remaining: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM item_tags it
                     JOIN tags t ON t.id = it.tag_id
                     WHERE t.folded = ?1",
                    params![folded],
                    |r| r.get(0),
                )
                .map_err(|e| format!("tags: delete-all recount: {e}"))?;
            if remaining == 0 {
                delete_tag(&tx, &tag)?;
            }
            tx.commit().map_err(|e| format!("tags: delete-all commit: {e}"))
        })
        .map_err(|e| crate::ipc_error("tag_delete_all: update tag", e, "could not update that tag"))?;

        Ok(result)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh temp directory per test, following the archive.rs convention
    /// (no dev-dependency; the pid plus a counter keeps parallel tests apart).
    fn temp_db(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "pb-tags-test-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("tags.db")
    }

    #[test]
    fn open_db_creates_the_schema() {
        let path = temp_db("schema");
        let conn = open_db(&path).unwrap();
        for table in ["items", "tags", "item_tags"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table} was not created");
        }
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn open_db_is_idempotent_across_reopens() {
        let path = temp_db("reopen");
        {
            let conn = open_db(&path).unwrap();
            conn.execute(
                "INSERT INTO tags (name, folded, created_at) VALUES ('Keep', 'keep', 1)",
                [],
            )
            .unwrap();
        }
        let conn = open_db(&path).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "reopening must not wipe or duplicate the schema");
    }

    #[test]
    fn open_db_refuses_a_database_from_a_newer_version() {
        // Downgrading the app must not silently open — and then corrupt — a
        // database written by a version that knows more than this one does.
        let path = temp_db("future");
        {
            let conn = open_db(&path).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        }
        let err = open_db(&path).unwrap_err();
        assert!(err.contains("newer"), "unhelpful error: {err}");
    }

    #[test]
    fn the_connection_is_actually_in_wal_mode() {
        // Not a tautology: pragma_update reports success even when SQLite
        // declines the switch, so this reads the mode back from the connection.
        let conn = open_db(&temp_db("wal")).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert!(mode.eq_ignore_ascii_case("wal"), "journal_mode was {mode}");
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = open_db(&temp_db("fk")).unwrap();
        let attempted = conn.execute("INSERT INTO item_tags (item_id, tag_id) VALUES (1, 1)", []);
        assert!(
            attempted.is_err(),
            "a join row pointing at an item and tag that do not exist must be refused"
        );
    }

    fn item<'a>(path: &'a str, name: &'a str) -> ItemRef<'a> {
        ItemRef { archive: "", path, kind: "image", name, sort_key: name }
    }

    #[test]
    fn apply_then_read_back_returns_the_tag() {
        let conn = open_db(&temp_db("apply")).unwrap();
        let tags = apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "Keep").unwrap();
        assert_eq!(tags, vec!["Keep".to_string()]);
        assert_eq!(tags_for(&conn, "", "C:\\p\\a.jpg").unwrap(), vec!["Keep".to_string()]);
    }

    #[test]
    fn tag_identity_folds_case_and_whitespace_but_displays_what_was_typed_first() {
        let conn = open_db(&temp_db("fold")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "Trip 2024").unwrap();
        apply_tag(&conn, &item("C:\\p\\b.jpg", "b.jpg"), "TRIP 2024").unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "case must not create a second tag");
        let shown: String = conn.query_row("SELECT name FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(shown, "Trip 2024", "the first spelling is the one displayed");
    }

    #[test]
    fn applying_the_same_tag_twice_is_a_no_op() {
        let conn = open_db(&temp_db("twice")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "keep").unwrap();
        let tags = apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "keep").unwrap();
        assert_eq!(tags, vec!["keep".to_string()]);
    }

    #[test]
    fn the_same_inner_path_in_two_archives_is_two_items() {
        // The composite key is the whole reason an archive page can be tagged.
        let conn = open_db(&temp_db("archives")).unwrap();
        let a = ItemRef { archive: "C:\\c\\v1.cbz", path: "ch1/p1.jpg", kind: "image", name: "p1.jpg", sort_key: "p1.jpg" };
        let b = ItemRef { archive: "C:\\c\\v2.cbz", path: "ch1/p1.jpg", kind: "image", name: "p1.jpg", sort_key: "p1.jpg" };
        apply_tag(&conn, &a, "keep").unwrap();
        apply_tag(&conn, &b, "toss").unwrap();
        assert_eq!(tags_for(&conn, "C:\\c\\v1.cbz", "ch1/p1.jpg").unwrap(), vec!["keep".to_string()]);
        assert_eq!(tags_for(&conn, "C:\\c\\v2.cbz", "ch1/p1.jpg").unwrap(), vec!["toss".to_string()]);
    }

    #[test]
    fn removing_the_last_tag_removes_the_item_row() {
        // An item exists only to carry tags; without this the table grows forever.
        let conn = open_db(&temp_db("orphan")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "keep").unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "edit").unwrap();
        unapply_tag(&conn, "", "C:\\p\\a.jpg", "keep").unwrap();
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 1, "one tag remains, so the row must stay");
        let left = unapply_tag(&conn, "", "C:\\p\\a.jpg", "edit").unwrap();
        assert!(left.is_empty());
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 0, "the last tag went, so the row must go");
    }

    #[test]
    fn unapplying_a_tag_that_was_never_applied_is_harmless() {
        let conn = open_db(&temp_db("noop")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "keep").unwrap();
        let tags = unapply_tag(&conn, "", "C:\\p\\a.jpg", "never").unwrap();
        assert_eq!(tags, vec!["keep".to_string()]);
    }

    #[test]
    fn hostile_tag_names_are_rejected() {
        let conn = open_db(&temp_db("hostile")).unwrap();
        let it = item("C:\\p\\a.jpg", "a.jpg");
        assert!(apply_tag(&conn, &it, "   ").is_err(), "empty");
        assert!(apply_tag(&conn, &it, &"x".repeat(MAX_TAG_NAME + 1)).is_err(), "too long");
        assert!(apply_tag(&conn, &it, "ke\u{0001}ep").is_err(), "control character");
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "no rejected name may reach the table");
    }

    #[test]
    fn an_item_cannot_exceed_the_tag_cap() {
        let conn = open_db(&temp_db("cap")).unwrap();
        let it = item("C:\\p\\a.jpg", "a.jpg");
        for n in 0..MAX_TAGS_PER_ITEM {
            apply_tag(&conn, &it, &format!("tag{n}")).unwrap();
        }
        assert!(apply_tag(&conn, &it, "one-too-many").is_err());
        // An ALREADY-applied tag must still be accepted at the cap — re-applying
        // is a no-op, not an overflow.
        assert!(apply_tag(&conn, &it, "tag0").is_ok());
    }

    #[test]
    fn a_quote_in_a_tag_name_is_stored_not_executed() {
        // Bound parameters, not string building. This is the injection oracle.
        let conn = open_db(&temp_db("inject")).unwrap();
        let nasty = "'); DROP TABLE items; --";
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), nasty).unwrap();
        assert_eq!(tags_for(&conn, "", "C:\\p\\a.jpg").unwrap(), vec![nasty.to_string()]);
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 1, "the items table must still exist and hold the row");
    }

    #[test]
    fn suggestions_are_ordered_by_use_and_carry_their_counts() {
        // The count is the point: it is what stops a user creating "landscape"
        // when 4,000 things already say "landscapes".
        let conn = open_db(&temp_db("suggest")).unwrap();
        for n in 0..3 {
            let p = format!("C:\\p\\{n}.jpg");
            apply_tag(&conn, &item(&p, "x.jpg"), "landscapes").unwrap();
        }
        apply_tag(&conn, &item("C:\\p\\z.jpg", "z.jpg"), "landfill").unwrap();

        let all = suggest_tags(&conn, "", 10).unwrap();
        assert_eq!(all[0].name, "landscapes");
        assert_eq!(all[0].count, 3);
        assert_eq!(all[1].name, "landfill");
        assert_eq!(all[1].count, 1);

        let filtered = suggest_tags(&conn, "lands", 10).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "landscapes");
    }

    #[test]
    fn suggestion_prefixes_match_case_insensitively() {
        let conn = open_db(&temp_db("suggest-case")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "Trip 2024").unwrap();
        assert_eq!(suggest_tags(&conn, "trip", 10).unwrap().len(), 1);
        assert_eq!(suggest_tags(&conn, "TRIP", 10).unwrap().len(), 1);
    }

    #[test]
    fn a_wildcard_in_the_prefix_is_a_literal_not_a_pattern() {
        // '%' must match a percent sign, not every tag — otherwise typing it
        // silently returns the whole library.
        let conn = open_db(&temp_db("suggest-wild")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "keep").unwrap();
        assert!(suggest_tags(&conn, "%", 10).unwrap().is_empty());
        assert!(suggest_tags(&conn, "_", 10).unwrap().is_empty());
    }

    #[test]
    fn suggestion_escape_order_survives_a_backslash_next_to_a_wildcard() {
        // The bare "%"/"_" cases above pass under a REVERSED escape order too,
        // so they cannot guard the ordering. This one can: with the backslash
        // escaped first, the query below matches the tag; escape `%` first and
        // the backslash it inserts gets doubled, producing a pattern that
        // demands TWO literal backslashes and matches nothing. Now that
        // suggest_tags shares like_prefix with list_tags, one helper needs one
        // guard exercised from both call sites.
        let conn = open_db(&temp_db("suggest-escape-order")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "a\\%b").unwrap();
        apply_tag(&conn, &item("C:\\p\\b.jpg", "b.jpg"), "plain").unwrap();

        let hit = suggest_tags(&conn, "a\\%", 10).unwrap();
        assert_eq!(hit.len(), 1, "a backslash-then-percent prefix must match its tag");
        assert_eq!(hit[0].name, "a\\%b");
    }

    #[test]
    fn an_untagged_tag_never_appears() {
        // Nothing creates a bare tag today, but the JOIN must be an inner one so
        // a tag with no members cannot show up with a count of zero.
        let conn = open_db(&temp_db("suggest-bare")).unwrap();
        conn.execute(
            "INSERT INTO tags (name, folded, created_at) VALUES ('Ghost', 'ghost', 1)",
            [],
        )
        .unwrap();
        assert!(suggest_tags(&conn, "", 10).unwrap().is_empty());
    }

    #[test]
    fn the_database_sits_beside_the_other_prefs() {
        // Mirrors the existing hwaccel_pref_path test in lib.rs: the location is
        // decided in Rust, so nothing in the WebView can name a database file.
        let path = crate::tags_db_path().expect("no config dir");
        assert!(path.ends_with(PathBuf::from(crate::APP_IDENTIFIER).join("tags.db")));
    }

    #[test]
    fn the_disk_target_is_the_archive_for_a_page_inside_one() {
        // A page inside an archive has no path on disk — the ARCHIVE is what
        // must exist. Checking the materialized mirror path instead would refuse
        // a tag whenever the cache had been pruned.
        assert_eq!(disk_target("", "C:\\p\\a.jpg"), "C:\\p\\a.jpg");
        assert_eq!(disk_target("C:\\c\\v1.cbz", "ch1/p1.jpg"), "C:\\c\\v1.cbz");
    }

    #[test]
    fn the_limit_is_clamped() {
        let conn = open_db(&temp_db("suggest-limit")).unwrap();
        // MAX_LIMIT + 1 tags, each with one member, built in ONE transaction:
        // 1001 apply_tag calls would be 1001 transactions and needlessly slow.
        let tx = conn.unchecked_transaction().unwrap();
        for n in 0..(MAX_LIMIT + 1) {
            tx.execute(
                "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
                 VALUES ('', ?1, 'image', 'x.jpg', 'x.jpg', 0)",
                params![format!("C:\\p\\{n}.jpg")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO tags (name, folded, created_at) VALUES (?1, ?1, 0)",
                params![format!("tag{n}")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO item_tags (item_id, tag_id)
                 VALUES ((SELECT id FROM items WHERE path = ?1), (SELECT id FROM tags WHERE folded = ?2))",
                params![format!("C:\\p\\{n}.jpg"), format!("tag{n}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        // Verify the clamp works: requesting u32::MAX tags should return exactly MAX_LIMIT.
        assert_eq!(
            suggest_tags(&conn, "", u32::MAX).unwrap().len(),
            MAX_LIMIT as usize,
            "suggest_tags must clamp to MAX_LIMIT"
        );
        // Verify zero limit returns empty result.
        assert!(suggest_tags(&conn, "", 0).unwrap().is_empty());
    }

    // -----------------------------------------------------------------------
    // Path identity (canonical_identity)
    // -----------------------------------------------------------------------

    /// Tag `spelled` the way the command layer does: canonicalize first, then
    /// store under whatever identity that produced.
    fn apply_via(conn: &Connection, spelled: &str, tag: &str) -> Vec<String> {
        let (archive, path) = canonical_identity("", spelled);
        let name = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let it = ItemRef {
            archive: &archive,
            path: &path,
            kind: "image",
            name: &name,
            sort_key: &name,
        };
        apply_tag(conn, &it, tag).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn two_spellings_of_one_file_are_one_row_with_one_tag_set() {
        // The failure this prevents: C:\photos\a.jpg and c:\photos\a.jpg landing
        // as two rows with SEPARATE tag sets, which the user experiences as "my
        // tags are gone". Windows treats both spellings as the same file, so the
        // store has to as well. (Windows-only because case-insensitivity is a
        // property of this filesystem, not of the code.)
        let db_path = temp_db("canon-case");
        let dir = db_path.parent().unwrap().to_path_buf();
        let file = dir.join("Photo.JPG");
        std::fs::write(&file, b"pixels").unwrap();

        let spelled_a = file.to_string_lossy().to_string();
        // The same file reached by a differently spelled path: lowercased drive
        // letter, directories and extension. Windows opens the identical file.
        let spelled_b = spelled_a.to_lowercase();
        assert_ne!(spelled_a, spelled_b, "the two spellings must actually differ");

        let conn = open_db(&db_path).unwrap();
        apply_via(&conn, &spelled_a, "keep");
        let both = apply_via(&conn, &spelled_b, "print");
        assert_eq!(
            both,
            vec!["keep".to_string(), "print".to_string()],
            "the second spelling must land on the row the first one created"
        );

        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 1, "two spellings of one file must not be two rows");

        // The read side resolves identically, whichever spelling is asked for.
        for spelled in [&spelled_a, &spelled_b] {
            let (archive, path) = canonical_identity("", spelled);
            assert_eq!(
                tags_for(&conn, &archive, &path).unwrap(),
                vec!["keep".to_string(), "print".to_string()],
                "reading through {spelled} missed the row"
            );
        }

        // And what is stored is the plain path, never canonicalize's `\\?\` form.
        let stored: String = conn.query_row("SELECT path FROM items", [], |r| r.get(0)).unwrap();
        assert!(
            !stored.starts_with(r"\\?\"),
            "the extended-length prefix must be stripped before storing: {stored}"
        );
    }

    #[test]
    fn a_path_that_cannot_be_canonicalized_falls_back_unchanged() {
        // A file on an unplugged drive still has to read back the tags it was
        // given while it was present, so an unresolvable path keeps exactly the
        // spelling it arrived with rather than becoming an error or an empty key.
        let missing = "C:\\definitely\\not\\here\\ghost.jpg";
        assert_eq!(
            canonical_identity("", missing),
            (String::new(), missing.to_string())
        );

        let conn = open_db(&temp_db("canon-missing")).unwrap();
        apply_via(&conn, missing, "keep");
        let (archive, path) = canonical_identity("", missing);
        assert_eq!(
            tags_for(&conn, &archive, &path).unwrap(),
            vec!["keep".to_string()],
            "a lookup through the fallback must still find the row"
        );
    }

    #[test]
    fn an_archive_item_canonicalizes_the_archive_and_leaves_the_inner_path() {
        // The inner path is not a filesystem path — there is nothing on disk to
        // resolve it against, and rewriting it would only corrupt the identity.
        let db_path = temp_db("canon-archive");
        let dir = db_path.parent().unwrap().to_path_buf();
        let cbz = dir.join("Volume1.CBZ");
        std::fs::write(&cbz, b"stand-in for an archive").unwrap();
        let real = cbz.to_string_lossy().to_string();

        let (canon_archive, inner) = canonical_identity(&real, "ch1/page01.jpg");
        assert_eq!(inner, "ch1/page01.jpg", "the inner path must be untouched");
        assert!(
            !canon_archive.starts_with(r"\\?\"),
            "the extended-length prefix must be stripped: {canon_archive}"
        );
        assert!(
            canon_archive.to_lowercase().ends_with("volume1.cbz"),
            "the archive must still name the same file: {canon_archive}"
        );

        #[cfg(windows)]
        {
            let (from_lower, inner_lower) =
                canonical_identity(&real.to_lowercase(), "ch1/page01.jpg");
            assert_eq!(from_lower, canon_archive, "two spellings name one archive");
            assert_eq!(inner_lower, "ch1/page01.jpg");
        }
    }

    // -----------------------------------------------------------------------
    // Scale
    // -----------------------------------------------------------------------

    #[test]
    fn suggestions_stay_quick_on_a_large_library() {
        // tag_suggest runs on EVERY keystroke, and its predicate
        // (`?1 = '' OR t.folded LIKE ?2 ESCAPE '\'`) cannot use an index: the OR
        // with a non-indexable term forces a scan, and the ESCAPE clause disables
        // SQLite's LIKE optimization outright. GROUP BY ... ORDER BY n DESC then
        // materializes every group before LIMIT applies. Until this test the only
        // evidence for that design was a two-tag store, while the library it was
        // chosen for is expected to exceed 100,000 items.
        //
        // The bound is deliberately GENEROUS: the purpose is to catch a
        // catastrophic scan, not to police milliseconds. A tight bound on a debug
        // build would flake and then get deleted, which is worse than no test.
        const TAGS: usize = 500;
        const ROWS: usize = 200_000;
        const ITEMS: usize = 30_000;

        /// A handful of real-looking neighbours share one prefix, so the "lan"
        /// probe measures a filter that actually matches something.
        fn tag_name(j: usize) -> String {
            if j % 50 == 0 {
                format!("landscape {}", j / 50)
            } else {
                format!("tag{j:04}")
            }
        }

        let conn = open_db(&temp_db("suggest-scale")).unwrap();
        let built = std::time::Instant::now();

        // ONE transaction, like the clamp test above: 200,000 separate commits
        // would make this fixture take minutes instead of seconds.
        let tx = conn.unchecked_transaction().unwrap();
        {
            let mut ins_item = tx
                .prepare(
                    "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
                     VALUES ('', ?1, 'image', ?2, ?2, 0)",
                )
                .unwrap();
            for i in 0..ITEMS {
                let name = format!("{i:05}.jpg");
                ins_item.execute(params![format!("C:\\lib\\{name}"), name]).unwrap();
            }
            let mut ins_tag = tx
                .prepare("INSERT INTO tags (name, folded, created_at) VALUES (?1, ?1, 0)")
                .unwrap();
            for j in 0..TAGS {
                ins_tag.execute(params![tag_name(j)]).unwrap();
            }
        }

        // Tag j is carried by `count_j` items on a Zipf-ish curve — a few tags on
        // a large share of the library, a long tail on almost nothing, which is
        // what makes ORDER BY n DESC do real work. The rotating start offset only
        // keeps the fixture from stacking all 500 tags onto item 0; the per-item
        // spread is not what this measures.
        let harmonic: f64 = (1..=TAGS).map(|j| 1.0 / j as f64).sum();
        let mut rows = 0usize;
        {
            let mut link = tx
                .prepare("INSERT INTO item_tags (item_id, tag_id) VALUES (?1, ?2)")
                .unwrap();
            for j in 0..TAGS {
                let count = ((ROWS as f64 / ((j + 1) as f64 * harmonic)).round() as usize)
                    .clamp(1, ITEMS);
                let offset = (j * 977) % ITEMS;
                for k in 0..count {
                    // Rows are 1-based rowids, and (item_id, tag_id) stays unique
                    // because each tag walks distinct items exactly once.
                    let item_id = ((offset + k) % ITEMS + 1) as i64;
                    link.execute(params![item_id, (j + 1) as i64]).unwrap();
                    rows += 1;
                }
            }
        }
        tx.commit().unwrap();
        println!(
            "fixture: {TAGS} tags, {ITEMS} items, {rows} item_tags rows in {:?}",
            built.elapsed()
        );

        let t0 = std::time::Instant::now();
        let all = suggest_tags(&conn, "", 20).unwrap();
        let all_elapsed = t0.elapsed();
        let t1 = std::time::Instant::now();
        let filtered = suggest_tags(&conn, "lan", 20).unwrap();
        let lan_elapsed = t1.elapsed();

        println!("suggest_tags(\"\", 20)    over {rows} item_tags rows: {all_elapsed:?}");
        println!("suggest_tags(\"lan\", 20) over {rows} item_tags rows: {lan_elapsed:?}");

        assert_eq!(all.len(), 20, "the unfiltered probe must fill its limit");
        assert!(
            !filtered.is_empty(),
            "the prefix probe must match the landscape family"
        );
        assert!(
            filtered.iter().all(|t| t.name.to_lowercase().starts_with("lan")),
            "the prefix filter must not leak unrelated tags"
        );

        let budget = std::time::Duration::from_secs(2);
        assert!(
            all_elapsed < budget,
            "suggest_tags(\"\") took {all_elapsed:?} on {rows} rows, over the {budget:?} budget"
        );
        assert!(
            lan_elapsed < budget,
            "suggest_tags(\"lan\") took {lan_elapsed:?} on {rows} rows, over the {budget:?} budget"
        );
    }

    // -----------------------------------------------------------------------
    // list_tags
    // -----------------------------------------------------------------------

    #[test]
    fn the_tag_list_is_most_used_first_and_pages() {
        let conn = open_db(&temp_db("list")).unwrap();
        // three tags with distinct counts, so the ordering is unambiguous
        for n in 0..3 {
            apply_tag(&conn, &item(&format!("C:\\p\\a{n}.jpg"), "a.jpg"), "keep").unwrap();
        }
        for n in 0..2 {
            apply_tag(&conn, &item(&format!("C:\\p\\b{n}.jpg"), "b.jpg"), "edit").unwrap();
        }
        apply_tag(&conn, &item("C:\\p\\c.jpg", "c.jpg"), "toss").unwrap();

        let all = list_tags(&conn, false, "", 10, 0).unwrap();
        assert_eq!(
            all.iter().map(|t| (t.name.as_str(), t.count)).collect::<Vec<_>>(),
            vec![("keep", 3), ("edit", 2), ("toss", 1)]
        );

        // Paging must be stable: page 2 continues where page 1 stopped.
        let first = list_tags(&conn, false, "", 2, 0).unwrap();
        let second = list_tags(&conn, false, "", 2, 2).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].name, "toss");
    }

    #[test]
    fn the_tag_list_filters_on_a_folded_prefix() {
        let conn = open_db(&temp_db("list-filter")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "Trip 2024").unwrap();
        apply_tag(&conn, &item("C:\\p\\b.jpg", "b.jpg"), "trinket").unwrap();
        apply_tag(&conn, &item("C:\\p\\c.jpg", "c.jpg"), "keep").unwrap();

        assert_eq!(list_tags(&conn, false, "tri", 10, 0).unwrap().len(), 2);
        // Case-insensitive, because `folded` is already lowercased.
        assert_eq!(list_tags(&conn, false, "TRI", 10, 0).unwrap().len(), 2);
        assert_eq!(list_tags(&conn, false, "trip", 10, 0).unwrap()[0].name, "Trip 2024");
    }

    #[test]
    fn a_wildcard_in_the_list_query_is_a_literal() {
        // Same hazard suggest_tags guards: a typed '%' must not list the library.
        let conn = open_db(&temp_db("list-wild")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "keep").unwrap();
        assert!(list_tags(&conn, false, "%", 10, 0).unwrap().is_empty());
        assert!(list_tags(&conn, false, "_", 10, 0).unwrap().is_empty());
    }

    #[test]
    fn the_escape_order_survives_a_backslash_next_to_a_wildcard() {
        // The bare "%"/"_" cases pass under a REVERSED escape order too, so they
        // cannot guard the ordering. This one can: with the backslash escaped
        // first, the query below matches the tag; escape `%` first and the
        // backslash it inserts gets doubled, producing a pattern that demands
        // TWO literal backslashes and matches nothing.
        let conn = open_db(&temp_db("list-escape-order")).unwrap();
        apply_tag(&conn, &item("C:\\p\\a.jpg", "a.jpg"), "a\\%b").unwrap();
        apply_tag(&conn, &item("C:\\p\\b.jpg", "b.jpg"), "plain").unwrap();

        let hit = list_tags(&conn, false, "a\\%", 10, 0).unwrap();
        assert_eq!(hit.len(), 1, "a backslash-then-percent prefix must match its tag");
        assert_eq!(hit[0].name, "a\\%b");
    }

    #[test]
    fn the_tag_list_never_shows_a_tag_with_no_members() {
        let conn = open_db(&temp_db("list-bare")).unwrap();
        conn.execute(
            "INSERT INTO tags (name, folded, created_at) VALUES ('Ghost', 'ghost', 1)",
            [],
        )
        .unwrap();
        assert!(list_tags(&conn, false, "", 10, 0).unwrap().is_empty());
    }

    #[test]
    fn the_tag_list_limit_is_clamped() {
        let conn = open_db(&temp_db("list-limit")).unwrap();
        // MAX_LIMIT + 1 tags, each with one member, built in ONE transaction:
        // 1001 apply_tag calls would be 1001 transactions and needlessly slow.
        // A single tag would pass this assertion whether or not the clamp ran
        // at all, so this mirrors the_limit_is_clamped's bulk fixture above.
        let tx = conn.unchecked_transaction().unwrap();
        for n in 0..(MAX_LIMIT + 1) {
            tx.execute(
                "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
                 VALUES ('', ?1, 'image', 'x.jpg', 'x.jpg', 0)",
                params![format!("C:\\p\\{n}.jpg")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO tags (name, folded, created_at) VALUES (?1, ?1, 0)",
                params![format!("tag{n}")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO item_tags (item_id, tag_id)
                 VALUES ((SELECT id FROM items WHERE path = ?1), (SELECT id FROM tags WHERE folded = ?2))",
                params![format!("C:\\p\\{n}.jpg"), format!("tag{n}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        // Verify the clamp works: requesting u32::MAX tags should return exactly MAX_LIMIT.
        assert_eq!(
            list_tags(&conn, false, "", u32::MAX, 0).unwrap().len(),
            MAX_LIMIT as usize,
            "list_tags must clamp to MAX_LIMIT"
        );
        // Verify zero limit returns empty result.
        assert!(list_tags(&conn, false, "", 0, 0).unwrap().is_empty());
    }

    // -----------------------------------------------------------------------
    // tag_page
    // -----------------------------------------------------------------------

    #[test]
    fn a_tag_page_is_ordered_and_carries_the_total() {
        let conn = open_db(&temp_db("page")).unwrap();
        // sort_key is what ORDER BY uses; give them keys that differ from
        // insertion order so a missing ORDER BY would be visible.
        for (path, key) in [("C:\\p\\c.jpg", "c"), ("C:\\p\\a.jpg", "a"), ("C:\\p\\b.jpg", "b")] {
            let it = ItemRef { archive: "", path, kind: "image", name: "x.jpg", sort_key: key };
            apply_tag(&conn, &it, "keep").unwrap();
        }
        let page = tag_page(&conn, "keep", 10, 0).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.offset, 0);
        assert_eq!(
            page.items.iter().map(|i| i.path.as_str()).collect::<Vec<_>>(),
            vec!["C:\\p\\a.jpg", "C:\\p\\b.jpg", "C:\\p\\c.jpg"]
        );
    }

    #[test]
    fn paging_a_tag_visits_every_row_exactly_once() {
        // The property that matters: no row appears on two pages, none is skipped.
        let conn = open_db(&temp_db("page-walk")).unwrap();
        for n in 0..25 {
            let path = format!("C:\\p\\{n:03}.jpg");
            let it = ItemRef {
                archive: "",
                path: &path,
                kind: "image",
                name: "x.jpg",
                sort_key: &format!("{n:03}"),
            };
            apply_tag(&conn, &it, "keep").unwrap();
        }
        let mut seen = Vec::new();
        let mut offset = 0u32;
        loop {
            let page = tag_page(&conn, "keep", 7, offset).unwrap();
            if page.items.is_empty() {
                break;
            }
            for i in &page.items {
                seen.push(i.path.clone());
            }
            offset += 7;
        }
        assert_eq!(seen.len(), 25, "every row exactly once");
        let mut deduped = seen.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(deduped.len(), 25, "no row visited twice");
    }

    #[test]
    fn a_tag_page_reports_which_rows_are_missing_from_disk() {
        let conn = open_db(&temp_db("page-missing")).unwrap();
        // One real file, one that never existed.
        let dir = std::env::temp_dir().join(format!("pb-tags-page-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.jpg");
        std::fs::write(&real, b"x").unwrap();
        let real_s = real.to_string_lossy().to_string();

        let a = ItemRef { archive: "", path: &real_s, kind: "image", name: "real.jpg", sort_key: "a" };
        let b = ItemRef { archive: "", path: "C:\\nope\\gone.jpg", kind: "image", name: "gone.jpg", sort_key: "b" };
        apply_tag(&conn, &a, "keep").unwrap();
        // apply_tag refuses a target that is not there, so insert the missing row
        // directly — this is the state left behind when a tagged file is deleted.
        conn.execute(
            "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
             VALUES ('', ?1, 'image', 'gone.jpg', 'b', 0)",
            params![b.path],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id)
             VALUES ((SELECT id FROM items WHERE path = ?1), (SELECT id FROM tags WHERE folded = 'keep'))",
            params![b.path],
        )
        .unwrap();

        let page = tag_page(&conn, "keep", 10, 0).unwrap();
        assert_eq!(page.total, 2);
        assert!(!page.items[0].missing, "the real file is present");
        assert!(page.items[1].missing, "the deleted file is reported missing");
    }

    #[test]
    fn an_archive_page_is_missing_only_when_the_ARCHIVE_is_gone() {
        // The extracted page lives in a cache a prune deletes; the archive is
        // what actually has to exist.
        let conn = open_db(&temp_db("page-archive")).unwrap();
        let dir = std::env::temp_dir().join(format!("pb-tags-arch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cbz = dir.join("vol1.cbz");
        std::fs::write(&cbz, b"x").unwrap();
        let cbz_s = cbz.to_string_lossy().to_string();

        let it = ItemRef {
            archive: &cbz_s,
            path: "ch1/page01.jpg",
            kind: "image",
            name: "page01.jpg",
            sort_key: "a",
        };
        apply_tag(&conn, &it, "keep").unwrap();
        let page = tag_page(&conn, "keep", 10, 0).unwrap();
        assert!(!page.items[0].missing, "the archive exists, so the page is not missing");
        assert_eq!(page.items[0].path, "ch1/page01.jpg", "the inner path is preserved");
    }

    #[test]
    fn an_unknown_tag_is_an_empty_page_not_an_error() {
        let conn = open_db(&temp_db("page-unknown")).unwrap();
        let page = tag_page(&conn, "never-used", 10, 0).unwrap();
        assert_eq!(page.total, 0);
        assert!(page.items.is_empty());
    }

    #[test]
    fn a_dry_run_prune_counts_without_changing_anything() {
        let conn = open_db(&temp_db("prune-dry")).unwrap();
        let dir = std::env::temp_dir().join(format!("pb-tags-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.jpg");
        std::fs::write(&real, b"x").unwrap();
        let real_s = real.to_string_lossy().to_string();
        let keep = ItemRef { archive: "", path: &real_s, kind: "image", name: "real.jpg", sort_key: "a" };
        apply_tag(&conn, &keep, "keep").unwrap();
        for n in 0..3 {
            let path = format!("C:\\nope\\gone{n}.jpg");
            conn.execute(
                "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
                 VALUES ('', ?1, 'image', 'gone.jpg', ?2, 0)",
                params![path, format!("b{n}")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO item_tags (item_id, tag_id)
                 VALUES ((SELECT id FROM items WHERE path = ?1),
                         (SELECT id FROM tags WHERE folded = 'keep'))",
                params![path],
            )
            .unwrap();
        }

        assert_eq!(prune_missing(&conn, "keep", false).unwrap(), 3, "counts the missing");
        assert_eq!(tag_page(&conn, "keep", 100, 0).unwrap().total, 4, "changed nothing");
    }

    #[test]
    fn applying_a_prune_removes_exactly_the_missing_rows() {
        let conn = open_db(&temp_db("prune-apply")).unwrap();
        let dir = std::env::temp_dir().join(format!("pb-tags-prune2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.jpg");
        std::fs::write(&real, b"x").unwrap();
        let real_s = real.to_string_lossy().to_string();
        apply_tag(
            &conn,
            &ItemRef { archive: "", path: &real_s, kind: "image", name: "real.jpg", sort_key: "a" },
            "keep",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
             VALUES ('', 'C:\\nope\\gone.jpg', 'image', 'gone.jpg', 'b', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id)
             VALUES ((SELECT id FROM items WHERE path = 'C:\\nope\\gone.jpg'),
                     (SELECT id FROM tags WHERE folded = 'keep'))",
            [],
        )
        .unwrap();

        assert_eq!(prune_missing(&conn, "keep", true).unwrap(), 1);
        let page = tag_page(&conn, "keep", 100, 0).unwrap();
        assert_eq!(page.total, 1, "only the present file remains");
        assert!(!page.items[0].missing);
        // An item row exists only to carry tags: pruning its last tag removes it.
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE path = 'C:\\nope\\gone.jpg'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0, "the item row went with its last tag");
    }

    #[test]
    fn a_prune_touches_only_the_named_tag() {
        let conn = open_db(&temp_db("prune-scope")).unwrap();
        conn.execute(
            "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
             VALUES ('', 'C:\\nope\\gone.jpg', 'image', 'gone.jpg', 'a', 0)",
            [],
        )
        .unwrap();
        for tag in ["keep", "edit"] {
            conn.execute(
                "INSERT INTO tags (name, folded, created_at) VALUES (?1, ?1, 0)",
                params![tag],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO item_tags (item_id, tag_id)
                 VALUES ((SELECT id FROM items WHERE path = 'C:\\nope\\gone.jpg'),
                         (SELECT id FROM tags WHERE folded = ?1))",
                params![tag],
            )
            .unwrap();
        }

        assert_eq!(prune_missing(&conn, "keep", true).unwrap(), 1);
        // The row is gone from `keep` but still carried by `edit`, so the ITEM
        // must survive — pruning one tag must not delete another tag's member.
        assert_eq!(tag_page(&conn, "keep", 10, 0).unwrap().total, 0);
        assert_eq!(tag_page(&conn, "edit", 10, 0).unwrap().total, 1);
    }

    #[test]
    fn the_two_phase_prune_matches_the_inline_one() {
        // tag_member_paths + delete_tag_members must remove exactly what
        // prune_missing would — including the safety property that matters most
        // on a delete path: an item another tag still carries must survive.
        // Mirrors a_prune_touches_only_the_named_tag's shape (one item shared by
        // two tags, one item carried only by the pruned tag) so a broken
        // NOT EXISTS guard actually shows up here, and it builds a SECOND,
        // independently fixtured store to run prune_missing on, so the two
        // paths are compared by outcome, not by SQL text merely looking alike.
        fn build_fixture(conn: &Connection) {
            conn.execute(
                "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
                 VALUES ('', 'C:\\nope\\shared.jpg', 'image', 'shared.jpg', 'a', 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
                 VALUES ('', 'C:\\nope\\keeponly.jpg', 'image', 'keeponly.jpg', 'b', 0)",
                [],
            )
            .unwrap();
            for tag in ["keep", "edit"] {
                conn.execute(
                    "INSERT INTO tags (name, folded, created_at) VALUES (?1, ?1, 0)",
                    params![tag],
                )
                .unwrap();
            }
            // shared.jpg carries both tags; keeponly.jpg carries only `keep`.
            for (path, tag) in [
                ("C:\\nope\\shared.jpg", "keep"),
                ("C:\\nope\\shared.jpg", "edit"),
                ("C:\\nope\\keeponly.jpg", "keep"),
            ] {
                conn.execute(
                    "INSERT INTO item_tags (item_id, tag_id)
                     VALUES ((SELECT id FROM items WHERE path = ?1),
                             (SELECT id FROM tags WHERE folded = ?2))",
                    params![path, tag],
                )
                .unwrap();
            }
        }

        // Store 1: the two-phase path under test.
        let conn = open_db(&temp_db("prune-split")).unwrap();
        build_fixture(&conn);

        let rows = tag_member_paths(&conn, "keep").unwrap();
        assert_eq!(rows.len(), 2, "both items carry keep");
        let gone: Vec<i64> = rows
            .iter()
            .filter(|(_, a, p)| std::fs::metadata(disk_target(a, p)).is_err())
            .map(|(id, _, _)| *id)
            .collect();
        assert_eq!(gone.len(), 2, "both files are missing from disk");
        assert_eq!(delete_tag_members(&conn, "keep", &gone).unwrap(), 2);

        assert_eq!(tag_page(&conn, "keep", 10, 0).unwrap().total, 0, "keep is now empty");
        assert_eq!(
            tag_page(&conn, "edit", 10, 0).unwrap().total,
            1,
            "edit must keep its member — pruning keep must not delete a row edit still carries"
        );
        let shared_survives: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE path = 'C:\\nope\\shared.jpg'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(shared_survives, 1, "shared.jpg is still carried by edit");
        let keeponly_gone: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE path = 'C:\\nope\\keeponly.jpg'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(keeponly_gone, 0, "keeponly.jpg lost its only tag, so its row went with it");

        // Store 2: an INDEPENDENT database with the identical fixture, pruned
        // through prune_missing instead — the actual comparison the name
        // promises, not just two blocks of assertions that happen to agree.
        let conn2 = open_db(&temp_db("prune-split-inline")).unwrap();
        build_fixture(&conn2);
        assert_eq!(prune_missing(&conn2, "keep", true).unwrap(), 2);

        assert_eq!(
            tag_page(&conn, "keep", 10, 0).unwrap().total,
            tag_page(&conn2, "keep", 10, 0).unwrap().total,
            "the two paths must leave `keep` in the same state"
        );
        assert_eq!(
            tag_page(&conn, "edit", 10, 0).unwrap().total,
            tag_page(&conn2, "edit", 10, 0).unwrap().total,
            "the two paths must leave `edit` in the same state"
        );
        let items_1: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        let items_2: i64 = conn2.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items_1, items_2, "the two paths must leave the same surviving item rows");
        assert_eq!(items_1, 1, "only the shared item, still held by edit, remains");
    }

    // -----------------------------------------------------------------------
    // Deep-offset paging benchmark
    // -----------------------------------------------------------------------

    #[test]
    fn a_deep_tag_page_stays_quick_on_a_large_tag() {
        // ~40,000 members in one tag: the size the spec's DOM window exists for.
        let conn = open_db(&temp_db("page-bench")).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        tx.execute(
            "INSERT INTO tags (name, folded, created_at) VALUES ('bench', 'bench', 0)",
            [],
        )
        .unwrap();
        for n in 0..40_000 {
            let path = format!("C:\\p\\{n:06}.jpg");
            tx.execute(
                "INSERT INTO items (archive, path, kind, name, sort_key, added_at)
                 VALUES ('', ?1, 'image', 'x.jpg', ?2, 0)",
                params![path, format!("{n:06}")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO item_tags (item_id, tag_id)
                 VALUES ((SELECT id FROM items WHERE path = ?1),
                         (SELECT id FROM tags WHERE folded = 'bench'))",
                params![path],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        // Every row is missing from disk here, so this also times the per-page
        // stat — the real cost the page pays.
        let first = std::time::Instant::now();
        let head = tag_page(&conn, "bench", 500, 0).unwrap();
        let head_ms = first.elapsed();
        let second = std::time::Instant::now();
        let deep = tag_page(&conn, "bench", 500, 39_000).unwrap();
        let deep_ms = second.elapsed();

        println!("tag_page first 500 of {}: {head_ms:?}", head.total);
        println!("tag_page 500 at offset 39000: {deep_ms:?}");
        assert_eq!(head.items.len(), 500);
        assert_eq!(deep.items.len(), 500);
        // Generous on purpose: this catches a catastrophic scan, it does not
        // police milliseconds, and a tight bound would flake and be deleted.
        assert!(head_ms < std::time::Duration::from_secs(5), "first page took {head_ms:?}");
        assert!(deep_ms < std::time::Duration::from_secs(5), "deep page took {deep_ms:?}");
    }

    #[test]
    fn migration_creates_the_blacklist_table_and_stamps_v2() {
        let path = temp_db("v2-schema");
        let conn = open_db(&path).unwrap();
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tag_blacklist'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "tag_blacklist was not created");
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 2);
    }

    /// A database created by the v1 binary must gain the new table WITHOUT
    /// losing the tags already in it. This is the migration case that matters:
    /// a fresh database exercises the v1 and v2 blocks together and would pass
    /// even if the v2 block only ever ran on empty schemas.
    #[test]
    fn migration_upgrades_a_v1_database_in_place() {
        let path = temp_db("v1-upgrade");
        {
            // Build a v1 database by hand: the v1 schema, its stamp, and a row.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!("BEGIN;\n{SCHEMA_V1}\nPRAGMA user_version = 1;\nCOMMIT;"))
                .unwrap();
            conn.execute(
                "INSERT INTO tags (name, folded, created_at) VALUES ('Keep', 'keep', 1)",
                [],
            )
            .unwrap();
        }
        let conn = open_db(&path).unwrap();
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 2, "an existing v1 database was not migrated");
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags WHERE folded = 'keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the migration lost an existing tag");
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tag_blacklist'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "tag_blacklist was not added to the v1 database");
    }

    #[test]
    fn migration_to_v2_is_idempotent_across_reopens() {
        let path = temp_db("v2-reopen");
        {
            let conn = open_db(&path).unwrap();
            conn.execute(
                "INSERT INTO tags (name, folded, created_at) VALUES ('Keep', 'keep', 1)",
                [],
            )
            .unwrap();
        }
        // A second open must not re-run the DDL (it would fail on "table exists").
        let conn = open_db(&path).unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags WHERE folded = 'keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1);
    }

    /// The FK cascade is what keeps the blacklist from accumulating orphans when
    /// a tag is deleted (tags-004 will delete tags). `open_db` turns
    /// `foreign_keys` on; without that pragma this silently would not fire.
    #[test]
    fn deleting_a_tag_drops_its_blacklist_row() {
        let path = temp_db("v2-cascade");
        let conn = open_db(&path).unwrap();
        conn.execute(
            "INSERT INTO tags (name, folded, created_at) VALUES ('Gone', 'gone', 1)",
            [],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM tags WHERE folded = 'gone'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO tag_blacklist (tag_id, created_at) VALUES (?1, 1)",
            params![id],
        )
        .unwrap();
        conn.execute("DELETE FROM tags WHERE id = ?1", params![id]).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM tag_blacklist", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "the blacklist row outlived its tag");
    }

    /// Two tags, three items: `a.jpg` carries both `keep` and `hide`, `b.jpg`
    /// carries only `keep`, `c.jpg` carries only `hide`. Returns the connection.
    fn seed_blacklist_fixture(path: &PathBuf) -> Connection {
        let conn = open_db(path).unwrap();
        conn.execute_batch(
            "INSERT INTO tags (id, name, folded, created_at) VALUES
               (1, 'Keep', 'keep', 1), (2, 'Hide', 'hide', 1);
             INSERT INTO items (id, archive, path, kind, name, sort_key, added_at) VALUES
               (1, '', 'C:\\pics\\a.jpg', 'image', 'a.jpg', 'a.jpg', 1),
               (2, '', 'C:\\pics\\b.jpg', 'image', 'b.jpg', 'b.jpg', 1),
               (3, '', 'C:\\pics\\c.jpg', 'image', 'c.jpg', 'c.jpg', 1);
             INSERT INTO item_tags (item_id, tag_id) VALUES
               (1, 1), (1, 2), (2, 1), (3, 2);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn set_blacklist_adds_and_removes_and_is_idempotent() {
        let path = temp_db("bl-set");
        let conn = seed_blacklist_fixture(&path);

        set_blacklist(&conn, "hide", true).unwrap();
        set_blacklist(&conn, "hide", true).unwrap(); // twice must not error or duplicate
        assert_eq!(list_blacklist(&conn).unwrap(), vec!["Hide".to_string()]);

        set_blacklist(&conn, "hide", false).unwrap();
        set_blacklist(&conn, "hide", false).unwrap(); // removing twice is a no-op
        assert!(list_blacklist(&conn).unwrap().is_empty());
    }

    /// Folding is the identity, so the case typed must not matter.
    #[test]
    fn set_blacklist_matches_a_tag_by_its_folded_name() {
        let path = temp_db("bl-fold");
        let conn = seed_blacklist_fixture(&path);
        set_blacklist(&conn, "  HIDE  ", true).unwrap();
        assert_eq!(list_blacklist(&conn).unwrap(), vec!["Hide".to_string()]);
    }

    #[test]
    fn set_blacklist_refuses_a_tag_that_does_not_exist() {
        let path = temp_db("bl-missing");
        let conn = seed_blacklist_fixture(&path);
        assert!(set_blacklist(&conn, "nosuchtag", true).is_err());
    }

    /// The veto rule: `a.jpg` carries `keep` as well as `hide`, and must still
    /// be hidden. An item is hidden if ANY of its tags is blacklisted.
    #[test]
    fn hidden_keys_is_the_union_and_one_blacklisted_tag_is_enough() {
        let path = temp_db("bl-hidden");
        let conn = seed_blacklist_fixture(&path);
        assert!(hidden_keys(&conn).unwrap().is_empty(), "nothing hidden before blacklisting");

        set_blacklist(&conn, "hide", true).unwrap();
        let mut keys = hidden_keys(&conn).unwrap();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "\u{0}C:\\pics\\a.jpg".to_string(), // carries keep AND hide -> hidden anyway
                "\u{0}C:\\pics\\c.jpg".to_string(),
            ],
            "b.jpg carries only `keep` and must not be hidden"
        );
    }

    #[test]
    fn hidden_keys_are_restored_by_un_blacklisting() {
        let path = temp_db("bl-restore");
        let conn = seed_blacklist_fixture(&path);
        set_blacklist(&conn, "hide", true).unwrap();
        assert_eq!(hidden_keys(&conn).unwrap().len(), 2);
        set_blacklist(&conn, "hide", false).unwrap();
        assert!(hidden_keys(&conn).unwrap().is_empty(), "un-blacklisting must restore everything");
    }

    /// An archive page's identity must not collide with a real file's.
    #[test]
    fn hidden_keys_separate_an_archive_page_from_a_real_file() {
        let path = temp_db("bl-archive");
        let conn = seed_blacklist_fixture(&path);
        conn.execute_batch(
            "INSERT INTO items (id, archive, path, kind, name, sort_key, added_at) VALUES
               (4, 'C:\\pics\\book.cbz', 'page1.jpg', 'image', 'page1.jpg', 'page1.jpg', 1);
             INSERT INTO item_tags (item_id, tag_id) VALUES (4, 2);",
        )
        .unwrap();
        set_blacklist(&conn, "hide", true).unwrap();
        let keys = hidden_keys(&conn).unwrap();
        assert!(keys.contains(&"C:\\pics\\book.cbz\u{0}page1.jpg".to_string()));
    }

    #[test]
    fn list_tags_hides_blacklisted_unless_asked_for_them() {
        let path = temp_db("bl-list");
        let conn = seed_blacklist_fixture(&path);
        set_blacklist(&conn, "hide", true).unwrap();

        let visible: Vec<String> =
            list_tags(&conn, false, "", 50, 0).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(visible, vec!["Keep".to_string()], "a blacklisted tag must not be listed");

        let all: Vec<String> =
            list_tags(&conn, true, "", 50, 0).unwrap().into_iter().map(|t| t.name).collect();
        assert!(all.contains(&"Hide".to_string()), "the index must be able to ask for them");
        assert!(all.contains(&"Keep".to_string()));
    }

    /// Typeahead has no "show blacklisted" affordance, so it always excludes:
    /// suggesting a tag the user has hidden would put it straight back on screen.
    #[test]
    fn suggest_tags_always_excludes_blacklisted() {
        let path = temp_db("bl-suggest");
        let conn = seed_blacklist_fixture(&path);
        set_blacklist(&conn, "hide", true).unwrap();
        let names: Vec<String> =
            suggest_tags(&conn, "h", 50).unwrap().into_iter().map(|t| t.name).collect();
        assert!(names.is_empty(), "typeahead offered a blacklisted tag");

        // tags-003 final review (Finding 3): a NON-empty prefix cannot tell
        // `(?1 = '' OR like) AND notin` apart from the unparenthesised
        // `?1 = '' OR like AND notin` -- once ?1 = '' is false both reduce to
        // the same thing, so the assertion above would still pass with a
        // dropped paren. An EMPTY prefix is the one case where they diverge:
        // unparenthesised, `?1 = ''` alone makes the whole WHERE true and
        // "Hide" leaks back in regardless of the blacklist. Empty is also the
        // prefix the user hits FIRST -- openTagPopover calls
        // refreshSuggestions("") -- so this is the untested form that matters
        // most, not an edge case.
        let all_names: Vec<String> =
            suggest_tags(&conn, "", 50).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(
            all_names,
            vec!["Keep".to_string()],
            "typeahead offered a blacklisted tag with an empty prefix"
        );
    }

    #[test]
    fn delete_tag_removes_the_tag_row_only() {
        let path = temp_db("del-tag");
        let conn = open_db(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO tags (id, name, folded, created_at) VALUES
               (1, 'Gone', 'gone', 1), (2, 'Keep', 'keep', 1);
             INSERT INTO items (id, archive, path, kind, name, sort_key, added_at) VALUES
               (1, '', 'C:\\pics\\a.jpg', 'image', 'a.jpg', 'a.jpg', 1);
             INSERT INTO item_tags (item_id, tag_id) VALUES (1, 2);",
        )
        .unwrap();

        delete_tag(&conn, "gone").unwrap();

        let gone: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags WHERE folded = 'gone'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 0, "the tag row should be gone");
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags WHERE folded = 'keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "an unrelated tag must not be touched");
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 1, "delete_tag must not remove item rows");
    }

    /// The cascade tags-003 added is what keeps a deleted tag from leaving a
    /// blacklist row pointing at an id a future tag could reuse.
    #[test]
    fn delete_tag_takes_its_blacklist_row_with_it() {
        let path = temp_db("del-tag-bl");
        let conn = open_db(&path).unwrap();
        conn.execute(
            "INSERT INTO tags (id, name, folded, created_at) VALUES (1, 'Gone', 'gone', 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO tag_blacklist (tag_id, created_at) VALUES (1, 1)", [])
            .unwrap();

        delete_tag(&conn, "gone").unwrap();

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM tag_blacklist", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "the blacklist row outlived its tag");
    }

    /// Deleting a tag that is not there is a no-op, not an error: the sweep may
    /// race a concurrent untag that already removed it, and failing there would
    /// report a failure for work that is already done.
    #[test]
    fn delete_tag_is_a_no_op_for_an_unknown_tag() {
        let path = temp_db("del-tag-missing");
        let conn = open_db(&path).unwrap();
        assert!(delete_tag(&conn, "nosuchtag").is_ok());
    }

    /// A temp directory holding one real file, for the classifier's disk checks.
    fn temp_files(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("pb-tagdel-test-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classify_keeps_files_that_are_really_there() {
        let dir = temp_files("present");
        let f = dir.join("a.jpg");
        std::fs::write(&f, b"x").unwrap();

        let out = classify_for_delete(vec![(1, String::new(), f.to_string_lossy().into_owned())]);

        assert_eq!(out.to_recycle.len(), 1);
        assert_eq!(out.to_recycle[0].0, 1);
        assert_eq!(out.skipped_missing, 0);
        assert_eq!(out.skipped_in_archive, 0);
    }

    /// A tagged FOLDER must never reach the recycle list. `recycle_file`
    /// (recycle.rs) already refuses a directory outright -- "a recursive
    /// folder delete is a materially different promise from removing one
    /// file -- one this app does not make anywhere" -- and a tag can carry a
    /// folder (TagTarget::kind includes "folder"), so the bulk sweep needs the
    /// same refusal or a confirmed "delete 5 files" can take an entire tree.
    #[test]
    fn classify_skips_a_tagged_folder_rather_than_recycling_it_recursively() {
        let dir = temp_files("folder");
        let album = dir.join("album");
        std::fs::create_dir_all(&album).unwrap();

        let out = classify_for_delete(vec![(1, String::new(), album.to_string_lossy().into_owned())]);

        assert!(out.to_recycle.is_empty(), "a folder must never be handed to recycle()");
        assert_eq!(out.skipped_folders, 1);
        assert_eq!(out.skipped_missing, 0);
    }

    /// Skipped, not deleted: recycling a page would mean rewriting the user's
    /// archive, which is a far larger action than this button promises.
    #[test]
    fn classify_skips_a_page_inside_an_archive() {
        let dir = temp_files("archive");
        let book = dir.join("book.cbz");
        std::fs::write(&book, b"x").unwrap(); // the archive itself exists

        let out = classify_for_delete(vec![(
            1,
            book.to_string_lossy().into_owned(),
            "page1.jpg".to_string(),
        )]);

        assert!(out.to_recycle.is_empty(), "an archive page must never be recycled");
        assert_eq!(out.skipped_in_archive, 1);
        assert_eq!(out.skipped_missing, 0);
    }

    #[test]
    fn classify_skips_a_file_that_is_already_gone() {
        let dir = temp_files("missing");
        let out = classify_for_delete(vec![(
            1,
            String::new(),
            dir.join("never-existed.jpg").to_string_lossy().into_owned(),
        )]);

        assert!(out.to_recycle.is_empty());
        assert_eq!(out.skipped_missing, 1);
        assert_eq!(out.skipped_in_archive, 0);
    }

    #[test]
    fn classify_sorts_a_mixed_batch_into_its_three_buckets() {
        let dir = temp_files("mixed");
        let real = dir.join("real.jpg");
        std::fs::write(&real, b"x").unwrap();
        let book = dir.join("book.cbz");
        std::fs::write(&book, b"x").unwrap();

        let out = classify_for_delete(vec![
            (1, String::new(), real.to_string_lossy().into_owned()),
            (2, book.to_string_lossy().into_owned(), "page1.jpg".to_string()),
            (3, String::new(), dir.join("gone.jpg").to_string_lossy().into_owned()),
        ]);

        assert_eq!(out.to_recycle.len(), 1);
        assert_eq!(out.to_recycle[0].0, 1);
        assert_eq!(out.skipped_in_archive, 1);
        assert_eq!(out.skipped_missing, 1);
    }

    #[test]
    fn classify_handles_an_empty_batch() {
        let out = classify_for_delete(Vec::new());
        assert!(out.to_recycle.is_empty());
        assert_eq!(out.skipped_in_archive, 0);
        assert_eq!(out.skipped_missing, 0);
    }
}
