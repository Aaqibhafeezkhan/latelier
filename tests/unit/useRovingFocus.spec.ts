// @vitest-environment jsdom
//
// Same jsdom-opt-in as useRovingHighlight.spec.ts (see the comment there):
// this hook's key-mapping logic is pure and fast enough for Stryker's
// per-mutant rerun, but exercising a React hook still needs a real render.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { renderHook, act } from '../helpers/render';
import { installJsdomTeardown } from '../helpers/jsdomTeardown';
import { useRovingFocus } from '../../src/hooks/useRovingFocus';

// #110 — unmount and clear pending timers after each test; see
// tests/helpers/jsdomTeardown.ts for why a jsdom unit spec needs this.
installJsdomTeardown();

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** A minimal stand-in for React.KeyboardEvent — only the fields onKeyDown reads. */
function keyEvent(
  key: string,
  opts: { sameTarget?: boolean } = {},
): React.KeyboardEvent {
  const sameTarget = opts.sameTarget ?? true;
  const target = {};
  return {
    key,
    target: sameTarget ? target : {},
    currentTarget: target,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent;
}

/** A minimal stand-in for React.FocusEvent — only the fields onFocus/onBlur read. */
function focusEvent(opts: { sameTarget?: boolean } = {}): React.FocusEvent {
  const sameTarget = opts.sameTarget ?? true;
  const target = {};
  return {
    target: sameTarget ? target : {},
    currentTarget: target,
  } as unknown as React.FocusEvent;
}

describe('useRovingFocus', () => {
  it('starts on row 0 with a matching aria-activedescendant', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.activeId).toBe('row-0');
    expect(result.current.containerProps['aria-activedescendant']).toBe('row-0');
    expect(result.current.containerProps.tabIndex).toBe(0);
  });

  it('ArrowDown moves to the next row and wraps past the last', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
    act(() => result.current.onKeyDown(keyEvent('ArrowDown')));
    expect(result.current.activeIndex).toBe(1);
    act(() => result.current.onKeyDown(keyEvent('ArrowDown')));
    act(() => result.current.onKeyDown(keyEvent('ArrowDown')));
    expect(result.current.activeIndex).toBe(0);
  });

  it('ArrowUp wraps backward past the first row', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
    act(() => result.current.onKeyDown(keyEvent('ArrowUp')));
    expect(result.current.activeIndex).toBe(2);
  });

  it('Home and End jump to the first and last row', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 5, idPrefix: 'row-' }));
    act(() => result.current.onKeyDown(keyEvent('ArrowDown')));
    act(() => result.current.onKeyDown(keyEvent('End')));
    expect(result.current.activeIndex).toBe(4);
    act(() => result.current.onKeyDown(keyEvent('Home')));
    expect(result.current.activeIndex).toBe(0);
  });

  it('calls preventDefault for every handled navigation key, not for others', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const handled = keyEvent(key);
      act(() => result.current.onKeyDown(handled));
      expect(handled.preventDefault).toHaveBeenCalledTimes(1);
    }

    const ignored = keyEvent('Enter');
    act(() => result.current.onKeyDown(ignored));
    expect(ignored.preventDefault).not.toHaveBeenCalled();
  });

  it('does not preventDefault a navigation key when count is 0 — nothing to navigate', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 0, idPrefix: 'row-' }));
    const e = keyEvent('ArrowDown');
    act(() => result.current.onKeyDown(e));
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores a key that bubbled up from a nested control', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
    act(() => result.current.onKeyDown(keyEvent('ArrowDown', { sameTarget: false })));
    expect(result.current.activeIndex).toBe(0);
  });

  it('is a no-op when count is 0 — no activedescendant, no crash on ArrowDown', () => {
    const { result } = renderHook(() => useRovingFocus({ count: 0, idPrefix: 'row-' }));
    expect(result.current.activeId).toBeUndefined();
    expect(result.current.containerProps['aria-activedescendant']).toBeUndefined();
    act(() => result.current.onKeyDown(keyEvent('ArrowDown')));
    expect(result.current.activeIndex).toBe(0);
  });

  it('calls scrollToIndex synchronously with the row about to become active', () => {
    const scrollToIndex = vi.fn();
    const { result } = renderHook(() =>
      useRovingFocus({ count: 3, idPrefix: 'row-', scrollToIndex }),
    );
    act(() => result.current.onKeyDown(keyEvent('ArrowDown')));
    expect(scrollToIndex).toHaveBeenCalledWith(1);
    act(() => result.current.onKeyDown(keyEvent('End')));
    expect(scrollToIndex).toHaveBeenCalledWith(2);
  });

  // #126 — two ArrowDowns handled before a re-render (one captured closure,
  // one `act`) must advance two rows and scroll to each, not scroll to row 1
  // twice.
  it('two ArrowDowns before a re-render advance two rows and scroll to each', () => {
    const scrollToIndex = vi.fn();
    const { result } = renderHook(() =>
      useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex, settle: false }),
    );
    const { onKeyDown } = result.current;
    act(() => {
      onKeyDown(keyEvent('ArrowDown'));
      onKeyDown(keyEvent('ArrowDown'));
    });
    expect(scrollToIndex.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(result.current.activeIndex).toBe(2);
  });

  it('calls scrollToIndex with the wrapped-backward target on ArrowUp', () => {
    const scrollToIndex = vi.fn();
    const { result } = renderHook(() =>
      useRovingFocus({ count: 3, idPrefix: 'row-', scrollToIndex }),
    );
    act(() => result.current.onKeyDown(keyEvent('ArrowUp')));
    expect(scrollToIndex).toHaveBeenCalledWith(2);
  });

  // #62 — Home's own case had no direct assertion (only ArrowDown/ArrowUp/End
  // did), so nothing distinguished calling `scrollThenSettle(0)` from not
  // calling it at all.
  it('calls scrollToIndex with 0 on Home', () => {
    const scrollToIndex = vi.fn();
    const { result } = renderHook(() =>
      useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
    );
    act(() => result.current.onKeyDown(keyEvent('Home')));
    expect(scrollToIndex).toHaveBeenCalledWith(0);
  });

  // #60 — highlightIndex drives the visual active-row treatment; it must
  // track real container focus separately from activeIndex (which Enter/
  // Space handling reads and must never see go to -1).
  describe('highlightIndex (#60)', () => {
    it('is -1 before the container has focus', () => {
      const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
      expect(result.current.highlightIndex).toBe(-1);
    });

    it('equals activeIndex once the container gains focus, and follows it', () => {
      const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
      act(() => result.current.containerProps.onFocus(focusEvent()));
      expect(result.current.highlightIndex).toBe(0);
      act(() => result.current.onKeyDown(keyEvent('ArrowDown')));
      expect(result.current.highlightIndex).toBe(result.current.activeIndex);
      expect(result.current.highlightIndex).toBe(1);
    });

    it('returns to -1 on blur', () => {
      const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
      act(() => result.current.containerProps.onFocus(focusEvent()));
      act(() => result.current.containerProps.onBlur(focusEvent()));
      expect(result.current.highlightIndex).toBe(-1);
    });

    it('stays -1 for an empty list even while the container has focus', () => {
      const { result } = renderHook(() => useRovingFocus({ count: 0, idPrefix: 'row-' }));
      act(() => result.current.containerProps.onFocus(focusEvent()));
      expect(result.current.highlightIndex).toBe(-1);
      // `activeIndex` is 0 here, not -1 — the two are deliberately different
      // values, and this is the case that shows it.
      expect(result.current.activeIndex).toBe(0);
    });

    it('ignores a focus/blur whose target is not the container itself', () => {
      const { result } = renderHook(() => useRovingFocus({ count: 3, idPrefix: 'row-' }));
      act(() => result.current.containerProps.onFocus(focusEvent({ sameTarget: false })));
      expect(result.current.highlightIndex).toBe(-1);

      act(() => result.current.containerProps.onFocus(focusEvent()));
      act(() => result.current.containerProps.onBlur(focusEvent({ sameTarget: false })));
      expect(result.current.highlightIndex).toBe(0);
    });
  });

  it('rowId/activeId reflect the current idPrefix', () => {
    const { result, rerender } = renderHook(
      ({ idPrefix }) => useRovingFocus({ count: 3, idPrefix }),
      { initialProps: { idPrefix: 'a-' } },
    );
    expect(result.current.activeId).toBe('a-0');
    rerender({ idPrefix: 'b-' });
    expect(result.current.activeId).toBe('b-0');
  });

  // #119 — `scrollThenSettle` (the wrapper around `scrollToIndex`) runs a
  // convergence loop: each animation frame, check whether the target row is
  // now fully visible before deciding whether to re-scroll (see the hook's
  // own comment for why #62's fixed two-frame re-scroll wasn't enough).
  // These tests need per-frame control real rAF timing can't give reliably,
  // so they swap in a manual, synchronously-flushable queue instead of
  // `vi.useFakeTimers()` (which doesn't cover rAF at all).
  describe('scrollThenSettle convergence (#119, #62)', () => {
    /**
     * A fake `requestAnimationFrame`/`cancelAnimationFrame` pair. `flush`
     * only runs callbacks queued *before* it was called and clears them
     * first — a callback that schedules another frame (the loop's next
     * iteration) lands in the fresh queue and needs a further `flush()`,
     * matching real rAF's per-frame batching. `pending()` reports how many
     * frames are currently queued, so a test can assert "nothing left
     * scheduled" instead of just "no more calls happened".
     */
    function makeFrameQueue() {
      let nextId = 1;
      const callbacks = new Map<number, FrameRequestCallback>();
      return {
        request(cb: FrameRequestCallback): number {
          const id = nextId++;
          callbacks.set(id, cb);
          return id;
        },
        cancel(id: number): void {
          callbacks.delete(id);
        },
        flush(): void {
          const due = [...callbacks.entries()];
          callbacks.clear();
          for (const [, cb] of due) cb(0);
        },
        pending(): number {
          return callbacks.size;
        },
      };
    }

    // The loop's own cap (see `MAX_SETTLE_FRAMES` in the hook) — mirrored
    // here rather than imported so a test can assert the exact call count at
    // the boundary without exporting an implementation constant. Every
    // "flush until done" loop below is bounded by this plus slack, never by
    // a `while (pending())`: a `framesLeft -= 1` -> `+= 1` or `> 0` -> `true`
    // mutant would otherwise turn the loop infinite and hang the run.
    const MAX_SETTLE_FRAMES = 60;

    let queue: ReturnType<typeof makeFrameQueue>;
    let originalRaf: typeof window.requestAnimationFrame;
    let originalCaf: typeof window.cancelAnimationFrame;

    // Swap in the fake queue for this block only, and hand the real pair
    // (which may itself be `jsdomTeardown.ts`'s recording wrapper — see
    // that file's own comment) back afterward, so its handles are recorded
    // and swept for every other test in this file as usual.
    beforeEach(() => {
      queue = makeFrameQueue();
      originalRaf = window.requestAnimationFrame;
      originalCaf = window.cancelAnimationFrame;
      window.requestAnimationFrame = queue.request as typeof window.requestAnimationFrame;
      window.cancelAnimationFrame = queue.cancel as typeof window.cancelAnimationFrame;
    });

    afterEach(() => {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCaf;
      document.body.replaceChildren(); // drop any row/scroller elements a test mounted directly
    });

    /** A rect with every `DOMRect` field defaulted to 0, `rect` overriding. */
    function stubRect(el: HTMLElement, rect: Partial<DOMRect>): void {
      const full = {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {
          return this;
        },
        ...rect,
      } as DOMRect;
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(full);
    }

    /**
     * Mounts a row element inside a scrollable ancestor (real DOM nodes,
     * attached to `document.body`, cleaned up in `afterEach` above), with
     * both elements' `getBoundingClientRect` stubbed to the given rects.
     * `wrapper: true` inserts a plain, non-scrollable node between the row
     * and the scroller, so the walk-up has more than one hop to make.
     */
    function mountRow(
      rowId: string,
      rowRect: Partial<DOMRect>,
      scrollerRect: Partial<DOMRect>,
      opts: { overflowY?: string; wrapper?: boolean } = {},
    ): void {
      const scroller = document.createElement('div');
      scroller.style.overflowY = opts.overflowY ?? 'auto';
      let parent: HTMLElement = scroller;
      if (opts.wrapper) {
        const wrapper = document.createElement('div');
        scroller.appendChild(wrapper);
        parent = wrapper;
      }
      const row = document.createElement('div');
      row.id = rowId;
      parent.appendChild(row);
      document.body.appendChild(scroller);
      stubRect(row, rowRect);
      stubRect(scroller, scrollerRect);
    }

    it('re-issues scrollToIndex once per frame while the row stays off-screen, then stops once it settles', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );
      // No row-4 element mounted yet, so every check reads "not visible".
      act(() => result.current.onKeyDown(keyEvent('End')));
      expect(scrollToIndex).toHaveBeenCalledTimes(1);
      expect(scrollToIndex).toHaveBeenLastCalledWith(4);

      // Three frames of "still not visible" (advisor: N >= 2 needed to tell
      // this apart from #62's old fixed two-frame re-scroll, which would
      // also produce exactly 2 calls at N=1).
      for (let frame = 0; frame < 3; frame += 1) {
        act(() => queue.flush());
      }
      expect(scrollToIndex).toHaveBeenCalledTimes(4); // 1 sync + 3 re-scrolls
      expect(queue.pending()).toBe(1); // next frame's check still scheduled

      // Now the row lands fully in view. The next check sees it visible but
      // has nothing to compare it against yet (the prior frames all read
      // "unmounted"), so it confirms rather than stopping outright.
      mountRow('row-4', { top: 10, bottom: 30 }, { top: 0, bottom: 100 });
      act(() => queue.flush());
      expect(scrollToIndex).toHaveBeenCalledTimes(4); // still no extra re-scroll — visible, just not yet confirmed
      expect(queue.pending()).toBe(1); // one more confirmation frame scheduled

      // Same rect again next frame — visible twice running — settles.
      act(() => queue.flush());
      expect(scrollToIndex).toHaveBeenCalledTimes(4); // no extra re-scroll
      expect(queue.pending()).toBe(0); // and nothing left scheduled
    });

    it('gives up at the frame cap for a row that never becomes visible', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );
      act(() => result.current.onKeyDown(keyEvent('End'))); // row-4 never mounts

      for (let frame = 0; frame < MAX_SETTLE_FRAMES + 5; frame += 1) {
        act(() => queue.flush());
      }
      expect(scrollToIndex).toHaveBeenCalledTimes(1 + MAX_SETTLE_FRAMES);
      expect(queue.pending()).toBe(0);
    });

    it('costs zero extra scrollToIndex calls when the row is already visible on frame 1', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );
      mountRow('row-4', { top: 10, bottom: 30 }, { top: 0, bottom: 100 });

      act(() => result.current.onKeyDown(keyEvent('End')));
      expect(scrollToIndex).toHaveBeenCalledTimes(1); // the synchronous call

      act(() => queue.flush());
      expect(scrollToIndex).toHaveBeenCalledTimes(1); // frame 1: visible, but unconfirmed — no re-scroll either way
      expect(queue.pending()).toBe(1);

      // Rect unchanged on the confirmation frame — settles without ever
      // having re-scrolled.
      act(() => queue.flush());
      expect(scrollToIndex).toHaveBeenCalledTimes(1);
      expect(queue.pending()).toBe(0);
    });

    // The pinned case: the first landing looks visible on estimated row
    // heights, but the estimate then changes underneath it (react-window's
    // `ResizeObserver` fires with a real measurement) and the row is no
    // longer visible. A stop condition that only checks "visible" declares
    // victory on frame 1 and never notices; requiring two identical
    // consecutive readings catches it.
    it('re-scrolls when a landing that looked visible turns out to be a stale estimate', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );
      mountRow('row-4', { top: 10, bottom: 30 }, { top: 0, bottom: 100 });

      act(() => result.current.onKeyDown(keyEvent('End')));
      expect(scrollToIndex).toHaveBeenCalledTimes(1); // synchronous call, visible on the stale estimate

      // Before the confirmation frame, the real measurement lands and moves
      // the row off-screen — same element, new geometry.
      const row = document.getElementById('row-4')!;
      const stubRect = (rect: Partial<DOMRect>) =>
        vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON() {
            return this;
          },
          ...rect,
        } as DOMRect);
      stubRect({ top: 110, bottom: 130 });

      act(() => queue.flush());
      expect(scrollToIndex).toHaveBeenCalledTimes(2); // caught the stale reading — re-scrolled
      expect(queue.pending()).toBe(1);

      // The real measurement holds still for two frames running now — settles.
      stubRect({ top: 70, bottom: 90 });
      act(() => queue.flush());
      expect(queue.pending()).toBe(1); // frame 1 of the real landing — unconfirmed yet
      act(() => queue.flush());
      expect(scrollToIndex).toHaveBeenCalledTimes(2); // no further re-scroll — it was already visible
      expect(queue.pending()).toBe(0);
    });

    it('does not settle while the row stays visible but its top keeps drifting', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );
      mountRow('row-4', { top: 10, bottom: 30 }, { top: 0, bottom: 100 });
      act(() => result.current.onKeyDown(keyEvent('End')));

      // Baseline frame: establishes lastRect = {10, 30} without which
      // `sameRect`'s `b !== null` check alone would explain the next
      // frame's "not settled" reading — the top comparison would never run.
      act(() => queue.flush());
      expect(queue.pending()).toBe(1);

      const row = document.getElementById('row-4')!;
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        top: 12,
        bottom: 30, // unchanged — isolates the `top` half of sameRect
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {
          return this;
        },
      } as DOMRect);

      act(() => queue.flush());
      expect(queue.pending()).toBe(1); // still visible, but top moved from the baseline — not confirmed
    });

    it('does not settle while the row stays visible but its bottom keeps drifting', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );
      mountRow('row-4', { top: 10, bottom: 30 }, { top: 0, bottom: 100 });
      act(() => result.current.onKeyDown(keyEvent('End')));

      // Baseline frame: establishes lastRect = {10, 30} — see the top-drift
      // test above for why this is required to isolate the bottom check.
      act(() => queue.flush());
      expect(queue.pending()).toBe(1);

      const row = document.getElementById('row-4')!;
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        top: 10,
        bottom: 32,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {
          return this;
        },
      } as DOMRect);

      act(() => queue.flush());
      expect(queue.pending()).toBe(1); // still visible, but bottom moved from the baseline — not confirmed
    });

    it('treats a missing row element as not settled and keeps re-scrolling', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );
      // row-4 is never mounted at all — getElementById returns null forever.
      act(() => result.current.onKeyDown(keyEvent('End')));
      act(() => queue.flush());
      act(() => queue.flush());
      expect(scrollToIndex).toHaveBeenCalledTimes(3);
      expect(queue.pending()).toBe(1);
    });

    // Boundary table for `isRowFullyVisible`'s own comparison, exercised
    // through the public loop: frame 1's decision to re-scroll or not is the
    // only observable signal, so each case renders the hook, mounts the
    // geometry, flushes one frame, and reads the call count.
    describe('visibility geometry', () => {
      it.each<{
        name: string;
        rowRect: Partial<DOMRect>;
        scrollerRect: Partial<DOMRect>;
        opts?: { overflowY?: string; wrapper?: boolean };
        expectSettled: boolean;
      }>([
        {
          name: 'top exactly at the 1px tolerance — visible',
          rowRect: { top: -1, bottom: 30 },
          scrollerRect: { top: 0, bottom: 100 },
          expectSettled: true,
        },
        {
          name: 'top 1.5px past the tolerance — not visible',
          rowRect: { top: -1.5, bottom: 30 },
          scrollerRect: { top: 0, bottom: 100 },
          expectSettled: false,
        },
        {
          name: 'bottom exactly at the 1px tolerance — visible',
          rowRect: { top: 70, bottom: 101 },
          scrollerRect: { top: 0, bottom: 100 },
          expectSettled: true,
        },
        {
          name: 'bottom 1.5px past the tolerance — not visible',
          rowRect: { top: 70, bottom: 101.5 },
          scrollerRect: { top: 0, bottom: 100 },
          expectSettled: false,
        },
        {
          name: 'top clipped, bottom fine — not visible (kills && -> ||)',
          rowRect: { top: -10, bottom: 30 },
          scrollerRect: { top: 0, bottom: 100 },
          expectSettled: false,
        },
        {
          name: 'bottom clipped, top fine — not visible (kills && -> ||)',
          rowRect: { top: 70, bottom: 110 },
          scrollerRect: { top: 0, bottom: 100 },
          expectSettled: false,
        },
        {
          name: 'scroller uses overflowY: scroll rather than auto — visible',
          rowRect: { top: 10, bottom: 30 },
          scrollerRect: { top: 0, bottom: 100 },
          opts: { overflowY: 'scroll' },
          expectSettled: true,
        },
        // Distinguishes "the 'scroll' ancestor was found and its rect used"
        // from "no scrollable ancestor was found, so the no-scroller
        // fallback vacuously says visible" — the row here would read as
        // visible either way if `nearestScrollableAncestor` didn't actually
        // recognize `overflowY: scroll` as its stop condition, since walking
        // past it to `document.body`/`<html>` (neither scrollable) hits the
        // same fallback. Clipping it against the real scroll ancestor's rect
        // is the only way to tell the two apart.
        {
          name: 'scroller uses overflowY: scroll and clips the row — not visible',
          rowRect: { top: -10, bottom: 30 },
          scrollerRect: { top: 0, bottom: 100 },
          opts: { overflowY: 'scroll' },
          expectSettled: false,
        },
        {
          name: 'a non-scrollable wrapper sits between the row and its scroller — visible',
          rowRect: { top: 10, bottom: 30 },
          scrollerRect: { top: 0, bottom: 100 },
          opts: { wrapper: true },
          expectSettled: true,
        },
        {
          name: 'a non-scrollable wrapper sits between the row and its scroller — clipped, not visible',
          rowRect: { top: -10, bottom: 30 },
          scrollerRect: { top: 0, bottom: 100 },
          opts: { wrapper: true },
          expectSettled: false,
        },
      ])('$name', ({ rowRect, scrollerRect, opts, expectSettled }) => {
        const scrollToIndex = vi.fn();
        const { result } = renderHook(() =>
          useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
        );
        mountRow('row-4', rowRect, scrollerRect, opts);

        act(() => result.current.onKeyDown(keyEvent('End')));
        act(() => queue.flush());

        expect(scrollToIndex).toHaveBeenCalledTimes(expectSettled ? 1 : 2);
      });

      it('no scrollable ancestor at all — treated as visible (nothing to wait for)', () => {
        const scrollToIndex = vi.fn();
        const { result } = renderHook(() =>
          useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
        );
        const row = document.createElement('div');
        row.id = 'row-4';
        document.body.appendChild(row); // no scrollable parent anywhere

        act(() => result.current.onKeyDown(keyEvent('End')));
        act(() => queue.flush());

        expect(scrollToIndex).toHaveBeenCalledTimes(1); // settled immediately
      });
    });

    it('a newer jump cancels the older pending settle — the stale index is never re-scrolled to', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );

      act(() => result.current.onKeyDown(keyEvent('Home'))); // schedules a settle(0)
      act(() => result.current.onKeyDown(keyEvent('End'))); // must cancel it, schedule settle(4)
      scrollToIndex.mockClear();

      act(() => queue.flush());
      act(() => queue.flush());

      expect(scrollToIndex).not.toHaveBeenCalledWith(0);
      expect(scrollToIndex).toHaveBeenCalledWith(4);
    });

    describe('moves that outrun settling', () => {
      // Mirror `URGENT_MOVES_IN_A_RUN` and `RUN_PAUSE_MS`, for the same reason as `MAX_SETTLE_FRAMES` above.
      const URGENT_MOVES = 8;
      const RUN_PAUSE_MS = 250;
      let startTransition: MockInstance<typeof React.startTransition>;

      beforeEach(() => {
        startTransition = vi.spyOn(React, 'startTransition');
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      function pressRepeatedly(onKeyDown: () => (e: React.KeyboardEvent) => void, key: string, times: number): void {
        for (let i = 0; i < times; i++) act(() => onKeyDown()(keyEvent(key)));
      }

      it('stays urgent up to the limit, then defers each further move without losing one', () => {
        const scrollToIndex = vi.fn();
        const { result } = renderHook(() =>
          useRovingFocus({ count: 20, idPrefix: 'row-', scrollToIndex }),
        );

        pressRepeatedly(() => result.current.onKeyDown, 'ArrowDown', URGENT_MOVES);
        expect(startTransition).not.toHaveBeenCalled();
        expect(result.current.activeIndex).toBe(URGENT_MOVES);

        pressRepeatedly(() => result.current.onKeyDown, 'ArrowDown', 2);
        expect(startTransition).toHaveBeenCalledTimes(2);
        expect(result.current.activeIndex).toBe(URGENT_MOVES + 2);
        expect(scrollToIndex).toHaveBeenLastCalledWith(URGENT_MOVES + 2);
      });

      it.each(['ArrowUp', 'Home', 'End'])('%s counts toward the run and is deferred past the limit', (key) => {
        const scrollToIndex = vi.fn();
        const { result } = renderHook(() =>
          useRovingFocus({ count: 20, idPrefix: 'row-', scrollToIndex }),
        );

        pressRepeatedly(() => result.current.onKeyDown, 'ArrowDown', URGENT_MOVES);
        const before = startTransition.mock.calls.length;
        pressRepeatedly(() => result.current.onKeyDown, key, 1);
        expect(startTransition.mock.calls.length).toBe(before + 1);
      });

      it('a key that is not a move neither counts toward the run nor is deferred', () => {
        const scrollToIndex = vi.fn();
        const { result } = renderHook(() =>
          useRovingFocus({ count: 20, idPrefix: 'row-', scrollToIndex }),
        );

        pressRepeatedly(() => result.current.onKeyDown, 'ArrowDown', URGENT_MOVES);
        pressRepeatedly(() => result.current.onKeyDown, 'x', 3);
        expect(startTransition).not.toHaveBeenCalled();
      });

      // A run past the limit, at a fixed clock, so each test decides what ends it.
      function runPastTheLimit(settle?: boolean) {
        const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
        const { result } = renderHook(() =>
          useRovingFocus({ count: 20, idPrefix: 'row-', scrollToIndex: vi.fn(), settle }),
        );
        pressRepeatedly(() => result.current.onKeyDown, 'ArrowDown', URGENT_MOVES + 1);
        return { clock, press: () => pressRepeatedly(() => result.current.onKeyDown, 'ArrowDown', 1) };
      }

      function settleTheLastMove(): void {
        const landed = document.createElement('div');
        landed.id = `row-${URGENT_MOVES + 1}`;
        document.body.appendChild(landed);
        for (let frame = 0; frame < 3; frame++) act(() => queue.flush());
        expect(queue.pending()).toBe(0);
      }

      it('settled and paused ends the run, so the next move is urgent again', () => {
        const { clock, press } = runPastTheLimit();
        expect(startTransition).toHaveBeenCalledTimes(1);

        settleTheLastMove();
        clock.mockReturnValue(1000 + RUN_PAUSE_MS);
        press();

        expect(startTransition).toHaveBeenCalledTimes(1);
      });

      it('settled without a long enough pause stays in the run', () => {
        const { clock, press } = runPastTheLimit();

        settleTheLastMove();
        clock.mockReturnValue(1000 + RUN_PAUSE_MS - 1);
        press();

        expect(startTransition).toHaveBeenCalledTimes(2);
      });

      it('a long pause with the last move still settling stays in the run', () => {
        const { clock, press } = runPastTheLimit();

        clock.mockReturnValue(1000 + RUN_PAUSE_MS);
        press();

        expect(startTransition).toHaveBeenCalledTimes(2);
      });

      it('with no settle loop, a pause still ends the run', () => {
        const { clock, press } = runPastTheLimit(false);
        expect(startTransition).toHaveBeenCalledTimes(1);

        clock.mockReturnValue(1000 + RUN_PAUSE_MS);
        press();

        expect(startTransition).toHaveBeenCalledTimes(1);
      });
    });

    it('unmounting cancels a still-pending settle', () => {
      const scrollToIndex = vi.fn();
      const { result, unmount } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );

      act(() => result.current.onKeyDown(keyEvent('End')));
      act(() => unmount());
      scrollToIndex.mockClear();

      act(() => queue.flush());
      act(() => queue.flush());

      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(queue.pending()).toBe(0);
    });

    // The "newer jump cancels" test above cancels the settle before its
    // first frame has fired at all — this one lets End's loop run one
    // iteration first (so a frame has already re-scrolled once), then checks
    // a following Home still cancels the next pending frame rather than
    // letting it fire.
    it('a newer jump cancels a pending settle even mid-loop, after an earlier retry already fired', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );

      act(() => result.current.onKeyDown(keyEvent('End'))); // schedules End's first check
      act(() => queue.flush()); // row-4 not mounted -> re-scrolls, schedules the next check
      act(() => result.current.onKeyDown(keyEvent('Home'))); // must cancel that pending check
      scrollToIndex.mockClear();

      act(() => queue.flush());
      act(() => queue.flush());

      expect(scrollToIndex).not.toHaveBeenCalledWith(4);
      expect(scrollToIndex).toHaveBeenCalledWith(0);
    });

    it('does not throw when scrollToIndex is omitted, and schedules no frame at all', () => {
      const { result } = renderHook(() => useRovingFocus({ count: 5, idPrefix: 'row-' }));

      expect(() => {
        act(() => result.current.onKeyDown(keyEvent('End')));
      }).not.toThrow();
      expect(queue.pending()).toBe(0);
    });

    // #119 review — a non-virtualized caller (DocFieldTree) scrolls exactly
    // with one `scrollIntoView`, and its rows don't carry `${idPrefix}${i}`
    // ids, so the geometry check could never see it settle and would spin
    // to the frame cap on every arrow key.
    it('settle: false scrolls once, synchronously, and schedules no frame', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex, settle: false }),
      );

      act(() => result.current.onKeyDown(keyEvent('End')));

      expect(scrollToIndex).toHaveBeenCalledTimes(1);
      expect(scrollToIndex).toHaveBeenCalledWith(4);
      expect(queue.pending()).toBe(0);
    });

    // Guards against a stale closure: a broken dependency array on
    // `scrollThenSettle` would keep calling the `scrollToIndex` captured at
    // first render even after the caller passed a new one in.
    it('picks up a scrollToIndex passed in after the initial render, not a stale one', () => {
      const first = vi.fn();
      const second = vi.fn();
      const { result, rerender } = renderHook(
        ({ scrollToIndex }) => useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
        { initialProps: { scrollToIndex: first } },
      );

      rerender({ scrollToIndex: second });
      act(() => result.current.onKeyDown(keyEvent('End')));

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(4);
    });

    // Guards the other half of the same dependency array: a broken one on
    // `cancelPendingSettle` itself would make it (and, transitively,
    // `scrollThenSettle`) a new function every render, so an unrelated
    // re-render (focus, here) would re-run the cleanup effect and cancel a
    // jump that's still legitimately pending.
    it('an unrelated re-render (focus) does not cancel a pending settle', () => {
      const scrollToIndex = vi.fn();
      const { result } = renderHook(() =>
        useRovingFocus({ count: 5, idPrefix: 'row-', scrollToIndex }),
      );

      act(() => result.current.onKeyDown(keyEvent('End')));
      act(() => result.current.containerProps.onFocus(focusEvent()));
      scrollToIndex.mockClear();

      act(() => queue.flush());
      act(() => queue.flush());

      expect(scrollToIndex).toHaveBeenCalledWith(4);
    });

    // #62 follow-up (reviewer-found) — `count` can shrink out from under a
    // still-pending settle (a query re-run, a filter, a delete). `i` was a
    // valid index when captured; by settle time it can be `>= count`, and
    // react-window's real `scrollToRow` throws `RangeError` for that —
    // `scrollToIndex` here mirrors that so the test would crash without the
    // `countRef` guard. 49 is the exact `i === count` boundary (one document
    // deleted), where `i < count` and `i <= count` disagree.
    it.each([10, 49])(
      'does not replay a settle for an index a count shrunk to %i no longer has',
      (shrunkTo) => {
        let currentCount = 50;
        const scrollToIndex = vi.fn((i: number) => {
          if (i >= currentCount) throw new RangeError(`Invalid index ${i}`);
        });
        const { result, rerender } = renderHook(
          ({ count }) => useRovingFocus({ count, idPrefix: 'row-', scrollToIndex }),
          { initialProps: { count: 50 } },
        );

        act(() => result.current.onKeyDown(keyEvent('End'))); // captures i = 49, schedules its settle
        currentCount = shrunkTo;
        rerender({ count: shrunkTo }); // the list shrank while that settle is still pending
        scrollToIndex.mockClear();

        expect(() => {
          act(() => queue.flush());
          act(() => queue.flush());
        }).not.toThrow();
        expect(scrollToIndex).not.toHaveBeenCalledWith(49);
      },
    );
  });
});
