# X06 — Contextual feature hints

> **Status: Implemented.**

## Purpose

Make non-obvious features discoverable at the moment a user would want them. The diagnostic for this spec is concrete: the project's own developer could not find how to configure document references (X05) without reading the source. The fix is not a one-time guided tour — it is small, dismissible, anchored callouts that fire when the user is in the right context, persist their dismissal, and stay out of the way otherwise.

## Scope

- **In**: hint registry, `<FeatureHint>` popover component, `useFeatureHint(id, when)` hook, dismissal persistence in `app_state`, a catalog of hints (Run, configure references, pin a tab, save a query, palette, suggestion keys, and the behaviour-triggered startup restore, Monitor, Indexes and find-options hints; see §4), and a "Reset hints" action in Settings.
- **Out** (deferred):
  - Full command palette / Cmd-K — specified in [X07](./X07-command-palette.md); since shipped.
  - Multi-step tours (next / back / skip).
  - Telemetry on hint impressions / dismissals.
  - Hint authoring UI — the catalog is a code-defined constant in v1.

## Dependencies

- F02 (`app_state` table) — already in place.
- X01 (`prefs:get`, `prefs:set`) — already in place.
- X05 (document references) — provides the first hint's trigger surface.
- W09 (saved queries) — provides the third hint's anchor.

## 1. Types

```ts
// shared/types.ts (runtime-free)

export type FeatureHintId =
  | 'run.execute'
  | 'refs.configure'
  | 'tabs.pin'
  | 'saved.create'
  | 'palette.discover'
  | 'suggestions.keyboard'
  | 'startup.restore'
  | 'monitor.live'
  | 'monitor.profiler'
  | 'indexes.usage'
  | 'find.options';

export interface FeatureHintDismissalState {
  dismissedIds: FeatureHintId[];
  resetAt?: string; // ISO; bumped when the user clicks "Reset hints"
}
```

```ts
// src/hints/registry.ts (renderer-only)

export interface FeatureHintCopy {
  id: FeatureHintId;
  title: string;          // <= 60 chars
  body: string;           // <= 200 chars, plain text
  ctaLabel?: string;      // optional primary action label; the call site supplies the handler
  priority: number;       // lower wins when several hints qualify at once
}
```

The trigger condition (`when`) is not stored in the registry — it's evaluated at the call site via `useFeatureHint(id, when)` because the conditions reference live UI state (current tab kind, query results, click counts).

## 2. Persistence

Single `app_state` key:

| Key                   | Shape                              |
| --------------------- | ---------------------------------- |
| `ui.hints.dismissed`  | `FeatureHintDismissalState`        |

Dismissal is permanent until the user clicks **Settings → Reset hints**, which clears `dismissedIds` and bumps `resetAt`.

No new IPC channels. The renderer uses the existing `api.prefs.get` / `api.prefs.set` with the new key. Typed helpers go on `window.atelier.prefs`:

- `prefs.getDismissedHints(): Promise<FeatureHintDismissalState>`
- `prefs.dismissHint(id: FeatureHintId): Promise<void>`
- `prefs.resetHints(): Promise<void>`

These are thin wrappers around `prefs.get`/`prefs.set`; no router changes needed beyond exposing them on the bridge.

## 3. Renderer architecture

### `HintsProvider`

Top-level context that:

1. Loads `ui.hints.dismissed` once at mount via `api.prefs.getDismissedHints`.
2. Exposes `{ isDismissed(id), dismiss(id), reset() }`.
3. Coordinates **at most one visible hint at a time**: when several qualify at once, the one with the lowest registry `priority` shows (ties keep mount order). The others stay mounted but render nothing until it dismisses.

Provider lives in `src/pages/App.tsx` so every page sees it. State is in-memory; the source of truth is `app_state` via prefs.

### `useFeatureHint(id, when)`

```ts
function useFeatureHint(
  id: FeatureHintId,
  when: boolean,
): { visible: boolean; anchorRef: RefObject<HTMLElement>; dismiss: () => void };
```

- `visible` is `true` only when: registry has the id, `isDismissed(id)` is false, `when` is true, and the provider's "one at a time" gate allows it.
- `dismiss()` calls `api.prefs.dismissHint(id)` and updates the provider's set.
- The hook does **not** poll — `when` is reactive, so the parent component recomputes it from React state.

### `<FeatureHint>`

