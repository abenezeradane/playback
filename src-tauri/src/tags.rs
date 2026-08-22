//! tags.rs — the tag index (tags-001).

use rusqlite::Connection;
use std::path::Path;

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
}
