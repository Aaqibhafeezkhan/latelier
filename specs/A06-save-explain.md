# A06 — Save pipeline / save as collection / explain

> **Status: Implemented.**

## Purpose

Three closely-related title-bar actions that extend the aggregation tab beyond "run + display": persisting a named pipeline for reuse, writing pipeline output to a new collection (via `$out`), and inspecting the query-planner's execution plan.

## Scope

- **In**: Save / Save as (thin wrapper around W09), Save as collection modal + server action, Save as view, Explain drawer + runner.
- **Out**: Saved-queries storage (W09), runner internals (A04).

## Dependencies

- W09, A01, A04, F05.

## 1. Save / Save as

Covered operationally in A01 §4 and W09 §5. Recap:
- Aggregation payload shape: `{ kind: 'aggregation', stages }`.
- Save uses `saved:update` if `savedId` is set, else falls through to Save as.
- Save as opens the W09 modal with `kind: 'aggregation'` preset.
- On success, tab state updates `{ savedId, name, dirty: false }`.

No new IPC surface.

## 2. Save as collection

Writes the pipeline result to a target collection by appending a `$out` stage (or `$merge` if chosen) and re-running.

### Modal

Triggered from the output panel's "Save as…" button or a pipeline-level action "Save results to collection".

Fields:
- **Target database** (select; default is current dbName).
- **Target collection** (text; validation: Mongo naming rules).
- **Mode**:
  - `$out` — replace collection contents atomically (default).
  - `$merge` — merge using `_id`. Shows advanced fields (`whenMatched`, `whenNotMatched`) when selected.
- **Warning banner**:
  - `$out`: "This replaces all documents in the target collection."
  - `$merge`: "Existing documents with matching `_id` will be replaced/updated; non-matching documents will be inserted."
- **Confirm button**: requires typing the target collection name (same pattern as W08 bulk delete).

### Server action

```ts
// IPC channel
'agg:runAndSave'  (AggInput + { target: { dbName, collection, mode: '$out'|'$merge'; merge?: MergeOptions } })
  → AggResult & { writtenCount?: number; mergeCounts?: { before: number; after: number } }
```

