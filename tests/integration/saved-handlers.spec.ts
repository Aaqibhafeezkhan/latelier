import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  SavedAggregationPayload,
  SavedFindPayload,
  SavedQuery,
  SavedQuerySummary,
} from '@shared/types';
import { createRouter } from '../../electron/ipc/router';
import { registerSavedChannels } from '../../electron/ipc/handlers/saved';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { createTempDb, insertConnectionRow, type TempDb, createTempCipher } from '../helpers/db';
import { createIpcShim } from '../helpers/ipcShim';
import { testSenderCheck } from '../helpers/ipcSender';
import { expectSchemaReject } from '../helpers/ipcAssert';
import type { Envelope } from '@shared/ipc';

/**
 * Drives `saved:*` through the real router, zod validators, service and a
 * temp SQLite file. The service spec skips the router and the registration
 * spec stubs the service, so neither proves that `saved.ts` maps every field
 * of the payload onto the service call or that a failure crosses as a typed
 * code. The NOT_FOUND that `saved:create` answers when the connection does
 * not exist (the repo maps the SQLite foreign-key failure to a typed error) is
 * pinned by the connection-not-found fix (#431), so it is not repeated here.
 */
const CONN_A = 'saved-conn-a';
const CONN_B = 'saved-conn-b';

function findPayload(overrides: Partial<SavedFindPayload> = {}): SavedFindPayload {
  return {
    kind: 'find',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    ...overrides,
  };
}

function aggregationPayload(
  overrides: Partial<SavedAggregationPayload> = {},
): SavedAggregationPayload {
  return {
    kind: 'aggregation',
    stages: [{ id: 1, op: '$match', body: '{"status":"open"}', enabled: true }],
    ...overrides,
  };
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  connectionId: CONN_A,
  dbName: 'shop',
  collection: 'orders',
  kind: 'find',
  name: 'open orders',
  payload: findPayload(),
  ...overrides,
});

/** The `path` of every issue a VALIDATION envelope carries, dotted, in the order reported. */
function issuePaths(env: Envelope<unknown>): string[] {
  expect(env.ok).toBe(false);
  if (env.ok) return [];
  expect(env.error.code).toBe('VALIDATION');
  const issues = (env.error.details as { issues: Array<{ path: Array<string | number> }> }).issues;
  return issues.map((i) => i.path.join('.'));
}

