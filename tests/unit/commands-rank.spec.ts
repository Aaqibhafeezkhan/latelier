import { describe, expect, it, vi } from 'vitest';
import { rankCommands, rankCapped, groupRows, displayText, RECENT_LABEL, QUERY_ROW_LABEL } from '../../src/commands/rank';
import { objectRow } from '../../src/commands/registry';
import { parseVerb } from '../../src/commands/verbs';
import { parsePastedObjectId } from '../../src/commands/pastedId';
import type { Command, PaletteContext } from '../../src/commands/types';

const ctx: PaletteContext = { pathname: '/connections', connectionId: null };

const make = (overrides: Partial<Command>): Command => ({
  id: overrides.id ?? 'x',
  title: overrides.title ?? 'Untitled',
  group: overrides.group ?? 'general',
  perform: () => {},
  ...overrides,
});

describe('rankCommands', () => {
  it('hides commands whose when() returns false', () => {
    const all = [
      make({ id: 'a', title: 'Alpha' }),
      make({ id: 'b', title: 'Beta', when: () => false }),
    ];
    const ranked = rankCommands(all, '', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['a']);
  });

  it('treats a throwing when() as false and warns once (dev)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const all = [
      make({
        id: 'broken',
        title: 'Broken',
        when: () => {
          throw new Error('boom');
        },
      }),
      make({ id: 'ok', title: 'OK' }),
    ];
    const ranked = rankCommands(all, '', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledWith('[commandRegistry] when() threw for "broken":', expect.any(Error));
    warn.mockRestore();
  });

  it('treats a throwing when() as false without warning in a production build', () => {
    vi.stubEnv('DEV', false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broken = make({
        id: 'broken',
        title: 'Broken',
        when: () => {
          throw new Error('boom');
        },
      });
      expect(rankCommands([broken], '', ctx, [])).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('trims and lowercases the query before matching', () => {
    const all = [make({ id: 'a', title: 'Save Query' })];
    const ranked = rankCommands(all, '  SAVE  ', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['a']);
  });

  it('with empty query: surfaces recents first then registration order', () => {
    const all = [
      make({ id: 'a', title: 'Alpha' }),
      make({ id: 'b', title: 'Beta' }),
      make({ id: 'c', title: 'Gamma' }),
    ];
    const ranked = rankCommands(all, '', ctx, ['c']);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['c', 'a', 'b']);
    expect(ranked.map((r) => r.recent)).toEqual([true, false, false]);
  });

  it('with empty query: ignores a stale recent id that is not visible', () => {
    const all = [make({ id: 'a', title: 'Alpha' })];
    // 'ghost' is a recent id from a command that no longer exists (or is
    // hidden by when()) — it must not produce a row with an undefined cmd.
    const ranked = rankCommands(all, '', ctx, ['ghost', 'a']);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.cmd.id).toBe('a');
    expect(ranked[0]!.recent).toBe(true);
  });

  it('ranks word starts above substrings above keywords', () => {
    const all = [
      make({ id: 'kw', title: 'Unrelated', keywords: ['save'] }),
      make({ id: 'sub', title: 'Re-save query' }),
      make({ id: 'pref', title: 'Save query' }),
    ];
    const ranked = rankCommands(all, 'sav', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['pref', 'sub', 'kw']);
  });


  it('matches subtitle and keywords case-insensitively', () => {
    const all = [
      make({ id: 'a', title: 'Foo', subtitle: 'has BAR inside' }),
      make({ id: 'b', title: 'Baz', keywords: ['Bar'] }),
    ];
    const ranked = rankCommands(all, 'bar', ctx, []);
    expect(ranked.map((r) => r.cmd.id).sort()).toEqual(['a', 'b']);
  });

  it('excludes a command that matches nothing, instead of ranking it anyway', () => {
    const all = [make({ id: 'a', title: 'Alpha', subtitle: 'first letter', keywords: ['abc'] })];
    const ranked = rankCommands(all, 'zzz', ctx, []);
    expect(ranked).toEqual([]);
  });

  it('does not read a keyword match out of a defaulted, blank subtitle', () => {
    // A command with no subtitle falls back to '' — querying for a
    // substring of the mutation-testing sentinel text catches a wrong
    // non-empty default, since '' never contains any non-empty substring.
    const all = [make({ id: 'a', title: 'Alpha', keywords: ['abc'] })];
    const ranked = rankCommands(all, 'here', ctx, []);
    expect(ranked).toEqual([]);
  });

  it('does not read a keyword match out of a defaulted, empty keyword list', () => {
    const all = [make({ id: 'a', title: 'Alpha', subtitle: 'first letter' })];
    const ranked = rankCommands(all, 'here', ctx, []);
    expect(ranked).toEqual([]);
  });

  it('joins multiple keywords with a space, not concatenated', () => {
    // 'foo bar' does not contain 'oobar' as a substring — it would if the
    // keywords were joined without a separator ('foobar').
    const all = [make({ id: 'a', title: 'Alpha', keywords: ['foo', 'bar'] })];
    const ranked = rankCommands(all, 'oobar', ctx, []);
    expect(ranked).toEqual([]);
  });
});

