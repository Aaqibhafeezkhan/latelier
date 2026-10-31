# X16 — Multi-connection Data View

> **Status: Implemented.**

## Purpose

Let a person work against several MongoDB servers at once. Today the Data View browses exactly
one **Active Connection**; switching to another closes the first one's tabs. Comparing Prod with
Staging means losing your place, twice.

This spec retires the Active Connection. Connection identity moves onto the tab, so one shared
tab strip can hold tabs from different Connections and the navigator can hold a root per
Connection.

Decided in [ADR 0006](../docs/adr/0006-multi-connection-data-view.md), which supersedes ADR 0001's
scope choice. Vocabulary — **Open Connection**, **Dormant Connection**, **Focused Tab** — is
defined in [CONTEXT.md](../CONTEXT.md). The UI shape was chosen from four prototype variants on
branch `prototype/multi-connection`; variant BS won.

## Scope

**In**

- Remove the single-active policy from `MongoPool` so several Connections stay connected.
- A Cancel action on a Connection that is still connecting.
- One navigator root per Connection, as an accordion: one root expanded at a time.
- The Connection's colour as a spine down its navigator section and its strip chip.
- One shared tab strip, tabs grouped by Connection behind a named chip; drag is constrained
  inside a group.
- Dormant Connections: restored tabs and a greyed root with no data.
- Disconnect confirms, closes that Connection's tabs, removes its root.
- Read-only marker on the tab and on the root.
- A failed connect surfaces on the root, with Retry, and closes nothing.
- Retire `ui.workspace.activeConnectionId`.

**Out**

- A `workspace_tabs` migration. `is_active` and `position` stay global and stay correct — see
  §5.
- A restore-tabs-on-launch setting. De-scoped; tracked separately (P2, S).
- Per-Connection tab *groups* as a data model. Grouping is presentation only.
- Any change to read-only enforcement. It stays in the main process, per ADR 0005.
- SSH tunnelling. Still not implemented; no per-connection port allocation exists to revisit.

## Dependencies

- [ADR 0006](../docs/adr/0006-multi-connection-data-view.md) — the decision.
- [ADR 0005](../docs/adr/0005-read-only-connection-enforcement.md) — read-only stays main-process.
- [F05](./F05-mongo-client-pool.md) — the pool this changes.
- [W01](./W01-workspace-shell.md), [W02](./W02-db-collection-navigator.md) — the surfaces.

## 1. Where the single Connection is enforced today

**Corrected during implementation: three places, not two.** This section originally named
the first two below. The third was found only by trying to delete the other two and discovering
that tabs from a second Connection still would not survive.

**The pool.** `MongoPool.connect()` runs a preemption loop that disconnects every other
`connected`/`connecting` entry before starting this one. The pool is otherwise already keyed by
id — a `Map<string, Entry>`, with `getClient(id)`, `getDb(id, db)`, `disconnect(id)`. Every
main-process service already takes a `connectionId`.

**The renderer, which is the real one.** On every switch, `Workspace.tsx` awaits
`closeAll(keepConnectionId)` — whose semantics are "close all tabs *except* this Connection's"
 — behind a generation token and an in-flight refcount. Deleting the pool loop alone
changes nothing a user sees, because the renderer closes the other Connection's tabs anyway.

**The tab openers, which nothing named.** `closeTabsForOtherConnections` in
`src/state/workspaceTabs.ts` closed every other Connection's tabs after *each* `openCollection` /
`openAggregation` / `openScript`, with a comment citing "the 'one live connection at a time' product
decision". Deleting the pool loop and the switch teardown is not enough: with this in place, opening
a tab on B still closes A's, so "tabs from two Connections coexist in the strip" stays unreachable.

The preemption loop is not free to delete. Its comment records why it exists: connecting to B
force-closes a hung connect to A, which drains the driver's topology wait queue and makes the
stuck `client.connect()` reject at once. §4.3 replaces that escape hatch deliberately.

## 2. The model

A Connection is in exactly one of four states.

| State | Live client | Navigator root | Tabs |
|---|---|---|---|
| Saved | no | none | none |
| Open | yes | expandable, browsable | live |
| Dormant | no | collapsed, greyed, **no data** | present, click to wake |
| Connecting / Failed | pending / no | root present, shows progress or the error | unchanged |

Transitions:

