import type { IpcApi } from '@shared/ipc';
import type { CollectionTab, ConnectionSummary, WorkspaceTab } from '@shared/types';

/**
 * Build a `window.atelier` stub for component tests. Every method defaults
 * to a benign no-op so the renderer can mount without unexpected throws.
 * Tests override only the methods they care about.
 */
// Functions are objects, so the `extends object` branch must exclude them —
// recursing into a function type drops its call signature and every override
// callback's parameters land as implicit `any`.
type Deep<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends object
      ? Deep<T[K]>
      : T[K];
};

export function installAtelierMock(overrides: Deep<IpcApi> = {}): IpcApi {
  const unused = (name: string) =>
    async (...args: unknown[]) => {
      throw new Error(`api.${name} was not mocked (args=${JSON.stringify(args)})`);
    };

  const base: IpcApi = {
    conn: {
      list: async () => [],
      get: unused('conn.get') as IpcApi['conn']['get'],
      getUri: unused('conn.getUri') as IpcApi['conn']['getUri'],
      create: unused('conn.create') as IpcApi['conn']['create'],
      update: unused('conn.update') as IpcApi['conn']['update'],
      delete: unused('conn.delete') as IpcApi['conn']['delete'],
      touchUsed: async (id) => ({ id }),
      parseUri: unused('conn.parseUri') as IpcApi['conn']['parseUri'],
      test: unused('conn.test') as IpcApi['conn']['test'],
      export: unused('conn.export') as IpcApi['conn']['export'],
      importOpen: unused('conn.importOpen') as IpcApi['conn']['importOpen'],
      importMap: unused('conn.importMap') as IpcApi['conn']['importMap'],
      importUris: unused('conn.importUris') as IpcApi['conn']['importUris'],
      importCommit: unused('conn.importCommit') as IpcApi['conn']['importCommit'],
    },
    app: {
      pickFile: async () => ({ path: null }),
      openExternal: async () => ({ opened: false }),
      saveFile: async () => ({ path: null }),
      diagnosticBundle: async () => ({ path: null }),
      setUnsavedWork: async () => {},
      onMenuCommand: () => () => {},
      onFlushRequest: () => () => {},
      flushDone: async () => {},
      log: async () => {},
    },
    updates: {
      getState: async () => ({ status: 'idle' as const }),
      restart: async (): Promise<{ restarting: boolean }> => ({ restarting: true }),
      onState: () => () => {},
    },
    shell: {
      openExternal: async () => ({ opened: true as const }),
    },
    mongo: {
      connect: async (id) => ({ id, status: 'disconnected' }),
      disconnect: async (id) => ({ id }),
      status: async (id) => ({ id, status: 'disconnected' }),
      ping: async () => ({ roundTripMs: 0 }),
      serverInfo: unused('mongo.serverInfo') as IpcApi['mongo']['serverInfo'],
      onStatus: () => () => {
        /* noop unsubscribe */
      },
    },
    meta: {
      listDatabases: async () => [],
      listCollections: async () => [],
      collectionDetails: unused('meta.collectionDetails') as IpcApi['meta']['collectionDetails'],
      sampleSchema: async () => ({ docs: [] }),
    },
    index: {
      list: async () => [],
      create: unused('index.create') as IpcApi['index']['create'],
      drop: unused('index.drop') as IpcApi['index']['drop'],
    },
    collection: {
      create: unused('collection.create') as IpcApi['collection']['create'],
      drop: unused('collection.drop') as IpcApi['collection']['drop'],
      rename: unused('collection.rename') as IpcApi['collection']['rename'],
      modify: unused('collection.modify') as IpcApi['collection']['modify'],
    },
    database: {
      drop: unused('database.drop') as IpcApi['database']['drop'],
    },
    user: {
      list: async () => [],
      get: unused('user.get') as IpcApi['user']['get'],
      create: unused('user.create') as IpcApi['user']['create'],
      update: unused('user.update') as IpcApi['user']['update'],
      drop: unused('user.drop') as IpcApi['user']['drop'],
    },
    role: {
      list: async () => [],
      create: unused('role.create') as IpcApi['role']['create'],
      update: unused('role.update') as IpcApi['role']['update'],
      drop: unused('role.drop') as IpcApi['role']['drop'],
    },
    admin: {
      currentOp: async () => ({ ops: [] }),
      killOp: unused('admin.killOp') as IpcApi['admin']['killOp'],
      profileStatus: async () => ({ level: 0 as const, slowms: 100 }),
      setProfileLevel: unused('admin.setProfileLevel') as IpcApi['admin']['setProfileLevel'],
      profileTail: async () => ({ docs: [] }),
    },
    prefs: {
      get: async () => null,
      set: async (_k, v) => v,
      getTheme: async () => 'system' as const,
      setTheme: async () => undefined,
      onThemeChanged: () => () => {},
    },
    secrets: {
      setPlaintextFallback: async (enabled) => ({ enabled }),
      status: async () => ({ columnKeyProtected: true }),
    },
    query: {
      find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
      count: async () => ({ count: 0 }),
      findOne: async () => ({ document: null, durationMs: 0 }),
      // The query runner asks for a plan after every run (the plan badge). An
      // empty plan is a successful explain with nothing to show, so no badge;
      // tests that check the explain call install their own spy.
      explain: (async () => ({ plan: {}, verbosity: 'queryPlanner' })) as IpcApi['query']['explain'],
      cancel: async () => undefined,
      export: unused('query.export') as IpcApi['query']['export'],
    },
    doc: {
      insert: unused('doc.insert') as IpcApi['doc']['insert'],
      insertMany: unused('doc.insertMany') as IpcApi['doc']['insertMany'],
      updateOne: unused('doc.updateOne') as IpcApi['doc']['updateOne'],
      deleteOne: unused('doc.deleteOne') as IpcApi['doc']['deleteOne'],
      confirmDeleteMany: unused('doc.confirmDeleteMany') as IpcApi['doc']['confirmDeleteMany'],
      deleteMany: unused('doc.deleteMany') as IpcApi['doc']['deleteMany'],
      confirmUpdateMany: unused('doc.confirmUpdateMany') as IpcApi['doc']['confirmUpdateMany'],
      updateMany: unused('doc.updateMany') as IpcApi['doc']['updateMany'],
    },
    saved: {
      list: async () => [],
      get: unused('saved.get') as IpcApi['saved']['get'],
      create: unused('saved.create') as IpcApi['saved']['create'],
      update: unused('saved.update') as IpcApi['saved']['update'],
      delete: async () => undefined,
      duplicate: unused('saved.duplicate') as IpcApi['saved']['duplicate'],
    },
    data: {
      import: unused('data.import') as IpcApi['data']['import'],
      previewCsv: unused('data.previewCsv') as IpcApi['data']['previewCsv'],
      cancelImport: async () => undefined,
      onImportProgress: () => () => {},
    },
    audit: {
      list: async () => [],
      undo: unused('audit.undo') as IpcApi['audit']['undo'],
    },
    recent: {
      list: async () => [],
      get: unused('recent.get') as IpcApi['recent']['get'],
      clear: async () => ({ deleted: 0 }),
      valuesForField: async () => ({ values: [] }),
      recordFieldValues: async () => ({ recorded: 0 }),
      clearFieldValues: async () => ({ deleted: 0 }),
    },
    agg: {
      run: unused('agg.run') as IpcApi['agg']['run'],
      previewUpToStage: unused('agg.previewUpToStage') as IpcApi['agg']['previewUpToStage'],
      cancel: async () => undefined,
      runAndSave: unused('agg.runAndSave') as IpcApi['agg']['runAndSave'],
      explain: unused('agg.explain') as IpcApi['agg']['explain'],
    },
    refs: {
      list: async () => [],
      get: unused('refs.get') as IpcApi['refs']['get'],
      create: unused('refs.create') as IpcApi['refs']['create'],
      update: unused('refs.update') as IpcApi['refs']['update'],
      delete: async () => undefined,
      resolve: unused('refs.resolve') as IpcApi['refs']['resolve'],
      autodetect: async () => [],
    },
    tabs: {
      list: unused('tabs.list') as IpcApi['tabs']['list'],
      openCollection: unused('tabs.openCollection') as IpcApi['tabs']['openCollection'],
      openAggregation: unused('tabs.openAggregation') as IpcApi['tabs']['openAggregation'],
      openDefault: unused('tabs.openDefault') as IpcApi['tabs']['openDefault'],
      openScript: unused('tabs.openScript') as IpcApi['tabs']['openScript'],
      update: unused('tabs.update') as IpcApi['tabs']['update'],
      close: unused('tabs.close') as IpcApi['tabs']['close'],
      setActive: unused('tabs.setActive') as IpcApi['tabs']['setActive'],
      reorder: unused('tabs.reorder') as IpcApi['tabs']['reorder'],
      setPinned: unused('tabs.setPinned') as IpcApi['tabs']['setPinned'],
      collectionRenamed: unused('tabs.collectionRenamed') as IpcApi['tabs']['collectionRenamed'],
    },
    mshell: {
      start: unused('mshell.start') as IpcApi['mshell']['start'],
      write: async () => undefined,
      stop: async () => undefined,
      list: async () => [],
      onOutput: () => () => {},
    },
    script: {
      run: unused('script.run') as IpcApi['script']['run'],
      cancel: async () => undefined,
    },
  };

  const merged: IpcApi = {
    ...base,
    ...(overrides as Partial<IpcApi>),
    conn:   { ...base.conn,   ...(overrides.conn   ?? {}) } as IpcApi['conn'],
    app:    { ...base.app,    ...(overrides.app    ?? {}) } as IpcApi['app'],
    updates: { ...base.updates, ...(overrides.updates ?? {}) } as IpcApi['updates'],
    shell:  { ...base.shell,  ...(overrides.shell  ?? {}) } as IpcApi['shell'],
    mongo:  { ...base.mongo,  ...(overrides.mongo  ?? {}) } as IpcApi['mongo'],
    meta:   { ...base.meta,   ...(overrides.meta   ?? {}) } as IpcApi['meta'],
    index:  { ...base.index,  ...(overrides.index  ?? {}) } as IpcApi['index'],
    collection: { ...base.collection, ...(overrides.collection ?? {}) } as IpcApi['collection'],
    database:   { ...base.database,   ...(overrides.database   ?? {}) } as IpcApi['database'],
    user:   { ...base.user,   ...(overrides.user   ?? {}) } as IpcApi['user'],
    role:   { ...base.role,   ...(overrides.role   ?? {}) } as IpcApi['role'],
    admin:  { ...base.admin,  ...(overrides.admin  ?? {}) } as IpcApi['admin'],
    prefs:  { ...base.prefs,  ...(overrides.prefs  ?? {}) } as IpcApi['prefs'],
    secrets: { ...base.secrets, ...(overrides.secrets ?? {}) } as IpcApi['secrets'],
    query:  { ...base.query,  ...(overrides.query  ?? {}) } as IpcApi['query'],
    doc:    { ...base.doc,    ...(overrides.doc    ?? {}) } as IpcApi['doc'],
    saved:  { ...base.saved,  ...(overrides.saved  ?? {}) } as IpcApi['saved'],
    data:   { ...base.data,   ...(overrides.data   ?? {}) } as IpcApi['data'],
    audit:  { ...base.audit,  ...(overrides.audit  ?? {}) } as IpcApi['audit'],
    recent: { ...base.recent, ...(overrides.recent ?? {}) } as IpcApi['recent'],
    agg:    { ...base.agg,    ...(overrides.agg    ?? {}) } as IpcApi['agg'],
    refs:   { ...base.refs,   ...(overrides.refs   ?? {}) } as IpcApi['refs'],
    tabs:   { ...base.tabs,   ...(overrides.tabs   ?? {}) } as IpcApi['tabs'],
    mshell: { ...base.mshell, ...(overrides.mshell ?? {}) } as IpcApi['mshell'],
    script: { ...base.script, ...(overrides.script ?? {}) } as IpcApi['script'],
  };

  (window as unknown as { atelier?: IpcApi }).atelier = merged;
  return merged;
}

