# W13 — Filter tree editor (redesign "B")

> **Status: Implemented.** It supersedes parts of [W04](./W04-query-builder-pane.md) and [W05](./W05-query-bar.md).

## Purpose

Replace the builder/query-bar **sync state machine** with a single canonical
representation: the filter is the EJSON text, and the right-hand drawer is a
recursive, editable *view* of that text. Anything the view can't model degrades
to an editable raw clause instead of disabling the drawer. Filter text and the
drawer can no longer disagree, because there is only one of them.

This supersedes the `BuilderState.conditions` model (W04 §1–§4) and the
SYNCED/DIRTY machine (W05 §1). It is Phase 2 of the query-builder redesign;
Phase 1 shipped previously.

## Scope

- **In**: `filterTree.ts` (parse / print / edit, pure), the recursive drawer UI,
  raw-clause degradation, nested groups, deletion of `queryDirty`, single Run,
  single owner for sort/limit/projection, the saved-query compatibility
  shim.
- **Out**: `FindInput` additions — `collation` / `hint` / `maxTimeMS` /
  `readPreference` (Phase 3, independent, needs the 5-file IPC contract). The
  drawer being dimmed dead weight on the Aggregation and Schema sub-views
  (layout, separate ticket). Merging Documents into the aggregation pipeline
  ("redesign C") — W13 is a precondition for it, not a step of it.

## Dependencies

- W01 (tab state), W03 (runner), W05 (query bar), W06, W09 (saved queries),
  W10 (recent), X02 (field autocomplete), X03 (operator autocomplete),
  X11 (workspace composition).

## 1. Model

```ts
// src/pages/Workspace/filterTree.ts
// Pure module — no React, no CollectionTabState, no api imports. That is what
// makes it reusable as the aggregation `$match` editor later (redesign C).

/** Node identity IS its position. No generated ids to keep stable. */
export type NodePath = readonly number[];

// The node types live in shared/types.ts and are re-exported from here.
export type { CondNode, RawNode, GroupNode, FilterNode } from '@shared/types';

// shared/types.ts
export interface CondNode {
  kind: 'cond';
  field: string;
  op: string;               // any $-prefixed op; print validates
  valType: ValType;         // see the note below — take it from builder.ts
  value: string;            // raw text, typed at print time
  disabled?: boolean;
}

export interface RawNode {
  kind: 'raw';
  /** One clause, verbatim. Printed byte-for-byte after a parse check. */
  json: string;
  disabled?: boolean;
}

export interface GroupNode {
  kind: 'group';
  logic: '$and' | '$or' | '$nor';
  children: FilterNode[];
  disabled?: boolean;       // never set on the root group
}

export type FilterNode = GroupNode | CondNode | RawNode;
```

The node types live in `shared/types.ts`, not in `filterTree.ts`, because a
tab's persisted draft (§5.7) holds a tree and `shared/` cannot import from the
renderer. `filterTree.ts` re-exports them, so callers keep one import site.

`disabled` switches a node off without deleting it: it stays in the tree, on
screen and editable, but the printer treats it as pending (§3). `parseFilter`
never sets it, so it only ever exists in a drawer's own tree and its draft.
The root group is never disabled; the drawer offers no control for it.

The root is **always** a `GroupNode`. `ValType`, `FIELD_OPS`,
`buildTypedValue`, and `coerceArrayElement` carry over unchanged — W13 replaces
the *container* model, not the value model.

> **Take the value model from `src/pages/Workspace/builder.ts`, not from W04
> §1.** W04 §1's `ValType` list predates the BSON-precision work and is missing
> `long` and `decimal`, which `FIELD_OPS`, `buildTypedValue`, and the
> condition-problem check (now `condValueProblem`) have all handled since. The shipped union is
> `'string' | 'number' | 'long' | 'decimal' | 'boolean' | 'date' | 'null' |
> 'regex' | 'objectid' | 'array'`. `long`/`decimal` are comparison-only on
> purpose — `$mod` and `$bits*` route through `Number()`, which re-introduces
> the precision loss those types exist to avoid.

## 2. `parseFilter`

```ts
export type ParseOutcome =
  | { ok: true; root: GroupNode }
  | { ok: false; reason: string };

export function parseFilter(ejson: string): ParseOutcome;
```

**Total on any valid JSON object.** It fails on exactly two things: text that
isn't valid EJSON, and a root that isn't an object. It never fails because of
an operator it doesn't understand — that is the whole point of W13, and it
removes the "Builder disabled" badge that today's `parseMqlToBuilder` raises on
the most idiomatic filter there is (`{ status: "active", qty: { $gt: 5 } }`).

| Input | Parses to |
| --- | --- |
| `{}` | root group `$and`, no children |
| `{ name: "x" }` | one cond, op `$eq` (implicit `$eq` is recognized) |
| `{ name: { $eq: "x" } }` | one cond |
| `{ a: 1, b: 2 }` | root `$and`, two conds |
| `{ $and: [...] }` / `{ $or: [...] }` / `{ $nor: [...] }` | group, recursive |
| `{ $nor: [x] }` (exactly one item) | root `$and` holding a one-child `$nor` group: a NOT (§4), kept as a group so it reads back as one |
| `{ a: { $gte: 1, $lte: 5 } }` | two conds — **only** per §2a |
| `{ a: { $regex: "x", $options: "i" } }` | one **raw** node (§2a) |
| `{ items: { $elemMatch: {...} } }` | one raw node |
| `{ $expr: {...} }`, `{ $text: {...} }`, `{ $where: ... }`, `{ $jsonSchema: ... }` | one raw node |
| `{ a: { $not: {...} } }` | one raw node |
| `{ loc: { $near: {...}, $maxDistance: 10 } }` | one raw node (§2a) |
| `{ $and: [ { $or: [...] }, { a: 1 } ] }` | nested groups, arbitrary depth |
| `{ $or: [...], a: 1 }` | root `$and` group containing the `$or` group and the cond — logic keys and field keys at the same level are siblings under the root |

