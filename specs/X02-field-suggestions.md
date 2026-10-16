# X02 — Field & value suggestions

> **Status: Implemented.** Further value sources are tracked as issues.

## Purpose

Provide a single composable autocomplete system that surfaces field paths
(and eventually values) in every place the user types a key or filter —
the builder condition rows, the raw query textarea, and the aggregation
stage bodies. One popover, one ranking, one set of sources; each surface
just supplies a `SuggestionContext` and a trigger.

## Scope

- **In**: `Suggestion` types, `FieldSource` / `ValueSource` source contract,
  `useSuggestions` hook, `SuggestionPopover` component,
  `useTextareaAutocomplete` hook for textarea consumers, caret-position
  helper, grammar detector for JSON-like bodies, first two field sources
  (`lastRunSource`, `sampleSchemaSource`), `meta:sampleSchema` IPC.
- **Out** (deferred, see roadmap in `docs/field-suggestions-roadmap.md`):
  value sources, index-aware source, schema-validator enum source,
  AI-generated suggestions.
- **Extended by X03**: MQL operator autocomplete adds an
  `OperatorSuggestion` kind, `operatorSource`, and context-aware
  ranking. The infrastructure below stays identical; X03 plugs in as
  another key-position source.

## Dependencies

- F04 (IPC bridge) for `meta:sampleSchema`.
- F05 (Mongo client pool) for the sample-schema query.
- W04 (builder), W05 (query bar), A03 (stage accordion) — consumer surfaces.

## 1. Types

```ts
// src/features/fieldSuggestions/types.ts

export interface SuggestionContext {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Docs the caller already has on hand (e.g., the current tab's lastRun). */
  recentDocs?: unknown[];
  /** When set, sources emit value suggestions for this field. */
  target?: { field: string; operator?: string };
}

export interface FieldSuggestion {
  kind: 'field';
  path: string;
  type?: DisplayType;
  source: string;
  frequency?: number;
}

export interface ValueSuggestion {
  kind: 'value';
  value: unknown;
  display: string;
  type?: DisplayType;
  source: string;
  frequency?: number;
}

export type Suggestion = FieldSuggestion | ValueSuggestion | OperatorSuggestion;

/** Key-position source — emits fields or operators at a bare-key site. */
export type FieldSource = (ctx: SuggestionContext) =>
  | Array<FieldSuggestion | OperatorSuggestion>
  | Promise<Array<FieldSuggestion | OperatorSuggestion>>;

export type ValueSource = (
  ctx: SuggestionContext & { target: { field: string; operator?: string } },
) => ValueSuggestion[] | Promise<ValueSuggestion[]>;
```

`OperatorSuggestion` and the `operatorContext` field on
`SuggestionContext` are defined in X03; they live alongside field
suggestions in the same module.

The discriminated union is intentional — the same popover renders all
three kinds, and `useSuggestions` routes on `ctx.target`:
- `target` absent → run field sources (fields + operators)
- `target` present → run value sources

## 2. Sources

A source is a pure function from context to `Suggestion[]`. Sync sources
resolve immediately; async sources resolve via `Promise` without
blocking render. `useSuggestions` composes a fixed list per surface.

### Default field sources (in ranking order)

| Source | Kind | Cost | Notes |
|---|---|---|---|
| `lastRunSource` | sync | free | Walks `ctx.recentDocs` for top-level + dotted paths with inferred `DisplayType` and frequency. |
| `sampleSchemaSource` | async | 1 IPC | Runs `meta:sampleSchema` (`$facet { recent, random }` in one round trip). Caches per `(connId, db, coll)` with 5-min TTL. Fails open. |
| `operatorSource` *(X03)* | sync | free | Emits every catalog entry from `OPERATORS`. Not part of `DEFAULT_FIELD_SOURCES`; surfaces opt in explicitly (textarea hook uses `[...DEFAULT_FIELD_SOURCES, operatorSource]`, builder op input uses `[operatorSource]`). |

### Default value sources

