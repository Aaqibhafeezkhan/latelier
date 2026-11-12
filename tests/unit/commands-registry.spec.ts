import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry, objectRow } from '../../src/commands/registry';
import { preparationsBuilt, preparedCount, rankCommands } from '../../src/commands/rank';
import type { Command, ObjectAction, PaletteObject } from '../../src/commands/types';

function makeCmd(id: string, perform: () => void = () => {}): Command {
  return { id, title: id, group: 'general', perform };
}

afterEach(() => {
  commandRegistry._resetForTests();
});

describe('commandRegistry', () => {
  it('add() returns an unregister fn that removes only what it added', () => {
    const a = makeCmd('a');
    const b = makeCmd('b');
    const offA = commandRegistry.add([a]);
    commandRegistry.add([b]);
    expect(commandRegistry.list().map((c) => c.id).sort()).toEqual(['a', 'b']);
    offA();
    expect(commandRegistry.list().map((c) => c.id)).toEqual(['b']);
  });

  it('subscribe() fires on add and on remove', () => {
    const cb = vi.fn();
    const off = commandRegistry.subscribe(cb);
    const a = commandRegistry.add([makeCmd('a')]);
    expect(cb).toHaveBeenCalledTimes(1);
    a();
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    commandRegistry.add([makeCmd('b')])();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('replaces by id and warns once per duplicate id (dev only)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    commandRegistry.add([makeCmd('dup', first)]);
    commandRegistry.add([makeCmd('dup', second)]);
    commandRegistry.add([makeCmd('dup', second)]);
    const live = commandRegistry.list().find((c) => c.id === 'dup');
    expect(live?.perform).toBe(second);
    // Only one warn for the same id even on repeated re-adds.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('commandRegistry — prepared match text', () => {
  const ctx = { pathname: '/', connectionId: null };
  const find = (q: string) => rankCommands(commandRegistry.list(), q, ctx, []).map((r) => r.cmd.title);

  it('re-prepares a command whose title changed, instead of serving the old one', () => {
    commandRegistry.add([{ ...makeCmd('x'), title: 'Alpha' }])();
    commandRegistry.add([{ ...makeCmd('x'), title: 'Beta' }]);
    expect(find('alpha')).toEqual([]);
    expect(find('beta')).toEqual(['Beta']);
  });

  it('re-prepares a command whose matchText changed', () => {
    commandRegistry.add([{ ...makeCmd('x'), title: 'Open: a.b', matchText: 'a.b' }])();
    commandRegistry.add([{ ...makeCmd('x'), title: 'Open: a.b', matchText: 'c.d' }]);
    expect(find('a.b')).toEqual([]);
    expect(find('c.d')).toEqual(['Open: a.b']);
  });

  it('re-prepares a command whose subtitle or keywords changed', () => {
    commandRegistry.add([{ ...makeCmd('x'), subtitle: 'one', keywords: ['k1'] }])();
    commandRegistry.add([{ ...makeCmd('x'), subtitle: 'two', keywords: ['k2'] }]);
    expect(find('one')).toEqual([]);
    expect(find('k1')).toEqual([]);
    expect(find('two')).toEqual(['x']);
    expect(find('k2')).toEqual(['x']);
  });

  it('keeps the preparation across a re-registration in the same tick', async () => {
    const off = commandRegistry.add([makeCmd('keep-1'), makeCmd('keep-2')]);
    off();
    commandRegistry.add([makeCmd('keep-1'), makeCmd('keep-2')]);
    await Promise.resolve();
    expect(preparedCount()).toBeGreaterThanOrEqual(2);
    expect(find('keep')).toEqual(['keep-1', 'keep-2']);
  });

  it('drops the preparations of ids that are no longer registered', async () => {
    const off = commandRegistry.add([makeCmd('gone-1'), makeCmd('gone-2')]);
    await Promise.resolve();
    const before = preparedCount();
    off();
    await Promise.resolve();
    expect(preparedCount()).toBe(before - 2);
  });
});

describe('prepared match text — reuse', () => {
  const base = (over: Partial<Command> = {}): Command => ({ ...makeCmd('r'), title: 'Alpha', ...over });
  /** Prepares `first`, then `second` as a new object with the same id; true when nothing was built the second time. */
  const built = (first: Partial<Command>, second: Partial<Command>): number => {
    commandRegistry.add([base(first)])();
    const before = preparationsBuilt();
    commandRegistry.add([base(second)]);
    return preparationsBuilt() - before;
  };
  const reused = (first: Partial<Command>, second: Partial<Command>): boolean => built(first, second) === 0;

  it('reuses the preparation for a rebuilt command with the same text', () => {
    expect(reused({ subtitle: 's', keywords: ['a', 'b'] }, { subtitle: 's', keywords: ['a', 'b'] })).toBe(true);
    expect(reused({}, {})).toBe(true);
    const shared = ['a'];
    expect(reused({ keywords: shared }, { keywords: shared })).toBe(true);
  });

  it.each([
    ['title', {}, { title: 'Beta' }],
    ['matchText', { matchText: 'a' }, { matchText: 'b' }],
    ['subtitle', { subtitle: 'one' }, { subtitle: 'two' }],
    ['subtitle added', {}, { subtitle: 'two' }],
    ['keyword text', { keywords: ['a', 'b'] }, { keywords: ['a', 'c'] }],
    ['keyword count', { keywords: ['a'] }, { keywords: ['a', 'b'] }],
    ['keywords added', {}, { keywords: ['a'] }],
    ['keywords removed', { keywords: ['a'] }, {}],
  ])('prepares again when the %s changed', (_name, first, second) => {
    expect(built(first, second)).toBe(1);
  });

  it('does not prepare a row built from the query', () => {
    const before = preparationsBuilt();
    commandRegistry.add([base({ forQuery: () => null })]);
    expect(preparationsBuilt()).toBe(before);
  });
});

describe('commandRegistry — objects', () => {
  const action = (id: string, over: Partial<ObjectAction> = {}): ObjectAction => ({
    id,
    verb: id,
    title: id,
    perform: () => {},
    ...over,
  });
  const object = (id: string, name = id, over: Partial<PaletteObject> = {}): PaletteObject => ({
    id,
    kind: 'collection',
    name,
    actions: [action('open')],
    ...over,
  });
  const ctx = { pathname: '/', connectionId: null };

  it('adds objects as rows, replaces them by id and unregisters only its own', () => {
    const offA = commandRegistry.addObjects([object('a', 'shop.a')]);
    commandRegistry.addObjects([object('a', 'shop.b')]);
    expect(commandRegistry.list().map((c) => [c.id, c.title, c.object?.name])).toEqual([['a', 'shop.b', 'shop.b']]);
    offA();
    expect(commandRegistry.list()).toHaveLength(1);
    const offB = commandRegistry.addObjects([object('b')]);
    offB();
    expect(commandRegistry.list().map((c) => c.id)).toEqual(['a']);
  });

  it('prepares an object at registration', () => {
    const before = preparationsBuilt();
    commandRegistry.addObjects([object('p1', 'shop.p1')]);
    expect(preparationsBuilt()).toBe(before + 1);
    rankCommands(commandRegistry.list(), 'p1', ctx, []);
    expect(preparationsBuilt()).toBe(before + 1);
  });

  it('lists an object once typed or as Recent, and performs its default on the row', () => {
    const open = vi.fn();
    const row = objectRow(object('o', 'shop.o', { subtitle: 'Prod', keywords: ['k'], actions: [action('open', { perform: open })] }));
    expect(row).toMatchObject({ id: 'o', title: 'shop.o', subtitle: 'Prod', keywords: ['k'], group: 'workspace', hideWhenEmptyQuery: true });
    void row.perform(ctx);
    expect(open).toHaveBeenCalledWith(ctx);
    expect(objectRow(object('c', 'c', { kind: 'connection' })).group).toBe('connection');
    commandRegistry.add([row]);
    expect(rankCommands(commandRegistry.list(), '', ctx, []).map((r) => r.cmd.id)).toEqual([]);
    expect(rankCommands(commandRegistry.list(), '', ctx, ['o']).map((r) => r.cmd.id)).toEqual(['o']);
  });

  it('refuses an object it could not offer safely', () => {
    expect(() => objectRow(object('e', 'e', { actions: [] }))).toThrow('palette object "e" has no actions');
    expect(() => objectRow(object('d', 'd', { actions: [action('drop', { destructive: true })] }))).toThrow(
      'palette object "d": a destructive action is never the default',
    );
    const two = [action('a'), action('b', { alternate: true }), action('c', { alternate: true })];
    expect(() => objectRow(object('t', 't', { actions: two }))).toThrow('at most one alternate');
    const bad = [action('a'), action('b', { alternate: true, destructive: true })];
    expect(() => objectRow(object('u', 'u', { actions: bad }))).toThrow('at most one alternate');
    expect(() => objectRow(object('v', 'v', { actions: [action('a'), action('b', { alternate: true })] }))).not.toThrow();
  });
});
