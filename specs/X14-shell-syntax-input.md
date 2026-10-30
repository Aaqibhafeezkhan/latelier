# X14 — Shell Syntax input on the read-query surfaces

> **Status: Implemented** (T1–T5). This spec now describes the application rather than
> proposing a change to it. T1 `src/utils/shellSyntax.ts`,
> T2 Filter Bar, T3 sort and raw projection,
> T4 aggregation stage bodies, T5 error feedback, plus
> follow-up work for the save paths T4 left uncovered. §8's criteria are all met;
> each is cited to a test.
>
> **Two facts about the built shape that the sections below do not make
> obvious.** Every blur/Run wiring reuses `repairOnCommit` — the glue T2
> factored out — rather than re-implementing the repair per surface. The one
> exception is `validateStageBody`: a validator has nothing to commit, so it
> calls `repairToCanonicalEjson` directly.
>
> The transform runs *in front of* the existing shape rules, never in place of
> them. `isEjsonDocument` and `isValidEjson` still refuse what they always
> refused, including a sentinel that is well-formed JSON but not well-formed
> BSON, such as `{"$oid": "nothex"}`, which the transform returns `unchanged`
> and never sees.

## Purpose

Four read-query inputs — the Filter Bar, the sort field, the projection field,
and the aggregation stage bodies — accept only Canonical EJSON. A user who
types the syntax MongoDB itself teaches, `{age: {$gt: 60}}`, gets a disabled
Run button. The app writes starter code its own validator rejects: the `$group`
stage template ships as `{ _id: "$field", count: { $sum: 1 } }`, unquoted keys
and all.

[ADR 0004](../docs/adr/0004-shell-syntax-input.md) settles the direction. This
spec turns that decision into per-surface behavior and acceptance criteria, so
the five tickets have one source rather than five readings of the same ADR
paragraph.

**Read ADR 0004 first.** Its four rejected alternatives carry more weight than
the decision, and one of them — evaluating the AST into JavaScript values —
looks obviously easier until you see what it costs.

## Scope

### In

- The Shell Syntax → Canonical EJSON transform, as a pure renderer module (T1).
- Wiring it into the Filter Bar (T2), the sort and projection fields (T3), and
  the aggregation stage bodies (T4).
- The error feedback that lenient input makes load-bearing (T5).
- The conversion point: on blur and on Run, in the box the user typed in.

### Out

- **The write surfaces** — out of scope *for X14*. `EditDrawer` and
  `InsertDrawer` stayed strict here because they write data, and a misread
  value there corrupts a document rather than returning wrong rows. Deferred
  by ADR 0004 and taken up later, which lifted the deferral once it was
  clear the argument was about the consequence rather than about this
  transform. See ADR 0004's write-surface entry for the condition it landed
  under.
- **General expressions** — arithmetic and anything else that has to be
  computed. They need an expression evaluator, which is a different risk class.
  Deferred by ADR 0004 as the second half of "Tier 3", and **rejected** there
  once the regex-literal work established that the first half never needed an evaluator: regex
  literals (`/^acme/i`) landed as a span copy like every other value, and are
  no longer out of scope. See ADR 0004's Tier 3 entry.
- **Canonical EJSON in what the edit and insert drawers *display*** — UX review
  §4.1. An output-rendering problem on the same two drawers, independent of
  input strictness. Shipped separately, and extended to the aggregation
  output later.
- **Symbolic operators** (`>` for `$gt`) in the Query Builder. A concern on a
  different control, recorded as a boundary in ADR 0004's scope note and left
  unfiled for a long while.
- **Anything in the main process.** No IPC channel, no handler, no wire format
  moves. See §7.
- **Reformatting.** The transform is a repair. Text that already parses
  strictly is returned untouched, spacing and key order intact.

## Dependencies

- [W05](./W05-query-bar.md) — the query bar and its Run gate.
- [W13](./W13-filter-tree-editor.md) — the filter tree, which holds value
  *text* and guards integers at print time. X14 must not undo that.
