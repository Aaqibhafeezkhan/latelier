import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Collection, MongoClient, ObjectId } from 'mongodb';
import { Int32, Long } from 'bson';
import { repairToCanonicalEjson } from '../../src/utils/shellSyntax';
import { ejsonParse, ejsonStringifyReadable } from '../../src/utils/ejson';
import { buildUpdateRequest } from '../../src/pages/Workspace/documentDiff';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { DocumentService } from '../../electron/mongo/DocumentService';
import { DEFAULT_MAX_EJSON_BYTES } from '../../electron/mongo/ejson';
import { ADMIN_LONG_TIMEOUT_MS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS } from '../../electron/mongo/timeouts';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createRouter } from '../../electron/ipc/router';
import { registerDocChannels } from '../../electron/ipc/handlers/doc';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { Envelope } from '../../shared/ipc';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import {
  getSharedMongoUri,
  uriToHostPort,
  makeConnection,
  makeReader,
} from '../helpers/mongo';

/**
 * Spies on the driver handle a write grant hands out.
 *
 * `pool.write(id)` itself reaches no driver — it is the synchronous read-only
 * refusal, and it deliberately runs *before* local validation so a refusal
 * still outranks a VALIDATION error. The claim these tests make is the
 * stronger one: that no handle was ever acquired, so nothing connected.
 */
function spyOnWriteHandle(p: MongoPool) {
  const real = p.write.bind(p);
  const acquired = vi.fn();
  vi.spyOn(p, 'write').mockImplementation((id: string) => {
    const grant = real(id);
    return {
      db: (dbName?: string) => {
        acquired();
        return grant.db(dbName);
      },
      client: () => {
        acquired();
        return grant.client();
      },
    };
  });
  return acquired;
}


function tokenCount(svc: DocumentService): number {
  return (svc as unknown as { tokens: Map<string, unknown> }).tokens.size;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('DocumentService.confirmDeleteMany token sweep', () => {
  let hp: { host: string; port: number };
  let tmp: TempDb;
  let vault: SecretsVault;
  let pool: MongoPool;
  let services: DocumentService[] = [];

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
  });

  afterEach(async () => {
    for (const svc of services) svc.dispose();
    services = [];
    if (pool) await pool.disconnectAll();
    tmp?.cleanup();
  });

  function setup(): void {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp, { defaultDb: 'doc_service_db' });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
  }

  function makeSvc(opts: { tokenTtlMs?: number; sweepIntervalMs?: number }): DocumentService {
    const svc = new DocumentService(pool, opts);
    services.push(svc);
    return svc;
  }

  it('sweeps expired tokens off the schedule', async () => {
    setup();
    const svc = makeSvc({ tokenTtlMs: 50, sweepIntervalMs: 25 });

    const { confirmToken } = await svc.confirmDeleteMany({
      connectionId: 'c1',
      dbName: 'doc_service_db',
      collection: 'docs_sweep_expired',
      filterJson: '{}',
    });
    expect(confirmToken).toBeTruthy();
    expect(tokenCount(svc)).toBe(1);

    // TTL is 50ms, sweep runs every 25ms. After 150ms the token must be gone.
    await sleep(150);
    expect(tokenCount(svc)).toBe(0);
  });

  it('leaves unexpired tokens alone across multiple sweeps', async () => {
    setup();
    // Long TTL, short sweep — several sweeps should pass without touching the token.
    const svc = makeSvc({ tokenTtlMs: 60_000, sweepIntervalMs: 15 });

    await svc.confirmDeleteMany({
      connectionId: 'c1',
      dbName: 'doc_service_db',
      collection: 'docs_sweep_preserve',
      filterJson: '{}',
    });
    expect(tokenCount(svc)).toBe(1);

    await sleep(120);
    expect(tokenCount(svc)).toBe(1);
  });

  it('deleteMany consumes its own token on success', async () => {
    setup();
    const svc = makeSvc({ tokenTtlMs: 60_000, sweepIntervalMs: 60_000 });

    const { confirmToken } = await svc.confirmDeleteMany({
      connectionId: 'c1',
      dbName: 'doc_service_db',
      collection: 'docs_consume',
      filterJson: '{}',
    });
    expect(tokenCount(svc)).toBe(1);

    await svc.deleteMany({
      connectionId: 'c1',
      dbName: 'doc_service_db',
      collection: 'docs_consume',
      filterJson: '{}',
      confirmToken,
    });
    expect(tokenCount(svc)).toBe(0);
  });

  it('deleteMany rejects an expired token and removes it from the map', async () => {
    setup();
    // Sweep interval is long so we can catch the expired-but-not-swept-yet window.
    const svc = makeSvc({ tokenTtlMs: 20, sweepIntervalMs: 60_000 });

    const { confirmToken } = await svc.confirmDeleteMany({
      connectionId: 'c1',
      dbName: 'doc_service_db',
      collection: 'docs_expired_delete',
      filterJson: '{}',
    });
    await sleep(50);
    // Still in the map (sweep hasn't run) but past its expiry.
    expect(tokenCount(svc)).toBe(1);

    await expect(
      svc.deleteMany({
        connectionId: 'c1',
        dbName: 'doc_service_db',
        collection: 'docs_expired_delete',
        filterJson: '{}',
        confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(tokenCount(svc)).toBe(0);
  });

  it('dispose stops the sweeper so new expired tokens are not cleaned', async () => {
    setup();
    const svc = makeSvc({ tokenTtlMs: 10, sweepIntervalMs: 15 });

    svc.dispose();

    await svc.confirmDeleteMany({
      connectionId: 'c1',
      dbName: 'doc_service_db',
      collection: 'docs_dispose',
      filterJson: '{}',
    });
    expect(tokenCount(svc)).toBe(1);

    // If the sweeper were still running, this token would be gone by now.
    await sleep(100);
    expect(tokenCount(svc)).toBe(1);
  });

  it('dispose is idempotent', async () => {
    setup();
    const svc = makeSvc({ tokenTtlMs: 60_000, sweepIntervalMs: 60_000 });
    svc.dispose();
    expect(() => svc.dispose()).not.toThrow();
  });
});

// BUG REPRO #2.3 — greedy EJSON.parse in DocumentService.insert
// collapses any object that starts with a recognised $-sentinel key, silently
// dropping sibling keys.  The sub-document {"$date":"…","kept":"x"} must be
// stored as a plain object with both fields intact.
// A collection keyed by small integers, so `_id: 1` type-checks.
type NumericIdDoc = { _id: number } & Record<string, unknown>;

describe('DocumentService insert EJSON round-trip (REPRO 2.3)', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'rr-conn';
  const dbName = 'rr_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('insert: sub-object with $date key + sibling key preserves sibling (REPRO 2.3)', async () => {
    const coll = 'repro_23';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});

    const docJson = JSON.stringify({
      testId: 'repro23',
      payload: { $date: '2026-01-01T00:00:00Z', kept: 'x' },
    });
    await svc.insert({ connectionId: connId, dbName, collection: coll, docJson });

    const db = await pool.write(connId).db(dbName);
    const stored = await db.collection(coll).findOne({ testId: 'repro23' });
    expect(stored).not.toBeNull();
    const payload = (stored as Record<string, unknown>).payload;
    // Bug: ejsonParse collapses {$date,"…",kept:"x"} to a Date → payload instanceof Date
    // Fix: payload stays as plain object with both keys
    expect(payload).not.toBeInstanceOf(Date);
    expect((payload as Record<string, unknown>).kept).toBe('x');
  });

  // JSON.parse rounds a bare integer past 2^53 to a double before the walker
  // sees it, so what a user types as 9007199254740993 used to be stored as
  // 9007199254740992. Assert the server-side BSON type with $type, not just
  // what the driver hands back: the driver would show a Long either way.
  it('insert: bare integers past 2^53 are stored as exact int64s, wider or safe ones as doubles (#279)', async () => {
    const coll = 'bare_big_int';
    const db = await pool.write(connId).db(dbName);
    await db.collection(coll).drop().catch(() => {});

    const docJson =
      '{"_id":1,"big":9007199254740993,"neg":-9007199254740993,"max":9223372036854775807,' +
      '"min":-9223372036854775808,"safe":9007199254740991,"wide":123456789012345678901,"nested":{"xs":[ 9007199254740993 ]}}';
    await svc.insert({ connectionId: connId, dbName, collection: coll, docJson });

    const c = db.collection<NumericIdDoc>(coll);
    expect(
      await c.countDocuments({
        big: { $type: 'long' },
        neg: { $type: 'long' },
        max: { $type: 'long' },
        min: { $type: 'long' },
        'nested.xs.0': { $type: 'long' },
        // A safe integer and a beyond-int64 one are not int64s: they stay doubles.
        safe: { $type: 'double' },
        wide: { $type: 'double' },
      }),
    ).toBe(1);

    const stored = (await c.findOne({ _id: 1 }, { promoteLongs: false })) as Record<string, unknown>;
    expect((stored.big as Long).toString()).toBe('9007199254740993');
    expect((stored.neg as Long).toString()).toBe('-9007199254740993');
    expect((stored.max as Long).toString()).toBe('9223372036854775807');
    expect((stored.min as Long).toString()).toBe('-9223372036854775808');
    expect(((stored.nested as { xs: Long[] }).xs[0] as Long).toString()).toBe('9007199254740993');
  });

  it('updateOne: a bare big integer in the filter matches that int64, not its rounded neighbour (#279)', async () => {
    const coll = 'bare_big_int_filter';
    const db = await pool.write(connId).db(dbName);
    await db.collection(coll).drop().catch(() => {});
    const c = db.collection<NumericIdDoc>(coll);
    await c.insertMany([
      { _id: 1, n: Long.fromString('9007199254740992') },
      { _id: 2, n: Long.fromString('9007199254740993') },
    ]);

    const res = await svc.updateOne({
      connectionId: connId,
      dbName,
      collection: coll,
      filterJson: '{"n":9007199254740993}',
      updateJson: '{"$set":{"hit":9007199254740993}}',
    });

    expect(res.matchedCount).toBe(1);
    const rows = (await c.find({}, { promoteLongs: false }).sort({ _id: 1 }).toArray()) as Record<string, unknown>[];
    expect(rows[0]!.hit).toBeUndefined();
    expect((rows[1]!.hit as Long).toString()).toBe('9007199254740993');
    expect(await c.countDocuments({ hit: { $type: 'long' } })).toBe(1);
  });

});

