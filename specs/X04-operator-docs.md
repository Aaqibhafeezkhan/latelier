# X04 — Operator documentation tooltips

> **Status: Implemented.**

## Purpose

Make the ~200-entry MQL operator catalog **discoverable without leaving the
app**. Today the user sees only the operator name and a 3-letter class
badge in the autocomplete popover; `$match`/`$group`/etc. carry a
one-liner in the stage picker; every other operator (query, expression,
accumulator, update) shows nothing. This spec adds a rich **doc panel**
— description + syntax + example — that surfaces in every place an
operator is *offered* (autocomplete) or *displayed* (a completed
condition row, a stage header).

Direct extension of [X03](./X03-mql-operators.md) §14 follow-up
"Operator signature hints". No new IPC, no persistence.

## Scope

- **In**:
  - Extend `OperatorDef` with `description`, `syntax`, `example`, `url`.
  - Author rich content for every operator in the `stage`, `query`,
    `logical`, `element`, `evaluation`, `array`, `geo`, `accumulator`,
    and `update` classes; one-line `summary` for every expression op
    plus rich content for the 25 most common expression ops.
  - New `OperatorDocPanel` presentational component.
  - New `OperatorTooltip` floating wrapper (anchored hover/focus tooltip).
  - New `placeFloatingPanel` positioning utility.
  - Integrate into `SuggestionPopover` (side panel for the highlighted
    operator suggestion).
  - Integrate into `AddStagePill` (side panel for the focused stage row).
  - Add hover tooltip on the **builder CondRow** op input (ⓘ icon).
  - Add hover tooltip on the **StageRow** header op badge.
- **Out** (explicitly deferred):
  - Hit-testing tokens inside a raw textarea to show a hover tooltip for
    operators already typed into free-form MQL / pipeline bodies. Needs
    caret-rect reverse mapping, which is a separate project.
  - Parameter typeaheads *inside* an operator body (the other half of
    X03 §14 "signature hints / parameter typeaheads").
  - i18n of doc content; English only.
  - Linking to user-authored notes / teaching content.

## Dependencies

- **X02** (field suggestions) — `SuggestionPopover`, `useSuggestions`.
- **X03** (operator autocomplete) — `OperatorDef`, `operatorSource`,
  `OperatorSuggestion`. All the data-flow plumbing already exists.
- **W04** (builder) — consumer of the CondRow ⓘ icon.
- **A03** (stage accordion) — consumer of the `AddStagePill` side
  panel and `StageRow` badge hover.
- **W05** (query bar) — consumer of the textarea autocomplete side
  panel (via `useTextareaAutocomplete`).

---

## 1. Data model

### 1.1 `OperatorDef` — extend

`src/features/fieldSuggestions/operators.ts`

```ts
export interface OperatorDef {
  name: string;                          // '$eq' — always $-prefixed
  class: OperatorClass;
  /** One-line description (≤ 60 chars). Shown in popover rows and
   *  AddStagePill inline text. Existing field. */
  summary?: string;
  validIn?: readonly OperatorContext[];

  // ─── new fields ──────────────────────────────────────────────────
  /** 1–3 sentences, plain text. Full explanation of what the op does,
   *  when to use it, and any key semantics (e.g. "$in returns a match
   *  when any element of the array equals the field value"). */
  description?: string;
  /** Signature line, rendered in a monospace block. Convention:
   *    - query ops: `{ field: { $op: <value> } }`
   *    - stage ops: `{ $op: <body> }`
   *    - expression ops: `{ $op: [<expr1>, <expr2>] }` or `{ $op: <expr> }`
   *    - accumulators: `{ $op: <expr> }`
   *    - update ops: `{ $op: { <field>: <value>, … } }`
   *  Use angle-bracket placeholders for parameter slots. */
  syntax?: string;
  /** A short, valid JSON snippet demonstrating the op in a realistic
   *  document shape. Multi-line allowed. Keep to ≤ 8 lines. */
  example?: string;
  /** Authoritative MongoDB docs URL. Used for the "Learn more →" link. */
  url?: string;
}
```

### 1.2 Catalog lookup helper

`src/features/fieldSuggestions/operators.ts`

```ts
/**
 * Resolve the catalog entry for an operator name, preferring an entry
 * whose `class` matches `prefClass` when provided. Falls back to the
 * first entry with that name. Used by the doc-panel consumers so that
 * `$eq` under a query autocomplete shows the query entry, while `$eq`
 * under a $project expression shows the expression entry.
 */
export function findOperatorDocs(
  name: string,
  prefClass?: OperatorClass,
): OperatorDef | null;
```

Implementation:

