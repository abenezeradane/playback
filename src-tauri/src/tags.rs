//! tags.rs — the tag index (tags-001).

use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// The schema version this binary understands. Bump it, and add a migration
/// step below, whenever the schema changes.
pub(crate) const SCHEMA_VERSION: i32 = 1;

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

/// Tags whose folded name starts with `prefix` (all tags when it is empty),
/// most-used first. Only tags that actually have members are returned.
pub(crate) fn suggest_tags(
    conn: &Connection,
    prefix: &str,
    limit: u32,
) -> Result<Vec<TagSummary>, String> {
    let limit = limit.min(MAX_LIMIT);
    // LIKE is a pattern language: a typed '%' or '_' would otherwise match
    // everything. Escape them and declare the escape character.
    let pattern = format!(
        "{}%",
        prefix
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut stmt = conn
        .prepare(
            "SELECT t.name, COUNT(it.item_id) AS n
             FROM tags t
             JOIN item_tags it ON it.tag_id = t.id
             WHERE ?1 = '' OR t.folded LIKE ?2 ESCAPE '\\'
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

/// The tags on one item. `archive` is "" for a real file or folder.
#[tauri::command]
pub(crate) async fn tags_for_item(
    db: tauri::State<'_, TagsDb>,
    archive: String,
    path: String,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    blocking(move || with_db(&db, |conn| tags_for(conn, &archive, &path)))
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
    // fold_tag's message is written for a person to read and leaks nothing, so
    // it is the one error passed through verbatim — the user must be told WHY a
    // name was refused.
    let (_, _) = fold_tag(&tag)?;
    // The store must not accumulate rows for things that were never real. The
    // check lives HERE rather than in apply_tag so the database layer stays
    // filesystem-free and its tests need no fixtures on disk.
    let target = disk_target(&archive, &path);
    if std::fs::metadata(target).is_err() {
        return Err(crate::ipc_error(
            "tag_apply: target missing",
            target,
            "that file is no longer there",
        ));
    }
    blocking(move || {
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
    })
    .await
    .map_err(|e| crate::ipc_error("tag_apply", e, "could not save that tag"))
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
    blocking(move || with_db(&db, |conn| unapply_tag(conn, &archive, &path, &tag)))
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
}