// `buildIdFilter` builds `JSON.stringify({ _id: doc._id })`, which looks like
// it breaks BSON-typed _ids because JSON.stringify on a live ObjectId yields a
// bare 24-char hex string. That premise doesn't hold there: `doc._id`
// arrives from electron/preload.ts `parseFindResult`, which does a PLAIN `JSON.parse(wire.documentsJson)` —
// never bson `EJSON.parse`. So for an ObjectId _id, `doc._id` is already
// the canonical EJSON *sentinel* `{ $oid: '<hex>' }`, never a live ObjectId
// instance. `JSON.stringify` around that sentinel reproduces the exact
// canonical EJSON, which the backend `EJSON.parse`s straight back into a
// real ObjectId. This test proves that wire contract end-to-end against a
// real ObjectId _id and the real updateOne backend.
describe('DocumentService.updateOne — ObjectId _id filter built from a JSON.parse\'d sentinel', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'oid-filter-conn';
  const dbName = 'oid_filter_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('matches and updates a real ObjectId _id when the filter is JSON.stringify\'d around the $oid sentinel (as buildIdFilter does)', async () => {
    const coll = 'oid_filter_roundtrip';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});

    const id = new ObjectId();
    await client.db(dbName).collection(coll).insertOne({ _id: id, name: 'original' });

    // Mirrors `buildIdFilter` exactly: `originalId` is never a live ObjectId —
    // it's the sentinel already produced by preload's plain JSON.parse of the
    // find-result wire JSON. Do NOT build this from a live ObjectId; that
    // scenario cannot reach `buildIdFilter` and would misrepresent the bug.
    const originalId = { $oid: id.toHexString() };
    const filterJson = JSON.stringify({ _id: originalId });
    const updateJson = JSON.stringify({ $set: { name: 'updated' } });

    const result = await svc.updateOne({
      connectionId: connId,
      dbName,
      collection: coll,
      filterJson,
      updateJson,
    });

    expect(result.matchedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);

    const stored = await client.db(dbName).collection(coll).findOne({ _id: id });
    expect(stored).not.toBeNull();
    expect((stored as Record<string, unknown>).name).toBe('updated');
  });
});