describe('groupRows', () => {
  it('renders a Recent header before group headers', () => {
    const ranked = rankCommands(
      [
        make({ id: 'a', title: 'Alpha', group: 'general' }),
        make({ id: 'b', title: 'Beta', group: 'workspace' }),
      ],
      '',
      ctx,
      ['b'],
    );
    const grouped = groupRows(ranked);
    expect(grouped.map((g) => g.key)).toEqual(['recent', 'general']);
    expect(grouped[0]!.rows.map((r) => r.cmd.id)).toEqual(['b']);
    expect(grouped[1]!.rows.map((r) => r.cmd.id)).toEqual(['a']);
  });

  it('does not duplicate a recent command into its own group', () => {
    const ranked = rankCommands(
      [make({ id: 'a', title: 'Alpha', group: 'workspace' })],
      '',
      ctx,
      ['a'],
    );
    const grouped = groupRows(ranked);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.key).toBe('recent');
  });

  it('labels the recent header "Recent"', () => {
    const ranked = rankCommands([make({ id: 'a', title: 'Alpha' })], '', ctx, ['a']);
    const grouped = groupRows(ranked);
    expect(grouped[0]!.label).toBe('Recent');
    expect(RECENT_LABEL).toBe('Recent');
  });

  it('keeps multiple commands in the same group together, not overwritten', () => {
    const ranked = rankCommands(
      [
        make({ id: 'a', title: 'Alpha', group: 'workspace' }),
        make({ id: 'b', title: 'Beta', group: 'workspace' }),
      ],
      '',
      ctx,
      [],
    );
    const grouped = groupRows(ranked);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.rows.map((r) => r.cmd.id)).toEqual(['a', 'b']);
  });

  it('lists the groups the tab in front owns first on an empty query', () => {
    const groups = [
      'general',
      'navigation',
      'connection',
      'workspace',
      'aggregation',
      'references',
      'view',
      'query',
    ] as const;
    const ranked = rankCommands(
      groups.map((g) => make({ id: g, title: `${g} thing`, group: g })),
      '',
      ctx,
      [],
    );
    expect(groupRows(ranked).map((g) => g.key)).toEqual([
      'query',
      'view',
      'references',
      'aggregation',
      'workspace',
      'connection',
      'navigation',
      'general',
    ]);
  });

  it('numbers rows in the order they are drawn, not the order they ranked', () => {
    const ranked = rankCommands(
      [
        make({ id: 'qry-a', title: 'Run query a', group: 'query' }),
        make({ id: 'gen', title: 'Run', group: 'general' }),
        make({ id: 'qry-b', title: 'Run query b', group: 'query' }),
      ],
      'run',
      ctx,
      [],
    );
    const rows = groupRows(ranked).flatMap((g) => g.rows);
    expect(rows.map((r) => [r.cmd.id, r.index])).toEqual([
      ['gen', 0],
      ['qry-a', 1],
      ['qry-b', 2],
    ]);
  });

  it('orders the groups by their best row on a typed query, so the first row drawn is the best match', () => {
    // `rest` is a subsequence of the view row and exact for the collection.
    const ranked = rankCommands(
      [
        make({ id: 'view', title: 'Show results as Tree', group: 'view' }),
        make({ id: 'coll', title: 'Open: api.rest', matchText: 'api.rest', group: 'workspace' }),
      ],
      'rest',
      ctx,
      [],
    );
    expect(ranked.map((r) => r.cmd.id)).toEqual(['coll', 'view']);
    const grouped = groupRows(ranked);
    expect(grouped.map((g) => g.key)).toEqual(['workspace', 'view']);
    expect(grouped[0]!.rows[0]!.index).toBe(0);
  });

  it('draws a recent query-group subsequence match below a workspace word-start match', () => {
    // Recent, but a subsequence: it stays below the word start in the workspace group.
    const stronger = rankCommands(
      [
        make({ id: 'q', title: 'Sxxxrxxxpxxx', group: 'query' }),
        make({ id: 'w', title: 'Open: srp.tools', matchText: 'srp.tools', group: 'workspace' }),
      ],
      'srp',
      ctx,
      ['q'],
    );
    expect(stronger.map((r) => r.cmd.id)).toEqual(['w', 'q']);
    expect(groupRows(stronger).map((g) => g.key)).toEqual(['workspace', 'query']);
  });

  it('keeps the fixed group order for an empty query', () => {
    const ranked = rankCommands(
      [
        make({ id: 'g', title: 'A', group: 'general' }),
        make({ id: 'q', title: 'B', group: 'query' }),
      ],
      '',
      ctx,
      [],
    );
    expect(groupRows(ranked).map((g) => g.key)).toEqual(['query', 'general']);
  });

  it('keeps a recent row in its own group on a typed query, where recency is only a tie-break', () => {
    const ranked = rankCommands([make({ id: 'a', title: 'Alpha', group: 'workspace' })], 'alp', ctx, ['a']);
    const grouped = groupRows(ranked);
    expect(grouped.map((g) => g.key)).toEqual(['workspace']);
    expect(grouped[0]!.rows[0]!.row.recent).toBe(true);
  });

  it('puts a row built from the query first, under its own label', () => {
    const ranked = rankCommands(
      [
        make({ id: 'a', title: 'Alpha', group: 'general' }),
        make({ id: 'q', title: 'Find', group: 'query', forQuery: () => rowFor('Found') }),
      ],
      'alpha',
      ctx,
      [],
    );
    const grouped = groupRows(ranked);
    expect(grouped[0]!.key).toBe('pasted');
    expect(grouped[0]!.label).toBe(QUERY_ROW_LABEL);
    expect(QUERY_ROW_LABEL).toBe('In the tab in front');
    expect(grouped[0]!.rows[0]!.index).toBe(0);
    expect(grouped[1]!.rows[0]!.index).toBe(1);
  });
});

