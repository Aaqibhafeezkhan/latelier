import React from 'react';
import { themeVars } from '../../theme/themeVars';
import { Button } from '@mantine/core';
import { api, getErrorMessage, isIpcError } from '../../api/atelier';
import type { SchemaSampleEntry, SchemaTabState } from '@shared/types';
import { SCHEMA_SAMPLE_MAX } from '@shared/defaults';
import { summarizeSchema } from './schemaSummary';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
  state: SchemaTabState;
  onPatch: (patch: Partial<SchemaTabState>) => void;
}

// Bounded by `meta:sampleSchema`'s zod max: a larger size is refused with
// VALIDATION before the service runs (see SCHEMA_SAMPLE_MAX).
const SAMPLE_SIZE_OPTIONS = [50, 100, SCHEMA_SAMPLE_MAX];

export function SchemaView({
  connectionId,
  dbName,
  collection,
  state,
  onPatch,
}: Props) {
  const T = themeVars;
  const [sampling, setSampling] = React.useState(false);
  // A tab persisted before the bound came down can carry 250/500/1000.
  const sampleSize = Math.min(state.sampleSize, SCHEMA_SAMPLE_MAX);

  const runSample = React.useCallback(async () => {
    if (!connectionId || !dbName || !collection) return;
    setSampling(true);
    const startedAt = performance.now();
    try {
      const { docs } = await api.meta.sampleSchema({
        connectionId,
        dbName,
        collection,
        size: sampleSize,
      });
      const entries = summarizeSchema(docs);
      onPatch({
        entries,
        sampledCount: docs.length,
        ranAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startedAt),
        errorMessage: undefined,
      });
    } catch (e) {
      const message = isIpcError(e) ? e.message : getErrorMessage(e, String(e));
      onPatch({
        entries: [],
        sampledCount: 0,
        ranAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startedAt),
        errorMessage: message,
      });
    } finally {
      setSampling(false);
    }
  }, [connectionId, dbName, collection, sampleSize, onPatch]);

  // Auto-sample on first open. We intentionally do not re-sample on tab
  // switches: the user explicitly hits Refresh to update, since each sample
  // hits Mongo and may be slow on large collections.
  const sampledOnce = React.useRef(false);
  React.useEffect(() => {
    if (sampledOnce.current) return;
    sampledOnce.current = true;
    if (state.entries) return;
    // Defer to a microtask so we don't trigger setState inside the effect's
    // synchronous body — `runSample` flips `sampling` immediately, which
    // would cascade a render before the parent has finished mounting.
    queueMicrotask(() => {
      void runSample();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = state.entries ?? [];

  // `flex: 'none'` + `overflow: 'visible'`: this now sits stacked below
  // IndexesTab inside StructureView's own single scroller (W16 Tier 2, ADR
  // 0003) rather than filling a flex parent with its own internal scroll.
  // See the matching note in IndexesTab.tsx.
  return (
    <div
      role="region"
      aria-label="Schema"
      style={{ flex: 'none', display: 'flex', flexDirection: 'column', overflow: 'visible' }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
          flexShrink: 0,
          fontSize: 12,
        }}
      >
        <div style={{ color: T.textMuted, flex: 1 }}>
          {state.ranAt ? (
            <>
              Sampled {state.sampledCount ?? 0} of {sampleSize} documents
              {typeof state.durationMs === 'number' && (
                <span style={{ color: T.textMuted }}> · {state.durationMs}ms</span>
              )}
            </>
          ) : (
            <span style={{ color: T.textMuted }}>Not sampled yet.</span>
          )}
        </div>
        <label style={{ color: T.textMuted, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span>Sample size</span>
          <select
            aria-label="Sample size"
            value={sampleSize}
            onChange={(e) => onPatch({ sampleSize: Number(e.target.value) })}
            disabled={sampling}
            style={{
              padding: '3px 6px',
              border: `1px solid ${T.border}`,
              borderRadius: T.rs,
              background: T.surfaceRaised,
              color: T.text,
              fontSize: 12,
            }}
          >
            {SAMPLE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button size="compact-xs" variant="filled" disabled={sampling} onClick={() => void runSample()}>
          {sampling ? 'Sampling…' : 'Refresh'}
        </Button>
      </div>

      {state.errorMessage && (
        <div
          role="alert"
          style={{
            padding: '6px 14px',
            fontSize: 12,
            color: T.warn,
            background: T.surface,
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          {state.errorMessage}
        </div>
      )}

      {/* Field list */}
      <div style={{ overflow: 'visible' }}>
        {entries.length === 0 ? (
          // A failed sample already says so in the banner above; "No fields
          // found" would claim the collection is empty when we never read it.
          (sampling || !state.errorMessage) && (
            <div
              style={{
                padding: '40px 14px',
                textAlign: 'center',
                color: T.textMuted,
                fontSize: 12,
              }}
            >
              {sampling
                ? 'Sampling…'
                : state.ranAt
                  ? 'No fields found in the sample.'
                  : 'Click Refresh to sample documents.'}
            </div>
          )
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: T.surface, zIndex: 1 }}>
                <th style={cellHead(T)}>Field</th>
                <th style={cellHead(T)}>Types</th>
                <th style={{ ...cellHead(T), width: 90, textAlign: 'right' }}>Distinct</th>
                <th style={cellHead(T)}>Range</th>
                <th style={{ ...cellHead(T), width: 110, textAlign: 'right' }}>Frequency</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <SchemaRow key={e.path} entry={e} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SchemaRow({ entry }: { entry: SchemaSampleEntry }) {
  const T = themeVars;
  const totalCount = Object.values(entry.types).reduce((a, b) => a + b, 0);
  const sortedTypes = Object.entries(entry.types).sort((a, b) => b[1] - a[1]);
  return (
    <tr style={{ borderBottom: `1px solid ${T.border}` }}>
      <td style={cellBody(T)}>
        <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
          {entry.path}
        </code>
      </td>
      <td style={cellBody(T)}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {sortedTypes.map(([type, count]) => (
            <span
              key={type}
              title={`${count} document${count === 1 ? '' : 's'}`}
              style={{
                padding: '1px 6px',
                fontSize: 10,
                fontWeight: 500,
                borderRadius: T.rx,
                background: typeBg(T, type),
                color: typeFg(T, type),
                border: `1px solid ${T.border}`,
              }}
            >
              {type}
              {totalCount > 0 && count < totalCount && (
                <span style={{ marginLeft: 4, color: T.textGhost, fontWeight: 400 }}>
                  {Math.round((count / totalCount) * 100)}%
                </span>
              )}
            </span>
          ))}
        </div>
      </td>
      <td style={{ ...cellBody(T), textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {entry.distinct ?? '—'}
      </td>
      <td style={{ ...cellBody(T), fontVariantNumeric: 'tabular-nums' }}>
        {entry.numeric
          ? `${formatNumber(entry.numeric.min)} – ${formatNumber(entry.numeric.max)} · avg ${formatNumber(entry.numeric.avg)}`
          : '—'}
      </td>
      <td style={{ ...cellBody(T), textAlign: 'right' }}>
        <span style={{ color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(entry.frequency * 100)}%
        </span>
      </td>
    </tr>
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function cellHead(T: typeof themeVars): React.CSSProperties {
  return {
    textAlign: 'left',
    padding: '6px 12px',
    fontSize: 11,
    fontWeight: 600,
    color: T.textMuted,
    borderBottom: `1px solid ${T.border}`,
  };
}

function cellBody(T: typeof themeVars): React.CSSProperties {
  return {
    padding: '6px 12px',
    color: T.text,
    verticalAlign: 'top',
  };
}

function typeBg(T: typeof themeVars, type: string): string {
  if (type === 'null' || type === 'undefined') return T.surfaceRaised;
  if (type === 'objectid' || type === 'date') return T.accentSoft;
  return T.surfaceRaised;
}

function typeFg(T: typeof themeVars, type: string): string {
  if (type === 'null' || type === 'undefined') return T.textGhost;
  if (type === 'objectid' || type === 'date') return T.accent;
  return T.text;
}

