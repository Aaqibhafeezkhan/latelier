# W14 — Query bar advanced row: correctness, affordance, projection

> **Status: Implemented.**

## Purpose

W13 §7 made the query bar the **single owner** of sort / limit / projection by
deleting the drawer's duplicate editors. That was the right call, but it removed
a safety net that had been masking two defects in the surviving owner:

1. The advanced row's open/closed state is computed **once, at first mount**, and
   never resyncs. After the first tab, whether it is open bears no relation to
   whether the tab actually has advanced values set.
2. The projection input **silently discards** the user's typed text when it fails
   to parse — contradicting the null contract `parseProjection` was written to
   honor.

Both predate W13. Neither mattered much while the drawer carried a second,
always-correct copy of these fields. Post-W13 the advanced row is the only
surface, so a wrong or hidden advanced row is now a wrong query with no second
opinion available.

This spec covers the correctness fixes, the missing affordance, and the
projection editor's parity gap with the filter tree.

> **Since decided (§4):** projection no longer lives in the advanced row — it
> moved into the result bar's Fields control. Where §1–§3 and §7–§8 say
> "projection / sort / limit", the advanced row now carries sort / limit
> only; §3's draft contract moved with the input and holds there unchanged.

## Scope

- **In**: `advancedOpen` lifecycle, a persistent indicator that collapsed
  advanced values exist, `commitProjection`'s draft-retention contract, inline
  validation feedback for projection, and the decision on whether projection gets
  a structured editor.
- **Out**: Saved / Recent tab restyling (Mantine + `aria-label` parity) and the
  Recent tab's missing query preview — real, P2, pre-existing, and unrelated to
  the advanced row; separate tickets. `ReferenceDrawer`'s fixed `width={380}`.
- **Since added (§9):** the `FindInput` additions (`collation` / `hint` /
  `maxTimeMS` / `readPreference`), W13 §Scope's Phase 3, as an options row in
  the advanced region.

## Dependencies

- W13 (single owner for sort/limit/projection — the precondition for this spec
  mattering), W05 (query bar), W09 (saved queries), W10 (recent).

---

## 1. The `advancedOpen` defect

`QueryBar.tsx:143-147`:

```ts
const hasAdvanced =
  state.builder.projection.length > 0 ||
  state.builder.sort.trim() !== '' ||
  state.builder.limit.trim() !== '';
const [advancedOpen, setAdvancedOpen] = React.useState(hasAdvanced);
```

`useState(hasAdvanced)` consumes `hasAdvanced` as an **initial value only**.
Three facts make this permanent rather than merely stale:

- `QueryBar.tsx` contains **zero** `useEffect` — nothing resyncs `advancedOpen`.
- `<QueryBar>` is mounted at `Workspace.tsx:2245` with **no `key`**, so it never
  remounts on tab switch.
- The only writer is `toggleAdvanced` (user click / Enter / Space).

So `advancedOpen` is fixed for the lifetime of the Workspace, decided by whatever
the first tab happened to look like.

`BuilderPane.tsx:1044` already solves this exact problem for the drawer with
`key={`${meta.tabId}:${loadGen}`}` (W13 §5.6). The advanced row needs the same
treatment.

### Reproduction

1. Open a collection tab with no sort / limit / projection → `advancedOpen`
   initializes `false`.
2. Switch to a second tab, or load a Saved query into the current tab, whose
   `builder.projection` is set.
3. The projection that is about to run is set, and the row that would show it is
   collapsed, with no indication anything is there.

The inverse is equally wrong: first tab has a sort, so the row opens; every
later tab shows an expanded, empty advanced grid.

### Required behavior

`advancedOpen` MUST re-derive from `hasAdvanced` whenever the underlying tab or
its builder values change — on tab switch and on a Saved/Recent load — while
preserving a user's explicit toggle **within** a tab. An explicit collapse must
not be undone by an unrelated re-render.

Implementation is open (a `key` on `QueryBar` mirroring `FilterDrawer`, or state
lifted per tab). A bare `useEffect(() => setAdvancedOpen(hasAdvanced), [...])` is
**not** acceptable: it would fight the user's own toggle on every keystroke that
changes `builder`.

---

## 2. The missing affordance

`QueryBar.tsx:293-332`. The disclosure trigger is a `div role="button"
tabIndex={0}` containing a chevron and the text `query`, with
`aria-expanded` / `aria-controls="query-bar-advanced"` correctly wired to the
controlled region at `QueryBar.tsx:370`. Enter and Space are handled.

