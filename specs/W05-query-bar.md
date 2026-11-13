# W05 — Query bar + bidirectional MQL sync

> **Status: Implemented.** Its sync machine (§1) and sync pill (§2) are superseded by [W13](./W13-filter-tree-editor.md).

> **Partly superseded by [W13](./W13-filter-tree-editor.md).** W13 makes the
> filter text canonical and the drawer a view of it, which removes the sync
> problem rather than solving it: **§1** (the whole SYNCED/DIRTY machine) and
> the sync-pill bullets of **§2** are frozen as the shipped pre-W13 behavior.
> §3–§6 (run flow, keyboard, cancellation, error handling) are unaffected.

## Purpose

The single-line editor above the result area that shows the compiled MQL, accepts hand edits, and either stays in lockstep with the builder pane (W04) or goes "freeform" when the user types something the builder can't represent. Run is triggered here; syncing status is visible here.

## Scope

- **In**: Query bar UI, bidirectional sync state machine, Run button, hydration on builder change, hand-edit detection, "Re-sync builder" action, the notice beside Run, duration pill, document-count pill. A failed run replaces the results (W06 §5).
- **Out**: The runner (W03), result rendering (W06), pagination (W07).

## Dependencies

- W03, W04, W06, W10 (recent capture triggers on run), F04.

## 1. Sync state machine

State lives on the collection tab and persists.

```
              ┌──────────────────┐
              │  SYNCED          │   queryRaw === compile(builder)
              │  builder ↔ raw   │   queryDirty = false
              └─────┬────────────┘
                    │ user types in query bar
                    ▼
              ┌──────────────────┐
              │  DIRTY (parseOk) │   queryRaw !== compile(builder)
              │  parse succeeds  │   queryDirty = true
              │  → offer Accept  │
              └─────┬────────────┘
                    │  user clicks "Re-sync builder"
                    │  → hydrate builder from parse, queryDirty=false
                    ▼
              ┌──────────────────┐
              │  SYNCED          │
              └──────────────────┘

              ┌──────────────────┐
              │  DIRTY (parseNo) │   parse fails
              │  freeform        │   builder is frozen (read-only badge)
              └──────────────────┘
```

- From **SYNCED**: any change to the builder recompiles `queryRaw` and stays SYNCED.
- From **SYNCED**: any keystroke in the bar that results in a different string than `compile(builder)` transitions to **DIRTY** + runs `parseMqlToBuilder` (W04 §3).
- In **DIRTY**, the builder pane does NOT auto-recompile into the bar. Changing the builder while dirty silently keeps the current `queryRaw` but shows an overlay "Builder changes aren't applied. Re-sync or accept builder." with two actions: **Re-sync builder** (keep bar, parse into builder) and **Accept builder** (overwrite bar with builder-compiled MQL).
- Run works in every state, on the current `queryRaw`.

## 2. UI

Above the result area; matches mock.

```
┌─ Sub-tab row ───────────────────────────────────────────────────────────┐
│ [Documents][Aggregation][Structure]  shop / orders  180 docs  [References]│
└─────────────────────────────────────────────────────────────────────────┘
┌─ Query bar ─────────────────────────────────────────────────────────────┐
│ [▸ query][ { posted: { $eq: true }, … }      ][Save][History] | [Run ▾] │
└─────────────────────────────────────────────────────────────────────────┘
┌─ Result bar ────────────────────────────────────────────────────────────┐
│ [▲ N docs] · [▲ 42 ms]                        [pagination — W07]        │
└─────────────────────────────────────────────────────────────────────────┘
```

- Three bars sit above the rows: the sub-tab row, the query row, the result
  bar. The breadcrumb and References sit on the sub-tab row, beside the
  Documents / Aggregation / Structure tabs, so they show in all three views.
  Save, History and the Run split end the query row itself; any notice sits
  before them, so Run never moves. Below ~640px of query bar, Save and History
  shrink to icon buttons that keep their names.
- Input: monospace, grows to a max of ~12 lines (shift+enter newline).
- **Autocomplete** (X02): field-name suggestions appear at the caret in
  key positions (`{ sta`, `{ user.na`, `{ $or: [{ na| }] }`, etc.) and
  field-ref suggestions inside value-side `"$…"` strings. Wired via
  `useTextareaAutocomplete`. Replaces tokens in-place; caret is
  restored past the insertion via `requestAnimationFrame` +
  `setSelectionRange`.
- Sync pill:
  - **SYNCED** → green dot "⇅ synced".
  - **DIRTY (parseOk)** → amber "Re-sync builder" action button.
  - **DIRTY (parseNo)** → red "Builder disabled" badge with a tooltip reason.
  - Both DIRTY states also offer **Accept builder**, which overwrites
    `queryRaw` from the builder and returns to SYNCED. It is the deliberate
    counterpart to the builder no longer clobbering a hand edit (§1) —
    discarding the raw text has to stay possible, just never implicit.
