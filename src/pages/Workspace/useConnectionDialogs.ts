import React from 'react';
import { api, isIpcError } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { disconnectConnection as disconnectWithNotify } from '../../features/connections/disconnectConnection';
import { invalidateSampleSchemaCache } from '../../features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../../features/fieldSuggestions/sources/schemaEnumSource';
import { useConnectionTransfer } from '../../features/connections/ConnectionTransferProvider';
import type { ConnectionSummary } from '@shared/types';
import type { WorkspaceTabsState } from '../../state/workspaceTabs';

export function useConnectionDialogs(deps: {
  connections: ConnectionSummary[];
  tabsRef: React.RefObject<WorkspaceTabsState>;
  closeTabsForConnection: (id: string, errorTitle: string) => Promise<void>;
  refreshConnections: () => Promise<void>;
  removeConnectionLocal: (id: string) => void;
  openConnection: (id: string) => void;
  openConnectionScreen: (id: string) => void;
}): {
  connectionFormTarget: 'new' | { id: string; focus?: 'password' } | null;
  deleteConnectionTarget: { id: string; name: string; tabCount: number } | null;
  disconnectTarget: { id: string; name: string; tabCount: number } | null;
  disconnectReturnFocus: HTMLElement | null;
  connectionTable: { query: string; trigger: HTMLElement | null } | null;
  tableReturnFocus: HTMLElement | null;
  requestDisconnect: (id: string, returnFocusTo?: HTMLElement | null) => void;
  closeDisconnectConnectionModal: () => void;
  confirmDisconnectConnection: () => void;
  openAddConnectionModal: () => void;
  openEditConnectionModal: (
    id: string,
    returnFocusTo?: HTMLElement | null,
    opts?: { focus?: 'password' },
  ) => void;
  closeConnectionFormModal: () => void;
  openDeleteConnectionModal: (id: string) => void;
  closeDeleteConnectionModal: () => void;
  openConnectionTable: (query: string, trigger: HTMLElement | null) => void;
  closeConnectionTable: () => void;
  connectFromExpandedTable: (id: string) => void;
  manageFromExpandedTable: (id: string) => void;
  editFromExpandedTable: (id: string) => void;
  deleteFromExpandedTable: (id: string) => void;
  addFromExpandedTable: () => void;
  importFromExpandedTable: () => void;
  /** Open tabs across these Connections; `null` while tabs are still loading. */
  tabCountFor: (ids: string[]) => number | null;
  /** Deletes each in turn, the same way as one; resolves once all are done. */
  deleteConnections: (ids: string[]) => Promise<void>;
  confirmDeleteConnection: () => Promise<void>;
  handleConnectionSaved: (id: string) => Promise<void>;
} {
  const {
    connections,
    tabsRef,
    closeTabsForConnection,
    refreshConnections,
    removeConnectionLocal,
    openConnection,
    openConnectionScreen,
  } = deps;

  const [connectionFormTarget, setConnectionFormTarget] = React.useState<
    'new' | { id: string; focus?: 'password' } | null
  >(null);
  // Snapshots {id, name, tabCount} at open time so the dialog's copy stays
  // stable even if connections/tabs change while it's open.
  const [deleteConnectionTarget, setDeleteConnectionTarget] = React.useState<
    { id: string; name: string; tabCount: number } | null
  >(null);
  const [disconnectTarget, setDisconnectTarget] = React.useState<
    { id: string; name: string; tabCount: number } | null
  >(null);
  // Dedicated field (not `tableReturnFocus`) so the navigator context menu's
  // return-focus target can't leak into the expanded table's dialogs.
  const [disconnectReturnFocus, setDisconnectReturnFocus] = React.useState<HTMLElement | null>(
    null,
  );
  const [connectionTable, setConnectionTable] = React.useState<{
    query: string;
    trigger: HTMLElement | null;
  } | null>(null);

  // State, not a ref: read during render to build dialog props.
  const [tableReturnFocus, setTableReturnFocus] = React.useState<HTMLElement | null>(null);

  const requestDisconnect = React.useCallback(
    (id: string, returnFocusTo?: HTMLElement | null) => {
      const conn = connections.find((c) => c.id === id);
      if (!conn) return;
      if (conn.status === 'connecting') {
        void disconnectWithNotify(id);
        return;
      }
      // tabsRef loads over IPC one microtask after mount; refuse rather than
      // read an empty list as "no tabs" during that window.
      if (tabsRef.current.loading) return;
      const tabCount = tabsRef.current.tabs.filter((t) => t.connectionId === id).length;
      setDisconnectTarget({ id: conn.id, name: conn.name, tabCount });
      if (returnFocusTo) setDisconnectReturnFocus(returnFocusTo);
    },
    [connections, tabsRef],
  );
  const closeDisconnectConnectionModal = React.useCallback(() => {
    setDisconnectTarget(null);
    setDisconnectReturnFocus(null);
  }, []);

  const confirmDisconnectConnection = React.useCallback(() => {
    if (!disconnectTarget) return;
    const { id } = disconnectTarget;
    setDisconnectTarget(null);
    void disconnectWithNotify(id);
    void closeTabsForConnection(id, 'Disconnected, but its tabs could not be closed');
  }, [disconnectTarget, closeTabsForConnection]);

  const openAddConnectionModal = React.useCallback(() => setConnectionFormTarget('new'), []);
  const openEditConnectionModal = React.useCallback(
    (id: string, returnFocusTo?: HTMLElement | null, opts?: { focus?: 'password' }) => {
      if (returnFocusTo) setTableReturnFocus(returnFocusTo);
      setConnectionFormTarget({ id, focus: opts?.focus });
    },
    [],
  );
  const closeConnectionFormModal = React.useCallback(() => {
    setConnectionFormTarget(null);
    setTableReturnFocus(null);
  }, []);

  const openDeleteConnectionModal = React.useCallback(
    (id: string) => {
      const conn = connections.find((c) => c.id === id);
      if (!conn) return;
      if (tabsRef.current.loading) return;
      const tabCount = tabsRef.current.tabs.filter((t) => t.connectionId === id).length;
      setDeleteConnectionTarget({ id: conn.id, name: conn.name, tabCount });
    },
    [connections, tabsRef],
  );
  const closeDeleteConnectionModal = React.useCallback(() => {
    setDeleteConnectionTarget(null);
    setTableReturnFocus(null);
  }, []);

  const openConnectionTable = React.useCallback(
    (query: string, trigger: HTMLElement | null) => setConnectionTable({ query, trigger }),
    [],
  );
  const closeConnectionTable = React.useCallback(() => setConnectionTable(null), []);

  // Every expanded-table action closes the table first, then routes through
  // the same handler the Switcher popover uses, so the two surfaces agree.
  const closeTableThen = React.useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        setTableReturnFocus(connectionTable?.trigger ?? null);
        closeConnectionTable();
        fn(...args);
      },
    [closeConnectionTable, connectionTable],
  );
  const connectFromExpandedTable = React.useCallback(
    (id: string) => closeTableThen(openConnection)(id),
    [closeTableThen, openConnection],
  );
  const manageFromExpandedTable = React.useCallback(
    (id: string) => closeTableThen(openConnectionScreen)(id),
    [closeTableThen, openConnectionScreen],
  );
  const editFromExpandedTable = React.useCallback(
    (id: string) => closeTableThen(openEditConnectionModal)(id),
    [closeTableThen, openEditConnectionModal],
  );
  const deleteFromExpandedTable = React.useCallback(
    (id: string) => closeTableThen(openDeleteConnectionModal)(id),
    [closeTableThen, openDeleteConnectionModal],
  );
  const addFromExpandedTable = React.useCallback(
    () => closeTableThen(openAddConnectionModal)(),
    [closeTableThen, openAddConnectionModal],
  );
  const { openImport } = useConnectionTransfer();
  const importFromExpandedTable = React.useCallback(
    () => closeTableThen(openImport)(),
    [closeTableThen, openImport],
  );

  const tabCountFor = React.useCallback(
    (ids: string[]) => {
      // Same refusal as the single delete: an unloaded list is not "no tabs".
      if (tabsRef.current.loading) return null;
      const set = new Set(ids);
      return tabsRef.current.tabs.filter((t) => set.has(t.connectionId)).length;
    },
    [tabsRef],
  );

  // One delete, shared by the single confirm and the table's batch delete.
  // `settled` runs as soon as the IPC call returns, before tabs close.
  const deleteOne = React.useCallback(
    async (id: string, settled: () => void) => {
      try {
        await api.conn.delete(id);
      } catch (err) {
        settled();
        if (isIpcError(err) && err.code === 'NOT_FOUND') {
          void refreshConnections();
        } else {
          notify.error(isIpcError(err) ? err.message : String(err), { title: 'Delete failed' });
        }
        return;
      }
      invalidateSampleSchemaCache(id);
      invalidateSchemaEnumCache(id);
      settled();
      await closeTabsForConnection(id, 'Connection deleted, but its tabs could not be closed');
      removeConnectionLocal(id);
    },
    [refreshConnections, removeConnectionLocal, closeTabsForConnection],
  );

  const confirmDeleteConnection = React.useCallback(async () => {
    if (!deleteConnectionTarget) return;
    await deleteOne(deleteConnectionTarget.id, () => setDeleteConnectionTarget(null));
  }, [deleteConnectionTarget, deleteOne]);

  const deleteConnections = React.useCallback(
    async (ids: string[]) => {
      for (const id of ids) await deleteOne(id, () => {});
    },
    [deleteOne],
  );

  // useConnections() only refetches on window focus or a live status event,
  // so an explicit awaited refresh is needed here. On edit, a mongo-relevant
  // field change drops the server-side client, so a connected/connecting/error
  // Connection is reconnected — read its status before the refresh, which is
  // where the drop shows up.
  const handleConnectionSaved = React.useCallback(
    async (id: string) => {
      const wasCreate = connectionFormTarget === 'new';
      const status = connections.find((c) => c.id === id)?.status;
      const wasInPlay = status === 'connected' || status === 'connecting' || status === 'error';
      setConnectionFormTarget(null);
      setTableReturnFocus(null);
      await refreshConnections();
      if (wasCreate || wasInPlay) openConnection(id);
    },
    [connectionFormTarget, connections, refreshConnections, openConnection],
  );

  return {
    connectionFormTarget,
    deleteConnectionTarget,
    disconnectTarget,
    disconnectReturnFocus,
    connectionTable,
    tableReturnFocus,
    requestDisconnect,
    closeDisconnectConnectionModal,
    confirmDisconnectConnection,
    openAddConnectionModal,
    openEditConnectionModal,
    closeConnectionFormModal,
    openDeleteConnectionModal,
    closeDeleteConnectionModal,
    openConnectionTable,
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
  };
}
