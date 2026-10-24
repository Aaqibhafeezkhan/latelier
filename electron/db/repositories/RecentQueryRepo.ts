import type { Database, Statement } from 'better-sqlite3';
import type { RecentKind } from '@shared/types';
import { rethrowMissingConnection } from '../sqliteErrors.ts';

export interface RecentQueryRow {
  id: string;
  connection_id: string;
  db_name: string;
  collection: string;
  kind: RecentKind;
  payload_json: string;
  ran_at: string;
  duration_ms: number;
  result_count: number | null;
  error_code: string | null;
}

export interface RecentQueryFilter {
  connectionId?: string;
  dbName?: string;
  collection?: string;
  kind?: RecentKind;
  limit?: number;
}

/**
 * every field here closes an over-delete. `connectionId` + `collection`
 * alone were not enough to express what the Recent tab actually shows:
 *
 *   - `id` — per-row delete. Cheaper than a `recent:delete` channel (shared
 *     type + zod schema + repo, no new registration).
 *   - `dbName` — without it, clearing `orders` on a connection wipes
 *     `shop.orders` *and* `analytics.orders`. Silent, and there is no undo.
 *   - `kind` — the tab lists `kind: 'find'` only, so clearing without it also
 *     wipes aggregation history the user never saw and did not ask to lose.
 *
 * An empty filter still deletes everything; that is the intentional clear-all.
 */
export interface RecentDeleteFilter {
  id?: string;
  connectionId?: string;
  dbName?: string;
  collection?: string;
  kind?: RecentKind;
}

export class RecentQueryRepo {
  private db: Database;
  private insertStmt: Statement;
  private findByIdStmt: Statement<[string]>;
  private countByConnectionStmt: Statement<[string]>;
  private deleteOldestStmt: Statement<[string, string, number]>;
  private deleteOlderThanStmt: Statement<[number]>;

  // Every `ORDER BY ran_at DESC` here ends in `rowid DESC`: runs recorded in
  // the same millisecond share `ran_at`, and without a tiebreaker their
  // order (and which of them eviction keeps) depends on the query plan. The
  // later insert, with the higher rowid, counts as newer.
  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO recent_queries
        (id, connection_id, db_name, collection, kind, payload_json, ran_at, duration_ms, result_count, error_code)
      VALUES
        (@id, @connection_id, @db_name, @collection, @kind, @payload_json, @ran_at, @duration_ms, @result_count, @error_code)
    `);
    this.findByIdStmt = db.prepare('SELECT * FROM recent_queries WHERE id = ?');
    this.countByConnectionStmt = db.prepare(
      'SELECT COUNT(*) as cnt FROM recent_queries WHERE connection_id = ?',
    );
    this.deleteOldestStmt = db.prepare(`
      DELETE FROM recent_queries
      WHERE connection_id = ?
        AND id NOT IN (
          SELECT id FROM recent_queries
          WHERE connection_id = ?
          ORDER BY ran_at DESC, rowid DESC
          LIMIT ?
        )
    `);
    // `ran_at` is written as ISO-8601 (`new Date().toISOString()`) which has a
    // `T` separator and `Z` suffix. SQLite's `datetime('now', '-N days')` emits
    // `YYYY-MM-DD HH:MM:SS` (space separator, no suffix). A naive lexicographic
    // `ran_at < datetime(...)` compares `T` (0x54) against space (0x20), which
    // never holds for production rows. Use `julianday(...)` so the comparison
    // happens on numeric time values, not on textual representations.
    this.deleteOlderThanStmt = db.prepare(
      "DELETE FROM recent_queries WHERE julianday(ran_at) < julianday('now', '-' || ? || ' days')",
    );
  }

  /** Delete recent-query rows older than `days` days. Returns the rows affected. */
  deleteOlderThan(days: number): number {
    return this.deleteOlderThanStmt.run(days).changes;
  }

  insert(row: RecentQueryRow): void {
    try {
      this.insertStmt.run(row);
    } catch (err) {
      rethrowMissingConnection(err, row.connection_id);
    }
  }

  findById(id: string): RecentQueryRow | null {
    const row = this.findByIdStmt.get(id) as RecentQueryRow | undefined;
    return row ?? null;
  }

  list(filter: RecentQueryFilter = {}): RecentQueryRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.connectionId !== undefined) {
      conditions.push('connection_id = ?');
      params.push(filter.connectionId);
    }
    if (filter.dbName !== undefined) {
      conditions.push('db_name = ?');
      params.push(filter.dbName);
    }
    if (filter.collection !== undefined) {
      conditions.push('collection = ?');
      params.push(filter.collection);
    }
    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter.limit !== undefined ? `LIMIT ${filter.limit}` : '';
    return this.db.prepare(
      `SELECT * FROM recent_queries ${where} ORDER BY ran_at DESC, rowid DESC ${limitClause}`
    ).all(...params) as RecentQueryRow[];
  }

  deleteByFilter(filter: RecentDeleteFilter): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.id !== undefined) {
      conditions.push('id = ?');
      params.push(filter.id);
    }
    if (filter.connectionId !== undefined) {
      conditions.push('connection_id = ?');
      params.push(filter.connectionId);
    }
    if (filter.dbName !== undefined) {
      conditions.push('db_name = ?');
      params.push(filter.dbName);
    }
    if (filter.collection !== undefined) {
      conditions.push('collection = ?');
      params.push(filter.collection);
    }
    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const info = this.db.prepare(`DELETE FROM recent_queries ${where}`).run(...params);
    return info.changes;
  }

  countByConnection(connectionId: string): number {
    const row = this.countByConnectionStmt.get(connectionId) as { cnt: number };
    return row.cnt;
  }

  deleteOldestByConnection(connectionId: string, keepCount: number): void {
    this.deleteOldestStmt.run(connectionId, connectionId, keepCount);
  }
}
