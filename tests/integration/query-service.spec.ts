import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { QueryService } from '../../electron/mongo/QueryService';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { ValidationError } from '../../electron/errors';
import { createTempDb, type TempDb } from '../helpers/db';
import { getSharedMongoUri, makeConnection, makeReader } from '../helpers/mongo';
import { repairToCanonicalEjson } from '../../src/utils/shellSyntax';

describe('QueryService', () => {
  let pool: MongoPool;
  let svc: QueryService;
  let tmp: TempDb;
  const connId = 'test-conn';
  const dbName = 'query_service_db';
  const collName = 'items';

  beforeAll(async () => {
    const uri = getSharedMongoUri();
    const hp = { host: new URL(uri).hostname, port: Number(new URL(uri).port) };
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({
      repo: makeReader([conn]),
      vault: { get: () => null } as unknown as import('../../electron/secrets/SecretsVault').SecretsVault,
    });

    tmp = createTempDb();
    // Insert a connection row so the FK from recent_queries → connections passes
    tmp.db.prepare(`
      INSERT INTO connections (
        id, name, color, connection_type, host, port,
        auth_mech, tls_enabled, tls_verify, ssh_enabled,
        connect_timeout_ms, socket_timeout_ms, server_selection_timeout_ms,
        read_preference, max_pool_size, direct_connection,
        created_at, updated_at
      ) VALUES (
        ?, 'Test', '#1A6835', 'standard', ?, ?,
        'none', 0, 1, 0,
        5000, 5000, 5000,
        'primary', 5, 1,
        ?, ?
      )
    `).run(connId, hp.host, hp.port, new Date().toISOString(), new Date().toISOString());

    const recentRepo = new RecentQueryRepo(tmp.db);
    const recentSvc = new RecentQueryService(recentRepo);
    svc = new QueryService(pool, recentSvc);

    // Seed 10 documents
    const client = await pool.write(connId).client();
    const coll = client.db(dbName).collection(collName);
    await coll.deleteMany({});
    const docs = Array.from({ length: 10 }, (_, i) => ({ n: i, tag: 'seed' }));
    await coll.insertMany(docs);
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  // The cases below spy on `pool.readDb` to prove the refusal happened
  // *instead of* the query, not alongside it. Restore per test so the spy
  // can't leak into the ones that need a real connection.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Service returns the wire shape (canonical EJSON as a string) so the
  // preload can pass it across the contextBridge without structured-cloning
  // every nested document. Tests parse once at the assertion boundary.
  const parseDocs = (s: string): unknown[] => JSON.parse(s) as unknown[];

  it('find with limit 5 returns 5 docs and hasMore=true', async () => {
    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      limit: 5,
      skip: 0,
    });
    expect(parseDocs(result.documentsJson)).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('find with limit 10 returns all 10 docs', async () => {
    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      limit: 10,
      skip: 0,
    });
    expect(parseDocs(result.documentsJson)).toHaveLength(10);
    // hasMore=true is valid when exactly limit docs returned (service can't know collection size)
  });

  it('find with limit 20 on 10-doc collection returns hasMore=false', async () => {
    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      limit: 20,
      skip: 0,
    });
    expect(parseDocs(result.documentsJson)).toHaveLength(10);
    expect(result.hasMore).toBe(false);
  });

  it('ObjectId round-trip: find by $oid filter returns doc with $oid shape', async () => {
    // First find to get an actual id
    const first = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      limit: 1,
      skip: 0,
    });
    const firstDocs = parseDocs(first.documentsJson);
    expect(firstDocs).toHaveLength(1);
    const doc = firstDocs[0] as Record<string, unknown>;
    const oidWrapper = doc._id as { $oid: string };
    expect(oidWrapper).toHaveProperty('$oid');
    const oidStr = oidWrapper.$oid;

    // Now query using the $oid filter
    const filter = JSON.stringify({ _id: { $oid: oidStr } });
    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter,
      limit: 1,
      skip: 0,
    });
    const resultDocs = parseDocs(result.documentsJson);
    expect(resultDocs).toHaveLength(1);
    const returned = resultDocs[0] as Record<string, unknown>;
    expect((returned._id as { $oid: string }).$oid).toBe(oidStr);
  });

  it('count returns correct number', async () => {
    const result = await svc.count({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{ "tag": "seed" }',
    });
    expect(result.count).toBe(10);
  });

  it('count with selective filter', async () => {
    const result = await svc.count({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{ "n": { "$gte": 5 } }',
    });
    expect(result.count).toBe(5);
  });

  it('find throws ValidationError for invalid filter EJSON', async () => {
    await expect(
      svc.find({
        connectionId: connId,
        dbName,
        collection: collName,
        filter: '{ invalid json }',
        limit: 10,
        skip: 0,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ─── W15 §12.10 — the raw projection reaches the driver ───────────
  //
  // `builder.projectionRaw` exists so `{_id: 0}` is expressible; these two
  // cases are the far end of that string. The second is the fail-closed proof
  // the §11 invariant asks for: a projection the app can't parse must come
  // back as VALIDATION, never as a result set with every field in it.

  it('find applies a raw projection verbatim, including an _id exclusion', async () => {
    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      projection: '{"_id":0,"n":1}',
      limit: 3,
      skip: 0,
    });
    const docs = parseDocs(result.documentsJson) as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(3);
    for (const doc of docs) {
      expect(doc).not.toHaveProperty('_id');
      expect(doc).toHaveProperty('n');
      // `tag` was seeded on every document and excluded by the projection —
      // asserted so a projection that silently didn't apply can't pass.
      expect(doc).not.toHaveProperty('tag');
    }
  });

  it('find throws ValidationError for a malformed projection, and returns nothing', async () => {
    // Not "rejects, therefore no documents" by assumption — the refusal has
    // to happen instead of the find, not alongside an unprojected one. The
    // `readDb` spy is what pins that: this test used to assert
    // `rejects.not.toHaveProperty('documentsJson')`, which passes for any
    // rejection at all (no `Error` has that property) and so could not fail.
    const readDb = vi.spyOn(pool, 'readDb');
    const call = svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      projection: '{"_id":0',
      limit: 10,
      skip: 0,
    });
    await expect(call).rejects.toBeInstanceOf(ValidationError);
    await expect(call).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(readDb).not.toHaveBeenCalled();
  });

  // ─── A sort or projection that parses but isn't a document ──────────────
  //
  // The gap W15 opened: `sort` and `projection` became free user text
  // (`projectionRaw`, the sort input), while main still parsed-and-cast. The
  // driver does not backstop it — verified against this same server:
  //
  //   sort       'null' / '[1,2]'  => runs UNSORTED, no error
  //   projection 'null'            => runs, EVERY FIELD returned
  //   projection '[1,2]'           => runs, only _id
  //
  // `projection: 'null'` widening a refused projection into every field is
  // the fail-open rule the W15 spec restates as its §11 invariant. Each case must
  // be refused before the driver is reached at all.

  // The sentinels each revive to a BSON instance, which satisfies
  // the loose `typeof === 'object' && !Array.isArray` shape test the guard used
  // to run — so they reached the driver. Two of them do so silently, which is
  // the same fail-open as the rows above rather than a milder cousin:
  // `{"$date":…}` as a sort runs in insertion order because
  // `Object.keys(new Date())` is `[]`, and `{"$oid":…}` as a filter matches
  // nothing. Measured against this file's own driver, not assumed.
  const NON_DOCUMENTS: Array<[string, string]> = [
    ['null', 'null'],
    ['an array', '[1,2]'],
    ['a scalar', '42'],
    ['a bare $oid sentinel', '{"$oid":"507f1f77bcf86cd799439011"}'],
    ['a bare $date sentinel', '{"$date":"2026-01-01T00:00:00Z"}'],
    ['a bare $numberDecimal sentinel', '{"$numberDecimal":"1.5"}'],
  ];

  for (const [label, raw] of NON_DOCUMENTS) {
    for (const field of ['projection', 'sort'] as const) {
      it(`find refuses ${label} as a ${field}, before any driver call`, async () => {
        const readDb = vi.spyOn(pool, 'readDb');
        const call = svc.find({
          connectionId: connId,
          dbName,
          collection: collName,
          filter: '{}',
          [field]: raw,
          limit: 10,
          skip: 0,
        });
        await expect(call).rejects.toBeInstanceOf(ValidationError);
        await expect(call).rejects.toMatchObject({ code: 'VALIDATION' });
        // Naming the field matters: "invalid sort" and "invalid projection"
        // are different fixes for the user.
        await expect(call).rejects.toThrow(new RegExp(field));
        expect(readDb).not.toHaveBeenCalled();
      });

      it(`explain refuses ${label} as a ${field}, before any driver call`, async () => {
        const readDb = vi.spyOn(pool, 'readDb');
        const call = svc.explain({
          connectionId: connId,
          dbName,
          collection: collName,
          filter: '{}',
          [field]: raw,
          verbosity: 'queryPlanner',
        });
        await expect(call).rejects.toBeInstanceOf(ValidationError);
        expect(readDb).not.toHaveBeenCalled();
      });
    }

    it(`find refuses ${label} as a filter, before any driver call`, async () => {
      const readDb = vi.spyOn(pool, 'readDb');
      const call = svc.find({
        connectionId: connId,
        dbName,
        collection: collName,
        filter: raw,
        limit: 10,
        skip: 0,
      });
      await expect(call).rejects.toBeInstanceOf(ValidationError);
      expect(readDb).not.toHaveBeenCalled();
    });

    for (const field of ['projection', 'sort'] as const) {
      it(`findOne refuses ${label} as a ${field}, before any driver call`, async () => {
        const readDb = vi.spyOn(pool, 'readDb');
        const call = svc.findOne({
          connectionId: connId,
          dbName,
          collection: collName,
          filter: '{}',
          [field]: raw,
        });
        await expect(call).rejects.toBeInstanceOf(ValidationError);
        expect(readDb).not.toHaveBeenCalled();
      });
    }

    // `count` takes only a filter, and the driver already threw on a
    // non-document one — but as a `MongoOpError` after a round trip. Same
    // guard, same call site pattern, so it refuses here like the rest.
    it(`count refuses ${label} as a filter, before any driver call`, async () => {
      const readDb = vi.spyOn(pool, 'readDb');
      const call = svc.count({
        connectionId: connId,
        dbName,
        collection: collName,
        filter: raw,
      });
      await expect(call).rejects.toBeInstanceOf(ValidationError);
      expect(readDb).not.toHaveBeenCalled();
    });
  }

  // The control for the block above: a real sort still sorts, and a real
  // projection still projects. Without it, "every non-document is refused"
  // would also be satisfied by refusing everything.
  it('a document sort and projection still run, and take effect', async () => {
    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      sort: '{"n":-1}',
      projection: '{"_id":0,"n":1}',
      limit: 3,
      skip: 0,
    });
    const docs = parseDocs(result.documentsJson) as Array<Record<string, unknown>>;
    expect(docs.map((d) => Number((d.n as { $numberInt: string }).$numberInt))).toEqual([9, 8, 7]);
    for (const doc of docs) expect(doc).not.toHaveProperty('tag');
  });

  // the transform's regex output, end to end against a real server.
  // The unit tests prove `/^acme/i` becomes `$regularExpression` and that the
  // renderer's EJSON reader revives it. Neither proves the *driver* treats it
  // as a regex, and both `$regularExpression` and the `$regex`/`$options` pair
  // survive a JSON round trip unchanged — so a wrong choice would have shown up
  // here as zero rows and nowhere earlier as an error.
  it('a repaired regex literal matches rows through the real driver', async () => {
    const repaired = repairToCanonicalEjson('{tag: /^SE/i}');
    expect(repaired.kind).toBe('repaired');
    const filter = (repaired as { kind: 'repaired'; text: string }).text;
    expect(filter).toContain('$regularExpression');

    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter,
      limit: 20,
      skip: 0,
    });
    expect(parseDocs(result.documentsJson)).toHaveLength(10);

    // The control: the same query without the `i` flag matches nothing, so the
    // ten rows above are the regex matching rather than the filter collapsing.
    const cased = await svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: (repairToCanonicalEjson('{tag: /^SE/}') as { text: string }).text,
      limit: 20,
      skip: 0,
    });
    expect(parseDocs(cased.documentsJson)).toHaveLength(0);
  });

  it('findOne returns null for non-matching filter', async () => {
    const result = await svc.findOne({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{ "n": -9999 }',
    });
    expect(result.document).toBeNull();
  });

  it('findOne returns a document for matching filter', async () => {
    const result = await svc.findOne({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{ "n": 3 }',
    });
    expect(result.document).not.toBeNull();
    const doc = result.document as Record<string, unknown>;
    // findOne uses canonical EJSON encoding; integers are wrapped as { $numberInt }
    const nVal = doc.n as { $numberInt?: string } | number;
    const n = typeof nVal === 'number' ? nVal : Number((nVal as { $numberInt: string }).$numberInt);
    expect(n).toBe(3);
  });

  it('explain reflects sort when provided (plan picks up a SORT stage)', async () => {
    // Without sort: plan shouldn't contain a SORT stage.
    const noSort = await svc.explain({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      verbosity: 'queryPlanner',
    });
    expect(JSON.stringify(noSort.plan)).not.toContain('"stage":"SORT"');

    // With sort: the plan must include a SORT stage. If the service drops
    // sort, this assertion fails — which is the regression to catch.
    const withSort = await svc.explain({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{}',
      sort: '{"n":-1}',
      verbosity: 'queryPlanner',
    });
    expect(JSON.stringify(withSort.plan)).toContain('"stage":"SORT"');
  });

  // BUG REPRO #2.1 — greedy EJSON.parse collapses {$regex,"^9",$gte:"93"} to
  // BSONRegExp, silently dropping $gte. Both docs match the bare regex; only
  // name:"95" should match when $gte:"93" is preserved.
  it('find: $regex + sibling $gte both applied — only name:"95" returned (REPRO 2.1)', async () => {
    const client = await pool.write(connId).client();
    const reproColl = 'repro_21';
    const coll = client.db(dbName).collection(reproColl);
    await coll.drop().catch(() => {});
    await coll.insertMany([
      { name: '90', price: 5 },
      { name: '95', price: 500 },
    ]);

    const filter = JSON.stringify({ name: { $regex: '^9', $gte: '93' } });
    const result = await svc.find({
      connectionId: connId,
      dbName,
      collection: reproColl,
      filter,
      limit: 10,
      skip: 0,
    });
    const docs = parseDocs(result.documentsJson) as Array<Record<string, unknown>>;
    // Bug: drops $gte → both "90" and "95" match → length 2.
    // Fix: $gte:"93" applied → only "95" >= "93" → length 1.
    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe('95');
  });

  // W03 §9 — "query:cancel aborts an in-flight long query". `$where` with a
  // server-side sleep is the standard way to make a find observably slow
  // without a flaky timing assumption on collection size or missing index.
  it('cancel(token) aborts an in-flight find quickly instead of waiting out the query', async () => {
    const token = 'cancel-find-tok';
    const t0 = Date.now();
    const promise = svc.find({
      connectionId: connId,
      dbName,
      collection: collName,
      filter: '{"$where":"sleep(5000) || true"}',
      limit: 10,
      skip: 0,
      cancelToken: token,
    });
    // Give the driver a tick to actually issue the query before cancelling.
    await new Promise((r) => setTimeout(r, 50));
    svc.cancel(token);

    await expect(promise).rejects.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('cancel(token) is a no-op for a token with nothing in flight', () => {
    expect(() => svc.cancel('no-such-token')).not.toThrow();
  });

  // #28 — the caps a user can hit say what they are and what to do, instead
  // of an `INTERNAL` byte count or a raw driver "MaxTimeMS" message.
  describe('caps explain themselves', () => {
    const limited = (limits: { maxFindBytes?: number; queryTimeoutMs?: number }) =>
      new QueryService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db)), undefined, undefined, limits);

    it('a result over the byte cap is refused as VALIDATION with what to change', async () => {
      const client = await pool.write(connId).client();
      const big = client.db(dbName).collection('big');
      await big.deleteMany({});
      await big.insertMany(Array.from({ length: 5 }, (_, i) => ({ n: i, pad: 'x'.repeat(1024) })));

      const err = await limited({ maxFindBytes: 2000 })
        .find({ connectionId: connId, dbName, collection: 'big', filter: '{}', limit: 5, skip: 0 })
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ code: 'VALIDATION' });
      expect((err as Error).message).toMatch(/larger than 2000 bytes/);
      expect((err as Error).message).toMatch(/projection/);
    });

    it('a result under the cap is unaffected', async () => {
      const result = await limited({ maxFindBytes: 1_000_000 }).find({
        connectionId: connId, dbName, collection: 'big', filter: '{}', limit: 5, skip: 0,
      });
      expect(JSON.parse(result.documentsJson)).toHaveLength(5);
    });

    it('a query stopped by the time limit is a TIMEOUT that says how long and what to do', async () => {
      const err = await limited({ queryTimeoutMs: 50 })
        .find({
          connectionId: connId,
          dbName,
          collection: collName,
          filter: '{"$where":"sleep(500) || true"}',
          limit: 10,
          skip: 0,
        })
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ code: 'TIMEOUT' });
      expect((err as Error).message).toMatch(/stopped after 0\.05 s/);
      expect((err as Error).message).toMatch(/index|filter/);
      expect((err as Error).message).not.toMatch(/MaxTimeMS/i);
    });
  });
});