- Switcher click, tab click on a Dormant tab, or expanding a Dormant root → **connects**.
- Connect succeeds → Open. Connect fails → the root shows the error with Retry; nothing closes.
- Connect hangs → Cancel calls `disconnect(id)`.
- Disconnect (the button) → confirm → tabs close, root removed → Saved.
- Drops on its own (network loss, server restart) → **Dormant**. Tabs survive.
- Launch → the Focused Tab's Connection connects; every other Connection with tabs → Dormant.

**Disconnect (the button) and disconnected (the state) do deliberately different things.** An
explicit action gets an explicit consequence; a failure preserves the user's place. There is no
confirmation to show for a network blip, and closing six tabs because Wi-Fi dropped is the
opposite of what this change is for.

## 3. User stories

1. As a developer, I want Prod and Staging connected at the same time, so that I can compare a
   document in one against the other without losing my place.
2. As a developer, I want each Connection to have its own navigator root, so that I can see what
   servers I am working against without opening a menu.
3. As a developer, I want one tab strip rather than one per Connection, so that ⌘-tabbing through
   my work does not depend on which server I am pointed at.
4. As a developer, I want each tab to say which Connection it belongs to, so that I never run a
   query against the wrong server.
5. As a developer, I want that label to be a name and not only a colour, so that two Connections
   in the same palette family stay distinguishable.
6. As a developer, I want tabs of the same Connection to sit together in the strip, so that the
   strip stays readable at a dozen tabs.
7. As a developer, I want a tab to stay in its own Connection's group when I drag it, so that a
   drop lands where I dropped it.
8. As a developer, I want only one navigator root expanded at a time, so that five Connections do
   not fight over the navigator's height.
9. As a developer, I want the Connection's colour carried down its navigator section, so that the
   tree and the strip read as one key.
10. As a developer, I want a Connection with no live client to look plainly different, so that I
    can tell at a glance which servers I am actually attached to.
11. As a developer, I want a Connection that has dropped to keep its tabs, so that a Wi-Fi blip
    does not destroy an afternoon's work.
12. As a developer, I want to click a tab of a dropped Connection and have it reconnect, so that
    recovery is one click and not a re-navigation.
13. As a developer, I want my tabs back after a relaunch even when they span three servers, so
    that quitting is not a decision.
14. As a developer, I want launch to stay fast however many Connections had tabs, so that
    reopening the app is never a wait on an unreachable host.
15. As a developer, I want a Connection that is still connecting to offer Cancel, so that a
    typo'd host does not lock me out for thirty seconds.
16. As a developer, I want a failed connect to explain itself on the Connection it failed for, so
    that I know which of my five servers is down.
17. As a developer, I want a failed connect to close nothing, so that a transient outage costs me
    nothing.
18. As a developer, I want to retry a failed connect from where the error is, so that I do not
    have to find the switcher again.
19. As a developer, I want clicking a Connection in the Switcher to just connect it, so that the
    app does not guess a Database and Collection on my behalf.
20. As a developer, I want the Switcher to show which Connections are connected, so that it
    doubles as the answer to "what have I got open".
21. As a cautious operator, I want Disconnect to tell me how many tabs it will close before it
    closes them, so that I do not lose work to a mis-click.
22. As a cautious operator, I want deleting a Connection to warn me once and not twice, so that I
    read the warning instead of clicking through it.
23. As a cautious operator, I want the read-only marker on the tab I am looking at, so that one
    marker in the title bar cannot lie to me about which server this is.
24. As a cautious operator, I want the read-only marker on the navigator root too, so that I can
    tell which of my open Connections is the dangerous one before I click anything.
25. As a developer, I want the command palette to open a Connection rather than switch to one, so
    that its wording matches what the app now does.
26. As a developer, I want a Dormant Connection to show no Databases and no Collections, so that
    I am never reading a stale tree and believing it is live.

## 4. Behavior

### 4.1 The pool

Delete the preemption loop in `MongoPool.connect()`. Connecting to B leaves A connected. Nothing
else in the pool changes: it is already keyed by id.

The two `'connection canceled'` guards in `getClient`/`run()` stop being dead defence — §4.3
makes them the live Cancel path.

### 4.2 The navigator

One root per Connection, as an accordion: at most one root expanded, and expanding a Dormant root
connects it first.

- The Connection's colour is a spine on the left edge of its whole section — header row and
  expanded subtree alike. Dormant and failed Connections get a muted rail, not their colour, so
  "has a live client" is readable without reading the status word.
- A root renders **no Databases and no Collections** unless its Connection is Open. Gate on the
  existing `isConnected` flag, never on the per-connection cache, which outlives a drop within a
  session. Only the per-Connection *expanded* boolean is persisted, so a launch-restored Dormant
  root has nothing cached to leak.
