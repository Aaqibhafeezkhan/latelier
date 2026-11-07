import React from 'react';
import { ActionIcon, Button, Group, Menu, Select, SegmentedControl, Tooltip, UnstyledButton } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { useElementWidth } from '../../hooks/useElementWidth';
import type { ResultViewMode } from '@shared/types';
import { useCollectionWorkspace } from './context';
import { api } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { DEFAULT_PAGE_SIZE_PREF_KEY, PAGE_SIZE_OPTIONS } from '../../state/workspaceTabs';
import { FieldsControl } from './FieldsControl';
import { ExportDialog } from './ExportDialog';
import { ExplainDrawer } from './Aggregation/ExplainDrawer';
import { useFindExplain } from './useFindExplain';
import { summarizeExplain } from '../../utils/explainSummary';
import { ImportDialog } from './ImportDialog';
import { compileFindOptions, findProblem } from './builder';
import { LIMIT_EXPLANATION, limitChipText } from './queryCaps';
import { resultBarLayout } from './toolbarLayout';

const VIEWS: ResultViewMode[] = ['Tree', 'JSON', 'Table'];

// W07 §2 / §5: fixed page-size option set (canonical copy lives in
// `state/workspaceTabs.ts`, reused here to avoid a second hardcoded array).
// Changing the value resets `page` to 0 and re-runs (same reasoning as the
// pager buttons' `goToPage`: patch + run with the same override so the
// runner doesn't close over stale state).
const PAGE_SIZE_DATA = PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }));

/**
 * Inline result strip that sits directly below the QueryBar. Mirrors the
 * mockup layout:
 *
 *   « ‹ P/T › »  ·  N results · D ms · showing X–Y          [Tree|JSON|Table]
 *
 * Reads everything off the collection-workspace context — no props. Drop it
 * into any provider (workspace tab, saved-query preview, aggregation result
 * snapshot) and it renders against that consumer's state without rewiring.
 */
