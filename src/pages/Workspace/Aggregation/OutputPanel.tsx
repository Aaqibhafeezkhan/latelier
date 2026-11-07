import React from 'react';
import { themeVars } from '../../../theme/themeVars';
import { I } from '../../../icons';
import type { AggregationLastRun, LastRunError, ResultViewMode } from '@shared/types';
import { PaneState } from '../../../components/PaneState';
import { ActionIcon, Button, Group, Menu, SegmentedControl, Tooltip, VisuallyHidden } from '@mantine/core';
import { ejsonStringifyReadable } from '../../../utils/ejson';
import { copyToClipboard } from '../../../utils/clipboard';
import { api, getErrorMessage } from '../../../api/atelier';
import { notify } from '../../../theme/notifications';
import { resizeKeyStep } from '../resizeKeyStep';
import { useElementWidth } from '../../../hooks/useElementWidth';
import { outputBarActions } from '../toolbarLayout';

interface OutputPanelProps {
  height: number;
  view: ResultViewMode;
  lastRun: AggregationLastRun | undefined;
  running: boolean;
  pipelineName: string | null;
  onHeightChange: (px: number) => void;
  onHeightCommit: () => void;
  onViewChange: (v: ResultViewMode) => void;
  onSaveAsCollection: () => void;
  /** Saves the pipeline itself, so it needs no output rows. */
  onSaveAsView: () => void;
  /** The toolbar's Run, offered again by the empty and failed states. */
  onRun: () => void;
  /** False while a stage body does not parse, as for the toolbar's Run. */
  canRun: boolean;
}

const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;

function maxHeight(): number {
  return Math.floor(window.innerHeight * 0.7);
}

function clampHeight(px: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maxHeight(), px));
}

/**
 * the JSON view, Copy all, and Download all share this, and all three
 * are read by a person. `ejsonStringifyReadable` unwraps only sentinels that
 * re-parse to identical BSON, so the copied text still means exactly what the
 * server returned; an int64 stays wrapped rather than arriving rounded.
 */
/** The whole error, server details included, since nothing else shows them. */
function errorText(err: LastRunError): string {
  const head = `${err.code}: ${err.message}`;
  return err.details === undefined ? head : `${head}\n\n${JSON.stringify(err.details, null, 2)}`;
}

function safeStringifyArray(rows: unknown[]): string {
  try {
    return ejsonStringifyReadable(rows, 2);
  } catch {
    return JSON.stringify(rows, null, 2);
  }
}

