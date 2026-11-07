import React from 'react';
import type {
  AggregationTabState,
  CollectionTab,
  CollectionTabState,
  CollectionView,
  ScriptTab,
  ScriptTabState,
  SchemaTabState,
} from '@shared/types';
import { sortFieldPatch } from './builder';
import { CLEAR_FILTER_PATCH, columnResizePatch, rowExpandPatch, schemaPatch } from './collectionPatches';
import type { WorkspaceTabsState } from '../../state/workspaceTabs';

export interface CollectionTabActions {
  patchActiveCollection: (patch: Partial<CollectionTabState>) => void;
  patchActiveCollectionWith: (fn: (s: CollectionTabState) => Partial<CollectionTabState>) => void;
  patchActiveScript: (patch: Partial<ScriptTabState>) => void;
  selectActiveView: (view: CollectionView) => void;
  clearActiveFilter: () => void;
  handleColumnResize: (field: string, width: number) => void;
  handleRowExpand: (docId: string, expanded: boolean) => void;
  handleSortField: (field: string) => void;
  patchAggregation: (patch: Partial<AggregationTabState>) => void;
  patchSchema: (patch: Partial<SchemaTabState>) => void;
  runActiveCollection: (override?: Partial<CollectionTabState>) => void;
  cancelActiveCollection: () => void;
}

export function useCollectionTabActions(deps: {
  activeCollectionRef: React.RefObject<CollectionTab | null>;
  activeScriptRef: React.RefObject<ScriptTab | null>;
  tabs: WorkspaceTabsState;
  run: (override?: Partial<CollectionTabState>) => Promise<void>;
  cancel: () => void;
}): CollectionTabActions {
  const { activeCollectionRef, activeScriptRef, tabs, run, cancel } = deps;

  const patchActiveCollection = React.useCallback(
    (patch: Partial<CollectionTabState>) => {
      const a = activeCollectionRef.current;
      if (a) tabs.patchCollectionState(a.id, patch);
    },
    [activeCollectionRef, tabs.patchCollectionState],
  );
  const patchActiveScript = React.useCallback(
    (patch: Partial<ScriptTabState>) => {
      const s = activeScriptRef.current;
      if (s) tabs.patchScriptState(s.id, patch);
    },
    [activeScriptRef, tabs.patchScriptState],
  );
  const selectActiveView = React.useCallback(
    (view: CollectionView) => {
      const a = activeCollectionRef.current;
      if (a) tabs.setActiveView(a.id, view);
    },
    [activeCollectionRef, tabs.setActiveView],
  );
  // Runs as well: the pane offering this describes the last run, so clearing
  // the text alone would leave it saying the collection is empty.
  const clearActiveFilter = React.useCallback(() => {
    const a = activeCollectionRef.current;
    if (!a) return;
    tabs.patchCollectionState(a.id, CLEAR_FILTER_PATCH);
    void run(CLEAR_FILTER_PATCH);
  }, [activeCollectionRef, tabs.patchCollectionState, run]);
  // These three use the functional-updater variant so the merge runs against the latest pending patch, not a stale ref snapshot.
  const handleColumnResize = React.useCallback(
    (field: string, width: number) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      tabs.patchCollectionStateWith(a.id, (prev) => columnResizePatch(prev, field, width));
    },
    [activeCollectionRef, tabs.patchCollectionStateWith],
  );
  const handleRowExpand = React.useCallback(
    (docId: string, expanded: boolean) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      tabs.patchCollectionStateWith(a.id, (prev) => rowExpandPatch(prev, docId, expanded));
    },
    [activeCollectionRef, tabs.patchCollectionStateWith],
  );
  const handleSortField = React.useCallback(
    (field: string) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      const patch = sortFieldPatch(a.state, field);
      tabs.patchCollectionState(a.id, patch);
      void run(patch);
    },
    [activeCollectionRef, tabs.patchCollectionState, run],
  );
  const patchAggregation = React.useCallback(
    (patch: Partial<AggregationTabState>) => {
      const a = activeCollectionRef.current;
      if (a) tabs.patchAggregationState(a.id, patch);
    },
    [activeCollectionRef, tabs.patchAggregationState],
  );
  const patchSchema = React.useCallback(
    (patch: Partial<SchemaTabState>) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      tabs.patchCollectionStateWith(a.id, (prev) => schemaPatch(prev, patch));
    },
    [activeCollectionRef, tabs.patchCollectionStateWith],
  );
  const patchActiveCollectionWith = React.useCallback(
    (fn: (s: CollectionTabState) => Partial<CollectionTabState>) => {
      const a = activeCollectionRef.current;
      if (a) tabs.patchCollectionStateWith(a.id, fn);
    },
    [activeCollectionRef, tabs.patchCollectionStateWith],
  );
  const runActiveCollection = React.useCallback(
    (override?: Partial<CollectionTabState>) => {
      void run(override);
    },
    [run],
  );
  const cancelActiveCollection = React.useCallback(() => {
    cancel();
  }, [cancel]);

  return {
    patchActiveCollection,
    patchActiveCollectionWith,
    patchActiveScript,
    selectActiveView,
    clearActiveFilter,
    handleColumnResize,
    handleRowExpand,
    handleSortField,
    patchAggregation,
    patchSchema,
    runActiveCollection,
    cancelActiveCollection,
  };
}
