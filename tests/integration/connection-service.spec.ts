import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import {
  ConnectionService,
  connectionReader,
} from '../../electron/mongo/ConnectionService';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { ConflictError, NotFoundError } from '../../electron/errors';
import type { ConnectionInput } from '@shared/types';
import { createTempDb, type TempDb } from '../helpers/db';
import { createSafeStorageMock } from '../helpers/safeStorageMock';

function validInput(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Test',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'localhost',
    port: 27017,
    authMech: 'none',
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
      serverSelectionTimeoutMs: 30_000,
      readPreference: 'primary',
      maxPoolSize: 100,
      directConnection: false,
    },
    ...overrides,
  };
}

describe('ConnectionService', () => {
  let tmp: TempDb;
  let repo: ConnectionRepo;
  let vault: SecretsVault;
  let pool: MongoPool;
  let svc: ConnectionService;
  let disconnectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = createTempDb();
    repo = new ConnectionRepo(tmp.db);
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    disconnectSpy = vi.spyOn(pool, 'disconnect').mockResolvedValue(undefined);
    svc = new ConnectionService({ repo, vault, pool });
  });

  afterEach(() => {
    tmp.cleanup();
    vi.restoreAllMocks();
  });

  it('create persists the row and password via vault', async () => {
    const conn = await svc.create(
      validInput({ authMech: 'scram256', authUsername: 'alice', password: 'hunter2' }),
    );
    expect(conn.id).toBeTruthy();
    expect(conn.hasPasswordStored).toBe(true);
    expect(vault.get(conn.id, 'password')).toBe('hunter2');
    expect(repo.findById(conn.id)).not.toBeNull();
  });

  it('create returns CONFLICT on duplicate name', async () => {
    await svc.create(validInput({ name: 'Dup' }));
    await expect(svc.create(validInput({ name: 'Dup' }))).rejects.toBeInstanceOf(ConflictError);
  });

  it('get throws NotFoundError for unknown id', () => {
    expect(() => svc.get('does-not-exist')).toThrow(NotFoundError);
  });

  it('update with new password replaces stored secret', async () => {
    const c = await svc.create(
      validInput({ authMech: 'scram256', authUsername: 'alice', password: 'first' }),
    );
    await svc.update(c.id, { password: 'second' });
    expect(vault.get(c.id, 'password')).toBe('second');
  });

  it('update with clearPassword removes the stored secret', async () => {
    const c = await svc.create(
      validInput({ authMech: 'scram256', authUsername: 'alice', password: 'x' }),
    );
    await svc.update(c.id, { clearPassword: true });
    expect(vault.has(c.id, 'password')).toBe(false);
  });

  it('update with color-only change does NOT disconnect pool', async () => {
    const c = await svc.create(validInput());
    disconnectSpy.mockClear();
    await svc.update(c.id, { color: '#1A5068' });
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it('update with host change DOES disconnect pool', async () => {
    const c = await svc.create(validInput());
    disconnectSpy.mockClear();
    await svc.update(c.id, { host: 'other.example.com' });
    expect(disconnectSpy).toHaveBeenCalledWith(c.id);
  });

  it('update renaming to an existing name returns CONFLICT', async () => {
    const a = await svc.create(validInput({ name: 'A' }));
    await svc.create(validInput({ name: 'B' }));
    await expect(svc.update(a.id, { name: 'B' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('renaming a read-only connection does not silently clear the flag', async () => {
    const c = await svc.create(validInput({ readOnly: true }));
    expect(c.readOnly).toBe(true);
    const renamed = await svc.update(c.id, { name: 'Renamed' });
    expect(renamed.readOnly).toBe(true);
    expect(svc.get(c.id).readOnly).toBe(true);
  });

  it('update can flip readOnly on and off independently of other fields', async () => {
    const c = await svc.create(validInput());
    expect(c.readOnly).toBe(false);
    const on = await svc.update(c.id, { readOnly: true });
    expect(on.readOnly).toBe(true);
    const off = await svc.update(c.id, { readOnly: false });
    expect(off.readOnly).toBe(false);
  });

  it('announces a connection turning read-only, so running scripts can be stopped', async () => {
    const c = await svc.create(validInput());
    const heard: string[] = [];
    pool.on('read-only-enabled', (id: string) => heard.push(id));
    await svc.update(c.id, { color: '#1A5068' });
    expect(heard).toEqual([]);
    await svc.update(c.id, { readOnly: true });
    expect(heard).toEqual([c.id]);
    // Already read-only, and turning it off, are not news to a running script.
    await svc.update(c.id, { readOnly: true });
    await svc.update(c.id, { readOnly: false });
    expect(heard).toEqual([c.id]);
  });

  it('update with readOnly-only change does NOT disconnect the pool', async () => {
    const c = await svc.create(validInput());
    disconnectSpy.mockClear();
    await svc.update(c.id, { readOnly: true });
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it('delete removes the row and cascades dependents', async () => {
    const c = await svc.create(
      validInput({ authMech: 'scram256', authUsername: 'alice', password: 'x' }),
    );
    await svc.delete(c.id);
    expect(repo.findById(c.id)).toBeNull();
    expect(vault.has(c.id, 'password')).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledWith(c.id);
  });

  it('delete of missing id throws NotFoundError', async () => {
    await expect(svc.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('list returns summaries ordered by last_used_at DESC', async () => {
    const a = await svc.create(validInput({ name: 'A' }));
    const b = await svc.create(validInput({ name: 'B' }));
    await svc.create(validInput({ name: 'C' }));

    repo.touchLastUsed(a.id);
    // simulate b touched earlier
    tmp.db
      .prepare('UPDATE connections SET last_used_at = ? WHERE id = ?')
      .run('2026-04-20T00:00:00.000Z', b.id);

    const list = svc.list();
    const order = list.map((x) => x.name);
    expect(order[0]).toBe('A');
    expect(order[1]).toBe('B');
    expect(order[2]).toBe('C');
  });

  it("list carries each connection's default database, undefined when unset", async () => {
    await svc.create(validInput({ name: 'With', defaultDb: 'smoke' }));
    await svc.create(validInput({ name: 'Without' }));

    const byName = new Map(svc.list().map((s) => [s.name, s]));
    expect(byName.get('With')!.defaultDb).toBe('smoke');
    expect(byName.get('Without')!.defaultDb).toBeUndefined();
  });

  it('touchUsed updates last_used_at', async () => {
    const c = await svc.create(validInput());
    expect(repo.findById(c.id)!.last_used_at).toBeNull();
    svc.touchUsed(c.id);
    expect(repo.findById(c.id)!.last_used_at).not.toBeNull();
  });

  it('parseUri returns a partial input', () => {
    const { input } = svc.parseUri('mongodb://localhost:27017/');
    expect(input.host).toBe('localhost');
    expect(input.port).toBe(27017);
  });

  it('rolls back connection row if secret persistence fails', async () => {
    const badVault = new SecretsVault(tmp.db, createSafeStorageMock({ available: false }));
    const brokenSvc = new ConnectionService({ repo, vault: badVault, pool });
    await expect(
      brokenSvc.create(
        validInput({ authMech: 'scram256', authUsername: 'a', password: 'p' }),
      ),
    ).rejects.toThrow();
    // No row should remain from the aborted create.
    expect(repo.list().length).toBe(0);
  });
  it('update leaves the row unchanged when the vault fails', async () => {
    const c = await svc.create(validInput());
    const before = repo.findById(c.id);
    const badVault = new SecretsVault(tmp.db, createSafeStorageMock({ available: false }));
    const brokenSvc = new ConnectionService({ repo, vault: badVault, pool });
    await expect(
      brokenSvc.update(c.id, { host: 'changed', password: 'p' }),
    ).rejects.toThrow();
    expect(repo.findById(c.id)).toEqual(before);
  });
});
