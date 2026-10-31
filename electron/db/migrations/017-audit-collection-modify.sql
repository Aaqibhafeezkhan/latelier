-- Migration 017: allow 'collectionModify' as an audit_log.op so collMod
-- (validation rules, view definitions) leaves a row like the other
-- collection admin Operations. SQLite cannot alter a CHECK constraint in
-- place, so the table is rebuilt: copy → drop → rename. The `op` set in 012
-- is frozen there; this migration widens it rather than editing 012.
-- Append-only; never edit after merge.
--
-- The migration runner disables foreign keys for the duration of the
-- migration loop, so DROP TABLE here doesn't cascade-delete existing rows.

CREATE TABLE audit_log_new (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL,
  db_name        TEXT NOT NULL,
  collection     TEXT,
  op             TEXT NOT NULL CHECK(op IN (
                   'insertMany','updateOne','updateMany','deleteOne','deleteMany',
                   'collectionDrop','collectionRename','collectionModify',
                   'databaseDrop','import')),
  summary_json   TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK(outcome IN ('ok','error','partial')),
  error_code     TEXT,
  ran_at         TEXT NOT NULL,
  duration_ms    INTEGER NOT NULL,
  reversible     INTEGER NOT NULL DEFAULT 0,
  undo_json      TEXT,
  undone_at      TEXT,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);

INSERT INTO audit_log_new
  (id, connection_id, db_name, collection, op, summary_json, outcome,
   error_code, ran_at, duration_ms, reversible, undo_json, undone_at)
SELECT
  id, connection_id, db_name, collection, op, summary_json, outcome,
  error_code, ran_at, duration_ms, reversible, undo_json, undone_at
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_by_conn_time ON audit_log(connection_id, ran_at DESC);

UPDATE schema_version SET version = 17;
