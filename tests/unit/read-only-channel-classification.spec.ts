import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

/**
 * Fail-open safety net for the read-only-connection guard (ADR 0005).
 *
 * Buckets A/B are enforced by each write-service method asking `MongoPool`
 * for a write grant (X18 §4) — nothing forces a *new*
 * write channel to ask for one. This test doesn't verify the guard fires (the
 * integration specs
 * for each service do that); it only forces every channel to be classified,
 * so adding a channel without deciding whether it writes MongoDB breaks CI
 * instead of silently shipping unguarded.
 *
 * - WRITE: mutates MongoDB, or is the session-start channel that must refuse
 *   outright on a read-only connection (mshellStart) — see Buckets A/B/C.
 * - READ: touches MongoDB but never mutates it.
 * - NON_MONGO: app-local state (SQLite, OS dialogs, prefs, workspace tabs) —
 *   never reaches a MongoDB driver call at all.
 */

const WRITE_CHANNELS = new Set<string>([
  IPC_CHANNELS.docInsert,
  IPC_CHANNELS.docInsertMany,
  IPC_CHANNELS.docUpdateOne,
  IPC_CHANNELS.docDeleteOne,
  IPC_CHANNELS.docDeleteMany,
  IPC_CHANNELS.docUpdateMany,
  IPC_CHANNELS.collectionCreate,
  IPC_CHANNELS.collectionDrop,
  IPC_CHANNELS.collectionRename,
  IPC_CHANNELS.collectionModify,
  IPC_CHANNELS.databaseDrop,
  IPC_CHANNELS.indexCreate,
  IPC_CHANNELS.indexDrop,
  IPC_CHANNELS.userCreate,
  IPC_CHANNELS.userUpdate,
  IPC_CHANNELS.userDrop,
  IPC_CHANNELS.aggRun,
  IPC_CHANNELS.aggRunAndSave,
  IPC_CHANNELS.mshellStart,
  IPC_CHANNELS.mshellWrite,
  IPC_CHANNELS.scriptRun,
  IPC_CHANNELS.auditUndo,
  IPC_CHANNELS.dataImport,
]);

const READ_CHANNELS = new Set<string>([
  IPC_CHANNELS.connTest,
  IPC_CHANNELS.mongoConnect,
  IPC_CHANNELS.mongoDisconnect,
  IPC_CHANNELS.mongoStatus,
  IPC_CHANNELS.mongoPing,
  IPC_CHANNELS.mongoServerInfo,
  IPC_CHANNELS.mongoStatusEvent,
  IPC_CHANNELS.metaListDatabases,
  IPC_CHANNELS.metaListCollections,
  IPC_CHANNELS.metaSampleSchema,
  IPC_CHANNELS.metaCollectionDetails,
  IPC_CHANNELS.indexList,
  IPC_CHANNELS.userList,
  IPC_CHANNELS.userGet,
  IPC_CHANNELS.roleList,
  IPC_CHANNELS.queryFind,
  IPC_CHANNELS.queryCount,
  IPC_CHANNELS.queryFindOne,
  IPC_CHANNELS.queryExplain,
  IPC_CHANNELS.queryCancel,
  IPC_CHANNELS.queryExport,
  IPC_CHANNELS.docConfirmDeleteMany,
  IPC_CHANNELS.docConfirmUpdateMany,
  IPC_CHANNELS.aggPreviewUpToStage,
  IPC_CHANNELS.aggExplain,
  IPC_CHANNELS.refsResolve,
  IPC_CHANNELS.refsAutodetect,
]);

