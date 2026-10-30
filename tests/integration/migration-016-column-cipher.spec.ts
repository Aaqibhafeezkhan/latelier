import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { runMigrations } from '../../electron/db/migrationRunner';
import { openDatabase, closeDatabase, isVacuumPending } from '../../electron/db/sqlite';
import { encryptLegacyRows } from '../../electron/db/columnKeyStore';
import { createTempCipher, loadMigrationsFromDisk } from '../helpers/db';

const MARK = {
  recent: 'MARK-recent-4c1d9e',
  values: 'MARK-values-8a2b7f',
  audit: 'MARK-audit-31f0aa',
  saved: 'MARK-saved-b9e4c2',
  tabs: 'MARK-tabs-5d7a10',
  stale: 'MARK-stale-e6c3b8',
};

const ENCRYPTED = [
  ['recent_queries', 'payload_json', 'r1', MARK.recent],
  ['audit_log', 'summary_json', 'a1', MARK.audit],
  ['saved_queries', 'payload_json', 's1', MARK.saved],
  ['workspace_tabs', 'state_json', 't1', MARK.tabs],
] as const;

const json = (marker: string) => JSON.stringify({ filter: { email: marker }, pad: 'x'.repeat(200) });

/**
 * A database holding plaintext in every encrypted table. At 15 it is what the
 * release before X21 left; at 16 it is one whose upgrade stopped before the
 * rows were sealed (Quit at the key dialog), so `openDatabase` runs no
 * migration and no VACUUM of its own.
 */
