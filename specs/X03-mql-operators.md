# X03 — MQL operator autocomplete

> **Status: Implemented.** Its follow-ups, signature hints, completion inside `$facet` and usage ranking, are not built.

## Purpose

Extend the X02 suggestion system with a third kind — MQL operators —
so the same popover that offers field names also offers `$eq`, `$sum`,
`$concat`, `$match`, etc. Users can type `eq` and accept `$eq` (no
leading `$` required). Coverage is the full documented operator surface
(stage, query, accumulator, expression, update classes), with
context-aware ranking so the ops that fit the caret's position rank
first.

The builder's condition row's op `<select>` is replaced by an
autocomplete `<input>` so the same UX reaches every operator, not just
the hand-curated `FIELD_OPS[valType]` subset.

## Scope

- **In**: static operator catalog (`OPERATORS`), `OperatorSuggestion`
  kind, `operatorSource` key-position source, `operatorContext`
  propagation through the grammar detector + textarea hook +
  `SuggestionContext`, ranking tweaks (strip leading `$`, downrank
  off-context), `SuggestionPopover` operator rendering, builder's op
  autocomplete input + shape-bucketed `compileMql`, the condition-problem
  check (W04 §2b) + invalid-row blocking.
- **Out** (deferred): schema-validator-driven narrowing (e.g., hide geo
  ops when the collection has no geo index), operator signature hints,
  parameter typeaheads, AI-generated operator chains, update-expression
  surfaces (the `'update'` context exists in the catalog but no input
  consumes it yet — that's Phase C).

## Dependencies

- **X02** (field suggestions) — supplies `SuggestionContext`, the
  popover, `useSuggestions`, and the grammar detector that this spec
  extends.
- **W04** (builder) — consumer surface for the op autocomplete input.
- **W05** (query bar), **A03** (stage accordion) — consumer surfaces
  for the textarea autocomplete.

## 1. Catalog — `operators.ts`

```ts
// src/features/fieldSuggestions/operators.ts

export type OperatorClass =
  | 'stage' | 'query' | 'logical' | 'element' | 'evaluation'
  | 'array' | 'geo' | 'accumulator' | 'expression' | 'update';

export type OperatorContext =
  | 'matchKey' | 'groupValue' | 'projectValue' | 'addFieldsValue'
  | 'stage' | 'update';

export interface OperatorDef {
  name: string;                         // '$eq' — always $-prefixed
  class: OperatorClass;
  summary?: string;                     // one-line description, stage ops only for v1
  validIn?: readonly OperatorContext[]; // contexts where the op applies
}

export const OPERATORS: readonly OperatorDef[];
export const CLASS_BADGE: Record<OperatorClass, string>;
export function stageOperatorSummary(name: string): string | undefined;
```

Hand-curated for MongoDB 7.x. ~200 entries covering all documented
classes. The same `name` can appear in multiple entries across classes
(e.g., `$eq` is both a query op and an expression op; `$set` is both a
stage op and an update op) — ranking uses the class badge, and
Phase-B context filtering keeps the right one on top.

`STAGES` order in the file is the curated presentation order; the
pipeline layer reads `stageOperatorSummary` to populate
`STAGE_OP_INFO[op].desc` for `KNOWN_STAGE_OPS` only. Body-shape hints
stay in `pipeline.ts` since they're builder UI copy, not catalog
metadata.

## 2. Types

Extends X02's `types.ts`:

```ts
export interface SuggestionContext {
  // ...existing fields...
  /** Resolved from stageOp + object-nesting depth at the caret.
   *  Filters/ranks operator suggestions. */
  operatorContext?: OperatorContext;
}

export interface OperatorSuggestion {
  kind: 'operator';
  name: string;             // '$eq' — always $-prefixed
  class: OperatorClass;
  summary?: string;
  source: string;
  /** True when the op's validIn doesn't cover the caret's context;
   *  downranked but still shown. */
  offContext?: boolean;
}

export type Suggestion = FieldSuggestion | ValueSuggestion | OperatorSuggestion;

/** Key-position source — emits fields or operators at a bare-key site. */
export type FieldSource = (ctx: SuggestionContext) =>
  Array<FieldSuggestion | OperatorSuggestion>
  | Promise<Array<FieldSuggestion | OperatorSuggestion>>;
```

## 3. Source — `operatorSource`

Sync, pure. Maps every `OPERATORS` entry to an `OperatorSuggestion`.
When `ctx.operatorContext` is set, entries whose `validIn` doesn't
include it are flagged `offContext: true`. When unset, every entry is
in-context.

```ts
// src/features/fieldSuggestions/sources/operatorSource.ts
export const operatorSource: FieldSource = (ctx) => {
  const wanted = ctx.operatorContext;
  return OPERATORS.map((op) => ({
    kind: 'operator',
    name: op.name,
    class: op.class,
    summary: op.summary,
    source: 'operators',
    offContext: !!wanted && !!op.validIn && !op.validIn.includes(wanted),
  }));
};
```

## 4. Source composition

```ts
// src/features/fieldSuggestions/sources/index.ts
export const DEFAULT_FIELD_SOURCES = [lastRunSource, sampleSchemaSource];
// useSuggestions defaults to DEFAULT_FIELD_SOURCES (fields only).
// Consumers opt in to operators explicitly.
```

Rationale: two ambiguous defaults were collapsed into one — surfaces
that want operators pass a composition explicitly. See §5 and §8.

## 5. Grammar detector — `operatorContext` resolution

`detectAggGrammar(value, caret, stageOp?)` gains a third parameter.
The `fieldName` hit grows an `operatorContext?: OperatorContext` field.

Resolution rule (`resolveOperatorContext(stageOp, depth)`):

| stageOp                    | depth 1 | depth ≥ 2           |
| -------------------------- | ------- | ------------------- |
| `$match`                   | matchKey | matchKey           |
| `$group`                   | —       | groupValue         |
| `$project`                 | —       | projectValue       |
| `$set`, `$addFields`       | —       | addFieldsValue     |
| `$facet`, unknown, absent  | —       | —                  |

Depth is `scopes.length` at the caret. "—" means `operatorContext` is
left undefined, so `operatorSource` falls back to showing the full
catalog in-context. `$facet` bodies recurse through stage-named keys
(e.g., `byStatus: [{$match: ...}]`); tracking the inner stage at the
caret is a Phase-B-v2 refinement — the current detector returns no
context for `$facet`, which is acceptable (full catalog).

The `fieldRef` and `valueFor` hits are unchanged.

## 6. Ranking

`useSuggestions.scoreMatch` scores against `candidate.slice(1)` when
the token doesn't start with `$` and the candidate does. This gives:

- `eq` → `$eq` scores 100 (exact after strip)
- `sum` → `$sum` scores 50 (prefix after strip)
- `$e` → `$eq` scores 50 (prefix, original behavior preserved)

`rankOperator(token, s)` applies a `-30` penalty when `s.offContext`
is true. Off-context ops still appear (don't hide) but sink below
in-context matches.

Dedupe key for operators is `O:${name}`; operators from different
sources with the same name merge into one row.

## 7. Popover rendering

`SuggestionPopover` routes on `s.kind`:

- **field** — label = `s.path`, badge = `s.type` (DisplayType)
- **operator** — label = `s.name` (includes the `$`), badge = short
  class label via `CLASS_BADGE` (`stage` | `query` | `logic` | `elem` |
  `eval` | `array` | `geo` | `acc` | `expr` | `update`)
- **value** — label = `s.display`, badge = `s.type`

Mixed lists are fine — ranking orders them together and the badge
differentiates.

`useTextareaAutocomplete.onSelect` splices `s.name` for operator hits
(same behavior as field hits but with the `$`-prefixed name).

### Picker grouping

The builder's op box passes `groupOperators` to the popover, which then
lays the operator rows out under one header per class: `query` shows as
Comparison, then Logical, Element, Evaluation, Array and Geospatial (any
other class is Other). `operatorGroups.ts` computes the runs from the
list's own order, so grouping never reorders anything.

- Grouping applies only while the box is blank. Once there is a token the
  list is a relevance ranking and stays flat.
- The markup is a `role="group"` per run, labelled by a non-interactive
  header, inside the one listbox. The highlight, `aria-selected` and Enter
  walk the options as a single flat list across groups; headers are never
  highlightable.
- The builder's list offers each operator once: the `$expr`-only twins of
  `$eq`, `$size` and the like (expression class) are left out, so no
  Other group appears.
- Only the builder opts in. Stage bodies, the query bar and the
  aggregation editor keep the flat list.
- Known limitation: focusing a row's op box puts the committed operator
  (such as `$eq`) in the token, which filters the list, so the grouped view
  shows on a blank row or after the user clears the box. Showing the full
  catalog on focus would change what the popover does today and is out of
  scope here.

## 8. Consumer wiring

### Textarea surfaces (W05 query bar, A03 stage accordion)

`useTextareaAutocomplete({ textareaRef, suggestionContext, stageOp, onReplace })`.

- W05 passes `stageOp: '$match'` — the find-filter body is `$match`
  semantics.
- A03 passes `stageOp: stage.op`.

Internally, the hook uses `[...DEFAULT_FIELD_SOURCES, operatorSource]`
so the popover offers both fields and operators at key positions.
Context flows: grammar hit → `ctx.operatorContext` → operator source
offContext flag → rank penalty.

### Builder condition row (W04)

Two popovers in the same row:

- **field input** — `fieldSources: DEFAULT_FIELD_SOURCES` (field-only
  behavior preserved; operators don't pollute the field-path input).
- **op input** — `fieldSources: [operatorSource]`,
  `operatorContext: 'matchKey'` (builder filters are `$match`
  semantics, so query-side ops rank first; stage ops and accumulators
  still appear, downranked).

On accept, the op input dispatches `{ t: 'patchCond', patch: { op: s.name } }`.

### AddStagePill (A03)

Search accepts bare names: typing `sort` matches `$sort`. One-liner in
the filter — no change to the stage list.

## 9. Builder compiler (W04)

`Cond.op` widens from `MqlOp` to `string` (the user can type any op).
`MqlOp` stays as a narrow union of ops the compiler handles and is the
type of `FIELD_OPS[valType]` entries.

### Shape buckets

Every op the builder emits falls into one of:

| Bucket       | Ops                                                          | Value handling                                  |
| ------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| simple       | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`                   | `buildTypedValue(cond)` (per valType)           |
| exists       | `$exists`                                                    | `true` (value field ignored)                    |
| in / nin     | `$in`, `$nin`, `$all`                                        | `parseJsonArray(value)` → `[]` on parse error   |
| regex        | `$regex`                                                     | `value` (no flags yet)                          |
| type         | `$type`                                                      | `Number(value)` if numeric, else `value`        |
| mod          | `$mod`                                                       | `parseJsonArray(value)` expects length 2        |
| size / bits  | `$size`, `$bitsAllClear/…AnySet/…AllSet/…AnyClear`           | `Number(value)`                                 |
| needs-raw    | everything else (e.g., `$elemMatch`, `$text`, `$expr`, `$geo*`) | row flagged invalid; Run blocked             |

`isCompilableOp(op)` names the buckets above; applicability is
`FIELD_OPS[valType]` membership (`FIELD_OPS` is the applicability table).

### Condition problems

`filterTree.ts`'s `condValueProblem(cond)` drives the warning text on the
row; W04 §2b lists its rules and messages in order. In short: an op that
doesn't start with `$` or isn't encodable (`'<op> is not encodable —
convert to a raw clause'`), a value that isn't a value of its type, an empty
or invalid `$in`/`$nin`/`$all` list, a malformed `{$oid}`/`{$date}`, and a
malformed `$mod`. A condition with a blank field is pending and never
checked. Applicability (`FIELD_OPS`) is not checked and no advisory is shown
for it.

### `CompiledMql.invalidCondIds`

New field: IDs of conditions with a problem. When non-empty:

- The Run button in `BuilderPane` is disabled with the tooltip
  `"One or more conditions need raw JSON mode"`.
- The offending row renders `aria-invalid`, a warning-colored border,
  and a small error message under the value input.

The user's escape hatch is the raw-query textarea (W05) — they can
flip to raw mode and hand-edit the object-shape expression.

### Expanded `FIELD_OPS` / `MqlOp`

`FIELD_OPS` now includes `$mod`, `$size`, `$type`, and `$bits*` where
they make sense per valType. `MqlOp` is extended with the same ops so
the lookup stays typed.

## 10. Behavior — lifecycle (delta vs X02)

1. User types at a key position in a textarea or the builder's op
   input.
2. Grammar detector resolves `operatorContext` from `stageOp` + caret
   depth (textareas) or the consumer passes it explicitly (builder op
   input sets `matchKey`).
3. `operatorSource` emits an `OperatorSuggestion` per catalog entry,
   marking off-context ones.
4. `useSuggestions` ranks — in-context matches first, off-context ones
   below, mixed with any fields/values from other sources.
5. On accept, the consumer splices `s.name` (with leading `$`) and
   moves the caret past it.

## 11. UI

- Operator row: same layout as field row. Left: monospace `$name`.
  Right: short class badge.
- The builder op input shares the condition row's `inputStyle` with
  `fontFamily: 'monospace'` and an error state when the condition
  problem is about the op (W04 §2b rules 1–2).
- The error message under the row is 10px, `T.warn` colored, one line.

## 12. Persistence

None. Catalog is static; context is computed per keystroke; ranking
lives in memory.

## 13. Error handling

- Catalog lookup misses (e.g., user-typed unknown op): the ranker
  returns no match, the popover just won't offer it. The row still
  flags as not encodable (W04 §2b).
- Malformed `$mod` / `$in` / `$nin` / `$all` values: a list that doesn't
  parse reads as `[]` and blocks with `'<op> needs at least one value'`;
  a malformed `$mod` blocks with its own `$mod` messages (W04 §2b).
- `$facet` context resolution returns no tag; the full catalog shows.
  Documented limitation; refining it requires running the detector on
  each branch of the facet body.

## 14. Acceptance criteria

- Typing `eq` in any bare-key position ranks `$eq` #1 (no leading
  `$` required). Typing `$e` preserves prior behavior and still ranks
  `$eq` #1.
- Operator suggestions appear alongside fields at key positions in
  stage bodies and the query bar textarea.
- AddStagePill search accepts bare stage names (`sort` → `$sort`).
- Builder condition row's op field is an autocomplete input
  offering the full catalog, with `matchKey`-context ranking.
- Typing an op outside `FIELD_OPS[valType]` flags the row and
  disables Run; the warning message names the mismatch.
- Typing an object-shape op (e.g. `$elemMatch`) flags the row as
  "needs raw JSON" and disables Run.
- `$mod` with an empty, single-element, or divisor-0 value is
  caught pre-run.
- Inside `$match` at any depth, query ops rank first and
  accumulators/stage ops sink.
- Inside `$group` at depth ≥ 2, accumulators rank first.
- Inside `$project` / `$set` / `$addFields` at depth ≥ 2,
  expression ops rank first.
- Inside `$facet`, the full catalog is shown (no context filter).
- Off-context operators still appear — downranked, not hidden.
- *(Follow-up)* Operator signature hints / parameter typeaheads.
- *(Follow-up — Phase C)* Update-expression surface uses
  `operatorContext: 'update'`. The catalog already carries the entries
  so this is purely additive.
- *(Follow-up)* $facet inner-stage context resolution.
- *(Follow-up)* Rank operators by how often the user picks them.
- With a blank op box, the builder's operator list shows under class
  headers, and arrow keys move through the options across headers.

## 15. Test cases

### Unit

- **field-suggestions-operators.spec.ts** — catalog shape:
  - `operatorSource` returns one suggestion per `OPERATORS` entry.
  - Every operator name is `$`-prefixed.
  - Core ops are present (`$eq`, `$ne`, `$gt`, `$sum`, `$match`,
    `$group`, `$concat`, `$set`).
  - `offContext` is false when `operatorContext` is unset; correctly
    marked when set (`$eq` in-context for `matchKey`, `$sum`
    off-context).
- **field-suggestions-agg-grammar.spec.ts** — extended with:
  - `$`-prefixed bare keys return a `fieldName` hit (operator source
    consumes it); the old `null`-return tests are rewritten.
  - `operatorContext` resolves correctly for each stageOp + depth
    combination (matchKey / groupValue / projectValue / addFieldsValue
    / none for `$facet` or missing stageOp).
- **builder-compile.spec.ts** — extended with:
  - New shape buckets: `$size`, `$mod`, `$in` all emit the right
    value shape.
  - Object-shape op (`$elemMatch`) populates `invalidCondIds`.
  - `$size` on a `string` valType populates `invalidCondIds`.
  - `isCompilableOp` exercises the trivial-shape and object-shape
    boundaries; `FIELD_OPS` is asserted as the exact per-valType table.
- **filter-tree.spec.ts** — `printFilter`'s problems carry the W04 §2b
  message for: non-`$` op, bad number / long / decimal values, the list
  rules, a malformed `{$oid}`/`{$date}`, malformed `$mod`.

### Component

- **field-suggestions-hook.spec.tsx** — extended with an "operator
  ranking" block:
  - Typing `eq` with `operatorSource` ranks `$eq` at #1.
  - Typing `$e` still ranks `$eq` at #1 (backward compatibility).
  - Mixed field + operator sources merge and rank together (`$eq`
    beats `equivalent` when the token is `eq`).
  - Off-context ops (e.g., `$sum` with `operatorContext: 'matchKey'`)
    still appear in results.

### Manual / E2E

- Open a `$match` stage body and type `{ age: { gt|` → `$gt` offered
  at the top of the popover.
- Open a `$group` body and type `{ total: { sum|` → `$sum` ranks first.
- Open the builder, set valType to `number`, type `mod` in the op
  input → `$mod` at the top. Leave value blank → row warns
  `'$mod value must be a 2-element array…'` and Run is disabled.
- Type `elem` in the op input → `$elemMatch` appears but on accept the
  row warns `'$elemMatch needs raw JSON — open the query textarea'`.

## 16. References

- X02 (field & value suggestions) — the underlying infrastructure.
- W04 (query builder pane) — the consumer whose op input changed.
- A03 (stage accordion) — the consumer whose stage-body autocomplete
  learned operator + context awareness.
- The original design plan this spec folded in is deleted (fully
  superseded — this spec is the contract).
