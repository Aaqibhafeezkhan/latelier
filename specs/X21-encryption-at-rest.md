# X21 — Encryption at rest for Mongo-derived values

> **Status: Implemented.**

## Purpose

`latelier.db` is owner-only (`0600`), zeroes freed pages (`secure_delete`) and never stores result documents (migration 014) or undo pre-images (migration 015). It still holds values that came out of the user's MongoDB data in plaintext: filter literals in recent and saved queries, the value-suggestion cache, audit-log filters, tab state with script source and schema min/max. Anyone holding the file, its WAL, or an OS backup of them (Time Machine, Windows File History, a copied `userData` folder) can read those values without ever touching the Mongo server.

X21 encrypts those values at the repository boundary, with a key wrapped by the OS keychain through the same `safeStorage` gate the secrets vault uses. The SQLite driver stays `better-sqlite3`; no new dependency.

## Threat model

**In:** someone who has `latelier.db`, `-wal`, `-shm`, or a backup of them taken after the upgrade, and is not running as the user on that machine. After X21, the Mongo-derived values in those files are unreadable to them.

**Out — stated in the UI and `SECURITY.md`, never oversold:**

- **Same-user code.** Any process running as the user can ask the keychain for the key: DPAPI on Windows decrypts for the whole user session, an unlocked libsecret/KWallet answers any caller, and a macOS Keychain grant follows the user's Allow. The column key is exactly as exposed as the connection passwords already in `connection_secrets`.
- **Backups taken before the upgrade.** They keep their plaintext; nothing in-app reaches them.
- **Schema names.** `db_name`, `collection`, `field`, `reference_rules` and `schema.entries[].path` stay plaintext. They are SQL predicates on every lookup; protecting them means encrypting the whole file (§9).
- **Linux hosts without a usable keychain** (§5): the key is stored unprotected, so the data is obfuscated, not protected.

## Scope

### In

| Table.column | Content | Retention |
| --- | --- | --- |
| `recent_queries.payload_json` | filter / pipeline literals | 30-day sweep |
| `recent_field_values.value` | typed or selected literal | 30-day sweep, 50 per field |
| `audit_log.summary_json` | update/delete `filter`, import `fileName`, rename from/to | 90-day sweep |
| `saved_queries.payload_json` | filter, pipeline, script source | until deleted |
| `workspace_tabs.state_json` | builder tree, filter text, stages, script source, `schema.entries[].numeric` | until the tab closes |

Every repository in `electron/db/repositories/` and every `app_state` key was checked: nothing else holds Mongo-derived values. `app_state` holds UI preferences only; `connections` holds user configuration, not Mongo data; `connection_secrets` is already `safeStorage` ciphertext and is unchanged.

### Out — deliberately

- Whole-file encryption and a driver swap (§9).
- Key rotation. The cell format carries a version byte (§1) so a later spec can add it.
- Protecting against same-user code (see Threat model).

## Dependencies

- [F02](./F02-sqlite-persistence.md) — schema, migrations, `secure_delete`, the post-migration VACUUM and WAL truncate. Its schema section gains `column_keys` and the rebuilt `recent_field_values`.
- The secrets vault (`electron/secrets/SecretsVault.ts`, `electron/secrets/keychainAvailability.ts`) — key wrapping goes through `vaultSafeStorage()`, so the Linux weak-backend rule applies unchanged.
- [X13](./X13-operation-audit-log.md) — `audit_log.summary_json` shape.

## 1. Cell format

An encrypted cell is a BLOB stored in the existing TEXT-affinity column. SQLite keeps a BLOB as-is in a TEXT column and `better-sqlite3` returns it as a `Buffer`, so a legacy row reads back as `string` and an encrypted one as `Buffer`. The JS type is the legacy marker; no extra column.

```
byte 0       format version, 0x01
bytes 1..12  nonce, crypto.randomBytes(12)
bytes 13..   AES-256-GCM ciphertext of the UTF-8 text
last 16      GCM auth tag
```

**AAD** is `${table}.${column}:${id}` in UTF-8. A cell moved to another row, column or table fails authentication. This gives confidentiality plus swap detection for sealed cells, not integrity against a downgrade: someone who can write the file can replace a sealed cell with TEXT, which `open` reads as legacy plaintext. Only `recent_field_values.value`, which 016 rebuilt empty and so never held legacy text, refuses TEXT cells. All five tables have a UUID `id` primary key. `recent_field_values`' upsert never rewrites `value` on conflict, so a cell stays bound to the id it was sealed with.

