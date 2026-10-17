# W16 — Structure: the collection's shape and access paths

> **Status: Implemented.**

## Purpose

A user runs a find, gets their rows, and moves on. Nothing in the app tells
them the query just scanned the whole collection. If they suspect it and open
`ExplainDrawer`, it says `⚠ COLLSCAN — no index used` and then offers nothing
— no index list, no create action, not even a link. Index management lives on
a different screen entirely, reached by leaving the Data View, opening the
Connection Manager, and re-selecting the database and collection from two
dropdowns that have no idea which collection the user was just looking at.

So the loop that matters most in a MongoDB client —

> slow query → *why?* → *what indexes exist?* → *create the missing one* → re-run

— is broken at every joint. This spec closes it.

It answers the question with two moves. The first is **a place**: a Structure
view inside the collection tab, holding the collection's observed shape
(sampled schema) and its access paths (indexes), so "what do I have?" is one
click from the rows rather than one screen away. The second is **a signal**:
a plan badge on every run, so "is this using an index?" stops being a question
the user has to think to ask.

## Scope

- **In**: a third sub-view in the collection tab (§1); re-scoping the index
  surface from cluster-level to collection-level and retiring the Connection
  Manager's Indexes tab (§2); a `queryPlanner` plan badge on the result bar
  (§3); a **Create this index** action in `ExplainDrawer`, prefilled from the
  executed query in ESR order (§4); the persisted-`activeView` migration that
  makes all of it safe to ship (§8).
- **In, later tiers**: the statistics section (§13, Tier 5) and schema depth —
  distinct counts and numeric range (§14, Tier 6). Both are *sections poured
  into the container this spec builds*, not changes to it, and shipped after
  Tiers 1–4.
- **Out**: sample values and value distributions in the schema section. §14.3
  records why they stay out.
- **Out**: composition-time index awareness — W15 §14.2. That is a different
  half of the same idea and the boundary is stated in §5, not left to whoever
  picks up second.
- **Out**: `UsersTab` and every other Connection Manager surface. §2 states
  the rule that decides which surfaces move and which stay; only indexes meet
  it today.
- **Out**: an "indexes across the whole cluster" overview. §2 argues the
  dropdown version was never that, and a real one is a different feature
  nobody has asked for.
- **Out**: suggesting an *extension* to an existing index (noticing that
  `status_1` should become `status_1_createdAt_-1`). §4.4 records why.

## Dependencies

- W06 (result views — the badge's host bar), W07 (pagination — the badge must
  survive paging), C09 (indexes tab — the component this spec re-scopes and
  the spec it amends), X02 (field suggestions — `sampleSchema`, which the
  schema section already consumes), W15 (query composition — §5 boundary).
- ADR 0001 (Data View is home) — §2 extends its reasoning; ADR 0003 records
  the extension.

---

## 0. Where indexes live today

| Question the user has | Where the answer is | Cost to reach it |
| --- | --- | --- |
| Did this query use an index? | `ExplainDrawer`, behind the Run split-button's dropdown | opt-in, and only if you already suspect |
| What indexes does this collection have? | Connection Manager → Indexes tab → pick db → pick collection | leave the Data View, re-select the namespace |
| Create the index this query wants | same screen, hand-transcribe the filter into a form | manual, and the query shape is on the other screen |
| What shape are these documents? | Schema sub-view, in the tab | one click — the only one that works |

The last row is the shape the other three should have had.

`IndexesTab` is not collection-scoped. Its props are `{ conn, runtime }`; it
owns its own database and collection `<select>` pickers and remembers the last
pair in a `ui.indexes.lastTarget` preference. It is a cluster-level tool that
happens to be about indexes. That is why "show it in the collection tab" is
not a re-parenting — it is surgery, and §2 argues for the version of the
surgery that leaves one host rather than two.

---

## 1. The Structure view

### 1.1 One stacked pane, not a fourth and fifth tab

`CollectionView` gains a member and loses one: `'schema'` becomes
`'structure'`. The sub-tab strip stays at three entries — Documents,
Aggregation, Structure — and does **not** grow when the collection-stats-header
and schema-depth items (§11) land.

Structure is a single vertically scrolling pane holding sections in order:

1. **Statistics** — one collection's counts and sizes (§13).
2. **Indexes** — the list, with create and drop.
3. **Validation** — the validation rules, level and action, editable (§15).
   Plain collections only.
4. **Schema** — today's `SchemaView`, demoted from a view to a section, with
   per-field depth (§14).

The statistics section and the schema depth arrived after Tiers 1–4 without a
strip change.

The stacking is the point, not an economy. The insight this view exists to
produce is a *join across two sections* — "I filter on `status`; the schema
says it is present in 98% of documents and is always a string; no index covers
it." Behind two tab entries that is two facts the user holds in their head one
at a time. In one scroll it is one screen.

### 1.2 The indexes section

Behavior is today's `IndexesTab`, minus its two pickers:

- Lists indexes for **this tab's collection**, with the badges it already
  renders (unique / sparse / TTL / partial / collation / hidden / default) and
  the usage and size figures `IndexService.list` already returns from
  `$indexStats` and `$collStats`.
- Create, via the existing drawer: multi-field with direction, TTL
  `expireAfterSeconds`, `partialFilterExpression`, collation, optional name.
- Drop, with the existing type-to-confirm.

