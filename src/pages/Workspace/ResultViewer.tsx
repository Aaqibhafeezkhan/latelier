/* eslint-disable react-refresh/only-export-components */
// Compound namespace (X11 phase 5): one `ResultViewer` export wraps several
// internal slot components. The react-refresh rule wants one component per
// file, but co-locating the slots is the whole point — and they're not
// addressed as top-level exports, only via the namespace.
import { useState, type ReactNode } from 'react';
import { Button, Skeleton, Stack } from '@mantine/core';
import { PaneState } from '../../components/PaneState';
import { TreeView } from './views/TreeView';
import { JsonView } from './views/JsonView';
import { TableView } from './views/TableView';
import { ResultBar } from './ResultBar';
import { ResultSelectionProvider } from './ResultSelectionProvider';
import { SelectionActionBar } from './SelectionActionBar';
import { ImportDialog } from './ImportDialog';
import { useCollectionWorkspace } from './context';
import { EMPTY_DOCUMENTS } from './resultSelection';
import { findProblem, isUnfilteredFirstPage } from './builder';
import { resultPaneKind, revertTarget, type ResultPaneKind } from './resultPaneState';
import type { CollectionTabState, ReferenceRule } from '@shared/types';

/**
 * Compound result view (X11 phase 5). Replaces the old ResultArea monolith
 * with a slot-based namespace so any provider can compose only the pieces
 * it needs. All slots read from `CollectionWorkspaceContext` — drop them
 * inside any `<CollectionWorkspaceProvider>` (real tab, saved-query
 * preview, aggregation snapshot) and they render against that state.
 *
 *   <ResultViewer>
 *     <ResultViewer.Pagination />
 *     <ResultViewer.Body
 *       onColumnResize={...}
 *       onRowExpand={...}
 *       onSortField={...}
 *       onClearFilter={...}
 *     />
 *   </ResultViewer>
 *
 * Or pick individual slots for custom composition:
 *
 *   <ResultViewer>
 *     <ResultViewer.Pagination />
 *     <ResultViewer.Tree expandedRows={...} onRowExpand={...} />
 *   </ResultViewer>
 */
function ResultViewerRoot({ children }: { children: ReactNode }) {
  // T0.4 — scope bulk-selection state to this subtree, resetting whenever
  // the result set itself changes (new run, page change, tab switch,
  // post-delete re-run).
  const { state } = useCollectionWorkspace();
  const documents = state.lastRun?.documents ?? EMPTY_DOCUMENTS;
  return (
    <ResultSelectionProvider documents={documents}>{children}</ResultSelectionProvider>
  );
}

interface BodyProps {
  onClearFilter: () => void;
  onColumnResize: (field: string, width: number) => void;
  onRowExpand: (docId: string, expanded: boolean) => void;
  onSortField?: (field: string) => void;
  refsByField?: Map<string, ReferenceRule>;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
  /** Called after the pane has replaced the whole query, as any wholesale load must report. */
  onQueryReplaced?: () => void;
}

function Body({
  onClearFilter,
  onColumnResize,
  onRowExpand,
  onSortField,
  refsByField,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
  onQueryReplaced,
}: BodyProps) {
  const { state, meta, actions } = useCollectionWorkspace();
  // Owned here, not by `EmptyState`: the import's own refresh fills
  // `documents`, which unmounts `EmptyState`, and the dialog has to outlive
  // that to keep showing its report.
  const [importOpen, setImportOpen] = useState(false);
  const kind = resultPaneKind(state);
  // Only a first load (no run has ever landed in this tab's state) gets
  // placeholder rows in place of the body. Any re-run keeps the body as it is,
  // with the band above saying so, and the result replaces it when it lands.
  const showSkeleton = meta.isLoading && !state.lastRun;
  // X14 §5 — dimmed, not hidden or inert, while the query above cannot
  // run: these rows still describe a real earlier query, and a user editing a
  // filter is often reading them to decide what to type next. Same rule as the
  // count marker in `ResultBar`, so the two never disagree. Opacity only — no
  // `pointer-events: none`, which would take selection and row expansion away.
  const isStale = kind === 'rows' && findProblem(state) !== null;

  return (
    <div
      data-stale={isStale ? 'true' : undefined}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        opacity: isStale ? 0.45 : undefined,
      }}
    >
      {showSkeleton ? (
        <Stack role="status" aria-label="Loading results" gap="var(--atelier-gap-xs)" p="8px 12px">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} height={22} />
          ))}
        </Stack>
      ) : kind !== 'rows' ? (
        <EmptyState
          kind={kind}
          onClearFilter={onClearFilter}
          onImport={() => setImportOpen(true)}
          onQueryReplaced={onQueryReplaced}
        />
      ) : (
        <>
          {state.view === 'Tree' && (
            <Tree
              onRowExpand={onRowExpand}
              refsByField={refsByField}
              onRefHover={onRefHover}
              onRefHoverLeave={onRefHoverLeave}
              onRefOpen={onRefOpen}
            />
          )}
          {state.view === 'JSON' && <Json />}
          {state.view === 'Table' && (
            <Table
              onColumnResize={onColumnResize}
              onRowExpand={onRowExpand}
              onSortField={onSortField}
              refsByField={refsByField}
              onRefHover={onRefHover}
              onRefHoverLeave={onRefHoverLeave}
              onRefOpen={onRefOpen}
            />
          )}
        </>
      )}
      {importOpen && (
        <ImportDialog
          connectionId={meta.connectionId}
          dbName={meta.dbName}
          collection={meta.collection}
          onClose={() => setImportOpen(false)}
          onImported={() => actions.run()}
          onPartialImport={() => actions.run()}
        />
      )}
    </div>
  );
}

