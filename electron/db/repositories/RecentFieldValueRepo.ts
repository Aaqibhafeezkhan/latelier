import type { Database, Statement } from 'better-sqlite3';
import type { ValType } from '@shared/types';
import { rethrowMissingConnection } from '../sqliteErrors.ts';
import type { ColumnCipher } from '../columnCipher.ts';
import { openListedCell } from './listedCell.ts';
import type { Logger } from '../../log.ts';

export interface RecentFieldValueRow {
  id: string;
  connection_id: string;
  db_name: string;
  collection: string;
  field: string;
  value: string;
  val_type: ValType;
  last_used_at: string;
  use_count: number;
}

export interface RecentFieldValueUpsert {
  id: string;
  connectionId: string;
  dbName: string;
  collection: string;
  field: string;
  value: string;
  valType: ValType;
  lastUsedAt: string;
}

export interface RecentFieldValueQuery {
  connectionId: string;
  dbName: string;
  collection: string;
  field: string;
  limit?: number;
}

export interface RecentFieldValueEvict {
  connectionId: string;
  dbName: string;
  collection: string;
  field: string;
  keep: number;
}

const DEFAULT_LIST_LIMIT = 20;

/** The columns `list` reads; `value` is the sealed BLOB. `value_mac` stays in SQL. */
type StoredRow = Omit<RecentFieldValueRow, 'value'> & { value: Buffer | string };

export class RecentFieldValueRepo {
  private db: Database;
  private cipher: ColumnCipher;
  private log?: Pick<Logger, 'warn'>;
  private upsertStmt: Statement;
  private listStmt: Statement<[string, string, string, string, number]>;
  private evictStmt: Statement<[string, string, string, string, string, string, string, string, number]>;
  private deleteByConnectionStmt: Statement<[string]>;
  private clearAllStmt: Statement;
  private deleteOlderThanStmt: Statement<[number]>;

  constructor(db: Database, cipher: ColumnCipher, log?: Pick<Logger, 'warn'>) {
    this.db = db;
    this.cipher = cipher;
    this.log = log;
    // `id` is inert on the UPDATE branch — a conflict keeps the row's
    // original id and only bumps use_count/last_used_at/val_type. `value`
    // is never rewritten on conflict either, so a stored cell stays bound to
    // the id it was sealed with. `value_mac` is the keyed hash of the value
    // within its (connection, db, collection, field) scope: the ciphertext
    // carries a random nonce, so equality has to be decided on the hash.
    this.upsertStmt = db.prepare(`
      INSERT INTO recent_field_values
        (id, connection_id, db_name, collection, field, value, value_mac, val_type, last_used_at, use_count)
      VALUES
        (@id, @connection_id, @db_name, @collection, @field, @value, @value_mac, @val_type, @last_used_at, 1)
      ON CONFLICT(value_mac)
      DO UPDATE SET
        last_used_at = excluded.last_used_at,
        val_type = excluded.val_type,
        use_count = use_count + 1
    `);
    this.listStmt = db.prepare(`
      SELECT id, connection_id, db_name, collection, field, value, val_type, last_used_at, use_count
      FROM recent_field_values
      WHERE connection_id = ? AND db_name = ? AND collection = ? AND field = ?
      ORDER BY last_used_at DESC
      LIMIT ?
    `);
    this.evictStmt = db.prepare(`
      DELETE FROM recent_field_values
      WHERE connection_id = ? AND db_name = ? AND collection = ? AND field = ?
        AND id NOT IN (
          SELECT id FROM recent_field_values
          WHERE connection_id = ? AND db_name = ? AND collection = ? AND field = ?
          ORDER BY last_used_at DESC
          LIMIT ?
        )
    `);
    this.deleteByConnectionStmt = db.prepare('DELETE FROM recent_field_values WHERE connection_id = ?');
    this.clearAllStmt = db.prepare('DELETE FROM recent_field_values');
    // `last_used_at` is written as ISO-8601 (`new Date().toISOString()`) which has a
    // `T` separator and `Z` suffix. SQLite's `datetime('now', '-N days')` emits
    // `YYYY-MM-DD HH:MM:SS` (space separator, no suffix). A naive lexicographic
    // `last_used_at < datetime(...)` compares `T` (0x54) against space (0x20), which
    // never holds for production rows. Use `julianday(...)` so the comparison
    // happens on numeric time values, not on textual representations.
    this.deleteOlderThanStmt = db.prepare(
      "DELETE FROM recent_field_values WHERE julianday(last_used_at) < julianday('now', '-' || ? || ' days')",
    );
  }

  /** Runs `fn` inside a SQLite transaction, committing on return and rolling back on throw. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  upsert(row: RecentFieldValueUpsert): void {
    try {
      this.upsertStmt.run({
        id: row.id,
        connection_id: row.connectionId,
        db_name: row.dbName,
        collection: row.collection,
        field: row.field,
        value: this.cipher.seal('recent_field_values', 'value', row.id, row.value),
        value_mac: this.cipher.blind([row.connectionId, row.dbName, row.collection, row.field], row.value),
        val_type: row.valType,
        last_used_at: row.lastUsedAt,
      });
    } catch (err) {
      rethrowMissingConnection(err, row.connectionId);
    }
  }

  list(q: RecentFieldValueQuery): RecentFieldValueRow[] {
    const rows = this.listStmt.all(
      q.connectionId,
      q.dbName,
      q.collection,
      q.field,
      q.limit ?? DEFAULT_LIST_LIMIT,
    ) as StoredRow[];
    // Skipped: an empty suggestion would be offered as a real value.
    return rows.flatMap((r) => {
      const value = openListedCell(this.cipher, this.log, 'recent_field_values', 'value', r.id, r.value);
      return value === null ? [] : [{ ...r, value }];
    });
  }

  /** Trims a `(conn, db, coll, field)` bucket to its `keep` most-recent rows. */
  evictOldest(q: RecentFieldValueEvict): void {
    this.evictStmt.run(
      q.connectionId,
      q.dbName,
      q.collection,
      q.field,
      q.connectionId,
      q.dbName,
      q.collection,
      q.field,
      q.keep,
    );
  }

  /** Delete recent-field-value rows older than `days` days. Returns the rows affected. */
  deleteOlderThan(days: number): number {
    return this.deleteOlderThanStmt.run(days).changes;
  }

  /** Mirrors other repos' cascade-parity helper — FK handles this too. */
  deleteByConnection(connectionId: string): number {
    return this.deleteByConnectionStmt.run(connectionId).changes;
  }

  /** Full wipe — Settings' "Clear value history" action. */
  clearAll(): number {
    return this.clearAllStmt.run().changes;
  }
}