On a view the section is a single note, naming the source collection, that views have no indexes of their own and use that collection's; no list is requested and no create or drop is offered.

Nothing about the index *operations* changes. What changes is that the
namespace is given, not chosen: the db and collection `<select>` controls and
the `ui.indexes.lastTarget` preference are deleted, and the component takes
`{ connectionId, dbName, collection }` — the shape `SchemaView` already uses.

### 1.3 The schema section

`SchemaView` moves under the Structure view unchanged, keeping:

- its sample-size control and explicit Refresh,
- its `SchemaTabState` (name retained — it is still the *schema section's*
  state, and renaming it would churn persisted keys for nothing),
- its deliberate rule of sampling once per mount and never re-sampling on view
  switch, because each sample hits Mongo,
- its honest failure state: when the sample fails, the error banner is the
  whole message. The "No fields found in the sample." line is reserved for a
  sample that succeeded and came back empty, so an error never reads as an
  empty collection.

The sampling rule now matters more, not less: entering Structure must not fire a
sample *and* an index list on every visit. Indexes are cheap and fetched on
entry; the schema section keeps its existing once-then-manual behavior.

### 1.4 The Connection Manager's Indexes tab is deleted

Not deprecated, not hidden — removed, along with its `Tab` union member and
its picker state. §2 is the argument.

---

## 2. The rule: collection-scoped surfaces live in the Data View

> **Collection-scoped admin surfaces live in the Data View, on the collection
> they belong to. Cluster-scoped ones stay in the Connection Manager.
> Indexes are collection-scoped and move; users are database-scoped and stay.**

ADR 0001 made the Data View home and retired the connections *list*. The
Connection Manager survives as a deep screen for things that are genuinely
about a connection. An index is not about a connection; it is about a
collection, and the app already has an excellent way to say which collection
you mean — the navigator, and the tab it opens.

Keeping both hosts means maintaining two routes to one operation, which drift.
The picker version's only capability over the collection-scoped one is
*choosing a namespace from two dropdowns*, which is a worse navigator. Nobody
loses a feature; they lose a detour.

`UsersTab` has the identical `{ conn, runtime }` shape and does **not** move,
because MongoDB users belong to a database, not a collection. That is the line
the rule draws, and it is why the rule is worth writing down: it tells the next
person where a new admin surface goes without another debate.

Recorded as ADR 0003.

---

## 3. The plan badge

### 3.1 `queryPlanner`, on every run

Every successful find issues a second, plan-only explain at `queryPlanner`
verbosity, and the result bar reports the winning plan.

The verbosity is not a tuning choice, it is the whole feasibility argument:

- `executionStats` **executes the query** — it runs the winning plan to
  completion and discards the documents. A badge built on it would produce
  every result set twice, worst on exactly the large collections where the
  badge matters most. Rejected.
- `queryPlanner` **plans without executing**. It yields the winning stage and
  the index name — which is precisely the one fact the badge exists to make
  ambient — and does not yield `nReturned` or `docsExamined`, because those do
  not exist without execution.

So the badge names the plan; it does not count documents. Counts stay in
`ExplainDrawer`, where the user opts into the expensive verbosity knowingly.

**Cheap enough to be unconditional beats rich enough to be rationed.** A
signal that appears only sometimes is one users learn to ignore rather than
read, which is why a duration-threshold variant is rejected too.

### 3.2 The plan is kept across a page change, and nowhere else

`ExplainInput` is `Omit<FindInput, 'limit' | 'skip' | 'cancelToken'>` plus
verbosity. Paging changes only `skip` and `limit` — neither reaches the
explain — so the plan is page-independent *by construction*, and a page change
that left the connection, database, collection, filter, sort, projection and
limit as the last explained run had them reuses that run's plan instead of
asking the server the same question again. The new page's result carries the
plan from the start, so the badge never blinks off between pages.

That is the whole cache, one plan per tab, and it is deliberately narrow. An
explicit Run always explains, as does any run that changes the query, the
collection or the limit, and a page change while the previous plan has not
arrived yet. Anything broader would be worse than useless: the moment a cached
answer is most wrong is immediately after the user creates the missing index,
which is the exact moment §4 is designed to produce, and §4's flow ends in an
explicit Run.

### 3.3 Content and placement

The badge sits in the result bar's flex-spacer region, left of the column
chooser — the only part of that bar not already occupied.

It renders from `summarizeExplain`, which already exists as a pure function,
is already unit-tested, and already handles a `queryPlanner`-only plan by
omitting the execution metrics rather than throwing:

| Plan | Badge | Tone |
| --- | --- | --- |
| `IXSCAN` | index name, e.g. `status_1` | neutral |
| `COLLSCAN` | `no index` | warning |
| unrecognized / explain failed | nothing | — |

The badge is a button. Activating it opens `ExplainDrawer` on the plan already
fetched, from which the user can request a heavier verbosity or, per §4,
create the index. The plan reaches the drawer as `initialPlan`: opening it
makes no request, and only changing the verbosity fetches. The plan lives on
`lastRun.plan` in renderer memory, never persisted with the tab.

While the badge is stale (§3.4) the drawer's title reads *Explain plan (not
current)* and it offers no create-index action, since a suggestion built from
the query now on screen would not be about the plan being read. Changing the
verbosity there still explains the query as it is now, not the run that
produced the plan.

**The explain never blocks or fails the run.** It is issued after the find
resolves; if it errors or is cancelled, the rows still render and the badge is
simply absent. A diagnostic must not be able to break the thing it diagnoses.

