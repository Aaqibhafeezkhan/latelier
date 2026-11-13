import React from 'react';
import { Group, Tooltip } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { api } from '../../api/atelier';
import { useElementWidth } from '../../hooks/useElementWidth';

/** Below this the counts would crowd the name; Structure's Statistics still has them. */
const STATS_MIN_WIDTH = 480;

interface CollectionHeaderProps {
  connectionId: string;
  dbName: string;
  collection: string;
  /**
   * Re-reads the counts whenever it changes. PanelBody builds it from
   * `useDocumentDialogs`'s write-completion counter (once per finished
   * insert/edit/delete/delete-many) and Structure's index changes. Not the
   * query re-run or a view switch: that would fire on every sort/filter/page
   * re-run too, and `collectionDetails` runs a stats aggregation on the
   * server, so it isn't free.
   */
  refreshSignal?: number;
}

/**
 * Breadcrumb header, on the sub-tab row beside Documents / Aggregation /
 * Structure, so it shows in all three. It fills what the tabs leave; the
 * breadcrumb ellipsizes first. The Tree|JSON|Table view switch, Insert and
 * References live in `<ResultBar/>`, References beside Fields; it is also in
 * the navigator's collection context menu and the command palette.
 */
export function CollectionHeader({
  connectionId,
  dbName,
  collection,
  refreshSignal,
}: CollectionHeaderProps) {
  const T = themeVars;
  const cacheKey = `${connectionId}|${dbName}|${collection}`;
  const [stats, setStats] = React.useState<{
    key: string;
    docCount: number | null;
    indexCount: number | null;
  } | null>(null);
  const current = stats && stats.key === cacheKey ? stats : null;
  const docCount = current?.docCount ?? null;
  const indexCount = current?.indexCount ?? null;

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { stats: figures } = await api.meta.collectionDetails({ connectionId, dbName, collection });
        if (cancelled) return;
        // A figure the server did not report (every one, for a view) stays absent rather than 0.
        setStats({
          key: cacheKey,
          docCount: figures?.documentCount ?? null,
          indexCount: figures?.indexCount ?? null,
        });
      } catch {
        // Best-effort — but a failed refresh must not leave a pre-write count
        // on screen looking current, so clear rather than hold the last value.
        if (!cancelled) setStats(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, dbName, collection, cacheKey, refreshSignal]);

  // A count shows whole or not at all: "1…" would read as one document.
  const [rowRef, rowWidth] = useElementWidth<HTMLDivElement>();
  const roomForStats = rowWidth === null || rowWidth >= STATS_MIN_WIDTH;

  return (
    <Group
      ref={rowRef}
      gap={themeVars.gapSm}
      wrap="nowrap"
      style={{
        flex: 1,
        minWidth: 0,
        padding: '0 10px 0 14px',
      }}
    >
      {/* Breadcrumb + stats */}
      <Group gap={T.gapSm} align="baseline" wrap="nowrap" style={{ minWidth: 0, flex: '0 1 auto', overflow: 'hidden' }}>
        <span style={{ fontSize: T.fsXs, color: T.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}>{dbName} /</span>
        <Tooltip label={collection} withArrow disabled={collection.length < 24}>
          <span
            style={{
              fontSize: T.fsMd,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: T.text,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {collection}
          </span>
        </Tooltip>
        {roomForStats && (docCount !== null || indexCount !== null) && (
          <span
            style={{
              fontSize: T.fsXs,
              color: T.textMuted,
              marginLeft: 4,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {docCount !== null && (
              <>
                <strong style={{ fontWeight: 500, color: T.text }}>
                  {docCount.toLocaleString()}
                </strong>
                {' docs in collection'}
              </>
            )}
            {docCount !== null && indexCount !== null && ' · '}
            {indexCount !== null && (
              <>
                <strong style={{ fontWeight: 500, color: T.text }}>{indexCount}</strong>
                {indexCount === 1 ? ' index' : ' indexes'}
              </>
            )}
          </span>
        )}
      </Group>

    </Group>
  );
}
