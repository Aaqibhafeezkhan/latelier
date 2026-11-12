# X07 — Command palette

> **Status: Implemented.** Rebuilt on Mantine Spotlight during [X12](./X12-mantine-migration.md), then extended by the v2 amendment in §13, which is implemented too; where §13 names a part of §1–§12, §13 is what ships.

## Purpose

Give the user one keystroke (`⌘K` / `Ctrl+K`) to reach every action in the app. Replaces the hardcoded `CmdKStub` in `ConnectionManager.tsx` with a global, extensible palette backed by a renderer-side registry. Two wins:

1. **Discoverability.** Hidden features become self-documenting — searching "reference" surfaces the references editor; searching "save" surfaces the Save dialog. The X06 hints solve "how do I notice this exists in context"; the palette solves "I know it exists, where is it".
2. **Reach.** Power users skip menu-hunting and get to any action with three keystrokes (`⌘K`, type, Enter), regardless of which page or tab they're on.

The palette ships as renderer-only — no IPC. State lives in React context; the catalog is dynamic (commands register themselves when their owning component mounts and unregister on unmount).

## Scope

- **In**: `Command` type, `CommandRegistry` context, `useRegisterCommands(commands)` hook, `<CommandPalette>` component mounted globally in `App.tsx`, `⌘K` / `Ctrl+K` global shortcut, Esc to close, ranked search, grouped results, keyboard navigation, recent-commands MRU (persisted across relaunches, §7), v1 catalog covering Connections / Workspace (collection + aggregation) / global.
- **Out** (deferred):
  - **Per-command keybindings** — the palette displays existing shortcuts (e.g., `⌘T`) but does not own them. Rebinding lives in a future `keybindings` spec.
  - **Multi-step / nested commands** ("Open recent query > pick which one") — v1 flattens dynamic sublists into top-level entries (e.g., `connection.switch:<id>` per connection). A "deferred run with parameters" UX waits. *§13.4 lifts this deferral: v2 adds a second step for an object's actions.*
  - **User-defined commands** / scripting / macros.
  - **Telemetry** on command usage.
  - **Internationalization** — copy is English-only and lives at the registration site.
  - **Theming** — palette uses the existing `Theme` tokens; no separate themeable surface.

## Dependencies

- F04 (IPC bridge) — only indirectly. Some commands invoke `api.*` channels but the palette itself does not register handlers.
- W01 (workspace shell) — the active tab + tab list are read from `useWorkspaceTabs`; per-tab commands register from inside the tab subtree.
- C05 (ConnectionManager) — replaces `CmdKStub`; existing `⌘K` listener moves to the global handler.
- X05, X06, X01 — provide actions surfaced in the catalog (configure references, reset hints, toggle theme).

## See also

