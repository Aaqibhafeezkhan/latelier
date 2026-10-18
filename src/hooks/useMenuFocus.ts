import React from 'react';

/**
 * X19/#55/#68/#69/#87 — dismiss and focus management for a hand-rolled
 * (non-`ContextMenu`-component) context menu: `TableView`'s cell/field
 * menus, `TreeView`'s field menu. Replaces `useKeyboardMenuFocus` and
 * `useMenuDismiss`, which used to split this job in two — see #87 for why
 * that split was the bug.
 *
 * The shared Mantine-backed `ContextMenu` doesn't need this: `Menu`'s own
 * `FocusTrap` grabs focus on open regardless of how it was opened, and its
 * `handleClose` restores focus itself. #87 measured whether `ContextMenu`
 * has the same "outside click steals focus back" defect this hook fixes,
 * against jsdom + `userEvent` (`ContextMenu`, an `outside` button, a click on
 * that button) — it does not: Mantine's outside-click dismiss fires on
 * `pointerdown`, before the click's own focusing step runs, so `handleClose`'s
 * unconditional `.focus(returnFocusTo)` is already done by the time the
 * browser moves focus to the actually-clicked element, and the browser's
 * focus wins. That ordering is also why the unconditional call is *correct*
 * for Escape and item activation, where nothing else is competing for focus.
 * Nothing to fix there; no shared predicate was worth extracting for a
 * defect that doesn't reproduce.
 *
 * ## Two independent defects, one root cause
 *
 * `close` fires on any window click, wherever it lands — a click is a
 * deliberate statement of where the user wants to be, and the old dismiss
 * listener couldn't tell "landed on nothing focusable" from "landed on
 * another control" (#87's first facet). Separately, the old focus hook's
 * cleanup fired on *any* dependency change, including one open being
 * replaced by another (a second right-click, no close in between) — so it
 * restored focus to the *previous* menu's target even though nothing had
 * closed (#87's second facet, filed as a comment on the same issue).
 *
 * Both are fixed by moving the restore out of an effect cleanup and into the
 * effect body, gated on `menu` having actually become `null`: a replacement
 * goes non-null -> non-null, so that branch never runs for it, by
 * construction. And the click listener decides suppression by reading
 * `document.activeElement` *inside* the click handler, which runs after the
 * browser's own focusing steps for that click — so it already knows where
 * (if anywhere) focus landed:
 *
 * | click target | `document.activeElement` after | so |
 * |---|---|---|
 * | a focusable control | that control | suppress the restore |
 * | a plain non-focusable element | `<body>` | restore |
 * | a non-focusable child of a focusable ancestor | the ancestor | suppress |
 *
 * A click on a menu item lands inside the menu (`menuRef.current.contains`),
 * so it is never treated as "outside" and the restore still runs on close.
 * In practice a click never reaches this hook's `window` listener at all:
 * the field items (Copy value / Copy field path / Add to filter, shared via
 * `FieldActionsMenu`) call `e.stopPropagation()` themselves in every menu
 * that renders them, and `TableView`'s cell and field menus also stop
 * propagation on their wrapper div, which covers the cell menu's
 * Edit/Duplicate/Delete items. Either way, the item's own `onClick` closes
 * the menu directly through the menu's close callback (the same `close`
 * passed here), which is exactly why the reset below matters — that close
 * path never runs this hook's `onClick` and so never gets a chance to
 * recompute `suppressRef` itself.
 *
 * `suppressRef` is reset to `false` at the top of the dismiss effect's body,
 * which only runs when `menu` is truthy (open, including a replacement) —
 * the `if (!menu) return` guard above it means a close (`menu` -> `null`)
 * skips the reset entirely, so the value the click handler just set survives
 * into the focus effect's body that runs in the same commit. Without this
 * reset: open a menu, suppress a close with an outside click (leaving
 * `suppressRef` `true`), reopen the menu, then activate an item — that
 * item's direct call to the close callback never touches `suppressRef`, so the
 * stale `true` survives and strands focus on the just-activated item
 * instead of restoring it. (An Escape-terminated version of that same
 * sequence is not a counterexample: `onKey` clears `suppressRef` itself
 * before calling `close()`, so it would "work" with or without this reset —
 * see `useMenuFocus.spec.ts`'s Escape test for why that one doesn't prove
 * this line is needed, and `add-to-filter-menu.spec.tsx`'s
 * "a suppressed close does not strand focus after the menu reopens and an
 * item is activated" for the one that does.)
 *
 * `close` must be stable (every call site wraps it in `useCallback` with an
 * empty dependency array — see `useMenuDismiss`'s old docstring for why),
 * and so must `menu`'s *identity* across renders that aren't a fresh open:
 * all three call sites hold it in `useState`, so it doesn't change except on
 * an actual open/close/replace.
 *
 * Unmounting the owning view while its menu is open does not restore focus —
 * there is no closing render for the effect to react to. That's a deliberate
 * read of "restore," not a regression: the widget the focus would return to
 * is going away too, and `.focus()` on an already-detached node is a silent
 * no-op (see `navigator-context-menu-focus.spec.tsx`'s docstring for the same
 * call landing on a since-removed node elsewhere in this codebase).
 */