### 3.4 The badge goes stale with the count

The badge and the result count are the same age: both describe `lastRun`, not
the text now in the query surfaces. X14 §5 already solved that for the count —
`ResultBar` derives `isStale = findProblem(state) !== null`, greys the number
and appends *"(not current — fix the query above)"* whenever Run is refusing to
make it current again.

**The badge dims on the same condition, with the same treatment.** No second
sentence: one explanation already covers the strip, and two would be noise for
one keystroke.

The alternatives were considered and rejected. *Hiding* the badge while stale
overloads absence, which the table above has already spent on "unrecognized
plan or failed explain" — the user could not tell a refused query from an
unreadable plan. *Leaving it at full contrast* beside a greyed, explicitly
flagged number asserts the plan is current when it is not, which is the defect
X14 fixed for the count.

Dimming is colour, so it cannot be the only carrier — see the Tier 3 criterion.
The accessible name states the staleness in words, e.g. `Query plan: status_1
(not current)`.

### 3.5 The staleness `isStale` does not see

`findProblem` reads the query text alone, so one sequence leaves the badge
wrong and unmarked: the badge reads `no index`, the user creates the index via
§4, and does not re-run. The plan is now obsolete and the query text is fine.

**Accepted, deliberately.** §4's flow ends in a re-run — that is what the Tier 3
e2e case walks — and §3.2 refuses a cache precisely so the next run answers
truthfully. Marking this window would mean the result bar watching index
creation for this collection: new cross-surface state, held for the seconds
between two clicks the user is already making in sequence. Not worth it.

---

## 4. Create this index

### 4.1 The suggestion rule

When the plan is a `COLLSCAN`, `ExplainDrawer` offers **Create this index**.
It opens the existing create drawer for this collection, prefilled from the
executed query's filter and sort.

`ExplainDrawer` is shared — `QueryBarInner` and `AggregationTab` both mount it,
and it knows nothing about either, taking only `{ onClose, initialVerbosity,
runExplain }`. So the action is **supplied by the caller, not owned by the
drawer**: an optional prop the find caller passes and the aggregation caller
omits. The find call site already closes over the executed filter and sort, so
nothing needs threading. Building it into the drawer instead would put the
button on a pipeline explain, where `suggestIndex(filter, sort)` has no filter
to read.

The ordering rule is MongoDB's **ESR** — **E**quality, then **S**ort, then
**R**ange:

| Class | Predicates | Direction in the key |
| --- | --- | --- |
| Equality | `{f: v}`, `{f: {$eq: v}}`, `{f: {$in: [...]}}` | `1` |
| Sort | keys of the sort document, in their given order | the sort's own direction, verbatim |
| Range | `$gt`, `$gte`, `$lt`, `$lte` | `1` |

Sort directions are preserved exactly, because a compound index serves a sort
only when the sort matches the index's direction pattern or its exact inverse.
Rewriting them to `1` would silently produce an index that cannot serve the
sort it was suggested for.

`$ne` and `$nin` are excluded from the key entirely: they are not selective
and an index on them does not help.

A field appearing in more than one class is placed once, in the earliest class
it qualifies for.

### 4.2 When it refuses

A wrong suggestion is worse than none, because it looks authoritative and
because an index is not free — it consumes RAM and every write pays for it
forever. The rule returns **no suggestion** when it cannot be confident:

- a top-level `$or` or `$nor` — these want a separate index per branch, which
  is a different recommendation, not a longer key;
- a `$regex` without a left anchor — it cannot use an index at all;
- `$text`, `$where`, `$expr` — different index types or none;
- an `$or` nested anywhere inside the filter (conservative);
- an empty filter with no sort — there is nothing to suggest.

Top-level `$and` is flattened and processing continues; a conjunction is
exactly what a compound key serves.

On refusal the button still appears and still opens the create drawer scoped
to this collection, with the fields empty. The user is one click from the
right form either way; only the prefill is withheld.

### 4.3 Prefilled, never submitted

The action **populates the drawer and stops.** Creating the index remains a
deliberate second act by the user, in the form they already know, with every
existing option available to edit.

Alongside the prefilled fields, one line of rationale naming the rule — e.g.
*"Equality on `status`, then sort on `createdAt`, then range on `amount` —
MongoDB's ESR order."* An override should be an informed disagreement, not a
superstition.

### 4.4 It ignores existing indexes

The suggestion is computed from the query alone. Noticing that `status_1`
already exists and this query wants `status_1_createdAt_-1` — i.e. proposing
an *extension* rather than a new index — is genuinely valuable and genuinely
more logic, including deciding when replacing an index is safe. Out of scope;
the pure function's signature leaves room for it without a rewrite.

---

## 5. Boundary with W15 §14.2

Both specs consume `index:list`. They are complementary halves and the line is:

| | W15 §14.2 | W16 §3–4 |
| --- | --- | --- |
| When | while composing, before Run | after a run |
| Source | the index list alone | the server's chosen plan |
| Claim | "`email` is indexed, `emailLower` is not" | "this query used no index" |
| Nature | prevention | diagnosis, then remediation |
| Cost | no round trip | one plan-only explain per run |

W15 §14.2 says it plainly: `ExplainDrawer` "is diagnosis… This is prevention."
Neither subsumes the other — prevention cannot know what the planner actually
chose, and diagnosis arrives after the user already waited.