- [W15](./W15-query-composition.md) — `sortProblem`, `isRawProjection`,
  `findProblem`, `currentFilterJson`. T3 changes what those functions accept.
- [A03](./A03-stage-accordion.md) — stage bodies and `validateStageBody`.
- [ADR 0004](../docs/adr/0004-shell-syntax-input.md) — the decision.

## 0. Where the pieces live today

| Surface | Gate | File |
| --- | --- | --- |
| Filter Bar | `isEjsonDocument(queryRaw)` | `QueryBar.tsx:98`, `builder.ts:539` (`currentFilterJson`) |
| Sort | `sortProblem` → `isValidEjson` + `isEjsonDocument` | `builder.ts:278` |
| Projection (raw) | `isRawProjection` → `isEjsonDocument` | `projection.ts:81` |
| Stage body | `isValidEjson` | `Aggregation/pipeline.ts:229`, `:232` |
| Edit / Insert drawers | `isValidEjson` — **stayed for X14**; later work put the transform in front of it | `EditDrawer.tsx`, `InsertDrawer.tsx` |

Two layers ask each read question, deliberately: the button gates on it, and
`useQueryRunner` re-checks for the paths with no button — auto-run on tab open,
the palette's `query.run`, post-write re-runs. That two-layer shape came out of
earlier work and is not X14's to change.

**`currentFilterJson` is the highest-risk point in this work.** It feeds two
execution flows: the normal query path and the delete-all confirmation. T2 owes
`gitnexus impact currentFilterJson` before any code is written.

## 1. The transform (T1)

One pure renderer module, `src/utils/shellSyntax.ts`, exporting the transform
itself plus `repairOnCommit` — the blur/Run glue T2 added for §2–§4 to share.
T1 shipped wired to nothing; §2–§5 are the consumers.

**The three-way outcome is the interface.** `unchanged` means strict
`JSON.parse` already succeeded, so the caller keeps the user's text as written.
`repaired` carries the new text. `failed` carries a reason and, where the parser
supplies one, a character offset.

**The repair rule lives inside the function.** Four consumers will exist; none
re-implements the "should I repair this?" check.

**A text transform, never a value evaluation.** Parse with `acorn` in
expression mode, walk the AST, and build the output by splicing source spans.
Every literal is copied character for character. This is ADR 0004's
load-bearing decision: evaluation turns `NumberLong("9007199254740993")` into a
JavaScript double, the user gets the neighbouring document, and no error is
raised. It is also what preserves line breaks and indentation, which §4 needs.

**Supported set — Tier 2, plus regex literals.**

| Input | Output |
| --- | --- |
| `/^acme/i` | `{"$regularExpression":{"pattern":"^acme","options":"i"}}` |
| unquoted / single-quoted keys | double-quoted keys |
| single-quoted strings | double-quoted, escapes normalised |
| trailing commas in objects and arrays | removed |
| `ObjectId("…")` | `{"$oid":"…"}` |
| `ISODate("…")`, `new Date("…")` | `{"$date":"…"}` |
| `new Date()` / `Date()` | `{"$date":"<resolved ISO-8601>"}` |
| `NumberLong("…")` or `NumberLong(…)` | `{"$numberLong":"…"}` |
| `NumberDecimal(…)` | `{"$numberDecimal":"…"}` |
| `NumberInt(…)` | `{"$numberInt":"…"}` |
| nested objects and arrays | recursively transformed |

`ObjectId()` with no argument is refused — generating an id inside a query
input is never what the user meant.

**`new Date()` is the one place a value is computed.** It resolves to the
current time and is emitted as an ISO-8601 string, in the box, where the user
can see what the query will mean when they reopen it next week.

