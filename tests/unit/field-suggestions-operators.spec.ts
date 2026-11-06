import { describe, it, expect } from 'vitest';
import { FIELD_POSITION_OPS, OPERATORS } from '../../src/features/fieldSuggestions/operators';
import { fieldOperatorSource, operatorSource } from '../../src/features/fieldSuggestions/sources/operatorSource';
import type { SuggestionContext } from '../../src/features/fieldSuggestions/types';
import { detectAggGrammar } from '../../src/features/fieldSuggestions/aggGrammar';

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

const WINDOW_ONLY = [
  '$rank', '$denseRank', '$documentNumber', '$shift', '$derivative', '$integral',
  '$expMovingAvg', '$linearFill', '$locf', '$covariancePop', '$covarianceSamp',
];
const FILTER_TOP_ONLY = ['$and', '$or', '$nor', '$expr', '$text', '$where', '$jsonSchema'];

/**
 * `class:name` of every operator ranked in-context at the caret (`|`), going
 * through the grammar detector as the Filter Bar and stage editors do.
 */
function inContextAt(text: string, stageOp: string): Set<string> {
  const caret = text.indexOf('|');
  const hit = detectAggGrammar(text.slice(0, caret) + text.slice(caret + 1), caret, stageOp);
  if (hit?.kind !== 'fieldName' || !hit.operatorContext) {
    throw new Error(`no operator context at ${text}`);
  }
  const out = operatorSource(ctx({ operatorContext: hit.operatorContext })) as Array<{
    name: string;
    class: string;
    offContext: boolean;
  }>;
  return new Set(out.filter((s) => !s.offContext).map((s) => `${s.class}:${s.name}`));
}

describe('operatorSource context ranking', () => {
  it('ranks only top-level filter operators in-context at the filter top level', () => {
    const names = [...inContextAt('{ $a|', '$match')].map((n) => n.split(':')[1]!);
    expect(names.sort((x, y) => x.localeCompare(y))).toEqual(
      [...FILTER_TOP_ONLY].sort((x, y) => x.localeCompare(y)),
    );
  });

  it("ranks only field operators in-context inside a field's object", () => {
    const names = [...inContextAt('{ age: { $| } }', '$match')].map((n) => n.split(':')[1]);
    for (const op of FIELD_POSITION_OPS) expect(names).toContain(op);
    for (const op of FILTER_TOP_ONLY) expect(names).not.toContain(op);
  });

  it('ranks no expression in-context anywhere in a filter outside $expr', () => {
    for (const text of ['{ $|', '{ age: { $| } }', '{ $or: [{ $| }] }']) {
      expect([...inContextAt(text, '$match')].filter((n) => n.startsWith('expression:'))).toEqual([]);
    }
    expect(inContextAt('{ $expr: { $| } }', '$match').has('expression:$concat')).toBe(true);
  });

  it('ranks window-only operators off-context in $group and in-context in $setWindowFields output', () => {
    const group = inContextAt('{ _id: null, n: { $| } }', '$group');
    const window = inContextAt('{ output: { n: { $| } } }', '$setWindowFields');
    for (const op of WINDOW_ONLY) {
      expect(group.has(`accumulator:${op}`)).toBe(false);
      expect(window.has(`accumulator:${op}`)).toBe(true);
    }
    // Common accumulators are valid in both; `$accumulator` only in $group.
    expect(group.has('accumulator:$sum')).toBe(true);
    expect(window.has('accumulator:$sum')).toBe(true);
    expect(group.has('accumulator:$accumulator')).toBe(true);
    expect(window.has('accumulator:$accumulator')).toBe(false);
    expect(window.has('accumulator:$function')).toBe(false);
  });

  it('ranks accumulators in-context in a $bucket output field', () => {
    const names = inContextAt('{ groupBy: "$a", boundaries: [0, 10], output: { n: { $| } } }', '$bucket');
    expect(names.has('accumulator:$sum')).toBe(true);
    expect(names.has('accumulator:$rank')).toBe(false);
  });

  it('ranks no operator in-context at a $sort key, and only $meta in a sort value', () => {
    expect(inContextAt('{ $|', '$sort').size).toBe(0);
    expect([...inContextAt('{ score: { $| } }', '$sort')]).toEqual(['expression:$meta']);
  });

  it('ranks both $elemMatch forms in-context inside $elemMatch', () => {
    const names = [...inContextAt('{ items: { $elemMatch: { $| } } }', '$match')].map(
      (n) => n.split(':')[1],
    );
    // A document predicate (`$or: [...]`) and a scalar comparison (`$gt`).
    for (const op of ['$and', '$or', '$nor', '$gt', '$in', '$not']) expect(names).toContain(op);
    for (const op of ['$expr', '$text', '$where']) expect(names).not.toContain(op);
    expect(names.some((n) => n === '$concat')).toBe(false);
  });

  it("ranks field operators in a condition inside an $elemMatch clause list", () => {
    const names = [
      ...inContextAt('{ items: { $elemMatch: { $or: [{ qty: { $| } }] } } }', '$match'),
    ].map((n) => n.split(':')[1]);
    expect(names).toContain('$gt');
    expect(names).not.toContain('$or');
  });

  it('hands each caller its own array, so a caller cannot corrupt the cached list', async () => {
    const first = operatorSource(ctx()) as unknown[];
    first.length = 0;
    expect((operatorSource(ctx()) as unknown[]).length).toBe(OPERATORS.length);
    const field = (await fieldOperatorSource({} as never)) as unknown[];
    field.length = 0;
    expect(((await fieldOperatorSource({} as never)) as unknown[]).length).toBe(FIELD_POSITION_OPS.size);
  });

  it('leaves the catalog unranked when no context is set', () => {
    const out = operatorSource(ctx()) as Array<{ offContext: boolean }>;
    expect(out.every((s) => !s.offContext)).toBe(true);
  });
});
