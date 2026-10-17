import type { Database, Statement } from 'better-sqlite3';
import { withTransaction } from '../sqlite.ts';
import { rethrowMissingConnection } from '../sqliteErrors.ts';

// SQLite still allows the legacy 'aggregation' literal for rows that haven't
// been migrated yet. Runtime inserts use 'collection' or 'script' (W12).
type StoredTabKind = 'collection' | 'aggregation' | 'script';

/**
 * Shape of a row in the `workspace_tabs` table. Keys mirror SQL columns exactly.
 * `state_json` is a JSON blob holding the tab-specific state (CollectionTabState or
 * AggregationTabState); rehydrating happens in the service layer.
 */
export interface WorkspaceTabRow {
  id: string;
  connection_id: string;
  kind: StoredTabKind;
  db_name: string;
  collection: string;
  state_json: string;
  position: number;
  is_active: number;
  opened_at: string;
  pinned: number;
}

export class WorkspaceTabRepo {
  private db: Database;
  private insertStmt: Statement;
  private updateStateStmt: Statement<[string, string]>;
  private deleteStmt: Statement<[string]>;
  private deleteAllStmt: Statement<[]>;
  private findByIdStmt: Statement<[string]>;
  private listStmt: Statement;
  private findMatchingStmt: Statement<[string, StoredTabKind, string, string]>;
  private maxPositionStmt: Statement;
  private clearActiveStmt: Statement;
  private setActiveStmt: Statement<[string]>;
  private setPositionStmt: Statement<[number, string]>;
  private setPinnedStmt: Statement<[number, string]>;
  private retargetCollectionStmt: Statement<[string, string]>;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO workspace_tabs (
        id, connection_id, kind, db_name, collection,
        state_json, position, is_active, opened_at, pinned
      ) VALUES (
        @id, @connection_id, @kind, @db_name, @collection,
        @state_json, @position, @is_active, @opened_at, @pinned
      )
    `);
    this.updateStateStmt = db.prepare(
      'UPDATE workspace_tabs SET state_json = ? WHERE id = ?',
    );
    this.deleteStmt = db.prepare('DELETE FROM workspace_tabs WHERE id = ?');
    this.deleteAllStmt = db.prepare('DELETE FROM workspace_tabs');
    this.findByIdStmt = db.prepare('SELECT * FROM workspace_tabs WHERE id = ?');
    this.listStmt = db.prepare(
      'SELECT * FROM workspace_tabs ORDER BY pinned DESC, position ASC',
    );
    this.findMatchingStmt = db.prepare(
      `SELECT * FROM workspace_tabs
       WHERE connection_id = ? AND kind = ? AND db_name = ? AND collection = ?
       ORDER BY pinned DESC, position ASC LIMIT 1`,
    );
    this.maxPositionStmt = db.prepare(
      'SELECT COALESCE(MAX(position), -1) AS m FROM workspace_tabs',
    );
    this.clearActiveStmt = db.prepare('UPDATE workspace_tabs SET is_active = 0');
    this.setActiveStmt = db.prepare(
      'UPDATE workspace_tabs SET is_active = 1 WHERE id = ?',
    );
    this.setPositionStmt = db.prepare(
      'UPDATE workspace_tabs SET position = ? WHERE id = ?',
    );
    this.setPinnedStmt = db.prepare(
      'UPDATE workspace_tabs SET pinned = ? WHERE id = ?',
    );
    this.retargetCollectionStmt = db.prepare(
      'UPDATE workspace_tabs SET collection = ? WHERE id = ?',
    );
  }

  setPinned(id: string, pinned: boolean): void {
    this.setPinnedStmt.run(pinned ? 1 : 0, id);
  }

  /**
   * Re-point a tab's `collection` column in place (N0.5) — used when the
   * underlying Mongo collection is renamed via `renameCollection` so an
   * open tab keeps its query/filter/pagination state instead of being
   * closed and losing it. Same-database rename only: `db_name` never
   * changes (mirrors the driver's own same-DB-only `renameCollection`).
   */
  retargetCollection(id: string, newCollection: string): void {
    this.retargetCollectionStmt.run(newCollection, id);
  }

  insert(row: WorkspaceTabRow): void {
    try {
      this.insertStmt.run(row);
    } catch (err) {
      rethrowMissingConnection(err, row.connection_id);
    }
  }

  updateState(id: string, stateJson: string): void {
    this.updateStateStmt.run(stateJson, id);
  }

  deleteById(id: string): number {
    return this.deleteStmt.run(id).changes;
  }

  /** One statement, so a partial failure cannot leave some tabs behind. */
  deleteAll(): number {
    return this.deleteAllStmt.run().changes;
  }

  findById(id: string): WorkspaceTabRow | null {
    return (this.findByIdStmt.get(id) as WorkspaceTabRow | undefined) ?? null;
  }

  list(): WorkspaceTabRow[] {
    return this.listStmt.all() as WorkspaceTabRow[];
  }

  findMatching(
    connectionId: string,
    kind: StoredTabKind,
    dbName: string,
    collection: string,
  ): WorkspaceTabRow | null {
    return (
      (this.findMatchingStmt.get(connectionId, kind, dbName, collection) as
        | WorkspaceTabRow
        | undefined) ?? null
    );
  }

  nextPosition(): number {
    const row = this.maxPositionStmt.get() as { m: number };
    return row.m + 1;
  }

  /**
   * Flip is_active = 1 on exactly one row (and 0 on all others) atomically.
   */
  setActiveExclusive(id: string): void {
    withTransaction(this.db, () => {
      this.clearActiveStmt.run();
      this.setActiveStmt.run(id);
    });
  }

  clearActive(): void {
    this.clearActiveStmt.run();
  }

  /**
   * Re-order tabs to match `orderedIds`. Unknown ids are ignored; missing ids
   * keep their relative order appended after.
   */
  reorder(orderedIds: string[]): void {
    withTransaction(this.db, () => {
      const existing = this.list();
      const known = new Set(existing.map((r) => r.id));
      let pos = 0;
      for (const id of orderedIds) {
        if (known.has(id)) {
          this.setPositionStmt.run(pos, id);
          known.delete(id);
          pos++;
        }
      }
      for (const row of existing) {
        if (known.has(row.id)) {
          this.setPositionStmt.run(pos, row.id);
          pos++;
        }
      }
    });
  }
}
