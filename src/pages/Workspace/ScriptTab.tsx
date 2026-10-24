import React, { memo, type ReactNode } from 'react';
import type {
  ScriptTab as ScriptTabModel,
  ScriptTabState,
  ScriptRunResultWire,
  ResultViewMode,
  CollectionTabState,
} from '@shared/types';
import { api, isIpcError } from '../../api/atelier';
import { invalidateSampleSchemaCache } from '../../features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../../features/fieldSuggestions/sources/schemaEnumSource';
import { themeVars } from '../../theme/themeVars';
import { Button, Group, Select, TextInput, Tooltip } from '@mantine/core';
import { ScriptEditor } from '../../components/ScriptEditor';
import { ejsonStringify } from '../../utils/ejson';
import { isRecord } from '../../utils/displayValue';
import { ownSet } from '../../utils/ownProperty';
import { ResultViewer } from './ResultViewer';
import { useResizableSplit, MIN_RESULT_HEIGHT, MAX_RESULT_HEIGHT } from './useResizableSplit';
import { CollectionWorkspaceProvider } from './CollectionWorkspaceProvider';
import type {
  CollectionWorkspaceActions,
  CollectionWorkspaceMeta,
} from './context';

const MAX_TIME_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '15 s', value: 15_000 },
  { label: '60 s', value: 60_000 },
  { label: '5 min', value: 5 * 60_000 },
  { label: 'No limit', value: 24 * 60 * 60_000 },
];

const COLLAPSED_RESULT_HEIGHT = 32;
const DEFAULT_RESULT_HEIGHT = 240;

interface ScriptTabProps {
  tab: ScriptTabModel;
  /** The connection's default database: what a blank DB field runs on, so
   *  completions follow the run. */
  defaultDb?: string;
  onPatch: (patch: Partial<ScriptTabState>) => void;
}

