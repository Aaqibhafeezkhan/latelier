# A01 — Aggregation shell + tab routing

> **Status: Implemented.** Aggregation opens as a sub-view of the collection tab, not as a tab of its own.

## Purpose

Wire the existing Aggregation mock as an in-workspace tab type rather than a standalone page. Provides the title-bar actions, the tab lifecycle, and the hosting container that holds the pipeline outline, stage accordion, and output panel.

## Scope

- **In**: Aggregation tab layout, title-bar actions (Save/Save as/Run/Explain), `WorkspaceTab.kind = 'aggregation'` integration, breadcrumb, dark toggle, name/state persistence.
- **Out**: Pipeline model (A02), stage UI (A03), runner (A04), output panel (A05), save/explain mechanics (A06).

## Dependencies

- W01 (tabs), A02–A06.

## 1. Route / containment

- No dedicated URL. Aggregation lives inside `/workspace` as a `kind: 'aggregation'` tab.
- The existing `Aggregation.tsx` file becomes a **component** (`AggregationTab`), not a page; `App.tsx`'s `/aggregation` route is removed.
- Tabs:
  - "Open aggregation on current collection" from W01's new-tab menu creates one.
  - C07's row context menu `Open as aggregation` creates one.
  - Saved aggregation "Open in new tab" (W09) creates one hydrated with stages.

## 2. Layout

```
┌─ Title bar ─────────────────────────────────────────────────────────┐
│ [< Connections]  Conn / db / coll · agg(pipeline name)   [🌙/☀]    │
│                               [Save] [Save as] [Run] [Explain] [Copy]│
├─ Tab strip (shared with workspace) ─────────────────────────────────┤
│ ⚡ journalEntry   Σ monthlyByAccount (×)                    [+▾]    │
├─ Body ──────────────────────────────────────────────────────────────┤
│ ┌─PipelineOutline──┐ ┌─StageAccordion─────────────────────────────┐ │
│ │ source           │ │ source card                                │ │
│ │ stage 1          │ │ AddStagePill                               │ │
│ │ stage 2 (active) │ │ Stage 1 …                                  │ │
│ │ output           │ │ …                                          │ │
│ └──────────────────┘ │                                            │ │
│                      │                                            │ │
│                      ├─Output panel (draggable handle)────────────┤ │
│                      │ Pipeline output · Tree/JSON/Table          │ │
│                      └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. State (subset of `AggregationTabState`, W01)

```ts
{
  name?: string;
  savedId?: string;
  stages: Stage[];
  activeStageId: number | null;
  outputHeight: number;          // px
  outputView: 'Tree' | 'JSON' | 'Table';
  lastRun?: {
    rows: unknown[];             // EJSON
    durationMs: number;
    ranAt: string;
    stageCounts: Record<number, number>;  // stage.id → count after that stage
    error?: IpcError;
  };
  dirty: boolean;
}
```

`dirty` flips when `stages` changes after a save/load. Used for the close-tab confirmation (W01).

## 4. Title bar actions

### Save
- If `savedId` present: `api.saved.update(savedId, { payload: { kind: 'aggregation', stages } })` → `setDirty(false)`.
- Else: same UX as Save as.

### Save as
- Opens Save modal (W09). On success, sets `savedId` + `name` and clears `dirty`.

### Run
- Invokes the runner (A04). Visually kicks off:
  - Disables other Title bar actions while running.
  - Updates outline stage counts and the output panel with results.
- Keyboard `⌘↵`.

### Explain
- Runs the aggregation in explain mode (A06). Opens a side drawer with the explain JSON.
- Keyboard `⌘E`.

### Copy
- A menu, disabled while the pipeline does not validate. "Pipeline (EJSON array)" copies the enabled stages as one Canonical EJSON array; mongosh, Node.js and Python copy an `aggregate` call for that driver.
- Each enabled body is repaired from Shell Syntax first, on a copy: the tab's own bodies are not rewritten. A body that cannot be repaired copies nothing and names the stage by its 1-based position.
- Each stage is a plain literal; each exact EJSON sentinel in it goes through the driver's own EJSON parser (`EJSON.parse(…, { relaxed: false })`, `json_util.loads`), so an ObjectId or a Long keeps its type. Only the sentinel: the drivers' parsers revive looser shapes than the app, such as `{ $regex, $ne }` as a regex. An Int32 or a fractional Double is written as a bare number, which every driver sends as that type.

### Dark toggle
- Reuses the global `DarkToggleCtx` (X01). No special behavior.

## 5. Breadcrumb

Format: `{connection.name} / {dbName} / {collection} · {name ?? 'Unsaved pipeline'}`. Dirty state is indicated by a small dot next to the name.

## 6. Close-tab guard

If `dirty: true` and user closes via `×` or `⌘W`:
- Dialog "Discard pipeline changes? The pipeline has unsaved edits." with `Cancel`, `Discard`, `Save…`. `Save…` opens Save-as modal; on success, close the tab.

## 7. Acceptance criteria

- Aggregation opens as a tab in Workspace, not a separate route.
- Closing the tab with `dirty=true` prompts; `dirty=false` closes silently.
- Save updates an existing saved pipeline; Save as always opens the modal.
- Title bar buttons reflect disabled state while a run is in flight.
- Dark toggle persists across aggregation/collection tabs within the same window.

## 8. Test cases

### Component
- **shell-render.spec.tsx**: hosted inside workspace, title bar breadcrumb reads connection/db/coll/name.
- **save-vs-save-as.spec.tsx**: with `savedId` → Save calls update; without → Save opens modal.
- **run-disables-buttons.spec.tsx**: when running, Save/Save as/Explain disabled; Run becomes Cancel (A04 cancellation).
- **dirty-close-guard.spec.tsx**: modify stages → attempt close → dialog; Save→close; Cancel keeps tab.
- **breadcrumb-dot.spec.tsx**: dirty adds a dot; save clears.
