# Field & value suggestions — roadmap

Living plan for the autocomplete system in `src/features/fieldSuggestions/`.
The contract for this feature lives in `specs/X02-field-suggestions.md`; this
file is the working backlog. Phases 1–3 shipped; value suggestions and the
quality-improvement list are queued. Each phase is intended to land as one
focused commit unless noted.

## Current state (Phases 1–3, shipped)

- `Suggestion` discriminated union (`'field' | 'value'`) and `SuggestionContext`
  with optional `target` for future value routing.
- Two field sources: `lastRunSource` (free, in-renderer) and
  `sampleSchemaSource` (async, one IPC per collection + 5 min cache).
- IPC `meta:sampleSchema` runs `$facet { recent, random }` in one round
  trip with `maxTimeMS: 3000` and fails open.
- Shared `useSuggestions` hook with race guards, dedupe, prefix-then-substring
  ranking. Sources captured once per mount.
- `SuggestionPopover`: fixed-position listbox, keyboard nav (↑/↓/Enter/Tab/Esc);
  accepts an optional `keyboardRef` so a zero-size caret marker can anchor
  while a textarea keeps focus.
- `getCaretRect(textarea, offset)` (mirror-div) and
  `detectAggGrammar(value, caret)` (streaming scope-stack parser) —
  positioning + grammar for textarea consumers.
- `useTextareaAutocomplete` hook — glue that turns the primitives above into
  a drop-in ~5-line integration for any textarea.
- Integrated into: the builder condition row's field input (Phase 1), every
  aggregation stage body textarea (Phase 2), and the raw MQL query bar
  (Phase 3).

## Phase 2 — Aggregation stage bodies *(shipped)*

Surface: the `$match` / `$group` / `$project` body textareas in
`AggregationTab` (via `StageRow`).

**What we have to build**

1. A caret-in-textarea position helper (~40 LOC). Two viable techniques:
   - Mirror-div: render an invisible `<div>` with the textarea's styles and
     the text up to the caret, measure the last char's rect. Works
     everywhere; browser-tested approach.
   - `getClientRects` on a `Range` over a mirrored span. Fewer LOC but
     flakier with line-wrapped long text.
   Pick the mirror-div variant; small enough to inline in the popover.

2. A lightweight grammar detector (~60 LOC). Given the textarea's value and
   caret offset, return one of:
   - `{ kind: 'fieldName', token: string }` — cursor is on an object key
     (left of a `:` inside `{...}`, not inside a string value).
   - `{ kind: 'fieldRef', token: string }` — cursor is inside a string that
     starts with `"$` (a field reference like `"$status"`).
   - `{ kind: 'valueFor', field: string, token: string }` — cursor is on the
     value side of a `key:` pair where `key` is a known field.
   - `null` — no suggestion context here; hide the popover.
   Deliberately best-effort. When the parser bails, the popover just doesn't
   open — no wrong suggestions.

3. Integration per stage row: reuse `SuggestionPopover` with a positioned
   anchor (a zero-size `<span>` positioned at the caret rect). Same hook,
   same keyboard UX. On accept, splice the selected value into the textarea
   and move the caret past it.

**Estimated size:** ~150 LOC new + ~25 LOC changed in `StageRow`.
**Tests:** unit tests for the grammar detector (lots of fixture strings),
one component test that types into a textarea and asserts a suggestion fires.

## Phase 3 — queryRaw / script editor *(shipped)*

Surface: the raw query editor (`QueryBar` textarea) and any future script
editor.

**What we have to build**

- Same caret helper + same integration pattern as Phase 2.
- A narrower grammar detector: `queryRaw` is always an MQL filter object,
  so keys are always fields. Value-side detection is easier than in the
  agg case because the shape is constrained.

**Estimated size:** ~80 LOC once Phase 2's caret helper exists; the grammar
detector can reuse most of Phase 2's object-key/value logic.
**Tests:** grammar fixtures, one component test.

## Value suggestions

Types and the hook already route on `ctx.target` (`useSuggestions.ts:95`,
`sources/index.ts:23`). `DEFAULT_VALUE_SOURCES` is an empty array waiting
for its first consumer. What's missing is two sources and the consumer
wiring on the builder's value input.

This phase commits to two sources only — the deferred Mongo-sampling path
("low-cardinality probe") is tracked separately.

### Scope (committed)