/**
 * A saved Connection, with everything but the interesting field filled in.
 * `id` and `name` are what tests usually vary.
 */
export function connectionFixture(
  overrides: Partial<ConnectionSummary> = {},
): ConnectionSummary {
  return {
    id: 'c1',
    name: 'Prod',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard',
    readOnly: false,
    status: 'connected',
    ...overrides,
  };
}

/** A collection tab on `c1`. Vary `connectionId` to put it on another one. */
export function collectionTabFixture(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    position: 0,
    isActive: false,
    openedAt: '2026-07-26T12:00:00.000Z',
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
    ...overrides,
  };
}

/**
 * X16.1 — `conn` + `tabs` overrides for a Data View holding several
 * Connections with tabs across them. Spread it into `installAtelierMock`:
 *
 * ```ts
 * installAtelierMock({
 *   ...multiConnectionMock({
 *     connections: [{ id: 'c1', name: 'Prod' }, { id: 'c2', name: 'Staging', readOnly: true }],
 *     tabs: [{ id: 't1', connectionId: 'c1', collection: 'alpha' },
 *            { id: 't2', connectionId: 'c2', collection: 'beta', isActive: true }],
 *   }),
 * });
 * ```
 *
 * `position` defaults to the array order, so the Focused Tab (`isActive`) can
 * be somewhere other than first — which is the whole point: the Data View's
 * Connection is the Focused Tab's, not the first tab's. The store mutates, so
 * `setActive` really moves the Focused Tab and `close` really removes a tab,
 * the way the real service does.
 *
 * With no `isActive` given, the first tab is focused — one Connection, one
 * tab, nothing surprising.
 */
