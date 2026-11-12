import { describe, expect, it } from 'vitest';
import { kindOf, matchText, rankCapped, QUERY_ROW_LABEL } from '../../src/commands/rank';
import {
  ACTION_LIST_HINTS,
  ALL_CAP,
  HISTORY_CAP,
  KIND_LAYOUT,
  KIND_ORDER,
  SCOPE_LABEL,
  SCOPES,
  SCOPE_CAP,
  actionList,
  asideFor,
  cycleScope,
  failureTitle,
  fieldStepHints,
  fieldStepList,
  footerHints,
  layoutPalette,
  pushHistory,
  stepHistory,
  type Entry,
  type MoreEntry,
  type RowEntry,
} from '../../src/commands/layout';
import { objectRow } from '../../src/commands/registry';
import type { Command, ObjectAction, ObjectKind, PaletteContext, PaletteObject } from '../../src/commands/types';

const ctx: PaletteContext = { pathname: '/workspace', connectionId: 'c1' };

const cmd = (over: Partial<Command> & { id: string }): Command => ({
  title: over.id,
  group: 'general',
  perform: () => {},
  ...over,
});

const act = (id: string, verb: string, over: Partial<ObjectAction> = {}): ObjectAction => ({
  id,
  verb,
  title: id,
  perform: () => {},
  ...over,
});

const coll = (name: string, over: Partial<Command> = {}): Command => ({
  ...objectRow({
    id: `tab.open:c1:shop:${name}`,
    kind: 'collection',
    name: `shop.${name}`,
    subtitle: 'Production',
    actions: [
      act('Open', 'open'),
      act('Open in new tab', 'open', { alternate: true }),
      act('Drop collection…', 'delete', { destructive: true }),
    ],
  }),
  ...over,
});

const conn = (name: string): Command =>
  objectRow({
    id: `connection.open:${name}`,
    kind: 'connection',
    name,
    subtitle: 'host',
    actions: [act('Open', 'open'), act('Delete…', 'delete', { destructive: true })],
  });

const ids = (entries: Entry[]) => entries.map((e) => e.id);
const rows = (entries: Entry[]) => entries.filter((e): e is RowEntry => e.type === 'row');

describe('kindOf', () => {
  it('reads a row\'s kind from its object, and a command as an action', () => {
    expect(kindOf(coll('orders'))).toBe('collection');
    expect(kindOf(conn('Prod'))).toBe('connection');
    expect(kindOf(cmd({ id: 'connection.edit:Prod' }))).toBe('action');
    expect(kindOf(cmd({ id: 'x.tab.open:a' }))).toBe('action');
    expect(kindOf(cmd({ id: 'x.connection.open:a' }))).toBe('action');
  });
});