function EmptyState({
  kind,
  onClearFilter,
  onImport,
  onQueryReplaced,
}: {
  kind: Exclude<ResultPaneKind, 'rows'>;
  onClearFilter: () => void;
  onImport: () => void;
  onQueryReplaced?: () => void;
}) {
  const { state, meta, actions } = useCollectionWorkspace();
  const clearFilter = (
    <Button variant="default" size="xs" onClick={onClearFilter}>
      Clear filter
    </Button>
  );
  const runAgain = (label: string) => (
    <Button
      variant="default"
      size="xs"
      disabled={meta.isLoading || findProblem(state) !== null}
      onClick={() => actions.run()}
    >
      {label}
    </Button>
  );

  switch (kind) {
    case 'never-run':
      // Results are never persisted, so a restored tab with a custom query has
      // not run yet: say so instead of claiming the query matched nothing.
      return <PaneState title="Run the query to see results" actions={meta.isReadOnly ? undefined : runAgain('Run')} />;
    case 'empty-collection':
      return (
        <PaneState
          title="This collection is empty"
          actions={
            meta.isReadOnly || meta.isView ? (
              runAgain('Run again')
            ) : (
              <Button variant="default" size="xs" onClick={onImport}>
                Import documents…
              </Button>
            )
          }
        />
      );
    case 'no-match':
      return <PaneState title="No matching documents" detail="The filter matched nothing in this collection." actions={clearFilter} />;
    case 'failed':
      return (
        <PaneState
          tone="error"
          title="The query could not finish"
          detail={errorText(state)}
          actions={runAgain('Run again')}
        />
      );
    case 'query-error': {
      const revert = revertTarget(state);
      return (
        <PaneState
          tone="error"
          title="This query failed"
          detail={errorText(state)}
          actions={
            revert ? (
              <Button
                variant="filled"
                size="xs"
                disabled={meta.isLoading}
                onClick={() => {
                  // Patch and run with the same values, so the run can't read
                  // the state from before the patch.
                  const patch = { ...revert, filterDraft: undefined };
                  actions.patch(patch);
                  actions.run(patch);
                  onQueryReplaced?.();
                }}
              >
                Revert to last valid query
              </Button>
            ) : isUnfilteredFirstPage({ ...state, lastRun: undefined }) ? (
              runAgain('Run again')
            ) : (
              clearFilter
            )
          }
        />
      );
    }
  }
}

function errorText(state: CollectionTabState): string {
  const error = state.lastRun?.error;
  return error ? `${error.code}: ${error.message}` : '';
}

interface TreeSlotProps {
  onRowExpand: (docId: string, expanded: boolean) => void;
  refsByField?: Map<string, ReferenceRule>;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
}

function Tree({
  onRowExpand,
  refsByField,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
}: TreeSlotProps) {
  const { state } = useCollectionWorkspace();
  const documents = state.lastRun?.documents ?? EMPTY_DOCUMENTS;
  return (
    <TreeView
      documents={documents}
      expandedRows={state.expandedRows}
      onSelect={() => {/* selection is internal to TreeView */}}
      onRowExpand={onRowExpand}
      refsByField={refsByField}
      onRefHover={onRefHover}
      onRefHoverLeave={onRefHoverLeave}
      onRefOpen={onRefOpen}
    />
  );
}

function Json() {
  const { state } = useCollectionWorkspace();
  const documents = state.lastRun?.documents ?? EMPTY_DOCUMENTS;
  return <JsonView documents={documents} />;
}

interface TableSlotProps {
  onColumnResize: (field: string, width: number) => void;
  onRowExpand: (docId: string, expanded: boolean) => void;
  onSortField?: (field: string) => void;
  refsByField?: Map<string, ReferenceRule>;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
}

function Table({
  onColumnResize,
  onRowExpand,
  onSortField,
  refsByField,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
}: TableSlotProps) {
  const { state } = useCollectionWorkspace();
  const documents = state.lastRun?.documents ?? EMPTY_DOCUMENTS;
  return (
    <TableView
      documents={documents}
      columns={state.columns}
      columnConfig={state.columnConfig}
      onColumnResize={onColumnResize}
      expandedRows={state.expandedRows}
      onRowExpand={onRowExpand}
      onSortField={onSortField}
      sort={state.builder.sort}
      refsByField={refsByField}
      onRefHover={onRefHover}
      onRefHoverLeave={onRefHoverLeave}
      onRefOpen={onRefOpen}
    />
  );
}

export const ResultViewer = Object.assign(ResultViewerRoot, {
  Pagination: ResultBar,
  Body,
  Tree,
  Json,
  Table,
  EmptyState,
  SelectionBar: SelectionActionBar,
});
