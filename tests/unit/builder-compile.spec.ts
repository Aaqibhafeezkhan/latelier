import { describe, it, expect } from 'vitest';
import {
  compileFindOptions,
  condFromDragged,
  currentFilterJson,
  classifySort,
  cycleSortField,
  effectivePageLimit,
  findProblem,
  filterProblem,
  isDefaultQueryState,
  isUnfilteredFirstPage,
  limitWarning,
  parseSortString,
  projectionProblem,
  sortProblem,
  emptyBuilder,
  sortFieldPatch,
  FIELD_OPS,
  opForValType,
  mergeOrReplaceDragged,
  valTypeFromDisplayType,
  DRAGGED_FIELD_MIME,
} from '../../src/pages/Workspace/builder';
import { DEFAULT_COLLECTION_TAB_STATE } from '@shared/defaults';
import type { BuilderState, CollectionTabState } from '@shared/types';
import { isCompilableOp, type FilterNode } from '../../src/pages/Workspace/filterTree';

function makeTabState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    ...DEFAULT_COLLECTION_TAB_STATE,
    builder: { ...DEFAULT_COLLECTION_TAB_STATE.builder },
    ...overrides,
  };
}

function makeState(overrides: Partial<BuilderState> = {}): BuilderState {
  return { ...emptyBuilder(), ...overrides };
}

// W13 deletes `compileMql` and `parseMqlToBuilder` — the condition
// model they compiled/parsed is gone with `BuilderState.conditions`. The
// filter-compile and filter-parse behavior they covered lives on in
// `filterTree.ts`'s `parseFilter`/`printFilter`, tested in
// `tests/unit/filter-tree.spec.ts`. `describeCondProblem` (and its
// `makeCond` fixture) is deleted with this pass too — an earlier revision shipped a
// parallel `condValueProblem` inside `filterTree.ts` instead of reusing it,
// so `describeCondProblem` had zero production callers; its coverage was
// pure duplicate of `condValueProblem`'s (already covered in
// `filter-tree.spec.ts`'s "Problems" table).

describe('compileFindOptions', () => {
  it('returns undefined sort/projection and a null limit for the default state', () => {
    const result = compileFindOptions(emptyBuilder());
    expect(result.sort).toBeUndefined();
    expect(result.projection).toBeUndefined();
    expect(result.limit).toBeNull();
  });

  it('sort pass-through', () => {
    const result = compileFindOptions(makeState({ sort: '{"_id":-1}' }));
    expect(result.sort).toBe('{"_id":-1}');
  });

  it('projection object always includes _id', () => {
    const result = compileFindOptions(makeState({ projection: ['name', 'email'] }));
    expect(JSON.parse(result.projection!)).toEqual({ _id: 1, name: 1, email: 1 });
  });

  it('limit parsed', () => {
    expect(compileFindOptions(makeState({ limit: '100' })).limit).toBe(100);
  });

  it('empty limit is null', () => {
    expect(compileFindOptions(makeState({ limit: '' })).limit).toBeNull();
  });

  it('limit "0" is null — Mongo treats .limit(0) as "no limit"', () => {
    expect(compileFindOptions(makeState({ limit: '0' })).limit).toBeNull();
  });

  it('negative limit is null', () => {
    expect(compileFindOptions(makeState({ limit: '-3' })).limit).toBeNull();
  });

  it('trailing junk after a numeric limit still parses ("5xyz" → 5)', () => {
    expect(compileFindOptions(makeState({ limit: '5xyz' })).limit).toBe(5);
  });

  it('sort is trimmed of surrounding whitespace, not passed through verbatim', () => {
    expect(compileFindOptions(makeState({ sort: '  {"_id":-1}  ' })).sort).toBe('{"_id":-1}');
  });

  it('whitespace-only sort compiles to no sort at all', () => {
    expect(compileFindOptions(makeState({ sort: '   ' })).sort).toBeUndefined();
  });

  it('limit surrounded by whitespace still parses correctly', () => {
    expect(compileFindOptions(makeState({ limit: '  25  ' })).limit).toBe(25);
  });

  it('a limit with no leading digits at all (parseInt → NaN) is null', () => {
    expect(compileFindOptions(makeState({ limit: 'abc' })).limit).toBeNull();
  });

  it('a limit so large it parses to Infinity is treated as no limit, not "positive"', () => {
    // Number.parseInt('9'.repeat(400), 10) overflows to Infinity — finite
    // must be checked, not just "> 0", or this would compile to Infinity.
    expect(compileFindOptions(makeState({ limit: '9'.repeat(400) })).limit).toBeNull();
  });
});

// W15 §3.1 — one classifier, two consumers: QueryBar's Run gate and
// `useQueryRunner`'s guard. Blank is "no sort", not "invalid" — a rule the
// runner would get wrong in the most damaging direction (refusing every
// unsorted query) if it grew its own copy.
describe('sortProblem', () => {
  it('accepts blank, whitespace and a sort document', () => {
    expect(sortProblem('')).toBeNull();
    expect(sortProblem('   ')).toBeNull();
    expect(sortProblem('{}')).toBeNull();
    expect(sortProblem('{"a":1}')).toBeNull();
    expect(sortProblem('{"a":1,"b":-1}')).toBeNull();
    // The header can't draw it, but it is a real sort and it runs.
    expect(sortProblem('{"score":{"$meta":"textScore"}}')).toBeNull();
  });

  it('refuses unparseable text, naming sort rather than the filter', () => {
    expect(sortProblem('{"a":1')).toMatch(/sort/i);
    expect(sortProblem('nonsense')).toMatch(/sort/i);
  });

  // parseable is not runnable. The driver *ignores* an array or
  // `null` sort and returns insertion order with no error, so nothing
  // downstream would ever tell the user the sort was dropped.
  it('refuses EJSON that parses but is not a document', () => {
    for (const raw of ['[1,2]', 'null', '42', '"abc"', 'true']) {
      expect([raw, sortProblem(raw)]).not.toEqual([raw, null]);
    }
  });

  it('says which of the two problems it is — a shape error is not a parse error', () => {
    // A user who typed `[1,2]` told to "fix the syntax" looks for a typo
    // that isn't there.
    expect(sortProblem('[1,2]')).toMatch(/document/i);
    expect(sortProblem('[1,2]')).not.toMatch(/parse/i);
    expect(sortProblem('{"a":1')).toMatch(/parse/i);
    expect(sortProblem('{"a":1')).not.toMatch(/must be a document/i);
  });

  // The driver throws "Invalid sort direction" on these at run time, so the
  // Run gate refuses them up front and names the field.
  it.each(['2', '-7', '0.5', '0', '" asc"', 'true', 'null', '"bogus"', '{"x":1}', '[1]', '{"$meta":1}'])(
    'refuses the driver-refused direction %s, naming the field',
    (dir) => {
      expect(sortProblem('{"a":1,"b":' + dir + '}')).toBe(
        'Sort direction for "b" must be 1, -1, "asc" or "desc".',
      );
    },
  );

  it.each([
    '"asc"',
    '"DESC"',
    '"ascending"',
    '"descending"',
    '"1"',
    '"-1"',
    '{"$numberInt":"-1"}',
    '{"$numberLong":"1"}',
    '{"$meta":"textScore"}',
    '{"$meta":"indexKey","x":1}',
  ])('accepts the driver direction %s', (dir) => {
    expect(sortProblem('{"a":' + dir + '}')).toBeNull();
  });
});