const rowFor = (title: string) => ({ title, subtitle: 'sub', emphasis: 'x', perform: () => {} });

const ids = (rows: { cmd: Command }[]) => rows.map((r) => r.cmd.id);
const rank = (all: Command[], q: string, recent: string[] = []) => ids(rankCommands(all, q, ctx, recent));

describe('rankCommands — tokens', () => {
  it('matches every token, in any order', () => {
    const all = [
      make({ id: 'a', title: 'Run query', subtitle: 'Production' }),
      make({ id: 'b', title: 'Run script', subtitle: 'Staging' }),
    ];
    expect(rank(all, 'prod run')).toEqual(['a']);
    expect(rank(all, 'run prod')).toEqual(['a']);
    expect(rank(all, 'run  r')).toEqual(['a', 'b']);
  });

  it('lists a Connection object for its verb typed before or after its name', () => {
    const conn = (name: string) =>
      objectRow({
        id: `connection.open:${name}`,
        kind: 'connection',
        name,
        actions: [
          { id: 'open', verb: 'open', title: 'Open', perform: () => {} },
          { id: 'edit', verb: 'edit', title: 'Edit', perform: () => {} },
        ],
      });
    const all = [conn('Production'), conn('Staging')];
    for (const q of ['prod open', 'open prod', 'production open']) {
      const verb = parseVerb(q)!;
      const r = rankCapped(all, q, ctx, [], 5, (k) => k, { verb: verb.verb, rest: verb.rest });
      const rows = r.buckets.flatMap((b) => b.rows);
      expect(rows.map((row) => [row.cmd.id, row.action?.title])).toEqual([['connection.open:Production', 'Open']]);
    }
  });

  it('finds shop.orders from "orders shop"', () => {
    const all = [make({ id: 'a', title: 'Open: shop.orders', matchText: 'shop.orders' })];
    expect(rank(all, 'orders shop')).toEqual(['a']);
  });

  it('drops a row when any one token misses', () => {
    const all = [make({ id: 'a', title: 'Open connection → Production' })];
    expect(rank(all, 'open zzz')).toEqual([]);
  });

  it('tries each token against the subtitle and keywords too', () => {
    const all = [make({ id: 'a', title: 'Open connection', subtitle: 'db.example.com', keywords: ['mongo'] })];
    expect(rank(all, 'open example mongo')).toEqual(['a']);
  });
});

