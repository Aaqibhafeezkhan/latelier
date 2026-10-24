// IPC contract shared by main and renderer. Runtime-free.

import type {
  AggExplainInput,
  AggInput,
  AggResult,
  AggRunAndSaveInput,
  AggSaveCounts,
  AggStagePreview,
  AggregationTabState,
  AuditEntry,
  AuditListInput,
  UndoResult,
  CollectionCreateInput,
  CollectionDropInput,
  CollectionModifyInput,
  CollectionRenameInput,
  CollectionTab,
  CollectionTabState,
  Connection,
  ConnectionExportInput,
  ConnectionExportResult,
  ConnectionInput,
  ImportCommitInput,
  ImportCommitResult,
  ImportMapInput,
  ImportMapResult,
  ImportOpenResult,
  ImportUrisResult,
  UpdateState,
  ConnectionRuntime,
  ConnectionSummary,
  ConnectionUpdate,
  CsvPreview,
  CurrentOpInput,
  CountInput,
  CurrentOpSummary,
  DataImportInput,
  DataImportProgressEvent,
  DatabaseDropInput,
  ExplainInput,
  FindInput,
  FindResult,
  ImportReport,
  IndexCreateInput,
  IndexDropInput,
  IndexInfo,
  ParsedUri,
  PreviewInput,
  ProbeResult,
  ProfileLevel,
  ProfileStatus,
  QueryExportInput,
  QueryExportResult,
  RoleCreateInput,
  RoleDropInput,
  RoleInfo,
  RoleUpdateInput,
  UserCreateInput,
  UserDropInput,
  UserInfo,
  UserUpdateInput,
  RecentKind,
  RecentQuery,
  ValType,
  ReferenceAutodetectCandidate,
  ReferenceAutodetectInput,
  ReferenceResolveInput,
  ReferenceResolveResult,
  ReferenceRule,
  ReferenceRuleCreateInput,
  ReferenceRuleUpdateInput,
  SavedKind,
  SavedQuery,
  SavedQuerySummary,
  ScriptRunInput,
  ScriptRunResultWire,
  ScriptTab,
  ScriptTabState,
  ShellOutputEvent,
  ShellSessionInfo,
  ValidationAction,
  ValidationLevel,
  WorkspaceTab,
} from './types.ts';

/** A native menu item that opens a renderer dialog. */
export type MenuCommand = 'connections.export' | 'connections.import';

export type IpcErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'MONGO_ERROR'
  | 'DB_ERROR'
  | 'SECRETS_UNAVAILABLE'
  | 'SECRET_DECRYPT_FAILED'
  | 'BAD_PASSPHRASE'
  | 'READ_ONLY'
  | 'AUDIT_NOT_REVERSIBLE'
  | 'AUDIT_UNDO_EXPIRED'
  | 'AUDIT_ALREADY_UNDONE'
  | 'AUDIT_TARGET_CHANGED'
  // Deliberately distinct from UNAUTHORIZED, which the renderer already reads
  // as "your MongoDB user lacks permission" in several places. This one means
  // the IPC message did not come from the app's own document, which is a very
  // different thing to tell someone. It is not an AppErrorCode: nothing throws
  // it, because it is decided before any handler runs.
  | 'UNTRUSTED_SENDER'
  | 'INTERNAL';

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  details?: unknown;
}

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: IpcError };

export interface ServerInfo {
  version: string;
  uptimeSeconds: number;
  connectionsCurrent: number;
  connectionsAvailable: number;
  opcountersPerSec: number;
  latencyP99Ms?: number;
  cacheHitRate?: number;
  /**
   * Null when the `listDatabases` these three are derived from failed — a
   * role without the privilege, or its time bound firing. A server with no
   * databases genuinely reports 0, so the two cannot share a value. UI
   * renders null as "—", the same way it already does for `indexCount`.
   */
  databaseCount: number | null;
  dataSizeBytes: number | null;
  storageSizeBytes: number | null;
  indexCount: number | null;
  topology: 'Single' | 'ReplicaSet' | 'Sharded' | 'Unknown';
  /**
   * True when the MongoDB `serverStatus` admin command succeeded. When false,
   * the user's role lacks the required privilege (Atlas read-only, scoped
   * roles, etc.) and the uptime/connections/opcounters fields are placeholders
   * (0) rather than real values. UI should render them as "—".
   */
  serverStatsAvailable: boolean;
}

