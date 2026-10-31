import React from 'react';
import { isInPalette, paletteOpener } from '../commands/paletteOpener';

/**
 * Returns keyboard focus to the control that opened a dialog.
 *
 * Mantine's own `returnFocus` cannot do it here: `useFocusReturn` hangs its
 * whole body off `useDidUpdate` keyed on `[opened, shouldReturnFocus]`, and
 * `useDidUpdate` skips its first run. Every dialog in this app is mounted and
 * unmounted by its parent with `opened` a bare attribute, so `opened` never
 * transitions, the trigger is never captured, and a close leaves focus on
 * `<body>` — the top of the tab order, many tab stops from where the user was.
 *
 * Two things about the shape are load-bearing.
 *
 * **The trigger is captured during the first render, not in a mount effect.**
 * A mount effect was proposed first, on the grounds that React runs child effects
 * before parent effects and Mantine's focus trap defers its own focus move via
 * `setTimeout` — so focus is still on the trigger at capture time. That holds
 * for the Document Editor, but not for the type-to-confirm dialogs: React applies
 * `autoFocus` during the commit's layout phase, *before* any `useEffect`, so a
 * mount effect in `DropCollectionConfirm`/`RenameCollectionModal`/the tab drop
 * confirms captures the dialog's own `TextInput` and later "restores" focus to
 * a node that is being removed — landing back on `<body>`, silently. A
 * `useState` initializer runs before the commit, so nothing has moved focus
 * yet, whatever the dialog does with `autoFocus`.
 *
 * **The restore runs from the close gesture, and only reclaims focus that is
 * still ours.** Both rules come from the two surfaces that already solved this:
 *
 * - `ConnectionSwitcher` restores only when the element focused at close is
 *   `null`, `<body>`, or inside the overlay being closed. Restoring
 *   unconditionally — Mantine's behaviour — drags focus off a control the user
 *   clicked elsewhere and back onto the trigger. The check here is by dialog
 *   role rather than by a ref to *this* dialog's root: it is a strict superset
 *   of that check, it costs no `ref` threaded through a dozen dialogs, and it
 *   keeps a nested overlay counted as ours — the Document Editor's discard prompt is a
 *   separate portal, so whether focus is still on the prompt when `close()`
 *   runs is a timing detail this shouldn't depend on.
 * - `ConnectionExpandedTable` wires focus return to `onClose` rather than an
 *   unmount effect, because several of its actions unmount it straight into
 *   another surface, and an unmount-keyed effect would fire there too and race
 *   that surface's own `FocusTrap` for a coin-flip winner. Same reason to wrap
 *   the gesture here rather than the unmount.
 *
 * Wrap the *dismiss* paths — Mantine's `onClose` prop plus any Cancel or
 * Close button — unconditionally. A success path (`onDropped`, `onSaved`,
 * `onInserted`) is the handoff case above by default, because after a drop
 * or a rename the trigger is usually a row that no longer exists — but it
 * may be wrapped too, on its own separate call, when the caller passes an
 * explicit `returnFocusTo` that outlives the mutation. #74 is the precedent:
 * `IndexesTab`'s `DropConfirmDialog` and `UsersTab`'s `DropUserDialog` each
 * make two calls — one for `onCancel` using the render-time captured trigger
 * (still there after a Cancel), and a second for `onDropped` passing the
 * tab's scroll region as `returnFocusTo` (the row isn't, after a drop).
 */
export function useDialogFocusReturn(
  onClose: () => void,
  returnFocusTo?: HTMLElement | null,
): () => void {
  // `returnFocusTo` wins when supplied, because there are openers the
  // render-time capture cannot see. `ConnectionExpandedTable` unmounts itself
  // and mounts a dialog in the same commit, so by this component's first render
  // the row button that opened it is already detached: capturing it yields a
  // node whose `.focus()` is a silent no-op and focus lands on `<body>`. No
  // point inside the dialog is early enough; only the opener knows.
  //
  // `ConnectionExpandedTable` solves the same problem for itself with a prop of
  // the same name, for the same reason — its own opener (the switcher popover)
  // is gone before it mounts.
  // A dialog the command palette launches renders while focus is still on the
  // palette's search input, which unmounts with the palette; the control that
  // opened the palette is the real trigger.
  const [captured] = React.useState(() => {
    const active = document.activeElement as HTMLElement | null;
    return isInPalette(active) ? (paletteOpener() ?? active) : active;
  });
  const trigger = returnFocusTo ?? captured;

  // Memoized because `TroubleshootingDrawer` puts the result in a `useCallback`
  // dependency list; a fresh identity per render would defeat that.
  return React.useCallback(() => {
    // Read before `onClose` — the parent may unmount this dialog synchronously.
    const el = document.activeElement;
    const ours =
      el === null || el === document.body || !!el.closest('[role="dialog"],[role="alertdialog"]');
    onClose();
    if (ours) trigger?.focus?.();
  }, [onClose, trigger]);
}