// W15 §4.1 — the compiled value and the message shown for it, asserted
// together on purpose: the whole defect was that these two disagreed
// silently. Note `'5xyz'` does *not* collapse to "no limit" (the spec's §4.1
// prose says it does) — `parseInt` keeps the 5 — so the two outcomes get two
// different messages.
describe('limitWarning', () => {
  const cases: Array<[string, number | null, RegExp | null]> = [
    ['', null, null],
    ['  ', null, null],
    ['100', 100, null],
    ['0', null, /not a positive number.*no limit/i],
    ['-3', null, /not a positive number.*no limit/i],
    ['abc', null, /not a positive number.*no limit/i],
    ['5xyz', 5, /running with limit 5.*ignored/i],
  ];

  for (const [raw, expectedLimit, expectedMessage] of cases) {
    it(`limit ${JSON.stringify(raw)} compiles to ${expectedLimit} and ${
      expectedMessage ? 'warns' : 'says nothing'
    }`, () => {
      expect(compileFindOptions(makeState({ limit: raw })).limit).toBe(expectedLimit);
      const warning = limitWarning(raw);
      if (expectedMessage === null) {
        expect(warning).toBeNull();
      } else {
        expect(warning).toMatch(expectedMessage);
      }
    });
  }

  it('a whitespace-padded honest limit is not flagged', () => {
    expect(limitWarning(' 25 ')).toBeNull();
    expect(compileFindOptions(makeState({ limit: ' 25 ' })).limit).toBe(25);
  });
});

describe('isCompilableOp / FIELD_OPS', () => {
  it('isCompilableOp covers the trivial-shape ops', () => {
    for (const op of ['$eq', '$ne', '$in', '$regex', '$type', '$mod', '$size', '$bitsAllClear']) {
      expect(isCompilableOp(op)).toBe(true);
    }
  });

  it('isCompilableOp rejects object-shape ops', () => {
    for (const op of ['$elemMatch', '$text', '$expr', '$geoWithin', '$jsonSchema']) {
      expect(isCompilableOp(op)).toBe(false);
    }
  });

  it('FIELD_OPS is exactly the documented table, per valType', () => {
    // A single exact-match assertion over the whole table, rather than spot
    // checks — spot checks leave every op the check doesn't happen to name
    // free to drift (added, removed, or swapped) without a test noticing.
    expect(FIELD_OPS).toEqual({
      string: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$regex', '$exists', '$type'],
      number: [
        '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type', '$mod',
        '$bitsAllClear', '$bitsAnyClear', '$bitsAllSet', '$bitsAnySet',
      ],
      long: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type'],
      decimal: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type'],
      boolean: ['$eq', '$ne', '$exists', '$type'],
      date: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$exists', '$type'],
      null: ['$eq', '$ne', '$exists', '$type'],
      regex: ['$regex', '$exists', '$type'],
      objectid: ['$eq', '$ne', '$in', '$nin', '$exists', '$type'],
      array: ['$in', '$nin', '$all', '$exists', '$type', '$size'],
    });
  });

  it('opForValType keeps the caller\'s current op when it is still applicable', () => {
    expect(opForValType('string', '$regex')).toBe('$regex');
  });

  it('opForValType falls back to the valType\'s first op when the current one no longer applies', () => {
    expect(opForValType('number', '$regex')).toBe('$eq');
    expect(opForValType('array', '$regex')).toBe('$in');
  });
});

describe('valTypeFromDisplayType', () => {
  it('maps every known DisplayType to its ValType 1:1', () => {
    const cases: Array<[Parameters<typeof valTypeFromDisplayType>[0], ReturnType<typeof valTypeFromDisplayType>]> = [
      ['objectid', 'objectid'],
      ['date', 'date'],
      ['long', 'long'],
      ['decimal', 'decimal'],
      ['number', 'number'],
      ['boolean', 'boolean'],
      ['null', 'null'],
      ['regex', 'regex'],
      ['array', 'array'],
    ];
    for (const [dt, expected] of cases) {
      expect(valTypeFromDisplayType(dt)).toBe(expected);
    }
  });

  it('falls back to string for object/binary/undefined/unknown', () => {
    expect(valTypeFromDisplayType('object')).toBe('string');
    expect(valTypeFromDisplayType('binary')).toBe('string');
    expect(valTypeFromDisplayType(undefined)).toBe('string');
  });
});

