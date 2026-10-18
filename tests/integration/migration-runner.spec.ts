import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../electron/db/migrationRunner';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-mig-'));
  return path.join(dir, 'test.db');
}

describe('migrationRunner', () => {
  const opened: BetterSqlite3.Database[] = [];

  afterEach(() => {
    while (opened.length) opened.pop()!.close();
  });

  it('applies migrations in order and advances schema_version', () => {
    const db = new BetterSqlite3(tmpFile());
    opened.push(db);
    const ran = runMigrations(db, [
      {
        version: 1,
        name: '001-init.sql',
        sql: `CREATE TABLE schema_version (version INTEGER NOT NULL);
              INSERT INTO schema_version (version) VALUES (0);
              CREATE TABLE t1 (x INTEGER);
              UPDATE schema_version SET version = 1;`,
      },
      {
        version: 2,
        name: '002-add.sql',
        sql: `CREATE TABLE t2 (x INTEGER);
              UPDATE schema_version SET version = 2;`,
      },
    ]);
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBe(2);
    expect(ran).toBe(2);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t2'").get(),
    ).toBeDefined();
  });

  it('is idempotent — re-running does not throw or advance version', () => {
    const db = new BetterSqlite3(tmpFile());
    opened.push(db);
    const migs = [
      {
        version: 1,
        name: '001.sql',
        sql: `CREATE TABLE schema_version (version INTEGER NOT NULL);
              INSERT INTO schema_version (version) VALUES (0);
              UPDATE schema_version SET version = 1;`,
      },
    ];
    expect(runMigrations(db, migs)).toBe(1);
    expect(runMigrations(db, migs)).toBe(0);
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBe(1);
  });

  it('rolls back a failing migration and leaves schema_version unchanged', () => {
    const db = new BetterSqlite3(tmpFile());
    opened.push(db);
    runMigrations(db, [
      {
        version: 1,
        name: '001.sql',
        sql: `CREATE TABLE schema_version (version INTEGER NOT NULL);
              INSERT INTO schema_version (version) VALUES (0);
              UPDATE schema_version SET version = 1;`,
      },
    ]);
    expect(() =>
      runMigrations(db, [
        {
          version: 1,
          name: '001.sql',
          sql: 'ignored because version <= current',
        },
        {
          version: 2,
          name: '002-broken.sql',
          sql: `CREATE TABLE ok (x INTEGER);
                NOT VALID SQL;`,
        },
      ]),
    ).toThrow();
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok'").get(),
      'partial migration must be rolled back',
    ).toBeUndefined();
  });

  it('fails loudly if a migration does not advance schema_version', () => {
    const db = new BetterSqlite3(tmpFile());
    opened.push(db);
    expect(() =>
      runMigrations(db, [
        {
          version: 1,
          name: '001.sql',
          sql: `CREATE TABLE schema_version (version INTEGER NOT NULL);
                INSERT INTO schema_version (version) VALUES (0);
                -- forgot to UPDATE schema_version
                CREATE TABLE x (y INTEGER);`,
        },
      ]),
    ).toThrow(/did not advance/);
  });

  describe('version sequence and foreign keys', () => {
    const base = `CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (0);
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
      UPDATE schema_version SET version = 1;`;
    const open = (): BetterSqlite3.Database => {
      const db = new BetterSqlite3(tmpFile());
      opened.push(db);
      return db;
    };

    it('rejects two migrations sharing a version, naming both files', () => {
      const db = open();
      expect(() =>
        runMigrations(db, [
          { version: 1, name: '001-a.sql', sql: base },
          { version: 1, name: '001-b.sql', sql: 'SELECT 1;' },
        ]),
      ).toThrow(/duplicate migration version 1: 001-a\.sql, 001-b\.sql/);
    });

    it('rejects a gap, naming the file and the expected version', () => {
      const db = open();
      expect(() =>
        runMigrations(db, [
          { version: 1, name: '001-a.sql', sql: base },
          { version: 3, name: '003-c.sql', sql: 'SELECT 1;' },
        ]),
      ).toThrow(/gap: expected 2, found 3 \(003-c\.sql\)/);
    });

    it('rolls back a migration that introduces a foreign key violation', () => {
      const db = open();
      runMigrations(db, [{ version: 1, name: '001-a.sql', sql: base }]);
      const bad = {
        version: 2,
        name: '002-bad.sql',
        sql: `INSERT INTO child (id, pid) VALUES (1, 99);
              UPDATE schema_version SET version = 2;`,
      };
      expect(() => runMigrations(db, [{ version: 1, name: '001-a.sql', sql: base }, bad])).toThrow(
        /migration 002-bad\.sql introduced 1 foreign key violation/,
      );
      expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM child').get()).toEqual({ n: 0 });
    });

    it('still boots when orphans already existed before the migration', () => {
      const db = open();
      const first = { version: 1, name: '001-a.sql', sql: base };
      runMigrations(db, [first]);
      db.pragma('foreign_keys = OFF');
      db.exec('INSERT INTO child (id, pid) VALUES (1, 99)');
      db.pragma('foreign_keys = ON');
      const ran = runMigrations(db, [
        first,
        { version: 2, name: '002-ok.sql', sql: 'UPDATE schema_version SET version = 2;' },
      ]);
      expect(ran).toBe(1);
    });
  });
});
