# W06 — Result views (Tree / JSON / Table)

> **Status: Implemented.** The preview-fields picker in §2 was removed; the Fields control replaced it.

## Purpose

Render the current result set in one of three views. Tree shows collapsed rows with a preview and expands to a typed field grid. JSON shows syntax-highlighted EJSON. Table shows tabular rows with column overflow. All three share a single data source (the tab's last successful run) and a single selection concept.

## Scope

- **In**: The three view components, the per-doc row expansion state, the column set derivation for Table, the preview-field picker integration, the document-selection concept (for W08 edit/delete), empty and loading states.
- **Out**: Running queries (W03/W05), pagination (W07), writing docs (W08).

## Dependencies

- W03 (EJSON shape), W05 (produces the docs), W07 (page controls), W08 (selection drives edit/delete), W10 (preview fields).

## 1. Data source

Held on the active collection tab as `state.lastRun`, in renderer memory only: main strips it before every `state_json` write (results can be production documents), so a restored tab has no `lastRun` until it runs — default-query tabs auto-run, custom-query tabs show "Run the query to see results":

```ts
interface LastRun {
  documents: unknown[];      // EJSON canonical
  totalCount?: number;
  durationMs: number;
  ranAt: string;             // ISO
  error?: IpcError;
}
```

Documents are always EJSON objects. A helper `toDisplayValue(v): { type, display, raw }` classifies each leaf:

| EJSON shape                      | `type`       | `display` |
| -------------------------------- | ------------ | --------- |
| `{ $oid: "…" }`                  | `objectid`   | `ObjectId("ffff…")` |
| `{ $date: "…" }`                 | `date`       | ISO string |
| `{ $numberLong: "…" }`           | `long`       | the number |
| `{ $numberDecimal: "…" }`        | `decimal`    | the number |
| `{ $regex: …, $options: … }`     | `regex`      | `/r/opts`  |
| `{ $binary: { … } }`             | `binary`     | `Binary(len=…)` |
| plain `string`/`number`/`boolean`| accordingly  |            |
| `null`                           | `null`       | `null`     |
| `Array`                          | `array`      | `[N items]` |
| plain object                     | `object`     | `{N fields}` |

## 2. Tree view (default)

Row layout (matches existing mock):
- Collapsed: `[▸] [📄] [shortId]   [key: value · key: value · …]   [✏ pick preview]`.
- Expanded: a field grid with three columns (field, value, type), nested objects/arrays expand on click.

### Expansion state
- `expanded: Set<string>` per tab (persisted in tab state).
- Clicking the ▸/▾ toggles.
- Deep field expansion uses a path like `_id.$oid` for persistence is overkill — iteration 1 does NOT persist deep expansion, only top-level row expansion.

### Preview fields
- Driven by the per-collection preview fields (W10). Shown in the collapsed row header, up to 4 fields.
- Each row has a ✏ button that opens `PreviewPicker` (already in mock): a popover listing all known field names from the current result set (union of keys across the first 50 docs). Selecting checkboxes updates preview fields via W10 IPC.

### Short id
- For `_id` of type `ObjectId`, show last 8 hex chars. For non-Object-id `_id`, show up to 12 chars of the EJSON stringification, prefixed with the type badge.

### Selection
- A plain click on the collapsed row header does not select: it expands or collapses the row (the chevron button does the same). Selecting is Cmd/Ctrl-click on the row, or the per-row select toggle (checkbox) at the row's left; both toggle that row into or out of the multi-selection (blue left border and tinted background on selected rows). There is no single-select-by-click mode.
- Selection is a set of row indices shared by Table, Tree and JSON, so it survives a view switch and is cleared whenever the result set changes (new run, page change, tab switch).
- Selection is consumed by W08 for `Edit document` / `Delete document(s)` actions; Edit and Delete also have their own buttons on each row.

### Full value of a leaf
- The expanded field grid truncates a value to its column. A leaf (non-object, non-array) row carries the same `⤢` affordance as a Table cell (`FullValuePopover`): revealed on hover, on focus and while the row is the field tree's active row, it opens a read-only popover with the untruncated value (strings quoted). The trigger is out of Tab order (`tabIndex={-1}`), so Tab does not walk every leaf; the keyboard path is Enter below.
- Keyboard: Enter or Space on an active leaf opens it (on an expandable row they still toggle), and focus moves into the dropdown (`role="dialog"`, `tabIndex=-1`, named "Full value"), so a screen reader lands on the value. Escape closes it, does not bubble to the outer Table/Tree grid, and focus returns to the field tree, whose arrow keys and `aria-activedescendant` carry on from the same row.
- The popover belongs to the active leaf: making another row active, collapsing the leaf's parent, or a different document closes it, and a closed popover never swallows the next Escape.
- The same field grid is the Table view's expanded-row panel, so both get it.

## 3. JSON view

- Each doc in its own card (matches mock).
- Uses `JSON.stringify(EJSON.parse(...), null, 2)` output with light syntax highlighting (keys bold; strings green; numbers blue; booleans orange; null grey — colors from tokens).
- Syntax highlighting is computed at render time by a tiny tokenizer in `utils/jsonHighlight.ts` — do NOT bring in `prismjs` or `highlight.js` for iteration 1.
- Active card: the card list is one tab stop (`role="tree"`, cards are `treeitem`s) with `aria-activedescendant` naming the active card, outlined while the list has focus — the same model as Tree and Table rows.
  - A plain click makes the card active; Cmd/Ctrl-click toggles it into the multi-selection; the per-card select toggle is the other way in.
  - Arrows, Home and End move the active card. `E` edits it (on the list, or on one of the card's own buttons). Shift+F10 or the ContextMenu key opens its document menu.
  - Enter and Space only keep the active card: a card has nothing to expand.

## 4. Table view

- Derive columns:
  - Take the union of top-level keys across the first 50 docs.
  - Ensure `_id` is first, then the current preview fields in order, then the remaining keys alphabetically.
- Column widths: default auto with `max-width: 200px` + ellipsis overflow. User can drag column separators to resize (persisted in tab state as `state.columns.{field}.width`).
- Nested objects/arrays show as `{N}` / `[N]` badges that expand into a small popover showing the nested JSON.
- Any cell with a value has a hover/focus-revealed `⤢` that opens the full, untruncated value in a popover (`FullValuePopover`, shared with Tree leaves).
- Double-click copies a cell's value. The cell's native title says so next to the drag hint ("Drag to add … to builder · double-click to copy"); no per-cell tooltip component, which would mount one floating instance per cell of a virtualized grid.
- Right-click on a row → context menu: `Edit`, `Delete`, `Copy`, `Copy as JSON`.

## 5. Common

### Loading & empty
- Loading (between Run click and response):
  - first load (no run has landed in the tab yet): eight skeleton rows stand in for the body, inside a `role="status"` region labelled "Loading results";
  - any re-run, including one after an empty or errored result: keep the body (previous docs, if any) visible ("stale but readable") under a "Loading…" strip, itself `role="status"`, so the layout does not jump. Only one of the two status regions shows at a time.
- Empty (`documents.length === 0`): centered placeholder "No matching documents" with a helpful link "Clear filter" (resets builder).
- Errored: the error pill in W05 conveys the state; the result area keeps the previous docs visible with a small amber "stale" badge.

### Keyboard
Each view is one tab stop (`role="tree"` for Tree and JSON, the grid for Table) with `aria-activedescendant` naming the active row, outlined while the view has focus. Keys act on the active row and only when the view itself has focus (a key typed on a button inside the row is that button's).
- `ArrowDown` / `ArrowUp` move the active row; `Home` / `End` jump to the first / last. There is no `j` / `k`.
- `Enter` or `Space`: in Tree, expands or collapses the active row; in Table, selects only the active row (or clears it if it was already the sole selection); in JSON, only keeps the card active (a card has nothing to expand). `Cmd/Ctrl+Enter` is Run, never a row action.
- `E` edits the active document in all three views (unmodified key only).
- `Shift+F10` or the ContextMenu key opens the document menu for the active row in Table and JSON.
- Not implemented: a `d` shortcut to delete the selected document(s). Deleting is through the row's Delete button or the document menu (W08).

### Performance
- Table, Tree and JSON rows are always virtualized with `react-window` (no row-count threshold).

## 6. Acceptance criteria

- All three views render the same underlying `documents` array without re-running the query.
- Changing preview fields updates Tree and Table header order without a new run.
- Selection state persists while switching view modes.
- Expanding a row in Tree persists across tab switches (top-level only).
- EJSON values (ObjectId, Date, Long, Decimal) render with correct type badges.
- Column resize in Table persists across relaunches.
- Switching view modes is instant (no extra fetch).
- A truncated leaf value in Tree or an expanded Table row can be read in full by mouse (`⤢`) and keyboard (Enter on the active leaf); Escape closes it without bubbling.
- The JSON view has an active card driven by click and arrow keys, and `E` edits it.
- A first load shows skeleton rows; a re-run keeps the previous rows.

## 7. Test cases

### Component
- **tree-collapsed.spec.tsx**: renders short id + preview fields; click ▸ expands.
- **tree-expanded.spec.tsx**: type badges rendered (objectid/date/number/...); nested object expands.
- **preview-picker.spec.tsx**: picker lists all field names; selecting updates preview fields via W10 mock.
- **json-highlight.spec.tsx**: keys are bold; strings are green; numbers are blue; null is grey.
- **table-columns.spec.tsx**: column order: _id first, then preview, then alpha remainder.
- **table-resize.spec.tsx**: drag a column separator → `api.tabs.update` called with new width.
- **selection.spec.tsx**: click selects; cmd-click toggles additional; switching view keeps selection.
- **empty-state.spec.tsx**: zero docs → placeholder with Clear filter link.
- **virtualize.spec.tsx**: with 500 docs, DOM contains ≤ 60 row nodes.

### E2E
- **view-swap.e2e.ts**: run query → Tree, click rows → switch to JSON → same docs → switch to Table → resize a column → reload app → width persisted.
