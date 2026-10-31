import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { RecentFieldValueRepo } from '../../electron/db/repositories/RecentFieldValueRepo';
import { AuditRepo } from '../../electron/db/repositories/AuditRepo';
import { MaintenanceService } from '../../electron/services/MaintenanceService';
import os from 'node:os';
import { openDatabase, closeDatabase, truncateWal, isVacuumPending } from '../../electron/db/sqlite';
import { runMigrations } from '../../electron/db/migrationRunner';
import { createTempDb, loadMigrationsFromDisk, type TempDb, createTempCipher } from '../helpers/db';

const MARKER = 'SECRET-MARKER-7f3a9c1e-do-not-keep';

describe('secure_delete and WAL truncation', () => {
  let tmp: TempDb;
  beforeEach(() => {
    tmp = createTempDb();
  });
  afterEach(() => tmp.cleanup());

  it('opens the database with secure_delete on', () => {
    expect(tmp.db.pragma('secure_delete', { simple: true })).toBe(1);
  });

  it('leaves no trace of an expired row in the .db or -wal bytes after the maintenance pass', () => {
    // The row under test needs no parent connection.
    tmp.db.pragma('foreign_keys = OFF');
    tmp.db
      .prepare(
        `INSERT INTO recent_queries (
           id, connection_id, db_name, collection, kind, payload_json,
           ran_at, duration_ms, result_count, error_code
         ) VALUES ('old', 'c', 'mydb', 'items', 'find', ?, ?, 5, 1, NULL)`,
      )
      .run(JSON.stringify({ filter: MARKER }), new Date(Date.now() - 60 * 86_400_000).toISOString());
    // Put the marker in the main file, so the purge has to erase it there.
    expect(truncateWal(tmp.db)).toBe(true);
    const dbPath = path.join(tmp.dir, 'latelier.db');
    expect(fs.readFileSync(dbPath).includes(MARKER)).toBe(true);

    const store = new Map<string, unknown>();
    new MaintenanceService({
      recentRepo: new RecentQueryRepo(tmp.db, createTempCipher()),
      recentFieldValueRepo: new RecentFieldValueRepo(tmp.db, createTempCipher()),
      auditRepo: new AuditRepo(tmp.db, createTempCipher()),
      checkpoint: () => void truncateWal(tmp.db),
    }).runIfNeeded({
      get: <T>(key: string) => (store.get(key) ?? null) as T | null,
      set: <T>(key: string, value: T) => void store.set(key, value),
    });

    expect(tmp.db.prepare("SELECT 1 FROM recent_queries WHERE id = 'old'").get()).toBeUndefined();
    expect(fs.readFileSync(dbPath).includes(MARKER)).toBe(false);
    expect(fs.readFileSync(`${dbPath}-wal`).includes(MARKER)).toBe(false);
  });

  it('truncateWal reports false while another connection holds a read transaction', () => {
    tmp.db.exec('CREATE TABLE probe (x)');
    tmp.db.prepare('INSERT INTO probe VALUES (1)').run();
    const reader = new BetterSqlite3(path.join(tmp.dir, 'latelier.db'));
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM probe').all();
      tmp.db.prepare('INSERT INTO probe VALUES (2)').run();
      tmp.db.pragma('busy_timeout = 0');
      expect(truncateWal(tmp.db)).toBe(false);
    } finally {
      reader.close();
    }
  });

  it('an upgrade that runs migrations also clears bytes freed before secure_delete existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-vacuum-'));
    const dbPath = path.join(dir, 'latelier.db');
    const all = loadMigrationsFromDisk();
    try {
      // An older install: no secure_delete, a row deleted long ago.
      const old = new BetterSqlite3(dbPath);
      old.pragma('journal_mode = WAL');
      runMigrations(old, all.slice(0, -1));
      old.exec('CREATE TABLE legacy (payload TEXT)');
      old.prepare('INSERT INTO legacy VALUES (?)').run(MARKER.repeat(200));
      old.pragma('wal_checkpoint(TRUNCATE)');
      old.exec('DELETE FROM legacy');
      old.pragma('wal_checkpoint(TRUNCATE)');
      old.close();
      expect(fs.readFileSync(dbPath).includes(MARKER)).toBe(true);

      const db = openDatabase({ userDataDir: dir, migrations: all });
      closeDatabase(db);
      expect(fs.readFileSync(dbPath).includes(MARKER)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reopening an up-to-date database does not VACUUM', () => {
    tmp.db.exec('CREATE TABLE filler (payload TEXT)');
    const insert = tmp.db.prepare('INSERT INTO filler VALUES (?)');
    for (let i = 0; i < 50; i++) insert.run('x'.repeat(4000));
    tmp.db.exec('DELETE FROM filler');
    expect(truncateWal(tmp.db)).toBe(true);
    const freePages = tmp.db.pragma('freelist_count', { simple: true }) as number;
    expect(freePages).toBeGreaterThan(0);
    closeDatabase(tmp.db);

    const reopened = openDatabase({ userDataDir: tmp.dir, migrations: loadMigrationsFromDisk() });
    const freeAfterReopen = reopened.pragma('freelist_count', { simple: true });
    closeDatabase(reopened);
    expect(freeAfterReopen).toBe(freePages);
  });

  describe('when the post-upgrade VACUUM fails', () => {
    // Every migration has committed by then; only the VACUUM fails, as on a
    // full disk.
    const failVacuum = () => {
      const real = BetterSqlite3.prototype.exec;
      return vi.spyOn(BetterSqlite3.prototype, 'exec').mockImplementation(function (this: BetterSqlite3.Database, sql: string) {
        if (sql === 'VACUUM') throw new Error('database or disk is full');
        return real.call(this, sql);
      });
    };

    it('reports it through the logger, still opens the migrated database, and leaves the VACUUM owed', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-vacuum-fail-'));
      const warnings: string[] = [];
      const spy = failVacuum();
      try {
        const db = openDatabase({
          userDataDir: dir,
          migrations: loadMigrationsFromDisk(),
          log: { warn: (_scope: string, msg: string) => void warnings.push(msg) },
        });
        const { version } = db.prepare('SELECT version FROM schema_version').get() as { version: number };
        const pending = isVacuumPending(db);
        closeDatabase(db);
        expect(version).toBe(loadMigrationsFromDisk().at(-1)!.version);
        expect(warnings).toEqual(['vacuum after migrations failed']);
        expect(pending).toBe(true);
      } finally {
        spy.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still opens, warning twice, when recording the owed VACUUM fails too', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-vacuum-fail-'));
      const warnings: string[] = [];
      const vacuum = failVacuum();
      const realPrepare = BetterSqlite3.prototype.prepare;
      const marker = vi.spyOn(BetterSqlite3.prototype, 'prepare').mockImplementation(function (this: BetterSqlite3.Database, sql: string) {
        if (sql.includes('INSERT INTO app_state')) throw new Error('disk I/O error');
        return realPrepare.call(this, sql);
      });
      try {
        const db = openDatabase({
          userDataDir: dir,
          migrations: loadMigrationsFromDisk(),
          log: { warn: (_scope: string, msg: string) => void warnings.push(msg) },
        });
        closeDatabase(db);
        expect(warnings).toEqual(['vacuum after migrations failed', 'could not record the owed vacuum']);
      } finally {
        marker.mockRestore();
        vacuum.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws when there is no logger to report it to', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-vacuum-fail-'));
      const spy = failVacuum();
      try {
        expect(() => openDatabase({ userDataDir: dir, migrations: loadMigrationsFromDisk() })).toThrow(/disk is full/);
      } finally {
        spy.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
