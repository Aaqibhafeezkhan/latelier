import { describe, it, expect } from 'vitest';
import {
  checkFieldType,
  inferType,
  summarizeSchema,
} from '../../src/pages/Workspace/schemaSummary';
import type { SchemaSampleEntry } from '@shared/types';

describe('summarizeSchema', () => {
  it('aggregates field paths and BSON-shaped types from a sample', () => {
    const docs = [
      { _id: { $oid: 'a' }, name: 'A', count: 1 },
      { _id: { $oid: 'b' }, name: 'B', count: 2 },
      { _id: { $oid: 'c' }, name: 'C' },
    ];
    const out = summarizeSchema(docs);
    const byPath = Object.fromEntries(out.map((e) => [e.path, e]));
    expect(byPath._id).toBeDefined();
    expect(byPath._id!.types).toEqual({ objectid: 3 });
    expect(byPath.name!.types).toEqual({ string: 3 });
    expect(byPath.count!.frequency).toBeCloseTo(2 / 3);
  });

  it('puts _id first regardless of frequency', () => {
    const docs = [{ _id: 1, b: 2, a: 3 }];
    const out = summarizeSchema(docs);
    expect(out[0]!.path).toBe('_id');
  });

  it('records null and missing as distinct outcomes', () => {
    const docs = [
      { x: 'a' },
      { x: null },
      {}, // x absent — shouldn't count as a type, only lowers frequency
    ];
    const out = summarizeSchema(docs);
    const x = out.find((e) => e.path === 'x')!;
    expect(x.types).toEqual({ string: 1, null: 1 });
    expect(x.frequency).toBeCloseTo(2 / 3);
  });

  it('walks one level of nested documents', () => {
    const docs = [
      { addr: { city: 'NYC', zip: '10001' } },
      { addr: { city: 'LA' } },
    ];
    const paths = summarizeSchema(docs).map((e) => e.path).sort();
    expect(paths).toContain('addr');
    expect(paths).toContain('addr.city');
    expect(paths).toContain('addr.zip');
  });

  it('walks one level into array elements', () => {
    const docs = [
      { items: [{ qty: 1 }, { qty: 2 }] },
      { items: [{ qty: 3 }] },
    ];
    const out = summarizeSchema(docs);
    const itemsQty = out.find((e) => e.path === 'items.qty');
    expect(itemsQty).toBeDefined();
    // Both documents have items.qty as a number → type:number = 2 (one per
    // doc, not per element) and frequency = 1.0.
    expect(itemsQty!.types).toEqual({ number: 2 });
    expect(itemsQty!.frequency).toBe(1);
  });

  it('caps frequency at 100% even when nested arrays repeat the same field many times', () => {
    const docs = [
      { items: [{ qty: 1 }, { qty: 2 }, { qty: 3 }, { qty: 4 }, { qty: 5 }] },
      { items: [{ qty: 6 }] },
    ];
    const out = summarizeSchema(docs);
    const itemsQty = out.find((e) => e.path === 'items.qty');
    expect(itemsQty!.frequency).toBe(1);
    expect(itemsQty!.types).toEqual({ number: 2 });
  });

  it('counts a path once per document even when present at multiple shapes in one array', () => {
    const docs = [
      { items: [{ qty: 1 }, { qty: '2' }, { qty: null }] },
    ];
    const out = summarizeSchema(docs);
    const itemsQty = out.find((e) => e.path === 'items.qty');
    // Frequency reflects "doc has the path", not "type-count sum".
    expect(itemsQty!.frequency).toBe(1);
    // But each *type* present in this doc is recorded once.
    expect(itemsQty!.types).toEqual({ number: 1, string: 1, null: 1 });
  });

  it('classifies EJSON wrappers without recursing into them', () => {
    const docs = [
      {
        when: { $date: '2026-01-01T00:00:00Z' },
        amount: { $numberDecimal: '1.5' },
        big: { $numberLong: '9999' },
      },
    ];
    const out = summarizeSchema(docs);
    const byPath = Object.fromEntries(out.map((e) => [e.path, e]));
    expect(byPath.when!.types).toEqual({ date: 1 });
    expect(byPath.amount!.types).toEqual({ decimal: 1 });
    expect(byPath.big!.types).toEqual({ long: 1 });
    // Should not have recursed into $date / $numberDecimal etc.
    expect(out.some((e) => e.path.includes('$'))).toBe(false);
  });

  it('types a sentinel key mixed with other keys as a sub-document, not as BSON', () => {
    // `{"$oid": …, "extra": true}` is not an exact wrapper, so bson's revival
    // rule leaves it a plain sub-document and it is stored as one. Typing it
    // `objectid` would disagree with what is actually written.
    const docs = [{ a: { $oid: '507f1f77bcf86cd799439011', extra: true } }];
    const out = summarizeSchema(docs);
    expect(out.find((e) => e.path === 'a')!.types).toEqual({ object: 1 });
  });

  it('sorts _id first, then by descending frequency, then alphabetically', () => {
    const docs = [
      { _id: 1, z: 1, a: 1, b: 1 },
      { _id: 1, a: 1, b: 1 },
      { _id: 1, a: 1 },
      { _id: 1 },
    ];
    const out = summarizeSchema(docs);
    expect(out.map((e) => e.path)).toEqual(['_id', 'a', 'b', 'z']);
  });

  it('puts _id first even when its own frequency is the lowest field present', () => {
    // _id only appears in one of three docs; z appears in all three. A
    // frequency-only sort would put z first — only the explicit "_id
    // always wins" rule gets this right.
    const docs = [{ _id: 1, z: 1 }, { z: 1 }, { z: 1 }];
    const out = summarizeSchema(docs);
    expect(out.map((e) => e.path)).toEqual(['_id', 'z']);
  });

  it('puts _id first when it is discovered after another, higher-frequency field', () => {
    // 'z' is inserted into the schema map before '_id' (first doc has no
    // _id), which puts _id second going into the sort — this exercises the
    // comparator's other argument order than the test above.
    const docs = [{ z: 1 }, { _id: 1, z: 1 }, { z: 1 }];
    const out = summarizeSchema(docs);
    expect(out.map((e) => e.path)).toEqual(['_id', 'z']);
  });

  it('sorts by descending frequency even when that contradicts alphabetical order', () => {
    // 'a' is alphabetically first but has the lowest frequency; 'z' is
    // alphabetically last but has the highest. Only a real frequency sort
    // (not an alphabetical-only fallback) recovers the z, m, a order.
    const docs = [
      { z: 1, m: 1, a: 1 },
      { z: 1, m: 1 },
      { z: 1 },
      {},
    ];
    const out = summarizeSchema(docs);
    expect(out.map((e) => e.path)).toEqual(['z', 'm', 'a']);
  });

  it('breaks a frequency tie alphabetically, not by insertion order', () => {
    // Both fields appear in every doc (frequency 1), and 'charlie' is
    // inserted into the Map before 'alpha' — only a real localeCompare
    // sort recovers alphabetical order here.
    const docs = [{ _id: 1, charlie: 1, alpha: 1 }];
    const out = summarizeSchema(docs);
    expect(out.map((e) => e.path)).toEqual(['_id', 'alpha', 'charlie']);
  });

  it('does not recurse into an empty array', () => {
    const docs = [{ items: [] }];
    const out = summarizeSchema(docs);
    expect(out.some((e) => e.path.startsWith('items.'))).toBe(false);
  });

  it('does not recurse into an EJSON-wrapper array element', () => {
    const docs = [{ tags: [{ $oid: '507f1f77bcf86cd799439011' }] }];
    const out = summarizeSchema(docs);
    expect(out.some((e) => e.path.startsWith('tags.'))).toBe(false);
  });
});

