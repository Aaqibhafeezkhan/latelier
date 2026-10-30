import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadOrCreateColumnKeys, resetProtectedData } from '../../electron/db/columnKeyStore';
import type { SafeStorageLike } from '../../electron/secrets/SecretsVault';
import { isVacuumPending, resetDatabaseInPlace } from '../../electron/db/sqlite';
import { AppStateRepo } from '../../electron/db/repositories/AppStateRepo';
import { AppStateService } from '../../electron/services/AppStateService';
import { createTempDb, insertConnectionRow, type TempDb } from '../helpers/db';

/** A reversible stand-in for safeStorage whose availability and failure the test controls. */
function fakeKeychain(state: { available: boolean; failDecrypt?: boolean; failEncrypt?: boolean }): SafeStorageLike {
  return {
    isEncryptionAvailable: () => state.available,
    encryptString: (s) => {
      if (state.failEncrypt) throw new Error('User denied keychain access');
      return Buffer.from(`wrapped:${s}`, 'utf8');
    },
    decryptString: (b) => {
      if (state.failDecrypt) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      const s = b.toString('utf8');
      if (!s.startsWith('wrapped:')) throw new Error('not wrapped by this keychain');
      return s.slice('wrapped:'.length);
    },
  };
}

const log = () => {
  const lines: string[] = [];
  return { lines, info: (_s: string, m: string) => void lines.push(m), warn: (_s: string, m: string) => void lines.push(m) };
};

function keyRow(tmp: TempDb) {
  return tmp.db.prepare('SELECT wrapped, is_plaintext, created_at FROM column_keys').all() as Array<{
    wrapped: Buffer;
    is_plaintext: number;
    created_at: string;
  }>;
}