describe('condFromDragged', () => {
  it('plain JS number → number cond', () => {
    const cond = condFromDragged({ field: 'qty', value: 5 });
    expect(cond.valType).toBe('number');
    expect(cond.value).toBe('5');
    expect(cond.op).toBe('$eq');
  });

  it('canonical $numberInt → number cond (not stringified object)', () => {
    const cond = condFromDragged({ field: 'qty', value: { $numberInt: '5' } });
    expect(cond.valType).toBe('number');
    expect(cond.value).toBe('5');
  });

  it('canonical $numberDouble → number cond', () => {
    const cond = condFromDragged({ field: 'price', value: { $numberDouble: '3.14' } });
    expect(cond.valType).toBe('number');
    expect(cond.value).toBe('3.14');
  });

  it('$numberLong → long cond preserving the exact integer string (#2.4)', () => {
    // 9007199254740993 = 2^53 + 1 — not representable as a JS double.
    const cond = condFromDragged({ field: 'big', value: { $numberLong: '9007199254740993' } });
    expect(cond.valType).toBe('long');
    expect(cond.value).toBe('9007199254740993');
  });

  it('$numberDecimal → decimal cond preserving the exact string (#2.10)', () => {
    const cond = condFromDragged({ field: 'price', value: { $numberDecimal: '9.99' } });
    expect(cond.valType).toBe('decimal');
    expect(cond.value).toBe('9.99');
  });

  it('$oid → objectid cond with hex value', () => {
    const cond = condFromDragged({ field: '_id', value: { $oid: '507f1f77bcf86cd799439011' } });
    expect(cond.valType).toBe('objectid');
    expect(cond.value).toBe('507f1f77bcf86cd799439011');
  });

  it('plain string → string cond', () => {
    const cond = condFromDragged({ field: 'name', value: 'alice' });
    expect(cond.valType).toBe('string');
    expect(cond.value).toBe('alice');
  });

  it('null → null cond with empty value', () => {
    const cond = condFromDragged({ field: 'x', value: null });
    expect(cond.valType).toBe('null');
    expect(cond.value).toBe('');
  });

  it('boolean → boolean cond stringified', () => {
    expect(condFromDragged({ field: 'active', value: true }).value).toBe('true');
    expect(condFromDragged({ field: 'active', value: false }).value).toBe('false');
    expect(condFromDragged({ field: 'active', value: true }).valType).toBe('boolean');
  });

  it('$regex sentinel → regex cond with just the pattern (no slashes/options)', () => {
    const cond = condFromDragged({ field: 'name', value: { $regex: '^acme', $options: 'i' } });
    expect(cond.valType).toBe('regex');
    expect(cond.value).toBe('^acme');
  });

  it('array → array cond, JSON-stringified', () => {
    const cond = condFromDragged({ field: 'tags', value: [1, 'a', true] });
    expect(cond.valType).toBe('array');
    expect(cond.value).toBe('[1,"a",true]');
  });

  it('a plain nested object (no matching valType) → JSON-stringified as the fallback', () => {
    const cond = condFromDragged({ field: 'meta', value: { nested: 1 } });
    expect(cond.value).toBe('{"nested":1}');
  });

  it('$date sentinel → date cond with the ISO display string', () => {
    const cond = condFromDragged({ field: 'createdAt', value: { $date: '2024-01-15T00:00:00.000Z' } });
    expect(cond.valType).toBe('date');
    expect(cond.value).toBe('2024-01-15T00:00:00.000Z');
  });

  it('a $regex-shaped value whose pattern is not a string never reaches the regex branch', () => {
    // toDisplayValue only assigns 'regex' when $regex is itself a string, so a
    // { $regex: 123 } object falls through to the generic-object fallback
    // (JSON-stringified), not the regex branch's `r` extraction.
    const cond = condFromDragged({ field: 'name', value: { $regex: 123 } });
    expect(cond.valType).not.toBe('regex');
    expect(cond.value).toBe('{"$regex":123}');
  });
});

describe('mergeOrReplaceDragged', () => {
  const eqCond = (field: string, valType: 'number' | 'string', value: string): FilterNode => ({
    kind: 'cond', field, op: '$eq', valType, value,
  });

  it('replaces (not merges) when the target field differs', () => {
    const target = eqCond('a', 'number', '1');
    const result = mergeOrReplaceDragged(target, { field: 'b', value: 5 });
    expect(result.field).toBe('b');
    expect(result.op).toBe('$eq');
  });

  it('replaces when the target op is not mergeable (e.g. $gt)', () => {
    const target: FilterNode = { kind: 'cond', field: 'a', op: '$gt', valType: 'number', value: '1' };
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 5 });
    expect(result.op).toBe('$eq');
    expect(result.value).toBe('5');
  });

  it('replaces when the target is a raw clause, not a cond', () => {
    const target: FilterNode = { kind: 'raw', json: '{}' };
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 5 });
    expect(result.field).toBe('a');
  });

  it('replaces an $in row whose current text is not valid JSON, rather than merging into it', () => {
    const target: FilterNode = { kind: 'cond', field: 'a', op: '$in', valType: 'number', value: 'not json' };
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 5 });
    expect(result.op).toBe('$eq');
    expect(result.value).toBe('5');
  });

  it('merges a matching $eq row into a fresh $in array', () => {
    const target = eqCond('a', 'number', '1');
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 2 });
    expect(result.op).toBe('$in');
    expect(result.valType).toBe('array');
    expect(JSON.parse(result.value) as unknown[]).toEqual([1, 2]);
  });

  it('merges into an existing $in array, appending the new element', () => {
    const target: FilterNode = { kind: 'cond', field: 'a', op: '$in', valType: 'number', value: '[1,2]' };
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 3 });
    expect(JSON.parse(result.value) as unknown[]).toEqual([1, 2, 3]);
  });

  it('$nin stays $nin after merging', () => {
    const target: FilterNode = { kind: 'cond', field: 'a', op: '$nin', valType: 'number', value: '[1]' };
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 2 });
    expect(result.op).toBe('$nin');
  });

  it('an array-valType $in row treats each element as already-wire-encoded (no re-coercion)', () => {
    const target: FilterNode = { kind: 'cond', field: 'a', op: '$in', valType: 'array', value: '[[1,2],[3]]' };
    const result = mergeOrReplaceDragged(target, { field: 'a', value: [4, 5] });
    expect(JSON.parse(result.value) as unknown[]).toEqual([[1, 2], [3], [4, 5]]);
  });

  it('a duplicate dragged value is not appended twice', () => {
    const target: FilterNode = { kind: 'cond', field: 'a', op: '$in', valType: 'number', value: '[1,2]' };
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 2 });
    expect(JSON.parse(result.value) as unknown[]).toEqual([1, 2]);
  });

  it('falls back to replace when merging would commit NaN→null for an unparsable number', () => {
    const target = eqCond('a', 'number', 'not-a-number');
    const result = mergeOrReplaceDragged(target, { field: 'a', value: 5 });
    expect(result.op).toBe('$eq');
    expect(result.value).toBe('5');
  });

  it('an objectid $in row coerces a bare unwrapped string element to $oid on merge', () => {
    // A bare "abc" (not yet { $oid: "abc" }) is what an older/hand-edited row
    // can hold; coerceArrayElementWire must wrap it before appending.
    const target: FilterNode = { kind: 'cond', field: '_id', op: '$in', valType: 'objectid', value: '["abc"]' };
    const result = mergeOrReplaceDragged(target, {
      field: '_id',
      value: { $oid: '507f1f77bcf86cd799439011' },
    });
    expect(JSON.parse(result.value) as unknown[]).toEqual([
      { $oid: 'abc' },
      { $oid: '507f1f77bcf86cd799439011' },
    ]);
  });
});