// T2.7 — insertMany routes a top-level EJSON array to a bulk insert,
// ordered:true, surfacing a CONFLICT with details.insertedCount on a
// duplicate-key failure partway through the batch.
describe('DocumentService.insertMany', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'insert-many-conn';
  const dbName = 'insert_many_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('inserts every document in the array on the happy path', async () => {
    const coll = 'insert_many_happy';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});

    const docsJson = JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const result = await svc.insertMany({ connectionId: connId, dbName, collection: coll, docsJson });

    expect(result.insertedCount).toBe(3);
    const count = await client.db(dbName).collection(coll).countDocuments({});
    expect(count).toBe(3);
  });

  it('rejects an empty array with VALIDATION and makes no driver call', async () => {
    const coll = 'insert_many_empty';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});

    await expect(
      svc.insertMany({ connectionId: connId, dbName, collection: coll, docsJson: '[]' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const count = await client.db(dbName).collection(coll).countDocuments({});
    expect(count).toBe(0);
  });

  it('rejects an array containing a non-object item with VALIDATION', async () => {
    const coll = 'insert_many_invalid_items';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});

    const docsJson = JSON.stringify([{ a: 1 }, 2]);
    await expect(
      svc.insertMany({ connectionId: connId, dbName, collection: coll, docsJson }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const count = await client.db(dbName).collection(coll).countDocuments({});
    expect(count).toBe(0);
  });

  it('ordered:true stops at the first duplicate key: CONFLICT with details.insertedCount reflecting the partial insert', async () => {
    const coll = 'insert_many_conflict';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number }>(coll).insertOne({ _id: 1 });

    const docsJson = JSON.stringify([{ _id: 2 }, { _id: 1 }, { _id: 3 }]);
    await expect(
      svc.insertMany({ connectionId: connId, dbName, collection: coll, docsJson }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { insertedCount: 1, mongoCode: 11000 } });

    // Pre-existing _id:1 + newly-inserted _id:2 only; _id:3 was never attempted
    // because ordered:true stops the batch at the first write error.
    const ids = (await client.db(dbName).collection<{ _id: number }>(coll).find({}).toArray())
      .map((d) => d._id)
      .sort((a, b) => a - b);
    expect(ids).toEqual([1, 2]);
  });

  /**
   * The router's only error seam (`toIpcError`) trusts that whatever reaches
   * it is already an `AppError` — anything else flattens to a generic
   * `INTERNAL` with no `.details`, discarding the classification entirely.
   * Driving a real duplicate-key failure through `createRouter` +
   * `registerDocChannels` (not calling `svc.insertMany` directly) proves the
   * classifier runs *before* that seam: the envelope comes back `CONFLICT`
   * with `details.insertedCount` intact, not `INTERNAL` with a raw
   * `MongoBulkWriteError` message.
   */
  it('a duplicate-key MongoBulkWriteError surfaces through the router as a classified CONFLICT, not INTERNAL', async () => {
    const coll = 'insert_many_router_conflict';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number }>(coll).insertOne({ _id: 1 });

    type Handler = (evt: typeof invokeEvent, payload: unknown) => unknown;
    const handlers = new Map<string, Handler>();
    const router = createRouter(
      { handle: (channel, fn) => handlers.set(channel, fn as Handler) },
      testSenderCheck,
    );
    registerDocChannels(router, svc);

    const docsJson = JSON.stringify([{ _id: 2 }, { _id: 1 }]);
    const envelope = (await handlers.get(IPC_CHANNELS.docInsertMany)!(invokeEvent, {
      connectionId: connId,
      dbName,
      collection: coll,
      docsJson,
    })) as Envelope<unknown>;

    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('CONFLICT');
    expect(envelope.error.details).toMatchObject({ insertedCount: 1, mongoCode: 11000 });
  });
});