1. Scan `OPERATORS` for every entry with `op.name === name`.
2. Return the one matching `prefClass` if present.
3. Else return the entry with a non-empty `description`.
4. Else return the first match, or `null` if none.

### 1.3 Class colour map

`src/features/fieldSuggestions/operators.ts`

```ts
/** Badge background + text colour per class. Used by OperatorDocPanel
 *  and SuggestionPopover row badges. Values are theme-agnostic
 *  rgba/hex pairs; callers apply alpha as needed. */
export const CLASS_COLOR: Record<OperatorClass, { bg: string; text: string }> = {
  stage:       { bg: 'rgba(26,104,53,0.15)',   text: '#1A6835' }, // green
  query:       { bg: 'rgba(26,80,138,0.15)',   text: '#1A508A' }, // blue
  logical:     { bg: 'rgba(107,58,138,0.15)',  text: '#6B3A8A' }, // purple
  element:     { bg: 'rgba(138,107,64,0.15)',  text: '#8A6B40' }, // amber
  evaluation:  { bg: 'rgba(26,104,104,0.15)',  text: '#1A6868' }, // teal
  array:       { bg: 'rgba(138,60,90,0.15)',   text: '#8A3C5A' }, // rose
  geo:         { bg: 'rgba(90,100,26,0.15)',   text: '#5A641A' }, // olive
  accumulator: { bg: 'rgba(90,58,138,0.15)',   text: '#5A3A8A' }, // violet
  expression:  { bg: 'rgba(64,90,138,0.15)',   text: '#405A8A' }, // indigo
  update:      { bg: 'rgba(138,50,50,0.15)',   text: '#8A3232' }, // red
};
```

Dark-mode brightening: consumers apply the same pattern as
`opColor()` in `StageAccordion.tsx` — replace `0.15` with `0.25` in
`bg` when `darkMode`. Export a helper:

```ts
export function classColor(cls: OperatorClass, dark: boolean): { bg: string; text: string };
```

---

## 2. Content authoring

Author rich content for **every operator** in these classes:

| Class         | Operators | Required fields                 |
|---------------|-----------|----------------------------------|
| `stage`       | 36        | description + syntax + example + url |
| `query`       | 8         | description + syntax + example + url |
| `logical`     | 4         | description + syntax + example + url |
| `element`     | 2         | description + syntax + example + url |
| `evaluation`  | 10        | description + syntax + example + url |
| `array`       | 3         | description + syntax + example + url |
| `geo`         | 11        | description + syntax + example + url |
| `accumulator` | 33        | description + syntax + example + url |
| `update`      | 15        | description + syntax + example + url |

For the `expression` class (~130 entries via the string-array
`EXPRESSIONS` expansion in `operators.ts`):

- **All** entries get a `summary` (≤ 60 chars, one line).
- The **25 most common** get full rich content (description + syntax +
  example + url). List below — covers the vast majority of real usage.

### 2.1 Expression ops requiring rich content

```
$cond, $ifNull, $switch, $let,
$concat, $substr, $toLower, $toUpper, $split, $trim,
$add, $subtract, $multiply, $divide, $round,
$dateToString, $dateFromString, $dateAdd, $dateDiff,
$map, $filter, $reduce, $size,
$toString, $toInt
```

### 2.2 Content style rules

1. **`description`** — 1 to 3 sentences, imperative voice ("Returns…",
   "Matches…", "Sets…"). Avoid "This operator…". Mention edge cases only
   when a caller is likely to trip on them (`$in`: array must be literal;
   `$regex`: anchor for full-string match; `$mod`: length-2 array;
   `$type`: alias strings like `"number"`). No marketing; no emojis.
2. **`syntax`** — one line whenever possible; placeholders in
   `<angle-brackets>`; variadic args with `…`; use real JSON punctuation.
   Example: `{ field: { $in: [<v1>, <v2>, …] } }`.
3. **`example`** — a valid JSON document fragment using **realistic
   shapes** (`age`, `status`, `orders`, `createdAt`, etc., not
   `foo`/`bar`). No trailing commas. Use 2-space indent. Wrap in the
   exact context the operator appears in (e.g. `$match` example shows a
   `$match` body, not a whole pipeline).
4. **`url`** — direct link to the exact doc page, not the index. Use
   `https://www.mongodb.com/docs/manual/reference/operator/...` form.
   MongoDB 7.0 docs.

### 2.3 Reference samples

Copy the style exactly. These are the canonical templates.