/**
 * W17 §2 — the dominance check behind the Update drawer's type warning.
 * Silence is the default: it warns only when one type holds ≥90% of a
 * field's own histogram and the new value is something else.
 */
describe('summarizeSchema — distinct values and numeric range', () => {
  const int = (n: number) => ({ $numberInt: String(n) });
  const byPath = (docs: unknown[], path: string) =>
    summarizeSchema(docs).find((e) => e.path === path)!;

  it('counts the unique scalar values seen on a path', () => {
    const docs = [{ a: int(1) }, { a: int(1) }, { a: int(2) }];
    expect(byPath(docs, 'a').distinct).toBe(2);
  });

  it('counts a string path and a null alike, one per unique value', () => {
    const docs = [{ s: 'x' }, { s: 'x' }, { s: 'y' }, { s: null }];
    expect(byPath(docs, 's').distinct).toBe(3);
  });

  it('tells the same digits apart across BSON types', () => {
    const docs = [{ a: int(1) }, { a: { $numberLong: '1' } }, { a: 'x' }, { a: '1' }];
    expect(byPath(docs, 'a').distinct).toBe(4);
  });

  it('counts an ObjectId sentinel as a scalar but gives a sub-document no distinct', () => {
    const docs = [
      { _id: { $oid: 'a' }, sub: { k: 1 } },
      { _id: { $oid: 'b' }, sub: { k: 2 } },
      { _id: { $oid: 'a' }, sub: { k: 1 } },
    ];
    const out = summarizeSchema(docs);
    expect(out.find((e) => e.path === '_id')!.distinct).toBe(2);
    expect(out.find((e) => e.path === 'sub')!.distinct).toBeUndefined();
    expect(out.find((e) => e.path === 'sub.k')!.distinct).toBe(2);
  });

  it('treats a sentinel key mixed with others as a sub-document, not a scalar', () => {
    const docs = [{ a: { $oid: '507f1f77bcf86cd799439011', extra: true } }];
    expect(byPath(docs, 'a').distinct).toBeUndefined();
  });

  it('does not add the scalar elements of an array to distinct', () => {
    const docs = [{ tags: ['a', 'b'] }, { tags: ['c'] }];
    const tags = byPath(docs, 'tags');
    expect(tags.distinct).toBeUndefined();
    expect(tags.numeric).toBeUndefined();
  });

  it('still counts scalars inside the object elements of an array', () => {
    const docs = [{ items: [{ q: int(1) }, { q: int(2) }] }, { items: [{ q: int(2) }] }];
    expect(byPath(docs, 'items.q').distinct).toBe(2);
  });

  it('reports min, max and average over $numberInt, $numberDouble and $numberLong', () => {
    const docs = [
      { n: int(2) },
      { n: { $numberDouble: '1.5' } },
      { n: { $numberLong: '10' } },
      { n: { $numberDecimal: '-0.5' } },
    ];
    expect(byPath(docs, 'n').numeric).toEqual({ min: -0.5, max: 10, avg: 3.25 });
  });

  it('reads a raw JS number too', () => {
    expect(byPath([{ n: 4 }, { n: 8 }], 'n').numeric).toEqual({ min: 4, max: 8, avg: 6 });
  });

  it('ignores a NaN or infinite occurrence', () => {
    const docs = [
      { n: int(2) },
      { n: { $numberDouble: 'NaN' } },
      { n: { $numberDouble: 'Infinity' } },
      { n: { $numberDouble: '-Infinity' } },
      { n: int(4) },
    ];
    expect(byPath(docs, 'n').numeric).toEqual({ min: 2, max: 4, avg: 3 });
  });

  it('gives a path whose only numbers are non-finite no numeric but still a distinct', () => {
    const docs = [{ n: { $numberDouble: 'NaN' } }];
    const n = byPath(docs, 'n');
    expect(n.numeric).toBeUndefined();
    expect(n.distinct).toBe(1);
  });

  it('gives a string-only path no numeric', () => {
    expect(byPath([{ s: '5' }, { s: '6' }], 's').numeric).toBeUndefined();
  });

  it('keeps the min and max of a negative-only path', () => {
    expect(byPath([{ n: -3 }, { n: -7 }], 'n').numeric).toEqual({ min: -7, max: -3, avg: -5 });
  });

  it('drops numeric when the average overflows, keeping distinct', () => {
    const big = { $numberDouble: '1.7e308' };
    const n = byPath([{ n: big }, { n: { $numberDouble: '1.6e308' } }], 'n');
    expect(n.numeric).toBeUndefined();
    expect(n.distinct).toBe(2);
  });

  it('stores no sample value, only counts and aggregates', () => {
    const entry = byPath([{ secret: 'hunter2' }, { secret: 'swordfish' }], 'secret');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    expect(JSON.stringify(entry)).not.toContain('swordfish');
  });
});