A `$and`/`$or`/`$nor` whose value is not an array is a raw node, not a parse
failure.

### 2a. Multi-key predicate splitting — allowlist, not a general rule

`{ a: { $gte: 1, $lte: 5 } }` may safely become two conds joined by the parent
`$and`. `{ a: { $regex: "x", $options: "i" } }` may **not** — `$options`
modifies `$regex`, and splitting them changes what the query matches.

> **Rule.** Split a field predicate into one cond per key **only when every key
> in it is in `SPLITTABLE_OPS`.** Otherwise the entire `{ field: {...} }` pair
> becomes a single raw node.

```ts
const SPLITTABLE_OPS = new Set([
  '$eq','$ne','$gt','$gte','$lt','$lte','$in','$nin','$all',
  '$exists','$type','$size','$mod','$regex',
  '$bitsAllClear','$bitsAnyClear','$bitsAllSet','$bitsAnySet',
]);
```

`$options`, `$maxDistance`, `$minDistance`, `$elemMatch`, `$not`, `$near`,
`$geoWithin`, `$nearSphere` are deliberately absent — each is either a modifier
of a sibling key or object-shaped. A single-key `{ a: { $regex: "x" } }` still
becomes a cond; it is the *pair* that forces raw.

This rule is load-bearing. An unqualified "split multi-op predicates" silently
changes result sets, which is the failure class that already cost this repo a
P0 incident.

### 2b. Value representability

A cond is only produced when the operator's value is representable by the
ValType model. A value outside it degrades the entire `{ field: {...} }` pair
to a single raw node — same degradation as §2a, same rationale: never mangle
what the model can't express.

**Unrepresentable value shapes:** plain nested objects (e.g.
`{ $eq: { nested: 1 } }`), `$binary`, `$timestamp`, `$numberDouble` /
`$numberInt` sentinels, `$regularExpression` (the pattern+options form),
`$minKey` / `$maxKey`, `$code`, `$dbPointer`, and any `$in`/`$nin`/`$all` array
containing an element that is itself unrepresentable.

The representable set is the inverse of `buildTypedValue` in `builder.ts`:
plain string/number/boolean/null, `{$oid}`, `{$date}`, `{$numberLong}`,
`{$numberDecimal}`, `{$regex}` (string-pattern form, no `$options` sibling —
that case is already raw per §2a), and homogeneous arrays of those for the
array-value ops.

The value→(valType, text) inference is the inverse of `buildTypedValue`,
adapted from the `guessValType` / `valueToString` helpers currently inside
`parseMqlToBuilder` (`builder.ts` lines ~462–508) — those helpers move into
`filterTree.ts` rather than being deleted with `parseMqlToBuilder`, and the
legacy fall-through where an unknown object stringifies to `"[object Object]"`
is exactly the corruption this rule exists to prevent. Under the old narrow
parser this path was rare; under a total parser it is hot, which is why the
rule is load-bearing.

**Which parser.** `parseFilter` uses plain `JSON.parse` with sentinel-aware
inspection of the resulting plain objects — **not** `ejsonParse` from
`src/utils/ejson.ts`, which revives sentinels into BSON class instances (wrong
shape for a tree editor that stores value *text*, not typed objects).

## 3. `printFilter`

```ts
export interface NodeProblem { path: NodePath; message: string }

export type PrintOutcome =
  | { ok: true; json: string }
  | { ok: false; problems: NodeProblem[] };

export function printFilter(root: GroupNode): PrintOutcome;
```

**Fail-closed.** `printFilter` returning a discriminated result — rather than a
best-effort string — is what preserves the fail-closed guard (W04 §7): a
node the printer can't encode never reaches `queryRaw`, so it can never reach
`query.find` or delete-all.
`currentFilterJson` **changes signature** from `string` to `string | null`
(§9) — callers must treat `null` as "no runnable filter", never as `{}`.

**Blocking problems** (print fails):

| Node | Problem |
| --- | --- |
| cond | op doesn't start with `$` |
| cond | value invalid for `valType` — the `number` / `long` / `decimal` / `$mod` checks in `condValueProblem` (W04 §2b) |
| cond | op not encodable as `{ field: { $op: value } }` (the UI offers "convert to raw clause" instead of letting this happen — the check is a backstop) |
| raw | non-blank `json` isn't valid JSON, or isn't an object |
| raw | `json` contains a numeric literal that `JSON.parse` → `JSON.stringify` round-tripping would alter (§3a) |

**Non-blocking:** a cond whose `field` is empty, or a raw node whose `json` is
blank/whitespace, is **pending** (§5) — skipped by the printer, never a
problem. A **disabled** node of any kind is pending too, together with its
whole subtree, and is checked first: a switched-off row with an invalid value
never blocks the rest of the filter. A nested group left with no printable
children is omitted (§3a), so a `$nor` whose only child is disabled prints
nothing rather than `{"$nor":[]}`. A cond whose op is outside `FIELD_OPS[valType]` still prints;
applicability is advisory, as today.

### 3a. Normalizations the printer performs

Output is canonical, not a faithful echo of the user's typing. The visible
consequences, all intended:

- Implicit `$eq` prints explicit: `{ name: "x" }` → `{"name":{"$eq":"x"}}`.
- A group with exactly one printable child prints as that child — **except
  `$nor`**, whose envelope is semantic and always survives.
