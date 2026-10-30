import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  openDatabase,
  closeDatabase,
  withTransaction,
  adoptLegacyDatabase,
  DB_FILENAME,
  LEGACY_DB_FILENAME,
} from '../../electron/db/sqlite';
import { createTempDb, type TempDb } from '../helpers/db';

describe('sqlite bootstrap', () => {
  let tmp: TempDb | null = null;

  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  it('creates the DB file at userDataDir/<filename>', () => {
    tmp = createTempDb();
    expect(fs.existsSync(path.join(tmp.dir, DB_FILENAME))).toBe(true);
  });

  it('applies pragmas', () => {
    tmp = createTempDb();
    expect(tmp.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(tmp.db.pragma('foreign_keys', { simple: true })).toBe(1);
    // 2 = MEMORY: VACUUM's temp copy never reaches disk.
    expect(tmp.db.pragma('temp_store', { simple: true })).toBe(2);
  });

  it('creates all expected tables', () => {
    tmp = createTempDb();
    const names = tmp.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of [
      'schema_version',
      'connections',
      'connection_secrets',
      'saved_queries',
      'recent_queries',
      'workspace_tabs',
      'app_state',
      'audit_log',
      'recent_field_values',
      'column_keys',
    ]) {
      expect(names, `expected table ${expected}`).toContain(expected);
    }
  });

  it('drops preview_fields (migration 011) and lands on schema_version 17', () => {
    tmp = createTempDb();
    const names = tmp.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).not.toContain('preview_fields');
    const version = tmp.db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(17);
  });

  it('reopening an existing DB does not re-run migrations', () => {
    tmp = createTempDb();
    const v1 = tmp.db.prepare('SELECT version FROM schema_version').get() as { version: number };
    closeDatabase(tmp.db);
    // Reopen directly with a non-existent migration that would fail if re-run:
    const migrations = [
      {
        version: 1,
        name: '001-init.sql',
        sql: 'SELECT RAISE(FAIL, "should not run");',
      },
    ];
    const db2 = openDatabase({ userDataDir: tmp.dir, migrations });
    expect(() => db2.prepare('SELECT 1 FROM connections').get()).not.toThrow();
    const v2 = db2.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v2.version).toBe(v1.version);
    closeDatabase(db2);
  });

  it('withTransaction commits on success and rolls back on throw', () => {
    tmp = createTempDb();
    const db = tmp.db;

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO app_state (key, value_json, updated_at) VALUES ('k1','"v"', '2024-01-01T00:00:00Z')`,
      ).run();
    });
    expect(db.prepare('SELECT key FROM app_state WHERE key = ?').get('k1')).toBeDefined();

    expect(() =>
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO app_state (key, value_json, updated_at) VALUES ('k2','"v"', '2024-01-01T00:00:00Z')`,
        ).run();
        throw new Error('boom');
      }),
    ).toThrow(/boom/);
    expect(db.prepare('SELECT key FROM app_state WHERE key = ?').get('k2')).toBeUndefined();
  });
});