Two sources, one consumer, one new SQLite table, one new IPC round-trip.

| Source | Kind | Cost | Notes |
|---|---|---|---|
| `lastRunValuesSource` | sync | free | Walks `ctx.recentDocs` at `ctx.target.field`, aggregates distinct values with frequency. Mirrors `lastRunSource` for fields. |
| `recentValuesSource` | async | one IPC, cached | Reads past values the user typed for this `(conn, db, coll, field)` from a new SQLite table. One round trip per focus, memoized per-tab for the lifetime of the popover. |

Consumer: the **value** input in `BuilderPane.tsx` (`CondRow`, the input
rendered at line 223 when `cond.op !== '$exists'`). Same pattern as the
field + operator inputs that already exist a few lines above.

### Source 1 — `lastRunValuesSource`

File: `src/features/fieldSuggestions/sources/lastRunValuesSource.ts` (new).

Sync. Signature: `ValueSource`. Behavior:

1. Bail if `ctx.recentDocs` is empty.
2. For each doc (cap at `MAX_DOCS = 50`, same as `lastRunSource`), resolve
   `ctx.target.field` as a dotted path. Support top-level keys and
   one-level-deep dotted access (`address.city`). No array-index paths
   (`tags.0`) in MVP; arrays are handled per next bullet.
3. If the resolved value is an **array**, iterate its primitive elements
   and record each. Skip nested arrays. This makes value autocomplete
   useful for `tags: ['a', 'b']`-style fields.
4. If the resolved value is a primitive, ObjectId, Date, or Decimal128,
   record the display form via `toDisplayValue(v).display`. Skip objects
   and nested arrays — no good UX for splicing a `{...}` into the
   builder's string-valued input.
5. Aggregate into a `Map<string, { value: unknown; type: DisplayType; count: number }>`
   keyed by the display string (which is what dedupes with `recentValuesSource`
   via `useSuggestions`' `V:${String(s.value)}` key — see note in §Value
   serialization below).
6. Return `ValueSuggestion[]` with `source: 'lastRun'` and `frequency: count`.

**Hard rule:** the `value` we put on the suggestion is the **display
string** — not the raw ObjectId/Date object. Reason: the builder's
`cond.value` is a string; the value we splice on select must also be a
string. Keeping `value` and `display` equal keeps dedupe trivially
correct across both sources.

~60 LOC. Unit tests: top-level, dotted, array elements, frequency
aggregation, ObjectId → hex, Date → ISO.

### Source 2 — `recentValuesSource` + persistence

#### SQLite schema (migration `005-recent-field-values.sql`)

```sql
CREATE TABLE recent_field_values (
  id TEXT PRIMARY KEY,                 -- UUID
  connection_id TEXT NOT NULL,
  db_name TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,                 -- dotted path, same shape as Cond.field
  value TEXT NOT NULL,                 -- display-string form (what the user typed)
  val_type TEXT NOT NULL,              -- mirrors Cond.valType: 'string'|'number'|...
  last_used_at TEXT NOT NULL,          -- ISO-8601
  use_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX recent_field_values_uniq
  ON recent_field_values(connection_id, db_name, collection, field, value);

CREATE INDEX recent_field_values_lookup
  ON recent_field_values(connection_id, db_name, collection, field, last_used_at DESC);
```

**Note on persistence choice:** `RecentQueryService.recordFind` currently
persists an empty `BuilderState` (`RecentQueryService.ts:29-35` — only
`queryRaw` is populated). Mining past values out of `recent_queries.payload_json`
would return nothing for builder-driven queries. A dedicated table also
gives us O(log n) reads with a compound index rather than parsing N
JSON blobs on every popover focus.

Cap at 50 values per `(conn, db, coll, field)` by deleting oldest
`last_used_at` when inserting a 51st. Eviction happens inside
`RecentFieldValueService.record` after the upsert.

#### Repo

`electron/db/repositories/RecentFieldValueRepo.ts` (new). Methods:

- `upsert(row)` — `INSERT … ON CONFLICT(...) DO UPDATE SET last_used_at=excluded.last_used_at, use_count=use_count+1`. Pure SQL; `better-sqlite3` is sync.
- `list({ connectionId, dbName, collection, field, limit=20 })` — returns rows ordered by `last_used_at DESC`.
- `evictOldest({ connectionId, dbName, collection, field, keep })` — trims to `keep` rows.
- `deleteByConnection(connectionId)` — mirrors existing repos for cascade parity (FK handles it, but some Delete-User flows call this explicitly).