function ScriptTabInner({ tab, defaultDb, onPatch }: ScriptTabProps) {
  const T = themeVars;
  const [running, setRunning] = React.useState(false);
  const [collections, setCollections] = React.useState<readonly string[]>([]);
  // Guards double-invocation when the editor's Cmd+Enter keymap and the
  // tab-level handler both fire on the same keypress (setRunning is async).
  const runningRef = React.useRef(false);
  const cancelTokenRef = React.useRef<string | null>(null);

  const state = tab.state;
  // Mirrors main's resolveDbName for a run with a blank field; keep the
  // `'test'` fallback in sync with MongoPool.resolveDbName.
  const effectiveDb = state.dbName?.trim() || defaultDb || 'test';
  const hasFirstRun = !!(state.lastResult || state.lastError);
  const persistedHeight = state.resultPanelHeight ?? DEFAULT_RESULT_HEIGHT;
  const { resultPanelHeight, onResizeStart, onKeyDown: onResizeKeyDown } = useResizableSplit({
    persistedHeight,
    hasContent: hasFirstRun || running,
    collapsedHeight: COLLAPSED_RESULT_HEIGHT,
    onCommit: (h) => onPatch({ resultPanelHeight: h }),
  });
  const showResizeHandle = hasFirstRun || running;

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.meta.listCollections({
          connectionId: tab.connectionId,
          dbName: effectiveDb,
        });
        if (!cancelled) setCollections(rows.map((r) => r.name));
      } catch (err) {
        // Completion falls back to no collection names; the script still runs.
        console.warn('[script] could not list collections for completion', err);
        if (!cancelled) setCollections([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab.connectionId, effectiveDb]);

  const runScript = React.useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const token = crypto.randomUUID();
    cancelTokenRef.current = token;
    setRunning(true);
    try {
      const result: ScriptRunResultWire = await api.script.run({
        connectionId: tab.connectionId,
        dbName: state.dbName || undefined,
        source: state.source,
        cancelToken: token,
        maxTimeMs: state.maxTimeMs,
      });
      onPatch({ lastResult: result, lastError: undefined });
    } catch (err) {
      const e = isIpcError(err)
        ? { code: err.code, message: err.message }
        : { code: 'INTERNAL', message: String(err) };
      onPatch({ lastError: e, lastResult: undefined });
    } finally {
      // A script can write to any collection of its Connection and the
      // renderer can't tell which, so drop the whole Connection's
      // field-suggestion samples — also when the run threw, since it may have
      // written before that.
      invalidateSampleSchemaCache(tab.connectionId);
      invalidateSchemaEnumCache(tab.connectionId);
      cancelTokenRef.current = null;
      runningRef.current = false;
      setRunning(false);
    }
  }, [tab.connectionId, state.source, state.dbName, state.maxTimeMs, onPatch]);

  const cancelScript = React.useCallback(() => {
    const token = cancelTokenRef.current;
    if (!token) return;
    void api.script.cancel({ token }).catch(() => {});
  }, []);

  const onSourceChange = React.useCallback(
    (next: string) => {
      onPatch({ source: next });
    },
    [onPatch],
  );

  const onTitleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onPatch({ title: e.target.value });
    },
    [onPatch],
  );

  const onDbNameChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onPatch({ dbName: e.target.value });
    },
    [onPatch],
  );

  const onMaxTimeChange = React.useCallback(
    (value: string | null) => {
      if (value === null) return;
      onPatch({ maxTimeMs: Number(value) });
    },
    [onPatch],
  );

  // Runs regardless of editor focus; runningRef stops a double-fire with the editor's own keymap.
  const onTabKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void runScript();
      }
    },
    [runScript],
  );

  return (
    // S6848 accepted, not fixed. `onKeyDown` with no `onClick`, `role` or
    // `tabIndex`: the Cmd/Ctrl+Enter Run shortcut is caught as it bubbles from
    // the title input or the editor, both of which are natively focusable, so
    // this div is never a focus target and cannot be mistaken for a control.
    // The rule's stated harm — that a keyboard user cannot reach the handler —
    // is inverted here: focus is already inside by design. Both offered fixes
    // make it worse: `role="button"` on a container holding inputs is invalid
    // nested-interactive ARIA, and a bare `tabIndex={0}` adds a tab stop that
    // does nothing.
    <div
      onKeyDown={onTabKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: T.surface,
      }}
    >
      {/* Toolbar */}
      <Group
        gap={10}
        wrap="nowrap"
        style={{
          padding: '6px 12px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
          flexShrink: 0,
        }}
      >
        <TextInput
          value={state.title}
          onChange={onTitleChange}
          placeholder="Script"
          variant="unstyled"
          size="xs"
          style={{ flex: '0 1 200px' }}
          styles={{ input: { fontWeight: 500, fontSize: 13 } }}
        />
        <span style={{ fontSize: 11, color: T.textMuted }}>db:</span>
        <TextInput
          value={state.dbName ?? ''}
          onChange={onDbNameChange}
          placeholder="(use default)"
          size="xs"
          style={{ width: 140 }}
        />
        <span style={{ fontSize: 11, color: T.textMuted }}>timeout:</span>
        <Select
          value={String(state.maxTimeMs ?? 60_000)}
          onChange={onMaxTimeChange}
          data={MAX_TIME_OPTIONS.map((o) => ({ label: o.label, value: String(o.value) }))}
          size="xs"
          allowDeselect={false}
          withCheckIcon={false}
          style={{ width: 120 }}
        />
        <div style={{ flex: 1 }} />
        {running ? (
          <Button variant="outline" color="red" size="compact-xs" onClick={cancelScript}>
            Cancel
          </Button>
        ) : (
          <Tooltip label="Run (Cmd+Enter)" withArrow>
            <Button
              variant="filled"
              size="compact-xs"
              onClick={runScript}
              data-testid="script-run-btn"
            >
              ▶ Run
            </Button>
          </Tooltip>
        )}
      </Group>

      {/* Editor */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <ScriptEditor
          value={state.source}
          onChange={onSourceChange}
          onRun={runScript}
          readOnly={running}
          testId="script-editor"
          ariaLabel="Script editor"
          collections={collections}
          connectionId={tab.connectionId}
          dbName={effectiveDb}
        />
      </div>

      {/* Resize handle — only meaningful once there is something to show. */}
      {showResizeHandle && (
        <div
          onMouseDown={onResizeStart}
          onKeyDown={onResizeKeyDown}
          tabIndex={0}
          style={{
            height: 4,
            cursor: 'ns-resize',
            background: T.border,
            flexShrink: 0,
          }}
          aria-label="Resize result panel"
          aria-valuenow={resultPanelHeight}
          aria-valuemin={MIN_RESULT_HEIGHT}
          aria-valuemax={MAX_RESULT_HEIGHT}
          role="separator"
        />
      )}

      {/* Result panel */}
      <div
        style={{
          height: resultPanelHeight,
          overflow: 'auto',
          borderTop: `1px solid ${T.border}`,
          background: T.surface,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ScriptResultPanel
          running={running}
          lastResult={state.lastResult}
          lastError={state.lastError}
          resultView={state.resultView ?? 'JSON'}
          resultColumns={state.resultColumns}
          resultExpandedRows={state.resultExpandedRows}
          onPatch={onPatch}
        />
      </div>
    </div>
  );
}

interface ScriptResultPanelProps {
  running: boolean;
  lastResult?: ScriptRunResultWire;
  lastError?: { code: string; message: string };
  resultView: ResultViewMode;
  resultColumns?: Record<string, { width: number }>;
  resultExpandedRows?: Record<string, boolean>;
  onPatch: (patch: Partial<ScriptTabState>) => void;
}

function ScriptResultPanel({
  running,
  lastResult,
  lastError,
  resultView,
  resultColumns,
  resultExpandedRows,
  onPatch,
}: ScriptResultPanelProps) {
  const T = themeVars;
  // `"null"` (string) means an explicit null result, still worth rendering;
  // hooks must run unconditionally, so this stays above the early returns.
  const valueJson = lastResult?.valueJson ?? null;
  const value = React.useMemo(
    () => (valueJson !== null ? safeJsonParse(valueJson) : null),
    [valueJson],
  );

  if (running) {
    return (
      <div
        style={{
          padding: 10,
          fontSize: 12,
          color: T.textMuted,
          fontStyle: 'italic',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        Running…
      </div>
    );
  }

  if (lastError) {
    return (
      <div
        style={{
          padding: 10,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: T.red,
          whiteSpace: 'pre-wrap',
        }}
      >
        <div style={{ fontWeight: 600 }}>{lastError.code}</div>
        <div>{lastError.message}</div>
      </div>
    );
  }

  if (!lastResult) {
    return (
      <div
        style={{
          padding: '6px 12px',
          fontSize: 11,
          color: T.textMuted,
          display: 'flex',
          alignItems: 'center',
          height: '100%',
        }}
      >
        No output yet. Press <kbd style={kbdStyle}>Cmd</kbd>+
        <kbd style={kbdStyle}>Enter</kbd> to run.
      </div>
    );
  }

  const printed = lastResult.printBuffer;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        height: '100%',
        minHeight: 0,
      }}
    >
      <div
        style={{
          color: T.textMuted,
          fontSize: 11,
          padding: '6px 10px 0',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          flexShrink: 0,
        }}
      >
        {lastResult.durationMs} ms
      </div>

      {/* Guard on the wire field, not the parsed `value`, so an explicit
          `null` result (`valueJson === "null"`) still renders. */}
      {lastResult.valueJson !== null && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ResultValueView
            value={value}
            resultView={resultView}
            resultColumns={resultColumns}
            resultExpandedRows={resultExpandedRows}
            onPatch={onPatch}
          />
        </div>
      )}

      {printed.length > 0 && (
        <details open style={{ padding: '0 10px 10px', flexShrink: 0 }}>
          <summary
            style={{
              color: T.textMuted,
              cursor: 'pointer',
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            print output ({printed.length} chars)
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: T.textMuted,
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {printed}
          </pre>
        </details>
      )}
    </div>
  );
}

interface ResultValueViewProps {
  value: unknown;
  resultView: ResultViewMode;
  resultColumns?: Record<string, { width: number }>;
  resultExpandedRows?: Record<string, boolean>;
  onPatch: (patch: Partial<ScriptTabState>) => void;
}

/**
 * Renders the script's last-expression value. Branches by shape:
 *   - Array → reuse the existing result views (Tree/JSON/Table) with a toggle.
 *   - Single record → reuse JsonView with a one-element array; no toggle.
 *   - Anything else (scalar, null, undefined) → small inline pre.
 */
function ResultValueView({
  value,
  resultView,
  resultColumns,
  resultExpandedRows,
  onPatch,
}: ResultValueViewProps) {
  const T = themeVars;
  // Stabilize the one-doc-fallback array reference across renders (as long
  // as `value` itself is unchanged) — `ResultViewer`'s selection context now
  // resets whenever its `documents` reference changes (T0.4), so a fresh
  // `[value]` literal on every render would reset-loop instead of only
  // resetting when the script result actually changes.
  const singleDocArray = React.useMemo(() => [value], [value]);

  if (Array.isArray(value)) {
    return (
      <ArrayResultView
        documents={value}
        resultView={resultView}
        resultColumns={resultColumns}
        resultExpandedRows={resultExpandedRows}
        onPatch={onPatch}
      />
    );
  }

  if (isRecord(value)) {
    // One-doc fallback: render as a single-element JsonView card so users
    // get the same EJSON-aware highlighting they see for collection docs.
    return (
      <div style={{ flex: 1, minHeight: 0 }}>
        <ScriptResultProvider documents={singleDocArray} view="JSON">
          <ResultViewer>
            <ResultViewer.Json />
          </ResultViewer>
        </ScriptResultProvider>
      </div>
    );
  }

  // Scalars, null, undefined, etc.
  return (
    <pre
      style={{
        margin: 0,
        padding: '0 10px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: T.text,
      }}
    >
      {prettyPrint(value)}
    </pre>
  );
}

interface ArrayResultViewProps {
  documents: unknown[];
  resultView: ResultViewMode;
  resultColumns?: Record<string, { width: number }>;
  resultExpandedRows?: Record<string, boolean>;
  onPatch: (patch: Partial<ScriptTabState>) => void;
}

function ArrayResultView({
  documents,
  resultView,
  resultColumns,
  resultExpandedRows,
  onPatch,
}: ArrayResultViewProps) {
  const T = themeVars;
  // O(N) scan; memoized so unrelated parent re-renders don't re-walk a
  // large result array on every keystroke.
  const allRecords = React.useMemo(
    () => documents.length > 0 && documents.every(isRecord),
    [documents],
  );
  // Tree and Table only make sense for record arrays; coerce to JSON if
  // the user persisted a different mode but the new result is non-records.
  const effectiveView: ResultViewMode = allRecords ? resultView : 'JSON';

  const setView = React.useCallback(
    (v: ResultViewMode) => onPatch({ resultView: v }),
    [onPatch],
  );

  const onColumnResize = React.useCallback(
    (field: string, width: number) => {
      const next = { ...(resultColumns ?? {}) };
      // Field names come straight from script output records, so `field`
      // can legally be `__proto__`. Plain `next[field] = { width }` would
      // go through `Object.prototype`'s `__proto__` setter — and since the
      // assigned value here is itself an object, the setter doesn't just
      // no-op, it re-parents `next` onto `{ width }`. `ownSet` always
      // creates a real own key instead.
      ownSet(next, field, { width });
      onPatch({ resultColumns: next });
    },
    [resultColumns, onPatch],
  );

  const onRowExpand = React.useCallback(
    (docId: string, expanded: boolean) => {
      const next = { ...(resultExpandedRows ?? {}) };
      if (expanded) ownSet(next, docId, true);
      else delete next[docId];
      onPatch({ resultExpandedRows: next });
    },
    [resultExpandedRows, onPatch],
  );

  const views: ResultViewMode[] = ['Tree', 'JSON', 'Table'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* View toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '0 10px 4px',
          flexShrink: 0,
        }}
      >
        {views.map((v) => {
          const enabled = allRecords || v === 'JSON';
          const active = effectiveView === v;
          return (
            <Tooltip
              key={v}
              label={enabled ? v : `${v} requires an array of documents`}
              withArrow
              disabled={enabled}
            >
              <Button
                variant={active ? 'light' : 'subtle'}
                color={active ? 'violet' : 'gray'}
                size="compact-xs"
                onClick={() => enabled && setView(v)}
                disabled={!enabled}
                styles={{ root: { fontSize: 11, fontWeight: active ? 600 : 400 } }}
              >
                {v}
              </Button>
            </Tooltip>
          );
        })}
        <span style={{ marginLeft: 8, fontSize: 11, color: T.textMuted }}>
          {documents.length} {documents.length === 1 ? 'doc' : 'docs'}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* reuse demonstration. ScriptTab composes the same
            <ResultViewer> slots the Workspace uses, against a read-only
            synthetic provider. No bespoke TreeView/JsonView/TableView
            wrapping needed. */}
        <ScriptResultProvider
          documents={documents}
          view={effectiveView}
          columns={resultColumns}
          expandedRows={resultExpandedRows}
        >
          <ResultViewer>
            {effectiveView === 'Tree' && (
              <ResultViewer.Tree onRowExpand={onRowExpand} />
            )}
            {effectiveView === 'JSON' && <ResultViewer.Json />}
            {effectiveView === 'Table' && (
              <ResultViewer.Table onColumnResize={onColumnResize} onRowExpand={onRowExpand} />
            )}
          </ResultViewer>
        </ScriptResultProvider>
      </div>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  padding: '1px 4px',
  border: '1px solid currentColor',
  borderRadius: 3,
  margin: '0 2px',
};