**W16 ticket 1 is an enabler for W15 §14.2.** Once the index surface is
collection-scoped, "the index list for the collection this tab is on" is
already available for the autocomplete to mark against. W15 §14.2 should be
sequenced after it and reuse it rather than fetching its own.

---

## 6. Types

```ts
// shared/types.ts — 'schema' becomes 'structure'
type CollectionView = 'documents' | 'aggregation' | 'structure';
```

`SchemaTabState` keeps its name and shape — it is the schema *section's*
state. `CollectionTabState` is otherwise unchanged.

The index section's props become the shape `SchemaView` already uses:

```ts
{ connectionId: string; dbName: string; collection: string }
```

replacing `{ conn: ConnectionSummary; runtime: ConnectionRuntime }`, and
dropping the `ui.indexes.lastTarget` preference key.

One new pure module, the spec's only new seam:

```ts
type IndexSuggestion = {
  keys: Array<{ field: string; direction: 1 | -1 }>;
  reason: string; // one-line rationale rendered beside the prefilled form
};

// null when the query shape does not support a confident suggestion (§4.2)
function suggestIndex(
  filter: Record<string, unknown>,
  sort?: Record<string, 1 | -1>,
): IndexSuggestion | null;
```

It takes the parsed filter **document**, not a `filterTree` node — the input is
what was executed, and coupling the rule to the editor's model would make it
unusable from the explain path and harder to test.

## 7. IPC contract

**Tiers 1–4 add no channel. One existing validator must widen.** Every channel
those tiers need exists (Tier 5 adds one read channel, `meta:collectionDetails`,
specified in §13.2):

- `query:explain` already takes `verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution'`;
- `index:list` / `index:create` / `index:drop` are unchanged and already
  collection-scoped in their payloads;
- `meta:sampleSchema` is unchanged.

The renderer gains a second call site for `query:explain` (in the query
runner, beside `api.query.find`) — a call site, not a channel.

### 7.1 The one edit the rename forces

`electron/ipc/handlers/tabs.ts` validates the tab-state payload shared by
`tabs:update`, `tabs:openScript` and `tabs:openCollection`'s `initialState`.
That schema hard-codes the old union:

```ts
activeView: z.enum(['documents', 'aggregation', 'schema']).optional(),
```

It must become `z.enum(['documents', 'aggregation', 'structure'])`. This is not
optional and it is not hygiene. The renderer is what *writes* `activeView`, so
after the rename it sends `'structure'` and this validator refuses it.

`.passthrough()` on that object does not rescue it — passthrough permits keys
the schema does not name, and `activeView` is a named key with an enum. The
parse fails, `zodValidator` throws a `ValidationError`, and the router returns
`{ ok: false }`.

The blast radius is the whole message, not the one field. `api.tabs.update` is
the 250 ms-debounced write for *all* collection-tab state, so a refused parse
discards `columns`, `page`, `queryRaw`, `expandedRows` and the rest along with
the view. The user would open Structure and quietly stop persisting their tab.

The `ipc-channel-auditor` gate is still owed per the Definition of Done. It now
has exactly one contract change to audit: this enum, in the handler and against
the `CollectionView` union in `shared/types.ts` that must stay its mirror.

## 8. Persistence & migration

Persisted collection-tab state enters the system in the main process, in
`WorkspaceStateService`'s row-to-tab mapping, which currently does:

```ts
activeView: (parsed.activeView ?? 'documents') as CollectionView
```

That cast is unchecked. After the rename, a tab persisted with
`activeView: 'schema'` passes straight through, matches none of the three
render branches, and yields a **blank pane** — it does not fall back to
Documents. Every user with a Schema view open at upgrade time gets an empty
collection tab.

So the migration is not hygiene, it is the condition of shipping:

1. `'schema'` maps to `'structure'`.
2. Any value not in the union falls back to `'documents'` — validated against
   the union, not cast to it. This closes the latent blank-pane class for
   every future rename, not just this one.
3. The mapping lives at that same boundary, so no renderer code needs to know
   the old name existed.

No SQLite migration file is needed: `state_json` is an opaque blob and the
mapping is applied on read.

Persisted state crosses two boundaries, and only one of them is this mapping.
The **read** side is `WorkspaceStateService`, above. The **write** side is the
zod schema in `electron/ipc/handlers/tabs.ts` (§7.1), which refuses the new
value until it is widened. Fixing one without the other ships a different bug:
migrate-only means the tab renders and then fails to save; widen-only means
every pre-upgrade Schema tab opens blank.

## 9. Acceptance criteria

Tiers are tickets. Tier 3 is blocked by nothing and should be built first —
it is the smallest, and it puts the idea in the running app soonest.

### Tier 1 — collection-scope the index surface

- The index component takes `{ connectionId, dbName, collection }` and
  renders that namespace's indexes.
- Its database and collection pickers are gone, as is the
  `ui.indexes.lastTarget` preference read/write.
- List, create (all existing options), and drop behave exactly as before
  for a given namespace.
- `IndexService` and the `index:*` channels are unchanged.
- `specs/C09-indexes-tab.md` is amended to describe the collection-scoped
  surface, and the references to it from `C05`, `C08`, `PLAN-connections`
  and `README` still resolve.

### Tier 2 — the Structure view

- `CollectionView` is `'documents' | 'aggregation' | 'structure'`; the
  sub-tab strip shows three entries with Structure third.
