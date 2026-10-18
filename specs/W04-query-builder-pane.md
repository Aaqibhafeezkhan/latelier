# W04 — Query builder pane (state + compile)

> **Status: Implemented.** §1–§4, §7 and §8 are superseded by [W13](./W13-filter-tree-editor.md), and the saved-queries strip in §6 was removed.

> **Partly superseded by [W13](./W13-filter-tree-editor.md).** W13 replaces the
> `BuilderState.conditions` container model and the compile/parse contract with
> a filter tree parsed from canonical EJSON text — §1–§4, §7 (including the
> fail-closed guard), and §8 below describe the shipped pre-W13 behavior
> and are frozen. Still authoritative and
> reused verbatim by W13: **§2a** (shape buckets), **§2b**
> (condition problems, now `filterTree.ts`'s `condValueProblem`), **§5**'s
> condition-row layout and the two autocompletes, and the **`FIELD_OPS`**
> table.

## Purpose

The right-hand "Builder / Saved / Recent" pane that lets users assemble a MQL `find` without typing raw JSON. Owns a normalized condition list, AND/OR logic, projection, sort, limit, and the bidirectional compile contract (builder → MQL → builder).

## Scope

- **In**: Condition rows (add/edit/remove), AND/OR toggle, projection chips, sort/limit inputs, `compileMql(state)`, `parseMqlToBuilder(mql)` (best-effort), Saved tab integration hook, Recent tab integration hook.
- **Out**: The query bar itself (W05), the actual running (W03), Saved/Recent CRUD (W09/W10).

## Dependencies

- W01, W03, W09, W10.

## 1. Types

```ts
// shared/types.ts
//
// MqlOp is the compiler-known set — the ops `compileMql` can encode as a
// simple `{ field: { $op: value } }` pair. `Cond.op` is a `string`
// because the user can type any op via autocomplete (see X03); the
// compiler flags rows with unknown ops via the §2b check.
export type MqlOp =
  | '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte'
  | '$in' | '$nin' | '$regex' | '$exists' | '$type' | '$all'
  | '$mod' | '$size'
  | '$bitsAllClear' | '$bitsAnyClear' | '$bitsAllSet' | '$bitsAnySet';

export type ValType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'regex' | 'objectid' | 'array';

export interface Cond {
  id: number;                 // monotonic within tab
  field: string;
  op: string;                 // any $-prefixed op; compiler validates
  valType: ValType;
  value: string;              // raw text; typed as per valType at compile time
}

export interface BuilderState {
  conditions: Cond[];
  logic: 'AND' | 'OR';
  projection: string[];       // field names to include (implicit `_id: 1`)
  sort: string;               // raw MQL, e.g. '{ date: -1 }'
  limit: string;              // raw number or empty
}
```

## 2. Compile — builder → MQL

```ts
interface CompiledMql {
  filter: string;
  sort?: string;
  projection?: string;
  limit: number | null;
  invalidCondIds: number[];    // rows flagged by the §2b check
}

compileMql(state: BuilderState): CompiledMql;
```

Algorithm:
1. **Filter**: for each active condition (field non-empty),
   `buildCondObject(cond)` produces `{ <field>: { <op>: <shapedValue> } }`.
   `<shapedValue>` depends on the op's shape bucket (see §2a).
   - If `active.length === 1` → the single clause IS the filter.
   - Else combine with `{ $and: [...] }` or `{ $or: [...] }` per `state.logic`.
2. **Projection**: if `state.projection.length > 0`, build
   `{ _id: 1, <f>: 1, ... }`. Empty ⇒ omit.
3. **Sort**: pass-through of `state.sort` (raw MQL). Empty ⇒ omit. The
   field validates as EJSON object before running.
4. **Limit**: parse as integer; empty or invalid ⇒ `null` (runner
   supplies default 50).
5. **`invalidCondIds`**: IDs of conditions whose op the compiler can't
   encode (`!isCompilableOp(op)`), whose op doesn't apply to the
   valType (op not in `FIELD_OPS[valType]`), or which have an
   op-specific value problem (`$mod` with a malformed or divisor-0
   value). See §2b.

All string outputs are EJSON canonical strings (F04 wire form).

### 2a. Shape buckets

`buildCondValue(cond)` dispatches by op:

| Bucket       | Ops                                                          | Value handling                                  |
| ------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| simple       | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`                   | `buildTypedValue(cond)` per valType             |
| exists       | `$exists`                                                    | `true` (value field ignored)                    |
| in / nin     | `$in`, `$nin`, `$all`                                        | `parseJsonArray(value)` → `[]` on parse error   |
| regex        | `$regex`                                                     | raw `value` string                              |
| type         | `$type`                                                      | `Number(value)` if finite, else `value`         |
| mod          | `$mod`                                                       | `parseJsonArray(value)` — length 2 expected     |
| size / bits  | `$size`, `$bitsAll*`/`$bitsAny*`                             | `Number(value)` (0 on parse error)              |
| needs-raw    | anything not listed above (`$elemMatch`, `$text`, `$expr`, `$geo*`, `$jsonSchema`, all accumulators/expressions) | row flagged invalid; Run blocked |

`buildTypedValue(cond)` for the `simple` bucket keeps the valType
mapping from the original spec (`string` → quoted, `number` → numeric,
`boolean` → true/false, `date` → `{$date}`, `null` → `null`,
`regex` → `{$regex}`, `objectid` → `{$oid}`, `array` → parsed JSON).

### 2b. Condition problems — `condValueProblem(cond) → string | null`

Lives in `filterTree.ts` (W13) and is not exported. `printFilter` runs it on
every enabled condition whose field is not blank; a condition with a blank
field is pending and never reaches it. `toRawNode` uses it too: a condition
with a problem converts to a blank raw clause. It returns the first problem
it finds, in order:

1. Op doesn't start with `$` → `'Operator must start with "$"'`.
2. `!isCompilableOp(op)` → `'<op> is not encodable — convert to a raw clause'`.
3. A scalar value that isn't a value of its type: `'Value must be a valid
   number'` (`number`), `'Long value must be an integer'` (`long`),
   `'Decimal value must be a number'` (`decimal`), or the precision message
   for a `number` beyond 2^53.
4. For `$in`/`$nin`/`$all`: a raw number element beyond 2^53 (precision
   message); an empty list → `'<op> needs at least one value'`; an element
   that fails rule 3 for the row's type; on a `boolean` row, an element other
   than `true`/`false` → `'Boolean value must be true or false'`.
5. A sent `{$oid}` that isn't 24 hex characters → `'ObjectId must be 24 hex
   characters'`; a sent `{$date}` that doesn't parse → `'Date must be a date,
   e.g. 2026-01-31T00:00:00Z'`.
6. `$mod`: not a 2-element array → `'$mod value must be a 2-element array,
   e.g. [2, 1]'`; then `'$mod divisor must be a finite number'`, `'$mod
   divisor cannot be 0'`, `'$mod remainder must be a finite number'`.

The precision message is `'Contains a number too large to represent exactly
— use {"$numberLong": "..."} or {"$numberDecimal": "..."} instead'`.

Applicability is not checked: an op outside `FIELD_OPS[valType]` prints and
runs, and no advisory for it is shown. `isCompilableOp(op)` enumerates the
shape buckets above.

A problem blocks the print: the drawer keeps `queryRaw` at its last good
value, pauses the live count, shows `⚠ N not applied: …` above the tree, and
puts the message on the row — under the value input when the op is
encodable, on the row otherwise.

## 3. Parse — MQL → builder (best-effort)

`parseMqlToBuilder(filterEjson: string): { ok: true; state: Partial<BuilderState> } | { ok: false; reason: string }`

Strategy:
- Parse EJSON. If not an object, fail.
- If the root is `{ $and: [...] }` or `{ $or: [...] }` with array items each of shape `{ field: { op: val } }`, extract each as a `Cond`.
- If the root is a single `{ field: { op: val } }`, one Cond.
- If anything else (nested `$or`, array ops, free-form expressions): fail with reason `'Contains operators the builder can\'t represent.'`
- Map typed value back to `ValType`:
  - `typeof 'string'` → `string`.
  - `typeof 'number'` → `number`.
  - `typeof 'boolean'` → `boolean`.
  - `{ $date: ... }` → `date`.
  - `{ $oid: ... }` → `objectid`.
  - `{ $regex: ..., $options: ... }` → `regex` (ignore options in iteration 1).
  - `null` → `null`.
  - `Array` → `array`.

Consumers handle `ok: false` by disabling the builder and showing W05's "cannot sync" state.

## 4. Reducer / hook

```ts
// src/pages/Workspace/builder.ts
type Action =
  | { t: 'addCond'; field: string }
  | { t: 'patchCond'; id: number; patch: Partial<Cond> }
  | { t: 'removeCond'; id: number }
  | { t: 'setLogic'; v: 'AND'|'OR' }
  | { t: 'toggleProj'; field: string }
  | { t: 'setSort'; v: string }
  | { t: 'setLimit'; v: string }
  | { t: 'hydrate'; state: BuilderState };
function reducer(s: BuilderState, a: Action): BuilderState;
```

Exported helpers:
- `useBuilder(tabId)` — reads initial state from the active tab's `state.builder`, dispatches via reducer, persists diffs through `api.tabs.update(tabId, { state: { builder: next } })` (debounced).
- `compileMql(state)` and `parseMqlToBuilder(s)`.

## 5. UI (existing mock, wired real)

The existing Workspace's right pane is the home for this. Structure:

- **Tabs row**: `Builder` / `Saved` / `Recent`. Active tab styling already in mock.
- **Builder tab content**:
  - Conditions section: list of `CondRow`s, AND/OR pills, "+ Add condition" button.
  - Projection section: chips. Clicking toggles.
  - Sort + Limit row: two small inputs.
  - "Saved for {collection}" section (optional, W09): renders if there are any saved queries targeting this collection.
- **Saved tab content**: list from `api.saved.list({ connectionId, dbName, collection? })` (W09). Each row has `Run here` + `Open in new tab`.
- **Recent tab content**: list from `api.recent.list(...)` (W10). Each row has `Run here` + `Copy MQL`.
- **Footer**: `Reset`, `Copy code`, `Run`. Matches mock.

### Condition row layout

Each `CondRow` is two lines:

- **Line 1**: `field` input (the label, flex-fills) + `op` input (fixed width, monospace) + remove button.
- **Line 2**: `valType` select (fixed width) + `value` input (flex-fills). The value input is hidden when `op === '$exists'`; the type select remains.
- Row-level warning text from the §2b check renders beneath both lines.

### Conditions field selector
- On focus, the `field` input shows a field-name autocomplete popover
  (X02). The builder pane owns the popover directly (input anchor, no
  textarea glue) and splices the selected path into the condition via
  `dispatch({ t: 'patchCond', patch: { field: s.path } })`. The field
  input uses `DEFAULT_FIELD_SOURCES` — operators are intentionally
  excluded here.

### Condition op selector *(X03)*

- The op is a monospace `<input>` with its own autocomplete popover
  driven by `[operatorSource]` and `operatorContext: 'matchKey'`. The
  popover offers the full catalog; query-side ops rank first.
- Users can type any `$`-prefixed op; the compiler (§2) decides whether
  it's representable.
- The input renders in its error state (`aria-invalid`) when the §2b
  problem is about the op (rules 1–2), and the message shows under the
  row. A value problem marks the value input instead.
- On accept, dispatches `{ t: 'patchCond', patch: { op: s.name } }`.

### Applicable ops per valType — `FIELD_OPS`

Used when a row's valType changes: the row keeps its op if the new type's
set holds it, and otherwise switches to that set's first op. Ops outside
this set still appear in the popover (the catalog is the source); the
§2b check does not flag them.

| valType   | Ops                              |
| --------- | -------------------------------- |
| string    | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$exists`, `$type` |
| number    | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$type`, `$mod`, `$bitsAllClear`, `$bitsAnyClear`, `$bitsAllSet`, `$bitsAnySet` |
| boolean   | `$eq`, `$ne`, `$exists`, `$type` |
| date      | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$type` |
| null      | `$eq`, `$ne`, `$exists`, `$type` |
| regex     | `$regex`, `$exists`, `$type`     |
| objectid  | `$eq`, `$ne`, `$in`, `$nin`, `$exists`, `$type` |
| array     | `$in`, `$nin`, `$all`, `$exists`, `$type`, `$size` |

## 6. "Saved for this collection"

Renders up to 5 saved queries scoped to `(connectionId, dbName, collection)`. Each row:
- `Run here` → replace the Builder state with the saved payload + call Run.
- `Open in new tab` → open a duplicate tab via W01 and hydrate.

## 7. Compile errors

`compileMql` returns `invalidCondIds` — conditions caught by
the §2b check. When that list is non-empty:

- Run is disabled with tooltip `"One or more conditions need raw JSON mode"`.
  This applies to **both** Run buttons — the pane's and W05's — which share
  one gating rule.
- Each offending row renders `aria-invalid`, a warn-colored border
  around the op input, and the message text under the value input.

The escape hatch for object-shape ops is the raw query textarea (W05)
— users flip to raw mode and hand-edit.

### 7a. Fail-closed execution guard **

`compileMql` still **emits** a flagged condition — `buildCondValue` falls
back to `buildTypedValue`, so an `$elemMatch` row compiles to
`{"items":{"$elemMatch":"{...}"}}`. That string is valid EJSON, which means
any "is this runnable" check testing only EJSON validity says yes.

`currentFilterJson(state)` therefore returns `string | null`, and returns
`null` when the builder holds a flagged condition and the tab is not dirty.
It is the single choke point every executor routes through:

| Consumer | Behavior on `null` |
| --- | --- |
| `useQueryRunner.run` | patches `lastRun.error` with `VALIDATION` and returns without IPC |
| Delete-all (`openDeleteAll` + the confirm) | refuses to arm; `notify.error` |
| `currentQueryKey` (hint counter) | falls back to a distinct `<invalid>` bucket |

`compileMql` must **not** be changed to drop flagged conditions instead.
That widens the compiled filter from mangled to `{}`, and delete-all reads
the same resolver — a widened filter there matches the whole collection.
The mangled string is also what the query bar shows and what the user
hand-edits to escape the flag.

## 8. Persistence

`BuilderState` is persisted as part of each collection tab's `state.builder` (W01 §2). Restoration is automatic when switching tabs or relaunching.

## 9. Acceptance criteria

- Adding a condition defaults to the first field, `$eq`, `string`, empty value.
- Changing `valType` resets `op` to the first op applicable for that
  type when the current op no longer fits.
- Toggling AND/OR with ≥ 2 conditions rewrites the compiled MQL envelope.
- Sort and Limit round-trip verbatim.
- Compile produces valid EJSON for every supported `valType`/op combination.
- Parse recognizes `{ field: { $op: val } }` and `{ $and: [...] }` / `{ $or: [...] }` shapes.
- Parse fails gracefully on free-form filters; the pane renders the "cannot sync" state.
- *(X03)* Op input offers the full operator catalog via autocomplete.
- *(X03)* Typing `eq` (no `$`) accepts `$eq`.
- *(X03)* Ops outside `FIELD_OPS[valType]` flag the row; Run is
  disabled with a tooltip.
- *(X03)* Object-shape ops (`$elemMatch`, `$text`, `$expr`, `$geo*`,
  `$jsonSchema`) flag the row as "needs raw JSON"; Run is disabled.
- *(X03)* Malformed `$mod` values (empty, single-element,
  divisor-0) are caught pre-run.
- ** A flagged condition disables **both** Run buttons, and
  blocks the runner even when invoked with no button involved
  (`query.run`, post-write re-runs).
- ** A flagged condition leaves delete-all unarmable rather than
  widening its filter to `{}`.
- ** Builder edits do not overwrite `queryRaw` while the tab is
  dirty; the only Save modal and the `query.save` command are owned above
  the pane so they survive it being collapsed **.

## 10. Test cases

### Unit
- **reducer.spec.ts**: each action transitions state correctly; `patchCond` only touches the identified id.
- **builder-compile.spec.ts**: fixture-based — (state) → (filter MQL,
  sort, limit, projection, `invalidCondIds`). Covers every valType,
  logic AND/OR, single-condition short-circuit, empty state → `{}`,
  each shape bucket (`$in`, `$mod`, `$size`, `$bits*`, `$regex`,
  `$type`), and `isCompilableOp` and `FIELD_OPS` boundaries.
- **filter-tree.spec.ts**: the §2b messages, through `printFilter`'s
  problems.
- **parseMqlToBuilder.spec.ts**: round-trips for supported shapes;
  failures for free-form filters; recognizes `$and`, `$or`, `$date`,
  `$oid`, `$regex`.

### Component
- **add-remove-cond.spec.tsx**: interactions with mocks observe correct reducer actions.
- **invalid-number.spec.tsx**: typing "abc" into a number condition disables Run and shows an outlined row.
- **projection-chips.spec.tsx**: clicking chips toggles selection; compiled projection reflects state.
- **sort-limit.spec.tsx**: text inputs update compiled output.
- **saved-section.spec.tsx**: mock returns one saved query for collection → row visible; "Run here" hydrates state and triggers run.
