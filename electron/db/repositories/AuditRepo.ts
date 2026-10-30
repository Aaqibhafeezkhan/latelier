import type { Database, Statement } from 'better-sqlite3';
import type { AuditOp, AuditOutcome } from '@shared/types';
import type { ColumnCipher } from '../columnCipher.ts';
import { openListedCell } from './listedCell.ts';
import type { Logger } from '../../log.ts';

/**
 * Every column except `undo_json`, which is always NULL: Pre-images live in
 * memory (`UndoStore`), never on disk. On a listed row `reversible` is whether
 * a Pre-image was captured and not yet spent — the service then also checks it
 * is still in memory; on disk it is whether one was ever captured.
 */
export interface AuditRow {
  id: string;
  connection_id: string;
  db_name: string;
  collection: string | null;
  op: AuditOp;
  summary_json: string;
  outcome: AuditOutcome;
  error_code: string | null;
  ran_at: string;
  duration_ms: number;
  reversible: number;
  undone_at: string | null;
}

/** What `audit:undo` needs of an entry; the Pre-image itself is in `UndoStore`. */
export interface AuditUndoRow {
  connection_id: string;
  db_name: string;
  collection: string | null;
  op: AuditOp;
  reversible: number;
  undone_at: string | null;
}

export interface AuditListFilter {
  connectionId: string;
  dbName?: string;
  collection?: string;
  before?: string;
  limit: number;
}

const LISTED_COLUMNS = `id, connection_id, db_name, collection, op, summary_json, outcome,
  error_code, ran_at, duration_ms,
  (reversible = 1 AND undone_at IS NULL) AS reversible, undone_at`;

export class AuditRepo {
  private db: Database;
  private cipher: ColumnCipher;
  private log?: Pick<Logger, 'warn'>;
  private insertStmt: Statement;
  private deleteOlderThanStmt: Statement<[number]>;
  private findForUndoStmt: Statement<[string]>;
  private markUndoneStmt: Statement<[string, string]>;

  constructor(db: Database, cipher: ColumnCipher, log?: Pick<Logger, 'warn'>) {
    this.db = db;
    this.cipher = cipher;
    this.log = log;
    this.insertStmt = db.prepare(`
      INSERT INTO audit_log
        (id, connection_id, db_name, collection, op, summary_json, outcome,
         error_code, ran_at, duration_ms, reversible, undone_at)
      VALUES
        (@id, @connection_id, @db_name, @collection, @op, @summary_json, @outcome,
         @error_code, @ran_at, @duration_ms, @reversible, @undone_at)
    `);
    // julianday rather than a text comparison: `ran_at` is ISO-8601 with a `T`
    // separator, `datetime('now', ...)` is not (see RecentQueryRepo).
    this.deleteOlderThanStmt = db.prepare(
      "DELETE FROM audit_log WHERE julianday(ran_at) < julianday('now', '-' || ? || ' days')",
    );
    this.findForUndoStmt = db.prepare(
      'SELECT connection_id, db_name, collection, op, reversible, undone_at FROM audit_log WHERE id = ?',
    );
    this.markUndoneStmt = db.prepare(
      'UPDATE audit_log SET undone_at = ? WHERE id = ? AND undone_at IS NULL',
    );
  }

  insert(row: AuditRow): void {
    this.insertStmt.run({
      ...row,
      summary_json: this.cipher.seal('audit_log', 'summary_json', row.id, row.summary_json),
    });
  }

  findForUndo(id: string): AuditUndoRow | undefined {
    return this.findForUndoStmt.get(id) as AuditUndoRow | undefined;
  }

  markUndone(id: string, at: string): void {
    this.markUndoneStmt.run(at, id);
  }

  /**
   * Newest first. `before` is an exclusive `ran_at` cursor. Operations started
   * in the same millisecond fall back to rowid — the order they were recorded.
   */
  list(filter: AuditListFilter): AuditRow[] {
    const conditions = ['connection_id = ?'];
    const params: unknown[] = [filter.connectionId];
    if (filter.dbName !== undefined) {
      conditions.push('db_name = ?');
      params.push(filter.dbName);
    }
    if (filter.collection !== undefined) {
      conditions.push('collection = ?');
      params.push(filter.collection);
    }
    if (filter.before !== undefined) {
      conditions.push('ran_at < ?');
      params.push(filter.before);
    }
    const rows = this.db
      .prepare(
        `SELECT ${LISTED_COLUMNS} FROM audit_log WHERE ${conditions.join(' AND ')}
         ORDER BY ran_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, filter.limit) as Array<Omit<AuditRow, 'summary_json'> & { summary_json: string | Buffer }>;
    // Skipped: the service parses every summary and has no fallback for an empty one.
    return rows.flatMap((r) => {
      const summary = openListedCell(this.cipher, this.log, 'audit_log', 'summary_json', r.id, r.summary_json);
      return summary === null ? [] : [{ ...r, summary_json: summary }];
    });
  }

  /** Delete audit rows older than `days` days. Returns the rows affected. */
  deleteOlderThan(days: number): number {
    return this.deleteOlderThanStmt.run(days).changes;
  }
}
