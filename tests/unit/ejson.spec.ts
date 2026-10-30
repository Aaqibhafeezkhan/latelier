import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { BSON, EJSON, Binary, ObjectId, Long, Decimal128, BSONRegExp, Code, DBRef, Timestamp, MinKey, MaxKey, BSONSymbol, Int32, Double, UUID } from 'bson';
import {
  ejsonParse,
  ejsonStringify,
  ejsonStringifyDriverValue,
  ejsonEncode,
  ejsonEncodeArray,
  ejsonEncodeArrayJson,
  markPromotedDoubles,
  ejsonStringifyRelaxed,
  wrapWideLongs,
  isValidEjson,
  isPlainDocument,
  parseEjsonField,
  parseEjsonDocument,
  DEFAULT_MAX_EJSON_BYTES,
} from '../../electron/mongo/ejson';
import {
  ejsonParse as ejsonParseRenderer,
  isExactSentinel,
  isValidEjson as isValidEjsonRenderer,
  isPlainDocument as isPlainDocumentRenderer,
  isEjsonDocument as isEjsonDocumentRenderer,
  ejsonStringifyReadable,
} from '../../src/utils/ejson';
import { diff, isEmptyDiff } from '../../src/pages/Workspace/documentDiff';

describe('ejson', () => {
  it('round-trips ObjectId', () => {
    const id = new ObjectId();
    const s = ejsonStringify({ _id: id });
    const back = ejsonParse<{ _id: ObjectId }>(s);
    expect(back._id).toBeInstanceOf(ObjectId);
    expect(back._id.toHexString()).toBe(id.toHexString());
  });

  it('round-trips Date', () => {
    const d = new Date('2026-04-20T12:00:00Z');
    const back = ejsonParse<{ d: Date }>(ejsonStringify({ d }));
    expect(back.d).toBeInstanceOf(Date);
    expect(back.d.toISOString()).toBe(d.toISOString());
  });

  it('round-trips Long and Decimal128', () => {
    const l = Long.fromString('9000000000000000001');
    const dec = Decimal128.fromString('12345.67890');
    const back = ejsonParse<{ l: Long; d: Decimal128 }>(ejsonStringify({ l, d: dec }));
    expect(back.l.toString()).toBe(l.toString());
    expect(back.d.toString()).toBe(dec.toString());
  });

  it('round-trips RegExp via BSONRegExp', () => {
    const r = /^hello$/i;
    const back = ejsonParse<{ r: BSONRegExp }>(ejsonStringify({ r }));
    // Canonical EJSON preserves regex as BSONRegExp, not the native RegExp.
    expect(back.r).toBeInstanceOf(BSONRegExp);
    expect(back.r.pattern).toBe(r.source);
    expect(back.r.options).toContain('i');
  });

  it('ejsonEncode preserves canonical type sentinels', () => {
    const id = new ObjectId();
    const out = ejsonEncode({ _id: id }) as { _id: { $oid: string } };
    expect(out._id.$oid).toBe(id.toHexString());
  });

  it('isValidEjson returns true for valid, false for invalid', () => {
    expect(isValidEjson('{"x":1}')).toBe(true);
    expect(isValidEjson('{ not json')).toBe(false);
  });

  it('round-trips every remaining SENTINEL_SINGLE type', () => {
    const back = ejsonParse<{
      code: Code; ts: Timestamp; mn: MinKey; mx: MaxKey; sym: BSONSymbol; i: Int32; d: Double;
    }>(ejsonStringify({
      code: new Code('function(){}'),
      ts: new Timestamp({ t: 1, i: 1 }),
      mn: new MinKey(),
      mx: new MaxKey(),
      sym: new BSONSymbol('foo'),
      i: new Int32(5),
      d: new Double(5.5),
    }));
    expect(back.code).toBeInstanceOf(Code);
    expect(back.ts).toBeInstanceOf(Timestamp);
    expect(back.mn).toBeInstanceOf(MinKey);
    expect(back.mx).toBeInstanceOf(MaxKey);
    expect(back.sym).toBeInstanceOf(BSONSymbol);
    expect(back.i).toBeInstanceOf(Int32);
    expect(back.i.valueOf()).toBe(5);
    expect(back.d).toBeInstanceOf(Double);
    expect(back.d.valueOf()).toBe(5.5);
  });

  it('a bare $undefined sentinel revives to null, not a plain {$undefined:true} object', () => {
    // bson 7's EJSON.parse revives an isolated $undefined node to `null`.
    // If '$undefined' ever drops out of SENTINEL_SINGLE, walkRevive would
    // instead pass the sentinel through untouched as a plain object.
    const result = ejsonParse('{"a":{"$undefined":true}}') as { a: unknown };
    expect(result.a).toBeNull();
  });

  it('a bare $dbPointer sentinel revives to a DBRef, not a plain object', () => {
    const raw = '{"a":{"$dbPointer":{"$ref":"coll","$id":{"$oid":"507f1f77bcf86cd799439011"}}}}';
    const result = ejsonParse(raw) as { a: unknown };
    expect(isPlainDocument(result.a)).toBe(false);
  });

  it('CodeWithScope: exact {$code,$scope} pair revives to Code (2-key sentinel)', () => {
    const c = new Code('function(){}', { x: 1 });
    const back = ejsonParse<{ c: Code }>(ejsonStringify({ c }));
    expect(back.c).toBeInstanceOf(Code);
    expect(back.c.code).toBe('function(){}');
  });

  it('CodeWithScope: a third sibling key blocks the 2-key sentinel match', () => {
    const raw = '{"$code":"function(){}","$scope":{"x":1},"extra":true}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Code);
    expect(result).toHaveProperty('extra', true);
  });

  it('CodeWithScope: $code without $scope does not match the 2-key sentinel', () => {
    const raw = '{"$code":"function(){}","other":1}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Code);
    expect(result).toHaveProperty('other', 1);
  });

  it('validateRegexPattern: rejection message names the bad pattern and preserves cause', () => {
    try {
      ejsonParse('{"a":{"$regularExpression":{"pattern":"(","options":""}}}');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('(');
      expect((err as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('$binary shape validation lets a non-object $binary value fall through to EJSON.parse', () => {
    // validateBinarySentinel only checks base64/subType on an object value;
    // a non-object value must not raise OUR message, but bson's own parse
    // still rejects the malformed shape.
    expect(() => ejsonParse('{"a":{"$binary":"not-an-object"}}')).toThrow();
    try {
      ejsonParse('{"a":{"$binary":"not-an-object"}}');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/invalid \$binary\.(base64|subType)/);
    }
  });

  it('$binary subType boundary: empty subType is valid (defaults to 0)', () => {
    const raw = '{"a":{"$binary":{"base64":"aGVsbG8=","subType":""}}}';
    expect(() => ejsonParse(raw)).not.toThrow();
  });

  it('$binary subType hex regex is fully anchored, not a substring match', () => {
    // Trailing junk after a valid hex prefix must still be rejected —
    // catches an unanchored `$`.
    expect(() =>
      ejsonParse('{"a":{"$binary":{"base64":"aGVsbG8=","subType":"1z"}}}'),
    ).toThrow(/subType/);
    // Leading junk before a valid hex suffix must still be rejected —
    // catches an unanchored `^`.
    expect(() =>
      ejsonParse('{"a":{"$binary":{"base64":"aGVsbG8=","subType":"z1"}}}'),
    ).toThrow(/subType/);
  });

  it('ejsonEncode defaults to canonical (non-relaxed) when relaxed is omitted', () => {
    expect(ejsonEncode(5)).toEqual({ $numberInt: '5' });
  });

  it('ejsonEncode(v, true) produces relaxed output', () => {
    expect(ejsonEncode(5, true)).toBe(5);
  });

  it('ejsonEncodeArrayJson: prepare runs on each element before it is encoded, and only as far as the cap lets it', () => {
    const seen: number[] = [];
    const prepare = (d: unknown): unknown => {
      seen.push(d as number);
      return { wrapped: d };
    };
    expect(ejsonEncodeArrayJson([1, 2], { prepare })).toBe(
      '[{"wrapped":{"$numberInt":"1"}},{"wrapped":{"$numberInt":"2"}}]',
    );
    seen.length = 0;
    expect(() => ejsonEncodeArrayJson([1, 2, 3], { prepare, maxBytes: 10 })).toThrow(/byte cap/);
    expect(seen).toEqual([1]);
  });

  it('ejsonEncodeArrayJson: a document that lands exactly on the cap is kept, so the next one is still prepared', () => {
    const seen: number[] = [];
    const prepare = (d: unknown): unknown => {
      seen.push(d as number);
      return d;
    };
    // "[1" is 2 bytes: at the cap, not past it. Only the next element's
    // separator and digit take it over.
    expect(() => ejsonEncodeArrayJson([1, 2, 3], { relaxed: true, prepare, maxBytes: 2 })).toThrow(/byte cap/);
    expect(seen).toEqual([1, 2]);
  });

  it('ejsonEncodeArrayJson defaults to canonical when relaxed is omitted', () => {
    expect(ejsonEncodeArrayJson([5])).toBe('[{"$numberInt":"5"}]');
  });

  it('ejsonEncodeArrayJson: exact separator and bracket placement across multiple docs', () => {
    expect(ejsonEncodeArrayJson([{ a: 1 }, { b: 2 }])).toBe(
      '[{"a":{"$numberInt":"1"}},{"b":{"$numberInt":"2"}}]',
    );
  });

  it('honours maxBytes at the exact boundary (> not >=)', () => {
    // The cap covers the whole output, closing ']' included, measured in
    // UTF-8 bytes rather than JavaScript string length.
    const exact = ejsonEncodeArrayJson([{ a: 1 }]);
    const boundary = Buffer.byteLength(exact, 'utf8');
    expect(() => ejsonEncodeArrayJson([{ a: 1 }], { maxBytes: boundary })).not.toThrow();
    expect(() => ejsonEncodeArrayJson([{ a: 1 }], { maxBytes: boundary - 1 })).toThrow(
      new RegExp(`${boundary - 1} byte cap`),
    );
  });

  it('maxBytes undefined never throws regardless of size', () => {
    const docs = [{ a: 'x'.repeat(10_000) }];
    expect(() => ejsonEncodeArrayJson(docs)).not.toThrow();
  });

  it('a field literally named __proto__ survives the round trip intact', () => {
    // Regression: walkRevive used to rebuild documents via `result[k] = v`
    // on a `{}` literal. When k === '__proto__' and v revives to a BSON
    // object (not a primitive), that assignment doesn't create an own
    // property — it reassigns the object's actual prototype, so the field
    // silently vanished from Object.keys and isPlainDocument misclassified
    // the corrupted result. Found by the fast-check round-trip property.
    // A literal JSON string, not JSON.stringify({__proto__: ...}) — object
    // LITERAL syntax with a `__proto__` key sets the new object's prototype
    // at construction time rather than creating an own property, so that
    // route would lose the key before ejsonParse ever ran.
    const raw = '{"__proto__":{"$oid":"507f1f77bcf86cd799439011"}}';
    const back = ejsonParse<Record<string, unknown>>(raw);
    // walkRevive builds documents on a null-prototype object precisely so
    // this key can't collide with the accessor — isPlainDocument treats
    // null-prototype the same as Object.prototype.
    expect(Object.getPrototypeOf(back)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(back, '__proto__')).toBe(true);
    expect((back['__proto__'] as ObjectId).toHexString()).toBe('507f1f77bcf86cd799439011');
    expect(isPlainDocument(back)).toBe(true);
  });

  it('DEFAULT_MAX_EJSON_BYTES is exactly 50 MiB', () => {
    expect(DEFAULT_MAX_EJSON_BYTES).toBe(52_428_800);
  });

  it('isPlainDocument treats a null-prototype object as plain', () => {
    expect(isPlainDocument(Object.create(null) as object)).toBe(true);
  });

  it('isPlainDocument treats an ordinary Object.prototype object as plain', () => {
    // walkRevive itself only ever produces null-prototype documents now
    // (see the __proto__ regression above) — this covers the OTHER half of
    // isPlainDocument's own OR, which a caller can still reach directly.
    expect(isPlainDocument({})).toBe(true);
  });

  it('parseEjsonField wraps the underlying parse error, naming the field', () => {
    try {
      parseEjsonField('{ not json', 'filter');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('filter');
      expect((err as { details?: { field?: string } }).details).toEqual({ field: 'filter' });
    }
  });

  it('parseEjsonDocument rejects a non-document with a message naming the field', () => {
    try {
      parseEjsonDocument('[1,2]', 'projection');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('projection');
      expect((err as { details?: { field?: string } }).details).toEqual({ field: 'projection' });
    }
  });

  // ─── Performance regression guard ───────────────────────────────────────
  //
  // `ejsonEncodeArrayJson` is on the hot path for every find / aggregate
  // result that crosses the IPC boundary; a regression here directly
  // translates to "the app feels slow on big result sets". The current
  // implementation is a per-doc `JSON.stringify(ejsonEncode(doc))` loop —
  // the budget is intentionally loose so it doesn't flake under load, but
  // strict enough to catch a 5-10× regression.
  it('encodes 1000 medium docs within a generous timing budget', () => {
    const docs: Array<Record<string, unknown>> = [];
    // ~10 KB per doc — embedded array of small typed values + a string blob.
    const blob = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 1000; i++) {
      docs.push({
        _id: new ObjectId(),
        seq: i,
        createdAt: new Date(2024, 0, 1, 0, 0, i % 60),
        amount: Decimal128.fromString((i / 7).toFixed(4)),
        nested: { tags: ['a', 'b', 'c'], note: blob },
      });
    }
    const t0 = Date.now();
    const out = ejsonEncodeArrayJson(docs);
    const elapsed = Date.now() - t0;
    expect(out.startsWith('[') && out.endsWith(']')).toBe(true);
    // Wall-clock budget: 1000 docs × ~10 KB ≈ 10 MB JSON. Empirically takes
    // ~150-300 ms on a laptop; 1500 ms gives a comfortable CI cushion.
    expect(elapsed).toBeLessThan(1500);
  });

  it('honours maxBytes ceiling and throws SystemError with the INTERNAL code', () => {
    const docs = [{ a: 'x'.repeat(1024) }, { b: 'y'.repeat(1024) }];
    try {
      ejsonEncodeArrayJson(docs, { maxBytes: 100 });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/cap/);
      expect((err as { code?: string }).code).toBe('INTERNAL');
    }
  });

  it('ejsonEncodeArrayJson(docs, {relaxed:true}) produces relaxed output, not canonical', () => {
    expect(ejsonEncodeArrayJson([5], { relaxed: true })).toBe('[5]');
  });

  // ─── Byte cap: the whole output, closing ']' included, in UTF-8 bytes (#379)

  it('byte cap: empty array [] is exactly 2 bytes, succeeds at maxBytes 2, throws at 1', () => {
    const out = ejsonEncodeArrayJson([], { relaxed: true });
    expect(out).toBe('[]');
    expect(Buffer.byteLength(out, 'utf8')).toBe(2);
    expect(() => ejsonEncodeArrayJson([], { relaxed: true, maxBytes: 2 })).not.toThrow();
    expect(() => ejsonEncodeArrayJson([], { relaxed: true, maxBytes: 1 })).toThrow();
  });

  it('byte cap boundary: output exactly M bytes succeeds at M, throws at M-1', () => {
    // Create an array with docs that produce an exact byte length.
    const out = ejsonEncodeArrayJson([{ x: 1 }], { relaxed: true });
    const M = Buffer.byteLength(out, 'utf8');
    expect(() => ejsonEncodeArrayJson([{ x: 1 }], { relaxed: true, maxBytes: M })).not.toThrow();
    expect(() => ejsonEncodeArrayJson([{ x: 1 }], { relaxed: true, maxBytes: M - 1 })).toThrow(
      new RegExp(`${M - 1} byte cap`),
    );
  });

  it('an output one byte over the cap throws, closing bracket included', () => {
    const docs = ['a'.repeat(93), 'b'];
    const out = ejsonEncodeArrayJson(docs, { relaxed: true });
    expect(Buffer.byteLength(out, 'utf8')).toBe(101);
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: 100 })).toThrow(/100 byte cap/);
  });

  it('multi-byte UTF-8: accented characters exceed cap if using UTF-16 length', () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes in canonical form.
    // Build a doc that fits UTF-16 but not UTF-8.
    const accent = 'é'.repeat(50); // 50 UTF-16 units = 100 UTF-8 bytes for this char
    const docs = [accent];
    const out = ejsonEncodeArrayJson(docs, { relaxed: true });
    const outBytes = Buffer.byteLength(out, 'utf8');
    // Should throw at a maxBytes lower than actual size.
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes - 1 })).toThrow();
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes })).not.toThrow();
  });

  it('byte cap accumulates separator commas in UTF-8 bytes', () => {
    // Each comma separator is 1 UTF-8 byte. Make sure it's counted.
    const docs = [1, 2, 3];
    const out = ejsonEncodeArrayJson(docs, { relaxed: true });
    const outBytes = Buffer.byteLength(out, 'utf8');
    // Commas should be included in the byte count.
    expect(out).toContain(',');
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes })).not.toThrow();
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes - 1 })).toThrow();
  });

  it('ejsonEncodeArray maps each doc through ejsonEncode with the same relaxed flag', () => {
    expect(ejsonEncodeArray([5])).toEqual([{ $numberInt: '5' }]);
    expect(ejsonEncodeArray([5], true)).toEqual([5]);
  });

  it('ejsonStringifyRelaxed renders a plain number without a $numberInt wrapper', () => {
    expect(ejsonStringifyRelaxed({ n: 5 })).toBe('{"n":5}');
  });
});

