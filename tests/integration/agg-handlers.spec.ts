import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AggResultWire, AggSaveCounts, AggStagePreview } from '@shared/types';
import { createRouter } from '../../electron/ipc/router';
import { registerAggChannels } from '../../electron/ipc/handlers/agg';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { AggregationService } from '../../electron/mongo/AggregationService';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import type { Logger } from '../../electron/log';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, insertConnectionRow, type TempDb } from '../helpers/db';
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
 * Drives `agg:*` through the real router, zod validators, `AggregationService`,
 * `MongoPool` and a real mongod. The service spec skips the router and the
 * registration spec stubs the service, so neither proves that `agg.ts` accepts
 * what the renderer sends, forwards every field of it, or that a failure
 * crosses as a typed code.
 *
 * Schema rejections go through `expectSchemaReject`: the service raises
 * VALIDATION too (no enabled stages, a bad collection name) and mongod answers
 * BadValue as VALIDATION, so a bare code check would stay green with the schema
 * loosened.
 */
const DB = 'agg_router_shop';
const SRC = 'products';
const RW = 'agg-rw';
const RO = 'agg-ro';
const DEAD = 'agg-dead';
const SEEDED = ['apple', 'banana', 'cherry', 'carrot', 'leek'];

const stage = (id: number, op: string, body: string, enabled = true) => ({ id, op, body, enabled });
const input = (overrides: Record<string, unknown> = {}) => ({
  connectionId: RW,
  dbName: DB,
  collection: SRC,
  stages: [stage(1, '$match', '{}')],
  ...overrides,
});
const fruitNames = [
  stage(1, '$match', '{"kind":"fruit"}'),
  stage(2, '$sort', '{"name":1}'),
  stage(3, '$project', '{"_id":0,"name":1}'),
];
const names = (data: AggResultWire) =>
  (JSON.parse(data.rowsJson) as Array<{ name: string }>).map((r) => r.name);
/** Whether `key` appears anywhere in a nested explain plan; its layout shifts with the pipeline. */
const hasKey = (value: unknown, key: string): boolean =>
  value !== null &&
  typeof value === 'object' &&
  (key in value || Object.values(value).some((v) => hasKey(v, key)));