- A group with no printable children is omitted; a root with none prints `{}`.
- Multiple top-level fields print as `{"$and":[…]}`, not the implicit form.
- Key order follows tree order.
- Raw nodes still normalize through `JSON.parse` + `JSON.stringify` (so the
  fixpoint below holds) — **except** a numeric literal that round-tripping
  would alter, which is a blocking problem (§3), not a silent rounding.
  `JSON.parse` + `JSON.stringify` corrupts integer literals beyond 2^53
  (`9007199254740993` → `...992`), and unlike today — where the bar text
  travels to the main process verbatim and precision only degrades at
  execution — the printer would write the rounded value back into the user's
  visible text and into saved queries. That's durable corruption, the exact
  class the `long`/`decimal` types exist to prevent. Detection: the
  `JSON.parse` reviver's `context.source` (available in Electron's V8) gives
  the original source text of each number token; a token whose source differs
  from `JSON.stringify` of its parsed value is not round-trip-safe. The
  blocking message directs the user to the `{"$numberLong": "..."}` /
  `{"$numberDecimal": "..."}` sentinel instead. Fail-closed beats silent
  rounding.

### 3b. The round-trip guarantee

Textual round-tripping is **not** guaranteed and must not be tested for —
`{ name: "x" }` deliberately comes back as `{"name":{"$eq":"x"}}`. What is
guaranteed is a fixpoint after one pass:

> For any `s` where `parseFilter(s).ok`, let `p = printFilter(parseFilter(s).root)`.
> If `p.ok`, then `printFilter(parseFilter(p.json).root)` is `p.json`.

Semantic preservation (`s` and `p.json` match the same documents) is asserted
by a hand-checked fixture corpus, not derivable from the fixpoint property.
Both go in `filter-tree.spec.ts` (§10).

## 4. Edit API

```ts
export function nodeAt(root: GroupNode, path: NodePath): FilterNode | null;
export function updateAt(root: GroupNode, path: NodePath, next: FilterNode): GroupNode;
export function insertAt(root: GroupNode, parent: NodePath, node: FilterNode, index?: number): GroupNode;
export function removeAt(root: GroupNode, path: NodePath): GroupNode;
export function wrapInGroup(root: GroupNode, path: NodePath, logic: GroupNode['logic']): GroupNode;
export function unwrapGroup(root: GroupNode, path: NodePath): GroupNode; // a one-child nested group → its child
export function andAtRoot(root: GroupNode, node: FilterNode): GroupNode;   // one more requirement on the whole filter
export function toRawNode(cond: CondNode): RawNode;     // best-effort encode; falls back to a blank pending raw node
export function tryParseRaw(raw: RawNode): FilterNode;  // raw → cond(s) when §2 can model it (wrapped in $and if >1), else unchanged
```

All are pure and return new roots. `removeAt` on the last child of a nested
group removes the empty group too; the root group is never removed.
`insertAt` appends when `index` is omitted and clamps an out-of-range one;
the drawer's *Insert condition above / below* pass the row's own index or the
one after it.

**Negation** needs no node kind of its own: NOT over any subtree is a
one-child `$nor`, which prints and parses as plain MongoDB. Negating is
`wrapInGroup(root, path, '$nor')`; removing it is `unwrapGroup`, which
replaces a nested group holding exactly one child with that child, and
returns `root` itself for anything else (the root, a non-group, a group of
several children, a path that does not resolve). A NOT round-trips through
the text: `parseFilter` keeps a top-level one-child `$nor` as a group under an
`$and` root (§2) instead of absorbing it into the root, which never shows NOT.
A root `$or`, or a `$nor` of several items, still parses to the root itself. A disabled group hands its
`disabled` to the child it leaves behind, so removing the wrapper never
switches a condition back on. `toRawNode` and `tryParseRaw` carry `disabled`
over the same way. Field-level `$not` stays a raw node (§2).

`toRawNode`'s fallback is a blank **pending** raw node (§5), never `{}` — `{}`
matches everything, so under `$or` a bad fallback would make the group
match-all, and under `$nor` match-nothing. A blank node is inert instead:
skipped by the printer until the user fills it in.

`tryParseRaw` can model a clause as more than one cond —
`{"a":{"$gte":1},"b":2}` becomes two. Splicing them flat into the parent group
would change semantics when that parent is `$or`/`$nor` (two ANDed conditions
turned into two ORed, or NORed, alternatives). When the parse yields more than
one node, `tryParseRaw` returns them wrapped in an `$and` group; a single node
returns bare. The printer's single-child-group collapse (§3a) keeps the common
case — a raw clause that only ever modeled to one cond — tidy on the next
print.

Path-as-identity means an edit that changes structure renumbers siblings — the
drawer keys rows by path and accepts that a removal re-keys the rows after it.
Generated ids were rejected: they have to survive a re-parse from text, which
means reconciling ids against a tree that no longer exists.

## 5. Editing lifetime — the pending-node rule

"Text is canonical" alone makes a freshly-added empty condition row
impossible: the printer would either omit it (the row vanishes the instant it
is created) or emit `{"":{"$eq":""}}` (a garbage filter reaches Run). Neither
is acceptable, so the tree gets its own editing lifetime *on top of* canonical
text:

1. The drawer holds `root: GroupNode` in component state, seeded by
   `parseFilter(queryRaw)`.
2. It also holds `lastPrinted: string | null` — the text it itself last wrote.
3. **Reconcile rule.** On render, if `queryRaw !== lastPrinted`, the text
   changed from outside the drawer (bar typing, Saved/Recent load, Reset) →
   re-seed `root` from `parseFilter(queryRaw)` and drop pending nodes. If it is
   equal, keep the local tree — this is what lets a pending row and the caret
   survive a re-render. This rule only handles a same-tab external edit — see
   the tab-switch note below for why text equality alone can't cover switching
   tabs.
4. **Pending node**: a cond with an empty `field`, **or** a raw node whose
   `json` is blank/whitespace. Both are rendered, editable, skipped by the
   printer, and never block anything. Add-condition creates the former,
   "+ Raw" the latter — without this, a fresh raw row would be a blocking
   problem (§3) the instant it's created, firing the "N not applied" badge
   before the user has typed anything.
