# W10 — Recent queries + preview field preferences

> **Status: Implemented.** The preview-field preferences in §2 were removed along with the picker.

## Purpose

Two small persistence features bundled because they share the same UX footprint: they both scope by connection/db/collection and both are exposed via the workspace panes. Recent gives users a view of their most recent runs to re-use; preview fields persist the user's chosen display columns across sessions.

## Scope

- **In**: `RecentQueryRepo`, `RecentQueryService`, capture hook called from W03 and A04, `recent:*` IPC channels, Recent tab UI; `PreviewFieldsRepo` + `prefs:previewFields` IPC, integration with W06 preview picker.
- **Out**: Analytics, export of recent (deferred).

## Dependencies

- F02 (`recent_queries`, `preview_fields`), W03 / A04 (producers of recent), W06 (consumer of preview fields).

## 1. Recent queries

### Types

```ts
export type RecentKind = 'find' | 'aggregation';

export interface RecentQuery {
  id: string;
  connectionId: string;
  dbName: string;
  collection: string;
  kind: RecentKind;
  payload: SavedPayload;       // same shape as W09, minus `script`
  ranAt: string;
  durationMs: number;
  resultCount?: number;
  errorCode?: string;
}
```

### Capture

- `QueryService.find` (W03) calls `RecentQueryService.recordFind(input, durationMs, resultCount, errorCode?)`.
- `AggregationService.run` (A04) calls `recordAggregation(...)`.
- `recordError` is called when a run throws, preserving the payload for "Try again" flows.

### Caps & retention

- Per `connectionId`: at most **200** entries. Oldest evicted on insert (ordered by `ran_at ASC`).
- Retention: 30 days. A daily maintenance tick (triggered on app startup) deletes older rows.
- Failed runs count toward the cap. Users can re-run to see if their env was the problem.

### IPC channels

| Channel           | Input                                               | Output              |
| ----------------- | --------------------------------------------------- | ------------------- |
| `recent:list`     | `{ connectionId?, dbName?, collection?, kind?, limit? }` | `RecentQuery[]` |
| `recent:get`      | `{ id }`                                            | `RecentQuery`       |
| `recent:clear`    | `{ connectionId?, collection? }`                    | `{ deleted: number }` |

List returns ordered by `ran_at DESC`, default limit 50.

### Recent tab UI

Inside the Builder pane of a collection tab:
- Filter to `{ connectionId, dbName, collection }` by default.
- Each row:
  - Relative timestamp, kind icon, one-line summary of the payload (first condition or first stage + `…`).
  - Right side: `durationMs`, `resultCount`, or an error badge.
  - Actions: `Run here`, `Open in new tab`, `Copy MQL`.
- "Clear all for this collection" link at the bottom → `recent:clear`.

### Aggregation tab usage

An aggregation tab has no Builder pane, but its title-bar has a small "Recent" popover that shows the last 10 agg runs for this collection with the same actions.

### De-dup

Storage does not de-duplicate: each run is a distinct row in `recent_queries` (useful for latency comparison), and the IPC returns every row.

The Recent tab collapses them at display time (`mergeConsecutive` in `views/recentRuns.ts`):
- Adjacent rows in list order with the same `connectionId`, `dbName`, `collection`, `kind` and an identical payload (`JSON.stringify`) merge into one.
- The row kept is the newest of the group (the first, since the list is `ran_at DESC`): its `id`, timestamp, duration and result count describe the latest run. It also carries `ids`, every run in the group, newest first.
- The merged row shows `×N` when N > 1. The visible `×N` is `aria-hidden`; a visually hidden "Ran N times" is what assistive tech reads.
- Only neighbours merge. The same query separated by a different one stays two rows, because that order is part of the history.
- Delete on a merged row removes every run in the group (one `recent:clear` per id, each bounded by the tab's scope). The confirm says how many: "Delete these N runs?" … "(N runs)".

## 2. Preview field preferences

### Types

```ts
export interface PreviewFields {
  connectionId: string;
  dbName: string;
  collection: string;
  fields: string[];          // ordered, up to ~10
  updatedAt: string;
}
```

### IPC channels

| Channel                    | Input                                    | Output           |
| -------------------------- | ---------------------------------------- | ---------------- |
| `prefs:getPreviewFields`   | `{ connectionId, dbName, collection }`   | `PreviewFields \| null` |
| `prefs:setPreviewFields`   | `{ connectionId, dbName, collection, fields: string[] }` | `PreviewFields` |

### UX
- On first render of a collection tab: if `null`, derive a sensible default from the first 50 docs:
  - Skip `_id`.
  - Take first 4 top-level scalar fields (string/number/boolean/date) preserving insertion order.
  - Store via `prefs:setPreviewFields`.
- Subsequent changes happen through W06's `PreviewPicker`. Each change writes through immediately (no debounce needed — the event is discrete).

### Invalidation
- If a doc arrives with a completely new field set, existing prefs still apply; the picker just lists the union of fields seen so far.

## 3. Maintenance

A tiny `MaintenanceService` registered at startup runs every 24 hours (and once at boot if the last run was > 24h ago):
- Vacuum recent_queries past 30-day retention.
- Log a summary (`info maintenance`).

## 4. Acceptance criteria

- Each successful or errored query run produces exactly one row in `recent_queries` within 100ms of completion.
- The per-connection cap (200) evicts the oldest rows on insert.
- Retention cleanup removes rows older than 30 days at startup.
- Recent tab lists rows in `ran_at DESC` order; "Run here" re-runs with the exact payload.
- Consecutive identical runs show as one row with a `×N` run count; non-adjacent repeats stay separate rows. Deleting that row deletes all N runs.
- `prefs:getPreviewFields` returns `null` for an unknown collection; the default-derivation logic then fires.
- Changes to preview fields via the picker persist across relaunches.

## 5. Test cases

### Integration
- **record-find.spec.ts**: run `query:find` → recent row present with matching payload and result count.
- **record-error.spec.ts**: query that errors still inserts a row with `error_code`.
- **cap.spec.ts**: insert 205 rows → 200 survive; 5 oldest evicted.
- **retention.spec.ts**: insert a row dated 31 days ago; call maintenance; row gone.
- **preview-roundtrip.spec.ts**: set → get → same fields.

### Component
- **recent-row.spec.tsx**: mock returns 3 rows → renders with correct summaries; "Run here" dispatches tab hydration + run.
- **preview-default.spec.tsx**: fresh tab → first 50 docs provided → picker initialized with first 4 scalar fields.
- **picker-persist.spec.tsx**: selecting a new field → `api.prefs.setPreviewFields` called with the new array.