describe('rankCommands — match classes', () => {
  const cls = (title: string, q: string, extra: Partial<Command> = {}) =>
    rankCommands([make({ id: 'a', title, ...extra })], q, ctx, [])[0]?.cls;

  it('exact: the token is the whole match text', () => {
    expect(cls('Orders', 'orders')).toBe('exact');
  });

  it('exact: the token is one whole word of the match text', () => {
    expect(cls('shop.orders', 'orders')).toBe('exact');
    expect(cls('shop.orders', 'shop')).toBe('exact');
  });

  it('exact: a token spanning a separator equals the whole text', () => {
    expect(cls('shop.orders', 'shop.orders')).toBe('exact');
  });

  it('word start: the token is a prefix of a word', () => {
    expect(cls('shop.orders', 'ord')).toBe('wordStart');
    expect(cls('Run query', 'qu')).toBe('wordStart');
  });

  it('initials: the first letters of consecutive words', () => {
    expect(cls('shop.orders', 'so')).toBe('initials');
    expect(cls('Run query', 'rq')).toBe('initials');
    expect(cls('a.b.c.d', 'bcd')).toBe('initials');
  });

  it('initials: needs consecutive words, and two characters at least', () => {
    expect(cls('a.b.c.d', 'acd')).not.toBe('initials');
    expect(cls('shop.orders', 's')).toBe('wordStart');
  });

  it('initials: the token must not outrun the words', () => {
    expect(cls('shop.orders', 'soo')).not.toBe('initials');
  });

  it('substring: the token sits inside a word', () => {
    expect(cls('reorders', 'order')).toBe('substring');
    expect(cls('shop.reorders', 'order')).toBe('substring');
  });

  it('keyword: the token is in the subtitle or a keyword', () => {
    expect(cls('Alpha', 'prod', { subtitle: 'Production' })).toBe('keyword');
    expect(cls('Alpha', 'sync', { keywords: ['sync'] })).toBe('keyword');
  });

  it('subsequence: the characters appear in order', () => {
    expect(cls('shop.orders', 'sods')).toBe('subsequence');
    expect(cls('shop.orders', 'sdro')).toBeUndefined();
  });

  it('subsequence: never reached by a one-character token', () => {
    expect(cls('alpha', 'z')).toBeUndefined();
  });

  it('subsequence: repeated letters each need their own character', () => {
    expect(cls('ab', 'aab')).toBeUndefined();
    expect(cls('a.xa.b', 'aab')).toBe('subsequence');
  });

  it('does no edit-distance matching', () => {
    expect(cls('orders', 'oders')).toBe('subsequence');
    expect(cls('orders', 'ordres')).toBeUndefined();
  });

  it('takes the weakest class among the tokens', () => {
    expect(cls('shop.orders', 'orders shop')).toBe('exact');
    expect(cls('shop.orders', 'orders ho')).toBe('substring');
    expect(cls('shop.orders', 'ho orders')).toBe('substring');
  });

  it('orders the classes strongest first', () => {
    const all = [
      make({ id: 'kw', title: 'zzz', keywords: ['orders'] }),
      make({ id: 'sub', title: 'xreorders' }),
      make({ id: 'ws', title: 'orders_archive' }),
      make({ id: 'ex', title: 'orders' }),
    ];
    expect(rank(all, 'orders')).toEqual(['ex', 'ws', 'sub', 'kw']);
  });

  it('ranks a subsequence below a keyword', () => {
    const all = [
      make({ id: 'sq', title: 'o.r.d.e.r.s' }),
      make({ id: 'kw', title: 'zzz', keywords: ['ordrs'] }),
    ];
    expect(rank(all, 'ordrs')).toEqual(['kw', 'sq']);
  });

  it('ranks exact orders above orders_archive above reorders', () => {
    const all = [
      make({ id: 'reorders', title: 'reorders' }),
      make({ id: 'archive', title: 'orders_archive' }),
      make({ id: 'orders', title: 'orders' }),
    ];
    expect(rank(all, 'orders')).toEqual(['orders', 'archive', 'reorders']);
  });

  it('treats a segment, not a word, as exact: orders_archive is a word start for orders', () => {
    const all = [
      make({ id: 'archive', title: 'Open: shop.orders_archive', matchText: 'shop.orders_archive' }),
      make({ id: 'exact', title: 'Open: shop.orders', matchText: 'shop.orders' }),
    ];
    const rows = rankCommands(all, 'orders', ctx, []);
    expect(rows.map((r) => [r.cmd.id, r.cls])).toEqual([
      ['exact', 'exact'],
      ['archive', 'wordStart'],
    ]);
  });

  it('keeps exact above word start when orders_archive is in the MRU', () => {
    const all = [
      make({ id: 'archive', title: 'Open: shop.orders_archive', matchText: 'shop.orders_archive' }),
      make({ id: 'exact', title: 'Open: shop.orders', matchText: 'shop.orders' }),
    ];
    expect(rank(all, 'orders', ['archive'])).toEqual(['exact', 'archive']);
  });

  it('keeps exact above word start when the exact match has the longer database name', () => {
    const all = [
      make({ id: 'archive', title: 'Open: db.orders_archive', matchText: 'db.orders_archive' }),
      make({ id: 'exact', title: 'Open: warehouse_eu.orders', matchText: 'warehouse_eu.orders' }),
    ];
    expect(rank(all, 'orders')).toEqual(['exact', 'archive']);
    expect(rank(all, 'orders', ['archive'])).toEqual(['exact', 'archive']);
  });

  it('does not end a segment at - or a case change', () => {
    expect(rankCommands([make({ id: 'a', title: 'shop.orders-old' })], 'orders', ctx, [])[0]!.cls).toBe('wordStart');
    expect(rankCommands([make({ id: 'a', title: 'shop.ordersOld' })], 'orders', ctx, [])[0]!.cls).toBe('wordStart');
    expect(rankCommands([make({ id: 'a', title: 'shop:orders/x' })], 'orders', ctx, [])[0]!.cls).toBe('exact');
  });

  it('ranks a word-start match above an initials match above a substring', () => {
    const all = [
      make({ id: 'sub', title: 'ahsox' }),
      make({ id: 'ini', title: 'shop.orders' }),
      make({ id: 'ws', title: 'reports.sorted' }),
    ];
    expect(rank(all, 'so')).toEqual(['ws', 'ini', 'sub']);
  });
});