const NON_MONGO_CHANNELS = new Set<string>([
  IPC_CHANNELS.connList,
  IPC_CHANNELS.connGet,
  // Builds a URI from the saved row; never reaches a MongoDB deployment.
  IPC_CHANNELS.connGetUri,
  IPC_CHANNELS.connCreate,
  // Connection Export touches SQLite and files only, never a MongoDB deployment.
  IPC_CHANNELS.connExport,
  // The Import Wizard (C14) reads a picked file and writes SQLite and the vault only.
  IPC_CHANNELS.connImportOpen,
  IPC_CHANNELS.connImportMap,
  IPC_CHANNELS.connImportUris,
  IPC_CHANNELS.connImportCommit,
  IPC_CHANNELS.connUpdate,
  IPC_CHANNELS.connDelete,
  IPC_CHANNELS.connTouchUsed,
  IPC_CHANNELS.connParseUri,
  IPC_CHANNELS.appPickFile,
  IPC_CHANNELS.appOpenExternal,
  IPC_CHANNELS.appSaveFile,
  IPC_CHANNELS.appDiagnosticBundle,
  IPC_CHANNELS.shellOpenExternal,
  IPC_CHANNELS.prefsGet,
  IPC_CHANNELS.prefsSet,
  IPC_CHANNELS.prefsGetTheme,
  IPC_CHANNELS.prefsSetTheme,
  IPC_CHANNELS.prefsThemeEvent,
  IPC_CHANNELS.appMenuCommandEvent,
  IPC_CHANNELS.updatesGetState,
  IPC_CHANNELS.updatesRestart,
  IPC_CHANNELS.updatesStateEvent,
  IPC_CHANNELS.secretsSetPlaintextFallback,
  IPC_CHANNELS.savedList,
  IPC_CHANNELS.savedGet,
  IPC_CHANNELS.savedCreate,
  IPC_CHANNELS.savedUpdate,
  IPC_CHANNELS.savedDelete,
  IPC_CHANNELS.savedDuplicate,
  IPC_CHANNELS.recentList,
  IPC_CHANNELS.recentGet,
  IPC_CHANNELS.recentClear,
  IPC_CHANNELS.recentValuesForField,
  IPC_CHANNELS.recentRecordFieldValues,
  IPC_CHANNELS.recentClearFieldValues,
  IPC_CHANNELS.auditList,
  IPC_CHANNELS.aggCancel,
  IPC_CHANNELS.dataPreviewCsv,
  IPC_CHANNELS.dataCancelImport,
  IPC_CHANNELS.dataImportProgressEvent,
  IPC_CHANNELS.refsList,
  IPC_CHANNELS.refsGet,
  IPC_CHANNELS.refsCreate,
  IPC_CHANNELS.refsUpdate,
  IPC_CHANNELS.refsDelete,
  IPC_CHANNELS.mshellStop,
  IPC_CHANNELS.mshellList,
  IPC_CHANNELS.mshellOutputEvent,
  IPC_CHANNELS.scriptCancel,
  IPC_CHANNELS.tabsList,
  IPC_CHANNELS.tabsOpenCollection,
  IPC_CHANNELS.tabsOpenAggregation,
  IPC_CHANNELS.tabsOpenDefault,
  IPC_CHANNELS.tabsOpenScript,
  IPC_CHANNELS.tabsUpdate,
  IPC_CHANNELS.tabsClose,
  IPC_CHANNELS.tabsSetActive,
  IPC_CHANNELS.tabsReorder,
  IPC_CHANNELS.tabsSetPinned,
  IPC_CHANNELS.tabsCollectionRenamed,
]);

describe('read-only guard — IPC channel classification is exhaustive', () => {
  it('classifies every channel into exactly one of write / read / non-mongo', () => {
    const allChannels = Object.values(IPC_CHANNELS);
    const classified = new Map<string, string[]>();
    for (const ch of allChannels) classified.set(ch, []);

    for (const ch of WRITE_CHANNELS) classified.get(ch)?.push('write');
    for (const ch of READ_CHANNELS) classified.get(ch)?.push('read');
    for (const ch of NON_MONGO_CHANNELS) classified.get(ch)?.push('non-mongo');

    const unclassified = allChannels.filter((ch) => (classified.get(ch)?.length ?? 0) === 0);
    const doubleClassified = allChannels.filter((ch) => (classified.get(ch)?.length ?? 0) > 1);

    expect(unclassified, 'new channel added without a read/write/non-mongo classification').toEqual([]);
    expect(doubleClassified, 'channel classified in more than one bucket').toEqual([]);
  });

  it('every write channel name actually looks write-shaped', () => {
    const writeVerb = /insert|update|replace|delete|drop|create|rename|modify|runAndSave|write|import/i;
    // These don't carry a write verb in their name because they're not
    // unconditional writes: agg:run is conditional on pipeline content
    // (guarded inline via isWriteStage), and mshell:start/script:run are the
    // session-start channels for panes that hand sandboxed code a raw driver
    // handle (guarded via wholesale refusal / dbProxy allowlist — ADR 0005).
    // Any OTHER non-verb-named addition here is exactly the silent-drift case
    // this test exists to catch — don't add to this list without a reason.
    // audit:undo writes whatever puts an Operation back (an insert or a
    // replace), and takes its grant from MongoPool.write like any write.
    const namedExemptions = new Set<string>([
      IPC_CHANNELS.aggRun,
      IPC_CHANNELS.mshellStart,
      IPC_CHANNELS.scriptRun,
      IPC_CHANNELS.auditUndo,
    ]);
    const nonVerbLike = [...WRITE_CHANNELS].filter(
      (ch) => !writeVerb.test(ch) && !namedExemptions.has(ch),
    );
    expect(nonVerbLike, 'a channel classified write but with no write-shaped verb — double check it').toEqual([]);
  });
});