- Run button primary. Disabled during in-flight runs; shows a spinner.
  Also disabled — with W04's tooltip — when the builder holds a condition
  the compiler can't encode and the tab is not dirty (W04 §7a).
  Checking `isValidEjson(queryRaw)` alone is insufficient: the mangled
  clause `compileMql` emits for those ops is valid EJSON.
- Result bar shows, in order:
  - `N documents` (or `—` if not yet run).
  - Duration `Xms`.
  - When the last run failed and left no rows, "Query failed" in the count's place; the error itself fills the results pane (W06 §5).
  - Pagination controls (W07).

## 3. Run flow

1. Compile args:
   - `filter = state.queryRaw` (tab's latest string).
   - `sort = state.builder.sort || undefined`.
   - `projection = buildProjection(state.builder.projection)` if any.
   - `limit = state.builder.limit ? Number(state.builder.limit) : pageSize`.
   - `skip = page * pageSize`.
2. Validate `filter` is EJSON. If not, abort: the rows stay, dimmed, and the reason shows beside Run.
3. `setPending(true);`
4. `const res = await api.query.find(FindInput)`.
5. Display: result bar updates with `documents.length` and `durationMs`. Pass `documents` to W06 result views via context.
6. `await api.query.count({...})` in parallel for the `totalCount` — separate spinner inside the doc-count pill.
7. Record ran into recent (W10) — handled server-side by the runner automatically; no additional client call.
8. `setPending(false)`.

## 4. Keyboard

- `⌘↵` / `Ctrl+Enter`: Run.
- `⌘L`: focus query bar and select all.
- `⌘⇧⌫`: clear query bar (reset to `{}` in SYNCED state).
- `Esc` while focused in bar: cancel in-flight run via `query:cancel`.

## 5. Cancellation

Each run generates a UUID `cancelToken`, stored in a ref. If a new Run starts, the previous token is cancelled first. `Esc` cancels the current token. Cancelled runs resolve to a `CANCELLED` code in the envelope error which the UI silences (no banner).

## 6. Validation & errors

| Error                         | UX |
| ----------------------------- | -- |
| Client-side invalid EJSON     | The reason, in a line beside Run that moves nothing; Run disabled until fixed. Rows stay, dimmed. |
| `NETWORK`/`UNAUTHORIZED`      | Results pane: the error, with Run again (W06 §5). |
| Anything else the server refuses (`VALIDATION`, `MONGO_ERROR`, `TIMEOUT`) | Results pane: the whole error, with Revert to last valid query (W06 §5). |

## 7. Acceptance criteria

- Edits in the builder pane update the query bar instantly in SYNCED.
- Typing in the bar flips to DIRTY and stops auto-recompile.
- "Re-sync builder" successfully parses and updates the builder (W04 §3 contract).
- "Accept builder" overwrites the bar.
- ** Builder edits while DIRTY — including click-to-sort on a
  result column (`sortFieldPatch`) — leave `queryRaw` and `queryDirty`
  untouched.
- Run honors the current `queryRaw` regardless of sync state.
- `⌘↵` runs; `Esc` cancels.
- A run the client refuses keeps the rows, dimmed. A run the server refuses replaces them with the error (W06 §5).
- The result bar reflects `documents.length`, count (when available), duration, and error state correctly.

## 8. Test cases

### Component
- **sync-happy.spec.tsx**: change a builder condition → bar updates; sync pill stays SYNCED.
- **dirty-parseable.spec.tsx**: hand-edit to `{ amount: { $gt: 10 } }` → DIRTY pill offers Re-sync. Click it → builder reflects the new condition; SYNCED again.
- **dirty-freeform.spec.tsx**: hand-edit to `{ $expr: { … } }` → DIRTY (parseNo); builder pane is disabled.
- **run-uses-queryRaw.spec.tsx**: set DIRTY, click Run → mock `api.query.find` receives the raw bar text, not the builder-compiled MQL.
- **invalid-ejson.spec.tsx**: bar contains `{ not json` → Run disabled; the reason shows beside Run.
- **cancel-esc.spec.tsx**: start a run (mock resolves after 2s); press Esc → `api.query.cancel` called; no banner shown.

### Integration
Cross-covered with W03 (query runner).

### E2E
- **workspace-run.e2e.ts**: open a seeded coll → builder has one condition → Run → result appears; hand-edit to freeform → builder disabled; Re-sync bar into builder → builder repopulates.