- Structure renders one scrolling pane: indexes section, then schema
  section.
- The schema section behaves exactly as the Schema view did, including
  sample-size, explicit Refresh, and no re-sample on view switch.
- Entering Structure fetches the index list; it does not trigger a schema
  sample.
- A tab persisted with `activeView: 'schema'` opens on Structure.
- A tab persisted with an unrecognized `activeView` opens on Documents,
  never blank.
- The `activeView` enum in `electron/ipc/handlers/tabs.ts` accepts
  `'structure'` (§7.1), and a tab left on Structure still persists its
  other state — columns, page, `queryRaw` — across a relaunch.
- The Connection Manager has no Indexes tab, and its `Tab` union no longer
  names one.
- `UsersTab` is untouched and still reachable.

### Tier 3 — the plan badge

- Every successful find issues a `queryPlanner` explain for the same
  filter, sort and projection.
- The result bar shows the index name for an `IXSCAN`, `no index` for a
  `COLLSCAN`, and nothing when the plan is unrecognized or the explain
  failed.
- A failed, slow, or cancelled explain never blocks, delays, or fails the
  find; rows render regardless.
- The badge is a button; activating it opens `ExplainDrawer` on the
  already-fetched plan.
- The badge follows every run, and reflects a newly created index without an
  app restart. A page change keeps the plan of the same query and sends no
  second explain; an explicit Run, or any change to the query, does.
- While the result count is marked not current (X14 §5), the badge is
  dimmed on the same condition, and its accessible name says so in words
  (§3.4).
- The badge has an accessible name; it is not colour-alone.

### Tier 4 — create this index

- On a `COLLSCAN` plan, `ExplainDrawer` offers **Create this index** when
  the find caller supplies the action, and does not offer it on an
  aggregation explain (§4.1).
- It opens the create drawer for this collection, prefilled in ESR order
  per §4.1, with sort directions preserved verbatim.
- For each refusal case in §4.2 the drawer opens with fields empty.
- The action never creates an index by itself — submission stays the
  user's act.
- The rationale line names the rule that produced the ordering.

### Invariants (all tiers)

