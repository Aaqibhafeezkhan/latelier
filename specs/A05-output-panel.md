# A05 — Pipeline output panel

> **Status: Implemented.**

## Purpose

The bottom panel of the aggregation tab. Shows the pipeline's final output in Tree / JSON / Table form, with a resizable height. Reuses W06's view components where possible, with agg-specific affordances (copy-all, save-as-collection, download JSON).

## Scope

- **In**: Output panel shell, drag-to-resize, view toggle, empty/loading/error states, Copy, Save as collection (which triggers A06), download JSON.
- **Out**: Explain drawer (A06), stage preview (A03).

## Dependencies

- W06 (views), A01 (state), A04 (result).

## 1. Layout

```
┌─ drag handle (6px) ─────────────────────────────────────────────────┐
├─ header ────────────────────────────────────────────────────────────┤
│ Pipeline output  · 5 docs · 128ms       [Tree/JSON/Table]  [Copy]   │
│                                                         [Save as…] [⇩]│
├─ body ──────────────────────────────────────────────────────────────┤
│ docs                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. Behavior

### Drag handle
- Changes `state.outputHeight` between 120 px and 70% of window height. Persisted via tab state (W01).
- Double-click resets to default 260 px.

### View toggle
- Same control as W06. State stored in `state.outputView`.

### Copy
- Copies pretty-printed EJSON array of all rows (not EJSON relaxed) to clipboard.
- Copies the output, not the pipeline: the pipeline itself is copied from the title bar's Copy menu (A01 §4).

### Save as collection
- Opens A06 "Save as collection" modal — fills in `$out` stage and re-runs if allowed. See A06.

### Download JSON (⇩)
- Opens `dialog.showSaveDialog` (via `app:saveFile` IPC returning a path or null). On success, writes the full EJSON array to disk.

## 3. Views

- **Tree / JSON / Table** delegate to W06 components with the aggregation's `rows` instead of the workspace's docs.
- Table view treats nested `_id` objects (common in aggregation output) by flattening top-level keys, showing `_id.account`, `_id.month`, etc.

## 4. States

- **No run yet**: centered placeholder "Run the pipeline to see output".
- **Running**: subtle overlay with spinner; keeps previous output visible.
- **Empty result**: "Pipeline returned no documents".
- **Error**: error card with code + message; "Show details" expands to raw error JSON.

## 5. Acceptance criteria

- Drag handle resizes the panel within the documented bounds; double-click resets.
- Height persists across tab switches and relaunches.
- View mode switches synchronously (no re-run).
- Copy produces EJSON canonical output.
- Download writes a valid file to the chosen path.
- Save as collection opens the A06 modal with target collection pre-filled.
- Error state shows code and message; "Show details" reveals the raw error.

## 6. Test cases

### Component
- **resize.spec.tsx**: drag pushes height; persists via `api.tabs.update`.
- **view-switch.spec.tsx**: toggling Tree/JSON/Table doesn't call any IPC.
- **copy.spec.tsx**: click Copy → clipboard receives expected EJSON.
- **download.spec.tsx**: click ⇩ → mocked `api.app.saveFile` called; file write channel receives payload.
- **empty.spec.tsx**: `rows=[]` → empty placeholder.
- **error.spec.tsx**: mock error → card with code; "Show details" reveals JSON.