- A failed connect renders its message on the root with a Retry button. This is the single error
  surface for all three ways in: the Switcher row, a click on a Dormant tab, and expanding a
  Dormant root.
- A read-only Connection is marked on its root.
- Each Open root offers Disconnect (§4.6).

### 4.3 Connecting and Cancel

A Connection in `connecting` shows a Cancel action on its Switcher row and on its navigator root.
Cancel calls the existing `mongo:disconnect` for that id, which force-closes the in-flight client
and drains the driver's wait queue — the same mechanism the deleted preemption loop relied on.
No new IPC channel.

### 4.4 The tab strip

One strip. Tabs are grouped by Connection, each group behind a chip carrying the Connection's
name, its colour spine, and its read-only marker if set. Groups are separated by a visible
divider. "Database" elsewhere in this app's UI language for a group means Connection, not
`CollectionTab.dbName` — a Connection carries the only colour a group or a selected tab's
underline can draw on; `dbName` carries none, and grouping by it would put a Connection's tabs
across several unlabelled, same-coloured groups instead of one.

- Each tab shows its own kind icon, pin marker, label and close control, as today.
- **Drag is constrained inside a group.** A tab reorders among its own Connection's tabs and
  cannot be dropped into another's. A tab's Connection is a property of the tab; dragging is not
  how you would change it.
- Grouping is presentation over the single global `position` order. See §5.
- Tabs of a Dormant Connection render muted and remain clickable; clicking one connects.

### 4.5 The Focused Tab

`is_active` already marks exactly one tab, globally, and the repo already flips it atomically.
That row is the Focused Tab, and its `connectionId` is the answer to "where am I".

- `src/state/activeConnection.ts` becomes the Focused Tab's Connection rather than a separately
  published Active Connection. `PaletteContext` follows.
- The pane of a tab whose Connection is not Open shows a "not connected" state with a Connect
  action, not a stale result grid.

### 4.6 Disconnect, delete, and the Switcher

- **Disconnect** confirms first, naming the Connection and counting its tabs
  ("this closes 3 open tabs and removes it from the navigator"), then closes that Connection's
  tabs and removes its root.
- **Delete** keeps its single existing confirmation, with the tab count added to the body. Two
  dialogs for one action is the thing people click through without reading.
- **A Switcher row click connects only.** It adds an expanded navigator root and opens no tab —
  opening one would mean guessing a Database and Collection. The row's "active" marker becomes a
  "connected" marker.
- Command palette wording: "Switch connection → X" becomes "Open connection → X".
- **Row content in the Switcher and the Connections table.** A connected Connection with a known
  server version shows a small `v{version}` badge. The version is runtime-only and cleared on
  disconnect, so it never shows beside a disconnected row, and topology is not shown for the same
  reason. Connections can be pinned: pinned rows sort first (the rest keep their order), carry a
  pin glyph, and the pins persist in the `ui.connections.pinned` pref, an array of Connection ids
  that drops ids of deleted Connections when read. The pin toggle lives on the Connections
  table's open row (a toggle button named `Pin {name}` whose pressed state is `aria-pressed`; only the hover text flips to Unpin); the Switcher only shows the
  glyph. Grouping connections is not built.

### 4.7 Launch restore

- Restore the tab set as persisted.
- Connect the Focused Tab's Connection only.
- Every other Connection with at least one tab restores **Dormant**.
- Retire `ui.workspace.activeConnectionId` and its restore path. The Focused Tab carries that
  identity. The one case the pref covered and tabs do not — a Connection left connected with no
  tabs — is a Connection that was not being used.

## 5. Types and schema

**No migration.** `workspace_tabs` already stores `connection_id` per row (migration 001), and
`is_active` and `position` are global. Both stay correct under this change:

- `is_active` marks the Focused Tab. There is one, globally, which is what the existing
  `clearActiveStmt` (`UPDATE workspace_tabs SET is_active = 0`) already enforces.
- `position` is the single stored order, and grouping is a render-time concern over it.

  **Corrected during implementation.** An earlier draft of this line claimed the in-group
  drag constraint keeps the rendered order and the stored order *identical*. It does not, and it
  cannot: once two Connections' positions interleave, a stored `c1, c2, c1` renders as
  `c1, c1 | c2`. Gathering every tab of a Connection into one group is required by §4.4, test
  case 9 and user story 6 — the alternative, grouping only consecutive runs, would render two
  chips for one Connection, which those forbid.

  No migration is owed anyway, and the reason is stronger than the claim it replaces: the rendered
  strip is a **deterministic function of the stored rows**, so it survives a relaunch unchanged
  without anything being persisted about groups. What the in-group drag constraint actually
  guarantees is narrower and still load-bearing — that a drag can only ever permute positions
  *within* one Connection's tabs, so a reorder the user performs inside a group is stored exactly
  as it is seen.

