import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Long, Decimal128, ObjectId } from 'bson';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { QueryService } from '../../electron/mongo/QueryService';
import type { RecentQueryService } from '../../electron/services/RecentQueryService';
import { insertAt, printFilter, type CondNode, type GroupNode } from '../../src/pages/Workspace/filterTree';
import { getSharedMongoUri, uriToHostPort, makeConnection, makeReader } from '../helpers/mongo';

// Phase 2A — prove the filter tree's printed filters actually MATCH the typed
// values they target on a real server. The unit tests (filter-tree.spec.ts)
// assert the emitted JSON shape; these assert the end-to-end query behavior
// (print → parseEjsonField → driver) for the precision-sensitive types the
// audit flagged (#2.4, #2.5, #2.10). W13 replaces `compileMql` with
// `filterTree.ts`'s printer as the live filter compiler.

const EMPTY_ROOT: GroupNode = { kind: 'group', logic: '$and', children: [] };

function filterFor(cond: Omit<CondNode, 'kind'>): string {
  const root = insertAt(EMPTY_ROOT, [], { kind: 'cond', ...cond });
  const printed = printFilter(root);
  if (!printed.ok) throw new Error(`test fixture produced an unprintable filter: ${JSON.stringify(printed.problems)}`);
  return printed.json;
}

describe('filter-tree printed filters match real BSON values (Phase 2A)', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: QueryService;
  const connId = 'bm-conn';
  const dbName = 'bm_db';
  const recentStub = { recordFind: async () => {} } as unknown as RecentQueryService;

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({
      repo: makeReader([conn]),
      vault: { get: () => null } as unknown as import('../../electron/secrets/SecretsVault').SecretsVault,
    });
    svc = new QueryService(pool, recentStub);
  });

  afterAll(async () => {
    await pool.disconnectAll();
  });

  const parseDocs = (s: string): Array<Record<string, unknown>> =>
    JSON.parse(s) as Array<Record<string, unknown>>;

  async function find(filter: string): Promise<Array<Record<string, unknown>>> {
    const res = await svc.find({ connectionId: connId, dbName, collection: coll(), filter, limit: 100, skip: 0 });
    return parseDocs(res.documentsJson);
  }

  let collName = '';
  const coll = (): string => collName;

  it('long $eq matches a Long beyond 2^53 (and rounding would NOT match) (#2.4)', async () => {
    collName = 'bm_long';
    const db = await pool.write(connId).db(dbName);
    await db.collection(collName).drop().catch(() => {});
    await db.collection(collName).insertMany([
      { name: 'exact', big: Long.fromString('1234567890123456789') },
      { name: 'rounded', big: Long.fromString('1234567890123456800') }, // what Number() would have produced
    ]);

    const filter = filterFor({ field: 'big', op: '$eq', valType: 'long', value: '1234567890123456789' });
    const docs = await find(filter);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe('exact');
  });

  it('decimal $eq matches a Decimal128 that a double would miss (#2.10)', async () => {
    collName = 'bm_decimal';
    const db = await pool.write(connId).db(dbName);
    await db.collection(collName).drop().catch(() => {});
    await db.collection(collName).insertMany([
      { name: 'd', price: Decimal128.fromString('9.99') },
      { name: 'other', price: Decimal128.fromString('10.01') },
    ]);

    const filter = filterFor({ field: 'price', op: '$eq', valType: 'decimal', value: '9.99' });
    const docs = await find(filter);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe('d');
  });

  it('objectid $in matches ObjectId _ids (raw-string $in would match nothing) (#2.5)', async () => {
    collName = 'bm_oid';
    const db = await pool.write(connId).db(dbName);
    await db.collection(collName).drop().catch(() => {});
    const a = new ObjectId();
    const b = new ObjectId();
    const c = new ObjectId();
    await db.collection(collName).insertMany([
      { _id: a, name: 'a' },
      { _id: b, name: 'b' },
      { _id: c, name: 'c' },
    ]);

    const filter = filterFor({
      field: '_id',
      op: '$in',
      valType: 'objectid',
      value: JSON.stringify([a.toHexString(), b.toHexString()]),
    });
    const docs = await find(filter);
    const names = docs.map((d) => d.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});