Empty until a consumer lands a `ValueSource`. When populated, consumers
already routed on `ctx.target` will light up automatically.

### Future drop-ins

Each listed in `docs/field-suggestions-roadmap.md` → "New sources". A
new source is one file in `src/features/fieldSuggestions/sources/` plus
one line in `DEFAULT_FIELD_SOURCES` or `DEFAULT_VALUE_SOURCES`.

## 3. IPC contract

### `meta:sampleSchema`

```ts
// Input
{
  connectionId: string;
  dbName: string;
  collection: string;
  size?: number;   // integer 1..200, default 50
}

// Output
{
  docs: unknown[];   // sampled documents, canonical EJSON
}
```

- Main runs `db.coll.aggregate([{ $facet: { recent: [{$sort:{_id:-1}},{$limit: size}], random: [{$sample:{size}}] } }])`
  under a fixed 3 s server-side budget (`STATS_TIMEOUT_MS`; the caller
  cannot set it) and returns both branches concatenated, so a document
  both branches pick appears twice.
- Main does not derive paths. The renderer's `sampleSchemaSource` walks
  `docs` once with `lastRunSource` (one row per dotted path with
  `DisplayType` + frequency) and digests the same sample with
  `summarizeSchema`.
- A failed aggregate (unauthorized, read-only role that can't run
  `$sample`, timeout) fails open — the channel returns `{ docs: [] }`. The
  renderer doesn't surface the error; the user just sees fewer
  suggestions. An absent collection is not an error either: it samples to
  `{ docs: [] }`.
- Not fail-open: a payload that breaks the schema (`size` outside 1..200, an
  empty id) is `VALIDATION`, and an unknown `connectionId` is `NOT_FOUND`,
  because the client lookup happens before the aggregate's `try`.
  `tests/integration/meta-handlers.spec.ts` pins all of this through the
  router.

## 4. Composition — `useSuggestions`

```ts
useSuggestions(
  context: SuggestionContext | null,
  token: string,
  opts?: { fieldSources?; valueSources?; limit? },
): { items: Suggestion[]; loading: boolean }
```

Behavior:

1. **Source capture**: `opts.fieldSources` / `opts.valueSources` are captured
   on mount via `useState(() => ...)` so callers can pass fresh arrays every
   render without re-triggering work. Consequence: swapping sources at
   runtime is not supported. This is deliberate — sources are configuration.
2. **Sync pass** (`useMemo`): runs non-Promise sources against the current
   context. `contextKey` (a concat of `connId|db|coll|target.field|target.operator`)
   and `recentDocs` are the memo deps.
3. **Async pass** (`useEffect` with a race-guard `reqId` ref): kicks off any
   Promise-returning sources inside an async IIFE. Late resolutions that
   predate a context change are discarded via `if (myReq !== reqId.current) return`.
   The sources settle together (`Promise.allSettled`): a source that rejects
   loses only its own batch, the sync items and the healthy sources still
   show, and `loading` always returns to `false` — but only the latest request
   may clear it, so a stale rejection never hides a newer request's spinner.
4. **Dedupe & rank** (`useMemo`): merges by a type-prefixed key (`F:path`,
   `O:name`, or `V:value`), preferring richer records (summed frequency,
   fills in `type`). Ranks each entry by `scoreMatch(token, candidate)`:
   exact → prefix → substring (closer wins) → rejected; also scores
   against `candidate.slice(1)` when the token lacks a leading `$` but
   the candidate has one (so `eq` matches `$eq`). Adds
   `min(frequency, 50) / 50` as a tie-breaker for fields/values, and a
   `-30` penalty for operators flagged `offContext` (X03). Returns top
   `limit` (default 50).

## 5. Popover — `SuggestionPopover`

```ts
<SuggestionPopover
  open
  items
  anchorRef       // positions the listbox below this element's rect
  keyboardRef?    // binds arrow/Enter/Tab/Escape handlers here (defaults to anchorRef)
  onSelect
  onClose
/>
```