export interface DbInfo {
  name: string;
  /**
   * Absent when the size was never measured — `MetaService.listDatabases`
   * falls back to a names-only catalog read when the full one exceeds its
   * time bound, and that reply carries no sizes. Distinct from 0, which is a
   * database the server reported as occupying no space.
   */
  sizeOnDisk?: number;
  empty: boolean;
}

export interface CollectionInfo {
  name: string;
  type: 'collection' | 'view' | 'timeseries';
  /**
   * The three figures below are absent when the server did not report them
   * (a time-series `$collStats` has no count) or the read failed: absent is
   * not zero, and the UI shows a dash for it.
   */
  documentCount?: number;
  sizeBytes?: number;
  indexCount?: number;
  lastModified?: string;
  capped: boolean;
}

/** One collection's stats and `listCollections` options (W16 §13). */
export interface CollectionDetails {
  name: string;
  type: 'collection' | 'view' | 'timeseries';
  capped: boolean;
  /** Absent for a view. A figure the server did not report is absent, never 0. */
  stats?: {
    documentCount?: number;
    sizeBytes?: number;
    indexCount?: number;
    storageSizeBytes?: number;
    avgObjSizeBytes?: number;
    totalIndexSizeBytes?: number;
  };
  /** From listCollections `options`; the documents are EJSON canonical strings. */
  options: {
    viewOn?: string;
    pipeline?: string;
    validator?: string;
    validationLevel?: ValidationLevel;
    validationAction?: ValidationAction;
    /** A view's or collection's collation; EJSON canonical string. */
    collation?: string;
  };
}

/**
 * IpcApi — the typed surface exposed to the renderer via contextBridge.
 * Every method returns a resolved `T` (errors thrown as IpcError), never an
 * Envelope — the preload unwraps it.
 */
/**
 * Stages a `tabs.openAggregation` call seeds the Aggregation view with, in
 * exactly the shape main's zod schema accepts: `stages` required, nothing
 * else of `AggregationTabState`.
 */
export type AggregationSeed = Pick<AggregationTabState, 'stages'> &
  Partial<Pick<AggregationTabState, 'activeStageId' | 'dirty'>>;

export interface IpcApi {
  conn: {
    list: () => Promise<ConnectionSummary[]>;
    get: (id: string) => Promise<Connection>;
    /** The saved connection's URI, built in main without its password. */
    getUri: (id: string) => Promise<{ uri: string }>;
    create: (input: ConnectionInput) => Promise<Connection>;
    update: (id: string, patch: ConnectionUpdate) => Promise<Connection>;
    delete: (id: string) => Promise<{ id: string }>;
    touchUsed: (id: string) => Promise<{ id: string }>;
    parseUri: (uri: string) => Promise<ParsedUri>;
    test: (input: ConnectionInput) => Promise<ProbeResult>;
    /** Main shows the save dialog and writes the file; secrets never come back. */
    export: (input: ConnectionExportInput) => Promise<ConnectionExportResult>;
    /** C14 wizard: main shows the open dialog, detects the format and returns a token plus a review (or mapping candidates). */
    importOpen: () => Promise<ImportOpenResult>;
    importMap: (input: ImportMapInput) => Promise<ImportMapResult>;
    importUris: (uris: string[]) => Promise<ImportUrisResult>;
    importCommit: (input: ImportCommitInput) => Promise<ImportCommitResult>;
  };

  app: {
    pickFile: (purpose: PickFilePurpose) => Promise<{ path: string | null }>;
    openExternal: (url: string) => Promise<{ opened: boolean }>;
    saveFile: (input: { defaultName?: string; content: string }) => Promise<{ path: string | null }>;
    /**
     * Build a JSON diagnostic bundle (recent logs + redacted connection
     * metadata + app/runtime versions) and prompt the user for a save
     * location. Returns the chosen path, or `null` on user cancel.
     */
    diagnosticBundle: () => Promise<{ path: string | null }>;
    /**
     * Reports how much unsaved work one source holds, replacing its last
     * report, so quitting can name it (F06). Main forgets every report when
     * the page reloads, crashes or its window closes.
     */
    setUnsavedWork: (input: { source: UnsavedWorkSource; count: number }) => Promise<void>;
    /** Native File-menu commands pushed from main; returns the unsubscribe. */
    onMenuCommand: (cb: (command: MenuCommand) => void) => () => void;
  };