describe('rankCapped', () => {
  it('refuses a cap below one', () => {
    expect(() => rankCapped([], 'a', ctx, [], 0, () => 'k')).toThrow('the cap must be at least 1, got 0');
    expect(() => rankCapped([], 'a', ctx, [], Number.NaN, () => 'k')).toThrow(/at least 1/);
    expect(rankCapped([], 'a', ctx, [], 1, () => 'k').buckets).toEqual([]);
  });

  it('orders the buckets by their best row', () => {
    const all = [cmd({ id: 'run', title: 'Reorder things' }), coll('orders'), coll('reorders')];
    const r = rankCapped(all, 'orders', ctx, [], 5, (k) => k);
    expect(r.buckets.map((b) => b.key)).toEqual(['collection', 'action']);
    const flipped = rankCapped([coll('reorders'), cmd({ id: 'run', title: 'Orders' })], 'orders', ctx, [], 5, (k) => k);
    expect(flipped.buckets.map((b) => b.key)).toEqual(['action', 'collection']);
  });

  it('keeps the best rows whatever order they arrive in', () => {
    const names = ['zz_orders_long_name', 'orders_b', 'orders', 'x_orders', 'orders_archive_x', 'o_orders'];
    const r = rankCapped(names.map((n) => coll(n)), 'orders', ctx, [], 3, () => 'b');
    expect(r.buckets[0]!.rows.map((x) => x.cmd.title)).toEqual(['shop.orders', 'shop.orders_b', 'shop.x_orders']);
    expect(r.buckets[0]!.total).toBe(6);
  });

  it('counts a kind with no bucket, and keeps none of its rows', () => {
    const all = [coll('orders'), cmd({ id: 'a', title: 'Orders report' }), cmd({ id: 'b', title: 'Orders' })];
    const r = rankCapped(all, 'orders', ctx, [], 5, (k) => (k === 'action' ? null : k));
    expect(r.buckets.map((b) => b.key)).toEqual(['collection']);
    expect(r.counts.get('action')).toBe(2);
    expect(r.counts.get('collection')).toBe(1);
    expect(r.counts.has('connection')).toBe(false);
  });

  it('passes a row built from the query through, outside the buckets', () => {
    const pasted = cmd({
      id: 'q',
      forQuery: (q) => ({ title: `Find ${q}`, subtitle: 's', emphasis: q, perform: () => {} }),
    });
    const r = rankCapped([pasted, coll('abc')], 'abc', ctx, [], 5, (k) => k);
    expect(r.fromQuery.map((x) => x.cmd.title)).toEqual(['Find abc']);
    expect(r.buckets.map((b) => b.key)).toEqual(['collection']);
  });

  it('buckets the empty-query list in its own order, recent first, capped', () => {
    const all = [cmd({ id: 'a' }), cmd({ id: 'b' }), cmd({ id: 'c' }), coll('orders'), conn('Prod')];
    const r = rankCapped(all, '  ', ctx, ['tab.open:c1:shop:orders', 'c'], 2, (k) => (k === 'connection' ? null : k));
    expect(r.fromQuery).toEqual([]);
    expect(r.buckets.map((b) => [b.key, b.total, b.rows.map((x) => x.cmd.id)])).toEqual([
      ['collection', 1, ['tab.open:c1:shop:orders']],
      ['action', 3, ['c', 'a']],
    ]);
    expect(r.buckets[1]!.rows.map((x) => x.recent)).toEqual([true, false]);
    // An object that is not recent waits for the user to type.
    expect(r.counts.has('connection')).toBe(false);
    expect(r.counts.get('action')).toBe(3);
  });
});

describe('the scope and kind tables', () => {
  it('names the five scopes in order', () => {
    expect(SCOPES.map((s) => SCOPE_LABEL[s])).toEqual(['All', 'Collections', 'Actions', 'Saved', 'Tabs']);
  });

  it('gives every kind its group label, its more-noun and its scope', () => {
    expect(KIND_LAYOUT).toEqual({
      collection: { group: 'Collections', noun: 'collections', one: 'collection', scope: 'collections' },
      database: { group: 'Databases', noun: 'databases', one: 'database', scope: 'collections' },
      connection: { group: 'Connections', noun: 'connections', one: 'connection', scope: null },
      tab: { group: 'Tabs', noun: 'tabs', one: 'tab', scope: 'tabs' },
      saved: { group: 'Saved', noun: 'saved', one: 'saved', scope: 'saved' },
      action: { group: 'Actions', noun: 'actions', one: 'action', scope: 'actions' },
    });
  });
});

describe('cycleScope', () => {
  it('steps forward and back, wrapping both ways', () => {
    expect(cycleScope('all', 1)).toBe('collections');
    expect(cycleScope('tabs', 1)).toBe('all');
    expect(cycleScope('all', -1)).toBe('tabs');
    expect(cycleScope('actions', -1)).toBe('collections');
    expect(cycleScope('saved', 6)).toBe('tabs');
  });
});

