# A04 — Aggregation runner service

> **Status: Implemented.** The `agg.instrumentation` setting in §3 is not wired: the runner always tries `$facet` first.

## Purpose

Execute `aggregate()` against Mongo on the main side, capture per-stage document counts and samples, stream results back to the renderer, handle cancellation, and route write stages (`$out`, `$merge`) through an explicit confirmation.

## Scope

- **In**: `AggregationService` in main; `agg:run`, `agg:previewUpToStage`, `agg:cancel` IPC channels; per-stage instrumentation; cancellation; recent-capture.
- **Out**: Explain (A06), output UI (A05).

## Dependencies

- F05 (pool), W10 (recent), A02 (model), A03 (preview consumer).

## 1. Types

```ts
export interface AggInput {
  connectionId: string;
  dbName: string;
  collection: string;
  stages: Stage[];            // full pipeline; disabled stages filtered here server-side
  limit?: number;             // default 1000; cap on doc return
  cancelToken?: string;
  allowWrite?: boolean;       // must be true for $out / $merge
}

export interface AggStagePreview {
  stageId: number;
  count?: number;
  sample: unknown[];          // up to N docs (default 5)
}

export interface AggResult {
  rows: unknown[];            // EJSON, capped by limit
  durationMs: number;
  totalCount?: number;        // only when output stage is $count
  stageCounts: Record<number, number>;
  stageSamples: Record<number, unknown[]>;
  hasMore: boolean;           // rows.length === limit
}

export interface PreviewInput {
  connectionId: string;
  dbName: string;
  collection: string;
  stages: Stage[];            // up to and INCLUDING the preview stage
  limit?: number;             // default 5
}
```

## 2. Channels

| Channel                   | Input         | Output          |
| ------------------------- | ------------- | --------------- |
| `agg:run`                 | `AggInput`    | `AggResult`     |
| `agg:previewUpToStage`    | `PreviewInput`| `AggStagePreview` |
| `agg:cancel`              | `{token}`     | `void`          |

## 3. Run implementation

```ts
async run(i: AggInput): Promise<AggResult> {
  const enabled = i.stages.filter(s => s.enabled);
  if (enabled.length === 0) throw validation('stages', 'no enabled stages');
  const writeStage = enabled.find(s => isWriteStage(s.op));
  if (writeStage && !i.allowWrite) throw validation('allowWrite', 'run blocked: write stage present');

  const pipeline = enabled.map(s => ({ [s.op]: ejsonParse(s.body) }));
  const ctrl = this.registerCancel(i.cancelToken);
  const coll = (await this.pool.getDb(i.connectionId, i.dbName)).collection(i.collection);
  const limit = Math.min(i.limit ?? 1000, 10_000);

  const t0 = Date.now();

  // Main result cursor
  const cursor = coll.aggregate([...pipeline, { $limit: limit }], { signal: ctrl.signal });
  const rows = ejsonEncodeArray(await cursor.toArray(), false);

  // Per-stage instrumentation (see §4)
  const { stageCounts, stageSamples } = await this.instrument(coll, enabled, ctrl.signal);

  await this.recent.recordAggregation(i, Date.now() - t0, rows.length);
  return {
    rows,
    durationMs: Date.now() - t0,
    stageCounts,
    stageSamples,
    hasMore: rows.length === limit,
  };
}
```

## 4. Per-stage instrumentation

Computing an intermediate count for every stage is expensive; doing it naïvely would multiply the cost by N (pipelines re-run up to each stage). We use `$facet` to run the full pipeline once and emit per-stage bookends:

```js
db.coll.aggregate([
  { $facet: {
      after_1: [ stage1, { $count: 'c' } ],
      sample_1: [ stage1, { $limit: 5 } ],
      after_2: [ stage1, stage2, { $count: 'c' } ],
      sample_2: [ stage1, stage2, { $limit: 5 } ],
      // …
      final: [ stage1, …, stageN, { $limit: LIMIT } ],
  } },
])
```

Tradeoffs:
- Works on most deployments; `$facet` has memory caps (100 MB by default). For iteration 1 we document the cap.
- If `$facet` fails (memory-limit, disallowed stage inside facet like `$out`/`$merge`/`$lookup` with unsupported pipeline), fall back to **separate per-stage runs** (N round-trips). A setting `instrumentation: 'facet' | 'separate' | 'off'` defaults to `'facet'` and can be flipped via `app_state['agg.instrumentation']`.

