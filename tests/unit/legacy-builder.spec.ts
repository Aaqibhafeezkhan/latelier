import { describe, it, expect } from 'vitest';
import { hydrateFindPayload, legacyCompileFilter } from '../../src/pages/Workspace/legacyBuilder';
import type { BuilderState } from '@shared/types';
import type { LegacyBuilderState, LegacyCond, LegacyValType } from '../../src/pages/Workspace/legacyBuilder';

function makeState(overrides: Partial<LegacyBuilderState> = {}): LegacyBuilderState {
  return {
    conditions: [],
    logic: 'AND',
    projection: [],
    sort: '',
    limit: '',
    ...overrides,
  };
}

function makeCond(overrides: Partial<LegacyCond> = {}): LegacyCond {
  return {
    id: 1,
    field: 'name',
    op: '$eq',
    valType: 'string',
    value: 'alice',
    ...overrides,
  };
}

// Compiles a single condition and reads back just its op-value, e.g.
// condValue({ op: '$gte', value: '5' }) reads filter.name.$gte.
function condValue(overrides: Partial<LegacyCond>): unknown {
  const cond = makeCond(overrides);
  const state = makeState({ conditions: [cond] });
  const parsed = JSON.parse(legacyCompileFilter(state)) as Record<string, Record<string, unknown>>;
  return parsed[cond.field]![cond.op];
}

// W13-2 — `legacyCompileFilter` is a frozen copy of the pre-W13
// `compileMql`'s filter half. This pins its output for a populated legacy
// `BuilderState` so the frozen copy can't silently drift from what it was
// meant to preserve.
describe('legacyCompileFilter', () => {
  it('returns {} for no active conditions', () => {
    expect(legacyCompileFilter(makeState())).toBe('{}');
  });

  it('compiles a single condition with no $and/$or wrapper', () => {
    const state = makeState({ conditions: [makeCond()] });
    expect(JSON.parse(legacyCompileFilter(state))).toEqual({ name: { $eq: 'alice' } });
  });

  it('wraps multiple AND conditions in $and', () => {
    const state = makeState({
      conditions: [
        makeCond({ id: 1, field: 'status', op: '$eq', valType: 'string', value: 'active' }),
        makeCond({ id: 2, field: 'age', op: '$gte', valType: 'number', value: '21' }),
      ],
      logic: 'AND',
    });
    expect(JSON.parse(legacyCompileFilter(state))).toEqual({
      $and: [{ status: { $eq: 'active' } }, { age: { $gte: 21 } }],
    });
  });

  it('wraps multiple OR conditions in $or', () => {
    const state = makeState({
      conditions: [
        makeCond({ id: 1, field: 'role', op: '$eq', valType: 'string', value: 'admin' }),
        makeCond({ id: 2, field: 'role', op: '$eq', valType: 'string', value: 'superuser' }),
      ],
      logic: 'OR',
    });
    expect(JSON.parse(legacyCompileFilter(state))).toEqual({
      $or: [{ role: { $eq: 'admin' } }, { role: { $eq: 'superuser' } }],
    });
  });

  it('preserves objectid/long/decimal/date EJSON sentinels', () => {
    const state = makeState({
      conditions: [
        makeCond({ id: 1, field: '_id', op: '$eq', valType: 'objectid', value: '507f1f77bcf86cd799439011' }),
        makeCond({ id: 2, field: 'big', op: '$eq', valType: 'long', value: '1234567890123456789' }),
        makeCond({ id: 3, field: 'price', op: '$gte', valType: 'decimal', value: '9.99' }),
        makeCond({ id: 4, field: 'createdAt', op: '$gt', valType: 'date', value: '2024-01-01T00:00:00.000Z' }),
      ],
      logic: 'AND',
    });
    expect(JSON.parse(legacyCompileFilter(state))).toEqual({
      $and: [
        { _id: { $eq: { $oid: '507f1f77bcf86cd799439011' } } },
        { big: { $eq: { $numberLong: '1234567890123456789' } } },
        { price: { $gte: { $numberDecimal: '9.99' } } },
        { createdAt: { $gt: { $date: '2024-01-01T00:00:00.000Z' } } },
      ],
    });
  });

  it('skips conditions with an empty field', () => {
    const state = makeState({
      conditions: [
        makeCond({ id: 1, field: '', op: '$eq', valType: 'string', value: 'x' }),
        makeCond({ id: 2, field: 'name', op: '$eq', valType: 'string', value: 'alice' }),
      ],
    });
    expect(JSON.parse(legacyCompileFilter(state))).toEqual({ name: { $eq: 'alice' } });
  });

  it('a whitespace-only field is inactive too (trimmed check, not a raw emptiness check)', () => {
    const state = makeState({
      conditions: [
        makeCond({ id: 1, field: '   ', op: '$eq', valType: 'string', value: 'x' }),
        makeCond({ id: 2, field: 'name', op: '$eq', valType: 'string', value: 'alice' }),
      ],
    });
    expect(JSON.parse(legacyCompileFilter(state))).toEqual({ name: { $eq: 'alice' } });
  });
});

