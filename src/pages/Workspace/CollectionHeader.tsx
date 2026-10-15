import React from 'react';
import { Button, Group, Tooltip } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { api } from '../../api/atelier';

interface CollectionHeaderProps {
  connectionId: string;
  dbName: string;
  collection: string;
  onOpenReferences: () => void;
  referenceRuleCount: number;
  /**
   * `useDocumentDialogs`'s write-completion counter — bumps once per
   * finished insert/edit/delete/delete-many. Reusing that existing signal
   * (rather than the query re-run itself) keeps this effect from firing on
   * every sort/filter/page re-run too: `listCollections` fans out a
   * per-collection stats call across the whole database, so it isn't free.
   */
  refreshSignal?: number;
}

/**
 * Top breadcrumb header. The Tree|JSON|Table view switch moved down to
 * `<ResultBar/>` alongside the pagination so the top row stays a clean
 * breadcrumb-plus-stats line, plus the References button on the right.
 * Insert lives in `<ResultBar/>`; References is also in the navigator's
 * collection context menu and the command palette.
 */
export function CollectionHeader({
  connectionId,
  dbName,
  collection,
  onOpenReferences,
  referenceRuleCount,
  refreshSignal,
}: CollectionHeaderProps) {
  const T = themeVars;
  const cacheKey = `${connectionId}|${dbName}|${collection}`;
  const [stats, setStats] = React.useState<{
    key: string;
    docCount: number;
    indexCount: number;
  } | null>(null);
  const current = stats && stats.key === cacheKey ? stats : null;
  const docCount = current?.docCount ?? null;
  const indexCount = current?.indexCount ?? null;

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.meta.listCollections({ connectionId, dbName });
        if (cancelled) return;
        const info = rows.find((r) => r.name === collection);
        if (info) {
          setStats({
            key: cacheKey,
            docCount: info.documentCount,
            indexCount: info.indexCount,
          });
        }
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

  return (
    <Group
      gap={10}
      wrap="nowrap"
      style={{
        padding: '0 14px',
        height: 42,
        background: T.surface,
        borderBottom: `1px solid ${T.border}`,
        flexShrink: 0,
      }}
    >
      {/* Breadcrumb + stats */}
      <Group gap={8} align="baseline" wrap="nowrap" style={{ minWidth: 0 }}>
        <span style={{ fontSize: 11, color: T.textMuted }}>{dbName} /</span>
        <Tooltip label={collection} withArrow disabled={collection.length < 24}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: T.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {collection}
          </span>
        </Tooltip>
        {(docCount !== null || indexCount !== null) && (
          <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 4 }}>
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
                {' indexes'}
              </>
            )}
          </span>
        )}
      </Group>

      <span style={{ flex: 1 }} />

      {/* References — secondary action; collapses to icon + count */}
      <Tooltip label={`Manage reference rules for this collection (${referenceRuleCount})`} withArrow>
        <Button
          data-hint-anchor="refs.configure"
          variant="default"
          size="compact-xs"
          onClick={onOpenReferences}
        >
          References ({referenceRuleCount})
        </Button>
      </Tooltip>
    </Group>
  );
}