describe('DRAGGED_FIELD_MIME', () => {
  it('is the fixed MIME type drag payloads are tagged with', () => {
    expect(DRAGGED_FIELD_MIME).toBe('application/x-atelier-field');
  });
});

describe('effectivePageLimit', () => {
  it('falls back to pageSize when userLimit is null', () => {
    expect(effectivePageLimit(null, 0, 50)).toEqual({ skip: 0, limit: 50 });
    expect(effectivePageLimit(null, 3, 50)).toEqual({ skip: 150, limit: 50 });
  });

  it('caps limit when userLimit is smaller than pageSize on page 0', () => {
    expect(effectivePageLimit(2, 0, 50)).toEqual({ skip: 0, limit: 2 });
  });

  it('paginates within a userLimit larger than pageSize', () => {
    // userLimit=120, pageSize=50: 50 / 50 / 20 across pages 0-2.
    expect(effectivePageLimit(120, 0, 50)).toEqual({ skip: 0, limit: 50 });
    expect(effectivePageLimit(120, 1, 50)).toEqual({ skip: 50, limit: 50 });
    expect(effectivePageLimit(120, 2, 50)).toEqual({ skip: 100, limit: 20 });
  });

  it('returns limit=0 when the page starts past the cap', () => {
    expect(effectivePageLimit(10, 1, 50)).toEqual({ skip: 50, limit: 0 });
    expect(effectivePageLimit(120, 3, 50)).toEqual({ skip: 150, limit: 0 });
  });
});

describe('parseSortString', () => {
  it('returns empty for empty/whitespace input', () => {
    expect(parseSortString('')).toEqual({});
    expect(parseSortString('   ')).toEqual({});
  });

  it('trims NBSP padding before parsing a real sort document', () => {
    // Plain spaces around valid JSON parse fine even without .trim() (JSON's
    // own whitespace grammar tolerates them), so that padding can't catch a
    // missing .trim(). NBSP (U+00A0) is whitespace to .trim() but NOT to
    // JSON's grammar, so only a real .trim() call lets this parse.
    expect(parseSortString(' {"name":1} ')).toEqual({ name: 1 });
  });

  it('treats NBSP-only input as blank too (broader than JSON.parse\'s own whitespace grammar)', () => {
    // NBSP (U+00A0) is whitespace under String.prototype.trim() but not
    // under JSON's own whitespace grammar, so the untrimmed string would
    // otherwise reach JSON.parse and throw instead of short-circuiting to {}.
    expect(parseSortString('\u00A0')).toEqual({});
  });

  it('a bare JSON scalar (not an object) is rejected, not treated as a sort map', () => {
    expect(parseSortString('"1"')).toEqual({});
    expect(parseSortString('42')).toEqual({});
  });

  it('returns empty for unparseable input', () => {
    expect(parseSortString('not json')).toEqual({});
    expect(parseSortString('[1, 2]')).toEqual({});
    expect(parseSortString('null')).toEqual({});
  });

  it('parses single- and multi-field sorts', () => {
    expect(parseSortString('{"name":1}')).toEqual({ name: 1 });
    expect(parseSortString('{"name":1,"age":-1}')).toEqual({ name: 1, age: -1 });
  });

  it('accepts "asc"/"desc" strings (case-insensitive)', () => {
    expect(parseSortString('{"name":"asc","age":"DESC"}')).toEqual({
      name: 1,
      age: -1,
    });
    expect(parseSortString('{"a":"Ascending","b":"descending"}')).toEqual({
      a: 1,
      b: -1,
    });
  });

  it('drops numbers other than ±1, which the driver refuses', () => {
    expect(parseSortString('{"a":2,"b":-7}')).toEqual({});
  });

  it('drops fields with shapes we don\'t model (e.g. $meta textScore)', () => {
    // `{$meta:"textScore"}` is valid Mongo, but it isn't a direction we can
    // cycle from the table header, so we leave it out of the map.
    expect(
      parseSortString('{"name":1,"score":{"$meta":"textScore"}}'),
    ).toEqual({ name: 1 });
  });

  it('accepts exact "1"/"-1" string directions', () => {
    expect(parseSortString('{"a":"1","b":"-1"}')).toEqual({ a: 1, b: -1 });
  });

  it('drops a field whose direction is 0 (no direction)', () => {
    expect(parseSortString('{"a":0,"b":1}')).toEqual({ b: 1 });
  });

  it('drops a field whose direction is a non-finite number', () => {
    expect(parseSortString('{"a":1e999,"b":1}')).toEqual({ b: 1 });
  });

  it('drops a fractional direction, which the driver refuses', () => {
    expect(parseSortString('{"a":0.5,"b":-0.5}')).toEqual({});
  });

  it('drops a field whose direction string is unrecognized', () => {
    expect(parseSortString('{"a":"bogus","b":1}')).toEqual({ b: 1 });
  });

  it('a parsed non-document (e.g. a bare number) yields an empty map', () => {
    expect(parseSortString('5')).toEqual({});
    expect(parseSortString('"a string"')).toEqual({});
  });

  it('a null raw input is treated as empty, not a crash', () => {
    expect(parseSortString(null as unknown as string)).toEqual({});
  });

  // The driver decides what runs: `prepareDirection` in
  // node_modules/mongodb/lib/sort.js accepts a direction only when its
  // lowercased string form is one of the six words below (plus `{$meta}`,
  // which has no ±1 to draw). Anything it would throw on draws no arrow.
  it.each([
    ['1', 1],
    ['-1', -1],
    ['"1"', 1],
    ['"-1"', -1],
    ['"asc"', 1],
    ['"desc"', -1],
    ['"ascending"', 1],
    ['"descending"', -1],
    ['"ASC"', 1],
    ['"Descending"', -1],
    ['{"$numberInt":"1"}', 1],
    ['{"$numberInt":"-1"}', -1],
    ['{"$numberLong":"1"}', 1],
    ['{"$numberDouble":"-1.0"}', -1],
    ['{"$numberDecimal":"1"}', 1],
  ] as const)('accepts the driver direction %s', (dir, expected) => {
    expect(parseSortString('{"f":' + dir + '}')).toEqual({ f: expected });
  });

  it.each([
    '2',
    '-7',
    '0.5',
    '0',
    '1.5',
    '" asc"',
    '"asc "',
    '"+1"',
    '"1.0"',
    'true',
    'null',
    '"bogus"',
    '"constructor"',
    '"__proto__"',
    '{"$numberInt":"2"}',
    '{"$meta":"textScore"}',
    '{"x":1}',
    '[1]',
    '[{"x":1}]',
  ])('drops the driver-refused direction %s', (dir) => {
    expect(parseSortString('{"f":' + dir + ',"g":1}')).toEqual({ g: 1 });
  });

  it('a lone EJSON sentinel is a value, not a sort document', () => {
    expect(parseSortString('{"$numberInt":"1"}')).toEqual({});
  });
});

