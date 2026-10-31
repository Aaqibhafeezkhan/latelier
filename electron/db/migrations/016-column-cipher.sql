-- Migration 016: encryption at rest for Mongo-derived values (X21).
-- Append-only; never edit after merge. Fixes go in a new migration.

-- The key that seals encrypted cells, wrapped by the OS keychain through
-- safeStorage. One row only. is_plaintext = 1 means `wrapped` holds the raw
-- key bytes because no usable keychain existed when it was written; it has
-- the same meaning as connection_secrets.is_plaintext.
CREATE TABLE column_keys (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  wrapped      BLOB NOT NULL,
  is_plaintext INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- The value-suggestion cache is rebuilt rather than converted: it is a 30-day
-- cache, and its UNIQUE index cannot stay on `value` once that column holds
-- ciphertext with a random nonce. Equality now goes through value_mac, a
-- keyed hash scoped to (connection, db, collection, field), so the index
-- alone deduplicates per field.
DROP TABLE recent_field_values;

CREATE TABLE recent_field_values (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  db_name TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,                 -- dotted path, same shape as CondNode.field
  value BLOB NOT NULL,                 -- sealed display string, padded to 32 bytes
  value_mac TEXT NOT NULL,             -- keyed hash of value within its field scope
  val_type TEXT NOT NULL,              -- mirrors CondNode.valType
  last_used_at TEXT NOT NULL,          -- ISO-8601
  use_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX recent_field_values_uniq ON recent_field_values(value_mac);

CREATE INDEX recent_field_values_lookup
  ON recent_field_values(connection_id, db_name, collection, field, last_used_at DESC);

UPDATE schema_version SET version = 16;