`$out` / `$merge` cannot appear in a `$facet` branch; when `allowWrite` is true we run the main pipeline separately and skip instrumentation for the final write stage (its "count" is `undefined`).

Preview-up-to-stage is simpler: run the truncated pipeline plus `$limit: N`; return sample.

## 5. Cancellation

- `registerCancel(token)` creates an `AbortController` keyed by token.
- `agg:cancel` aborts it; active cursors close.
- A write pipeline (`$out`/`$merge`) is the exception: the server does not stop the write when its client disconnects, so once the write is sent it runs to completion and the run reports completed (with empty per-stage counts when the cancel lands before instrumentation finishes), never "cancelled". A cancel that arrives before the write is sent still rejects with "cancelled". A sent write that fails on its own (a duplicate key under `whenMatched: 'fail'`, a timeout, a permission error) is reported as that error even after a cancel, since part of it may have landed.
- In the tab, Cancel on a read-only run stops it at once and drops its late result. Cancel on a confirmed write run keeps waiting instead: the run button reads "Stopping…" and a toast explains that a started write stage can't be interrupted; the run then shows its normal result plus a "ran to completion" notice, shows main's error in the output panel if the write failed, or stops quietly if main reports "cancelled".
- Auto-cancel on tab close.

## 6. Write-stage confirmation

When the UI calls `agg:run` with a pipeline containing `$out` / `$merge` and `allowWrite !== true`:
- Handler returns VALIDATION with `details: { writeStageOp, targetCollection, kind }`.
- UI (A01's Run) surfaces a modal:
  > Running this pipeline will write to collection `outputCollection` via `$out`. This replaces the collection's contents. Proceed?
  > [Cancel] [Proceed]
- On Proceed, UI re-invokes `agg:run` with `allowWrite: true`.

## 7. Validation

Each stage body parsed as EJSON; unparseable → VALIDATION with `details.stageId`. Then the server delegates remaining validation to Mongo (catches unknown ops etc.) and classifies errors via F05's classifier + `MONGO_ERROR` code.

## 8. Limits

- Default `limit`: 1000.
- Max `limit`: 10 000.
- Row serialization memory is bounded by limit × average doc size; a crude guard refuses results > 200 MB serialized (classify as `INTERNAL`).
- `maxTimeMS` honored if passed via stage body (advanced users); else service defaults to 60 seconds.

## 9. Acceptance criteria

- A valid pipeline produces `rows`, `stageCounts`, and `stageSamples` populated for each enabled stage (except the final write stage if any).
- Disabled stages don't affect execution or instrumentation.
- Cancellation aborts both the main cursor and the instrumentation facet.
- `$out`/`$merge` without `allowWrite: true` returns VALIDATION with structured details.
- Fallback "separate" instrumentation runs when `$facet` is impossible.
- Recent query row is inserted for each run.

## 10. Test cases

### Integration (memory Mongo, seeded)
- **run-happy.spec.ts**: two-stage pipeline → rows non-empty; stage counts > 0.
- **run-disabled.spec.ts**: disable stage 1 → execution skips it; stageCounts omits disabled ids.
- **write-stage-gate.spec.ts**: `$out` without `allowWrite` → VALIDATION `details.writeStageOp == '$out'`.
- **write-stage-allow.spec.ts**: `$out` with `allowWrite: true` → data written.
- **cancel.spec.ts**: long `$lookup` → cancel token → agg:run rejects with internal "cancelled"; subsequent runs unaffected.
- **facet-fallback.spec.ts**: seed a pipeline whose `$facet` variant fails → service falls back to separate runs; stageCounts still populated.
- **preview-up-to-stage.spec.ts**: request preview after stage 2 → sample length ≤ 5.
- **recent-capture.spec.ts**: after run, `recent_queries` has an aggregation entry for this connection.

### Unit
- **isWriteStage.spec.ts**: `$out`, `$merge` → true; others → false.
- **build-facet.spec.ts**: pipeline → `$facet` body expected shape (fixture).