/**
 * W15 §3.2 / §12 case 2 — the classification that drives the table
 * header's sort state.
 *
 * The bug it exists to prevent: `parseSortString` answers `{}` for everything
 * it can't model, so the header could not tell "no sort" from "a sort I can't
 * draw" and rendered both as unsorted. Each case below is a string that
 * reaches the header today and must not read as "unsorted".
 */
describe('classifySort', () => {
  it('empty text is no sort', () => {
    expect(classifySort('')).toBe('none');
    expect(classifySort('   ')).toBe('none');
  });

  it('a null raw input is treated as no sort, not a crash', () => {
    expect(classifySort(null as unknown as string)).toBe('none');
  });

  it('`{}` is no sort — it is what Mongo itself reads as unsorted', () => {
    expect(classifySort('{}')).toBe('none');
  });

  it('every key modelled is a fully mapped sort', () => {
    expect(classifySort('{"name":1}')).toBe('mapped');
    expect(classifySort('{"name":1,"age":-1}')).toBe('mapped');
    // String directions the driver accepts count as mapped.
    expect(classifySort('{"name":"asc","age":"desc"}')).toBe('mapped');
  });

  it('a $meta key alongside a plain one is partially mapped', () => {
    // `parseSortString` keeps `name` and drops `score`; the per-column arrow
    // on `name` alone would claim the whole sort is drawn.
    expect(classifySort('{"name":1,"score":{"$meta":"textScore"}}')).toBe('partial');
  });

  it('a sort made only of shapes the map drops is unrepresentable', () => {
    expect(classifySort('{"score":{"$meta":"textScore"}}')).toBe('unrepresentable');
  });

  // Was: "EJSON that parses but is not a document is unrepresentable, not
  // absent", justified by "Mongo throws on them". It does not — testing verified
  // that the driver runs the query UNSORTED — so the header was announcing
  // "Sorted by a rule this header cannot show" over rows in insertion order.
  // These are refused before they run now, which is `'invalid'`.
  it('EJSON that parses but is not a document is invalid, not a sort in effect', () => {
    for (const raw of ['[1,2]', 'null', '42', '"abc"']) {
      expect([raw, classifySort(raw)]).toEqual([raw, 'invalid']);
    }
  });

  it('the one sort that really is unrepresentable still is', () => {
    // `{ $meta: … }` is a genuine sort the per-column arrows cannot draw —
    // the case the state exists for, and the one that must not be collapsed
    // into `'invalid'` along with the fakes above.
    expect(sortProblem('{"score":{"$meta":"textScore"}}')).toBeNull();
    expect(classifySort('{"score":{"$meta":"textScore"}}')).toBe('unrepresentable');
  });

  it('text the shared gate refuses is invalid', () => {
    expect(classifySort('{"a":1')).toBe('invalid');
    expect(classifySort('nonsense')).toBe('invalid');
  });

  it('a direction the driver refuses is invalid, not an undrawable sort', () => {
    expect(classifySort('{"a":2}')).toBe('invalid');
    expect(classifySort('{"a":1,"b":" asc"}')).toBe('invalid');
  });

  it('EJSON number directions are drawn like plain ones', () => {
    expect(classifySort('{"a":{"$numberInt":"1"},"b":{"$numberLong":"-1"}}')).toBe('mapped');
  });

  it('agrees with the gate on every input: `invalid` iff `sortProblem` complains', () => {
    // The two must not drift — that divergence is the whole reason
    // this rule was centralised. A classifier with its own parser would pass every
    // case above and still fail this one.
    for (const raw of [
      '',
      '{}',
      '{"a":1}',
      '{"a":1,"b":{"$meta":"textScore"}}',
      '[1,2]',
      'null',
      '{"a":1',
      'nonsense',
      '{"$oid":"not-an-oid"}',
      '{"a":2}',
      '{"a":"asc","b":{"$numberInt":"-1"}}',
    ]) {
      expect([raw, classifySort(raw) === 'invalid']).toEqual([raw, sortProblem(raw) !== null]);
    }
  });
});

/**
 * W15 §3.2 — the second input, and the one silence left unhandled.
 *
 * Everything above calls `classifySort` with one argument, and keeps its
 * old answer. That is the contract: the default is "every mapped key is
 * drawn", which is exactly what the function assumed before column
 * visibility entered the picture.
 *
 * The defect: `{"createdAt":-1}` maps perfectly, so the header stayed silent
 * — while the user had hidden `createdAt` and no arrow existed anywhere. The
 * table read identically to an unsorted one over sorted rows.
 */