// ─── buildCondValue routing ──────────────────────────────────────────────────
//
// Equivalent mutants ceded (verified, not guessed): SIMPLE_OPS
// ($eq/$ne/$gt/$gte/$lt/$lte) routes to `buildTypedValue(cond)` — but so does
// the function's final fallback (`return buildTypedValue(cond)`), and no
// other branch above it ($regex/$type/$mod/$size/BITS_OPS/ARRAY_VALUE_OPS)
// can ever match one of those six literal ops. So whether an op is "in"
// SIMPLE_OPS or falls through to the bottom fallback, the call is identical
// either way — the whole check, and every literal inside it, is unobservable
// dead weight. That kills: the `SIMPLE_OPS.has(op)` line's `if (false)`
// mutant, the `new Set([])` mutant, and all 6 individual string-literal
// mutants on the SIMPLE_OPS line. (`if (true)` on that same line IS real —
// it would short-circuit ARRAY_VALUE_OPS/$regex/$type/$mod/$size ops too —
// and is killed below by the $in test.)

describe('buildCondValue — $exists ignores value/valType', () => {
  it('returns literal true regardless of value or valType', () => {
    expect(condValue({ op: '$exists', valType: 'string', value: 'whatever' })).toBe(true);
  });
});

describe('buildCondValue — ARRAY_VALUE_OPS ($in/$nin/$all) coerce each element', () => {
  it('$in wraps each raw objectid-string element individually, unlike a single sentinel over the raw JSON', () => {
    expect(condValue({ op: '$in', valType: 'objectid', value: '["507f1f77bcf86cd799439011",123]' })).toEqual([
      { $oid: '507f1f77bcf86cd799439011' },
      123,
    ]);
  });

  it('$nin takes the same array-value path as $in', () => {
    expect(condValue({ op: '$nin', valType: 'objectid', value: '["507f1f77bcf86cd799439011"]' })).toEqual([
      { $oid: '507f1f77bcf86cd799439011' },
    ]);
  });

  it('$all takes the same array-value path as $in', () => {
    expect(condValue({ op: '$all', valType: 'number', value: '[1,"2"]' })).toEqual([1, 2]);
  });

  it('an unrecognized op with valType number goes through numeric coercion, not a $regex-style raw passthrough', () => {
    expect(condValue({ op: '$unknownop', valType: 'number', value: '42' })).toBe(42);
  });
});

