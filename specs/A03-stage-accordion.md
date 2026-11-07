# A03 — Stage accordion + add-stage picker

> **Status: Implemented.**

## Purpose

The center of the aggregation tab: a vertical list of stages where each one expands into a split editor + stage-output preview. Between every stage and above/below the list, an "+Add stage" pill opens a searchable picker that inserts a new stage at the right position.

## Scope

- **In**: Stage row (collapsed + expanded layout), editor (textarea with EJSON validation), stage preview pane driven by A04 §4, per-stage toolbar (toggle, reorder, delete), add-stage pill + picker.
- **Out**: Pipeline-level ops (A02), runner internals (A04), output panel (A05).

## Dependencies

- A02 (model), A04 (stage-preview IPC), F04.

## 1. Stage row — collapsed

Header line, always visible:
```
[⋮⋮] [#] [$match]  field-summary                   [ctr] [ON] [▲][▼][🗑] [▾]
```
- `⋮⋮` drag handle (handed off to outline's drag but also works here).
- `#` index (1-based).
- `$match` colored badge (OP_COLOR). **Editable (T2.1)**: the badge is a
  button, not read-only text. Clicking it opens the same `StageOpPicker`
  used by the add-stage pill (§4), anchored under the badge, so a
  mis-picked operator can be swapped in place without deleting the stage.
  The click stops propagation so it doesn't also toggle the row's
  expand/collapse. Body handling on op-change is deterministic: the
  existing body is preserved unless it's empty or still equals the prior
  op's default body (`DEFAULT_BODIES`), in which case it's replaced with
  the new op's default (see `setOp` in `pipeline.ts`).
- Field-summary: heuristic one-line summary of the body (e.g., `date: …` for a match, `account: …` for a group). Algorithm:
  - Parse EJSON; if fails, show `"(invalid)"` in warn color.
  - If `op === '$match'`: take first key → `field: …`.
  - If `op === '$group'`: show `_id: …, metrics: N`.
  - Else first line of body truncated.
- `ctr` — count after this stage (from the last run). Gray badge. "stale" indicator (⚠) if stage edited since last run.
- `ON/OFF` toggle.
- `▲`/`▼` move; `🗑` delete.
- `▾` expand.

## 2. Stage row — expanded (split view)

```
┌───────────────────────────────────────────┬────────────────────────────┐
│ Editor (fills the rest)                    │ Stage preview (280 px)     │
│                                            │ ─ header: {count} docs ─   │
│  { textarea, EJSON syntax hint }           │                            │
│                                            │ { doc }                    │
│                                            │ { doc }                    │
│                                            │ { doc }  (first 5)         │
│                                            │                            │
│  [Copy] [Format]  …                        │                            │
└───────────────────────────────────────────┴────────────────────────────┘
```

When the stage list is narrower than 640 px, the editor sits above a full-width preview instead, so the editor never shrinks below a readable width. A container query on the stage list decides this, not the window width, because the navigator and outline take varying room. In neither layout does the height depend on the preview's documents: side by side it is fixed, and stacked it is the fixed-height editor plus a fixed-height preview, so a run never moves the page.

### Editor
- Monospace textarea. Grows with content, height clamped (min 140, max 500 px; user-resizable via resize handle).
- Inline validation: EJSON parse on blur (or after 400ms idle). Error → red bar under editor with message.
- `Format` button pretty-prints via `EJSON.stringify(parsed, { relaxed: false })` with 2-space indent; if parse fails, no-op + toast.
- `Copy` copies the current body to clipboard.
- `Shift+⌘↵` runs only up to this stage (calls `agg:previewUpToStage`, A04 §4).
- **Autocomplete** (X02 + X03): field-name and MQL-operator
  suggestions at key positions, field-ref suggestions inside `"$…"`
  strings on the value side or in arrays. Wired via
  `useTextareaAutocomplete({ stageOp: stage.op, … })` so operator
  ranking is context-aware — accumulators rank first inside `$group`
  bodies, expression ops inside `$project`/`$set`/`$addFields`, query
  ops everywhere inside `$match`, full catalog inside `$facet` and
  unknown stages. The tab's current `lastRun.rows` supplies
  `recentDocs`. `valueFor` hits are detected but suppressed until
  value sources land.

### Stage preview
- Reads `lastRun.stageSamples[stage.id]` (an array of up to 5 EJSON docs; see A04).
- If no run yet: "Run to see output" placeholder.
- If stage disabled: "Stage is disabled" placeholder.
- "Refresh preview" button calls `agg:previewUpToStage({stageId, limit: 5})` and updates in place.

## 3. Interactions

- Clicking the collapsed header expands/collapses; exactly ONE stage is expanded at a time (accordion). Clicking another stage closes the first.
- `activeStageId` in pipeline state reflects the expanded stage.
- Escape in the editor unfocuses.

## 4. Add-stage pill + `StageOpPicker` (T2.1)

Located before the first stage, between every pair of stages, and after the last stage (matches existing mock).

The picker itself — search input, keyboard nav, operator list, doc side-panel — is a single shared `StageOpPicker` component. It's used from two triggers: the add-stage pill (inserts a new stage) and the stage-row op badge (§1, changes an existing stage's op in place). Both get identical search/keyboard/description behavior for free.