  /** Auto-update: one state, one action. See specs/X20-auto-update.md. */
  updates: {
    getState: () => Promise<UpdateState>;
    /**
     * Quits, installs the downloaded update and relaunches. Rejects unless
     * `ready`. Asks first when work is running; `restarting: false` means the
     * user cancelled, and main re-sends `ready` so Restart is offered again.
     */
    restart: () => Promise<{ restarting: boolean }>;
    /** Main pushes the state when a download finishes; returns the unsubscribe. */
    onState: (cb: (state: UpdateState) => void) => () => void;
  };

  /** Refuses any URL that does not start with https://www.mongodb.com/docs/. */
  shell: {
    openExternal: (input: { url: string }) => Promise<{ opened: true }>;
  };

  mongo: {
    connect: (id: string) => Promise<ConnectionRuntime>;
    disconnect: (id: string) => Promise<{ id: string }>;
    status: (id: string) => Promise<ConnectionRuntime>;
    ping: (id: string) => Promise<{ roundTripMs: number }>;
    serverInfo: (id: string) => Promise<ServerInfo>;
    onStatus: (cb: (runtime: ConnectionRuntime) => void) => () => void;
  };

  index: {
    list: (input: { connectionId: string; dbName: string; collection: string }) => Promise<IndexInfo[]>;
    create: (input: IndexCreateInput) => Promise<{ name: string }>;
    drop: (input: IndexDropInput) => Promise<{ dropped: true }>;
  };

  /** MongoDB has no separate "create database" primitive — creating a collection creates it too. */
  collection: {
    create: (input: CollectionCreateInput) => Promise<{ name: string }>;
    drop: (input: CollectionDropInput) => Promise<{ dropped: boolean }>;
    rename: (input: CollectionRenameInput) => Promise<{ name: string; auditId?: string }>;
    /** `collMod`: a collection's validation rules, or a view's source and pipeline. */
    modify: (input: CollectionModifyInput) => Promise<{ ok: true }>;
  };

  database: {
    drop: (input: DatabaseDropInput) => Promise<{ dropped: true }>;
  };

  user: {
    list: (input: { connectionId: string; dbName?: string }) => Promise<UserInfo[]>;
    get: (input: { connectionId: string; dbName: string; username: string }) => Promise<UserInfo>;
    create: (input: UserCreateInput) => Promise<{ ok: true }>;
    update: (input: UserUpdateInput) => Promise<{ ok: true }>;
    drop: (input: UserDropInput) => Promise<{ dropped: true }>;
  };

  role: {
    list: (input: { connectionId: string; dbName: string }) => Promise<RoleInfo[]>;
    create: (input: RoleCreateInput) => Promise<{ ok: true }>;
    update: (input: RoleUpdateInput) => Promise<{ ok: true }>;
    drop: (input: RoleDropInput) => Promise<{ dropped: true }>;
  };

  /** Monitor tab (C06 §9): running ops, killOp and the database profiler. */
  admin: {
    currentOp: (input: CurrentOpInput) => Promise<{ ops: CurrentOpSummary[] }>;
    killOp: (input: { connectionId: string; opid: string }) => Promise<{ ok: true }>;
    profileStatus: (input: { connectionId: string; dbName: string }) => Promise<ProfileStatus>;
    setProfileLevel: (input: {
      connectionId: string;
      dbName: string;
      level: ProfileLevel;
      slowms?: number;
    }) => Promise<{ ok: true }>;
    /** Latest `system.profile` rows, newest first, as canonical EJSON documents. */
    profileTail: (input: {
      connectionId: string;
      dbName: string;
      limit?: number;
    }) => Promise<{ docs: unknown[] }>;
  };

  meta: {
    listDatabases: (input: { connectionId: string; includeSystem?: boolean }) => Promise<DbInfo[]>;
    listCollections: (input: { connectionId: string; dbName: string }) => Promise<CollectionInfo[]>;
    collectionDetails: (input: {
      connectionId: string;
      dbName: string;
      collection: string;
    }) => Promise<CollectionDetails>;
    /** Blended sample (recent by _id + random $sample) for autocomplete inference; caller treats a miss as empty. */
    sampleSchema: (input: {
      connectionId: string;
      dbName: string;
      collection: string;
      size?: number;
    }) => Promise<{ docs: unknown[] }>;
  };