describe('buildCondValue — $regex / $type / $mod / $size / BITS_OPS', () => {
  it('$regex returns the raw string unwrapped, unlike the regex valType (which wraps it)', () => {
    expect(condValue({ op: '$regex', valType: 'regex', value: 'foo.*' })).toBe('foo.*');
  });

  it('$type coerces a numeric value to a number', () => {
    expect(condValue({ op: '$type', valType: 'string', value: '5' })).toBe(5);
  });

  it('$type falls back to the raw string for a non-numeric value', () => {
    expect(condValue({ op: '$type', valType: 'string', value: 'abc' })).toBe('abc');
  });

  it('$type falls back to the raw string for a whitespace-only value (trim guard)', () => {
    // Number('   ') is 0 (finite) — without the `.trim() !== ''` guard this
    // would wrongly coerce to the number 0.
    expect(condValue({ op: '$type', valType: 'string', value: '   ' })).toBe('   ');
  });

  it('$mod passes a length-2 array through unchanged', () => {
    expect(condValue({ op: '$mod', valType: 'string', value: '[10,2]' })).toEqual([10, 2]);
  });

  it('$mod defaults to [0,0] when the parsed array length is not 2', () => {
    expect(condValue({ op: '$mod', valType: 'string', value: '[10]' })).toEqual([0, 0]);
  });

  it('$mod defaults to [0,0] for invalid JSON', () => {
    expect(condValue({ op: '$mod', valType: 'string', value: 'not json' })).toEqual([0, 0]);
  });

  it('$size coerces a numeric value directly, ignoring valType', () => {
    expect(condValue({ op: '$size', valType: 'string', value: '3' })).toBe(3);
  });

  it('$size falls back to 0 for a non-numeric value', () => {
    expect(condValue({ op: '$size', valType: 'string', value: 'abc' })).toBe(0);
  });

  it.each(['$bitsAllClear', '$bitsAnyClear', '$bitsAllSet', '$bitsAnySet'] as const)(
    '%s coerces a numeric value directly like $size — proves the guard is || not &&',
    (op) => {
      expect(condValue({ op, valType: 'string', value: '7' })).toBe(7);
    },
  );

  it('an unrecognized op falls through every special case to buildTypedValue', () => {
    expect(condValue({ op: '$unknownop', valType: 'string', value: '42' })).toBe('42');
  });
});

// ─── buildTypedValue — every LegacyValType, via $eq (routes through the
// (equivalent) SIMPLE_OPS branch or the identical bottom fallback) ─────────
//
// Equivalent mutant ceded: `case 'string': return value;` in the switch and
// the switch's own `default: return value;` execute the identical
// statement, so removing the 'string' case label changes nothing observable
// — valType 'string' simply falls through to the (behaviourally identical)
// default.

describe('buildTypedValue — full valType coverage', () => {
  it('boolean valType parses "true" literally as boolean true', () => {
    expect(condValue({ valType: 'boolean', value: 'true' })).toBe(true);
  });

  it('boolean valType treats any other string as false', () => {
    expect(condValue({ valType: 'boolean', value: 'false' })).toBe(false);
    expect(condValue({ valType: 'boolean', value: 'yes' })).toBe(false);
  });

  it('null valType always compiles to null, ignoring the raw value', () => {
    expect(condValue({ valType: 'null', value: 'ignored' })).toBe(null);
  });

  it('regex valType wraps the raw string as $regex (distinct from the $regex op passthrough)', () => {
    expect(condValue({ op: '$eq', valType: 'regex', value: 'a.*b' })).toEqual({ $regex: 'a.*b' });
  });

  it('array valType parses valid JSON directly, without per-element coercion', () => {
    expect(condValue({ valType: 'array', value: '[1,"two",true]' })).toEqual([1, 'two', true]);
  });

  it('array valType falls back to [] for invalid JSON', () => {
    expect(condValue({ valType: 'array', value: 'not json' })).toEqual([]);
  });

  it('long/decimal trim surrounding whitespace from the raw value', () => {
    expect(condValue({ valType: 'long', value: '  42  ' })).toEqual({ $numberLong: '42' });
    expect(condValue({ valType: 'decimal', value: '  9.5  ' })).toEqual({ $numberDecimal: '9.5' });
  });

  it('an unrecognized valType falls through to the raw string (defensive default for malformed saved data)', () => {
    expect(condValue({ valType: 'bogus' as unknown as LegacyValType, value: 'x' })).toBe('x');
  });
});

// ─── coerceArrayElement — every LegacyValType, via $in ──────────────────────

