import { describe, it, expect } from 'vitest';
import {
  HISTORY_CAP,
  initHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
} from '../../src/pages/Workspace/filterHistory';

describe('filterHistory', () => {
  it('starts with nothing to undo or redo', () => {
    const h = initHistory('a');
    expect(h).toEqual({ past: [], present: 'a', future: [], lastKey: null });
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('a push moves the present into past and clears future', () => {
    const h = redo(undo(pushHistory(initHistory('a'), 'b')));
    expect(h.future).toEqual([]);
    const pushed = pushHistory(undo(pushHistory(initHistory('a'), 'b')), 'c');
    expect(pushed).toEqual({ past: ['a'], present: 'c', future: [], lastKey: null });
    expect(canUndo(pushed)).toBe(true);
    expect(canRedo(pushed)).toBe(false);
  });

  it('a push with the same key as the last replaces the present without growing past', () => {
    const h1 = pushHistory(initHistory('a'), 'b', 'k');
    expect(h1).toEqual({ past: ['a'], present: 'b', future: [], lastKey: 'k' });
    const h2 = pushHistory(h1, 'bc', 'k');
    expect(h2).toEqual({ past: ['a'], present: 'bc', future: [], lastKey: 'k' });
  });

  it('a different key, or no key, grows past', () => {
    const h1 = pushHistory(initHistory('a'), 'b', 'k');
    expect(pushHistory(h1, 'c', 'other')).toEqual({ past: ['a', 'b'], present: 'c', future: [], lastKey: 'other' });
    expect(pushHistory(h1, 'c')).toEqual({ past: ['a', 'b'], present: 'c', future: [], lastKey: null });
    const keyless = pushHistory(initHistory('a'), 'b');
    expect(pushHistory(keyless, 'c')).toEqual({ past: ['a', 'b'], present: 'c', future: [], lastKey: null });
  });

  it('undo and redo move one step each way', () => {
    const h = pushHistory(pushHistory(initHistory('a'), 'b'), 'c');
    const u = undo(h);
    expect(u).toEqual({ past: ['a'], present: 'b', future: ['c'], lastKey: null });
    expect(canRedo(u)).toBe(true);
    const r = redo(u);
    expect(r).toEqual({ past: ['a', 'b'], present: 'c', future: [], lastKey: null });
  });

  it('undo and redo with nothing to move return the same object', () => {
    const h = initHistory('a');
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it(`keeps at most ${HISTORY_CAP} past entries, dropping the oldest`, () => {
    let h = initHistory(0);
    for (let i = 1; i <= HISTORY_CAP + 5; i++) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toBe(5);
    expect(h.present).toBe(HISTORY_CAP + 5);
  });

  it('a no-op edit at the cap keeps every step, the oldest included', () => {
    let h = initHistory(0);
    for (let i = 1; i <= HISTORY_CAP; i++) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_CAP);
    const oldest = h.past[0];
    const same = pushHistory(h, h.present);
    expect(same.past).toHaveLength(HISTORY_CAP);
    expect(same.past[0]).toBe(oldest);
  });

  it('a push after an undo clears future', () => {
    const h = undo(pushHistory(initHistory('a'), 'b'));
    expect(h.future).toEqual(['b']);
    expect(pushHistory(h, 'c').future).toEqual([]);
  });

  it('undo forgets the last key, so the next same-key push is its own step', () => {
    const h = pushHistory(pushHistory(initHistory('a'), 'b'), 'bc', 'k');
    const u = undo(h);
    expect(u.lastKey).toBeNull();
    expect(pushHistory(u, 'bd', 'k')).toEqual({ past: ['a', 'b'], present: 'bd', future: [], lastKey: 'k' });
  });

  it('redo forgets the last key too', () => {
    const h = undo(pushHistory(initHistory('a'), 'b', 'k'));
    const r = redo(h);
    expect(r.lastKey).toBeNull();
    expect(pushHistory(r, 'bc', 'k').past).toEqual(['a', 'b']);
  });

  it('a push equal to the present adds no step', () => {
    const h = pushHistory(initHistory({ a: 1 }), { a: 2 });
    const same = pushHistory(h, { a: 2 });
    expect(same.past).toEqual([{ a: 1 }]);
    expect(same.present).toEqual({ a: 2 });
  });

  it('typing then deleting back to where the step began leaves no empty undo step', () => {
    const typed = pushHistory(pushHistory(initHistory('a'), 'ab', 'k'), 'abc', 'k');
    const back = pushHistory(typed, 'a', 'k');
    expect(back).toEqual({ past: [], present: 'a', future: [], lastKey: null });
    // Typing again starts a fresh step rather than silently overwriting.
    expect(pushHistory(back, 'ax', 'k')).toEqual({ past: ['a'], present: 'ax', future: [], lastKey: 'k' });
  });

  it('a step that lands back where it started still clears the redo stack', () => {
    const h = undo(pushHistory(pushHistory(initHistory('a'), 'b'), 'c'));
    expect(h.future).toEqual(['c']);
    expect(pushHistory(h, 'b').future).toEqual([]);
  });
});