**Keyboard and screen-reader reachability are correct — this is not an a11y
defect.** The problem is visual: nothing indicates that projection / sort / limit
exist and are hidden. The only hint is a hover tooltip, which does not exist for
touch, and does not exist for a user who never hovers the label.

This row previously had the fix. Commit `43ee030` added an accent dot beside
`QUERY` whenever `!advancedOpen && hasAdvanced`; commit `7a21468` removed it 29
minutes later to match a design mockup, and `1ddd538` later restored only the
chevron rotation. `hasAdvanced` survives in the code with its rendering use
deleted — today it feeds nothing but the broken `useState` in §1.

### Required behavior

When the advanced row is collapsed **and** any of projection / sort / limit is
set, the collapsed row MUST carry a persistent, non-hover visual indicator that
values are hidden. A count ("3 set") is preferable to a bare dot: it survives
monochrome rendering and states the actual fact.

**Error variant.** The sort and limit notices render inside the expanded row, so
a collapsed row used to hide why Run was disabled (an unparseable sort) or that
the limit was being coerced. While collapsed, the indicator also counts the
values that cannot run as written: a sort the bar refuses (unparseable, or
parseable but not a document) and a limit that `limitWarning` flags. With one or
more of those it reads `2 set · 1 error` / `2 set · 2 errors` in the warning
colour instead of the accent; without any it reads exactly `n set`, unchanged.
The count is the same two conditions the notices use, so the badge and the
expanded row cannot disagree. The row is not forced open and collapsing is not
blocked — the badge only has to say a problem exists. The longer text no longer
fits beside QUERY in the label track, so the trigger wraps the badge onto its
own line while an error is shown.

Additionally: verify a visible `:focus-visible` style on the trigger. The app
defines none for this custom `role="button"`, so it currently relies on the
browser default — acceptable if it renders, but it must be confirmed rather than
assumed.

---

## 3. The projection draft-discard defect

`QueryBar.tsx:120-127`:

```ts
const commitProjection = () => {
  if (projDraft === null) return;
  const next = parseProjection(projDraft);
  if (next !== null) {
    onPatch({ builder: { ...state.builder, projection: next } });
  }
  setProjDraft(null);   // runs even when next === null
};
```

`parseProjection` returns `null` for anything the inclusion-only model cannot
express — exclusions (`{a: 0}`), `$slice`, malformed input. Returning `null`
rather than a lossy parse is deliberate, and its doc comment states the reason:
*so the caller keeps the user's draft text instead of silently dropping fields*.

The caller does not keep it. `setProjDraft(null)` runs unconditionally, the input
falls back to the last committed value via `projValue = projDraft ?? projDisplay`,
and the typed text is gone. No error, no red border, no message. The parser
honors the contract; the component defeats it.

This is the sharpest instance of the asymmetry with the filter tree, which on an
unprintable edit shows an inline `role="alert"` on the offending row
(`BuilderPane.tsx:446-450`, `:530-534`) and **never** discards the edit — the
tree keeps it and only `queryRaw` holds at the last good value (W13 §5.5).

### Required behavior

- On parse failure, the draft text MUST be retained in the input.
- The failure MUST be surfaced inline, with the same `role="alert"` treatment the
  filter tree uses for an unprintable row.
- The message MUST distinguish the two failure causes, because they call for
  different user actions: *malformed input* (fix the text) versus *a valid
  projection this editor cannot model* — exclusions and `$slice` — where the
  correct advice is to use raw MQL, mirroring how `filterTree.ts` degrades an
  unrepresentable clause to an editable raw node rather than rejecting it.

---

## 4. Projection editor parity — decided: a text field, in the Fields control

The filter got a recursive per-row editor with typed values, operator pickers,
and raw-clause degradation. Projection remained a single text input over an
inclusion-only model.

Whether to close that gap is a **product decision this spec records rather than
settles**. §3 is required regardless: retaining the draft and explaining the
failure is correct behavior for a text input and is a prerequisite for any richer
editor. A structured projection editor — field chips with include/exclude
toggles, sourced from `previewKnownFields` which the query bar already receives —
is a larger change whose value depends on how often users hand-write projections.

Recommendation: ship §1–§3 first, then decide §4 against real use. Do not build
the structured editor speculatively.

### Decision

