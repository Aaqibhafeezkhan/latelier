# W15 — Query composition: the whole find, not just the filter

> **Status: Accepted.** Tiers 1–2 and most of §13 shipped. Tier 3 is open only for the 1000-document cap. Of §14, 14.1, 14.3 and 14.5–14.9 shipped; 14.2 and 14.4's "exclude this value" are open.

## Purpose

W13 rebuilt the **filter**. W14 fixed three defects in the row that owns
everything else. Neither asked the question this spec exists to answer:

> Can a user who does not already know MongoDB assemble a complete `find` —
> filter, projection, sort, limit, skip — without leaving the app to think?

The answer today is no, and the reasons are not evenly distributed. The filter
is excellent: a recursive typed editor, field and operator autocomplete,
inline per-row errors, and a raw-clause escape for anything the model can't
express. The other four fields are four unlabelled text inputs behind a
collapsed chevron, with no autocomplete, no validation, and — in two cases —
error messages that name an escape hatch this app does not have.

This spec is an audit first and a design second. §1–§7 are findings with
evidence, §13 covers the drawer's presentation, and §14 covers what is absent
rather than wrong. §8 states the direction; §9–§12 are the contract.

## Scope

- **In**: the projection / sort / limit / skip surface (`QueryBar` advanced
  row), the right-hand drawer's role after W13 §7 deleted its editors and its
  presentation (§13 — affordances, tab strip, Saved/Recent rows, empty and
  loading states), the three-way split between projection / preview fields /
  column config, and the dead or stale surfaces the redesigns left behind.
- **Out**: the filter tree itself (W13, shipped and working). `FindInput`
  Phase 3 — `collation` / `hint` / `maxTimeMS` / `readPreference`; it
  is a separate 5-file IPC change and adding it to a UI this shaky would just
  add two more unlabelled inputs. `ReferenceDrawer`'s fixed width.
  Result-view redesign (W06).
- **Out, deliberately, and recorded rather than designed.** Three drawer
  usability questions this spec declines to answer, kept out on request so §13
  stays a defect list rather than a redesign. Each is tracked in GitHub Issues →
  "UI / UX improvements" so it survives this spec:
  1. **Visual redesign of the pane** — layout, density, typography,
     information hierarchy. §13 fixes what is wrong; it does not propose what
     the drawer should look like. Needs a design intent first.
  2. **Narrow-width behavior.** The panel's `minSize` is 15%, and a `CondRow`
     packs an 88px type `Select`, a 100px op input, a preview span, a `⋮` menu
     and a `✕` onto one line. It must break below some width; nobody has
     established where. Responsive behaviour below 1024px is covered globally, not this pane.
  3. **First-run guidance.** X06 hints exist, but `saved.create`
     (`BuilderPane.tsx:1108`) is the only anchor in the entire drawer. Nothing
     introduces the filter tree, the drop target, or the raw-clause escape.

  Recorded here as well as on the tracker on purpose: W13's and W14's
  scoped-out items lived *only* as spec "Out" lines and went untracked
  across two specs. One line in one spec is not a tracker.

## Dependencies

- W13 (filter tree — the precondition and the quality bar), W14 (advanced-row
  correctness), W05 (query bar), W06 (result views), W07 (pagination),
  W10 (preview fields), X02 (field suggestions).

---

## 0. Where the pieces live today

| Piece | Editor | Where | Autocomplete | Validation | Escape hatch |
| --- | --- | --- | --- | --- | --- |
| filter | recursive tree + textarea | drawer *and* bar | fields + operators | per-row inline, fail-closed | raw clause |
| projection | one text input | bar, collapsed | none | inline (W14 §3) | **named but absent** |
| sort | one text input | bar, collapsed | none | **none — server round trip** | none |
| limit | one number input | bar, collapsed | n/a | **none — silent coercion** | none |
| skip | read-only text | bar, collapsed | n/a | n/a | none |

Three of the five are behind a disclosure control labelled `query`
(`QueryBar.tsx:388`) — a noun that describes the *filter* row it sits on, not
the advanced content it reveals.

---

## 1. The drawer after W13 §7

W13 §7 made the query bar the single owner of sort / limit / projection by
deleting the drawer's copies. Correct — two owners with divergent write
semantics was the defect. But the deletion left the drawer in a strange state,
and this is the substance of the "right-side drawer" follow-up.

### 1.1 The drawer prints fields it does not let you edit — P1

`BuilderPane.tsx:895-904`, the **Copy code** button:

