import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CollectionDetails, CollectionInfo, DbInfo } from '@shared/ipc';
import { createRouter } from '../../electron/ipc/router';
import { registerMetaChannels } from '../../electron/ipc/handlers/meta';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { MetaService } from '../../electron/mongo/MetaService';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { createIpcShim } from '../helpers/ipcShim';
import { testSenderCheck } from '../helpers/ipcSender';
import { getSharedMongoUri, makeConnection, makeReader, uriToHostPort } from '../helpers/mongo';

/**
 * Drives `meta:*` through the real router, zod validators, `MetaService`,
 * `MongoPool` and a real mongod. The service spec skips the router and the
 * registration spec stubs the service, so neither proves that the schemas
 * accept what the renderer sends or that a failure crosses as a typed code.
 */
const DB = 'meta_router_shop';
const CONN = 'meta-conn';

describe('meta:* channels via router', () => {
  let tmp: TempDb;
  let pool: MongoPool;
  const shim = createIpcShim();

  beforeAll(async () => {
    const seed = new MongoClient(getSharedMongoUri());
    try {
      await seed.connect();
      await seed
        .db(DB)
        .collection('products')
        .insertMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
      await seed.db(DB).collection('orders').insertOne({ total: 1 });
    } finally {
      await seed.close();
    }

    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(CONN, uriToHostPort(getSharedMongoUri()), { defaultDb: DB });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    registerMetaChannels(createRouter(shim.ipcMain, testSenderCheck), new MetaService(pool));
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  describe('meta:listDatabases', () => {
    it('returns the seeded database and hides the system ones', async () => {
      const env = await shim.invoke<DbInfo[]>(IPC_CHANNELS.metaListDatabases, {
        connectionId: CONN,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      const names = env.data.map((d) => d.name);
      expect(names).toContain(DB);
      for (const sys of ['admin', 'local', 'config']) expect(names).not.toContain(sys);
      const shop = env.data.find((d) => d.name === DB);
      expect(shop).toMatchObject({ empty: false });
      expect(typeof shop?.sizeOnDisk).toBe('number');
    });

    it('includes the system databases with includeSystem: true', async () => {
      const env = await shim.invoke<DbInfo[]>(IPC_CHANNELS.metaListDatabases, {
        connectionId: CONN,
        includeSystem: true,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((d) => d.name)).toContain('admin');
    });

    it.each([
      ['an empty payload', {}],
      ['an empty connectionId', { connectionId: '' }],
      ['a non-boolean includeSystem', { connectionId: CONN, includeSystem: 'yes' }],
      ['no payload at all', undefined],
    ])('rejects %s with VALIDATION', async (_what, payload) => {
      const env = await shim.invoke(IPC_CHANNELS.metaListDatabases, payload);
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('answers NOT_FOUND for an unknown connection', async () => {
      const env = await shim.invoke(IPC_CHANNELS.metaListDatabases, {
        connectionId: 'no-such-conn',
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });

  describe('meta:listCollections', () => {
    it('returns CollectionInfo for each seeded collection', async () => {
      const env = await shim.invoke<CollectionInfo[]>(IPC_CHANNELS.metaListCollections, {
        connectionId: CONN,
        dbName: DB,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((c) => c.name).sort((a, b) => a.localeCompare(b))).toEqual([
        'orders',
        'products',
      ]);
      const products = env.data.find((c) => c.name === 'products');
      expect(products).toMatchObject({
        type: 'collection',
        documentCount: 3,
        capped: false,
      });
      expect(typeof products?.sizeBytes).toBe('number');
      expect(typeof products?.indexCount).toBe('number');
    });

    it.each([
      ['a missing dbName', { connectionId: CONN }],
      ['an empty dbName', { connectionId: CONN, dbName: '' }],
      ['a missing connectionId', { dbName: DB }],
    ])('rejects %s with VALIDATION', async (_what, payload) => {
      const env = await shim.invoke(IPC_CHANNELS.metaListCollections, payload);
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('answers NOT_FOUND for an unknown connection', async () => {
      const env = await shim.invoke(IPC_CHANNELS.metaListCollections, {
        connectionId: 'no-such-conn',
        dbName: DB,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });

  describe('meta:collectionDetails', () => {
    const target = { connectionId: CONN, dbName: DB, collection: 'products' };

    it('returns the details of a seeded collection', async () => {
      const env = await shim.invoke<CollectionDetails>(IPC_CHANNELS.metaCollectionDetails, target);
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toMatchObject({ name: 'products', type: 'collection', capped: false });
      expect(env.data.stats?.documentCount).toBe(3);
    });

    it.each([
      ['an empty collection', { ...target, collection: '' }],
      ['a missing dbName', { connectionId: CONN, collection: 'products' }],
      ['a missing connectionId', { dbName: DB, collection: 'products' }],
    ])('rejects %s with VALIDATION', async (_what, payload) => {
      const env = await shim.invoke(IPC_CHANNELS.metaCollectionDetails, payload);
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('answers NOT_FOUND for a collection that does not exist', async () => {
      const env = await shim.invoke(IPC_CHANNELS.metaCollectionDetails, {
        ...target,
        collection: 'never_created',
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('answers NOT_FOUND for an unknown connection', async () => {
      const env = await shim.invoke(IPC_CHANNELS.metaCollectionDetails, {
        ...target,
        connectionId: 'no-such-conn',
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });

  describe('meta:sampleSchema', () => {
    const target = { connectionId: CONN, dbName: DB, collection: 'products' };

    it('returns sampled documents as an array', async () => {
      const env = await shim.invoke<{ docs: unknown[] }>(
        IPC_CHANNELS.metaSampleSchema,
        target,
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(Array.isArray(env.data.docs)).toBe(true);
      expect(env.data.docs.length).toBeGreaterThan(0);
      expect(env.data.docs[0]).toMatchObject({ name: expect.any(String) });
    });

    it.each([1, 200])('accepts the size bound %i', async (size) => {
      const env = await shim.invoke<{ docs: unknown[] }>(IPC_CHANNELS.metaSampleSchema, {
        ...target,
        size,
      });
      expect(env.ok).toBe(true);
    });

    it.each([0, 201, 1.5, -1])('rejects size %s with VALIDATION', async (size) => {
      const env = await shim.invoke(IPC_CHANNELS.metaSampleSchema, { ...target, size });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('rejects a missing collection with VALIDATION', async () => {
      const env = await shim.invoke(IPC_CHANNELS.metaSampleSchema, {
        connectionId: CONN,
        dbName: DB,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('answers NOT_FOUND for an unknown connection', async () => {
      const env = await shim.invoke(IPC_CHANNELS.metaSampleSchema, {
        ...target,
        connectionId: 'no-such-conn',
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('returns an empty sample for a collection that does not exist', async () => {
      const env = await shim.invoke<{ docs: unknown[] }>(IPC_CHANNELS.metaSampleSchema, {
        ...target,
        collection: 'never_created',
      });
      expect(env).toEqual({ ok: true, data: { docs: [] } });
    });
  });
});

// A dedicated server, not the shared one: `failCommand` needs
// `enableTestCommands`, which nothing else wants turned on. `sampleSchema`
// swallows a failed aggregate and answers an empty sample so one hostile
// source does not sink the suggestions of the others; an absent namespace
// never reaches that catch, only a command that actually errors does.
describe('meta:sampleSchema fails open when the aggregate errors', () => {
  let server: MongoMemoryServer;
  let tmp: TempDb;
  let pool: MongoPool;
  const shim = createIpcShim();
  const target = { connectionId: CONN, dbName: DB, collection: 'products' };

  beforeAll(async () => {
    server = await MongoMemoryServer.create({
      instance: { args: ['--setParameter', 'enableTestCommands=1'] },
    });
    const seed = new MongoClient(server.getUri());
    try {
      await seed.connect();
      await seed.db(DB).collection('products').insertMany([{ name: 'a' }, { name: 'b' }]);
    } finally {
      await seed.close();
    }

    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(CONN, uriToHostPort(server.getUri()), { defaultDb: DB });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    registerMetaChannels(createRouter(shim.ipcMain, testSenderCheck), new MetaService(pool));
  }, 60_000);

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
    await server.stop();
  });

  it('answers an empty sample, not an error, when the server rejects the aggregate', async () => {
    const client = await pool.readClient(CONN);
    await client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      // 50 is MaxTimeMSExpired, the failure a slow deployment produces.
      data: { failCommands: ['aggregate'], errorCode: 50 },
    });

    const failed = await shim.invoke<{ docs: unknown[] }>(IPC_CHANNELS.metaSampleSchema, target);
    expect(failed).toEqual({ ok: true, data: { docs: [] } });

    // The failpoint fired once and is spent: the same call now samples the
    // seeded documents, so the empty answer above was the catch and not an
    // empty collection.
    const healthy = await shim.invoke<{ docs: unknown[] }>(IPC_CHANNELS.metaSampleSchema, target);
    expect(healthy.ok).toBe(true);
    if (!healthy.ok) return;
    expect(healthy.data.docs.length).toBeGreaterThan(0);
  });
});