// bson's relaxed mode writes a Long with `Long.toNumber()`, so one past 2^53
// comes out as a different number. The shell, script `print()` and a relaxed
// export all print through `ejsonStringifyRelaxed`.
describe('ejsonStringifyRelaxed keeps a Long past 2^53 exact', () => {
  const long = (digits: string): Long => Long.fromString(digits);
  const wrapped = (digits: string): string => `{"$numberLong":"${digits}"}`;
  // What bson itself prints: the reference for every value that is not a wide Long.
  const plainRelaxed = (v: unknown): string => EJSON.stringify(v as object, undefined, undefined, { relaxed: true });

  it.each([
    ['2^53 - 1', '9007199254740991', false],
    ['2^53', '9007199254740992', false],
    ['2^53 + 1', '9007199254740993', true],
    ['-(2^53 - 1)', '-9007199254740991', false],
    ['-2^53', '-9007199254740992', false],
    ['-(2^53 + 1)', '-9007199254740993', true],
    ['an even one past 2^53, which rounds onto itself', '9007199254740994', true],
    ['Long.MAX_VALUE', '9223372036854775807', true],
    ['Long.MIN_VALUE', '-9223372036854775808', true],
  ])('a Long of %s prints %s', (_name, digits, keepsWrapper) => {
    expect(ejsonStringifyRelaxed({ n: long(digits) })).toBe(
      keepsWrapper ? `{"n":${wrapped(digits)}}` : `{"n":${digits}}`,
    );
  });

  it('keeps a wide Long wrapped at the root, in arrays and in nested documents', () => {
    const big = long('9007199254740993');
    expect(ejsonStringifyRelaxed(big)).toBe(wrapped('9007199254740993'));
    expect(ejsonStringifyRelaxed([big, long('7'), 3])).toBe(`[${wrapped('9007199254740993')},7,3]`);
    expect(ejsonStringifyRelaxed({ a: [{ b: { c: big } }], d: { e: [big] } })).toBe(
      `{"a":[{"b":{"c":${wrapped('9007199254740993')}}}],"d":{"e":[${wrapped('9007199254740993')}]}}`,
    );
  });

  it('reaches a wide Long inside the scope of a Code and the fields of a DBRef', () => {
    const big = long('9007199254740993');
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    expect(ejsonStringifyRelaxed(new Code('x', { big }))).toBe(
      `{"$code":"x","$scope":{"big":${wrapped('9007199254740993')}}}`,
    );
    expect(ejsonStringifyRelaxed(new DBRef('c', oid, undefined, { big }))).toBe(
      `{"$ref":"c","$id":{"$oid":"507f1f77bcf86cd799439011"},"big":${wrapped('9007199254740993')}}`,
    );
  });

  it('indents the way EJSON.stringify does', () => {
    const doc = { a: [1, { b: long('9007199254740993') }], c: 'x' };
    expect(ejsonStringifyRelaxed(doc, 2)).toBe(
      JSON.stringify({ a: [1, { b: { $numberLong: '9007199254740993' } }], c: 'x' }, null, 2),
    );
    expect(ejsonStringifyRelaxed({ n: 1 }, 2)).toBe('{\n  "n": 1\n}');
  });

  it('prints exactly what bson prints for every other value', () => {
    const cases: Record<string, unknown> = {
      int32: new Int32(5),
      doubleWhole: new Double(2),
      doubleFraction: new Double(1.5),
      doubleInfinity: new Double(Infinity),
      doubleNaN: new Double(Number.NaN),
      doubleNegativeZero: new Double(-0),
      number: 5,
      numberAt2p53: 2 ** 53,
      numberPast2p53: 2 ** 60,
      numberNegativePast2p53: -(2 ** 60),
      numberPast2p63: 1e30,
      objectId: new ObjectId('507f1f77bcf86cd799439011'),
      dateEpoch: new Date(0),
      dateRecent: new Date(1700000000000),
      dateBefore1970: new Date(-1),
      dateAfter9999: new Date(253402300800000),
      decimal: Decimal128.fromString('1.5'),
      timestamp: new Timestamp({ t: 1700000000, i: 1 }),
      binary: new Binary(Buffer.from('ab')),
      uuid: new UUID('00000000-0000-4000-8000-000000000000'),
      regex: new BSONRegExp('a', 'i'),
      symbol: new BSONSymbol('s'),
      minKey: new MinKey(),
      maxKey: new MaxKey(),
      code: new Code('x'),
      undef: undefined,
      nul: null,
      string: 's',
      bool: true,
      array: [1, 'two', null, [new Int32(3)]],
      safeLong: long('9007199254740991'),
      // A plain document that only looks like a Long is a document: bson prints it as one.
      lookalike: { $numberLong: '9007199254740993' },
      lookalikeNotDigits: { $numberLong: 'abc' },
    };
    for (const [name, value] of Object.entries(cases)) {
      expect(ejsonStringifyRelaxed({ v: value }), name).toBe(plainRelaxed({ v: value }));
    }
  });

  it('prints a plain number past 2^53 as a number, not as a Long', () => {
    // The driver hands a stored Double past 2^53 back as a JS number; it is not a Long.
    expect(ejsonStringifyRelaxed({ d: 2 ** 60 })).toBe(plainRelaxed({ d: 2 ** 60 }));
    expect(ejsonStringifyRelaxed({ d: 2 ** 60 })).not.toContain('$numberLong');
  });

  it('keeps a field named __proto__ that holds a wide Long', () => {
    // JSON.parse makes `__proto__` an own property; a `{}` accumulator would
    // set the prototype instead and the field would vanish from the output.
    const doc = JSON.parse('{"__proto__":{},"k":1}') as Record<string, Record<string, unknown>>;
    doc['__proto__']!.big = long('9007199254740993');
    expect(ejsonStringifyRelaxed(doc)).toBe(`{"__proto__":{"big":${wrapped('9007199254740993')}},"k":1}`);
  });

  // The shell and a script's vm each have their own Object.prototype and Map,
  // so what they build is another realm's object.
  it('prints a number past 2^53 bare and a wide Long wrapped in an object made in another realm', () => {
    const ctx = vm.createContext({ big: long('9007199254740993') });
    const made = vm.runInContext('({ n: 2 ** 60, nested: { m: [2 ** 55] }, big, inMap: new Map([["k", big]]) })', ctx);
    expect(ejsonStringifyRelaxed(made)).toBe(
      `{"n":1152921504606847000,"nested":{"m":[36028797018963970]},"big":${wrapped('9007199254740993')},"inMap":{"k":${wrapped('9007199254740993')}}}`,
    );
  });

  it('reaches a wide Long in a class instance and in a Map, as bson walks both', () => {
    class Holder {
      big = long('9007199254740993');
      d = 2 ** 60;
    }
    expect(ejsonStringifyRelaxed(new Holder())).toBe(`{"big":${wrapped('9007199254740993')},"d":1152921504606847000}`);
    const map = new Map<string, unknown>([['big', long('9007199254740993')], ['n', 1]]);
    expect(ejsonStringifyRelaxed({ map })).toBe(`{"map":{"big":${wrapped('9007199254740993')},"n":1}}`);
  });

  it('reaches a wide Long used as the $id of a DBRef', () => {
    const big = long('9007199254740993');
    expect(ejsonStringifyRelaxed(new DBRef('c', big as unknown as ObjectId))).toBe(`{"$ref":"c","$id":${wrapped('9007199254740993')}}`);
    const parsed = EJSON.parse('{"r":{"$ref":"c","$id":{"$numberLong":"9007199254740993"}}}', { relaxed: false });
    expect(ejsonStringifyRelaxed(parsed)).toBe(`{"r":{"$ref":"c","$id":${wrapped('9007199254740993')}}}`);
    expect(ejsonStringifyRelaxed(new DBRef('c', { id: big } as unknown as ObjectId, 'd'))).toBe(
      `{"$ref":"c","$id":{"id":${wrapped('9007199254740993')}},"$db":"d"}`,
    );
  });

  it('treats a Date or a RegExp as a leaf, as bson does, even one carrying a wide Long', () => {
    class TaggedDate extends Date {
      get [Symbol.toStringTag](): string {
        return 'Other';
      }
    }
    class TaggedRegExp extends RegExp {
      get [Symbol.toStringTag](): string {
        return 'Other';
      }
    }
    const ctx = vm.createContext({});
    const leaves: Record<string, object> = {
      date: new Date(0),
      vmDate: vm.runInContext('new Date(0)', ctx) as object,
      taggedDate: new TaggedDate(0),
      regExp: /a/i,
      vmRegExp: vm.runInContext('/a/i', ctx) as object,
      taggedRegExp: new TaggedRegExp('a', 'i'),
    };
    for (const [name, leaf] of Object.entries(leaves)) {
      Object.assign(leaf, { big: long('9007199254740993') });
      expect(ejsonStringifyRelaxed({ v: leaf }), name).toBe(plainRelaxed({ v: leaf }));
    }
  });

  it('reaches a wide Long in a Map subclass that reports another tag', () => {
    class TaggedMap extends Map<string, unknown> {
      get [Symbol.toStringTag](): string {
        return 'Other';
      }
    }
    expect(ejsonStringifyRelaxed(new TaggedMap([['k', long('9007199254740993')]]))).toBe(`{"k":${wrapped('9007199254740993')}}`);
  });

  it('reads an array that reports the Map tag as a Map, as bson checks Map before Array', () => {
    const entries = [['k', long('9007199254740993')]];
    Object.defineProperty(entries, Symbol.toStringTag, { value: 'Map' });
    expect(ejsonStringifyRelaxed(entries)).toBe(`{"k":${wrapped('9007199254740993')}}`);
  });

  it('keeps a wide bigint wrapped, read as the 64-bit value bson writes for it', () => {
    expect(ejsonStringifyRelaxed({ b: 9007199254740993n, s: 5n })).toBe(`{"b":${wrapped('9007199254740993')},"s":5}`);
    // bson wraps a bigint to 64 bits first: 2^64 + 7 is written as 7.
    expect(ejsonStringifyRelaxed({ b: 2n ** 64n + 7n })).toBe('{"b":7}');
    expect(ejsonStringifyRelaxed({ b: 2n ** 64n + 9007199254740993n })).toBe(`{"b":${wrapped('9007199254740993')}}`);
  });

  it('leaves a BSON value it does not open as bson prints it', () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    Object.assign(oid, { extra: long('9007199254740993') });
    expect(ejsonStringifyRelaxed({ oid })).toBe('{"oid":{"$oid":"507f1f77bcf86cd799439011"}}');
  });

  it('returns a value with no wide Long as the same reference, and copies only the changed path', () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    const doc = {
      a: [1, { b: 2 ** 60 }],
      code: new Code('x', { s: 1 }),
      ref: new DBRef('c', oid, undefined, { f: 1 }),
      map: new Map([['k', 1]]),
      safe: long('7'),
      n: 5n,
    };
    expect(wrapWideLongs(doc)).toBe(doc);
    const sibling = { x: 1 };
    const out = wrapWideLongs({ big: long('9007199254740993'), sibling }) as Record<string, unknown>;
    expect(out.sibling).toBe(sibling);
    expect(out.big).toEqual({ $numberLong: '9007199254740993' });
    // The caller's own array is never written to.
    const list = [long('9007199254740993')];
    expect(wrapWideLongs(list)).toEqual([{ $numberLong: '9007199254740993' }]);
    expect(list[0]).toBeInstanceOf(Long);
  });

  it('answers undefined for a value EJSON cannot serialise, as before', () => {
    expect(ejsonStringifyRelaxed(() => 1)).toBeUndefined();
  });

  it('throws on a cycle, as EJSON does', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => ejsonStringifyRelaxed(cyclic)).toThrow();
  });
});

