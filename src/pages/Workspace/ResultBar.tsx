import React from 'react';
import { ActionIcon, Button, Group, Menu, Select, SegmentedControl, Tooltip, UnstyledButton } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
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
  // that ran, not the text now in the box.
  const planSummary = summarizeExplain(lastRun?.plan);
  const planLabel = planSummary?.collscan
    ? 'no index'
    : planSummary?.usesIndex
      ? (planSummary.indexName ?? 'index')
      : null;
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
      gap={10}
      wrap="nowrap"
      style={{
        padding: '4px 14px',
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
        fontSize: 11,
        color: T.textMuted,
        // None of this row's own text (page number, result counts, ms,
        // range) sets its own `white-space`, so a tight flex squeeze can
        // wrap any one span onto a second line instead of shrinking a
        // neighbour. That grows this bar's own height, which — one flex
        // column up — shrinks the table's available height under its
        // virtualized list, turning a cosmetic width squeeze into a
        // scroll-settle bug several layers away (a virtualized row landing
        // a sub-pixel short of fully in view because its scroll container
        // is fractionally shorter than the settle math expects). Setting it
        // once here, inherited by every descendant, keeps this row's height
        // independent of how tight the available width gets, rather than
        // chasing it span by span.
        whiteSpace: 'nowrap',
      }}
    >
      {/* Pager — first · prev · P/T · next · last */}
      <Group gap={2} wrap="nowrap">
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
        <span style={{ padding: '0 6px', color: T.text, fontVariantNumeric: 'tabular-nums' }}>
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
        style={{ width: 62, flexShrink: 0 }}
      />

      {/* Counts + range */}
      <Group gap={6} wrap="nowrap">
        {docCount !== null ? (
          <>
            <span style={{ color: T.textGhost }}>·</span>
            <span>
              <strong
                style={{ color: isStale ? T.textGhost : T.text, fontWeight: 600 }}
              >
                {totalCount !== undefined ? totalCount.toLocaleString() : docCount.toLocaleString()}
                {hasMore && totalCount === undefined ? '+' : ''}
              </strong>{' '}
              results
            </span>
            {/* Plain text, not a live region: the QueryBar's `role="alert"`
                already announces the reason, and two announcements for one
                keystroke is worse than none. */}
            {isStale && (
              <span
                data-testid="result-count-stale"
                style={{ color: T.warn, fontWeight: 600 }}
              >
                (not current — fix the query above)
              </span>
            )}
            {limitChip !== null && (
              <>
                <span>·</span>
                <span data-testid="result-limit-cap" title={LIMIT_EXPLANATION}>
                  {limitChip}
                </span>
              </>
            )}
            {duration !== null && (
              <>
                <span>·</span>
                <span>
                  <strong style={{ color: T.text, fontWeight: 600 }}>{duration}</strong> ms
                </span>
              </>
            )}
            {start !== null && end !== null && (
              <>
                <span>·</span>
                <span>
                  showing {start.toLocaleString()}–{end.toLocaleString()}
                </span>
              </>
            )}
          </>
        ) : (
          <>
            <span style={{ color: T.textGhost }}>·</span>
            {isReadOnly ? (
              <span style={{ color: T.textMuted }}>No run yet</span>
            ) : (
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
            )}
          </>
        )}
      </Group>

      <span style={{ flex: 1 }} />

      {planLabel !== null && (
        <UnstyledButton
          type="button"
          data-testid="plan-badge"
          aria-label={`Query plan: ${planLabel}${isStale ? ' (not current)' : ''}`}
          title={planLabel}
          onClick={() => setPlanOpen(true)}
          style={{
            fontSize: 10,
            padding: '1px 6px',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 0,
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

      {/* Fields control — one control for all three views; each view reads
          the same per-tab `columnConfig`. */}
      <FieldsControl />

      {/* Insert — primary create action, moved here from the header so it
          sits with the other document-level controls. Same handler as
          before (`actions.openInsert`, wired to `useDocumentDialogs`'s
          `openInsertModal`); the aria-label is unchanged so existing e2e
          selectors looking for `/Insert document/` still match. Hidden for
          read-only consumers (ScriptTab's snapshot provider), same as the
          Documents menu below. */}
      {!isReadOnly && (
        <Tooltip label="Insert a new document into this collection" withArrow>
          <Button
            variant="filled"
            size="compact-xs"
            leftSection={I.plus}
            onClick={() => actions.openInsert()}
            aria-label="Insert document"
          >
            Insert
          </Button>
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
          <Menu.Target>
            <Button
              variant="default"
              size="compact-xs"
              rightSection={I.chevD}
            >
              Documents
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={I.edit}
              onClick={() => actions.openUpdateAll()}
            >
              Update all matching…
            </Menu.Item>
            <Menu.Item
              leftSection={I.download}
              disabled={docCount === null || docCount === 0}
              onClick={() => setExportOpen(true)}
            >
              Export…
            </Menu.Item>
            <Menu.Item
              leftSection={I.upload}
              onClick={() => setImportOpen(true)}
            >
              Import documents…
            </Menu.Item>
            <Menu.Item
              color="red"
              leftSection={I.trash}
              onClick={() => actions.openDeleteAll()}
            >
              Delete all matching…
            </Menu.Item>
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
      />
    </Group>
  );
}