export function multiConnectionMock(spec: {
  connections: Partial<ConnectionSummary>[];
  tabs: Partial<WorkspaceTab>[];
}): Pick<Deep<IpcApi>, 'conn' | 'tabs'> {
  const connections = spec.connections.map((c) => connectionFixture(c));
  let rows: WorkspaceTab[] = spec.tabs.map((t, i) =>
    collectionTabFixture({ id: `t${i + 1}`, position: i, ...t } as Partial<CollectionTab>),
  );
  if (rows.length > 0 && !rows.some((t) => t.isActive)) {
    rows = rows.map((t, i) => ({ ...t, isActive: i === 0 }));
  }
  return {
    conn: { list: async () => connections },
    tabs: {
      list: async () => rows,
      setActive: async (id: string) => {
        rows = rows.map((t) => ({ ...t, isActive: t.id === id }));
        return { id };
      },
      close: async (id: string) => {
        rows = rows.filter((t) => t.id !== id);
        return { newActiveId: rows.find((t) => t.isActive)?.id ?? null };
      },
      update: async (id: string, patch: { state: object }) => {
        rows = rows.map((t) =>
          t.id === id ? ({ ...t, state: { ...t.state, ...patch.state } } as WorkspaceTab) : t,
        );
        return rows.find((t) => t.id === id) ?? rows[0];
      },
      setPinned: async ({ id, pinned }: { id: string; pinned: boolean }) => {
        rows = rows.map((t) => (t.id === id ? { ...t, pinned } : t));
        return rows.find((t) => t.id === id) ?? rows[0];
      },
    },
  };
}

