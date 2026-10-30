import type { Database } from 'better-sqlite3';
import type { SavedKind } from '@shared/types';
import { ConflictError, NotFoundError } from '../../errors.ts';
import { isUniqueConstraintError, rethrowMissingConnection } from '../sqliteErrors.ts';
import type { ColumnCipher } from '../columnCipher.ts';
import { openListedCell } from './listedCell.ts';
import type { Logger } from '../../log.ts';

export interface SavedQueryRow {
  id: string;
  connection_id: string;
  db_name: string;
  collection: string;
  kind: SavedKind;
  name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

/** `payload_json` as SQLite returns it: a sealed BLOB, or text from before encryption. */
type StoredRow = Omit<SavedQueryRow, 'payload_json'> & { payload_json: string | Buffer };

export interface SavedQueryFilter {
  connectionId?: string;
  dbName?: string;
  collection?: string;
  kind?: SavedKind;
}

export interface SavedQueryPatch {
  name?: string;
  payload_json?: string;
  updated_at: string;
}

export class SavedQueryRepo {
  private db: Database;
  private cipher: ColumnCipher;
  private log?: Pick<Logger, 'warn'>;

  constructor(db: Database, cipher: ColumnCipher, log?: Pick<Logger, 'warn'>) {
    this.db = db;
    this.cipher = cipher;
    this.log = log;
  }

  private seal(id: string, payloadJson: string): Buffer {
    return this.cipher.seal('saved_queries', 'payload_json', id, payloadJson);
  }

  private opened(row: StoredRow): SavedQueryRow {
    return { ...row, payload_json: this.cipher.open('saved_queries', 'payload_json', row.id, row.payload_json) };
  }

  insert(row: SavedQueryRow): void {
    try {
      this.db.prepare(`
        INSERT INTO saved_queries
          (id, connection_id, db_name, collection, kind, name, payload_json, created_at, updated_at)
        VALUES
          (@id, @connection_id, @db_name, @collection, @kind, @name, @payload_json, @created_at, @updated_at)
      `).run({ ...row, payload_json: this.seal(row.id, row.payload_json) });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(`saved query name '${row.name}' already exists`, { field: 'name' });
      }
      rethrowMissingConnection(err, row.connection_id);
    }
  }

  update(id: string, patch: SavedQueryPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (patch.name !== undefined) {
      sets.push('name = @name');
      params.name = patch.name;
    }
    if (patch.payload_json !== undefined) {
      sets.push('payload_json = @payload_json');
      params.payload_json = this.seal(id, patch.payload_json);
    }
    sets.push('updated_at = @updated_at');
    params.updated_at = patch.updated_at;

    try {
      const info = this.db.prepare(`UPDATE saved_queries SET ${sets.join(', ')} WHERE id = @id`).run(params);
      if (info.changes === 0) throw new NotFoundError(`saved query ${id} not found`);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(`saved query name '${String(patch.name)}' already exists`, { field: 'name' });
      }
      throw err;
    }
  }

  findById(id: string): SavedQueryRow | null {
    const row = this.db.prepare('SELECT * FROM saved_queries WHERE id = ?').get(id) as StoredRow | undefined;
    return row ? this.opened(row) : null;
  }

  list(filter: SavedQueryFilter = {}): SavedQueryRow[] {
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
    const rows = this.db.prepare(`SELECT * FROM saved_queries ${where} ORDER BY updated_at DESC`).all(...params) as StoredRow[];
    // An unreadable payload lists as '', which the service already reads as
    // "no payload" for a corrupted row.
    return rows.map((r) => ({
      ...r,
      payload_json: openListedCell(this.cipher, this.log, 'saved_queries', 'payload_json', r.id, r.payload_json) ?? '',
    }));
  }

  deleteById(id: string): number {
    const info = this.db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id);
    return info.changes;
  }
}