5. **Commit**: every edit calls `printFilter`. On `ok` with new text, patch
   `{ queryRaw: json }` and set `lastPrinted = json`. On failure, `queryRaw`
   is not patched — the tree keeps the edit, the offending row renders its
   message inline, and `queryRaw` stays at the last good value. Every edit,
   whatever the outcome, also writes the draft (§5.7).
6. **Tab switch.** Two tabs commonly share identical `queryRaw` (`'{}'` is the
   default), so the reconcile rule's text-equality check alone can't detect a
   tab switch — it would keep tab A's local tree, pending rows included,
   displayed for tab B. The drawer mounts with `key={tabId}`, so a tab switch
   always remounts, and the remount re-seeds from **that tab's own** draft
   when it still matches, else from `parseFilter(queryRaw)` (§5.7). Pending
   and disabled rows therefore survive a tab switch. They are dropped only by
   an outside text edit (the reconcile rule above), Reset, a Saved/Recent
   load, or Clear filter.

### 5.7 Persisted draft and history

The text cannot carry a pending or a disabled row, so a tree rebuilt from the
text alone loses them; a user who switched a condition off to try the query
without it would lose the condition on the next tab switch. The drawer's own
tree is therefore persisted with the tab, as
`CollectionTabState.filterDraft: { root: GroupNode; queryRaw: string }` —
the tree and the `queryRaw` it was last consistent with.

- **Seed.** On mount, the draft is considered only when
  `draft.queryRaw === queryRaw` and `draft.root` is a group. It then has to
  print: `ok` with exactly `queryRaw` uses the draft; blocked uses the draft
  with its problems, so the "N not applied" banner is back on first render;
  `ok` with any other text ignores the draft and seeds from `parseFilter`,
  so the drawer never shows a tree other than the one that runs. Without a
  usable draft, `parseFilter(queryRaw)` as before.
- **Seed over invalid text.** When `queryRaw` doesn't parse, a draft that is
  a group and either is blocked or prints to its own `draft.queryRaw` seeds
  the drawer frozen, read-only, with the note of §6a for a draft. The draft
  is the drawer's own last state, not necessarily the last valid text: the
  bar may have moved through other valid text while the drawer wasn't
  mounted. Returning the bar to `draft.queryRaw` restores that tree, its
  switched-off and pending rows included; any other valid text re-parses as
  an outside edit. Without such a draft the drawer freezes on an empty tree
  that stands for no text, so only valid text unfreezes it.
- **Reconcile** (rule 3) still always parses and never reads the draft: an
  outside text edit wins. One made while the drawer is mounted clears the
  draft (`filterDraft: undefined`), so a later return to the same text can't
  bring the replaced rows back on the next remount. One made while the drawer
  is not mounted clears nothing: the draft is unused while the text is other
  valid text, seeds the drawer frozen while the text doesn't parse (above),
  and would seed again if the text came back to it.
- **Commit.** Every edit patches `filterDraft: { root, queryRaw }`, with the
  `queryRaw` that is current once the edit lands — the new text on an `ok`
  print, the unchanged last good text on a no-op or blocked one. That
  includes edits whose printed text does not change (adding a pending row,
  switching a row off), which patch the draft and nothing else.
- **Clear.** Reset, a Saved or Recent load, and *Clear filter* patch
  `filterDraft: undefined` together with their `queryRaw`, so the rows of the
  filter just replaced can't come back. Reset and the loads also remount the
  drawer. *Clear filter* doesn't, and its `'{}'` can equal the text the tree
  already prints to (only switched-off or pending rows left, or a later page
  of an unfiltered query), so the drawer can't see it by comparing text.
  Instead, a draft removed while the drawer is mounted, by anything other
  than the drawer's own reconcile, re-seeds the drawer from `queryRaw` as a
  remount would, so the tree on screen never holds rows its draft no longer
  does.
- **What runs.** Save, Recent and Copy code all read `queryRaw`, so a disabled
  condition is never saved, recorded or copied.

**History.** The drawer keeps an undo/redo history of its tree (`filterHistory.ts`:
`past` / `present` / `future`, capped at 100 steps). Every edit pushes; edits
carrying the same coalescing key back to back — keystrokes in one text box of
one row — are one step. An edit that lands back on the tree the step began
from (typing then deleting back) leaves no step at all. Undo and redo commit the tree they land on through
the same print-and-commit path as any edit. The history is in memory only: it
restarts from the new tree on an outside text edit, and a remount (tab
switch, Reset, a Saved or Recent load) drops it, which is why Reset keeps its
confirm.

Consequence to accept knowingly: while a node has a blocking problem, Run
executes the *last good* filter, not what is on screen. The drawer header
carries an "N not applied" badge so the divergence is visible where the edit
is.

```
// ponytail: Run stays enabled on last-good text rather than plumbing a
// filterProblemCount up into the toolbar. Upgrade path if the stale-run
// surprise proves real in use: lift the count into CollectionWorkspaceMeta
// (ephemeral, never persisted) and gate Run on it.
```

## 6. UI

The drawer's first tab is renamed **Builder → Filter**. Saved and Recent are
unchanged.

```
┌─ Filter ─────────────────────────────────────────────┐
│ [AND|OR|NOR]        + Condition  + Group  + Raw      │
│ ⚠ 1 not applied                                      │
│ ┌──────────────────────────────────────────────────┐ │
│ │ status        $eq      [string ▾] active     ⋮ ✕ │ │
│ │ qty           $gt      [number ▾] 5          ⋮ ✕ │ │
│ │ ┌─ OR ─────────────────────────────────  ⋮ ✕ ──┐ │ │
│ │ │ tier        $eq      [string ▾] gold     ⋮ ✕ │ │ │
│ │ │ vip         $eq      [boolean▾] true     ⋮ ✕ │ │ │
│ │ └──────────────────────────────────────────────┘ │ │
│ │ ┌─ raw clause ───────────────────────────  ⋮ ✕ ┐ │ │
│ │ │ {"items":{"$elemMatch":{"sku":1}}}           │ │ │
│ │ │                              [Try to parse]  │ │ │
│ │ └──────────────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────┘ │
│ [Reset]  [Copy code]                                 │
└──────────────────────────────────────────────────────┘
```