export function OutputPanel({
  height,
  view,
  lastRun,
  running,
  pipelineName,
  onHeightChange,
  onHeightCommit,
  onViewChange,
  onSaveAsCollection,
  onSaveAsView,
  onRun,
  canRun,
}: OutputPanelProps) {
  const T = themeVars;
  const dragRef = React.useRef<{ startY: number; startH: number } | null>(null);

  // `maxHeight()` reads `window.innerHeight` fresh on every call, so the
  // clamp itself is always correct at interaction time (drag/keyboard both
  // call it live). Without this, only the *displayed* `aria-valuemax` would
  // go stale — stuck at whatever it was on the last render — if the window
  // is resized while the separator holds focus and nothing else re-renders.
  const [ariaMaxHeight, setAriaMaxHeight] = React.useState(maxHeight);
  React.useEffect(() => {
    const onResize = () => setAriaMaxHeight(maxHeight());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { startY: e.clientY, startH: height };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      onHeightChange(clampHeight(dragRef.current.startH + delta));
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (d) onHeightCommit();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onDoubleClick = () => {
    onHeightChange(DEFAULT_HEIGHT);
    onHeightCommit();
  };

  // Keyboard equivalent of both the drag and the double-click reset above.
  // Arrow/Home/End resize by the same shared step every separator in the app
  // uses; Enter is the reset, since double-click has no other keyboard analog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onDoubleClick();
      return;
    }
    const next = resizeKeyStep(e.key, 'vertical', height, MIN_HEIGHT, maxHeight());
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onHeightChange(next);
    onHeightCommit();
  };

  const rows = lastRun?.rows ?? [];
  const err = lastRun?.error;
  const [barRef, barWidth] = useElementWidth<HTMLDivElement>();
  const actionsForm = outputBarActions(barWidth);
  const noRows = rows.length === 0;
  const showsState = !!err || noRows;
  const runButton = (label: string) => (
    <Button variant="default" size="xs" disabled={running || !canRun} onClick={onRun}>
      {label}
    </Button>
  );

  // Always mounted: a live region only announces text that changes after it
  // exists, so start and finish of a run are both heard.
  let statusText = '';
  if (running) statusText = 'Running…';
  else if (err) statusText = 'Run failed';
  else if (lastRun) statusText = `Finished: ${rows.length} documents`;

  const copyAll = () => {
    if (rows.length === 0) return;
    void copyToClipboard(safeStringifyArray(rows), 'Output copied to the clipboard.');
  };

  const download = async () => {
    if (rows.length === 0) return;
    const content = safeStringifyArray(rows);
    const defaultName = `${pipelineName ?? 'pipeline'}-output.json`;
    // A cancelled save panel resolves `{ path: null }`; only a real write
    // failure throws, and the user has to hear about that one.
    try {
      await api.app.saveFile({ defaultName, content });
    } catch (err) {
      notify.error(`Could not save the output: ${getErrorMessage(err, 'the file could not be written')}`);
    }
  };

  return (
    <div
      style={{
        height,
        flexShrink: 0,
        borderTop: `1px solid ${T.border}`,
        display: 'flex',
        flexDirection: 'column',
        background: T.surface,
      }}
    >
      <div
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="separator"
        className="resize-separator"
        aria-label="Resize output panel"
        aria-valuenow={height}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={ariaMaxHeight}
        style={{
          height: 6,
          cursor: 'ns-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: T.surfaceRaised,
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <div style={{ width: 32, height: 3, borderRadius: 2, background: T.border }} />
      </div>

      <Group
        ref={barRef}
        data-testid="output-bar"
        gap={themeVars.gapSm}
        wrap="nowrap"
        style={{
          minHeight: 42,
          boxSizing: 'border-box',
          padding: '0 14px',
          borderBottom: `1px solid ${T.border}`,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {actionsForm !== 'menu' && (
          <span style={{ flexShrink: 0, fontSize: T.fsSm, fontWeight: 600, color: T.text }}>Pipeline output</span>
        )}
        {/* Holds the gap whether or not a run has happened: a long count
            truncates here before any control moves. */}
        <span
          title={lastRun ? `${rows.length} docs · ${lastRun.durationMs} ms` : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontSize: T.fsSm,
            color: T.textMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {lastRun && `${rows.length} docs · ${lastRun.durationMs} ms`}
        </span>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => onViewChange(v as ResultViewMode)}
          data={['Tree', 'JSON', 'Table'].map((m) => ({ label: m, value: m }))}
          style={{ flexShrink: 0 }}
        />
        {actionsForm === 'labels' && (
          <>
            <Button size="compact-xs" variant="default" leftSection={I.copy} onClick={copyAll} disabled={noRows} style={{ flexShrink: 0 }}>
              Copy
            </Button>
            <Button size="compact-xs" variant="default" leftSection={I.save} onClick={onSaveAsCollection} disabled={running || noRows} style={{ flexShrink: 0 }}>
              Save as…
            </Button>
            <Button size="compact-xs" variant="default" leftSection={I.view} onClick={onSaveAsView} disabled={running} style={{ flexShrink: 0 }}>
              Save as view…
            </Button>
          </>
        )}
        {actionsForm === 'icons' && (
          <>
            <OutputIcon label="Copy" icon={I.copy} onClick={copyAll} disabled={noRows} />
            <OutputIcon label="Save as…" icon={I.save} onClick={onSaveAsCollection} disabled={running || noRows} />
            <OutputIcon label="Save as view…" icon={I.view} onClick={onSaveAsView} disabled={running} />
          </>
        )}
        {actionsForm !== 'menu' && (
          <OutputIcon
            label="Download output as JSON"
            icon={I.download}
            onClick={() => void download()}
            disabled={noRows}
          />
        )}
        {actionsForm === 'menu' && (
          <Menu position="bottom-end" shadow="md">
            <Tooltip label="Copy, Save as, Save as view, Download" withArrow>
              <Menu.Target>
                <ActionIcon variant="default" size={26} style={{ flexShrink: 0 }} aria-label="Output actions">
                  {I.more}
                </ActionIcon>
              </Menu.Target>
            </Tooltip>
            <Menu.Dropdown>
              <Menu.Item leftSection={I.copy} onClick={copyAll} disabled={noRows}>
                Copy
              </Menu.Item>
              <Menu.Item leftSection={I.save} onClick={onSaveAsCollection} disabled={running || noRows}>
                Save as…
              </Menu.Item>
              <Menu.Item leftSection={I.view} onClick={onSaveAsView} disabled={running}>
                Save as view…
              </Menu.Item>
              <Menu.Item leftSection={I.download} onClick={() => void download()} disabled={noRows}>
                Download output as JSON
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 14px',
          // A pane state fills the pane in the app's text face; rows keep the code face.
          ...(showsState
            ? { display: 'flex', flexDirection: 'column' }
            : { fontFamily: 'JetBrains Mono, monospace', fontSize: T.fsSm }),
          position: 'relative',
        }}
      >
        <VisuallyHidden role="status" aria-live="polite">
          {statusText}
        </VisuallyHidden>
        {running && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 4,
              right: 14,
              fontSize: T.fsXs,
              color: T.textMuted,
              background: T.surface,
              padding: '1px 6px',
              borderRadius: T.rx,
            }}
          >
            Running…
          </div>
        )}

        {err ? (
          <PaneState
            tone="error"
            title="The pipeline failed"
            detail={errorText(err)}
            actions={runButton('Run again')}
          />
        ) : !lastRun ? (
          // Not "Run": that name belongs to the toolbar button.
          <PaneState title="Run the pipeline to see output" actions={runButton('Run pipeline')} />
        ) : rows.length === 0 ? (
          <PaneState
            title="The pipeline returned no documents"
            detail="Each stage's preview shows where the documents stop."
            actions={runButton('Run again')}
          />
        ) : view === 'JSON' ? (
          <JsonOutput rows={rows} />
        ) : view === 'Table' ? (
          <TableOutput rows={rows} />
        ) : (
          <TreeOutput rows={rows} />
        )}
      </div>
    </div>
  );
}

function OutputIcon({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Tooltip label={label} withArrow>
      <ActionIcon variant="default" size={26} onClick={onClick} disabled={disabled} aria-label={label} style={{ flexShrink: 0 }}>
        {icon}
      </ActionIcon>
    </Tooltip>
  );
}

// ─── Lightweight local views ──────────────────────────────────────────────

function JsonOutput({ rows }: { rows: unknown[] }) {
  const T = themeVars;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.gapSm }}>
      {rows.map((doc, i) => (
        <div
          key={i}
          style={{
            padding: '7px 10px',
            background: T.surfaceRaised,
            border: `1px solid ${T.border}`,
            borderRadius: T.rs,
          }}
        >
          <pre
            style={{
              margin: 0,
              fontSize: T.fsXs,
              color: T.text,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {tryStringify(doc, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

function TreeOutput({ rows }: { rows: unknown[] }) {
  const T = themeVars;
  return (
    <div>
      {rows.map((doc, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: T.gapSm,
            padding: '4px 0',
            borderBottom: `1px solid ${T.border}`,
            alignItems: 'flex-start',
          }}
        >
          <span style={{ color: T.textGhost }}>{I.doc}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${themeVars.gapXs} ${themeVars.gapLg}`, flex: 1 }}>
            {doc && typeof doc === 'object'
              ? Object.entries(doc as Record<string, unknown>).map(([k, v]) => (
                  <span key={k} style={{ fontSize: T.fsXs, color: T.textMuted }}>
                    <span style={{ color: T.textMuted }}>{k}: </span>
                    <span style={{ color: typeof v === 'number' ? '#5B8FCA' : T.text }}>
                      {tryStringify(v)}
                    </span>
                  </span>
                ))
              : (
                <span style={{ fontSize: T.fsXs, color: T.text }}>{tryStringify(doc)}</span>
              )}
          </div>
        </div>
      ))}
    </div>
  );
}

function flattenKeys(doc: unknown, prefix = ''): string[] {
  if (!doc || typeof doc !== 'object') return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (k === '_id' && v && typeof v === 'object' && !isBsonSentinel(v)) {
      keys.push(...flattenKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function isBsonSentinel(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.keys(v as object).some((k) => k.startsWith('$'));
}

function getByPath(doc: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function TableOutput({ rows }: { rows: unknown[] }) {
  const T = themeVars;
  const columns = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows.slice(0, 50)) {
      for (const k of flattenKeys(r)) set.add(k);
    }
    return Array.from(set);
  }, [rows]);

  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr style={{ background: T.surfaceRaised, borderBottom: `1px solid ${T.border}` }}>
          {columns.map((h) => (
            <th
              key={h}
              style={{
                padding: '4px 8px',
                textAlign: 'left',
                fontSize: T.fsXs,
                fontWeight: 600,
                color: T.textMuted,
                whiteSpace: 'nowrap',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((doc, i) => (
          <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
            {columns.map((h) => {
              const v = getByPath(doc, h);
              return (
                <td key={h} style={{ padding: '4px 8px', color: T.text }}>
                  {v === undefined ? '' : typeof v === 'number' ? (
                    <span style={{ color: '#5B8FCA' }}>{v}</span>
                  ) : (
                    tryStringify(v)
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * a single value or document, for the table and tree cells. Same
 * renderer as the Documents views now, which is the point: `n` read `102` in
 * one tab and `{"$numberInt":"102"}` in the other.
 */
function tryStringify(v: unknown, indent?: number): string {
  try {
    return ejsonStringifyReadable(v, indent);
  } catch {
    try {
      return JSON.stringify(v, null, indent);
    } catch {
      return String(v);
    }
  }
}