**Nonce** is random per write. The NIST SP 800-38D bound of 2^32 messages per key is far above this database's lifetime write count; no counter is persisted.

**Length** leaks: ciphertext is plaintext + 29 bytes. `recent_field_values.value` is padded to a 32-byte multiple before sealing so short literals do not reveal their length; the other columns hold JSON whose length is low-value and is not padded. The padding is on the UTF-8 bytes: a `0x80` marker, then zeros to the next multiple (a full extra block when already aligned), so every value round-trips exactly. The cipher decides which columns are padded from the table and column name, so a repository cannot pad on write and forget to strip on read.

## 2. `ColumnCipher` — `electron/db/columnCipher.ts`

Pure `node:crypto`, no I/O. Goes into `stryker.config.json`'s `mutate` array.

```ts
export interface ColumnKeys { enc: Buffer; mac: Buffer } // 32 bytes each

export class ColumnCipher {
  constructor(keys: ColumnKeys);
  seal(table: string, column: string, id: string, plaintext: string): Buffer;
  /** A string is a legacy plaintext cell and is returned as-is. */
  open(table: string, column: string, id: string, cell: string | Buffer): string;
  /** HMAC-SHA256(mac, scope.join('\0') + '\0' + value), base64url. */
  blind(scope: readonly string[], value: string): string;
  static generate(): ColumnKeys;
}
```

`open` throws `SystemError('COLUMN_DECRYPT_FAILED')` on an unknown version byte or a failed tag, never returns partial plaintext.

A list read must not fail because one cell does not open, so the repositories catch `COLUMN_DECRYPT_FAILED` per row, log a `warn` naming only the table, column and id (never the cell), and hand the services something they already handle. Recent queries, the audit log and value suggestions skip the row: their services parse every cell and have no fallback, and an empty suggestion would be offered as a real value. Saved queries list the row with an empty payload, which the service already reads as "no payload". Workspace tabs read an unreadable state as `''` on every read, single-row ones included, so the tab opens with its default state and stays closable, pinnable and updatable; the next update re-seals the cell and heals it. Every other single-row read still throws `COLUMN_DECRYPT_FAILED`.

## 3. Key storage

### 3.1 Migration 016

```sql
CREATE TABLE column_keys (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  wrapped      BLOB NOT NULL,
  is_plaintext INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
```

`wrapped` is `safeStorage.encryptString(base64(enc || mac))`, or the raw 64 bytes when `is_plaintext = 1` (same meaning as `connection_secrets.is_plaintext`).

The keys live in the database rather than in `app_state` or a side file:

- `AppStateRepo.get` turns an unparseable value into `null`, which would read as "no key yet" and silently generate a new one, orphaning every encrypted cell.
- A side file would break the "move these three files" recovery text in `main.ts`.
- The database alone is still useless without the keychain, which is the property wanted.

### 3.2 `loadOrCreateColumnKeys` — `electron/db/columnKeyStore.ts`

Modelled on `SecretsVault.set`/`get`:

| State | Result |
| --- | --- |
| row, `is_plaintext = 0` | `safeStorage.decryptString(wrapped)`; a throw becomes `SystemError('COLUMN_KEY_UNREADABLE')` (§6). Never regenerates. |
| row, `is_plaintext = 1`, keychain now available | re-wrap, set `is_plaintext = 0`, then use |
| row, `is_plaintext = 1`, keychain unavailable | raw bytes |
| no row | `ColumnCipher.generate()`; wrap if the keychain is available, else store raw with `is_plaintext = 1` (§5) |

A keychain that reports available but throws on `encryptString` (macOS Deny at the first prompt) is treated as unavailable in both wrap paths: the key is stored or kept raw with `is_plaintext = 1` and a `warn`, never a failed boot.

## 4. Wiring

- `main.ts`, right after the vault is built: load the keys, build the `ColumnCipher`, run `encryptLegacyRows` (§7), then construct the five repos with the cipher injected.
- Repos seal on write and open on read. Row types keep `string` fields, so services, handlers and IPC are unchanged; no channel is added.
- `RecentFieldValueRepo.upsert` writes `value_mac = cipher.blind([connectionId, dbName, collection, field], value)`.
- `DiagnosticService.secretsStatus` gains `columnKeyProtected: boolean`, which goes into the exported diagnostic bundle. Settings had no keychain line and no channel that reported one, so a read-only, input-free `secrets:status` channel (`{ columnKeyProtected }`) feeds a new "Local data protection" row in Settings. The `ipc-channel-auditor` agent runs for it.
- The dev database-reset path in `main.ts` empties the live database instead of deleting its files (`resetDatabaseInPlace`: one transaction deleting `connections`, which cascades to every per-connection table, and `app_state`; then the owed VACUUM), keeps `column_keys` so the live cipher stays valid, clears `AppStateService`'s cache, disposes the mongosh shell sessions of the deleted connections (`ShellService.disposeAll`), disconnects the pool and reloads the window. Reopening the file had left every service, the vault and the cipher on a closed handle, and a relaunch cannot come back under the Vite dev server.
- `tests/helpers/db.ts` gains `createTempCipher()` with fixed keys; integration specs construct repos with it.

