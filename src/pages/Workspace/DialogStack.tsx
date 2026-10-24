import React from 'react';
import { Button, Modal } from '@mantine/core';
import { api, isIpcError } from '../../api/atelier';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { themeVars } from '../../theme/themeVars';
import { ownGet } from '../../utils/ownProperty';
import type { CollectionView, CollectionTab, ConnectionSummary } from '@shared/types';
import { ReferenceHoverPopover } from '../../features/references/ReferenceHoverPopover';
import { ReferenceRulesEditor } from '../../features/references/ReferenceRulesEditor';
import type { UseReferenceRulesResult } from '../../features/references/useReferenceRules';
import { ConnectionFormModal } from '../../features/connections/ConnectionFormModal';
import { ConnectionDeleteDialog } from '../../features/connections/ConnectionDeleteDialog';
import { ConnectionDisconnectDialog } from '../../features/connections/ConnectionDisconnectDialog';
import { ConnectionExpandedTable } from '../../features/connections/ConnectionExpandedTable';
import { FeatureHint } from '../../hints/FeatureHint';
import type { UseFeatureHintResult } from '../../hints/useFeatureHint';
import { SaveModal } from './SaveModal';
import { DocumentEditor } from './DocumentEditor';
import { DeleteConfirm } from './DeleteConfirm';
import { UpdateConfirm } from './UpdateConfirm';
import { resolveDeleteDialog } from './deleteMode';
import { currentFilterJson } from './builder';
import type { ReferenceDrawerState } from './useReferenceDrawer';
import { targetOf, type useDocumentDialogs } from './useDocumentDialogs';
import type { useConnectionDialogs } from './useConnectionDialogs';

interface NewTabPickerProps {
  connectionId: string | null;
  onCancel: () => void;
  onPick: (input: {
    connectionId: string;
    dbName: string;
    collection: string;
    initialView: CollectionView;
  }) => void;
}