```ts
{
  name: '$match',
  class: 'stage',
  summary: 'Filter documents',
  validIn: STAGE,
  description:
    'Filters the pipeline so that only documents matching the query ' +
    'pass to the next stage. The query syntax is identical to find().',
  syntax: '{ $match: <query> }',
  example: '{ $match: { status: "active", age: { $gte: 21 } } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/',
},

{
  name: '$group',
  class: 'stage',
  summary: 'Group & aggregate values',
  validIn: STAGE,
  description:
    'Groups documents by the _id expression and computes accumulator ' +
    'values for each group. Use _id: null to aggregate across every ' +
    'document.',
  syntax: '{ $group: { _id: <expr>, <field>: { <accumulator>: <expr> }, … } }',
  example:
    '{\n' +
    '  $group: {\n' +
    '    _id: "$status",\n' +
    '    total: { $sum: "$amount" },\n' +
    '    count: { $sum: 1 }\n' +
    '  }\n' +
    '}',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/group/',
},

{
  name: '$lookup',
  class: 'stage',
  summary: 'Left join another collection',
  validIn: STAGE,
  description:
    'Performs a left outer join between the input documents and a ' +
    'foreign collection. Each input document receives an array field ' +
    'containing the matching foreign documents.',
  syntax:
    '{ $lookup: { from: <coll>, localField: <f>, foreignField: <f>, as: <arr> } }',
  example:
    '{\n' +
    '  $lookup: {\n' +
    '    from: "orders",\n' +
    '    localField: "_id",\n' +
    '    foreignField: "customerId",\n' +
    '    as: "orders"\n' +
    '  }\n' +
    '}',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/',
},

{
  name: '$eq',
  class: 'query',
  validIn: MATCH,
  description:
    'Matches documents where the field value equals the given value. ' +
    'Also used implicitly when a match filter uses plain { field: value }.',
  syntax: '{ field: { $eq: <value> } }',
  example: '{ status: { $eq: "active" } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/query/eq/',
},

{
  name: '$in',
  class: 'query',
  validIn: MATCH,
  description:
    'Matches documents where the field value equals any value in the ' +
    'given array. The array must be a literal — to compare against ' +
    'another field, use $expr with { $in: [<expr>, <array>] }.',
  syntax: '{ field: { $in: [<v1>, <v2>, …] } }',
  example: '{ status: { $in: ["active", "pending"] } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/query/in/',
},

{
  name: '$regex',
  class: 'evaluation',
  validIn: MATCH,
  description:
    'Matches documents where the string field matches the given regex. ' +
    'Anchor with ^ / $ for full-string matches. Case-insensitive mode is ' +
    'enabled via the $options "i" flag.',
  syntax: '{ field: { $regex: <pattern>, $options: <flags> } }',
  example: '{ email: { $regex: "@example\\.com$", $options: "i" } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/query/regex/',
},

{
  name: '$sum',
  class: 'accumulator',
  validIn: GROUP,
  description:
    'Returns the sum of numeric expressions across the group. Use ' +
    '{ $sum: 1 } to count documents.',
  syntax: '{ $sum: <expr> }',
  example: '{ totalAmount: { $sum: "$amount" } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/sum/',
},

{
  name: '$cond',
  class: 'expression',
  validIn: PROJECT_EXPR,
  description:
    'Ternary expression: evaluates the boolean <if>, returns <then> when ' +
    'true, else <else>. The object form { if, then, else } is also valid.',
  syntax: '{ $cond: [<if>, <then>, <else>] }',
  example: '{ isAdult: { $cond: [{ $gte: ["$age", 18] }, true, false] } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/cond/',
},

{
  name: '$set',  // update variant
  class: 'update',
  validIn: UPDATE,
  description:
    'Sets the value of one or more fields. Creates fields that do not ' +
    'exist. Replaces an existing field\'s value entirely — use $inc for ' +
    'relative numeric updates.',
  syntax: '{ $set: { <field>: <value>, … } }',
  example: '{ $set: { status: "shipped", shippedAt: new Date() } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/update/set/',
},

{
  name: '$inc',
  class: 'update',
  validIn: UPDATE,
  description:
    'Increments a numeric field by the given amount. Negative values ' +
    'decrement. Creates the field with the value if it doesn\'t exist.',
  syntax: '{ $inc: { <field>: <number>, … } }',
  example: '{ $inc: { views: 1, stock: -1 } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/update/inc/',
},
```

### 2.4 Duplicate-name handling

Both `$eq` (query) and `$eq` (expression) get separate entries with
their own description/syntax/example. The query entry talks about
field-value matching; the expression entry talks about two-argument
equality returning boolean. `findOperatorDocs` picks the right one
based on the `prefClass` argument.

---

## 3. Type propagation

### 3.1 `OperatorSuggestion` — extend

`src/features/fieldSuggestions/types.ts`