**Projection stays a text field, and it moves out of the advanced row into the
Fields control** (the result bar's one control for which fields you see), as a
separate section headed "Fetch only these fields from the server". No
structured chip editor is built.

Why: the parity gap turned out to be the smaller problem. Three controls
answered "which fields do I see?" — Preview fields, Columns and projection —
and projection, the only one with a server-side cost, sat in a different strip
under a different word, presented as a peer of two display toggles. A field a
projection excluded then dropped out of the column list with no explanation.
Putting the projection *beside* the display toggles, divided from them and each
explained in one line, is what teaches the difference:

- **Show in results** (hide / reorder): display only, instant, nothing is
  re-fetched.
- **Fetch only these fields from the server** (projection): changes what the
  server returns, applied on the next Run.

What moved and what did not:

- The input keeps everything it had: Shell Syntax repair on commit, the
  `projection` / `projectionRaw` split and its W15 §9(b) raw escape, the
  retained-draft messages of §3, and field completion. It commits on blur,
  Enter, and when the control closes; ⌘↵ inside it settles the draft and runs
  (the panel-level ⌘↵ skips dialogs, and the control's dropdown is one).
- Run compiles and sends the projection exactly as before; `BuilderState` is
  unchanged.
- The advanced row keeps sort, skip and limit. Its "n set" count no longer
  counts a projection and a projection alone no longer opens it; the Fields
  button carries its own "projection" badge instead, warn-coloured while the
  projection cannot run as written.
- A field the projection keeps off the wire is listed as "not fetched" rather
  than silently missing — every field the control can name without asking the
  server (the fields in hand, plus any the tab's column config remembers).

## 5. Types

For §1–§4: no new types. No changes to `BuilderState`, `CollectionTabState`, or any
persisted shape. `projection: string[]` and its inclusion-only model are
unchanged.

## 6. IPC contract

For §1–§4: **none**; §9 changes four channel inputs. §1–§4 are renderer-only. No channel is added, removed, or altered,
so the 5-file contract and `scripts/ipc-secret-allowlist.txt` are untouched.

---

## 7. Acceptance criteria

- Opening a tab with no advanced values, then switching to a tab whose
  projection / sort / limit is set, leaves the advanced row **open**.
- The inverse: first tab has a sort, second tab has none → the advanced row
  is **collapsed** on the second tab.
- Loading a Saved or Recent query that has advanced values into the active
  tab opens the advanced row, whatever the row held before: a tab whose row
  already had values and was collapsed by the user opens too. Any load that
  replaces the query wholesale (Saved and Recent run-here, Reset) re-derives
  the row as a tab switch does, so Reset, which empties the values, collapses
  it.
- A user's explicit collapse of the advanced row is **not** undone by editing
  the filter, typing in the query bar, or any other same-tab re-render.
- When collapsed with at least one advanced value set, the trigger shows a
  persistent indicator without hover, stating how many are set.
- When collapsed and a set sort or limit cannot run as written, the indicator
  also states how many errors there are (`n set · m error(s)`) in the warning
  colour, and returns to plain `n set` once they are fixed.
- The trigger keeps `aria-expanded` / `aria-controls` correct, remains
  operable by Enter and Space, and shows a visible focus ring.
- Typing an unparseable projection and blurring **retains the typed text**.
- That failure renders a `role="alert"` message adjacent to the input.
- A valid-but-unmodelable projection (`{a: 0}`, `$slice`) produces a message
  distinct from the malformed-input message, and points at raw MQL.
- A valid projection still commits and clears the draft exactly as today.
- No change to `builder.projection`'s persisted shape; a tab saved before this
  change restores identically.

## 8. Test cases

**Component** (`tests/component/`)

1. Two-tab fixture, tab A with no advanced values and tab B with a projection;
   assert the advanced region is present after switching A → B, and absent after
   B → A. This is the §1 regression and MUST fail against current `main`.
2. Explicit collapse, then patch `queryRaw`; assert the region stays collapsed —
   the guard against a naive `useEffect` resync.
3. Saved-query load with a projection into a tab that had none; assert the region
   opens. A load bringing a different sort into a tab whose row had a sort and
   was collapsed; assert the region opens, while a plain sort edit with no load
   behind it leaves the collapsed row alone.
4. Collapsed + advanced values set → indicator present, with its count. Collapsed
   + none set → absent.
4a. Collapsed with an unparseable sort, a sort that is not a document, a limit
   that coerces, or both a sort and a limit problem → the indicator reads
   `n set · m error(s)` with the right counts and the warning tint. Valid values
   still read exactly `n set`, expanded shows no badge, and fixing the value
   returns the plain count.
5. Enter a malformed projection, blur, assert the input still holds the typed
   text and an `alert` is rendered.
6. Enter `{a: 0}`, blur, assert the draft is retained and the message names raw
   MQL rather than a syntax error.
7. Enter a valid projection, blur, assert it commits and the draft clears.

**Unit** (`tests/unit/`)

8. `parseProjection` returns `null` for exclusions, `$slice`, and malformed
   input, and a field list for each accepted form (strict JSON, unquoted keys,
   bare comma list). Partly covered today — extend rather than duplicate.

**E2E** (`tests/e2e/`)

9. One flow: open two collection tabs, set a projection on the second, switch
   away and back, assert the advanced row reflects the active tab both times.

Note for whoever writes test 1: assert on the presence of the region
(`#query-bar-advanced`) or its inputs, not on the advanced grid's internal
markup, which W13 already reshaped once.

---

## 9. Find options (W13 Phase 3)

The four find options W13 §Scope deferred: `collation`, `hint`, `maxTimeMS`
and `readPreference`. They live in the advanced region, below skip and limit,
because that is where everything the find carries besides its filter is set.

### State

`BuilderState` gains four optional strings, each the text the input holds
(blank is unset): `collation?`, `hint?`, `maxTimeMS?`, `readPreference?`.
They are optional and additive like `projectionRaw`, so tabs and saved rows
from before them restore unchanged. `SavedFindPayloadSchema.builder` accepts
them as optional strings, not the wire enum or number, so a row saved with an
option the builder flags still loads.

### Wire

`FindInput` gains `FindMatchOptions` — `collation?` (an EJSON document as
text), `hint?` (text: an EJSON document is a key pattern, anything else an
index name) and `readPreference?` (the driver's five modes) — plus
`maxTimeMS?: number`. The zod schemas take `collation` and `hint` as strings
and parse them main-side (`parseEjsonDocument`), like `filter` and `sort`;
`readPreference` is a `z.enum`; `maxTimeMS` is an integer of at least 1.

- **Timeout.** `maxTimeMS = min(input.maxTimeMS ?? cap, cap)` with the 30 s
  `QUERY_TIMEOUT_MS` cap. A user value can only lower the cap; a larger one
  is clamped, and the row says it runs at 30000. A find stopped by the user's
  limit names that limit, not 30 s.
- **A read preference no server can serve** fails server selection after
  `serverSelectionTimeoutMS`. Find, count, explain and export name it ("No
  server can serve the read preference secondary: …") as `MONGO_ERROR`, with
  the driver's message in `details`; never `TIMEOUT`, which would say the
  query ran too long and stop the live count asking that collection again.
- **Which ops carry what.** A collation decides which documents match, so
  every op that must see the on-screen set carries collation, hint and
  readPreference: `query:count` (the result bar's total and the drawer's live
  count), `query:explain` (the plan badge and the Explain menu) and
  `query:export`. `query:find` carries all four; `maxTimeMS` is find-only.
- **History.** `recordFind` stores the four options in the recorded builder,
  as it stores `projectionRaw` (collation and hint trimmed as sent, a blank
  one not at all), so a Recent rerun is the run in the list.

### Gates

`findOptionProblems(builder)` names each option that cannot run:

- a collation must be a document, as EJSON or Shell Syntax (X14); it is sent
  repaired to EJSON, so `{locale: 'en'}` runs as typed;
- a hint that starts with `{` must be a document the same way; a quoted hint
  (`"_id_"`, `'_id_'`) is the index name it quotes, sent without the quotes,
  and must be one closed string; any other text is an index name, which only
  the server can check;
- maxTimeMS must be digits only, an integer of at least 1 (`5xyz` and `1.5`
  are refused, not coerced as `limit` is);
- a read preference must be one of the five modes.

`optionsProblem` is the first of them, and `findProblem` includes it, so Run,
⌘↵, Copy code, Open as pipeline, Export all matching and the runner's own
guard all refuse the same states. `queryRunKey` includes the four options.
The drawer's live count idles while `optionsProblem` holds, and the plan
badge's Explain refuses with its message, so a half-typed collation shows no
server refusal.

### UI

Two grid rows, `collation | hint` and `maxTimeMS | read pref`: plain inputs
for the first three (placeholders `{"locale":"en","strength":2}`,
`_id_ or {"a":1}` and `max 30000`) and a native `<select>` whose first entry
is the connection default. Each is named by `aria-labelledby` off its label
cell and has its own `role="alert"` notice, as sort and limit do. The
collapsed badge counts set options and their problems (§2).

### Writes and pipelines

- **Delete and update by filter refuse while a collation or a hint is set.**
  `doc:confirmDeleteMany`/`deleteMany` and `doc:confirmUpdateMany`/`updateMany`
  send only `filterJson`, so with a collation they would act on a different set
  than the one on screen, and with a hint naming a sparse index the screen can
  show fewer documents than the filter matches. `DeleteConfirm` (delete by the
  tab's filter) and `UpdateConfirm` say "Clear the collation to delete/update by
  filter: it would change which documents match" or "Clear the hint to
  delete/update by filter: a hinted sparse index can show fewer documents than
  the filter matches", and disable the confirm. A refused delete asks for no
  count, so its title names no number the filter alone would give. A delete of
  selected documents (by `_id`) or of one document is unaffected. Carrying the options through the
  four doc channels is a follow-up, only if asked.
- **Open as pipeline refuses a collation or a hint**: the aggregate channel
  carries neither.
- **Copy code carries the collation and the hint** in all three languages
  (W04 §Footer); `maxTimeMS` and the read preference are left out, since
  neither changes the documents or their order.

### Acceptance criteria

- A collation `{"locale":"en","strength":2}` makes `{"name":"a"}` match `A` in
  the result, the total and the drawer's live count.
- A hint by index name and by key pattern reaches the plan; an index that does
  not exist is refused by the server as `VALIDATION`.
- `maxTimeMS` 40000 runs with 30000; 2000 runs with 2000; the row says a value
  over 30000 runs at 30000.
- The chosen read preference reaches find, count, explain and export.
- Count, explain and export carry collation, hint and readPreference;
  `maxTimeMS` reaches only the find.
- Each invalid option shows its own notice and disables Run; ⌘↵ is refused
  with "Invalid find option"; the runner refuses one that reaches it.
- A Shell Syntax collation `{locale: 'en'}` and key pattern `{a: 1}` run, sent
  as EJSON; a quoted hint `"_id_"` or `'_id_'` runs as `_id_`, and one left
  open is refused.
- While an option cannot run, the drawer's live count asks nothing and the
  plan badge's Explain refuses with the option's own message.
- A read preference no server can serve is named in the error, as
  `MONGO_ERROR`, never `TIMEOUT`.
- Changing an option changes the run key and asks for a new plan.
- A Recent rerun and a saved query keep the options; a saved row with no
  builder clears the tab's. Recent stores the collation and hint trimmed.
- Reset clears the options along with the sort, limit and projection, and its
  confirm names whichever are set.
- Delete all matching and Update all matching are refused while a collation
  or a hint is set, and a refused delete asks for no count; Open as pipeline
  is refused with a collation or a hint.
- The renderer's `CountInput` type has no `maxTimeMS`, matching the schema.
- Copy code emits the collation and the hint, and neither `maxTimeMS` nor the
  read preference.
- The delete confirm's type-to-confirm input is named "Type <collection> to
  confirm" (N5.2).

### Test cases

- Integration `query-service.spec.ts` (memory-server): collation in find and
  count, a `Long` past 2^53 in the filter beside a collation, hint by name and
  key, an unknown hint, the maxTimeMS clamp and message, readPreference on
  every op (driver spies), an unservable read preference named on every op
  (injected selection error), and find, count, explain and export driven
  through the router with every option.
- Unit `query-schema.spec.ts`, `builder-find-options.spec.ts`,
  `queryRunKey.spec.ts`, `builder-to-pipeline.spec.ts`, `driver-code.spec.ts`,
  `mongo-errors.spec.ts`; integration `recent-query-service.spec.ts`.
- Component `query-bar-find-options.spec.tsx`, plus the delete, update,
  live count, export, explain and runner specs, `result-bar-plan-badge`,
  `workspace-delete-modes`, `saved-legacy-payload`, `workspace-run-hint` and
  the Copy code case in `query-composition-truthfulness`.
- E2E `w14-find-options.e2e.ts`: set a case-insensitive collation, Run, and the
  mixed-case row shows with the count matching.