export function useMenuFocus(
  menuRef: React.RefObject<HTMLElement | null>,
  menu: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean } | null,
  close: () => void,
): void {
  // Mutation review — `React.useRef(false)` → `React.useRef(true)` survives
  // (equivalent, not untested): the dismiss effect below resets this to
  // `false` at the top of its body on every render where `menu` is truthy,
  // i.e. every open, and every one of this hook's three call sites starts
  // `menu` at `null` (`React.useState<...>(null)`) — so the one render
  // where the initial value could matter is the very first one, with
  // `menu` still `null`. On that render the *other* effect below also runs
  // its "closed" branch (`if (!suppressRef.current) returnFocusToRef.current?.focus()`),
  // but `returnFocusToRef.current` is still its own initial `null` too (no
  // menu has ever opened to set it) — so `null?.focus()` is a no-op
  // regardless of which way `suppressRef` starts. The initial value is
  // provably unobservable from either effect.
  // Stryker disable next-line BooleanLiteral: the dismiss effect resets this to false on every open before it's read, and the one render where it's read unreset (the very first, menu still null) is a no-op regardless of its value — see the paragraph above.
  const suppressRef = React.useRef(false);
  const returnFocusToRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!menu) return;
    // A fresh open (including a replacement) always starts unsuppressed —
    // see the docstring above for why this reset, not the close branch
    // below, is what has to clear it.
    suppressRef.current = false;
    const onClick = () => {
      const el = document.activeElement;
      // Mutation review — `el !== null` → `true` survives (equivalent, not
      // untested): per the DOM spec, `document.activeElement` is `null`
      // only for a document with no browsing context / no body at all
      // (e.g. mid-navigation); it defaults to `document.body` — never
      // `null` — the moment a body exists, which it always does by the
      // time this listener can run. The check documents the spec-true
      // case rather than one this app can ever actually observe.
      // Stryker disable next-line ConditionalExpression: document.activeElement is null only for a document with no body at all, never reachable by the time this window listener can fire — the check documents a spec case this app never observes.
      suppressRef.current = el !== null && el !== document.body && !menuRef.current?.contains(el);
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Mutation review — this reset survives deletion today (every
      // *human* Escape reaches here through the same synchronous handler
      // that already computed a fresh `suppressRef` on the open, or none
      // at all), but it is kept deliberately rather than ceded: `close()`
      // is invoked from a native `window` listener, not a React synthetic
      // event, so React 18 auto-batches the resulting state update instead
      // of flushing it synchronously — the menu stays mounted and both
      // listeners stay attached until the following microtask. A keydown
      // dispatched programmatically within that same window (nothing a
      // human produces, but a scripted or replayed interaction can) would
      // still reach this same `onKey` while a prior click's `suppressRef =
      // true` is live, and without this line it would suppress an Escape
      // that must never be suppressed. Cheap to keep, load-bearing under a
      // plausible-if-rare interleaving — #60 kept its index-keyed row
      // comparator checks unreachable-today for the same reason (blocked
      // on the open #82, not yet resolved either way), rather than delete
      // them, specifically so a later fix elsewhere can't silently turn
      // into a regression.
      suppressRef.current = false;
      close();
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, close, menuRef]);

  React.useEffect(() => {
    if (menu) {
      returnFocusToRef.current = menu.returnFocusTo ?? null;
      if (menu.focusMenuOnOpen) menuRef.current?.querySelector('button')?.focus();
      return;
    }
    if (!suppressRef.current) returnFocusToRef.current?.focus();
  }, [menu, menuRef]);
}