- Tiers 1–4 add no IPC channel. Their only contract change is the `activeView`
  enum in `electron/ipc/handlers/tabs.ts` widening in step with `CollectionView`
  (§7.1) — no channel gains, loses, or retypes any other field. Tier 5 adds
  `meta:collectionDetails` (§13.2) and Tier 7 adds `collection:modify` (§15.3).
  The base these tiers ship in adds two more contract changes of its own:
  `conn:getUri` (the navigator's "Copy connection string") and the `viewOn` and
  `pipeline` options on `collection:create` (Save as view).
- No renderer import of a forbidden module; the suggestion module is pure
  and imports nothing from `electron/`.
- No behavior change to `IndexService` or `QueryService`. Tiers 1–4 leave
  `MetaService` unchanged; Tier 5 adds `collectionDetails` to it. Its other
  methods' results stay as they were, though `listCollections` now takes its
  figures from the same storage-stats read as `collectionDetails` (§13.2) and
  skips a view, which has no storage and which `$collStats` refuses.

## 10. Test cases

One new seam. Everything else extends prior art.

### Unit — `tests/unit/index-suggestion.spec.ts` (new)

The only new seam, and the one with real logic:

- equality only → single-key index;
- equality + sort → equality first, sort direction preserved;
- equality + sort + range → full ESR ordering;
- sort `{a: 1, b: -1}` → key preserves both directions, not normalized to `1`;
- `$in` classed as equality;
- `$gt`/`$lte` classed as range, placed last;
- `$ne` / `$nin` excluded from the key;
- a field in two classes appears once, in the earliest;
- top-level `$and` flattened, suggestion still produced;
- each §4.2 refusal returns `null`: top-level `$or`, `$nor`, nested `$or`,
  unanchored `$regex`, `$text`, `$where`, `$expr`, empty filter with no sort;
- an anchored `^`-prefixed `$regex` is *not* a refusal;
- `reason` names the classes actually used.

### Unit — `tests/unit/explain-summary.spec.ts` (extend)

Already covers a `queryPlanner`-only plan yielding undefined metrics. Add
whatever badge-shaped assertions the summary needs — index name present for
`IXSCAN`, absent for `COLLSCAN` — rather than re-summarizing in a component.

### Integration — `tests/integration/workspace-state-service.spec.ts` (extend)

The migration, at the boundary where it lives:

- persisted `'schema'` → `'structure'`;
- persisted `'structure'` → `'structure'`;
- persisted `'documents'` / `'aggregation'` unchanged;
- persisted garbage, and absent `activeView` → `'documents'`;
- unparseable `state_json` still yields defaults, as today.

### Integration — the `tabs:update` validator (extend)

The write half of §8, and today nothing covers it: no test in the suite sends
`activeView: 'schema'` through a `tabs:*` payload — the existing ones all use
`'aggregation'`, which the rename leaves untouched. So the enum in §7.1 can be
missed with every gate green, and the failure is silent state loss rather than
a crash.

- `tabs:update` with `activeView: 'structure'` resolves `{ ok: true }` and the
  value round-trips through a re-read;
- the same call also persists a second field (`page`, say), proving the whole
  patch survives rather than the view alone;
- `activeView: 'schema'` — the retired value — is refused with `VALIDATION`.

### Integration — `tests/integration/index-service.spec.ts` (unchanged)

Named to be explicit: Tier 1 must not require edits here. If it does, the
change leaked into the main process and the tier is wrong.

### Component — the index section (rework the four existing specs)

`indexes-tab-render`, `indexes-create-drawer`, `indexes-drop-confirm`,
`indexes-empty-states` keep their assertions and change their harness: mount
with `{ connectionId, dbName, collection }` against `installAtelierMock`
instead of driving the pickers. Any test whose *subject* was picker behavior is
deleted, not ported.

### Component — the Structure view

Following the existing precedent of setting `activeView` in the fixture rather
than clicking the strip:

- `activeView: 'structure'` renders both sections;
- entering Structure requests the index list and does not request a schema
  sample;
- the schema section still honors explicit Refresh.

### Component — the badge (via the existing workspace mount helper)

- a run whose mocked explain is an `IXSCAN` shows the index name;
- a `COLLSCAN` shows `no index` with its warning treatment;
- a rejected explain leaves rows rendered and no badge;
- activating the badge opens the drawer;
- a page change, or a page-size change, sends no second explain and the new
  page keeps the badge; an explicit Run of the same query, a changed filter,
  sort, projection, limit or collection, and a page change before the first
  plan arrived, each explain again;
- editing the filter to something `findProblem` refuses dims the badge beside
  the already-stale count, and its accessible name carries the same fact —
  the assertion is on the name, not the colour (§3.4).

### E2E

One flow, on the tier-4 ticket: run a find that collection-scans → badge reads
`no index` → open the drawer → **Create this index** → drawer is prefilled →
create → re-run → badge names the new index.

It is the only test that covers the whole loop this spec exists to close —
every other case above verifies one joint of it — so it is the one that must
not be skipped.

**It will not run itself.** The e2e job is `workflow_dispatch`-only; it does
not run on a PR, including a PR targeting `main`. Dispatch it by hand on the
tier-4 ticket. Per the Definition of Done, a gate a workflow cannot run
automatically is still owed, not waived.

## 11. Out of scope

Recorded here *and* filed, because a spec's "Out" line is not a tracker —
the FindInput Phase 3 item ("collation / hint / maxTimeMS / readPreference
are specified but untracked") is what that failure looks like once it has aged:

| Deferred | Where it is tracked |
| --- | --- |
| Collection stats header | shipped as a Structure section, §13 (not as a navigation change: a nav click still opens a tab on Documents) |
| Schema depth — cardinality, numeric stats | shipped inside the schema section, §14 |
| Schema sample values and value distributions | out of scope, §14.3 |
| Validation rules | shipped as a Structure section, §15 |
| Composition-time index marking | W15 §14.2; sequence after Tier 1 and reuse its collection-scoped list (§5) |
| Suggesting an extension to an existing index | §4.4; no issue yet — file if it survives first use |
| Cross-collection index overview | §2; no issue, and no demand |
| `executionStats` counts in the badge | rejected by §3.1, not deferred |

## 12. Issue map

Removed — see the note at the end of `W15-query-composition.md` §15. The live
mapping is GitHub Issues, which cite this spec's tiers in their bodies.

---

## 13. Statistics section (Tier 5)

### 13.1 What it shows

A `Statistics` region at the top of the Structure pane, above Indexes. For a
collection or time-series collection it shows documents, data size, storage
size, average document size, indexes (count and total index size) and whether
the collection is capped. A figure the server did not report, or that could not
be read, renders `—`, not `0`. While the first reply is pending the section says
`Loading…`, and a switch to another collection drops the previous collection's
figures rather than showing them under the new name. For a view it shows `View on <source>` and no figures. It fetches on entry
and on its own Refresh button, and a failed fetch is an inline alert in the
section: the indexes and the schema still render.

The collection header keeps its own count, read from `meta:listCollections`.
Both sources read `$collStats`, so they agree; moving the header onto the new
channel is not part of this tier.

### 13.2 `meta:collectionDetails`

A read channel taking `{ connectionId, dbName, collection }` and returning
`CollectionDetails` (`shared/ipc.ts`): `name`, `type`, `capped`, `stats?` and
`options`.

- `stats` is `documentCount`, `sizeBytes`, `indexCount`, `storageSizeBytes`,
  `avgObjSizeBytes` and `totalIndexSizeBytes`, each present only when the server
  reported it. A sharded cluster answers `$collStats` with one document per
  shard: counts and sizes are summed, the index count (the same on every shard)
  is the largest, and the average is recomputed from the totals. A time-series
  collection reports no count, so it is read with `estimatedDocumentCount`.
  `stats` is absent for a view.
- `$collStats` refused for lack of privilege, or by a tier that does not offer it,
  falls back to `estimatedDocumentCount` for the count and `indexes()` for the
  index count; the sizes are absent, and the refusal is logged. Any other
  failure of `$collStats` (a timeout, a dropped connection) is an error of the
  call. If the refusal fallback cannot read either estimate, the call is an
  error too: unreadable figures are never reported as `0`.
- `options` carries what `listCollections` reports: `viewOn` as a plain string,
  `pipeline` and `validator` as canonical EJSON strings, and the validation
  level and action. A later tier that edits a view or a validator reads them
  from here.
- A collection that does not exist is `NOT_FOUND`. A missing field in the payload
  is `VALIDATION`.

`MetaService.listCollections` and `collectionDetails` share one storage-stats
read, so the `$collStats` call and its fallback exist once. A collection whose
read fails is still listed, without figures, so one bad collection does not
blank the navigator. A view is listed without figures and without a
`$collStats` call, which a view refuses.

### 13.3 Acceptance criteria

- Structure renders a Statistics region above the Indexes region.
- Entering Structure calls `meta:collectionDetails` once for the tab's
  collection; Refresh calls it again.
- A collection shows its document count and its sizes in human units; an absent
  figure, including the count of a time-series collection whose estimate failed,
  shows `—`.
- The section says `Loading…` until its first reply, and switching collection
  clears the previous figures.
- A view shows `View on <source>` and no document count.
- A rejected fetch shows a `role="alert"` inside the section and does not stop
  the Indexes or Schema sections rendering.
- A reply for a collection the tab has since left never overwrites the one
  on screen.
- Creating or dropping an index in Structure, and modifying the view from the
  navigator, read the details again, so the figures and `View on <source>` are
  never older than the change. A reload captured for a collection the tab has
  since left does nothing.
- The collection header's document and index counts come from the same
  `meta:collectionDetails` read, one collection rather than the whole database;
  a figure the server did not report is hidden, never `0`.
- `meta:collectionDetails` has its schema, preload binding, handler registration
  and shared type, and no `SECRET_INPUT` tag (the payload carries no secret).

### 13.4 Test cases

- Integration, `MetaService.collectionDetails`: a collection with an extra index
  (type, count, index count of 2, positive sizes); a capped collection; a
  collection with a validator, level and action (the validator parses back to
  the document); a view (no stats, `viewOn`, parsed pipeline); a missing
  collection (`NOT_FOUND`); `$collStats` refused (estimate, optional sizes
  absent, the refusal logged); a populated time-series collection (real count,
  here and in `listCollections`); `$collStats` failing for another reason
  (classified error); refused with both estimates failing (error, no zeros).
- Unit, `foldStorageStats`: single node, a two-shard reply, a missing count,
  empty reply.
- Integration, router: empty `collection` is `VALIDATION`; a valid payload is
  `{ ok: true }`; a missing collection is `NOT_FOUND`.
- Unit, `humanBytes`: units, the petabyte ceiling, non-finite input.
- Component, `StructureView`: the cases in §13.3.

---

## 14. Schema depth (Tier 6)

### 14.1 What it adds

Two columns in the schema table, both computed from the sample the section
already fetches (no IPC change):

- **Distinct** — how many different scalar values the field held in the sample.
- **Range** — `min – max · avg x` over the field's numeric occurrences
  (`number`, `long`, `decimal`), or `—`.

A scalar is a value that is neither an array nor a plain sub-document, so
`null` is one. An EJSON
sentinel (`ObjectId`, `Date`, a number) is one scalar. `1` and `"1"`, and an
`Int32` 1 and a `Long` 1, are different values. The scalar elements of an array
are not counted — the walk still looks only at an array's object elements, as
before — so an array field has neither column.

The sample arrives as canonical EJSON, so a number is a `$numberInt`,
`$numberDouble`, `$numberLong` or `$numberDecimal` wrapper. Its string is read
with `Number.parseFloat`; `NaN` and the infinities are ignored. `$numberLong` and
`$numberDecimal` values past 2^53, or with more than about 15 significant
digits, are therefore approximate in the range. A field whose average overflows
to infinity has no range at all, because the persisted JSON would turn it into
`null`.

### 14.2 What is persisted

`SchemaSampleEntry` gains `distinct?: number` and
`numeric?: { min; max; avg }`. `schema.entries` is persisted with the tab, so
both are numbers derived from the sample, like `frequency`.

`numeric.min` and `numeric.max` are literal values of single documents, which
makes them results in all but name. Main therefore drops `numeric` from an
entry whose path is secret-named (`isSecretFieldPath`, the rule the log
redactor and the recent-value recorder already share) before the tab is
written to SQLite; the renderer, which cannot import that rule, keeps it in
memory for the session. `distinct` is a count and is kept. A restored tab shows
`—` in Range for such a field until the next sample.

### 14.3 What stays out

Sample values and value distributions ("top values") are out of scope. They
would write user document values into SQLite with the tab, and the feature this
tier answers asks only for cardinality and numeric range.

Known ceiling: the sample is the most recent documents plus a random draw, so a
document can appear twice. `distinct` is unaffected; `avg` is weighted by the
duplicates.

### 14.4 The sample-size bound

The sample size selector offers 50, 100 and 200 — `SCHEMA_SAMPLE_MAX`
(`shared/defaults.ts`), the bound `meta:sampleSchema` validates. Raising it is
unsafe on its own: the `recent` and `random` branches (n documents each) share
one `$facet` output document with BSON's 16 MB cap, and a breach fails open to
an empty sample. A tab persisted with a larger size samples at the bound.

### 14.5 Acceptance criteria

- `distinct` counts unique scalar values per path; a sentinel is a scalar, a
  sub-document and an array are not; an array's scalar elements are not
  counted.
- `numeric` is the min, max and average over finite numeric occurrences and
  ignores `NaN` and infinities; a path with none has no `numeric`.
- No sample value is stored on an entry.
- The persisted tab state has no `numeric` on a secret-named path and keeps it
  on others.
- The schema table shows Distinct and Range, `—` where absent.
- The sample-size selector offers exactly 50, 100 and 200, and a tab persisted
  with a size above the bound samples at the bound.

### 14.6 Test cases

- Unit, `summarizeSchema`: distinct counts, sentinel and sub-document
  handling, array elements, numeric over mixed wrappers, `NaN`, string-only
  path, no stored values.
- Unit and integration, tab-state serialisation: a `password` or `pwd` field
  loses `numeric` and keeps `distinct`; a `price` field keeps both.
- Component, `StructureView`: the Distinct and Range cells; the three sample
  sizes; a restored size above the bound.

---

## 15. Validation rules (Tier 7)

### 15.1 Where it lives

A collection's validator is collection-scoped admin state, so under the §2
rule it lives in Structure, not in the Connection Manager or a dialog off the
navigator. It sits **between Indexes and Schema**: the shape the server
enforces next to the shape the sample observed.

### 15.2 What it shows and edits

A `Validation` region. Read mode shows the validator pretty-printed as
readable JSON (`"minimum": 0`, not `{"$numberInt":"0"}`; only wrappers that
re-parse to the same BSON are dropped), or `No validation rules` when there is
none (an empty `{}` validator counts as none), then `Level: <level>` and
`Action: <action>`. `listCollections` reports
the level and action only once they were set, so an absent one shows the
server default, `strict` and `error`.

`Edit rules` swaps in a `Validator` textarea prefilled with the same readable
rules, so saving them unchanged sends the same BSON, a `Validation level`
select (off, strict, moderate) and a `Validation action` select (error, warn,
errorAndLog), with Save and Cancel. `errorAndLog` round-trips when the server
reports it; MongoDB 8.0.5 refuses it in `collMod`, and that refusal shows
inline like any other. Save requires the text to parse as
a JSON document (not an array, not `null`, not a bare EJSON value such as
`{"$date":…}`, the same rule main applies) and says so inline otherwise, with
no call. An emptied textarea saves `{}`, which clears the rules. The region
renders for a plain collection only: a view has no validation rules, and the
server refuses `collMod` validation options on a time-series collection
(MongoDB 8.0.5 answers `InvalidOptions`, code 72, for both `validator` and
`validationLevel`).

Save calls `collection:modify` with `{ validator, validationLevel,
validationAction }` and then reads the details again; the button stays in its
submitting state and the editor stays open until that read is in, so the old
rules never flash back. A refusal, a read-only
connection's included, is a `role="alert"` in the section and the editor stays
open; like the indexes section, nothing is greyed out up front, and main is the
guard (ADR 0005).

The region reads `CollectionDetails.options` from the same
`meta:collectionDetails` reply the statistics section shows: Structure reads it
once on entry and hands it to both, so a save refreshes the figures too. While
that read is pending or has failed, the region is not rendered, and the
statistics section carries the alert.

### 15.3 `collection:modify`

A write channel taking `{ connectionId, dbName, collection, options }` and
returning `{ ok: true }`. It runs `collMod` on the metadata budget. The options
are either validation keys (`validator`, `validationLevel`,
`validationAction`) or a view's definition (`viewOn` and `pipeline`, together),
never both: the router refuses an empty `options`, half a view definition and a
mix as `VALIDATION` before the service runs. Main parses `validator` as an EJSON
document and `pipeline` as an EJSON array of single-operator stages with no
`$out` or `$merge`, and refuses anything else as `VALIDATION` naming the field.
A missing collection is `NOT_FOUND`, and a read-only connection is refused by
the write grant. W02's Modify view is the channel's other caller.

### 15.4 Acceptance criteria

- Structure renders a Validation region after Indexes and before the schema
  section.
- The region shows the validator, level and action from
  `meta:collectionDetails`; with none set it says `No validation rules`,
  `Level: strict`, `Action: error`.
- Edit rules, a changed level, Save calls `collection:modify` with the
  validator, level and action, then reads the details again, and read mode
  shows the new level only once that read is in.
- Rules are shown and edited as readable JSON, and saving them unchanged
  sends an equivalent validator.
- The action select offers `errorAndLog`, and a reported `errorAndLog` shows.
- An emptied validator saves `{}`; text that is not a JSON document is refused
  inline with no call.
- A refused save shows inline and keeps the editor open.
- A view, a time-series collection and a failed details read render no
  Validation region.
- Entering Structure still reads `meta:collectionDetails` once.
- `collection:modify` sets a validator the server then enforces, clears it with
  `{}`, updates level and action alone, and replaces a view's definition;
  invalid EJSON, a non-document validator and a write stage are `VALIDATION`;
  a missing collection is `NOT_FOUND`; a read-only connection is refused; the
  command carries `maxTimeMS`.
- `collection:modify` has its schema, preload binding, handler registration and
  shared type, is classified as a write channel, and carries no `SECRET_INPUT`
  tag.

### 15.5 Test cases

- Integration, `CollectionAdminService.modify` and view create: the cases in
  §15.4 against the memory server.
- Integration, router: empty options, half a view, mixed keys and an unknown
  action are `VALIDATION`; valid payloads of both kinds reach the service.
- Component, `StructureView`: placement, read mode, `{}` as no rules, edit and
  save with refetch, `{}` on an empty textarea, invalid input, a refused save,
  a view.
- E2E, `w02-views-validation.e2e.ts`: Edit rules saves a `$jsonSchema` that the
  section then shows.