## 5. Linux without a keychain

`vaultSafeStorage()` already reports `basic_text` / `unknown` backends as unavailable. The vault refuses to save a password there unless `secrets.allowPlaintextFallback` is on. Columns cannot refuse — tabs and saved queries must persist — so the key is stored with `is_plaintext = 1` whatever the preference, with a `warn` log. Settings says the key is stored unprotected and does not call the data encrypted. When a keychain appears later, the next boot re-wraps (§3.2).

## 6. Key loss

When the wrapped key cannot be decrypted at boot (Keychain reset, macOS Deny at the prompt, Windows `Local State` deleted or profile migrated, Linux keyring password changed), every encrypted cell is unreadable. The app does not regenerate the key silently. It shows a boot dialog modelled on "Could not open the database":

- **Quit** (default). The user can restore the keychain item, or relaunch and click Allow.
- **Reset protected data.** One transaction deletes all rows from `recent_queries`, `recent_field_values`, `audit_log`, `saved_queries`, `workspace_tabs` and `column_keys`; then VACUUM, WAL truncate, and a fresh key. Connections stay; their passwords follow the vault's existing per-secret handling.

The dialog tells "keychain not reachable right now" from "key gone" by `isEncryptionAvailable()` alone, never by Electron's error text (`columnKeyDialogCopy` in `electron/db/columnKeyStore.ts`). Unavailable means unreachable on every platform: a denied macOS prompt lasts until relaunch, and a Linux keyring that is locked, missing from an SSH or X-forwarded session, behind a dead D-Bus, or overridden by `--password-store=basic` — or a Windows profile problem — fixes itself. That copy says to quit and start again from the normal desktop session (on macOS: relaunch and click Always Allow) and offers Reset only "if the keychain is gone for good". An available keychain whose decrypt throws is "key gone": the item was removed or reset, the profile moved, or the keyring password changed. Quit stays the default in both.

## 7. Encrypting existing rows

The migration runner cannot do it: a `.sql` file has no key, and a JS hook inside `runMigrations` would run before the keychain gate. Instead, an idempotent post-open step:

```
encryptLegacyRows(db, cipher, log):
  one transaction, for each (table, column) in the four kept tables:
    SELECT id, <column> FROM <table> WHERE typeof(<column>) = 'text'
    UPDATE <table> SET <column> = seal(...) WHERE id = ?
  if any row was converted: VACUUM, then wal_checkpoint(TRUNCATE)
```

Migration 016 drops and recreates `recent_field_values` with `value BLOB` and `value_mac TEXT` carrying the UNIQUE index in place of `value`. The index is on `value_mac` alone: the blind index is already scoped to (connection, db, collection, field), and the upsert conflicts on it. It is a 30-day suggestion cache; wiping it is cheaper than a two-phase rebuild, and the release notes say so.

The step's own VACUUM is required. Rows written before `secure_delete` was turned on leave stale plaintext copies in page slack and on freelist pages that an UPDATE plus checkpoint does not reach; only VACUUM removes them. The VACUUM in `openDatabase` runs during migration 016, before this step, so it does not help.

A VACUUM can fail (it needs free disk about the size of the database) after the work it cleans up has committed. So an `app_state` marker (`db.vacuumPending`) is written by the conversion, by "Reset protected data" and by the in-place dev reset, each in the same transaction as its work, and by `openDatabase` when its post-migration VACUUM fails (with a logger, a failure to write that marker is itself only a warning, so the boot still goes on); the step runs the VACUUM whenever rows were converted or the marker is set, and clears the marker only after a VACUUM succeeds. `app_state` holds it because main keeps its own maintenance state there, it survives the reset (which empties `column_keys`), and the renderer cannot read or write it.

`sqlite.ts` sets `PRAGMA temp_store = MEMORY` before any VACUUM. Otherwise the post-migration VACUUM copies the still-plaintext tables into a temp file on disk.