describe('saved:* channels via router', () => {
  let tmp: TempDb;
  let shim: ReturnType<typeof createIpcShim>;

  /** Creates a saved query through the channel and returns it, failing loudly if the channel did not. */
  async function create(overrides: Record<string, unknown> = {}): Promise<SavedQuery> {
    const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedCreate, createInput(overrides));
    if (!env.ok) throw new Error(`saved:create failed: ${env.error.code} ${env.error.message}`);
    return env.data;
  }

  beforeEach(() => {
    tmp = createTempDb();
    insertConnectionRow(tmp.db, CONN_A);
    insertConnectionRow(tmp.db, CONN_B);
    shim = createIpcShim();
    registerSavedChannels(
      createRouter(shim.ipcMain, testSenderCheck),
      new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher())),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  describe('saved:list', () => {
    it('answers an empty list for no payload at all', async () => {
      const env = await shim.invoke<SavedQuerySummary[]>(IPC_CHANNELS.savedList);
      expect(env).toEqual({ ok: true, data: [] });
    });

    it('filters by connection and kind', async () => {
      await create({ name: 'a-find' });
      await create({ name: 'a-agg', kind: 'aggregation', payload: { kind: 'aggregation', stages: [] } });
      await create({ connectionId: CONN_B, name: 'b-find' });
      const env = await shim.invoke<SavedQuerySummary[]>(IPC_CHANNELS.savedList, {
        connectionId: CONN_A,
        kind: 'find',
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((q) => q.name)).toEqual(['a-find']);
    });

    it('filters by database and collection', async () => {
      await create({ name: 'orders-q' });
      await create({ name: 'users-q', collection: 'users' });
      // Same collection name in another database, so only dbName tells it from users-q.
      await create({ name: 'other-db-q', dbName: 'crm', collection: 'users' });
      const env = await shim.invoke<SavedQuerySummary[]>(IPC_CHANNELS.savedList, {
        dbName: 'shop',
        collection: 'users',
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((q) => q.name)).toEqual(['users-q']);
    });

    it('returns summaries that carry the payload description and no payload', async () => {
      await create({ payload: findPayload({ description: 'the open ones' }) });
      const env = await shim.invoke<SavedQuerySummary[]>(IPC_CHANNELS.savedList);
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toHaveLength(1);
      expect(env.data[0]).toMatchObject({ name: 'open orders', description: 'the open ones' });
      expect(env.data[0]).not.toHaveProperty('payload');
    });

    it('rejects an unknown kind with VALIDATION', async () => {
      const env = await shim.invoke(IPC_CHANNELS.savedList, { kind: 'bogus' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });

  describe('saved:get', () => {
    it('answers NOT_FOUND for an unknown id', async () => {
      const env = await shim.invoke(IPC_CHANNELS.savedGet, { id: 'no-such-query' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('rejects an empty id with VALIDATION', async () => {
      const env = await shim.invoke(IPC_CHANNELS.savedGet, { id: '' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });

  describe('saved:create', () => {
    it.each([
      ['find', findPayload({ queryRaw: '{"status":"open"}', description: 'd' })],
      ['aggregation', aggregationPayload({ description: 'd' })],
    ] as const)(
      'stores every field of the %s payload, which saved:get reads back',
      async (kind, payload) => {
        const created = await create({ kind, name: 'round trip', payload });
        const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.data).toMatchObject({
          id: created.id,
          connectionId: CONN_A,
          dbName: 'shop',
          collection: 'orders',
          kind,
          name: 'round trip',
        });
        expect(env.data.payload).toEqual(payload);
      },
    );

    it.each([
      ['an empty name', { name: '' }],
      ['a kind outside the enum', { kind: 'view' }],
      ['a payload that is not an object', { payload: 'x' }],
      ['an empty connectionId', { connectionId: '' }],
      ['an empty dbName', { dbName: '' }],
      ['an empty collection', { collection: '' }],
      ['a missing collection', { collection: undefined }],
    ])('rejects %s with VALIDATION', async (_what, overrides) => {
      const env = await shim.invoke(IPC_CHANNELS.savedCreate, createInput(overrides));
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    describe('payload against kind', () => {
      // Each mismatch is a payload the renderer cannot hydrate: it reads `payload.kind`
      // and the variant's own fields as if they were there.
      it.each([
        ['an aggregation with a find payload', 'aggregation', findPayload(), ['payload.kind', 'payload.stages']],
        ['a find with an aggregation payload', 'find', aggregationPayload(), ['payload.kind', 'payload.builder']],
        ['a find with an empty payload', 'find', {}, ['payload.kind', 'payload.builder']],
        ['a find with a payload of unrelated fields', 'find', { foo: 1 }, ['payload.kind', 'payload.builder']],
        ['a find whose payload has no builder', 'find', { kind: 'find', queryRaw: '{}' }, ['payload.builder']],
        [
          'an aggregation whose stages are not stages',
          'aggregation',
          { kind: 'aggregation', stages: [{ op: '$match' }] },
          ['payload.stages.0.id', 'payload.stages.0.body', 'payload.stages.0.enabled'],
        ],
      ])('rejects %s with VALIDATION and stores nothing', async (_what, kind, payload, paths) => {
        const env = await shim.invoke(IPC_CHANNELS.savedCreate, createInput({ kind, payload }));
        expect(issuePaths(env)).toEqual(paths);
        if (!env.ok) expect(env.error.message).toContain(paths[0]);
        const list = await shim.invoke<SavedQuerySummary[]>(IPC_CHANNELS.savedList);
        expect(list).toEqual({ ok: true, data: [] });
      });

      it('rejects a payload kind that differs from the saved kind alone', async () => {
        const env = await shim.invoke(
          IPC_CHANNELS.savedCreate,
          createInput({ kind: 'find', payload: { ...findPayload(), kind: 'aggregation' } }),
        );
        expectSchemaReject(env, 'payload.kind');
      });

      // The payloads below are built field for field as SaveModal and
      // SavePipelineModal build theirs: `description` is present as `undefined` when blank.
      it('accepts the find payload SaveModal sends', async () => {
        const payload = {
          kind: 'find',
          builder: { projection: ['name'], sort: 'name:1', limit: '20' },
          queryRaw: '{"status":"open"}',
          description: undefined,
        };
        const created = await create({ kind: 'find', payload });
        expect(created.payload).toEqual({ ...payload, description: undefined });
      });

      it('accepts the aggregation payload SavePipelineModal sends', async () => {
        const payload = {
          kind: 'aggregation',
          stages: [
            { id: 1, op: '$match', body: '{ status: "open" }', enabled: true },
            // A key the stage type does not name must survive: the schema checks, it does not rewrite.
            { id: 2, op: '$limit', body: '5', enabled: false, note: 'cap it', legacy: 1 },
          ],
          description: 'open orders, capped',
        };
        const created = await create({ kind: 'aggregation', payload });
        expect(created.payload).toEqual(payload);
        const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.data.payload).toEqual(payload);
      });

      it('accepts a payload with no queryRaw and keeps the legacy keys of its builder', async () => {
        // W09 §1 types queryRaw as optional and rows saved before it existed lack it, so a
        // payload without one must be accepted, and its `conditions`/`logic` kept: the legacy
        // filter shim compiles the filter from them on load.
        const payload = {
          kind: 'find',
          builder: {
            conditions: [{ id: 1, field: 'status', op: '$eq', valType: 'string', value: 'open' }],
            logic: 'AND',
            projection: [],
            sort: '',
            limit: '',
          },
        };
        const created = await create({ kind: 'find', payload });
        const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.data.payload).toEqual(payload);
      });

      it('leaves the payload of a script query unchecked, as no variant describes one', async () => {
        const created = await create({ kind: 'script', payload: { source: 'db.x.find()' } });
        expect(created.kind).toBe('script');
        expect(created.payload).toEqual({ source: 'db.x.find()' });
      });
    });

    it('answers CONFLICT for the same name twice in one scope', async () => {
      await create();
      const env = await shim.invoke(IPC_CHANNELS.savedCreate, createInput());
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('CONFLICT');
    });

    it('accepts the same name in another collection', async () => {
      const first = await create();
      const env = await shim.invoke<SavedQuery>(
        IPC_CHANNELS.savedCreate,
        createInput({ collection: 'users' }),
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.collection).toBe('users');
      expect(env.data.name).toBe(first.name);
      expect(env.data.id).not.toBe(first.id);
    });
  });

  describe('saved:update', () => {
    it('renames and replaces the payload, leaving the scope alone', async () => {
      const created = await create();
      const payload = findPayload({ queryRaw: '{"a":1}' });
      const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
        id: created.id,
        patch: { name: 'renamed', payload },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toMatchObject({
        id: created.id,
        name: 'renamed',
        payload,
        dbName: 'shop',
        collection: 'orders',
        kind: 'find',
      });
      const read = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.data.name).toBe('renamed');
      expect(read.data.payload).toEqual(payload);
    });

    it('replaces only the payload when the patch carries only a payload', async () => {
      // AggregationTab's Save sends exactly this shape: it must not rename the pipeline.
      const created = await create({
        kind: 'aggregation',
        name: 'pipeline',
        payload: aggregationPayload(),
      });
      const payload = aggregationPayload({
        stages: [{ id: 1, op: '$limit', body: '5', enabled: true }],
      });
      const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
        id: created.id,
        patch: { payload },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.name).toBe('pipeline');
      expect(env.data.payload).toEqual(payload);
      const read = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.data.name).toBe('pipeline');
      expect(read.data.payload).toEqual(payload);
    });

    describe('description on a payload that names none', () => {
      // AggregationTab's Save sends only `kind` and `stages`; the description typed into
      // SavePipelineModal lives in the same payload and must survive that Save.
      const newStages = [{ id: 1, op: '$limit', body: '5', enabled: true }];

      async function savePipelineWith(description: string | undefined) {
        const created = await create({
          kind: 'aggregation',
          name: 'pipeline',
          payload: aggregationPayload({ description }),
        });
        return created.id;
      }

      async function update(id: string, payload: Record<string, unknown>): Promise<SavedQuery> {
        const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, { id, patch: { payload } });
        if (!env.ok) throw new Error(`saved:update failed: ${env.error.code} ${env.error.message}`);
        return env.data;
      }

      it('keeps the stored description, on the payload and on the derived field', async () => {
        const id = await savePipelineWith('keep me');
        const updated = await update(id, { kind: 'aggregation', stages: newStages });
        expect(updated.payload).toEqual({ kind: 'aggregation', stages: newStages, description: 'keep me' });
        expect(updated.description).toBe('keep me');

        const read = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id });
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.data.payload).toEqual({ kind: 'aggregation', stages: newStages, description: 'keep me' });
        expect(read.data.description).toBe('keep me');
      });

      it('keeps it again on a second stages-only save', async () => {
        const id = await savePipelineWith('keep me');
        await update(id, { kind: 'aggregation', stages: newStages });
        const second = await update(id, { kind: 'aggregation', stages: [] });
        expect(second.description).toBe('keep me');
      });

      it('adds no description to a pipeline that never had one', async () => {
        const id = await savePipelineWith(undefined);
        const updated = await update(id, { kind: 'aggregation', stages: newStages });
        expect(updated.payload).toEqual({ kind: 'aggregation', stages: newStages });
      });

      it('replaces the stored description when the payload names one', async () => {
        const id = await savePipelineWith('keep me');
        const updated = await update(id, { kind: 'aggregation', stages: newStages, description: 'new' });
        expect(updated.description).toBe('new');
      });

      it('clears the stored description on an explicit empty string', async () => {
        const id = await savePipelineWith('keep me');
        const updated = await update(id, { kind: 'aggregation', stages: newStages, description: '' });
        expect(updated.description).toBe('');
      });
    });

    it('renames without touching the payload when the patch carries only a name', async () => {
      const payload = findPayload({ queryRaw: '{"a":1}', description: 'keep me' });
      const created = await create({ payload });
      const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
        id: created.id,
        patch: { name: 'renamed' },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.name).toBe('renamed');
      expect(env.data.payload).toEqual(payload);
      const read = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.data.name).toBe('renamed');
      expect(read.data.payload).toEqual(payload);
    });

    it('accepts an empty patch, which today changes updated_at and nothing else', async () => {
      // No renderer call sends this; it is pinned so tightening it becomes a deliberate change.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const created = await create();
      vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
      const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
        id: created.id,
        patch: {},
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toEqual({ ...created, updatedAt: '2026-01-01T00:00:05.000Z' });
      const read = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
      expect(read).toEqual({ ok: true, data: env.data });
    });

    describe('payload against the stored kind', () => {
      // The patch carries no kind, so the stored row's kind is the only thing to hold it to.
      it.each([
        ['an aggregation payload on a find query', 'find', aggregationPayload(), ['patch.payload.kind', 'patch.payload.builder']],
        ['a find payload on an aggregation query', 'aggregation', findPayload(), ['patch.payload.kind', 'patch.payload.stages']],
        ['an empty payload on a find query', 'find', {}, ['patch.payload.kind', 'patch.payload.builder']],
        ['unrelated fields on a find query', 'find', { foo: 1 }, ['patch.payload.kind', 'patch.payload.builder']],
        ['an empty payload on an aggregation query', 'aggregation', {}, ['patch.payload.kind', 'patch.payload.stages']],
      ])('rejects %s with VALIDATION and keeps the stored payload', async (_what, kind, patchPayload, paths) => {
        const stored = kind === 'find' ? findPayload() : aggregationPayload();
        const created = await create({ kind, payload: stored });
        const env = await shim.invoke(IPC_CHANNELS.savedUpdate, {
          id: created.id,
          patch: { name: 'renamed', payload: patchPayload },
        });
        expect(issuePaths(env)).toEqual(paths);
        if (!env.ok) expect(env.error.message).toContain(paths[0]);
        const read = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: created.id });
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        // Rejected whole: the rename in the same patch did not land either.
        expect(read.data.name).toBe(created.name);
        expect(read.data.payload).toEqual(stored);
      });

      it('accepts the find payload SaveModal builds on a find query', async () => {
        const created = await create();
        const payload = {
          kind: 'find',
          builder: { projection: ['name'], sort: 'name:1', limit: '20' },
          queryRaw: '{"status":"closed"}',
          description: 'closed',
        };
        const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
          id: created.id,
          patch: { payload },
        });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.data.payload).toEqual(payload);
      });

      it('leaves the payload of a script query unchecked on update too', async () => {
        const created = await create({ kind: 'script', name: 'a script', payload: { source: 'a' } });
        const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
          id: created.id,
          patch: { payload: { source: 'b' } },
        });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.data.payload).toEqual({ source: 'b' });
      });

      it('accepts the payload AggregationTab sends on an aggregation query', async () => {
        const created = await create({ kind: 'aggregation', payload: aggregationPayload() });
        const payload = { kind: 'aggregation', stages: [{ id: 3, op: '$sort', body: '{ a: 1 }', enabled: true }] };
        const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
          id: created.id,
          patch: { payload },
        });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.data.payload).toEqual(payload);
      });
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const env = await shim.invoke(IPC_CHANNELS.savedUpdate, {
        id: 'no-such-query',
        patch: { name: 'x' },
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('rejects an empty patch.name with VALIDATION', async () => {
      const created = await create();
      const env = await shim.invoke(IPC_CHANNELS.savedUpdate, {
        id: created.id,
        patch: { name: '' },
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it.each([
      ['an empty id', { id: '' }],
      ['a payload that is not an object', { patch: { payload: 'x' } }],
    ])('rejects %s with VALIDATION', async (_what, overrides) => {
      const created = await create();
      const env = await shim.invoke(IPC_CHANNELS.savedUpdate, {
        id: created.id,
        patch: { name: 'x' },
        ...overrides,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('answers CONFLICT when the new name is taken in the scope', async () => {
      await create({ name: 'first' });
      const second = await create({ name: 'second' });
      const env = await shim.invoke(IPC_CHANNELS.savedUpdate, {
        id: second.id,
        patch: { name: 'first' },
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('CONFLICT');
    });
  });

  describe('rows written before the payload was checked against the kind', () => {
    // Inserted through the repo, which is how such a row got there: saved:create stored
    // whatever object it was given. None of them may make a read fail.
    const LEGACY_FIND = {
      kind: 'find',
      builder: {
        conditions: [{ id: 1, field: 'status', op: '$eq', valType: 'string', value: 'open' }],
        logic: 'AND',
        projection: [],
        sort: '',
        limit: '',
      },
      description: 'from before queryRaw',
    };
    const rows = [
      ['legacy-find', 'find', 'legacy find', LEGACY_FIND],
      ['mismatched', 'find', 'find holding a pipeline', aggregationPayload()],
      ['empty-agg', 'aggregation', 'aggregation holding nothing', {}],
    ] as const;

    beforeEach(() => {
      const repo = new SavedQueryRepo(tmp.db, createTempCipher());
      for (const [id, kind, name, payload] of rows) {
        repo.insert({
          id,
          connection_id: CONN_A,
          db_name: 'shop',
          collection: 'orders',
          kind,
          name,
          payload_json: JSON.stringify(payload),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      }
    });

    it('saved:list still answers every one of them', async () => {
      const env = await shim.invoke<SavedQuerySummary[]>(IPC_CHANNELS.savedList);
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((q) => q.id).sort((a, b) => a.localeCompare(b))).toEqual(
        ['empty-agg', 'legacy-find', 'mismatched'],
      );
      expect(env.data.find((q) => q.id === 'legacy-find')?.description).toBe('from before queryRaw');
    });

    it.each(rows)('saved:get still answers %s with its payload untouched', async (id, kind, _name, payload) => {
      const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.kind).toBe(kind);
      expect(env.data.payload).toEqual(payload);
    });

    it('renames one without re-checking its payload', async () => {
      const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedUpdate, {
        id: 'mismatched',
        patch: { name: 'renamed' },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.name).toBe('renamed');
      expect(env.data.payload).toEqual(aggregationPayload());
    });
  });

  describe('saved:delete', () => {
    it('removes the query and returns no data', async () => {
      const created = await create();
      const del = await shim.invoke(IPC_CHANNELS.savedDelete, { id: created.id });
      expect(del).toStrictEqual({ ok: true, data: undefined });
      const after = await shim.invoke(IPC_CHANNELS.savedGet, { id: created.id });
      expect(after.ok).toBe(false);
      if (after.ok) return;
      expect(after.error.code).toBe('NOT_FOUND');
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const env = await shim.invoke(IPC_CHANNELS.savedDelete, { id: 'no-such-query' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('rejects an empty id with VALIDATION', async () => {
      const env = await shim.invoke(IPC_CHANNELS.savedDelete, { id: '' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });

  describe('saved:duplicate', () => {
    it('copies the query under a new id and name', async () => {
      const created = await create({ payload: findPayload({ queryRaw: '{"a":1}' }) });
      const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedDuplicate, {
        id: created.id,
        newName: 'open orders copy',
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.id).not.toBe(created.id);
      expect(env.data).toMatchObject({
        name: 'open orders copy',
        connectionId: CONN_A,
        dbName: 'shop',
        collection: 'orders',
        kind: 'find',
        payload: created.payload,
      });
      const read = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedGet, { id: env.data.id });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.data.name).toBe('open orders copy');
      expect(read.data.payload).toEqual(created.payload);
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const env = await shim.invoke(IPC_CHANNELS.savedDuplicate, {
        id: 'no-such-query',
        newName: 'copy',
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it.each([
      ['an empty newName', { newName: '' }],
      ['an empty id', { id: '', newName: 'copy' }],
    ])('rejects %s with VALIDATION', async (_what, overrides) => {
      const created = await create();
      const env = await shim.invoke(IPC_CHANNELS.savedDuplicate, { id: created.id, ...overrides });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('answers CONFLICT when newName is already taken in the scope', async () => {
      const created = await create();
      const env = await shim.invoke(IPC_CHANNELS.savedDuplicate, {
        id: created.id,
        newName: created.name,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('CONFLICT');
    });
  });
});
