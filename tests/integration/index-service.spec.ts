import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Collection, MongoClient } from 'mongodb';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { IndexService } from '../../electron/mongo/IndexService';
import { ejsonParse } from '../../electron/mongo/ejson';
import { Double } from 'bson';
import { ADMIN_LONG_TIMEOUT_MS, STATS_TIMEOUT_MS } from '../../electron/mongo/timeouts';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import {
  getSharedMongoUri,
  uriToHostPort,
  makeConnection,
  makeReader,
} from '../helpers/mongo';

const DB = 'idx_test';
const COLL = 'people';

async function seedIndexes(uri: string): Promise<void> {
  const c = new MongoClient(uri);
  try {
    await c.connect();
    const coll = c.db(DB).collection(COLL);
    await coll.insertOne({ email: 'a@example.com', age: 30, createdAt: new Date(), status: 'active' });
    await coll.createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
    await coll.createIndex(
      { createdAt: -1 },
      { expireAfterSeconds: 86400, name: 'createdAt_ttl' },
    );
    await coll.createIndex(
      { status: 1, age: -1 },
      {
        name: 'active_only',
        partialFilterExpression: { status: { $eq: 'active' } },
      },
    );
  } finally {
    await c.close();
  }
}

describe('IndexService.list', () => {
  let hp: { host: string; port: number };
  let tmp: TempDb;
  let pool: MongoPool;
  let svc: IndexService;
  const connId = 'conn-idx';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    await seedIndexes(getSharedMongoUri());
  });

  afterEach(async () => {
    await pool?.disconnectAll();
    tmp?.cleanup();
  });

  function setup(): void {
    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: DB });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new IndexService(pool);
  }

  it('returns _id_ plus every seeded index with populated metadata', async () => {
    setup();
    const indexes = await svc.list({ connectionId: connId, dbName: DB, collection: COLL });

    expect(indexes.map((i) => i.name).sort()).toEqual([
      '_id_',
      'active_only',
      'createdAt_ttl',
      'email_unique',
    ]);

    const idIdx = indexes.find((i) => i.name === '_id_')!;
    expect(idIdx.isIdIndex).toBe(true);

    const unique = indexes.find((i) => i.name === 'email_unique')!;
    expect(unique.unique).toBe(true);
    expect(unique.key).toEqual([{ field: 'email', direction: 1 }]);

    const ttl = indexes.find((i) => i.name === 'createdAt_ttl')!;
    expect(ttl.expireAfterSeconds).toBe(86400);
    expect(ttl.key).toEqual([{ field: 'createdAt', direction: -1 }]);

    const partial = indexes.find((i) => i.name === 'active_only')!;
    expect(partial.key).toEqual([
      { field: 'status', direction: 1 },
      { field: 'age', direction: -1 },
    ]);
    expect(partial.partialFilterExpression).toBeTruthy();
    expect(JSON.parse(partial.partialFilterExpression!)).toEqual({
      status: { $eq: 'active' },
    });
  });

  it('shows a Double past 2^53 in a partialFilterExpression as a Double, not a rounded Long', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'double_filter',
      fields: [{ field: 'n', direction: 1 }],
      options: {
        name: 'n_big',
        partialFilterExpression: '{"n":{"$gt":{"$numberDouble":"1760000000000000768"}}}',
      },
    });
    const indexes = await svc.list({ connectionId: connId, dbName: DB, collection: 'double_filter' });
    const shown = indexes.find((i) => i.name === 'n_big')!.partialFilterExpression!;
    expect(JSON.parse(shown)).toEqual({ n: { $gt: { $numberDouble: '1760000000000000768.0' } } });
    const bound = ejsonParse<{ n: { $gt: Double } }>(shown).n.$gt;
    expect(bound).toBeInstanceOf(Double);
    expect(bound.valueOf()).toBe(1760000000000000768);
  });

  it('exposes sizeBytes from $collStats when authorized', async () => {
    setup();
    const indexes = await svc.list({ connectionId: connId, dbName: DB, collection: COLL });
    const sized = indexes.filter((i) => typeof i.sizeBytes === 'number');
    expect(sized.length).toBeGreaterThan(0);
  });

  it('create() round-trips and surfaces a CONFLICT on duplicate', async () => {
    setup();
    const created = await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'create_target',
      fields: [{ field: 'username', direction: 1 }],
      options: { unique: true, name: 'username_unique' },
    });
    expect(created.name).toBe('username_unique');

    const after = await svc.list({ connectionId: connId, dbName: DB, collection: 'create_target' });
    expect(after.find((i) => i.name === 'username_unique')?.unique).toBe(true);

    let conflictCode: string | undefined;
    try {
      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'create_target',
        fields: [{ field: 'username', direction: 1 }],
        options: { unique: true, name: 'username_unique_alt' },
      });
    } catch (err) {
      conflictCode = (err as { code?: string }).code;
    }
    expect(conflictCode).toBe('CONFLICT');
  });

  it('drop() removes a non-_id index and refuses _id_ with VALIDATION', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'drop_target',
      fields: [{ field: 'a', direction: 1 }],
      options: { name: 'a_1' },
    });

    const dropped = await svc.drop({
      connectionId: connId,
      dbName: DB,
      collection: 'drop_target',
      name: 'a_1',
    });
    expect(dropped.dropped).toBe(true);

    const remaining = await svc.list({ connectionId: connId, dbName: DB, collection: 'drop_target' });
    expect(remaining.some((i) => i.name === 'a_1')).toBe(false);

    let code: string | undefined;
    try {
      await svc.drop({
        connectionId: connId,
        dbName: DB,
        collection: 'drop_target',
        name: '_id_',
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('VALIDATION');
  });

  it('rejects TTL on a multi-field key with VALIDATION', async () => {
    setup();
    let code: string | undefined;
    try {
      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'ttl_validate',
        fields: [
          { field: 'a', direction: 1 },
          { field: 'b', direction: -1 },
        ],
        options: { expireAfterSeconds: 600 },
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('VALIDATION');
  });

  it('falls back gracefully when $indexStats throws Unauthorized', async () => {
    setup();
    const original = Collection.prototype.aggregate;
    const spy = vi
      .spyOn(Collection.prototype, 'aggregate')
      .mockImplementation(function aggregateStub(this: Collection, pipeline, opts) {
        const first = (pipeline as unknown[])?.[0] as Record<string, unknown> | undefined;
        if (first && '$indexStats' in first) {
          const err = Object.assign(new Error('not authorized'), {
            code: 13,
            codeName: 'Unauthorized',
          });
          return {
            toArray: () => Promise.reject(err),
            next: () => Promise.reject(err),
          } as unknown as ReturnType<typeof original>;
        }
        return original.call(this, pipeline, opts);
      });

    try {
      const indexes = await svc.list({ connectionId: connId, dbName: DB, collection: COLL });
      expect(indexes.length).toBeGreaterThan(0);
      expect(indexes.every((i) => i.usage === undefined)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // create/drop take a write grant (which refuses first); list() is a
  // read and must stay unguarded. Registers a second,
  // read-only connection against the same shared server so each test proves
  // both the rejection AND that the identical call still works on the
  // writable connection (regression guard).
  describe('read-only connection guard', () => {
    const rwConnId = 'idx-guard-rw';
    const roConnId = 'idx-guard-ro';

    function setupGuard(): void {
      tmp = createTempDb();
      const vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const rwConn = makeConnection(rwConnId, hp, { defaultDb: DB });
      const roConn = makeConnection(roConnId, hp, { defaultDb: DB, readOnly: true });
      pool = new MongoPool({ repo: makeReader([rwConn, roConn]), vault });
      svc = new IndexService(pool);
    }

    it('list still works on the read-only connection', async () => {
      setupGuard();
      const indexes = await svc.list({ connectionId: roConnId, dbName: DB, collection: COLL });
      expect(indexes.map((i) => i.name).sort()).toEqual([
        '_id_',
        'active_only',
        'createdAt_ttl',
        'email_unique',
      ]);
    });

    it('create rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      // create() rejects before ever touching the driver, so the collection
      // never gets implicitly created. Seed it first (via the writable
      // connection) so the post-rejection list() call targets a real
      // namespace instead of throwing NamespaceNotFound.
      const seedDb = await pool.write(rwConnId).db(DB);
      await seedDb.collection('ro_guard_create_target').insertOne({ seed: true });

      await expect(
        svc.create({
          connectionId: roConnId,
          dbName: DB,
          collection: 'ro_guard_create_target',
          fields: [{ field: 'ro_field', direction: 1 }],
          options: { name: 'ro_guard_idx' },
        }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      const afterReject = await svc.list({
        connectionId: rwConnId,
        dbName: DB,
        collection: 'ro_guard_create_target',
      });
      expect(afterReject.find((i) => i.name === 'ro_guard_idx')).toBeUndefined();

      const created = await svc.create({
        connectionId: rwConnId,
        dbName: DB,
        collection: 'ro_guard_create_target',
        fields: [{ field: 'ro_field', direction: 1 }],
        options: { name: 'ro_guard_idx' },
      });
      expect(created.name).toBe('ro_guard_idx');
    });

    it('drop rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      await svc.create({
        connectionId: rwConnId,
        dbName: DB,
        collection: 'ro_guard_drop_target',
        fields: [{ field: 'b', direction: 1 }],
        options: { name: 'b_1' },
      });

      await expect(
        svc.drop({ connectionId: roConnId, dbName: DB, collection: 'ro_guard_drop_target', name: 'b_1' }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      let remaining = await svc.list({ connectionId: rwConnId, dbName: DB, collection: 'ro_guard_drop_target' });
      expect(remaining.some((i) => i.name === 'b_1')).toBe(true);

      const dropped = await svc.drop({
        connectionId: rwConnId,
        dbName: DB,
        collection: 'ro_guard_drop_target',
        name: 'b_1',
      });
      expect(dropped.dropped).toBe(true);
      remaining = await svc.list({ connectionId: rwConnId, dbName: DB, collection: 'ro_guard_drop_target' });
      expect(remaining.some((i) => i.name === 'b_1')).toBe(false);
    });
  });

  // create()/drop() used to send no maxTimeMS at all. create() gets the
  // admin-long budget rather than the stats one — see the comment at the
  // call site for the empirical reasoning — drop() gets the stats budget
  // like every other catalog op.
  describe('create/drop carry maxTimeMS', () => {
    it('create sends ADMIN_LONG_TIMEOUT_MS and drop sends STATS_TIMEOUT_MS', async () => {
      setup();
      const createSpy = vi.spyOn(Collection.prototype, 'createIndex');
      const dropSpy = vi.spyOn(Collection.prototype, 'dropIndex');

      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'maxtimems_target',
        fields: [{ field: 'z', direction: 1 }],
        options: { name: 'z_1' },
      });
      await svc.drop({
        connectionId: connId,
        dbName: DB,
        collection: 'maxtimems_target',
        name: 'z_1',
      });

      expect(
        (createSpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS,
      ).toBe(ADMIN_LONG_TIMEOUT_MS);
      expect(
        (dropSpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS,
      ).toBe(STATS_TIMEOUT_MS);

      createSpy.mockRestore();
      dropSpy.mockRestore();
    });
  });
});

/**
 * The other half of the ordering the guarded handle has to preserve: local
 * validation must still run *before* anything touches the network.
 *
 * `pool.write()` refuses read-only synchronously and connects nothing; the
 * grant's `.db()` is what connects. Hoist that connect above the local checks
 * and an invalid request against an unreachable server starts reporting the
 * connection failure instead of the input error — the useful message buried
 * under an incidental one.
 */
describe('IndexService — local validation precedes any connection attempt', () => {
  const unreachableId = 'idx-unreachable-conn';
  let tmp: TempDb;
  let pool: MongoPool;
  let svc: IndexService;

  beforeAll(() => {
    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    // Port 1 is reserved and refuses immediately, so a regression fails fast
    // rather than hanging out the server-selection timeout.
    const conn = makeConnection(unreachableId, { host: '127.0.0.1', port: 1 }, {
      defaultDb: 'never_reached',
    });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new IndexService(pool);
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('drop reports VALIDATION for the _id_ index without attempting to connect', async () => {
    const connect = vi.spyOn(pool, 'connect');
    await expect(
      svc.drop({ connectionId: unreachableId, dbName: 'd', collection: 'c', name: '_id_' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('create reports VALIDATION for an empty field list without attempting to connect', async () => {
    const connect = vi.spyOn(pool, 'connect');
    await expect(
      svc.create({ connectionId: unreachableId, dbName: 'd', collection: 'c', fields: [], options: {} }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(connect).not.toHaveBeenCalled();
  });
});
