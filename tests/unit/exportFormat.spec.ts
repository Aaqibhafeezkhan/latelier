import { describe, it, expect } from 'vitest';
import { Double, Int32, Long, Timestamp } from 'bson';
import {
  csvCellValue,
  csvEscape,
  exportColumnsFrom,
  exportFileExtension,
  neutralizeFormula,
  serializeCsv,
  serializeJsonArray,
  serializeJsonl,
} from '../../src/pages/Workspace/exportFormat';
import type { ResolvedColumn } from '../../src/pages/Workspace/views/tableColumns';
import { parseJsonArray, parseJsonlLine } from '../../electron/mongo/importParse';

// Canonical-EJSON-shaped documents, exactly the plain-object shape
// `electron/preload.ts` hands the renderer (`JSON.parse(wire.documentsJson)`)
// — no BSON class instances anywhere in these fixtures.
const canonicalDocs = [
  {
    _id: { $oid: '507f1f77bcf86cd799439011' },
    n: { $numberInt: '5' },
    big: { $numberLong: '9007199254740993' },
    when: { $date: { $numberLong: '1700000000000' } },
  },
];

describe('serializeJsonArray', () => {
  it('canonical (default) is a plain pretty stringify — documents are already this shape', () => {
    expect(serializeJsonArray(canonicalDocs, false)).toBe(JSON.stringify(canonicalDocs, null, 2));
  });

  it('relaxed unwraps int/double sentinels and writes $date as an ISO string', () => {
    const out = JSON.parse(serializeJsonArray(canonicalDocs, true));
    expect(out).toEqual([
      {
        _id: { $oid: '507f1f77bcf86cd799439011' },
        n: 5,
        // bson's own Relaxed writer rounds this to 9007199254740992; the
        // export keeps a Long past the safe-integer range as its sentinel.
        big: { $numberLong: '9007199254740993' },
        when: { $date: '2023-11-14T22:13:20Z' },
      },
    ]);
  });

  it('empty input is an empty array, not an empty string', () => {
    expect(serializeJsonArray([], false)).toBe('[]');
  });
});

describe('serializeJsonl', () => {
  it('empty input is the empty string', () => {
    expect(serializeJsonl([], false)).toBe('');
  });

  it('one document per line, LF-terminated including the last line', () => {
    const docs = [{ a: 1 }, { b: 2 }];
    expect(serializeJsonl(docs, false)).toBe('{"a":1}\n{"b":2}\n');
  });

  it('relaxed applies per line, independently of serializeJsonArray', () => {
    const out = serializeJsonl(canonicalDocs, true);
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.trim())).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      n: 5,
      big: { $numberLong: '9007199254740993' },
      when: { $date: '2023-11-14T22:13:20Z' },
    });
  });
});