#### Service

`electron/services/RecentFieldValueService.ts` (new). Methods:

- `recordMany(connectionId, dbName, collection, entries: Array<{ field, value, valType }>)` — upserts each, then calls `evictOldest` when any field exceeds 50 rows. Called from the IPC handler, not from `RecentQueryService` (keeps the two concerns decoupled; mirrors how other services are injected).
- `listForField(connectionId, dbName, collection, field, limit?)` — thin pass-through.

Inject in `electron/main.ts` alongside the other services and pass to the router.

#### IPC (two channels)

`shared/ipc.ts`:

```ts
// Value suggestions — read
'meta:recentValuesForField': {
  input: { connectionId: string; dbName: string; collection: string; field: string; limit?: number };
  output: { values: Array<{ value: string; valType: ValType; frequency: number; lastUsedAt: string }> };
};

// Value suggestions — write (on query-run success)
'recent:recordFieldValues': {
  input: { connectionId: string; dbName: string; collection: string; entries: Array<{ field: string; value: string; valType: ValType }> };
  output: { recorded: number };
};
```

Both fail open. `meta:recentValuesForField` returns `{ values: [] }` on
error (same pattern as `meta:sampleSchema`, see `X02 §12`). No retry.
No toast.

Handlers: `electron/ipc/handlers/meta.ts` (extend) and
`electron/ipc/handlers/recent.ts` (extend). Zod-validate inputs.
Reuse existing `RecentChannelsRouter` injection pattern.

#### Write path — when to record

The renderer dispatches `recent:recordFieldValues` in `Workspace.tsx`
right after a successful `api.query.find(...)` call completes. It walks
`state.builder.conditions` and emits `{ field, value, valType }` for
every condition with non-empty field AND non-empty value AND
`op !== '$exists'` (exists carries no value worth remembering).

We do **not** mine values from raw-MQL runs in MVP. That's tracked as a
separate follow-up. The builder covers the common case and the parser
complexity isn't justified for v1.

Fire-and-forget from the renderer (`.catch(() => {})`). A write failure
shouldn't surface.

#### Frontend source

`src/features/fieldSuggestions/sources/recentValuesSource.ts` (new).

Async `ValueSource`. On call:
1. Invoke `api.meta.recentValuesForField(ctx.connectionId, ctx.dbName, ctx.collection, ctx.target.field)`.
2. Map rows to `ValueSuggestion` with `source: 'recent'`, `frequency: use_count`, `type: displayTypeFromValType(valType)`.
3. Return `[]` on error (matches `sampleSchemaSource` fail-open style).

In-memory cache per `(conn, db, coll, field)` with a ~5-minute TTL, same
as `sampleSchemaSource`. The cache is cleared on successful record via
a module-level `invalidateRecentValuesCache(conn, db, coll, field)`
call from the write path.

### Consumer wiring — builder value input

In `BuilderPane.tsx` `CondRow`:

- Add `valueInputRef`, `valuePopoverOpen` state (mirror the field/op
  pattern already present).
- Build a value-mode context:
  ```ts
  const valueSuggestionCtx = suggestionContext && cond.field && cond.op
    ? { ...suggestionContext, target: { field: cond.field, operator: cond.op } }
    : null;
  const { items: valueItems } = useSuggestions(
    valuePopoverOpen ? valueSuggestionCtx : null,
    cond.value,
  );
  ```
- Gate the popover on `cond.field !== ''` and `cond.op !== '' && cond.op !== '$exists'`.
- On select: `dispatch({ t: 'patchCond', id: cond.id, patch: { value: s.display } })`,
  close the popover, blur.

`useSuggestions` will auto-use `DEFAULT_VALUE_SOURCES` once we wire
both sources into that array.

### Operator filtering

Skip the popover entirely (at the consumer level, not inside the sources)
when `cond.op` is:

- `$exists` — boolean, not a value from the collection. (Also the value
  input is hidden already at line 222.)
- `$regex`, `$type`, `$size` — RHS is not a sampled value.

Anything else: open. `$in`/`$nin`/`$all` technically take arrays, but
users typically type one element at a time then hand-edit to an array;
offering single-value suggestions is still useful.