```ts
const opts = compileFindOptions(state.builder);
const parts = [`db.${collection}.find(${filterText}`];
if (opts.projection) parts[0] += `, ${opts.projection}`;
parts[0] += ')';
if (opts.sort) parts.push(`.sort(${opts.sort})`);
if (opts.limit !== null) parts.push(`.limit(${opts.limit})`);
```

The drawer emits `.sort()` / `.limit()` / a projection argument for values it
gives the user no way to see or change. A user reading the drawer as "the
place where I build my query" — which its tab labels, its footer, and its
`Save` button all encourage — gets a copied shell command containing clauses
that appear from nowhere.

It also omits `skip`, so the copied command does not reproduce what the pager
is showing.

### 1.2 Nothing in the drawer points at the advanced row — P1

The drawer is the widest, most visually prominent query surface in the app.
After W13 it contains exactly one thing: the filter tree. There is no line, no
link, no disabled placeholder saying where sort and projection went. The only
signal is W14's `n set` badge, on a different pane, above the result area, on
a control the user must already know to look at.

W14 §2 called the badge a fix for "nothing indicates that projection / sort /
limit exist and are hidden". It is a fix for users who already know they
exist. It is not discovery.

> **Shipped (pointer):** under the filter tree the drawer carries one muted
> line: sort, limit and skip are set in the query bar's advanced row, and
> projection is under Fields. It is static text, not a control — a pointer is
> enough once the reader knows where to look.


### 1.3 The drawer is dimmed dead weight on two of three views — P2

`Workspace.tsx:2366-2373` keeps `BuilderPane` mounted under `opacity: 0.35`,
`pointer-events: none`, `aria-hidden` on the Aggregation and Schema views.
W13 called this "layout, separate ticket"; it was never actually tracked. It is
a third of the horizontal space spent on a control that is, in those views,
decoration.

### 1.4 A Saved load does not reopen an explicitly collapsed advanced row — P2

Already filed. Restated here because it belongs to this surface:
the fix (lift `loadGen` from `BuilderPane` to `Workspace`) is cheap *if* done
alongside any other change that touches the resync, and expensive as a
standalone P2.

### 1.5 Saved / Recent tabs — P2

Already filed: one item (never migrated to Mantine; icon buttons lack
`aria-label`) and another (Recent shows *when* a query ran, never *what* it
queried). Both live in this drawer. The Recent-preview gap matters more than its P2 suggests —
a history list you cannot read is not a history list, and it is the only place
a user can recover a query they lost.

---

## 2. Projection

### 2.1 The error message names an escape hatch that does not exist — P1

`QueryBar.tsx:27`:

```ts
unmodelable: 'This editor only models inclusions. Use raw MQL for exclusions or $slice.',
```

There is no raw-MQL projection input in this application. `builder.projection`
is `string[]`; `compileFindOptions` (`builder.ts:218-225`) can only build an
inclusion map from it; `FindInput.projection` is a string but the only writer
is that compiler. Grep confirms the query bar's input is the sole projection
editor in the renderer.

So W14 §3 replaced *silently eating the user's text* with *telling the user to
do something the app cannot do*. That is better — the text survives — but the
advice is a dead end, and it is the exact asymmetry W14 §3 held up as the
model: `filterTree.ts` degrades an unrepresentable clause to an **editable raw
node**. Projection degrades to a sentence.

**Required**: either projection gets a raw passthrough (a `string` that skips
the inclusion model and goes to the driver verbatim, exactly as `queryRaw`
does for the filter), or the message stops naming one. The first is correct;
the second is the honest minimum.

### 2.2 `_id` cannot be excluded — P1

`builder.ts:220` seeds every compiled projection with `{ _id: 1 }`. For
inclusions this matches Mongo's own default and changes nothing. But combined
with §2.1 it means `{_id: 0}` — the single most common projection idiom in
daily use — is unreachable by **any** route in the app.

Corroborating evidence that the codebase expects it to be reachable:
`DeleteConfirm.tsx:95` carries a guard for a document with no `_id`,
commented "*e.g. a find with `{_id: 0}` projection*". That is a defensive path
for a state the UI cannot currently produce.

### 2.3 No field autocomplete — P1

The projection input is a bare `<input>` (`QueryBar.tsx:448-471`). The user
must recall exact field names, including dotted paths, from memory.

Everything needed already exists: `useSuggestions` + `DEFAULT_FIELD_SOURCES`
(used by the drawer's cond rows at `BuilderPane.tsx:223-227`), and
`previewKnownFields`, already computed in `Workspace.tsx` and already passed
to `CollectionHeader`. The drawer's filter rows autocomplete field names; the
projection input, three inches away, does not.

### 2.4 A retained invalid draft is invisible when collapsed — P2

Already filed. The badge counts `builder.projection`, which a
refused draft never updates, so a collapsed row reads "nothing set" while an
unresolved edit sits underneath.

### 2.5 Two divergent `parseProjection` implementations — P2

`src/pages/Workspace/projection.ts` returns a typed
`{ ok } | { ok: false; reason }`. `ReferenceRulesEditor.tsx:62` defines a
private `parseProjection` that comma-splits and cannot fail. Same name, same
concept, different contracts, one file apart in the import graph. A reader who
learns one will mis-read the other.

---

## 3. Sort

### 3.1 Sort has no client-side validation at all — P0 for consistency, P1 in practice

`compileFindOptions` (`builder.ts:213-215`) passes the trimmed string straight
through. It reaches `QueryService.find`, where `parseEjsonField` throws a
`ValidationError` (`electron/mongo/ejson.ts`), which surfaces as the red run
error pill *after a round trip to the main process*.

Compare the filter in the same component: `isValidEjson(queryRaw)` gates the
Run button (`QueryBar.tsx:53, 62`), with an inline warning underline
(`QueryBar.tsx:425-427`), before anything is sent.

Two fields, one row apart, in one component, with two different validation
contracts. A user who types `{name: 1` in the filter gets Run disabled and a
warning border. A user who types `{name: 1` in sort gets an enabled Run, a
round trip, and `VALIDATION: invalid sort: ...` in a pill.

### 3.2 A broken sort silently desyncs the table header — P1

`parseSortString` returns `{}` on any parse failure, by
design, so the quick-sort UI has something to work with. Consequence:
`TableView`'s header indicator (`TableView.tsx:980-1048`) shows **no** sort
arrow while `builder.sort` holds text that is about to error, or text using a
shape the map drops (`{ $meta: 'textScore' }`).

The header is the primary place a user reads "what am I sorted by". It is
allowed to disagree with the query silently.

A sort direction is valid exactly when the driver accepts it: `1`, `-1`,
`"asc"`, `"desc"`, `"ascending"` or `"descending"` (case-insensitive, EJSON
numbers included), or a `{ $meta: "<string>" }` document. `parseSortString`
draws an arrow only for the first six, `sortProblem` refuses anything outside
all seven at the Run gate, and the index suggestion reads the sort through
`parseSortString`.

### 3.3 Multi-field sort is hand-typed JSON only, and the docs point at a deleted surface — P1

`cycleSortField` (`builder.ts:171-176`) replaces the entire sort with a
single-key object on every header click. There is no shift-click to append, no
reorder, no per-field direction control.

The comment above it (`builder.ts:168`) reads:

> The full sort editor remains the way to compose multi-field sorts ().

**That tracked item is closed**, and its acceptance criterion "Existing sort editor still
works for multi-field sorts" was invalidated by W13 §7, which deleted that
editor. The comment now points at a surface that does not exist, and the
capability it promised has no owner. A user who wants
`{ status: 1, createdAt: -1 }` must type it by hand into an unlabelled input
with no autocomplete and no validation (§3.1, §3.4).

### 3.4 No field autocomplete on sort — P1

Same as §2.3, same available machinery, same omission.

---

## 4. Limit and skip

### 4.1 `limit` silently coerces junk to "no limit" — P1

`builder.ts:229-235`:

```ts
const parsedLimit = state.limit.trim() ? parseInt(state.limit.trim(), 10) : null;
const limit = parsedLimit !== null && Number.isFinite(parsedLimit) && parsedLimit > 0
  ? parsedLimit : null;
```

`0`, `-3` and `abc` collapse to `null` = **no limit**. The comment correctly
explains *why* (`.limit(0)` means "no limit" to the driver) but the UI never
tells the user. `type="number" min={1}` (`QueryBar.tsx:524-532`) is advisory —
nothing enforces it on commit.

A user typing `0` to mean "none" gets a full page. That is the opposite of
what they asked for, with no feedback of any kind.

Trailing junk is a *second*, different outcome. `parseInt('5xyz', 10)` stops at
the junk and returns `5`, which is finite and positive — so `5xyz` runs **with
limit 5**, not with no limit. An earlier draft of this section listed it
alongside `0` and `-3`; that was wrong, and saying "no limit" for both would
have replaced one untrue statement with another. The fix implements the two
outcomes as two distinct messages (`limitWarning` in `builder.ts`), and §11's
Tier 1 criterion is met by that split, not by a single message.

### 4.2 `limit` means "cap across all pages", and nothing says so — P2

`effectivePageLimit` (`builder.ts:298`) treats the user's limit as a total
budget: page 2 of a limit-10 query returns fewer rows, past the cap
`useQueryRunner.ts:143-153` short-circuits to an empty result, and
`useQueryRunner.ts:202` clamps the displayed `totalCount` to the limit.

That is a defensible design. It is also indistinguishable, from the UI, from
"the query broke on page 3". The label is one word: `limit`.

**Fix.** The limit input is described, to a hovering mouse, a focused keyboard
and a screen reader alike (the same Tooltip + visually-hidden pattern as skip,
§4.4): "Total across all pages. Queries stop after 30 s; results over 50 MB
are refused." The Result bar also states the limit that really applies beside
the count (`limit 10`) and says nothing when the limit is blank or coerced to
none (§4.1). The sentence and the numbers live in `queryCaps.ts`, and a unit
test pins them to the ceilings the main process enforces, so the wording can't
drift from the behaviour.

### 4.3 The server caps limit at 1000 invisibly — P2

`QueryService.ts:33`: `const limit = Math.min(input.limit, 1000);`. A user who
asks for 5000 gets 1000, with no notice anywhere in the UI.

**Resolved by finding it unreachable.** The page-size selector tops out at 500
(`PAGE_SIZE_OPTIONS`) and `effectivePageLimit` never returns more than the page
size, so the 1000 clamp can no longer fire from the UI; it stays as a guard on
the IPC boundary. The ceilings a user *can* hit are the limit as a total
budget (§4.2), the 30 s query timeout and the 50 MB result cap, and those now
fail with a message that says what to change: `TIMEOUT` reads "The query was
stopped after 30 s. Add an index or narrow the filter.", and a result over the
cap is a `VALIDATION` error reading "The result is larger than 50 MB. Add a
filter, a projection, or lower the rows per page." (W03 §7).

### 4.4 `skip` explains itself only on hover, to a mouse — P2

`QueryBar.tsx:509-520` wraps a `<span>` in a Tooltip reading "Skip is driven
by the page selector below the results". The span is not focusable, so
keyboard and screen-reader users never receive the explanation — they get a
number in a grid cell labelled `skip` that does not respond to typing, with no
stated reason.

There is also no way to set an ad-hoc skip without paging to it.

---

## 5. The advanced row's inputs have no accessible names — P1

`QueryBar.tsx:446, 473, 507, 522` render the labels as plain `<div>`s:

```tsx
<div style={labelCellStyle}>projection</div>
```

The inputs carry `data-testid` and a placeholder, and nothing else — no `id` +
`<label htmlFor>`, no `aria-label`, no `aria-labelledby`. A screen reader
announces three unnamed text fields. The drawer, by contrast, uses Mantine
`TextInput` with explicit `aria-label` throughout (`BuilderPane.tsx:330, 386`).

Related, and still open from W14 §2: that spec required verifying a visible
`:focus-visible` style on the `role="button"` disclosure trigger
(`QueryBar.tsx:355-364`) "rather than assumed". The component defines none —
it inherits whatever the browser does with a styled `<div>`. Nothing in the
repo confirms it renders.

---

## 6. Three different ways to choose fields, none of which mention each other — P1

| Control | Scope | Persisted in | Effect |
| --- | --- | --- | --- |
| `projection` (query bar) | the query | tab `state_json` | **server-side** — changes what is fetched |
| Preview fields (`PreviewPicker`, header) | the collection | `prefs` per collection | Tree-view preview line only |
| Column chooser (`ColumnChooser`, result bar) | the tab | tab `columnConfig` | Table-view columns only |

Three controls, three scopes, three persistence stores, three different places
on screen, all answering the question "which fields do I want to see". None of
them references the others. A user who hides a column in Table view and then
switches to Tree view sees it again. A user who sets a projection and then
opens the column chooser sees a list of only the projected fields with no
explanation of why the rest vanished.

This is the single largest "the user has to think about it" cost in the
Documents view, and it is invisible in any single-feature review because each
control is individually reasonable.

> **Since resolved:** the three became one Fields control in the result bar;
> projection is its separate "fetch" section (W14 §4), and a field the
> projection excluded is listed as "not fetched" rather than vanishing.

---

## 7. Dead and stale surfaces

### 7.1 "Set default" writes a preference nothing reads — P1

`Workspace.tsx:2247-2257` writes
`query.default.<connectionId>.<dbName>.<collection>` on click. A repo-wide
grep for `query.default` returns **that write and nothing else**. No reader
exists in `src/`, `electron/`, or `shared/`.

The button also gives no feedback — no toast, no pressed state, no indication
a default exists, no way to clear one. It is a labelled button in the primary
toolbar, beside Run and Save, that has no observable effect whatsoever.

### 7.2 The stale sort-editor comment — P2

Covered in §3.3. Listed separately because the fix is a comment edit plus a
decision about who owns multi-field sort, not a code change on its own.

### 7.3 `DeleteConfirm`'s `{_id: 0}` guard — P2

`DeleteConfirm.tsx:95` guards a state §2.2 shows the UI cannot produce. Keep
the guard — the shell (W11) and scripts (W12) can produce such documents — but
its comment cites a find projection as the example, which is currently
impossible. Correct the example or make §2.2 true.

---

## 8. Direction

Ranked by "how much thinking does removing this save the user", not by effort.

**Tier 1 — the query lies or dead-ends.** §7.1 (Set default does nothing),
§2.1 (advice to use a surface that does not exist), §3.1 (sort has no
client-side validation), §4.1 (limit silently inverts the user's intent),
§1.1 (Copy code emits invisible clauses). Each is a case where the app tells
the user something untrue. None is large.

**Tier 2 — the user must already know MongoDB.** §2.3 + §3.4 (no field
autocomplete on projection or sort, with the machinery already built and
already wired three inches away), §5 (no accessible names), §2.2 (`_id`
cannot be excluded), §3.3 (multi-field sort is hand-typed JSON with no owner).

**Tier 3 — structural.** §6 (three field-choosers), §1.2 (the drawer does not
mention where sort and projection went), §4.2/§4.3 (limit semantics and the
server cap are unstated).

**Presentation (§13) cuts across all three.** Its P1s belong with Tier 1 —
`SavedStrip`'s per-row `↗` carries an `aria-label` for behavior it does not
have (§13.3), Recent's rows show everything except the query (§13.4), Reset
destroys a tree with no confirm (§13.1) — all are cases of the pane
misrepresenting itself, same as Tier 1's. The rest is Tier 2 polish, mostly
single-line fixes, and is worth batching into one pass rather than trickling.

**On W14 §4 — the structured-projection decision.** W14 deferred it
pending real use, correctly. This audit does not overturn that, but it changes
the shape of the question: the gap is not "text input versus chips", it is
that projection lacks the *two* things the filter has — completion and an
escape hatch. §2.1 and §2.3 deliver both without a chip UI and without
extending the inclusion-only model. Decide that after those ship, not before.
If a structured editor is built later, it should share one control with sort
(both are field-list-plus-modifier editors) rather than arriving as a third
independent widget in a row that already has too many.

> **Decided (W14 §4):** after §2.1 and §2.3 shipped, projection stayed a text
> field — completion plus the §9(b) raw escape, no chip UI — and moved out of
> the advanced row into the result bar's Fields control, as a divided "Fetch
> only these fields from the server" section beside the display-only
> show/hide list. That is also §6's answer for projection: one control for
> "which fields do I see", with the server-side choice visibly separate from
> the display-only one and each explained in one line. The advanced row keeps
> sort, skip and limit.

**Recommended sequencing**: Tier 1 as one small PR (it is mostly deletion and
message edits), Tier 2 as a second (one shared autocomplete-backed field input
serving projection and sort, plus labels), Tier 3 as its own spec — §6 in
particular is a design question, not a bug list.

---

## 9. Types

Nothing in §8 Tier 1 changes a type.

Tier 2's `_id` exclusion (§2.2) and raw projection (§2.1) do. Two options,
both renderer-side, neither touching the wire:

- **(a) Widen the model**: `BuilderState.projection: string[]` becomes
  `{ fields: string[]; exclude?: boolean }` or similar. Breaks the persisted
  shape; needs a read-side shim exactly like W13 §8's `legacyBuilder`.
- **(b) Add a sibling raw field**: `BuilderState.projectionRaw?: string`,
  used verbatim when present and ignored when absent. Additive, so a tab
  saved before the change restores identically, and `formatProjection` /
  `parseProjection` keep their current contracts for the modelled path.

**(b) is recommended** — it is the same shape W13 chose for the filter
(`queryRaw` beside the structured model, raw wins), so the app has one
precedent instead of two patterns.

## 10. IPC contract

**None.** Everything in §1–§7 is renderer-side. `FindInput.projection` and
`FindInput.sort` are already `string`, already carry whatever the compiler
emits, and are already parsed main-side by `parseEjsonField`. No channel is
added, removed, or altered; `scripts/ipc-secret-allowlist.txt` is untouched.

The one item in this area that *does* owe the 5-file contract is `FindInput`
Phase 3, explicitly out of scope per §Scope.

---

## 11. Acceptance criteria

Grouped by tier so a PR can claim one tier cleanly.

### Tier 1

- "Set default" either reads back the preference it writes (restoring
  filter / sort / limit / projection on the next open of that collection)
  or is removed. A button with no observable effect does not ship.
- If "Set default" stays, it reports success, shows that a default exists
  for the current collection, and offers a way to clear it.
- The projection `unmodelable` message names a surface that exists in the
  app, or projection gains the raw passthrough that makes the current
  wording true.
- Typing invalid EJSON in the sort input surfaces client-side, before any
  IPC call, with the same treatment the filter gets (Run gated + inline
  warning). No sort-only round trip to produce a `VALIDATION` pill.
- A limit of `0`, a negative limit, or trailing junk produces a visible
  inline message stating what will actually run. No silent coercion to
  "no limit".
- **Copy code** reproduces the query as run — including `skip` — or emits
  only the clauses the drawer itself owns. It must not emit values the
  user has no editor for.

### Tier 2

- The projection input offers field-name completion from the same sources
  the drawer's cond rows use, including dotted paths.
- The sort input offers the same completion.
- `{_id: 0}` is expressible through some route in the UI, and the round
  trip preserves it across a tab save/restore.
- Each of projection / sort / limit / skip has a programmatic accessible
  name; a screen reader announces which field it is on.
- The advanced-row disclosure trigger has an explicitly defined, visible
  `:focus-visible` style — asserted by a test, not by inspection (closes
  the item W14 §2 left open).
- Multi-field sort has exactly one documented composition path, and the
  comment at `builder.ts:168` names it. A stale tracker reference and a
  deleted editor are not a path.
- A sort string the table header cannot represent shows *something* in the
  header — the header never silently claims "unsorted" while a sort runs.

### Tier 3

- The drawer states where sort / projection / limit are edited, or hosts
  them.
- `limit`'s across-pages semantics and the time and size caps are
  discoverable without reading the source (§4.2, §4.3).
- Projection, preview fields, and column config each state their scope
  where they are used, and the two that are display-only say so.

### Invariants (all tiers)

- No change to `FindInput`, to any IPC channel, or to the secret
  allowlist.
- A tab persisted before the change restores identically — including one
  whose `builder.projection` is a plain `string[]`.
- W13's fail-closed rule is preserved: no path widens a refused filter,
  sort, or projection into a broader query than the user asked for. In
  particular, a refused *projection* must never silently fall back to
  "return every field" without saying so — the projection analogue of
  that fail-closed hazard.

## 12. Test cases

**Unit** (`tests/unit/`)

1. `compileFindOptions` — limit `'0'`, `'-3'`, `'5xyz'`, `'  '`: assert the
   compiled value *and* that whatever new validation surface Tier 1 adds
   reports each one. Extends `builder-compile.spec.ts`.
2. Sort validation helper: valid EJSON, invalid EJSON, `{ $meta: ... }`, empty
   — the classification that drives §3.1's gate and §3.2's header state.
3. `parseProjection` round trip through `formatProjection` for every accepted
   form, plus the `_id`-exclusion path once §2.2 lands. Extends
   `parseProjection.spec.ts`.

**Component** (`tests/component/`)

4. Invalid sort text → Run disabled (or gated per the chosen design) and an
   inline message rendered; `api.query.find` **not** called. The §3.1
   regression; must fail against current `main`.
5. Limit `0` → inline message; assert the compiled request the runner would
   send. The §4.1 regression.
6. Projection and sort inputs each expose an accessible name
   (`getByLabelText`). The §5 regression.
7. Typing a prefix in the projection input opens the suggestion popover with
   field candidates; selecting one inserts it. Same for sort.
8. "Set default" — asserts whichever contract §11 Tier 1 settles on: either a
   subsequent open restores the stored default, or the control is gone.
9. Copy code with a sort, a limit, and a non-zero page: assert the emitted
   string matches what `useQueryRunner` would actually send.

**Integration** (`tests/integration/`)

10. None required — no IPC surface changes. If §2.1 adds a raw projection
    string, one integration case asserting `QueryService.find` receives it
    verbatim and that a malformed one returns `VALIDATION` rather than an
    unprojected result set.

**E2E** (`tests/e2e/`)

11. One flow: open a seeded collection, set a sort and a limit from the
    advanced row, run, confirm the header indicator matches the sort and the
    pager matches the limit, then reload the tab and confirm all of it
    restored.

---

## 13. Drawer presentation

§1 covered what the drawer *computes*. This section covers how it *presents*.
These are cheap and individually small; they are listed together because the
cumulative effect is the difference between a pane that explains itself and one
that needs a legend.

### 13.1 Filter tab — the tree

- **Two different actions share one icon.** The group header renders three add
  buttons: "Add condition" is `I.plus` (`BuilderPane.tsx:608`), "Add nested
  group" is `I.code` (`:619`), "Add raw clause" is `I.plus` again (`:630`).
  Two identical plus glyphs in one row, distinguished only by tooltip — and
  `I.code` is a `<>` glyph, which reads as "raw JSON", the opposite of the
  action it performs. The raw button is the one that should carry it. **P1**,
  and a five-line fix.
- **Every row carries two Remove controls.** `RowMenu`'s red *Remove* item
  (`:194`) and a separate red ✕ `ActionIcon` (`:359-370` for conds, `:513-524`
  for raw). Same action, two affordances, every row, at both nesting levels.
  **P2**
- **Reset is instant, unconfirmed, and unrecoverable.** `handleReset`
  (`:906-910`) wipes the entire tree and `queryRaw` to `{}` on one click, from
  a footer button sitting beside Save. This is the same class of problem as
  aggregation stage delete with no confirm/undo, applied to a structure that
  can represent arbitrarily much work. **P1**
- **The problems banner is a count with no navigation.** "⚠ N not applied"
  (`:830`) does not name the field or link to the offending row, which may be
  scrolled out of view in a deep tree. The per-row alerts are correct; the
  summary is not actionable. **P2**
- **Drag-and-drop is undiscoverable.** The drop target carries
  `aria-label="Drop a field here to add a condition"` (`:806`) and a hover
  highlight, but renders nothing at rest. A user who never happens to drag a
  field never learns the feature exists. **P2**
- **Conditions cannot be reordered.** Add, duplicate, wrap, remove — never
  move. `insertAt` / `removeAt` already exist; there are no move controls and
  no drag handles inside the tree. On an `$or` this is cosmetic; on a long
  `$and` the reading order is the user's own grouping logic. **P2**
- **Nesting depth is visually flat.** Every non-root group gets the same 3px
  `T.accent` left border (`:586`), so depth 1 and depth 4 are indistinguishable
  at a glance. **P2**
- **The empty tree has no empty state.** A fresh tab shows an AND/OR/NOR
  radiogroup and three icon buttons over blank space — no "add your first
  condition", no hint that the text in the bar above is the same object. It is
  the first thing every new user sees in this pane. **P1**

### 13.2 The tab strip looks like a tablist and is not one — P1

`BuilderPane.tsx:1025-1036` renders three bare `<button>`s with an accent
bottom-border for the active one. No `role="tablist"` / `role="tab"`, no
`aria-selected`, no `aria-controls`, no arrow-key roving. The active tab is
conveyed by color and font-weight alone. Screen readers get three unrelated
buttons; keyboard users get three separate tab stops instead of one.

### 13.3 Saved appears twice, in two different designs — P2

A 4-item `SavedStrip` pinned inside the Filter tab **and** a full `SavedTab`.
Different row markup (Mantine `Group` + `QUE`/`AGG`/`SCR` badges in the strip;
hand-rolled divs in the tab), different actions (strip: Run / show-in-tab;
tab: Run / Delete), no delete in the strip, no badges in the tab.

Two specific defects inside the strip:

- **Every row's `↗` button does the same thing.** It calls `onOpenSavedTab()`
  (`SavedStrip.tsx:226`), which takes no argument and merely flips the tab —
  it does not scroll to or highlight the row. Each button nonetheless carries
  a distinct `aria-label` (`Show "<name>" in Saved tab`) promising
  item-specific behavior it does not have. **P1** — the label states something
  untrue.
- **A permanent legend explains two icons.** "▶ runs here · ↗ opens in tab"
  (`:236-238`) renders unconditionally, including beneath the "No saved
  queries yet" empty state, where it explains actions that are not on screen.
  A legend that must be permanent is evidence the controls are not
  self-describing. **P2**

### 13.4 Recent's rows show everything except the query — P1

`RecentTab.tsx:92-102`. The row's primary content slot — the `flex: 1` div, the
place a row's identity belongs — contains one 10px ghost-colored line of
timestamp, duration, doc count, and error code. The query itself appears
nowhere. Every row is therefore visually identical, and "Run here" is a blind
action: the user re-runs something they cannot identify.

This is the Recent-preview gap noted in §1.5, and the framing there ("no query preview") undersells it. The
slot is not empty; it is filled with the least identifying information
available.

Three smaller ones in the same component:

- **Time without date.** `new Date(item.ranAt).toLocaleTimeString()` (`:94`) —
  a run from last Tuesday reads `14:32`, indistinguishable from one an hour
  ago. **P2**
- **Copy MQL is a silent no-op on legacy rows.** `copyMql` (`:35-39`)
  early-returns when `payload.queryRaw` is absent. The button responds to the
  click by doing nothing, with no message. **P2**
- **No delete, no clear history.** Saved has per-row delete plus a confirm;
  Recent has neither. **P2**

### 13.5 Consistency across the three tabs

- **Hand-rolled buttons using `title` as the accessible name.** Run / copy /
  delete / retry in both `SavedTab` and `RecentTab`. `title` is not an
  accessible name for an icon-only button. Covered broadly elsewhere (see §1.5);
  noted here because it is the same pane. **P2**
- **A third confirm pattern.** `SavedTab`'s delete opens a hand-rolled
  `role="alertdialog"` overlay (`SavedTab.tsx:187+`) rather than Mantine or the
  repo's own `DeleteConfirm` component. Meanwhile Reset (§13.1) has no confirm
  at all. Another instance of confirm-pattern proliferation, in miniature,
  inside one pane. **P2**
- **Three different loading/error shapes.** `SavedStrip` renders an inline
  "Loading…" and keeps its chrome; `SavedTab` and `RecentTab` each replace the
  entire pane with a centered message, losing the tab strip context. Switching
  to Recent while it loads blanks the pane. **P2**

### 13.6 No keyboard path to the drawer — P2

Collapse and expand happen only through `DividerNotch`. There is no shortcut
and no command-palette entry — `GlobalCommands.tsx` registers theme, settings,
nav, and connection commands, nothing for panes. `expandBuilder` exists and is
invoked programmatically by the History button; a user cannot invoke it.

### 13.7 Acceptance criteria for this section

- The three add-buttons in a group header are mutually distinguishable
  without reading a tooltip.
- Each row offers exactly one Remove affordance.
- Reset either confirms or is undoable.
- The "N not applied" banner names or navigates to the offending rows.
- An empty filter tree renders an empty state that says what to do next.
- The drawer's tab strip implements the tablist pattern: `role`,
  `aria-selected`, `aria-controls`, and arrow-key roving as one tab stop.
- No control carries an `aria-label` describing behavior it does not have
  — specifically `SavedStrip`'s per-row `↗`.
- A Recent row shows what was queried, and its timestamp disambiguates days.
- Copy actions report success, and never silently no-op.
- "builder configuration" is gone from user-facing copy — W13 renamed the
  tab to Filter and deleted the builder model (`SavedStrip.tsx:152`,
  `BuilderPane.tsx:1106`).
- Loading and error states preserve the tab strip rather than replacing
  the pane.

## 14. What's missing — capabilities, not defects

§1–§13 are things that are wrong. This section is things that are absent. It
is a proposal, not a mandate, and it is ordered by value-per-unit-effort with
a bias toward what the codebase can already do but doesn't.

The recurring theme: this app already computes almost everything needed to
make query-building fast — sampled schemas with type histograms, field
frequencies, operator documentation, index lists, a live result set — and the
drawer consumes almost none of it.

### 14.1 Value autocomplete — designed in full, never built — P1

> **Correction on first reading.** This section originally proposed value
> autocomplete as a new idea. It is not. `docs/field-suggestions-roadmap.md`
> → "Value suggestions" specifies it completely — two sources
> (`lastRunValuesSource`, `recentValuesSource`), the exact consumer ("the
> **value** input in `BuilderPane.tsx` (`CondRow`)"), the dotted-path and
> array-element rules, the display-string invariant, a LOC estimate, and the
> unit-test list. The third, deferred tier is tracked separately. The finding
> is therefore **not** "nobody thought of this" but
> "it was specified to implementation detail and the consumer it was written
> for still has a bare `TextInput`". That is a stronger finding, not a weaker
> one.
>
> Two stale details in that roadmap worth fixing when it is picked up: it
> proposes migration `005-recent-field-values.sql`, but `005` shipped as
> `005-reference-rules.sql` and the next free number is **010**; and its
> `CondRow` line citation predates W13's rewrite of the component.

`src/features/fieldSuggestions/sources/index.ts:27`:

```ts
/** Reserved for value sources; empty until the first consumer lands. */
export const DEFAULT_VALUE_SOURCES: readonly ValueSource[] = [];
```

The `ValueSource` type (`types.ts:65`), the `rankValue` scorer
(`useSuggestions.ts`), and the dispatch branch at `useSuggestions.ts:129` all
exist. There is no source implementation and no consumer. Meanwhile the
CondRow's value input (`BuilderPane.tsx:404-412`) is a plain `TextInput` with
no suggestion wiring at all — the field input and the op input each get a
popover; the value input, the one where the user is least likely to know the
answer, gets nothing.

Filtering `status` requires knowing the enum. Filtering `type`, `role`,
`state`, `category` — same. This is the most common single act in a database
GUI and it is unassisted.

**Cheapest useful version costs no IPC**: a value source over
`suggestionContext.recentDocs` — already populated from
`state.lastRun.documents` (`BuilderPane.tsx:888`) — offering the distinct
values of the selected field from the current result set, ranked by frequency
exactly as fields already are. It is wrong at the margins (it only knows the
page you fetched) and right the overwhelming majority of the time.

A `query.distinct` channel would make it authoritative. That is a 5-file IPC
change and should be its own ticket; it should not block the free version.

### 14.2 Index awareness — the thing that separates a Mongo GUI from a JSON form — P1

The drawer knows nothing about indexes. `index:list` already exists
(`shared/ipc.ts:379`) and `IndexesTab` already consumes it.

Two changes, neither large:

- **Mark indexed fields in the field autocomplete.** When the user is picking
  between `email` and `emailLower` and one is indexed, that is the entire
  decision. Today nothing says so.
- **A passive unsupported-filter hint on the tree root.** The top-level field
  set of the tree, checked against the index list, catches the obvious
  collection-scan without any round trip.

`ExplainDrawer` exists and is good, but it is diagnosis: buried in a
split-button menu, run on demand, returning a plan document to read. This is
prevention, at composition time, for the case that does not need a planner.

### 14.3 Type-aware value editors — P1

The problem as first written, before the editors shipped (kept for history):

Every `valType` shares one plain text input. The consequences differ by type:

- **`date`** — the user hand-types an ISO-8601 string. No picker, no relative
  ranges. "Last 7 days", "this month", "before today" are the most common date
  filters in existence and each requires computing a literal timestamp by hand
  and pasting it. For a database tool this is the sharpest gap in the list
  after §14.1.
- **`array` / `$in` / `$nin`** — the value must be hand-typed valid JSON
  (`["a","b"]`). `$in` is among the most-used operators and currently demands
  the user get bracket-and-quote syntax right in a 100px-tall row with no
  syntax feedback until print fails. A token/chip input removes the class.
- **`boolean`** — a text input accepting the strings `true` / `false`, where a
  segmented control or switch is unambiguous.
- **`objectid`** — 24-hex validity is checkable as you type; today a typo
  surfaces as a print problem.
- **`null`** — the value input is hidden only for `$exists`; for `null` it
  renders an input that means nothing.

`formatCondPreview` (now in `CondValueEditor.tsx`) already knows the shape of
every type well enough to render `ISODate("…")` / `NumberDecimal("…")`. The
editors just never followed.

Shipped: the value editor follows the row's type and operator.

- `$exists` and `null` rows show no value input.
- `$in` / `$nin` / `$all` show the list as chips, whatever the value type.
  - Typing a value and pressing Enter or a comma adds one. A pasted list split
    on commas or new lines adds several. A value that itself holds a comma is
    entered through "Edit as JSON".
  - Each chip has its own named remove button.
  - The chip box offers the same value suggestions as the text input; picking
    one adds it as a chip.
  - What a chip means follows the row's type. In a `string`, `objectid`,
    `long`, `decimal` or `date` row a chip is the text as typed (`007`, a
    19-digit long, an all-digit ObjectId), which the row's type then wraps. In
    any other row `42` is a number and `true` / `false` / `null` are those
    literals. `"42"` in quotes is text in every row.
  - "Edit as JSON" switches to the text input and back. A list a chip can't
    show faithfully keeps the text input: sub-documents, EJSON values such as
    `{"$oid": …}`, integers past 2^53, and anything but text in a `string`,
    `objectid`, `long`, `decimal` or `date` row, where a chip would read back
    as text after the next edit.
  - The chips-or-JSON choice, a half-typed chip and an open date picker belong
    to the row: a row that moves into its slot after a remove, move or undo
    does not take them over.
- A boolean with a comparison operator is a true / false choice. A blank value
  shows as false, and nothing is written until one is picked.
- A date with a comparison operator keeps its text input and adds a "Pick
  date" button. It opens a popover holding a date-and-time input in local
  time and the presets Now, Start of today, 7 days ago, 30 days ago and Start
  of this month.
  - The input works to the minute, so an edit made there drops the value's
    seconds and milliseconds.
  - Edits made in the input are one undo step.
  - In the repeated hour of a daylight-saving fall-back, the input can't tell
    the two hours apart and reads its time as the first one.
- A value the server could not use does not print. The row keeps its last
  good filter text, and the reason shows under the value input as that
  input's description. That covers:
  - an ObjectId that isn't 24 hex characters, alone or in a list;
  - date text that isn't a date;
  - a list item of a number, long or decimal row that a single value of that
    row couldn't be (`abc`, `1.5` for a long, an empty item, `null`);
  - a list item of a boolean row that isn't `true` or `false` (`yes`, `1`,
    `null`), which would otherwise go out as `false`;
  - an empty `$in` / `$nin` / `$all` the user left, which matches nothing (or
    everything) and is never what a list was started for. An empty list
    already in the filter text is valid MongoDB and is not refused: it parses
    to a raw clause, so it prints back as written.

### 14.4 Filter-by-this-value from the result — P1

The Table context menu offers *Copy field path*, *Copy value*, *Duplicate*,
*Edit*, *Delete* — but not **Filter by this value**, and not **Exclude this
value**. That is the fastest path in any data browser: see a row, ask for all
rows like it.

`condFromDragged` (`builder.ts`) already builds a typed `$eq` CondNode from a
field + raw value, with full BSON type inference, and is already wired to the
drawer's drop handler. Two menu items reusing it is close to free, and it also
solves §13.1's discoverability problem — drag-and-drop stops being the only
route from a result to a filter.

### 14.5 Live match count while composing — P2

There is no feedback between editing the tree and pressing Run. A debounced
`api.query.count` against the current filter — the channel exists
(`shared/ipc.ts:224`), it is already fired in the background by the runner
(`useQueryRunner.ts:192-205`), and `countDocuments` carries its own 5s budget —
would show "≈1,240 match" as the user builds.

> **Shipped:** a line under the filter tree reads "≈1,240 match", "Counting…"
> or "Match count unavailable". It counts the committed filter text — the one
> Run would send — half a second after the last edit, so a row the printer
> refused is never counted. It asks nothing for an empty filter, while a
> "not applied" banner or the invalid-text banner shows. After a count times
> out, that collection is not counted again for the rest of the session, on
> any filter, across tab switches, Reset and Saved or Recent loads; any other
> failure is unavailable for that filter text only, and the next edit asks
> again. A response that arrives after a newer request was sent is ignored.


The value is not the number; it is catching "0 match" while the mistake is
still on screen, instead of after a Run that returns an empty table.

The guards that shipped: no count while the tree has print problems, and the
timeout latch above for a collection too large to count in the budget.

### 14.6 Undo / redo on the tree — P2

`filterTree`'s edit API (`updateAt` / `insertAt` / `removeAt` / `wrapInGroup`)
is pure and returns a new root each time. A bounded history stack is close to
free, and it is the right mitigation for §13.1's unconfirmed Reset — cheaper
and less annoying than a confirm dialog.

Shipped: the drawer keeps a bounded, in-memory undo/redo history of its tree, with buttons in the root group's header (W13 §5.7). Reset keeps its confirm, since a Reset remounts the drawer and the history goes with it.

### 14.7 Schema-driven mismatch warnings — P2

`summarizeSchema` (`schemaSummary.ts`) already computes per-field type
histograms with frequencies, and `SchemaView` already renders them. If the
sample says `status` is 100% `string` and the user sets `valType: number`, the
row can say so.

The design precedent is the op-versus-type advisory that W04 §2b and X03
specify from `FIELD_OPS` (the applicability table); no code shows that
advisory today. This is the value-versus-schema half, from data already
computed, and it stays advisory — sampling is not a constraint.

Shipped: a condition whose value type disagrees with the sample shows a line
under the row, such as "Sample: status is string in 100% of documents that
have it". The share is of the sampled documents that hold the field. It
uses the same ≥90% dominance rule as the document editor's warning (W17) and
the same cached sample, so every row of a collection shares one fetch, and a
row with a blank field asks for none. It stays silent where the comparison
means nothing:

- `$exists`, `$type`, `$regex`, `$all` and the other operators that don't
  compare one value;
- `null`, `regex` and array values;
- a field the sample shows as an array, which matches by element;
- number against long or decimal.

A `$in` / `$nin` list is checked by its first non-null element, as it is sent.
The line is advisory and never blocks printing.

### 14.8 Starter templates — P2

Nothing seeds a common shape. Saved queries cover per-collection reuse but
ship empty, so a new user's first filter is built from an empty tree with no
examples. A short built-in list — last 7 days, field exists and is non-null,
case-insensitive contains, `$in` over a pasted list — would double as
documentation for the operators behind them, which `operators.ts` already
documents in prose.

Shipped: an empty filter offers four starters under its "No conditions yet"
note: Last 7 days (`$gte` on a date), Exists and is not null (`$ne: null`),
Contains text (any case) (`$regex` with the inline `(?i)` flag) and One of a
list (`$in`, edited as chips). Each button's tooltip names its operator. A
starter adds one row with a blank field and puts the caret in it, so nothing
reaches the filter text until the field is named (and, for One of a list,
until the list holds a value). A read-only tree offers
none.

### 14.9 First-class negation — P2

`$not` degrades to a raw node (W13 §2). `$nor` exists at group level, `$ne`
at the field level. "NOT this whole condition" — wrapping an arbitrary
subtree — has no control, so a user's only route is hand-writing raw JSON for
a shape the tree could otherwise represent.

Shipped: any row or nested group can be negated from the drawer, which wraps it in a one-child `$nor` shown as NOT and removable in one click; a NOT, a top-level one included, reads back from the filter text as the same NOT group (W13 §2, §4).

### 14.10 Sequencing

§14.1 and §14.4 are the two that change how the pane feels for the least work,
and both reuse code that already exists. §14.3's date editor is the largest
single gap by user impact but is genuinely new UI. §14.2 is the one that makes
this tool feel like it understands MongoDB rather than JSON.

Nothing here should start before §8 Tier 1 — there is no point making it
faster to compose a query while `Set default` does nothing and sort accepts
text it cannot run.

## 15. Issue map

Removed. This section mapped spec sections to issue numbers and to "not yet
filed" placeholders, and it went stale the moment either side moved — at one
point it still listed §13 as unfiled a month after that work had shipped.

The live mapping is GitHub Issues. Searching the repository for `W15` finds
them; note that GitHub's search tokenizer drops `§` and the decimal, so
`W15 §2.1` returns nothing — search the spec id alone and read down.
