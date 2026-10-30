import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { NotFoundError } from '../../electron/errors';
import type { Logger } from '../../electron/log';
import { createTempDb, type TempDb, createTempCipher, cellType } from '../helpers/db';
import type { FindInput } from '@shared/types';

const CONNECTION_ID = 'conn-1';
const DB_NAME = 'mydb';
const COLLECTION = 'items';

function makeFindInput(overrides: Partial<FindInput> = {}): FindInput {
  return {
    connectionId: CONNECTION_ID,
    dbName: DB_NAME,
    collection: COLLECTION,
    filter: '{}',
    limit: 20,
    skip: 0,
    ...overrides,
  };
}

describe('RecentQueryService', () => {
  let tmp: TempDb;
  let repo: RecentQueryRepo;
  let svc: RecentQueryService;

  beforeEach(() => {
    tmp = createTempDb();
    // Insert a real connection row so FK constraint passes
    tmp.db.prepare(`
      INSERT INTO connections (
        id, name, color, connection_type, host, port,
        auth_mech, tls_enabled, tls_verify, ssh_enabled,
        connect_timeout_ms, socket_timeout_ms, server_selection_timeout_ms,
        read_preference, max_pool_size, direct_connection,
        created_at, updated_at
      ) VALUES (
        ?, 'Test', '#1A6835', 'standard', 'localhost', 27017,
        'none', 1, 1, 0,
        10000, 30000, 30000,
        'primary', 100, 0,
        ?, ?
      )
    `).run(CONNECTION_ID, new Date().toISOString(), new Date().toISOString());

    repo = new RecentQueryRepo(tmp.db, createTempCipher());
    svc = new RecentQueryService(repo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it('logs a failed eviction and still records the run', async () => {
    const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logged = new RecentQueryService(repo, log);
    // Over the cap, so eviction reaches the delete, which then fails.
    vi.spyOn(repo, 'countByConnection').mockReturnValue(201);
    vi.spyOn(repo, 'deleteOldestByConnection').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(logged.recordFind(makeFindInput(), 42, 10)).resolves.toBeUndefined();
    await logged.drainEvictions();

    expect(log.warn).toHaveBeenCalledWith('recent', 'evicting old recent queries failed', {
      connectionId: CONNECTION_ID,
      message: 'disk full',
    });
    expect(logged.list({ connectionId: CONNECTION_ID })).toHaveLength(1);
  });

  it('recordFind inserts a row retrievable via get', async () => {
    await svc.recordFind(makeFindInput(), 42, 10);

    const list = svc.list({ connectionId: CONNECTION_ID });
    expect(list).toHaveLength(1);

    const item = list[0]!;
    expect(item.connectionId).toBe(CONNECTION_ID);
    expect(item.dbName).toBe(DB_NAME);
    expect(item.collection).toBe(COLLECTION);
    expect(item.kind).toBe('find');
    expect(item.durationMs).toBe(42);
    expect(item.resultCount).toBe(10);
    expect(item.errorCode).toBeUndefined();

    const fetched = svc.get(item.id);
    expect(fetched.id).toBe(item.id);
    expect(cellType(tmp.db, 'recent_queries', 'payload_json', item.id)).toBe('blob');
  });

  // Codex review on the W15 base → `main` PR. `recordFind` wrote a hardcoded
  // empty builder while `BuilderPane`'s Recent hydration reads `projectionRaw`
  // from it — so rerunning a query that had excluded a field ran with no
  // projection at all and put the excluded field back on screen. Silently: the
  // run in the history list was not the run you got.
  it('recordFind preserves the projection that actually executed', async () => {
    await svc.recordFind(
      { ...makeFindInput(), projection: '{"secret":0}', sort: '{"createdAt":-1}' },
      5,
      1,
    );

    const item = svc.list({ connectionId: CONNECTION_ID })[0]!;
    const payload = item.payload as { builder: { projectionRaw?: string; sort: string; limit: string } };
    expect(payload.builder.projectionRaw).toBe('{"secret":0}');
    expect(payload.builder.sort).toBe('{"createdAt":-1}');
    // `FindInput.limit` is the *effective page* limit, not the user's cap, so
    // recording it would make a rerun inherit whichever page the original run
    // happened to be on.
    expect(payload.builder.limit).toBe('');
  });

  it('recordFind leaves projectionRaw unset when the run had no projection', async () => {
    await svc.recordFind(makeFindInput(), 5, 1);

    const item = svc.list({ connectionId: CONNECTION_ID })[0]!;
    const payload = item.payload as { builder: { projectionRaw?: string } };
    expect(payload.builder.projectionRaw).toBeUndefined();
  });

  // W14 §9 — a collation changes which documents match, so a Recent rerun
  // that dropped it would silently not be the run in the list.
  it('recordFind records the find options as the builder text, and omits unset ones', async () => {
    await svc.recordFind(
      makeFindInput({
        collation: '{"locale":"en","strength":2}',
        hint: '_id_',
        maxTimeMS: 40000,
        readPreference: 'secondaryPreferred',
      }),
      5,
      1,
    );
    await svc.recordFind(makeFindInput(), 5, 1);

    const [withOptions, without] = svc.list({ connectionId: CONNECTION_ID }).reverse();
    expect((withOptions!.payload as { builder: object }).builder).toMatchObject({
      collation: '{"locale":"en","strength":2}',
      hint: '_id_',
      maxTimeMS: '40000',
      readPreference: 'secondaryPreferred',
    });
    const bare = (without!.payload as { builder: object }).builder;
    for (const key of ['collation', 'hint', 'maxTimeMS', 'readPreference']) {
      expect(bare).not.toHaveProperty(key);
    }
  });

  // QueryService trims the collation and hint before sending them, so a
  // blank one was never part of the run and a padded one reruns trimmed.
  it('recordFind trims the collation and hint, and omits blank ones', async () => {
    await svc.recordFind(makeFindInput({ collation: '  {"locale":"en"} ', hint: ' _id_ ' }), 5, 1);
    await svc.recordFind(makeFindInput({ collation: '   ', hint: '\t' }), 5, 1);

    const [padded, blank] = svc.list({ connectionId: CONNECTION_ID }).reverse();
    expect((padded!.payload as { builder: object }).builder).toMatchObject({
      collation: '{"locale":"en"}',
      hint: '_id_',
    });
    const bare = (blank!.payload as { builder: object }).builder;
    expect(bare).not.toHaveProperty('collation');
    expect(bare).not.toHaveProperty('hint');
  });

  it('recordFind stores errorCode when provided', async () => {
    await svc.recordFind(makeFindInput(), 0, 0, 'TIMEOUT');

    const list = svc.list({ connectionId: CONNECTION_ID });
    expect(list).toHaveLength(1);
    expect(list[0]!.errorCode).toBe('TIMEOUT');
  });

  it('a run recorded against an unknown connection is a NotFoundError, not a raw SQLite error', async () => {
    await expect(svc.recordFind(makeFindInput({ connectionId: 'no-such-conn' }), 1, 0)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      svc.recordAggregation({ connectionId: 'no-such-conn', dbName: DB_NAME, collection: COLLECTION, stages: [] }, 1, 0),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'connection no-such-conn not found' });
    expect(svc.list()).toHaveLength(0);
  });

  it('get throws NotFoundError for unknown id', () => {
    expect(() => svc.get('does-not-exist')).toThrow(NotFoundError);
  });

  it('clear deletes matching rows and returns count', async () => {
    await svc.recordFind(makeFindInput(), 10, 5);
    await svc.recordFind(makeFindInput({ collection: 'other' }), 20, 3);

    const result = svc.clear({ connectionId: CONNECTION_ID });
    expect(result.deleted).toBe(2);
    expect(svc.list({ connectionId: CONNECTION_ID })).toHaveLength(0);
  });

  it('clear with collection filter only deletes matching rows', async () => {
    await svc.recordFind(makeFindInput(), 10, 5);
    await svc.recordFind(makeFindInput({ collection: 'other' }), 20, 3);

    const result = svc.clear({ collection: COLLECTION });
    expect(result.deleted).toBe(1);
    expect(svc.list({ connectionId: CONNECTION_ID })).toHaveLength(1);
  });

  // the Recent tab's delete/clear paths both ride `clear`.
  it('clear by id removes exactly that row', async () => {
    await svc.recordFind(makeFindInput({ filter: '{"a":1}' }), 10, 5);
    await svc.recordFind(makeFindInput({ filter: '{"b":2}' }), 20, 3);

    const [victim, survivor] = svc.list({ connectionId: CONNECTION_ID });
    const result = svc.clear({ id: victim!.id });

    expect(result.deleted).toBe(1);
    const left = svc.list({ connectionId: CONNECTION_ID });
    expect(left).toHaveLength(1);
    expect(left[0]!.id).toBe(survivor!.id);
  });

  it('clear with kind find leaves aggregation history alone', async () => {
    await svc.recordFind(makeFindInput(), 10, 5);
    await svc.recordAggregation(
      { connectionId: CONNECTION_ID, dbName: DB_NAME, collection: COLLECTION, stages: [] },
      15,
      2,
    );

    const result = svc.clear({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
    });

    expect(result.deleted).toBe(1);
    const left = svc.list({ connectionId: CONNECTION_ID });
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe('aggregation');
  });

  // Same collection name, different database — the discriminating case. If
  // `deleteByFilter` ignored `dbName`, `collection = ?` would take both rows.
  it('clear scoped to a database spares the same collection elsewhere', async () => {
    await svc.recordFind(makeFindInput(), 10, 5);
    await svc.recordFind(makeFindInput({ dbName: 'analytics' }), 20, 3);

    const result = svc.clear({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
    });

    expect(result.deleted).toBe(1);
    const left = svc.list({ connectionId: CONNECTION_ID });
    expect(left).toHaveLength(1);
    expect(left[0]!.dbName).toBe('analytics');
  });

  it('205 inserts → only 200 survive (oldest evicted)', async () => {
    const total = 205;

    for (let i = 0; i < total; i++) {
      // Use slightly different timestamps to ensure ordering
      await svc.recordFind(makeFindInput({ filter: `{"n":${i}}` }), i, 1);
    }

    // Eviction is deferred to setImmediate so the IPC reply isn't held
    // up by the COUNT + DELETE pair; flush before asserting.
    await svc.drainEvictions();
    const count = svc.list({ connectionId: CONNECTION_ID }).length;
    expect(count).toBe(200);
  });

  it('eviction keeps at most 200 entries after bulk inserts', async () => {
    const total = 205;

    for (let i = 0; i < total; i++) {
      await svc.recordFind(makeFindInput({ filter: `{"n":${i}}` }), i, 1);
    }

    await svc.drainEvictions();
    const list = svc.list({ connectionId: CONNECTION_ID });
    // After 205 inserts the count must not exceed 200
    expect(list.length).toBeLessThanOrEqual(200);
  });

  // Runs recorded in the same millisecond share `ran_at`. Without a
  // tiebreaker their order is whatever the query plan yields, which can swap
  // identical runs apart and break the Recent tab's adjacency merge. The
  // later insert counts as newer.
  describe('same-millisecond runs order deterministically, newest insert first', () => {
    const SAME = '2026-10-22T10:00:00.000Z';
    function row(id: string, collection = 'orders') {
      return {
        id,
        connection_id: CONNECTION_ID,
        db_name: 'shop',
        collection,
        kind: 'find' as const,
        payload_json: '{}',
        ran_at: SAME,
        duration_ms: 1,
        result_count: null,
        error_code: null,
      };
    }

    it('list returns ties in reverse insertion order, with and without filters and limits', () => {
      // Ids chosen so neither id nor insertion order alone sorts them DESC.
      for (const id of ['m', 'z', 'a']) repo.insert(row(id));
      expect(repo.list().map((r) => r.id)).toEqual(['a', 'z', 'm']);
      expect(repo.list({ connectionId: CONNECTION_ID }).map((r) => r.id)).toEqual(['a', 'z', 'm']);
      expect(
        repo.list({ connectionId: CONNECTION_ID, dbName: 'shop', collection: 'orders', kind: 'find', limit: 2 })
          .map((r) => r.id),
      ).toEqual(['a', 'z']);
    });

    it('eviction among ties drops the earliest inserts', () => {
      for (const id of ['m', 'z', 'a']) repo.insert(row(id));
      repo.deleteOldestByConnection(CONNECTION_ID, 2);
      expect(repo.list().map((r) => r.id)).toEqual(['a', 'z']);
    });
  });
});
