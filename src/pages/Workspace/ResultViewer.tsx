/* eslint-disable react-refresh/only-export-components */
// Compound namespace (X11 phase 5): one `ResultViewer` export wraps several
// internal slot components. The react-refresh rule wants one component per
// file, but co-locating the slots is the whole point — and they're not
// addressed as top-level exports, only via the namespace.
import { useState, type ReactNode } from 'react';
import { Button, Skeleton, Stack } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
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
import type { ReferenceRule } from '@shared/types';

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
}: BodyProps) {
  const { state, meta, actions } = useCollectionWorkspace();
  // Owned here, not by `EmptyState`: the import's own refresh fills
  // `documents`, which unmounts `EmptyState`, and the dialog has to outlive
  // that to keep showing its report.
  const [importOpen, setImportOpen] = useState(false);
  const isLoading = meta.isLoading;
  const documents = state.lastRun?.documents ?? EMPTY_DOCUMENTS;
  const hasError = !!state.lastRun?.error;
  const isEmpty = documents.length === 0 && !isLoading && !hasError;
  // Only a first load (no run has ever landed in this tab's state) gets
  // placeholder rows in place of the body. Any re-run, including one after an
  // empty or errored result, keeps the body under the "Loading…" strip, so
  // the layout doesn't jump. One live region at a time.
  const showSkeleton = isLoading && !state.lastRun;
  // X14 §5 — dimmed, not hidden or inert, while the query above cannot
  // run: these rows still describe a real earlier query, and a user editing a
  // filter is often reading them to decide what to type next. Same rule as the
  // count marker in `ResultBar`, so the two never disagree. Opacity only — no
  // `pointer-events: none`, which would take selection and row expansion away.
  const isStale = findProblem(state) !== null;

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
      {isLoading && !showSkeleton && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 32,
            left: 0,
            right: 0,
            zIndex: 10,
            padding: '4px 12px',
            background: 'var(--atelier-surface)',
            borderBottom: '1px solid var(--atelier-border)',
            fontSize: 11,
            color: 'var(--atelier-text-muted)',
            textAlign: 'center',
          }}
        >
          Loading…
        </div>
      )}

      {showSkeleton ? (
        <Stack role="status" aria-label="Loading results" gap={6} p="8px 12px">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} height={22} />
          ))}
        </Stack>
      ) : isEmpty ? (
        <EmptyState onClearFilter={onClearFilter} onImport={() => setImportOpen(true)} />
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

function EmptyState({ onClearFilter, onImport }: { onClearFilter: () => void; onImport: () => void }) {
  const { state, meta } = useCollectionWorkspace();
  // No filter, first page, no error: the collection itself is empty, not
  // just this query's match — a different message and CTA than "no match".
  const isEmptyCollection = isUnfilteredFirstPage(state);
  // Results are never persisted, so a restored tab with a custom query has not
  // run yet: say so instead of claiming the query matched nothing.
  const neverRun = state.lastRun === undefined;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--atelier-text-ghost)',
        fontSize: 13,
        gap: 8,
      }}
    >
      {neverRun ? (
        <span>Run the query to see results</span>
      ) : isEmptyCollection ? (
        <>
          <span>This collection is empty</span>
          {!meta.isReadOnly && (
            <Button variant="subtle" size="compact-xs" fz={12} td="underline" c={themeVars.accent} onClick={onImport}>
              Import documents…
            </Button>
          )}
        </>
      ) : (
        <>
          <span>No matching documents</span>
          <Button variant="subtle" size="compact-xs" fz={12} td="underline" c={themeVars.accent} onClick={onClearFilter}>
            Clear filter
          </Button>
        </>
      )}
    </div>
  );
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