- Fixed-position listbox under the anchor's bounding rect.
- Position updates on window resize + scroll (capture).
- Keyboard: ↑/↓ to navigate (wraps), Enter or Tab to accept,
  Escape to close.
- `onMouseDown={(e) => e.preventDefault()}` on the listbox so clicking
  an item doesn't blur the underlying input.
- Highlight state is clamped at render time (no set-state-in-effect).
- **`keyboardRef` is required when the anchor is a zero-size caret marker**
  (textarea consumers) — otherwise the keys never fire because the span
  can't receive focus. See §7.

## 6. Input consumer — builder condition row (W04)

Uses the popover directly. Pattern:

```ts
const inputRef = useRef<HTMLInputElement>(null);
const [open, setOpen] = useState(false);
const { items } = useSuggestions(open ? context : null, cond.field);
// ...
<input ref={inputRef} onFocus={() => setOpen(true)} onBlur={deferredClose} ... />
<SuggestionPopover open={open} anchorRef={inputRef} items={items} ... />
```

- Anchor is the input itself (same element receives keyboard focus).
- `onBlur` defers closing by ~100ms so a click on the popover can
  register before the input loses focus.
- On select: splice `s.path` into the condition field via `dispatch`.

## 7. Textarea consumer — `useTextareaAutocomplete`

Shared glue for any textarea that edits a JSON-shaped body. Used by
W05 (query bar) and A03 (stage accordion).

```ts
const textareaRef = useRef<HTMLTextAreaElement>(null);
const autocomplete = useTextareaAutocomplete({
  textareaRef,
  suggestionContext,
  stageOp,              // X03: enclosing stage op for context-aware op ranking
  onReplace: (next) => /* setLocalBody / onPatch */,
});

<textarea
  ref={textareaRef}
  onChange={e => { handleExisting(e); autocomplete.probe(); }}
  onKeyUp={autocomplete.probe}
  onClick={autocomplete.probe}
  onFocus={autocomplete.probe}
  onBlur={autocomplete.onBlur}
/>
{autocomplete.popover}
```

What the hook does internally:

1. **Caret rect** via `getCaretRect(textarea, offset)` — mirror-div technique:
   clone the textarea's text-layout styles onto a hidden `<div>`, drop the
   text up to the caret into it, insert a zero-width marker `<span>`, and
   read its rect. Works in every browser that renders a textarea.
2. **Grammar detection** via `detectAggGrammar(value, caret)` — see §8.
3. **Anchor** — a `position: fixed` zero-size `<span>` rendered at the caret
   rect. `SuggestionPopover` measures this for positioning.
4. **Keyboard** — `keyboardRef={textareaRef}` so arrows/Enter/Tab/Escape
   bind to the textarea while the anchor is elsewhere.
5. **Accept** — splices `s.path` into the body across `[replaceStart, replaceEnd]`,
   calls `onReplace(nextValue)`, then `requestAnimationFrame`s to focus +
   `setSelectionRange` so the caret lands right after the inserted path.
6. **Dismiss** — `onBlur` schedules `setGrammar(null)` after 120ms so a
   click on the popover can land first.

## 8. Grammar detector

```ts
detectAggGrammar(value: string, caret: number, stageOp?: string): GrammarHit | null
```

Streams `value` from 0 to `caret`, tracking a scope stack of
`{ type: 'obj' | 'arr', mode: 'key' | 'afterKey' | 'value', lastKey }` with
string-escape handling. At `caret`, classifies the position:

| Position | Returns |
|---|---|
| Inside a quoted **object key** | `{ kind: 'fieldName', token, replaceStart, replaceEnd, operatorContext? }` |
| Bare identifier in object key mode (including `$`-prefixed) | `{ kind: 'fieldName', token, ..., operatorContext? }` |
| Inside a value string starting with `$` | `{ kind: 'fieldRef', token, ... }` — `$` excluded from replace range |
| Inside a value string with a known sibling key | `{ kind: 'valueFor', field, token, ... }` |
| Anywhere else | `null` |