A tiny allow-list in `BuilderPane.tsx`:

```ts
const VALUE_SUGGESTIONS_DISABLED = new Set(['$exists', '$regex', '$type', '$size']);
```

### Value serialization

The builder's `cond.value` is a plain string. The split between
`cond.valType` (`string | number | objectId | date | bool | null`) and
`cond.value` happens at compile time in the MQL compiler. So:

- Suggestions carry `value: string` = `display: string`. We store and
  splice the same form the user would have typed.
- `toDisplayValue` already produces canonical forms for ObjectId (hex),
  Date (ISO), Decimal128 (decimal string), Binary (base64) — which is
  exactly what the builder parses for those `valType`s.
- When we record values from the builder, we send `{ value: cond.value, valType: cond.valType }`; no coercion.

### Tests

- **Unit — `lastRunValuesSource.spec.ts`**: top-level primitives, dotted
  paths, array element expansion, ObjectId/Date display forms, frequency
  aggregation, empty `recentDocs` bail.
- **Unit — `recentValuesSource.spec.ts`**: IPC mocked; happy path maps
  rows; fail-open on `{ ok: false }`; cache hit avoids second IPC.
- **Integration — `recentFieldValueRepo.spec.ts`**: upsert bumps
  `use_count` and `last_used_at`, unique key enforced, eviction trims
  to 50.
- **Integration — `recentFieldValueService.spec.ts`**: `recordMany`
  skips empty fields/values, `listForField` orders by `last_used_at`.
- **Component — `BuilderPane.valuesuggest.spec.tsx`**: `CondRow` with
  pre-seeded `recentDocs`, focus value input → popover opens; type
  partial value → filtering works; Enter splices `s.display`;
  `$exists` suppresses the popover.
- **Atelier mock**: add `meta.recentValuesForField` and
  `recent.recordFieldValues` default stubs in `tests/helpers/atelierMock.ts`
  (per gotcha §4 above — forgetting this crashes other component tests).

### Estimated size

~350 LOC new + ~30 LOC in `BuilderPane.tsx`. One migration. Two IPC
channels. One new repo + service pair.

### Open decisions to resolve before implementation

1. **Eviction cap per field.** 50 sounds right — deep enough for common
   values, shallow enough to keep SQLite small on a heavy user. Worth
   a quick gut-check.
2. **Operator filtering — is the disable list right?** `$regex`/`$type`/`$size`/`$exists`
   feel obvious; `$in`/`$nin`/`$all` are the gray area. Default: allow
   them. User can override.
3. **Cross-connection scoping.** Current design scopes values to
   `(connection_id, db, collection, field)`. That means switching between
   a dev and prod Atlas cluster gives separate history. Right call for
   isolation; worth naming explicitly.
4. **Privacy of historical values.** The new table stores user-typed
   values in plaintext SQLite. Acceptable (everything in `recent_queries`
   already does), but the cascade delete on connection removal needs a
   test — don't leave orphaned values when a connection is forgotten.

## New sources (drop-ins as they become worth it)

Each is a single file in `sources/` + one line added to `DEFAULT_FIELD_SOURCES`
or `DEFAULT_VALUE_SOURCES`. No consumer changes required.

| Source | Kind | Trigger | Cost | Notes |
|---|---|---|---|---|
| `indexesSource` | field | When user touches a collection for the first time in a session | One IPC, cached per (conn, db, coll). | Pulls `db.coll.indexes()`, emits indexed-field paths with a "has index" hint we can surface later in the popover badge. |
| `previewFieldsSource` | field | Any time | Free; uses existing `api.prefs.getPreviewFields`. | Low-yield overlap with `lastRunSource`; defer until someone wants persistence of "fields I care about." |

> `recentValuesSource` (committed) moved to the "Value suggestions" section above.
> **Shipped:** `schemaEnumSource` reads the validator's `$jsonSchema` `enum`
> through the existing `meta:collectionDetails`, cached per collection, and
> ranks first. The low-cardinality source shipped as `sampleValuesSource`:
> no separate probe, it reuses the docs `sampleSchemaSource` already fetched
> and lists a field with 20 or fewer distinct values. X02 §2 is the contract
> for both.

## Quality improvements (prioritize as symptoms emerge)

