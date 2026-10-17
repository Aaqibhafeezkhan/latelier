import React, { memo } from 'react';
import { Badge, Button, Group, Menu, Tooltip, VisuallyHidden } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { isEjsonDocument } from '../../utils/ejson';
import { useShellSyntaxField } from './useShellSyntaxField';
import { useFindExplain } from './useFindExplain';
import {
  filterProblem,
  findProblem,
  limitWarning,
  projectionProblem,
  sortProblem,
} from './builder';
import type { SuggestionContext } from '../../features/fieldSuggestions/types';
import { FieldAutocompleteInput } from '../../features/fieldSuggestions/FieldAutocompleteInput';
import { useTextareaAutocomplete } from '../../features/fieldSuggestions/useTextareaAutocomplete';
import { useCollectionWorkspace } from './context';
import { ExplainDrawer } from './Aggregation/ExplainDrawer';
import { QueryExpandModal } from './QueryExpandModal';
import { LIMIT_EXPLANATION } from './queryCaps';
import type { CollectionTabState, ExplainVerbosity } from '@shared/types';

interface QueryBarProps {
  suggestionContext: SuggestionContext | null;
  /**
   * Receives the Documents view's ⌘/Ctrl+Enter action. The key is
   * bound once, on `PanelBody`'s panel group, so it reaches every focus in
   * the view (a result row after a drag into the drawer, sort, limit);
   * what it does lives here, beside the drafts it has to flush first.
   */
  runShortcutRef?: React.Ref<() => void>;
}

/**
 * Why Run refuses `s`, or null when it would run. One copy for the Run
 * tooltip and the refused-⌘↵ line, so the two can't drift.
 */
function runBlockReason(s: CollectionTabState): string | null {
  if (filterProblem(s.queryRaw) !== null) return 'Invalid MQL';
  if (sortProblem(s.builder.sort) !== null) return 'Invalid sort';
  if (projectionProblem(s.builder) !== null) return 'Invalid projection';
  return null;
}

// W15 §4.4 — one copy, referenced by both the Tooltip (mouse, and now
// keyboard focus) and the visually-hidden element `skip` is described by. Two
// copies of a sentence like this drift the first time someone edits one.
const SKIP_EXPLANATION = 'Skip is driven by the page selector below the results';

/**
 * Inline `role="alert"` strip — the same treatment the filter tree gives an
 * unprintable row (`BuilderPane.tsx:446`). A full-width strip rather than a
 * cell sibling: every one of these messages is longer than the 1fr track.
 */
function Notice({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <div
      id={id}
      role="alert"
      style={{
        padding: '3px 12px 4px',
        fontSize: 10,
        lineHeight: 1.3,
        color: themeVars.warn,
        background: themeVars.surface,
        borderTop: `1px solid ${themeVars.border}`,
      }}
    >
      {children}
    </div>
  );
}

