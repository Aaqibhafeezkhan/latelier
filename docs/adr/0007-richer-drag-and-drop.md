# Richer drag-and-drop: per-group drop targets replace the single pane-level one

## Status

accepted

## Context

`docs/ux-review-2026-08-09-draft.md` §8.2 ("Richer drag-and-drop") was an accepted-but-unowned
proposal — never filed as an issue. Today exactly one drop target exists: the whole
`BuilderPane` (`BuilderPane.tsx:999-1002`). Every drop, wherever it visually lands, runs
`applyEdit(insertAt(tree.root, [], condFromDragged(dragged)))` — always root
(`BuilderPane.tsx:995`). The drag payload (`DraggedField`, `{field, value}`, over the custom
MIME `DRAGGED_FIELD_MIME`) starts at `DocFieldTree.tsx:121`.

A fact-finding pass ahead of this decision found the review's framing of item 1 was wrong on
one point: nested AND/OR/NOR groups are **already fully supported**, both in the data model
(`GroupNode`, `wrapInGroup`, `insertAt` accepting a `NodePath`, all in `filterTree.ts`) and in
the UI — every row already has a "Wrap in group" menu item, and every group already has an
"Add nested group" button (`BuilderPane.tsx:233`, `:775-785`). Nested-group *targeting* by drag
is therefore an ergonomics gap, not a functional one: the capability exists via click, drag just
can't reach it. ("T2.8 — Query builder ceilings") claims "flat AND/OR only (no
nested groups)" — that claim does not hold and is corrected on the issue as part of this work.

Two other facts shaped scope:
- `$in`/`$nin` values render as a plain JSON-text `TextInput` (`BuilderPane.tsx:544-554`), not a
  chip/list control, and `condFromDragged` (`builder.ts:598-635`) always hardcodes `$eq`. No
  `mergeIntoIn`-style helper exists anywhere in `src/`. Building the `$in`-merge sub-item is new
  code, not just new wiring.
- `ColumnChooser`'s existing drag-reorder uses no `dataTransfer`/MIME at all — it's a plain
  ref-based index swap (`ColumnChooser.tsx:119-141`), a completely separate mechanism from
  `DRAGGED_FIELD_MIME`. The Sort control (`QueryBar.tsx:735-753`) is a single free-text EJSON
  field, not a list of sort criteria, and accepts no drop today.

## Decision

**Build items 1–3 of §8.2 plus the discoverability fix in this pass. Defer items 4 and 5.**

- **Drop-target resolution moves from the pane to each group.** `BuilderPane`'s single
  `handleDragOver`/`handleDrop` pair is replaced by handlers on each recursive `GroupView`,
  using the `path: NodePath` each `GroupView` invocation already carries. DOM event bubbling
  plus `stopPropagation` gives the innermost group under the cursor priority by construction —
  no coordinate/geometry-based resolution is built. This is the load-bearing architectural
  choice future work (items 4 and 5) needs to know about before adding new drop surfaces.
- **Empty-group drop surface lives on the group's header/border chrome**, not the children list,
  so a group with zero children (near-zero height) is still a reachable drop target.
- **Drop-on-existing-row disambiguation is by field name, not gesture.** Same field name as the
  target row → merge into `$in` (only when the target row's op is `$eq`, `$in`, or `$nin` —
  anything else has no sensible "merge into a value list" reading and falls through to
  replace). Different field name → replace that row's field/value. No modifier key, no
  split-drop-zone.
- **The "Add to filter" discoverability fix always adds at root** — no group-picker in the
  context menu. A context menu has no "hover the group you want" gesture the way drag does;
  building one is disproportionate to what this fix is for.
- **An earlier finding is corrected**, not just commented on: the "flat AND/OR only (no nested groups)" bullet
  is struck from its body, since nesting already works by both measures (data model and UI), and
  its `L` effort estimate should not be priced against work that doesn't need doing.

**Deferred, with the design decisions already made so a future ticket doesn't re-litigate them:**

- **Item 4 — drop targets on Sort and `ColumnChooser`.** Sort drop *replaces* the
  single sort field. **Answered (Sort shipped):** a drop always sets **ascending**. That is
  also the first step of the column header's sort cycle, but a drop never continues the
  cycle: it never flips or clears, so re-dropping the field already sorted cannot silently
  remove the sort. The `ColumnChooser` half is obsolete and was not built.
