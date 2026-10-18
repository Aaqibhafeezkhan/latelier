import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MongoPool } from '../../electron/mongo/MongoPool';
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
});
