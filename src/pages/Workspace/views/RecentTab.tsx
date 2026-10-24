import React from 'react';
import { I } from '../../../icons';
import { api, getErrorMessage } from '../../../api/atelier';
import { relativeTime } from '../../../utils/relativeTime';
import { copyToClipboard } from '../../../utils/clipboard';
import { confirmDestructive } from '../../../utils/confirm';
import { ActionIcon, Box, Button, Group, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { themeVars } from '../../../theme/themeVars';
import type { RecentQuery } from '@shared/types';
import { mergeConsecutive, type MergedRecentQuery } from './recentRuns';

interface RecentTabProps {
  connectionId: string;
  dbName: string;
  collection: string;
  onRunHere: (recent: RecentQuery) => void;
}

/**
 * The filter a recent run actually used, or `null` for a row recorded before
 * `queryRaw` existed. W15 §13.4: the row's primary slot used to hold
 * only a bare time and a duration, so every row looked the same and "Run"
 * was a blind action. `legacyCompileFilter` could reconstruct the pre-W13
 * rows, but dragging the frozen legacy shim into a read-only view to render
 * a preview is not worth it — those rows say so instead.
 */
function previewOf(item: RecentQuery): string | null {
  return item.payload.kind === 'find' && item.payload.queryRaw
    ? item.payload.queryRaw
    : null;
}

export function RecentTab({ connectionId, dbName, collection, onRunHere }: RecentTabProps) {
  const T = themeVars;
  const [items, setItems] = React.useState<RecentQuery[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const rows = React.useMemo(() => mergeConsecutive(items), [items]);

  // A reviewer flagged that this instance is reused when the active collection
  // changes, and two `recent.list` calls can be in flight at once. If the older
  // one resolves last it repopulates the list with the *previous* collection's
  // rows under the new header. Combined with a delete that carried only the
  // row's id, confirming then destroyed history from a collection the user was
  // no longer looking at. The token makes a stale response a no-op.
  const loadToken = React.useRef(0);

  const load = React.useCallback(async () => {
    const token = ++loadToken.current;
    setLoading(true);
    setErr(null);
    try {
      const list = await api.recent.list({ connectionId, dbName, collection, kind: 'find' });
      if (token !== loadToken.current) return;
      setItems(list);
    } catch (e) {
      if (token !== loadToken.current) return;
      setErr(getErrorMessage(e, 'Failed to load recent queries'));
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [connectionId, dbName, collection]);

  React.useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);

  // both paths go through `recent:clear`; a per-row delete is just the
  // same filter narrowed to one `id` per run the row stands for. Same
  // confirm as Saved's.
  const runDelete = async (
    filters: Array<Parameters<typeof api.recent.clear>[0]>,
    failure: string,
  ) => {
    setDeleting(true);
    let failed: string | null = null;
    try {
      for (const filter of filters) await api.recent.clear(filter);
    } catch (e) {
      failed = getErrorMessage(e, failure);
    } finally {
      setDeleting(false);
    }
    // Reload even after a failure: the runs cleared before it are already
    // gone, so the list on screen is stale. The error goes up after the
    // reload because `load` resets it.
    await load();
    if (failed !== null) setErr(failed);
  };

  // A merged row stands for every run in its group, so deleting it removes
  // all of them — otherwise the next-older identical run would just take its
  // place and the row would look undeleted.
  const requestDelete = async (item: MergedRecentQuery, preview: string | null) => {
    const n = item.ids.length;
    const proceed = await confirmDestructive({
      title: n > 1 ? `Delete these ${n} runs?` : 'Delete this run?',
      body: `Removes ${preview ?? 'this run'}${n > 1 ? ` (${n} runs)` : ''} from the recent history. This action cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!proceed) return;
    // The id alone would be enough to find the row — and that was the problem.
    // Sending the scope too means the delete is bounded by what this tab is
    // showing, so even a row that reached the list by some other route cannot
    // take history from another collection with it. The `AND` of id + scope
    // matches nothing rather than the wrong thing.
    await runDelete(
      item.ids.map((id) => ({ id, connectionId, dbName, collection, kind: 'find' as const })),
      'Failed to delete recent query',
    );
  };

  // Scoped to exactly what the tab shows — this connection, this database,
  // this collection, `kind: 'find'`. Aggregation history for the same
  // collection is history this view never listed, so it stays.
  const requestClear = async () => {
    const proceed = await confirmDestructive({
      title: 'Clear recent history?',
      body: `Clears the find history for ${collection} in ${dbName} on this connection. Aggregation history and saved queries are not affected.`,
      confirmLabel: 'Clear history',
    });
    if (!proceed) return;
    await runDelete(
      [{ connectionId, dbName, collection, kind: 'find' }],
      'Failed to clear recent queries',
    );
  };

  return (
    <div>
      {/* W15 §13.5 — the header survives loading, error and empty.
          This view used to early-return a bare centered message, so anyone
          switching here while it loaded got an unlabelled blank panel. */}
      <Group
        gap={6}
        wrap="nowrap"
        px={10}
        pt={10}
        pb={6}
        fz={10}
        fw={700}
        c={T.textMuted}
        style={{ letterSpacing: 0.6, textTransform: 'uppercase' }}
      >
        <span style={{ flex: 1 }}>Recent · {collection}</span>
        <Button
          variant="default"
          size="compact-xs"
          h={18}
          px={6}
          fz={10}
          c={loading ? undefined : T.textMuted}
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh recent queries"
        >
          Refresh
        </Button>
        {/* The accessible name deliberately differs from the confirm's
            "Clear history" label — otherwise both match the same role+name
            query and the dialog is unreachable by keyboard *and* by test. */}
        <Tooltip label="Clear history" withArrow openDelay={400}>
          <Button
            variant="default"
            size="compact-xs"
            h={18}
            px={6}
            fz={10}
            c={loading || deleting || items.length === 0 ? undefined : T.red}
            onClick={() => void requestClear()}
            disabled={loading || deleting || items.length === 0}
            aria-label={`Clear recent find history for ${collection}`}
          >
            Clear
          </Button>
        </Tooltip>
      </Group>

      {loading && (
        <Text fz={12} c={T.textMuted} px={10} pt={4} pb={10}>
          Loading…
        </Text>
      )}

      {!loading && err && (
        <Text fz={12} c={T.warn} px={10} pt={4} pb={10}>
          {err}
        </Text>
      )}

      {!loading && !err && items.length === 0 && (
        <Text fz={12} c={T.textMuted} px={10} pt={4} pb={10}>
          No recent queries yet. Anything you run in this collection shows up here.
        </Text>
      )}

      {!loading && !err && rows.map((item) => {
        const preview = previewOf(item);
        return (
          <Group
            key={item.id}
            gap={6}
            wrap="nowrap"
            px={10}
            py={7}
            fz={12}
            style={{ borderBottom: `1px solid ${T.border}` }}
          >
            <Box style={{ flex: 1, overflow: 'hidden' }}>
              {/* The row's identity: what was queried, not just when. */}
              <Text
                title={preview ?? undefined}
                fz={11}
                c={preview ? T.text : T.textGhost}
                truncate="end"
                style={{ fontFamily: '"JetBrains Mono", monospace' }}
              >
                {preview ?? 'no stored query'}
              </Text>
              <Text fz={10} c={T.textGhost} mt={1}>
                {/* `toLocaleTimeString` alone made a run from last Tuesday read
                    `14:32`, indistinguishable from one an hour ago. */}
                {relativeTime(item.ranAt, item.ranAt)} — {item.durationMs}ms
                {item.ids.length > 1 && (
                  <span style={{ marginLeft: 6 }}>
                    <span aria-hidden="true">×{item.ids.length}</span>
                    <VisuallyHidden>Ran {item.ids.length} times</VisuallyHidden>
                  </span>
                )}
                {item.resultCount !== undefined && (
                  <span style={{ marginLeft: 6 }}>{item.resultCount} docs</span>
                )}
                {item.errorCode && (
                  <span style={{ marginLeft: 6, color: T.warn }}>{item.errorCode}</span>
                )}
              </Text>
            </Box>
            <Tooltip label="Run here" withArrow openDelay={400}>
              <Button
                variant="light"
                size="compact-xs"
                h={20}
                px={7}
                fz={10}
                leftSection={I.play}
                onClick={() => onRunHere(item)}
                aria-label={`Run ${preview ?? 'this recent query'} in this tab`}
              >
                Run
              </Button>
            </Tooltip>
            {/* W15 §13.7 — this used to early-return on a row with no
                stored `queryRaw`: the click did nothing and said nothing. It
                is now unavailable, and says why through its accessible name,
                next to a row that already shows there is no query to copy. */}
            {/* The span is the Tooltip's target: a disabled button swallows the
                pointer events the tooltip listens for, and a row with no
                stored query is exactly when the explanation is wanted. */}
            <Tooltip
              label={preview ? 'Copy MQL' : 'This run has no stored query to copy'}
              withArrow
              openDelay={400}
            >
              <span style={{ display: 'inline-flex' }}>
                <ActionIcon
                  variant="default"
                  size={22}
                  c={preview ? T.textMuted : undefined}
                  onClick={() => { if (preview) void copyToClipboard(preview, 'Query copied to the clipboard'); }}
                  disabled={!preview}
                  aria-label={preview ? 'Copy MQL to the clipboard' : 'Copy MQL — this run has no stored query'}
                >
                  {I.copy}
                </ActionIcon>
              </span>
            </Tooltip>
            {/* Icon-only, so the tooltip is not the accessible name; the
                real name says which run goes. */}
            <Tooltip label="Delete" withArrow openDelay={400}>
              <ActionIcon
                variant="default"
                size={22}
                c={deleting ? undefined : T.red}
                onClick={() => void requestDelete(item, preview)}
                disabled={deleting}
                aria-label={`Delete ${preview ?? 'this recent query'} from recent history`}
              >
                {I.trash}
              </ActionIcon>
            </Tooltip>
          </Group>
        );
      })}
    </div>
  );
}
