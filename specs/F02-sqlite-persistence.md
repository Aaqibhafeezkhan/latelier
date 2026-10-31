# F02 — SQLite persistence & migrations

> **Status: Implemented.**

## Purpose

Provide a single, well-typed, versioned SQLite store for every piece of persistent state MongoLab keeps. Wrap `better-sqlite3` so services see a small, testable surface: a `Database` handle plus a set of repositories.

## Scope

- **In**: DB bootstrapping, file location, pragmas, migration runner, schema for all iteration-1 tables, base repository patterns.
- **Out**: Secret encryption (F03), the specific repository methods used by each domain service (those live in the repo's own spec: C02, W09, W10, X01).

## Dependencies

- F01 (conventions).
- `better-sqlite3` installed.

## 1. Location & bootstrap

- DB path: `path.join(app.getPath('userData'), 'latelier.db')`. A `mongolab.db` left by an older build is renamed once at startup ([X09](./X09-namespace-rename.md) Phase 3).
- On POSIX the user-data dir is `0700` and `latelier.db`, `-wal` and `-shm` are `0600` (existing ones are tightened at open; the db file is created before SQLite opens it so the side files inherit the mode); a chmod failure aborts startup. No-op on Windows.
- Opened synchronously on app startup (F06) before any window is created.
- Pragmas (applied once, in order, on every open):
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA secure_delete = ON;
  PRAGMA temp_store = MEMORY;  -- VACUUM's temp copy of still-plaintext rows never reaches disk (X21)
  ```
- On first run the file is created and migrations run to the latest version.
- On subsequent runs migrations with version > `schema_version.version` run in a transaction.

```ts
// electron/db/sqlite.ts
export function openDatabase(userDataDir: string): Database {
  const db = new Database(path.join(userDataDir, 'latelier.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  db.pragma('temp_store = MEMORY');
  // VACUUM when an upgrade ran migrations: erases bytes freed before
  // secure_delete was on. Then fold and truncate the WAL.
  if (runMigrations(db) > 0) vacuumAndTruncateWal(db, 'after migrations', log);
  else truncateWal(db);
  return db;
}
```

## 2. Migration runner

- Migrations live in `electron/db/migrations/` as numbered `.sql` files: `001-init.sql`, `002-add-recent-index.sql`, …
- A build-time step (`vite-plugin-virtual` or a simple `import.meta.glob`) inlines them into `migrations.ts` so packaged apps can read them without filesystem access.
- Algorithm:
  1. `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);` and insert `0` if empty.
  2. Read current version.
  3. For each migration file with number > current, begin transaction, execute SQL, update version, commit.
  4. If any migration throws, rollback that migration and abort startup (log fatal, do not create window).
- Migration files are **append-only**: once merged they are never edited. Fixes go in a new migration.

## 3. Schema (migration 001)

```sql
-- 001-init.sql

CREATE TABLE schema_version (
  version INTEGER NOT NULL
);
INSERT INTO schema_version (version) VALUES (0);

-- Connections -----------------------------------------------------

CREATE TABLE connections (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL,
  color                      TEXT NOT NULL DEFAULT '#1A6835',
  connection_type            TEXT NOT NULL CHECK(connection_type IN ('srv','standard')),
  host                       TEXT NOT NULL,
  port                       INTEGER NOT NULL,
  default_db                 TEXT,
  auth_mech                  TEXT NOT NULL CHECK(auth_mech IN ('scram256','scram1','x509','awsiam','none')),
  auth_username              TEXT,
  auth_database              TEXT,
  tls_enabled                INTEGER NOT NULL DEFAULT 1,
  tls_verify                 INTEGER NOT NULL DEFAULT 1,
  tls_ca_path                TEXT,
  tls_client_cert_path       TEXT,
  ssh_enabled                INTEGER NOT NULL DEFAULT 0,
  ssh_host                   TEXT,
  ssh_port                   INTEGER,
  ssh_username               TEXT,
  ssh_auth_method            TEXT CHECK(ssh_auth_method IN ('key','password') OR ssh_auth_method IS NULL),
  ssh_private_key_path       TEXT,
  connect_timeout_ms         INTEGER NOT NULL DEFAULT 10000,
  socket_timeout_ms          INTEGER NOT NULL DEFAULT 30000,
  server_selection_timeout_ms INTEGER NOT NULL DEFAULT 30000,
  read_preference            TEXT NOT NULL DEFAULT 'primary',
  max_pool_size              INTEGER NOT NULL DEFAULT 100,
  direct_connection          INTEGER NOT NULL DEFAULT 0,
  app_name                   TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  last_used_at               TEXT
);
CREATE INDEX idx_connections_last_used ON connections(last_used_at DESC);

-- Per-connection secret blobs (encrypted by F03)
CREATE TABLE connection_secrets (
  connection_id TEXT NOT NULL,
  field         TEXT NOT NULL,      -- e.g., 'password', 'ssh_password', 'ssh_passphrase'
  ciphertext    BLOB NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (connection_id, field),
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);

-- Saved queries (Find / Aggregation / Script) --------------------

CREATE TABLE saved_queries (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  db_name       TEXT NOT NULL,
  collection    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('find','aggregation','script')),
  name          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,       -- JSON: builder state, pipeline stages, script body
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE INDEX idx_saved_by_target ON saved_queries(connection_id, db_name, collection);

-- Recent queries (ring buffer, capped per connection) ------------

CREATE TABLE recent_queries (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL,
  db_name        TEXT NOT NULL,
  collection     TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK(kind IN ('find','aggregation')),
  payload_json   TEXT NOT NULL,
  ran_at         TEXT NOT NULL,
  duration_ms    INTEGER NOT NULL,
  result_count   INTEGER,
  error_code     TEXT,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE INDEX idx_recent_by_conn_time ON recent_queries(connection_id, ran_at DESC);

-- Workspace tabs (session restore) --------------------------------

CREATE TABLE workspace_tabs (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK(kind IN ('collection','aggregation')),
  db_name         TEXT NOT NULL,
  collection      TEXT NOT NULL,
  state_json      TEXT NOT NULL,      -- builder state, view mode, preview fields, pipeline draft
  position        INTEGER NOT NULL,   -- ordering within the tab strip
  is_active       INTEGER NOT NULL DEFAULT 0,
  opened_at       TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE INDEX idx_tabs_position ON workspace_tabs(position);

-- Per-collection preview-field preferences ------------------------

CREATE TABLE preview_fields (
  connection_id TEXT NOT NULL,
  db_name       TEXT NOT NULL,
  collection    TEXT NOT NULL,
  fields_json   TEXT NOT NULL,      -- JSON array of field names
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (connection_id, db_name, collection),
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);

-- Global app state (kv store) -------------------------------------

CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

UPDATE schema_version SET version = 1;
```

### 3.1 Encrypted columns and the column key (migration 016, [X21](./X21-encryption-at-rest.md))

Five columns hold values that came out of the user's MongoDB data and are stored as sealed BLOBs in their existing TEXT-affinity columns: `recent_queries.payload_json`, `recent_field_values.value`, `audit_log.summary_json`, `saved_queries.payload_json`, `workspace_tabs.state_json`. The repositories seal on write and open on read through `ColumnCipher` (`electron/db/columnCipher.ts`); their row types keep `string`. A TEXT cell in those columns is plaintext written before X21 and is sealed once by `encryptLegacyRows` on the next boot. Schema names (`db_name`, `collection`, `field`, reference rules, schema paths inside tab state) stay plaintext: they are SQL predicates.

```sql
CREATE TABLE column_keys (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  wrapped      BLOB NOT NULL,              -- safeStorage ciphertext of base64(enc || mac), or the raw 64 bytes
  is_plaintext INTEGER NOT NULL DEFAULT 0, -- 1 when no usable keychain existed; re-wrapped once one appears
  created_at   TEXT NOT NULL
);

-- Rebuilt by 016 (the 30-day cache is dropped, not converted):
CREATE TABLE recent_field_values (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  db_name TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,
  value BLOB NOT NULL,          -- sealed, padded to a 32-byte multiple
  value_mac TEXT NOT NULL,      -- HMAC of the value scoped to (connection, db, collection, field)
  val_type TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX recent_field_values_uniq ON recent_field_values(value_mac);
CREATE INDEX recent_field_values_lookup
  ON recent_field_values(connection_id, db_name, collection, field, last_used_at DESC);
```

A migration that only reshapes these tables (add, drop or rename a column; a rebuild that copies the column verbatim under the same table name) is unaffected. A migration that changes the content of an encrypted column cannot be written in SQL; it needs a post-open data step with the key (X21 §8).

## 4. Base repository pattern

- All repos receive the `Database` handle in their constructor.
- All queries use **prepared statements cached on the repo instance** (perf + correctness — `better-sqlite3` prepares lazily but caching avoids parse overhead).
- All mutating methods return the primary key or row count, never the whole row (caller re-reads if it needs the row).
- Row ↔ object mapping is explicit: `rowToX(row: Row): X`. No ORM, no magic.

```ts
// electron/db/repositories/ConnectionRepo.ts (excerpt — full surface in C02)
export class ConnectionRepo {
  constructor(private db: Database) {
    this.insertStmt  = db.prepare(`INSERT INTO connections (…) VALUES (…)`);
    this.selectStmt  = db.prepare(`SELECT * FROM connections WHERE id = ?`);
    // …
  }
  insert(c: ConnectionRow): void { this.insertStmt.run(c); }
  findById(id: string): Connection | null { /* … */ }
  // …
}
```

## 5. Transactions

Expose a `withTransaction<T>(fn: () => T): T` helper on `sqlite.ts`:

```ts
export function withTransaction<T>(db: Database, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx();
}
```

Repositories MAY nest transactions safely (`better-sqlite3` uses savepoints).

## 6. Error handling

- `SQLITE_CONSTRAINT` → `ConflictError` (mapped to IPC error code `CONFLICT`).
- `SQLITE_BUSY` → `SystemError` with code `DB_BUSY`. Busy timeout of 5s should make this rare.
- Any other failure → `SystemError` with code `DB_ERROR` and the original message in `details`.

## 7. Backup & reset (dev niceties, not iteration-1 UI)

- `sqlite.ts` exposes `exportToFile(path)` which runs `VACUUM INTO path`. Not wired to UI in iteration 1 but used by tests.
- Deleting the DB file and restarting is a supported reset path; document this in README.

## 8. Acceptance criteria

- App starts with no DB present and creates one at the correct path.
- Migration runner is idempotent: running twice in a row leaves `schema_version.version` unchanged.
- Re-running the app reads the existing DB without running migrations again.
- Foreign-key cascades: deleting a connection removes its `connection_secrets`, `saved_queries`, `recent_queries`, `workspace_tabs`, `preview_fields`.
- `PRAGMA foreign_keys` is confirmed `= 1` after open.

## 9. Test cases

### Unit (Vitest)
- **migration-runner.spec.ts**
  - Applies 001 from an empty DB → `schema_version.version === 1`.
  - Idempotent re-run does not throw and does not change version.
  - If a migration SQL contains a syntax error, `runMigrations` throws and `schema_version.version` is unchanged (rollback).

### Integration (Vitest + temp file)
- **sqlite-bootstrap.spec.ts**
  - Creates DB at a temp path, closes, reopens: tables exist.
  - WAL mode active (`PRAGMA journal_mode` returns `wal`).
  - Foreign keys active.
  - `PRAGMA secure_delete` returns `1`.
  - `withTransaction` commits on success, rolls back on throw.
- **cascade.spec.ts**
  - Insert a connection + secret + saved query + recent + tab + preview_fields.
  - Delete connection.
  - Assert all dependent rows gone.