describe('rankCommands — word starts', () => {
  const cls = (title: string, q: string) => rankCommands([make({ id: 'a', title })], q, ctx, [])[0]?.cls;

  it.each([' ', '.', '_', '-', ':', '/', '→'])('a word starts after %j', (sep) => {
    expect(cls(`shop${sep}orders`, 'ord')).toBe('wordStart');
  });

  it('a word starts at a lower-to-upper case change', () => {
    expect(cls('orderItems', 'items')).toBe('wordStart');
    expect(cls('orderItems', 'ite')).toBe('wordStart');
    expect(cls('orderItems', 'oi')).toBe('initials');
  });

  it('a capital after a capital starts no word', () => {
    expect(cls('ORDERS', 'ders')).toBe('substring');
  });

  it('a separator itself starts no word', () => {
    expect(cls('a..b', '.b')).toBe('substring');
  });

  it('a digit after a letter starts no word', () => {
    expect(cls('a1b', '1b')).toBe('substring');
  });

  it('a word at the very start counts', () => {
    expect(cls('Orders list', 'ord')).toBe('wordStart');
  });

  it('a leading separator does not hide the first word', () => {
    expect(cls('_id', 'id')).toBe('wordStart');
  });
});

describe('rankCommands — matchText', () => {
  it('reads the match text instead of the title for every title match', () => {
    const all = [
      make({ id: 'a', title: 'Open: shop.orders', matchText: 'shop.orders' }),
      make({ id: 'b', title: 'Open: crm.leads', matchText: 'crm.leads' }),
    ];
    expect(rank(all, 'open')).toEqual([]);
    expect(rank(all, 'new')).toEqual([]);
    expect(rank([make({ id: 'c', title: 'Open in new tab: shop.orders', matchText: 'shop.orders' })], 'tab')).toEqual([]);
    expect(rank(all, 'orders')).toEqual(['a']);
    expect(rank(all, 'opn')).toEqual([]);
  });

  it('still reads the subtitle and keywords', () => {
    const all = [make({ id: 'a', title: 'Open: shop.orders', matchText: 'shop.orders', subtitle: 'Production' })];
    expect(rank(all, 'prod')).toEqual(['a']);
  });

  it('lowercases the match text before matching', () => {
    const all = [make({ id: 'a', title: 'Open: Shop.Orders', matchText: 'Shop.Orders' })];
    expect(rank(all, 'so')).toEqual(['a']);
  });

  it('is the text a row displays', () => {
    expect(displayText(make({ title: 'Open: a.b', matchText: 'a.b' }))).toBe('a.b');
    expect(displayText(make({ title: 'Run query' }))).toBe('Run query');
  });

  it('keeps ranges valid for a character whose lower case is longer', () => {
    // 'İ'.toLowerCase() is two code units long.
    const [row] = rankCommands([make({ id: 'a', title: 'İstanbul.orders' })], 'orders', ctx, []);
    expect(row!.ranges).toEqual([[9, 15]]);
    expect(displayText(row!.cmd).slice(9, 15)).toBe('orders');
  });
});