- **Group header**: logic segmented control + the three add buttons. Nested
  groups render their own header, indented, with a left rule, plus an
  *Include group N* checkbox before the logic control and a *Negate group N*
  button, where *N* is the group's position counted from 1 (`2.1` is the first
  child of the second), so no two groups' controls share a name. A nested
  one-child `$nor` shows as **NOT** in place of the logic control, with a
  *Remove negation N* button; a second child turns it back into
  an ordinary NOR group. The root group's header carries *Undo filter edit*
  and *Redo filter edit* (§5.7), named for what they undo because a write's
  own Undo toast can be on screen at the same time.
- **Include checkbox**: every cond and raw row starts with one
  (*Include condition &lt;field&gt;*, *Include raw clause*). Unchecking sets
  `disabled` (§1): the row stays, dimmed but editable, and leaves `queryRaw`.
  The dimming is visual only, so everything inside a switched-off group —
  each row's checkbox and raw textarea, each nested group's checkbox — is
  also described by a visually hidden note, "Excluded: its group is switched
  off".
- **Cond row**: unchanged from W04 §5 (field / op / valType / value, both
  autocompletes per X02 and X03). The `⋮` menu adds: *Insert condition
  above* / *below* (a blank pending row at that index, with the caret in its
  field box), *Convert to raw clause*, *Wrap in group*, *Negate (NOT)*,
  *Duplicate*, *Remove*.
- **Unmodelled op is no longer a dead end.** Typing `$elemMatch` into the op
  input replaces W04's terminal warning with a one-click **Convert to raw
  clause** button that seeds a raw node from the row. The old message —
  `"<op> needs raw JSON — open the query textarea"` — is retired along with the
  workflow it described.
- **Raw row**: monospace textarea plus **Try to parse**, which runs
  `tryParseRaw` and replaces the node with conds when §2 can model it (so a
  clause pasted from elsewhere can be adopted into the tree).
- **Footer**: `Reset` · `Copy code`. **The pane's Run button is removed** — see
  §7.
- Drag-and-drop targets whichever group or row is under the cursor, not the
  pane as a whole — updated by ADR 0007. A drop on a group inserts
  a fresh `$eq` cond there (`condFromDragged`, retargeted at that group's own
  `insertAt`); a drop on an existing row merges into `$in`/`$nin` or replaces
  the row (`mergeOrReplaceDragged`), per field-name/op rules ADR 0007 §"Decision"
  spells out.

### 6a. Query bar (replaces W05 §1 and §2's sync pill)

- The sync pill, **Re-sync builder**, **Accept builder**, and **Builder
  disabled** are all deleted. There is nothing to sync: the drawer is a view of
  the text.
- Invalid JSON in the bar keeps today's warn underline. The drawer freezes on
  the last successfully parsed tree, renders read-only, and shows
  *"Filter text isn't valid JSON — the tree below is the last valid version."*
  A drawer that mounted over invalid text and seeded from the tab's draft
  (§5.7) can't claim that, so it shows *"Filter text isn't valid JSON —
  showing this filter as you last left it in the drawer. Fix the text in the
  bar to edit it."* instead.
- The advanced grid (projection / sort / skip / limit) stays and becomes the
  **sole** editor for those fields — see §7.

## 7. Single owner, single Run

Today sort, limit, and projection are editable in both the drawer and the bar,
with divergent write semantics (the drawer's writes reset `queryDirty`, the
bar's don't). W13 resolves it by deletion rather than reconciliation:

| Field | Owner after W13 |
| --- | --- |
| filter | query bar textarea ⟷ Filter tree (same value) |
| sort | query bar advanced grid (+ result-column click) |
| limit | query bar advanced grid |
| projection | query bar advanced grid |
| skip | pagination (display-only in the grid, unchanged) |
| Run | **one** button, at the right end of the toolbar |

The drawer stops rendering sort / limit / projection editors. That work is
therefore **subsumed by W13**, not implemented separately — building it would
create a second, contradicting design for the same fields. It loses its
`ready-for-agent` label the moment this spec lands, so no AFK agent can pick up
the superseded design, and is closed as superseded when W13 ships.

One Run, in the always-visible toolbar, resolves the adjacency complaint that
opened this redesign: the drawer's Run sat ~400px below the row being edited
and ran under a *different* enabled rule than the bar's. That mangled-but-valid-EJSON
hazard cannot recur, because the only writer of `queryRaw` other than the user
is a printer that fails closed.

**Amended.** Two gaps survived the first pass. `⌘↵` was bound only to the
filter textarea and the drawer root, so it did nothing from a result row — which is
where focus stays after dragging a field into the drawer — or from the sort,
projection and limit inputs. And Run sat at the toolbar's left end, the width of the
results column away from the drawer. So:

- **Position.** The toolbar reads `Save · History · (spacer) · Run ▾`; Run and its
  options chevron sit at the right end, beside the drawer. Still one Run.
- **One handler.** `⌘↵` is bound once, on the Collection tab root, and replaces the
  textarea and drawer handlers. It acts only in the Documents view (Aggregation
  keeps its own; Structure has no Run), ignores events from inside
  `[role="dialog"]` / `[role="alertdialog"]` (each dialog keeps its own `⌘↵`), and
  commits pending Shell Syntax edits before it gates.
