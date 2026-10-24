import React from 'react';
import { Button, Drawer } from '@mantine/core';
import { themeVars } from '../../../theme/themeVars';
import { api, getErrorMessage } from '../../../api/atelier';
import { useDialogFocusReturn } from '../../../hooks/useDialogFocusReturn';
import { ejsonStringify } from '../../../utils/ejson';
import { copyToClipboard } from '../../../utils/clipboard';
import { useLatest } from '../../../commands/useLatest';
import { summarizeExplain } from '../../../utils/explainSummary';
import { JsonTree } from './JsonTree';
import { PlanTree } from './PlanTree';
import type { ExplainVerbosity } from '@shared/types';

/** Keys visually emphasized in the plan tree — the fields the summary strip
 * above already surfaces, so a reader scanning the raw tree can still spot
 * them quickly. */
const EXPLAIN_HIGHLIGHT_KEYS = new Set([
  'winningPlan',
  'stage',
  'indexName',
  'keyPattern',
  'docsExamined',
  'totalDocsExamined',
  'totalKeysExamined',
  'nReturned',
  'executionTimeMillis',
]);

function metricChipStyle(T: typeof themeVars): React.CSSProperties {
  return {
    fontSize: 10,
    padding: '2px 6px',
    borderRadius: T.rs,
    background: T.surface,
    color: T.textMuted,
    border: `1px solid ${T.border}`,
  };
}

/** Shape every explain fetcher (find or aggregation) must resolve to. */
export interface ExplainRunResult {
  plan: unknown;
  writeStageOmitted?: boolean;
}

interface Props {
  onClose: () => void;
  /** Verbosity to run with on first open. Defaults to 'queryPlanner'. */
  initialVerbosity?: ExplainVerbosity;
  /**
   * Caller-supplied fetcher — decouples the drawer from api.agg vs
   * api.query so both Aggregation and the find QueryBar can reuse it.
   */
  runExplain: (
    verbosity: ExplainVerbosity,
    cancelToken: string,
  ) => Promise<ExplainRunResult>;
  /**
   * Optional: called (fire-and-forget) when the drawer wants to cancel an
   * in-flight explain (unmount or verbosity change). Omit if the backend
   * call has no cancellation support (find-explain doesn't today).
   */
  onCancelToken?: (cancelToken: string) => void;
  /**
   * Optional: shows "Create an index for this query" beside the COLLSCAN
   * badge. Omitted by `AggregationTab` — only a find's explain has a filter
   * `suggestIndex` can read. The caller (`QueryBar`) owns computing the
   * suggestion and routing to the Structure view; this only closes the
   * drawer and hands control back.
   */
  onCreateIndex?: () => void;
  /**
   * A plan the caller already holds (the result bar's plan badge). Shown
   * instead of fetching on open; changing the verbosity fetches as usual.
   */
  initialPlan?: unknown;
  /** The plan describes an earlier run than the query now on screen; the title says so. */
  stale?: boolean;
}