The WAL truncate sets the file length to 0 without zeroing the freed blocks; a filesystem snapshot taken in that boot-time window keeps them. This cannot be closed in-app.

## 8. Future migrations

- **Schema-only changes** (add, drop or rename a column; a table rebuild that copies the column verbatim and ends with the original table name) are unaffected: the BLOB copies through.
- **Content changes** (a 014-style `json_remove`, renaming a key inside the JSON) cannot be written in SQL any more. They go into a versioned post-open data step next to `encryptLegacyRows`, in a small registry `electron/db/dataSteps.ts` of `{ version, run(db, cipher) }` keyed on an `app_state` marker, with the same sequence check as `assertMigrationSequence`.
- **Permanently renaming a table** invalidates the AAD and must re-seal its cells through a data step.

## 9. Alternatives considered

- **Whole-file encryption** (`better-sqlite3-multiple-ciphers`, SQLite3MultipleCiphers). Stronger: it also covers schema names and every page of the WAL. Rejected because it swaps the only native module, which the repo keeps rebuild-free. It is the answer if schema names are later judged sensitive.
- **`safeStorage.encryptString` per cell.** Smaller diff, but no AAD (cells swap between rows undetected), a format Electron owns, and `recent_field_values` still needs a key for its blind index — so a wrapped key is needed anyway.
- **Store less.** Making `recent_field_values` opt-in, hashing the audit filter and keeping `schema.entries[].numeric` in memory shrink the surface, but cannot cover saved queries and tab script source, which the user expects back. Complements X21; does not replace it.

## 10. Decided

1. **Saved queries on key reset** are deleted with the rest: an undecryptable saved query is noise.
2. **Unreachable vs gone** is decided by `isEncryptionAvailable()`, not by parsing Electron's error (§6).

## Acceptance criteria

- After first launch on X21, the five columns hold BLOB cells only: `SELECT typeof(col)` reports `blob` for every row.
- The raw bytes of `latelier.db` and `latelier.db-wal` contain none of the plaintext values seeded before the upgrade, including rows written while `secure_delete` was off.
- A cell copied into another row, column or table fails to decrypt with `COLUMN_DECRYPT_FAILED`.
- `recent_field_values` deduplicates on `value_mac` exactly as it did on `value`.
- An unreadable key fails boot with the §6 dialog and never generates a new key on its own.
- On a host with no usable keychain the key is stored with `is_plaintext = 1`, Settings says it is unprotected, and the next boot with a keychain re-wraps it.
- `temp_store` is `MEMORY` for every connection `openDatabase` returns.
- Services, IPC handlers and the renderer are unchanged apart from the diagnostics field and the read-only `secrets:status` channel that feeds the Settings line.
- `SECURITY.md`'s local-data section and F02's schema section describe the encrypted columns, the threat-model limits and the plaintext schema names.

## Test cases

- **unit** `tests/unit/column-cipher.spec.ts`: round trip; wrong table, column or id rejected; bit flip rejected; unknown version byte rejected; legacy string returned as-is; `blind` deterministic and scope-sensitive; `generate` yields two distinct 32-byte keys; `recent_field_values` padding.
- **property** `tests/unit/column-cipher.property.spec.ts`: `open(seal(s)) === s` for arbitrary unicode, the empty string and JSON carrying a `__proto__` key (built through `JSON.parse` or `Object.defineProperty`, never an object literal); `open` with any other id throws; ciphertext never contains the plaintext bytes; `blind(scope, a) === blind(scope, b)` iff `a === b`.
- **integration** `tests/integration/column-key-store.spec.ts`: fresh database creates a wrapped row; decrypt throws → `COLUMN_KEY_UNREADABLE`, row untouched; no keychain → `is_plaintext = 1`; keychain appears → re-wrapped.
- **integration** `tests/integration/migration-016-column-cipher.spec.ts`: a 015-shaped database with plaintext in all five tables, run through `openDatabase` and `encryptLegacyRows` → every cell is a BLOB, `recent_field_values` is empty, and `fs.readFileSync` of the database and its WAL contains none of the seeded markers. Repeated with rows inserted while `secure_delete` was off.
- **integration**, existing repo and service specs: construct repos with `createTempCipher()`; each gains one assertion that a raw `SELECT typeof(col)` is `blob` after a write.
- **mutation**: `columnCipher.ts` added to `mutate`, at or above the 90% break threshold. `columnKeyStore.ts` stays out: its logic is covered by integration specs only.
- **e2e**: no new flow; the existing suite drives every write path. One check in `x06-secrets-vault-ui.e2e.ts` for the Settings protection line.