Renderer types gain a Connection runtime state — Open / Dormant / Connecting / Failed — derived
from the existing `mongo:status` stream plus "has tabs". No new persisted field.

`app_state` loses the `ui.workspace.activeConnectionId` key. Stale rows are harmless; nothing
reads it after this change.

## 6. IPC contract

**No new channels, no changed payloads.** Everything needed exists: `mongo:connect`,
`mongo:disconnect`, `mongo:status`, `mongo:status-event`, and the `tabs:*` family. Cancel is
`mongo:disconnect`. The change is entirely in what the renderer does with them and in the pool's
policy.

The IPC gate still applies — `npm run audit:ipc` plus the `ipc-channel-auditor` agent — because a
green script is not evidence the contract is whole.

## 7. Implementation decisions

- **`MongoPool`** — delete the preemption loop; keep everything else. Smallest possible change at
  this layer.
- **`src/state/workspaceTabs.ts`** — `closeAll` inverts from "close all except this Connection's"
  to "close this Connection's tabs". The `keepConnectionId` parameter and its empty-local fallback
 go with it.
- **`src/pages/Workspace.tsx`** — the switch machinery is mostly deleted rather than rewritten:
  `switchToConnection`, `switchConnection`, the generation token, the in-flight refcount, and the
  Active Connection derivation. What replaces it is a Connect action and a Disconnect action, both
  of which are ordinary and neither of which coordinates a teardown.
- **`src/pages/Workspace/DbCollectionNavigator.tsx`** — one root becomes N, as an accordion. The
  per-connection cache and per-connection expand pref already exist and stay; the render and the
  empty state are what change.
- **`src/pages/Workspace/TabStrip.tsx`** — grouping, chips, spine, in-group drag.
- **`src/state/activeConnection.ts`** and **`src/commands/PaletteContext.tsx`** — publish the
  Focused Tab's Connection.
- Read-only props keep coming from a Connection record; the record is now the Focused Tab's, and
  the root's badge reads its own. Enforcement is untouched — ADR 0005 keeps it main-process and
  keyed by `connectionId`, so the badge is a label and never the guard.

The prototype (branch `prototype/multi-connection`) is a primary source for the shape, not code to
promote. It was written under prototype constraints — no tests, no error handling — and the winner
is rewritten properly here.

## 8. Testing decisions

A good test here asserts what a person can see: a root is greyed and lists no collections, a tab
survived a drop, a confirm named three tabs. It does not assert that `closeAll` was called with a
particular argument. The existing suite pins the single-Connection invariant partly through call
assertions, which is why it breaks so widely — the rewrite should not reintroduce that.

Three seams, all of which already exist. No new seam.

**Component — `tests/helpers/atelierMock.ts` and the Workspace specs.** The highest seam, and
where most of this lives: N roots, Dormant rendering nothing, the grouped strip, in-group-only
drag, the disconnect confirm, read-only on tab and root, a failed connect on the root.
`activeConnectionPrefs()` in that helper exists for `ui.workspace.activeConnectionId` and
dies with the pref; multi-Connection fixtures replace it. Prior art: the 14 specs that pin the
current invariant, listed in §12.

**Integration — `tests/integration/mongo-pool.spec.ts`.** Two behaviours need real driver
semantics and are invisible at the component seam: two Connections staying connected at once, and
Cancel draining the wait queue so a hung `connect()` rejects. Prior art: the existing pool spec
and `tests/helpers/mongo.ts`.

**E2E — `tests/e2e/active-connection-restore.e2e.ts`.** Launch restore needs a real relaunch
against a real `workspace_tabs` table. That spec is named for the retired concept and is
rewritten, not extended. Prior art: `conn-connect-disconnect.e2e.ts`, `connect-retry.e2e.ts`.

## 9. Acceptance criteria

- Connecting to a second Connection leaves the first connected.
- The navigator shows one root per Connection, with at most one expanded.
- Each root carries its Connection's colour as a spine down its whole section.
- A Dormant root is visibly muted and lists no Databases and no Collections.
- Expanding a Dormant root connects it, then expands.
- A Connection in `connecting` offers Cancel; Cancel makes the in-flight connect reject.
- A failed connect renders its message and a Retry on that Connection's root, and closes no
  tabs.