function noop() {}

// Actions are stable (frozen) — they're constants, not closures. Building
// once at module scope keeps the provider value identity stable across
// every ScriptTab render so memoised view subtrees don't re-render on
// editor keystrokes.
const SCRIPT_RESULT_ACTIONS: CollectionWorkspaceActions = Object.freeze({
  patch: noop,
  patchWith: noop,
  run: noop,
  cancel: noop,
  openEdit: noop,
  openDelete: noop,
  openDeleteAll: noop,
  openUpdateAll: noop,
  openInsert: noop,
  openSave: noop,
}) as CollectionWorkspaceActions;

const SCRIPT_RESULT_META: CollectionWorkspaceMeta = Object.freeze({
  connectionId: '',
  dbName: '',
  collection: '',
  tabId: 'script-result',
  isLoading: false,
  isReadOnly: true,
});

/**
 * Wraps script result views in a read-only CollectionWorkspaceProvider so
 * TreeView / JsonView / TableView see a valid context. ScriptTab doesn't
 * support edit/delete/insert/save — the actions are no-ops, `isReadOnly` is
 * set so future leaves can short-circuit destructive UI.
 */
function ScriptResultProvider({
  documents,
  view,
  columns,
  expandedRows,
  children,
}: {
  documents: unknown[];
  view: ResultViewMode;
  columns?: Record<string, { width: number }>;
  expandedRows?: Record<string, boolean>;
  children: ReactNode;
}) {
  const state = React.useMemo<CollectionTabState>(
    () => ({
      view,
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: documents.length,
      activeBuilderTab: 'Builder',
      columns,
      expandedRows,
      lastRun: {
        documents,
        durationMs: 0,
        ranAt: new Date(0).toISOString(),
      },
    }),
    [view, columns, expandedRows, documents],
  );
  return (
    <CollectionWorkspaceProvider
      state={state}
      actions={SCRIPT_RESULT_ACTIONS}
      meta={SCRIPT_RESULT_META}
    >
      {children}
    </CollectionWorkspaceProvider>
  );
}

// Memoized so unrelated Workspace re-renders don't re-render the editor
// or its result panel. Tab state and onPatch are both stable from the
// Workspace side.
export const ScriptTab = memo(ScriptTabInner);

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function prettyPrint(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return String(value);
  try {
    return ejsonStringify(value, 2);
  } catch {
    return JSON.stringify(value, null, 2);
  }
}
