# W01 — Workspace shell + tab management

> **Status: Implemented.** Aggregation is a sub-view of the collection tab (§5), not the separate tab kind §2 lists.

## Purpose

The workspace is the tabbed IDE-like page. This spec defines the outer shell (title bar, tab strip, three-column layout placeholder) and, crucially, **the tab system**: what a tab is, how tabs are created/moved/closed, how state is persisted so relaunching the app restores the user's session.

## Scope

- **In**: Tab type and state shape; tab strip UI; create/close/reorder/switch; per-tab state isolation; session persistence via `workspace_tabs` (F02) and IPC; title bar with breadcrumb; "+" new-tab menu; empty state.
- **Out**: Inner content of a collection tab (W02–W07), aggregation tab (A01–A06), document write ops (W08), saved/recent/preview (W09–W10).

## Dependencies

- F02 (`workspace_tabs` table), F04, C02, C07.

## 1. Route

- `/workspace` — current active window on whatever the last-active tab was.
- No `:id` param. The active tab is a piece of persistent UI state, not URL state — the URL is just "I'm in workspace".
- Workspace is only meaningful with at least one saved connection. If none exist, redirect to `/connections`.

## 2. Tab type

```ts
// shared/types.ts
export type WorkspaceTabKind = 'collection' | 'aggregation';

export interface WorkspaceTabBase {
  id: string;                    // UUID
  kind: WorkspaceTabKind;
  connectionId: string;
  dbName: string;
  collection: string;
  position: number;
  openedAt: string;
}

export interface CollectionTabState {
  view: 'Tree' | 'JSON' | 'Table';
  builder: {
    conditions: Cond[];          // see W04
    logic: 'AND' | 'OR';
    projection: string[];
    sort: string;                // raw MQL
    limit: string;               // raw MQL
  };
  queryRaw?: string;             // overrides builder if user hand-edited
  queryDirty: boolean;
  page: number;
  pageSize: number;
  activeBuilderTab: 'Builder' | 'Saved' | 'Recent';
}

export interface AggregationTabState {
  name?: string;                 // saved name, if any
  savedId?: string;
  stages: Stage[];               // see A02
  activeStageId: number | null;
  outputHeight: number;          // px, user-resized
  outputView: 'Tree' | 'JSON' | 'Table';
}

export type CollectionTab = WorkspaceTabBase & { kind: 'collection'; state: CollectionTabState };
export type AggregationTab = WorkspaceTabBase & { kind: 'aggregation'; state: AggregationTabState };
export type WorkspaceTab   = CollectionTab | AggregationTab;
```

## 3. State (renderer)

```ts
const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
const [activeId, setActiveId] = useState<string | null>(null);
const active = tabs.find(t => t.id === activeId) ?? null;
```

Tab state lives in the renderer for responsiveness but is mirrored to main on every mutation via `tabs:update`.

## 4. IPC contract

| Channel              | Input                                                               | Output                | Notes |
| -------------------- | ------------------------------------------------------------------- | --------------------- | ----- |
| `tabs:list`          | —                                                                   | `WorkspaceTab[]`      | ordered by position |
| `tabs:openCollection`| `{connectionId, dbName, collection, reuseExisting?: boolean}`       | `WorkspaceTab`        | |
| `tabs:openAggregation`| `{connectionId, dbName, collection, savedId?, name?}`              | `WorkspaceTab`        | creates a new agg tab |
| `tabs:openDefault`   | `{connectionId}`                                                    | `WorkspaceTab`        | C08 used this |
| `tabs:update`        | `{id, patch: Partial<TabState>}`                                    | `WorkspaceTab`        | patch writes to `state_json` |
| `tabs:close`         | `{id}`                                                              | `{ newActiveId: string\|null }` | |
| `tabs:setActive`     | `{id}`                                                              | `void`                | |
| `tabs:reorder`       | `{orderedIds: string[]}`                                            | `void`                | |

## 5. Open semantics

### `tabs:openCollection`
- `reuseExisting` default: `true`. If a tab already matches `(connectionId, dbName, collection)`, activate it instead of creating a duplicate.
- If false, always create a new tab (used by "Open in new tab" actions).
- New tab `position = max(position) + 1`. Becomes active.
- Initial `state` is the default `CollectionTabState` (view=Tree, empty builder, pageSize=50, page=1).

### `tabs:openAggregation`
- Reuses the collection tab already open on `(connectionId, dbName, collection)`, switching it to the Aggregation sub-view; otherwise creates a new collection tab parked there. A `savedId` or `name` reseeds that tab's aggregation state; without either, its aggregation state is kept.
- Initial `state.stages` is empty, or hydrated from a saved pipeline if `savedId` present (W09). Main does the hydration, since the call carries no stages. The saved query must be a pipeline whose stored stages are readable and which belongs to the same connection, database and collection as the tab, because the tab's Save writes back to it. An unknown `savedId` answers `NOT_FOUND`; any other mismatch answers `VALIDATION`. Neither opens or changes a tab.

