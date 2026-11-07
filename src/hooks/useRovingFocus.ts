import React from 'react';
import { useRovingHighlight } from './useRovingHighlight';

// #119 — cap for `scrollThenSettle`'s convergence loop below. Frames, not
// wall-clock time: react-window's dynamic-height cache is only corrected
// inside a frame's rendering step (mount -> layout effect -> ResizeObserver),
// so "elapsed ms" can't tell a slow-but-progressing settle from a stuck one —
// a time cap would give up early under exactly the CPU load that causes the
// bug this is fixing (#119's own repro is a 14-process `yes` load). 60 frames
// is ~1s at 60fps; it also bounds a row that can never fully fit (taller
// than the viewport), which would otherwise loop forever.
const MAX_SETTLE_FRAMES = 60;

// How many moves in a row stay urgent while each one arrives before the last
// has settled (see `navigate`). A move costs about three of React's 50 nested
// updates, so this stays well under the limit, and it is more than any test or
// person presses before acting on a row they are looking at.
const URGENT_MOVES_IN_A_RUN = 8;

// A run of moves ends at a pause this long, and only once the last move has
// settled too. Settling alone isn't enough: a row can hold still for two frames
// while React still has work pending, and measured that way the count hit 50.
const RUN_PAUSE_MS = 250;

// Walk up from a row element to the nearest ancestor react-window scrolls —
// its `<List>` root always carries an inline `overflowY: 'auto'` style (see
// react-window's own `Oe`/list-render function). Module-level: this is pure
// DOM geometry, not hook state, and every `useRovingFocus` caller can share
// one copy instead of a per-caller predicate (that would just be the same
// walk copy-pasted into TableView/TreeView).
function nearestScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

// The settle loop's stop condition: is the row fully inside its scroller's
// visible rect, vertically? A missing row element (not yet mounted, or
// unmounted mid-settle) counts as "not settled" — re-scroll, don't stop.
// `TOLERANCE` absorbs subpixel rounding from layout math, not real clipping.
function isRowFullyVisible(rowElementId: string): boolean {
  const row = document.getElementById(rowElementId);
  if (!row) return false;
  const scroller = nearestScrollableAncestor(row);
  if (!scroller) return true; // nothing scrollable above it — nothing to wait for
  const rowRect = row.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const TOLERANCE = 1;
  return (
    rowRect.top >= scrollerRect.top - TOLERANCE &&
    rowRect.bottom <= scrollerRect.bottom + TOLERANCE
  );
}

/** The row's own top/bottom, or `null` when it isn't mounted. Compared frame
 * to frame to tell a genuinely settled layout from a stale estimate that
 * merely reads as visible this frame. */
