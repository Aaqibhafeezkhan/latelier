import React from 'react';

export interface RovingHighlight {
  /** Always in `[0, count - 1]` (or `0` when `count` is `0`) — never names a row that isn't there. */
  index: number;
  /** Jump straight to a row (click, hover, Home/End). */
  setIndex: (index: number) => void;
  /** Move by `delta` from the latest (clamped) highlight, wrapping at both ends. Returns the new index. */
  move: (delta: number) => number;
}

/**
 * `epoch` counts the resets: a key the list had before is a new list when it
 * comes back (a query retyped), so a highlight stored under it no longer
 * applies.
 */
type Stored = { raw: number; key: unknown; epoch: number };

function clampedIndex(stored: Stored, count: number, resetKey: unknown, epoch: number): number {
  const raw = stored.key === resetKey && stored.epoch === epoch ? stored.raw : 0;
  return count === 0 ? 0 : Math.min(raw, count - 1);
}

/**
 * Owns the clamp-at-render + wrap-around arithmetic shared by every
 * keyboard-navigable list in the app (`ConnectionSwitcher`, `SuggestionPopover`,
 * `CommandPalette`, `ConnectionExpandedTable`). Doesn't own key
 * bindings or DOM wiring: callers differ too much (a subtree `onKeyDown` vs.
 * a manual `window`/anchor `addEventListener`) to unify that too; this hook
 * only owns "what index is highlighted right now."
 *
 * `move` computes from the latest highlight a setter wrote (#126), clamped
 * with the same rules as `index`, not from the raw stored one — this is `ConnectionSwitcher`'s original approach (the one named
 * "the better base" when this hook was extracted), which stays correct
 * even when `count` shrinks out from under a standing highlight for a
 * reason the component never sees
 * (e.g. a Connection deleted elsewhere in the app while its popover is
 * open) — the next arrow press still walks from a row that's actually on
 * screen, not from a stale raw index.
 *
 * `resetKey`: pass a value that changes when the underlying list is
 * conceptually "new" (e.g. a search query) to reset the highlight to `0`
 * without an effect — the same trick a command palette needs when it
 * doesn't own the search input's `onChange` directly. Omit it for a
 * component that resets the highlight itself (an explicit `setIndex(0)`
 * alongside its own query handler).
 */
export function useRovingHighlight(count: number, resetKey?: unknown): RovingHighlight {
  const [state, setState] = React.useState<Stored>({ raw: 0, key: resetKey, epoch: 0 });
  // A new key resets the highlight, adjusted while rendering (#745): going
  // back to an earlier key starts from the top too, not from the row it had.
  let current = state;
  if (state.key !== resetKey) {
    current = { raw: 0, key: resetKey, epoch: state.epoch + 1 };
    setState(current);
  }
  const { epoch } = current;
  const index = clampedIndex(current, count, resetKey, epoch);

  // #126 — the latest value either setter wrote, before React re-renders.
  // Two key events can reach a handler before the first one's render
  // commits (seen on CI: the second ArrowDown re-computed from the same
  // render-time `index`, and one step was lost). `move` therefore reads
  // this, with the same clamp and reset rules as the render above. It is
  // written only in the setters, never during render.
  const latest = React.useRef<Stored>(state);

  const setIndex = React.useCallback(
    (next: number) => {
      latest.current = { raw: next, key: resetKey, epoch };
      setState(latest.current);
    },
    [resetKey, epoch],
  );

  const move = React.useCallback(
    (delta: number) => {
      if (count === 0) return 0;
      const next = (clampedIndex(latest.current, count, resetKey, epoch) + delta + count) % count;
      latest.current = { raw: next, key: resetKey, epoch };
      setState(latest.current);
      return next;
    },
    [count, resetKey, epoch],
  );

  return { index, setIndex, move };
}