- **One gate.** Button and shortcut share `findProblem(state) === null && !isLoading`.
  The drawer's old `isEjsonDocument`-only rule let a bad sort reach the runner.
- **Blocked feedback.** A refused `⌘↵` shows the same reason the Run tooltip shows,
  in a `role="alert"` line under the Query Bar, cleared by the next edit or run.
  Every refused press remounts the line, so a repeat press is announced again. The
  one exception: when the press itself raises the filter or projection refusal
  notice, that notice is the announcement and the line stays away — two alerts for
  one press would say it twice. Nothing is shown while a run is in flight.

## 8. Persistence & migration

No SQL migration. Tab state is JSON in `workspace_tabs.state_json`; saved
payloads are JSON in the saved-queries table.

**Tab state** (`CollectionTabState`):
- `queryRaw` becomes required, default `'{}'`.
- `filterDraft` (§5.7) is an additive, optional key: no migration, and no IPC
  change, since `tabs:update` passes unknown keys through. A tab persisted
  before it restores exactly as before, seeded from `queryRaw`.
- `queryDirty` is **removed**. Stale keys in persisted state are ignored.
- `BuilderState` shrinks to `{ sort: string; limit: string; projection: string[] }`.
  `conditions` and `logic` leave the live type. Open tabs lose their condition
  rows on first launch after the upgrade — explicitly accepted by the user when
  this redesign was chosen ("resetting open tabs is fine").

**Saved queries are durable user data and are NOT covered by that.**
`SavedFindPayload` is `{ kind: 'find'; builder: BuilderState; queryRaw?: string }`
with `queryRaw` *optional*, and `BuilderPane.handleSavedRunHere` reconstructs
the filter via `saved.payload.queryRaw ?? compileMql(newBuilder).filter`. Drop
`conditions` from `BuilderState` without more, and every saved find that
predates `queryRaw` silently loads as `{}` — the user's filter is gone with no
error. `builder` is also the only carrier of sort/limit/projection in a saved
find (see `SaveModal.tsx`, which submits `payload: { builder: builderState,
queryRaw, ... }` whole) — a naive `@deprecated builder?` stops new saves from
persisting those, a second regression alongside the filter one. Required:

1. `src/pages/Workspace/legacyBuilder.ts` — a **frozen** module holding the old
   `Cond` / `BuilderState` shapes, a copy of `compileMql` renamed
   `legacyCompileFilter`, and `LegacySavedFindPayload` — a distinct
   stored-payload type where `queryRaw` is optional and `builder` may carry
   the legacy `conditions`/`logic` keys. The freeze covers the compile logic;
   `LegacySavedFindPayload` is part of the read boundary the shim needs and is
   exempt from "never extended" for that one purpose. Otherwise: read-only,
   never used for editing.
2. Exactly one call site: hydrating a saved/recent find payload, typed against
   `LegacySavedFindPayload` — `payload.queryRaw ?? legacyCompileFilter(payload.builder)`.
   Typing the call site against the legacy type (rather than the live
   `SavedFindPayload`) is what keeps this expression from looking like dead
   code to TypeScript once `SavedFindPayload.queryRaw` is required, and
   getting deleted.
3. `SavedFindPayload.queryRaw` becomes **required**. `builder` stays
   **required**, shrunk to `{ sort; limit; projection }` — the same shape
   `BuilderState` shrinks to above — only `conditions` and `logic` are retired
   from it, because they're the only parts the tree model replaces. New saves
   write `queryRaw` + the shrunk `builder`. The IPC zod schemas
   (`electron/ipc/schemas/saved.ts`) check a payload per kind on write with
   loose objects and never check one on read, so legacy rows carrying the old
   `conditions`/`logic` keys pass untouched — the type discipline
   above (`SavedFindPayload` vs `LegacySavedFindPayload`) is renderer-side
   only, a distinction the wire never sees. `RecentQueryService` already
   writes `queryRaw` on every record, so recents need nothing beyond the same
   shrink.
4. Legacy hydration maps the old builder to the shrunk shape (sort/limit/
   projection copied over) plus the filter via `legacyCompileFilter`. A test
   loads a legacy payload — `builder.conditions` populated, `queryRaw` absent
   — and asserts the hydrated filter is the compiled conditions (not `{}`)
   *and* that sort/limit/projection survive the hydration.

## 9. What gets deleted, and its blast radius

Run `impact` before each edit — the numbers below are from the pre-work pass
and exist to right-size the change, not to replace the required check.