describe('checkFieldType', () => {
  const entry = (path: string, types: Record<string, number>): SchemaSampleEntry => ({
    path,
    frequency: 1,
    types,
  });
  const byPath = (entries: SchemaSampleEntry[]) => new Map(entries.map((e) => [e.path, e]));

  it('returns null for a field with no sampled entry', () => {
    expect(checkFieldType(byPath([entry('sku', { string: 10 })]), 'missing', 'number')).toBeNull();
  });

  it('returns null when a 100%-share type agrees with the value', () => {
    expect(checkFieldType(byPath([entry('sku', { string: 10 })]), 'sku', 'string')).toBeNull();
  });

  it('warns with percent 100 when a 100%-share type disagrees', () => {
    expect(checkFieldType(byPath([entry('ref', { objectid: 10 })]), 'ref', 'string')).toEqual({
      field: 'ref',
      expectedType: 'objectid',
      actualType: 'string',
      percent: 100,
    });
  });

  it('names the dominant type on a 92/8 split when the value is the minority one', () => {
    const entries = byPath([entry('qty', { number: 92, string: 8 })]);
    expect(checkFieldType(entries, 'qty', 'string')).toEqual({
      field: 'qty',
      expectedType: 'number',
      actualType: 'string',
      percent: 92,
    });
  });

  it('returns null on a 60/40 split regardless of the value type', () => {
    const entries = byPath([entry('mixed', { number: 60, string: 40 })]);
    expect(checkFieldType(entries, 'mixed', 'string')).toBeNull();
    expect(checkFieldType(entries, 'mixed', 'number')).toBeNull();
    expect(checkFieldType(entries, 'mixed', 'date')).toBeNull();
  });

  it('reads the cutoff off the unrounded share: 0.895 displays as 90% but does not warn', () => {
    // 179/200 = 0.895 — Math.round gives 90, so a cutoff written against the
    // displayed integer would warn here. The fraction is what decides.
    const entries = byPath([entry('edge', { number: 179, string: 21 })]);
    expect(checkFieldType(entries, 'edge', 'string')).toBeNull();
  });

  it('warns at exactly the 90% cutoff — the threshold is inclusive', () => {
    const entries = byPath([entry('exact', { number: 9, string: 1 })]);
    expect(checkFieldType(entries, 'exact', 'string')).toEqual({
      field: 'exact',
      expectedType: 'number',
      actualType: 'string',
      percent: 90,
    });
  });

  it('returns null for a sampled field with an empty type histogram', () => {
    const entries = byPath([entry('empty', {})]);
    expect(checkFieldType(entries, 'empty', 'string')).toBeNull();
  });

  it('shares one type vocabulary with inferType, sentinels included', () => {
    // The regression this guards: the W17 warning must read {"$oid": …} as
    // `objectid`, not as `object`, or a correct edit warns.
    const entries = byPath([entry('ref', { objectid: 10 })]);
    expect(inferType({ $oid: '507f1f77bcf86cd799439011' })).toBe('objectid');
    expect(
      checkFieldType(entries, 'ref', inferType({ $oid: '507f1f77bcf86cd799439011' })),
    ).toBeNull();
    // …and $regularExpression, the sentinel Canonical EJSON actually emits.
    expect(inferType({ $regularExpression: { pattern: 'a', options: '' } })).toBe('regex');
  });

  it('agrees with bson revival on a sentinel key that is not the whole object', () => {
    const value = { $oid: '507f1f77bcf86cd799439011', extra: true };
    // ejsonParse leaves this a plain object, so it is written as a
    // sub-document — `object` is the only truthful classification.
    expect(inferType(value)).toBe('object');
    // …and a sub-document is out of scope for the warning, so a field
    // sampled as `number` must not be told its value is an `objectid`.
    expect(checkFieldType(byPath([entry('qty', { number: 10 })]), 'qty', inferType(value))).toEqual({
      field: 'qty',
      expectedType: 'number',
      actualType: 'object',
      percent: 100,
    });
  });
});

