import { describe, it, expect } from 'vitest';
import { prefSetSchema } from '../../electron/ipc/prefKeys';
import { PINNED_PREF_KEY, parsePinned, sortPinnedFirst, togglePinned } from '../../src/state/connectionPins';

const c = (id: string) => ({ id });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('sortPinnedFirst', () => {
  it('puts pinned first and keeps each group in its original order', () => {
    const out = sortPinnedFirst([c('a'), c('b'), c('c'), c('d'), c('e')], ['d', 'b']);
    expect(ids(out)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('is independent of the order of the pinned ids', () => {
    const conns = [c('a'), c('b'), c('c')];
    expect(ids(sortPinnedFirst(conns, ['c', 'b']))).toEqual(ids(sortPinnedFirst(conns, ['b', 'c'])));
  });

  it('leaves the list alone when nothing, or everything, is pinned', () => {
    const conns = [c('a'), c('b'), c('c')];
    expect(ids(sortPinnedFirst(conns, []))).toEqual(['a', 'b', 'c']);
    expect(ids(sortPinnedFirst(conns, ['c', 'a', 'b']))).toEqual(['a', 'b', 'c']);
  });

  it('ignores pinned ids that are not in the list, and does not mutate its input', () => {
    const conns = [c('a'), c('b')];
    expect(ids(sortPinnedFirst(conns, ['zzz', 'b']))).toEqual(['b', 'a']);
    expect(ids(conns)).toEqual(['a', 'b']);
  });

  it('keeps the whole object, not just the id', () => {
    const a = { id: 'a', name: 'Alpha' };
    expect(sortPinnedFirst([{ id: 'b', name: 'Bravo' }, a], new Set(['a']))[0]).toBe(a);
  });
});

describe('togglePinned', () => {
  const live = new Set(['a', 'b', 'c']);

  it('adds an unpinned id at the end', () => {
    expect(togglePinned(['a'], 'b', live)).toEqual(['a', 'b']);
  });

  it('removes a pinned id', () => {
    expect(togglePinned(['a', 'b'], 'a', live)).toEqual(['b']);
  });

  it('drops ids of connections that no longer exist', () => {
    expect(togglePinned(['gone', 'a'], 'b', live)).toEqual(['a', 'b']);
    expect(togglePinned(['gone'], 'a', live)).toEqual(['a']);
  });
});

describe('parsePinned', () => {
  it('keeps the strings of an array', () => {
    expect(parsePinned(['a', 1, null, 'b'])).toEqual(['a', 'b']);
  });

  it.each([null, undefined, 'a', 3, { 0: 'a' }, true])('reads %j as nothing pinned', (v) => {
    expect(parsePinned(v)).toEqual([]);
  });
});

describe('PINNED_PREF_KEY', () => {
  it('is a key the main process lets the renderer write', () => {
    expect(prefSetSchema(PINNED_PREF_KEY)).not.toBeNull();
  });
});