describe('classifySort — columns the user has hidden', () => {
  const shown = (...fields: string[]) => new Set(fields);

  it('a mapped sort on a hidden column is not "mapped" — nothing is drawn', () => {
    expect(classifySort('{"createdAt":-1}', shown('_id', 'name'))).toBe('hidden');
  });

  it('the same sort with its column shown stays silent', () => {
    expect(classifySort('{"createdAt":-1}', shown('_id', 'createdAt'))).toBe('mapped');
  });

  it('hiding one key of a multi-field sort is the same "some are missing" as $meta', () => {
    expect(classifySort('{"name":1,"age":-1}', shown('name'))).toBe('partial');
  });

  it('separates "hidden" from "unrepresentable" — one has a fix, the other does not', () => {
    // Both draw zero arrows. Only the first is repaired by the column
    // chooser, and telling a `$meta` user to unhide a column, or a hidden-
    // column user that the header "cannot show" their sort, is the §3.2
    // defect in a new costume.
    expect(classifySort('{"name":1}', shown())).toBe('hidden');
    expect(classifySort('{"score":{"$meta":"textScore"}}', shown('name'))).toBe('unrepresentable');
  });

  it('an empty shown-set does not turn "no sort" into a sort', () => {
    expect(classifySort('', shown())).toBe('none');
    expect(classifySort('{}', shown())).toBe('none');
  });

  it('invalid text stays invalid regardless of which columns are up', () => {
    expect(classifySort('{"a":1', shown())).toBe('invalid');
    expect(classifySort('[1,2]', shown('a'))).toBe('invalid');
  });

  it('omitting the set means "every mapped key is drawn"', () => {
    // Pins the default rather than trusting it: this is what keeps every
    // era call above answering as it did.
    expect(classifySort('{"name":1,"age":-1}')).toBe(
      classifySort('{"name":1,"age":-1}', shown('name', 'age')),
    );
  });
});

/**
 * W15 §3.2 — splitting `'hidden'`, for the same reason
 * `'unrepresentable'` was split.
 *
 * That earlier split called every undrawn-but-mappable key `'hidden'` and pointed the user
 * at the column chooser. But the columns are derived from the returned
 * documents, so a sort key the *projection* excluded is undrawn too — and the
 * chooser, built from that same derived list, has nothing to offer. The
 * header gave advice that could not be followed.
 *
 * `shownFields ⊆ schemaFields` always (field columns are the derived list
 * minus the hidden ones), so the only question the second set answers is
 * whether unhiding could help.
 */
describe('classifySort — a sort field that is not in the result schema', () => {
  const set = (...f: string[]) => new Set(f);

  it('hidden by config is still hidden — the chooser can bring it back', () => {
    expect(classifySort('{"name":1}', set('_id'), set('_id', 'name'))).toBe('hidden');
  });

  it('missing from the schema is absent — the chooser cannot bring it back', () => {
    expect(classifySort('{"createdAt":-1}', set('_id', 'name'), set('_id', 'name'))).toBe(
      'absent',
    );
  });

  it('one key hidden and one absent still counts as hidden — a remedy exists', () => {
    // `name` is unhideable-back, `createdAt` is not there at all. Naming the
    // actionable one is right; claiming nothing can be done would be false.
    expect(
      classifySort('{"name":1,"createdAt":-1}', set('_id'), set('_id', 'name')),
    ).toBe('hidden');
  });

  it('omitting the schema keeps the schema-less behaviour exactly', () => {
    // A caller whose columns are its whole schema has no third state to
    // reach, and every pre-schema-aware two-argument call above must keep answering.
    expect(classifySort('{"createdAt":-1}', set('_id', 'name'))).toBe('hidden');
  });

  it('does not disturb the states that never depended on the schema', () => {
    const schema = set('_id', 'name');
    expect(classifySort('', set(), schema)).toBe('none');
    expect(classifySort('{}', set(), schema)).toBe('none');
    expect(classifySort('{"name":1}', set('name'), schema)).toBe('mapped');
    expect(classifySort('{"a":1', set(), schema)).toBe('invalid');
    // Nothing mapped at all: no column, hidden or otherwise, would draw it.
    expect(classifySort('{"score":{"$meta":"textScore"}}', set('name'), schema)).toBe(
      'unrepresentable',
    );
  });
});

/**
 * W15 §1.1 — the one question "is this query runnable", asked once.
 *
 * Copy code emitted composition state without checking it, so a filter, sort
 * or raw projection that will not run was copied as text that will not run.
 * The fix is not a fourth per-clause check on the copy path: `findProblem`
 * composes the three gates that already exist, and the Run button reads the
 * same function.
 */
describe('filterProblem', () => {
  it('is null for a runnable filter document', () => {
    expect(filterProblem('{"status":"active"}')).toBeNull();
  });

  it('names unparseable text specifically, with the expected-shape example', () => {
    expect(filterProblem('{"a":')).toBe(
      'Can\'t parse this filter. Expected EJSON like { "status": "active" }.',
    );
  });

  it('names a non-document (parseable but not a document) specifically', () => {
    expect(filterProblem('[1,2]')).toBe(
      'A filter must be a document, like { "status": "active" }.',
    );
  });

  for (const blank of ['', '   ', '\n\t']) {
    it(`names blank filter text ${JSON.stringify(blank)} as missing, not as unparseable`, () => {
      expect(filterProblem(blank)).toBe(
        'Enter a filter, like { "status": "active" }, or {} to match every document.',
      );
    });
  }
});