describe('adoptLegacyDatabase', () => {
  let dir: string;
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-adopt-'));
    log.info.mockClear();
    log.warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A WAL-mode database like the one openDatabase leaves, holding the given values. */
  function seed(directory: string, filename: string, values: string[]): void {
    const db = new BetterSqlite3(path.join(directory, filename));
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (v TEXT)');
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
      for (const v of values) insert.run(v);
    } finally {
      db.close();
    }
  }

  function readValues(directory: string, filename: string): string[] {
    const db = new BetterSqlite3(path.join(directory, filename), { readonly: true, fileMustExist: true });
    try {
      return (db.prepare('SELECT v FROM t ORDER BY rowid').all() as Array<{ v: string }>).map((r) => r.v);
    } finally {
      db.close();
    }
  }

  const legacyFiles = (directory: string): string[] =>
    ['', '-wal', '-shm'].filter((suffix) => fs.existsSync(path.join(directory, LEGACY_DB_FILENAME + suffix)));

  it('does nothing when neither file exists', () => {
    expect(adoptLegacyDatabase(dir, log)).toBe('latelier.db');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('renames a cleanly closed legacy database and keeps its rows', () => {
    seed(dir, LEGACY_DB_FILENAME, ['kept']);

    expect(adoptLegacyDatabase(dir, log)).toBe('latelier.db');

    expect(fs.existsSync(path.join(dir, DB_FILENAME))).toBe(true);
    expect(legacyFiles(dir)).toEqual([]);
    expect(readValues(dir, DB_FILENAME)).toEqual(['kept']);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('folds a WAL left behind by a crash into the renamed file instead of dropping its rows', () => {
    const crashed = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-adopt-crashed-'));
    try {
      // Auto-checkpoint off keeps every row in the WAL; the files are copied
      // while the writer is still open, as a crash would leave them.
      const writer = new BetterSqlite3(path.join(crashed, LEGACY_DB_FILENAME));
      try {
        writer.pragma('journal_mode = WAL');
        writer.pragma('wal_autocheckpoint = 0');
        writer.exec('CREATE TABLE t (v TEXT)');
        const insert = writer.prepare('INSERT INTO t (v) VALUES (?)');
        for (let i = 0; i < 50; i++) insert.run(`row-${i}`);
        for (const suffix of ['', '-wal', '-shm']) {
          fs.copyFileSync(path.join(crashed, LEGACY_DB_FILENAME + suffix), path.join(dir, LEGACY_DB_FILENAME + suffix));
        }
      } finally {
        writer.close();
      }
    } finally {
      fs.rmSync(crashed, { recursive: true, force: true });
    }
    expect(fs.statSync(path.join(dir, LEGACY_DB_FILENAME + '-wal')).size).toBeGreaterThan(0);

    expect(adoptLegacyDatabase(dir, log)).toBe('latelier.db');

    expect(legacyFiles(dir)).toEqual([]);
    expect(readValues(dir, DB_FILENAME)).toHaveLength(50);
  });

  it('keeps the old name for this run when another connection still holds the database', () => {
    seed(dir, LEGACY_DB_FILENAME, []);
    const legacyPath = path.join(dir, LEGACY_DB_FILENAME);
    const writer = new BetterSqlite3(legacyPath);
    const reader = new BetterSqlite3(legacyPath);
    try {
      writer.pragma('journal_mode = WAL');
      const insert = writer.prepare('INSERT INTO t (v) VALUES (?)');
      insert.run('one');
      // An open read transaction pins the WAL, so the second row cannot be folded in.
      reader.exec('BEGIN');
      reader.prepare('SELECT v FROM t').all();
      insert.run('two');

      expect(adoptLegacyDatabase(dir, log)).toBe(LEGACY_DB_FILENAME);

      expect(fs.existsSync(path.join(dir, DB_FILENAME))).toBe(false);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      reader.exec('COMMIT');
      reader.close();
      writer.close();
    }
    expect(readValues(dir, LEGACY_DB_FILENAME)).toEqual(['one', 'two']);
  });

  it('leaves the legacy file alone when the current database already exists', () => {
    seed(dir, LEGACY_DB_FILENAME, ['legacy-row']);
    seed(dir, DB_FILENAME, ['current-row']);
    const before = fs.readFileSync(path.join(dir, LEGACY_DB_FILENAME));

    expect(adoptLegacyDatabase(dir, log)).toBe('latelier.db');

    expect(fs.readFileSync(path.join(dir, LEGACY_DB_FILENAME)).equals(before)).toBe(true);
    expect(readValues(dir, DB_FILENAME)).toEqual(['current-row']);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the old name and the file untouched when the legacy file is not a database', () => {
    const legacyPath = path.join(dir, LEGACY_DB_FILENAME);
    fs.writeFileSync(legacyPath, 'not a database'.repeat(200));
    const before = fs.readFileSync(legacyPath);

    expect(adoptLegacyDatabase(dir, log)).toBe(LEGACY_DB_FILENAME);

    expect(fs.readFileSync(legacyPath).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(dir, DB_FILENAME))).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the old name when side files of a missing current database are present', () => {
    seed(dir, LEGACY_DB_FILENAME, ['legacy-row']);
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-adopt-foreign-'));
    try {
      // Another database's WAL, copied while its writer is open so it holds rows.
      const writer = new BetterSqlite3(path.join(foreign, 'other.db'));
      try {
        writer.pragma('journal_mode = WAL');
        writer.pragma('wal_autocheckpoint = 0');
        writer.exec('CREATE TABLE other (v TEXT)');
        writer.prepare('INSERT INTO other (v) VALUES (?)').run('foreign-row');
        for (const suffix of ['-wal', '-shm']) {
          fs.copyFileSync(path.join(foreign, 'other.db' + suffix), path.join(dir, DB_FILENAME + suffix));
        }
      } finally {
        writer.close();
      }
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
    const before = fs.readFileSync(path.join(dir, LEGACY_DB_FILENAME));

    expect(adoptLegacyDatabase(dir, log)).toBe(LEGACY_DB_FILENAME);

    expect(fs.existsSync(path.join(dir, DB_FILENAME))).toBe(false);
    expect(fs.readFileSync(path.join(dir, LEGACY_DB_FILENAME)).equals(before)).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the old name when an idle connection still has the database open', () => {
    seed(dir, LEGACY_DB_FILENAME, ['legacy-row']);
    // No transaction is open, so the checkpoint itself succeeds; only the
    // side files this connection keeps alive show that it is still there.
    const holder = new BetterSqlite3(path.join(dir, LEGACY_DB_FILENAME));
    try {
      holder.prepare('SELECT v FROM t').all();

      expect(adoptLegacyDatabase(dir, log)).toBe(LEGACY_DB_FILENAME);

      expect(fs.existsSync(path.join(dir, DB_FILENAME))).toBe(false);
      expect(log.warn).toHaveBeenCalledTimes(1);
    } finally {
      holder.close();
    }
    expect(readValues(dir, LEGACY_DB_FILENAME)).toEqual(['legacy-row']);
  });

  it('keeps the old name and the data when the rename itself fails', () => {
    seed(dir, LEGACY_DB_FILENAME, ['legacy-row']);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    try {
      expect(adoptLegacyDatabase(dir, log)).toBe(LEGACY_DB_FILENAME);
    } finally {
      rename.mockRestore();
    }

    expect(fs.existsSync(path.join(dir, DB_FILENAME))).toBe(false);
    expect(readValues(dir, LEGACY_DB_FILENAME)).toEqual(['legacy-row']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'db',
      expect.any(String),
      expect.objectContaining({ message: expect.stringContaining('EBUSY') }),
    );
  });
});
