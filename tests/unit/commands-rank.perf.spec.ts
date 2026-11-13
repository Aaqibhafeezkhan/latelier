import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { rankCommands, groupRows } from '../../src/commands/rank';
import { commandRegistry, objectRow } from '../../src/commands/registry';
import { layoutPalette, type Scope } from '../../src/commands/layout';
import type { Command, ObjectAction, PaletteContext } from '../../src/commands/types';

const ctx: PaletteContext = { pathname: '/workspace', connectionId: 'c1' };

// X07 §13.7 rule 4: the ranker takes no more than 16 ms at 50,000 collections
// plus the commands, for any query. Median of 15 runs, the first one warming
// the per-registration cache.
//
// A wall-clock bound that tight fails under the parallel suite's load, so the
// frame-budget probes are opt-in, like the in-app harness: `npm run perf:rank`
// (ATELIER_RANK_PERF=1). The normal suite keeps one coarse regression guard.
const BOUND_MS = 16;
const PERF = process.env.ATELIER_RANK_PERF === '1';
// What the normal suite allows the palette's first typed call at 50,000
// collections: it catches work that grows per row, not a slow machine.
const COARSE_BOUND_MS = 100;
const RUNS = 15;

const act = (id: string, verb: string, extra: Partial<ObjectAction> = {}): ObjectAction => ({
  id,
  verb,
  title: id,
  perform: () => {},
  ...extra,
});
const ACTIONS: ObjectAction[] = [
  act('Open', 'open'),
  act('Open in new tab', 'open', { alternate: true }),
  act('Aggregate', 'aggregate'),
  act('Schema', 'schema'),
  act('Indexes', 'indexes'),
  act('Export…', 'export'),
  act('Import…', 'import'),
  act('Rename…', 'rename'),
  act('Drop collection…', 'delete', { destructive: true }),
];

function catalog(collections: number, idPrefix = ''): Command[] {
  const cmds: Command[] = [];
  for (let i = 0; i < 40; i++) {
    cmds.push({ id: `cmd.${i}`, title: `Run command number ${i}`, group: 'general', keywords: ['x'], perform: () => {} });
  }
  for (let i = 0; i < collections; i++) {
    const db = `db${i % 50}`;
    const coll = `collection_${i}`;
    // Collections are objects since X07 §13.4, with the actions the app gives them.
    cmds.push(
      objectRow({
        id: `${idPrefix}tab.open:c1:${db}:${coll}`,
        kind: 'collection',
        name: `${db}.${coll}`,
        subtitle: 'Production',
        actions: ACTIONS,
      }),
    );
  }
  return cmds;
}

function median(all: Command[], query: string): number {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    groupRows(rankCommands(all, query, ctx, ['cmd.3']));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)]!;
}

// Stryker's instrumented code runs slower than the budget allows, so a mutant
// would be "killed" by the clock rather than by an assertion about behaviour.
const underStryker = process.env.STRYKER_MUTATOR_WORKER !== undefined;

describe.skipIf(underStryker || !PERF)('ranker budget at 50,000 collections', () => {
  const all = catalog(50_000);

  it.each(['', 'o', 'ord', 'collection 42', 'zzz', 'db1.collection_2'])('stays within the frame for %j', (query) => {
    expect(median(all, query)).toBeLessThanOrEqual(BOUND_MS);
  });
});

/** Settles the garbage the fixture left behind, so a collection pause is not timed as ranking. */
function collectGarbage(): void {
  v8.setFlagsFromString('--expose-gc');
  (vm.runInNewContext('gc') as () => void)();
}

// What registering 50,000 rows costs. A generous bound: it guards against the
// work growing per row, not against a slow machine.
const REGISTER_BOUND_MS = 250;
// Looking up 50,000 unchanged rows by id costs about 14 ms of that and the
// registry's own bookkeeping about 11 more; a full prepare is about 70.
const REREGISTER_BOUND_MS = 40;