describe('agg:* channels via router', () => {
  let tmp: TempDb;
  let pool: MongoPool;
  let svc: AggregationService;
  const shim = createIpcShim();

  const countOf = async (collection: string) =>
    (await pool.readDb(RW, DB)).collection(collection).countDocuments({});
  const exists = async (collection: string) =>
    (await (await pool.readDb(RW, DB)).listCollections({ name: collection }).toArray()).length === 1;

  beforeAll(async () => {
    const seed = new MongoClient(getSharedMongoUri());
    try {
      await seed.connect();
      await seed
        .db(DB)
        .collection(SRC)
        .insertMany(
          SEEDED.map((name) => ({ name, kind: ['apple', 'banana', 'cherry'].includes(name) ? 'fruit' : 'veg' })),
        );
    } finally {
      await seed.close();
    }

    tmp = createTempDb();
    // The service records each run in the recent-query table, fire-and-forget:
    // without these rows the FK failure is swallowed and hides a real one.
    insertConnectionRow(tmp.db, RW);
    insertConnectionRow(tmp.db, RO);
    const hp = uriToHostPort(getSharedMongoUri());
    pool = new MongoPool({
      repo: makeReader([
        makeConnection(RW, hp, { defaultDb: DB }),
        makeConnection(RO, hp, { defaultDb: DB, readOnly: true }),
        // Nothing listens on port 1: every connect attempt is refused and the
        // driver then waits out `serverSelectionTimeoutMs` before giving up.
        makeConnection(DEAD, { host: '127.0.0.1', port: 1 }, {
          defaultDb: DB,
          advanced: {
            connectTimeoutMs: 500,
            socketTimeoutMs: 500,
            serverSelectionTimeoutMs: 500,
            readPreference: 'primary',
            maxPoolSize: 5,
            directConnection: true,
          },
        }),
      ]),
      vault: new SecretsVault(tmp.db, createSafeStorageMock()),
    });
    svc = new AggregationService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db)));
    registerAggChannels(createRouter(shim.ipcMain, testSenderCheck), svc);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  // Every channel but agg:cancel validates the same collection target and stage
  // shape; a required string is covered both empty and absent, and the service
  // must not be reached for either.
  describe.each([
    ['agg:run', IPC_CHANNELS.aggRun, 'run', {}],
    ['agg:previewUpToStage', IPC_CHANNELS.aggPreviewUpToStage, 'previewUpToStage', {}],
    [
      'agg:runAndSave',
      IPC_CHANNELS.aggRunAndSave,
      'runAndSave',
      { target: { dbName: DB, collection: 'never_written', mode: '$out' } },
    ],
    ['agg:explain', IPC_CHANNELS.aggExplain, 'explain', { verbosity: 'queryPlanner' }],
  ] as const)('%s required fields', (_name, channel, method, extra) => {
    it.each([
      ...(['connectionId', 'dbName', 'collection'] as const).flatMap((key) => [
        [`an empty ${key}`, { [key]: '' }, key] as const,
        [`a missing ${key}`, { [key]: undefined }, key] as const,
      ]),
      ['an empty stage op', { stages: [stage(1, '', '{}')] }, 'stages.0.op'] as const,
      ['a missing stage op', { stages: [{ id: 1, body: '{}', enabled: true }] }, 'stages.0.op'] as const,
      ['a non-string stage body', { stages: [{ id: 1, op: '$match', body: 5, enabled: true }] }, 'stages.0.body'] as const,
      ['a missing enabled flag', { stages: [{ id: 1, op: '$match', body: '{}' }] }, 'stages.0.enabled'] as const,
      ['a non-boolean enabled flag', { stages: [{ id: 1, op: '$match', body: '{}', enabled: 'yes' }] }, 'stages.0.enabled'] as const,
    ])('rejects %s at the schema without calling the service', async (_what, overrides, path) => {
      const called = vi.spyOn(svc, method as 'run');
      expectSchemaReject(await shim.invoke(channel, input({ ...extra, ...overrides })), path);
      expect(called).not.toHaveBeenCalled();
    });
  });

  describe('agg:run', () => {
    it('returns the rows with per-stage counts', async () => {
      const env = await shim.invoke<AggResultWire>(
        IPC_CHANNELS.aggRun,
        input({
          stages: [
            stage(1, '$match', '{"kind":"fruit"}'),
            stage(2, '$sort', '{"name":1}'),
            stage(3, '$limit', '2'),
            stage(4, '$project', '{"_id":0,"name":1}'),
          ],
        }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(names(env.data)).toEqual(['apple', 'banana']);
      expect(env.data.stageCounts).toEqual({ 1: 3, 2: 3, 3: 2, 4: 2 });
      expect(env.data.hasMore).toBe(false);
    });

    it('forwards limit, so the page is cut short and hasMore is set', async () => {
      const env = await shim.invoke<AggResultWire>(
        IPC_CHANNELS.aggRun,
        input({ stages: fruitNames, limit: 2 }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(names(env.data)).toEqual(['apple', 'banana']);
      expect(env.data.hasMore).toBe(true);
    });

    it('forwards cancelToken to the service', async () => {
      const run = vi.spyOn(svc, 'run');
      const env = await shim.invoke(IPC_CHANNELS.aggRun, input({ cancelToken: 'run-token' }));
      expect(env.ok).toBe(true);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ cancelToken: 'run-token' }));
    });

    it.each([
      ['an empty stage list', { stages: [] }, 'stages'],
      ['a limit of 0', { limit: 0 }, 'limit'],
      ['a limit over the 10000 cap', { limit: 10_001 }, 'limit'],
      ['a fractional limit', { limit: 1.5 }, 'limit'],
      ['a fractional stage id', { stages: [stage(1.5, '$match', '{}')] }, 'stages.0.id'],
      [
        'a non-string stage note',
        { stages: [{ id: 1, op: '$match', body: '{}', enabled: true, note: 5 }] },
        'stages.0.note',
      ],
    ])('rejects %s at the schema without calling the service', async (_what, overrides, path) => {
      const called = vi.spyOn(svc, 'run');
      expectSchemaReject(await shim.invoke(IPC_CHANNELS.aggRun, input(overrides)), path);
      expect(called).not.toHaveBeenCalled();
    });

    it('forwards a stage note to the service', async () => {
      const run = vi.spyOn(svc, 'run');
      const env = await shim.invoke(
        IPC_CHANNELS.aggRun,
        input({ stages: [{ ...stage(1, '$match', '{}'), note: 'why' }] }),
      );
      expect(env.ok).toBe(true);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ stages: [expect.objectContaining({ id: 1, note: 'why' })] }),
      );
    });

    it('answers VALIDATION from the service when every stage is disabled', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRun,
        input({ stages: [stage(1, '$match', '{}', false)] }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
      expect(env.error.message).toBe('stages: no enabled stages');
    });

    it('answers VALIDATION naming the stage when a body is not EJSON', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRun,
        input({ stages: [stage(4, '$match', '{not json')] }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
      expect(env.error.details).toMatchObject({ stageId: 4, op: '$match' });
    });

    it('classifies a pipeline the server rejects as MONGO_ERROR', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRun,
        input({ stages: [stage(1, '$group', '{}')] }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('MONGO_ERROR');
    });

    it('refuses a write stage without allowWrite and says which stage', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRun,
        input({ stages: [stage(1, '$match', '{}'), stage(2, '$out', '"run_blocked_out"')] }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
      expect(env.error.details).toMatchObject({
        kind: 'writeStage',
        writeStageOp: '$out',
        stageId: 2,
        targetCollection: 'run_blocked_out',
      });
      expect(await exists('run_blocked_out')).toBe(false);
    });

    it('runs a write stage with allowWrite and leaves the copy behind', async () => {
      const env = await shim.invoke<AggResultWire>(
        IPC_CHANNELS.aggRun,
        input({
          stages: [stage(1, '$match', '{}'), stage(2, '$out', '"run_out_ok"')],
          allowWrite: true,
        }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.rowsJson).toBe('[]');
      expect(await countOf('run_out_ok')).toBe(SEEDED.length);
    });

    it('answers CONFLICT for $out into the source collection and leaves the source intact', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRun,
        input({
          stages: [stage(1, '$match', '{"kind":"fruit"}'), stage(2, '$out', JSON.stringify(SRC))],
          allowWrite: true,
        }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('CONFLICT');
      expect(await countOf(SRC)).toBe(SEEDED.length);
    });

    it('answers READ_ONLY for a write stage on a read-only connection and writes nothing', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRun,
        input({
          connectionId: RO,
          stages: [stage(1, '$match', '{}'), stage(2, '$out', '"ro_refused_out"')],
          allowWrite: true,
        }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('READ_ONLY');
      expect(await exists('ro_refused_out')).toBe(false);
    });

    it('still runs a read pipeline on a read-only connection', async () => {
      const env = await shim.invoke<AggResultWire>(
        IPC_CHANNELS.aggRun,
        input({ connectionId: RO, stages: fruitNames }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(names(env.data)).toEqual(['apple', 'banana', 'cherry']);
    });

    it('answers NOT_FOUND for an unknown connection', async () => {
      const env = await shim.invoke(IPC_CHANNELS.aggRun, input({ connectionId: 'no-such-conn' }));
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });

  describe('agg:previewUpToStage', () => {
    it('returns the last stage id, an uncapped count and a sample capped by limit', async () => {
      const env = await shim.invoke<AggStagePreview>(
        IPC_CHANNELS.aggPreviewUpToStage,
        input({ stages: fruitNames, limit: 2 }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.stageId).toBe(3);
      expect(env.data.count).toBe(3);
      expect(env.data.sample).toHaveLength(2);
    });

    it.each([
      ['a limit over the 50 cap', { limit: 51 }, 'limit'],
      ['a limit of 0', { limit: 0 }, 'limit'],
      ['an empty stage list', { stages: [] }, 'stages'],
      ['a fractional stage id', { stages: [stage(0.5, '$match', '{}')] }, 'stages.0.id'],
    ])('rejects %s at the schema without calling the service', async (_what, overrides, path) => {
      const called = vi.spyOn(svc, 'previewUpToStage');
      expectSchemaReject(await shim.invoke(IPC_CHANNELS.aggPreviewUpToStage, input(overrides)), path);
      expect(called).not.toHaveBeenCalled();
    });

    it('answers NOT_FOUND for an unknown connection', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggPreviewUpToStage,
        input({ connectionId: 'no-such-conn' }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });

  describe('agg:cancel', () => {
    it('hands the token to the service and answers ok with no data, even for an unknown token', async () => {
      const cancel = vi.spyOn(svc, 'cancel');
      const env = await shim.invoke(IPC_CHANNELS.aggCancel, { token: 'never-registered' });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith('never-registered');
    });

    it.each([
      ['an empty token', { token: '' }],
      ['a missing token', {}],
      ['a non-string token', { token: 7 }],
    ])('rejects %s at the schema', async (_what, payload) => {
      const cancel = vi.spyOn(svc, 'cancel');
      expectSchemaReject(await shim.invoke(IPC_CHANNELS.aggCancel, payload), 'token');
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  describe('agg:runAndSave', () => {
    const save = (overrides: Record<string, unknown> = {}) =>
      input({
        stages: [stage(1, '$match', '{"kind":"fruit"}')],
        target: { dbName: DB, collection: 'saved_fruit', mode: '$out' },
        ...overrides,
      });

    it('writes the result with $out and reports how many documents landed', async () => {
      const env = await shim.invoke<AggResultWire & AggSaveCounts>(
        IPC_CHANNELS.aggRunAndSave,
        save(),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.writtenCount).toBe(3);
      expect(env.data.mergeCounts).toBeUndefined();
      expect(await exists('saved_fruit')).toBe(true);
      expect(await countOf('saved_fruit')).toBe(3);
      expect(await countOf(SRC)).toBe(SEEDED.length);
    });

    it('forwards the $merge options: whenNotMatched discard adds nothing, the default inserts', async () => {
      const discard = await shim.invoke<AggSaveCounts>(
        IPC_CHANNELS.aggRunAndSave,
        save({
          target: {
            dbName: DB,
            collection: 'merged_discard',
            mode: '$merge',
            merge: { whenNotMatched: 'discard' },
          },
        }),
      );
      expect(discard.ok).toBe(true);
      if (!discard.ok) return;
      expect(discard.data.mergeCounts).toEqual({ before: 0, after: 0 });

      const insert = await shim.invoke<AggSaveCounts>(
        IPC_CHANNELS.aggRunAndSave,
        save({ target: { dbName: DB, collection: 'merged_insert', mode: '$merge' } }),
      );
      expect(insert.ok).toBe(true);
      if (!insert.ok) return;
      expect(insert.data.mergeCounts).toEqual({ before: 0, after: 3 });
    });

    it('reports a $merge into a populated target as before and after totals, not as documents written', async () => {
      const into = 'merge_into_existing';
      const client = await pool.write(RW).client();
      await client.db(DB).collection(into).insertMany([{ _id: 'keep-1' as never }, { _id: 'keep-2' as never }]);
      const merge = () =>
        shim.invoke<AggSaveCounts>(
          IPC_CHANNELS.aggRunAndSave,
          save({ target: { dbName: DB, collection: into, mode: '$merge' } }),
        );

      // Three new documents land in a target that already holds two.
      const first = await merge();
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.data.mergeCounts).toEqual({ before: 2, after: 5 });
      // The target's total is not a count of what the merge wrote.
      expect(first.data.writtenCount).toBeUndefined();

      // The same three again only update in place: the total does not move.
      const again = await merge();
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.data.mergeCounts).toEqual({ before: 5, after: 5 });
    });

    it('still succeeds without counts, and logs, when the target cannot be counted', async () => {
      const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const logged = new AggregationService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db)), log);
      // The write path takes its handle from the write grant, so only the
      // count probes go through `readDb`. The connection is fine; the count
      // itself is refused, as for a user without the `find` privilege.
      vi.spyOn(pool, 'readDb').mockResolvedValue({
        collection: () => ({
          countDocuments: async () => {
            throw new Error('probe refused');
          },
        }),
      } as unknown as Db);

      const result = await logged.runAndSave(
        save({ target: { dbName: DB, collection: 'merge_uncounted', mode: '$merge' } }) as never,
      );

      expect(result.mergeCounts).toBeUndefined();
      expect(result.writtenCount).toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        'agg',
        'counting the save target failed',
        expect.objectContaining({ collection: 'merge_uncounted', message: 'probe refused' }),
      );
      vi.restoreAllMocks();
      expect(await countOf('merge_uncounted')).toBe(3);
    });

    it('does not fail a $merge that already wrote because the connection dropped before the closing count', async () => {
      const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const logged = new AggregationService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db)), log);
      const readDb = pool.readDb.bind(pool);
      // First call is the count before the write; the second is the one after.
      vi.spyOn(pool, 'readDb')
        .mockImplementationOnce(readDb)
        .mockRejectedValueOnce(new Error('connection dropped'));

      const result = await logged.runAndSave(
        save({ target: { dbName: DB, collection: 'merge_dropped', mode: '$merge' } }) as never,
      );

      expect(result.mergeCounts).toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        'agg',
        'counting the save target failed',
        expect.objectContaining({ message: 'connection dropped' }),
      );
      vi.restoreAllMocks();
      expect(await countOf('merge_dropped')).toBe(3);
    });

    it('reports an unreachable connection once for a $merge, not once for the count and again for the write', async () => {
      // Each connect attempt costs a full server-selection wait, so a second
      // one is the user's second wait for the same error.
      const connect = vi.spyOn(pool, 'connect');

      await expect(
        svc.runAndSave(
          save({
            connectionId: DEAD,
            target: { dbName: DB, collection: 'merge_dead', mode: '$merge' },
          }) as never,
        ),
      ).rejects.toMatchObject({ code: 'DB_ERROR' });

      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('honours a cancel that arrives while the $merge target is still being counted', async () => {
      const into = 'merge_cancelled';
      const token = 'cancel-during-count';
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readDb = pool.readDb.bind(pool);
      // Hold the first call, the count before the write, open.
      const held = vi.spyOn(pool, 'readDb').mockImplementationOnce(async (id, dbName) => {
        await gate;
        return readDb(id, dbName);
      });

      const settled = svc
        .runAndSave(
          save({ target: { dbName: DB, collection: into, mode: '$merge' }, cancelToken: token }) as never,
        )
        .catch((e: unknown) => e);
      await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(1));
      svc.cancel(token);
      release();

      expect(await settled).toMatchObject({ code: 'INTERNAL', message: 'cancelled' });
      vi.restoreAllMocks();
      expect(await exists(into)).toBe(false);
    });

    it('forwards whenMatched: a populated target merges by default but fails with whenMatched fail', async () => {
      const into = 'merge_into_populated';
      const seeded = await shim.invoke(
        IPC_CHANNELS.aggRunAndSave,
        save({ target: { dbName: DB, collection: into, mode: '$out' } }),
      );
      expect(seeded.ok).toBe(true);

      // The same three documents again: every one matches an existing _id.
      const merged = await shim.invoke(
        IPC_CHANNELS.aggRunAndSave,
        save({ target: { dbName: DB, collection: into, mode: '$merge' } }),
      );
      expect(merged.ok).toBe(true);

      const failed = await shim.invoke(
        IPC_CHANNELS.aggRunAndSave,
        save({ target: { dbName: DB, collection: into, mode: '$merge', merge: { whenMatched: 'fail' } } }),
      );
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.error.code).toBe('CONFLICT');
      expect(await countOf(into)).toBe(3);
    });

    it('writes into another database when the target names one', async () => {
      const copyDb = `${DB}_copy`;
      const env = await shim.invoke<AggSaveCounts>(
        IPC_CHANNELS.aggRunAndSave,
        save({ target: { dbName: copyDb, collection: 'copied_fruit', mode: '$out' } }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.writtenCount).toBe(3);
      expect(await (await pool.readDb(RW, copyDb)).collection('copied_fruit').countDocuments({})).toBe(3);
      expect(await exists('copied_fruit')).toBe(false);
    });

    it.each([
      ['a mode outside the enum', { target: { dbName: DB, collection: 'x', mode: '$append' } }, 'target.mode'],
      ['a missing target', { target: undefined }, 'target'],
      ['an empty target collection', { target: { dbName: DB, collection: '', mode: '$out' } }, 'target.collection'],
      ['a missing target collection', { target: { dbName: DB, mode: '$out' } }, 'target.collection'],
      ['an empty target dbName', { target: { dbName: '', collection: 'x', mode: '$out' } }, 'target.dbName'],
      ['a missing target dbName', { target: { collection: 'x', mode: '$out' } }, 'target.dbName'],
      [
        'a whenMatched outside the enum',
        { target: { dbName: DB, collection: 'x', mode: '$merge', merge: { whenMatched: 'bogus' } } },
        'target.merge.whenMatched',
      ],
    ])('rejects %s at the schema without calling the service', async (_what, overrides, path) => {
      const called = vi.spyOn(svc, 'runAndSave');
      expectSchemaReject(await shim.invoke(IPC_CHANNELS.aggRunAndSave, save(overrides)), path);
      expect(called).not.toHaveBeenCalled();
    });

    it('answers VALIDATION from the service for a malformed target collection name', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRunAndSave,
        save({ target: { dbName: DB, collection: '$bad', mode: '$out' } }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
      expect(env.error.message).toBe('invalid collection name');
      expect(env.error.details).toEqual({ collection: '$bad' });
    });

    it('answers CONFLICT when $out would overwrite the source and leaves the source intact', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRunAndSave,
        save({ target: { dbName: DB, collection: SRC, mode: '$out' } }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('CONFLICT');
      expect(await countOf(SRC)).toBe(SEEDED.length);
    });

    it('answers READ_ONLY on a read-only connection and writes nothing', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggRunAndSave,
        save({
          connectionId: RO,
          target: { dbName: DB, collection: 'ro_refused_save', mode: '$out' },
        }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('READ_ONLY');
      expect(await exists('ro_refused_save')).toBe(false);
    });
  });

  describe('agg:explain', () => {
    it.each([
      ['queryPlanner', false],
      ['executionStats', true],
      ['allPlansExecution', true],
    ] as const)(
      'returns a plan for verbosity %s (executionStats present: %s)',
      async (verbosity, withStats) => {
        const env = await shim.invoke<{ plan: unknown; verbosity: string; writeStageOmitted: boolean }>(
          IPC_CHANNELS.aggExplain,
          input({ stages: fruitNames, verbosity }),
        );
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.data.verbosity).toBe(verbosity);
        expect(env.data.writeStageOmitted).toBe(false);
        expect(hasKey(env.data.plan, 'queryPlanner')).toBe(true);
        expect(hasKey(env.data.plan, 'executionStats')).toBe(withStats);
      },
    );

    it('says when it left a write stage out of the plan', async () => {
      const env = await shim.invoke<{ writeStageOmitted: boolean }>(
        IPC_CHANNELS.aggExplain,
        input({
          stages: [stage(1, '$match', '{}'), stage(2, '$out', '"explain_never_written"')],
          verbosity: 'queryPlanner',
        }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.writeStageOmitted).toBe(true);
      expect(await exists('explain_never_written')).toBe(false);
    });

    it.each([
      ['a verbosity outside the enum', { verbosity: 'bogus' }],
      ['a missing verbosity', {}],
    ])('rejects %s at the schema without calling the service', async (_what, overrides) => {
      const called = vi.spyOn(svc, 'explain');
      expectSchemaReject(await shim.invoke(IPC_CHANNELS.aggExplain, input(overrides)), 'verbosity');
      expect(called).not.toHaveBeenCalled();
    });

    it('answers NOT_FOUND for an unknown connection', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.aggExplain,
        input({ connectionId: 'no-such-conn', verbosity: 'queryPlanner' }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });
});
