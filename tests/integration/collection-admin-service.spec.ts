import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Db, MongoClient } from 'mongodb';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { CollectionAdminService } from '../../electron/mongo/CollectionAdminService';
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

const DB = 'coll_admin_test';

describe('CollectionAdminService', () => {
  let hp: { host: string; port: number };
  let tmp: TempDb;
  let pool: MongoPool;
  let svc: CollectionAdminService;
  const connId = 'conn-coll-admin';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
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
    svc = new CollectionAdminService(pool);
  }

  async function listNames(dbName: string): Promise<string[]> {
    const client = new MongoClient(getSharedMongoUri());
    try {
      await client.connect();
      const specs = await client.db(dbName).listCollections({}, { nameOnly: true }).toArray();
      return specs.map((s) => s.name);
    } finally {
      await client.close();
    }
  }

  it('creates a plain collection', async () => {
    setup();
    const res = await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'plain_coll',
      options: {},
    });
    expect(res.name).toBe('plain_coll');
    expect(await listNames(DB)).toContain('plain_coll');
  });

  it('creates a capped collection with the requested options', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'capped_coll',
      options: { capped: true, size: 100_000, max: 10 },
    });
    const client = new MongoClient(getSharedMongoUri());
    try {
      await client.connect();
      const specs = await client.db(DB).listCollections({ name: 'capped_coll' }).toArray();
      const spec = specs[0];
      // `listCollections` types its rows as full-spec-or-name-only; only the
      // full spec carries `options`.
      if (!spec || !('options' in spec)) throw new Error('expected a full collection spec');
      expect(spec.options?.capped).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('creates a timeseries collection', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'ts_coll',
      options: { timeseries: { timeField: 'ts' } },
    });
    const client = new MongoClient(getSharedMongoUri());
    try {
      await client.connect();
      const specs = await client.db(DB).listCollections({ name: 'ts_coll' }).toArray();
      expect(specs[0]?.type).toBe('timeseries');
    } finally {
      await client.close();
    }
  });

  it('creates a collection with a validator', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'validated_coll',
      options: {
        validator: JSON.stringify({ $jsonSchema: { bsonType: 'object', required: ['name'] } }),
      },
    });
    const client = new MongoClient(getSharedMongoUri());
    try {
      await client.connect();
      const specs = await client.db(DB).listCollections({ name: 'validated_coll' }).toArray();
      const spec = specs[0];
      // `listCollections` types its rows as full-spec-or-name-only; only the
      // full spec carries `options`.
      if (!spec || !('options' in spec)) throw new Error('expected a full collection spec');
      expect(spec.options?.validator).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it('implicitly creates the database when it does not exist yet', async () => {
    setup();
    const freshDb = 'coll_admin_fresh_db';
    await svc.create({
      connectionId: connId,
      dbName: freshDb,
      collection: 'first_coll',
      options: {},
    });
    expect(await listNames(freshDb)).toContain('first_coll');

    // Clean up the implicitly-created DB so it doesn't leak into other tests.
    const client = new MongoClient(getSharedMongoUri());
    try {
      await client.connect();
      await client.db(freshDb).dropDatabase();
    } finally {
      await client.close();
    }
  });

  it('creating an existing name throws CONFLICT', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'dup_coll',
      options: {},
    });

    let code: string | undefined;
    try {
      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'dup_coll',
        options: { capped: true, size: 1000 },
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('CONFLICT');
  });

  it('creating an existing name with identical (default) options still throws CONFLICT', async () => {
    // Regression test for the listCollections pre-check in
    // CollectionAdminService.create: the driver's own createCollection only
    // throws NamespaceExists when the *second* call's options differ from
    // the first. When both calls use identical (here: default/empty)
    // options, db.createCollection silently no-ops instead of throwing —
    // exactly the "New collection" happy path a user would hit retyping an
    // existing name. Without the pre-check this call would resolve
    // successfully with no error at all.
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'dup_identical_opts',
      options: {},
    });

    let code: string | undefined;
    try {
      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'dup_identical_opts',
        options: {},
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('CONFLICT');
  });

  it('drops an existing collection', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'drop_me',
      options: {},
    });
    const res = await svc.drop({ connectionId: connId, dbName: DB, collection: 'drop_me' });
    expect(res.dropped).toBe(true);
    expect(await listNames(DB)).not.toContain('drop_me');
  });

  it('drop on a missing collection does not throw and returns a boolean', async () => {
    setup();
    const res = await svc.drop({
      connectionId: connId,
      dbName: DB,
      collection: 'never_existed',
    });
    expect(typeof res.dropped).toBe('boolean');
  });

  it('renames a collection within the same database', async () => {
    setup();
    await svc.create({
      connectionId: connId,
      dbName: DB,
      collection: 'rename_src',
      options: {},
    });
    const res = await svc.rename({
      connectionId: connId,
      dbName: DB,
      collection: 'rename_src',
      newName: 'rename_dst',
    });
    expect(res.name).toBe('rename_dst');
    const names = await listNames(DB);
    expect(names).toContain('rename_dst');
    expect(names).not.toContain('rename_src');
  });

  it('rename onto an existing target throws CONFLICT', async () => {
    setup();
    await svc.create({ connectionId: connId, dbName: DB, collection: 'rename_a', options: {} });
    await svc.create({ connectionId: connId, dbName: DB, collection: 'rename_b', options: {} });

    let code: string | undefined;
    try {
      await svc.rename({
        connectionId: connId,
        dbName: DB,
        collection: 'rename_a',
        newName: 'rename_b',
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('CONFLICT');
  });

  it('rename of a missing source throws NOT_FOUND', async () => {
    setup();
    let code: string | undefined;
    try {
      await svc.rename({
        connectionId: connId,
        dbName: DB,
        collection: 'does_not_exist',
        newName: 'whatever',
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('NOT_FOUND');
  });

  it('drops the database (all collections gone)', async () => {
    setup();
    const dropDbName = 'coll_admin_drop_db';
    await svc.create({
      connectionId: connId,
      dbName: dropDbName,
      collection: 'seed',
      options: {},
    });
    expect(await listNames(dropDbName)).toContain('seed');

    const res = await svc.dropDatabase({ connectionId: connId, dbName: dropDbName });
    expect(res.dropped).toBe(true);

    const client = new MongoClient(getSharedMongoUri());
    try {
      await client.connect();
      const dbs = await client.db('admin').admin().listDatabases();
      expect(dbs.databases.map((d) => d.name)).not.toContain(dropDbName);
    } finally {
      await client.close();
    }
  });

  // write methods take a write grant (which refuses first). Registers a
  // second, read-only connection against the same shared
  // server so each test proves both the rejection AND that the identical
  // call still works on the writable connection (regression guard).
  describe('read-only connection guard', () => {
    const rwConnId = 'coll-admin-guard-rw';
    const roConnId = 'coll-admin-guard-ro';

    function setupGuard(): void {
      tmp = createTempDb();
      const vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const rwConn = makeConnection(rwConnId, hp, { defaultDb: DB });
      const roConn = makeConnection(roConnId, hp, { defaultDb: DB, readOnly: true });
      pool = new MongoPool({ repo: makeReader([rwConn, roConn]), vault });
      svc = new CollectionAdminService(pool);
    }

    it('create rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      await expect(
        svc.create({ connectionId: roConnId, dbName: DB, collection: 'ro_guard_create', options: {} }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect(await listNames(DB)).not.toContain('ro_guard_create');

      const res = await svc.create({ connectionId: rwConnId, dbName: DB, collection: 'ro_guard_create', options: {} });
      expect(res.name).toBe('ro_guard_create');
    });

    it('drop rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      await svc.create({ connectionId: rwConnId, dbName: DB, collection: 'ro_guard_drop', options: {} });

      await expect(
        svc.drop({ connectionId: roConnId, dbName: DB, collection: 'ro_guard_drop' }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect(await listNames(DB)).toContain('ro_guard_drop');

      const res = await svc.drop({ connectionId: rwConnId, dbName: DB, collection: 'ro_guard_drop' });
      expect(res.dropped).toBe(true);
    });

    it('rename rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      await svc.create({ connectionId: rwConnId, dbName: DB, collection: 'ro_guard_rename_src', options: {} });

      await expect(
        svc.rename({
          connectionId: roConnId,
          dbName: DB,
          collection: 'ro_guard_rename_src',
          newName: 'ro_guard_rename_dst',
        }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      let names = await listNames(DB);
      expect(names).toContain('ro_guard_rename_src');
      expect(names).not.toContain('ro_guard_rename_dst');

      const res = await svc.rename({
        connectionId: rwConnId,
        dbName: DB,
        collection: 'ro_guard_rename_src',
        newName: 'ro_guard_rename_dst',
      });
      expect(res.name).toBe('ro_guard_rename_dst');
      names = await listNames(DB);
      expect(names).toContain('ro_guard_rename_dst');
    });

    it('dropDatabase rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      const guardDropDb = 'coll_admin_ro_guard_drop_db';
      await svc.create({ connectionId: rwConnId, dbName: guardDropDb, collection: 'seed', options: {} });
      expect(await listNames(guardDropDb)).toContain('seed');

      await expect(
        svc.dropDatabase({ connectionId: roConnId, dbName: guardDropDb }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect(await listNames(guardDropDb)).toContain('seed');

      const res = await svc.dropDatabase({ connectionId: rwConnId, dbName: guardDropDb });
      expect(res.dropped).toBe(true);
    });
  });

  // create/rename used to run with no maxTimeMS at all; drop/dropDatabase
  // are the deliberate override — a large namespace can legitimately take
  // longer than the metadata-op budget above to free, so they get
  // ADMIN_LONG_TIMEOUT_MS instead of STATS_TIMEOUT_MS.
  describe('every driver call carries maxTimeMS', () => {
    it('create sends maxTimeMS on both the listCollections precheck and createCollection', async () => {
      setup();
      const listSpy = vi.spyOn(Db.prototype, 'listCollections');
      const createSpy = vi.spyOn(Db.prototype, 'createCollection');

      await svc.create({ connectionId: connId, dbName: DB, collection: 'maxtimems_create', options: {} });

      expect(
        (listSpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS,
      ).toBe(STATS_TIMEOUT_MS);
      expect(
        (createSpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS,
      ).toBe(STATS_TIMEOUT_MS);
    });

    it('rename sends maxTimeMS: STATS_TIMEOUT_MS (metadata-only op)', async () => {
      setup();
      await svc.create({ connectionId: connId, dbName: DB, collection: 'maxtimems_rename_src', options: {} });
      const renameSpy = vi.spyOn(Db.prototype, 'renameCollection');

      await svc.rename({
        connectionId: connId,
        dbName: DB,
        collection: 'maxtimems_rename_src',
        newName: 'maxtimems_rename_dst',
      });

      expect(
        (renameSpy.mock.calls[0]![2] as { maxTimeMS?: number } | undefined)?.maxTimeMS,
      ).toBe(STATS_TIMEOUT_MS);
    });

    it('drop and dropDatabase override to ADMIN_LONG_TIMEOUT_MS', async () => {
      setup();
      await svc.create({ connectionId: connId, dbName: DB, collection: 'maxtimems_drop', options: {} });
      const dropCollSpy = vi.spyOn(Db.prototype, 'dropCollection');
      const dropDbSpy = vi.spyOn(Db.prototype, 'dropDatabase');

      await svc.drop({ connectionId: connId, dbName: DB, collection: 'maxtimems_drop' });
      await svc.dropDatabase({ connectionId: connId, dbName: 'coll_admin_maxtimems_dropdb' });

      expect(
        (dropCollSpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS,
      ).toBe(ADMIN_LONG_TIMEOUT_MS);
      expect(
        (dropDbSpy.mock.calls[0]![0] as { maxTimeMS?: number } | undefined)?.maxTimeMS,
      ).toBe(ADMIN_LONG_TIMEOUT_MS);
    });
  });

  // Views go through collection:create with viewOn + pipeline; collMod edits a
  // view's definition or a collection's validation rules in place.
  describe('views and collMod', () => {
    async function direct<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const client = new MongoClient(getSharedMongoUri());
      try {
        await client.connect();
        return await fn(client.db(DB));
      } finally {
        await client.close();
      }
    }
    const optionsOf = (name: string) =>
      direct(async (db) => {
        const [spec] = await db.listCollections({ name }).toArray();
        return spec as { type: string; options: Record<string, unknown> } | undefined;
      });

    it('create with viewOn + pipeline makes a view that returns only the matching documents', async () => {
      setup();
      await direct((db) => db.collection('view_src').insertMany([{ a: 1 }, { a: 2 }, { a: 1 }]));

      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'view_a1',
        options: { viewOn: 'view_src', pipeline: '[{"$match":{"a":{"$numberInt":"1"}}}]' },
      });

      const spec = await optionsOf('view_a1');
      expect(spec?.type).toBe('view');
      expect(spec?.options).toMatchObject({ viewOn: 'view_src', pipeline: [{ $match: { a: 1 } }] });
      const docs = await direct((db) => db.collection('view_a1').find({}, { projection: { _id: 0 } }).toArray());
      expect(docs).toEqual([{ a: 1 }, { a: 1 }]);
    });

    it.each([
      ['a $out stage', '[{"$match":{}},{"$out":"elsewhere"}]'],
      ['a $merge stage', '[{"$merge":{"into":"elsewhere"}}]'],
      ['a pipeline that is not an array', '{"$match":{}}'],
      ['a stage with two operators', '[{"$match":{},"$limit":1}]'],
      ['a stage key without $', '[{"match":{}}]'],
      ['a stage that is not a document', '[1]'],
      ['invalid EJSON', '[{"$match":'],
    ])('create refuses %s with VALIDATION and creates nothing', async (_label, pipeline) => {
      setup();
      await expect(
        svc.create({ connectionId: connId, dbName: DB, collection: 'bad_view', options: { viewOn: 'view_src', pipeline } }),
      ).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'pipeline' } });
      expect(await listNames(DB)).not.toContain('bad_view');
    });

    it('modify sets a validator that the server then enforces, and {} clears it', async () => {
      setup();
      await svc.create({ connectionId: connId, dbName: DB, collection: 'validated', options: {} });

      const res = await svc.modify({
        connectionId: connId,
        dbName: DB,
        collection: 'validated',
        options: { validator: '{"$jsonSchema":{"required":["name"]}}' },
      });
      expect(res).toEqual({ ok: true });
      expect((await optionsOf('validated'))?.options.validator).toEqual({ $jsonSchema: { required: ['name'] } });
      await expect(direct((db) => db.collection('validated').insertOne({ other: 1 }))).rejects.toThrow(
        /validation/i,
      );

      await svc.modify({ connectionId: connId, dbName: DB, collection: 'validated', options: { validator: '{}' } });
      expect((await optionsOf('validated'))?.options.validator ?? {}).toEqual({});
      await direct((db) => db.collection('validated').insertOne({ other: 1 }));
      expect(await direct((db) => db.collection('validated').countDocuments({ other: 1 }))).toBe(1);
    });

    it('modify updates the level and the action on their own', async () => {
      setup();
      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'levels',
        options: { validator: '{"a":{"$exists":true}}' },
      });

      await svc.modify({
        connectionId: connId,
        dbName: DB,
        collection: 'levels',
        options: { validationLevel: 'moderate', validationAction: 'warn' },
      });

      expect((await optionsOf('levels'))?.options).toMatchObject({
        validator: { a: { $exists: true } },
        validationLevel: 'moderate',
        validationAction: 'warn',
      });
    });

    it('modify on a view replaces its source and pipeline', async () => {
      setup();
      await direct((db) => db.collection('view_src2').insertMany([{ b: 1 }, { b: 2 }]));
      await svc.create({
        connectionId: connId,
        dbName: DB,
        collection: 'view_mod',
        options: { viewOn: 'view_src', pipeline: '[]' },
      });

      await svc.modify({
        connectionId: connId,
        dbName: DB,
        collection: 'view_mod',
        options: { viewOn: 'view_src2', pipeline: '[{"$match":{"b":{"$numberInt":"2"}}}]' },
      });

      expect((await optionsOf('view_mod'))?.options).toMatchObject({
        viewOn: 'view_src2',
        pipeline: [{ $match: { b: 2 } }],
      });
      const docs = await direct((db) => db.collection('view_mod').find({}, { projection: { _id: 0 } }).toArray());
      expect(docs).toEqual([{ b: 2 }]);
    });

    it.each([
      ['invalid EJSON', '{"$jsonSchema":', 'bad_validator_ejson'],
      ['a value that is not a document', '[1]', 'bad_validator_array'],
    ])('modify refuses a validator that is %s with VALIDATION', async (_label, validator, collection) => {
      setup();
      await svc.create({ connectionId: connId, dbName: DB, collection, options: {} });
      await expect(
        svc.modify({ connectionId: connId, dbName: DB, collection, options: { validator } }),
      ).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'validator' } });
    });

    it('modify refuses a write stage in a view pipeline with VALIDATION', async () => {
      setup();
      await expect(
        svc.modify({
          connectionId: connId,
          dbName: DB,
          collection: 'view_mod',
          options: { viewOn: 'view_src', pipeline: '[{"$out":"x"}]' },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'pipeline' } });
    });

    it('modify on a missing collection is NOT_FOUND', async () => {
      setup();
      await expect(
        svc.modify({ connectionId: connId, dbName: DB, collection: 'ghost_coll', options: { validator: '{}' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('modify rejects on a read-only connection and succeeds on the writable one', async () => {
      tmp = createTempDb();
      const vault = new SecretsVault(tmp.db, createSafeStorageMock());
      pool = new MongoPool({
        repo: makeReader([
          makeConnection('mod-rw', hp, { defaultDb: DB }),
          makeConnection('mod-ro', hp, { defaultDb: DB, readOnly: true }),
        ]),
        vault,
      });
      svc = new CollectionAdminService(pool);
      await svc.create({ connectionId: 'mod-rw', dbName: DB, collection: 'ro_guard_modify', options: {} });
      const input = { dbName: DB, collection: 'ro_guard_modify', options: { validator: '{"a":{"$exists":true}}' } };

      await expect(svc.modify({ connectionId: 'mod-ro', ...input })).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect((await optionsOf('ro_guard_modify'))?.options.validator).toBeUndefined();

      await svc.modify({ connectionId: 'mod-rw', ...input });
      expect((await optionsOf('ro_guard_modify'))?.options.validator).toEqual({ a: { $exists: true } });
    });

    it('modify sends maxTimeMS: STATS_TIMEOUT_MS on the collMod command', async () => {
      setup();
      await svc.create({ connectionId: connId, dbName: DB, collection: 'maxtimems_modify', options: {} });
      const commandSpy = vi.spyOn(Db.prototype, 'command');

      await svc.modify({ connectionId: connId, dbName: DB, collection: 'maxtimems_modify', options: { validator: '{}' } });

      const collMod = commandSpy.mock.calls.find(([cmd]) => 'collMod' in (cmd as object));
      expect(collMod?.[0]).toMatchObject({ collMod: 'maxtimems_modify', maxTimeMS: STATS_TIMEOUT_MS });
    });
  });
});