describe('findProblem', () => {
  const state = (over: Partial<CollectionTabState> = {}): CollectionTabState => ({
    view: 'Table',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    ...over,
  });

  it('a fully runnable query has no problem', () => {
    expect(
      findProblem(
        state({
          queryRaw: '{"status":"active"}',
          builder: { projection: [], sort: '{"createdAt":-1}', limit: '25' },
        }),
      ),
    ).toBeNull();
  });

  it('catches each clause on its own', () => {
    expect(findProblem(state({ queryRaw: '{"a":' }))).toMatch(/filter/i);

  // Reviewer feedback on the W15 base → `main` PR. The filter half only asked
  // "does this parse"; sort and projection both ask "is this a document". So
  // these left Run enabled and let Copy code emit a command, while later fixes
  // made main refuse them with VALIDATION — the renderer calling runnable
  // exactly what main rejects.
  });

  for (const raw of ['[1,2]', 'null', '42', '"abc"', 'true', '{"$oid":"507f1f77bcf86cd799439011"}']) {
    it(`refuses ${raw} as a filter, naming the filter`, () => {
      expect(findProblem(state({ queryRaw: raw }))).toBe(
        'A filter must be a document, like { "status": "active" }.',
      );
    });
  }

  it('still accepts a filter whose value is a nested sentinel', () => {
    expect(
      findProblem(state({ queryRaw: '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}' })),
    ).toBeNull();
    expect(
      findProblem(state({ builder: { projection: [], sort: '{"a":1', limit: '' } })),
    ).toMatch(/sort/i);
    expect(
      findProblem(
        state({ builder: { projection: [], sort: '', limit: '', projectionRaw: '{"_id": 0' } }),
      ),
    ).toMatch(/projection/i);
  });

  it('reports the first clause in command order, not an arbitrary one', () => {
    // All three broken at once. The message must name the filter — the thing
    // the user has to fix first — rather than whichever gate happens to be
    // checked first by accident.
    expect(
      findProblem(
        state({
          queryRaw: '{"a":',
          builder: { projection: [], sort: '{"b":1', limit: '', projectionRaw: '{"_id": 0' },
        }),
      ),
    ).toMatch(/filter/i);
  });

  it('delegates rather than re-deciding — it never disagrees with a clause gate', () => {
    // The point of the ticket: one rule, not a copy of one. A `findProblem`
    // with its own parser would pass every case above and fail this.
    for (const sort of ['', '{}', '{"a":1}', '{"a":1', '[1,2]', 'null', 'nonsense']) {
      const s = state({ builder: { projection: [], sort, limit: '' } });
      expect([sort, findProblem(s) !== null]).toEqual([sort, sortProblem(sort) !== null]);
    }
    for (const projectionRaw of ['', '{"_id":0}', '{"_id": 0', '[1,2]', 'nope']) {
      const builder = { projection: [], sort: '', limit: '', projectionRaw };
      expect([projectionRaw, findProblem(state({ builder })) !== null]).toEqual([
        projectionRaw,
        projectionProblem(builder) !== null,
      ]);
    }
  });

  it('blank filter text is a problem, matching the Run button that is already disabled', () => {
    // `isValidEjson('')` is false, so this is not a new rule — it is the rule
    // the button has always used. Pinned because "refusing to copy a blank
    // filter" would be a regression if it were ever otherwise.
    expect(findProblem(state({ queryRaw: '' }))).toMatch(/filter/i);
  });

  it('a blank filter stays a problem, with the missing-filter message, so Run stays closed', () => {
    // Blank must stay non-null: `findProblem` is the Run gate, and a null here
    // would enable Run, Explain and delete-all on an empty box.
    expect(findProblem(state({ queryRaw: '   ' }))).toBe(
      'Enter a filter, like { "status": "active" }, or {} to match every document.',
    );
  });
});

describe('cycleSortField', () => {
  it('first click adds ascending', () => {
    expect(cycleSortField('', 'name')).toBe('{"name":1}');
  });

  it('second click flips to descending', () => {
    expect(cycleSortField('{"name":1}', 'name')).toBe('{"name":-1}');
  });

  it('third click clears the sort', () => {
    expect(cycleSortField('{"name":-1}', 'name')).toBe('');
  });

  it('clicking a different field replaces existing sort with single field', () => {
    // Single-field cycle path. A multi-field sort is composed in the query
    // bar's advanced-row `sort` input (W15 §3.3) — this click replaces it.
    expect(cycleSortField('{"name":1}', 'age')).toBe('{"age":1}');
  });

  it('treats unparseable existing sort as empty', () => {
    expect(cycleSortField('not json', 'name')).toBe('{"name":1}');
  });
});

// W13 — the filter half of `isDefaultQueryState` becomes text-only
// (`queryRaw` blank or `'{}'`), but the sort/limit/projection checks MUST
// stay: dropping them would auto-run a restored saved query carrying a sort
// behind the user's back (an earlier regression). The last test in this block is
// the regression proof from ticket step 4/7 — it fails if that guard is
// ever removed.
describe('isDefaultQueryState', () => {
  it('is true for the default tab state', () => {
    expect(isDefaultQueryState(makeTabState())).toBe(true);
  });

  it('is false when the query text is non-empty JSON', () => {
    const state = makeTabState({ queryRaw: '{"a":1}' });
    expect(isDefaultQueryState(state)).toBe(false);
  });

  it('treats explicit empty raw JSON ({}) as still default', () => {
    const state = makeTabState({ queryRaw: '{}' });
    expect(isDefaultQueryState(state)).toBe(true);
  });

  it('treats whitespace-only raw JSON as still default', () => {
    const state = makeTabState({ queryRaw: '  ' });
    expect(isDefaultQueryState(state)).toBe(true);
  });

  it('is false when a sort is set — regression guard', () => {
    // This is the test that must fail if isDefaultQueryState ever stops
    // checking sort/limit/projection (ticket step 4/7). Verified live:
    // collapsing the function to `return isDefaultFilter;` (dropping the
    // sort/limit/projection conjuncts) turns this failure:
    //   AssertionError: expected true to be false
    //   - false
    //   + true
    // Restoring the conjuncts makes it pass again.
    const state = makeTabState({
      builder: { ...emptyBuilder(), sort: '{"name":1}' },
    });
    expect(isDefaultQueryState(state)).toBe(false);
  });

  it('is false when a limit is set', () => {
    const state = makeTabState({
      builder: { ...emptyBuilder(), limit: '10' },
    });
    expect(isDefaultQueryState(state)).toBe(false);
  });

  it('is false when a raw projection is set', () => {
    // Same auto-run rule as sort: a restored tab that already carries a raw
    // projection is not "untouched", so it must not auto-run on open.
    const state = makeTabState({
      builder: { ...emptyBuilder(), projectionRaw: '{"_id":0}' },
    });
    expect(isDefaultQueryState(state)).toBe(false);
  });

  it('is false when a projection is set', () => {
    const state = makeTabState({
      builder: { ...emptyBuilder(), projection: ['name'] },
    });
    expect(isDefaultQueryState(state)).toBe(false);
  });

  it('is still true when projectionRaw is whitespace-only (not "set")', () => {
    const state = makeTabState({
      builder: { ...emptyBuilder(), projectionRaw: '   ' },
    });
    expect(isDefaultQueryState(state)).toBe(true);
  });
});

// `ResultViewer`'s empty-collection CTA discriminator: no filter, first
// page, no error. Each conjunct is proven independently so a `&&` weakened
// to `||`, or an equality flipped, fails one of these.
describe('isUnfilteredFirstPage', () => {
  it('is true for the default tab state (no filter, page 0, no run error)', () => {
    expect(isUnfilteredFirstPage(makeTabState())).toBe(true);
  });

  it('is true for an explicit whitespace-only queryRaw too', () => {
    expect(isUnfilteredFirstPage(makeTabState({ queryRaw: '  ' }))).toBe(true);
  });

  it('is false when the filter is non-default', () => {
    expect(isUnfilteredFirstPage(makeTabState({ queryRaw: '{"a":1}' }))).toBe(false);
  });

  it('is false past the first page', () => {
    expect(isUnfilteredFirstPage(makeTabState({ page: 1 }))).toBe(false);
  });

  it('is false when the last run errored', () => {
    const state = makeTabState({
      lastRun: { documents: [], durationMs: 1, ranAt: '2026-01-01T00:00:00.000Z', error: { code: 'MONGO_ERROR', message: 'x' } },
    });
    expect(isUnfilteredFirstPage(state)).toBe(false);
  });

  it('requires every condition at once — a non-default filter on page 0 is still false', () => {
    expect(isUnfilteredFirstPage(makeTabState({ queryRaw: '{"a":1}', page: 0 }))).toBe(false);
  });
});