export function NewTabPicker({ connectionId, onCancel, onPick }: NewTabPickerProps) {
  const T = themeVars;
  const close = useDialogFocusReturn(onCancel);
  const [dbs, setDbs] = React.useState<string[] | null>(null);
  const [collsByDb, setCollsByDb] = React.useState<Record<string, string[]>>({});
  const [selectedDb, setSelectedDb] = React.useState<string>('');
  const [selectedColl, setSelectedColl] = React.useState<string>('');
  const [initialView, setInitialView] = React.useState<CollectionView>('documents');
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!connectionId) return;
    let active = true;
    void (async () => {
      try {
        const rows = await api.meta.listDatabases({ connectionId });
        if (!active) return;
        const names = rows.map((r) => r.name);
        setDbs(names);
        if (names[0]) setSelectedDb(names[0]);
      } catch (e) {
        if (!active) return;
        setErr(isIpcError(e) ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId]);

  React.useEffect(() => {
    if (!connectionId || !selectedDb) return;
    if (ownGet(collsByDb, selectedDb)) return;
    let active = true;
    void (async () => {
      try {
        const rows = await api.meta.listCollections({ connectionId, dbName: selectedDb });
        if (!active) return;
        const names = rows.map((r) => r.name);
        setCollsByDb((c) => ({ ...c, [selectedDb]: names }));
        if (names[0]) setSelectedColl(names[0]);
      } catch (e) {
        if (!active) return;
        setErr(isIpcError(e) ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, selectedDb, collsByDb]);

  const canOpen = !!connectionId && !!selectedDb && !!selectedColl;

  const submit = () => {
    if (!canOpen) return;
    onPick({
      connectionId,
      dbName: selectedDb,
      collection: selectedColl,
      initialView,
    });
  };

  return (
    <Modal
      opened
      onClose={close}
      title="Open collection"
      size={440}
      centered
    >
      <div>
        {err && (
          <div
            role="alert"
            style={{ color: T.warn, fontSize: 12, marginBottom: 12 }}
          >
            {err}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 11, color: T.textMuted }}>
            Database
            <select
              aria-label="Database"
              value={selectedDb}
              onChange={(e) => {
                const next = e.target.value;
                setSelectedDb(next);
                // Seed from cache: the fetch effect early-returns on an already-cached db, so A→B→A must not blank the selection.
                setSelectedColl(ownGet(collsByDb, next)?.[0] ?? '');
              }}
              style={{
                width: '100%',
                marginTop: 4,
                padding: '6px 10px',
                border: `1px solid ${T.border}`,
                borderRadius: T.rs,
                background: T.surfaceRaised,
                color: T.text,
                fontSize: 12,
              }}
            >
              {!dbs && <option value="">Loading…</option>}
              {dbs?.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, color: T.textMuted }}>
            Collection
            <select
              aria-label="Collection"
              value={selectedColl}
              onChange={(e) => setSelectedColl(e.target.value)}
              style={{
                width: '100%',
                marginTop: 4,
                padding: '6px 10px',
                border: `1px solid ${T.border}`,
                borderRadius: T.rs,
                background: T.surfaceRaised,
                color: T.text,
                fontSize: 12,
              }}
            >
              {!ownGet(collsByDb, selectedDb) && <option value="">Loading…</option>}
              {ownGet(collsByDb, selectedDb)?.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, color: T.textMuted }}>
            Open as
            <select
              aria-label="Initial view"
              value={initialView}
              onChange={(e) => setInitialView(e.target.value as CollectionView)}
              style={{
                width: '100%',
                marginTop: 4,
                padding: '6px 10px',
                border: `1px solid ${T.border}`,
                borderRadius: T.rs,
                background: T.surfaceRaised,
                color: T.text,
                fontSize: 12,
              }}
            >
              <option value="documents">Documents</option>
              <option value="aggregation">Aggregation</option>
              <option value="structure">Structure</option>
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <Button size="compact-xs" variant="subtle" onClick={close}>
            Cancel
          </Button>
          <Button size="compact-xs" variant="filled" onClick={submit} disabled={!canOpen}>
            Open
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface DialogStackProps {
  newTabOpen: boolean;
  setNewTabOpen: (open: boolean) => void;
  scratchConnectionId: string | null;
  onPickNewTab: (input: {
    connectionId: string;
    dbName: string;
    collection: string;
    initialView: CollectionView;
  }) => void;
  documentDialogs: ReturnType<typeof useDocumentDialogs>;
  connectionDialogs: ReturnType<typeof useConnectionDialogs>;
  connections: ConnectionSummary[];
  activeCollection: CollectionTab | null;
  focusedConnectionReadOnly: boolean;
  referenceRules: UseReferenceRulesResult;
  refDrawer: Pick<
    ReferenceDrawerState,
    'refHover' | 'refEditorOpen' | 'setRefEditorOpen'
  >;
  queryBarSaveOpen: boolean;
  setQueryBarSaveOpen: (open: boolean) => void;
  setSavedRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  expandBuilder: () => void;
  patchActiveCollection: (patch: Record<string, unknown>) => void;
  refsConfigureHint: UseFeatureHintResult;
  tabsPinHint: UseFeatureHintResult;
  savedCreateHint: UseFeatureHintResult;
  runExecuteHint: UseFeatureHintResult;
}

export function DialogStack({
  newTabOpen,
  setNewTabOpen,
  scratchConnectionId,
  onPickNewTab,
  documentDialogs,
  connectionDialogs,
  connections,
  activeCollection,
  focusedConnectionReadOnly,
  referenceRules,
  refDrawer,
  queryBarSaveOpen,
  setQueryBarSaveOpen,
  setSavedRefreshKey,
  expandBuilder,
  patchActiveCollection,
  refsConfigureHint,
  tabsPinHint,
  savedCreateHint,
  runExecuteHint,
}: DialogStackProps) {
  const { refHover, refEditorOpen, setRefEditorOpen } = refDrawer;
  const {
    editing,
    deleteDoc,
    deleteAllOpen,
    updateAllOpen,
    deleteSelected,
    inserting,
    closeInsertDrawer,
    handleInserted,
    handlePartialInsert,
    closeEditor,
    handleDocSaved,
    closeDeleteDialogs,
    handleDeleted,
    closeUpdateAllModal,
    handleUpdatedAll,
  } = documentDialogs;
  const {
    connectionFormTarget,
    deleteConnectionTarget,
    disconnectTarget,
    disconnectReturnFocus,
    connectionTable,
    tableReturnFocus,
    closeDisconnectConnectionModal,
    confirmDisconnectConnection,
    closeConnectionFormModal,
    closeDeleteConnectionModal,
    closeConnectionTable,
    connectFromExpandedTable,
    manageFromExpandedTable,
    editFromExpandedTable,
    deleteFromExpandedTable,
    addFromExpandedTable,
    importFromExpandedTable,
    tabCountFor,
    deleteConnections,
    confirmDeleteConnection,
    handleConnectionSaved,
  } = connectionDialogs;

  return (
    <>
      {newTabOpen && (
        <NewTabPicker
          connectionId={scratchConnectionId}
          onCancel={() => setNewTabOpen(false)}
          onPick={(input) => void onPickNewTab(input)}
        />
      )}

      {refHover && (
        <ReferenceHoverPopover
          rule={refHover.rule}
          anchorRect={refHover.anchorRect}
          result={refHover.result}
          loading={refHover.loading}
          error={refHover.error}
        />
      )}

      {refEditorOpen && activeCollection && (
        <ReferenceRulesEditor
          connectionId={activeCollection.connectionId}
          dbName={activeCollection.dbName}
          collection={activeCollection.collection}
          sampleDocs={activeCollection.state.lastRun?.documents}
          onClose={() => setRefEditorOpen(false)}
          onChanged={() => void referenceRules.reload()}
        />
      )}

      {queryBarSaveOpen && activeCollection && (
        <SaveModal
          connectionId={activeCollection.connectionId}
          dbName={activeCollection.dbName}
          collection={activeCollection.collection}
          builderState={activeCollection.state.builder}
          queryRaw={activeCollection.state.queryRaw}
          onClose={() => setQueryBarSaveOpen(false)}
          onSaved={() => {
            setSavedRefreshKey((k) => k + 1);
            setQueryBarSaveOpen(false);
            expandBuilder();
            patchActiveCollection({ activeBuilderTab: 'Saved' });
          }}
        />
      )}

      {inserting && (
        <DocumentEditor
          mode="insert"
          collection={inserting.target.collection}
          connectionId={inserting.target.connectionId}
          dbName={inserting.target.dbName}
          initialDocJson={inserting.duplicateDocJson ?? undefined}
          onClose={closeInsertDrawer}
          onInserted={handleInserted}
          onPartialInsert={handlePartialInsert}
        />
      )}

      {editing && (
        <DocumentEditor
          mode="edit"
          connectionId={editing.target.connectionId}
          dbName={editing.target.dbName}
          collection={editing.target.collection}
          doc={editing.doc}
          focusPath={editing.focusPath}
          onClose={closeEditor}
          onSaved={handleDocSaved}
        />
      )}

      {updateAllOpen && activeCollection && (() => {
        const filterJson = currentFilterJson(activeCollection.state);
        // Same defensive stance as delete-all: openUpdateAllModal already
        // refused to open without a runnable filter, but the filter is read
        // live from the Focused Tab, which can change out from under an open
        // dialog (builder edit, tab restore) — never fall through to `{}`.
        if (filterJson === null) return null;
        // The write's own collection: the dialog's props and this target come
        // from the same tab, and the callback keeps it if focus moves before
        // the request lands.
        const target = targetOf(activeCollection);
        return (
          <UpdateConfirm
            connectionId={activeCollection.connectionId}
            dbName={activeCollection.dbName}
            collection={activeCollection.collection}
            readOnly={focusedConnectionReadOnly}
            filter={filterJson}
            collation={activeCollection.state.builder.collation}
            hint={activeCollection.state.builder.hint}
            onClose={closeUpdateAllModal}
            onUpdated={(auditId, message) => handleUpdatedAll(auditId, message, target)}
          />
        );
      })()}

      {(() => {
        if (!activeCollection) return null;
        const deleteAllFilterJson = deleteAllOpen ? currentFilterJson(activeCollection.state) : null;
        const dialog = resolveDeleteDialog({ deleteDoc, deleteSelected, deleteAllFilterJson });
        if (!dialog.open) return null;
        const byTabFilter = deleteAllFilterJson !== null && dialog.filter === deleteAllFilterJson;
        // The write's own collection — see UpdateConfirm above.
        const target = targetOf(activeCollection);
        return (
          <DeleteConfirm
            connectionId={activeCollection.connectionId}
            dbName={activeCollection.dbName}
            collection={activeCollection.collection}
            readOnly={focusedConnectionReadOnly}
            docs={dialog.docs}
            filter={dialog.filter}
            // Only when the dialog deletes by the tab's own filter. A
            // selection deletes the selected documents by `_id`, the same set
            // with or without the collation or hint, and DeleteConfirm refuses
            // any multi delete given one. Keyed on the filter the dialog was
            // handed, not on which menu opened it.
            collation={byTabFilter ? activeCollection.state.builder.collation : undefined}
            hint={byTabFilter ? activeCollection.state.builder.hint : undefined}
            onClose={closeDeleteDialogs}
            onDeleted={(auditId, message) => handleDeleted(auditId, message, target)}
          />
        );
      })()}

      <FeatureHint
        id="run.execute"
        visible={runExecuteHint.visible}
        onDismiss={runExecuteHint.dismiss}
      />
      <FeatureHint
        id="refs.configure"
        visible={refsConfigureHint.visible}
        onDismiss={refsConfigureHint.dismiss}
        onCta={() => setRefEditorOpen(true)}
      />
      <FeatureHint
        id="tabs.pin"
        visible={tabsPinHint.visible}
        onDismiss={tabsPinHint.dismiss}
      />
      <FeatureHint
        id="saved.create"
        visible={savedCreateHint.visible}
        onDismiss={savedCreateHint.dismiss}
      />

      {connectionFormTarget !== null && (
        <ConnectionFormModal
          key={connectionFormTarget === 'new' ? 'new' : connectionFormTarget.id}
          connectionId={connectionFormTarget === 'new' ? undefined : connectionFormTarget.id}
          onSaved={handleConnectionSaved}
          onClose={closeConnectionFormModal}
          returnFocusTo={tableReturnFocus}
          initialFocus={connectionFormTarget === 'new' ? undefined : connectionFormTarget.focus}
        />
      )}

      {deleteConnectionTarget && (
        <ConnectionDeleteDialog
          name={deleteConnectionTarget.name}
          tabCount={deleteConnectionTarget.tabCount}
          onCancel={closeDeleteConnectionModal}
          onConfirm={() => void confirmDeleteConnection()}
          returnFocusTo={tableReturnFocus}
        />
      )}

      {disconnectTarget && (
        <ConnectionDisconnectDialog
          name={disconnectTarget.name}
          tabCount={disconnectTarget.tabCount}
          onCancel={closeDisconnectConnectionModal}
          onConfirm={confirmDisconnectConnection}
          returnFocusTo={disconnectReturnFocus}
        />
      )}

      {connectionTable && (
        <ConnectionExpandedTable
          connections={connections}
          initialQuery={connectionTable.query}
          returnFocusTo={connectionTable.trigger}
          onClose={closeConnectionTable}
          onConnect={connectFromExpandedTable}
          onManage={manageFromExpandedTable}
          onAdd={addFromExpandedTable}
          onImport={importFromExpandedTable}
          tabCountFor={tabCountFor}
          onDeleteMany={deleteConnections}
          onEdit={editFromExpandedTable}
          onDelete={deleteFromExpandedTable}
        />
      )}
    </>
  );
}
