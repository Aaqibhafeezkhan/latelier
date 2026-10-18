import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { IPC_CHANNELS } from '@shared/ipc';
import type { IndexInfo } from '@shared/types';
import { createRouter } from '../../electron/ipc/router';
import { registerIndexChannels } from '../../electron/ipc/handlers/indexes';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { IndexService } from '../../electron/mongo/IndexService';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { createIpcShim } from '../helpers/ipcShim';
import { expectSchemaReject } from '../helpers/ipcAssert';
import { testSenderCheck } from '../helpers/ipcSender';
import {
  getSharedMongoUri,
  makeConnection,
  makeReader,
  uriToHostPort,
} from '../helpers/mongo';

/**
 * Drives `index:list` through the real router, zod validator, `IndexService`,
 * `MongoPool` and a real mongod. `index:create` and `index:drop` are driven in
 * audit-handlers.spec.ts and not repeated here.
 */
const DB = 'index_router_shop';
const COLL = 'people';
const CONN = 'index-conn';

describe('index:list via router', () => {
  let tmp: TempDb;
  let pool: MongoPool;
  let svc: IndexService;
  const shim = createIpcShim();
  const target = (overrides: Record<string, unknown> = {}) => ({
    connectionId: CONN,
    dbName: DB,
    collection: COLL,
    ...overrides,
  });

  beforeAll(async () => {
    const seed = new MongoClient(getSharedMongoUri());
    try {
      await seed.connect();
      const people = seed.db(DB).collection(COLL);
      // The document makes the collection exist; listing indexes on a missing one is a different answer.
      await people.insertOne({ email: 'a@example.com', status: 'active', age: 30 });
      await people.createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
      await people.createIndex({ status: 1, age: -1 }, { name: 'status_age' });
    } finally {
      await seed.close();
    }

    tmp = createTempDb();
    pool = new MongoPool({
      repo: makeReader([makeConnection(CONN, uriToHostPort(getSharedMongoUri()), { defaultDb: DB })]),
      vault: new SecretsVault(tmp.db, createSafeStorageMock()),
    });
    svc = new IndexService(pool);
    registerIndexChannels(createRouter(shim.ipcMain, testSenderCheck), svc);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('lists the implicit _id_ index and the seeded ones with their key order and flags', async () => {
    const env = await shim.invoke<IndexInfo[]>(IPC_CHANNELS.indexList, target());
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    const byName = new Map(env.data.map((i) => [i.name, i]));
    expect([...byName.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      '_id_',
      'email_unique',
      'status_age',
    ]);
    expect(byName.get('_id_')).toMatchObject({ isIdIndex: true });
    expect(byName.get('email_unique')).toMatchObject({
      isIdIndex: false,
      unique: true,
      key: [{ field: 'email', direction: 1 }],
    });
    expect(byName.get('status_age')?.key).toEqual([
      { field: 'status', direction: 1 },
      { field: 'age', direction: -1 },
    ]);
  });

  it.each([
    ['a missing collection', { collection: undefined }, 'collection'],
    ['an empty collection', { collection: '' }, 'collection'],
    ['a missing dbName', { dbName: undefined }, 'dbName'],
    ['an empty dbName', { dbName: '' }, 'dbName'],
    ['a missing connectionId', { connectionId: undefined }, 'connectionId'],
    ['an empty connectionId', { connectionId: '' }, 'connectionId'],
  ])('rejects %s at the schema without calling the service', async (_what, overrides, path) => {
    const list = vi.spyOn(svc, 'list');
    expectSchemaReject(await shim.invoke(IPC_CHANNELS.indexList, target(overrides)), path);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects no payload at all with VALIDATION without calling the service', async () => {
    const list = vi.spyOn(svc, 'list');
    const env = await shim.invoke(IPC_CHANNELS.indexList);
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('VALIDATION');
    expect(list).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for an unknown connection', async () => {
    const env = await shim.invoke(IPC_CHANNELS.indexList, target({ connectionId: 'no-such-conn' }));
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('NOT_FOUND');
  });
});