describe('projectionProblem', () => {
  it('is null when projectionRaw is undefined, empty, or whitespace-only', () => {
    expect(projectionProblem({ ...emptyBuilder() })).toBeNull();
    expect(projectionProblem({ ...emptyBuilder(), projectionRaw: '' })).toBeNull();
    expect(projectionProblem({ ...emptyBuilder(), projectionRaw: '   ' })).toBeNull();
  });

  it('is null for a valid raw projection', () => {
    expect(projectionProblem({ ...emptyBuilder(), projectionRaw: '{"_id":0}' })).toBeNull();
  });

  it('names the projection when it cannot be parsed', () => {
    expect(projectionProblem({ ...emptyBuilder(), projectionRaw: '{"_id":0' })).toMatch(/projection/i);
  });
});

// W13 drops the DIRTY branch entirely: sort is a builder-only field
// now and never recompiles `queryRaw`.
describe('sortFieldPatch', () => {
  it('patches only the builder — never touches queryRaw', () => {
    const state = makeTabState({ queryRaw: '{"a":1}', builder: makeState() });
    const patch = sortFieldPatch(state, 'age');
    expect(patch.builder?.sort).toBe('{"age":1}');
    expect('queryRaw' in patch).toBe(false);
  });

  it('cycles asc → desc → off', () => {
    const base = makeTabState({ queryRaw: '{}' });
    const asc = sortFieldPatch(base, 'age');
    expect(asc.builder?.sort).toBe('{"age":1}');
    const desc = sortFieldPatch({ ...base, builder: asc.builder! }, 'age');
    expect(desc.builder?.sort).toBe('{"age":-1}');
    const off = sortFieldPatch({ ...base, builder: desc.builder! }, 'age');
    expect(off.builder?.sort).toBe('');
  });
});

// W13 — `queryRaw` is the single source of truth for the filter now.
// `currentFilterJson` returns `null` for blank/invalid text, and `'{}'` for
// the empty filter, as-is — never widened. This is the fail-open lesson:
// a `?? '{}'` anywhere in this resolver turns "I can't run this"
// into "match every document in the collection", and delete-all reads this
// same resolver.
describe('currentFilterJson', () => {
  it('returns the trimmed queryRaw text for a valid filter', () => {
    const state = makeTabState({ queryRaw: '{"status":"pending"}' });
    expect(currentFilterJson(state)).toBe('{"status":"pending"}');
  });

  it('returns "{}" as-is for the empty filter — never nulled', () => {
    expect(currentFilterJson(makeTabState({ queryRaw: '{}' }))).toBe('{}');
  });

  it('trims surrounding whitespace before returning it', () => {
    expect(currentFilterJson(makeTabState({ queryRaw: '  {"a":1}  ' }))).toBe('{"a":1}');
  });

  it('returns null for a whitespace-only queryRaw', () => {
    expect(currentFilterJson(makeTabState({ queryRaw: '   ' }))).toBeNull();
  });

  // Codex, base → `main`, second pass. Disabling the Run button for `[1,2]`
  // was not enough: ⌘↵ in the drawer, the palette's `query.run` and post-write
  // re-runs never touch the button and all resolve their filter here, so the
  // button said "not runnable" while every button-less path still sent it to
  // main for an avoidable VALIDATION. Delete-all reads this too — a
  // non-document filter must not reach it either.
  for (const raw of ['[1,2]', 'null', '42', '"abc"', 'true', '{"$oid":"507f1f77bcf86cd799439011"}']) {
    it(`returns null for ${raw} — parseable, but not a document`, () => {
      expect(currentFilterJson(makeTabState({ queryRaw: raw }))).toBeNull();
    });
  }

  it('still accepts a document whose value is a sentinel', () => {
    expect(
      currentFilterJson(makeTabState({ queryRaw: '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}' })),
    ).toBe('{"_id":{"$oid":"507f1f77bcf86cd799439011"}}');
  });

  it('returns null for blank/whitespace-only text', () => {
    // This is the regression proof from ticket step 4/7: it fails if a
    // `?? '{}'` (or any other collapsing fallback) is reintroduced here.
    // Verified live: swapping the body for `return state.queryRaw.trim() ||
    // '{}';` turns this failure (and the same shape on the next two tests):
    //   AssertionError: expected '{}' to be null
    //   - null
    //   + "{}"
    // Restoring the guard makes all three pass again.
    for (const raw of ['', '   ', '\n']) {
      expect(currentFilterJson(makeTabState({ queryRaw: raw }))).toBeNull();
    }
  });

  it('returns null for invalid EJSON text — the case a blank-only check would miss', () => {
    // A rewrite that only checks for blank text (dropping the `isValidEjson`
    // half) would let this fall through to a truthy, non-'{}' string instead
    // of null — passing the "does it ever equal {}" check while still
    // regressing the contract. Assert the literal return value, not just
    // inequality with '{}', so that failure mode can't slip through.
    expect(currentFilterJson(makeTabState({ queryRaw: '{oops' }))).toBeNull();
  });

  it('never collapses null into {} across every refusal case', () => {
    for (const raw of ['', '   ', '{oops', 'not json at all']) {
      const result = currentFilterJson(makeTabState({ queryRaw: raw }));
      expect(result).toBeNull();
      expect(result).not.toBe('{}');
    }
  });
});

// A stray write (`DEFAULT_COLLECTION_TAB_STATE.page = 5`) would otherwise
// leak into every tab seeded from the default afterwards.
describe('DEFAULT_COLLECTION_TAB_STATE', () => {
  it('is frozen, builder included', () => {
    expect(Object.isFrozen(DEFAULT_COLLECTION_TAB_STATE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_COLLECTION_TAB_STATE.builder)).toBe(true);
  });
});