Implementation:
- Append `{ $out: "coll" }` or `{ $merge: { into: "coll", whenMatched, whenNotMatched } }` to the user's pipeline.
- Call `agg:run` with `allowWrite: true`.
- The resulting `AggResult.rows` is empty for `$out`/`$merge` (they don't return documents); the UI shows a success banner. `$out` replaces the target, so it reads "Wrote N documents to {db}.{coll}" (N via `countDocuments` post-run, returned as `writtenCount`). `$merge` keeps and updates what the target already holds, so the total is not a count of what was written: the service counts the target before and after the run (`mergeCounts: { before, after }`) and the banner reads "Merged into {db}.{coll} — now N documents (+M new)", or just "Merged into {db}.{coll}" when a count could not be read.
- The pipeline stored in the tab does NOT get the write stage appended; this is a one-shot run. If the user wants to persist the write, they can add the stage themselves via A03.

### Error handling

- Invalid target collection name → VALIDATION.
- `Unauthorized` → UNAUTHORIZED banner explaining the user lacks `insert` / `update` privileges.
- Namespace conflict (target equals source with `$out`) → CONFLICT.

## 2b. Save as view

Saves the pipeline itself, not its output, as a read-only view on the open collection.

- **Trigger**: the output panel's "Save as view…" button, next to "Save as…". It is enabled whenever the pipeline is not running; it needs no output rows, because nothing is run.
- **Modal**: one "View name" field. The view is created in the **same database** as the source collection, because MongoDB requires a view and its `viewOn` to share a database, so there is no target-database field.
- **Pipeline**: the enabled stages, after the same Shell-Syntax repair a run applies, serialized as one canonical EJSON array. A stage whose body does not parse is named inline by its position in the builder and operator, with the parser's reason (`stage 2 ($group): invalid EJSON — …`), and nothing is sent.
- **Write stages**: an enabled `$out` or `$merge` is refused inline before any call, since a view only reads. A disabled one is ignored. Main refuses them too, as VALIDATION on `pipeline`.
- **Server action**: `collection:create` with `options: { viewOn: <source>, pipeline }`. A duplicate name comes back as CONFLICT and shows inline; the dialog stays open.
- **Dismiss**: Escape with a typed name asks before discarding it; a click outside does nothing.
- **After**: a toast names the view. The navigator is not refreshed by the save, the same as Save as collection.

## 3. Explain

Triggered by the title-bar Explain button or `⌘E`.

### IPC channel

| Channel       | Input                                   | Output              |
| ------------- | --------------------------------------- | ------------------- |
| `agg:explain` | `AggInput + { verbosity }`              | `{ plan: unknown }` |

`verbosity`: `queryPlanner` (default) | `executionStats` | `allPlansExecution`.

Server implementation:
- `collection.aggregate(pipeline).explain(verbosity)`.
- Strips sensitive fields from the plan before returning (none currently, but the hook exists).
- Skips write stages in the pipeline when generating explain (silently removes `$out`/`$merge` before calling; documented in the drawer).

### Drawer UI

- Slide-in from the right, 520 px wide, full height.
- Header: title, verbosity selector, close.
- Body: a stage tree above the syntax-highlighted EJSON of the explain plan, which has expand/collapse buttons for nested sections.
- Stage tree: one row per stage of the winning plan (`buildPlanTree`), as a nested read-only list, with the index name and key pattern on an `IXSCAN`. At `executionStats` and above each row carries the figures its own stage reported (`nReturned`, `docsExamined`, `keysExamined`, `~Nms`); at `queryPlanner` the rows have no figures. A `COLLSCAN` row uses the warning treatment. An aggregation shows a `pipeline` root: the `$cursor` subtree first, then one row per later `$`-operator. A sharded plan has one child per shard, the shard's root row carrying the shard name. Figures read the same whether they arrive bare (`query:explain`) or as canonical EJSON numbers (`agg:explain`). A plan the builder does not recognize shows no tree; the EJSON view is still there.
- Ceiling: a slot-based (SBE) plan shows its classic stage names from `queryPlan`, with no per-stage figures, because the executed slot tree uses different names. Mapping them by `planNodeId` would lift it.
- A caller that already holds a plan (the result bar's plan badge) passes it as `initialPlan`: the drawer shows it without fetching, and a verbosity change fetches.
- Footer: `Copy` (clipboard), `Download` (save JSON file).
- A small "Stages with write ops were omitted" notice if applicable.

### Performance

- Explain queries can be as expensive as the real run for `executionStats`+. The drawer shows a spinner; cancellation button aborts via `agg:cancel` keyed on a new token.

## 4. Acceptance criteria

- Save/Save as delegate to W09 correctly; tab state updates reflect saved status.
- Save as collection with `$out` replaces the target collection's contents; a banner reports the new count.
- `$merge` mode respects `whenMatched`/`whenNotMatched`.
- Target equals source with `$out` is rejected before running.
- Explain drawer renders a plan for `queryPlanner` on a seeded collection.
- Explain with `$out`/`$merge` in the pipeline succeeds and shows the omission notice.
- Save as view creates a view on the source collection, in its database, whose documents are the enabled stages' output.
- Save as view refuses an enabled `$out`/`$merge` inline and sends nothing.

## 5. Test cases

### Integration (memory Mongo)
- **out-happy.spec.ts**: seed source coll; run agg:runAndSave with `$out`; target coll now has expected docs.
- **merge.spec.ts**: pre-existing target doc gets merged on matching `_id`; non-matching inserted.
- **target-equals-source.spec.ts**: CONFLICT.
- **unauthorized.spec.ts**: read-only user → UNAUTHORIZED.
- **explain-queryplanner.spec.ts**: call explain → `plan.stages` present.
- **explain-strips-write-stage.spec.ts**: pipeline with `$out` → explain runs without writing; response flagged with omission note.

### Component
- **save-as-collection-modal.spec.tsx**: require name typed to enable Confirm; submitting calls `api.agg.runAndSave`.
- **save-as-view-modal.spec.tsx**: submitting calls `collection.create` with `viewOn` = the source and the enabled stages' pipeline; an enabled write stage or an unparsable body is refused inline with no call; Escape on a typed name asks to discard.
- **output-panel.spec.tsx**: "Save as view…" is enabled with no output rows and disabled while running.
- **explain-drawer.spec.tsx**: click Explain → drawer opens; verbosity toggle re-fetches.
- **explain-copy-download.spec.tsx**: Copy writes to clipboard; Download calls `app:saveFile`.
- **explain-drawer.spec.tsx**: the stage tree renders a row per stage with its figures, a `COLLSCAN` row says so, an unrecognized plan shows no tree; with `initialPlan` the drawer does not fetch on open (StrictMode included) and fetches once on a verbosity change.

### Unit
- **explain-summary.spec.ts**: `buildPlanTree` for classic, `inputStages`, queryPlanner-only, aggregation, SBE and sharded plans; non-numeric figures are not copied; unrecognized input gives `null`.

### E2E
- **agg-full-flow.e2e.ts**: open agg tab → build pipeline → Run → Save (enters modal) → Save as collection → verify new collection exists → Explain → drawer visible with plan.
- **a06-explain-plan.e2e.ts**: at `executionStats` the drawer's stage tree shows the stage name and its figures.
- **w02-views-validation.e2e.ts**: `$match` → Save as view → Refresh collections lists the view; Modify view changes what it returns.