function rowRectSnapshot(rowElementId: string): { top: number; bottom: number } | null {
  const row = document.getElementById(rowElementId);
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/** Same row, same position — an exact comparison is fine because a layout
 * that hasn't changed reports identical numbers, not merely close ones. */
function sameRect(
  a: { top: number; bottom: number } | null,
  b: { top: number; bottom: number } | null,
): boolean {
  return a !== null && b !== null && a.top === b.top && a.bottom === b.bottom;
}

export interface UseRovingFocusOptions {
  /** Number of navigable rows. */
  count: number;
  /** Prefix for each row's stable DOM `id` — must match what the caller puts
   * on the row it renders at that index (`${idPrefix}${index}`), since
   * `aria-activedescendant` only works if it names a real element. */
  idPrefix: string;
  /** Forwarded to `useRovingHighlight` — pass the value that means "this is
   * conceptually a new list" (e.g. the `documents` array reference). */
  resetKey?: unknown;
  /**
   * Called synchronously, in the same key handler that moves the active
   * index, with the row index that is about to become active. A
   * virtualized list needs this to scroll the row into the mounted range
   * (`listRef.current.scrollToRow`) — `aria-activedescendant` is only valid
   * once that row actually exists in the DOM, so the scroll can't wait for
   * a separate effect a render later. Omit when nothing needs scrolling
   * (content that's always fully mounted).
   */
  scrollToIndex?: (index: number) => void;
  /**
   * #119 — after the synchronous scroll, keep re-scrolling each frame until
   * the `${idPrefix}${index}` row is fully in view (see `scrollThenSettle`).
   * That exists for react-window's estimated row heights. Pass `false` from
   * a non-virtualized caller whose `scrollToIndex` is already exact, or
   * whose rows don't carry `${idPrefix}${index}` ids (DocFieldTree): the
   * check could never see those settle. Default `true`.
   */
  settle?: boolean;
}

export interface RovingFocus {
  /** Index of the row `aria-activedescendant` currently names. */
  activeIndex: number;
  /**
   * #60 — the row to paint the visual active-row treatment on, or `-1` to
   * paint none. Deliberately not the same value as `activeIndex`: a
   * screen reader hears `aria-activedescendant` whether or not the
   * container has real DOM focus (it's just an ARIA attribute, always
   * present once there's a row to name), but a *sighted* highlight that
   * stayed lit with focus elsewhere in the app would look like a stuck,
   * meaningless row — so this collapses to `-1` whenever the container
   * itself doesn't have focus, while `activeIndex` (read by Enter/Space
   * handling) must keep naming a real row even then.
   */
  highlightIndex: number;
  /** `undefined` when `count` is 0 — nothing to name. */
  activeId: string | undefined;
  /** The DOM id a row at this index must carry. */
  rowId: (index: number) => string;
  /**
   * Jump the active row directly, bypassing Arrow/Home/End — for a click on
   * row N, so the next Arrow key continues from the row just clicked rather
   * than from wherever the highlight was sitting before. Delegates straight
   * to `useRovingHighlight`'s own `setIndex`; never reimplemented here.
   */
  setActiveIndex: (index: number) => void;
  /** Spread onto the container element. */
  containerProps: {
    tabIndex: 0;
    'aria-activedescendant': string | undefined;
    onFocus: (e: React.FocusEvent) => void;
    onBlur: (e: React.FocusEvent) => void;
  };
  /**
   * Handles ArrowUp/ArrowDown/Home/End by moving the active row via
   * `useRovingHighlight`'s own `move`/`setIndex` — never reimplemented here.
   * Ignored when the key bubbled up from a nested control (`e.target !==
   * e.currentTarget`), so tabbing into a row's own button or an inline-edit
   * input keeps that control's native key behaviour. Leaves every other key,
   * Enter/Space included, for the caller to handle after it — activation
   * differs too much per view (select a Table row, expand/collapse a Tree
   * or field row) to own here, same reasoning `useRovingHighlight` already
   * documents for staying out of key bindings.
   */
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function useRovingFocus({
  count,
  idPrefix,
  resetKey,
  scrollToIndex,
  settle = true,
}: UseRovingFocusOptions): RovingFocus {
  const { index, setIndex, move } = useRovingHighlight(count, resetKey);
  const rowId = React.useCallback((i: number) => `${idPrefix}${i}`, [idPrefix]);

  // A long jump (Home/End, or any move past never-rendered rows) asks
  // `scrollToIndex` to compute an offset from react-window's dynamic-height
  // cache while most of the rows it's summing are still at their
  // `defaultRowHeight` estimate, so the target can land clipped instead of
  // fully in view. The first call still has to run synchronously (this
  // docstring's own requirement — the row must exist in the DOM before
  // `aria-activedescendant` names it); the rest is a convergence loop, one
  // `requestAnimationFrame` at a time: re-scroll while the row isn't fully
  // visible (`isRowFullyVisible`, above), and once it is, keep checking
  // without re-scrolling until its rect (`rowRectSnapshot`) reads identical
  // two frames running (`sameRect`) before declaring it settled. Visible
  // alone isn't enough: a stale estimate can hold perfectly still and read
  // as fully visible right up until `ResizeObserver` actually fires and
  // moves it off-screen, so a single "looks visible" frame can't tell a
  // real landing from a lucky one on numbers about to change. Requiring an
  // unchanged rect on top of "visible" catches that case, at the cost of one
  // extra confirmation frame even when the first landing was already
  // correct. Harmless for ArrowUp/ArrowDown, which don't hit the clipped-
  // estimate case at all (each step moves at most one row, so there's no
  // unmeasured span to accumulate error over).
  //
  // The pending frame id is tracked so a newer jump — or an unmount — can
  // cancel a still-pending settle: without this, a quick Home-then-End let
  // Home's deferred re-scroll fire after End's jump and flick the list back
  // to row 0, and a settle could still fire after the list itself had
  // unmounted.
  const pendingFrame = React.useRef<number | null>(null);
  // #62 follow-up — `count` can shrink out from under a still-pending settle
  // (a query re-run, a filter, a delete, same "count shrinks out from under"
  // case `useRovingHighlight.ts` already documents) before a deferred call
  // fires. `i` was captured when it was still a valid index; by settle time
  // it can be `>= count`, and react-window's `scrollToRow` throws
  // `RangeError` for that. Checked on every frame of the loop, not just
  // once, since the loop can run up to `MAX_SETTLE_FRAMES` times.
  // `useLayoutEffect`, not a plain assignment during render (refs are for
  // effects/handlers, not render) — it still commits synchronously, well
  // before any deferred rAF could fire.
  const countRef = React.useRef(count);
  React.useLayoutEffect(() => {
    countRef.current = count;
  });
  // The `!== null` guard only skips a no-op: `cancelAnimationFrame` on a
  // stale/nonexistent handle (including `null`) is a documented no-op, never
  // a throw — confirmed against jsdom directly, not assumed from the spec.
  // Stryker's "always call it" mutant is genuinely equivalent for that
  // reason; its "never call it" and "flip the check" mutants are real bugs
  // and are covered below (a still-pending settle that a newer jump must
  // cancel).
  // This `useCallback`'s own `[]` closes over nothing (only stable refs), so
  // swapping it for a hardcoded non-empty literal is also equivalent: React
  // compares dependency arrays element-by-element with `Object.is`, and a
  // literal is the same value on every render, so it never trips the
  // "changed" branch any differently than `[]` does. Same reasoning applies
  // to `handleFocus`/`handleBlur` a little further down.
  // Stryker disable ArrayDeclaration: closes over only stable refs, so any literal dep array is equivalent to []
  const cancelPendingSettle = React.useCallback(() => {
    // Stryker disable next-line ConditionalExpression: cancelAnimationFrame on a stale/nonexistent handle is a documented no-op (confirmed against jsdom), never a throw
    if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = null;
  }, []);
  // Stryker restore ArrayDeclaration
  // `cancelPendingSettle`'s own deps are `[]`, so its identity is stable for
  // the component's lifetime (React's `useCallback([])` contract) — this
  // effect's `[cancelPendingSettle]` dep therefore never actually changes
  // across renders, making it equivalent to `[]` here specifically. Kept
  // for the normal reason to list a dep an effect closes over, not because
  // this instance can behave differently.
  // Stryker disable next-line ArrayDeclaration: cancelPendingSettle's identity is stable ([] deps), so [cancelPendingSettle] never differs from []
  React.useEffect(() => cancelPendingSettle, [cancelPendingSettle]);

  const scrollThenSettle = React.useCallback(
    (i: number) => {
      cancelPendingSettle();
      // No `scrollToIndex` means nothing to scroll; `settle: false` means
      // the one synchronous scroll is already exact. Either way, schedule
      // no frames at all.
      if (!scrollToIndex) return;
      scrollToIndex(i);
      if (!settle) return;

      let framesLeft = MAX_SETTLE_FRAMES;
      let lastRect: { top: number; bottom: number } | null = null;
      const scheduleCheck = () => {
        pendingFrame.current = requestAnimationFrame(() => {
          pendingFrame.current = null;
          if (i >= countRef.current) return; // count shrunk this index out
          const rect = rowRectSnapshot(rowId(i));
          const visible = isRowFullyVisible(rowId(i));
          if (visible && sameRect(rect, lastRect)) return; // settled: visible AND unchanged since last frame
          lastRect = rect;
          if (!visible) scrollToIndex(i);
          framesLeft -= 1;
          if (framesLeft > 0) scheduleCheck();
        });
      };
      scheduleCheck();
    },
    [scrollToIndex, settle, cancelPendingSettle, rowId],
  );

  // Keys pressed faster than the list renders used to crash the workspace.
  // React only zeroes its nested-update count on a commit that leaves no sync,
  // input or default work pending. Rows mounting schedule that work from their
  // refs and from ResizeObserver, so with an urgent update per key press no
  // commit ever qualifies, and the count reaches 50 and throws "Maximum update
  // depth exceeded" with nothing actually looping. Past a few moves with no
  // pause between them, the rest become transitions, which React can coalesce,
  // so it catches up. A move that isn't part of such a run stays urgent, because
  // the caller's next key (Space, `D`, Tab) must act on the row this one moved
  // to. During a run that key acts on the painted row, which is still the one
  // the person can see.
  const movesInRun = React.useRef(0);
  const lastMoveAt = React.useRef(Number.NEGATIVE_INFINITY);
  const navigate = React.useCallback(
    (pick: () => number) => {
      const now = performance.now();
      const paused = pendingFrame.current === null && now - lastMoveAt.current >= RUN_PAUSE_MS;
      movesInRun.current = paused ? 1 : movesInRun.current + 1;
      lastMoveAt.current = now;
      const go = () => scrollThenSettle(pick());
      if (movesInRun.current > URGENT_MOVES_IN_A_RUN) React.startTransition(go);
      else go();
    },
    [scrollThenSettle],
  );

  // #60 — tracks real DOM focus on the container so `highlightIndex` can
  // collapse to `-1` while it's elsewhere, without touching `activeIndex`
  // (see that field's docstring on `RovingFocus`). Guarded the same way
  // `onKeyDown` already documents: React's `onFocus`/`onBlur` map to
  // `focusin`/`focusout`, which bubble, so without the own-target check,
  // a nested row control (an expand button, a whole nested `DocFieldTree`)
  // taking focus would light up this container too.
  const [focused, setFocused] = React.useState(false);
  // Stryker disable ArrayDeclaration: closes over only the stable setFocused setter, so any literal dep array is equivalent to []
  const handleFocus = React.useCallback((e: React.FocusEvent) => {
    if (e.target !== e.currentTarget) return;
    setFocused(true);
  }, []);
  const handleBlur = React.useCallback((e: React.FocusEvent) => {
    if (e.target !== e.currentTarget) return;
    setFocused(false);
  }, []);
  // Stryker restore ArrayDeclaration

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (count === 0) return;
      if (e.target !== e.currentTarget) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          navigate(() => move(1));
          return;
        case 'ArrowUp':
          e.preventDefault();
          navigate(() => move(-1));
          return;
        case 'Home':
          e.preventDefault();
          navigate(() => {
            setIndex(0);
            return 0;
          });
          return;
        case 'End':
          e.preventDefault();
          navigate(() => {
            // Stryker's `count - 1` -> `count + 1` mutant on this `setIndex`
            // call is equivalent: `useRovingHighlight`'s `index` getter clamps
            // via `Math.min(raw, count - 1)`, so `setIndex(count + 1)` and
            // `setIndex(count - 1)` land on the identical clamped index —
            // confirmed by reading that clamp, not assumed.
            // Stryker disable next-line ArithmeticOperator: clampedIndex's Math.min(raw, count - 1) lands count+1 and count-1 on the same clamped index
            setIndex(count - 1);
            return count - 1;
          });
          return;
        // Stryker's "drop this `return`" mutant is equivalent: it's the
        // switch's last case and nothing follows the switch in this
        // callback, so falling out of the switch and hitting `return` do
        // the same thing.
        // Stryker disable next-line ConditionalExpression: last switch case, nothing follows — falling out and returning are identical
        default:
          return;
      }
    },
    [count, move, setIndex, navigate],
  );

  return {
    activeIndex: index,
    // The `count === 0` arm matches `activeId` and `aria-activedescendant`
    // below rather than leaning on callers: with no rows, `index` is 0, not
    // -1, so a focused empty widget would nominate row 0. No caller renders a
    // row at index 0 while `count` is 0 today, so nothing paints — but the
    // three values on these lines should agree about what "empty" means.
    highlightIndex: count === 0 || !focused ? -1 : index,
    activeId: count === 0 ? undefined : rowId(index),
    rowId,
    setActiveIndex: setIndex,
    containerProps: {
      tabIndex: 0,
      'aria-activedescendant': count === 0 ? undefined : rowId(index),
      onFocus: handleFocus,
      onBlur: handleBlur,
    },
    onKeyDown,
  };
}
