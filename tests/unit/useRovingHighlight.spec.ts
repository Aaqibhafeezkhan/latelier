// @vitest-environment jsdom
//
// `useRovingHighlight` is pure React-state arithmetic — no DOM reads, no
// effects — but exercising it needs a real component render (React hooks
// only run inside one), which needs *some* DOM to mount into. The
// `unit` project itself runs under Node with no DOM; this file opts back
// into jsdom for just itself via the magic comment above, while still
// living in `tests/unit/**` so it's fast enough for Stryker's per-mutant
// rerun (see `stryker.config.json`'s `mutate` array).
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '../helpers/render';
import { installJsdomTeardown } from '../helpers/jsdomTeardown';
import { useRovingHighlight } from '../../src/hooks/useRovingHighlight';

// #110 — unmount and clear pending timers after each test; see
// tests/helpers/jsdomTeardown.ts for why a jsdom unit spec needs this.
installJsdomTeardown();

// `renderHook` wraps every hook in the app's real MantineProvider tree (see
// tests/helpers/render.tsx) so hook specs match the runtime tree — this file
// lives in the `unit` project, which (unlike `component`) has no
// `tests/helpers/jsdomSetup.ts` setupFile, so jsdom here is missing the
// window.matchMedia stub Mantine's color-scheme provider needs to mount.
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