function QueryBarInner({
  suggestionContext,
  runShortcutRef,
}: QueryBarProps) {
  const T = themeVars;
  const { state, actions, meta } = useCollectionWorkspace();
  const isLoading = meta.isLoading;
  const onPatch = actions.patch;
  const onRun = actions.run;
  const onCancel = actions.cancel;
  const onSave = actions.openSave;
  // the Recent list lives in the builder pane, which is unmounted
  // while collapsed. Switching its tab without making it visible is a click
  // that appears to do nothing.
  const onHistory = React.useCallback(() => {
    actions.expandBuilder?.();
    actions.patch({ activeBuilderTab: 'Recent' });
  }, [actions]);
  const queryRaw = state.queryRaw;

  // W13 — the sync pill / "Re-sync builder" / "Accept builder" machinery is
  // gone: the drawer is a view of `queryRaw`, not a competing compiled
  // filter to reconcile against, so the bar only needs to know whether the
  // current text is runnable.
  // A filter must be a *document*, not merely parseable EJSON — `[1,2]` and
  // `null` parse, and main refuses them. One rule with
  // `currentFilterJson` and `findProblem`.
  const isValid = React.useMemo(() => isEjsonDocument(queryRaw), [queryRaw]);

  // W15 §3.1 — sort used to reach `QueryService.find` unvalidated and
  // come back as a `VALIDATION` pill after a round trip, one row below a
  // filter gated client-side. `sortProblem` is shared with `useQueryRunner`'s
  // guard so the button and the runner can't drift onto two rules.
  const sortError = React.useMemo(() => sortProblem(state.builder.sort), [state.builder.sort]);
  const limitError = React.useMemo(
    () => limitWarning(state.builder.limit),
    [state.builder.limit],
  );

  // W13 §7 — Run's enabled rule collapses to `isEjsonDocument(queryRaw)`. The
  // fail-open hazard can't recur through this button: `queryRaw` is the single
  // source of truth for the filter, and any op the old builder couldn't
  // compile (`$elemMatch`, `$text`, ...) is now a raw node the filter-tree
  // printer encodes losslessly — there's no more "compiles to a mangled
  // clause" state to guard against.
  // §3.1 folds the sort in: an unparseable sort is refused here rather than
  // by the main process. `limitError` deliberately does *not* gate — a
  // coerced limit still runs, it just has to say what it runs as (§4.1).
  //
  // The three-way conjunction collapses into `findProblem`, which is the
  // same three gates in the same order and so the same boolean — this swap is
  // deliberately an equivalent mutation, and no test can tell it from the
  // conjunction it replaced. It earns its place structurally, not
  // behaviourally: Copy code needs the *reason* rather than the verdict, and
  // a second place computing "is this query runnable" is exactly what §3.1
  // exists to prevent, so the button and the copy path read one function.
  // `sortError` stays — it is the inline per-field
  // message, which is a different question from whether Run is enabled.
  const canRun = !isLoading && findProblem(state) === null;
  // Explain calls `api.query.explain` directly — it does NOT go through
  // `useQueryRunner.run`, but W13 collapses its rule to the same one:
  // `queryRaw` is the only filter source now, so Explain needs nothing
  // stricter than Run.
  const canExplain = canRun;

  const [expandOpen, setExpandOpen] = React.useState(false);
  const [explainOpen, setExplainOpen] = React.useState(false);
  const [explainVerbosity, setExplainVerbosity] =
    React.useState<ExplainVerbosity>('queryPlanner');

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const autocomplete = useTextareaAutocomplete({
    textareaRef,
    suggestionContext,
    stageOp: '$match',
    onReplace: (next) => onPatch({ queryRaw: next }),
  });

  // X14 §2 — Shell Syntax becomes Canonical EJSON on blur, in the box the
  // user typed it in. Not per keystroke: a per-keystroke rewrite fights the
  // user mid-word. The seam patches only for a real repair, so text that
  // already parses strictly is byte-identical afterwards — spacing and key
  // order untouched — and a failed transform leaves the text as typed with
  // the Run gate still closed.
  //
  // Safe to compose with the autocomplete's own blur: the suggestion popover
  // preventDefaults its `onMouseDown` (`SuggestionPopover.tsx:152`), so
  // picking a suggestion never blurs the textarea in the first place.
  //
  // X14 §5 — `thenCheck: filterProblem` is the document rule, applied after the
  // transform's own refusal and never collapsed into the same sentence — the
  // hook's own ordering rule. The message is held in state and set at the
  // conversion point, not derived per keystroke: `Notice` is a `role="alert"`,
  // and a derived one would announce a half-typed `{age:` on every character.
  const filterField = useShellSyntaxField({
    value: queryRaw,
    commit: (next) => onPatch({ queryRaw: next }),
    thenCheck: filterProblem,
  });

  const handleBlur = () => {
    autocomplete.onBlur();
    filterField.onBlur();
  };

  // X14 — Explain reads through the repair, like every other surface.
  //
  // These live below `filterField` rather than beside `canExplain` because
  // they call it, and a hook argument is evaluated during render — naming it
  // earlier is a temporal-dead-zone throw, not a lint nit.
  //
  // **The repair cannot fire here today, and that is the point.** `canExplain`
  // is `canRun`, which refuses anything `isEjsonDocument` refuses, and the
  // transform returns `unchanged` for everything `JSON.parse` already accepts.
  // So the two sets do not overlap: by the time Explain is reachable, the text
  // is strict and the repair is a no-op. What this buys is that Explain no
  // longer *depends* on that being true — the aggregation side repairs on its
  // Run and Explain paths, and the one read surface that did not was
  // the odd one out waiting for the gate to change under it.
  const onExplain = (verbosity: ExplainVerbosity) => {
    const { text, outcome } = filterField.commitNow();
    if (outcome.kind === 'failed') return;
    if (findProblem({ ...state, queryRaw: text }) !== null || isLoading) return;
    setExplainVerbosity(verbosity);
    setExplainOpen(true);
  };

  // The fetcher and the create-index handoff are shared with the result bar's
  // plan badge. The filter is read through the repair, never the raw text.
  const { runExplain: runQueryExplain, onCreateIndex } = useFindExplain(
    () => filterField.commitNow().text,
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onPatch({ queryRaw: e.target.value });
    // Stale complaint while the user is already fixing it; the next blur or
    // ⌘↵ re-asks. This is also X14 §5's "the message clears when the input
    // becomes runnable again".
    filterField.onChange(e.target.value);
    autocomplete.probe();
  };

  // X14 §3 — the sort field's half, same glue and same conversion
  // point as the filter bar. The transform runs first and `sortProblem` then
  // judges the repaired text, which is the whole of the ordering rule:
  // `{name: 1}` becomes `{"name": 1}` and passes, while `[1, 2]` is already
  // valid JSON, so the transform returns `unchanged` and the shape refusal
  // still fires with its own message rather than the parse one.
  //
  // Blank needs no special case: the transform reports empty input as
  // `failed`, the hook then commits nothing, and `sortProblem`'s own blank
  // check ahead of it still reads "no sort".
  //
  // X14 §5 — no `then` here: the shape check (`sortError`, below) is a
  // separate memo and the two are OR'd in JSX rather than combined into one
  // hook-owned refusal — `sortProblem`'s "must be a document" and the
  // transform's own reason name different fixes.
  const sortField = useShellSyntaxField({
    value: state.builder.sort,
    commit: (next) => onPatch({ builder: { ...state.builder, sort: next } }),
  });
  const handleSortChange = (v: string) => {
    onPatch({ builder: { ...state.builder, sort: v } });
    sortField.onChange(v);
  };
  const handleSortBlur = () => {
    sortField.onBlur();
  };
  const handleLimitChange = (v: string) => {
    onPatch({ builder: { ...state.builder, limit: v } });
  };

  // The Documents view's ⌘/Ctrl+Enter. No blur has run when a key
  // is pressed, so every draft is repaired before the gate, never after it:
  // gating the raw text would refuse `{age: {$gt: 60}}` or a `{name: 1}` sort
  // that the Run button (whose click blurs first) accepts. Patches land
  // async, so the repaired values also ride along as the `run` override.
  //
  // A refused press is named on `runBlocked`'s line — unless this very
  // press raised the filter Notice (`commitNow` set it just now), which
  // already says why; a second `role="alert"` would say it twice. A Notice
  // that was already on screen is not re-announced, so it does not count.
  // `seq` remounts the line on every refused press so a repeat press is
  // announced again. The line lasts until the query changes (keyed on the
  // exact values it judged) or the tab switches.
  //
  // The projection is not settled here: its draft lives in the Fields
  // control, whose dropdown is a dialog the panel-level ⌘↵ skips, so the
  // control runs its own ⌘↵ with the draft settled.
  const [runBlocked, setRunBlocked] = React.useState<{
    reason: string;
    queryRaw: string;
    builder: CollectionTabState['builder'];
    seq: number;
  } | null>(null);
  const runFromShortcut = () => {
    if (isLoading) return;
    const hadFilterNotice = filterField.refusal !== null;
    const filter = filterField.commitNow();
    const sort = sortField.repairNow();
    const builder =
      sort.text === state.builder.sort ? state.builder : { ...state.builder, sort: sort.text };
    if (builder !== state.builder) onPatch({ builder });
    const reason = runBlockReason({ ...state, queryRaw: filter.text, builder });
    if (reason === null) {
      setRunBlocked(null);
      onRun({ queryRaw: filter.text, builder });
      return;
    }
    const freshNotice = filterProblem(filter.text) !== null && !hadFilterNotice;
    setRunBlocked((prev) =>
      freshNotice ? null : { reason, queryRaw: filter.text, builder, seq: (prev?.seq ?? 0) + 1 },
    );
  };
  React.useImperativeHandle(runShortcutRef, () => runFromShortcut);
  const blocked =
    runBlocked?.queryRaw === state.queryRaw && runBlocked.builder === state.builder
      ? runBlocked
      : null;

  const skipValue = state.page * state.pageSize;
  const runError = state.lastRun?.error;

  // Advanced rows (sort/skip/limit) are hidden by default and
  // expand from the QUERY row's chevron. The row opens automatically when the
  // builder already has any advanced value set, so users editing an existing
  // saved query don't get a "where did my sort go?" moment.
  // A count rather than a bare boolean — W14 §2 renders "n set" on the
  // collapsed trigger. Projection is not counted: it lives in the Fields
  // control, which carries its own badge (W14 §4).
  const advancedCount =
    (state.builder.sort.trim() !== '' ? 1 : 0) +
    (state.builder.limit.trim() !== '' ? 1 : 0);
  const hasAdvanced = advancedCount > 0;
  // The sort and limit notices render inside the advanced region, so a
  // collapsed row would hide the reason Run is disabled (a sort that cannot
  // parse) or that the limit is coerced. The same two conditions the notices
  // use are counted here so the collapsed badge can say so (W14 §2).
  const advancedProblems =
    ((sortField.refusal ?? sortError) !== null ? 1 : 0) + (limitError !== null ? 1 : 0);

  // W14 §1 — `useState(hasAdvanced)` alone froze the row at whatever
  // the first tab looked like: QueryBar has no `key` at its mount site and
  // never remounts. Resync during render (React's "adjust state when a prop
  // changes"), deliberately asymmetric:
  //   - tab switch (`tabId` changes)  → re-derive in both directions;
  //   - same tab, hasAdvanced false→true (a Saved/Recent load, a quick-sort
  //     from the table header) → open;
  //   - same tab, true→false → leave it alone.
  // The last rule is the point: a symmetric resync would yank the row shut
  // under a user who just deleted the last character of `sort`, and a bare
  // `useEffect(() => setAdvancedOpen(hasAdvanced))` would fight every toggle.
  // No `key` is used, so nothing here remounts QueryBar.
  const [advancedOpen, setAdvancedOpen] = React.useState(hasAdvanced);
  const [advancedSync, setAdvancedSync] = React.useState({
    tabId: meta.tabId,
    hasAdvanced,
  });
  if (advancedSync.tabId !== meta.tabId) {
    setAdvancedSync({ tabId: meta.tabId, hasAdvanced });
    setAdvancedOpen(hasAdvanced);
    // X14 §5 — the held messages are QueryBar-local and QueryBar never
    // remounts, so tab A's complaint would
    // otherwise sit under tab B's query. `onChange`'s argument is unused by
    // the hook — this leans on it purely for the clear.
    filterField.onChange('');
    sortField.onChange('');
    setRunBlocked(null);
  } else if (advancedSync.hasAdvanced !== hasAdvanced) {
    setAdvancedSync({ tabId: meta.tabId, hasAdvanced });
    if (hasAdvanced) setAdvancedOpen(true);
  }
  const toggleAdvanced = () => setAdvancedOpen((o) => !o);

  // Shared cell styles for the 4-column grid below the toolbar. The label
  // cells are a slightly raised background to read as "row headers" the way
  // the screenshot mockup does it.
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '120px 1fr 64px 152px',
    borderTop: `1px solid ${T.border}`,
  };
  const labelCellStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    background: T.surfaceRaised,
    borderRight: `1px solid ${T.border}`,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: T.textMuted,
  };
  const valueCellStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '0 10px',
    background: T.surface,
    borderRight: `1px solid ${T.border}`,
    minHeight: 30,
  };
  const valueCellLast: React.CSSProperties = {
    ...valueCellStyle,
    borderRight: 'none',
  };
  const cellInputStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 11,
    padding: '4px 0',
    border: 'none',
    background: 'transparent',
    color: T.text,
    outline: 'none',
  };

  return (
    <div
      style={{
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
      }}
    >
      {/* Top toolbar — Save · History · Run (split). W15 §7.1 deletes
          "Set default": it wrote `query.default.<conn>.<db>.<coll>` and
          nothing anywhere read it back. Saved queries already own "reuse this
          query on this collection". This is now the one Save button in the
          Documents view — the builder-drawer footer's copy was deleted, and
          `saved.create`'s hint anchor moved here with it. */}
      <Group gap={8} wrap="nowrap" style={{ padding: '8px 12px' }}>
        <Button
          data-hint-anchor="saved.create"
          variant="default"
          size="compact-xs"
          leftSection={I.save}
          onClick={onSave}
        >
          Save
        </Button>
        <Button variant="default" size="compact-xs" leftSection={I.clock} onClick={onHistory}>
          History
        </Button>
        {/* Run sits at the right end, beside the drawer, so the
            pointer's trip from a builder row to Run is short. */}
        <span style={{ flex: 1 }} />
        <span
          aria-hidden="true"
          style={{
            width: 1,
            alignSelf: 'stretch',
            background: T.border,
            margin: '0 2px',
          }}
        />

        <Button.Group>
          {isLoading ? (
            <Tooltip label="Cancel" withArrow>
              <Button
                variant="outline"
                color="red"
                size="compact-xs"
                onClick={onCancel}
                data-testid="query-cancel-btn"
              >
                Cancel
              </Button>
            </Tooltip>
          ) : (
            <Tooltip
              label={runBlockReason(state) ?? 'Run (Cmd+Enter)'}
              withArrow
            >
              <Button
                variant="filled"
                size="compact-xs"
                onClick={() => canRun && onRun()}
                disabled={!canRun}
                data-testid="query-run-btn"
                data-hint-anchor="run.execute"
                leftSection={I.play}
                styles={{ root: { fontWeight: 700 } }}
              >
                Run
              </Button>
            </Tooltip>
          )}
          <Menu position="bottom-end" shadow="md" width={190}>
            <Menu.Target>
              <Tooltip label="Run options" withArrow>
                <Button
                  variant="filled"
                  size="compact-xs"
                  disabled={!canRun}
                  aria-label="Run options"
                  data-testid="query-run-options-btn"
                  px={6}
                >
                  {I.chevD}
                </Button>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={I.play} onClick={() => canRun && onRun()}>
                Run
              </Menu.Item>
              <Menu.Divider />
              <Menu.Label>Explain</Menu.Label>
              <Menu.Item
                leftSection={I.eye}
                disabled={!canExplain}
                onClick={() => onExplain('queryPlanner')}
              >
                queryPlanner
              </Menu.Item>
              <Menu.Item
                leftSection={I.eye}
                disabled={!canExplain}
                onClick={() => onExplain('executionStats')}
              >
                executionStats
              </Menu.Item>
              <Menu.Item
                leftSection={I.eye}
                disabled={!canExplain}
                onClick={() => onExplain('allPlansExecution')}
              >
                allPlansExecution
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Button.Group>
      </Group>

      {/* QUERY row — collapsible header + editable filter textarea. W13
          deletes the sync pill / "Re-sync builder" / "Accept builder" /
          "Builder disabled" column that used to sit to the right: the Filter
          drawer is a view of this same text now, not a competing compiled
          filter to reconcile against, so there's nothing left to show here. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr',
          borderTop: `1px solid ${T.border}`,
        }}
      >
        <Tooltip
          label={advancedOpen ? 'Hide advanced options' : 'Show advanced options'}
          withArrow
        >
          <div
            role="button"
            tabIndex={0}
            // W15 §5 — a styled `<div role="button">` inherits no
            // focus ring of its own, and `:focus-visible` can't be expressed
            // in the inline styles everything else here uses. The rule lives
            // in `src/index.css`; the e2e keyboard-focuses this element and
            // reads the computed outline back, which is what closes the item
            // W14 §2 left open ("verified, not assumed").
            className="focus-ring"
            onClick={toggleAdvanced}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleAdvanced();
              }
            }}
            aria-expanded={advancedOpen}
            aria-controls="query-bar-advanced"
            style={{
              ...labelCellStyle,
              cursor: 'pointer',
              // The 120px track fits chevron + QUERY with ~35px to spare;
              // trim the right padding only while the badge is showing, so
              // it never sits beside the expanded label cells below.
              paddingRight: !advancedOpen && hasAdvanced ? 6 : undefined,
              // "2 set · 2 errors" is wider than the room left beside QUERY
              // in the 120px track, so the badge drops to its own line
              // rather than spilling under the filter cell.
              ...(!advancedOpen && hasAdvanced && advancedProblems > 0
                ? { flexWrap: 'wrap', rowGap: 2, paddingTop: 3, paddingBottom: 3 }
                : null),
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                marginRight: 6,
                color: T.textGhost,
                transform: advancedOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 120ms ease',
              }}
            >
              {I.chevD}
            </span>
            <span style={{ color: T.accent }}>query</span>
            {/* W14 §2 — collapsed, the row gave no non-hover sign that
                sort / limit were set. A count rather than the dot
                43ee030 shipped and 7a21468 reverted: it survives monochrome
                and states the fact. Decoration only — a Badge is a plain div,
                so it isn't focusable and its clicks bubble to the trigger. */}
            {!advancedOpen && hasAdvanced && (
              <Badge
                size="xs"
                variant="light"
                color={advancedProblems > 0 ? T.warn : T.accent}
                style={{ marginLeft: 'auto', flexShrink: 0 }}
              >
                {advancedCount} set
                {advancedProblems > 0 &&
                  ` · ${advancedProblems} ${advancedProblems === 1 ? 'error' : 'errors'}`}
              </Badge>
            )}
          </div>
        </Tooltip>
        <div style={{ ...valueCellStyle, padding: '0 4px' }}>
          <textarea
            ref={textareaRef}
            value={queryRaw}
            onChange={handleChange}
            onKeyUp={autocomplete.probe}
            onClick={autocomplete.probe}
            onFocus={autocomplete.probe}
            onBlur={handleBlur}
            spellCheck={false}
            data-testid="query-bar-input"
            // X14 §5 — the textarea had neither, so the one control that
            // most often refuses input was the only one whose complaint never
            // reached a screen reader. Same wiring as the sort and limit
            // inputs below (W15 §5).
            aria-invalid={filterField.refusal !== null}
            aria-describedby={filterField.refusal ? 'query-bar-filter-error' : undefined}
            placeholder="{}"
            style={{
              flex: 1,
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12,
              padding: '6px 8px',
              border: 'none',
              borderBottom: `1px solid ${
                !isValid && queryRaw !== '{}' ? T.warn : 'transparent'
              }`,
              background: 'transparent',
              color: T.text,
              resize: 'vertical',
              minHeight: 28,
              maxHeight: 240,
              outline: 'none',
              lineHeight: 1.5,
            }}
            rows={1}
          />
          <Tooltip label="Expand" withArrow>
            <Button
              variant="subtle"
              size="compact-xs"
              px={4}
              onClick={() => setExpandOpen(true)}
              aria-label="Expand query filter"
              data-testid="query-bar-expand-btn"
              style={{ flexShrink: 0, alignSelf: 'flex-start', marginTop: 4 }}
            >
              {I.expand}
            </Button>
          </Tooltip>
          {autocomplete.popover}
        </div>
      </div>

      {filterField.refusal && <Notice id="query-bar-filter-error">{filterField.refusal}</Notice>}

      {advancedOpen && (
      <div id="query-bar-advanced">
      {/* SORT row — the full width, since a multi-field sort is the longest
          value here. Projection is not in this row: it lives in the Fields
          control, beside the display-only toggles (W14 §4). */}
      <div style={{ ...gridStyle, gridTemplateColumns: '120px 1fr' }}>
        {/* W15 §5 — these label cells were the only thing naming the
            inputs, and only visually. Giving them `id`s and pointing
            `aria-labelledby` at them names each input off the exact text on
            screen; an `aria-label` duplicate would be a second copy to keep
            in sync. */}
        <div id="query-bar-sort-label" style={labelCellStyle}>sort</div>
        <div style={valueCellLast}>
          <FieldAutocompleteInput
            value={state.builder.sort}
            onChange={handleSortChange}
            context={suggestionContext}
            mode="token"
            onBlur={handleSortBlur}
            placeholder='{"_id":-1}'
            dataTestid="query-bar-sort"
            ariaLabelledBy="query-bar-sort-label"
            ariaInvalid={(sortField.refusal ?? sortError) !== null}
            ariaDescribedBy={(sortField.refusal ?? sortError) ? 'query-bar-sort-error' : undefined}
            style={{
              ...cellInputStyle,
              borderBottom: `1px solid ${sortError ? T.warn : 'transparent'}`,
            }}
          />
        </div>
      </div>

      {(sortField.refusal ?? sortError) && (
        <Notice id="query-bar-sort-error">{sortField.refusal ?? sortError}</Notice>
      )}

      {/* SKIP + LIMIT row */}
      <div style={gridStyle}>
        <div id="query-bar-skip-label" style={labelCellStyle}>skip</div>
        <div style={valueCellStyle}>
          {/* W15 §4.4 — was a Tooltip on a non-focusable `<span>`, so
              the one sentence explaining why this cell ignores typing reached
              a hovering mouse and nobody else. Three changes, all needed:
              a read-only `<input>` (native, focusable, nameable — a `<span>`
              has no role that takes an accessible name), `events.focus` so
              the Tooltip fires for a keyboard user (Mantine's default is
              hover-only), and `aria-describedby` → a visually-hidden copy so
              a screen reader gets the reason without a Tooltip at all. */}
          <Tooltip
            label={SKIP_EXPLANATION}
            withArrow
            events={{ hover: true, focus: true, touch: false }}
          >
            <input
              type="text"
              readOnly
              value={skipValue}
              aria-labelledby="query-bar-skip-label"
              aria-describedby="query-bar-skip-help"
              data-testid="query-bar-skip"
              style={{
                ...cellInputStyle,
                color: T.textMuted,
                cursor: 'default',
              }}
            />
          </Tooltip>
          <VisuallyHidden id="query-bar-skip-help">{SKIP_EXPLANATION}</VisuallyHidden>
        </div>
        <div id="query-bar-limit-label" style={labelCellStyle}>limit</div>
        <div style={valueCellLast}>
          {/* Same pattern as skip above: the Tooltip serves hover and focus,
              the visually-hidden copy serves a screen reader. */}
          <Tooltip
            label={LIMIT_EXPLANATION}
            withArrow
            events={{ hover: true, focus: true, touch: false }}
          >
            <input
              type="number"
              min={1}
              value={state.builder.limit}
              onChange={(e) => handleLimitChange(e.target.value)}
              placeholder="—"
              data-testid="query-bar-limit"
              aria-labelledby="query-bar-limit-label"
              aria-invalid={limitError !== null}
              aria-describedby={
                limitError ? 'query-bar-limit-error query-bar-limit-help' : 'query-bar-limit-help'
              }
              style={{
                ...cellInputStyle,
                borderBottom: `1px solid ${limitError ? T.warn : 'transparent'}`,
              }}
            />
          </Tooltip>
          <VisuallyHidden id="query-bar-limit-help">{LIMIT_EXPLANATION}</VisuallyHidden>
        </div>
      </div>

      {limitError && <Notice id="query-bar-limit-error">{limitError}</Notice>}
      </div>
      )}

      {blocked && (
        <Notice key={blocked.seq} id="query-bar-run-blocked">Not run: {blocked.reason}</Notice>
      )}

      {runError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 12px 6px',
            fontSize: 11,
            color: T.textMuted,
            borderTop: `1px solid ${T.border}`,
          }}
        >
          <span
            role="alert"
            style={{
              color: T.redText,
              padding: '1px 7px',
              borderRadius: T.rx,
              background: T.redSoft,
              border: `1px solid ${T.redBorder}`,
            }}
          >
            {runError.code}: {runError.message}
          </span>
        </div>
      )}

      {expandOpen && (
        <QueryExpandModal
          queryRaw={queryRaw}
          onApply={(next) => {
            onPatch({ queryRaw: next });
            filterField.onChange(next);
          }}
          onClose={() => setExpandOpen(false)}
        />
      )}

      {explainOpen && (
        <ExplainDrawer
          onClose={() => setExplainOpen(false)}
          initialVerbosity={explainVerbosity}
          runExplain={runQueryExplain}
          onCreateIndex={onCreateIndex}
        />
      )}
    </div>
  );
}

export const QueryBar = memo(QueryBarInner);
