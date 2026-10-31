import { describe, it, expect } from 'vitest';
import { FIELD_POSITION_OPS, OPERATORS } from '../../src/features/fieldSuggestions/operators';
import { fieldOperatorSource, operatorSource } from '../../src/features/fieldSuggestions/sources/operatorSource';
import type { SuggestionContext } from '../../src/features/fieldSuggestions/types';

function ctx(overrides: Partial<SuggestionContext> = {}): SuggestionContext {
  return {
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    ...overrides,
  };
}

describe('operatorSource', () => {
  it('returns one suggestion per catalog entry', () => {
    const out = operatorSource(ctx());
    expect(Array.isArray(out)).toBe(true);
    const arr = out as Array<{ kind: string; name: string }>;
    expect(arr.length).toBe(OPERATORS.length);
    expect(arr.every((s) => s.kind === 'operator')).toBe(true);
  });

  it('has no duplicate (class, name) pair', () => {
    const keys = OPERATORS.map((o) => `${o.class}:${o.name}`);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it('every operator name starts with $', () => {
    for (const op of OPERATORS) {
      expect(op.name.startsWith('$')).toBe(true);
    }
  });

  it('includes core operators across classes', () => {
    const names = new Set(OPERATORS.map((o) => o.name));
    for (const expected of ['$eq', '$ne', '$gt', '$sum', '$match', '$group', '$concat', '$set']) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('tags source = "operators"', () => {
    const out = operatorSource(ctx()) as Array<{ source: string }>;
    expect(out.every((s) => s.source === 'operators')).toBe(true);
  });

  it('flags off-context entries when operatorContext is set', () => {
    const out = operatorSource(ctx({ operatorContext: 'matchKey' })) as Array<{
      name: string;
      offContext: boolean;
    }>;
    const eq = out.find((s) => s.name === '$eq');
    const sum = out.find((s) => s.name === '$sum');
    expect(eq?.offContext).toBe(false);
    expect(sum?.offContext).toBe(true);
  });
});

describe('fieldOperatorSource', () => {
  it('lists each field-position operator once, and exactly those operators', async () => {
    const items = (await fieldOperatorSource({} as never)) as Array<{ name: string; class: string }>;
    const names = items.map((s) => s.name);
    // The catalog's `$expr` twins of $eq, $size, ... share these names; the
    // builder's op box must offer the query-position operator alone.
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(
      [...FIELD_POSITION_OPS].sort((a, b) => a.localeCompare(b)),
    );
    expect(items.some((s) => s.class === 'expression')).toBe(false);
  });
});