- The tab strip groups tabs by Connection behind a named chip carrying colour and, if set, the
  read-only marker.
- A tab can be reordered inside its group and cannot be dropped into another group.
- A tab of a Dormant Connection renders muted; clicking it connects that Connection.
- The pane of a tab whose Connection is not Open shows a not-connected state with Connect, not
  a stale grid.
- The read-only marker appears on the tab and on the root, and on neither is it the guard.
- Disconnect confirms, naming the Connection and its tab count, then closes only that
  Connection's tabs and removes its root.
- A Connection that drops on its own becomes Dormant and keeps its tabs.
- Deleting a Connection with open tabs shows exactly one confirmation, with the tab count.
- A Switcher row click connects and opens no tab.
- The Switcher marks connected Connections rather than an active one.
- The command palette offers "Open connection → X".
- At launch, the Focused Tab's Connection connects and every other Connection with tabs
  restores Dormant.
- `ui.workspace.activeConnectionId` is written by nothing and read by nothing.
- No new migration file. No new IPC channel.

## 10. Test cases

**Integration — pool**

1. `connect(a)` then `connect(b)`; both report `connected`.
2. `connect(a)`, then `disconnect(a)` while it is still connecting; the pending `connect` rejects
   rather than running to `serverSelectionTimeoutMs`.
3. `disconnect(a)` leaves `b` connected and its `getDb` still usable.

**Component — navigator**

4. Three Connections, one Open: exactly one root is expandable, the other two render muted with no
   collection rows.
5. Expanding a Dormant root issues a connect for that id.
6. A Connection whose status goes to `error` renders the message and a Retry on its own root; the
   other roots are unaffected.
7. A Connection that drops without a user action keeps its tabs and greys its root.
8. A read-only Connection's root shows the marker; a writable one's does not.

**Component — strip**

9. Tabs from two Connections render in two labelled groups, in `position` order within each.
10. Dragging a tab onto a sibling in its own group reorders it.
11. Dragging a tab onto a tab of another Connection leaves the order unchanged.
12. Clicking a tab of a Dormant Connection issues a connect for that id.
13. The pane for a tab of a non-Open Connection shows the not-connected state, not results.

**Component — destructive paths**

14. Disconnect on a Connection with three tabs shows a confirm naming it and counting three.
15. Confirming closes exactly those three tabs and leaves the other Connection's tabs open.
16. Cancelling the confirm closes nothing.
17. Delete on a Connection with tabs shows one confirm, not two, and it carries the tab count.

**Component — switcher and palette**

18. A Switcher row click connects and adds a root without opening a tab.
19. The Switcher marks every connected Connection, not one active one.
20. The palette lists "Open connection → X" and routes to the same connect action.

**E2E**

21. Quit with tabs across three Connections; relaunch: all tabs return, the Focused Tab's
    Connection is connected, the other two are Dormant.
22. Click a Dormant tab after that relaunch; its Connection connects and the pane fills.
23. Quit with one Connection connected and no tabs; relaunch shows the empty state.

## 11. Out of scope

- A `workspace_tabs` migration — §5 explains why none is owed.
- The restore-tabs-on-launch setting (P2, S), deliberately de-scoped.
- Any change to read-only enforcement.
- Promoting prototype code. The winning variant is rewritten, not merged.
- The dead `poc/connection-switcher-popover` pointer in ADR 0001. Unrelated tidy-up.

## 12. Notes — the tests that pin the old invariant

Fourteen files assert a single Active Connection and are reworked with this change:

`tests/component/codex-review-findings.spec.tsx`, `confirm-convergence.spec.tsx`,
`connection-palette-switch.spec.tsx`, `connection-switcher.spec.tsx`,
`drawer-saved-recent.spec.tsx`, `new-connection.spec.tsx`,
`workspace-active-connection.spec.tsx`, `workspace-open-for-connection.spec.tsx`,
`workspace-palette-connection-commands.spec.tsx`, `workspace-tabs-optimistic.spec.tsx`,
`tests/e2e/active-connection-restore.e2e.ts`, `tests/e2e/helpers/uiSeed.ts`,
`tests/helpers/atelierMock.ts`, `tests/unit/workspace-switch-source.spec.ts`.

`workspace-switch-source.spec.ts` pins a *call count* on `switchToConnection`. That
function is deleted here, so the spec is deleted with it rather than adapted — the invariant it
protected (one call site for switching) stops existing when switching stops being a coordinated
teardown.