### `tabs:list`
- A saved-pipeline tab that is clean (not `dirty`) yet has no stages gets the stored stages back. Only a tab persisted before the hydration above existed can be in that state, since every stage edit marks the tab `dirty`. A saved query that is gone or unreadable leaves the tab as it is.

### `tabs:openDefault`
- Pick first non-system DB; pick its first collection; call `tabs:openCollection` semantics.
- If nothing exists, still create a tab but flag it in renderer as "nothing here yet" with instructions to create a collection outside the app.

## 6. Close semantics

- `tabs:close` removes the tab.
- If closing the active tab: new active is the adjacent left tab, else the right; if none, `activeId = null` (empty state).
- The UX **always** allows closing the last tab (unlike the current mock which prevents it). Empty state renders a placeholder.
- Confirmation dialog only if the tab has unsaved agg-pipeline changes or a dirty builder.

## 7. Tab strip UI

```
┌───────────────────────────────────────────────────────────────────────┐
│ journalEntry │ order ×  │ Σ monthlyByAccount ×                   │
└───────────────────────────────────────────────────────────────────────┘
```

- **Icons**: none for collection tabs, Σ for aggregation tabs (use SVG from `icons.tsx`).
- **Close (×)** on hover; always visible on active tab.
- **Drag to reorder** — HTML5 drag events, snap into new position on drop. Debounced `tabs:reorder` call.
- **Overflow**: horizontal scroll with subtle gradient fade. Never wrap.
- **No "+" button.** A new collection tab opens from the navigator, ⌘T, the command palette, or the empty state; each opens the tiny modal (see §8).
- **Tab Groups**: one per Connection, with a header filled in the Connection's colour (brighter when it holds the Focused Tab). Clicking the header collapses or expands the group. Each tab carries a bottom border in that colour, dim until it is the Focused Tab.
- **Former "+▾" new-tab menu** (superseded):
  - "New aggregation on current collection" → opens an agg tab with the same coll.
  - "New script" (stub) → toast "coming soon".
  - Separator, then recent connections → clicking one runs `tabs:openDefault(connectionId)`.

### Tab context menu

Right-click on a tab, or Shift+F10 / the ContextMenu key on a focused tab, opens a menu with:

- **Pin tab / Unpin tab** and **Close tab**, as before.
- **Close others** closes every other tab in the strip.
- **Close to the right** closes every tab to the right of this one.
- **Reveal in sidebar** shows the tab's collection in the navigator. Collection tabs only: a script tab has no navigator row, so the item is absent.

Both bulk closes follow the same rules:

- **Order.** "To the right" means the order on screen. Tabs render grouped by connection, so this can differ from the stored `position` order whenever the stored tabs of two connections interleave.
- **Collapsed groups.** A collapsed group's tabs are not on screen, so neither action closes them.
- **Pinned tabs** are never closed by a bulk action, and neither is the tab the menu was opened on.
- **Disabled when empty.** Each item is disabled when it would close nothing.
- **Unsaved pipelines.** If any tab to be closed has an unsaved pipeline, one confirmation names how many. Cancel closes nothing. Confirm closes them all. If the active tab is among them, the tab the menu was opened on is activated first, so focus never lands on a tab that is about to close.

Reveal in sidebar:

1. Activates the tab, waking a dormant connection the same way a click does.
2. Opens the sidebar if it is collapsed.
3. Expands the tab's connection root and its database, clears the navigator's name filter so it cannot hide the row, and re-lists the database's collections (sharing a load already in flight).
4. Moves the navigator's focus (its `aria-activedescendant`) to the collection row once that row is rendered, which scrolls it into view. The request is then spent: reopening the sidebar later focuses the active tab's row, not this one.
5. If that listing settles without the collection (it was dropped, or the listing failed), the request is dropped instead. It never fires later, when the collection reappears and the user has moved on.

Real DOM focus stays where the menu returns it.

### Collection view strip

Above a collection tab, a strip switches between Documents, Aggregation and Structure. It is a tablist (`aria-label="Collection view"`) built on Mantine `Tabs`, in the same root as the three view panels, so each tab's `aria-controls` points at a real `tabpanel` that names the tab back with `aria-labelledby`.

- One tab stop: only the selected tab is reachable with Tab.
- Left and Right move focus and select that view; Home and End move focus to the first and last tab, and Enter or Space selects it.
- Only the selected view's panel is mounted, so an unselected view does no work.

## 8. New-collection-tab modal

- Small centered modal:
  - Select: Connection (current one pre-selected).
  - Select: Database (populated via `meta:listDatabases`).
  - Select: Collection (populated via `meta:listCollections` on db change).