// ─── src/utils/ejson.ts — the renderer's own mirror (not re-exported from
// electron/, so its own gaps need direct coverage) ──────────────────────────
describe('renderer isExactSentinel — shape checks, tested directly', () => {
  it('recognises every SENTINEL_SINGLE key as a sole key', () => {
    for (const key of [
      '$oid', '$date', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal',
      '$binary', '$timestamp', '$regularExpression', '$minKey', '$maxKey',
      '$undefined', '$code', '$symbol', '$dbPointer',
    ]) {
      expect(isExactSentinel({ [key]: 'x' })).toBe(true);
    }
  });

  it('CodeWithScope: exact {$code,$scope} pair matches', () => {
    expect(isExactSentinel({ $code: 'f', $scope: {} })).toBe(true);
  });

  it('CodeWithScope: a third key blocks the match', () => {
    expect(isExactSentinel({ $code: 'f', $scope: {}, extra: 1 })).toBe(false);
  });

  it('CodeWithScope: $code without $scope does not match', () => {
    expect(isExactSentinel({ $code: 'f', other: 1 })).toBe(false);
  });

  it('CodeWithScope: $scope without $code does not match', () => {
    expect(isExactSentinel({ $scope: {}, other: 1 })).toBe(false);
  });

  it('an ordinary two-key document is not a sentinel', () => {
    expect(isExactSentinel({ a: 1, b: 2 })).toBe(false);
  });
});

