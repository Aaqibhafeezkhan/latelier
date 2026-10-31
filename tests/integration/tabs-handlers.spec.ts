import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerTabsChannels } from '../../electron/ipc/handlers/tabs';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { WorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import type { AggregationSeed, Envelope } from '../../shared/ipc';
import type { CollectionTab } from '../../shared/types';
import { WorkspaceStateService as RealWorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { createTempDb, insertConnectionRow, type TempDb, createTempCipher } from '../helpers/db';
import { createIpcShim } from '../helpers/ipcShim';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

// The router never reads the event (`_evt` in router.ts), so the shim stands
// one in rather than constructing a real Electron event.

function createShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        handlers.set(channel, fn);
      },
    } as const,
    async invoke<T>(channel: string, payload: unknown): Promise<Envelope<T>> {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return (await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

function stubSvc(): WorkspaceStateService {
  const noopAsync = async () => ({}) as never;
  return {
    list: () => [],
    openCollection: vi.fn(() => ({}) as never),
    openAggregation: noopAsync,
    openDefault: noopAsync,
    openScript: vi.fn(() => ({}) as never),
    update: vi.fn((id: string) => ({ id }) as never),
    close: () => ({ newActiveId: null }),
    setActive: () => undefined,
    reorder: () => undefined,
    setPinned: noopAsync,
    renameCollectionTabs: vi.fn(() => ({ retargeted: true, closed: false })),
  } as unknown as WorkspaceStateService;
}

/**
 * P1-14 regression coverage: `tabs:update` and `tabs:openScript` payloads
 * previously accepted `z.record(z.string(), z.unknown())` for `state`, which
 * let renderer bugs ship typed values as the wrong runtime type across the
 * IPC boundary. The schema is now a `z.object({known fields}).passthrough()`
 * — known fields are type-checked, unknown fields pass through.
 */
describe('tabs:* handlers — tightened state schema (P1-14)', () => {
  let shim: ReturnType<typeof createShim>;
  let svc: WorkspaceStateService;

  beforeEach(() => {
    shim = createShim();
    svc = stubSvc();
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerTabsChannels(router, svc);
  });

  it('tabs:update accepts a well-typed CollectionTabState patch', async () => {
    const env = await shim.invoke<{ id: string }>(IPC_CHANNELS.tabsUpdate, {
      id: 'tab-1',
      patch: {
        state: {
          view: 'Tree',
          page: 3,
          pageSize: 50,
          queryRaw: '{}',
        },
      },
    });
    expect(env.ok).toBe(true);
  });

  it('tabs:update rejects a page value of wrong type (string instead of number)', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsUpdate, {
      id: 'tab-1',
      patch: { state: { page: '3' } },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('tabs:update rejects a view value outside the enum', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsUpdate, {
      id: 'tab-1',
      patch: { state: { view: 'Pretty' } },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('tabs:update accepts activeView:"structure" and forwards it alongside a second field', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsUpdate, {
      id: 'tab-1',
      patch: { state: { activeView: 'structure', page: 2 } },
    });
    expect(env.ok).toBe(true);
    expect(svc.update).toHaveBeenCalledWith('tab-1', {
      state: { activeView: 'structure', page: 2 },
    });
  });

  it('tabs:update rejects the retired "schema" activeView value', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsUpdate, {
      id: 'tab-1',
      patch: { state: { activeView: 'schema' } },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('tabs:update accepts unknown forward-compat fields via .passthrough()', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsUpdate, {
      id: 'tab-1',
      patch: { state: { someNewlyAddedField: 'forward-compat' } },
    });
    // Unknown keys must NOT block the call — additive forward-compat is by design.
    expect(env.ok).toBe(true);
  });

  it('tabs:openScript rejects a maxTimeMs of wrong type', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsOpenScript, {
      connectionId: 'c1',
      initialState: { maxTimeMs: '60000' },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  // ─── N0.5: tabs:collectionRenamed ───────────────────────────────────────
  it('tabs:collectionRenamed forwards a well-formed payload to the service', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsCollectionRenamed, {
      connectionId: 'c1',
      dbName: 'app',
      oldCollection: 'orders',
      newCollection: 'orders2',
    });
    expect(env.ok).toBe(true);
    expect(svc.renameCollectionTabs).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'app',
      oldCollection: 'orders',
      newCollection: 'orders2',
    });
  });

  it('tabs:collectionRenamed rejects a payload missing newCollection', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsCollectionRenamed, {
      connectionId: 'c1',
      dbName: 'app',
      oldCollection: 'orders',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('tabs:openScript accepts a well-typed ScriptTabState slice', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsOpenScript, {
      connectionId: 'c1',
      initialState: {
        title: 'My Script',
        source: 'db.users.find()',
        maxTimeMs: 60_000,
        resultPanelHeight: 240,
      },
    });
    expect(env.ok).toBe(true);
  });

  // ─── T0.5 / W07: tabs:openCollection.initialState wire-contract guard ──
  //
  // `OpenCollectionInput` gained an optional `initialState` field so the
  // sticky page-size default can seed brand-new tabs. Without an explicit
  // field on the zod schema, an object schema silently strips unknown keys
  // — this would make the seed vanish with no error at runtime. This test
  // guards that the field actually reaches the service, not just that the
  // envelope reports ok.
  it('tabs:openCollection forwards initialState.pageSize through to the service (does not get silently stripped)', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsOpenCollection, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      initialState: { pageSize: 100 },
    });
    expect(env.ok).toBe(true);
    expect(svc.openCollection).toHaveBeenCalledWith(
      expect.objectContaining({ initialState: { pageSize: 100 } }),
    );
  });

  it('tabs:openCollection rejects a pageSize of the wrong type inside initialState', async () => {
    const env = await shim.invoke(IPC_CHANNELS.tabsOpenCollection, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      initialState: { pageSize: '100' },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });
});