- Confirm → `tabs:openCollection({...})`.
- Cancel closes.

## 9. Session restore

On mount of `/workspace`:
1. `const tabs = await api.tabs.list()`.
2. If tabs exist → activate the one with `is_active = 1` (else the last one).
3. Else if there's at least one saved connection → render empty state with an "Open a collection…" button that opens the new-tab modal.
4. Else redirect to `/connections`.

Settings carries a "Reopen tabs on launch" switch, stored under `ui.workspace.restoreTabs`. An unset value means on, so the behaviour above is the default. When the value is `false`, the main process closes every tab (pinned ones included) once at boot, right after the tab service is built, so the workspace opens empty. The check lives in main rather than in the `/workspace` mount because that page remounts on route changes and would wipe tabs mid-session. Nothing asks at quit with the setting off, so a tab holding unsaved pipeline changes is lost at the next launch along with the rest; the switch's description in Settings says so.

Every renderer state change in a tab triggers `api.tabs.update(id, patchOfState)` with a **debounced** (250ms) writer. This keeps session restoration on par with the last typed-but-unsaved state without thrashing SQLite.

## 10. Breadcrumb in title bar

Format: `{connection.name} / {dbName} / {collection}  [· kind]` where kind is rendered if agg. The breadcrumb left-side has a back button → `/connections`.

## 11. Keyboard

| Shortcut            | Action |
| ------------------- | ------ |
| `⌘T`                | Open new-collection-tab modal |
| `⌘⇧T`               | Open aggregation tab on current coll |
| `⌘W`                | Close current tab |
| `⌘⇧W`               | Close all other tabs |
| `⌘1`…`⌘9`           | Switch to Nth tab |
| `⌘⌥→` / `⌘⌥←`       | Next / previous tab |
| `⌘K`                | CmdK overlay (C08 stub) |

## 12. Acceptance criteria

- Relaunching the app restores previously open tabs, positions, active tab, and the builder state of the active collection tab (view mode, builder conditions, sort, limit).
- With "Reopen tabs on launch" off, a relaunch starts with no tabs, pinned ones included; switching it back on restores the default behaviour.
- Closing the last tab leaves the workspace on an empty state; reopening via "+" restores functionality.
- Reordering tabs persists and survives relaunch.
- Switching tabs never calls `api.meta.*` or `api.query.*` — those run on tab activation in their own spec.
- Opening the same collection twice (with default `reuseExisting`) activates the existing tab.
- Aggregation tab opens without a default pipeline; builder starts empty.

## 13. Test cases

### Integration (main)
- **tabs-crud.spec.ts**: openCollection → list returns one row; openCollection same coll again → still one row (reuseExisting); openCollection reuseExisting:false → two rows with distinct ids.
- **active-follows-close.spec.ts**: open three, activate middle, close it → newly active = left neighbor.
- **reorder.spec.ts**: reorder persists; `tabs:list` returns the new order.
- **update-debounce.spec.ts**: rapid updates collapse (observer receives at most one write per 250ms window).
- **restore-tabs-boot.spec.ts**: with `ui.workspace.restoreTabs` false, boot closes every tab, pinned ones included; true or unset keeps them.

### Component
- **tab-strip-render.spec.tsx**: renders N tabs with correct icons and active styling.
- **tab-drag.spec.tsx**: simulate drag → `api.tabs.reorder` called with the new order.
- **new-tab-menu.spec.tsx**: click "+" → menu items visible; "New aggregation on current collection" invokes `api.tabs.openAggregation`.
- **keyboard-switch.spec.tsx**: `⌘2` activates the second tab.
- **collection-subtabs.spec.tsx**: the collection view strip is a tablist: arrow keys move focus and selection, Home and End move focus, only the selected tab is a tab stop, it points at a tabpanel that points back, and a click changes the view.
- **settings-modal-restore-tabs.spec.tsx**: the "Reopen tabs on launch" switch reads on when unset and off when stored false, saves the new value, toasts and reverts a failed save, and its description says unsaved pipeline changes are lost with the tabs.
- **workspace-tab-groups.spec.tsx** (tab context menu): Close others and Close to the right close the tabs on screen in the strip's grouped order, keep pinned tabs and collapsed groups, hand focus to the menu's tab, ask once over unsaved pipelines, and keep closing the rest when one close fails, reporting it in one toast. Reveal in sidebar opens a collapsed sidebar, clears the navigator filter, waits for or re-lists the database, focuses the row, and drops a reveal whose database failed to list or whose collection is gone.

### E2E
- **restore.e2e.ts**: open two tabs → quit app → relaunch → both tabs present, active tab unchanged.
- **workspace-restore.e2e.ts**: tabs survive a quit and relaunch; with "Reopen tabs on launch" off, a relaunch starts with no tabs.