- Click opens a popover anchored below the trigger:
  - Input: search.
  - List of operators (`KNOWN_STAGE_OPS`, 24 entries as of T2.1 — the
    original 16 plus `$facet`, `$bucket`, `$sample`, `$graphLookup`,
    `$unionWith`, `$setWindowFields`, `$geoNear`, `$documents`). Each
    item: colored badge + operator + short description (description
    drawn from the shared `OPERATORS` catalog via `stageOperatorSummary`;
    see X03 §1).
  - Search accepts bare names — typing `sort` matches `$sort`.
  - Keyboard: `↑/↓` to navigate; `Enter` to pick; `Esc` closes.
  - **"Other / custom stage…"** row at the bottom of the list (T2.1):
    reveals a small text input; submitting (`Enter` or the `Add` button)
    picks `$<name>` (normalized to a single leading `$`). `Stage.op` is
    already typed `StageOp | string`, so custom ops need no type change;
    `validatePipeline` already warns (doesn't block) on non-`KNOWN` ops,
    and the row/outline already render an "Unknown op" badge for them —
    that path now also carries user-authored custom ops.
- Picking inserts the stage at the pill's position with a sensible default body (matches existing `defaultBodies` map). The new stage is auto-expanded.

### Default bodies (updated)

```ts
const DEFAULTS: Record<StageOp, string> = {
  '$match':      '{\n  \n}',
  '$group':      '{\n  _id: "$field",\n  count: { $sum: 1 }\n}',
  '$sort':       '{ field: 1 }',
  '$project':    '{\n  field: 1\n}',
  '$addFields':  '{\n  newField: "$existingField"\n}',
  '$set':        '{\n  newField: "$existingField"\n}',
  '$unset':      '"fieldToDrop"',
  '$limit':      '100',
  '$skip':       '0',
  '$count':      '"totalCount"',
  '$lookup':     '{\n  from: "collection",\n  localField: "_id",\n  foreignField: "_id",\n  as: "result"\n}',
  '$unwind':     '"$arrayField"',
  '$replaceRoot':'{ newRoot: "$subdoc" }',
  '$redact':     '"$$KEEP"',
  '$out':        '"outputCollection"',
  '$merge':      '{\n  into: "outputCollection",\n  whenMatched: "merge",\n  whenNotMatched: "insert"\n}',
  // T2.1 — the 8 named common stages added to the curated set:
  '$facet':           '{\n  outputA: [ ]\n}',
  '$bucket':          '{\n  groupBy: "$field",\n  boundaries: [ ],\n  default: "other",\n  output: { }\n}',
  '$sample':          '{ size: 100 }',
  '$graphLookup':     '{\n  from: "collection",\n  startWith: "$field",\n  connectFromField: "field",\n  connectToField: "field",\n  as: "result"\n}',
  '$unionWith':       '{\n  coll: "collection",\n  pipeline: [ ]\n}',
  '$setWindowFields': '{\n  partitionBy: "$field",\n  sortBy: { field: 1 },\n  output: { }\n}',
  '$geoNear':         '{\n  near: { type: "Point", coordinates: [ 0, 0 ] },\n  distanceField: "dist",\n  spherical: true\n}',
  '$documents':       '[ ]',
};
```

Note: like the pre-existing defaults above (unquoted keys, e.g. `$group`'s `_id: "$field"`), these are "sensible" placeholders, not strict-JSON. `validateStageBody`/`isValidEjson` requires strict JSON (`JSON.parse`), so several defaults — old and new — intentionally fail validation until the user edits them; that's expected, not a bug.

## 5. Write-stage guard

Any `$out` or `$merge` stage shows a warning strip across the stage header: "This stage writes to MongoDB. Runs outside Explain will modify data." Disabling the stage hides the warning.

## 6. Acceptance criteria

- Expanding a stage activates it in the outline; only one stage is expanded at a time.
- Editing the body and unfocusing validates as EJSON; invalid shows inline error.
- `Format` pretty-prints valid bodies; silently no-ops on invalid.
- The add-stage pill picker supports keyboard navigation and search.
- Inserted stages receive sensible default bodies; id is unique; ordering matches pill position.
- `$out` / `$merge` stages show a write warning in the header.
- `Shift+⌘↵` runs a preview up to that stage.
- **(T2.1)** A stage's operator can be changed in place from the collapsed header, without deleting/re-adding the stage.
- **(T2.1)** The op picker offers the expanded curated set (24 ops, including the 8 named common stages) plus an "Other / custom stage…" escape hatch for any `$operator` name.
- **(T2.1)** A stage whose op isn't a recognized operator shows the "Unknown op" badge (row + outline); a curated op does not.
- **(T2.1)** Changing op to/from `$out`/`$merge` toggles the write-warning strip.
- **(T2.1)** Changing a stage's op with its body unchanged marks the stage stale (the run/stale signature is keyed on op **and** body — see `stageSig` in `pipeline.ts` — not body alone).
- **(T2.1)** Body-on-op-change is deterministic: the user's body is preserved unless it was empty or equalled the prior op's default body.

## 7. Test cases

### Component
- **collapsed-render.spec.tsx**: summary heuristic for `$match` / `$group`.
- **expand-single.spec.tsx**: expanding stage 2 collapses stage 1.
- **editor-validate.spec.tsx**: typing invalid EJSON → error bar; valid body clears it.
- **format-click.spec.tsx**: mock valid body → clicking Format calls `EJSON.stringify` indirectly (observe textarea value).
- **stage-accordion.spec.tsx** (`StageOpPicker` / T2.1): open picker → type "mat" → highlights `$match` → enter inserts at correct index with default body. Typing `sort` (no `$`) matches `$sort`. Clicking the stage-row op badge opens the same picker and calls `onChangeOp`; "Other / custom stage…" submits a normalized `$name`; unknown-op badge renders only for non-curated ops.
- **aggregation-tab.spec.tsx** (T2.1): changing a stage's op after a run (body unchanged) marks it stale; changing op to `$out` shows the write-warning strip, changing away hides it.
- **keyboard-run-stage.spec.tsx**: Shift+⌘↵ in editor → `api.agg.previewUpToStage` called with stage id.
- **write-warning.spec.tsx**: adding `$out` renders the warning strip.

### Unit
- **pipeline-ops.spec.ts**: `setOp` body-preservation rules (preserve / swap-to-default on empty / swap-to-default on prior-default, custom op, missing id no-op); `stageSig` differs on op-only and body-only changes; `KNOWN_STAGE_OPS`/`DEFAULT_BODIES` include the 8 named stages.

### Integration
Preview-up-to-stage covered in A04 tests.
