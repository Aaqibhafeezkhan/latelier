import { describe, expect, it } from 'vitest';
import { VERBS, VERB_KINDS, capitalize, parseVerb, verbLine } from '../../src/commands/verbs';
import { layoutPalette, footerHints, type RowEntry, type VerbEntry } from '../../src/commands/layout';
import { rankCapped } from '../../src/commands/rank';
import { objectRow } from '../../src/commands/registry';
import type { Command, ObjectAction, ObjectKind, PaletteContext } from '../../src/commands/types';

const ctx: PaletteContext = { pathname: '/workspace', connectionId: 'c1' };

const act = (id: string, verb: string, over: Partial<ObjectAction> = {}): ObjectAction => ({
  id,
  verb,
  title: id,
  perform: () => {},
  ...over,
});

const obj = (id: string, kind: ObjectKind, name: string, actions: ObjectAction[]): Command =>
  objectRow({ id, kind, name, subtitle: 'Production', actions });

const coll = (name: string) =>
  obj(`tab.open:c1:${name}`, 'collection', name, [
    act('Open', 'open'),
    act('Open in new tab', 'open', { alternate: true }),
    act('Export…', 'export'),
    act('Drop collection…', 'delete', { destructive: true }),
  ]);
const conn = (name: string) =>
  obj(`connection.open:${name}`, 'connection', name, [act('Open', 'open'), act('Delete…', 'delete', { destructive: true })]);
const command = (id: string, title: string): Command => ({ id, title, group: 'general', perform: () => {} });

const rows = (l: ReturnType<typeof layoutPalette>) => l.entries.filter((e): e is RowEntry => e.type === 'row');
const verbRows = (l: ReturnType<typeof layoutPalette>) => l.entries.filter((e): e is VerbEntry => e.type === 'verb');

describe('parseVerb', () => {
  it('reads a leading verb and the tokens after it', () => {
    expect(parseVerb('  Open  shop.or  x ')).toEqual({
      verb: 'open',
      typed: 'open',
      participle: 'opened',
      destructive: false,
      rest: ['shop.or', 'x'],
      trailing: false,
    });
  });

  it('reads an alias as its verb, and keeps the word typed', () => {
    expect(parseVerb('drop ord')).toEqual({
      verb: 'delete',
      typed: 'drop',
      participle: 'deleted',
      destructive: true,
      rest: ['ord'],
      trailing: false,
    });
    expect(parseVerb('go prod')?.verb).toBe('open');
    expect(parseVerb('unpin x')?.verb).toBe('pin');
  });

  it('reads a verb alone with no rest', () => {
    expect(parseVerb('open')?.rest).toEqual([]);
  });

  it('answers null when neither the first nor the last word is a verb', () => {
    expect(parseVerb('orders drop shop')).toBeNull();
    expect(parseVerb('opens')).toBeNull();
    expect(parseVerb('')).toBeNull();
  });

  it('reads a trailing verb or alias, the tokens before it as the rest', () => {
    expect(parseVerb(' Prod  Open ')).toEqual({
      verb: 'open',
      typed: 'open',
      participle: 'opened',
      destructive: false,
      rest: ['prod'],
      trailing: true,
    });
    expect(parseVerb('shop ord drop')).toEqual({
      verb: 'delete',
      typed: 'drop',
      participle: 'deleted',
      destructive: true,
      rest: ['shop', 'ord'],
      trailing: true,
    });
  });

  it('prefers a leading verb to a trailing one', () => {
    expect(parseVerb('open drop')).toMatchObject({ verb: 'open', typed: 'open', rest: ['drop'] });
  });

  it('never reads a single token as a trailing verb', () => {
    // A verb alone is leading, with nothing after it.
    expect(parseVerb('drop')).toMatchObject({ typed: 'drop', rest: [] });
  });

  it('knows every verb and alias of the table, each once', () => {
    const words = VERBS.flatMap((v) => [v.verb, ...v.aliases]);
    expect(new Set(words).size).toBe(words.length);
    for (const v of VERBS) {
      expect(parseVerb(v.verb)?.verb).toBe(v.verb);
      for (const a of v.aliases) expect(parseVerb(`${a} x`)?.verb).toBe(v.verb);
    }
    expect(VERBS.map((v) => v.verb)).toEqual([
      'open', 'edit', 'delete', 'close', 'rename', 'run', 'query', 'filter',
      'aggregate', 'schema', 'indexes', 'export', 'import', 'pin', 'disconnect',
    ]);
    expect(VERBS.filter((v) => parseVerb(v.verb)?.destructive).map((v) => v.verb)).toEqual(['delete']);
    expect(Object.fromEntries(VERBS.map((v) => [v.verb, [v.aliases.join(' '), parseVerb(v.verb)?.participle]]))).toEqual({
      open: ['go switch show', 'opened'],
      edit: ['modify', 'edited'],
      delete: ['remove drop', 'deleted'],
      close: ['', 'closed'],
      rename: ['', 'renamed'],
      run: ['execute', 'run'],
      query: ['find', 'queried'],
      filter: ['', 'filtered'],
      aggregate: ['pipeline', 'aggregated'],
      schema: ['structure', 'inspected'],
      indexes: ['index', 'indexed'],
      export: ['', 'exported'],
      import: ['', 'imported'],
      pin: ['unpin', 'pinned'],
      disconnect: ['', 'disconnected'],
    });
  });
});

