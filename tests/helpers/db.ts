import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../electron/db/sqlite';
import type { Migration } from '../../electron/db/migrationRunner';
import { ColumnCipher } from '../../electron/db/columnCipher';

/**
 * Read migrations directly from disk so tests don't depend on Vite's glob.
 */
export function loadMigrationsFromDisk(): Migration[] {
  const dir = path.resolve(__dirname, '..', '..', 'electron', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  return files
    .map((name) => {
      const match = name.match(/^(\d+)-/);
      if (!match) throw new Error(`migration filename must start with digits: ${name}`);
      return {
        version: Number(match[1]),
        name,
        sql: fs.readFileSync(path.join(dir, name), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);
}

export interface TempDb {
  db: Database;
  dir: string;
  cleanup: () => void;
}

export function createTempDb(): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-db-'));
  const db = openDatabase({
    userDataDir: dir,
    migrations: loadMigrationsFromDisk(),
  });
  return {
    db,
    dir,
    cleanup: () => {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insert a `connections` row with only the columns that have no schema default (name derived from `id`, names are unique) so FK-bound tables accept rows for `id`. */
export function insertConnectionRow(db: Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connections (
       id, name, connection_type, host, port, auth_mech, created_at, updated_at
     ) VALUES (?, ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
  ).run(id, `Test ${id}`, now, now);
}

/** A cipher with fixed keys, so specs construct the encrypting repositories without a keychain. */
export function createTempCipher(): ColumnCipher {
  return new ColumnCipher({ enc: Buffer.alloc(32, 0x11), mac: Buffer.alloc(32, 0x22) });
}

/** SQLite's storage class of one cell: 'blob' once a repository has sealed it. */
export function cellType(db: Database, table: string, column: string, id: string): string {
  const row = db.prepare(`SELECT typeof(${column}) AS t FROM ${table} WHERE id = ?`).get(id) as { t: string } | undefined;
  if (!row) throw new Error(`no ${table} row ${id}`);
  return row.t;
}
