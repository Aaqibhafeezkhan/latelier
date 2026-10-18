import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Stage } from '@shared/types';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { QueryService } from '../../electron/mongo/QueryService';
import { AggregationService } from '../../electron/mongo/AggregationService';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import type { Logger } from '../../electron/log';
import { createTempDb, insertConnectionRow, type TempDb } from '../helpers/db';
import { getSharedMongoUri, makeConnection, makeReader } from '../helpers/mongo';

/**
 * Recording a run into `recent_queries` is fire-and-forget: it must never fail
 * the user's query. It must not vanish either, so a rejected write reaches the
 * logger while the query result stays exactly what the user would have got.
 */
describe('recent-query write failures are logged, not swallowed', () => {
  let pool: MongoPool;
  let tmp: TempDb;
  let repo: RecentQueryRepo;
  let recent: RecentQueryService;
  let log: Logger;
  const connId = 'rwf-conn';
  const dbName = 'rwf_db';
  const collName = 'items';

  const find = (connectionId = connId, filter = '{}') => ({
    connectionId,
    dbName,
    collection: collName,
    filter,
    sort: '{"n":1}',
    limit: 10,
    skip: 0,
  });
  const stages = (body: string): Stage[] => [{ id: 1, op: '$match', body, enabled: true }];
  const agg = (connectionId = connId, body = '{}') => ({
    connectionId,
    dbName,
    collection: collName,
    stages: stages(body),
  });

  beforeAll(async () => {
    const uri = getSharedMongoUri();
    const hp = { host: new URL(uri).hostname, port: Number(new URL(uri).port) };
    pool = new MongoPool({
      repo: makeReader([makeConnection(connId, hp, { defaultDb: dbName }), makeConnection('rwf-ghost', hp, { defaultDb: dbName })]),
      vault: { get: () => null } as unknown as import('../../electron/secrets/SecretsVault').SecretsVault,
    });
    tmp = createTempDb();
    // Only `rwf-conn` has a SQLite row: a run against `rwf-ghost` reaches Mongo
    // fine and then fails the recent_queries foreign key.
    insertConnectionRow(tmp.db, connId);
    repo = new RecentQueryRepo(tmp.db);
    recent = new RecentQueryService(repo);

    const client = await pool.write(connId).client();
    const coll = client.db(dbName).collection(collName);
    await coll.deleteMany({});
    await coll.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  const fresh = () => {
    log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  };
  const failInsert = () =>
    vi.spyOn(repo, 'insert').mockImplementation(() => {
      throw new Error('disk full');
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('QueryService.find', () => {
    it('returns the same result and logs the failure when the success-path write rejects', async () => {
      fresh();
      const svc = new QueryService(pool, recent, undefined, log);
      const expected = await svc.find(find());

      failInsert();
      const result = await svc.find(find());

      expect(result.documentsJson).toBe(expected.documentsJson);
      expect(result.hasMore).toBe(expected.hasMore);
      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith('recent', 'recording a recent query failed', {
          message: 'disk full',
        }),
      );
    });

    it('still throws the classified query error and logs the failure when the error-path write rejects', async () => {
      fresh();
      const svc = new QueryService(pool, recent, undefined, log);
      failInsert();

      await expect(svc.find(find(connId, '{"$bogus":1}'))).rejects.toMatchObject({ code: 'VALIDATION' });

      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith('recent', 'recording a recent query failed', {
          message: 'disk full',
        }),
      );
    });

    it('names the missing connection, not a raw SQLite error, when the run is against an unknown connection', async () => {
      fresh();
      const svc = new QueryService(pool, recent, undefined, log);

      const result = await svc.find(find('rwf-ghost'));

      expect(JSON.parse(result.documentsJson)).toHaveLength(3);
      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith('recent', 'recording a recent query failed', {
          message: 'connection rwf-ghost not found',
        }),
      );
    });
  });

  describe('AggregationService.run', () => {
    it('returns the same result and logs the failure when the success-path write rejects', async () => {
      fresh();
      const svc = new AggregationService(pool, recent, log);
      const expected = await svc.run(agg());

      failInsert();
      const result = await svc.run(agg());

      expect(result.rowsJson).toBe(expected.rowsJson);
      expect(result.stageCounts).toEqual(expected.stageCounts);
      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith('recent', 'recording a recent query failed', {
          message: 'disk full',
        }),
      );
    });

    it('still throws the classified pipeline error and logs the failure when the error-path write rejects', async () => {
      fresh();
      const svc = new AggregationService(pool, recent, log);
      failInsert();

      await expect(svc.run(agg(connId, '{"$bogus":1}'))).rejects.toMatchObject({ code: 'VALIDATION' });

      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith('recent', 'recording a recent query failed', {
          message: 'disk full',
        }),
      );
    });

    it('names the missing connection, not a raw SQLite error, when the run is against an unknown connection', async () => {
      fresh();
      const svc = new AggregationService(pool, recent, log);

      const result = await svc.run(agg('rwf-ghost'));

      expect(JSON.parse(result.rowsJson)).toHaveLength(3);
      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith('recent', 'recording a recent query failed', {
          message: 'connection rwf-ghost not found',
        }),
      );
    });
  });
});