/**
 * Reset `window.atelier` to a fully-permissive stub. Every method resolves a
 * benign default; nothing throws. This keeps React effect cleanups safe when
 * RTL unmounts components between tests — `afterEach` hook ordering means our
 * uninstall runs before RTL's `cleanup()`, and an in-flight effect that hits
 * the bridge during unmount must not crash the next test's setup.
 *
 * If a follow-up test forgets to call `installAtelierMock`, calls hit the
 * permissive stub instead of the strict `unused(...)` throws — that's a
 * deliberate trade: silent test bugs are recoverable, crashed CI runs are not.
 */
export function uninstallAtelierMock() {
  (window as unknown as { atelier?: IpcApi }).atelier = makePermissiveStub();
}

function makePermissiveStub(): IpcApi {
  const noopAsync = async () => undefined as never;
  const noopFn = () => undefined as never;
  const okAsync = <T>(value: T) => async () => value;

  return {
    conn: {
      list: async () => [],
      get: noopAsync as IpcApi['conn']['get'],
      getUri: noopAsync as IpcApi['conn']['getUri'],
      create: noopAsync as IpcApi['conn']['create'],
      update: noopAsync as IpcApi['conn']['update'],
      delete: async (id) => ({ id }),
      touchUsed: async (id) => ({ id }),
      parseUri: noopAsync as IpcApi['conn']['parseUri'],
      test: okAsync({ ok: false }) as IpcApi['conn']['test'],
      export: okAsync({ cancelled: true as const }) as IpcApi['conn']['export'],
      importOpen: okAsync({ cancelled: true as const }) as IpcApi['conn']['importOpen'],
      importMap: noopAsync as IpcApi['conn']['importMap'],
      importUris: noopAsync as IpcApi['conn']['importUris'],
      importCommit: noopAsync as IpcApi['conn']['importCommit'],
    },
    app: {
      pickFile: async () => ({ path: null }),
      openExternal: async () => ({ opened: false }),
      saveFile: async () => ({ path: null }),
      diagnosticBundle: async () => ({ path: null }),
      setUnsavedWork: async () => {},
      onMenuCommand: () => () => {},
      onFlushRequest: () => () => {},
      flushDone: async () => {},
      log: async () => {},
    },
    updates: {
      getState: async () => ({ status: 'idle' as const }),
      restart: async (): Promise<{ restarting: boolean }> => ({ restarting: true }),
      onState: () => () => {},
    },
    shell: {
      openExternal: async () => ({ opened: true as const }),
    },
    mongo: {
      connect: async (id) => ({ id, status: 'disconnected' }),
      disconnect: async (id) => ({ id }),
      status: async (id) => ({ id, status: 'disconnected' }),
      ping: async () => ({ roundTripMs: 0 }),
      serverInfo: noopAsync as IpcApi['mongo']['serverInfo'],
      onStatus: () => noopFn,
    },
    meta: {
      listDatabases: async () => [],
      listCollections: async () => [],
      collectionDetails: noopAsync as IpcApi['meta']['collectionDetails'],
      sampleSchema: async () => ({ docs: [] }),
    },
    index: {
      list: async () => [],
      create: noopAsync as IpcApi['index']['create'],
      drop: async () => ({ dropped: true as const }),
    },
    collection: {
      create: noopAsync as IpcApi['collection']['create'],
      drop: async () => ({ dropped: true }),
      rename: noopAsync as IpcApi['collection']['rename'],
      modify: noopAsync as IpcApi['collection']['modify'],
    },
    database: {
      drop: async () => ({ dropped: true as const }),
    },
    user: {
      list: async () => [],
      get: noopAsync as IpcApi['user']['get'],
      create: noopAsync as IpcApi['user']['create'],
      update: noopAsync as IpcApi['user']['update'],
      drop: async () => ({ dropped: true as const }),
    },
    role: {
      list: async () => [],
      create: noopAsync as IpcApi['role']['create'],
      update: noopAsync as IpcApi['role']['update'],
      drop: async () => ({ dropped: true as const }),
    },
    admin: {
      currentOp: async () => ({ ops: [] }),
      killOp: async () => ({ ok: true as const }),
      profileStatus: async () => ({ level: 0 as const, slowms: 100 }),
      setProfileLevel: async () => ({ ok: true as const }),
      profileTail: async () => ({ docs: [] }),
    },
    prefs: {
      get: async () => null,
      set: async (_k, v) => v,
      getTheme: async () => 'system' as const,
      setTheme: async () => undefined,
      onThemeChanged: () => noopFn,
    },
    secrets: {
      setPlaintextFallback: async (enabled) => ({ enabled }),
      status: async () => ({ columnKeyProtected: true }),
    },
    query: {
      find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
      count: async () => ({ count: 0 }),
      findOne: async () => ({ document: null, durationMs: 0 }),
      explain: (async () => ({ plan: {}, verbosity: 'queryPlanner' })) as IpcApi['query']['explain'],
      cancel: async () => undefined,
      export: noopAsync as IpcApi['query']['export'],
    },
    doc: {
      insert: noopAsync as IpcApi['doc']['insert'],
      insertMany: noopAsync as IpcApi['doc']['insertMany'],
      updateOne: noopAsync as IpcApi['doc']['updateOne'],
      deleteOne: noopAsync as IpcApi['doc']['deleteOne'],
      confirmDeleteMany: noopAsync as IpcApi['doc']['confirmDeleteMany'],
      deleteMany: noopAsync as IpcApi['doc']['deleteMany'],
      confirmUpdateMany: noopAsync as IpcApi['doc']['confirmUpdateMany'],
      updateMany: noopAsync as IpcApi['doc']['updateMany'],
    },
    saved: {
      list: async () => [],
      get: noopAsync as IpcApi['saved']['get'],
      create: noopAsync as IpcApi['saved']['create'],
      update: noopAsync as IpcApi['saved']['update'],
      delete: async () => undefined,
      duplicate: noopAsync as IpcApi['saved']['duplicate'],
    },
    data: {
      import: noopAsync as IpcApi['data']['import'],
      previewCsv: noopAsync as IpcApi['data']['previewCsv'],
      cancelImport: async () => undefined,
      onImportProgress: () => noopFn,
    },
    audit: {
      list: async () => [],
      undo: noopAsync as IpcApi['audit']['undo'],
    },
    recent: {
      list: async () => [],
      get: noopAsync as IpcApi['recent']['get'],
      clear: async () => ({ deleted: 0 }),
      valuesForField: async () => ({ values: [] }),
      recordFieldValues: async () => ({ recorded: 0 }),
      clearFieldValues: async () => ({ deleted: 0 }),
    },
    agg: {
      run: noopAsync as IpcApi['agg']['run'],
      previewUpToStage: noopAsync as IpcApi['agg']['previewUpToStage'],
      cancel: async () => undefined,
      runAndSave: noopAsync as IpcApi['agg']['runAndSave'],
      explain: noopAsync as IpcApi['agg']['explain'],
    },
    refs: {
      list: async () => [],
      get: noopAsync as IpcApi['refs']['get'],
      create: noopAsync as IpcApi['refs']['create'],
      update: noopAsync as IpcApi['refs']['update'],
      delete: async () => undefined,
      resolve: noopAsync as IpcApi['refs']['resolve'],
      autodetect: async () => [],
    },
    tabs: {
      list: async () => [],
      openCollection: noopAsync as IpcApi['tabs']['openCollection'],
      openAggregation: noopAsync as IpcApi['tabs']['openAggregation'],
      openDefault: noopAsync as IpcApi['tabs']['openDefault'],
      openScript: noopAsync as IpcApi['tabs']['openScript'],
      update: noopAsync as IpcApi['tabs']['update'],
      close: async () => ({ newActiveId: null }),
      setActive: async (id) => ({ id }),
      reorder: async () => ({ ok: true as const }),
      setPinned: noopAsync as IpcApi['tabs']['setPinned'],
      collectionRenamed: async () => ({ retargeted: false, closed: false }),
    },
    mshell: {
      start: noopAsync as IpcApi['mshell']['start'],
      write: async () => undefined,
      stop: async () => undefined,
      list: async () => [],
      onOutput: () => noopFn,
    },
    script: {
      run: noopAsync as IpcApi['script']['run'],
      cancel: async () => undefined,
    },
  };
}