export function ResultBar() {
  const T = themeVars;
  const { state, actions, meta } = useCollectionWorkspace();
  const lastRun = state.lastRun;
  const page = state.page;
  const pageSize = state.pageSize;
  const docCount = lastRun?.documents.length ?? null;
  const duration = lastRun?.durationMs ?? null;
  const totalCount = state.totalCount;
  const hasMore = state.lastRunHasMore;
  const isLoading = meta.isLoading;
  const view = state.view;
  const isReadOnly = !!meta.isReadOnly;
  // A view runs queries but takes no writes.
  const isView = !!meta.isView;
  const [exportOpen, setExportOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);
  // The plan badge's drawer re-fetches only when the verbosity changes, and
  // then asks about the committed filter text, like any other read surface.
  const { runExplain, onCreateIndex } = useFindExplain(() => state.queryRaw);

  // X14 §5 — the dangerous half of the defect this ticket exists for.
  // A refused filter never re-runs, so `lastRun` keeps describing the query
  // the user has since edited away and "139 results" reads as the answer to
  // the text now in the box. Derived rather than held: the button-less Run
  // paths (auto-run on open, the palette's `query.run`) repair inside
  // `useQueryRunner`, where no QueryBar-local message exists to hang this on.
  // `findProblem` is the Run button's own rule, so the count is marked stale
  // exactly while Run is refusing to make it current again.
  const runProblem = findProblem(state);
  const isStale = runProblem !== null;
  // Before the first run, the count is missing entirely rather than stale —
  // offer the same Run gate QueryBar's button uses instead of a dead-end
  // "No run yet" label. Read-only consumers (ScriptTab's snapshot provider)
  // have no working `run`, so they keep the plain label.
  const canRunHere = !isReadOnly && !isLoading && runProblem === null;

  // #160 — what the last run's query did: the index it used, or a collection
  // scan. Stale on the same rule as the count: the plan describes the query
  // that ran, not the text now in the box. An empty filter matches every
  // document, so a scan is the only plan it has, not a missing index.
  const planSummary = summarizeExplain(lastRun?.plan);
  const planLabel = planSummary?.collscan
    ? planSummary.emptyFilter
      ? null
      : 'no index'
    : planSummary?.usesIndex
      ? (planSummary.indexName ?? 'index')
      : null;
  const [barRef, barWidth] = useElementWidth<HTMLDivElement>();
  const layout = resultBarLayout(barWidth);
  // A stale count is the total and "· not current", at any width: the longer forms
  // leave that no room. This stays inside the count's slot, so no control moves.
  const countForm = isStale ? 'total' : layout.count;

  // The limit that actually applies (a coerced one shows as what it runs as).
  const limitChip = limitChipText(compileFindOptions(state.builder).limit);

  const start = docCount !== null ? page * pageSize + 1 : null;
  const end = docCount !== null ? page * pageSize + docCount : null;
  const totalPages =
    totalCount !== undefined ? Math.max(1, Math.ceil(totalCount / pageSize)) : null;

  const canPrev = page > 0 && !isLoading;
  // Prefer totalPages when it's known: the find's server-side `hasMore` is
  // computed as `docs.length === limit`, which is a false positive on a last
  // page that happens to be exactly full. Once the count() background fetch
  // settles, totalPages is authoritative — only fall back to hasMore while
  // the count is still in flight.
  const canNext =
    !isLoading &&
    (totalPages !== null ? page < totalPages - 1 : !!hasMore);
  const canFirst = canPrev;
  const canLast = totalPages !== null && page < totalPages - 1 && !isLoading;

  const totalLabel = `${(totalCount ?? docCount ?? 0).toLocaleString()}${hasMore && totalCount === undefined ? '+' : ''}`;
  const rangeLabel =
    start !== null && end !== null && docCount !== 0
      ? `${start.toLocaleString()}–${end.toLocaleString()}`
      : null;
  // The merged forms drop words, never facts: the rest stays one hover away.
  const countDetail = `${totalLabel} results${duration !== null ? ` · ${duration} ms` : ''}${
    rangeLabel ? ` · showing ${rangeLabel}` : ''
  }`;

  // Pagination through context: patch + re-run with the same override so
  // `run` doesn't close over a stale `page` from before the patch.
  const goToPage = (p: number) => {
    const patch = { page: p };
    actions.patch(patch);
    actions.run(patch);
  };

  // Page-size selector (W07 §2/§3, T0.5). Convert the Select's string value
  // to a number once at this boundary and reuse the single numeric variable
  // for the patch/run and the sticky-default prefs write — never let a
  // string reach `effectivePageLimit` / `FindInput.limit`.
  const handlePageSizeChange = (value: string | null) => {
    if (!value) return;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n === pageSize) return;
    const patch = { pageSize: n, page: 0 };
    actions.patch(patch);
    actions.run(patch);
    void api.prefs.set(DEFAULT_PAGE_SIZE_PREF_KEY, n).catch(() => {
      // The tab's own pageSize already persisted via patch; only the sticky
      // default for new tabs is lost, which the user is told.
      notify.error('Could not save the rows-per-page default', { id: 'pref-save-failed' });
    });
  };

  return (
    <Group
      ref={barRef}
      data-testid="result-bar"
      gap={layout.iconControls ? 6 : 8}
      wrap={layout.wrap ? 'wrap' : 'nowrap'}
      style={{
        minHeight: 44,
        boxSizing: 'border-box',
        padding: layout.wrap ? '4px 14px' : '0 14px',
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
        fontSize: T.fsSm,
        color: T.textMuted,
        // Set once here and inherited, so no text in this row wraps onto a
        // second line. That would grow the bar, which one flex column up shrinks
        // the virtualized list and turns a width squeeze into a scroll-settle bug.
        whiteSpace: 'nowrap',
      }}
    >
      {/* Pager — first · prev · P/T · next · last */}
      <Group gap={themeVars.gapXs} wrap="nowrap" style={{ flexShrink: 0 }}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={() => canFirst && goToPage(0)}
          disabled={!canFirst}
          aria-label="First page"
        >
          {I.chevLL}
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={() => canPrev && goToPage(page - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
        >
          {I.chevL}
        </ActionIcon>
        {/* Room for "2400 / 2400", the widest this page count reaches, so Next and Last hold still. */}
        <span
          data-testid="page-label"
          style={{
            minWidth: `max(48px, ${2 * String(totalPages ?? '').length + 3}ch)`,
            textAlign: 'center',
            color: T.text,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {page + 1}
          {totalPages !== null ? ` / ${totalPages}` : ''}
        </span>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={() => canNext && goToPage(page + 1)}
          disabled={!canNext}
          aria-label="Next page"
        >
          {I.chevR}
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={() => canLast && totalPages !== null && goToPage(totalPages - 1)}
          disabled={!canLast}
          aria-label="Last page"
        >
          {I.chevRR}
        </ActionIcon>
      </Group>

      {/* Page-size selector — W07 §2/§5, T0.5. `comboboxProps={{ keepMounted:
          false }}` unmounts the option list while closed (Mantine's default
          keeps it mounted-but-hidden for a11y) — otherwise every numeric
          option label (10/25/50/100/250/500) sits in the DOM at all times
          and collides with substring text locators elsewhere on the page
          (e.g. a document field rendering the digit "5"). */}
      <Select
        size="xs"
        aria-label="Rows per page"
        value={String(pageSize)}
        onChange={handlePageSizeChange}
        data={PAGE_SIZE_DATA}
        allowDeselect={false}
        withCheckIcon={false}
        comboboxProps={{ keepMounted: false }}
        rightSectionWidth={18}
        // A compact control here, beside 26 px buttons, not the theme's 36 px input.
        styles={{ input: { height: 26, minHeight: 26, fontSize: T.fsSm, paddingInline: '6px 18px' } }}
        style={{ width: 52, flexShrink: 0 }}
      />

      {/* The one flexible part of the bar: everything that depends on the query
          lives here and truncates, so nothing to its right ever moves. */}
      <div
        data-testid="result-count-slot"
        style={{
          flex: layout.wrap ? '1 1 0' : 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: T.gapXs,
          overflow: 'hidden',
        }}
      >
        {lastRun?.error && docCount === 0 ? (
          <span data-testid="result-count-failed" style={{ color: T.redText, fontWeight: 600 }}>
            Query failed
          </span>
        ) : docCount !== null ? (
          <>
            <span
              title={countForm === 'full' ? undefined : countDetail}
              style={{ flex: '0 0 auto', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {countForm === 'full' && (
                <>
                  <CountFigure stale={isStale}>{totalLabel}</CountFigure> results
                  {duration !== null && (
                    <>
                      {' · '}
                      <CountFigure>{duration}</CountFigure> ms
                    </>
                  )}
                  {/* An empty page has no range: "1–0" reads as a bug. */}
                  {' · '}
                  <span>{rangeLabel ? `showing ${rangeLabel}` : 'nothing to show'}</span>
                </>
              )}
              {countForm === 'range' && (
                rangeLabel ? (
                  <>
                    <CountFigure stale={isStale}>{rangeLabel}</CountFigure> of {totalLabel}
                  </>
                ) : (
                  <>
                    <CountFigure stale={isStale}>{totalLabel}</CountFigure> results
                  </>
                )
              )}
              {/* Short of room, a stale count spends it on "not current", not the noun. */}
              {countForm === 'total' && (
                <>
                  <CountFigure stale={isStale}>{totalLabel}</CountFigure>
                  {!isStale && ' results'}
                </>
              )}
            </span>
            {/* Plain text, not a live region: the QueryBar's `role="alert"`
                already announces the reason, and two announcements for one
                keystroke is worse than none. This gives way before the number
                does, because the number is what the bar is for. */}
            {isStale && (
              <span
                data-testid="result-count-stale"
                title="The query above has changed and cannot run as written"
                style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: T.warn, fontWeight: 600 }}
              >
                · not current
              </span>
            )}
            {limitChip !== null && (
              <>
                <span style={{ flexShrink: 0 }}>·</span>
                <span
                  data-testid="result-limit-cap"
                  title={LIMIT_EXPLANATION}
                  style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {limitChip}
                </span>
              </>
            )}
          </>
        ) : isReadOnly ? (
          <span style={{ color: T.textMuted }}>No run yet</span>
        ) : layout.count === 'full' ? (
          <Tooltip label={runProblem ?? 'Run (Cmd+Enter)'} withArrow>
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              leftSection={I.play}
              onClick={() => canRunHere && actions.run()}
              disabled={!canRunHere}
              data-testid="resultbar-run-cta"
            >
              Run (Cmd+Enter)
            </Button>
          </Tooltip>
        ) : (
          <Tooltip label={runProblem ?? 'Run (Cmd+Enter)'} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={26}
              onClick={() => canRunHere && actions.run()}
              disabled={!canRunHere}
              data-testid="resultbar-run-cta"
              aria-label="Run (Cmd+Enter)"
            >
              {I.play}
            </ActionIcon>
          </Tooltip>
        )}

        {planLabel !== null && layout.planBadge && (
          <UnstyledButton
            type="button"
            data-testid="plan-badge"
            aria-label={`Query plan: ${planLabel}${isStale ? ' (not current)' : ''}`}
            title={planLabel}
            onClick={() => setPlanOpen(true)}
            style={{
              fontSize: T.fsXs,
              padding: '1px 6px',
              flex: '0 1 auto',
              minWidth: 44,
              maxWidth: 140,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              borderRadius: T.rs,
              ...(isStale
                ? { background: T.surface, color: T.textGhost, border: `1px solid ${T.border}` }
                : planSummary?.collscan
                  ? { background: T.warnSoft, color: T.warnText, border: `1px solid ${T.warnBorder}` }
                  : { background: T.surfaceRaised, color: T.text, border: `1px solid ${T.border}` }),
            }}
          >
            {planLabel}
          </UnstyledButton>
        )}
      </div>

      <Group gap={layout.iconControls ? 6 : 8} wrap="nowrap" style={{ flexShrink: 0 }}>
        {/* Fields control — one control for all three views; each view reads
            the same per-tab `columnConfig`. */}
        <FieldsControl iconOnly={layout.iconControls} />

        {/* Insert — primary create action, moved here from the header so it
            sits with the other document-level controls. Same handler as
            before (`actions.openInsert`, wired to `useDocumentDialogs`'s
            `openInsertModal`); the aria-label is unchanged so existing e2e
            selectors looking for `/Insert document/` still match. Hidden for
            read-only consumers (ScriptTab's snapshot provider), same as the
            Documents menu below. */}
        {!isReadOnly && !isView && (
          <Tooltip label="Insert a new document into this collection" withArrow>
            {layout.iconControls ? (
              <ActionIcon variant="filled" size={26} onClick={() => actions.openInsert()} aria-label="Insert document">
                {I.plus}
              </ActionIcon>
            ) : (
              <Button
                variant="filled"
                size="compact-xs"
                leftSection={I.plus}
                onClick={() => actions.openInsert()}
                aria-label="Insert document"
              >
                Insert
              </Button>
            )}
          </Tooltip>
        )}

        {/* Document-level actions — bulk/destructive operations on the result
            set. A labelled menu rather than a bare overflow icon: this is the
            shared home for document actions (update all matching, delete all
            matching, export, import), so it needs a name a
            user can point at, not just a dots glyph next to the view switch.
            Placed left of the view switch, not beside it, so a destructive item
            doesn't share a hover target with a benign view-mode toggle. Hidden
            for read-only consumers (ScriptTab's snapshot provider) so there's
            nothing to short-circuit at the leaf. */}
        {!isReadOnly && (
          <Menu position="bottom-end" shadow="md" width={210}>
            <Tooltip label="Documents: update, export, import, delete" withArrow disabled={!layout.iconControls}>
              <Menu.Target>
                {layout.iconControls ? (
                  <ActionIcon variant="default" size={26} aria-label="Documents">
                    {I.doc}
                  </ActionIcon>
                ) : (
                  <Button variant="default" size="compact-xs" rightSection={I.chevD}>
                    Documents
                  </Button>
                )}
              </Menu.Target>
            </Tooltip>
            <Menu.Dropdown>
              {!isView && (
                <Menu.Item
                  leftSection={I.edit}
                  onClick={() => actions.openUpdateAll()}
                >
                  Update all matching…
                </Menu.Item>
              )}
              <Menu.Item
                leftSection={I.download}
                disabled={docCount === null || docCount === 0}
                onClick={() => setExportOpen(true)}
              >
                Export…
              </Menu.Item>
              {!isView && (
                <Menu.Item
                  leftSection={I.upload}
                  onClick={() => setImportOpen(true)}
                >
                  Import documents…
                </Menu.Item>
              )}
              {!isView && (
                <Menu.Item
                  color="red"
                  leftSection={I.trash}
                  onClick={() => actions.openDeleteAll()}
                >
                  Delete all matching…
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        )}

        {planOpen && (
          <ExplainDrawer
            onClose={() => setPlanOpen(false)}
            initialPlan={lastRun?.plan}
            initialVerbosity="queryPlanner"
            runExplain={runExplain}
            stale={isStale}
            // A suggestion built from the query now on screen would not be about
            // the plan being read.
            onCreateIndex={isStale ? undefined : onCreateIndex}
          />
        )}

        {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
        {importOpen && (
          <ImportDialog
            connectionId={meta.connectionId}
            dbName={meta.dbName}
            collection={meta.collection}
            onClose={() => setImportOpen(false)}
            onImported={(report) => {
              if (report.inserted > 0) actions.run();
            }}
            onPartialImport={() => actions.run()}
          />
        )}

        {/* View switch */}
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => actions.patch({ view: v as ResultViewMode })}
          data={VIEWS.map((v) => ({ label: v, value: v }))}
          style={{ flexShrink: 0 }}
        />
      </Group>
    </Group>
  );
}

function CountFigure({ stale = false, children }: { stale?: boolean; children: React.ReactNode }) {
  const T = themeVars;
  return <strong style={{ color: stale ? T.textGhost : T.text, fontWeight: 600 }}>{children}</strong>;
}