- **Item 5 — multi-field drag makes an OR group.** Larger effort. **Decision:
  true multi-select drag**, not a modifier-key single-field shortcut — the user explicitly chose
  this over the leaner alternative during grilling. A user selects multiple fields in
  `DocFieldTree`, one drag gesture serializes the whole selection into one `dataTransfer`
  payload, and the drop wraps them in an OR group. Prerequisite, not yet built: multi-select
  state in `DocFieldTree` (open question left for that ticket: ctrl/cmd-click toggle, and
  whether shift-click range-select is in scope).

## Considered Options

- **Coordinate-based drop-target resolution** (`elementFromPoint` or geometry against each
  group's `getBoundingClientRect`) — rejected. No such helper exists today, and it would be new
  machinery built from scratch where the recursive component tree already carries the exact
  `NodePath` each group needs, for free, via ordinary React props.
- **Modifier-key-only multi-field drag** (item 5) — rejected by the user in favor of true
  multi-select. Native HTML5 drag-and-drop carries exactly one `dataTransfer` payload per
  gesture, but that payload can itself encode an array, so true multi-select drag does not
  require any new browser primitive — only new selection state in `DocFieldTree`.
- **Drop-zone split (top half replace, bottom half merge) for item 2 vs. 3** — rejected in favor
  of field-name disambiguation. A same-field drop reads naturally as "add this value to what's
  already there"; a different-field drop reads naturally as "replace." A pixel-precise split
  zone adds a discoverability problem index item §8.2 was already trying to fix.

## Consequences

- `BuilderPane`'s `dropHover` boolean (pane-wide) becomes per-group/row highlighting. First cut
 gave each `GroupView`/row its own local `dropHover` state; a further revision
  (see Addendum below) replaced that with a single `activeDropPath` shared across every level.
- Items 2 and 3 depend on item 1's per-group handler refactor landing first — not just by value
  ordering, but because "which row/group did this land on" is exactly what item 1 builds.
- `mergeOrReplaceDragged`, `condFromDragged`'s new companion for "drop lands on an
  existing row", gains a code path that does not always return `op: '$eq'` — a merge target
  needs to read and rewrite an existing row's value, not only construct a fresh one.
  `condFromDragged` itself stays a pure "fresh `$eq` from a dragged field" constructor, used by
  both the drop-into-empty-space path and as `mergeOrReplaceDragged`'s own replace fallback.

## Addendum (reviewer findings)

Three points a reviewer raised against the implementation, resolved without revisiting the
decisions above:

- **Highlight mechanism, again.** Two rounds of a `dragLeave`-based per-group guard
  each got a different edge case wrong — `dragleave` fires on target change like `mouseout`, and
  its `relatedTarget` doesn't reliably distinguish a real exit from a hand-off to a nested drop
  target (jsdom doesn't even wire `relatedTarget` through by default, so tests built on it
  encoded an assumption rather than an observation). That revision replaced the per-group `dropHover`
  booleans with one `activeDropPath: string | null`, lifted to `FilterDrawer`: each level's
  `onDragOver` simply overwrites it to its own path (no "leave" detection needed — the next
  level's claim is what un-highlights the last one), every `onDrop` clears it, and one
  document-level `dragend` listener clears it for every level at once when a drag ends for any
  other reason. This is a strictly better implementation of the same "per-group highlight"
  consequence above, not a change to the drop-target-resolution decision itself.
- **The always-visible `+` strip.** W15 §13's UX pass (this session) added a small dashed `+`
  target at the bottom of every group's own children, inside the children list — a deliberate
  addition on top of "empty-group drop surface lives on the header/border", not a replacement of
  it. The header/border area is still every group's real drop target regardless of children
  count (that's what keeps an empty group reachable, and it's what the `dropHover`/
  `activeDropPath` highlight lights up); the strip is a purely visual affordance so a user can
  see, before dropping, which specific group (root vs. a given nested one) is about to receive
  the drop, addressing user feedback that the ambient whole-group highlight alone didn't make
  that legible.
- **`FilterDrawer`'s pane-level fallback `onDragOver`/`onDrop`.** These were not reintroduced
  drop-target *resolution* — they exist because the "N not applied" and read-only banners render
  as siblings of the root `GroupView` inside the same outer wrapper, not as its descendants, so a
  drop landing exactly on a banner never reaches any `GroupView`'s own `stopPropagation()`'d
  handler. The wrapper's fallback only ever fires for an event no `GroupView` already claimed,
  and always resolves to the root group — it is the mechanism that keeps this ADR's own
  "no drop should land outside every group's DOM node" invariant true, not an exception to it.