describe('renderer walkRevive — __proto__ field regression', () => {
  it('a field literally named __proto__ survives the round trip intact', () => {
    // A literal JSON string, not JSON.stringify({__proto__: ...}) — see the
    // electron-side test above for why the object-literal route loses it.
    const raw = '{"__proto__":{"$oid":"507f1f77bcf86cd799439011"}}';
    const back = ejsonParseRenderer<Record<string, unknown>>(raw);
    // walkRevive builds documents on a null-prototype object precisely so
    // this key can't collide with the accessor — isPlainDocument treats
    // null-prototype the same as Object.prototype.
    expect(Object.getPrototypeOf(back)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(back, '__proto__')).toBe(true);
    expect(isPlainDocumentRenderer(back)).toBe(true);
  });

  it('ejsonStringifyReadable preserves a __proto__ field rather than dropping it', () => {
    // Object.defineProperty, not an object literal — `{__proto__: v}` in
    // literal syntax sets the new object's prototype at construction time
    // instead of creating an own property with that name.
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, '__proto__', {
      value: { $oid: '507f1f77bcf86cd799439011' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const text = ejsonStringifyReadable(input);
    // Compare against a value parsed from JSON text, not an object literal
    // with a __proto__ key — same reason as above, on the expectation side.
    expect(JSON.parse(text)).toEqual(JSON.parse('{"__proto__":{"$oid":"507f1f77bcf86cd799439011"}}'));
  });
});

describe('renderer isValidEjson / isPlainDocument', () => {
  it('isValidEjson returns false, not just non-true, for invalid text', () => {
    expect(isValidEjsonRenderer('{ not json')).toBe(false);
  });

  it('isPlainDocument treats a null-prototype object as plain', () => {
    expect(isPlainDocumentRenderer(Object.create(null) as object)).toBe(true);
  });

  it('isPlainDocument treats an ordinary Object.prototype object as plain', () => {
    expect(isPlainDocumentRenderer({})).toBe(true);
  });

  it('isPlainDocument rejects null without crashing on Object.getPrototypeOf', () => {
    // `typeof null === 'object'`, so `!parsed` has to short-circuit the
    // whole check on its own — if it were ANDed instead of ORed with the
    // next clause, `null` would fall through to `Object.getPrototypeOf(null)`,
    // which throws.
    expect(isPlainDocumentRenderer(null)).toBe(false);
    expect(isEjsonDocumentRenderer('null')).toBe(false);
  });

  // `JSON.parse` refuses the Unicode spaces `trim` strips, so the trim is what
  // makes a padded document read as one — the filter Run gate relies on it.
  it('isEjsonDocument accepts a document padded with NBSP, BOM or em space', () => {
    expect(isEjsonDocumentRenderer('\u00a0{"a":1}\u00a0')).toBe(true);
    expect(isEjsonDocumentRenderer('\ufeff{"a":1}\u2003')).toBe(true);
  });
});

describe('renderer ejsonStringifyReadable — isoDate does not crash on a malformed inner $date', () => {
  // These bypass ejsonParse deliberately: a real Date always round-trips to a
  // {$numberLong:"<digits>"} inner shape via bson's own serializer, so these
  // malformed shapes are only reachable if `v` is handed in directly rather
  // than produced by ejsonParse — still a real path, since ejsonStringifyReadable
  // takes an arbitrary value, not only ejsonParse's output.
  it('a null inner $date falls back to the sentinel unchanged, rather than throwing', () => {
    expect(() => ejsonStringifyReadable({ at: { $date: null } })).not.toThrow();
    expect(ejsonStringifyReadable({ at: { $date: null } })).toBe('{"at":{"$date":null}}');
  });

  it('a non-string $numberLong is left wrapped, not coerced', () => {
    // A boolean survives ejsonStringify's own number-canonicalization pass
    // untouched, unlike a raw number (which would get re-wrapped first).
    const text = ejsonStringifyReadable({ at: { $date: { $numberLong: true } } });
    expect(text).toBe('{"at":{"$date":{"$numberLong":true}}}');
  });
});

// ─── Regression tests for greedy EJSON.parse bugs (#2.1, #2.2, #2.3) ───────
// These tests FAIL against the current ejsonParse (EJSON.parse with relaxed:false)
// and PASS once ejsonParse is wired to safeEjsonParse.
describe('safeEjsonParse — strict sentinel revival (REPRO 2.1, 2.2, 2.3)', () => {
  // BUG #2.2 / #2.3: sibling key alongside $date is silently dropped.
  // EJSON.parse collapses {"$date":"…","kept":"x"} to a Date, losing "kept".
  it('object with $date key + sibling key is NOT collapsed — sibling preserved', () => {
    const raw = '{"$date":"2026-01-01T00:00:00Z","kept":"x"}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Date);
    expect(result).toHaveProperty('$date', '2026-01-01T00:00:00Z');
    expect(result).toHaveProperty('kept', 'x');
  });

  // BUG #2.1: sibling operator alongside $regex is silently dropped.
  // EJSON.parse collapses {"$regex":"^9","$gte":"93"} to BSONRegExp, losing $gte.
  it('object with $regex key + sibling $gte is NOT collapsed — both operators preserved', () => {
    const raw = '{"$regex":"^9","$gte":"93"}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(BSONRegExp);
    expect(result).toHaveProperty('$regex', '^9');
    expect(result).toHaveProperty('$gte', '93');
  });

  // Legacy {$regex, $options} form is deliberately excluded from revival —
  // in a filter it is a query operator, not a document sentinel.
  it('legacy {$regex, $options} two-key form is NOT revived to BSONRegExp', () => {
    const raw = '{"$regex":"^foo","$options":"i"}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(BSONRegExp);
    expect(result).toHaveProperty('$regex', '^foo');
    expect(result).toHaveProperty('$options', 'i');
  });

  // Exact single-key sentinels must still revive correctly (no regression).
  it('exact single-key $date sentinel is still revived to Date', () => {
    expect(ejsonParse('{"$date":"2026-01-01T00:00:00Z"}')).toBeInstanceOf(Date);
  });

  it('exact $regularExpression sentinel is still revived to BSONRegExp', () => {
    const result = ejsonParse('{"$regularExpression":{"pattern":"^foo","options":"i"}}');
    expect(result).toBeInstanceOf(BSONRegExp);
    expect((result as BSONRegExp).pattern).toBe('^foo');
  });

  it('nested exact sentinels inside a plain wrapper object are all revived', () => {
    const raw = JSON.stringify({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      ts: { $date: '2026-01-01T00:00:00Z' },
      extra: 42,
    });
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result._id).toBeInstanceOf(ObjectId);
    expect(result.ts).toBeInstanceOf(Date);
    expect(result.extra).toBe(42);
  });

  it('sentinels inside arrays are revived', () => {
    const raw = JSON.stringify([{ $oid: '507f1f77bcf86cd799439011' }, 99]);
    const result = ejsonParse(raw) as unknown[];
    expect(result[0]).toBeInstanceOf(ObjectId);
    expect(result[1]).toBe(99);
  });

  // Renderer-side ejsonParse must exhibit the same safe behavior.
  it('renderer ejsonParse: sibling key alongside $date is NOT collapsed', () => {
    const raw = '{"$date":"2026-01-01T00:00:00Z","kept":"x"}';
    const result = ejsonParseRenderer(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Date);
    expect(result).toHaveProperty('kept', 'x');
  });

  it('renderer ejsonParse: exact $date sentinel still revives to Date', () => {
    expect(ejsonParseRenderer('{"$date":"2026-01-01T00:00:00Z"}')).toBeInstanceOf(Date);
  });
});

// ─── Bug 1 (HIGH) — invalid $regularExpression pattern must be rejected at ─
// parse time, not silently stored. bson's BSONRegExp constructor never
// compiles `pattern`; the only place it gets compiled is deep inside the
// driver's BSON deserializer on a later read, which throws and bricks reads
// for the whole collection. walkRevive is the one shared choke point every
// filter/doc/docs/update string passes through, so the fix belongs there.
describe('safeEjsonParse — invalid $regularExpression pattern is rejected', () => {
  it('rejects a $regularExpression whose pattern does not compile', () => {
    const raw = '{"a":{"$regularExpression":{"pattern":"(","options":"x"}}}';
    expect(() => ejsonParse(raw)).toThrow();
  });

  it('a bare invalid $regularExpression sentinel is rejected the same way', () => {
    const raw = '{"$regularExpression":{"pattern":"(","options":""}}';
    expect(() => ejsonParse(raw)).toThrow();
  });

  it('a valid $regularExpression pattern still revives to BSONRegExp (no regression)', () => {
    const raw = '{"a":{"$regularExpression":{"pattern":"^valid$","options":"i"}}}';
    const result = ejsonParse(raw) as { a: BSONRegExp };
    expect(result.a).toBeInstanceOf(BSONRegExp);
    expect(result.a.pattern).toBe('^valid$');
  });
});

// ─── Bug 2 (MEDIUM) — malformed $date / $binary content must be rejected, ──
// not silently corrupted. bson's EJSON.parse is lenient: Date.parse('garbage')
// is NaN → Invalid Date → stored as epoch 0; Buffer.from(base64,'base64')
// silently drops invalid characters; parseInt(subType,16) on a non-hex string
// is NaN, masked to 0 by `& 0xff`. Nothing re-validates the revived value's
// CONTENT after the sentinel SHAPE check passes.
describe('safeEjsonParse — malformed $date / $binary content is rejected', () => {
  it('rejects a $date that does not parse to a real instant, naming the value', () => {
    const raw = '{"a":{"$date":"garbage"}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$date value.*garbage/);
  });

  it('names a bare integer $date beyond 2^53 by the digits that were typed, not by the sentinel the parse made of it', () => {
    // 1700000000000000000 ms is far past the Date range. The parse keeps the
    // digits exact as {"$numberLong":"…"}; the message shows the digits.
    expect(() => ejsonParse('{"a":{"$date":1700000000000000000}}')).toThrow(
      /^invalid \$date value: 1700000000000000000$/,
    );
    expect(() => ejsonParse('{"a":{"$date":-1700000000000000000}}')).toThrow(
      /^invalid \$date value: -1700000000000000000$/,
    );
  });

  it('still quotes a string $date value as JSON', () => {
    expect(() => ejsonParse('{"a":{"$date":"garbage"}}')).toThrow(/^invalid \$date value: "garbage"$/);
  });

  it('names the digits of an explicit canonical $date too', () => {
    expect(() => ejsonParse('{"a":{"$date":{"$numberLong":"1700000000000000000"}}}')).toThrow(
      /^invalid \$date value: 1700000000000000000$/,
    );
  });

  it('a valid $date still round-trips to the correct instant (no regression)', () => {
    const result = ejsonParse('{"a":{"$date":"2026-01-01T00:00:00Z"}}') as { a: Date };
    expect(result.a).toBeInstanceOf(Date);
    expect(result.a.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects $binary with base64 that contains invalid characters, naming the field', () => {
    const raw = '{"a":{"$binary":{"base64":"!!!invalid!!!","subType":"00"}}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$binary\.base64/);
  });

  it('rejects $binary with a subType that is not a valid hex byte, naming the field', () => {
    const raw = '{"a":{"$binary":{"base64":"aGVsbG8=","subType":"zz"}}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$binary\.subType/);
  });

  it('rejects a base64 length that is not a multiple of 4, even with valid characters', () => {
    // BASE64_RE's `{4}` grouping is what catches this — an unanchored-length
    // version would accept any run of base64 characters.
    const raw = '{"a":{"$binary":{"base64":"AAAAA","subType":"00"}}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$binary\.base64/);
  });

  it('a $binary value that is null is left for EJSON.parse, not our validator', () => {
    // validateBinarySentinel's null/non-object guard exists so property
    // access on the raw sentinel value (base64/subType) can't itself throw
    // before EJSON.parse gets a chance to raise its own shape error.
    expect(() => ejsonParse('{"a":{"$binary":null}}')).not.toThrow();
  });

  it('a non-string base64 is left for EJSON.parse, not flagged as invalid base64 text', () => {
    expect(() => ejsonParse('{"a":{"$binary":{"base64":123,"subType":"00"}}}')).toThrow();
    try {
      ejsonParse('{"a":{"$binary":{"base64":123,"subType":"00"}}}');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/invalid \$binary\.base64/);
    }
  });

  it('a non-string subType is not flagged as an invalid hex byte (no regression)', () => {
    // The validator only guards the STRING shape of subType; a numeric
    // subType is a separate, already-documented lenient-EJSON.parse quirk.
    expect(() => ejsonParse('{"a":{"$binary":{"base64":"aGVsbG8=","subType":100}}}')).not.toThrow();
  });

  it('a valid $binary still round-trips correctly (no regression)', () => {
    const result = ejsonParse(
      '{"a":{"$binary":{"base64":"aGVsbG8=","subType":"00"}}}',
    ) as { a: { buffer: Uint8Array; sub_type: number } };
    expect(Buffer.from(result.a.buffer).toString('base64')).toBe('aGVsbG8=');
    expect(result.a.sub_type).toBe(0);
  });
});

// ─── Bare integers beyond 2^53 ──────────────────────────────────────────────
// `JSON.parse` rounds `9007199254740993` to `9007199254740992` before any
// walker sees it. The source-preserving parse that keeps the digits is shared
// (src/utils/bigIntJson.ts, tested once in bigIntJson.spec.ts: every token
// spelling, the gate, the missing-source case). Here each parser proves the
// sentinel it gets back is revived to a Long, with the rest of its walk intact.
describe.each([
  ['electron safeEjsonParse', ejsonParse],
  ['renderer ejsonParse', ejsonParseRenderer],
] as const)('%s — bare integers beyond 2^53', (_label, parse) => {
  const longAtA = (raw: string): string => {
    const v = parse<{ a: unknown }>(raw).a;
    expect(v).toBeInstanceOf(Long);
    return (v as Long).toString();
  };

  it.each([
    ['2^53 + 1', '9007199254740993'],
    ['negative -(2^53 + 1)', '-9007199254740993'],
    ['int64 max', '9223372036854775807'],
    ['int64 min', '-9223372036854775808'],
  ])('%s becomes an exact Long', (_name, token) => {
    expect(longAtA(`{"a":${token}}`)).toBe(token);
  });

  it('keeps the digits exact inside arrays nested in objects, at any depth', () => {
    const raw = '{"a":[1,{"b":9007199254740993}],"c":{"d":[[-9007199254740993]]}}';
    const out = parse<{ a: [number, { b: Long }]; c: { d: Long[][] } }>(raw);
    expect(out.a[0]).toBe(1);
    expect(out.a[1].b).toBeInstanceOf(Long);
    expect(out.a[1].b.toString()).toBe('9007199254740993');
    expect(out.c.d[0][0].toString()).toBe('-9007199254740993');
  });

  it('a lone top-level scalar becomes a Long', () => {
    const v = parse('  -9007199254740993\n');
    expect(v).toBeInstanceOf(Long);
    expect((v as Long).toString()).toBe('-9007199254740993');
  });

  it('stringifies as a canonical $numberLong with the exact digits', () => {
    expect(ejsonStringify(parse('{"a":9007199254740993}'))).toBe('{"a":{"$numberLong":"9007199254740993"}}');
  });

  it('is unaffected by another field being a __proto__ own property', () => {
    // A JSON string, not an object literal: a literal `__proto__` key sets the
    // prototype instead of creating a field. Takes the reviver path (big int
    // present) which the other __proto__ tests never do.
    const out = parse<Record<string, unknown>>(
      '{"__proto__":{"$oid":"507f1f77bcf86cd799439011"},"b":9007199254740993}',
    );
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out.__proto__).toBeInstanceOf(ObjectId);
    expect((out.b as Long).toString()).toBe('9007199254740993');
  });

  it('a __proto__ field holding the big integer itself keeps it as an own property', () => {
    const out = parse<Record<string, unknown>>('{"__proto__":9007199254740993}');
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect((out.__proto__ as Long).toString()).toBe('9007199254740993');
  });

  it('leaves what is not a big integer token a plain number or string', () => {
    // A second field with a real big int forces the reviver on.
    const out = parse<Record<string, unknown>>(
      '{"safe":1234567890123456,"frac":1.5,"exp":1e20,"beyond":9223372036854775808,"str":"9007199254740993","keep":9007199254740993}',
    );
    expect(out.safe).toBe(1234567890123456);
    expect(out.frac).toBe(1.5);
    expect(out.exp).toBe(1e20);
    expect(out.beyond).toBe(9223372036854775808);
    expect(out.str).toBe('9007199254740993');
    expect(out.keep).toBeInstanceOf(Long);
  });

  it('leaves an existing $numberLong sentinel exactly as it was', () => {
    const out = parse<{ a: Long; b: Long }>('{"a":{"$numberLong":"9007199254740993"},"b":9007199254740993}');
    expect(out.a).toBeInstanceOf(Long);
    expect(out.a.toString()).toBe('9007199254740993');
    expect(out.b.equals(out.a)).toBe(true);
  });

  it('refuses an integer beyond 2^53 when the engine gives no source text, instead of keeping the rounded double', () => {
    const real = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) =>
      real(text, reviver ? (key: string, value: unknown) => reviver.call(undefined, key, value) : undefined),
    );
    try {
      expect(() => parse('{"a":9007199254740993}')).toThrow(/no source text/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('bare big integers: both parsers agree', () => {
  it('give the same canonical EJSON for every input, big, safe or odd', () => {
    for (const raw of [
      '{"a":9007199254740993}',
      '{"a":-9223372036854775808,"b":[9223372036854775807,1e20]}',
      '[1, 9007199254740993, 12345678901234567890.0, 123456789012345678901]',
      '9007199254740993',
      '{"a":"9007199254740993","b":{"$numberLong":"9007199254740993"}}',
      '{"a":1234567890123456,"b":1.5}',
    ]) {
      expect(ejsonStringify(ejsonParseRenderer(raw))).toBe(ejsonStringify(ejsonParse(raw)));
    }
  });
});

// ─── A Double past 2^53 read back from the server ───────────────────────────
// The driver reads with promoteValues and promoteLongs on: a Long within ±2^53
// becomes a JS number, a Long beyond stays a Long, and every Double is a JS
// number. So a JS integer with |v| > 2^53 can only be a stored Double, but
// bson's canonical writer labels it $numberLong, with JavaScript's shortest
// digits rather than its own. ejsonEncode, which every read path goes through,
// says $numberDouble instead.
describe('ejsonEncode — a promoted Double past 2^53 is written as a Double', () => {
  // Exactly the options the driver deserializes a reply with.
  const asDriverReads = (value: unknown): unknown =>
    BSON.deserialize(BSON.serialize({ v: value as never }), {
      promoteValues: true,
      promoteLongs: true,
      useBigInt64: false,
    }).v;
  const asBsonWrites = (v: unknown): unknown => (EJSON.serialize({ v } as never, { relaxed: false }) as { v: unknown }).v;
  const encoded = (v: unknown): unknown => (ejsonEncode({ v }) as { v: unknown }).v;

  it('pins the promotion rule it relies on', () => {
    expect(asDriverReads(new Double(1760000000000000768))).toBe(1760000000000000768);
    expect(asDriverReads(Long.fromString('9007199254740992'))).toBe(9007199254740992);
    expect(asDriverReads(Long.fromString('-9007199254740992'))).toBe(-9007199254740992);
    expect(asDriverReads(Long.fromString('9007199254740993'))).toBeInstanceOf(Long);
    expect(asDriverReads(Long.fromString('-9007199254740993'))).toBeInstanceOf(Long);
    expect(asDriverReads(Long.MAX_VALUE)).toBeInstanceOf(Long);
  });

  it.each([
    ['a Double past 2^53', 1760000000000000768, '1760000000000000768.0'],
    ['a negative Double past 2^53', -1760000000000000768, '-1760000000000000768.0'],
    ['the first Double after 2^53', 9007199254740994, '9007199254740994.0'],
    ['the first Double before -2^53', -9007199254740994, '-9007199254740994.0'],
    ['2^63', 2 ** 63, '9223372036854775808.0'],
    ['-2^63', -(2 ** 63), '-9223372036854775808.0'],
  ])('%s becomes $numberDouble with its exact digits', (_name, n, digits) => {
    expect(encoded(asDriverReads(new Double(n)))).toEqual({ $numberDouble: digits });
  });

  it.each([
    ['2^53, which a Long of that value is promoted to too', 2 ** 53],
    ['-2^53', -(2 ** 53)],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER],
    ['an integer past int32', 3_000_000_000],
    ['an int32', 5],
    ['a fraction', 2.5],
    ['a double past int64', 1e30],
    ['a double between int64 and 1e21', 5e20],
    ['negative zero', -0],
  ])('%s is written exactly as bson writes it', (_name, n) => {
    expect(encoded(n)).toEqual(asBsonWrites(n));
  });

  it('leaves a real Long past 2^53 as an exact $numberLong', () => {
    for (const digits of ['9007199254740993', '-9007199254740993', '9223372036854775807', '-9223372036854775808']) {
      expect(encoded(asDriverReads(Long.fromString(digits)))).toEqual({ $numberLong: digits });
    }
  });

  it('round-trips: a stored Double comes back a Double with the same value, a stored Long a Long', () => {
    const doc = {
      d: asDriverReads(new Double(1760000000000000768)),
      l: asDriverReads(Long.fromString('9007199254740993')),
      f: asDriverReads(new Double(2.5)),
      i: asDriverReads(new Int32(7)),
    };
    const back = ejsonParse<{ d: Double; l: Long; f: Double; i: Int32 }>(JSON.stringify(ejsonEncode(doc)));
    expect(back.d).toBeInstanceOf(Double);
    expect(BigInt(back.d.valueOf())).toBe(1760000000000000768n);
    expect(back.l).toBeInstanceOf(Long);
    expect(back.l.toString()).toBe('9007199254740993');
    expect(back.f.valueOf()).toBe(2.5);
    expect(back.i.valueOf()).toBe(7);
  });

  it('reaches numbers inside arrays and sub-documents, wherever they sit', () => {
    const out = ejsonEncode({ a: [1, [1760000000000000768]], b: { c: { d: [{ e: -1760000000000000768 }] } } });
    expect(out).toEqual({
      a: [{ $numberInt: '1' }, [{ $numberDouble: '1760000000000000768.0' }]],
      b: { c: { d: [{ e: { $numberDouble: '-1760000000000000768.0' } }] } },
    });
  });

  it('does not change the document it is given', () => {
    const doc = { a: 1760000000000000768, b: [1760000000000000768], c: { d: 1760000000000000768 } };
    ejsonEncode(doc);
    expect(doc).toEqual({ a: 1760000000000000768, b: [1760000000000000768], c: { d: 1760000000000000768 } });
    expect(typeof doc.a).toBe('number');
  });

  it('leaves other BSON values alone', () => {
    const id = new ObjectId();
    const when = new Date('2026-01-02T03:04:05Z');
    const doc = { id, when, dec: Decimal128.fromString('1.5'), bin: new Binary(Buffer.from('ab')), ts: new Timestamp({ t: 1, i: 2 }), n: 1760000000000000768 };
    const { n, ...rest } = ejsonEncode(doc) as Record<string, unknown>;
    expect(n).toEqual({ $numberDouble: '1760000000000000768.0' });
    expect(rest).toEqual({
      id: { $oid: id.toHexString() },
      when: { $date: { $numberLong: String(when.getTime()) } },
      dec: { $numberDecimal: '1.5' },
      bin: { $binary: { base64: 'YWI=', subType: '00' } },
      ts: { $timestamp: { t: 1, i: 2 } },
    });
  });

  it('keeps a field named __proto__ as an own field', () => {
    // A JSON string, not an object literal: a literal `__proto__` key sets the
    // prototype instead of creating a field.
    const doc = JSON.parse('{"__proto__":1760000000000000768,"k":0}') as Record<string, unknown>;
    const out = ejsonEncode(doc) as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ $numberDouble: '1760000000000000768.0' });
    expect(out.k).toEqual({ $numberInt: '0' });
  });

  it('writes relaxed output as the bare number, as before', () => {
    expect(ejsonEncode({ v: 1760000000000000768 }, true)).toEqual({ v: 1760000000000000768 });
  });

  it('is what ejsonEncodeArray and ejsonEncodeArrayJson write for every document', () => {
    const docs = [{ v: 1760000000000000768 }, { v: 5 }];
    const want = [{ v: { $numberDouble: '1760000000000000768.0' } }, { v: { $numberInt: '5' } }];
    expect(ejsonEncodeArray(docs)).toEqual(want);
    expect(JSON.parse(ejsonEncodeArrayJson(docs))).toEqual(want);
  });

  it('leaves a Double instance, which an exact read hands over, as it is', () => {
    expect(encoded(new Double(1760000000000000768))).toEqual({ $numberDouble: '1760000000000000768.0' });
  });
});

// ─── The walk behind it ──────────────────────────────────────────────────────
// It runs over every document of every find, so it copies only the path to a
// changed number and hands back everything else as the same reference.
describe('ejsonStringifyDriverValue — shows a driver value the way a find result is shown', () => {
  it('writes a number past 2^53 (a promoted Double) as $numberDouble, nested in documents and arrays', () => {
    expect(ejsonStringifyDriverValue({ a: [1760000000000000768, { b: -1760000000000000768 }] })).toBe(
      '{"a":[{"$numberDouble":"1760000000000000768.0"},{"b":{"$numberDouble":"-1760000000000000768.0"}}]}',
    );
  });

  it('matches what ejsonEncode writes for the same value', () => {
    const value = { n: 1760000000000000768, s: 'x', l: Long.fromString('9007199254740993'), i: 5 };
    expect(ejsonStringifyDriverValue(value)).toBe(JSON.stringify(ejsonEncode(value)));
  });

  it('leaves a real Long past 2^53 a $numberLong, and a plain ejsonStringify unchanged', () => {
    const long = Long.fromString('9007199254740993');
    expect(ejsonStringifyDriverValue({ l: long })).toBe('{"l":{"$numberLong":"9007199254740993"}}');
    expect(ejsonStringify({ n: 1760000000000000768 })).toBe('{"n":{"$numberLong":"1760000000000000800"}}');
  });
});

describe('markPromotedDoubles — copies only the path to a changed number', () => {
  const WIDE = 1760000000000000768;
  const isMarked = (v: unknown): boolean => v instanceof Double && v.valueOf() === WIDE;

  it('returns the very same document, array and sub-documents when there is nothing to mark', () => {
    const doc = { a: [1, 'x', null, { b: true, c: [2.5] }], d: { e: null, f: { g: 'h' } }, i: 2 ** 53 };
    expect(markPromotedDoubles(doc)).toBe(doc);
    expect(markPromotedDoubles(doc.a)).toBe(doc.a);
  });

  it('copies the changed branch and the root, and shares every other branch', () => {
    const sibling = { s: 1 };
    const list = [1, 2];
    const other = [{ o: 'x' }];
    const doc = { sibling, list, hit: { deep: [0, WIDE, 3] }, other };
    const out = markPromotedDoubles(doc) as typeof doc;
    expect(out).not.toBe(doc);
    expect(out.sibling).toBe(sibling);
    expect(out.list).toBe(list);
    expect(out.other).toBe(other);
    expect(out.hit).not.toBe(doc.hit);
    expect(out.hit.deep).not.toBe(doc.hit.deep);
    expect(isMarked(out.hit.deep[1])).toBe(true);
    expect(out.hit.deep[0]).toBe(0);
    expect(out.hit.deep[2]).toBe(3);
    // The input is not touched.
    expect(doc.hit.deep).toEqual([0, WIDE, 3]);
    expect(typeof doc.hit.deep[1]).toBe('number');
  });

  it('keeps every element of an array around the number that changed', () => {
    const arr = ['a', 1, WIDE, null, 3, 'z'];
    const out = markPromotedDoubles(arr) as unknown[];
    expect(out).toHaveLength(6);
    expect(out.map((v, i) => (i === 2 ? isMarked(v) : v))).toEqual(['a', 1, true, null, 3, 'z']);
    expect(arr[2]).toBe(WIDE);
  });

  it('marks a number in the first, the middle and the last place of an array', () => {
    for (const arr of [[WIDE, 1, 2], [1, WIDE, 2], [1, 2, WIDE]]) {
      const out = markPromotedDoubles(arr) as unknown[];
      expect(out.map(isMarked)).toEqual(arr.map((v) => v === WIDE));
      expect(out).toHaveLength(3);
    }
  });

  it('keeps every field of a document around the number that changed, whichever place it sits in', () => {
    for (const hit of ['a', 'b', 'c']) {
      const doc: Record<string, unknown> = { a: 'x', b: 2, c: null };
      doc[hit] = WIDE;
      const out = markPromotedDoubles(doc) as Record<string, unknown>;
      expect(Object.keys(out)).toEqual(['a', 'b', 'c']);
      for (const k of ['a', 'b', 'c']) expect(k === hit ? isMarked(out[k]) : out[k]).toEqual(k === hit ? true : doc[k]);
    }
  });

  it('marks only a whole number past 2^53 and up to 2^63, in either sign', () => {
    const marks = (n: number): boolean => markPromotedDoubles(n) instanceof Double;
    expect([2 ** 53, 2 ** 53 + 2, 2 ** 63, 2 ** 63 + 2048, 3_000_000_000, 0.5].map(marks)).toEqual([false, true, true, false, false, false]);
    expect([-(2 ** 53), -(2 ** 53) - 2, -(2 ** 63), -(2 ** 63) - 2048].map(marks)).toEqual([false, true, true, false]);
  });

  it('passes a scalar through unchanged, whatever it is', () => {
    for (const v of [null, undefined, 'text', true, false, 0, 7, 2.5, 5n]) expect(markPromotedDoubles(v)).toBe(v);
    expect(isMarked(markPromotedDoubles(WIDE))).toBe(true);
  });

  it('copes with null and undefined fields next to a number that changes', () => {
    const out = markPromotedDoubles({ u: undefined, n: null, s: 'x', w: WIDE }) as Record<string, unknown>;
    expect(out.u).toBeUndefined();
    expect(out.n).toBeNull();
    expect(out.s).toBe('x');
    expect(isMarked(out.w)).toBe(true);
  });

  it('walks a plain document made in another realm, as a script result is', () => {
    // A script's vm has its own Object.prototype; the encoded result must say
    // Double for its numbers exactly as it does for this realm's documents.
    const made = vm.runInContext('({ n: 1760000000000000768, list: [{ m: 1760000000000000768 }], bare: Object.create(null) })', vm.createContext({}));
    const out = markPromotedDoubles(made) as { n: unknown; list: { m: unknown }[] };
    expect(isMarked(out.n)).toBe(true);
    expect(isMarked(out.list[0]!.m)).toBe(true);
    expect(ejsonEncode(made)).toEqual(ejsonEncode({ n: WIDE, list: [{ m: WIDE }], bare: {} }));
    const holder = vm.runInContext('new (class Holder { n = 1760000000000000768 })()', vm.createContext({}));
    expect(markPromotedDoubles(holder)).toBe(holder);
  });

  it('does not look inside anything but a plain document or an array', () => {
    class Holder {
      n = WIDE;
    }
    const holder = new Holder();
    const values = [holder, new Date(0), new ObjectId(), new Double(WIDE), Long.fromNumber(5), new Binary(Buffer.from('a')), new Map([['n', WIDE]])];
    for (const v of values) {
      expect(markPromotedDoubles(v)).toBe(v);
      const out = markPromotedDoubles({ v, w: WIDE }) as { v: unknown; w: unknown };
      expect(out.v).toBe(v);
      expect(isMarked(out.w)).toBe(true);
    }
    expect(holder.n).toBe(WIDE);
  });

  it('walks a document with no prototype, as a plain one', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { n: WIDE, k: 1 });
    const out = markPromotedDoubles(bare) as Record<string, unknown>;
    expect(isMarked(out.n)).toBe(true);
    expect(out.k).toBe(1);
    const still = Object.assign(Object.create(null) as Record<string, unknown>, { k: 1 });
    expect(markPromotedDoubles(still)).toBe(still);
  });
});