| Symbol | Fate | Impact (upstream) |
| --- | --- | --- |
| `compileMql` | filter half → frozen `legacyCompileFilter`, one caller (§8) | **CRITICAL** — 10 direct, 11 processes, 3 modules |
| `compileFindOptions` | **new**, stays in `builder.ts` — carries over the sort/projection/limit half of `compileMql` unchanged, including the `.limit(0)`-dumps-the-collection guard | `useQueryRunner.run`, the `currentQueryKey` path, Copy code |
| `parseMqlToBuilder` | deleted | LOW — 1 caller (`QueryBar.parsed`) |
| `currentFilterJson` | kept, **signature changes** `string` → `string \| null`: `null` when `queryRaw` is blank/whitespace or fails `isValidEjson`, else the trimmed text (`'{}'` returned as-is, never nulled) | runner, delete-all, `currentQueryKey` |
| `isDefaultQueryState` | kept — filter check becomes text-only (`queryRaw` blank or `'{}'`); the sort/limit/projection checks stay (dropping them would auto-run a restored saved query with a sort behind the user's back — a known regression class) | `Workspace` auto-run gate |
| `sortFieldPatch` | loses its dirty branch — sort no longer touches the filter | `handleSortField` |
| `reducer` + `Action` | deleted with `BuilderState.conditions` | `BuilderPane` only |
| `describeCondProblem` | **deleted** (revised from the pre-work "kept" plan) — `filterTree.ts`'s `condValueProblem` shipped as a parallel implementation instead of reusing it, leaving `describeCondProblem` with zero production callers by the time it was removed. `condFromDragged` (the drag-and-drop path) never called it either | none (was test-only) |

Retired test ids and controls, so the churn isn't a surprise:
`builder-run-btn` (component tests only), `builder-sort-input` (present in
`WorkspacePage` but referenced by no e2e spec), and the `Re-sync builder` /
`Accept builder` / `synced` / `Builder disabled` roles asserted in
`tests/component/query-builder-defects.spec.tsx`.

## 10. Acceptance criteria

**Parser**
- `{ name: "x" }` (implicit `$eq`) yields one cond — today it disables the builder.
- `{ status: "active", qty: { $gt: 5 } }` yields two conds under root `$and` — today it disables the builder.
- `{ a: { $gte: 1, $lte: 5 } }` yields two conds.
- `{ a: { $regex: "x", $options: "i" } }` yields exactly one **raw** node.
- `{ loc: { $near: {...}, $maxDistance: 10 } }` yields exactly one raw node.
- `$elemMatch`, `$expr`, `$text`, `$where`, `$jsonSchema`, field-level `$not` each yield a raw node; none produces a parse failure.
- Nested `{ $and: [ { $or: [...] }, ... ] }` yields nested groups at arbitrary depth.
- `parseFilter` fails **only** on invalid JSON and on a non-object root.
- `$oid` / `$date` / `$numberLong` / `$numberDecimal` values round-trip through cond rows preserving their exact text.
- Each unrepresentable value shape of §2b (plain nested object, `$binary`, `$timestamp`, `$numberDouble`/`$numberInt`, `$regularExpression`, `$minKey`/`$maxKey`, `$code`, `$dbPointer`, an `$in`/`$nin`/`$all` array with an unrepresentable element) yields a raw node, never a mangled cond.
- `{ $or: [...], a: 1 }` parses to the root `$and` group containing the `$or` group and the cond as siblings.

**Printer**
- The fixpoint of §3b holds across the whole fixture corpus.
- Every corpus entry's printed output equals its recorded expectation. The
  expectations are `(input, expectedOutput)` pairs reviewed by a human at
  authoring time for "matches the same documents" — the *test* asserts only
  that the printer still agrees with the reviewed pair, which is what makes a
  later semantic regression fail loudly.
- A cond with an invalid `number` / `long` / `decimal` / `$mod` value makes `printFilter` return `ok: false` with that node's path.
- A raw node holding unparseable JSON makes `printFilter` return `ok: false`.
- A cond with an empty field is skipped, and does **not** appear in `problems`.
- A single-child `$nor` group keeps its envelope; single-child `$and` / `$or` do not.
- A raw node containing `9007199254740993` makes `printFilter` return `ok: false` with that node's path; a raw node containing `{"$numberLong":"9007199254740993"}` prints fine.

**Editing**
- "+ Condition" adds a row that persists on screen and does not change `queryRaw`.
- "+ Raw" adds a row that persists on screen and does not change `queryRaw`, same as "+ Condition".
- Filling that row's field writes the printed filter to `queryRaw`.
- Typing in the query bar re-seeds the tree and discards pending rows.
- Switching tabs re-seeds each tab from its own state, even when both tabs' text is identical: a tab whose draft still matches its `queryRaw` gets its pending and disabled rows back; a tab with no draft shows only what its text holds.
- Unchecking a row's or nested group's include checkbox removes it from `queryRaw` and keeps it on screen; re-checking restores the previous `queryRaw`.
- A draft that prints to text other than `queryRaw`, or was written for other text, is ignored; a blocked draft seeds with its "N not applied" banner.
- Reset, a Saved or Recent load, and Clear filter drop the draft, and the drawer's rows with it, even when Clear filter writes the text the tree already prints to.
- *Negate (NOT)* and *Negate group* wrap the node in a one-child `$nor`, shown as NOT; *Remove negation* restores the node.
- A NOT re-parses as the same NOT group, a top-level one included.
- *Add to filter* from Tree or Table view requires the new condition of the whole filter: with a root `$or` or `$nor` it is ANDed beside the root group, never added inside it.
- *Insert condition above / below* adds a blank row at that position, focused, without changing `queryRaw`.
- Undo and redo step the tree and `queryRaw` back and forth; typing into one box is one step; an outside text edit clears the history.
- An edit whose print fails leaves `queryRaw` untouched and shows the message on that row.
- Typing `$elemMatch` into an op input offers "Convert to raw clause"; one click produces an editable raw node.
- "Try to parse" converts a modellable raw node back into conds.
- Invalid JSON in the bar leaves the drawer showing the last valid tree, read-only, with the banner.
- A drawer mounted over invalid text with a usable draft shows the draft's tree read-only, with the note that it is the filter as last left in the drawer, not the last valid version; returning the bar to the draft's text restores it with its switched-off and pending rows, and other valid text re-parses.

**Integration**
- No sync pill, "Re-sync builder", "Accept builder", or "Builder disabled" control exists anywhere.
- Exactly one Run button; `⌘↵` runs from inside any drawer input.
- Run is the last control in the toolbar, after History.
- `⌘↵` runs from anywhere in the Documents view — result rows, sort/projection/limit inputs, drawer inputs — and after a drag-and-drop into the drawer with no further click.
- `⌘↵` inside a dialog never runs the find query; in the Aggregation view it runs the pipeline exactly once.
- Run button and `⌘↵` share one gate (`findProblem`); a refused `⌘↵` announces its reason in a `role="alert"` line.
- Sort, limit, and projection are editable in exactly one place.
- `currentFilterJson` returns `null` for blank or invalid-EJSON text, returns `'{}'` for the empty filter, and delete-all refuses to arm on `null`.
- A saved find payload with `builder.conditions` and no `queryRaw` hydrates to its original filter, not `{}`, and its sort/limit/projection survive hydration.
- `filterTree.ts` imports no React, no `CollectionTabState`, and no `api` —
  enforced by an `eslint` `no-restricted-imports` override scoped to that file,
  not by inspection. Purity is the property that makes this module reusable as
  redesign C's `$match` editor; nothing else in the suite would catch it
  rotting.

## 11. Test cases

### Unit — `tests/unit/filter-tree.spec.ts`
- Parse table: one case per §2 row, including every raw-degradation shape and the mixed-top-level-keys row (`{ $or: [...], a: 1 }`).
- Value representability (§2b): one case per unrepresentable shape (plain nested object, `$binary`, `$timestamp`, `$numberDouble`/`$numberInt`, `$regularExpression`, `$minKey`/`$maxKey`, `$code`, `$dbPointer`, an `$in` array with an unrepresentable element) — each yields a raw node. `$oid`/`$date`/`$numberLong`/`$numberDecimal` cases assert the exact value text round-trips into the cond row.
- Split allowlist: `$gte`+`$lte` splits; `$regex`+`$options`, `$near`+`$maxDistance`, and any pair containing a non-allowlisted key do not.
- Print table: normalizations of §3a, one case each.
- Numeric precision (§3a): a raw node containing `9007199254740993` makes `printFilter` fail with that node's path; the same value as `{"$numberLong":"9007199254740993"}` in the same position prints fine.
- Fixpoint: iterate the whole corpus, assert `print(parse(print(parse(s)))) === print(parse(s))`.
- Semantics: hand-checked (input, expected-output) pairs — the corpus that the fixpoint property cannot cover.
- Problems: each blocking case of §3 returns the correct `path`.
- Disabled nodes: a disabled cond, raw node or group prints as pending with no problem; a `$nor` whose only child is disabled is omitted; `parseFilter` never sets `disabled`; `toRawNode` / `tryParseRaw` carry it over.
- `unwrapGroup`: unwraps a one-child nested group; returns `root` for the root, a multi-child group, a cond and a bad path. Negating a top-level cond prints `{"$nor":[…]}` and parses back to the same tree: a NOT group under an `$and` root.
- `andAtRoot`: appends to an `$and` root; wraps a root `$or` / `$nor` in an `$and` beside the new node.
- Edit API: `updateAt` / `insertAt` / `removeAt` / `wrapInGroup` purity and path arithmetic; `removeAt` collapsing an emptied nested group; the root group surviving; `toRawNode`'s fallback is a blank pending raw node, never `{}`; `tryParseRaw` on a clause modeling to more than one cond returns an `$and`-wrapped group, and a single-cond clause returns bare.

### Property — `tests/unit/filterTree.property.spec.ts`, `tests/unit/filterHistory.property.spec.ts`
- Printing a tree with disabled nodes equals printing it with those nodes removed.
- `unwrapGroup(wrapInGroup(t, p, '$nor'), p)` is `t` for any node of any tree.
- `k` undos then `k` redos return the same present; `past` never exceeds the cap.

### Unit — `tests/unit/filterHistory.spec.ts`
- Push, coalescing by key, undo/redo identity on empty, the cap, and undo/redo forgetting the last key.

### Unit — `tests/unit/legacy-builder.spec.ts`
- `legacyCompileFilter` still produces the pre-W13 filter for a populated legacy `BuilderState` (pinned so the shim can't drift).

### Component
- **filter-tree-drawer.spec.tsx**: add / edit / remove / nest, each asserted through `queryRaw`; disable a row and a group; seeding from a matching, stale, differently-printing and blocked draft; Reset clearing the draft; negate and remove negation; insert above / below; undo / redo, coalescing and the history reset on an outside edit.
- **filter-tree-pending.spec.tsx**: the pending-row lifecycle of §5, including a bar edit landing underneath a pending row, and switching tabs re-seeding each tab from its own state even when both tabs' text is identical (the drawer remounts on `key={tabId}`; tab A's pending row comes back from its draft).
- **filter-tree-raw.spec.tsx**: convert-to-raw, edit raw, try-to-parse.
- **filter-tree-print-failure.spec.tsx**: a bad value leaves `queryRaw` untouched and surfaces the row message.
- **saved-legacy-payload.spec.tsx**: the §8 shim — legacy payload hydrates to its original filter.

### E2E
- **workspace-filter-tree.e2e.ts**: open a seeded collection → build `(a AND (b OR c))` in the drawer → Run → results → hand-edit the bar to an `$elemMatch` → the drawer shows a raw clause rather than disabling → Run still works. A second test switches a condition off and runs without it, keeps it across a switch to another tab and back, then negates it and runs NOT.

## 12. Spec migration

W13 is authoritative for the filter model. To be landed **with this spec**, not
with the code, so `spec-compliance-reviewer` is never pointed at two
contradicting sources of truth:

- `specs/README.md` — add the W13 row to the Workspace table.
- `W04` §1–§4, §7 (incl. the fail-closed guard), §8 — superseded note pointing here. §2a
  (shape buckets), §5's condition-row layout, and the `FIELD_OPS` table stay
  authoritative; W13 reuses them verbatim. §2b (`describeCondProblem`) does
  **not** — a parallel `condValueProblem` shipped inside `filterTree.ts`
  instead of reusing it, and `describeCondProblem` was deleted outright once
  that made it dead code (zero production callers). `filterTree.ts`'s
  `condValueProblem` is the live implementation of §2b's validation from W13
  onward.
- `W05` §1 (the whole sync state machine) and the sync-pill bullets of §2 —
  superseded note pointing here. §3–§6 (run flow, keyboard, cancellation,
  errors) are unaffected.