Anchored popover (use existing popover primitive from X05's `ReferenceHoverPopover` if portable; otherwise a sibling). Renders:

- Title (bold, single line).
- Body (1–2 lines).
- Optional CTA button on the left, "Got it" on the right.
- Close (`×`) in the corner — same effect as "Got it".

Click-outside does **not** dismiss — only explicit "Got it", CTA, or `×` does. This avoids accidentally clearing a hint the user didn't read.

#### Focus and keyboard

A hint appears on conditions such as `run.execute` while the user is typing, so it never takes focus by itself — moving focus on appear would swallow keystrokes.

- **Announcement.** When a hint appears, focus stays where it is and the title is written into a visually hidden `aria-live="polite"` region (no `role="status"`, so the page's real status regions stay the only ones) that stays mounted whether or not the hint shows (a live region is only spoken when its text changes). The popover itself mounts fresh on every show, so a hint that hid without a blur never keeps a stale trap or return spot.
- **F6.** The deliberate way in. While a hint is visible, F6 (a window `keydown` listener that exists only while the hint is visible) calls `preventDefault` and moves focus to the hint's "Got it" button. It is ignored while a modal is open (`[role="dialog"][aria-modal="true"]`). The element that had focus is remembered.
- **Trap.** While focus is inside the hint, Tab wraps within it (Mantine `FocusTrap`, active only while focus is inside the popover). The popover is `role="dialog"` with `aria-modal="false"` and `aria-describedby` pointing at the body text.
- **Escape.** Escape inside the hint dismisses it and calls `stopPropagation`, so an ancestor's Escape handler (closing a drawer, say) does not also run.
- **Return.** On dismiss (Escape, `×`, "Got it") or CTA, focus goes back to the element F6 took it from. A hint that focus never entered, or that focus has since left, restores nothing.

### Settings panel

Add a single row to the existing Settings UI: **Hints** — `[Reset hints]` button. Clicking it calls `api.prefs.resetHints()` and shows a 2-second toast "Hints reset — you'll see them again as you use the app."

## 4. Initial catalog (v1)

| Id                | Title                              | Body                                                                                                  | Trigger (`when`)                                                                                                  | Anchor                                  | CTA                                |
| ----------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| `run.execute`     | Press Run to see your results      | Cmd+Enter (Ctrl+Enter on Windows/Linux) runs the query without leaving the keyboard.                  | Documents view of a collection tab, no run in flight, the filter parses, and the query on screen has not yet been run this session (its run-key tally is 0). | The Run button in the query bar         | none (close-only)                  |
| `refs.configure`  | Link this field to another doc?    | Fields ending in `_id` or `Id` can become clickable references. Configure a rule to follow them.       | Active tab is a collection tab, last run returned ≥1 row, ≥1 visible field matches `/(.+)(_id\|Id)$/`, and no enabled rules exist for the collection. | "References" button above ResultViewer  | "Configure references" → opens editor |
| `tabs.pin`        | Pin this tab                       | Pinned tabs stay at the front of the strip and are easy to find later. Right-click any tab to pin it.               | Session tab-switch counter ≥ 3 and the user has zero pinned tabs.                                                  | The active tab in the tab strip         | none (close-only)                  |
| `saved.create`    | Save this query                    | Run something useful? Save it for one-click reuse from the Saved tab.                                | Same `(connectionId, dbName, collection, queryHash)` was just executed for the 3rd time in this session.           | The "Save" button on the query toolbar  | "Save now" → opens save dialog     |
| `palette.discover`| Find any action with ⌘K            | Press ⌘K (Ctrl+K on Windows/Linux) to search every action — switch connections, run queries, configure references, and more. | The user has not opened the palette this session (`getSessionEventCount('palette', 'opened') === 0`).               | The `⌘K` button in the title bar         | "Try it" → opens the palette       |
| `suggestions.keyboard` | Navigate suggestions          | Tab inserts the highlighted item. ↑↓ to pick another, then Enter or Tab. Esc to close.                                                       | Any suggestion popover is open (X02 §5) and the hint state has loaded.                                             | A footer line under the popover's list, not a floating hint | none; the first pick dismisses it |
| `startup.restore` | Your tabs were reopened | Tabs from last time came back. You can turn this off in Settings → Reopen tabs on launch. | At least one tab was in the first tab list the renderer read after launch (main has already restored, or cleared when the pref is off, by then). A tab opened later in the session never qualifies, and the hint does not repeat after a Workspace remount once shown. | The workspace tab strip | "Open settings" → opens the Settings modal |
| `monitor.live` | This list refreshes on its own | It refreshes every 5 s while the window is visible; Pause stops it. Kill asks first, and whatever the operation already wrote stays written. | The Monitor tab is shown for a connected connection. The interval in the copy is built from `MONITOR_POLL_MS`, the constant the tab polls on. | The Pause button | none (close-only) |
| `monitor.profiler` | Profiling stays on until you turn it off | The level is a server-side setting for this database, so it keeps running until you set it back to Off. Profiling can add write load. | The profiler's Apply succeeded with Slow or All; a failed Apply, an Apply to Off, or picking another database does not qualify. | The Profiler section | none (close-only) |
| `indexes.usage` | What the Use column counts | Use counts how often queries used an index since the date in its tooltip (server restart or index creation). Near zero over a long window: a drop candidate. | The Indexes list holds at least one index with usage data (`$indexStats`). The UI has no hide/unhide control, so the copy does not suggest one. | The "Use" column header | none (close-only) |
| `find.options` | Collation and hint apply to the whole query | They apply to Run, the count, export and Copy code. Delete by filter and bulk update refuse while one is set: clear it first. | The query bar's options row is open and the collation or the hint is non-blank. | The collation/hint row of the query bar | none (close-only) |

Priority order (lowest wins): `run.execute` 0, `refs.configure` 10, `tabs.pin` 20, `saved.create` 30, `palette.discover` 40, `suggestions.keyboard` 50 (inline, so never competes), `startup.restore` 60, `monitor.live` 70, `monitor.profiler` 80, `indexes.usage` 90, `find.options` 100. The behaviour hints rank below every original one, so they never pre-empt the primary path. The primary path, Run, always beats a secondary hint.

`queryHash` is a stable hash over `(filter, projection, sort, limit, skip)` — already computed for the recents feature; reuse.

`suggestions.keyboard` is the one inline hint: `SuggestionPopover` reads `useHints()` directly instead of `useFeatureHint`, so it never takes the floating slot and is not subject to the one-hint-at-a-time rule. It is dismissed through the same `dismiss(id)` and comes back with **Reset hints**.

The session-scoped counters (`tabs.pin`, `saved.create`, `palette.discover`, and the run tally `run.execute` reads) live in `HintsProvider` memory and reset on app start. They are **not** persisted — once you dismiss, the counter is moot.

## 5. Behavior

- Hints that the user has dismissed never re-render until **Reset hints**.
- Only one hint visible at a time — the qualifying hint with the lowest registry `priority` wins; the others wait silently.
- Hints are passive: showing one never blocks input, never moves focus on its own (F6 is the user's own request to move it), and never animates the underlying UI.
- A hint must not appear within the first 1.5 s of a renderer mount — gives the layout time to settle so the popover doesn't visibly jump.
- All copy lives in the registry constant. No translation layer in v1.

## 6. Error handling

- `prefs.getDismissedHints` failure → assume empty dismissed list (fail-open: better to over-show than to wrongly suppress).
- `prefs.dismissHint` failure → keep the hint dismissed in memory for this session, log via `electron/log.ts`. The next session may reshow it; that's acceptable.

## 7. Acceptance criteria

- `ui.hints.dismissed` round-trips through `app_state` (set, relaunch, get returns the same value).
- `prefs.getDismissedHints` / `prefs.dismissHint` / `prefs.resetHints` are exposed on `window.atelier.prefs` and typed in `shared/ipc.ts`.
- On a collection tab whose results contain an `_id`-suffixed field and which has no reference rules, the **References** button shows the `refs.configure` hint exactly once.
- Clicking "Got it" dismisses the hint and it does not re-appear after relaunch.
- Clicking the CTA dismisses the hint and opens the references editor in the same gesture.
- After three tab switches with zero pinned tabs, the `tabs.pin` hint anchors to the active tab.
- After running the same query three times, the `saved.create` hint anchors to the Save button.
- If two trigger conditions become true simultaneously, only the lower-`priority` hint is rendered; the other waits.
- Settings → Reset hints clears the dismissed list and the next eligible trigger reshows its hint.
- No hint appears within 1.5 s of cold renderer mount.
- A hint appearing leaves focus where it was and is announced through a polite live region.
- F6 moves focus to the visible hint's "Got it" button, and does nothing while a modal dialog is open.
- Escape inside a hint dismisses it without reaching ancestor handlers; focus returns to where F6 found it.

## 8. Test cases

### Unit
- `hints-registry.spec.ts` — registry contains every `FeatureHintId`; copy lengths within bounds; `run.execute` has the lowest `priority`.

### Integration
- `hints-prefs-roundtrip.spec.ts` — `prefs.dismissHint('refs.configure')` then `prefs.getDismissedHints()` returns `{ dismissedIds: ['refs.configure'] }`; `prefs.resetHints()` clears it and bumps `resetAt`.

### Component
- `feature-hint.spec.tsx` — `<FeatureHint visible>` renders title/body/CTA; "Got it" calls `dismiss`; `×` calls `dismiss`; click-outside does **not** call `dismiss`; focus does not move on appear; F6 focuses "Got it" (and is ignored over a modal); Tab wraps inside; Escape dismisses, restores focus and is not seen by a parent.
- `hints-provider.spec.tsx` — when two hooks request visibility at once, only the first renders; dismissing it lets the second appear.
- `refs-configure-hint.spec.tsx` — mocked workspace tab with ObjectId-bearing rows and no rules → hint visible; with rules present → hint hidden; after dismiss → hint hidden on re-render.

### E2E
- `hints-persist.e2e.ts` — trigger `refs.configure`, click "Got it", relaunch app, reproduce trigger conditions, assert hint does **not** reappear. Then Settings → Reset hints, assert it does reappear.
