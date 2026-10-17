import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type Envelope, type IpcApi, type MenuCommand } from '@shared/ipc';
import type {
  AggResult,
  AggResultWire,
  AggSaveCounts,
  DataImportProgressEvent,
  FindResult,
  FindResultWire,
  ShellOutputEvent,
} from '@shared/types';

function invoke<T>(channel: string, payload?: unknown): Promise<Envelope<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<Envelope<T>>;
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const env = await invoke<T>(channel, payload);
  if (!env.ok) throw env.error;
  return env.data;
}

// Find/aggregate results cross the wire as a JSON string and are parsed once
// here at the preload boundary. Avoids structured-cloning every nested EJSON
// sentinel object across the IPC.
function parseFindResult(wire: FindResultWire): FindResult {
  return {
    documents: JSON.parse(wire.documentsJson) as unknown[],
    durationMs: wire.durationMs,
    hasMore: wire.hasMore,
  };
}

function parseAggResult<T extends AggResultWire>(
  wire: T,
): Omit<T, 'rowsJson'> & { rows: unknown[] } {
  const { rowsJson, ...rest } = wire;
  return { ...rest, rows: JSON.parse(rowsJson) as unknown[] };
}

const api: IpcApi = {
  conn: {
    list: () => call(IPC_CHANNELS.connList),
    get: (id) => call(IPC_CHANNELS.connGet, { id }),
    getUri: (id) => call(IPC_CHANNELS.connGetUri, { id }),
    create: (input) => call(IPC_CHANNELS.connCreate, input),
    update: (id, patch) => call(IPC_CHANNELS.connUpdate, { id, patch }),
    delete: (id) => call(IPC_CHANNELS.connDelete, { id }),
    touchUsed: (id) => call(IPC_CHANNELS.connTouchUsed, { id }),
    parseUri: (uri) => call(IPC_CHANNELS.connParseUri, { uri }),
    test: (input) => call(IPC_CHANNELS.connTest, input),
    export: (input) => call(IPC_CHANNELS.connExport, input),
    importOpen: () => call(IPC_CHANNELS.connImportOpen, {}),
    importMap: (input) => call(IPC_CHANNELS.connImportMap, input),
    importUris: (uris) => call(IPC_CHANNELS.connImportUris, { uris }),
    importCommit: (input) => call(IPC_CHANNELS.connImportCommit, input),
  },

  app: {
    pickFile: (purpose) => call(IPC_CHANNELS.appPickFile, purpose),
    openExternal: (url) => call(IPC_CHANNELS.appOpenExternal, url),
    saveFile: (input) => call(IPC_CHANNELS.appSaveFile, input),
    diagnosticBundle: () => call(IPC_CHANNELS.appDiagnosticBundle, {}),
    onMenuCommand: (cb) => {
      const listener = (_evt: unknown, command: unknown) => cb(command as MenuCommand);
      ipcRenderer.on(IPC_CHANNELS.appMenuCommandEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.appMenuCommandEvent, listener);
    },
  },

  updates: {
    getState: () => call(IPC_CHANNELS.updatesGetState, {}),
    restart: () => call(IPC_CHANNELS.updatesRestart, {}),
    onState: (cb) => {
      const listener = (_evt: unknown, state: unknown) => cb(state as Parameters<typeof cb>[0]);
      ipcRenderer.on(IPC_CHANNELS.updatesStateEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updatesStateEvent, listener);
    },
  },

  shell: {
    openExternal: (input) => call(IPC_CHANNELS.shellOpenExternal, input),
  },

  mongo: {
    connect: (id) => call(IPC_CHANNELS.mongoConnect, { id }),
    disconnect: (id) => call(IPC_CHANNELS.mongoDisconnect, { id }),
    status: (id) => call(IPC_CHANNELS.mongoStatus, { id }),
    ping: (id) => call(IPC_CHANNELS.mongoPing, { id }),
    serverInfo: (id) => call(IPC_CHANNELS.mongoServerInfo, { id }),
    onStatus: (cb) => {
      const listener = (_evt: unknown, runtime: unknown) =>
        cb(runtime as Parameters<typeof cb>[0]);
      ipcRenderer.on(IPC_CHANNELS.mongoStatusEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mongoStatusEvent, listener);
    },
  },

  meta: {
    listDatabases: (input) => call(IPC_CHANNELS.metaListDatabases, input),
    listCollections: (input) => call(IPC_CHANNELS.metaListCollections, input),
    sampleSchema: (input) => call(IPC_CHANNELS.metaSampleSchema, input),
    collectionDetails: (input) => call(IPC_CHANNELS.metaCollectionDetails, input),
  },

  index: {
    list: (input) => call(IPC_CHANNELS.indexList, input),
    create: (input) => call(IPC_CHANNELS.indexCreate, input),
    drop: (input) => call(IPC_CHANNELS.indexDrop, input),
  },

  collection: {
    create: (input) => call(IPC_CHANNELS.collectionCreate, input),
    drop: (input) => call(IPC_CHANNELS.collectionDrop, input),
    rename: (input) => call(IPC_CHANNELS.collectionRename, input),
    modify: (input) => call(IPC_CHANNELS.collectionModify, input),
  },

  database: {
    drop: (input) => call(IPC_CHANNELS.databaseDrop, input),
  },

  user: {
    list: (input) => call(IPC_CHANNELS.userList, input),
    get: (input) => call(IPC_CHANNELS.userGet, input),
    create: (input) => call(IPC_CHANNELS.userCreate, input),
    update: (input) => call(IPC_CHANNELS.userUpdate, input),
    drop: (input) => call(IPC_CHANNELS.userDrop, input),
  },

  role: {
    list: (input) => call(IPC_CHANNELS.roleList, input),
  },

  prefs: {
    get: (key) => call(IPC_CHANNELS.prefsGet, { key }),
    set: (key, value) => call(IPC_CHANNELS.prefsSet, { key, value }),
    getTheme: () => call(IPC_CHANNELS.prefsGetTheme),
    setTheme: (mode) => call(IPC_CHANNELS.prefsSetTheme, { mode }),
    onThemeChanged: (cb) => {
      const listener = (_evt: unknown, mode: unknown) => cb(mode as 'light' | 'dark' | 'system');
      ipcRenderer.on(IPC_CHANNELS.prefsThemeEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.prefsThemeEvent, listener);
    },
  },

  secrets: {
    setPlaintextFallback: (enabled) =>
      call(IPC_CHANNELS.secretsSetPlaintextFallback, { enabled }),
  },

  query: {
    find: async (input) => parseFindResult(
      await call<FindResultWire>(IPC_CHANNELS.queryFind, input),
    ),
    count: (input) => call(IPC_CHANNELS.queryCount, input),
    findOne: (input) => call(IPC_CHANNELS.queryFindOne, input),
    explain: (input) => call(IPC_CHANNELS.queryExplain, input),
    cancel: (input) => call(IPC_CHANNELS.queryCancel, input),
    export: (input) => call(IPC_CHANNELS.queryExport, input),
  },

  doc: {
    insert: (input) => call(IPC_CHANNELS.docInsert, input),
    insertMany: (input) => call(IPC_CHANNELS.docInsertMany, input),
    updateOne: (input) => call(IPC_CHANNELS.docUpdateOne, input),
    deleteOne: (input) => call(IPC_CHANNELS.docDeleteOne, input),
    confirmDeleteMany: (input) => call(IPC_CHANNELS.docConfirmDeleteMany, input),
    deleteMany: (input) => call(IPC_CHANNELS.docDeleteMany, input),
    confirmUpdateMany: (input) => call(IPC_CHANNELS.docConfirmUpdateMany, input),
    updateMany: (input) => call(IPC_CHANNELS.docUpdateMany, input),
  },

  saved: {
    list: (input) => call(IPC_CHANNELS.savedList, input),
    get: (input) => call(IPC_CHANNELS.savedGet, input),
    create: (input) => call(IPC_CHANNELS.savedCreate, input),
    update: (input) => call(IPC_CHANNELS.savedUpdate, input),
    delete: (input) => call(IPC_CHANNELS.savedDelete, input),
    duplicate: (input) => call(IPC_CHANNELS.savedDuplicate, input),
  },

  data: {
    import: (input) => call(IPC_CHANNELS.dataImport, input),
    previewCsv: (input) => call(IPC_CHANNELS.dataPreviewCsv, input),
    cancelImport: (input) => call(IPC_CHANNELS.dataCancelImport, input),
    onImportProgress: (cb) => {
      const listener = (_evt: unknown, payload: unknown) => cb(payload as DataImportProgressEvent);
      ipcRenderer.on(IPC_CHANNELS.dataImportProgressEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.dataImportProgressEvent, listener);
    },
  },

  audit: {
    list: (input) => call(IPC_CHANNELS.auditList, input),
    undo: (input) => call(IPC_CHANNELS.auditUndo, input),
  },
  recent: {
    list: (input) => call(IPC_CHANNELS.recentList, input),
    get: (input) => call(IPC_CHANNELS.recentGet, input),
    clear: (input) => call(IPC_CHANNELS.recentClear, input),
    valuesForField: (input) => call(IPC_CHANNELS.recentValuesForField, input),
    recordFieldValues: (input) => call(IPC_CHANNELS.recentRecordFieldValues, input),
    clearFieldValues: () => call(IPC_CHANNELS.recentClearFieldValues, {}),
  },

  agg: {
    run: async (input): Promise<AggResult> => parseAggResult(
      await call<AggResultWire>(IPC_CHANNELS.aggRun, input),
    ),
    previewUpToStage: (input) => call(IPC_CHANNELS.aggPreviewUpToStage, input),
    cancel: (input) => call(IPC_CHANNELS.aggCancel, input),
    runAndSave: async (input) => parseAggResult(
      await call<AggResultWire & AggSaveCounts>(IPC_CHANNELS.aggRunAndSave, input),
    ),
    explain: (input) => call(IPC_CHANNELS.aggExplain, input),
  },

  refs: {
    list: (input) => call(IPC_CHANNELS.refsList, input),
    get: (input) => call(IPC_CHANNELS.refsGet, input),
    create: (input) => call(IPC_CHANNELS.refsCreate, input),
    update: (input) => call(IPC_CHANNELS.refsUpdate, input),
    delete: (input) => call(IPC_CHANNELS.refsDelete, input),
    resolve: (input) => call(IPC_CHANNELS.refsResolve, input),
    autodetect: (input) => call(IPC_CHANNELS.refsAutodetect, input),
  },

  mshell: {
    start: (input) => call(IPC_CHANNELS.mshellStart, input),
    write: (input) => call(IPC_CHANNELS.mshellWrite, input),
    stop: (input) => call(IPC_CHANNELS.mshellStop, input),
    list: () => call(IPC_CHANNELS.mshellList),
    onOutput: (cb) => {
      const listener = (_evt: unknown, payload: unknown) => cb(payload as ShellOutputEvent);
      ipcRenderer.on(IPC_CHANNELS.mshellOutputEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mshellOutputEvent, listener);
    },
  },

  script: {
    run: (input) => call(IPC_CHANNELS.scriptRun, input),
    cancel: (input) => call(IPC_CHANNELS.scriptCancel, input),
  },

  tabs: {
    list: () => call(IPC_CHANNELS.tabsList),
    openCollection: (input) => call(IPC_CHANNELS.tabsOpenCollection, input),
    openAggregation: (input) => call(IPC_CHANNELS.tabsOpenAggregation, input),
    openDefault: (input) => call(IPC_CHANNELS.tabsOpenDefault, input),
    openScript: (input) => call(IPC_CHANNELS.tabsOpenScript, input),
    update: (id, patch) => call(IPC_CHANNELS.tabsUpdate, { id, patch }),
    close: (id) => call(IPC_CHANNELS.tabsClose, { id }),
    setActive: (id) => call(IPC_CHANNELS.tabsSetActive, { id }),
    reorder: (orderedIds) => call(IPC_CHANNELS.tabsReorder, { orderedIds }),
    setPinned: (input) => call(IPC_CHANNELS.tabsSetPinned, input),
    collectionRenamed: (input) => call(IPC_CHANNELS.tabsCollectionRenamed, input),
  },
};

contextBridge.exposeInMainWorld('atelier', api);

// Test-mode flag for the renderer. When the E2E harness launches with a
// throwaway userData dir via ATELIER_USER_DATA_DIR + NODE_ENV=test, the
// renderer skips purely-cosmetic UX layers (the splash overlay, feature
// hints) so tests don't race against animations or fixed-z-index overlays.
//
// Bracket notation defeats Vite/esbuild's build-time substitution of
// `process.env.NODE_ENV` — the previous member-access form was being
// folded to a literal `false` at build time, which silently disabled the
// test-mode suppression in every packaged preload.
const __envProcess = process as {
  env: Record<string, string | undefined>;
  platform: string;
};
contextBridge.exposeInMainWorld('__atelierEnv__', {
  isTest:
    __envProcess.env['NODE_ENV'] === 'test' &&
    !!__envProcess.env['ATELIER_USER_DATA_DIR'],
  // Sandboxed preloads still get `process.platform` (probed on Electron).
  platform: __envProcess.platform,
});