describe('verbLine and capitalize', () => {
  it('names the alias it was read from, and only then', () => {
    const drop = verbLine(parseVerb('drop ord')!);
    expect(`${drop.before}${drop.verb}${drop.after}`).toBe(
      'Read as the verb delete (from “drop”): only things that can be deleted are listed',
    );
    expect(drop.verb).toBe('delete');
    const open = verbLine(parseVerb('open x')!);
    expect(`${open.before}${open.verb}${open.after}`).toBe(
      'Read as the verb open: only things that can be opened are listed',
    );
  });

  it('capitalizes the first letter only', () => {
    expect(capitalize('open')).toBe('Open');
    expect(capitalize('')).toBe('');
  });

  it('lists the kinds a verb alone offers, in order, with their destinations', () => {
    expect(VERB_KINDS.map((k) => [k.kind, k.noun, k.destination])).toEqual([
      ['collection', 'a collection', 'Collections scope ›'],
      ['connection', 'a connection', 'All, connections only ›'],
      ['tab', 'a tab', 'Tabs scope ›'],
      ['saved', 'a saved query', 'Saved scope ›'],
    ]);
  });
});

describe('a verb in the query', () => {
  const all = [coll('shop.orders'), coll('sales.order_items'), conn('Production'), command('drop.cmd', 'Drop caches')];

  it('lists the objects that have it, matched on what follows, with its action', () => {
    const l = layoutPalette(all, 'drop ord', ctx, [], 'all');
    expect(rows(l).map((e) => [e.id, e.row.action?.title])).toEqual([
      ['tab.open:c1:shop.orders', 'Drop collection…'],
      ['tab.open:c1:sales.order_items', 'Drop collection…'],
    ]);
    expect(rows(l)[0]!.aside).toEqual({ type: 'action', label: 'Drop collection…', destructive: true });
    // Ranges cover the name only, not the verb.
    expect(rows(l)[0]!.row.ranges).toEqual([[5, 8]]);
    expect(l.verb?.verb).toBe('delete');
  });

  it('hides an object without an action for the verb', () => {
    // `prod` names the Connection, and the collections through their subtitle:
    // only the collections can be exported.
    const l = layoutPalette(all, 'export prod', ctx, [], 'all');
    expect(rows(l).map((e) => e.kind)).toEqual(['collection', 'collection']);
    expect(layoutPalette(all, 'prod', ctx, [], 'all').entries.some((e) => e.kind === 'connection')).toBe(true);
    expect(layoutPalette(all, 'export shop', ctx, [], 'all').entries.map((e) => e.id)).toEqual([
      'tab.open:c1:shop.orders',
    ]);
  });

  it('reads a trailing verb as a leading one: `prod open` lists Production with Open', () => {
    for (const q of ['prod open', 'production open', 'open prod']) {
      const l = layoutPalette(all, q, ctx, [], 'all');
      const conns = rows(l).filter((e) => e.kind === 'connection');
      expect(conns.map((e) => [e.id, e.row.action?.title])).toEqual([['connection.open:Production', 'Open']]);
      expect(l.verb?.verb).toBe('open');
      expect(footerHints('all', true, conns[0]).left[0]).toEqual({ keys: '↵', label: 'Open' });
    }
  });

  it('lists `prod open` exactly as `open prod`', () => {
    const strip = (q: string) =>
      layoutPalette(all, q, ctx, [], 'all').entries.map((e) => [e.id, e.type === 'row' ? e.aside : null]);
    expect(strip('prod open')).toEqual(strip('open prod'));
  });

  it('keeps an object whose name ends in the trailing verb, matched on the whole query with its default', () => {
    const saved = obj('saved:1', 'saved', 'Orders pipeline', [act('Open', 'open'), act('Run', 'run')]);
    const l = layoutPalette([...all, saved], 'orders pipeline', ctx, [], 'all');
    const row = rows(l).find((e) => e.id === 'saved:1')!;
    expect(row.row.action).toBeUndefined();
    expect(row.aside).toBeNull();
    expect(row.row.ranges).toEqual([
      [0, 6],
      [7, 15],
    ]);
    // A trailing verb an object lacks still has to match its name: the Connection is hidden.
    expect(rows(layoutPalette(all, 'prod export', ctx, [], 'all')).map((e) => e.kind)).toEqual([
      'collection',
      'collection',
    ]);
  });

  it('hides an object without the action under a leading verb, whatever its name', () => {
    const saved = obj('saved:1', 'saved', 'Export orders', [act('Open', 'open')]);
    expect(rows(layoutPalette([saved], 'export orders', ctx, [], 'all'))).toEqual([]);
  });

  it('still lists a command matching the whole query, the verb last', () => {
    const l = layoutPalette([...all, command('caches.drop', 'Caches drop')], 'caches drop', ctx, [], 'all');
    expect(rows(l).map((e) => e.id)).toEqual(['drop.cmd', 'caches.drop']);
  });

  it('still lists a command matching the whole query', () => {
    const l = layoutPalette(all, 'drop caches', ctx, [], 'all');
    expect(rows(l).map((e) => e.id)).toEqual(['drop.cmd']);
    expect(rows(l)[0]!.row.action).toBeUndefined();
  });

  it('names the action in the footer, the destructive one with its dialog', () => {
    const l = layoutPalette(all, 'drop ord', ctx, [], 'all');
    expect(footerHints('all', true, l.entries[0]).left).toEqual([
      { keys: '↵', label: 'Drop collection… (opens its confirm dialog)' },
      { keys: '⌥↵', label: 'All actions' },
    ]);
    const e = layoutPalette(all, 'export shop', ctx, [], 'all');
    expect(footerHints('all', true, e.entries[0]).left[0]).toEqual({ keys: '↵', label: 'Export…' });
    expect(rows(e)[0]!.aside).toEqual({ type: 'action', label: 'Export…', destructive: false });
  });

  it('reads the disabled reason of the verb’s action, not the default’s', () => {
    const view = obj('v', 'collection', 'shop.view', [
      act('Open', 'open'),
      act('Export…', 'export', { disabledReason: () => 'nope' }),
    ]);
    expect(rows(layoutPalette([view], 'export view', ctx, [], 'all'))[0]!.disabled).toBe('nope');
    expect(rows(layoutPalette([view], 'view', ctx, [], 'all'))[0]!.disabled).toBeNull();
  });

  it('lists every object with the verb when nothing follows it, in a single scope', () => {
    const l = layoutPalette(all, 'open', ctx, [], 'collections');
    expect(rows(l).map((e) => e.id)).toEqual(['tab.open:c1:shop.orders', 'tab.open:c1:sales.order_items']);
    // No name follows the verb, so there is no verb line.
    expect(l.verb).toBeNull();
  });

  it('ranks under a verb through rankCapped as well', () => {
    const r = rankCapped(all, 'drop ord', ctx, [], 5, (k) => k, { verb: 'delete', rest: ['ord'] });
    expect(r.buckets.map((b) => [b.key, b.total])).toEqual([['collection', 2]]);
  });
});