describe('column key store', () => {
  let tmp: TempDb;
  beforeEach(() => {
    tmp = createTempDb();
  });
  afterEach(() => tmp.cleanup());

  it('creates one wrapped key on a fresh database and loads the same key afterwards', () => {
    const keychain = fakeKeychain({ available: true });
    const first = loadOrCreateColumnKeys(tmp.db, keychain, log());
    expect(first.protected).toBe(true);
    expect(first.keys.enc.length).toBe(32);
    expect(first.keys.mac.length).toBe(32);

    const rows = keyRow(tmp);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_plaintext).toBe(0);
    const raw = Buffer.concat([first.keys.enc, first.keys.mac]);
    expect(rows[0]!.wrapped.includes(raw)).toBe(false);
    expect(rows[0]!.wrapped.toString('utf8')).toBe(`wrapped:${raw.toString('base64')}`);

    const again = loadOrCreateColumnKeys(tmp.db, keychain, log());
    expect(again.keys.enc.equals(first.keys.enc)).toBe(true);
    expect(again.keys.mac.equals(first.keys.mac)).toBe(true);
    expect(keyRow(tmp)).toHaveLength(1);
  });

  it('throws COLUMN_KEY_UNREADABLE when the keychain cannot decrypt, and leaves the row alone', () => {
    loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available: true }), log());
    const before = keyRow(tmp);

    for (const available of [true, false]) {
      expect(() => loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available, failDecrypt: true }), log())).toThrow(
        expect.objectContaining({
          code: 'COLUMN_KEY_UNREADABLE',
          details: expect.objectContaining({ encryptionAvailable: available }),
        }),
      );
    }
    expect(keyRow(tmp)).toEqual(before);
  });

  it('refuses a decrypted key of the wrong length instead of using part of it', () => {
    tmp.db
      .prepare('INSERT INTO column_keys (id, wrapped, is_plaintext, created_at) VALUES (1, ?, 0, ?)')
      .run(Buffer.from(`wrapped:${Buffer.alloc(48, 1).toString('base64')}`), new Date().toISOString());
    expect(() => loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available: true }), log())).toThrow(
      expect.objectContaining({ code: 'COLUMN_KEY_UNREADABLE' }),
    );
  });

  it('stores the key raw with is_plaintext = 1 when no keychain is usable, and warns', () => {
    const l = log();
    const loaded = loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available: false }), l);
    expect(loaded.protected).toBe(false);
    const [row] = keyRow(tmp);
    expect(row!.is_plaintext).toBe(1);
    expect(row!.wrapped.equals(Buffer.concat([loaded.keys.enc, loaded.keys.mac]))).toBe(true);
    expect(l.lines).toContain('no usable keychain, column key stored unprotected');

    const again = loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available: false }), log());
    expect(again.protected).toBe(false);
    expect(again.keys.enc.equals(loaded.keys.enc)).toBe(true);
    expect(keyRow(tmp)[0]!.is_plaintext).toBe(1);
  });

  it('re-wraps an unprotected key once a keychain appears, keeping the same key', () => {
    const plain = loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available: false }), log());
    const wrapped = loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available: true }), log());
    expect(wrapped.protected).toBe(true);
    expect(wrapped.keys.enc.equals(plain.keys.enc)).toBe(true);
    expect(wrapped.keys.mac.equals(plain.keys.mac)).toBe(true);
    const [row] = keyRow(tmp);
    expect(row!.is_plaintext).toBe(0);
    expect(row!.wrapped.includes(Buffer.concat([plain.keys.enc, plain.keys.mac]))).toBe(false);

    const later = loadOrCreateColumnKeys(tmp.db, fakeKeychain({ available: true }), log());
    expect(later.keys.enc.equals(plain.keys.enc)).toBe(true);
  });

  it('falls back to an unprotected key when the keychain refuses to wrap, on create and on re-wrap', () => {
    const refusing = fakeKeychain({ available: true, failEncrypt: true });
    const l = log();
    const created = loadOrCreateColumnKeys(tmp.db, refusing, l);
    expect(created.protected).toBe(false);
    expect(keyRow(tmp)[0]!.is_plaintext).toBe(1);
    expect(l.lines).toContain('keychain refused to wrap the column key');

    const again = loadOrCreateColumnKeys(tmp.db, refusing, log());
    expect(again.protected).toBe(false);
    expect(again.keys.enc.equals(created.keys.enc)).toBe(true);
    expect(keyRow(tmp)[0]!.is_plaintext).toBe(1);
  });

  it('reset deletes every protected row and the key, keeps connections, and a fresh key follows', () => {
    const keychain = fakeKeychain({ available: true });
    const old = loadOrCreateColumnKeys(tmp.db, keychain, log());
    insertConnectionRow(tmp.db, 'c1');
    const now = new Date().toISOString();
    tmp.db.prepare(`INSERT INTO recent_queries (id, connection_id, db_name, collection, kind, payload_json, ran_at, duration_ms)
      VALUES ('r', 'c1', 'd', 'c', 'find', x'01', ?, 1)`).run(now);
    tmp.db.prepare(`INSERT INTO recent_field_values (id, connection_id, db_name, collection, field, value, value_mac, val_type, last_used_at)
      VALUES ('v', 'c1', 'd', 'c', 'f', x'01', 'm', 'string', ?)`).run(now);
    tmp.db.prepare(`INSERT INTO audit_log (id, connection_id, db_name, collection, op, summary_json, outcome, ran_at, duration_ms)
      VALUES ('a', 'c1', 'd', 'c', 'deleteOne', x'01', 'ok', ?, 1)`).run(now);
    tmp.db.prepare(`INSERT INTO saved_queries (id, connection_id, db_name, collection, kind, name, payload_json, created_at, updated_at)
      VALUES ('s', 'c1', 'd', 'c', 'find', 'n', x'01', ?, ?)`).run(now, now);
    tmp.db.prepare(`INSERT INTO workspace_tabs (id, connection_id, kind, db_name, collection, state_json, position, opened_at)
      VALUES ('t', 'c1', 'collection', 'd', 'c', x'01', 0, ?)`).run(now);

    resetProtectedData(tmp.db, log());

    for (const table of ['recent_queries', 'recent_field_values', 'audit_log', 'saved_queries', 'workspace_tabs', 'column_keys']) {
      expect((tmp.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    }
    expect(tmp.db.prepare("SELECT id FROM connections WHERE id = 'c1'").get()).toBeDefined();
    expect(isVacuumPending(tmp.db)).toBe(false);

    const fresh = loadOrCreateColumnKeys(tmp.db, keychain, log());
    expect(fresh.keys.enc.equals(old.keys.enc)).toBe(false);
  });

  it('the dev reset empties every user table in place but keeps the column key', () => {
    const keychain = fakeKeychain({ available: true });
    const key = loadOrCreateColumnKeys(tmp.db, keychain, log());
    insertConnectionRow(tmp.db, 'c1');
    const now = new Date().toISOString();
    tmp.db.prepare(`INSERT INTO connection_secrets (connection_id, field, ciphertext, updated_at) VALUES ('c1', 'password', x'01', ?)`).run(now);
    tmp.db.prepare(`INSERT INTO reference_rules (id, connection_id, source_db, source_collection, source_field, target_db, target_collection, created_at, updated_at)
      VALUES ('rr', 'c1', 'd', 'c', 'f', 'd', 't', ?, ?)`).run(now, now);
    tmp.db.prepare(`INSERT INTO saved_queries (id, connection_id, db_name, collection, kind, name, payload_json, created_at, updated_at)
      VALUES ('s', 'c1', 'd', 'c', 'find', 'n', x'01', ?, ?)`).run(now, now);
    tmp.db.prepare(`INSERT INTO recent_field_values (id, connection_id, db_name, collection, field, value, value_mac, val_type, last_used_at)
      VALUES ('v', 'c1', 'd', 'c', 'f', x'01', 'm', 'string', ?)`).run(now);
    const appState = new AppStateService(new AppStateRepo(tmp.db));
    appState.set('ui.showSystemDbs', true);
    expect(appState.get('ui.showSystemDbs')).toBe(true);

    resetDatabaseInPlace(tmp.db, log());
    appState.reset();

    for (const table of ['connections', 'connection_secrets', 'reference_rules', 'saved_queries', 'recent_queries',
      'workspace_tabs', 'audit_log', 'recent_field_values', 'app_state']) {
      expect((tmp.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    }
    expect(appState.get('ui.showSystemDbs')).toBeNull();
    expect(isVacuumPending(tmp.db)).toBe(false);
    const kept = loadOrCreateColumnKeys(tmp.db, keychain, log());
    expect(kept.keys.enc.equals(key.keys.enc)).toBe(true);
  });
});
