import React from 'react';
import { notify } from '../../theme/notifications';
import { invalidateSampleSchemaCache } from '../../features/fieldSuggestions/sources/sampleSchemaSource';
import { offerUndo } from './offerUndo';
import { filterProblem } from './builder';
import { stripIdForDuplicate } from './views/docId';
import type { CollectionTab } from '@shared/types';
import type { RunnerTarget, UseQueryRunnerResult } from './useQueryRunner';

/** Identity of the collection a drawer or confirm dialog is writing to, captured when it opened. */
export interface DocTarget {
  tabId: string;
  connectionId: string;
  dbName: string;
  collection: string;
}

export function targetOf(tab: CollectionTab): DocTarget {
  return {
    tabId: tab.id,
    connectionId: tab.connectionId,
    dbName: tab.dbName,
    collection: tab.collection,
  };
}

export function useDocumentDialogs(deps: {
  activeCollectionRef: React.RefObject<CollectionTab | null>;
  queryRunner: UseQueryRunnerResult;
  activeTabId: string | null;
  /** Resolves a tab's current runner target at write-completion time; `null` if the tab is gone. */
  resolveRunnerTarget: (tabId: string) => RunnerTarget | null;
  /** The Focused Tab's Connection is read-only, so the Document Editor never opens. */
  readOnly: boolean;
}): {
  editing: { doc: unknown; target: DocTarget; focusPath?: string } | null;
  deleteDoc: unknown | null;
  deleteAllOpen: boolean;
  updateAllOpen: boolean;
  deleteSelected: unknown[] | null;
  inserting: { target: DocTarget; duplicateDocJson: string | null } | null;
  openEdit: (doc: unknown, focusPath?: string) => void;
  setDeleteDoc: React.Dispatch<React.SetStateAction<unknown | null>>;
  setDeleteSelected: React.Dispatch<React.SetStateAction<unknown[] | null>>;
  openInsertModal: () => void;
  openDeleteAllModal: () => void;
  openUpdateAllModal: () => void;
  openDuplicate: (doc: unknown) => void;
  closeInsertDrawer: () => void;
  handleInserted: () => void;
  handlePartialInsert: () => void;
  closeEditor: () => void;
  handleDocSaved: (auditId?: string) => void;
  closeDeleteDialogs: () => void;
  /** `target` is the collection the dialog wrote to, not the Focused Tab at completion.
   * Closes the delete dialogs only when focus is still on that tab. */
  handleDeleted: (auditId: string | undefined, message: string, target: DocTarget) => void;
  closeUpdateAllModal: () => void;
  /** `target` is the collection the dialog wrote to, not the Focused Tab at completion.
   * Closes update-all only when focus is still on that tab. */
  handleUpdatedAll: (auditId: string | undefined, message: string, target: DocTarget) => void;
  /** Bumps once per completed insert/edit/delete/delete-many, so a consumer
   * that only cares "did a write just land" (e.g. the header's stats fetch)
   * doesn't have to re-run on every read-only query re-run (sort, filter,
   * page). */
  writeVersion: number;
} {
  const { activeCollectionRef, activeTabId, resolveRunnerTarget, readOnly } = deps;
  const { run } = deps.queryRunner;

  // Target travels inside editing/inserting with the payload, captured at
  // open time, so a tab switch mid-edit can't retarget the eventual write.
  const [editing, setEditing] = React.useState<{ doc: unknown; target: DocTarget; focusPath?: string } | null>(null);
  const [deleteDoc, setDeleteDoc] = React.useState<unknown | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false);
  const [updateAllOpen, setUpdateAllOpen] = React.useState(false);
  // Holds the selected documents, not just ids, so the $in filter can be
  // recomputed from the canonical revived-BSON _id values.
  const [deleteSelected, setDeleteSelected] = React.useState<unknown[] | null>(null);
  // `null` duplicateDocJson means opened via plain Insert; the Document
  // Editor's insert mode falls back to '{}'.
  const [inserting, setInserting] = React.useState<{
    target: DocTarget;
    duplicateDocJson: string | null;
  } | null>(null);
  const [writeVersion, setWriteVersion] = React.useState(0);

  const openEdit = React.useCallback(
    (doc: unknown, focusPath?: string) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      if (readOnly) {
        notify.info('This connection is read-only, so its documents cannot be edited.', {
          title: 'Read-only connection',
        });
        return;
      }
      setEditing({ doc, target: targetOf(a), focusPath });
    },
    [activeCollectionRef, readOnly],
  );
  const openInsertModal = React.useCallback(() => {
    const a = activeCollectionRef.current;
    if (!a) return;
    setInserting({ target: targetOf(a), duplicateDocJson: null });
  }, [activeCollectionRef]);
  const openDeleteAllModal = React.useCallback(() => {
    const a = activeCollectionRef.current;
    if (!a) return;
    // The Run gate's own rule and message (`currentFilterJson` is null
    // exactly when this is not), so the refusal names what to fix.
    const problem = filterProblem(a.state.queryRaw);
    if (problem !== null) {
      notify.error(problem, { title: 'No runnable filter' });
      return;
    }
    setDeleteAllOpen(true);
  }, [activeCollectionRef]);
  const openUpdateAllModal = React.useCallback(() => {
    const a = activeCollectionRef.current;
    if (!a) return;
    // The Run gate's own rule and message (`currentFilterJson` is null
    // exactly when this is not), so the refusal names what to fix.
    const problem = filterProblem(a.state.queryRaw);
    if (problem !== null) {
      notify.error(problem, { title: 'No runnable filter' });
      return;
    }
    setUpdateAllOpen(true);
  }, [activeCollectionRef]);
  const openDuplicate = React.useCallback(
    (doc: unknown) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      setInserting({ target: targetOf(a), duplicateDocJson: stripIdForDuplicate(doc) });
    },
    [activeCollectionRef],
  );

  // A bare run() would refresh the Focused Tab, not the tab that was written
  // to — resolve that tab from the live tab list instead. `null` (tab gone,
  // e.g. ⌘W with the drawer open) no-ops rather than falling back.
  const rerunTarget = React.useCallback(
    (target: DocTarget) => {
      const runnerTarget = resolveRunnerTarget(target.tabId);
      if (!runnerTarget) return;
      void run(undefined, runnerTarget);
      setWriteVersion((v) => v + 1);
    },
    [resolveRunnerTarget, run],
  );
  // The write already landed, so the field-suggestion sample is dropped first,
  // from the captured target, ahead of any early return in the re-run.
  const refreshSource = React.useCallback(
    (target: DocTarget) => {
      invalidateSampleSchemaCache(target.connectionId, target.dbName, target.collection);
      rerunTarget(target);
    },
    [rerunTarget],
  );

  const closeInsertDrawer = React.useCallback(() => setInserting(null), []);
  const handleInserted = React.useCallback(() => {
    const target = inserting?.target;
    closeInsertDrawer();
    if (target) refreshSource(target);
  }, [closeInsertDrawer, inserting, refreshSource]);
  const handlePartialInsert = React.useCallback(() => {
    if (inserting) refreshSource(inserting.target);
  }, [inserting, refreshSource]);

  const closeEditor = React.useCallback(() => setEditing(null), []);
  const handleDocSaved = React.useCallback((auditId?: string) => {
    const target = editing?.target;
    setEditing(null);
    if (!target) return;
    refreshSource(target);
    offerUndo('Document updated', auditId, () => refreshSource(target));
  }, [editing, refreshSource]);

  const closeDeleteDialogs = React.useCallback(() => {
    setDeleteDoc(null);
    setDeleteAllOpen(false);
    setDeleteSelected(null);
  }, []);
  // Not routed through refreshSource: DeleteConfirm and UpdateConfirm drop the
  // field-suggestion sample themselves, from their own props, before calling
  // back. `target` is the collection the dialog wrote to — focus can move
  // while the request is in flight, so the re-run and the Undo follow it
  // rather than whichever tab is focused when the write lands.
  //
  // Closes the delete dialogs only while focus is still on the written tab. Then
  // the open state is this write's own, including the flag an unmounted dialog
  // leaves set (DialogStack hides it while its filter is invalid). Once focus
  // has moved, the tab switch already closed that dialog, so whatever is open
  // now was opened on another tab since and must stay. A dialog still on screen
  // also closes itself, and skips that when it has been unmounted.
  const handleDeleted = React.useCallback((auditId: string | undefined, message: string, target: DocTarget) => {
    if (activeCollectionRef.current?.id === target.tabId) closeDeleteDialogs();
    rerunTarget(target);
    // Exactly one toast: Undo-bearing when reversible, plain otherwise — a
    // delete-all over the bulk capture ceiling still needs to say what
    // happened.
    if (auditId === undefined) {
      notify.success(message);
      return;
    }
    offerUndo(message, auditId, () => refreshSource(target));
  }, [activeCollectionRef, closeDeleteDialogs, refreshSource, rerunTarget]);

  // Same shape as delete-all: UpdateConfirm also reports the collection it
  // wrote to, drops the field-suggestion sample itself and closes itself, and
  // the flag is cleared here under the same focus rule.
  const closeUpdateAllModal = React.useCallback(() => setUpdateAllOpen(false), []);
  const handleUpdatedAll = React.useCallback((auditId: string | undefined, message: string, target: DocTarget) => {
    if (activeCollectionRef.current?.id === target.tabId) closeUpdateAllModal();
    rerunTarget(target);
    // Exactly one toast: Undo-bearing when reversible, plain otherwise — an
    // update over the bulk capture ceiling still needs to say what happened.
    if (auditId === undefined) {
      notify.success(message);
      return;
    }
    offerUndo(message, auditId, () => refreshSource(target));
  }, [activeCollectionRef, closeUpdateAllModal, refreshSource, rerunTarget]);

  // DeleteConfirm's and UpdateConfirm's targets are read live from the
  // Focused Tab, so any route that moves focus off the tab either was opened
  // against (⌘1-9, ⌘W, cycling, palette tab.open) must close them —
  // otherwise they'd act on the wrong collection. editing/inserting
  // deliberately do NOT close here: they carry their own captured target and
  // hold an in-progress draft that a tab switch must not silently discard.
  //
  // Adjusted during render (not an effect) to avoid an extra commit+render pass per switch.
  const [prevTabId, setPrevTabId] = React.useState(activeTabId);
  if (activeTabId !== prevTabId) {
    setPrevTabId(activeTabId);
    closeDeleteDialogs();
    closeUpdateAllModal();
  }

  return {
    editing,
    deleteDoc,
    deleteAllOpen,
    updateAllOpen,
    deleteSelected,
    inserting,
    openEdit,
    setDeleteDoc,
    setDeleteSelected,
    openInsertModal,
    openDeleteAllModal,
    openUpdateAllModal,
    openDuplicate,
    closeInsertDrawer,
    handleInserted,
    handlePartialInsert,
    closeEditor,
    handleDocSaved,
    closeDeleteDialogs,
    handleDeleted,
    closeUpdateAllModal,
    handleUpdatedAll,
    writeVersion,
  };
}