**Everything else fails closed.** Template literals, arithmetic, bare
identifiers, property access, function calls the module does not know, spread,
and any unrecognised AST node produce `failed` with a reason naming the
construct. A final `JSON.parse` guard on the spliced result means an unhandled
node can never emit text the rest of the app cannot read.

Regex literals were on that list once and are not any more — they repair.
What still fails is a *flag* MongoDB has no equivalent for: `/^a/g` is refused
by name, because dropping the flag would change what the query means and leave
it looking correct. The accepted flags are `i`, `m`, `s`, `u`, as an allowlist
rather than a denylist — `d` and `v` are unparseable at the module's
`ecmaVersion` today, and a denylist would silently start accepting them the day
that changes.

**No document check.** Whether the result is an object, an array or a scalar is
not this module's concern — that rule lives in `isEjsonDocument` and stays
there.

## 2. Filter Bar (T2)

**Conversion point.** On blur of the textarea, and on Run. Not per keystroke —
a per-keystroke rewrite fights the user mid-word, and the `>` / `>=` prefix
trap in ADR 0004's scope note is the same class of defect.

**Behavior.**

1. On blur or Run, call the transform on `queryRaw`.
2. `unchanged` → nothing happens. The text is not reformatted, reordered, or
   re-spaced.
3. `repaired` → write the repaired text back into `queryRaw` as a normal state
   patch. The user sees their Shell Syntax become Canonical EJSON in place.
   This is the visible half of the invariant, not a hidden normalisation.
4. `failed` → `queryRaw` is left exactly as typed. The Run gate stays closed and
   §5 shows the reason.

**The invariant.** After a blur or a Run, `queryRaw` holds Canonical EJSON or
text the user must still fix. Stored state — `workspace_tabs.state_json`, saved
queries — therefore never holds Shell Syntax.

**What does not change.** `currentFilterJson` keeps its rule exactly:
`isEjsonDocument` on the committed text. It is the choke point for the paths
with no button, including delete-all, and it must stay strictly stricter than
the button. The transform runs *before* it, never inside it.

**The delete-all confirmation shows the Canonical EJSON it will run.** Never a
friendlier rendering of it. A destructive operation does not get a translation
layer.

**Two-way sync is unaffected.** `printFilter` already overwrites the bar with
canonical text on any builder edit (`applyEdit`, `BuilderPane.tsx:951`), which agrees with
the invariant rather than fighting it.

## 3. Sort and projection (T3)

Same conversion point — blur, and Run — on the sort field and on the raw
projection field.

**Behavior.** Identical to §2, applied to `builder.sort` and
`builder.projectionRaw` respectively.

**Order matters.** The transform runs first; `sortProblem` and
`isRawProjection` then judge the repaired text. So `{name: 1}` becomes
`{"name": 1}` and passes, while `[1, 2]` repairs to nothing (it is already
valid JSON) and is still refused by the document test with W15's own message.
The two refusals stay distinct: "can't parse this" and "must be a document" are
different fixes, and conflating them points people at the wrong one.

**One rule between the two raw fields, still.** `sortProblem` and
`isRawProjection` share `isEjsonDocument` today. T3 adds the transform in front
of both, not one.

**Blank stays blank.** An empty sort means "no sort", not "invalid". The
transform reports empty input as `failed`, so the callers keep their own blank
check ahead of it.

A blank *filter* is the exception to "no problem": it is still refused, because
the filter rule is also the Run gate and a blank box must not enable Run,
Explain or delete-all. It gets its own sentence ("Enter a filter, like …")
rather than the parse message, since an empty box is missing a filter, not
holding one that fails to parse.

## 4. Aggregation stage bodies (T4)

**`validateStageBody` stops calling `isValidEjson` directly and routes through
the transform** (`pipeline.ts:229`, `:232`). Both branches — the primitive-body
ops and the rest — get the same treatment.

**This is the ticket that pays off the app's disagreement with itself.** Once
it lands, the `$group` and `$match` templates and the stage-picker help
examples can stay in the friendly dialect they are already written in, and Run
is no longer disabled from the moment the app writes its own starter code.

