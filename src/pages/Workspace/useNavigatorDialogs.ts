import React from 'react';
import type { ContextMenuState } from '../../components/ContextMenu';
import { notifyCollectionChanged } from '../../state/collectionChanges';
import { api, getErrorMessage } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import type { LoadOptions } from './useNavigatorData';

type MenuState = ContextMenuState;

/** A view being duplicated: its source and pipeline are read before the dialog opens. */
export interface DuplicateViewTarget {
  connectionId: string;
  dbName: string;
  view: string;
  viewOn: string;
  pipelineJson: string;
  /** The source view's collation (EJSON), when it has one. */
  collation?: string;
}

export function useNavigatorDialogs(deps: {
  refreshDb: (connectionId: string, dbName: string, opts?: LoadOptions) => void;
  refreshAll: (connectionId: string, opts?: LoadOptions) => Promise<void>;
  onCollectionRenamed?: (
    connectionId: string,
    dbName: string,
    oldName: string,
    newName: string,
  ) => void;
  onCollectionDropped?: (connectionId: string, dbName: string, collection: string) => void;
  onDatabaseDropped?: (connectionId: string, dbName: string) => void;
}): {
  menu: MenuState | null;
  createCollDb: { connectionId: string; dbName: string } | null;
  renameTarget: { connectionId: string; dbName: string; collection: string } | null;
  modifyViewTarget: { connectionId: string; dbName: string; collection: string } | null;
  duplicateViewTarget: DuplicateViewTarget | null;
  dropCollTarget: { connectionId: string; dbName: string; collection: string } | null;
  importTarget: { connectionId: string; dbName: string; collection: string } | null;
  dropDbTarget: { connectionId: string; dbName: string } | null;
  menuTrigger: HTMLElement | null;
  setMenu: React.Dispatch<React.SetStateAction<MenuState | null>>;
  setCreateCollDb: React.Dispatch<
    React.SetStateAction<{ connectionId: string; dbName: string } | null>
  >;
  setRenameTarget: React.Dispatch<
    React.SetStateAction<{ connectionId: string; dbName: string; collection: string } | null>
  >;
  setModifyViewTarget: React.Dispatch<
    React.SetStateAction<{ connectionId: string; dbName: string; collection: string } | null>
  >;
  setDropCollTarget: React.Dispatch<
    React.SetStateAction<{ connectionId: string; dbName: string; collection: string } | null>
  >;
  setDropDbTarget: React.Dispatch<
    React.SetStateAction<{ connectionId: string; dbName: string } | null>
  >;
  setImportTarget: React.Dispatch<
    React.SetStateAction<{ connectionId: string; dbName: string; collection: string } | null>
  >;
  setMenuTrigger: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
  closeMenu: () => void;
  cancelCreateColl: () => void;
  handleCollectionCreated: () => void;
  cancelRename: () => void;
  handleCollectionRenamed: (newName: string) => void;
  cancelModifyView: () => void;
  handleViewModified: () => void;
  openDuplicateView: (connectionId: string, dbName: string, view: string) => void;
  cancelDuplicateView: () => void;
  handleViewDuplicated: (name: string) => void;
  cancelDropColl: () => void;
  handleCollectionDropped: () => void;
  cancelDropDb: () => void;
  handleDatabaseDropped: () => void;
  closeImport: () => void;
  handleImported: () => void;
} {
  const { refreshDb, refreshAll, onCollectionRenamed, onCollectionDropped, onDatabaseDropped } =
    deps;

  const [menu, setMenu] = React.useState<MenuState | null>(null);
  // Each dialog carries the Connection it was opened on, not the expanded one (N roots means those differ).
  const [createCollDb, setCreateCollDb] = React.useState<{ connectionId: string; dbName: string } | null>(null);
  const [renameTarget, setRenameTarget] = React.useState<{ connectionId: string; dbName: string; collection: string } | null>(null);
  const [modifyViewTarget, setModifyViewTarget] = React.useState<{ connectionId: string; dbName: string; collection: string } | null>(null);
  const [duplicateViewTarget, setDuplicateViewTarget] = React.useState<DuplicateViewTarget | null>(null);
  const [dropCollTarget, setDropCollTarget] = React.useState<{ connectionId: string; dbName: string; collection: string } | null>(null);
  const [dropDbTarget, setDropDbTarget] = React.useState<{ connectionId: string; dbName: string } | null>(null);
  const [importTarget, setImportTarget] = React.useState<{ connectionId: string; dbName: string; collection: string } | null>(null);
  // ContextMenu unmounts its trigger in the same batch as onClick, so useDialogFocusReturn would capture an already-detached element; this state outlives it.
  const [menuTrigger, setMenuTrigger] = React.useState<HTMLElement | null>(null);

  const closeMenu = React.useCallback(() => setMenu(null), []);
  const cancelCreateColl = React.useCallback(() => setCreateCollDb(null), []);
  const handleCollectionCreated = React.useCallback(() => {
    if (!createCollDb) return;
    const { connectionId: cid, dbName: db } = createCollDb;
    setCreateCollDb(null);
    refreshDb(cid, db, { force: true });
  }, [createCollDb, refreshDb]);

  const cancelRename = React.useCallback(() => setRenameTarget(null), []);
  const handleCollectionRenamed = React.useCallback(
    (newName: string) => {
      if (!renameTarget) return;
      const { connectionId: cid, dbName: db, collection: oldName } = renameTarget;
      setRenameTarget(null);
      refreshDb(cid, db, { force: true });
      onCollectionRenamed?.(cid, db, oldName, newName);
    },
    [renameTarget, refreshDb, onCollectionRenamed],
  );

  const cancelModifyView = React.useCallback(() => setModifyViewTarget(null), []);
  const handleViewModified = React.useCallback(() => {
    if (!modifyViewTarget) return;
    const { connectionId: cid, dbName: db, collection } = modifyViewTarget;
    setModifyViewTarget(null);
    // The navigator listens for this and refreshes the DB; an open Structure tab on the view reloads too.
    notifyCollectionChanged({ connectionId: cid, dbName: db, collection });
  }, [modifyViewTarget]);

  // Only the latest read may open the dialog: a slow one for an earlier view must not replace it.
  const duplicateReadRef = React.useRef(0);
  const openDuplicateView = React.useCallback((connectionId: string, dbName: string, view: string) => {
    const read = ++duplicateReadRef.current;
    api.meta
      .collectionDetails({ connectionId, dbName, collection: view })
      .then((d) => {
        if (read !== duplicateReadRef.current) return;
        const { viewOn, pipeline } = d.options;
        if (!viewOn || pipeline === undefined) {
          throw new Error(`${view} reports no source collection or pipeline`);
        }
        setDuplicateViewTarget({
          connectionId,
          dbName,
          view,
          viewOn,
          pipelineJson: pipeline,
          collation: d.options.collation,
        });
      })
      .catch((e: unknown) => {
        if (read === duplicateReadRef.current) notify.error(getErrorMessage(e, 'Could not read the view'));
      });
  }, []);
  const cancelDuplicateView = React.useCallback(() => setDuplicateViewTarget(null), []);
  const handleViewDuplicated = React.useCallback(
    (name: string) => {
      if (!duplicateViewTarget) return;
      const { connectionId: cid, dbName: db } = duplicateViewTarget;
      setDuplicateViewTarget(null);
      // The new view is a collection the navigator has not listed yet.
      notifyCollectionChanged({ connectionId: cid, dbName: db, collection: name });
    },
    [duplicateViewTarget],
  );

  const cancelDropColl = React.useCallback(() => setDropCollTarget(null), []);
  const handleCollectionDropped = React.useCallback(() => {
    if (!dropCollTarget) return;
    const { connectionId: cid, dbName: db, collection: coll } = dropCollTarget;
    setDropCollTarget(null);
    refreshDb(cid, db, { force: true });
    onCollectionDropped?.(cid, db, coll);
  }, [dropCollTarget, refreshDb, onCollectionDropped]);

  const cancelDropDb = React.useCallback(() => setDropDbTarget(null), []);
  const handleDatabaseDropped = React.useCallback(() => {
    if (!dropDbTarget) return;
    const { connectionId: cid, dbName: db } = dropDbTarget;
    setDropDbTarget(null);
    void refreshAll(cid, { force: true });
    onDatabaseDropped?.(cid, db);
  }, [dropDbTarget, refreshAll, onDatabaseDropped]);

  const closeImport = React.useCallback(() => setImportTarget(null), []);
  // The dialog stays open on its report, so this refreshes without closing it.
  const handleImported = React.useCallback(() => {
    if (importTarget) refreshDb(importTarget.connectionId, importTarget.dbName, { force: true });
  }, [importTarget, refreshDb]);

  return {
    menu,
    createCollDb,
    renameTarget,
    modifyViewTarget,
    duplicateViewTarget,
    dropCollTarget,
    dropDbTarget,
    importTarget,
    menuTrigger,
    setMenu,
    setCreateCollDb,
    setRenameTarget,
    setModifyViewTarget,
    setDropCollTarget,
    setDropDbTarget,
    setImportTarget,
    setMenuTrigger,
    closeMenu,
    cancelCreateColl,
    handleCollectionCreated,
    cancelRename,
    handleCollectionRenamed,
    cancelModifyView,
    handleViewModified,
    openDuplicateView,
    cancelDuplicateView,
    handleViewDuplicated,
    cancelDropColl,
    handleCollectionDropped,
    cancelDropDb,
    handleDatabaseDropped,
    closeImport,
    handleImported,
  };
}