describe('asideFor', () => {
  const row = (c: Command, recent = false) => ({ cmd: c, recent, cls: null, ranges: [], subtitleRanges: [] });

  it('shows a toggle’s switch before anything else', () => {
    const c = cmd({ id: 't', toggle: { checked: false }, shortcut: '⌘B' });
    expect(asideFor(row(c, true), 'action', true)).toEqual({ type: 'switch', checked: false });
  });

  it('names the kind of a collection or Connection under RECENT', () => {
    expect(asideFor(row(coll('o'), true), 'collection', true)).toEqual({ type: 'tag', label: 'Collection' });
    expect(asideFor(row(conn('P'), true), 'connection', true)).toEqual({ type: 'tag', label: 'Connection' });
  });

  it('shows a shortcut, then Recent on a recent row of a typed query', () => {
    expect(asideFor(row(cmd({ id: 'r', shortcut: '⌘↵' }), true), 'action', true)).toEqual({ type: 'key', keys: '⌘↵' });
    expect(asideFor(row(cmd({ id: 'r', shortcut: '⌘↵' }), true), 'action', false)).toEqual({ type: 'key', keys: '⌘↵' });
    expect(asideFor(row(coll('o'), true), 'collection', false)).toEqual({ type: 'tag', label: 'Recent' });
    expect(asideFor(row(cmd({ id: 'r' }), true), 'action', true)).toBeNull();
    expect(asideFor(row(cmd({ id: 'r' })), 'action', false)).toBeNull();
  });
});

describe('asideFor — an object’s own tag', () => {
  const row = (c: Command, recent = false) => ({ cmd: c, recent, cls: null, ranges: [], subtitleRanges: [] });
  const tab = objectRow({ id: 'tab:t1', kind: 'tab', name: 'orders', tag: 'Open tab', actions: [act('Switch to', 'open')] });

  it('shows the tag instead of Recent, and under RECENT where its kind has no tag', () => {
    expect(asideFor(row(tab, true), 'tab', false)).toEqual({ type: 'tag', label: 'Open tab' });
    expect(asideFor(row(tab), 'tab', false)).toEqual({ type: 'tag', label: 'Open tab' });
    expect(asideFor(row(tab, true), 'tab', true)).toEqual({ type: 'tag', label: 'Open tab' });
  });

  it('gives way to the kind tag under RECENT and to a verb’s action', () => {
    const tagged = { ...coll('o'), object: { ...coll('o').object!, tag: 'X' } };
    expect(asideFor(row(tagged, true), 'collection', true)).toEqual({ type: 'tag', label: 'Collection' });
    const action = act('Close', 'close');
    expect(asideFor({ ...row(tab), action }, 'tab', false)).toEqual({ type: 'action', label: 'Close', destructive: false });
  });

  it('comes before a shortcut', () => {
    const c = { ...tab, shortcut: '⌘1' };
    expect(asideFor(row(c), 'tab', false)).toEqual({ type: 'tag', label: 'Open tab' });
  });
});