**Whitespace is the acceptance risk here.** Stage bodies are multi-line and
hand-indented. The transform splices spans rather than reprinting, so line
breaks and indentation survive a repair — but this is the surface where a
regression would be most visible and least caught by a shape assertion. Assert
line counts and leading whitespace, not just the parsed result.

## 5. Error feedback (T5)

Lenient input makes this load-bearing: fewer inputs fail, so the ones that do
must say so clearly.

**Today a broken filter leaves the previous query's count on screen.** A failed
query reads as "139 results". The wrong count is the dangerous half of that
defect, not the missing message.

**Behavior.**

1. An inline message under the offending input, carrying the transform's
   `reason` verbatim.
2. The character offset from `index` locates the problem — at minimum a line
   or column reference, so a typo forty lines into a stage body does not have
   to be found by eye.
3. The stale result grid is dimmed while the input is unrunnable, and the
   result count does not read as current.
4. A refusal names the exact token it cannot keep. The regex case is
   about flags rather than the literal: `/^acme/gi` names `"g"` and `global`,
   so the user deletes one character rather than wondering why nothing matched.
   Dropping the flag quietly would be worse than refusing — the query would run
   and look correct.

## 6. Types

```ts
// src/utils/shellSyntax.ts
export type RepairOutcome =
  | { kind: 'unchanged' }
  | { kind: 'repaired'; text: string }
  | { kind: 'failed'; reason: string; index?: number };

export function repairToCanonicalEjson(text: string): RepairOutcome;
```

A discriminated result, not an exception — the same convention as `parseFilter`
/ `printFilter` in W13.

No other type changes. `CollectionTabState`, `Stage`, and the builder types are
untouched; T2–T4 write repaired text into fields that already exist.

## 7. IPC contract

**None.** ADR 0004 chose input-edge conversion precisely so that no channel,
handler, schema, or wire format moves. Canonical EJSON remains the only thing
that crosses the boundary, and the hand-written parser stays off the trust
boundary.

`acorn` moves into the renderer bundle. It is already a dependency, used in the
main process, and it is pure JavaScript with no Node built-ins, so
`check-renderer-purity.mjs` permits it.

## 8. Acceptance criteria

### T1 — the transform

- Valid Canonical EJSON returns `unchanged`, including nested documents,
  arrays, and every EJSON sentinel. No text is returned for this case.
- Each row of §1's table converts to the exact output text stated.
- `NumberLong("9007199254740993")`, `NumberLong(9007199254740993)`, and a
  bare `9007199254740993` literal all keep every digit. **Asserted on the
  output string.** A test that parses the result reintroduces the double
  conversion the transform exists to avoid.
- A `NumberDecimal` with more significant digits than a double can hold
  keeps all of them.
- A multi-line input is repaired with its line count and per-line
  indentation intact.
- Every `repaired` output parses with `JSON.parse` and with `ejsonParse`.
- Unbalanced braces, bare identifiers, unknown calls, property access,
  arithmetic, template literals, `ObjectId()` with no argument, trailing
  text after a complete value, and empty input each return `failed` with a
  reason. Regex literals moved off this list — they repair.
- The reason for a rejected regex flag names the flag.
- At least one failure carries an `index` pointing into the offending
  region.
- An input containing a call or an assignment is refused and demonstrably
  does not execute.

### T2 — Filter Bar

- Typing `{age: {$gt: 60}}` and blurring leaves `{"age": {"$gt": 60}}` in
  the box, and Run is enabled.
- `{_id: ObjectId("…")}` runs and returns the document.
- Text that already parses strictly is byte-identical after a blur.
- Strict text padded with Unicode spaces `JSON.parse` refuses (NBSP, BOM, em
  space) repairs to its trimmed text, byte for byte. The Run gate
  (`filterProblem`) trims the same way, and `currentFilterJson` sends the
  trimmed text, so Run, the runner, Explain and the blur agree on it.