describe('a verb alone', () => {
  const all = [
    coll('shop.orders'),
    coll('shop.openings'),
    conn('Production'),
    command('open.settings', 'Open settings'),
    command('x', 'Export all'),
  ];

  it('lists a row per kind that has the verb, then the commands it matches', () => {
    const l = layoutPalette(all, 'open', ctx, [], 'all');
    expect(l.groups.map((g) => [g.key, g.label])).toEqual([
      ['verb', 'Open…'],
      ['action', 'Actions'],
    ]);
    expect(l.entries.map((e) => e.id)).toEqual(['verb:collection', 'verb:connection', 'open.settings']);
    expect(verbRows(l).map((e) => [e.title, e.destination, e.target, e.index])).toEqual([
      ['Open a collection…', 'Collections scope ›', 'collections', 0],
      ['Open a connection…', 'All, connections only ›', 'connections', 1],
    ]);
    expect(verbRows(l)[0]!.ranges).toEqual([[0, 4]]);
    expect(rows(l).map((e) => [e.id, e.index])).toEqual([['open.settings', 2]]);
    expect(l.verb).toBeNull();
    // `shop.openings` matches the word as a name: counted, not listed.
    expect(l.counts?.collections).toBe(1);
  });

  it('gives no row to a kind whose objects lack the verb', () => {
    const l = layoutPalette(all, 'export', ctx, [], 'all');
    expect(verbRows(l).map((e) => e.kind)).toEqual(['collection']);
    expect(l.groups[0]!.label).toBe('Export…');
    expect(layoutPalette([command('x', 'Export all')], 'export', ctx, [], 'all').groups.map((g) => g.label)).toEqual([
      'Actions',
    ]);
  });

  it('does not highlight the title for an alias', () => {
    const l = layoutPalette(all, 'go', ctx, [], 'all');
    expect(verbRows(l)[0]!.title).toBe('Open a collection…');
    expect(verbRows(l)[0]!.ranges).toEqual([]);
    expect(verbRows(l)[0]!.typed).toBe('go');
  });

  it('caps the commands and offers the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => command(`o${i}`, `Open thing ${i}`));
    const l = layoutPalette(many, 'open', ctx, [], 'all');
    expect(l.entries.map((e) => e.id).slice(-1)).toEqual(['more:action']);
    expect(rows(l)).toHaveLength(5);
  });

  it('switches scope from the footer, and suggests a name to keep typing', () => {
    const l = layoutPalette(all, 'go', ctx, [], 'all');
    expect(footerHints('all', true, l.entries[0]).left).toEqual([
      { keys: '↵', label: 'Switch scope' },
      { keys: '', label: 'Keep typing a name:', strong: 'go shop.or' },
    ]);
  });

  it('builds the name to keep typing from the first collection with the verb', () => {
    const noExport = obj('tab.open:c1:aa.zz', 'collection', 'aa.zz', [act('Open', 'open')]);
    const l = layoutPalette([noExport, coll('sales.order_items'), coll('shop.orders')], 'export', ctx, [], 'all');
    expect(verbRows(l)[0]!.example).toBe('sales.or');
    expect(footerHints('all', true, l.entries[0]).left[1]).toEqual({
      keys: '',
      label: 'Keep typing a name:',
      strong: 'export sales.or',
    });
    const bare = layoutPalette([coll('logs')], 'open', ctx, [], 'all');
    expect(verbRows(bare)[0]!.example).toBe('lo');
  });

  it('names no collection when none has the verb', () => {
    const l = layoutPalette([conn('Production')], 'open', ctx, [], 'all');
    expect(verbRows(l)[0]!.example).toBeNull();
    expect(footerHints('all', true, l.entries[0]).left[1]).toEqual({
      keys: '',
      label: 'Keep typing a name after',
      strong: 'open',
    });
  });
});