export function ExplainDrawer({
  onClose,
  initialVerbosity,
  runExplain,
  onCancelToken,
  onCreateIndex,
  initialPlan,
  stale,
}: Props) {
  const T = themeVars;
  const [verbosity, setVerbosity] = React.useState<ExplainVerbosity>(
    initialVerbosity ?? 'queryPlanner',
  );
  const [loading, setLoading] = React.useState(false);
  const [plan, setPlan] = React.useState<unknown | null>(initialPlan ?? null);
  // State, not a ref flipped inside the effect: StrictMode double-invokes the
  // effect on mount, and a ref set by the first run would let the second fetch.
  const [verbosityTouched, setVerbosityTouched] = React.useState(false);
  const [writeOmitted, setWriteOmitted] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [viewMode, setViewMode] = React.useState<'tree' | 'raw'>('tree');

  // Both `runExplain` and `onCancelToken` are stabilized through refs.
  // AggregationTab's fetcher is a `useCallback` keyed on `stages`, so its
  // identity legitimately changes as the pipeline is edited — keying the
  // effect on that identity would re-fire the explain (new token →
  // cancel-in-flight → refetch flicker/loop). `onCancelToken` currently
  // happens to be stable at both call sites (`useCallback([])` in
  // AggregationTab, `undefined` in QueryBar), but relying on callers to keep
  // it that way is fragile — an unmemoized callback would trip the same
  // refetch loop. Reading both through refs lets the effect key on
  // `verbosity` alone, which is the only value that should restart the fetch.
  // The refs themselves are listed as deps to keep exhaustive-deps clean —
  // their identity never changes across renders (same pattern as
  // AggregationTab's keyboard-shortcut effect), so this doesn't reintroduce
  // the re-fire the ref indirection exists to avoid.
  const runExplainRef = useLatest(runExplain);
  const onCancelTokenRef = useLatest(onCancelToken);

  // The drawer has nothing to save, so every close is a dismiss.
  const close = useDialogFocusReturn(onClose);

  // Fixed at mount: a re-run replacing the badge's plan (even with none, until
  // its own explain lands) while the drawer is open must not start a fetch.
  const [hasInitialPlan] = React.useState(initialPlan !== undefined);
  React.useEffect(() => {
    if (hasInitialPlan && !verbosityTouched) return;
    const token = crypto.randomUUID();
    let cancelled = false;
    // Snapshot at effect-setup time (not read live inside cleanup) so
    // exhaustive-deps doesn't flag a ref read from a cleanup closure.
    const onCancelTokenSnapshot = onCancelTokenRef.current;

    void (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await runExplainRef.current(verbosity, token);
        if (cancelled) return;
        setPlan(res.plan);
        setWriteOmitted(res.writeStageOmitted ?? false);
      } catch (e) {
        if (cancelled) return;
        setErr(getErrorMessage(e, 'Explain failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      onCancelTokenSnapshot?.(token);
    };
  }, [verbosity, verbosityTouched, hasInitialPlan, runExplainRef, onCancelTokenRef]);

  const summary = React.useMemo(() => summarizeExplain(plan), [plan]);

  const json = React.useMemo(() => {
    if (plan === null) return '';
    try {
      return ejsonStringify(plan, 2);
    } catch {
      return JSON.stringify(plan, null, 2);
    }
  }, [plan]);

  const onCopy = () => {
    if (!json) return;
    void copyToClipboard(json, 'Explain plan copied to the clipboard.');
  };

  const onDownload = async () => {
    if (!json) return;
    try {
      await api.app.saveFile({ defaultName: 'explain.json', content: json });
    } catch {
      // ignore
    }
  };

  return (
    // X15 T6 — the hand-rolled version put `role="dialog"` on the *backdrop*
    // (the `position: fixed` scrim), so assistive tech announced the scrim and
    // never the panel; it also never moved focus in on open. Mantine fixes both.
    //
    // No `closeOnClickOutside={false}`: this drawer holds no typed input, so a
    // backdrop click loses nothing and the Mantine default is the right
    // convenience. That makes the `closeOnClickOutside` mutation *equivalent*
    // here — there is no test that could tell the two builds apart.
    //
    // The verbosity select and the Raw/Tree toggle move out of the header and
    // into a toolbar at the top of the body. Mantine's `title` accepts a
    // ReactNode, but it also feeds the drawer's accessible name, and stuffing
    // controls in there would turn "Explain plan" into a paragraph that four
    // spec files and two e2e specs query by.
    <Drawer
      opened
      onClose={close}
      position="right"
      size={520}
      title={stale ? 'Explain plan (not current)' : 'Explain plan'}
      // Mantine's body is a plain padded block, so the `flex: 1` on the
      // scrolling plan output below has no flex context to resolve against: it
      // would collapse to its intrinsic height and the Copy/Download footer
      // would float up under it instead of sitting at the bottom of the panel.
      // `minHeight: 0` is the load-bearing half — a flex item's default
      // `min-height: auto` refuses to shrink below its content, so without it a
      // large plan grows the body past the drawer instead of scrolling inside
      // it. `padding: 0` keeps the sections' own paddings (and the full-bleed
      // background on the scroll area) rather than double-padding them.
      styles={{
        content: { display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0 },
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '10px 14px',
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <select
            value={verbosity}
            onChange={(e) => {
              setVerbosity(e.target.value as ExplainVerbosity);
              setVerbosityTouched(true);
            }}
            aria-label="Verbosity"
            style={{
              fontSize: 11,
              padding: '4px 8px',
              border: `1px solid ${T.border}`,
              borderRadius: T.rs,
              background: T.surfaceRaised,
              color: T.text,
            }}
          >
            <option value="queryPlanner">queryPlanner</option>
            <option value="executionStats">executionStats</option>
            <option value="allPlansExecution">allPlansExecution</option>
          </select>
          <Button
            variant="default"
            size="compact-xs"
            fz={11}
            c={T.textMuted}
            onClick={() => setViewMode((m) => (m === 'tree' ? 'raw' : 'tree'))}
            aria-label={viewMode === 'tree' ? 'Switch to raw view' : 'Switch to tree view'}
          >
            {viewMode === 'tree' ? 'Raw' : 'Tree'}
          </Button>
        </div>

        {writeOmitted && (
          <div
            style={{
              padding: '6px 14px',
              fontSize: 11,
              color: T.warn,
              background: 'rgba(200,160,0,0.08)',
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            Stages with write ops were omitted from the explain.
          </div>
        )}

        <div
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, background: T.bg }}
        >
          {loading ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Running explain…</div>
          ) : err ? (
            <div role="alert" style={{ color: T.red, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {err}
            </div>
          ) : plan === null ? null : (
            <>
              {summary && (
                <div
                  data-testid="explain-summary-strip"
                  style={{
                    marginBottom: 10,
                    padding: '8px 10px',
                    border: `1px solid ${T.border}`,
                    borderRadius: T.rs,
                    background: T.surfaceRaised,
                  }}
                >
                  <div
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 11,
                      color: T.text,
                      marginBottom: 6,
                    }}
                  >
                    {summary.stages.join(' → ')}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {summary.collscan ? (
                      <span
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: T.rs,
                          background: T.warnSoft,
                          color: T.warnText,
                          border: `1px solid ${T.warnBorder}`,
                        }}
                      >
                        ⚠ COLLSCAN — no index used
                      </span>
                    ) : null}
                    {summary.collscan && onCreateIndex && (
                      <Button
                        data-testid="explain-create-index"
                        variant="default"
                        size="compact-xs"
                        h={20}
                        px={8}
                        fz={10}
                        c={T.text}
                        onClick={() => {
                          close();
                          onCreateIndex();
                        }}
                      >
                        Create an index for this query
                      </Button>
                    )}
                    {!summary.collscan && summary.usesIndex ? (
                      <span
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: T.rs,
                          background: T.greenSoft,
                          color: T.greenText,
                          border: `1px solid ${T.greenBorder}`,
                        }}
                      >
                        Index: {summary.indexName ?? 'IXSCAN'}
                      </span>
                    ) : null}
                    {summary.nReturned !== undefined && (
                      <span style={metricChipStyle(T)}>nReturned: {summary.nReturned}</span>
                    )}
                    {summary.docsExamined !== undefined && (
                      <span style={metricChipStyle(T)}>docsExamined: {summary.docsExamined}</span>
                    )}
                    {summary.keysExamined !== undefined && (
                      <span style={metricChipStyle(T)}>keysExamined: {summary.keysExamined}</span>
                    )}
                    {summary.executionTimeMillis !== undefined && (
                      <span style={metricChipStyle(T)}>{summary.executionTimeMillis}ms</span>
                    )}
                  </div>
                </div>
              )}
              <PlanTree plan={plan} />
              {viewMode === 'raw' ? (
                <pre
                  // Handle for the raw-vs-tree assertions. They used to reach
                  // for `dialog.querySelector('pre')`; a `<pre>` carries no
                  // implicit ARIA role, so a testid is the accessible-query
                  // equivalent here.
                  data-testid="explain-raw"
                  style={{
                    margin: 0,
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: T.text,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {json}
                </pre>
              ) : (
                <JsonTree value={plan} highlightKeys={EXPLAIN_HIGHLIGHT_KEYS} />
              )}
            </>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '8px 14px',
            borderTop: `1px solid ${T.border}`,
            justifyContent: 'flex-end',
          }}
        >
          <Button
            variant="default"
            size="compact-xs"
            fz={11}
            c={json ? T.textMuted : undefined}
            onClick={onCopy}
            disabled={!json}
          >
            Copy
          </Button>
          <Button
            variant="default"
            size="compact-xs"
            fz={11}
            c={json ? T.textMuted : undefined}
            onClick={() => void onDownload()}
            disabled={!json}
          >
            Download
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
