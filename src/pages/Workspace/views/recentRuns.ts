import type { RecentQuery } from '@shared/types';

/** A displayed Recent row. `ids` holds every stored run it stands for,
 * newest first (`ids[0] === id`), so a delete can remove the whole group. */
export type MergedRecentQuery = RecentQuery & { ids: string[] };

function sameRun(a: RecentQuery, b: RecentQuery): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.dbName === b.dbName &&
    a.collection === b.collection &&
    a.kind === b.kind &&
    JSON.stringify(a.payload) === JSON.stringify(b.payload)
  );
}

/**
 * Re-running the same query records one history row per run, so a user who
 * hits Run five times gets five identical rows. This collapses each run of
 * adjacent identical rows into one, at display time only — the stored history
 * is untouched. The list arrives newest-first, so the row kept is the first of
 * each group: its `id`, `ranAt`, `durationMs` and `resultCount` describe the
 * latest run, and `ids` lists every run in the group. Only neighbours merge; the same query separated by a different
 * one stays two rows, because that order is part of the history.
 */
export function mergeConsecutive(items: RecentQuery[]): MergedRecentQuery[] {
  const out: MergedRecentQuery[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && sameRun(last, item)) last.ids.push(item.id);
    else out.push({ ...item, ids: [item.id] });
  }
  return out;
}