// The Document editor's JSON view: a stored Double past 2^53 has to come back
// from "show as text, save untouched" as the same Double, or the diff would
// report a change the user never made and $set the field as a Long.
describe('a Double past 2^53 through the Document editor JSON view', () => {
  it('re-parses to the same Double and the same Long, and the diff stays empty', () => {
    const wire = JSON.stringify(ejsonEncode({ _id: 1, d: 1760000000000000768, l: Long.fromString('9007199254740993'), f: 2.5 }));
    type Row = { d: Double; l: Long; f: Double };
    const original = ejsonParseRenderer<Row>(wire);
    expect(original.d).toBeInstanceOf(Double);
    expect(original.l).toBeInstanceOf(Long);

    const draft = ejsonParseRenderer<Row>(ejsonStringifyReadable(original, 2));
    expect(draft.d).toBeInstanceOf(Double);
    expect(BigInt(draft.d.valueOf())).toBe(1760000000000000768n);
    expect(draft.l).toBeInstanceOf(Long);
    expect(draft.l.toString()).toBe('9007199254740993');
    expect(isEmptyDiff(diff(original, draft))).toBe(true);
    expect(JSON.parse(ejsonStringify(draft)) as unknown).toMatchObject({
      d: { $numberDouble: '1760000000000000768.0' },
      l: { $numberLong: '9007199254740993' },
    });
  });
});