- A failed transform leaves the text as typed and Run disabled.
- `queryRaw` in `workspace_tabs.state_json` never holds Shell Syntax after
  a blur or a Run.
- `currentFilterJson` still refuses `[1,2]`, `null` and blank text.
- A blank filter box is refused with its own message ("Enter a filter, like
  …"), not the parse message, and Run stays disabled. Blank sort still
  means "no sort".
- The delete-all confirmation shows the Canonical EJSON that will run.
- `gitnexus impact currentFilterJson` was run and recorded before the code
  was written.

### T3 — sort and projection

- `{name: 1}` in the sort field repairs and runs.
- `[1, 2]` in the sort field is still refused, with the shape message and
  not the parse message.
- Blank sort still means "no sort".
- `{_id: 0}` in the raw projection repairs and runs.
- The button gate and `useQueryRunner`'s re-check agree on every case —
  one rule, two layers.

### T4 — stage bodies

- The shipped `$group` template validates without editing it.
- Every stage-picker help example validates.
- A repaired multi-line stage body keeps its line breaks and indentation.
- `validateStageBody` no longer reaches `isValidEjson` without the
  transform in front of it. `isValidEjson` is still the second gate, inside
  `bodyProblem` — it is what refuses a sentinel that is well-formed JSON and
  malformed BSON, which the transform returns `unchanged` and never sees.

### T5 — error feedback

- A failed input shows its reason inline, under that input.
- The message locates the problem by line or column.
- The stale result count is not presented as current while the input is
  unrunnable.
- `/^acme/gi` produces a message naming the `g` flag. (`/^acme/i` no longer
  produces a message at all — that repair handles it.)

## 9. Test cases

**T1 — unit only.** A pure string-to-outcome function: every test is a literal
input and an assertion on the outcome. No mocks, no DOM, no database. Tests
assert on the returned outcome and text, never on how the AST was walked — a
rewrite onto a different parser should leave every test passing. `ejson.spec.ts`
and `filter-tree.spec.ts` are the house prior art for round-trip assertions and
for `mustParse` / `mustPrint` style helpers on a discriminated outcome.

**T2–T4 — component.** Each surface gets a test that types Shell Syntax, blurs,
and asserts both the repaired text in the input and the Run gate. `queryRaw`
persistence is integration, through the tab-state path.

**T5 — component**, plus one e2e that a failed filter does not leave a stale
count reading as current.

**Two tests that must not be "simplified".**

1. The precision tests assert on output **strings**. Parse-and-compare passes
   against an implementation that silently loses digits, which is the exact
   defect the whole design exists to prevent. Verified by mutation: replacing
   the raw-text copy with an evaluated value must turn a test red.
2. The whitespace tests assert line counts and leading whitespace. A shape
   assertion cannot see indentation loss.

## 10. Deferred, and owed as issues — all now closed

ADR 0004 stated these were "tracked as their own issues" while none was filed.
They were filed and cleared on the `feature/adr0004-completion` run.

| Item | Outcome |
| --- | --- |
| ~~Tier 3 syntax — regex literals, general expressions~~ | Split. Regex literals shipped (no evaluator needed); general expressions rejected in ADR 0004 |
| ~~Lenient input on `EditDrawer` / `InsertDrawer`~~ | Shipped. The deferral rested on the consequence of a misread value, not on this transform; conversion happens in the box on blur, so the canonical text is on screen before the write |
| ~~UX review §4.1 — canonical EJSON in what the drawers *display*~~ | Shipped as a lossless-subset renderer (bson's relaxed mode is not lossless), and extended to the aggregation output later |
| ~~Symbolic operators in the Query Builder~~ | Not in this table originally, and filed nowhere else either — ADR 0004 recorded the design as a scope note. Shipped, then corrected: the resolution ran on blur only, so Enter left the symbol in place |