describe('csvCellValue', () => {
  it('undefined/null render as an empty cell', () => {
    expect(csvCellValue(undefined)).toBe('');
    expect(csvCellValue(null)).toBe('');
  });

  it('strings/numbers/booleans stringify plainly', () => {
    expect(csvCellValue('hi')).toBe('hi');
    expect(csvCellValue(42)).toBe('42');
    expect(csvCellValue(true)).toBe('true');
  });

  it('an ObjectId sentinel renders as its bare hex', () => {
    expect(csvCellValue({ $oid: '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011');
  });

  it('a canonical $date sentinel renders as an ISO string', () => {
    // Native `Date.prototype.toISOString`, not bson's Relaxed EJSON writer —
    // it always includes milliseconds, unlike the JSON export path below.
    expect(csvCellValue({ $date: { $numberLong: '1700000000000' } })).toBe(
      '2023-11-14T22:13:20.000Z',
    );
  });

  it('an already-relaxed $date string sentinel passes through unchanged', () => {
    expect(csvCellValue({ $date: '2023-11-14T22:13:20Z' })).toBe('2023-11-14T22:13:20Z');
  });

  it('a $date sentinel with a non-string, non-numberLong-object inner value falls back to its JSON text', () => {
    expect(csvCellValue({ $date: 123 })).toBe('{"$date":123}');
    expect(csvCellValue({ $date: {} })).toBe('{"$date":{}}');
    expect(csvCellValue({ $date: { $numberLong: 123 } })).toBe(
      '{"$date":{"$numberLong":123}}',
    );
  });

  it('a $date sentinel whose inner value is null falls back to its JSON text (no crash on property access)', () => {
    expect(csvCellValue({ $date: null })).toBe('{"$date":null}');
  });

  it('a $date sentinel whose $numberLong does not parse to a valid instant falls back to its JSON text', () => {
    expect(csvCellValue({ $date: { $numberLong: 'not-a-number' } })).toBe(
      '{"$date":{"$numberLong":"not-a-number"}}',
    );
  });

  it('a truthy, non-object $date inner value never decodes, even one carrying a look-alike $numberLong', () => {
    // A function is truthy and `typeof … !== 'object'` — distinct from every
    // other case above, which are either objects or null/number/string. Real
    // wire data never puts a function here; this exists to pin down that the
    // decode requires the inner value to genuinely be an object, not merely
    // to have a `$numberLong`-shaped property.
    const inner = Object.assign(() => {}, { $numberLong: '1700000000000' });
    expect(csvCellValue({ $date: inner as unknown })).toBe('{}');
  });

  it('int32/double sentinels unwrap to a plain number', () => {
    expect(csvCellValue({ $numberInt: '30' })).toBe('30');
    expect(csvCellValue({ $numberDouble: '3.5' })).toBe('3.5');
  });

  it.each(['5', '-5', '9007199254740991', '-9007199254740991'])('a $numberLong of %s unwraps to its digits', (digits) => {
    expect(csvCellValue({ $numberLong: digits })).toBe(digits);
  });

  it.each(['9007199254740992', '-9007199254740992'])('a $numberLong of %s, past the safe range, stays wrapped', (digits) => {
    expect(csvCellValue({ $numberLong: digits })).toBe(`{"$numberLong":"${digits}"}`);
  });

  it('a $numberLong that is not a digit string stays wrapped', () => {
    expect(csvCellValue({ $numberLong: 5 })).toBe('{"$numberLong":5}');
  });

  it('a $numberLong sentinel stays wrapped (int64 can exceed a JS number exactly)', () => {
    expect(csvCellValue({ $numberLong: '9007199254740993' })).toBe(
      '{"$numberLong":"9007199254740993"}',
    );
  });

  it('a plain sub-document renders as its JSON text, not [object Object]', () => {
    expect(csvCellValue({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('an array renders as its JSON text', () => {
    expect(csvCellValue([1, 2, 3])).toBe('[1,2,3]');
  });

  it('a two-digit numeric sentinel that is not an exact BSON wrapper is a sub-document', () => {
    // `$oid` plus an extra key is not `isExactSentinel` — same rule
    // `schemaSummary.ts:inferType` uses — so it falls through to generic
    // object JSON rather than being misread as an ObjectId.
    expect(csvCellValue({ $oid: 'x', extra: true })).toBe('{"$oid":"x","extra":true}');
  });
});

describe('csvEscape', () => {
  it('leaves a plain field unquoted', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('')).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a field containing a newline or CR', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('a\rb')).toBe('"a\rb"');
  });
});

describe('serializeCsv', () => {
  it('writes a header row and one row per document, in column order', () => {
    const docs = [
      { name: 'Ann, A.', age: 30 },
      { name: 'Bo', age: 25 },
    ];
    const columns = [
      { header: 'name', path: 'name' },
      { header: 'age', path: 'age' },
    ];
    expect(serializeCsv(docs, columns)).toBe('name,age\n"Ann, A.",30\nBo,25\n');
  });

  it('a missing field resolves to an empty cell, keeping column alignment', () => {
    const docs = [{ a: 1 }];
    const columns = [
      { header: 'a', path: 'a' },
      { header: 'b', path: 'b' },
    ];
    expect(serializeCsv(docs, columns)).toBe('a,b\n1,\n');
  });

  it('empty documents still emit the header row', () => {
    expect(serializeCsv([], [{ header: 'a', path: 'a' }])).toBe('a\n');
  });

  it('resolves a dotted path into a nested sub-document', () => {
    const docs = [{ address: { city: 'NYC' } }];
    expect(serializeCsv(docs, [{ header: 'address.city', path: 'address.city' }])).toBe(
      'address.city\nNYC\n',
    );
  });
});

describe('neutralizeFormula', () => {
  it.each(['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'prefixes a string cell starting with a formula character: %j',
    (cell) => {
      expect(neutralizeFormula(cell, cell)).toBe(`'${cell}`);
    },
  );

  it('leaves ordinary strings and non-string values alone', () => {
    expect(neutralizeFormula('plain', 'plain')).toBe('plain');
    expect(neutralizeFormula('a=b', 'a=b')).toBe('a=b');
    expect(neutralizeFormula('-5', -5)).toBe('-5');
    expect(neutralizeFormula('-5', { $numberInt: '-5' })).toBe('-5');
  });

  it('is applied to header cells too, since field names come from the data', () => {
    expect(serializeCsv([{ '=cmd': 1 }], [{ header: '=cmd', path: '=cmd' }])).toBe("'=cmd\n1\n");
  });

  it('is applied by serializeCsv before quoting', () => {
    const docs = [{ f: '=1+1', n: -3 }];
    const columns = [
      { header: 'f', path: 'f' },
      { header: 'n', path: 'n' },
    ];
    expect(serializeCsv(docs, columns)).toBe("f,n\n'=1+1,-3\n");
  });
});

describe('exportColumnsFrom', () => {
  it('a plain field column uses its own name as both header and path', () => {
    const resolved: ResolvedColumn[] = [{ kind: 'field', field: 'name' }];
    expect(exportColumnsFrom(resolved)).toEqual([{ header: 'name', path: 'name' }]);
  });

  it('a computed column falls back to its path when it has no label', () => {
    const resolved: ResolvedColumn[] = [
      { kind: 'computed', field: 'c1', path: 'address.city' },
    ];
    expect(exportColumnsFrom(resolved)).toEqual([
      { header: 'address.city', path: 'address.city' },
    ]);
  });

  it('a computed column with a label uses the label as its header', () => {
    const resolved: ResolvedColumn[] = [
      { kind: 'computed', field: 'c1', path: 'address.city', label: 'City' },
    ];
    expect(exportColumnsFrom(resolved)).toEqual([{ header: 'City', path: 'address.city' }]);
  });
});

describe('exportFileExtension', () => {
  it('maps each format to its file extension', () => {
    expect(exportFileExtension('json')).toBe('json');
    expect(exportFileExtension('jsonl')).toBe('jsonl');
    expect(exportFileExtension('csv')).toBe('csv');
  });
});

// bson's Relaxed writer prints a number as a bare token, and an importer reads a
// bare integer past 2^53 back as a Long. A Long past the safe range comes out
// rounded, and an integral double there comes back as a Long with JavaScript's
// shortest digits instead of its own value, so both keep a sentinel.
describe('relaxed export keeps numbers past 2^53 exact', () => {
  // [what, canonical wire value, exactly what the relaxed file holds for it]
  const written: Array<[string, unknown, unknown]> = [
    ['a Long past 2^53', { $numberLong: '9007199254740993' }, { $numberLong: '9007199254740993' }],
    ['a negative Long past -2^53', { $numberLong: '-9007199254740993' }, { $numberLong: '-9007199254740993' }],
    ['the largest Long', { $numberLong: '9223372036854775807' }, { $numberLong: '9223372036854775807' }],
    ['the smallest Long', { $numberLong: '-9223372036854775808' }, { $numberLong: '-9223372036854775808' }],
    ['a Long at 2^53 exactly', { $numberLong: '9007199254740992' }, { $numberLong: '9007199254740992' }],
    ['a Long at the safe limit', { $numberLong: '9007199254740991' }, 9007199254740991],
    ['a small Long', { $numberLong: '5' }, 5],
    ['a Double past 2^53', { $numberDouble: '1760000000000000768' }, { $numberDouble: '1760000000000000768' }],
    ['a negative Double past -2^53', { $numberDouble: '-1760000000000000768' }, { $numberDouble: '-1760000000000000768' }],
    ['a Double at 2^53 exactly', { $numberDouble: '9007199254740992' }, { $numberDouble: '9007199254740992' }],
    ['a Double at the safe limit', { $numberDouble: '9007199254740991' }, 9007199254740991],
    ['a fractional Double', { $numberDouble: '2.5' }, 2.5],
    ['a Double with a long fraction', { $numberDouble: '0.1' }, 0.1],
    ['a Double of exactly 2^63', { $numberDouble: '9223372036854775808' }, 9223372036854776000],
    ['a Double past int64', { $numberDouble: '1e30' }, 1e30],
    ['an Int32', { $numberInt: '7' }, 7],
    // bson's Timestamp extends Long, and a real-epoch one (t >= 2^21) is not a
    // safe integer as a Long, but it is not a Long on the wire.
    ['a Timestamp with a real epoch', { $timestamp: { t: 1700000000, i: 1 } }, { $timestamp: { t: 1700000000, i: 1 } }],
    ['the largest Timestamp', { $timestamp: { t: 4294967295, i: 4294967295 } }, { $timestamp: { t: 4294967295, i: 4294967295 } }],
    ['a small Timestamp', { $timestamp: { t: 1, i: 2 } }, { $timestamp: { t: 1, i: 2 } }],
  ];

  it.each(written)('%s', (_what, wire, file) => {
    const doc = { v: wire };
    expect(JSON.parse(serializeJsonl([doc], true))).toEqual({ v: file });
    expect(JSON.parse(serializeJsonArray([doc], true))).toEqual([{ v: file }]);
  });

  it('reaches values inside arrays and sub-documents, and leaves other BSON types alone', () => {
    const doc = {
      a: [{ $numberLong: '9007199254740993' }, { $numberDouble: '1760000000000000768' }, { $numberInt: '1' }],
      b: { c: { d: { $numberLong: '9007199254740993' } }, when: { $date: { $numberLong: '1700000000000' } } },
      id: { $oid: '507f1f77bcf86cd799439011' },
    };
    expect(JSON.parse(serializeJsonl([doc], true))).toEqual({
      a: [{ $numberLong: '9007199254740993' }, { $numberDouble: '1760000000000000768' }, 1],
      b: { c: { d: { $numberLong: '9007199254740993' } }, when: { $date: '2023-11-14T22:13:20Z' } },
      id: { $oid: '507f1f77bcf86cd799439011' },
    });
  });

  it('keeps a field named __proto__', () => {
    // A JSON string, not an object literal: a literal `__proto__` key sets the
    // prototype instead of creating a field.
    const doc: unknown = JSON.parse('{"__proto__":{"$numberLong":"9007199254740993"}}');
    expect(JSON.parse(serializeJsonl([doc], true))).toEqual(
      JSON.parse('{"__proto__":{"$numberLong":"9007199254740993"}}'),
    );
  });

  // The point of all of the above: what is written reads back as the value and
  // type that went out, through both import paths.
  it.each([
    ['JSONL', (docs: unknown[]) => serializeJsonl(docs, true).trimEnd().split('\n').map((l, i) => parseJsonlLine(l, i + 1)!)],
    ['a JSON array', (docs: unknown[]) => parseJsonArray(serializeJsonArray(docs, true))],
  ])('a Long and a Double past 2^53 survive a relaxed export and re-import through %s', (_name, roundTrip) => {
    const docs = [
      { l: { $numberLong: '9007199254740993' }, d: { $numberDouble: '1760000000000000768' }, f: { $numberDouble: '2.5' } },
      { l: { $numberLong: '-9223372036854775808' }, d: { $numberDouble: '-9007199254740992' }, f: { $numberDouble: '0.1' } },
    ];
    const back = roundTrip(docs).map((r) => (r as { doc: Record<string, unknown> }).doc);

    expect(back[0]!.l).toBeInstanceOf(Long);
    expect((back[0]!.l as Long).toString()).toBe('9007199254740993');
    expect(back[0]!.d).toBeInstanceOf(Double);
    expect(BigInt((back[0]!.d as Double).valueOf())).toBe(1760000000000000768n);
    expect(back[0]!.f).toBe(2.5);

    expect((back[1]!.l as Long).toString()).toBe('-9223372036854775808');
    expect(BigInt((back[1]!.d as Double).valueOf())).toBe(-9007199254740992n);
    expect(back[1]!.f).toBe(0.1);
  });

  it.each([
    ['JSONL', (docs: unknown[]) => serializeJsonl(docs, true).trimEnd().split('\n').map((l, i) => parseJsonlLine(l, i + 1)!)],
    ['a JSON array', (docs: unknown[]) => parseJsonArray(serializeJsonArray(docs, true))],
  ])('a real-epoch Timestamp survives a relaxed export and re-import through %s as a Timestamp', (_name, roundTrip) => {
    const [rec] = roundTrip([{ ts: { $timestamp: { t: 1700000000, i: 1 } }, n: { $numberLong: '9007199254740993' } }]);
    const doc = (rec as { doc: Record<string, unknown> }).doc;
    expect(doc.ts).toBeInstanceOf(Timestamp);
    expect((doc.ts as Timestamp).t).toBe(1700000000);
    expect((doc.ts as Timestamp).i).toBe(1);
    // The Long beside it is still kept exact.
    expect((doc.n as Long).toString()).toBe('9007199254740993');
  });

  it('a small Int32 and a small Long come back as plain numbers (Relaxed is not lossless for every type)', () => {
    const [rec] = serializeJsonl([{ i: { $numberInt: '7' }, l: { $numberLong: '5' } }], true)
      .trimEnd()
      .split('\n')
      .map((l, i) => parseJsonlLine(l, i + 1)!);
    const doc = (rec as { doc: Record<string, unknown> }).doc;
    expect(doc).toEqual({ i: 7, l: 5 });
    expect(doc.i).not.toBeInstanceOf(Int32);
  });
});