function seed(dir: string, secureDelete: boolean, upTo: 15 | 16): string {
  const dbPath = path.join(dir, 'latelier.db');
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma(`secure_delete = ${secureDelete ? 'ON' : 'OFF'}`);
  runMigrations(db, loadMigrationsFromDisk().filter((m) => m.version <= upTo));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
    VALUES ('c1', 'c1', 'standard', 'localhost', 27017, 'none', ?, ?)`).run(now, now);
  const insert = (id: string, marker: string) => {
    db.prepare(`INSERT INTO recent_queries (id, connection_id, db_name, collection, kind, payload_json, ran_at, duration_ms)
      VALUES (?, 'c1', 'shop', 'orders', 'find', ?, ?, 1)`).run(id, json(marker), now);
  };
  insert('r1', MARK.recent);
  if (upTo === 15) {
    db.prepare(`INSERT INTO recent_field_values (id, connection_id, db_name, collection, field, value, val_type, last_used_at)
      VALUES ('v1', 'c1', 'shop', 'orders', 'email', ?, 'string', ?)`).run(MARK.values, now);
  }
  db.prepare(`INSERT INTO audit_log (id, connection_id, db_name, collection, op, summary_json, outcome, ran_at, duration_ms)
    VALUES ('a1', 'c1', 'shop', 'orders', 'deleteOne', ?, 'ok', ?, 1)`).run(json(MARK.audit), now);
  db.prepare(`INSERT INTO saved_queries (id, connection_id, db_name, collection, kind, name, payload_json, created_at, updated_at)
    VALUES ('s1', 'c1', 'shop', 'orders', 'find', 'mine', ?, ?, ?)`).run(json(MARK.saved), now, now);
  db.prepare(`INSERT INTO workspace_tabs (id, connection_id, kind, db_name, collection, state_json, position, opened_at)
    VALUES ('t1', 'c1', 'collection', 'shop', 'orders', ?, 0, ?)`).run(json(MARK.tabs), now);
  // Plaintext that only survives as a stale copy: written, then deleted.
  insert('r-gone', MARK.stale);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare("DELETE FROM recent_queries WHERE id = 'r-gone'").run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return dbPath;
}

function bytesOnDisk(dbPath: string): Buffer {
  const parts = [fs.readFileSync(dbPath)];
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) parts.push(fs.readFileSync(dbPath + suffix));
  }
  return Buffer.concat(parts);
}

describe('migration 016 and encryptLegacyRows', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const cases = [
    { upTo: 15, secureDelete: true },
    { upTo: 15, secureDelete: false },
    { upTo: 16, secureDelete: false },
  ] as const;
  for (const { upTo, secureDelete } of cases) {
    it(`leaves only sealed cells and no plaintext on disk (seeded at ${upTo}, secure_delete ${secureDelete ? 'on' : 'off'})`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-016-'));
      dirs.push(dir);
      const dbPath = seed(dir, secureDelete, upTo);
      const markers = Object.values(MARK).filter((m) => upTo === 15 || m !== MARK.values);
      const seeded = bytesOnDisk(dbPath);
      // With secure_delete on, the deleted row was zeroed at the time.
      for (const marker of markers) {
        expect(seeded.includes(marker), marker).toBe(marker !== MARK.stale || !secureDelete);
      }

      const db = openDatabase({ userDataDir: dir, migrations: loadMigrationsFromDisk() });
      try {
        expect(db.pragma('temp_store', { simple: true })).toBe(2);
        const cipher = createTempCipher();
        const log = { info: () => {}, warn: (_s: string, m: string) => expect.fail(m) };
        expect(encryptLegacyRows(db, cipher, log)).toBe(4);

        for (const [table, column, id, marker] of ENCRYPTED) {
          const row = db.prepare(`SELECT typeof(${column}) AS t, ${column} AS cell FROM ${table} WHERE id = ?`).get(id) as {
            t: string;
            cell: Buffer;
          };
          expect(row.t, table).toBe('blob');
          expect(cipher.open(table, column, id, row.cell)).toBe(json(marker));
        }
        expect(db.prepare('SELECT COUNT(*) AS n FROM recent_field_values').get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM column_keys').get()).toEqual({ n: 0 });

        const onDisk = bytesOnDisk(dbPath);
        for (const marker of markers) expect(onDisk.includes(marker), marker).toBe(false);

        // Idempotent: a second boot finds nothing left to convert.
        expect(encryptLegacyRows(db, cipher, log)).toBe(0);
      } finally {
        closeDatabase(db);
      }
      const afterClose = bytesOnDisk(dbPath);
      for (const marker of markers) expect(afterClose.includes(marker), marker).toBe(false);
    });
  }

  it('a VACUUM that fails after sealing stays owed and is retried and cleared on the next boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-016-'));
    dirs.push(dir);
    // Seeded at 16 with secure_delete off: the case only this step's VACUUM erases.
    const dbPath = seed(dir, false, 16);
    const markers = Object.values(MARK).filter((m) => m !== MARK.values);
    const cipher = createTempCipher();
    const warnings: string[] = [];
    const log = { info: () => {}, warn: (_s: string, m: string) => void warnings.push(m) };

    const first = openDatabase({ userDataDir: dir, migrations: loadMigrationsFromDisk().filter((m) => m.version <= 16) });
    const real = first.exec.bind(first);
    const spy = vi.spyOn(first, 'exec').mockImplementationOnce((sql: string) => {
      if (sql === 'VACUUM') throw new Error('database or disk is full');
      return real(sql);
    });
    try {
      expect(encryptLegacyRows(first, cipher, log)).toBe(4);
      expect(spy).toHaveBeenCalledWith('VACUUM');
      expect(warnings).toEqual(['vacuum after encrypting legacy rows failed']);
      expect(isVacuumPending(first)).toBe(true);
      // The failed VACUUM left the stale plaintext behind.
      expect(markers.some((m) => bytesOnDisk(dbPath).includes(m))).toBe(true);
    } finally {
      spy.mockRestore();
      closeDatabase(first);
    }

    const second = openDatabase({ userDataDir: dir, migrations: loadMigrationsFromDisk().filter((m) => m.version <= 16) });
    try {
      expect(encryptLegacyRows(second, cipher, log)).toBe(0);
      expect(isVacuumPending(second)).toBe(false);
      const onDisk = bytesOnDisk(dbPath);
      for (const marker of markers) expect(onDisk.includes(marker), marker).toBe(false);
      // Nothing owed any more: a third run does not VACUUM again.
      const exec = vi.spyOn(second, 'exec');
      expect(encryptLegacyRows(second, cipher, log)).toBe(0);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      closeDatabase(second);
    }
  });

  it('dedupes recent_field_values on value_mac alone and still cascades on connection delete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-016-'));
    dirs.push(dir);
    const db = openDatabase({ userDataDir: dir, migrations: loadMigrationsFromDisk() });
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
        VALUES ('c1', 'c1', 'standard', 'localhost', 27017, 'none', ?, ?)`).run(now, now);
      const insert = db.prepare(`INSERT INTO recent_field_values (id, connection_id, db_name, collection, field, value, value_mac, val_type, last_used_at)
        VALUES (?, 'c1', 'd', 'c', 'f', x'00', ?, 'string', ?)`);
      insert.run('v1', 'mac-1', now);
      insert.run('v2', 'mac-2', now);
      expect(() => insert.run('v3', 'mac-1', now)).toThrow(/UNIQUE/);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 17 });

      db.prepare("DELETE FROM connections WHERE id = 'c1'").run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM recent_field_values').get()).toEqual({ n: 0 });
    } finally {
      closeDatabase(db);
    }
  });
});