describe('coerceArrayElement (via $in) — full valType coverage', () => {
  it('objectid: wraps a raw string element, passes through a non-string element', () => {
    expect(condValue({ op: '$in', valType: 'objectid', value: '["abc",123]' })).toEqual([{ $oid: 'abc' }, 123]);
  });

  it('long: passes an already-wrapped element through, wraps+trims a raw one', () => {
    expect(condValue({ op: '$in', valType: 'long', value: '[{"$numberLong":"9"}," 42 "]' })).toEqual([
      { $numberLong: '9' },
      { $numberLong: '42' },
    ]);
  });

  it('long: a null element is not mistaken for "already wrapped" (isEjsonWrapped rejects null)', () => {
    expect(condValue({ op: '$in', valType: 'long', value: '[null]' })).toEqual([{ $numberLong: 'null' }]);
  });

  it('long: a plain object missing the $numberLong key is not mistaken for "already wrapped"', () => {
    expect(condValue({ op: '$in', valType: 'long', value: '[{"foo":1}]' })).toEqual([
      { $numberLong: '[object Object]' },
    ]);
  });

  it('decimal: passes an already-wrapped element through, wraps+trims a raw one', () => {
    expect(condValue({ op: '$in', valType: 'decimal', value: '[{"$numberDecimal":"9.1"}," 4.2 "]' })).toEqual([
      { $numberDecimal: '9.1' },
      { $numberDecimal: '4.2' },
    ]);
  });

  it('date: wraps a raw string element, passes through a non-string element', () => {
    expect(condValue({ op: '$in', valType: 'date', value: '["2024-01-01",5]' })).toEqual([
      { $date: '2024-01-01' },
      5,
    ]);
  });

  it('number: passes a numeric element through, coerces a string element', () => {
    expect(condValue({ op: '$in', valType: 'number', value: '[5,"6"]' })).toEqual([5, 6]);
  });

  it('boolean: passes a boolean element through, treats "true" as true and anything else as false', () => {
    expect(condValue({ op: '$in', valType: 'boolean', value: '[true,"true","nope"]' })).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('string: coerces a non-string element via String()', () => {
    expect(condValue({ op: '$in', valType: 'string', value: '[1,true]' })).toEqual(['1', 'true']);
  });

  it('default: an unrecognized valType passes each element through unchanged', () => {
    expect(condValue({ op: '$in', valType: 'bogus' as unknown as LegacyValType, value: '[1,"x"]' })).toEqual([
      1,
      'x',
    ]);
  });
});

// ─── parseJsonArray edge cases (via $in, so per-element coercion exposes
// the difference between an empty array and a swallowed single element) ────

describe('parseJsonArray edge cases', () => {
  it('valid-but-non-array JSON compiles to an empty array', () => {
    expect(condValue({ op: '$in', valType: 'string', value: '{"a":1}' })).toEqual([]);
  });

  it('invalid JSON compiles to an empty array', () => {
    expect(condValue({ op: '$in', valType: 'string', value: 'not json' })).toEqual([]);
  });
});

describe('hydrateFindPayload', () => {
  const current: BuilderState = {
    projection: ['a'],
    projectionRaw: '{"a":1}',
    sort: 'a:1',
    limit: '5',
    collation: '{"locale":"fr"}',
    hint: 'a_1',
    maxTimeMS: '100',
    readPreference: 'secondary',
  } as BuilderState;

  it('takes the saved text and builder, and clears what the payload does not carry', () => {
    const builder = { ...makeState({ sort: 'b:-1', limit: '7', projection: ['b'] }), maxTimeMS: '9' };
    const out = hydrateFindPayload({ kind: 'find', builder, queryRaw: '{"b":2}' }, current);
    expect(out).toEqual({
      queryRaw: '{"b":2}',
      builder: {
        sort: 'b:-1',
        limit: '7',
        projection: ['b'],
        projectionRaw: undefined,
        collation: undefined,
        hint: undefined,
        maxTimeMS: '9',
        readPreference: undefined,
      },
    });
  });

  it('compiles the pre-queryRaw conditions when the payload has no text', () => {
    const builder = makeState({
      conditions: [makeCond({ field: 'n', op: '=', valType: 'number', value: '3' })],
    });
    const out = hydrateFindPayload({ kind: 'find', builder }, current);
    expect(out.queryRaw).toBe(legacyCompileFilter(builder));
    expect(out.queryRaw).not.toBe('{}');
  });

  it('keeps the tab’s sort, limit and projections for a row with no builder, and drops its options', () => {
    const out = hydrateFindPayload({ kind: 'find' } as never, current);
    expect(out).toEqual({
      queryRaw: '{}',
      builder: {
        sort: 'a:1',
        limit: '5',
        projection: ['a'],
        projectionRaw: '{"a":1}',
        collation: undefined,
        hint: undefined,
        maxTimeMS: undefined,
        readPreference: undefined,
      },
    });
  });

  it('reads a saved raw projection', () => {
    const builder = { ...makeState(), projectionRaw: '{"_id":0}' };
    expect(hydrateFindPayload({ kind: 'find', builder, queryRaw: '{}' }, current).builder.projectionRaw).toBe('{"_id":0}');
  });
});
