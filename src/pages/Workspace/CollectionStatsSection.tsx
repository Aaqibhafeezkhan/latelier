import React from 'react';
import { Button } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { api, getErrorMessage } from '../../api/atelier';
import type { CollectionDetails } from '@shared/ipc';
import { humanBytes } from '../../utils/humanBytes';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
}

/**
 * Structure's statistics header (W16 §13): one collection's counts and sizes,
 * read through `meta:collectionDetails` on entry and on Refresh. Natural
 * height and `flex: 'none'` like its siblings, because StructureView's single
 * scroller sizes them (see StructureView's comment).
 */
export function CollectionStatsSection({ connectionId, dbName, collection }: Props) {
  const T = themeVars;
  // Keyed by target so a reply (or an error) is only ever shown for the
  // collection it was read for: switching collections shows Loading, not the
  // previous collection's figures.
  const targetKey = `${connectionId}|${dbName}|${collection}`;
  const [fetched, setFetched] = React.useState<{ key: string; details: CollectionDetails } | null>(null);
  const details = fetched?.key === targetKey ? fetched.details : null;
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  // Only the latest request may write state: a slow reply for a collection the
  // tab has since left must not overwrite the one now on screen.
  const latest = React.useRef(0);

  const load = React.useCallback(async () => {
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api.meta.collectionDetails({ connectionId, dbName, collection });
      if (id === latest.current) setFetched({ key: targetKey, details: d });
    } catch (e) {
      if (id === latest.current) {
        setFetched(null);
        setError(getErrorMessage(e, String(e)));
      }
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [connectionId, dbName, collection, targetKey]);

  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
          gap: 10,
          padding: '10px 16px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
          fontSize: 12,
        }}
      >
        <div style={{ flex: 1, fontWeight: 600, color: T.text }}>Statistics</div>
        <Button
          size="compact-xs"
          variant="subtle"
          aria-label="Refresh statistics"
          onClick={() => void load()}
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
            fontSize: 12,
            color: T.warn,
            background: T.surface,
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          {error}
        </div>
      )}

      {loading && !details && !error && (
        <div style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted }}>Loading…</div>
      )}

      {details?.type === 'view' && (
        <div style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted }}>
          View on {details.options.viewOn}
        </div>
      )}

      {details && stats && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px 28px',
            padding: '10px 16px',
            borderBottom: `1px solid ${T.border}`,
            fontSize: 12,
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: T.textMuted, fontSize: 11 }}>{label}</span>
      <span style={{ color: T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}
