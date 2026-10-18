import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Collection } from 'mongodb';
import type { Stage } from '@shared/types';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { AggregationService } from '../../electron/mongo/AggregationService';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { createTempDb, type TempDb } from '../helpers/db';
import { getSharedMongoUri, makeConnection, makeReader } from '../helpers/mongo';

describe('AggregationService', () => {
  let pool: MongoPool;
  let svc: AggregationService;
  let tmp: TempDb;
  const connId = 'agg-conn';
  const dbName = 'aggdb';
  const collName = 'transactions';

  beforeAll(async () => {
    const uri = getSharedMongoUri();
    const hp = { host: new URL(uri).hostname, port: Number(new URL(uri).port) };
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({
      repo: makeReader([conn]),
      vault: { get: () => null } as unknown as import('../../electron/secrets/SecretsVault').SecretsVault,
    });

    tmp = createTempDb();
    tmp.db.prepare(`
      INSERT INTO connections (
        id, name, color, connection_type, host, port,
        auth_mech, tls_enabled, tls_verify, ssh_enabled,
        connect_timeout_ms, socket_timeout_ms, server_selection_timeout_ms,
        read_preference, max_pool_size, direct_connection,
        created_at, updated_at
      ) VALUES (
        ?, 'AggTest', '#1A6835', 'standard', ?, ?,
        'none', 0, 1, 0,
        5000, 5000, 5000,
        'primary', 5, 1,
        ?, ?
      )
    `).run(connId, hp.host, hp.port, new Date().toISOString(), new Date().toISOString());

    const recentRepo = new RecentQueryRepo(tmp.db);
    const recentSvc = new RecentQueryService(recentRepo);
    svc = new AggregationService(pool, recentSvc);

    // Seed some data
    const client = await pool.write(connId).client();
    const coll = client.db(dbName).collection(collName);
    await coll.deleteMany({});
    await coll.insertMany([
      { account: 'a', month: 1, amount: 100, posted: true },
      { account: 'a', month: 1, amount: 50, posted: true },
      { account: 'a', month: 2, amount: 75, posted: true },
      { account: 'b', month: 1, amount: 40, posted: true },
      { account: 'b', month: 2, amount: 10, posted: false },
    ]);
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  it('runs a happy-path pipeline with stage counts', async () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{"posted":true}', enabled: true },
      {
        id: 2,
        op: '$group',
        body: '{"_id":"$account","total":{"$sum":"$amount"}}',
        enabled: true,
      },
      { id: 3, op: '$sort', body: '{"total":-1}', enabled: true },
    ];
    const result = await svc.run({
      connectionId: connId,
      dbName,
      collection: collName,
      stages,
    });
    // Service returns the wire shape; parse rows once at the assertion edge.
    const rows = JSON.parse(result.rowsJson) as unknown[];
    expect(rows.length).toBe(2);
    expect(result.stageCounts[1]).toBe(4);
    expect(result.stageCounts[2]).toBe(2);
    expect(result.stageCounts[3]).toBe(2);
    expect(result.stageSamples[2]?.length).toBeLessThanOrEqual(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('omits disabled stages from execution and instrumentation', async () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{"posted":true}', enabled: false },
      {
        id: 2,
        op: '$group',
        body: '{"_id":"$account","total":{"$sum":"$amount"}}',
        enabled: true,
      },
    ];
    const result = await svc.run({
      connectionId: connId,
      dbName,
      collection: collName,
      stages,
    });
    expect(result.stageCounts[1]).toBeUndefined();
    // All 5 documents pass through (no match filter)
    expect(result.stageCounts[2]).toBe(2);
  });

  it('blocks $out runs without allowWrite', async () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{}', enabled: true },
      { id: 2, op: '$out', body: '"copy"', enabled: true },
    ];
    await expect(
      svc.run({
        connectionId: connId,
        dbName,
        collection: collName,
        stages,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('run with allowWrite rejects $out targeting the source collection (#2.17)', async () => {
    // Direct agg:run with allowWrite previously bypassed runAndSave's guards and
    // would let $out overwrite the source collection. The guard now lives in run().
    await expect(
      svc.run({
        connectionId: connId,
        dbName,
        collection: collName,
        stages: [
          { id: 1, op: '$match', body: '{}', enabled: true },
          { id: 2, op: '$out', body: JSON.stringify(collName), enabled: true },
        ],
        allowWrite: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('run with allowWrite rejects an invalid $out collection name (#2.17)', async () => {
    await expect(
      svc.run({
        connectionId: connId,
        dbName,
        collection: collName,
        stages: [
          { id: 1, op: '$match', body: '{}', enabled: true },
          { id: 2, op: '$out', body: JSON.stringify('$bad'), enabled: true },
        ],
        allowWrite: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('previewUpToStage returns a capped sample', async () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{"posted":true}', enabled: true },
    ];
    const res = await svc.previewUpToStage({
      connectionId: connId,
      dbName,
      collection: collName,
      stages,
      limit: 2,
    });
    expect(res.sample.length).toBeLessThanOrEqual(2);
    expect(res.count).toBe(4);
  });

  it('rejects $out that matches source collection', async () => {
    await expect(
      svc.runAndSave({
        connectionId: connId,
        dbName,
        collection: collName,
        stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
        target: {
          dbName,
          collection: collName,
          mode: '$out',
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('explain returns a plan for queryPlanner', async () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{"posted":true}', enabled: true },
    ];
    const res = await svc.explain({
      connectionId: connId,
      dbName,
      collection: collName,
      stages,
      verbosity: 'queryPlanner',
    });
    expect(res.verbosity).toBe('queryPlanner');
    expect(res.plan).toBeDefined();
    expect(res.writeStageOmitted).toBe(false);
  });

  it('explain strips write stages', async () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{}', enabled: true },
      { id: 2, op: '$out', body: '"copy"', enabled: true },
    ];
    const res = await svc.explain({
      connectionId: connId,
      dbName,
      collection: collName,
      stages,
      verbosity: 'queryPlanner',
    });
    expect(res.writeStageOmitted).toBe(true);
  });

  // ─── Performance regression guards ───────────────────────────────────────
  //
  // `instrument()` tries `instrumentFacet` first (one round-trip) and silently
  // falls through to `instrumentSeparate` (2 round-trips × N stages) on any
  // throw. A future refactor that introduces a bug inside `instrumentFacet`
  // — a parse error, a typo, a new validation — would regress a normal
  // server from O(1) to O(N) round-trips with no signal to the user.

  it('uses the $facet instrumentation path on a normal server', async () => {
    const facetSpy = vi.spyOn(
      svc as unknown as { instrumentFacet: (...a: unknown[]) => unknown },
      'instrumentFacet',
    );
    const sepSpy = vi.spyOn(
      svc as unknown as { instrumentSeparate: (...a: unknown[]) => unknown },
      'instrumentSeparate',
    );
    try {
      const stages: Stage[] = [
        { id: 1, op: '$match', body: '{"posted":true}', enabled: true },
        {
          id: 2,
          op: '$group',
          body: '{"_id":"$account","total":{"$sum":"$amount"}}',
          enabled: true,
        },
        { id: 3, op: '$sort', body: '{"total":-1}', enabled: true },
      ];
      await svc.run({
        connectionId: connId,
        dbName,
        collection: collName,
        stages,
      });
      expect(facetSpy).toHaveBeenCalledTimes(1);
      expect(sepSpy).not.toHaveBeenCalled();
    } finally {
      facetSpy.mockRestore();
      sepSpy.mockRestore();
    }
  });

  it('caps every aggregate() call with maxTimeMS', async () => {
    // AggregationService used to set no maxTimeMS on any of its four execution
    // paths, so a client-side cancel stopped the app waiting but never the
    // server working. Assert the option is actually on the wire rather than
    // relying on a real slow query, which mongodb-memory-server can't induce
    // deterministically.
    const aggregateSpy = vi.spyOn(Collection.prototype, 'aggregate');
    try {
      const stages: Stage[] = [
        { id: 1, op: '$match', body: '{"posted":true}', enabled: true },
        {
          id: 2,
          op: '$group',
          body: '{"_id":"$account","total":{"$sum":"$amount"}}',
          enabled: true,
        },
      ];
      await svc.run({ connectionId: connId, dbName, collection: collName, stages });
      await svc.previewUpToStage({
        connectionId: connId,
        dbName,
        collection: collName,
        stages,
      });
      await svc.explain({
        connectionId: connId,
        dbName,
        collection: collName,
        stages,
        verbosity: 'queryPlanner',
      });

      expect(aggregateSpy.mock.calls.length).toBeGreaterThan(0);
      for (const call of aggregateSpy.mock.calls) {
        const options = call[1] as { maxTimeMS?: number } | undefined;
        expect(options?.maxTimeMS).toBeGreaterThan(0);
      }
    } finally {
      aggregateSpy.mockRestore();
    }
  });

  it('runs a 5-stage pipeline within a generous wall-clock budget', async () => {
    // The main query and instrumentation run via Promise.all in `run()`. If a
    // refactor ever serialises them, runtime scales with stage count. A 5-stage
    // pipeline on the seeded data normally finishes in <200 ms; the 2 s budget
    // gives ~10× headroom while still catching a meaningful regression.
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{"posted":true}', enabled: true },
      {
        id: 2,
        op: '$group',
        body: '{"_id":"$account","total":{"$sum":"$amount"}}',
        enabled: true,
      },
      { id: 3, op: '$sort', body: '{"total":-1}', enabled: true },
      { id: 4, op: '$project', body: '{"_id":1,"total":1}', enabled: true },
      { id: 5, op: '$limit', body: '10', enabled: true },
    ];
    const t0 = Date.now();
    const result = await svc.run({
      connectionId: connId,
      dbName,
      collection: collName,
      stages,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    // Sanity: instrumentation populated counts for every enabled stage. If a
    // future change drops a stage from the $facet branch, this trips.
    expect(Object.keys(result.stageCounts)).toHaveLength(5);
  });

  // the guard sits INSIDE run(), only in the
  // `if (writeStage && input.allowWrite)` branch. A plain read pipeline (no
  // $out/$merge) must keep working on a read-only connection; a pipeline
  // that actually writes must reject, whether reached via run() directly or
  // via runAndSave() (which appends a synthetic $out/$merge and calls
  // run() with allowWrite: true internally).
  describe('read-only connection guard', () => {
    let guardTmp: TempDb;
    let guardPool: MongoPool;
    let guardSvc: AggregationService;
    const rwConnId = 'agg-guard-rw';
    const roConnId = 'agg-guard-ro';

    beforeAll(() => {
      const hp = { host: new URL(getSharedMongoUri()).hostname, port: Number(new URL(getSharedMongoUri()).port) };
      const rwConn = makeConnection(rwConnId, hp, { defaultDb: dbName });
      const roConn = makeConnection(roConnId, hp, { defaultDb: dbName, readOnly: true });
      guardPool = new MongoPool({
        repo: makeReader([rwConn, roConn]),
        vault: { get: () => null } as unknown as import('../../electron/secrets/SecretsVault').SecretsVault,
      });

      guardTmp = createTempDb();
      for (const [id, host, port] of [
        [rwConnId, hp.host, hp.port],
        [roConnId, hp.host, hp.port],
      ] as const) {
        guardTmp.db
          .prepare(
            `
          INSERT INTO connections (
            id, name, color, connection_type, host, port,
            auth_mech, tls_enabled, tls_verify, ssh_enabled,
            connect_timeout_ms, socket_timeout_ms, server_selection_timeout_ms,
            read_preference, max_pool_size, direct_connection,
            created_at, updated_at
          ) VALUES (
            ?, ?, '#1A6835', 'standard', ?, ?,
            'none', 0, 1, 0,
            5000, 5000, 5000,
            'primary', 5, 1,
            ?, ?
          )
        `,
          )
          .run(id, `AggGuardTest-${id}`, host, port, new Date().toISOString(), new Date().toISOString());
      }
      const recentRepo = new RecentQueryRepo(guardTmp.db);
      const recentSvc = new RecentQueryService(recentRepo);
      guardSvc = new AggregationService(guardPool, recentSvc);
    });

    afterAll(async () => {
      await guardPool.disconnectAll();
      guardTmp.cleanup();
    });

    it('run() with a plain read pipeline succeeds on the read-only connection', async () => {
      const result = await guardSvc.run({
        connectionId: roConnId,
        dbName,
        collection: collName,
        stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
      });
      const rows = JSON.parse(result.rowsJson) as unknown[];
      expect(rows.length).toBe(5);
    });

    it('run() with a write stage + allowWrite rejects on read-only, succeeds on writable', async () => {
      const outColl = 'ro_guard_agg_out';
      const stages: Stage[] = [
        { id: 1, op: '$match', body: '{}', enabled: true },
        { id: 2, op: '$out', body: JSON.stringify(outColl), enabled: true },
      ];

      await expect(
        guardSvc.run({ connectionId: roConnId, dbName, collection: collName, stages, allowWrite: true }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      const clientAfterReject = await guardPool.readClient(rwConnId);
      expect(
        await clientAfterReject.db(dbName).collection(outColl).countDocuments({}),
      ).toBe(0);

      await guardSvc.run({ connectionId: rwConnId, dbName, collection: collName, stages, allowWrite: true });
      const client = await guardPool.readClient(rwConnId);
      expect(await client.db(dbName).collection(outColl).countDocuments({})).toBeGreaterThan(0);
    });

    it('runAndSave() rejects on read-only, succeeds on writable', async () => {
      const outColl = 'ro_guard_agg_run_and_save_out';
      const target = { dbName, collection: outColl, mode: '$out' as const };

      await expect(
        guardSvc.runAndSave({
          connectionId: roConnId,
          dbName,
          collection: collName,
          stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
          target,
        }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      const clientAfterReject = await guardPool.readClient(rwConnId);
      expect(
        await clientAfterReject.db(dbName).collection(outColl).countDocuments({}),
      ).toBe(0);

      const res = await guardSvc.runAndSave({
        connectionId: rwConnId,
        dbName,
        collection: collName,
        stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
        target,
      });
      expect(res.writtenCount).toBeGreaterThan(0);
    });

    // ADR 0005: refuse before anything asks the server. A `$merge` counts its
    // target before writing, and that count has to wait for the refusal and
    // for local validation, or a read-only connection is queried first and a
    // malformed stage waits out a scan of the target before it is reported.
    it('runAndSave() with $merge refuses a read-only connection before counting the target', async () => {
      const readDb = vi.spyOn(guardPool, 'readDb');
      try {
        await expect(
          guardSvc.runAndSave({
            connectionId: roConnId,
            dbName,
            collection: collName,
            stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
            target: { dbName, collection: 'ro_guard_merge', mode: '$merge' },
          }),
        ).rejects.toMatchObject({ code: 'READ_ONLY' });
        expect(readDb).not.toHaveBeenCalled();
      } finally {
        readDb.mockRestore();
      }
    });

    it('runAndSave() with $merge reports a malformed stage before counting the target', async () => {
      const readDb = vi.spyOn(guardPool, 'readDb');
      try {
        await expect(
          guardSvc.runAndSave({
            connectionId: rwConnId,
            dbName,
            collection: collName,
            stages: [{ id: 1, op: '$match', body: '{ nope', enabled: true }],
            target: { dbName, collection: 'rw_guard_merge', mode: '$merge' },
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(readDb).not.toHaveBeenCalled();
      } finally {
        readDb.mockRestore();
      }
    });
  });

  /**
   * Cancel against a real server, mid-pipeline. The slow stage is a JS
   * `$function` busy loop (`$where`/`sleep` is refused in aggregation), about
   * 3ms per document, so an uncancelled run takes about 4.5s.
   *
   * A read aggregate is killed server-side once the driver aborts and drops
   * the socket. A `$out` aggregate is not: the server finishes it and the
   * write lands anyway. So a write pipeline must never report "cancelled" once
   * its write can no longer be stopped — it runs to completion and reports
   * completed.
   */
  describe('cancel mid-pipeline', () => {
    const cancelDb = 'aggcancel';
    const slowColl = 'slow_src';
    const docCount = 1500;
    const slowMatch: Stage = {
      id: 1,
      op: '$match',
      body: JSON.stringify({
        $expr: {
          $function: {
            body: 'function(){ var t = Date.now(); while (Date.now() - t < 3) {} return true; }',
            args: [],
            lang: 'js',
          },
        },
      }),
      enabled: true,
    };

    const db = async () => (await pool.write(connId).client()).db(cancelDb);

    const aggregatesOnSlowColl = async (): Promise<number> => {
      const client = await pool.write(connId).client();
      // Match on namespace only: currentOp shows a long command (the
      // instrumentation $facet) as `command.$truncated`, so a filter on
      // `command.aggregate` would never see it.
      const res = await client.db('admin').command({
        currentOp: 1,
        ns: `${cancelDb}.${slowColl}`,
      });
      return (res.inprog as unknown[]).length;
    };

    const untilNoAggregate = async (budgetMs: number): Promise<number> => {
      const deadline = Date.now() + budgetMs;
      let n = await aggregatesOnSlowColl();
      while (n > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        n = await aggregatesOnSlowColl();
      }
      return n;
    };

    // Poll until the server is running an op on the source collection, so a
    // cancel lands mid-flight however slow setup was on a loaded machine.
    const untilAggregateRunning = async (budgetMs: number): Promise<void> => {
      const deadline = Date.now() + budgetMs;
      while ((await aggregatesOnSlowColl()) === 0) {
        if (Date.now() > deadline) throw new Error('aggregate never started on the server');
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    beforeAll(async () => {
      const d = await db();
      await d.dropDatabase();
      await d
        .collection(slowColl)
        .insertMany(Array.from({ length: docCount }, (_, i) => ({ i })));
    });

    afterAll(async () => {
      // Let any op a failing run left behind drain before the next suite.
      await untilNoAggregate(10_000);
      await (await db()).dropDatabase();
    });

    it('a cancelled read pipeline rejects at once and stops working on the server', async () => {
      const token = 'cancel-read-mid-pipeline';
      const t0 = Date.now();
      const run = svc
        .run({
          connectionId: connId,
          dbName: cancelDb,
          collection: slowColl,
          // `$group` emits nothing until it has read every document, so the
          // whole read is one long `aggregate` command currentOp can see
          // (otherwise the first batch returns early and the rest runs as
          // `getMore`s the probe does not match).
          stages: [
            slowMatch,
            { id: 2, op: '$group', body: '{"_id":null,"n":{"$sum":1}}', enabled: true },
          ],
          cancelToken: token,
        })
        .catch((e: unknown) => e);
      setTimeout(() => svc.cancel(token), 300);
      const err = await run;
      const elapsed = Date.now() - t0;

      expect(err).toMatchObject({ message: 'cancelled' });
      // The uncancelled run takes ~4.5s.
      expect(elapsed).toBeLessThan(2500);
      // Without the signal on the main aggregate or on the instrumentation
      // $facet, that aggregate keeps the server busy after the run has
      // already reported cancelled.
      expect(await untilNoAggregate(3000)).toBe(0);
    });

    it('a write pipeline cancelled mid-flight completes and is reported as completed', async () => {
      const target = 'cancel_out_target';
      const token = 'cancel-write-mid-pipeline';
      const run = svc.run({
        connectionId: connId,
        dbName: cancelDb,
        collection: slowColl,
        stages: [slowMatch, { id: 2, op: '$out', body: JSON.stringify(target), enabled: true }],
        allowWrite: true,
        cancelToken: token,
      });
      await untilAggregateRunning(15_000);
      svc.cancel(token);

      const result = await run;
      expect(result.rowsJson).toBe('[]');
      expect(await (await db()).collection(target).countDocuments()).toBe(docCount);
    });

    it("a sent write's own failure after a cancel is reported as that failure, not cancelled", async () => {
      const target = 'cancel_merge_fail_target';
      const token = 'cancel-write-then-fail';
      const d = await db();
      // Every source `_id` already exists in the target, so `whenMatched:
      // 'fail'` rejects when $merge flushes, after the slow stage has run.
      const ids = await d.collection(slowColl).find({}, { projection: { _id: 1 } }).toArray();
      await d.collection(target).insertMany(ids.map(({ _id }) => ({ _id, old: true })));
      const run = svc
        .run({
          connectionId: connId,
          dbName: cancelDb,
          collection: slowColl,
          stages: [
            slowMatch,
            {
              id: 2,
              op: '$merge',
              body: JSON.stringify({ into: target, whenMatched: 'fail' }),
              enabled: true,
            },
          ],
          allowWrite: true,
          cancelToken: token,
        })
        .catch((e: unknown) => e);
      await untilAggregateRunning(15_000);
      svc.cancel(token);

      const err = await run;
      expect(err).toMatchObject({ code: 'CONFLICT', details: { mongoCode: 11000 } });
      expect((err as Error).message).not.toBe('cancelled');
    });

    it('a cancel during instrumentation, after the write landed, is reported as completed', async () => {
      type WithInstrument = { instrument: (...a: unknown[]) => unknown };
      const target = 'cancel_race_target';
      const token = 'cancel-after-write';
      const original = (svc as unknown as WithInstrument).instrument;
      const spy = vi
        .spyOn(svc as unknown as WithInstrument, 'instrument')
        .mockImplementation(function (this: unknown, ...args: unknown[]) {
          svc.cancel(token);
          return original.apply(this, args);
        });
      try {
        const result = await svc.run({
          connectionId: connId,
          dbName,
          collection: collName,
          stages: [
            { id: 1, op: '$match', body: '{"posted":true}', enabled: true },
            { id: 2, op: '$out', body: JSON.stringify(target), enabled: true },
          ],
          allowWrite: true,
          cancelToken: token,
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(result.rowsJson).toBe('[]');
        const client = await pool.write(connId).client();
        expect(await client.db(dbName).collection(target).countDocuments()).toBe(4);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

/**
 * Cancellation has to be registered before anything connects.
 *
 * `run()` takes its write grant early (the read-only refusal) but does not
 * connect until `getCollection` asks the grant for a handle, and that has to
 * stay *after* `registerCancel`. Move the connect above it and an `agg:cancel`
 * arriving while the pool is still connecting finds no entry, silently
 * discards the cancellation, and the pipeline — including a `$out` write —
 * runs to completion once the connection resolves.
 *
 * The assertion is on whether the pipeline executed, not on which error came
 * back: a version that throws for an unrelated reason would otherwise look
 * like a pass.
 */
describe('AggregationService — cancel during connection setup', () => {
  let tmp: TempDb;

  beforeAll(() => {
    tmp = createTempDb();
  });

  afterAll(() => {
    tmp.cleanup();
  });

  it('does not execute the pipeline when cancel arrives while the handle is still resolving', async () => {
    // `coll.aggregate()` only builds a cursor — nothing runs until a terminal
    // method is called, so execution is `toArray`, not `aggregate`.
    const execute = vi.fn(async () => []);
    const aggregate = vi.fn(() => ({ toArray: execute }));

    // The connect the grant performs, held open until the test releases it.
    let release!: () => void;
    const connected = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fakePool = {
      isReadOnly: () => false,
      write: () => ({
        db: async () => {
          await connected;
          return { collection: () => ({ aggregate }) };
        },
        client: async () => {
          throw new Error('not used');
        },
      }),
      readDb: async () => {
        await connected;
        return { collection: () => ({ aggregate }) };
      },
    } as unknown as MongoPool;

    const recent = new RecentQueryService(new RecentQueryRepo(tmp.db));
    const svc = new AggregationService(fakePool, recent);
    const token = 'cancel-during-connect';

    const run = svc.run({
      connectionId: 'c',
      dbName: 'd',
      collection: 'src',
      stages: [
        { id: 's1', op: '$match', body: '{}', enabled: true },
        { id: 's2', op: '$out', body: '"dest"', enabled: true },
      ],
      allowWrite: true,
      cancelToken: token,
    } as never);
    const settled = run.catch((e: unknown) => e);

    // Let run() reach the awaited handle, then cancel while it is pending.
    await Promise.resolve();
    await Promise.resolve();
    svc.cancel(token);
    release();
    await settled;

    expect(execute).not.toHaveBeenCalled();
  });
});

/**
 * The route that actually reaches disk.
 *
 * `AggregationTab` stores `e.details` *whole* into `lastRun.error.details`,
 * which is a declared field of the persisted tab state — so whatever the
 * classifier puts in `details` is written to `workspace_tabs.state_json`
 * through the debounced tab update. A `$out` into a collection with a
 * `$jsonSchema` validator is the path that produces `errInfo`, and `errInfo`
 * arrives as live BSON: `failingDocumentId` is an ObjectId wrapping a Buffer.
 *
 * Unencoded, that reached the renderer as `{ buffer: Uint8Array }` and
 * JSON.stringified into an index-keyed blob in the persisted state. Nothing
 * threw, which is why it needed a test rather than a bug report.
 */
describe('AggregationService — a write stage rejected by a validator', () => {
  let pool: MongoPool;
  let svc: AggregationService;
  let tmp: TempDb;
  const connId = 'agg-dv-conn';
  const dbName = 'agg_dv_db';
  const srcColl = 'dv_source';
  const destColl = 'dv_validated';

  beforeAll(async () => {
    const uri = getSharedMongoUri();
    const hp = { host: new URL(uri).hostname, port: Number(new URL(uri).port) };
    const conn = makeConnection(connId, hp, { defaultDb: dbName });
    pool = new MongoPool({
      repo: makeReader([conn]),
      vault: { get: () => null } as unknown as import('../../electron/secrets/SecretsVault').SecretsVault,
    });
    tmp = createTempDb();
    svc = new AggregationService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db)));

    const client = await pool.write(connId).client();
    const db = client.db(dbName);
    await db.collection(srcColl).drop().catch(() => {});
    await db.collection(destColl).drop().catch(() => {});
    await db.collection(srcColl).insertOne({ n: 'not-an-int' });
    await db.createCollection(destColl, {
      validator: {
        $jsonSchema: { bsonType: 'object', required: ['n'], properties: { n: { bsonType: 'int' } } },
      },
    });
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  const outStage = (): Stage[] => [
    { id: 1, op: '$out', body: JSON.stringify(destColl), enabled: true },
  ];

  it('surfaces as VALIDATION, not MONGO_ERROR', async () => {
    await expect(
      svc.run({ connectionId: connId, dbName, collection: srcColl, stages: outStage(), allowWrite: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('carries errInfo as Extended JSON, not live BSON', async () => {
    let caught: { details?: { errInfo?: Record<string, unknown> } } | undefined;
    try {
      await svc.run({
        connectionId: connId,
        dbName,
        collection: srcColl,
        stages: outStage(),
        allowWrite: true,
      });
    } catch (e) {
      caught = e as { details?: { errInfo?: Record<string, unknown> } };
    }
    const errInfo = caught?.details?.errInfo;
    expect(errInfo).toBeDefined();

    // Nothing reachable from errInfo may be a BSON instance: this object is
    // persisted verbatim, so a class here becomes an index-keyed byte blob.
    const seen = new Set<unknown>();
    const assertPlain = (v: unknown, path: string): void => {
      if (v === null || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      const ctor = v.constructor?.name;
      expect(ctor, `${path} is a ${ctor}, not plain data`).toMatch(/^(Object|Array)$/);
      for (const [k, child] of Object.entries(v)) assertPlain(child, `${path}.${k}`);
    };
    assertPlain(errInfo, 'errInfo');
  });
});

describe('AggregationService.runningCount', () => {
  let tmp: TempDb;

  beforeAll(() => {
    tmp = createTempDb();
  });

  afterAll(() => {
    tmp.cleanup();
  });

  function held(outcome: 'resolve' | 'reject') {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = { reached: false };
    const toArray = async () => {
      started.reached = true;
      await gate;
      if (outcome === 'reject') throw new Error('boom');
      return [];
    };
    const coll = { aggregate: () => ({ toArray }) };
    const pool = {
      isReadOnly: () => false,
      readDb: async () => ({ collection: () => coll }),
    } as unknown as MongoPool;
    const svc = new AggregationService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db)));
    return { svc, finish, started };
  }

  const input = (cancelToken?: string) =>
    ({
      connectionId: 'c',
      dbName: 'd',
      collection: 'src',
      stages: [{ id: 's1', op: '$match', body: '{}', enabled: true }],
      cancelToken,
    }) as never;

  const untilReached = async (started: { reached: boolean }) => {
    for (let i = 0; i < 50 && !started.reached; i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('counts a run in flight, with or without a cancel token, and not once it finishes', async () => {
    for (const token of [undefined, 'tok']) {
      const { svc, finish, started } = held('resolve');
      expect(svc.runningCount()).toBe(0);
      const run = svc.run(input(token));
      await untilReached(started);
      expect(svc.runningCount()).toBe(1);
      finish();
      await run;
      expect(svc.runningCount()).toBe(0);
    }
  });

  it('stops counting a run that fails', async () => {
    const { svc, finish, started } = held('reject');
    const run = svc.run(input()).catch((e: unknown) => e);
    await untilReached(started);
    expect(svc.runningCount()).toBe(1);
    finish();
    await run;
    expect(svc.runningCount()).toBe(0);
  });

  it('stops counting a run once it is cancelled and has unwound', async () => {
    const { svc, finish, started } = held('resolve');
    const run = svc.run(input('tok')).catch((e: unknown) => e);
    await untilReached(started);
    svc.cancel('tok');
    finish();
    await run;
    expect(svc.runningCount()).toBe(0);
  });

  it('clears the cancel token when the connection cannot be opened', async () => {
    const pool = {
      isReadOnly: () => false,
      readDb: async () => {
        throw new Error('connect failed');
      },
    } as unknown as MongoPool;
    const svc = new AggregationService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db)));
    await expect(svc.run(input('tok'))).rejects.toThrow('connect failed');
    expect((svc as unknown as { active: Map<string, unknown> }).active.size).toBe(0);
    expect(svc.runningCount()).toBe(0);
  });
});