describe('inferType', () => {
  it('tags the JS primitives', () => {
    expect(inferType(null)).toBe('null');
    expect(inferType(undefined)).toBe('undefined');
    expect(inferType([1, 2])).toBe('array');
    expect(inferType('a')).toBe('string');
    expect(inferType(1)).toBe('number');
    expect(inferType(true)).toBe('boolean');
  });

  it('falls through to the raw typeof tag for a non-object, non-primitive value', () => {
    // A function isn't null/undefined/array/string/number/boolean, and
    // `typeof` for it isn't 'object' either — it must reach the final
    // `return t;` fallback, not get swept into the sentinel-object branch.
    expect(inferType(() => {})).toBe('function');
  });

  it('tags every canonical-EJSON numeric/binary/timestamp sentinel', () => {
    expect(inferType({ $numberInt: '1' })).toBe('number');
    expect(inferType({ $numberDouble: '1.5' })).toBe('number');
    expect(inferType({ $numberLong: '9999' })).toBe('long');
    expect(inferType({ $numberDecimal: '1.5' })).toBe('decimal');
    expect(inferType({ $regularExpression: { pattern: 'a', options: '' } })).toBe('regex');
    expect(inferType({ $binary: { base64: 'AA==', subType: '00' } })).toBe('binary');
    expect(inferType({ $timestamp: { t: 1, i: 1 } })).toBe('timestamp');
  });

  it('falls back to object for a sentinel-shaped value none of the checks name', () => {
    // $minKey is a recognised single-key sentinel (isExactSentinel says
    // yes) but inferType has no dedicated branch for it — the fallback at
    // the end of the sentinel chain must catch it.
    expect(inferType({ $minKey: 1 })).toBe('object');
    // CodeWithScope: the other isExactSentinel shape (two keys), same gap.
    expect(inferType({ $code: 'function(){}', $scope: {} })).toBe('object');
  });
});
