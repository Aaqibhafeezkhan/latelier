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

describe('migration 017 — audit collectionModify', () => {
  let db: BetterSqlite3.Database | null = null;
  let dir: string | null = null;

  afterEach(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
  });

  function open(): BetterSqlite3.Database {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-mig17-'));
    db = new BetterSqlite3(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    return db;
  }

  function seedConnection(d: BetterSqlite3.Database, id: string): void {
    const now = new Date().toISOString();
    d.prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES (?, ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
    ).run(id, id, now, now);
  }

  const insertOp = (d: BetterSqlite3.Database, op: string) =>
    d
      .prepare(
        `INSERT INTO audit_log (id, connection_id, db_name, op, summary_json, outcome, ran_at, duration_ms)
         VALUES (?, 'c1', 'd', ?, '{}', 'ok', '2026-01-01T00:00:00.000Z', 0)`,
      )
      .run(`id-${op}`, op);

  it('keeps a row written under 012 intact, every column, and lands on version 17', () => {
    const d = open();
    const all = loadMigrationsFromDisk();
    runMigrations(d, all.filter((m) => m.version < 17));
    seedConnection(d, 'c1');
    d.prepare(
      `INSERT INTO audit_log
         (id, connection_id, db_name, collection, op, summary_json, outcome, error_code,
          ran_at, duration_ms, reversible, undo_json, undone_at)
       VALUES ('row-1', 'c1', 'shop', 'orders', 'collectionRename', '{"op":"collectionRename"}', 'error', 'CONFLICT',
               '2026-02-03T04:05:06.000Z', 42, 1, '{"k":1}', '2026-02-04T00:00:00.000Z')`,
    ).run();
    const before = d.prepare('SELECT * FROM audit_log').all();

    runMigrations(d, all);

    expect(d.prepare('SELECT * FROM audit_log').all()).toEqual(before);
    expect(before).toHaveLength(1);
    expect((d.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(17);
  });

  it("accepts op 'collectionModify' and still refuses an unknown op", () => {
    const d = open();
    runMigrations(d, loadMigrationsFromDisk());
    seedConnection(d, 'c1');
    expect(() => insertOp(d, 'collectionModify')).not.toThrow();
    expect(() => insertOp(d, 'import')).not.toThrow();
    expect(() => insertOp(d, 'replace')).toThrow(/CHECK constraint/);
  });

  it('still refuses an outcome outside the set', () => {
    const d = open();
    runMigrations(d, loadMigrationsFromDisk());
    seedConnection(d, 'c1');
    expect(() =>
      d
        .prepare(
          `INSERT INTO audit_log (id, connection_id, db_name, op, summary_json, outcome, ran_at, duration_ms)
           VALUES ('x', 'c1', 'd', 'import', '{}', 'maybe', '2026-01-01T00:00:00.000Z', 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it('deletes a connection\'s audit rows with it', () => {
    const d = open();
    runMigrations(d, loadMigrationsFromDisk());
    seedConnection(d, 'c1');
    insertOp(d, 'collectionModify');

    d.prepare("DELETE FROM connections WHERE id = 'c1'").run();

    expect((d.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c).toBe(0);
  });

  it('recreates the connection/time index', () => {
    const d = open();
    runMigrations(d, loadMigrationsFromDisk());
    const idx = d
      .prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_audit_by_conn_time'")
      .get() as { tbl_name: string } | undefined;
    expect(idx?.tbl_name).toBe('audit_log');
    expect(d.prepare("SELECT name FROM sqlite_master WHERE name = 'audit_log_new'").get()).toBeUndefined();
  });
});