`stageOp` is optional. When provided, fieldName hits carry an
`operatorContext` resolved from `stageOp` + object-nesting depth. See
X03 §5 for the resolution table. `$`-prefixed bare keys return a
fieldName hit so the operator source can consume them.

Deliberately best-effort. When the parser bails or the shape is unclear,
returns `null` — the popover just doesn't open. No wrong suggestions.

Works identically for aggregation stage bodies and MQL filter objects;
the shape is the same (nested objects, arrays, strings, numbers).

The hook consumes only `fieldName` and `fieldRef` today; `valueFor` is
detected but its context is suppressed (routed to `null`) until
`DEFAULT_VALUE_SOURCES` lands a source. No consumer change is needed
when that happens.

## 9. Behavior — lifecycle

1. User focuses / clicks / types in a consumer input or textarea.
2. Consumer builds a `SuggestionContext` (always includes
   `connectionId + dbName + collection`; attaches `recentDocs` from the
   current tab's `lastRun.documents` or `lastRun.rows` when available).
3. `useSuggestions` runs sync sources, schedules async sources, returns
   a ranked list.
4. Popover opens below the input or at the caret rect.
5. User navigates with arrows, accepts with Enter/Tab (or mouse click).
6. On accept, consumer splices the path into its value and moves the
   caret past it.
7. On Escape or blur, popover closes.

### Caching

- `sampleSchemaSource` caches per `(connId, db, coll)` with a 5-min TTL,
  so multiple tabs for the same collection trigger one fetch total.
- `invalidateSampleSchemaCache(connId, db, coll)` drops that collection's
  entry (`(connId)` drops the connection's, no argument drops all). It
  also forgets an in-flight fetch and stops it from re-caching: a
  generation counter, bumped by every invalidation, keeps a sample that
  was requested before a write and resolves after it from landing in the
  cache. The generation is global, so an invalidation anywhere makes
  every fetch in flight skip its cache write (its caller still gets the
  answer); that errs toward a refetch, never toward a stale entry.
- Every write the renderer completes, except those listed after this,
  calls it, so fresh fields and the Update drawer's type warning
  reflect the write immediately. Each site names the collection from the
  data it owns, never from the Focused Tab at completion, which can have
  moved on while a request was in flight:
  - `useDocumentDialogs` — insert, partial insert, document save, and the
    Undo of those that offer one (including delete and update-many).
    `refreshSource` invalidates from the drawer's captured target
    before its tab-gone early return, because the write landed even
    when the tab did not survive the drawer.
  - `DeleteConfirm` (one, selected, many) and `UpdateConfirm`
    (update-many) invalidate from their own props as soon as the request
    resolves, not through `useDocumentDialogs`; the hook's completion
    callbacks leave the cache alone.
  - `Workspace.tsx` `updateField` (Quick Edit), which writes straight
    through `api.doc.updateOne`, and its Undo.
  - `ImportDialog`, once the import resolves and again on Undo.
  - `SaveAsCollectionModal`, for the target `(connId, db, coll)`; and
    `AggregationTab`'s confirmed `$out` / `$merge` run, for the whole
    connection (main parses the target out of the stage body, so the
    renderer cannot name it).
  - `AuditLogModal` Revert, for the entry's own connection (the entry can
    be a rename, drop or import with no single collection).
  - `ScriptTab`, for the tab's connection after every run: a script can
    write to any collection and the renderer cannot tell which.
  - The connection dialogs (`ConnectionManager`, `useConnectionDialogs`)
    for connection changes.
- Writes that can fail part-way invalidate on failure too, since an
  earlier part may already have landed and an extra resample costs
  nothing: a rejected delete-many, update-many, `$merge` or Revert, a
  script that threw, and an import whose error carries
  `details.insertedCount > 0` (a refusal before any batch carries none and
  leaves the sample alone).
- Not wired, on purpose: the Mongo shell (a fire-and-forget stream with
  no completion point to hook), and collection create / drop / rename and
  database drop. The 5-minute TTL bounds these; a collection dropped and
  re-created inside it can show the old fields until the TTL lapses.

### Race safety

- `useSuggestions` uses a `reqId` ref; async resolutions that predate a
  context change are dropped.
- The popover's keyboard-handler effect re-binds when `items`,
  `highlight`, or `onSelect` change — each render may re-bind, but the
  listener set is always consistent.

## 10. UI

- Listbox max-height 240px, scroll-on-overflow.
- Each row: `<path>` left-aligned (monospace), `<type>` right-aligned badge.
- Hover and keyboard-highlight use `accentSoft` background.
- No `aria-activedescendant` yet — see the a11y follow-up in the roadmap.

## 11. Persistence

None. Suggestions are derived on demand; cache lives in memory (cleared
on app restart).

## 12. Error handling

- `meta:sampleSchema` aggregate failures → `{ docs: [] }`, silent. Validation
  failures and an unknown connection still reach the renderer as typed errors (§3).
- `getCaretRect` is deterministic given a textarea + valid offset; no
  catch. A thrown error would be a real bug, not a UX hiccup to hide.
- Grammar detector never throws — returns `null` on ambiguity.

## 13. Acceptance criteria

- Field-name popover opens in the builder condition row on focus
  and narrows by prefix → substring as the user types.
- Field-name popover opens at the caret inside aggregation stage
  body textareas (match, group, project, …). Dotted paths in the
  sample appear for nested-object consumers.
- Field-ref popover opens inside `"$…"` strings on the value side
  of a pair or inside an array.
- Same UX in the raw-MQL query bar — `{ sta|`, `{ user.na|`,
  `{ $or: [{ na| }] }`, etc.
- Keyboard navigation: ↑ ↓ wraps, Enter and Tab accept, Escape
  closes. Mouse click also accepts (textarea keeps focus).
- Async `sampleSchemaSource` populates without blocking the sync
  `lastRunSource` render.
- Stale async results from a previous collection are dropped
  (race-guarded).
- A rejecting async source never leaves `loading` stuck and never drops the
  other sources' items.
- `valueFor` hits are detected but do not open the popover until
  value sources land.
- `$`-prefixed bare keys open the popover (previously suppressed);
  the operator source (X03) consumes these hits. `fieldRef` and
  `valueFor` branches remain unchanged.
- Cache invalidation on writes (§9 "Caching" lists every wired path and the ones left to the TTL).
- *(Follow-up)* First `ValueSource` + consumer wiring (builder
  value input).
- *(Follow-up)* Accessibility pass (`aria-activedescendant`,
  `role="combobox"` wrapper, loading-state hints).

## 14. Test cases

### Unit

- **field-suggestions-source.spec.ts** — `lastRunSource`: extracts top-level
  fields with inferred `DisplayType`; aggregates frequencies across
  multiple docs; handles dotted paths and arrays.
- **field-suggestions-agg-grammar.spec.ts** — 25 fixtures covering:
  bare & quoted keys, dotted paths, `$`-prefixed field refs, nested
  `$or` arrays, operator-object keys (→ `null`), value-side strings
  (→ `valueFor`), escaped quotes, and replace-range correctness.

### Component

- **field-suggestions-hook.spec.tsx** — drives `useSuggestions` with a
  stub source; asserts sync + async merge, dedupe, ranking, race-guard.

### Manual / E2E

- Builder condition row: focus the field input → see suggestions from
  the current lastRun → accept with Enter.
- Aggregation stage body: type `{ sta` in a `$match` body → popover
  appears near the caret → accept.
- Query bar: type `{ user.na` → dotted-path suggestions appear.
- Stage body `"$sta` → field-ref suggestions with the `$` preserved.

## 15. Roadmap reference

The living plan (remaining phases, new sources, quality improvements,
non-goals) lives in `docs/field-suggestions-roadmap.md`. That file is
the working backlog; this spec is the contract.

The MQL operator autocomplete extension is specified in
[X03](./X03-mql-operators.md), which is now the sole contract for it —
its design plan was fully implemented and deleted.