  prefs: {
    get: <T>(key: string) => Promise<T | null>;
    set: <T>(key: string, value: T) => Promise<T>;
    getTheme: () => Promise<'light' | 'dark' | 'system'>;
    setTheme: (mode: 'light' | 'dark' | 'system') => Promise<void>;
    onThemeChanged: (cb: (mode: 'light' | 'dark' | 'system') => void) => () => void;
  };

  secrets: {
    /**
     * Enabling makes main show its own warning dialog first; the result is the
     * value now in force, so a cancelled enable comes back `{ enabled: false }`.
     */
    setPlaintextFallback: (enabled: boolean) => Promise<{ enabled: boolean }>;
  };

  query: {
    find: (input: FindInput) => Promise<FindResult>;
    count: (input: CountInput) => Promise<{ count: number }>;
    findOne: (input: Pick<FindInput, 'connectionId' | 'dbName' | 'collection' | 'filter' | 'projection' | 'sort'>) => Promise<{ document: unknown | null; durationMs: number }>;
    explain: (input: ExplainInput) => Promise<{ plan: unknown; verbosity: string }>;
    cancel: (input: { token: string }) => Promise<void>;
    /** Export every matching document (up to a hard cap) straight to a file the user picks. */
    export: (input: QueryExportInput) => Promise<QueryExportResult>;
  };

  doc: {
    insert: (input: { connectionId: string; dbName: string; collection: string; docJson: string }) => Promise<{ insertedId: unknown }>;
    insertMany: (input: { connectionId: string; dbName: string; collection: string; docsJson: string }) => Promise<{ insertedCount: number; insertedIds: unknown[] }>;
    // `auditId` is present only when the write was recorded Reversible: it is
    // the entry to hand `audit.undo`, so its presence is what offers Undo.
    updateOne: (input: { connectionId: string; dbName: string; collection: string; filterJson: string; updateJson: string }) => Promise<{ matchedCount: number; modifiedCount: number; auditId?: string }>;
    deleteOne: (input: { connectionId: string; dbName: string; collection: string; filterJson: string }) => Promise<{ deletedCount: number; auditId?: string }>;
    confirmDeleteMany: (input: { connectionId: string; dbName: string; collection: string; filterJson: string }) => Promise<{ count: number; confirmToken: string }>;
    deleteMany: (input: { connectionId: string; dbName: string; collection: string; filterJson: string; confirmToken: string }) => Promise<{ deletedCount: number; auditId?: string }>;
    confirmUpdateMany: (input: { connectionId: string; dbName: string; collection: string; filterJson: string; updateJson: string }) => Promise<{ count: number; confirmToken: string }>;
    updateMany: (input: { connectionId: string; dbName: string; collection: string; filterJson: string; updateJson: string; confirmToken: string }) => Promise<{ matchedCount: number; modifiedCount: number; auditId?: string }>;
  };