- **Debounce async fetches for fast typing.** `sampleSchemaSource` already
  caches, but a second collection flipped to in mid-type can fire two
  parallel IPCs. Add a 150ms debounce in the hook when `contextKey` changes
  rapidly. Only needed if anyone complains.
- **Type-aware value filtering.** When a field's `DisplayType` is known
  (from `lastRun`), filter value suggestions of incompatible types. Skip
  until we have a value source that produces typed values.
- **Cardinality heuristic.** Skip or mark-low-confidence value suggestions
  for fields whose cardinality in the sample is ≥ 90% of sample size
  (probably high-entropy fields like `_id`, free text). One-liner in the
  source output.
- **Accessibility.** Current popover is keyboard-reachable but has no
  `aria-live` for loading, no screen-reader hint on accept. Add
  `aria-busy`, `aria-activedescendant`, and an `role="combobox"` wrapper
  when we do an a11y pass.
- **Keyboard discovery.** A tiny hint below the field input on first focus
  ("↑↓ to navigate, Enter to insert") — fade after first successful accept.
- **Recent + random cache coordination.** Right now every tab with the same
  collection triggers its own `sampleSchemaSource` fetch because the cache
  key is per-collection. That's actually the desired behavior (one fetch
  total). No change needed, but document the assumption so we don't break
  it when the cache is refactored.

## Explicit non-goals

- **Fuzzy matching.** Prefix → substring → absent is enough. No fzf-style
  subsequence until someone asks for "find me `createdAt` by typing `crat`".
- **AI-generated suggestions.** Not a field suggestion problem.
- **Typeahead for MQL operators** (`$eq`, `$gt`…). That's a separate
  dropdown; conflating with field suggestions would muddy both.
- **Server-side sampling strategies beyond `$facet`.** If $facet is ever
  rejected (e.g., a read-only role that can't run `$sample`), fall through
  to LastRun + future index/schema sources. Don't add workaround paths.

## Gotchas worth knowing before you touch this code

React 19 + this project's `eslint-plugin-react-hooks` config is strict. Two
rules will trip you up the first time you write async hook code here;
both have a canonical workaround already used in `useSuggestions.ts`.

1. **`react-hooks/set-state-in-effect`** — any synchronous `setState` in
   the body of a `useEffect` is flagged as causing cascading renders.
   **Fix:** wrap the whole effect body in an async IIFE. Every `setState`
   runs after at least one await / microtask boundary, which satisfies
   the rule. See `useSuggestions.ts` for the race-guarded pattern
   (`reqId` ref + `if (myReq !== reqId.current) return` in the
   continuation).

2. **`react-hooks/refs`** — reading `ref.current` during render (i.e.,
   inside the component function or a `useMemo`) is flagged. Refs are
   for effects/handlers only. **Fix:** when you need a stable-identity
   value that's also readable at render time, use
   `useState(() => initialValue)` with no setter exposed. This is how
   `useSuggestions` captures the sources config — callers can pass fresh
   arrays every render and the hook sees a single stable reference,
   without violating the refs rule. Trade-off: the captured value is
   fixed for the lifetime of the hook. That's fine for configuration,
   not fine for things that should react to prop changes.

3. **Effect deps on identity-unstable props** — if you include `context`
   or `fieldSources` directly in an effect's deps and the caller rebuilds
   them every render, the effect fires forever. **Fix:** derive a stable
   key (see `contextKey` in `useSuggestions`) or lazy-capture via
   `useState` (as above). Don't rely on callers to memoize — they will
   forget.

4. **The atelier mock gate** — every new IPC channel needs a default
   no-op stub in `tests/helpers/atelierMock.ts`. Forgetting this
   crashes component tests with "api.X.Y was not mocked" the first time
   the new channel is indirectly invoked.

5. **Native-module ABI** — no longer a gotcha. `better-sqlite3` 13 is an
   N-API addon whose prebuilt binary serves every Node and Electron ABI,
   so the `rebuild:node` / `rebuild:electron` flip this entry used to
   warn about is gone.

## Where to add new surfaces

Every integration follows the same three-step pattern. If you're adding a
new editor, do this:

1. Decide how to build a `SuggestionContext` at the caret — usually from
   the tab's connection/db/collection plus a caret position.
2. Feed `context` and `token` to `useSuggestions`.
3. Render `<SuggestionPopover anchorRef=... items=... onSelect=... />`.

That's it. Nothing else in the feature needs to change.