describe('layoutPalette — empty query in All', () => {
  it('lists RECENT, then the command groups in their fixed order, with no counts', () => {
    const all = [
      cmd({ id: 'settings', title: 'Open settings', shortcut: '⌘,' }),
      cmd({ id: 'run', title: 'Run query', group: 'query', shortcut: '⌘↵' }),
      coll('orders'),
      coll('users'),
    ];
    const l = layoutPalette(all, '', ctx, ['tab.open:c1:shop:orders', 'run'], 'all');
    expect(l.groups.map((g) => [g.key, g.label])).toEqual([
      ['recent', 'Recent'],
      ['general', 'General'],
    ]);
    expect(ids(l.entries)).toEqual(['tab.open:c1:shop:orders', 'run', 'settings']);
    expect(l.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(rows(l.entries).map((e) => e.aside)).toEqual([
      { type: 'tag', label: 'Collection' },
      { type: 'key', keys: '⌘↵' },
      { type: 'key', keys: '⌘,' },
    ]);
    expect(l.counts).toBeNull();
    expect(l.hidden).toBe(0);
  });

  it('reads a blank query as empty', () => {
    const l = layoutPalette([cmd({ id: 'a' }), coll('orders')], '   ', ctx, [], 'all');
    expect(l.groups.map((g) => g.key)).toEqual(['general']);
    expect(l.counts).toBeNull();
  });

  it('lists a Connection on an empty query only as Recent, tagged with its kind', () => {
    expect(layoutPalette([conn('Prod')], '', ctx, [], 'all').entries).toEqual([]);
    const l = layoutPalette([conn('Prod')], '', ctx, ['connection.open:Prod'], 'all');
    expect(rows(l.entries).map((e) => e.aside)).toEqual([{ type: 'tag', label: 'Connection' }]);
  });

  it('greys a row whose disabledReason answers, and reads it with the palette context', () => {
    const seen: PaletteContext[] = [];
    const all = [
      cmd({ id: 'copy', disabledReason: (c) => (seen.push(c), 'Type a filter first') }),
      cmd({ id: 'ok', disabledReason: () => null }),
      cmd({ id: 'plain' }),
    ];
    const l = layoutPalette(all, '', ctx, [], 'all');
    expect(rows(l.entries).map((e) => e.disabled)).toEqual(['Type a filter first', null, null]);
    expect(seen).toEqual([ctx]);
  });
});

describe('layoutPalette — typed query in All', () => {
  const many = Array.from({ length: 8 }, (_, i) => coll(`orders${i}`));

  it('groups by kind, five rows each, then a Show more row that names the kind’s scope', () => {
    const all = [...many, cmd({ id: 'a', title: 'Reorders report', shortcut: '⌘R' })];
    const l = layoutPalette(all, 'orders', ctx, [], 'all');
    expect(l.groups.map((g) => [g.key, g.label])).toEqual([
      ['collection', 'Collections'],
      ['action', 'Actions'],
    ]);
    const [colls] = l.groups;
    expect(colls!.entries).toHaveLength(ALL_CAP + 1);
    const more = colls!.entries[ALL_CAP] as MoreEntry;
    expect(more).toEqual({
      type: 'more',
      id: 'more:collection',
      index: ALL_CAP,
      kind: 'collection',
      scope: 'collections',
      label: 'Show 3 more collections',
    });
    expect(l.entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(l.counts).toEqual({ collections: 8, actions: 1, saved: 0, tabs: 0 });
  });

  it('lists no Show more for a kind that fits, and none for Connections, which have no scope', () => {
    const all = Array.from({ length: 7 }, (_, i) => conn(`Prod${i}`));
    const l = layoutPalette([...all, coll('prod')], 'prod', ctx, [], 'all');
    expect(l.groups.map((g) => [g.key, g.label, g.entries.length])).toEqual([
      ['collection', 'Collections', 1],
      ['connection', 'Connections', ALL_CAP],
    ]);
    expect(l.entries.some((e) => e.type === 'more')).toBe(false);
  });

  it('says how many more actions there are, singular for one', () => {
    const all = Array.from({ length: 6 }, (_, i) => cmd({ id: `a${i}`, title: `Go ${i}` }));
    const l = layoutPalette(all, 'go', ctx, [], 'all');
    expect((l.entries.at(-1) as MoreEntry).label).toBe('Show 1 more action');
    const seven = Array.from({ length: 7 }, (_, i) => cmd({ id: `a${i}`, title: `Go ${i}` }));
    expect((layoutPalette(seven, 'go', ctx, [], 'all').entries.at(-1) as MoreEntry).label).toBe('Show 2 more actions');
    expect((l.entries.at(-1) as MoreEntry).scope).toBe('actions');
  });

  it('puts a row built from the query first, under its own label, with the Enter key cap, not its shortcut', () => {
    const pasted = cmd({
      id: 'q',
      shortcut: '⌘F',
      forQuery: (q) => ({ title: `Find ${q}`, subtitle: 's', emphasis: q, perform: () => {} }),
    });
    const l = layoutPalette([coll('abc'), pasted], 'abc', ctx, [], 'all');
    expect(l.groups.map((g) => [g.key, g.label])).toEqual([
      ['pasted', QUERY_ROW_LABEL],
      ['collection', 'Collections'],
    ]);
    expect((l.entries[0] as RowEntry).aside).toEqual({ type: 'key', keys: '↵' });
    expect((l.entries[1] as RowEntry).aside).toBeNull();
  });

  it('tags a recent collection Recent', () => {
    const l = layoutPalette([coll('orders1'), coll('orders2')], 'orders', ctx, ['tab.open:c1:shop:orders2'], 'all');
    expect(rows(l.entries).map((e) => [e.id, e.aside])).toEqual([
      ['tab.open:c1:shop:orders2', { type: 'tag', label: 'Recent' }],
      ['tab.open:c1:shop:orders1', null],
    ]);
  });
});

describe('layoutPalette — the kind order in All on a typed query', () => {
  const obj = (kind: PaletteObject['kind'], name: string): Command =>
    objectRow({ id: `${kind}:${name}`, kind, name, actions: [act('Open', 'open')] });

  it('draws Collections, Databases, Tabs, Saved, Connections, Actions, whichever matches best', () => {
    const all = [
      cmd({ id: 'a', title: 'orders' }),
      obj('connection', 'orders'),
      obj('saved', 'orders'),
      obj('tab', 'orders'),
      obj('database', 'orders x'),
      obj('collection', 'shop.reorders'),
    ];
    const l = layoutPalette(all, 'orders', ctx, [], 'all');
    expect(l.groups.map((g) => g.key)).toEqual(['collection', 'database', 'tab', 'saved', 'connection', 'action']);
    expect(KIND_ORDER).toEqual(['collection', 'database', 'tab', 'saved', 'connection', 'action']);
    // The cursor's first row is the first drawn, not the best match.
    expect(l.entries[0]!.id).toBe('collection:shop.reorders');
  });

  it('leaves out empty kinds and keeps rank order inside each group', () => {
    const all = [obj('tab', 'reorders'), obj('tab', 'orders'), cmd({ id: 'a', title: 'orders' })];
    const l = layoutPalette(all, 'orders', ctx, [], 'all');
    expect(l.groups.map((g) => g.key)).toEqual(['tab', 'action']);
    expect(ids(l.groups[0]!.entries)).toEqual(['tab:orders', 'tab:reorders']);
  });
});

describe('layoutPalette — a single scope', () => {
  const many = Array.from({ length: 60 }, (_, i) => coll(`orders${String(i).padStart(2, '0')}`));

  it('lists the 50 best of its kinds in rank order, without a header, and counts the rest', () => {
    const all = [...many, cmd({ id: 'a', title: 'Orders report' })];
    const l = layoutPalette(all, 'orders', ctx, [], 'collections');
    expect(l.groups).toHaveLength(1);
    expect(l.groups[0]!.label).toBeNull();
    expect(l.entries).toHaveLength(SCOPE_CAP);
    expect(l.entries.every((e) => e.type === 'row' && e.kind === 'collection')).toBe(true);
    expect(l.entries[0]!.id).toBe('tab.open:c1:shop:orders00');
    expect(l.hidden).toBe(10);
    expect(l.counts).toEqual({ collections: 60, actions: 1, saved: 0, tabs: 0 });
  });

  it('lists actions only in Actions, and nothing in Saved or Tabs yet', () => {
    const all = [...many.slice(0, 2), cmd({ id: 'a', title: 'Orders report' })];
    expect(ids(layoutPalette(all, 'orders', ctx, [], 'actions').entries)).toEqual(['a']);
    const saved = layoutPalette(all, 'orders', ctx, [], 'saved');
    expect(saved.entries).toEqual([]);
    expect(saved.groups).toEqual([]);
    expect(saved.hidden).toBe(0);
    expect(saved.counts).toEqual({ collections: 2, actions: 1, saved: 0, tabs: 0 });
  });

  it('lists the recent collections on an empty query, without counts', () => {
    const l = layoutPalette([...many.slice(0, 3), cmd({ id: 'a' })], '', ctx, ['a', 'tab.open:c1:shop:orders01'], 'collections');
    expect(ids(l.entries)).toEqual(['tab.open:c1:shop:orders01']);
    expect((l.entries[0] as RowEntry).aside).toEqual({ type: 'tag', label: 'Recent' });
    expect(l.counts).toBeNull();
  });

  it('never lists the row built from the query: it is in All only', () => {
    const pasted = cmd({ id: 'q', forQuery: (q) => ({ title: q, subtitle: '', emphasis: q, perform: () => {} }) });
    for (const scope of ['collections', 'actions', 'saved', 'tabs'] as const) {
      expect(layoutPalette([pasted, coll('abc')], 'abc', ctx, [], scope).entries.some((e) => e.id === 'q')).toBe(false);
    }
    expect(layoutPalette([pasted], 'abc', ctx, [], 'all').entries.map((e) => e.id)).toEqual(['q']);
  });
});

describe('footerHints', () => {
  const row = (over: Partial<RowEntry>): RowEntry => ({
    type: 'row',
    id: 'x',
    index: 0,
    cmd: cmd({ id: 'x' }),
    row: { cmd: cmd({ id: 'x' }), recent: false, cls: null, ranges: [], subtitleRanges: [] },
    kind: 'action',
    aside: null,
    disabled: null,
    ...over,
  });

  it('names what Enter does on the highlighted entry', () => {
    const left = (e: Entry | undefined) => footerHints('all', true, e).left;
    const c = coll('o');
    expect(left(row({ kind: 'collection', cmd: c, row: { cmd: c, recent: false, cls: null, ranges: [], subtitleRanges: [] } }))).toEqual([
      { keys: '↵', label: 'Open' },
      { keys: '⌘↵', label: 'Open in new tab' },
      { keys: '⌥↵', label: 'Actions' },
    ]);
    const p = conn('P');
    expect(left(row({ kind: 'connection', cmd: p, row: { cmd: p, recent: false, cls: null, ranges: [], subtitleRanges: [] } }))).toEqual([
      { keys: '↵', label: 'Open' },
      { keys: '⌥↵', label: 'Actions' },
    ]);
    expect(left(row({}))).toEqual([{ keys: '↵', label: 'Run' }]);
    expect(left(row({ cmd: cmd({ id: 't', toggle: { checked: true } }) }))).toEqual([{ keys: '↵', label: 'Toggle' }]);
    const fromQuery = { title: 't', subtitle: '', emphasis: 't', perform: () => {} };
    expect(left(row({ row: { cmd: cmd({ id: 'q' }), recent: false, cls: null, ranges: [], subtitleRanges: [], fromQuery } }))).toEqual([
      { keys: '↵', label: 'Find' },
    ]);
    expect(left(row({ disabled: 'no' }))).toEqual([]);
    expect(left(undefined)).toEqual([]);
    const more: MoreEntry = { type: 'more', id: 'm', index: 0, kind: 'collection', scope: 'collections', label: '' };
    expect(left(more)).toEqual([{ keys: '↵', label: 'Switch scope' }]);
  });

  it('offers ⌘P on an empty query in All, and in a scope ⇧Tab naming the scope it goes to', () => {
    expect(footerHints('all', false, undefined).right).toEqual([{ keys: '⌘P', label: 'Collections' }]);
    expect(footerHints('all', true, undefined).right).toEqual([]);
    expect(footerHints('collections', false, undefined).right).toEqual([{ keys: '⇧Tab', label: 'All' }]);
    expect(footerHints('actions', true, undefined).right).toEqual([{ keys: '⇧Tab', label: 'Collections' }]);
    expect(footerHints('tabs', true, undefined).right).toEqual([{ keys: '⇧Tab', label: 'Saved' }]);
  });
});

describe('query history', () => {
  it('puts a query first, once, trimmed, and ignores a blank one', () => {
    expect(pushHistory(['a', 'b'], '  b ')).toEqual(['b', 'a']);
    expect(pushHistory(['a'], '   ')).toEqual(['a']);
    const h = ['a'];
    expect(pushHistory(h, '')).not.toBe(h);
  });

  it('keeps at most twenty', () => {
    let h: string[] = [];
    for (let i = 0; i < 25; i++) h = pushHistory(h, `q${i}`);
    expect(h).toHaveLength(HISTORY_CAP);
    expect(h[0]).toBe('q24');
    expect(h.at(-1)).toBe('q5');
  });

  it('steps older and newer, back to an empty input, and stops at the oldest', () => {
    const h = ['new', 'mid', 'old'];
    expect(stepHistory(h, -1, 'older')).toEqual({ at: 0, query: 'new' });
    expect(stepHistory(h, 1, 'older')).toEqual({ at: 2, query: 'old' });
    expect(stepHistory(h, 2, 'older')).toBeNull();
    expect(stepHistory(h, 2, 'newer')).toEqual({ at: 1, query: 'mid' });
    expect(stepHistory(h, 0, 'newer')).toEqual({ at: -1, query: '' });
    expect(stepHistory(h, -1, 'newer')).toBeNull();
    expect(stepHistory([], -1, 'older')).toBeNull();
  });
});

describe('actionList', () => {
  const obj = (kind: 'collection' | 'connection'): PaletteObject => ({
    id: 'o',
    kind,
    name: 'shop.orders',
    actions: [
      act('Open', 'open'),
      act('Drop collection…', 'delete', { destructive: true }),
      act('Open in new tab', 'open', { alternate: true }),
      act('Rename…', 'rename', { disabledReason: (c) => (c.connectionId === 'c1' ? 'a view' : null) }),
      act('Filter by field…', 'filter', { fieldStep: () => null }),
    ],
  });

  it('lists every action, destructive ones last, with keys and tags', () => {
    const list = actionList(obj('collection'), '', ctx);
    expect(list.map((a) => [a.action.id, a.index, a.keys, a.tag, a.disabled])).toEqual([
      ['Open', 0, '↵', 'reuses the open tab', null],
      ['Open in new tab', 1, '⌘↵', null, null],
      ['Rename…', 2, null, null, 'a view'],
      ['Filter by field…', 3, null, '›', null],
      ['Drop collection…', 4, null, 'asks to confirm', null],
    ]);
  });

  it('tags the reused tab on a collection only', () => {
    expect(actionList(obj('connection'), '', ctx)[0]!.tag).toBeNull();
  });

  it('filters with the palette matcher, keeping the order', () => {
    const list = actionList(obj('collection'), 'op', ctx);
    expect(list.map((a) => [a.action.id, a.index, a.ranges])).toEqual([
      ['Open', 0, [[0, 2]]],
      ['Open in new tab', 1, [[0, 2]]],
      ['Drop collection…', 2, [[2, 4]]],
    ]);
    expect(actionList(obj('collection'), 'new tab', ctx).map((a) => a.action.id)).toEqual(['Open in new tab']);
    expect(actionList(obj('collection'), 'zzz', ctx)).toEqual([]);
  });

  it('gives the action list its own footer', () => {
    expect(ACTION_LIST_HINTS.left.map((h) => `${h.keys} ${h.label}`)).toEqual([
      '↵ Run action',
      'esc Back to results',
      '← Back, on an empty input',
    ]);
    expect(ACTION_LIST_HINTS.right).toEqual([]);
  });
});

describe('matchText', () => {
  it('returns ranges, [] on an empty query, null on a miss', () => {
    expect(matchText('Open in new tab', '  ')).toEqual([]);
    expect(matchText('Open in new tab', 'tab NEW')).toEqual([
      [8, 11],
      [12, 15],
    ]);
    expect(matchText('Open in new tab', 'tab  new')).toEqual([
      [8, 11],
      [12, 15],
    ]);
    expect(matchText('Open', 'open x')).toBeNull();
  });
});

describe('the field step', () => {
  const fields = [
    { path: 'status', type: 'String' },
    { path: 'shipping.street', type: 'String' },
    { path: 'total', type: 'Number' },
    { path: 'lastUpdatedAt', type: 'Date' },
  ];
  const starters = [
    { id: 'last7d', label: 'Last 7 days' },
    { id: 'inList', label: 'One of a list' },
  ];
  const view = (r: ReturnType<typeof fieldStepList>) =>
    [...r.fields, ...r.starters].map((e) => [e.type === 'field' ? e.field.path : e.label, e.index, e.ranges]);

  it('lists the fields in sample order, then the starters, indexed as one list', () => {
    expect(view(fieldStepList(fields, starters, ''))).toEqual([
      ['status', 0, []],
      ['shipping.street', 1, []],
      ['total', 2, []],
      ['lastUpdatedAt', 3, []],
      ['Last 7 days', 4, []],
      ['One of a list', 5, []],
    ]);
  });

  it('filters both lists with the palette matcher, keeping each order', () => {
    const r = fieldStepList(fields, starters, 'st');
    expect(r.fields.map((e) => e.type)).toEqual(['field', 'field', 'field']);
    expect(r.starters.map((e) => e.type)).toEqual(['starter', 'starter']);
    expect(view(r)).toEqual([
      ['status', 0, [[0, 2]]],
      ['shipping.street', 1, [[9, 11]]],
      ['lastUpdatedAt', 2, [[2, 4]]],
      ['Last 7 days', 3, [[2, 4]]],
      ['One of a list', 4, [[11, 13]]],
    ]);
    expect(view(fieldStepList(fields, starters, 'zzz'))).toEqual([]);
  });

  it('lists the starters alone while the sample loads', () => {
    const r = fieldStepList(null, starters, '');
    expect(r.fields).toEqual([]);
    expect(view(r).map((e) => e[0])).toEqual(['Last 7 days', 'One of a list']);
  });

  it('names what Enter adds, and that esc goes back to the actions', () => {
    const [field] = fieldStepList(fields, starters, '').fields;
    const [starter] = fieldStepList(fields, starters, '').starters;
    expect(fieldStepHints(field)).toEqual({
      left: [
        { keys: '↵', label: 'Add "status" to the filter (nothing runs)' },
        { keys: 'esc', label: 'Back to actions' },
      ],
      right: [],
    });
    expect(fieldStepHints(starter).left[0]).toEqual({ keys: '↵', label: 'Add "Last 7 days" to the filter (nothing runs)' });
    expect(fieldStepHints(undefined)).toEqual({ left: [{ keys: 'esc', label: 'Back to actions' }], right: [] });
  });
});

describe('failureTitle', () => {
  const title = (kind: ObjectKind, t: string, verb = 'x') =>
    failureTitle(kind, { id: 'a', verb, title: t, perform: () => {} });

  it('names the kind after the verb of every action the palette registers', () => {
    expect(
      (
        [
          ['collection', 'Open', 'open'],
          ['collection', 'Open in new tab', 'open'],
          ['collection', 'Query…', 'query'],
          ['collection', 'Filter by field…', 'filter'],
          ['collection', 'Aggregate', 'aggregate'],
          ['collection', 'Schema', 'schema'],
          ['collection', 'Indexes', 'indexes'],
          ['collection', 'Export…', 'export'],
          ['collection', 'Import…', 'import'],
          ['collection', 'Rename…', 'rename'],
          ['collection', 'Drop collection…', 'delete'],
          ['database', 'Reveal in navigator', 'reveal'],
          ['database', 'Create collection…', 'create'],
          ['database', 'Drop database…', 'delete'],
          ['connection', 'Open', 'open'],
          ['connection', 'Edit', 'edit'],
          ['connection', 'Disconnect', 'disconnect'],
          ['connection', 'Delete…', 'delete'],
          ['tab', 'Switch to', 'open'],
          ['tab', 'Close', 'close'],
          ['tab', 'Unpin', 'pin'],
          ['saved', 'Open', 'open'],
          ['saved', 'Run', 'run'],
          ['saved', 'Rename…', 'rename'],
          ['saved', 'Delete…', 'delete'],
        ] as const
      ).map(([kind, t, verb]) => title(kind, t, verb)),
    ).toEqual([
      'Open collection',
      'Open in new tab',
      'Query collection…',
      'Filter collection by field…',
      'Aggregate collection',
      'Open collection schema',
      'Open collection indexes',
      'Export collection…',
      'Import collection…',
      'Rename collection…',
      'Drop collection…',
      'Reveal database in navigator',
      'Create collection…',
      'Drop database…',
      'Open connection',
      'Edit connection',
      'Disconnect connection',
      'Delete connection…',
      'Switch to tab',
      'Close tab',
      'Unpin tab',
      'Open saved query',
      'Run saved query',
      'Rename saved query…',
      'Delete saved query…',
    ]);
  });

  it('reads a kind word only as a whole word, in any case', () => {
    expect(title('collection', 'Tabulate')).toBe('Tabulate collection');
    expect(title('collection', 'Copy to TAB')).toBe('Copy to TAB');
    expect(title('tab', 'Go into')).toBe('Go tab into');
  });
});