  saved: {
    list: (input: { connectionId?: string; dbName?: string; collection?: string; kind?: SavedKind }) => Promise<SavedQuerySummary[]>;
    get: (input: { id: string }) => Promise<SavedQuery>;
    create: (input: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'>) => Promise<SavedQuery>;
    update: (input: { id: string; patch: Partial<Pick<SavedQuery, 'name' | 'payload'>> }) => Promise<SavedQuery>;
    delete: (input: { id: string }) => Promise<void>;
    duplicate: (input: { id: string; newName: string }) => Promise<SavedQuery>;
  };

  /**
   * Bulk data in and out of a collection. `import` takes the path the
   * renderer got back from `app.pickFile('data-import')`. Main remembers
   * every path that dialog returned and refuses any other, so the renderer
   * can hand back a file the user picked but never name one; it then
   * re-validates the path (absolute, allowed extension, a regular file)
   * before reading. It opens no dialog of its own, so a cancelled pick never
   * reaches this audited channel and records no row.
   */
  data: {
    import: (input: DataImportInput) => Promise<ImportReport>;
    /**
     * Reads a `.csv` file the renderer got from `app.pickFile('data-import')`
     * — refused unless that dialog returned it, then re-validated as for
     * `import` — and returns its header, first rows
     * and an inferred type per column, for the dialog's mapping step.
     */
    previewCsv: (input: { path: string }) => Promise<CsvPreview>;
    /** Sets a flag `ImportService` checks between batches; the current batch still lands. */
    cancelImport: (input: { token: string }) => Promise<void>;
    onImportProgress: (cb: (evt: DataImportProgressEvent) => void) => () => void;
  };

  /** The Audit Log: newest first, never carrying a Pre-image. */
  audit: {
    list: (input: AuditListInput) => Promise<AuditEntry[]>;
    /** Puts back what a Reversible entry changed; records no entry of its own. */
    undo: (input: { entryId: string }) => Promise<UndoResult>;
  };

  recent: {
    list: (input: { connectionId?: string; dbName?: string; collection?: string; kind?: RecentKind; limit?: number }) => Promise<RecentQuery[]>;
    get: (input: { id: string }) => Promise<RecentQuery>;
    /** `id` deletes one row; `dbName`/`kind` scope a clear; empty input clears all. */
    clear: (input: {
      id?: string;
      connectionId?: string;
      dbName?: string;
      collection?: string;
      kind?: RecentKind;
    }) => Promise<{ deleted: number }>;
    /** Past values typed into the builder for this `(conn, db, coll, field)`; fails open to `{ values: [] }`. */
    valuesForField: (input: {
      connectionId: string;
      dbName: string;
      collection: string;
      field: string;
      limit?: number;
    }) => Promise<{ values: Array<{ value: string; valType: ValType; frequency: number; lastUsedAt: string }> }>;
    /** Fire-and-forget after a successful find — records the values a run's builder conditions actually carried. */
    recordFieldValues: (input: {
      connectionId: string;
      dbName: string;
      collection: string;
      entries: Array<{ field: string; value: string; valType: ValType; op: string }>;
    }) => Promise<{ recorded: number }>;
    /** Settings' "Clear value history" — wipes every `recent_field_values` row. */
    clearFieldValues: () => Promise<{ deleted: number }>;
  };

  agg: {
    run: (input: AggInput) => Promise<AggResult>;
    previewUpToStage: (input: PreviewInput) => Promise<AggStagePreview>;
    cancel: (input: { token: string }) => Promise<void>;
    runAndSave: (input: AggRunAndSaveInput) => Promise<AggResult & AggSaveCounts>;
    explain: (input: AggExplainInput) => Promise<{ plan: unknown; verbosity: string; writeStageOmitted: boolean }>;
  };

  refs: {
    list: (input: { connectionId: string; dbName?: string; collection?: string }) => Promise<ReferenceRule[]>;
    get: (input: { id: string }) => Promise<ReferenceRule>;
    create: (input: ReferenceRuleCreateInput) => Promise<ReferenceRule>;
    update: (input: { id: string; patch: ReferenceRuleUpdateInput }) => Promise<ReferenceRule>;
    delete: (input: { id: string }) => Promise<void>;
    resolve: (input: ReferenceResolveInput) => Promise<ReferenceResolveResult>;
    autodetect: (input: ReferenceAutodetectInput) => Promise<ReferenceAutodetectCandidate[]>;
  };

  /** In-process Node REPL reusing the pool's already-open MongoClient — no external mongosh. */
  mshell: {
    start: (input: { connectionId: string; dbName?: string }) => Promise<ShellSessionInfo>;
    write: (input: { sessionId: string; data: string }) => Promise<void>;
    stop: (input: { sessionId: string }) => Promise<void>;
    list: () => Promise<ShellSessionInfo[]>;
    onOutput: (cb: (evt: ShellOutputEvent) => void) => () => void;
  };

  /** Multi-statement JS buffer, structured result — same execution model as `mshell`. */
  script: {
    run: (input: ScriptRunInput) => Promise<ScriptRunResultWire>;
    cancel: (input: { token: string }) => Promise<void>;
  };

  tabs: {
    list: () => Promise<WorkspaceTab[]>;
    openCollection: (input: {
      connectionId: string;
      dbName: string;
      collection: string;
      reuseExisting?: boolean;
      initialState?: Partial<CollectionTabState>;
    }) => Promise<CollectionTab>;
    openAggregation: (input: {
      connectionId: string;
      dbName: string;
      collection: string;
      savedId?: string;
      name?: string;
      initialState?: AggregationSeed;
    }) => Promise<CollectionTab>;
    openDefault: (input: {
      connectionId: string;
      dbName?: string;
      collection?: string;
    }) => Promise<CollectionTab>;
    openScript: (input: {
      connectionId: string;
      initialState?: Partial<ScriptTabState>;
    }) => Promise<ScriptTab>;
    update: (
      id: string,
      patch: { state: Partial<CollectionTabState> | Partial<ScriptTabState> },
    ) => Promise<WorkspaceTab>;
    close: (id: string) => Promise<{ newActiveId: string | null }>;
    setActive: (id: string) => Promise<{ id: string }>;
    reorder: (orderedIds: string[]) => Promise<{ ok: true }>;
    setPinned: (input: { id: string; pinned: boolean }) => Promise<WorkspaceTab>;
    /** Re-points a matching open tab at a collection's new name after `collection:rename`. */
    collectionRenamed: (input: {
      connectionId: string;
      dbName: string;
      oldCollection: string;
      newCollection: string;
    }) => Promise<{ retargeted: boolean; closed: boolean }>;
  };
}

// Channel name registry.
export const IPC_CHANNELS = {
  // Connection CRUD -----------------------------------------
  connList:      'conn:list',
  connGet:       'conn:get',
  connGetUri:    'conn:getUri',
  connCreate:    'conn:create',    // SECRET_INPUT
  connUpdate:    'conn:update',    // SECRET_INPUT
  connDelete:    'conn:delete',
  connTouchUsed: 'conn:touchUsed',
  connParseUri:  'conn:parseUri',  // SECRET_INPUT
  connTest:      'conn:test',      // SECRET_INPUT
  connExport:        'conn:export',        // SECRET_INPUT
  connImportOpen:     'conn:importOpen',
  connImportMap:      'conn:importMap',
  connImportUris:     'conn:importUris',     // SECRET_INPUT
  connImportCommit:   'conn:importCommit',   // SECRET_INPUT

  // App-level utilities -----------------------------------------
  appMenuCommandEvent: 'app:menu-command-event',
  appPickFile:     'app:pickFile',
  appOpenExternal: 'app:openExternal',
  appSaveFile:     'app:saveFile',
  appDiagnosticBundle: 'app:diagnosticBundle',
  appSetUnsavedWork: 'app:setUnsavedWork',

  // Auto-update -----------------------------------------
  updatesGetState:   'updates:getState',
  updatesRestart:    'updates:restart',
  updatesStateEvent: 'updates:state-event',

  // Docs-restricted external opener -----------------------------------------
  shellOpenExternal: 'shell:openExternal',

  // Mongo lifecycle -----------------------------------------
  mongoConnect:     'mongo:connect',
  mongoDisconnect:  'mongo:disconnect',
  mongoStatus:      'mongo:status',
  mongoPing:        'mongo:ping',
  mongoServerInfo:  'mongo:serverInfo',
  mongoStatusEvent: 'mongo:status-event',

  // Meta -----------------------------------------
  metaListDatabases:   'meta:listDatabases',
  metaListCollections: 'meta:listCollections',
  metaSampleSchema:    'meta:sampleSchema',
  metaCollectionDetails: 'meta:collectionDetails',

  // Indexes -----------------------------------------
  indexList:   'index:list',
  indexCreate: 'index:create',
  indexDrop:   'index:drop',

  // Collection / database admin -----------------------------
  collectionCreate: 'collection:create',
  collectionDrop:   'collection:drop',
  collectionRename: 'collection:rename',
  collectionModify: 'collection:modify',
  databaseDrop:     'database:drop',

  // Users -----------------------------------------
  userList:   'user:list',
  userGet:    'user:get',
  userCreate: 'user:create', // SECRET_INPUT
  userUpdate: 'user:update', // SECRET_INPUT
  userDrop:   'user:drop',
  roleList:   'role:list',
  roleCreate: 'role:create',
  roleUpdate: 'role:update',
  roleDrop:   'role:drop',

  // Monitor (C06 §9) -------------------------------------
  adminCurrentOp:       'admin:currentOp',
  adminKillOp:          'admin:killOp',
  adminProfileStatus:   'admin:profileStatus',
  adminSetProfileLevel: 'admin:setProfileLevel',
  adminProfileTail:     'admin:profileTail',

  // App state preferences ----------------------------------------
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
  prefsGetTheme:  'prefs:getTheme',
  prefsSetTheme:  'prefs:setTheme',
  prefsThemeEvent: 'prefs:theme-event',

  // Secrets settings (main-confirmed) -----------------------------
  secretsSetPlaintextFallback: 'secrets:set-plaintext-fallback',

  // Query runner -----------------------------------------
  queryFind:             'query:find',
  queryCount:            'query:count',
  queryFindOne:          'query:findOne',
  queryExplain:          'query:explain',
  queryCancel:           'query:cancel',
  queryExport:           'query:export',

  // Document write ops -----------------------------------------
  docInsert:             'doc:insert',
  docInsertMany:         'doc:insertMany',
  docUpdateOne:          'doc:updateOne',
  docDeleteOne:          'doc:deleteOne',
  docConfirmDeleteMany:  'doc:confirmDeleteMany',
  docDeleteMany:         'doc:deleteMany',
  docConfirmUpdateMany:  'doc:confirmUpdateMany',
  docUpdateMany:         'doc:updateMany',

  // Saved queries -----------------------------------------
  savedList:      'saved:list',
  savedGet:       'saved:get',
  savedCreate:    'saved:create',
  savedUpdate:    'saved:update',
  savedDelete:    'saved:delete',
  savedDuplicate: 'saved:duplicate',

  // Recent queries -----------------------------------------
  recentList:  'recent:list',
  recentGet:   'recent:get',
  recentClear: 'recent:clear',
  recentValuesForField:   'recent:valuesForField',
  recentRecordFieldValues: 'recent:recordFieldValues',
  recentClearFieldValues:  'recent:clearFieldValues',

  // Bulk data -----------------------------------------
  dataImport: 'data:import',
  dataPreviewCsv: 'data:previewCsv',
  dataCancelImport: 'data:cancelImport',
  dataImportProgressEvent: 'data:import-progress-event',

  // Audit log -----------------------------------------
  auditList: 'audit:list',
  auditUndo: 'audit:undo',

  // Aggregation runner -----------------------------------------
  aggRun:             'agg:run',
  aggPreviewUpToStage: 'agg:previewUpToStage',
  aggCancel:          'agg:cancel',
  aggRunAndSave:      'agg:runAndSave',
  aggExplain:         'agg:explain',

  // Document references -----------------------------------------
  refsList:       'refs:list',
  refsGet:        'refs:get',
  refsCreate:     'refs:create',
  refsUpdate:     'refs:update',
  refsDelete:     'refs:delete',
  refsResolve:    'refs:resolve',
  refsAutodetect: 'refs:autodetect',

  // Mongo shell pane -----------------------------------------
  mshellStart:       'mshell:start',
  mshellWrite:       'mshell:write',
  mshellStop:        'mshell:stop',
  mshellList:        'mshell:list',
  mshellOutputEvent: 'mshell:output-event',

  // Script editor -----------------------------------------
  scriptRun:    'script:run',
  scriptCancel: 'script:cancel',

  // Workspace tabs -----------------------------------------
  tabsList:            'tabs:list',
  tabsOpenCollection:  'tabs:openCollection',
  tabsOpenAggregation: 'tabs:openAggregation',
  tabsOpenDefault:     'tabs:openDefault',
  tabsOpenScript:      'tabs:openScript',
  tabsUpdate:          'tabs:update',
  tabsClose:           'tabs:close',
  tabsSetActive:       'tabs:setActive',
  tabsReorder:         'tabs:reorder',
  tabsSetPinned:       'tabs:setPinned',
  tabsCollectionRenamed: 'tabs:collectionRenamed',
} as const;

/** Allowed purposes for app:pickFile — restricts the file dialog filter. */
export type PickFilePurpose = 'tls-ca' | 'tls-client-cert' | 'ssh-key' | 'data-import';

/** Who reports unsaved work for the quit question: the connection form, or the workspace's dirty pipelines. */
export type UnsavedWorkSource = 'connectionForm' | 'pipelines';
