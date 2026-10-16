import { describe, expect, it, vi } from 'vitest';
import { rankCommands, groupRows, RECENT_LABEL } from '../../src/commands/rank';
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
    expect(ranked.map((r) => r.bucket)).toEqual(['recent', 'substring', 'substring']);
  });

  it('with empty query: ignores a stale recent id that is not visible', () => {
    const all = [make({ id: 'a', title: 'Alpha' })];
    // 'ghost' is a recent id from a command that no longer exists (or is
    // hidden by when()) — it must not produce a row with an undefined cmd.
    const ranked = rankCommands(all, '', ctx, ['ghost', 'a']);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.cmd.id).toBe('a');
    expect(ranked[0]!.bucket).toBe('recent');
  });

  it('ranks prefix matches above substring matches above keyword matches', () => {
    const all = [
      make({ id: 'kw', title: 'Unrelated', keywords: ['save'] }),
      make({ id: 'sub', title: 'Re-save query' }),
      make({ id: 'pref', title: 'Save query' }),
    ];
    const ranked = rankCommands(all, 'sav', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['pref', 'sub', 'kw']);
  });

  it('promotes a query-matching command into the recent bucket if MRU includes it', () => {
    const all = [make({ id: 'pref', title: 'Save query' })];
    const ranked = rankCommands(all, 'sav', ctx, ['pref']);
    expect(ranked[0]!.bucket).toBe('recent');
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

  it('orders groups by GROUP_ORDER', () => {
    const ranked = rankCommands(
      [
        make({ id: 'a', title: 'Aggregation thing', group: 'aggregation' }),
        make({ id: 'b', title: 'Workspace thing', group: 'workspace' }),
        make({ id: 'c', title: 'General thing', group: 'general' }),
      ],
      '',
      ctx,
      [],
    );
    const grouped = groupRows(ranked);
    expect(grouped.map((g) => g.key)).toEqual(['general', 'workspace', 'aggregation']);
  });
});

describe('rankCommands — fuzzy subsequence bucket', () => {
  it('matches a subsequence of the title in the fuzzy bucket', () => {
    const all = [make({ id: 'o', title: 'Open: shop.orders' })];
    const ranked = rankCommands(all, 'shord', ctx, []);
    expect(ranked.map((r) => [r.cmd.id, r.bucket])).toEqual([['o', 'fuzzy']]);
  });

  it('ranks fuzzy after prefix, substring and keyword matches', () => {
    const all = [
      make({ id: 'fz', title: 'Show recent queries' }),
      make({ id: 'kw', title: 'Unrelated', keywords: ['src'] }),
      make({ id: 'sub', title: 'Re-src thing' }),
      make({ id: 'pref', title: 'Src first' }),
    ];
    const ranked = rankCommands(all, 'src', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['pref', 'sub', 'kw', 'fz']);
    expect(ranked.map((r) => r.bucket)).toEqual(['prefix', 'substring', 'keyword', 'fuzzy']);
  });

  it('adds no fuzzy row for a one-character query', () => {
    // One character is a subsequence exactly when it is a substring, so a
    // single key never reaches the fuzzy bucket: it is prefix or substring.
    const all = [make({ id: 'a', title: 'Alpha one' }), make({ id: 'b', title: 'Bravo' })];
    expect(rankCommands(all, 'n', ctx, []).map((r) => [r.cmd.id, r.bucket])).toEqual([
      ['a', 'substring'],
    ]);
  });

  it('fuzzy-matches from two characters on', () => {
    const all = [make({ id: 'a', title: 'Alpha one' })];
    expect(rankCommands(all, 'ae', ctx, []).map((r) => r.bucket)).toEqual(['fuzzy']);
  });

  it('ignores whitespace in the query for the subsequence', () => {
    const all = [make({ id: 'o', title: 'Open: shop.orders' })];
    expect(rankCommands(all, 'sh  ord', ctx, []).map((r) => r.bucket)).toEqual(['fuzzy']);
  });

  it('does not match the right letters in the wrong order', () => {
    const all = [make({ id: 'o', title: 'Open: shop.orders' })];
    expect(rankCommands(all, 'dros', ctx, [])).toEqual([]);
  });

  it('keeps registration order inside the fuzzy bucket', () => {
    const all = [
      make({ id: 'z', title: 'Open: zoo.orders' }),
      make({ id: 'a', title: 'Open: app.orders' }),
    ];
    expect(rankCommands(all, 'ords', ctx, []).map((r) => r.cmd.id)).toEqual(['z', 'a']);
  });

  it('promotes a fuzzy match into the recent bucket when the MRU has it', () => {
    const all = [make({ id: 'o', title: 'Open: shop.orders' })];
    expect(rankCommands(all, 'shord', ctx, ['o'])[0]!.bucket).toBe('recent');
  });
});

describe('rankCommands — hideWhenEmptyQuery', () => {
  const all = [
    make({ id: 'plain', title: 'Plain' }),
    make({ id: 'ns', title: 'Open: shop.orders', hideWhenEmptyQuery: true }),
  ];

  it('omits the command from the empty-query catalog', () => {
    expect(rankCommands(all, '', ctx, []).map((r) => r.cmd.id)).toEqual(['plain']);
  });

  it('still lists it under Recent on an empty query when the MRU has it', () => {
    const ranked = rankCommands(all, '   ', ctx, ['ns']);
    expect(ranked.map((r) => [r.cmd.id, r.bucket])).toEqual([
      ['ns', 'recent'],
      ['plain', 'substring'],
    ]);
  });

  it('shows it once there is a query', () => {
    expect(rankCommands(all, 'orders', ctx, []).map((r) => r.cmd.id)).toEqual(['ns']);
  });
});

describe('groupRows — fuzzy rows', () => {
  it('groups a fuzzy row under its command group, not Recent', () => {
    const groups = groupRows([
      { cmd: make({ id: 'o', title: 'Open: shop.orders', group: 'workspace' }), bucket: 'fuzzy' },
    ]);
    expect(groups.map((g) => g.key)).toEqual(['workspace']);
  });
});

describe('rankCommands — fuzzyText', () => {
  it('matches the subsequence against fuzzyText instead of the title', () => {
    const all = [
      make({ id: 'a', title: 'Open: shop.orders', fuzzyText: 'shop.orders' }),
      make({ id: 'b', title: 'Open: crm.leads', fuzzyText: 'crm.leads' }),
    ];
    // "opn" is a subsequence of every "Open: …" title, but of neither namespace.
    expect(rankCommands(all, 'opn', ctx, [])).toEqual([]);
    expect(rankCommands(all, 'shrd', ctx, []).map((r) => [r.cmd.id, r.bucket])).toEqual([
      ['a', 'fuzzy'],
    ]);
  });

  it('keeps substring matching on the full title', () => {
    const all = [make({ id: 'a', title: 'Open: shop.orders', fuzzyText: 'shop.orders' })];
    expect(rankCommands(all, 'open', ctx, []).map((r) => r.bucket)).toEqual(['prefix']);
  });

  it('lowercases fuzzyText before matching', () => {
    const all = [make({ id: 'a', title: 'Open: Shop.Orders', fuzzyText: 'Shop.Orders' })];
    expect(rankCommands(all, 'shrd', ctx, []).map((r) => r.bucket)).toEqual(['fuzzy']);
  });
});
