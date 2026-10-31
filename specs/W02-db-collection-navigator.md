# W02 — DB / collection navigator sidebar

> **Status: Implemented.** [X16](./X16-multi-connection.md) supersedes §1b's single active connection. The status lists in §10 predate later work: some "Deferred" items have since shipped, others have not.

> **Amended 2026-04-22.** v2 grows the action surface to match MongoDB Compass's parity features (context menus on every row type, destructive-action convention, optional hover action bar). Additions are gated behind new IPC channels (see §12) and new sub-specs (see §13). The amendment keeps multi-connection deferred.

> **Partly superseded by [X16](./X16-multi-connection.md).** X16 retired the single-connection
> model this spec assumes throughout: the "one connection browsed at a time" policy,
> `browsingConnectionId` (§1b), `MongoPool`'s single-active-connection preemption loop, and
> `tabs.closeAll()` (renamed `closeForConnection`, now scoped to one Connection's tabs). The
> navigator renders **one root per Connection** as an accordion — see X16 §4.2. §1b in full, the
> "Connection dropdown" row and "Multi-connection drawer... stays deferred" bullet below describe
> the pre-X16 behavior and are historical. Row/menu/keyboard/context-menu content in §2–§13 is
> otherwise unaffected and still accurate.

## Implementation status (as of v2.2)

Snapshot of what's currently shipped in `src/pages/Workspace/DbCollectionNavigator.tsx` and surrounding code. Every row below maps to a section in the spec; use this table to skip straight to the relevant section if you're auditing.

| Capability                                          | Status         | Notes                              |
|-----------------------------------------------------|----------------|------------------------------------|
| Tree rendering (connection / db / coll / view / ts) | ✅ live         | §1, §7                             |
| Filter (with force-load of unexpanded DBs)          | ✅ live         | §4                                 |
| Click modifiers (plain / Cmd / Alt / right-click)   | ✅ live         | §5.1                               |
| Context menu — connection row                       | ✅ live         | §5.2; Disconnect/Reconnect/Refresh/Edit live; "Copy connection string" live through `conn:getUri`, without the password |
| Context menu — DB row                               | ✅ live         | §5.2; Create collection, Refresh, Copy DB name and Drop database are all live |
| Context menu — collection/view/ts row               | ✅ live         | §5.2; Open, Copy, Import documents, Rename (collections), Modify view (views) and Drop are all live |
| Hover action bar on DB rows                         | ✅ live         | §5b; Create collection and Refresh collections |
| Destructive-action modal convention                 | ✅ live         | §5c; Drop collection / view and Drop database confirm by typing the name |
| Connection tree node (Path 2)                       | ✅ live         | §7; status dot tracks `mongo.onStatus`; Reconnect menu item surfaces when not connected |
| `aria-level` (1 / 2 / 3) + `aria-expanded` + `aria-selected` | ✅ live | §9                                 |
| Keyboard nav: ↑ / ↓ / ← / → / Enter / Home / End    | ✅ live         | §9; extras (`*`, letter type-ahead) deferred |
| Auto-expand + scroll-to-active                      | ✅ live         | §6                                 |
| Persistent connection-expanded state                | ✅ live         | `prefs.set('ui.workspace.navigator.connExpanded:<id>', …)` |
| Skeleton placeholders                               | ✅ live         | §8; simple greyed pills, not count-sized |
| Clean-slate on connection switch                    | ✅ live         | §1b (new this iteration)           |
| Connection dropdown (switch-to-other-connection)    | superseded     | See [X16](./X16-multi-connection.md) — shipped as one navigator root per Connection, not a dropdown |
| Inline error card per-DB (`listCollections` failure)| ❌ not built    | §8; only top-level `listDatabases` error is surfaced |
| Sub-specs W02a / W02b / W02c / W02d                 | ❌ not authored | §13                                |
| IPC: create / drop / rename collection, drop database, modify | ✅ live | §12; shipped as `collection:create`, `collection:drop`, `collection:rename`, `database:drop` and `collection:modify` rather than the `mongo:*` names below |

Legend: ✅ shipped · 🚧 partial / aspirational · ❌ deferred.

## Purpose

The left sidebar in the workspace that shows the connection's databases and collections as an expandable tree. Clicking a collection opens it in the active area (same tab or new, per Cmd/Ctrl modifier). Every row type (DB, collection, view, timeseries, optional connection) carries a context menu with the actions typical for that type, and may surface a small hover action bar for the most common ones. Stays lightweight — no doc counts or size info on rows — because C07 already covers that rich view.

## Scope

- **In**: Tree UI, filter, click handlers, integration with `tabs:openCollection`, auto-expand to current collection, keyboard tree navigation, **context menus on connection, DB and collection rows (incl. view / timeseries variants)**, **destructive-action confirmation flows (drop DB, drop collection, rename collection, disconnect)**, **creation flows (create collection)**, **hover action bar on DB rows (§5b)**, **first-class connection tree node (§7)**.
- **Out**: Rich collection stats (C07), multi-connection drawer (deferred; Path 2 connection node lays the groundwork but only one connection is active at a time), Atlas/CSFLE/performance-metrics/non-genuine-MongoDB concepts (do not apply), MongoDB shell integration, per-row color codes beyond the connection dot, virtualized rendering.

## Dependencies

- W01 (tabs), C07 (meta IPC), F05.
- **New IPC channels (§12)**: `mongo:dropCollection`, `mongo:dropDatabase`, `mongo:renameCollection`, `mongo:createCollection`.
- **New sub-specs (§13)**: W02a (drop-collection confirm), W02b (drop-database confirm), W02c (rename-collection modal), W02d (create-collection modal).

## Terminology

- **Row kind**: one of `db`, `coll`, `view`, `timeseries`, `connection` (last is conditional on §7 Path 2).
- **Default action**: the action triggered by plain click / Enter on a row (DB → toggle expand; coll/view/timeseries → open with `reuseExisting: true`).
- **Destructive action**: any action that mutates or deletes server-side state (drop, rename, create). Always modal-gated; see §5c.

---

## 1. Layout

Width 206 px (matches mock), full vertical height of the content area, scrollable independently. Resizable via F05 ResizeHandle (160–560 px, persisted via `prefs.set('ui.workspace.leftWidth', …)`).

```
┌──────────────────────────┐
│ [🔍 Filter…]       [↻]   │
│ ────────────────────────  │
│ ▾ ● Production           │
│   ▾ 🗄 downlink      5   │
│      ≡ journalEntry      │
│      ≡ order             │
│      👁 latestOrders VIEW│
│      📈 metrics      TS  │
│   ▸ 🗄 config        1   │
└──────────────────────────┘
```

Row height ≈ 24 px. The connection is the top-level tree node (Path 2 — see §7); DBs are its children, collections are grandchildren. Each row type renders a leading type icon (connection dot / DB / coll / view / timeseries); non-standard collections (`view`, `timeseries`, capped) also carry an uppercase badge at the end of the row. DB rows also carry a hover action bar on the right (§5b).

---

## 1b. Connection-switch behavior

The navigator shows the databases of **one** connection at a time. Which connection it shows is governed by a single piece of state in `Workspace.tsx`, `browsingConnectionId: string | null`, not by the active tab's connection.

### `browsingConnectionId` — source of truth for the navigator

```ts
const [browsingConnectionId, setBrowsingConnectionId] = useState<string | null>(null);

// Navigator + NewTabPicker receive this, not `active?.connectionId`.
const navConnectionId =
  browsingConnectionId ?? active?.connectionId ?? connections[0]?.id ?? null;
```

### Two rules that govern it

1. **Sync on tab activation.** When the user activates a tab, `browsingConnectionId` is set to that tab's connection. The navigator follows whichever tab you last clicked.
2. **Clean slate on "Open workspace" from another connection.** When the user arrives at `/workspace` with `state.openForConnection = B` (triggered by clicking "Open workspace" from B's detail panel in the Connection Manager), and the current active tab is on a different connection A, the workspace:
   - Calls `tabs.closeAll()` — every existing tab is closed (single-connection policy).
   - Sets `browsingConnectionId = B`.
   - **Does NOT open the NewTabPicker modal.** The navigator tree is the discovery surface; the user picks a collection from it.

### Why decouple from `active?.connectionId`

Before this model, the navigator read `active?.connectionId` directly. If a user had tabs on A and connected to B, the navigator stayed on A because the active tab was still on A. Combined with `MongoPool`'s single-active-connection policy (connecting B silently disconnects A), the user saw cached A data for a closed connection, and B was invisible.

With `browsingConnectionId`, the navigator can point at B the moment `openForConnection=B` fires, before any B tab exists. Once the user opens a B collection from the tree, a tab activates and rule 1 confirms `browsingConnectionId = B`. Everything lines up.

### Multi-connection path

When multi-connection is picked up (currently deferred), rule 1 remains correct: the navigator follows the active tab. Rule 2 becomes: don't close A's tabs on switch, just update `browsingConnectionId`. The spec change needed is minimal — drop the `tabs.closeAll()` call in the `openForConnection` effect.

### Layout consequence

The workspace now **always** renders the three-column layout (navigator + center + optional builder), even with zero tabs open. The empty-tabs center shows "Select a collection from the sidebar to get started." plus an "Open a collection" button. The navigator is never hidden.

---

## 2. State

```ts
const [caches, setCaches] = useState<Record<ConnectionId, ConnectionCache>>({});
const [connectionExpanded, setConnectionExpanded] = useState<Record<ConnectionId, boolean>>({});
const [expanded, setExpanded] = useState<Record<string, boolean>>({});
const [filter, setFilter] = useState('');
const [focusedId, setFocusedId] = useState<string | null>(null);
const [menu, setMenu] = useState<MenuState | null>(null);

interface ConnectionCache {
  dbs: DbInfo[] | null;
  colls: Record<string, CollectionInfo[]>;
  err: IpcError | null;
  dbsLoading: boolean;
  collsLoading: Record<string, boolean>;
}
```

**Where the state lives.** The tree (caches, expanded root and databases, connect errors) and its two loaders, `loadDbs` and `loadColls`, are owned by the Workspace (`useNavigatorData`) and passed to the navigator as a prop, not held inside it. Two reasons: the navigator unmounts when the sidebar collapses, and the cache must outlive that; and the command palette's `Open: <db>.<coll>` commands (X07 §5) read the same cache instead of fetching their own copy. A navigator rendered without the prop owns a private copy, which is what its standalone tests mount. `filter`, `focusedId` and `menu` stay local to the navigator.

The `mongo.onStatus` subscription that keeps the tree current (connect errors in and out, and the reconnect refresh of previously-expanded databases) moves with the state: the owner of the tree subscribes, so a disconnect and reconnect while the sidebar is collapsed still refreshes what the reopened navigator shows.

The loaders share in-flight requests: a second `loadDbs` for a connection, or `loadColls` for the same database, while one is pending returns the pending one rather than issuing a second IPC call. The navigator's mount effect and the palette's sweep both see an empty cache in the same commit, and the reducer's loading flags cannot stop that.

A refresh that must see a change — the connection-level Refresh, every post-mutation refresh below, and the database list re-read after a reconnect — is a forced load: it never joins a pending request. It issues its own, and the older request's late answer is discarded rather than written over the newer one. A manual per-DB refresh still joins a pending listing, so a double-click costs one call.

Key points:
- Cache is keyed by `connectionId`. Switching tabs within the same connection keeps the cache; switching to a different connection's tab uses that cache.
- `connectionExpanded` tracks whether the connection tree node is expanded. Defaults to `true` the first time a connection becomes active; can be toggled by the user.
- `focusedId` tracks the keyboard focus and is distinct from the active tab's highlight. Arrow-key navigation moves `focusedId`, not the selection.
- `menu` holds the context-menu position and target row; closed on outside-click or Escape.
- Connection status (`connected` / `connecting` / `disconnected` / `error`) is read live from `mongo.onStatus` and drives the connection row's dot color and action-menu contents.

---

## 3. Data loading

- On activate of the workspace (or first render if already active): fetch `meta:listDatabases` for the active tab's connection.
- The first time a DB node is expanded: fetch `meta:listCollections` and cache in `colls[db]`.
- When the active tab's connection changes (switching to a tab on a different connection): the navigator reads from the target cache; no implicit re-fetch.
- **Cache is per `connectionId`.** A "Refresh" affordance (small circular arrow) next to the filter dumps + refetches the whole connection. After the fresh DB list resolves, every DB that was expanded *before* the refresh — except the active tab's DB — has its collections re-fetched too, so previously-populated DBs don't go blank; the active DB's collections are re-fetched exactly once, by the active-DB auto-expand effect, so this loop excludes it to avoid a duplicate `meta:listCollections` call. A previously-expanded DB absent from the refreshed list (e.g. dropped externally) is simply skipped — no fetch, no crash.
- Per-DB refresh (from the DB row context menu) invalidates only that DB's collections; DBs list is not re-fetched.
- **The palette sweep.** While the focused connection is connected, the Workspace lists its databases and every database's collections into this same cache, once per database list (a refreshed list sweeps again; a database whose listing failed is not retried until then). After a reconnect it re-reads the database list (forced) and re-lists every database the status sync did not already refresh, so a database or collection added during the gap appears. While the focused connection is not connected the palette lists none of its collections, even though the cache still holds them. Expanding a database the sweep already filled shows its collections at once; the re-expand background refresh above still runs. Collapsing and reopening the sidebar fetches nothing.

### Post-mutation invalidation

Every destructive / creation action must refresh the relevant cache level on success:

| Action             | Refresh            |
|--------------------|--------------------|
| Create collection  | `colls[db]` for the target DB |
| Drop collection    | `colls[db]` for the target DB, close workspace tabs on that namespace |
| Rename collection  | `colls[db]` for the target DB, rename any open workspace tabs on the old namespace to the new (or close if rename not trivially possible — see W02c) |
| Drop database      | Remove `db` from the DB list, drop `colls[db]`, close workspace tabs in that DB |
| Disconnect         | Reset the whole connection cache |

---

## 4. Filter

Filters collections (not DB names). If a filter is active, **every DB participates**: DBs are visually auto-expanded and a `meta:listCollections` fetch is kicked off for every DB that is not yet cached and not already loading. Once all fetches resolve, DBs with zero matches disappear; DBs with matches show only the matching collections. Matching is case-insensitive substring on `name`.

> Bug-fix note vs v1: v1 expanded every DB visually but never triggered the missing fetches, so a user who filtered before touching any DB saw empty rows. v2 requires the force-load behavior.

---

## 5. Interactions — per row-kind matrix

### 5.1 Click interactions (all row kinds)

| Trigger           | Effect                                                |
|-------------------|-------------------------------------------------------|
| Click DB          | Toggle expansion (fetches collections on first open). |
| Click coll/view/ts | `tabs:openCollection({ reuseExisting: true })` — reuses the active tab if it's a collection tab on the same namespace; else activates the matching open tab; else creates one. |
| Cmd/Ctrl + click coll/view/ts | `reuseExisting: false` → force new tab.   |
| Alt/Option + click coll/view/ts | `tabs:openAggregation` for that namespace. |
| Right-click any row | Open the context menu described in §5.2.            |
| Double-click DB   | Expand + focus first child (optional; stretch).        |

### 5.2 Context menu — action matrix

Every row's context menu is composed from its row-kind entry below plus any inherited parent actions (marked ⇡). Disabled items stay visible with a tooltip ("Coming soon" / "Requires …") so users can see what's possible; they don't silently vanish.

**Status column key** (as of v2.2):  
✅ live — wired in the current build.  
🚧 rendered disabled — the menu entry shows with a "Coming soon" tooltip; the backing IPC and/or sub-spec isn't in place yet.

#### DB row

| Item               | Icon  | Destructive | Status | IPC requirement            |
|--------------------|-------|-------------|--------|----------------------------|
| Create collection  | Plus  | no          | ✅     | `collection:create` |
| Refresh collections| Sync  | no          | ✅     | existing `meta:listCollections` |
| Copy DB name       | Copy  | no          | ✅     | — (clipboard)              |
| ───                |       |             |        |                            |
| Drop database      | Trash | **yes**     | ✅     | `database:drop` |

#### Collection row (standard)

| Item               | Icon      | Destructive | Status | IPC requirement              |
|--------------------|-----------|-------------|--------|------------------------------|
| Open               | Open      | no          | ✅     | existing `tabs:openCollection` |
| Open in new tab    | OpenNewTab| no          | ✅     | existing `tabs:openCollection` |
| Open as aggregation| Play      | no          | ✅     | existing `tabs:openAggregation` |
| ───                |           |             |        |                              |
| Copy name          | Copy      | no          | ✅     | — (clipboard)                |
| Copy namespace     | Copy      | no          | ✅     | — (clipboard, `${db}.${coll}`) |
| ───                |           |             |        |                              |
| Rename collection  | Edit      | no          | ✅     | `collection:rename` |
| Drop collection    | Trash     | **yes**     | ✅     | `collection:drop` |

#### View row

Same as collection row minus Rename (views are immutable by name), plus:

| Item            | Icon | Destructive | IPC requirement                                |
|-----------------|------|-------------|------------------------------------------------|
| Duplicate view  | Copy | no          | ✅ `meta:collectionDetails` for `viewOn` + `pipeline`, then `collection:create` with both verbatim. Opens the "Save pipeline as view" dialog titled "Duplicate view", name prefilled `<view>_copy`; a name already taken (NamespaceExists, a `CONFLICT`) shows inline. Closing with the prefill untouched asks nothing. Creating refreshes the database. The copy keeps the source view's collation (`meta:collectionDetails` returns it as EJSON) |
| Modify view     | Edit | no          | ✅ `meta:collectionDetails` to prefill, `collection:modify` (`collMod`) to save. A dialog with a "Source collection" input and a plain "Pipeline" textarea (resizable), prefilled as readable JSON (`0`, not `{"$numberInt":"0"}`); a pipeline that is not a JSON array is refused inline. Escape, the close button, the backdrop and Cancel ask "Discard changes?" once either field differs from what was loaded, and nothing closes the dialog while a save is in flight. Saving refreshes the database |
| Drop view       | Trash| **yes**     | ✅ `collection:drop` (§12)                      |

#### Timeseries row

Limited variant (MongoDB doesn't support rename on TS collections):

| Item               | Icon      | Destructive | IPC requirement         |
|--------------------|-----------|-------------|-------------------------|
| Open / Open in new tab / Open as aggregation | — | no | existing |
| Copy name / Copy namespace | Copy | no | — |
| ───                |           |             |                         |
| Drop collection    | Trash     | **yes**     | `mongo:dropCollection`  |

#### Connection row

(Path 2 is committed — see §7.)

| Item                  | Icon       | Destructive | Status | IPC requirement           |
|-----------------------|------------|-------------|--------|---------------------------|
| Refresh databases     | Sync       | no          | ✅     | existing `meta:listDatabases` |
| Edit connection       | Edit       | no          | ✅     | existing — route to `/connections/:id` via `onEditConnection` prop |
| Copy connection string| Copy       | no          | ✅     | `conn:getUri` builds the URI in main from the saved connection **without its password**: the username, host, options and TLS flags are kept, the stored secret never crosses IPC or reaches the clipboard. The toast says the password is not included |
| ───                   |            |             |        |                           |
| Disconnect            | Disconnect | **yes**     | ✅     | existing `mongo:disconnect`. Tabs are **not** auto-closed on disconnect — see §14 deliberate choice |
| Reconnect             | Sync       | no          | ✅     | existing `mongo:connect`. Shown in place of Disconnect when current status is not `connected` |

---

### 5a. Context-menu implementation contract

- Actions are authored **once** per row kind in a module like `src/pages/Workspace/Navigator/actions.ts` and consumed by both the context-menu renderer and the optional hover action bar (§5b). Mirrors Compass's `item-actions.ts` pattern.
- Context menu position is anchored to `clientX`/`clientY` of the right-click event, clamped to viewport on overflow.
- Closes on: outside click (mousedown outside the menu), Escape key, or any action being invoked.
- Disabled items render with a tooltip, not suppressed — they're discoverable, which is what users want.

---

### 5b. Hover action bar — **DB rows only**

Compass shows a small row-right action bar on hover/focus with the most common actions for that row kind. Mongo-lab adopts this **for DB rows only**.

**DB-row hover bar actions:**

| Position | Action              | Icon | Status | IPC requirement           |
|----------|---------------------|------|--------|---------------------------|
| 1        | Create collection   | Plus | 🚧 rendered disabled | `mongo:createCollection` → W02d |
| 2        | Refresh collections | Sync | ✅ live | existing `meta:listCollections` — scoped invalidation of `colls[db]` |

Both actions also exist in the DB context menu (§5.2). The hover bar is a shortcut, never a unique surface — single source of truth is the shared `actions.ts` module (§5a).

**Not adopted** on connection, collection, view, or timeseries rows:
- Connection: the only high-frequency action is "Refresh databases", already covered by the toolbar refresh button.
- Collection / view / timeseries: the only unique hover-worthy action ("Open in new tab") is already covered by Cmd/Ctrl-click. A hover bar with one button is visual debt, not lift.

**Implementation contract:**
- Hidden by default. Revealed when the row is focused OR the pointer hovers with `pointer: fine`.
- On `pointer: coarse` (touch): revealed after tap-and-hold; tap alone still triggers default action (toggle expand).
- Keyboard: a focused DB row has its hover-bar buttons reachable via Tab; Escape returns focus to the row.
- Hover-bar buttons share the action definitions from §5a — the same `actions.ts` feeds both surfaces.
- The refresh-collections button on the DB hover bar invalidates only `colls[db]`, not the whole connection cache (distinction vs. the top-right refresh button).

---

### 5c. Destructive-action convention

Applies to every `Destructive: yes` entry in §5.2. Author every destructive flow to follow this convention; don't re-invent per action:

1. **Always modal-confirmed.** No toast-with-undo, no silent commit. Modal is dismissible with Escape and cancellable by button.
2. **Type-to-confirm** for DB-level and any multi-collection destructive action (drop DB). The confirm button is disabled until the user types the exact DB name. Collection-level drops *may* use a simple "Drop" / "Cancel" confirm depending on sub-spec; sub-spec authors pick.
3. **Error surface stays in the modal.** On `mongo:*` failure, show the error inline and keep the modal open so the user can retry or cancel. Do not close on error.
4. **Post-success side effects** (all required):
   - Close any workspace tabs pointing at the dropped/renamed namespace.
   - Refresh the relevant cache level (see §3 "Post-mutation invalidation").
   - Pop a short-lived success toast (F-series toast pattern; if no such pattern exists yet, spec author should flag it as a dependency).
5. **No bulk destructive actions** in v2 (drop many collections at once is out of scope; close as duplicate of W-series bulk ops if requested later).

---

## 6. Auto-expand & scroll-to-active

- The connection tree node is **auto-expanded** the first time a connection becomes active. User collapse is sticky (persisted via `prefs.set('ui.workspace.navigator.connExpanded:<id>', …)`).
- The DB of the **active tab's collection** is automatically expanded and the row highlighted.
- On activation of a tab, the navigator scrolls so the collection is visible (`scrollIntoView({ block: 'nearest' })`).
- If the active tab's collection is hidden by the current filter, scrolling is skipped; the active highlight still applies to the DB row.
- If the connection is collapsed at activation time, the navigator expands it before scrolling so the active collection is actually visible.

---

## 7. Connection tree node

The connection is the top-level tree node, not a static header. v1's "connection label" row is replaced by an expandable/collapsible `role="treeitem"` with `aria-level={1}`.

### Structure

```
▾ ● Production         ← connection row (this section)
  ▾ 🗄 downlink    5   ← DB row (§5.2)
    ≡ journalEntry    ← collection row
```

### Connection row contents

- **Disclosure chevron** (▾ / ▸) — expand / collapse the connection.
- **Status dot** — color from `mongo.onStatus`:
  - `connected` → `T.greenDot` (or `connectionColor` if set)
  - `connecting` → muted yellow (`T.warn` or similar)
  - `disconnected` / `error` → `T.red`
- **Connection name** — from `Connection.name`, bold.
- **DB count badge** — number of databases (right-aligned, muted text, only when expanded and `cache.dbs` is loaded).

### Interactions

- Click row (not chevron): toggle expand.
- Click chevron: toggle expand (same effect; just a distinct hit target for a11y).
- Right-click: Connection context menu (§5.2).
- No hover action bar (see §5b rationale).

### Behavior

- Auto-expanded the first time a connection becomes active (see §6).
- Collapse hides all DB and collection rows beneath it; the connection row itself remains focusable.
- When multi-connection lands (deferred), additional connections render as peer top-level tree nodes; no structural change needed.
- `aria-level` scheme with Path 2 committed:
  - Connection row → `aria-level={1}`
  - DB row → `aria-level={2}`
  - Collection / view / timeseries row → `aria-level={3}`
- Keyboard nav: ArrowLeft from a DB row moves focus to the connection row (its parent); ArrowRight on a collapsed connection expands it.

### Status transitions

- On `connecting` → `connected`: preserve `connectionExpanded` state; if no cache exists, auto-fetch `meta:listDatabases`.
- On `connected` → `disconnected` or `error`: do not auto-collapse. Keep the tree visible (from the last cache), but dim DB/coll rows and disable their context-menu destructive actions. A prominent "Reconnect" affordance appears in the connection row's context menu.
- On `disconnected` → `connected` (reconnect): re-enable actions. Refresh the cache.

---

## 8. Empty / error states

- `listDatabases` error: tree replaced with an inline error card + Retry button. ✅ live.
- `listCollections` error inside an expanded DB: inline error at that depth + per-DB retry. 🚧 **not yet built** — failures silently leave the DB in an empty state and the top-level refresh button is the only recourse.
- No collections in a DB (after fetch): muted "No collections" placeholder at depth 2. ✅ live.
- No databases at all: muted "No databases" placeholder at depth 1. ✅ live.
- Connection status not `connected`: DB and collection rows are dimmed (opacity 0.55) and cached data is retained. The connection row itself stays fully opaque so the Reconnect menu remains obvious. ✅ live.

While any mutation IPC is in flight (drop / rename / create): affected row shows a subtle loading state (e.g., reduced opacity + disabled context menu) until the IPC resolves. Do not block the whole tree. 🚧 — no mutation IPC exists yet, so this isn't exercised.

---

## 9. Accessibility

- Tree uses ARIA `role="tree"` / `role="treeitem"`, with `aria-level` on every treeitem, `aria-expanded` on expandable rows, and `aria-selected` on the active collection.
- Tree container is `tabIndex={0}` with an `aria-label="Databases and collections"`.
- `focusedId` (§2) drives an outline-style focus ring distinct from the active/selection highlight.

### Keyboard map (W02 §9 required)

| Key         | Required? | Behaviour |
|-------------|-----------|-----------|
| ↑ / ↓       | required  | Move focus to prev / next row. |
| →           | required  | If collapsed-expandable: expand. If already expanded: move focus to first child. |
| ←           | required  | If expanded-expandable: collapse. Otherwise move focus to parent. |
| Enter       | required  | Default action (toggle DB / open collection). Modifiers: Cmd/Ctrl → new tab; Alt → aggregation. |
| Home / End  | stretch   | First / last visible row. |
| `*`         | stretch   | Expand all sibling DBs of the current row. |
| any letter  | stretch   | Type-ahead to next row whose name starts with that letter. |
| Space       | required when focused on a hover-bar button | Activate that button. |
| Escape      | required in modal / menu | Close context menu or destructive modal. |

---

## 10. Acceptance criteria

### Met as of v2.2

- Opening workspace with a single-DB connection auto-expands that DB and highlights the active collection.
- Cmd-click opens a duplicate tab; plain click activates the existing tab.
- Alt-click opens an aggregation tab targeting the collection.
- Filter hides non-matching collections and auto-expands DBs; unexpanded DBs are force-loaded when the filter becomes active.
- Switching tabs within the same connection does not re-fetch.
- Refresh button invalidates cache for the current connection only.
- Refresh re-populates every previously-expanded database, not only the active one.
- Right-clicking a collection opens the collection context menu from §5.2 at the cursor, clamped to viewport. Rename and Drop are live.
- Right-clicking a DB row opens the DB context menu from §5.2. Create, Refresh, Copy-name and Drop are live.
- Right-clicking the connection row opens the Connection context menu from §5.2, with Disconnect ↔ Reconnect swapped based on live status.
- View rows show the view icon and `VIEW` badge; timeseries rows show `TS`; a capped collection shows `CAPPED` and the row title "Capped collection".
- `aria-level` is 1 / 2 / 3 for connection / DB / collection; `aria-expanded` is present on connection and DB rows; `aria-selected` is present on the active collection.
- Keyboard map required rows (↑ / ↓ / ← / → / Enter / Home / End / Escape) fully wired across all three tree levels.
- Focused row has an outline-style ring distinct from the active-tab highlight; arrow-key nav does not move the active highlight.
- Hover action bar shows on DB rows on hover/focus with Create and Refresh, both live.
- The connection row is auto-expanded on first activation; user collapse persists across app launches via `prefs`.
- Connection status (`connected` / `connecting` / `disconnected` / `error`) is reflected live in the dot color.
- Navigator switches to the new connection when arriving via `openForConnection`; old tabs close; no NewTabPicker modal (§1b).
- The three-column layout renders even with zero tabs — navigator is always the discovery surface.
- The tab strip follows the mutations: dropping a collection or view closes its open tabs, dropping a database closes every tab on it, and renaming a collection re-points an open tab at the new name.

### Deferred (blocked on IPC / sub-specs)

- Every menu action is built: drop collection, drop database, rename, create, modify view and duplicate view are live and go through the confirmation modals and dialogs of W02a–d.
- Inline per-DB error cards for `listCollections` failures (§8).
- Keyboard stretch (Home / End are live; `*` expand-siblings and letter type-ahead remain deferred).

---

## 11. Test cases

### Component (with mocked `api.meta` and `api.mongo`)

Existing:
- **auto-expand.spec.tsx**: with active tab's db = 'downlink', sidebar mounts with downlink expanded.
- **click-reuse.spec.tsx**: plain click on an existing coll → `openCollection({reuseExisting:true})`.
- **cmd-click.spec.tsx**: simulate meta-key click → `reuseExisting:false`.
- **alt-click.spec.tsx**: alt-click → `openAggregation`.
- **filter.spec.tsx**: typing narrows results in all DBs.
- **refresh.spec.tsx**: click refresh → `listDatabases` + `listCollections` called again.
- **error-retry.spec.tsx**: `listDatabases` rejects → error card; Retry re-calls.

New for v2:
- **filter-force-loads.spec.tsx**: typing a filter triggers `listCollections` for every DB that had none cached.
- **context-menu-coll.spec.tsx**: right-click on a collection opens the menu with the expected items.
- **context-menu-db.spec.tsx**: right-click on a DB row shows Create / Refresh / Copy / Drop.
- **context-menu-connection.spec.tsx**: right-click on the connection row shows Refresh databases / Edit / Copy connection string / Disconnect; the menu reflects live connection status.
- **context-menu-keyboard.spec.tsx**: menu closes on Escape; mousedown outside the menu closes it.
- **view-badge.spec.tsx**: a collection with `type: 'view'` renders the view icon + `VIEW` badge.
- **timeseries-badge.spec.tsx**: a collection with `type: 'timeseries'` renders the TS icon + `TS` badge.
- **copy-name.spec.tsx**: context menu "Copy name" writes just the collection name to `navigator.clipboard`.
- **copy-namespace.spec.tsx**: context menu "Copy namespace" writes `${db}.${coll}`.
- **keyboard-nav.spec.tsx**: arrow keys move focus without changing the active-tab highlight; Enter triggers the default action.
- **connection-row.spec.tsx**: the connection row renders at `aria-level={1}`, expand chevron toggles, DB count shows when loaded, and status dot color tracks `mongo.onStatus`.
- **connection-expand-persist.spec.tsx**: collapsing the connection persists via `prefs.set`; reload restores collapsed state.
- **disconnect.spec.tsx**: picking Disconnect from the connection menu calls `mongo:disconnect`, closes all tabs on that connection, and resets its cache.
- **hover-bar-db.spec.tsx**: hovering / focusing a DB row reveals the action bar with Create + Refresh; Tab moves focus into the bar; Escape returns to the row.
- **hover-bar-scope.spec.tsx**: collection / view / timeseries / connection rows do NOT show a hover bar.
- **drop-collection.spec.tsx**: clicking Drop opens the W02a modal; confirming invokes `mongo:dropCollection`, closes workspace tabs on the dropped namespace, and refreshes `colls[db]`.
- **rename-collection.spec.tsx** (per W02c): on success, tabs on the old namespace migrate to the new namespace.
- **drop-db.spec.tsx** (per W02b): requires type-to-confirm.
- **create-collection.spec.tsx** (per W02d): post-create, the new collection appears in `colls[db]` and may auto-open a tab (optional).

### Integration

Covered transitively by:
- C07 (`meta:*` handlers).
- The new `mongo:dropCollection` / `mongo:dropDatabase` / `mongo:renameCollection` / `mongo:createCollection` handler specs (§12).

---

## 12. IPC dependencies

The following channels are **prerequisites** for the matching §5 actions. Each one gets its own handler + service + zod schema + preload binding (the 5-file contract from `CLAUDE.md`). Authoring of these belongs to the C-series or a new W02-IPC spec; this section just enumerates them.

| Channel                   | Input                                                               | Output                  | Secret-input? | Used by        |
|---------------------------|---------------------------------------------------------------------|-------------------------|---------------|----------------|
| `mongo:dropCollection`    | `{ connectionId; dbName; collection }`                              | `{ dropped: boolean }`  | no            | W02a           |
| `mongo:dropDatabase`      | `{ connectionId; dbName }`                                          | `{ dropped: boolean }`  | no            | W02b           |
| `mongo:renameCollection`  | `{ connectionId; dbName; collection; newName; dropTarget?: boolean }` | `{ newNamespace: string }` | no         | W02c           |
| `mongo:createCollection`  | `{ connectionId; dbName; name; options? }` (options covers capped, timeseries, clustered, viewOn+pipeline) | `{ namespace: string }` | no | W02d, hover bar |
| `collection:modify`       | `{ connectionId; dbName; collection; options }`: either `validator`/`validationLevel`/`validationAction`, or `viewOn` + `pipeline` together | `{ ok: true }` | no | Modify view, W16 §15 |
| `conn:getUri`             | `{ id }`                                                            | `{ uri: string }`, never with the password | no | Copy connection string |

Non-functional requirements for the new handlers:
- Errors must surface as `AppError` subclasses: `NotFoundError` (db/coll missing), `ConflictError` (rename target exists), `MongoOpError` (wrapping the driver error). `electron/errors.ts` already covers these.
- All four must reject with `ValidationError` if `dbName` or `collection` contains invalid chars (`$`, `\0`, leading `.`, names reserved by MongoDB).
- None of these carry secrets → **none are added to `scripts/ipc-secret-allowlist.txt`.**

---

## 13. Sub-specs referenced

The destructive and creation flows each need their own spec before shipping:

| Spec   | Topic                              | Depends on         |
|--------|------------------------------------|--------------------|
| W02a   | Drop collection confirmation modal | `mongo:dropCollection` |
| W02b   | Drop database confirmation modal (type-to-confirm) | `mongo:dropDatabase` |
| W02c   | Rename collection modal + tab-namespace migration | `mongo:renameCollection` |
| W02d   | Create collection modal (name + capped/timeseries/clustered/view options) | `mongo:createCollection` |

Each sub-spec must follow the destructive-action convention in §5c. They can be authored in parallel; none of them block W02's context-menu skeleton from shipping (an item whose backing IPC + modal had not landed rendered disabled with a tooltip; all four have landed).

---

## 14. Out of scope — explicit rejects

Documented so reviewers don't reopen these:

- **Atlas metadata, CSFLE, non-genuine MongoDB warnings.** Compass surfaces these via `isGenuineMongoDB`, `csfleMode`, `atlasMetadata`. None apply to mongo-lab.
- **RBAC gating** (`hasWriteActionsDisabled`, `canEditCollection`, `canDeleteDatabase`). Mongo-lab has no read-only preference and no role model. All destructive actions in §5 are always enabled (subject to their IPC existing).
- **Per-item `colorCode`** on DB/collection rows. The connection dot is the only color affordance.
- **Virtualized list.** Defer indefinitely; pure-flex layout (§1a of the redesign analysis) is simpler and sufficient.
- **Multi-connection drawer.** Unchanged from v1 — stays deferred *as originally scoped here*. Shipped instead as one navigator root per Connection; see [X16](./X16-multi-connection.md).
- **MongoDB shell, performance metrics, query insights, cluster overview.** Compass-only; do not port.
- **Modify view in an aggregation tab.** Modify view edits the pipeline as JSON in a textarea dialog; editing it stage by stage in the aggregation builder is a later enhancement, not planned here.

---

## 15. Adjacent work shipped alongside v2.2 (not strictly W02)

These changes landed during the v2.2 iteration because they were blocking the navigator from being usable end-to-end, but they belong to Workspace (W01) and Connections (C06 / C07) concerns respectively. Listed here for traceability; the canonical home for each belongs in its own spec when those specs get their next amendment.

- **`browsingConnectionId` in `Workspace.tsx`** — see §1b. Workspace-level state; the navigator only consumes it via the `connectionId` prop.
- **`tabs.closeAll()` on `useWorkspaceTabs`** (`src/state/workspaceTabs.ts`) — added to support the clean-slate-on-connection-switch rule in §1b.
- **Always-visible three-column layout** in `Workspace.tsx` — the navigator renders even with zero tabs; empty center shows a CTA ("Select a collection from the sidebar to get started." + "Open a collection" button).
- **`authorizedDatabases: true` on `listDatabases`** (`electron/ipc/handlers/meta.ts`, `electron/mongo/MongoPool.ts` `serverInfo`). Restricted MongoDB roles (Atlas read-only, scoped roles) now see the databases they have access to instead of an empty list.
- **`serverStatsAvailable: boolean` on `ServerInfo`** (`shared/ipc.ts`, `electron/mongo/MongoPool.ts`, consumed by `src/pages/DetailPanel.tsx`). `serverStatus` failures no longer blow up `serverInfo` — the overview card now renders `—` for uptime / connections / ops when the role lacks the privilege, plus a one-line explainer. Stops the 15-second log spam.

---

## Changelog

- **v2.2 (2026-04-22)** — Reconciliation pass after implementation: added top-of-doc Implementation-status snapshot; added §1b (connection-switch behavior, `browsingConnectionId`, clean-slate + always-visible navigator); annotated §5.2 action matrix, §5b hover bar, §8 empty/error states, §10 acceptance criteria with `✅ live` vs `🚧 deferred` markers; added §14a listing adjacent work that shipped in this iteration (Workspace tab-close-all, `authorizedDatabases=true`, `serverStatsAvailable`). No scope changes; spec now reflects what's in code.
- **v2.1 (2026-04-22)** — Open decisions resolved: hover action bar adopted on DB rows (§5b); connection row committed to Path 2 — first-class tree node at `aria-level={1}` (§7). Layout diagram, state model, auto-expand, acceptance criteria, and test cases updated accordingly.
- **v2 (2026-04-22)** — Amendment: per-row-type action matrix (§5), context menus on connection / DB / collection rows, destructive-action convention (§5c), hover action bar (§5b), connection tree node (§7), keyboard map expansion, IPC + sub-spec cross-references (§12, §13), explicit out-of-scope list (§14).
- **v1** — Original scope: tree UI, filter, click modifiers, collection-only right-click menu (not implemented), arrow-key navigation (not implemented).
