# X07 — Command palette

> **Status: Implemented.** Rebuilt on Mantine Spotlight during [X12](./X12-mantine-migration.md).

## Purpose

Give the user one keystroke (`⌘K` / `Ctrl+K`) to reach every action in the app. Replaces the hardcoded `CmdKStub` in `ConnectionManager.tsx` with a global, extensible palette backed by a renderer-side registry. Two wins:

1. **Discoverability.** Hidden features become self-documenting — searching "reference" surfaces the references editor; searching "save" surfaces the Save dialog. The X06 hints solve "how do I notice this exists in context"; the palette solves "I know it exists, where is it".
2. **Reach.** Power users skip menu-hunting and get to any action with three keystrokes (`⌘K`, type, Enter), regardless of which page or tab they're on.

The palette ships as renderer-only — no IPC. State lives in React context; the catalog is dynamic (commands register themselves when their owning component mounts and unregister on unmount).

## Scope

- **In**: `Command` type, `CommandRegistry` context, `useRegisterCommands(commands)` hook, `<CommandPalette>` component mounted globally in `App.tsx`, `⌘K` / `Ctrl+K` global shortcut, Esc to close, ranked search, grouped results, keyboard navigation, recent-commands MRU (persisted across relaunches, §7), v1 catalog covering Connections / Workspace (collection + aggregation) / global.
- **Out** (deferred):
  - **Per-command keybindings** — the palette displays existing shortcuts (e.g., `⌘T`) but does not own them. Rebinding lives in a future `keybindings` spec.
  - **Multi-step / nested commands** ("Open recent query > pick which one") — v1 flattens dynamic sublists into top-level entries (e.g., `connection.switch:<id>` per connection). A "deferred run with parameters" UX waits.
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
- Session MRU `string[]` of recently performed command ids (cap 10).

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