describe('Connections only', () => {
  const all = [
    // Shorter than any Connection's name, so it would rank first if let through.
    coll('a.b'),
    ...Array.from({ length: 7 }, (_, i) => conn(`Prod${i}`)),
    command('open.settings', 'Open settings'),
  ];

  it('lists Connection objects only, in one list past the five-row cap', () => {
    const l = layoutPalette(all, 'open', ctx, [], 'all', true);
    expect(l.groups.map((g) => g.label)).toEqual([null]);
    expect(rows(l).map((e) => e.kind)).toEqual(Array(7).fill('connection'));
    expect(l.verb).toBeNull();
    expect(layoutPalette(all, 'open prod', ctx, [], 'all', true).verb?.verb).toBe('open');
    // Connections have no scope: they count in none.
    expect(l.counts).toEqual({ collections: 1, actions: 1, saved: 0, tabs: 0 });
  });

  it('applies in All only', () => {
    const l = layoutPalette(all, 'open', ctx, [], 'collections', true);
    expect(rows(l).map((e) => e.kind)).toEqual(['collection']);
  });

  it('narrows a typed name too', () => {
    const l = layoutPalette(all, 'prod3', ctx, [], 'all', true);
    expect(rows(l).map((e) => e.id)).toEqual(['connection.open:Prod3']);
  });
});
