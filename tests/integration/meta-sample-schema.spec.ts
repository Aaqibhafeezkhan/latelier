import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { MetaService } from '../../electron/mongo/MetaService';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import {
  getSharedMongoUri,
  uriToHostPort,
  makeConnection,
  makeReader,
} from '../helpers/mongo';

describe('meta:sampleSchema aggregation ($facet recent + random)', () => {
  let hp: { host: string; port: number };
  let tmp: TempDb;
  let vault: SecretsVault;
  let pool: MongoPool;

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
  });

  afterEach(async () => {
    if (pool) await pool.disconnectAll();
    tmp?.cleanup();
  });

  it('surfaces recently-inserted fields via the "recent" branch', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp, { defaultDb: 'schema_test' });
    pool = new MongoPool({ repo: makeReader([conn]), vault });

    const client = await pool.write('c1').client();
    const coll = client.db('schema_test').collection('sample_recent');
    await coll.deleteMany({});
    // Old docs without `email`.
    await coll.insertMany(Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, age: i })));
    // New docs with `email` — these should win the recent branch.
    await coll.insertMany(
      Array.from({ length: 20 }, (_, i) => ({
        name: `q${i}`,
        email: `q${i}@example.com`,
      })),
    );

    const cursor = coll.aggregate(
      [
        {
          $facet: {
            recent: [{ $sort: { _id: -1 } }, { $limit: 20 }],
            random: [{ $sample: { size: 20 } }],
          },
        },
      ],
      { allowDiskUse: false, maxTimeMS: 3000 },
    );
    const arr = (await cursor.toArray()) as Array<{ recent: unknown[]; random: unknown[] }>;
    const row = arr[0]!;
    expect(row.recent.length).toBe(20);
    expect(row.random.length).toBe(20);
    const recentHasEmail = row.recent.every(
      (d) => typeof d === 'object' && d !== null && 'email' in (d as object),
    );
    expect(recentHasEmail).toBe(true);
  });

  it('random branch draws across the whole collection, not just tail', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp, { defaultDb: 'schema_test' });
    pool = new MongoPool({ repo: makeReader([conn]), vault });

    const client = await pool.write('c1').client();
    const coll = client.db('schema_test').collection('sample_random');
    await coll.deleteMany({});
    // 200 docs, each tagged with its insertion index.
    await coll.insertMany(
      Array.from({ length: 200 }, (_, i) => ({ idx: i })),
    );

    const cursor = coll.aggregate([{ $sample: { size: 50 } }], { maxTimeMS: 3000 });
    const sampled = (await cursor.toArray()) as Array<{ idx: number }>;
    expect(sampled.length).toBe(50);
    const indices = sampled.map((d) => d.idx);
    // Statistical expectation — random sample of 50 out of 200 shouldn't
    // all cluster in the last quarter. This is loose on purpose but catches
    // a degenerate "sample degraded to natural order" regression.
    const inFirstHalf = indices.filter((i) => i < 100).length;
    expect(inFirstHalf).toBeGreaterThan(5);
  });
  describe('MetaService.sampleSchema', () => {
    async function sample(collName: string, count: number, size: number) {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp, { defaultDb: 'schema_test' });
      pool = new MongoPool({ repo: makeReader([conn]), vault });
      const client = await pool.write('c1').client();
      const coll = client.db('schema_test').collection(collName);
      await coll.deleteMany({});
      await coll.insertMany(Array.from({ length: count }, (_, i) => ({ idx: i })));
      const { docs } = await new MetaService(pool).sampleSchema({
        connectionId: 'c1',
        dbName: 'schema_test',
        collection: collName,
        size,
      });
      return docs as Array<{ _id: { $oid: string } }>;
    }

    it('lets the random draw contribute, not only the newest documents', async () => {
      const docs = (await sample('sample_random_mix', 300, 10)) as unknown as Array<{
        idx: { $numberInt: string };
      }>;
      const idxs = docs.map((d) => Number(d.idx.$numberInt));
      expect(docs).toHaveLength(10);
      // The 10 newest are idx 290..299; a random-only document is older.
      expect(idxs.some((i) => i < 290)).toBe(true);
      expect(idxs.some((i) => i >= 290)).toBe(true);
    });

    it('returns every document once when the collection is smaller than the size', async () => {
      const docs = await sample('sample_dedupe_under', 7, 10);
      expect(docs).toHaveLength(7);
      expect(new Set(docs.map((d) => d._id.$oid)).size).toBe(7);
    });

    it('does not collapse documents that have no _id', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp, { defaultDb: 'schema_test' });
      pool = new MongoPool({ repo: makeReader([conn]), vault });
      const db = (await pool.write('c1').client()).db('schema_test');
      const base = db.collection('sample_noid_base');
      await base.deleteMany({});
      await base.insertMany(Array.from({ length: 20 }, (_, i) => ({ idx: i })));
      await db.dropCollection('sample_noid_view').catch(() => undefined);
      await db.createCollection('sample_noid_view', {
        viewOn: 'sample_noid_base',
        pipeline: [{ $project: { _id: 0, idx: 1 } }],
      });
      const { docs } = await new MetaService(pool).sampleSchema({
        connectionId: 'c1',
        dbName: 'schema_test',
        collection: 'sample_noid_view',
        size: 10,
      });
      expect(docs).toHaveLength(10);
    });

    it('returns each document of a small collection once', async () => {
      const docs = await sample('sample_dedupe_small', 3, 100);
      expect(docs).toHaveLength(3);
      expect(new Set(docs.map((d) => d._id.$oid)).size).toBe(3);
    });

    it('caps a larger collection at the requested size with unique _ids', async () => {
      const docs = await sample('sample_dedupe_large', 300, 100);
      expect(docs).toHaveLength(100);
      expect(new Set(docs.map((d) => d._id.$oid)).size).toBe(100);
    });
  });
});
