import React from 'react';
import { themeVars } from '../../../theme/themeVars';
import { I } from '../../../icons';
import type { AggregationLastRun, ResultViewMode } from '@shared/types';
import { Button, Group, SegmentedControl } from '@mantine/core';
import { ejsonStringifyReadable } from '../../../utils/ejson';
import { copyToClipboard } from '../../../utils/clipboard';
import { api, getErrorMessage } from '../../../api/atelier';
import { notify } from '../../../theme/notifications';
import { resizeKeyStep } from '../resizeKeyStep';

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
}: OutputPanelProps) {
  const T = themeVars;
  const [errDetails, setErrDetails] = React.useState(false);
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
        gap={10}
        wrap="nowrap"
        style={{
          padding: '6px 14px',
          borderBottom: `1px solid ${T.border}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>Pipeline output</span>
        {lastRun && (
          <>
            <span style={{ fontSize: 11, color: T.textMuted }}>{rows.length} docs</span>
            <span style={{ fontSize: 11, color: T.textMuted }}>· {lastRun.durationMs}ms</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => onViewChange(v as ResultViewMode)}
          data={['Tree', 'JSON', 'Table'].map((m) => ({ label: m, value: m }))}
        />
        <Button size="compact-xs" variant="default" leftSection={I.copy} onClick={copyAll} disabled={rows.length === 0}>
          Copy
        </Button>
        <Button size="compact-xs" variant="default" leftSection={I.save} onClick={onSaveAsCollection} disabled={running || rows.length === 0}>
          Save as…
        </Button>
        <Button size="compact-xs" variant="default" onClick={onSaveAsView} disabled={running}>
          Save as view…
        </Button>
        <Button
          size="compact-xs"
          variant="default"
          onClick={() => void download()}
          disabled={rows.length === 0}
          aria-label="Download output as JSON"
          title="Download output as JSON"
        >
          ⇩
        </Button>
      </Group>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 14px',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          position: 'relative',
        }}
      >
        {running && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              right: 14,
              fontSize: 11,
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
          <div
            role="alert"
            style={{
              border: `1px solid ${T.red}`,
              borderRadius: T.rs,
              padding: 10,
              background: 'rgba(180,60,60,0.08)',
              color: T.text,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: T.red }}>
              {err.code}
            </div>
            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{err.message}</div>
            <button
              onClick={() => setErrDetails((d) => !d)}
              style={{
                marginTop: 8,
                fontSize: 11,
                background: 'none',
                border: 'none',
                color: T.accent,
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: 0,
              }}
            >
              {errDetails ? 'Hide details' : 'Show details'}
            </button>
            {errDetails && (
              <pre
                style={{
                  marginTop: 8,
                  padding: 8,
                  background: T.surfaceRaised,
                  border: `1px solid ${T.border}`,
                  borderRadius: T.rs,
                  fontSize: 10,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {JSON.stringify(err, null, 2)}
              </pre>
            )}
          </div>
        ) : !lastRun ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: T.textMuted,
              fontSize: 12,
            }}
          >
            Run the pipeline to see output.
          </div>
        ) : rows.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: T.textMuted,
              fontSize: 12,
            }}
          >
            Pipeline returned no documents.
          </div>
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

// ─── Lightweight local views ──────────────────────────────────────────────

function JsonOutput({ rows }: { rows: unknown[] }) {
  const T = themeVars;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              fontSize: 11,
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
            gap: 8,
            padding: '4px 0',
            borderBottom: `1px solid ${T.border}`,
            alignItems: 'flex-start',
          }}
        >
          <span style={{ color: T.textGhost }}>{I.doc}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', flex: 1 }}>
            {doc && typeof doc === 'object'
              ? Object.entries(doc as Record<string, unknown>).map(([k, v]) => (
                  <span key={k} style={{ fontSize: 11, color: T.textMuted }}>
                    <span style={{ color: T.textMuted }}>{k}: </span>
                    <span style={{ color: typeof v === 'number' ? '#5B8FCA' : T.text }}>
                      {tryStringify(v)}
                    </span>
                  </span>
                ))
              : (
                <span style={{ fontSize: 11, color: T.text }}>{tryStringify(doc)}</span>
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
                fontSize: 11,
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
