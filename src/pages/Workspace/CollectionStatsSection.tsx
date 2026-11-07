import { Button } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import type { CollectionDetails } from '@shared/ipc';
import { humanBytes } from '../../utils/humanBytes';

interface Props {
  details: CollectionDetails | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}

/**
 * Structure's statistics header (W16 §13): one collection's counts and sizes,
 * from the `meta:collectionDetails` read StructureView owns. Natural height and
 * `flex: 'none'` like its siblings, because StructureView's single scroller
 * sizes them (see StructureView's comment).
 */
export function CollectionStatsSection({ details, error, loading, onRefresh }: Props) {
  const T = themeVars;
  const stats = details?.stats;
  const size = (n: number | undefined) => (n === undefined ? '—' : humanBytes(n));

  return (
    <section
      aria-label="Statistics"
      style={{ flex: 'none', display: 'flex', flexDirection: 'column', overflow: 'visible' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: themeVars.gapSm,
          padding: '10px 16px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
          fontSize: T.fsSm,
        }}
      >
        <div style={{ flex: 1, fontWeight: 600, color: T.text }}>Statistics</div>
        <Button
          size="compact-xs"
          variant="subtle"
          aria-label="Refresh statistics"
          onClick={onRefresh}
          leftSection={I.sync}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '6px 16px',
            fontSize: T.fsSm,
            color: T.warn,
            background: T.surface,
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          {error}
        </div>
      )}

      {loading && !details && !error && (
        <div style={{ padding: '10px 16px', fontSize: T.fsSm, color: T.textMuted }}>Loading…</div>
      )}

      {details?.type === 'view' && (
        <div style={{ padding: '10px 16px', fontSize: T.fsSm, color: T.textMuted }}>
          View on {details.options.viewOn}
        </div>
      )}

      {details && stats && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: `${themeVars.gapSm} ${themeVars.gapXl}`,
            padding: '10px 16px',
            borderBottom: `1px solid ${T.border}`,
            fontSize: T.fsSm,
          }}
        >
          <Figure label="Documents" value={stats.documentCount?.toLocaleString() ?? '—'} />
          <Figure label="Data size" value={size(stats.sizeBytes)} />
          <Figure label="Storage size" value={size(stats.storageSizeBytes)} />
          <Figure label="Avg. document size" value={size(stats.avgObjSizeBytes)} />
          <Figure label="Indexes" value={`${stats.indexCount ?? '—'} · ${size(stats.totalIndexSizeBytes)}`} />
          <Figure label="Capped" value={details.capped ? 'Yes' : 'No'} />
        </div>
      )}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  const T = themeVars;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: themeVars.gapXs }}>
      <span style={{ color: T.textMuted, fontSize: T.fsXs }}>{label}</span>
      <span style={{ color: T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}