describe.skipIf(underStryker || !PERF)('registering 50,000 collections', () => {
  it('prepares them within the registration budget', () => {
    const all = catalog(50_000, 'budget:');
    const t0 = performance.now();
    const off = commandRegistry.add(all);
    const ms = performance.now() - t0;
    off();
    process.stderr.write(`register 50k: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThanOrEqual(REGISTER_BOUND_MS);
  });

  it.each([10_000, 50_000])('times the first registration of %i rows', (n) => {
    const all = catalog(n, `first${n}:`);
    const t0 = performance.now();
    const off = commandRegistry.add(all);
    const ms = performance.now() - t0;
    off();
    process.stderr.write(`first registration ${n}: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThanOrEqual(REGISTER_BOUND_MS);
  });

  it('re-registers an identical 50,000-row catalog, rebuilt as new objects, at lookup cost', () => {
    // A running app has registered before: warm the lookup path on a small
    // catalog, so the timed run measures it and not first-use compilation.
    commandRegistry.add(catalog(2_000, 'warm:'))();
    commandRegistry.add(catalog(2_000, 'warm:'))();
    const off1 = commandRegistry.add(catalog(50_000, 'same:'));
    off1();
    const again = catalog(50_000, 'same:');
    collectGarbage();
    const t0 = performance.now();
    const off2 = commandRegistry.add(again);
    const ms = performance.now() - t0;
    off2();
    process.stderr.write(`re-registration 50k: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThanOrEqual(REREGISTER_BOUND_MS);
  });
});

// What the palette runs per keystroke since the capped layout (X07 §13.7
// rule 3): five rows per kind in All, 50 in a scope, the rest only counted.
describe.skipIf(underStryker || !PERF)('capped layout at 50,000 collections', () => {
  const all = catalog(50_000, 'capped:');

  it.each([
    ['all', ''],
    ['all', 'o'],
    ['all', 'ord'],
    ['collections', 'o'],
    ['collections', 'collection 42'],
    ['actions', 'o'],
    ['all', 'zzz'],
    ['all', 'open'],
    ['all', 'drop o'],
    ['collections', 'open'],
  ] as Array<[Scope, string]>)('lays out %s %j within the frame', (scope, query) => {
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      layoutPalette(all, query, ctx, ['cmd.3'], scope);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const ms = times[Math.floor(RUNS / 2)]!;
    process.stderr.write(`capped ${scope} ${JSON.stringify(query)}: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThanOrEqual(BOUND_MS);
  });

  it.each([
    ['all', 'o'],
    ['collections', 'o'],
    ['all', 'ord'],
  ] as Array<[Scope, string]>)('lays out %s %j within the frame on the first keystroke after a fresh registration', (scope, query) => {
    const fresh = catalog(50_000, `capped-first-${scope}-${query}:`);
    const off = commandRegistry.add(fresh);
    try {
      collectGarbage();
      const t0 = performance.now();
      layoutPalette(commandRegistry.list(), query, ctx, ['cmd.3'], scope);
      const first = performance.now() - t0;
      process.stderr.write(`capped first ${scope} ${JSON.stringify(query)}: ${first.toFixed(1)} ms\n`);
      expect(first).toBeLessThanOrEqual(BOUND_MS);
    } finally {
      off();
    }
  });
});

// A single cold sample on a shared 2-core runner under coverage lands near the
// bound by itself, and one GC pause or preemption pushes it over. Each sample
// gets its own fresh registration, so every one is still a first keystroke, and
// the fastest is compared: noise only ever adds time, while work that grows per
// row shows up in every sample.
const GUARD_SAMPLES = 3;

describe.skipIf(underStryker)('capped layout regression guard', () => {
  it('lays out the first typed query after registering 50,000 collections well inside a coarse bound', () => {
    const times: number[] = [];
    for (let i = 0; i < GUARD_SAMPLES; i++) {
      const off = commandRegistry.add(catalog(50_000, `guard${i}:`));
      try {
        collectGarbage();
        const t0 = performance.now();
        const layout = layoutPalette(commandRegistry.list(), 'o', ctx, ['cmd.3'], 'all');
        times.push(performance.now() - t0);
        expect(layout.entries.length).toBeLessThanOrEqual(2 * 6);
      } finally {
        off();
      }
    }
    expect(Math.min(...times)).toBeLessThanOrEqual(COARSE_BOUND_MS);
  });
});