/**
 * The drawer's persisted tree (`filterDraft`) through the real router, zod
 * schema, service and a temp SQLite file: written, refused when malformed, and
 * gone from `state_json` once the renderer clears it.
 */
describe('tabs:update — the filter draft, via router and SQLite', () => {
  const CONN = 'draft-conn';
  const DRAFT = {
    queryRaw: '{"a":{"$eq":1}}',
    root: {
      kind: 'group',
      logic: '$and',
      children: [
        { kind: 'cond', field: 'a', op: '$eq', valType: 'number', value: '1' },
        { kind: 'cond', field: 'b', op: '$eq', valType: 'number', value: '2', disabled: true },
      ],
    },
  };
  let tmp: TempDb;
  let shim: ReturnType<typeof createIpcShim>;
  let tabId: string;

  const storedState = () =>
    JSON.parse(
      createTempCipher().open(
        'workspace_tabs',
        'state_json',
        tabId,
        (tmp.db.prepare('SELECT state_json FROM workspace_tabs WHERE id = ?').get(tabId) as { state_json: Buffer })
          .state_json,
      ),
    ) as Record<string, unknown>;
  const update = (state: Record<string, unknown>) => shim.invoke(IPC_CHANNELS.tabsUpdate, { id: tabId, patch: { state } });

  beforeEach(async () => {
    tmp = createTempDb();
    insertConnectionRow(tmp.db, CONN);
    shim = createIpcShim();
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerTabsChannels(
      router,
      new RealWorkspaceStateService(new WorkspaceTabRepo(tmp.db, createTempCipher()), new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher()))),
    );
    const env = await shim.invoke<CollectionTab>(IPC_CHANNELS.tabsOpenCollection, {
      connectionId: CONN,
      dbName: 'shop',
      collection: 'orders',
    });
    if (!env.ok) throw new Error(`tabs:openCollection failed: ${env.error.code} ${env.error.message}`);
    tabId = env.data.id;
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('persists a draft, and clearing it removes it from the stored state', async () => {
    expect((await update({ queryRaw: DRAFT.queryRaw, filterDraft: DRAFT })).ok).toBe(true);
    expect(storedState().filterDraft).toEqual(DRAFT);

    expect((await update({ filterDraft: undefined })).ok).toBe(true);
    const state = storedState();
    expect('filterDraft' in state).toBe(false);
    expect(state.queryRaw).toBe(DRAFT.queryRaw);
  });

  it('refuses a draft of the wrong shape and leaves the stored one alone', async () => {
    await update({ filterDraft: DRAFT });
    for (const filterDraft of [{ queryRaw: 1, root: DRAFT.root }, { queryRaw: '{}' }, { queryRaw: '{}', root: 'x' }, 'x']) {
      const env = await update({ filterDraft });
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    }
    expect(storedState().filterDraft).toEqual(DRAFT);
  });
});

/**
 * "Open as pipeline" (#156) seeds the Aggregation view with the builder's
 * stages. `z.object` strips keys it does not name, so without `initialState`
 * in the channel's schema the stages never reach the service and the tab
 * opens on the default empty pipeline.
 */
describe('tabs:openAggregation — initialState, via router and SQLite', () => {
  const CONN = 'pipe-conn';
  const STAGES = [
    { id: 1, op: '$match', body: '{"n":{"$numberLong":"9007199254740993"}}', enabled: true },
    { id: 2, op: '$limit', body: '25', enabled: true },
  ];
  let tmp: TempDb;
  let shim: ReturnType<typeof createIpcShim>;

  beforeEach(() => {
    tmp = createTempDb();
    insertConnectionRow(tmp.db, CONN);
    shim = createIpcShim();
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerTabsChannels(
      router,
      new RealWorkspaceStateService(new WorkspaceTabRepo(tmp.db, createTempCipher()), new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher()))),
    );
  });

  afterEach(() => {
    tmp.cleanup();
  });

  const open = (initialState: unknown) =>
    shim.invoke<CollectionTab>(IPC_CHANNELS.tabsOpenAggregation, {
      connectionId: CONN,
      dbName: 'shop',
      collection: 'orders',
      initialState,
    });

  it('lands the stages on a new tab', async () => {
    const env = await open({ stages: STAGES, activeStageId: null, dirty: true });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.state.activeView).toBe('aggregation');
    expect(env.data.state.aggregation).toMatchObject({ stages: STAGES, activeStageId: null, dirty: true });
  });

  it('replaces the pipeline on the collection tab already open', async () => {
    const first = await open({ stages: [{ id: 1, op: '$count', body: '"n"', enabled: true }] });
    const second = await open({ stages: STAGES, activeStageId: null, dirty: true });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.state.aggregation?.stages).toEqual(STAGES);
  });

  it('types the seed exactly as the schema takes it', () => {
    const ok: AggregationSeed = { stages: STAGES, activeStageId: null, dirty: true };
    // @ts-expect-error -- `stages` is required: main refuses a seed without it.
    const missing: AggregationSeed = { dirty: true };
    // @ts-expect-error -- the schema takes no other AggregationTabState key.
    const extra: AggregationSeed = { stages: [], name: 'x' };
    expect([ok, missing, extra]).toHaveLength(3);
  });

  it('refuses a malformed stage list', async () => {
    const env = await open({ stages: [{ id: 'x', op: '$match', body: '{}', enabled: true }] });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });
});
