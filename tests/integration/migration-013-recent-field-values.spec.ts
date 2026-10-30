import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, type Migration } from '../../electron/db/migrationRunner';

function loadMigrationsFromDisk(): Migration[] {
  const dir = path.resolve(__dirname, '..', '..', 'electron', 'db', 'migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({
      version: Number(/^(\d+)-/.exec(name)![1]),
      name,
      sql: fs.readFileSync(path.join(dir, name), 'utf8'),
    }))
    .sort((a, b) => a.version - b.version);
}

describe('migration 013 — recent field values', () => {
  let db: BetterSqlite3.Database | null = null;
  let dir: string | null = null;

  afterEach(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
  });

  function version(d: BetterSqlite3.Database): number {
    return (d.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  }

  function open(): BetterSqlite3.Database {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-mig13-'));
    const d = new BetterSqlite3(path.join(dir, 'test.db'));
    d.pragma('foreign_keys = ON');
    return d;
  }

  function insertConnection(d: BetterSqlite3.Database, id: string): void {
    const now = new Date().toISOString();
    d.prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES (?, ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
    ).run(id, id, now, now);
  }

  it('applies to a database that predates it, and re-running the runner changes nothing', () => {
    db = open();
    const all = loadMigrationsFromDisk();
    runMigrations(db, all.filter((m) => m.version < 13));
    expect(version(db)).toBeLessThan(13);
    const hasTable = () =>
      db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recent_field_values'").get()
      !== undefined;
    expect(hasTable()).toBe(false);

    const upTo13 = all.filter((m) => m.version <= 13);
    runMigrations(db, upTo13);
    expect(hasTable()).toBe(true);
    expect(version(db)).toBe(13);

    expect(() => runMigrations(db!, upTo13)).not.toThrow();
    expect(version(db)).toBe(13);
  });

  it('rejects a second row for the same (connection, db, collection, field, value)', () => {
    db = open();
    // Pinned to 013's own schema: 016 rebuilds this table around value_mac.
    runMigrations(db, loadMigrationsFromDisk().filter((m) => m.version <= 13));
    insertConnection(db, 'c1');
    const now = new Date().toISOString();
    const insert = () =>
      db!.prepare(
        `INSERT INTO recent_field_values
           (id, connection_id, db_name, collection, field, value, val_type, last_used_at, use_count)
         VALUES (?, 'c1', 'shop', 'orders', 'status', 'shipped', 'string', ?, 1)`,
      ).run(crypto.randomUUID(), now);
    insert();
    expect(insert).toThrow(/UNIQUE constraint/);
  });

  it('cascades on connection delete', () => {
    db = open();
    // Pinned to 013's own schema: 016 rebuilds this table around value_mac.
    runMigrations(db, loadMigrationsFromDisk().filter((m) => m.version <= 13));
    insertConnection(db, 'c1');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO recent_field_values
         (id, connection_id, db_name, collection, field, value, val_type, last_used_at, use_count)
       VALUES ('v1', 'c1', 'shop', 'orders', 'status', 'shipped', 'string', ?, 1)`,
    ).run(now);
    db.prepare('DELETE FROM connections WHERE id = ?').run('c1');
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM recent_field_values').get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
