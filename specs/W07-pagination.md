# W07 — Pagination control

> **Status: Implemented.**

## Purpose

Drive the `skip` / `limit` inputs of the runner, show where we are in the result set, and let the user move between pages without leaving the workspace. Small but testable.

## Scope

- **In**: Pagination controls (prev/next, page size), page count derivation from total, state persistence per tab, disabled states.
- **Out**: The actual find call (W03), the result bar (W05).

## Dependencies

- W03, W05, W01.

## 1. State

Per collection tab (persisted):

```ts
{
  page: number;           // 0-indexed
  pageSize: number;       // default 50; allowed {10, 25, 50, 100, 250, 500}
  totalCount?: number;    // from query:count; may be absent (very large coll)
  lastRunHasMore: boolean;
}
```

## 2. UI

In the result bar (already reserved by W05), right-aligned:

```
  [◀]   Page 3 / 128 · 1–50 of 6 382   [50 ▾]   [▶]
```

- **Prev** / **Next** arrows.
- If `totalCount` is known: `Page n / total · start–end of total`.
- If `totalCount` is unknown: `Page n · start–end` and next is disabled only when `lastRunHasMore === false`.
- Page-size menu: `10, 25, 50, 100, 250, 500`. Changing it resets `page` to 0 and triggers a run.
- On zero docs: entire pagination is hidden.

## 3. Behavior

- `Next`: `setPage(p => p + 1)` and trigger Run (same as W05 Run but without changing `queryRaw`). Disabled when `lastRunHasMore === false` or `(totalCount && (page+1)*pageSize >= totalCount)`.
- `Prev`: `setPage(p => Math.max(0, p - 1))` and trigger Run. Disabled at page 0.
- Editing the builder or the query bar resets `page` to 0 (because the result shape likely changed). The reset fires on the next Run, not immediately; a small hint "Will jump to page 1 on run" appears if we were on page > 0 when state became dirty. A page the user picks (the pager, the page-size menu) is not reset: it runs the edited query at that page.
- Once the count settles, a page past the end of the results (documents deleted since, a chosen page the results no longer reach) moves to the last page that has results and re-runs.

## 4. Accessibility

- Prev/Next buttons have descriptive `aria-label`s.
- Page-size select is a labeled `<select>` for screen readers.

## 5. Acceptance criteria

- Default page size is 50.
- Changing page size resets page to 0 and re-runs.
- With `totalCount` known, Next is disabled on the last page.
- With `totalCount` unknown, Next disables only when `lastRunHasMore` is false.
- Prev is disabled on page 0.
- Running an edited query starts from page 0; re-running the same query keeps the page.
- A page past the end of the results moves to the last page that has results.
- Pagination state persists across tab switches (including page number).
- Switching tabs re-runs only if the tab was created with no prior run state; otherwise the last result is shown.

## 6. Test cases

### Component
- **defaults.spec.tsx**: page=0, size=50 on fresh tab.
- **next.spec.tsx**: click Next → `api.query.find` receives `skip=50, limit=50`.
- **prev.spec.tsx**: from page 2, click Prev → skip=50.
- **disabled-last.spec.tsx**: totalCount=100, pageSize=50, page=1 → Next disabled.
- **disabled-no-total.spec.tsx**: totalCount undefined, `hasMore=false` → Next disabled.
- **size-change-resets.spec.tsx**: change size 50→100 → page=0 → run called with limit=100.
- **query-bar-run.spec.tsx**: change builder while page>0 → small hint visible.
- **use-query-runner.spec.tsx**: Run of an edited query → skip=0; same query → page kept; page past the end → moves to the last page with results.