- **X06 — Contextual feature hints**: hints surface a feature once, in context. The palette surfaces every feature, always. Both should reach the same primitive (e.g., the `references.configure` hint's CTA and the `references.configure` palette command should call the same function). X06 also defines a `palette.discover` hint anchored to the `⌘K` button — it fires the first time a user lands in the app and has not yet opened the palette this session, closing the discoverability loop on the palette itself. The palette records `recordSessionEvent('palette', 'opened')` on every open so the hint self-suppresses after first use.
- The old **"P1 — Cmd-K feature palette"** item: this spec replaced it, and the palette has since shipped (`src/commands/CommandPalette.tsx`).

## 1. Types

```ts
// src/commands/types.ts (renderer-only)

export type CommandGroup =
  | 'general'
  | 'connection'
  | 'workspace'
  | 'query'
  | 'aggregation'
  | 'view'
  | 'references'
  | 'navigation';

export interface PaletteContext {
  /** react-router pathname; one of '/connections', '/connections/:id', '/workspace', etc. */
  pathname: string;
  /** Active connection id, parsed from `/connections/:id`. */
  connectionId: string | null;
}

// The active workspace tab is intentionally NOT carried in `PaletteContext`.
// Tab-scoped commands (`query.run`, `view.mode.*`, `agg.run`, …) register from
// inside the active tab subtree and capture tab state via closures + refs;
// they automatically vanish when the tab unmounts. Adding `activeTab` here
// would create a second source of truth and force every consumer to subscribe
// to the workspace tabs hook.

export interface Command {
  /** Stable, unique. Dotted namespace recommended (`query.run`, `tab.close`). */
  id: string;
  /** Shown in the palette row. <= 60 chars. */
  title: string;
  /** Optional secondary line shown muted under the title. <= 80 chars. */
  subtitle?: string;
  /** Header bucket the command renders under. */
  group: CommandGroup;
  /** Free-text aliases that match the search query in addition to `title`. */
  keywords?: string[];
  /** Optional shortcut hint, written in Mac glyphs, e.g. `⌘T`. Display-only; shown platform-aware (see §5). */
  shortcut?: string;
  /**
   * Optional dynamic gate. Defaults to `() => true`. Evaluated each time the
   * palette opens and on every keystroke; must be cheap.
   */
  when?: (ctx: PaletteContext) => boolean;
  /**
   * Left out of the empty-query catalog. Set on the dynamic
   * one-row-per-namespace commands, which would otherwise flood the empty
   * palette and bury the commands people browse for. A recently used one
   * still shows under Recent.
   */
  hideWhenEmptyQuery?: boolean;
  /**
   * What the fuzzy match reads instead of the title. The namespace commands
   * set it to `<db>.<coll>`, so the shared `Open: ` prefix is not a
   * subsequence every one of them matches.
   */
  fuzzyText?: string;
  /**
   * Side-effecting handler. Receives the palette context. Performing a
   * command always closes the palette; v1 has no "stay open" affordance.
   */
  perform: (ctx: PaletteContext) => void | Promise<void>;
}
```

Commands are not serializable — `perform` is a closure over the registering component's state. This is deliberate: it removes the need for an event-bus indirection and keeps the per-command code where it belongs.

## 2. Architecture

### Singleton registry (in-renderer)

```ts
// src/commands/registry.ts

interface CommandRegistry {
  list(): Command[];                       // all currently registered
  add(commands: Command[]): () => void;    // returns unregister fn
  subscribe(cb: () => void): () => void;   // notifies the palette to re-render
}

export const commandRegistry: CommandRegistry;
```

Implementation is a `Map<id, Command>` plus a tiny pub/sub. Registering an id that already exists overwrites and warns once via `console.warn` (dev-only). This catches typos but doesn't crash if two components race to register.

### `useRegisterCommands(commands)`

```ts
function useRegisterCommands(
  commands: Command[],
  deps: React.DependencyList,
): void;
```

- Calls `commandRegistry.add(commands)` on mount and on `deps` change.
- Returns the unregister fn from the effect cleanup.
- Stable identity: callers MUST list every closed-over value in `deps`. Bad deps → stale `perform` closures (same risk as `useCallback`).

### `<CommandPalette>` component

Mounted once in `src/App.tsx`, inside `<HintsProvider>` so hints can also fire while the palette is closed but suppress while it's open (see §6).

Reads:
- `commandRegistry` (subscribed).
- `PaletteContext` from a sibling `<PaletteContextProvider>` (next item).
- `useTheme` for tokens.
- `useNavigate` for nav-style commands.

State (local):
- `open: boolean`
- `query: string`
- `cursor: number` (selected row index in the filtered list)
- MRU `string[]` of recently performed command ids (cap 8, persisted — §7).

### `<PaletteContextProvider>`

Tiny context published by `App.tsx` at the same level as the palette. Reads route from `useLocation`, active connection from the URL or `useConnections().selected`, and active tab from `useWorkspaceTabs()` when on `/workspace`. Pushed downward as a `PaletteContext` value the palette and `when` predicates consume.

This is one of two coupling points between the palette and the rest of the app (the other is per-page command registration via the hook). Pages do **not** need to know the palette exists — they just register their commands.

## 3. Search and ranking

Filter is case-insensitive, on the trimmed query. Substring matching is tried first, against the title, then the subtitle and the keywords (joined with a space). A command none of those match falls back to a fuzzy match: every character of the query, whitespace removed, appears in the title in order (a subsequence), so `shord` finds `Open: shop.orders`. A command with `fuzzyText` is matched against that instead of its title, so `opn` does not match every namespace through its `Open: ` prefix. The fuzzy match is title-only (or `fuzzyText`-only) and has no scoring: it is a last bucket, never a reorder of the substring ones. A one-character query cannot reach it, since one character is a subsequence exactly when it is a substring.

Ranking, in order:
1. Recently used (MRU bucket, oldest at the bottom of its bucket).
2. Title prefix match (`q === title.slice(0, q.length)` lowercase).
3. Title substring match.
4. Subtitle / keywords substring match.
5. Title subsequence (fuzzy) match.

Within each rank bucket, preserve the registration order (which roughly tracks importance: ConnectionManager registers global commands first, then page-specific commands register).

When MRU pulls a command into the RECENT bucket, that command does **not** also appear under its own group — it moves, not duplicates. This matches VS Code / Linear behavior and avoids two same-named rows on screen.

Empty query → render the RECENT bucket first (if non-empty), then every other command grouped by `group`. Commands with `hideWhenEmptyQuery` are left out of the grouped catalog, but one the MRU holds still shows in the RECENT bucket. Section headers in registration order: `general`, `navigation`, `connection`, `workspace`, `query`, `view`, `references`, `aggregation`.

## 4. UI

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ 🔍  Search commands…                                    │  ← input
├─────────────────────────────────────────────────────────┤
│ RECENT                                                  │
│   ▶  Run query                                ⌘↵        │
│   ▶  Save query                                          │
│ CONNECTION                                              │
│   ▶  New connection                           ⌘N        │
│   ▶  Switch to: Production                               │
│ QUERY                                                   │
│   ▶  Configure references                                │
│ WORKSPACE                                               │
│   ▶  New tab…                                  ⌘T        │
│   ▶  Pin current tab                                     │
└─────────────────────────────────────────────────────────┘
```

- 520 px wide, max 460 px tall (matches the existing `CmdKStub` dimensions for visual continuity).
- Modal-style overlay: full-viewport backdrop at `rgba(0,0,0,0.45)`, palette centered ~100 px from top.
- Click on the backdrop dismisses; click inside the palette does not bubble.
- Focus the input on open. Restore focus to the previously focused element on close.

### Keyboard

| Key             | Behavior                                                               |
| --------------- | ---------------------------------------------------------------------- |
| `⌘K` / `Ctrl+K` | Toggle the palette.                                                    |
| `Esc`           | Close.                                                                 |
| `↓` / `↑`       | Move the cursor through visible rows (wraps).                          |
| `Enter`         | Perform the cursor row's command.                                      |
| `⌘↵`            | Same as `Enter`. Reserved for power users who already chord with `⌘`. |
| `Home` / `End`  | Jump cursor to first / last visible row.                               |

`Tab` is intentionally unbound: the palette's only focusable element is its input, so the default browser behavior (no-op on Tab) is the desired outcome. The palette never traps `⌘W`, `⌘T`, `⌘1`–`⌘9`, or other workspace shortcuts — those listeners are owned by their own components and don't fire while the palette is open because the palette's input absorbs typing. The palette's global listener at `document` level intercepts only `⌘K`/`Ctrl+K` (open/close) and `Esc` (close), and only the latter when the palette is open.

### Empty / no-result states

- No commands registered → render "No actions available here yet." (defensive — should never happen in practice because global commands always register).
- Query with no matches → `No matches for "<query>"` muted text.

### Visual style

- Match the existing `CmdKStub`: surface = `T.surface`, border = `T.borderMed`, headers = `T.textGhost` uppercase 10 px, rows = 12 px text, hover = `T.surfaceRaised`, selected (cursor) row = `T.surfaceRaised` + 2 px left accent in `T.accent`.
- Group headers always visible above their (filtered) rows; hide the header if the group has zero matches.
- Shortcut badge right-aligned in the row, monospace, 11 px, muted.

## 5. v1 command catalog

> **Amended** (ADR [0001](../docs/adr/0001-data-view-home-connection-switcher.md)): the
> `/connections` list-sidebar screen this table was written against is retired, and
> `PaletteContext.connectionId` now falls back to the Active Connection off the deep detail screen
> — see the row-level notes below for what changed. The rest of this table (workspace/query/view/
> aggregation commands) is unaffected.

| Group         | Id                          | Title                             | When                                                                                  | Performs                                                              |
| ------------- | --------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| general       | `theme.toggle`              | Toggle dark mode                  | always                                                                                | calls the `useTheme()` toggle from `<GlobalCommands>` in `App.tsx`     |
| general       | `settings.open`             | Open settings                     | always                                                                                | opens `<SettingsModal>` — see §11 for the prerequisite hoist           |
| general       | `help.shortcuts`            | Keyboard shortcuts…               | always (shortcut `⌘/`)                                                                | opens the shortcuts cheat sheet, registered and rendered by `<GlobalCommands>`; see below |
| navigation    | ~~`nav.connections`~~       | ~~Go to connections~~             | **Removed** — `/connections` no longer has a screen to navigate to (it redirects to `/workspace`). | —                                                                       |
| navigation    | `nav.workspace`             | Go to workspace                   | `pathname !== '/workspace'` and `connectionId` set (URL id, or the Active Connection off the deep screen) | `navigate('/workspace')`                                               |
| connection    | `connection.new`            | New connection                    | always                                                                                | `navigate('/connections/new')`                                         |
| connection    | `connection.edit`           | Edit selected connection          | `connectionId` set (URL id on the deep screen, or the Active Connection from the Data View, no longer a `pathname` prefix check) | `navigate('/connections/:id/edit', { state: { returnTo: pathname } })` — `returnTo` lands save/cancel back where the command was invoked from, not always the deep screen |
| connection    | `connection.delete`         | Delete selected connection        | `connectionId` set                                                                    | On the deep screen: opens `ConnectionManager`'s delete-confirm dialog. On the Data View: opens the same dialog via `Workspace.tsx`'s `openDeleteConnectionModal`, acting on the Active Connection — the two registrations share the id but the routes are mutually exclusive |
| connection    | `connection.refresh`        | Refresh connection list           | `pathname.startsWith('/connections')` (deep screen) or `pathname === '/workspace'` (Data View) | `useConnections().refresh()` — registered separately by whichever of `ConnectionManager.tsx` / `Workspace.tsx` is mounted, each capturing its own hook instance |
| connection    | `connection.switch:<id>`    | `Switch to: <name>`               | always; one row per connection (subtitle = host)                                      | navigates to `/workspace` with a `switchConnectionId` intent that `Workspace` runs via `switchConnection` — registered globally by `<ConnectionPaletteCommands>`, which holds its own `useConnections()` subscription |
| workspace     | `tab.new`                   | New tab…                          | `pathname === '/workspace'` and active connection exists                              | opens the existing `<NewTabModal>` (`setNewTabOpen(true)`)             |
| workspace     | `tab.new.aggregation`       | New aggregation tab on this coll. | `activeTab?.kind === 'collection'`                                                    | `tabs.openAggregation({connectionId, dbName, collection})` from the active tab's coords (no modal) |
| workspace     | `tab.open:<connectionId>:<db>:<coll>` | `Open: <db>.<coll>`     | on `/workspace`, one row per collection of the **focused connection** only (never an unopened connection's, per X16 §4.2), and none while it is not connected; left out of the empty-query catalog (`hideWhenEmptyQuery`) but listed under Recent once used. The id names the connection, so the same namespace on another connection is not recent. Fuzzy-matched on `<db>.<coll>` (`fuzzyText`) | `tabs.openCollection({connectionId, dbName, collection, reuseExisting: true})` — switches to an existing tab if one exists, otherwise creates a fresh one. Mirrors the navigator's plain-click behavior. The list is read from the navigator's own cache (W02 §2), which the Workspace sweeps once the focused connection is connected, so a collection created, renamed or dropped through the navigator shows up here too and nothing is fetched twice |
| workspace     | `shell.toggle`              | Open Shell / Close Shell          | a focused connection exists (title flips on whether the shell pane is open)           | toggles the Mongo shell pane, the same state the TitleBar's Shell button drives |
| workspace     | `tab.close`                 | Close current tab                 | `activeTab !== null`                                                                  | `tabs.close(activeTab.id)` from `useWorkspaceTabs`                     |
| workspace     | `tab.pin.toggle`            | Pin current tab / Unpin           | `activeTab !== null` (title flips on `activeTab.pinned`)                              | `tabs.setPinned(activeTab.id, !activeTab.pinned)`                      |
| query         | `query.run`                 | Run query                         | `activeTab?.kind === 'collection'`                                                    | runs the active collection tab's query                                 |
| query         | `query.save`                | Save query                        | `activeTab?.kind === 'collection'`                                                    | opens `SaveModal`                                                      |
| query         | `query.copy`                | Copy MQL to clipboard             | `activeTab?.kind === 'collection'` and `state.queryRaw` non-empty                     | `navigator.clipboard.writeText(state.queryRaw)`                        |
| references    | `references.configure`      | Configure references              | `activeTab?.kind === 'collection'`                                                    | `setRefEditorOpen(true)` — same setter the X06 `refs.configure` hint CTA already calls (`Workspace.tsx`) |
| view          | `view.mode.tree`            | Show results as Tree              | `activeTab?.kind === 'collection'` and `state.view !== 'Tree'`                        | `tabs.patchCollectionState(activeTab.id, { view: 'Tree' })`            |
| view          | `view.mode.json`            | Show results as JSON              | same, `state.view !== 'JSON'`                                                         | `tabs.patchCollectionState(activeTab.id, { view: 'JSON' })`            |
| view          | `view.mode.table`           | Show results as Table             | same, `state.view !== 'Table'`                                                        | `tabs.patchCollectionState(activeTab.id, { view: 'Table' })`           |
| view          | `view.structure.schema`     | Go to Schema                      | `activeTab?.kind === 'collection'`                                                    | `tabs.setActiveView(activeTab.id, 'structure')`: the Structure sub-view holds the schema |
| view          | `view.structure.indexes`    | Go to Indexes                     | `activeTab?.kind === 'collection'`                                                    | same switch, then scrolls the Indexes region into view once the Structure view has rendered |
| aggregation   | `agg.run`                   | Run pipeline                      | `activeTab?.kind === 'aggregation'`                                                   | runs the active aggregation                                            |
| aggregation   | `agg.explain`               | Explain pipeline                  | `activeTab?.kind === 'aggregation'`                                                   | opens explain drawer                                                   |
| aggregation   | `agg.save`                  | Save pipeline                     | `activeTab?.kind === 'aggregation'`                                                   | opens save modal                                                       |

The `activeTab?.kind === '…'` predicates above are conceptual — the implementation enforces them structurally via registration scope: the collection-tab subtree only mounts when `activeTab.kind === 'collection'`, so its `query.*` / `view.mode.*` / `references.configure` registrations only exist while the predicate would be true. The same applies to `agg.*`. No `when` clause needs to read `activeTab` at runtime, which is why `PaletteContext` doesn't carry it.

`shortcut` is set on commands that already have a keyboard binding elsewhere (e.g., `tab.new` shows `⌘T`). The palette never installs shortcuts; it only displays them.

Shortcuts are written once, in Mac glyphs, and shown for the platform they run on. On a Mac the label is shown as written. Elsewhere `⌘` reads `Ctrl+`, `⌥` reads `Alt+`, `⇧` reads `Shift+` and `↵` reads `Enter`, with modifiers in Ctrl, Alt, Shift order: `⌘T` shows `Ctrl+T`, `⇧⌘↵` shows `Ctrl+Shift+Enter`. The palette rows, the shortcut tooltips and the Connection Switcher legend all go through that one formatter (`formatShortcut`). The shortcuts themselves already accept either `⌘` or `Ctrl`.

**Keyboard shortcuts cheat sheet.** `help.shortcuts` opens a dialog titled "Keyboard shortcuts" that lists every registered command that has a `shortcut`, grouped as the palette groups them, plus a fixed list of shortcuts that are not commands, under the heading for where they work: Anywhere (`⌘K` palette), In the workspace (`⌘1`–`⌘9` switch tab, `⌘⌥←` / `⌘⌥→` cycle tabs, `⌘E` manage connections) and In the connection form (`⌘S` save, `⌘↵` test). A command without a `shortcut` is not listed. `⌘/` (`Ctrl+/` elsewhere) opens it from anywhere, except while a text field or an editor has focus, where `/` keeps its own meaning. Closing it returns focus to where it was.

Commands marked "always" + `connection.new` + `nav.*` register once globally from `App.tsx`. Page- and tab-scoped commands are registered by the component that owns the action — that way `perform` is a closure over the live state setters/handlers in scope:

- `ConnectionManager.tsx` registers `connection.delete` (closure over `setDeleteConfirmOpen`) and `connection.refresh` (closure over `useConnections().refresh`) for the deep detail screen. `connection.edit` stays global because it's pure nav. `Workspace.tsx` now *also* registers `connection.delete` / `connection.refresh` (against the Active Connection) so they're offered from the Data View too — the routes never overlap, so there's no id collision at runtime.
- `Workspace.tsx` registers `tab.new` (closure over `setNewTabOpen`), `tab.new.aggregation` (closure over `tabs.openAggregation` + the active tab's coords), `tab.close`, `tab.pin.toggle`, and `references.configure` (closure over `setRefEditorOpen`).
- The collection-tab subtree (currently the body of `Workspace.tsx` when `activeTab.kind === 'collection'` — could become `<CollectionTabBody>` during this work) registers `query.run` (closure over `run`), `query.save` (closure over the SaveModal opener), `query.copy`, and the three `view.mode.*` commands.
- The aggregation-tab subtree registers `agg.run`, `agg.explain`, `agg.save` against the active aggregation tab's local handlers.

When the owning component unmounts, the commands disappear from the palette automatically.

`connection.switch:<id>` is dynamic: a single `useRegisterCommands` call inside a global `<ConnectionPaletteCommands>` component derives one Command per row of its own `useConnections()` subscription.

## 6. Behavior rules

- **One palette only.** Two `⌘K` presses with the palette already open does NOT stack; it closes.
- **Performs are best-effort.** A `perform` that throws logs a dev-only `console.error`. The palette closes anyway; no error UI takes over the screen. (A toast is intentionally omitted in v1 — a failing command is rare and the user can read the dev console; adding a toast layer here just to handle this case is overkill.)
- **MRU persists.** The RECENT bucket survives a relaunch (§7). A stored id that no registered command carries any more (a refactor renamed it, or its collection is gone) is skipped at rank time, never rendered.
- **Hints stay behind the backdrop.** The palette's full-viewport backdrop visually covers any X06 hint that would otherwise be visible. No explicit suppression API is needed — the `rgba(0,0,0,0.45)` overlay handles it.

## 7. Persistence

The MRU lives in `app_state['ui.commandPalette.mru']`, a `string[]` of command ids, most recent first, through the existing `prefs:get` / `prefs:set` channels. Main validates it as at most 16 strings of at most 512 characters each; the renderer keeps 8.

- **Load.** The palette reads the key once on mount. Anything other than an array of strings is ignored. The stored ids are merged behind any command performed while the read was in flight.
- **Save.** Each perform writes the new list, but not before the stored history has been read and merged: a command performed while the read is in flight is written together with what was stored, never alone over it. After a failed read nothing is written, so an unreadable history is never replaced. The seed itself is never written back.
- **Unknown ids** are dropped at rank time, not at load: a command registered later in the session (a collection that finishes loading) still finds its place.
- **Failures.** The history is a convenience, and the palette works the same without it. A failed read is logged with `console.warn`, as the theme's is; a failed write shows one error toast, as a layout write does.

## 8. Error handling

- A command registered with a duplicate id replaces the previous one and warns once (dev). No throw — registration races during HMR are common.
- A command whose `when` throws is treated as `false` and warned once.
- A command whose `perform` throws or rejects logs and toasts as in §6.
- The palette never holds the user hostage: Esc always closes regardless of the cursor row's state.

## 9. Acceptance criteria

- `⌘K` (`Ctrl+K` on non-mac) opens the palette from any route. Pressing it again closes it.
- Esc closes the palette and restores focus to the previously focused element.
- Typing filters the catalog by case-insensitive substring across `title`, `subtitle`, and `keywords`, then by title subsequence (`shord` finds `Open: shop.orders`), ranked last.
- Arrow keys move a visible cursor; Enter performs the command; performing closes the palette.
- Performing a command bumps it to the top of the MRU and the palette shows it under a "RECENT" header on next open, including after a relaunch.
- **Superseded** — `/connections` no longer exists as a screen; `New connection` and every `Switch to: <name>` row are offered from `/workspace` (the Data View, now home) instead.
- On `/connections/:id` (deep detail screen, reached only via the Switcher's "Manage connection…"), the palette includes `Edit selected connection` and `Delete selected connection`. Both are now also offered from `/workspace`, acting on the Active Connection.
- On `/workspace` with a collection tab active, the palette includes `Run query`, `Save query`, `Configure references`, two `view.mode.*` toggles (only the non-current ones), `New aggregation tab on this coll.`, and `Pin current tab` / `Unpin current tab` matching the active tab's `pinned` flag.
- On `/workspace` with an aggregation tab active, the palette includes `Run pipeline`, `Explain pipeline`, `Save pipeline`. Collection-only commands (`Run query`, `view.mode.*`) are hidden.
- Closing a workspace tab removes the tab-scoped commands from the palette on the next open without a reload.
- The previous `CmdKStub` is removed; `ConnectionManager.tsx` no longer owns the `⌘K` keyboard listener or the dialog markup.
- The X06 `refs.configure` hint's CTA and the `references.configure` palette command call the same `setRefEditorOpen` setter from `Workspace.tsx` (verified by both being closures over the same component scope).
- A `perform` that throws does not crash the renderer; the palette closes and the error reaches `console.error`.

## 10. Test cases

### Unit

- `commands-registry.spec.ts` — `add` / `list` / `subscribe`; duplicate ids replace and warn once; multiple `add` calls compose; the unregister fn returned by `add` removes only what it added.
- `commands-rank.spec.ts` — fixture catalog + queries → expected order. Covers MRU precedence, prefix > substring, keyword fallback, the fuzzy (subsequence) last bucket, and `hideWhenEmptyQuery`.
- `commands-when.spec.ts` — `when` returning false hides the command; `when` throwing is treated as false and warns once.
- `shortcut-label.spec.ts` — `formatShortcut` writes Mac glyphs as Windows/Linux combinations in the platform's modifier order, passes a label without glyphs through, writes a bare modifier without a dangling plus, and leaves a glyph in the middle of a label alone.

### Component

- `command-palette-shell.spec.tsx` — `⌘K` opens, Esc closes, click-outside closes; focus restored.
- `command-palette-keyboard.spec.tsx` — arrow keys move cursor, Enter performs and closes.
- `command-palette-search.spec.tsx` — typing filters; group headers hide when empty; "no matches" copy.
- `command-palette-mru.spec.tsx` — the stored history seeds RECENT; a perform writes it back, newest first; unknown ids and malformed values are ignored; a failed read leaves an empty RECENT, is logged and is never written over; a perform before the read lands is written merged with the stored list; a failed write toasts.
- `shortcuts-modal.spec.tsx` — the cheat sheet opens from the palette, on `mod+/` and `⌘/`, lists commands with their platform shortcut and the shortcuts that are not commands, files workspace-only and connection-form shortcuts under their own headings, ignores the key inside a text field, an editor or another dialog, and Escape closes it and returns focus; tooltips name the platform shortcut.
- `workspace-palette-namespaces.spec.tsx` — `Open: <db>.<coll>` rows for the focused connection only, found by subsequence and not by the letters of "Open", reusing a tab; Recent per connection on an empty query; the rows read the navigator's own cache (one listing per database, kept while collapsed); a reconnect re-lists every database; a refresh after a change never joins an older listing; the sweep keeps at most 4 collection listings in flight and still reaches every database.
- `workspace-palette-views.spec.tsx` — "Open Shell" opens the shell pane and then offers to close it; "Go to Schema" and "Go to Indexes" switch to the Structure view; no structure entries without a collection tab, and no shell entry without a focused connection.
- `register-commands.spec.tsx` — `useRegisterCommands` registers on mount, unregisters on unmount, replaces on `deps` change.
- `palette-context.spec.tsx` — context exposes the right `pathname` / `connectionId` / `activeTab` for each route fixture.

### E2E

- `palette-connections.e2e.ts` — fresh launch → `⌘K` → search "new" → Enter → lands on `/connections/new`.
- `palette-workspace.e2e.ts` — open a collection tab → `⌘K` → search "json" → Enter → result view switches to JSON. Then `⌘K` → search "save" → Enter → SaveModal opens.
- `palette-aggregation.e2e.ts` — open an aggregation tab → `⌘K` → only `agg.*` commands appear under AGGREGATION; `Run query` is absent.
- `palette-mru.e2e.ts` — perform `Run query`, close + reopen palette, RECENT row is at the top.

## 11. Implementation order

Lands in three commits, each independently mergeable:

1. **Extract + registry, no behavior change.**
   - New files: `src/commands/{types.ts, registry.ts, useRegisterCommands.ts, PaletteContext.tsx, CommandPalette.tsx, GlobalCommands.tsx, ConnectionPaletteCommands.tsx}`.
   - Mount the palette + the `<PaletteContextProvider>` + `<GlobalCommands>` + `<ConnectionPaletteCommands>` in `App.tsx`.
   - Hoist `<SettingsModal>` mount + `settingsOpen` state from `Workspace.tsx` to `App.tsx` (or to a sibling provider) so the global `settings.open` command can open it from any route. The existing `onOpenSettings` prop stays — it now calls a context-provided opener instead of a local setter.
   - Move the `⌘K` listener and dialog markup out of `ConnectionManager.tsx`. The `<TitleBar>` `⌘K` button stays — it dispatches the same toggle the keyboard listener does (via the palette's open/close API exposed on the registry context).
   - Register the existing `connection.new` (global), `theme.toggle` (global), `settings.open` (global), and the dynamic `connection.switch:<id>` rows. Visual parity with today's `CmdKStub`.
   - Tests: registry unit, register-commands hook, shell component, search/keyboard component.
2. **Workspace + connection-context commands.**
   - In `ConnectionManager.tsx`, register `connection.delete` (closure over `setDeleteConfirmOpen`) and `connection.refresh`.
   - In `Workspace.tsx`, register `tab.new`, `tab.new.aggregation`, `tab.close`, `tab.pin.toggle`, and `references.configure`.
   - In the collection-tab subtree, register `query.run`, `query.save`, `query.copy`, and the three `view.mode.*` toggles. (Extract `<CollectionTabBody>` if needed to scope the registrations to the active collection tab; otherwise gate via `when` on `activeTab.kind`.)
   - In the aggregation-tab subtree, register `agg.run`, `agg.explain`, `agg.save`.
   - Tests: palette-context, palette-aggregation E2E, palette-workspace E2E.
3. **MRU + polish.** Session MRU, perform-failure logging, copy review, accessibility pass (`role="dialog"` `aria-modal="true"`, listbox semantics on the result list). Tests: MRU unit + component, palette-mru E2E.

## 12. Risks and mitigations

- **Closure staleness in `useRegisterCommands`.** Same risk as `useCallback` — wrong `deps` array → palette runs an old `perform`. Mitigation: extend `react-hooks/exhaustive-deps` via the `additionalHooks` ESLint config to lint our hook (one-line config addition). Component test that switches the active tab and runs the registered command catches the worst regression.
- **Registry leaks during HMR.** Vite HMR can re-mount components without unmounting the previous instance. Mitigation: registry's `add` overwrites by id (a re-mount registers the same id and replaces the closure rather than duplicating).
- **Shortcut conflicts.** `⌘K` is unused today (`CmdKStub` already claims it). `Tab` inside the palette traps focus only while open. No other keys are claimed.
- **Palette opening from a textarea.** `⌘K` should still open even if a `<textarea>` is focused. Mitigation: install the listener on `document`, not on a contained element; do not check `e.target.tagName`. Verify with the query-bar textarea in tests.

## 13. Amendment — palette v2: search everywhere

> **Implemented.** It supersedes the parts of §1–§12 it names and leaves the rest standing.

### 13.1 Why, and what changes

The v1 palette finds a command when the query is a contiguous piece of its title. Past that it reads as arbitrary:

- The query is one substring, so `prod open` does not find `Open connection → Production` and `orders shop` does not find `Open: shop.orders`.
- Every collection row is titled `Open: <db>.<coll>` and carries the keywords `collection`, `tab`, `new`. Typing `open` returns every collection as a title-prefix match; typing `new` or `tab` returns every collection as a keyword match.
- Inside a rank bucket rows keep registration order. Nothing prefers an exact name or a word start.
- A recently used command that matches at all, even by subsequence, ranks above an exact prefix match.
- Each saved Connection adds three rows (open, edit, delete), all listed on an empty query, above the commands for the tab in front of the user.
- A row that fails does so silently.
- Open tabs, saved queries and most collection actions (export, import, rename, drop, create index) have no row at all.

v2 keeps the registry, the context gating, the persisted MRU and the single `⌘K` entry point, and changes four things: how a query is matched and ranked (§13.2), how results are laid out (§13.3), what a row is — an object with several actions rather than one row per verb (§13.4) — and what the catalog covers (§13.5, §13.6). The model is the "search everywhere" dialog of the JetBrains IDEs: one box, scopes to narrow by kind, a default action on Enter and the rest one key away.

**Baseline.** These commands ship today and are missing from the §5 table. They are listed here so v2 starts from the real catalog; the table's `connection.switch:<id>` row is the third one below.

| Group      | Id                       | Title                              |
| ---------- | ------------------------ | ---------------------------------- |
| general    | `audit.open`             | Open audit log                     |
| general    | `activity.open`          | Show activity log                  |
| general    | `troubleshooting.open`   | Open connection troubleshooting    |
| connection | `connection.open:<id>`   | `Open connection → <name>`         |
| connection | `connection.edit:<id>`   | `Edit connection → <name>`         |
| connection | `connection.delete:<id>` | `Delete connection → <name>`       |
| connection | `connection.export`      | Export Connections…                |
| connection | `connection.import`      | Import Connections…                |
| workspace  | `doc.insert`             | Insert document…                   |
| query      | `query.drawer.toggle`    | Expand / Collapse query drawer     |

### 13.2 Matching and ranking

Replaces §3.

**Tokens.** The trimmed, lower-cased query is split on whitespace. A row matches when **every** token matches it, in any order. Each token is tried against the row's match text, then its subtitle and keywords.

**Match text.** `fuzzyText` is renamed `matchText` and widened: when set, every title match reads it instead of the title, not only the subsequence match. A collection's match text is `<db>.<coll>`, so `open` no longer matches a collection through the `Open: ` prefix. Collection rows drop the keywords `collection`, `tab` and `new`.

**Word starts.** A word starts at the beginning of the text, after a space or one of `. _ - : / →`, and at a lower-to-upper case change (`orderItems` has two words).

**Match classes**, strongest first, per token:

1. **Exact** — the token equals the whole match text, or one whole segment of it. Segments are separated by a space or one of `. : / →`; `_`, `-` and a case change start a word but do not end a segment, so `orders` is exact for `shop.orders` and a word start for `shop.orders_archive`.
2. **Word start** — the token is a prefix of a word.
3. **Initials** — the token, two characters or more, is the first letters of consecutive words: `so` matches `shop.orders`, `rq` matches `Run query`.
4. **Substring** — the token appears inside the match text.
5. **Keyword** — the token appears in the subtitle or in a keyword.
6. **Subsequence** — the token's characters appear in the match text in order. Never reached by a one-character token.

A row's class is the weakest class among its tokens. Rows sort by class, then:

1. position in the MRU, a recently used row first;
2. shorter match text first;
3. registration order.

Recency is a tie-break inside a class, never a class of its own once a query is typed: a recent row that matches by subsequence stays below an exact match. There is no edit-distance matching; `ordres` finds nothing (`oders` still finds `orders`, by subsequence).

**Group order on a typed query.** In All, the kinds are drawn in a fixed order, as on the agreed artboards: Collections, Databases, Tabs, Saved, Connections, Actions, each group in rank order and empty groups left out; a verb alone's `<Verb>…` group comes first. The cursor starts on the first drawn row. In a single scope the rows are in rank order. Before objects existed (step 1) the command groups were ordered by their best row; the kinds replace them.

**Empty query.** RECENT first, as today. Then the groups owned by the tab in front (`query`, `view`, `references`, `aggregation`, whichever have rows), then `workspace`, `connection`, `navigation`, `general`. Objects (§13.4) other than recent ones are not listed until the user types.

**Highlight.** The ranker returns the matched character ranges with each row, and the row renders them emphasised.

**Pasted `_id`.** When the whole query is 24 hexadecimal characters, alone or wrapped as `ObjectId("…")`, and a collection tab is in front, the first row is `Find _id <value> in <db>.<coll>`. Performing it sets that tab's filter to the `_id` and runs it, as one step of the builder's own undo history, so Undo puts the previous filter back. With no collection tab in front the row is absent, and it is listed in All only.

**Failures.** Supersedes the "no toast" rule in §6 and the wording in §8: a `perform` that throws or rejects shows one error toast naming the command, in every build. The palette still closes first.

**Titles.** Every command title is "Verb object" in sentence case: `Open settings`, `Open audit log`, `Open activity log`, `Show keyboard shortcuts`, `Export connections…`, `Import connections…`, `Go to schema`, `Go to indexes`. `Edit selected connection` and the deep screen's `Delete selected connection` are removed in favour of the Connection object's actions (§13.4).

### 13.3 Layout

**Scopes.** A row of scopes sits under the search input: **All**, **Collections**, **Actions**, **Saved**, **Tabs**. `Tab` moves to the next scope and `Shift+Tab` to the previous, wrapping; the query is kept. The scope row is a `tablist` and each scope a `tab`; the input stays the only focused element. This supersedes §4's "`Tab` is intentionally unbound". The palette always opens on All.

| Scope       | Lists                                                               |
| ----------- | ------------------------------------------------------------------- |
| All         | every kind, grouped                                                 |
| Collections | Collection and Database objects                                     |
| Actions     | commands, and nothing else                                          |
| Saved       | saved queries and saved pipelines                                   |
| Tabs        | open tabs                                                           |

Connection objects appear in All only.

**Capped groups.** In All, each kind shows its five best rows, followed by a `Show <n> more` row when there are more. Performing that row switches to the kind's scope with the query kept. A single scope lists its 50 best matches in rank order, then a line reading `Keep typing to narrow <n> more`. Both caps are fixed, so the number of rendered rows never depends on the size of the catalog (§13.7).

**Last query.** Within a session the palette reopens with its previous query in the input, fully selected, so typing replaces it and Enter repeats it. `↑` on an empty input steps back through the session's earlier queries, at most 20; `↓` steps forward. This history is not persisted.

**Toggles.** A command may declare `toggle: { checked: boolean }`. Its row renders a switch showing the state, and performing it flips the state and leaves the palette open with the cursor on the same row. `theme.toggle`, `shell.toggle`, `query.drawer.toggle` and `tab.pin.toggle` become toggles, with fixed titles (`Dark mode`, `Shell`, `Query drawer`, `Pin tab`) in place of titles that flip. This supersedes "performing a command always closes the palette" for toggles only.

**Unavailable commands.** A command may declare `disabledReason: (ctx) => string | null`. When it returns a string the row is listed greyed with the reason as its subtitle, carries `aria-disabled`, and Enter does nothing. `when` keeps its meaning — the command does not apply here at all, and is not listed. Use `disabledReason` where the user would look for the command and wonder where it went: `Copy MQL to clipboard` with no filter typed, `Insert document…` on a view. A disabled row never enters the MRU.

**Direct entry.** `⌘P` opens the palette on the Collections scope. It is listed in the shortcuts cheat sheet under "Anywhere".

**Agreed design.** The UI below was reviewed and agreed in Claude Design, on the canvas "Command palette v2" (ten artboards: empty query, typed query in All, Collections scope, pasted `_id`, failure toast, first-letter lookup, action list, verb and object, verb alone, Filter by field). The build reproduces those artboards; where this section and an artboard differ in copy, the artboard's copy, quoted here, wins. Colours come from the `--atelier-*` tokens in both themes, never from the artboards' dark-theme values: a matched character uses `--atelier-accent-ink` at weight 600, the highlighted row `--atelier-accent-soft`, a destructive action the red tokens.

- **Search row.** A search icon, the input (placeholder `Search collections, actions, tabs…`) and an `esc` key cap at the right.
- **Scope row.** The five scopes as tabs, the selected one in the accent colour. Once a query is typed, each scope but All shows its match count after its name; with an empty query no count is shown. At the right of the row, on an empty query, the hint `Tab to switch scope`. Scope tabs carry `tabIndex={-1}`: a click selects them, the input keeps focus.
- **Rows.** A kind icon (collection, database, connection, tab, saved, command), the title with matched characters emphasised, a muted subtitle on the same line (a collection's Connection name, a Connection's host, a tab's `<db> · <Connection>`, a saved item's namespace), and at the right either the command's shortcut as a key cap or a tag naming the row: `Recent` for a recent row, `Collection` and `Connection` for those kinds under RECENT, `Open tab` for a tab, `Query` or `Pipeline` for a saved item.
- **Show more.** In All, the line under a capped kind reads `Show <n> more collections` (`… more saved`, `… more tabs`), in the accent colour.
- **Row limit line.** Under a scope's list, fixed outside the scrolling area: `Showing the best 50 · keep typing to narrow <n> more`.
- **Footer.** A bar of key hints for the highlighted row, changing with the state:
  - object row: `↵ Open`, `⌘↵ Open in new tab` (only when it has an alternate), `⌥↵ Actions`; on an empty query in All also `⌘P Collections` at the right; in a single scope `⇧Tab <the scope Shift+Tab goes to>` at the right (`⇧Tab All` from Collections);
  - action list: `↵ Run action`, `esc Back to results`, `← Back, on an empty input`;
  - verb in the query: `↵ <action title>` with `(opens its confirm dialog)` for a destructive one, and `⌥↵ All actions`;
  - verb alone: `↵ Switch scope`, and `Keep typing a name: open shop.or` with the verb typed;
  - pasted `_id`: `↵ Find`;
  - field step: `↵ Add "<field>" to the filter (nothing runs)`, `esc Back to actions`.
- **Toggles.** A switch at the right of the row, filled with the accent when on.
- **Unavailable rows.** Title and reason in the ghost text colour, the reason as the subtitle.
- **Pasted `_id`.** Its group is labelled `In the tab in front`; the row reads `Find _id <value> in <db>.<coll>` with the value in the monospace font and the accent colour, and a second line `Replaces the filter and runs it · Undo puts the old filter back`. Below it, `No other matches` when nothing else matches.
- **Failure toast.** Title `Couldn't run "<command title>"`, body the error's message, an error icon and a dismiss button, red border.
- **Action list.** A back button, the object as a chip (its kind icon, its name, and the Connection for a collection: `shop.orders · Production`), and the input with placeholder `Filter actions…`. Every action is one row; the default carries the `↵` key cap and the tag `reuses the open tab` for a collection, the alternate `⌘↵`, `Filter by field…` a `›`. Destructive actions sit last, after a divider, in red with a trash icon and the tag `asks to confirm`.
- **Verb in the query.** A line under the scope row: `Read as the verb <verb> (from "<typed word>")` when an alias was typed, `Read as the verb <verb>` otherwise, followed by `: only things that can be <verb past participle> are listed`, the verb in red when its action is destructive. Each object row shows its action as a tag at the right, a red outlined one for a destructive action.
- **Verb alone.** A group titled `<Verb>…` of rows `<Verb> a collection…`, `<Verb> a connection…`, `<Verb> a tab…`, `<Verb> a saved query…` for the kinds that have the verb, each with its destination at the right (`Collections scope ›`, `All, connections only ›`, `Tabs scope ›`, `Saved scope ›`), then the matching commands under Actions.
- **Connections only.** Connections have no scope of their own. Performing `<Verb> a connection…` keeps All selected and lists Connection objects only, until the query is cleared or the scope changes; the scope row shows a removable `Connections only` chip after All while it holds.
- **Field step.** Two chips, the collection and `Filter by field`, and the input. Groups `Fields · sampled` (field path in the monospace font, its dominant type as a tag), `Starters` (the `FILTER_TEMPLATES` labels), and while the sample loads a `Sampling fields…` status row in place of the fields.

### 13.4 Objects and actions

Lifts the "multi-step / nested commands" deferral in Scope.

A flat row per verb per thing costs `verbs × things` rows and puts `Delete connection → Production` one keystroke from `Open connection → Production`. v2 registers each thing once, with the actions it supports.

```ts
// src/commands/types.ts

export type ObjectKind = 'connection' | 'database' | 'collection' | 'tab' | 'saved';

export interface ObjectAction {
  /** Unique within the object. */
  id: string;
  /** The verb that selects this action from the query, lower case: `open`, `drop`. */
  verb: string;
  /** Row title in the action list: `Open`, `Drop collection…`. */
  title: string;
  /** Confirmed by its own dialog; styled as destructive and never the default. */
  destructive?: boolean;
  disabledReason?: (ctx: PaletteContext) => string | null;
  perform: (ctx: PaletteContext) => void | Promise<void>;
}

export interface PaletteObject {
  /** Stable and unique across kinds; what the MRU stores. */
  id: string;
  kind: ObjectKind;
  /** Shown as the row title and matched as the match text. */
  name: string;
  subtitle?: string;
  keywords?: string[];
  /** The first action is the default, performed on Enter. */
  actions: ObjectAction[];
}
```

Objects register through `useRegisterObjects(objects, deps)`, which follows `useRegisterCommands` in every respect: same registry module, same replace-by-id rule, same unregister on unmount. Commands stay as they are for everything that is not an action on a named thing.

**Ids.** A Collection object's id is `tab.open:<connectionId>:<db>:<coll>` and a Connection object's is `connection.open:<id>` — the ids their v1 rows carry — so a stored MRU keeps working. An MRU entry names the object; performing any of its actions bumps it.

**Keys on an object row.**

| Key                         | Behaviour                                                                 |
| --------------------------- | ------------------------------------------------------------------------- |
| `Enter`                     | The default action.                                                       |
| `⌘↵`                        | The object's alternate action, where it has one (below).                  |
| `⌥↵`, or `→` at the end of the input | Open the object's action list.                                   |
| `Esc`, or `←` / `Backspace` on an empty input, in the action list | Back to the results, query and cursor kept. |

This supersedes §4's "`⌘↵` is the same as Enter". On a command row both keys still perform it.

**Action list.** The second step. The input shows the object's name as a fixed leading chip and filters the object's actions by the same matcher; the list shows every action, destructive ones last and marked. Enter performs and closes. The scope row is hidden while it is open.

**Verbs in the query.** When the query's first token is a verb, or an alias of one, and at least one more token follows, that token is read as a verb: objects are matched on the remaining tokens, only objects with an action for the verb are listed, and each listed object's row shows that action and performs it on Enter. Commands are matched on the whole query at the same time, so `open settings` still finds `Open settings`. In a single scope, or while Connections only holds, a verb alone lists every object of that scope that has the action, each showing it. In All, a verb alone lists one row per object kind that has it (`Open a collection…`, `Open a connection…`), each switching to that kind's scope, above the commands the word matches.

| Verb         | Aliases                  |
| ------------ | ------------------------ |
| `open`       | `go`, `switch`, `show`   |
| `edit`       | `modify`                 |
| `delete`     | `remove`, `drop`         |
| `close`      |                          |
| `rename`     |                          |
| `run`        | `execute`                |
| `query`      | `find`                   |
| `filter`     |                          |
| `aggregate`  | `pipeline`               |
| `schema`     | `structure`              |
| `indexes`    | `index`                  |
| `export`     |                          |
| `import`     |                          |
| `pin`        | `unpin`                  |
| `disconnect` |                          |

**Destructive actions** are reachable only from the action list or by typing their verb. They are never a default, never an alternate, and each still opens the confirmation dialog it opens from the rest of the app; the palette confirms nothing itself.

**Actions per kind.** The default is first; the alternate, where there is one, is marked.

| Kind       | Actions                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| connection | Open · Edit · Disconnect (when connected) · Delete…                                                                                                 |
| database   | Reveal in navigator · Create collection… · Drop database…                                                                                           |
| collection | Open (reuses an open tab) · Open in new tab (alternate) · Query… · Filter by field… · Aggregate · Schema · Indexes · Export… · Import… · Rename… · Drop… |
| tab        | Switch to · Close · Pin / Unpin                                                                                                                     |
| saved      | Open · Run (alternate) · Rename… · Delete…                                                                                                          |

Each action calls the handler the same control calls elsewhere in the app; none is reimplemented for the palette. Actions that write are disabled, with a reason, on a view.

**What it replaces.** The `connection.open:<id>`, `connection.edit:<id>` and `connection.delete:<id>` command families and the `tab.open:…` family become Connection and Collection objects. `connection.edit` and both `connection.delete` registrations are removed.

### 13.5 Catalog coverage

**Objects.**

- **Tabs.** One object per open tab, named as its tab is. Registered by `Workspace.tsx`, which owns the tab list.
- **Saved.** One object per saved query and saved pipeline of the focused Connection, read with `api.saved.list` when the palette opens and again when a save, rename or delete lands. The subtitle is the namespace.
- **Databases.** One object per database of each Open Connection, from the navigator's cache.
- **Collections of every Open Connection.** v1 lists the focused Connection's collections only. v2 lists those of every Connection that is connected, with the Connection's name as the subtitle; a Connection that is not connected still contributes nothing, as [X16](./X16-multi-connection.md) §4.2 requires. The palette asks a server for nothing on their behalf: the sweep stays what it is in v1, for the focused Connection only, and another connected Connection contributes the collections the navigator has already listed for it. Focusing that Connection sweeps it, as today.

**Commands added**, for actions that have none today and are not actions on a named object:

| Group       | Id                   | Title                    |
| ----------- | -------------------- | ------------------------ |
| workspace   | `tab.new.script`     | New script tab           |
| workspace   | `collection.create`  | Create collection…       |
| query       | `query.explain`      | Explain query            |
| view        | `index.create`       | Create index…            |
| connection  | `monitor.open`       | Open monitor             |
| connection  | `users.open`         | Open users               |
| connection  | `roles.open`         | Open roles               |

Each is gated by `when` or `disabledReason` exactly as the control it mirrors is shown or disabled.

### 13.6 Starting a query

The app builds queries with the builder; the palette does not take typed filter text, and nothing here parses a query. Each entry below leaves the user in the builder with part of the work done.

- **Query…** (Collection action). Opens the collection, reusing an open tab, expands the query drawer and puts focus on the builder's first field input.
- **Filter by field…** (Collection action). Opens a third step listing the collection's fields from the sampled schema, with each field's dominant type as the subtitle, followed by the starter rows of `FILTER_TEMPLATES` (`Last 7 days`, `Exists and is not null`, `Contains text (any case)` …). Choosing a field opens the collection and appends one condition on that field to the root of the filter, focus in its value input. Choosing a starter row appends that row with focus in its field input.
  - The condition is **appended** with `andAtRoot`, as one step of the builder's undo history. The filter already on the tab is kept, so there is no unsaved-edits question to ask.
  - The field list comes from the schema-sample cache the field suggestions already use. An uncached collection is sampled once; the step shows a loading row until it lands and `No fields sampled` when the sample is empty or fails. The starter rows are listed either way.
  - Nothing runs. The user fills in the value and runs the query as usual.
- **Run** (Saved action) opens a saved query or pipeline and runs it. **Open** only loads it.
- **Pasted `_id`** — §13.2.

Only finds and aggregations run from the palette. No action here writes to a collection without the dialog that guards it elsewhere.

### 13.7 Performance

v2 must not make the app slower, anywhere, for any catalog size. These are requirements, not goals; a step that cannot meet one does not ship.

**Measured baseline (v1).** `rankCommands` plus `groupRows`, median of 15 runs under vitest on a development machine, 40 commands plus *n* collection rows:

| Collections | Empty query | `o`     | `ord`  | No match | Rows returned for `o` |
| ----------- | ----------- | ------- | ------ | -------- | --------------------- |
| 1,000       | 0.1 ms      | 0.2 ms  | 0.2 ms | 0.1 ms   | 1,040                 |
| 10,000      | 0.6 ms      | 1.3 ms  | 1.4 ms | 1.2 ms   | 10,040                |
| 50,000      | 3.7 ms      | 8.3 ms  | 8.4 ms | 7.0 ms   | 50,040                |

Registering, listing and unregistering 50,000 rows took 6.4 ms. Ranking is not where v1 spends its time. Rendering is: v1 mounts one DOM row per match, so a single `o` on a 10,000-collection deployment mounts 10,040 rows. That cost was not measured here, and v2 removes it rather than tunes it.

**Rules.**

1. **No new server calls.** Opening the palette, typing in it and moving through it send nothing to a MongoDB server. Collections and databases come from the navigator's cache as it already stands. The one exception is `Filter by field…`, which the user asks for explicitly, and which makes at most one schema sample through the existing cache, so the builder that opens next does not sample again.
2. **No new work while closed.** The palette's content stays unmounted while it is closed, as in v1. Objects register through the same registry on the same triggers as today's rows; nothing polls, and nothing recomputes on a timer.
3. **Bounded rendering.** At most five rows per kind in All and 50 rows in a scope (§13.3), whatever the catalog holds. The ranker returns the total count for the `more` lines without materialising the rows behind it.
4. **Ranking inside one frame.** The v2 ranker, on the probe above, takes no more than 16 ms at 50,000 collections for any query. Text that does not change between keystrokes (lower-cased match text, word starts, initials) is computed once per registration, not once per keystroke.
5. **Local reads once per open.** The saved-query list is one local `saved:list` read when the palette opens, never per keystroke.
6. **No regression in the app.** Before step 1 and after each of steps 1 to 4 (§13.9), the built app is measured against a 10,000-collection fixture: time from `⌘K` to the first painted list, and time from a keystroke to the next paint. A step whose numbers are worse than the step before it does not merge. Worse means a median above the earlier one by more than their run-to-run spread, taken from runs of the two builds alternated on the same machine: back-to-back runs of one build differ by about a millisecond. The numbers go in the pull request.

### 13.8 Not in scope

- A shorthand query language (`orders status:paid total>100`), or typing or pasting filter text or shell commands into the palette.
- Natural-language queries.
- Edit-distance (typo-tolerant) matching.
- Searching document contents across collections.
- A preview pane for the highlighted row.
- Double-tap modifier triggers, and separate dialogs for search, actions and running.
- Rebinding shortcuts from the palette.

### 13.9 Build order

Each step ships on its own and leaves the palette working. Two things come before any of them:

- **Design review.** Done. The UI and UX of §13.3, §13.4 and §13.6 were reviewed and agreed in Claude Design; the outcome is "Agreed design" in §13.3.
- **Baseline measurement.** The in-app numbers of §13.7 rule 6 are taken on v1.

1. **Ranking.** §13.2 against the v1 flat rows: tokens, classes, `matchText`, recency as a tie-break, the empty-query order, highlight, the failure toast, the title pass, the pasted `_id` row. Per-Connection edit and delete rows get `hideWhenEmptyQuery` until step 3 removes them.
2. **Layout.** Scopes, capped groups, the last query and query history, toggles, `disabledReason`, `⌘P`.
3. **Objects.** The object type, registry and hook, the action list, verbs, and the move of Connections and Collections to objects.
4. **Coverage.** Tab, Saved and Database objects, collections of every Open Connection, the added commands.
5. **Query entry.** `Query…` and `Filter by field…`.

### 13.10 Acceptance criteria

- `prod open` and `open prod` both list `Production` with its Open action first; `orders shop` finds `shop.orders`.
- Typing `open`, `new` or `tab` matches no collection through a title prefix or keyword: a collection without the word in its `<db>.<coll>` matches only by subsequence (§13.2), so inside its group it ranks below every collection matching by word start. Groups keep the fixed kind order of §13.2, and in a single scope a verb typed alone lists that scope's objects (§13.4).
- For the query `orders`, a collection named exactly `orders` ranks above `orders_archive`, which ranks above `reorders`.
- `so` finds `shop.orders`; `rq` finds `Run query`.
- A recently used row that matches by subsequence ranks below a row that matches by word start.
- With an empty query and a collection tab in front, the Query and View groups are listed above Connection and General, and no per-Connection edit or delete row is listed.
- Matched characters are emphasised in every listed row, in its title or its subtitle. Three kinds of row show none: a row matched by a hidden keyword alone, a verb row reached through an alias (the query names the verb, not the row), and an unavailable row, drawn in the ghost colour (§13.3).
- A command whose `perform` rejects shows one error toast naming it.
- Pasting a 24-character hexadecimal string with a collection tab in front offers the `_id` row first; performing it filters the tab to that document, and Undo in the builder restores the previous filter.
- `Tab` and `Shift+Tab` cycle the five scopes and keep the query; the palette always opens on All.
- In All, no kind shows more than five rows, and `Show <n> more` switches to that kind's scope.
- Reopening the palette shows the previous query selected; `↑` on an empty input recalls the one before it.
- Performing a toggle flips its switch and leaves the palette open on the same row.
- `Copy MQL to clipboard` is listed greyed with its reason when the filter is empty, and Enter on it does nothing.
- `⌘P` opens the palette on Collections.
- Enter on a collection reuses its open tab; `⌘↵` opens a second tab; `⌥↵` lists its actions.
- `drop orders` lists `orders` with Drop as its action, and performing it opens the drop-collection confirmation; no destructive action is listed for the plain query `orders` outside the action list.
- With several Connections saved, an empty query lists no row per Connection beyond recent ones.
- An open tab is found by its name and Enter switches to it.
- A saved query is found by its name; Enter opens it and `⌘↵` runs it.
- With two Connections connected, collections of both are listed, each with its Connection's name; a Connection that is not connected contributes none.
- `Filter by field…` on a collection with a filter already set appends one condition on the chosen field, keeps the existing filter, puts focus in the new value input, and runs nothing.
- `Filter by field…` on a collection whose sample fails still lists the starter rows.
- A stored MRU written by v1 still shows its collections and Connections under RECENT.
- Opening the palette, typing and navigating in it send no request to a MongoDB server; only `Filter by field…` does, at most one schema sample.
- With 10,000 collections cached, no query renders more than 50 result rows in a scope or five per kind in All.
- The ranker stays within 16 ms at 50,000 collections on the §13.7 probe (`npm run perf:rank`; opt-in, since a 16 ms wall-clock assertion flakes under the full suite's load, which keeps a coarse guard).
- The in-app measurements of §13.7 rule 6 are no worse after each step than before it, in the sense rule 6 gives worse.
- Every row, scope and action is reachable and operable from the keyboard, and the highlighted row is announced through `aria-activedescendant` in the results and in the action list.

### 13.11 Test cases

**Unit**

- `commands-rank.spec.ts` — token order independence; each match class and their order; word starts at separators and case changes; initials; `matchText` shielding the title; recency as a tie-break only; shorter-text tie-break; the empty-query group order; matched ranges; the pasted-`_id` detector, bare and wrapped, and its rejects.
- `commands-rank.property.spec.ts` — a row listed for a query is listed for any reordering of its tokens; every returned range lies inside the text it refers to; adding a token never adds a row.
- `commands-verbs.spec.ts` — a leading verb or alias with a following token selects the action; a verb alone yields the per-kind rows; a verb an object lacks hides the object; a command matching the whole query is still listed.
- `commands-registry.spec.ts` — objects add, replace by id and unregister as commands do.

`rank.ts` and the verb parser belong in `stryker.config.json`'s `mutate` array, at the 90% bar.

**Component**

- `command-palette-scopes.spec.tsx` — `Tab` / `Shift+Tab` cycling and wrapping; per-scope contents; the five-row cap and `Show <n> more`; the row limit line.
- `command-palette-history.spec.tsx` — the last query selected on reopen; `↑` / `↓` through earlier queries; nothing persisted.
- `command-palette-toggles.spec.tsx` — a toggle flips and keeps the palette open on its row; a disabled row is listed with its reason, is not performed and never enters the MRU.
- `command-palette-objects.spec.tsx` — Enter, `⌘↵` and `⌥↵` on an object; the action list, its filter and its way back; destructive actions listed last and reachable only there or by verb; a v1 MRU id resolving to its object.
- `command-palette-failure.spec.tsx` — a rejecting `perform` toasts once.
- `workspace-palette-objects.spec.tsx` — tab, saved, database and multi-Connection collection objects; none from a Connection that is not connected.
- `workspace-palette-filter-field.spec.tsx` — fields from the sample cache; the loading and empty states; a chosen field appended to an existing filter with focus in its value; a starter row; nothing run. Needs the stateful wrapper, since the appended row shows only once the patch comes back through props.

**E2E**

- `palette-search.e2e.ts` — `⌘K`, two words in the wrong order, Enter lands on the collection; `⌘P` opens on Collections.
- `palette-object-actions.e2e.ts` — a collection's action list, Export… opens the export dialog; `drop <name>` opens the confirmation and cancelling leaves the collection.
- `palette-filter-field.e2e.ts` — `Filter by field…`, pick a field, type a value, run, and the result is filtered.

### 13.12 Resolved questions

- **Row limit.** Fixed at five per kind and 50 per scope (§13.3). Any fixed cap bounds the DOM, so the choice needs no measurement; the measurement that matters is the before-and-after one in §13.7 rule 6.
- **Sweeping every Open Connection.** Dropped. It would multiply the listings made on connect, and §13.7 rule 1 forbids it. Other connected Connections contribute what the navigator has already listed (§13.5).
- **`⌘P`** is free. The application menu (`electron/security/appMenu.ts`) has no Print item and no item bound to it, the only `globalShortcut` is a development-only reset, and nothing in the renderer listens for it.
- **Disconnect** lives in `Workspace.tsx`'s `useConnectionDialogs`, which asks first when the Connection has open tabs. Connection objects register above `<Routes>`, so the action travels as a `disconnectConnectionId` route intent, the way open, edit and delete already do, and reaches that same handler and dialog.
- **Initials against word starts.** Word start stays the stronger class (§13.2). A collection with a word starting with the query, such as `reports.sorted` for `so`, lists above `shop.orders`; recency breaks ties only inside a class.
- **Saved `Rename…`.** No dialog: it opens the collection's tab on Documents with its Saved list showing, and puts the entry in that list's own inline rename input (W09 §8). An open pipeline tab of that saved pipeline takes the new name. On a Connection that is not connected it says to connect first, as Export… does.
- **Kind order in All.** Fixed, as the artboards draw it (§13.2, "Group order on a typed query"), so the layout does not reshuffle between keystrokes.
- **Additions from the design review.** The footer key hints, the scope counts, the verb line, the row tags and the Connections-only state were not in the first draft; the review kept them (§13.3, "Agreed design").
- **Reveal in navigator** for a database: `DbCollectionNavigator`'s reveal request accepts a database on its own, which it expands, scrolls to and focuses. The request lives in `Workspace.tsx`, so the palette and the tab menu share it. `reveal` is not a verb (§13.4), like `create`: under `open` it would list every database.