// N0.1 — defense-in-depth: deleteOne/updateOne must refuse an empty `{}`
// filter rather than silently touching the first document Mongo returns.
// deleteMany/confirmDeleteMany are deliberately exempt (delete-all is
// legitimate there, gated by the confirmToken flow) so this suite only
// exercises the two single-document write paths.
describe('DocumentService.deleteOne / updateOne — empty filter guard (N0.1)', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'empty-filter-conn';
  const dbName = 'empty_filter_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('deleteOne rejects an empty filter with VALIDATION and never touches the seeded fixture', async () => {
    const coll = 'empty_filter_delete';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number; name: string }>(coll).insertOne({ _id: 1, name: 'first' });

    await expect(
      svc.deleteOne({ connectionId: connId, dbName, collection: coll, filterJson: '{}' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const count = await client.db(dbName).collection(coll).countDocuments({});
    expect(count).toBe(1);
  });

  it('updateOne rejects an empty filter with VALIDATION and never touches the seeded fixture', async () => {
    const coll = 'empty_filter_update';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number; name: string }>(coll).insertOne({ _id: 1, name: 'first' });

    await expect(
      svc.updateOne({
        connectionId: connId,
        dbName,
        collection: coll,
        filterJson: '{}',
        updateJson: JSON.stringify({ $set: { name: 'changed' } }),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const stored = await client.db(dbName).collection<{ _id: number; name: string }>(coll).findOne({ _id: 1 });
    expect(stored!.name).toBe('first');
  });
});

describe('DocumentService — the filter guard matches QueryService', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'doc-guard-conn';
  const dbName = 'doc_guard_db';
  const coll = 'doc_guard_docs';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  // Restored here, not inline: a failing `expect` throws, so an inline
  // `mockRestore` after one would be skipped and the spy would leak into the
  // next test — turning one real failure into a cascade of false ones.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each of these revives to a BSON instance, which passed the old
  // `parseEjsonField` untouched. `query:find` refuses them; the
  // `doc:*` channels used not to, so the same string got two verdicts
  // depending on which channel carried it. The driver does reject them — every
  // write path throws `MongoServerError` — but only after a round trip, and as
  // an opaque error rather than a VALIDATION naming the field.
  const SENTINELS: Array<[string, string]> = [
    ['a bare $oid', '{"$oid":"507f1f77bcf86cd799439011"}'],
    ['a bare $date', '{"$date":"2026-01-01T00:00:00Z"}'],
    ['a bare $numberDecimal', '{"$numberDecimal":"1.5"}'],
  ];

  for (const [label, filterJson] of SENTINELS) {
    it(`deleteOne refuses ${label} as a filter, before any driver call`, async () => {
      const handle = spyOnWriteHandle(pool);
      const call = svc.deleteOne({ connectionId: connId, dbName, collection: coll, filterJson });
      await expect(call).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(call).rejects.toThrow(/filterJson/);
      expect(handle).not.toHaveBeenCalled();
    });

    it(`confirmDeleteMany refuses ${label} as a filter, before any driver call`, async () => {
      const readDb = vi.spyOn(pool, 'readDb');
      const call = svc.confirmDeleteMany({ connectionId: connId, dbName, collection: coll, filterJson });
      await expect(call).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(readDb).not.toHaveBeenCalled();
    });

    it(`updateOne refuses ${label} as a filter, before any driver call`, async () => {
      const handle = spyOnWriteHandle(pool);
      const call = svc.updateOne({
        connectionId: connId,
        dbName,
        collection: coll,
        filterJson,
        updateJson: '{"$set":{"a":1}}',
      });
      await expect(call).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(handle).not.toHaveBeenCalled();
    });
  }

  // The two guards answer different questions and neither subsumes the other.
  // `{}` is a perfectly good document, so the document guard cannot catch it;
  // a bare sentinel is not empty by `Object.keys` for every BSON type, so the
  // empty-filter guard cannot catch those.
  it('still refuses an empty filter on deleteOne, which is a valid document', async () => {
    await expect(
      svc.deleteOne({ connectionId: connId, dbName, collection: coll, filterJson: '{}' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('still accepts a filter whose value is a nested sentinel', async () => {
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    await client.db(dbName).collection(coll).insertOne({ _id: oid, keep: true } as never);

    const res = await svc.deleteOne({
      connectionId: connId,
      dbName,
      collection: coll,
      filterJson: '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}',
    });
    expect(res.deletedCount).toBe(1);
  });

  it('insertMany still parses its array — the document guard must not reach docsJson', async () => {
    const client = await pool.write(connId).client();
    await client.db(dbName).collection('doc_guard_insert').drop().catch(() => {});
    const res = await svc.insertMany({
      connectionId: connId,
      dbName,
      collection: 'doc_guard_insert',
      docsJson: '[{"a":1},{"a":2}]',
    });
    expect(res.insertedCount).toBe(2);
  });
});

/**
 * the write path, driven with text the *renderer* produced.
 *
 * `write-surface-shell-syntax.spec.tsx` proves the drawers send repaired text;
 * it runs against a mocked `window.atelier`, so it says nothing about the main
 * process accepting it. `doc-handlers.spec.ts` drives every `doc:*` channel
 * through the router but stubs the service and sends plain JSON. Neither
 * crosses the boundary the payload actually crosses.
 *
 * An earlier revision got this right — `query-service.spec.ts` runs a repaired regex filter
 * against a real server — and the IPC audit of this base flagged the write
 * side as the asymmetry. This closes it.
 *
 * The transform is imported from `src/`, exactly as the renderer calls it, so
 * a change to its output shows up here rather than only in a component test
 * asserting against itself.
 */
describe('DocumentService — text produced by the Shell Syntax transform', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'shell-conn';
  const dbName = 'shell_db';

  /** Exactly what a drawer commits on blur. Fails loudly if it did not repair. */
  function repaired(shell: string): string {
    const outcome = repairToCanonicalEjson(shell);
    if (outcome.kind !== 'repaired') {
      throw new Error(`expected a repair for ${shell}, got ${outcome.kind}`);
    }
    return outcome.text;
  }

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('inserts a document written in Shell Syntax, with its BSON types intact', async () => {
    const coll = 'shell_insert';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});

    await svc.insert({
      connectionId: connId,
      dbName,
      collection: coll,
      docJson: repaired(
        "{name: 'acme', at: ISODate('2026-01-01T00:00:00.000Z'), big: NumberLong('9007199254740993'),}",
      ),
    });

    const stored = await client.db(dbName).collection(coll).findOne({ name: 'acme' });
    expect(stored).not.toBeNull();
    expect(stored!.at).toBeInstanceOf(Date);
    expect((stored!.at as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // The digit the whole no-evaluation design exists to protect. Through a
    // JavaScript double this reads …992.
    expect(String(stored!.big)).toBe('9007199254740993');
  });

  it('inserts many from a Shell Syntax array', async () => {
    const coll = 'shell_insert_many';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});

    const res = await svc.insertMany({
      connectionId: connId,
      dbName,
      collection: coll,
      docsJson: repaired("[{name: 'a'}, {name: 'b'},]"),
    });

    expect(res.insertedCount).toBe(2);
    expect(await client.db(dbName).collection(coll).countDocuments()).toBe(2);
  });

  it('applies a $set written in Shell Syntax', async () => {
    const coll = 'shell_update';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    const id = new ObjectId();
    await client.db(dbName).collection(coll).insertOne({ _id: id, status: 'draft' });

    const res = await svc.updateOne({
      connectionId: connId,
      dbName,
      collection: coll,
      filterJson: repaired(`{_id: ObjectId('${id.toHexString()}')}`),
      updateJson: repaired("{$set: {status: 'active'}}"),
    });

    expect(res.matchedCount).toBe(1);
    expect((await client.db(dbName).collection(coll).findOne({ _id: id }))!.status).toBe('active');
  });

  it('round-trips the readable renderer through a real write', async () => {
    // The other half of the same boundary: `ejsonStringifyReadable` fills the
    // Duplicate buffer, and an unedited insert sends that text. The int32 has
    // to come back an int32 and the int64 a int64, or the insert quietly
    // retyped a stored field.
    const coll = 'shell_readable';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    const id = new ObjectId();
    await client.db(dbName).collection(coll).insertOne({
      _id: id,
      age: new Int32(67),
      big: Long.fromString('9007199254740993'),
      at: new Date('2025-01-31T00:48:48.524Z'),
    });

    const original = await client.db(dbName).collection(coll).findOne({ _id: id });
    await client.db(dbName).collection(coll).deleteOne({ _id: id });
    await svc.insert({
      connectionId: connId,
      dbName,
      collection: coll,
      docJson: ejsonStringifyReadable(original, 2),
    });

    const after = await client.db(dbName).collection(coll).findOne({ _id: id });
    expect(after!.age).toBe(67);
    expect(String(after!.big)).toBe('9007199254740993');
    expect((after!.at as Date).toISOString()).toBe('2025-01-31T00:48:48.524Z');

    // Ask the server for the BSON types rather than the driver for JavaScript
    // ones: the driver hands back a plain number for both an int32 and a
    // double, so `toBe(67)` above cannot tell a retyped field from an intact
    // one. `$type` is the only thing here that can.
    const typed = await client
      .db(dbName)
      .collection(coll)
      .countDocuments({ _id: id, age: { $type: 'int' }, big: { $type: 'long' }, at: { $type: 'date' } });
    expect(typed).toBe(1);
  });
});

// every write method on DocumentService takes a write grant (which
// refuses first) before touching the driver.
// Two connections share the same physical Mongo server; only the `readOnly`
// flag differs. Each test proves the guard rejects on the read-only
// connection AND that the identical call still works on the writable one —
// so a guard that's too aggressive (blocking everything) would also fail.
//
// Seeding/verification goes through an independent MongoClient rather than
// pool.write().client(): MongoPool enforces a single-active-connection policy
// (connect() disconnects every other entry), so a client handle grabbed for
// one connectionId is force-closed the moment a call against the other
// connectionId connects — see MongoPool.connect().
describe('DocumentService — read-only connection guard', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  let verify: MongoClient;
  const rwConnId = 'ro-guard-rw-conn';
  const roConnId = 'ro-guard-ro-conn';
  const dbName = 'ro_guard_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    verify = new MongoClient(getSharedMongoUri());
    await verify.connect();

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const rwConn = makeConnection(rwConnId, hp, { defaultDb: dbName });
    const roConn = makeConnection(roConnId, hp, { defaultDb: dbName, readOnly: true });
    pool = new MongoPool({ repo: makeReader([rwConn, roConn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    await verify.close();
    tmp.cleanup();
  });

  /**
   * Refusal outranks validation, and the ordering is the whole reason
   * `pool.write()` refuses synchronously at the top of a method rather than
   * being folded into the awaited handle. A malformed payload on a read-only
   * connection must still report READ_ONLY: the connection cannot be written
   * at all, which is the more useful thing to tell the user, and it is what
   * this surface reported before the guarded handle existed.
   */
  it('reports READ_ONLY, not VALIDATION, for a malformed payload on a read-only connection', async () => {
    await expect(
      svc.insert({ connectionId: roConnId, dbName, collection: 'ro_order', docJson: 'null' }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });

    // The same payload on a writable connection is where VALIDATION belongs —
    // otherwise this test would pass against a service that always says
    // READ_ONLY.
    await expect(
      svc.insert({ connectionId: rwConnId, dbName, collection: 'ro_order', docJson: 'null' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('insert rejects on the read-only connection and succeeds on the writable one', async () => {
    const coll = 'ro_guard_insert';
    await verify.db(dbName).collection(coll).drop().catch(() => {});

    await expect(
      svc.insert({ connectionId: roConnId, dbName, collection: coll, docJson: '{"a":1}' }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(await verify.db(dbName).collection(coll).countDocuments({})).toBe(0);

    const res = await svc.insert({ connectionId: rwConnId, dbName, collection: coll, docJson: '{"a":1}' });
    expect(res.insertedId).toBeDefined();
    expect(await verify.db(dbName).collection(coll).countDocuments({})).toBe(1);
  });

  it('insertMany rejects on the read-only connection and succeeds on the writable one', async () => {
    const coll = 'ro_guard_insert_many';
    await verify.db(dbName).collection(coll).drop().catch(() => {});

    await expect(
      svc.insertMany({ connectionId: roConnId, dbName, collection: coll, docsJson: '[{"n":1},{"n":2}]' }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(await verify.db(dbName).collection(coll).countDocuments({})).toBe(0);

    const res = await svc.insertMany({ connectionId: rwConnId, dbName, collection: coll, docsJson: '[{"n":1},{"n":2}]' });
    expect(res.insertedCount).toBe(2);
  });

  it('updateOne rejects on the read-only connection and succeeds on the writable one', async () => {
    const coll = 'ro_guard_update';
    await verify.db(dbName).collection(coll).drop().catch(() => {});
    await verify.db(dbName).collection<{ _id: number; status: string }>(coll).insertOne({ _id: 1, status: 'draft' });

    await expect(
      svc.updateOne({
        connectionId: roConnId,
        dbName,
        collection: coll,
        filterJson: '{"_id":1}',
        updateJson: '{"$set":{"status":"active"}}',
      }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(
      (await verify.db(dbName).collection<{ _id: number; status: string }>(coll).findOne({ _id: 1 }))!.status,
    ).toBe('draft');

    const res = await svc.updateOne({
      connectionId: rwConnId,
      dbName,
      collection: coll,
      filterJson: '{"_id":1}',
      updateJson: '{"$set":{"status":"active"}}',
    });
    expect(res.matchedCount).toBe(1);
  });

  it('deleteOne rejects on the read-only connection and succeeds on the writable one', async () => {
    const coll = 'ro_guard_delete_one';
    await verify.db(dbName).collection(coll).drop().catch(() => {});
    await verify.db(dbName).collection<{ _id: number }>(coll).insertOne({ _id: 1 });

    await expect(
      svc.deleteOne({ connectionId: roConnId, dbName, collection: coll, filterJson: '{"_id":1}' }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(await verify.db(dbName).collection(coll).countDocuments({})).toBe(1);

    const res = await svc.deleteOne({ connectionId: rwConnId, dbName, collection: coll, filterJson: '{"_id":1}' });
    expect(res.deletedCount).toBe(1);
  });

  it('confirmDeleteMany still works read-only, but deleteMany rejects the write with the resulting token', async () => {
    const coll = 'ro_guard_delete_many';
    await verify.db(dbName).collection(coll).drop().catch(() => {});
    await verify.db(dbName).collection<{ a: number }>(coll).insertMany([{ a: 1 }, { a: 2 }]);

    // confirmDeleteMany only counts + mints a token — not a write, not guarded.
    const { confirmToken, count } = await svc.confirmDeleteMany({
      connectionId: roConnId,
      dbName,
      collection: coll,
      filterJson: '{}',
    });
    expect(count).toBe(2);

    await expect(
      svc.deleteMany({ connectionId: roConnId, dbName, collection: coll, filterJson: '{}', confirmToken }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(await verify.db(dbName).collection(coll).countDocuments({})).toBe(2);

    // Regression: the identical confirm+delete flow against the writable
    // connection must still go through.
    const { confirmToken: rwToken } = await svc.confirmDeleteMany({
      connectionId: rwConnId,
      dbName,
      collection: coll,
      filterJson: '{}',
    });
    const res = await svc.deleteMany({
      connectionId: rwConnId,
      dbName,
      collection: coll,
      filterJson: '{}',
      confirmToken: rwToken,
    });
    expect(res.deletedCount).toBe(2);
  });
});

// Fuzz-testing pass — real bugs found in document write validation, driven
// through the real router/handlers layer (DocumentService), exactly like the
// rest of this file.
describe('DocumentService — fuzz-found write-validation bugs', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'fuzz-conn';
  const dbName = 'fuzz_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  // ─── Bug 1 (HIGH) — invalid $regularExpression pattern must never reach ──
  // storage. Before the fix: insert succeeded, and the very next find() on
  // that collection threw MONGO_ERROR because bson's deserializer calls
  // `new RegExp(pattern, options)` on read and "(" is not a valid pattern —
  // one bad insert bricked reads for the whole collection.
  describe('Bug 1 — invalid $regularExpression', () => {
    it('insert rejects an invalid regex pattern with VALIDATION and writes nothing', async () => {
      const coll = 'fuzz_bad_regex_insert';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const docJson = JSON.stringify({ a: { $regularExpression: { pattern: '(', options: 'x' } } });
      await expect(
        svc.insert({ connectionId: connId, dbName, collection: coll, docJson }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const count = await client.db(dbName).collection(coll).countDocuments({});
      expect(count).toBe(0);
    });

    it('a subsequent read on the collection is never bricked, because the bad insert never landed', async () => {
      const coll = 'fuzz_bad_regex_no_brick';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});
      await client.db(dbName).collection(coll).insertOne({ ok: true });

      const docJson = JSON.stringify({ a: { $regularExpression: { pattern: '(', options: '' } } });
      await expect(
        svc.insert({ connectionId: connId, dbName, collection: coll, docJson }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      // If the bad regex had landed, this read would throw MONGO_ERROR.
      const docs = await client.db(dbName).collection(coll).find({}).toArray();
      expect(docs).toHaveLength(1);
    });

    it('a filter carrying the same invalid regex sentinel is also rejected with VALIDATION, before any driver call', async () => {
      const coll = 'fuzz_bad_regex_filter';
      const handle = spyOnWriteHandle(pool);
      const filterJson = JSON.stringify({ a: { $regularExpression: { pattern: '(', options: '' } } });
      await expect(
        svc.deleteOne({ connectionId: connId, dbName, collection: coll, filterJson }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(handle).not.toHaveBeenCalled();
    });

    it('a valid regex filter still works (no regression)', async () => {
      const coll = 'fuzz_valid_regex_filter';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});
      await client.db(dbName).collection(coll).insertOne({ name: 'hello' });

      const filterJson = JSON.stringify({ name: { $regularExpression: { pattern: '^hel', options: 'i' } } });
      const result = await svc.deleteOne({ connectionId: connId, dbName, collection: coll, filterJson });
      expect(result.deletedCount).toBe(1);
    });
  });

  // ─── Bug 2 (MEDIUM) — malformed $date / $binary must be rejected, not ────
  // silently corrupted into epoch-0 dates or mangled binary.
  describe('Bug 2 — malformed $date / $binary', () => {
    it('insert rejects a malformed $date with VALIDATION instead of silently storing epoch 0', async () => {
      const coll = 'fuzz_bad_date';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const docJson = JSON.stringify({ a: { $date: 'garbage' } });
      await expect(
        svc.insert({ connectionId: connId, dbName, collection: coll, docJson }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const count = await client.db(dbName).collection(coll).countDocuments({});
      expect(count).toBe(0);
    });

    it('insert rejects malformed $binary (bad base64) with VALIDATION instead of silently mangling it', async () => {
      const coll = 'fuzz_bad_binary_base64';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const docJson = JSON.stringify({
        a: { $binary: { base64: '!!!invalid!!!', subType: '00' } },
      });
      await expect(
        svc.insert({ connectionId: connId, dbName, collection: coll, docJson }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const count = await client.db(dbName).collection(coll).countDocuments({});
      expect(count).toBe(0);
    });

    it('insert rejects malformed $binary (bad subType) with VALIDATION instead of silently coercing it to 00', async () => {
      const coll = 'fuzz_bad_binary_subtype';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const docJson = JSON.stringify({
        a: { $binary: { base64: 'aGVsbG8=', subType: 'zz' } },
      });
      await expect(
        svc.insert({ connectionId: connId, dbName, collection: coll, docJson }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const count = await client.db(dbName).collection(coll).countDocuments({});
      expect(count).toBe(0);
    });

    it('a valid $date and $binary still round-trip correctly (no regression)', async () => {
      const coll = 'fuzz_valid_date_binary';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const docJson = JSON.stringify({
        testId: 'valid-date-binary',
        d: { $date: '2026-01-01T00:00:00Z' },
        b: { $binary: { base64: 'aGVsbG8=', subType: '00' } },
      });
      await svc.insert({ connectionId: connId, dbName, collection: coll, docJson });

      const stored = (await client
        .db(dbName)
        .collection(coll)
        .findOne({ testId: 'valid-date-binary' })) as Record<string, unknown>;
      expect(stored).not.toBeNull();
      expect(stored.d).toBeInstanceOf(Date);
      expect((stored.d as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      const bin = stored.b as { buffer: Uint8Array; sub_type: number };
      expect(Buffer.from(bin.buffer).toString('base64')).toBe('aGVsbG8=');
      expect(bin.sub_type).toBe(0);
    });
  });

  // ─── Bug 3 (LOW/MED) — a non-document docJson must fail cleanly as ───────
  // VALIDATION, not leak a raw driver-internal TypeError as MONGO_ERROR.
  describe('Bug 3 — non-document docJson', () => {
    it('insert rejects docJson: "null" with VALIDATION, not a leaked internal TypeError', async () => {
      const coll = 'fuzz_docjson_null';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const call = svc.insert({ connectionId: connId, dbName, collection: coll, docJson: 'null' });
      await expect(call).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(call).rejects.toThrow(/docJson/);
    });

    it('insert rejects docJson: "\\"abc\\"" with VALIDATION, not a leaked internal TypeError', async () => {
      const coll = 'fuzz_docjson_string';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const call = svc.insert({ connectionId: connId, dbName, collection: coll, docJson: '"abc"' });
      await expect(call).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('a valid document insert still works (no regression)', async () => {
      const coll = 'fuzz_docjson_valid';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const docJson = JSON.stringify({ a: 1 });
      await svc.insert({ connectionId: connId, dbName, collection: coll, docJson });
      const count = await client.db(dbName).collection(coll).countDocuments({});
      expect(count).toBe(1);
    });
  });

  // ─── Bug 4 (gap) — insertMany must apply the same maxBytes size guard the ─
  // read paths (QueryService.find, AggregationService) already apply, before
  // it can freeze the main process parsing one fat payload.
  describe('Bug 4 — insertMany size guard', () => {
    it('rejects a docsJson payload of exactly maxBytes + 1 bytes with VALIDATION, before parsing', async () => {
      const coll = 'fuzz_insertmany_oversize';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      const prefix = '[{"a":"';
      const suffix = '"}]';
      const padLen = DEFAULT_MAX_EJSON_BYTES + 1 - prefix.length - suffix.length;
      const docsJson = prefix + 'x'.repeat(padLen) + suffix;
      expect(Buffer.byteLength(docsJson, 'utf8')).toBe(DEFAULT_MAX_EJSON_BYTES + 1);

      await expect(
        svc.insertMany({ connectionId: connId, dbName, collection: coll, docsJson }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const count = await client.db(dbName).collection(coll).countDocuments({});
      expect(count).toBe(0);
    });

    it('a docsJson payload comfortably under maxBytes still inserts (no regression)', async () => {
      const coll = 'fuzz_insertmany_undersize';
      const client = await pool.write(connId).client();
      await client.db(dbName).collection(coll).drop().catch(() => {});

      // 4 docs well under the single-document 16MB BSON limit, cumulatively
      // well under the maxBytes cap — proves the guard doesn't false-reject.
      const bigDocs = Array.from({ length: 4 }, (_, i) => ({
        i,
        pad: 'x'.repeat(8 * 1024 * 1024),
      }));
      const docsJson = JSON.stringify(bigDocs);
      expect(Buffer.byteLength(docsJson, 'utf8')).toBeLessThan(DEFAULT_MAX_EJSON_BYTES);

      const result = await svc.insertMany({ connectionId: connId, dbName, collection: coll, docsJson });
      expect(result.insertedCount).toBe(4);
    }, 30_000);
  });
});

// Every DocumentService write used to carry no maxTimeMS at all — an
// unresponsive server held insertOne/insertMany/updateOne/
// deleteOne/deleteMany open until the socket gave up. Assert the bound is
// actually on the wire rather than relying on a real slow query, which
// mongodb-memory-server can't induce deterministically.
describe('DocumentService — every driver call carries maxTimeMS', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'maxtimems-conn';
  const dbName = 'maxtimems_db';
  const coll = 'maxtimems_docs';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('insert / insertMany carry QUERY_TIMEOUT_MS', async () => {
    const insertOneSpy = vi.spyOn(Collection.prototype, 'insertOne');
    const insertManySpy = vi.spyOn(Collection.prototype, 'insertMany');

    await svc.insert({ connectionId: connId, dbName, collection: coll, docJson: '{"a":1}' });
    await svc.insertMany({
      connectionId: connId,
      dbName,
      collection: coll,
      docsJson: '[{"a":2},{"a":3}]',
    });

    expect((insertOneSpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS).toBe(
      QUERY_TIMEOUT_MS,
    );
    expect((insertManySpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS).toBe(
      QUERY_TIMEOUT_MS,
    );
  });

  it('updateOne / deleteOne carry QUERY_TIMEOUT_MS', async () => {
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number }>(coll).insertMany([{ _id: 1 }, { _id: 2 }]);

    const updateSpy = vi.spyOn(Collection.prototype, 'findOneAndUpdate');
    const findOneSpy = vi.spyOn(Collection.prototype, 'findOne');
    const deleteSpy = vi.spyOn(Collection.prototype, 'findOneAndDelete');

    await svc.updateOne({
      connectionId: connId,
      dbName,
      collection: coll,
      filterJson: '{"_id":1}',
      updateJson: '{"$set":{"updated":true}}',
    });
    await svc.deleteOne({ connectionId: connId, dbName, collection: coll, filterJson: '{"_id":2}' });

    expect(((updateSpy.mock.calls[0] as unknown[])[2] as { maxTimeMS?: number } | undefined)?.maxTimeMS).toBe(
      QUERY_TIMEOUT_MS,
    );
    expect(((deleteSpy.mock.calls[0] as unknown[])[1] as { maxTimeMS?: number } | undefined)?.maxTimeMS).toBe(
      QUERY_TIMEOUT_MS,
    );
    // updateOne's Pre-image read.
    expect(findOneSpy.mock.calls).toHaveLength(1);
    expect(((findOneSpy.mock.calls[0] as unknown[])[1] as { maxTimeMS?: number } | undefined)?.maxTimeMS).toBe(
      QUERY_TIMEOUT_MS,
    );
  });

  it('confirmDeleteMany carries PROBE_TIMEOUT_MS and deleteMany carries ADMIN_LONG_TIMEOUT_MS', async () => {
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection(coll).insertMany([{ a: 1 }, { a: 2 }]);

    const countSpy = vi.spyOn(Collection.prototype, 'countDocuments');
    const deleteManySpy = vi.spyOn(Collection.prototype, 'deleteMany');

    const { confirmToken } = await svc.confirmDeleteMany({
      connectionId: connId,
      dbName,
      collection: coll,
      filterJson: '{}',
    });
    await svc.deleteMany({ connectionId: connId, dbName, collection: coll, filterJson: '{}', confirmToken });

    expect((countSpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS).toBe(
      PROBE_TIMEOUT_MS,
    );
    // deleteMany gets the admin budget, not the interactive one: it is the
    // confirm-gated bulk delete and is not atomic, so a bound that fires
    // mid-run leaves documents already deleted.
    expect((deleteManySpy.mock.calls[0]![1] as { maxTimeMS?: number } | undefined)?.maxTimeMS).toBe(
      ADMIN_LONG_TIMEOUT_MS,
    );
  });
});

describe('DocumentService — a schema-validator rejection is a VALIDATION error', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  const connId = 'dv-conn';
  const dbName = 'dv_db';
  const coll = 'validated';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);

    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).createCollection(coll, {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['n'],
          properties: { n: { bsonType: 'int' } },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  /**
   * Driven against a real `$jsonSchema` validator rather than a hand-built
   * error, because the shape is the whole point: mongod reports this as code
   * 121 with **no** `codeName`, so the classifier branch that matched only
   * the name never ran and every validator rejection reached the renderer as
   * MONGO_ERROR. A fixture asserting `codeName: 'DocumentValidationFailure'`
   * would have passed against the broken code.
   */
  it('insert: a document the validator rejects surfaces as VALIDATION, not MONGO_ERROR', async () => {
    await expect(
      svc.insert({ connectionId: connId, dbName, collection: coll, docJson: JSON.stringify({ n: 'not-an-int' }) }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('updateOne: the same rejection on an update path is also VALIDATION', async () => {
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).insertOne({ n: 1 });
    await expect(
      svc.updateOne({
        connectionId: connId,
        dbName,
        collection: coll,
        filterJson: JSON.stringify({ n: 1 }),
        updateJson: JSON.stringify({ $set: { n: 'not-an-int' } }),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('carries errInfo, so the renderer can say which rule failed', async () => {
    let caught: { details?: { errInfo?: unknown } } | undefined;
    try {
      await svc.insert({
        connectionId: connId,
        dbName,
        collection: coll,
        docJson: JSON.stringify({ n: 'bad' }),
      });
    } catch (e) {
      caught = e as { details?: { errInfo?: unknown } };
    }
    expect(caught).toBeDefined();
    expect(caught?.details?.errInfo).toBeDefined();
  });
});

// W08/updateMany — same confirm-token gate as deleteMany, plus two things
// deleteMany's filter-only token doesn't need: an update-shape guard
// (operator documents only, no pipelines, no replacements) and a hash
// binding the token to the exact update body reviewed, not just the filter.
describe('DocumentService.confirmUpdateMany / updateMany', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  const connId = 'update-many-conn';
  const dbName = 'update_many_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('happy path: confirms a count, then updates exactly the matched documents', async () => {
    const coll = 'update_many_happy';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client
      .db(dbName)
      .collection<{ _id: number; status: string }>(coll)
      .insertMany([{ _id: 1, status: 'draft' }, { _id: 2, status: 'draft' }, { _id: 3, status: 'final' }]);

    const filterJson = JSON.stringify({ status: 'draft' });
    const updateJson = JSON.stringify({ $set: { status: 'active' } });
    const { count, confirmToken } = await svc.confirmUpdateMany({ connectionId: connId, dbName, collection: coll, filterJson, updateJson });
    expect(count).toBe(2);

    const result = await svc.updateMany({ connectionId: connId, dbName, collection: coll, filterJson, updateJson, confirmToken });
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });

    const docs = await client.db(dbName).collection<{ _id: number; status: string }>(coll).find({}).sort({ _id: 1 }).toArray();
    expect(docs.map((d) => d.status)).toEqual(['active', 'active', 'final']);
  });

  it('confirmUpdateMany refuses a replacement-style document (no $ keys), before counting', async () => {
    const coll = 'update_many_replacement';
    await expect(
      svc.confirmUpdateMany({
        connectionId: connId,
        dbName,
        collection: coll,
        filterJson: '{}',
        updateJson: JSON.stringify({ status: 'active' }),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('confirmUpdateMany refuses a pipeline update (a top-level array)', async () => {
    const coll = 'update_many_pipeline';
    await expect(
      svc.confirmUpdateMany({
        connectionId: connId,
        dbName,
        collection: coll,
        filterJson: '{}',
        updateJson: JSON.stringify([{ $set: { status: 'active' } }]),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('confirmUpdateMany refuses an empty update document', async () => {
    const coll = 'update_many_empty_update';
    await expect(
      svc.confirmUpdateMany({ connectionId: connId, dbName, collection: coll, filterJson: '{}', updateJson: '{}' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a confirmDeleteMany token cannot authorize updateMany, even against the identical filter/collection', async () => {
    const coll = 'update_many_cross_op_a';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number; status: string }>(coll).insertOne({ _id: 1, status: 'draft' });

    const filterJson = '{}';
    const { confirmToken } = await svc.confirmDeleteMany({ connectionId: connId, dbName, collection: coll, filterJson });

    await expect(
      svc.updateMany({
        connectionId: connId,
        dbName,
        collection: coll,
        filterJson,
        updateJson: JSON.stringify({ $set: { status: 'active' } }),
        confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const stored = await client.db(dbName).collection<{ _id: number; status: string }>(coll).findOne({ _id: 1 });
    expect(stored!.status).toBe('draft');
  });

  it('a confirmUpdateMany token cannot authorize deleteMany, even against the identical filter/collection', async () => {
    const coll = 'update_many_cross_op_b';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number }>(coll).insertOne({ _id: 1 });

    const filterJson = '{}';
    const updateJson = JSON.stringify({ $set: { touched: true } });
    const { confirmToken } = await svc.confirmUpdateMany({ connectionId: connId, dbName, collection: coll, filterJson, updateJson });

    await expect(
      svc.deleteMany({ connectionId: connId, dbName, collection: coll, filterJson, confirmToken }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(await client.db(dbName).collection(coll).countDocuments({})).toBe(1);
  });

  it('rejects the token when the update body changes after Review, even though the filter/collection match', async () => {
    const coll = 'update_many_hash_mismatch';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number; status: string }>(coll).insertOne({ _id: 1, status: 'draft' });

    const filterJson = '{}';
    const { confirmToken } = await svc.confirmUpdateMany({
      connectionId: connId,
      dbName,
      collection: coll,
      filterJson,
      updateJson: JSON.stringify({ $set: { status: 'reviewed-value' } }),
    });

    await expect(
      svc.updateMany({
        connectionId: connId,
        dbName,
        collection: coll,
        filterJson,
        // A different update body than the one the token was minted for.
        updateJson: JSON.stringify({ $set: { status: 'edited-after-review' } }),
        confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const stored = await client.db(dbName).collection<{ _id: number; status: string }>(coll).findOne({ _id: 1 });
    expect(stored!.status).toBe('draft');
  });

  it('consumes its own token on success, and rejects an expired token', async () => {
    const coll = 'update_many_token_lifecycle';
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    await client.db(dbName).collection<{ _id: number }>(coll).insertOne({ _id: 1 });

    const filterJson = '{}';
    const updateJson = JSON.stringify({ $set: { touched: true } });
    const { confirmToken } = await svc.confirmUpdateMany({ connectionId: connId, dbName, collection: coll, filterJson, updateJson });
    await svc.updateMany({ connectionId: connId, dbName, collection: coll, filterJson, updateJson, confirmToken });

    // Reusing the same (now-consumed) token must fail.
    await expect(
      svc.updateMany({ connectionId: connId, dbName, collection: coll, filterJson, updateJson, confirmToken }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// Read-only connection guard for updateMany. Same server, only `readOnly`
// differs — the write-grant-first ordering (unlike deleteMany's
// token-then-grant order) must report READ_ONLY even against a bogus token,
// proving the grant really is asked for before the token is inspected.
describe('DocumentService.updateMany — read-only connection guard', () => {
  let hp: { host: string; port: number };
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  let vault: SecretsVault;
  let verify: MongoClient;
  const rwConnId = 'update-many-ro-guard-rw';
  const roConnId = 'update-many-ro-guard-ro';
  const dbName = 'update_many_ro_guard_db';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    verify = new MongoClient(getSharedMongoUri());
    await verify.connect();

    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const rwConn = makeConnection(rwConnId, hp, { defaultDb: dbName });
    const roConn = makeConnection(roConnId, hp, { defaultDb: dbName, readOnly: true });
    pool = new MongoPool({ repo: makeReader([rwConn, roConn]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    await verify.close();
    tmp.cleanup();
  });

  it('confirmUpdateMany still works read-only (a read); updateMany refuses READ_ONLY even with a bogus token', async () => {
    const coll = 'update_many_ro_guard';
    await verify.db(dbName).collection(coll).drop().catch(() => {});
    await verify.db(dbName).collection<{ a: number }>(coll).insertMany([{ a: 1 }, { a: 2 }]);

    const { count } = await svc.confirmUpdateMany({
      connectionId: roConnId,
      dbName,
      collection: coll,
      filterJson: '{}',
      updateJson: '{"$set":{"a":9}}',
    });
    expect(count).toBe(2);

    await expect(
      svc.updateMany({
        connectionId: roConnId,
        dbName,
        collection: coll,
        filterJson: '{}',
        updateJson: '{"$set":{"a":9}}',
        confirmToken: 'not-a-real-token',
      }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(await verify.db(dbName).collection(coll).countDocuments({ a: 9 })).toBe(0);

    // The identical confirm+update flow against the writable connection still works.
    const { confirmToken: rwToken } = await svc.confirmUpdateMany({
      connectionId: rwConnId,
      dbName,
      collection: coll,
      filterJson: '{}',
      updateJson: '{"$set":{"a":9}}',
    });
    const res = await svc.updateMany({
      connectionId: rwConnId,
      dbName,
      collection: coll,
      filterJson: '{}',
      updateJson: '{"$set":{"a":9}}',
      confirmToken: rwToken,
    });
    expect(res.matchedCount).toBe(2);
  });
});

// The Document Editor's save is a compare-and-set: the filter carries each
// changed field's loaded value, so a concurrent change to one of those fields
// makes the update match nothing, and a change to any other field does not.
describe('DocumentService.updateOne — the Document Editor compare-and-set', () => {
  let pool: MongoPool;
  let svc: DocumentService;
  let tmp: TempDb;
  const connId = 'cas-conn';
  const dbName = 'cas_db';
  const coll = 'cas_docs';

  beforeAll(async () => {
    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    pool = new MongoPool({ repo: makeReader([makeConnection(connId, uriToHostPort(getSharedMongoUri()), { defaultDb: dbName })]), vault });
    svc = new DocumentService(pool);
  });

  afterAll(async () => {
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  /** Seeds one document and returns it revived, as the editor holds it once opened. */
  async function seed(): Promise<{ id: ObjectId; loaded: Record<string, unknown> }> {
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).drop().catch(() => {});
    const id = new ObjectId();
    await client.db(dbName).collection(coll).insertOne({ _id: id, name: 'a', qty: new Int32(1), addr: { city: 'X' } });
    const loaded = ejsonParse<Record<string, unknown>>(JSON.stringify({
      _id: { $oid: id.toHexString() }, name: 'a', qty: { $numberInt: '1' }, addr: { city: 'X' },
    }));
    return { id, loaded };
  }

  const save = (req: { filterJson: string; updateJson: string }) =>
    svc.updateOne({ connectionId: connId, dbName, collection: coll, ...req });

  it('matches nothing when an edited field changed underneath', async () => {
    const { id, loaded } = await seed();
    const req = buildUpdateRequest(loaded, { ...loaded, addr: { city: 'Y' } })!;
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).updateOne({ _id: id }, { $set: { 'addr.city': 'Z' } });

    expect((await save(req)).matchedCount).toBe(0);
    expect((await client.db(dbName).collection(coll).findOne({ _id: id }))!.addr).toEqual({ city: 'Z' });
  });

  it('saves over a change to a field the user did not touch, and both changes survive', async () => {
    const { id, loaded } = await seed();
    const req = buildUpdateRequest(loaded, { ...loaded, name: 'b' })!;
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).updateOne({ _id: id }, { $set: { qty: 7 } });

    expect((await save(req)).matchedCount).toBe(1);
    const stored = await client.db(dbName).collection(coll).findOne({ _id: id });
    expect(stored).toMatchObject({ name: 'b', qty: 7 });
  });

  it('matches nothing when a field the draft adds appeared underneath', async () => {
    const { id, loaded } = await seed();
    const req = buildUpdateRequest(loaded, { ...loaded, note: 'mine' })!;
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).updateOne({ _id: id }, { $set: { note: 'theirs' } });

    expect((await save(req)).matchedCount).toBe(0);
  });

  it('writes a nested edit as its dotted path, keeping a sibling changed underneath', async () => {
    const { id, loaded } = await seed();
    const client = await pool.write(connId).client();
    await client.db(dbName).collection(coll).updateOne({ _id: id }, { $set: { 'addr.zip': '9' } });
    const req = buildUpdateRequest(loaded, { ...loaded, addr: { city: 'Y' } })!;

    expect((await save(req)).matchedCount).toBe(1);
    expect((await client.db(dbName).collection(coll).findOne({ _id: id }))!.addr).toEqual({ city: 'Y', zip: '9' });
  });
});