describe('useRovingHighlight', () => {
  // #126 — two key events can reach a handler before React commits the
  // first one (seen on CI: the second press re-computed from the same
  // render-time index and one step was lost). Each call below comes from
  // one captured closure, inside one `act`, so no re-render happens between.
  describe('several updates before one re-render (#126)', () => {
    it('two move(1) calls both count', () => {
      const { result } = renderHook(() => useRovingHighlight(5));
      const { move } = result.current;
      act(() => {
        move(1);
        move(1);
      });
      expect(result.current.index).toBe(2);
    });

    it('setIndex then move moves from the index just set', () => {
      const { result } = renderHook(() => useRovingHighlight(5));
      const { setIndex, move } = result.current;
      act(() => {
        setIndex(3);
        move(1);
      });
      expect(result.current.index).toBe(4);
    });

    it('move wraps against the current count after the list shrinks, not the first render\'s', () => {
      const { result, rerender } = renderHook(({ count }) => useRovingHighlight(count), {
        initialProps: { count: 5 },
      });
      act(() => { result.current.setIndex(2); });
      rerender({ count: 3 });
      act(() => {
        result.current.move(1);
      });
      expect(result.current.index).toBe(0);
    });

    it('move returns the index it moved to, wrapping included', () => {
      const { result } = renderHook(() => useRovingHighlight(3));
      const { move } = result.current;
      const seen: number[] = [];
      act(() => {
        seen.push(move(1), move(1), move(1), move(-1));
      });
      expect(seen).toEqual([1, 2, 0, 2]);
      expect(result.current.index).toBe(2);
    });
  });

  it('starts at index 0', () => {
    const { result } = renderHook(() => useRovingHighlight(5));
    expect(result.current.index).toBe(0);
  });

  it('wraps forward past the last row back to 0', () => {
    const { result } = renderHook(() => useRovingHighlight(3));
    act(() => { result.current.setIndex(2); });
    act(() => { result.current.move(1); });
    expect(result.current.index).toBe(0);
  });

  it('wraps backward past the first row to the last', () => {
    const { result } = renderHook(() => useRovingHighlight(3));
    act(() => { result.current.move(-1); });
    expect(result.current.index).toBe(2);
  });

  it('moves within bounds without wrapping', () => {
    const { result } = renderHook(() => useRovingHighlight(3));
    act(() => { result.current.move(1); });
    expect(result.current.index).toBe(1);
  });

  // The clamp invariant: a highlight must never name a row that filtering
  // (or an external delete) has removed, even though nothing explicitly
  // reset it when the list shrank.
  it('clamps a standing highlight when count shrinks out from under it', () => {
    const { result, rerender } = renderHook(({ count }) => useRovingHighlight(count), {
      initialProps: { count: 5 },
    });
    act(() => { result.current.setIndex(4); });
    expect(result.current.index).toBe(4);

    rerender({ count: 2 });
    expect(result.current.index).toBe(1);
  });

  it('clamps to 0 when count drops to 0, and move() is a no-op', () => {
    const { result, rerender } = renderHook(({ count }) => useRovingHighlight(count), {
      initialProps: { count: 3 },
    });
    act(() => { result.current.setIndex(2); });
    rerender({ count: 0 });
    expect(result.current.index).toBe(0);

    act(() => { result.current.move(1); });
    expect(result.current.index).toBe(0);
  });

  it('move() computes from the clamped index, not a stale raw one', () => {
    // Standing highlight at the last row of a 5-item list; the list then
    // shrinks to 2 without an explicit reset (e.g. an external delete).
    // The clamped index is 1 (last row of 2) — moving forward from *that*
    // must wrap to 0, not to whatever raw-index-mod-2 would have produced.
    const { result, rerender } = renderHook(({ count }) => useRovingHighlight(count), {
      initialProps: { count: 5 },
    });
    act(() => { result.current.setIndex(4); });
    rerender({ count: 2 });
    expect(result.current.index).toBe(1);

    act(() => { result.current.move(1); });
    expect(result.current.index).toBe(0);
  });

  it('resetKey changing resets the index to 0 without an explicit call', () => {
    const { result, rerender } = renderHook(
      ({ count, resetKey }) => useRovingHighlight(count, resetKey),
      { initialProps: { count: 5, resetKey: 'a' } },
    );
    act(() => { result.current.setIndex(3); });
    expect(result.current.index).toBe(3);

    rerender({ count: 5, resetKey: 'b' });
    expect(result.current.index).toBe(0);
  });

  it('without a resetKey, the index survives a re-render with the same count', () => {
    const { result, rerender } = renderHook(({ count }) => useRovingHighlight(count), {
      initialProps: { count: 5 },
    });
    act(() => { result.current.setIndex(3); });
    rerender({ count: 5 });
    expect(result.current.index).toBe(3);
  });

  // `setIndex` stores `resetKey` alongside the index it's given so a later
  // render can tell a standing value apart from a stale one (see the
  // `raw`/`state.key` comparison in the hook body). If `setIndex`'s own
  // `useCallback` ever dropped `resetKey` from its deps, it would keep using
  // whatever `resetKey` was in scope the FIRST time it was created, and every
  // call after `resetKey` changes would tag the state with that stale value
  // — which the very next render's `state.key === resetKey` check then
  // rejects as stale itself, discarding the index it just set.
  it('setIndex tags state with the CURRENT resetKey, not the one from its first render', () => {
    const { result, rerender } = renderHook(
      ({ resetKey }) => useRovingHighlight(5, resetKey),
      { initialProps: { resetKey: 'a' } },
    );
    rerender({ resetKey: 'b' });
    act(() => { result.current.setIndex(3); });
    expect(result.current.index).toBe(3);
  });

  // `move`'s own `count === 0` guard exists so it never runs the wrap
  // arithmetic against a zero count (which would divide by zero). The
  // *returned* `index` stays 0 either way, because of the outer `count ===
  // 0 ? 0 : …` clamp — so the guard's own effect only shows up once `count`
  // grows again and the hook re-reads whatever `raw` a skipped vs. an
  // unskipped `move()` call left behind.
  it("move() at count 0 leaves state untouched, not corrupted, once count grows back", () => {
    const { result, rerender } = renderHook(({ count }) => useRovingHighlight(count), {
      initialProps: { count: 0 },
    });
    act(() => { result.current.move(1); });
    rerender({ count: 3 });
    expect(result.current.index).toBe(0);
  });
});