describe('rankCommands — recency and tie-breaks', () => {
  it('lets a recent row rank first inside its class', () => {
    const all = [make({ id: 'a', title: 'Save a' }), make({ id: 'b', title: 'Save b' })];
    expect(rank(all, 'save', ['b'])).toEqual(['b', 'a']);
  });

  it('orders recent rows by their position in the MRU', () => {
    const all = [
      make({ id: 'a', title: 'Save a' }),
      make({ id: 'b', title: 'Save b' }),
      make({ id: 'c', title: 'Save c' }),
    ];
    expect(rank(all, 'save', ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('never lets recency outrank a stronger class', () => {
    const all = [
      make({ id: 'sub', title: 'resave' }),
      make({ id: 'sq', title: 'sxxaxxvxx' }),
      make({ id: 'ws', title: 'save' }),
    ];
    expect(rank(all, 'sav', ['sq', 'sub'])).toEqual(['ws', 'sub', 'sq']);
  });

  it('keeps a recent subsequence match below a word-start match', () => {
    const all = [make({ id: 'sq', title: 'sxaxve', keywords: [] }), make({ id: 'ws', title: 'save it' })];
    expect(rank(all, 'sav', ['sq'])).toEqual(['ws', 'sq']);
    const both = [make({ id: 'sq', title: 'sxxaxxvxxe' }), make({ id: 'ws', title: 'save it' })];
    expect(rank(both, 'save', ['sq'])).toEqual(['ws', 'sq']);
  });

  it('prefers the shorter match text inside a class and recency', () => {
    const all = [
      make({ id: 'long', title: 'save the whole thing' }),
      make({ id: 'short', title: 'save it' }),
    ];
    expect(rank(all, 'save')).toEqual(['short', 'long']);
  });

  it('falls back to registration order', () => {
    const all = [make({ id: 'b', title: 'save b' }), make({ id: 'a', title: 'save a' })];
    expect(rank(all, 'save')).toEqual(['b', 'a']);
  });

  it('marks a row recent whatever its rank', () => {
    const all = [make({ id: 'a', title: 'save a' }), make({ id: 'b', title: 'save b' })];
    const rows = rankCommands(all, 'save', ctx, ['b']);
    expect(rows.map((r) => r.recent)).toEqual([true, false]);
  });

  it('counts a stale recent id for nothing', () => {
    const all = [make({ id: 'a', title: 'save a' })];
    expect(rank(all, 'save', ['ghost'])).toEqual(['a']);
  });

  it('keeps the first position when an id repeats in the MRU', () => {
    const all = [
      make({ id: 'a', title: 'save a' }),
      make({ id: 'b', title: 'save b' }),
      make({ id: 'c', title: 'save c' }),
    ];
    expect(rank(all, 'save', ['c', 'b', 'c'])).toEqual(['c', 'b', 'a']);
  });

  it('still ranks a recent row first past the last MRU slot the key can hold', () => {
    const all = [make({ id: 'x', title: 'save x' }), make({ id: 'a', title: 'save a' })];
    const mru = Array.from({ length: 20 }, (_, i) => `r${i}`);
    expect(rank(all, 'save', [...mru, 'a'])).toEqual(['a', 'x']);
  });
});

describe('rankCommands — highlight ranges', () => {
  const ranges = (title: string, q: string, extra: Partial<Command> = {}) =>
    rankCommands([make({ id: 'a', title, ...extra })], q, ctx, [])[0]?.ranges;

  it('marks an exact word', () => {
    expect(ranges('shop.orders', 'orders')).toEqual([[5, 11]]);
  });

  it('marks the whole text for an exact match of it', () => {
    expect(ranges('shop.orders', 'shop.orders')).toEqual([[0, 11]]);
  });

  it('marks the prefix of a word', () => {
    expect(ranges('shop.orders', 'ord')).toEqual([[5, 8]]);
  });

  it('marks the first letter of each word for initials', () => {
    expect(ranges('shop.orders', 'so')).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });

  it('marks a substring', () => {
    expect(ranges('reorders', 'order')).toEqual([[2, 7]]);
  });

  it('marks each character of a subsequence, and merges the neighbours', () => {
    expect(ranges('shop.orders', 'sods')).toEqual([
      [0, 1],
      [2, 3],
      [7, 8],
      [10, 11],
    ]);
    expect(ranges('abcdef', 'abdf')).toEqual([
      [0, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('marks the first word-start occurrence, not an earlier mid-word one', () => {
    expect(ranges('xorders orders', 'ord')).toEqual([[8, 11]]);
  });

  it('marks nothing for a keyword match, whose text is not displayed', () => {
    expect(ranges('Alpha', 'prod', { subtitle: 'Production' })).toEqual([]);
  });

  it('unions the ranges of several tokens, sorted and merged', () => {
    expect(ranges('shop.orders', 'orders shop')).toEqual([
      [0, 4],
      [5, 11],
    ]);
    expect(ranges('shop.orders', 'sho hop')).toEqual([[0, 4]]);
    expect(ranges('abcdef', 'cd ab')).toEqual([[0, 4]]);
    expect(ranges('abcdef', 'ab ef')).toEqual([
      [0, 2],
      [4, 6],
    ]);
  });

  it('merges a range nested inside another', () => {
    expect(ranges('abcdef', 'abcdef bc')).toEqual([[0, 6]]);
  });

  it('is empty on an empty query', () => {
    expect(ranges('shop.orders', '')).toEqual([]);
  });

  it('refers to the match text when one is set', () => {
    expect(ranges('Open: shop.orders', 'orders', { matchText: 'shop.orders' })).toEqual([[5, 11]]);
  });
});

describe('rankCommands — subtitle ranges', () => {
  const sub = (title: string, q: string, extra: Partial<Command> = {}) =>
    rankCommands([make({ id: 'a', title, ...extra })], q, ctx, [])[0]?.subtitleRanges;

  it('marks a token matched through the subtitle, in the subtitle', () => {
    expect(sub('Alpha', 'duct', { subtitle: 'Production' })).toEqual([[3, 7]]);
    expect(sub('Alpha', 'prod', { subtitle: 'Production' })).toEqual([[0, 4]]);
  });

  it('marks only the tokens the title missed, merged', () => {
    expect(sub('Alpha', 'alp pro rod', { subtitle: 'Production' })).toEqual([[0, 4]]);
    expect(sub('Alpha', 'alp', { subtitle: 'alpine' })).toEqual([]);
  });

  it('marks nothing for a hidden keyword, nor without a subtitle', () => {
    expect(sub('Alpha', 'mongo', { subtitle: 'Production', keywords: ['mongo'] })).toEqual([]);
    // No subtitle: nothing to look in, whatever the keyword.
    expect(sub('Alpha', 'here', { keywords: ['here'] })).toEqual([]);
  });

  it('keeps ranges on the subtitle as shown for a character whose lower case is longer', () => {
    // `İ` lower-cases to two characters; the range must still land on `prod`.
    expect(sub('Alpha', 'prod', { subtitle: 'İ Production' })).toEqual([[2, 6]]);
  });

  it('reads the ranges once, however often asked, and alongside the title’s', () => {
    const [row] = rankCommands([make({ id: 'a', title: 'Alpha', subtitle: 'Production' })], 'alp prod', ctx, []);
    expect(row!.subtitleRanges).toBe(row!.subtitleRanges);
    expect(row!.ranges).toBe(row!.ranges);
    expect(row!.ranges).toEqual([[0, 3]]);
    expect(row!.subtitleRanges).toEqual([[0, 4]]);
  });

  it('is empty on an empty query', () => {
    expect(sub('Alpha', '', { subtitle: 'Production' })).toEqual([]);
  });
});

describe('rankCommands — empty query', () => {
  it('reports no class', () => {
    const rows = rankCommands([make({ id: 'a' })], '', ctx, []);
    expect(rows[0]!.cls).toBeNull();
    expect(rows[0]!.recent).toBe(false);
  });

  it('lists a recent row once, even with a duplicate id in the MRU', () => {
    expect(rank([make({ id: 'a', title: 'A' }), make({ id: 'b', title: 'B' })], '', ['b', 'b'])).toEqual(['b', 'a']);
  });

  it('keeps every row of a family apart from the recents that are listed', () => {
    const all = [make({ id: 'a' }), make({ id: 'b' }), make({ id: 'c' })];
    expect(rank(all, '   ', ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });
});

describe('rankCommands — rows built from the query', () => {
  const finder = (answer: string | null) =>
    make({
      id: 'find',
      title: 'Find _id',
      group: 'query',
      forQuery: (q) => (answer === null ? null : { ...rowFor(`Find ${q}`), emphasis: q }),
    });

  it('lists the row first, with the title the query gave it', () => {
    const rows = rankCommands([make({ id: 'a', title: 'Alpha' }), finder('x')], 'alpha', ctx, []);
    expect(ids(rows)).toEqual(['find', 'a']);
    expect(rows[0]!.cmd.title).toBe('Find alpha');
    expect(rows[0]!.cmd.subtitle).toBe('sub');
    expect(rows[0]!.fromQuery?.emphasis).toBe('alpha');
    expect(rows[0]!.cls).toBeNull();
  });

  it('performs the row’s own action, not the command’s', () => {
    const own = vi.fn();
    const base = vi.fn();
    const cmd = make({ id: 'f', perform: base, forQuery: () => ({ ...rowFor('t'), perform: own }) });
    void rankCommands([cmd], 'x', ctx, [])[0]!.cmd.perform(ctx);
    expect(own).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();
  });

  it('hands it the trimmed query as typed', () => {
    const seen: string[] = [];
    const cmd = make({ id: 'f', forQuery: (q) => (seen.push(q), null) });
    rankCommands([cmd], '  AbC  ', ctx, []);
    expect(seen).toEqual(['AbC']);
  });

  it('lists nothing when the query is not for it, and never ranks it as a command', () => {
    expect(rank([finder(null)], 'find')).toEqual([]);
  });

  it('is absent on an empty query, recent or not', () => {
    expect(rank([finder('x')], '')).toEqual([]);
    expect(rank([finder('x')], '', ['find'])).toEqual([]);
  });

  it('is hidden by when() like any command', () => {
    const cmd = { ...finder('x'), when: () => false };
    expect(rank([cmd], 'alpha')).toEqual([]);
  });
});

describe('rankCommands — limits', () => {
  it('refuses more commands than the sort key can number', () => {
    const many = new Array<Command>(2 ** 24 + 1).fill(make({ id: 'a' }));
    expect(() => rankCommands(many, 'a', ctx, [])).toThrow(/exceed/);
  });
});

describe('parsePastedObjectId', () => {
  const hex = '6650c1f2a9e4b31d2c8f0a17';

  it('takes 24 hexadecimal characters, bare', () => {
    expect(parsePastedObjectId(hex)).toBe(hex);
    expect(parsePastedObjectId(`  ${hex}  `)).toBe(hex);
    expect(parsePastedObjectId(hex.toUpperCase())).toBe(hex.toUpperCase());
  });

  it('takes ObjectId("…") and ObjectId(\'…\')', () => {
    expect(parsePastedObjectId(`ObjectId("${hex}")`)).toBe(hex);
    expect(parsePastedObjectId(`ObjectId('${hex}')`)).toBe(hex);
    expect(parsePastedObjectId(`ObjectId( "${hex}" )`)).toBe(hex);
  });

  it.each([
    ['too short', hex.slice(1)],
    ['too long', `${hex}0`],
    ['not hexadecimal', `${hex.slice(0, 23)}g`],
    ['mismatched quotes', `ObjectId("${hex}')`],
    ['unquoted', `ObjectId(${hex})`],
    ['extra text before', `x ObjectId("${hex}")`],
    ['extra text after', `ObjectId("${hex}") x`],
    ['wrong case of the wrapper', `objectid("${hex}")`],
    ['a second id', `${hex} ${hex}`],
    ['empty', ''],
  ])('rejects %s', (_name, query) => {
    expect(parsePastedObjectId(query)).toBeNull();
  });
});



describe('rankCommands — hideWhenEmptyQuery', () => {
  const all = [
    make({ id: 'plain', title: 'Plain' }),
    make({ id: 'ns', title: 'Open: shop.orders', matchText: 'shop.orders', hideWhenEmptyQuery: true }),
  ];

  it('omits the command from the empty-query catalog', () => {
    expect(rank(all, '')).toEqual(['plain']);
  });

  it('still lists it under Recent on an empty query when the MRU has it', () => {
    const rows = rankCommands(all, '', ctx, ['ns']);
    expect(ids(rows)).toEqual(['ns', 'plain']);
    expect(rows[0]!.recent).toBe(true);
  });

  it('shows it once there is a query', () => {
    expect(rank(all, 'orders')).toEqual(['ns']);
  });
});

describe('rankCommands — corners the mutants found', () => {
  const only = (title: string, q: string, extra: Partial<Command> = {}) =>
    rankCommands([make({ id: 'a', title, ...extra })], q, ctx, [])[0];

  it('lowercases around a character whose lower case is longer', () => {
    expect(only('İSTANBUL.Orders', 'orders')?.cls).toBe('exact');
  });

  it('a whole match text that starts with a separator is exact', () => {
    expect(only('.b', '.b')?.cls).toBe('exact');
  });

  it('marks the first word start when a token starts several words', () => {
    expect(only('ord_ord', 'ord')?.ranges).toEqual([[0, 3]]);
  });

  it('does not read initials past the last word', () => {
    expect(only('shop', 'ss')).toBeUndefined();
    expect(only('shop', 'sh')?.cls).toBe('wordStart');
  });

  it('matches a two-character subsequence', () => {
    expect(only('shop.orders', 'oe')?.cls).toBe('subsequence');
  });

  it.each(['→', ' ', '/', ':'])('ends a segment at %j', (sep) => {
    expect(only(`x${sep}orders${sep}y`, 'orders')?.cls).toBe('exact');
  });

  it('gives empty-query rows no ranges and the right recent flag', () => {
    const rows = rankCommands([make({ id: 'a' }), make({ id: 'b' })], '', ctx, ['a']);
    expect(rows.map((r) => [r.recent, r.ranges])).toEqual([
      [true, []],
      [false, []],
    ]);
  });

  it('gives a row built from the query no ranges and no recency', () => {
    const [row] = rankCommands([make({ id: 'f', forQuery: () => rowFor('t') })], 'x', ctx, ['f']);
    expect(row!.ranges).toEqual([]);
    expect(row!.recent).toBe(false);
  });

  it('orders groups by best row even with a row built from the query first', () => {
    const ranked = rankCommands(
      [
        make({ id: 'view', title: 'Show results as Tree', group: 'view' }),
        make({ id: 'coll', title: 'Open: api.rest', matchText: 'api.rest', group: 'workspace' }),
        make({ id: 'f', title: 'Find', group: 'query', forQuery: () => rowFor('Found') }),
      ],
      'rest',
      ctx,
      [],
    );
    expect(groupRows(ranked).map((g) => g.key)).toEqual(['pasted', 'workspace', 'view']);
  });
});

describe('initials ranges', () => {
  it('emphasises the first letter of each word an initials match reads', () => {
    const coll = make({ id: 'tab.open:c1:ops:retention_daily', title: 'Open: ops.retention_daily', matchText: 'ops.retention_daily' });
    const [row] = rankCommands([coll], 'ord', ctx, []);
    expect(row!.cls).toBe('initials');
    expect(row!.ranges).toEqual([
      [0, 1],
      [4, 5],
      [14, 15],
    ]);
  });
});