```ts
export interface OperatorSuggestion {
  kind: 'operator';
  name: string;
  class: OperatorClass;
  summary?: string;
  source: string;
  offContext?: boolean;

  // ─── new ─────────────────────────────────────────────────────────
  description?: string;
  syntax?: string;
  example?: string;
  url?: string;
}
```

### 3.2 `operatorSource.ts` — pass the new fields through

```ts
export const operatorSource: FieldSource = (ctx) => {
  const wanted = ctx.operatorContext;
  const out: OperatorSuggestion[] = [];
  for (const op of OPERATORS) {
    const offContext = !!wanted && !!op.validIn && !op.validIn.includes(wanted);
    out.push({
      kind: 'operator',
      name: op.name,
      class: op.class,
      summary: op.summary,
      description: op.description,
      syntax: op.syntax,
      example: op.example,
      url: op.url,
      source: 'operators',
      offContext,
    });
  }
  return out;
};
```

No other touch-points in `useSuggestions` — it already forwards
suggestions verbatim (apart from merging duplicates by key, which this
change doesn't alter).

---

## 4. `OperatorDocPanel` — new component

**Location**: `src/features/fieldSuggestions/OperatorDocPanel.tsx`

### 4.1 Props

```ts
interface OperatorDocPanelProps {
  /** If null, the panel renders an empty placeholder with
   *  "No documentation available" text. Consumers should check
   *  beforehand and avoid rendering in that case when it would be
   *  a side panel with nothing to point at. */
  op: OperatorDef | null;
  /** Layout variant. 'side' — used inside a popover/dropdown as a
   *  fixed-width companion panel. 'tooltip' — used standalone floating
   *  near an anchor. Affects padding and max-width only. */
  variant?: 'side' | 'tooltip';
  /** Override width. Default 340 for both variants. */
  width?: number;
}
```

### 4.2 Rendering

Stack layout, top to bottom:

1. **Header row** — flex, align-center, gap 8.
   - Operator name: monospace, `fontSize: 13`, `fontWeight: 600`,
     color `T.text`.
   - Class badge: `padding: 2px 6px`, `borderRadius: T.rx`,
     `fontSize: 9`, `textTransform: uppercase`, `letterSpacing: 0.04em`,
     background/text from `classColor(op.class, dark)`. Text uses the
     `CLASS_BADGE[class]` short name.
2. **Description** — `fontSize: 12`, `lineHeight: 1.5`, color `T.text`,
   `marginTop: 6`. Render `op.description`. If empty, skip.
3. **"Syntax" label** — `fontSize: 10`, `textTransform: uppercase`,
   `letterSpacing: 0.05em`, color `T.textGhost`, `marginTop: 10`,
   `marginBottom: 4`. Only if `op.syntax`.
4. **Syntax block** — `<pre>` inside a styled wrapper:
   - `background: T.surfaceRaised`
   - `border: 1px solid T.border`
   - `borderRadius: T.rx`
   - `padding: 6px 8px`
   - `fontSize: 11`, `fontFamily: 'JetBrains Mono, monospace'`
   - `whiteSpace: pre-wrap`, `wordBreak: break-word`
   - `color: T.text`
5. **"Example" label** — same style as "Syntax" label. Only if
   `op.example`.
6. **Example block** — same style as Syntax block.
7. **Footer** — `marginTop: 10`, flex `justify-between`. Left: `"Class:
   <class badge word>"` (e.g. `"Class: query operator"`, in
   `fontSize: 10`, color `T.textGhost`). Right: `"Learn more →"` link
   (`color: T.accent`, `textDecoration: none`, `fontSize: 10`; opens via
   `window.atelier.shell.openExternal(url)` — **DO NOT** use a raw
   `<a href>` because this is Electron and we need to route to the host
   browser explicitly). Footer only renders if `op.url`.

### 4.3 Outer wrapper

```ts
<div
  role="note"
  aria-label={`Documentation for ${op.name}`}
  style={{
    width: width ?? 340,
    maxHeight: 360,
    overflowY: 'auto',
    background: T.surface,
    border: `1px solid ${T.borderMed}`,
    borderRadius: T.r,
    boxShadow: T.shadowLg,
    padding: variant === 'tooltip' ? 12 : 10,
    color: T.text,
    // Tooltip variant is absolutely/fixed positioned by the parent;
    // side variant is laid out by the parent via flex.
  }}
>
  …content…
</div>
```

### 4.4 `openExternal` contract

There is no existing `api.shell.openExternal`; check
`src/api/atelier.ts`. If missing:

- Add IPC channel `shell:openExternal` (no `SECRET_INPUT`).
  - Input: `{ url: string }`. Validate it starts with `https://www.mongodb.com/docs/`
    in the zod schema — refuse anything else to prevent the doc panel
    becoming an arbitrary-URL opener.
  - Handler: `electron.shell.openExternal(url)` from Electron.
  - Output: `void` (envelope `{ ok: true }`).
- Expose via `preload.ts` under `window.atelier.shell.openExternal`.
- Add to `shared/ipc.ts` types.

This is the only IPC touch in the whole spec.

---

## 5. `placeFloatingPanel` — new utility

**Location**: `src/features/fieldSuggestions/placement.ts`

```ts
type Placement = 'right' | 'left' | 'below' | 'above';

interface Rect { top: number; left: number; width: number; height: number }
interface Size { width: number; height: number }

/**
 * Position a floating panel around an anchor rect without clipping the
 * viewport. Tries `prefer` first, flips to the opposite side on
 * overflow, then falls back to 'below' / 'above'. 8px gap + 8px
 * viewport margin.
 */
export function placeFloatingPanel(
  anchor: Rect,
  panel: Size,
  prefer: Placement,
  viewport?: { width: number; height: number },
): { top: number; left: number; placement: Placement };
```

Algorithm (pseudo):

1. `vw = viewport?.width ?? window.innerWidth`, `vh = viewport?.height ?? window.innerHeight`.
2. `GAP = 8`, `MARGIN = 8`.
3. Candidate order: `[prefer, opposite(prefer), 'below', 'above']`.
4. For each candidate, compute `{top, left}` + `fits` (does the panel
   fit within `[MARGIN, vw-MARGIN] x [MARGIN, vh-MARGIN]`?). Return the
   first fitting candidate.
5. If none fit, return the preferred placement with `top`/`left`
   clamped into `[MARGIN, vw-MARGIN-panel.width]` etc.

Placement math:

| Placement | `top`                                        | `left`                           |
|-----------|----------------------------------------------|----------------------------------|
| `right`   | `anchor.top`                                 | `anchor.left + anchor.width + GAP` |
| `left`    | `anchor.top`                                 | `anchor.left - panel.width - GAP` |
| `below`   | `anchor.top + anchor.height + GAP`           | `anchor.left`                    |
| `above`   | `anchor.top - panel.height - GAP`            | `anchor.left`                    |

Unit-test every branch. See §12.

---

## 6. Integration — `SuggestionPopover` (autocomplete side panel)

**File**: `src/features/fieldSuggestions/SuggestionPopover.tsx`

### 6.1 Behaviour

When the highlighted `items[highlight]` is an operator AND
`findOperatorDocs(item.name, item.class)` returns an entry with at
least a `description`, render an `OperatorDocPanel` next to the
listbox. Position uses `placeFloatingPanel` with:

- `anchor`: the listbox's own bounding rect (once rendered).
- `panel`: `{ width: 340, height: 360 }` (a conservative estimate; the
  panel's own `maxHeight` clamps it).
- `prefer`: `'right'`.

For field or value suggestions, no panel.

### 6.2 Implementation notes

- Use a `React.useRef<HTMLDivElement>` on the listbox outer div.
- New effect: after the listbox `pos` is computed AND the panel should
  be visible, measure the listbox rect via
  `listboxRef.current?.getBoundingClientRect()` and compute the panel
  position. Store as `panelPos` state.
- Re-run the effect on:
  - `open` change
  - `items.length` change
  - `highlight` change (only if the highlighted item kind changes
    between operator-with-docs and anything else — memo `showPanel`
    boolean separately to avoid thrash)
- The panel is rendered as a sibling `<div style={{ position: 'fixed',
  top: panelPos.top, left: panelPos.left, zIndex: 1001, … }}>` — higher
  z-index than the listbox so it isn't clipped.
- The whole popover (listbox + panel) should dismiss together. No
  change needed — the listbox owns the lifecycle.
- **Accessibility**: add `aria-describedby` on each operator row that
  points to the panel's id when shown. Generate a stable id via
  `React.useId()`.

### 6.3 Performance

The panel re-mounts on every highlight change. This is fine; operators
are hundreds of entries max, and the panel is plain DOM. No need for
memoisation beyond what React already gives us.

---

## 7. Integration — `AddStagePill`

**File**: `src/pages/Workspace/Aggregation/StageAccordion.tsx`

### 7.1 Current behaviour

Dropdown of 16 rows, each: `<op badge> <desc one-liner>`. Focus index
tracked in `focusIdx`.

### 7.2 Change

Keep the inline `desc` — it's still useful as a scan aid when the user
is reading the list. **Add** a side panel showing the full
`OperatorDocPanel` for the focused op.

- After the dropdown opens, measure the dropdown's outer wrapper rect
  (the `<div>` with `position: absolute; top: 100%; left: 50%; …width: 300`).
- Compute `panelPos` via `placeFloatingPanel(dropdownRect, { width: 340, height: 360 }, 'right')`.
- Render `<OperatorDocPanel op={findOperatorDocs(filtered[focusIdx], 'stage')} variant="side" />`
  inside a fixed-positioned sibling.
- Panel updates as `focusIdx` changes (keyboard nav) and as the mouse
  hovers rows (existing `onMouseEnter`).
- When `filtered` is empty, hide the panel.

### 7.3 Dismiss

The existing fixed overlay click-catcher dismisses the dropdown. No
extra handling needed — when the dropdown unmounts, the panel unmounts
with it (they're siblings in the same component).

---

## 8. Integration — `OperatorTooltip` (hover tooltip for displayed ops)

**Location**: `src/features/fieldSuggestions/OperatorTooltip.tsx`

### 8.1 Component

```ts
interface OperatorTooltipProps {
  /** Operator name, e.g. '$eq'. Resolved via findOperatorDocs. */
  name: string;
  /** Preferred class to disambiguate duplicates. */
  prefClass?: OperatorClass;
  /** The anchor element. Rendered as-is; the tooltip attaches to the
   *  anchor's bounding rect. */
  children: React.ReactElement;
  /** Preferred placement. Default 'below'. */
  placement?: 'right' | 'left' | 'below' | 'above';
  /** Open delay in ms; default 200. */
  openDelay?: number;
  /** Close delay in ms; default 100. */
  closeDelay?: number;
}
```

### 8.2 Mechanics

- Clones `children` and attaches `onMouseEnter`, `onMouseLeave`,
  `onFocus`, `onBlur` handlers (merged with any existing handlers on
  the child).
- `onMouseEnter` / `onFocus` → start an `openDelay` timer → set `open`
  true, compute position via `placeFloatingPanel`.
- `onMouseLeave` / `onBlur` → start a `closeDelay` timer → set `open`
  false. Cancel if the mouse re-enters before the timer fires.
- `Escape` key while anchor has focus → close immediately.
- Renders `<OperatorDocPanel op={…} variant="tooltip" />` in a portal
  (`createPortal(panel, document.body)`) to avoid being clipped by
  ancestors with `overflow: hidden`.
- If `findOperatorDocs(name, prefClass)?.description` is empty,
  **do not open** — avoids hover-flicker for operators without content.

### 8.3 Ref forwarding

The `OperatorTooltip` must not require the child to accept a `ref`.
Use the "wrap in a span" strategy if necessary: if the child is a
DOM element, clone it directly and pass a `ref` via
`React.cloneElement`; if it's a function component, wrap it in an
inline `<span style={{ display: 'inline-flex' }}>` that takes the ref.

---

## 9. Consumer — CondRow ⓘ icon

**File**: `src/pages/Workspace/BuilderPane.tsx` → `CondRow`

### 9.1 Where

Right after the operator input (`opInputRef`), before the remove button.

### 9.2 Rendering

```tsx
{cond.op && findOperatorDocs(cond.op, 'query') && (
  <OperatorTooltip name={cond.op} prefClass="query" placement="below">
    <span
      tabIndex={0}
      aria-label={`Documentation for ${cond.op}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: `1px solid ${T.border}`,
        color: T.textGhost,
        fontSize: 10,
        fontWeight: 600,
        cursor: 'help',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      ?
    </span>
  </OperatorTooltip>
)}
```

Rationale for `?` instead of ⓘ character: no unicode-font dependency;
works in any environment.

### 9.3 Visibility rules

- Icon only shows when `cond.op` starts with `$` AND
  `findOperatorDocs(cond.op, 'query')` returns an entry with a
  `description`.
- Icon does **not** show while the row has a condition problem (W04 §2b),
  whether about the op or the value — the existing warning is enough
  signal.

---

## 10. Consumer — StageRow badge hover

**File**: `src/pages/Workspace/Aggregation/StageAccordion.tsx` → `StageRow`

### 10.1 Where

The colored pill showing `stage.op` in the StageRow header (currently
rendered via `<span style={{ … background: c.bg, color: c.text, … }}>{stage.op}</span>`).

### 10.2 Change

Wrap the pill in `<OperatorTooltip name={stage.op} prefClass="stage" placement="right">`.

No other changes — the pill stays clickable for whatever existing
behaviour it has (toggle active?), and the tooltip layer is passive.

---

## 11. Behaviour — lifecycle

### 11.1 Autocomplete popover (textarea or CondRow input)

1. User types at a key position → grammar detection → operator source
   emits suggestions with rich fields populated.
2. Popover opens; first row highlighted.
3. If highlighted row is an operator with `description`, side panel
   mounts to the right.
4. Arrow keys move the highlight → panel re-renders with new content.
5. User accepts with Enter/Tab or clicks → popover closes → panel
   closes with it.

### 11.2 AddStagePill

1. User clicks "Add stage" → dropdown opens.
2. Side panel mounts to the right, showing docs for the first filtered
   op.
3. Keyboard arrows or mouse hover move `focusIdx` → panel re-renders.
4. User clicks a row or presses Enter → stage added, dropdown + panel
   close together.

### 11.3 CondRow ⓘ icon

1. User hovers/focuses the `?` icon → 200ms → tooltip appears below.
2. User moves mouse away → 100ms → tooltip disappears.
3. User presses Escape while focused → tooltip disappears immediately.

### 11.4 StageRow badge

Same as 11.3, anchored to the pill.

---

## 12. Acceptance criteria

- `OperatorDef` has `description`, `syntax`, `example`, `url`
  fields, all optional.
- `findOperatorDocs(name, prefClass)` returns the class-matching
  entry when available; returns a description-bearing entry
  otherwise; returns the first match as last resort.
- `CLASS_COLOR` + `classColor(cls, dark)` export the per-class
  palette; dark variant brightens the `bg` channel by the
  `0.15` → `0.25` rule.
- Every `stage`, `query`, `logical`, `element`, `evaluation`,
  `array`, `geo`, `accumulator`, and `update` operator has
  `description`, `syntax`, `example`, `url`.
- Every `expression` operator has at least `summary`; the 25
  listed in §2.1 have full rich content.
- `OperatorSuggestion` carries the new fields; `operatorSource`
  passes them through.
- `OperatorDocPanel` renders correctly with full data, with
  missing-url (no footer link), with no syntax, and with no
  example. Renders a graceful placeholder when `op` is `null`.
- The autocomplete popover shows the doc panel to the right
  whenever the highlighted suggestion is an operator with a
  `description`. Panel updates on arrow-key navigation.
- The doc panel flips to the left when there's not enough
  viewport room on the right. Falls back to below when neither
  side fits.
- The AddStagePill dropdown shows the doc panel. Panel updates
  on keyboard and mouse focus changes. Inline one-liner `desc`
  is preserved.
- The CondRow op input has a `?` icon that only shows when the
  current op has docs and no validation problem.
- The StageRow op pill opens a floating tooltip on hover or
  keyboard focus.
- The "Learn more →" link opens in the user's default browser via
  `shell.openExternal`, not inside the Electron window.
- The `shell:openExternal` IPC rejects any URL that does not start
  with `https://www.mongodb.com/docs/`.
- All existing X02/X03 acceptance criteria still pass.

---

## 13. Test cases

### 13.1 Unit

**`tests/unit/operator-docs.spec.ts`** (new)

- Every `OperatorDef` with `description` also has `syntax`, `example`,
  `url` — assert content-completeness invariant.
- Every URL starts with `https://www.mongodb.com/docs/`.
- Every `syntax` contains the operator name.
- `findOperatorDocs('$eq', 'query')` returns the query entry.
- `findOperatorDocs('$eq', 'expression')` returns the expression entry.
- `findOperatorDocs('$eq')` returns an entry with a description.
- `findOperatorDocs('$nope')` returns `null`.
- `classColor('query', false).bg` ends with `0.15`.
- `classColor('query', true).bg` ends with `0.25`.

**`tests/unit/placement.spec.ts`** (new)

- `'right'` preferred, fits → returns right.
- `'right'` preferred, viewport too narrow on right, fits on left →
  returns left.
- Both sides too narrow, fits below → returns below.
- Nothing fits → returns preferred with clamped coords, no overflow.
- Viewport width/height overrides respected.

### 13.2 Component

**`tests/component/OperatorDocPanel.spec.tsx`** (new)

- Full data: renders name, class badge, description, syntax, example,
  footer link.
- Missing `url`: no footer link rendered.
- Missing `example`: example block not rendered, no empty `<pre>`.
- `op={null}`: renders placeholder text, no crash.
- "Learn more →" click calls
  `window.atelier.shell.openExternal` with the URL (mocked).

**`tests/component/OperatorTooltip.spec.tsx`** (new)

- Hovers open tooltip after 200ms (fake timers).
- Leaves close tooltip after 100ms.
- Re-entering within close delay cancels close.
- Focus opens; blur closes.
- Escape closes immediately while focused.
- Does not open when operator has no `description`.

**`tests/component/SuggestionPopover.spec.tsx`** (extend existing)

- When highlighted item is an operator with docs, side panel renders.
- When highlighted item is a field, side panel does not render.
- Arrow-down to an operator row mounts the panel; arrow-up to a
  field row unmounts it.

### 13.3 Integration

No IPC-side test except the new `shell:openExternal` channel:

**`tests/integration/shell-open-external.spec.ts`** (new)

- Valid URL → success envelope, `electron.shell.openExternal` called.
- URL not starting with `https://www.mongodb.com/docs/` → `{ ok: false,
  error: { code: 'ValidationError' } }`, `electron.shell.openExternal`
  not called.

### 13.4 Manual / E2E (no new Playwright; note in PR description)

- Open the query bar, type `{ $` → autocomplete opens, side panel
  shows `$eq` docs. Arrow down → panel updates to the next op.
- Open the builder, enter a field, type `in` in the op input →
  autocomplete shows `$in` with rich side panel.
- The `?` icon next to a completed `{ field: $in … }` condition opens
  a tooltip on hover.
- Open "Add stage" → dropdown opens with side panel for `$match`.
  Hovering `$group` updates the panel.
- Hover the colored `$match` pill in an existing stage header → same
  tooltip.
- Click "Learn more →" → default browser opens the MongoDB docs page.
- Resize the window so the side panel would overflow the right edge →
  panel flips to the left.

---

## 14. Implementation order (for the implementing agent)

Each phase should land as one commit. Run tests between phases.

1. **Data layer** — extend `OperatorDef`, add `CLASS_COLOR`,
   `classColor`, `findOperatorDocs`. Update `OperatorSuggestion` and
   `operatorSource`. No UI yet. Commit. `npm test` must stay green.
2. **Populate content — stage + query + accumulator + update** (~92
   operators). Commit. Unit test `operator-docs.spec.ts` covers this.
3. **Populate content — logical, element, evaluation, array, geo**
   (~30 operators). Commit.
4. **Populate content — expression summaries (all) + rich for 25**.
   Commit.
5. **Placement utility + unit tests**. Commit.
6. **`OperatorDocPanel` component + its component test**. No consumer
   yet. Commit.
7. **`shell:openExternal` IPC + its integration test**. Commit.
8. **Wire into `SuggestionPopover`**. Commit.
9. **Wire into `AddStagePill`**. Commit.
10. **`OperatorTooltip` component + its tests**. Commit.
11. **Wire `OperatorTooltip` into `CondRow` and `StageRow`**. Commit.
12. **Update this spec's acceptance criteria to `[x]` as each lands**.
    Commit.

---

## 15. Files touched (checklist)

Create:

- `src/features/fieldSuggestions/OperatorDocPanel.tsx`
- `src/features/fieldSuggestions/OperatorTooltip.tsx`
- `src/features/fieldSuggestions/placement.ts`
- `tests/unit/operator-docs.spec.ts`
- `tests/unit/placement.spec.ts`
- `tests/component/OperatorDocPanel.spec.tsx`
- `tests/component/OperatorTooltip.spec.tsx`
- `tests/integration/shell-open-external.spec.ts`
- `electron/ipc/handlers/shell.ts` (new router for the one channel)

Modify:

- `src/features/fieldSuggestions/operators.ts` — extend type, add
  content, add helpers.
- `src/features/fieldSuggestions/types.ts` — extend
  `OperatorSuggestion`.
- `src/features/fieldSuggestions/sources/operatorSource.ts` — pass
  new fields through.
- `src/features/fieldSuggestions/SuggestionPopover.tsx` — side panel.
- `src/pages/Workspace/Aggregation/StageAccordion.tsx` — side panel
  in `AddStagePill`, tooltip on `StageRow` pill.
- `src/pages/Workspace/BuilderPane.tsx` — `?` icon in `CondRow`.
- `shared/ipc.ts` — `shell.openExternal` type.
- `electron/preload.ts` — `shell.openExternal` binding.
- `electron/main.ts` — register the shell router.
- `src/api/atelier.ts` — `api.shell.openExternal` wrapper.
- `scripts/ipc-secret-allowlist.txt` — **not** added; the channel
  does not accept secrets.
- `tests/component/SuggestionPopover.spec.tsx` — panel assertions.

---

## 16. References

- [X02](./X02-field-suggestions.md) — the underlying suggestion system.
- [X03](./X03-mql-operators.md) — the operator catalog and autocomplete
  plumbing this spec builds on.
- [W04](./W04-query-builder-pane.md) — the builder consumer.
- [A03](./A03-stage-accordion.md) — the aggregation consumer.
- MongoDB 7.0 operator reference — source of truth for content.
