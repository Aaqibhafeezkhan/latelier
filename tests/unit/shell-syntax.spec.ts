import { describe, it, expect } from 'vitest';
import { refusalMessage, repairOnCommit, repairToCanonicalEjson, type RepairOutcome } from '../../src/utils/shellSyntax';
import { ejsonParse, ejsonStringify } from '../../src/utils/ejson';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The repaired text, or a readable failure. */
function mustRepair(shell: string): string {
  const r = repairToCanonicalEjson(shell);
  if (r.kind !== 'repaired') throw new Error(`expected repaired, got ${describeOutcome(r)}`);
  return r.text;
}

function mustFail(shell: string): { reason: string; index?: number } {
  const r = repairToCanonicalEjson(shell);
  if (r.kind !== 'failed') throw new Error(`expected failed, got ${describeOutcome(r)}`);
  return r;
}

function describeOutcome(r: RepairOutcome): string {
  return r.kind === 'repaired' ? `repaired: ${r.text}` : r.kind;
}

/** One field with the given value expression — the shape most tests need. */
function value(expr: string): string {
  return mustRepair(`{a: ${expr}}`);
}

// ─── Pass-through ────────────────────────────────────────────────────────────

describe('repairToCanonicalEjson — text that is already Canonical EJSON', () => {
  it.each([
    '{"age":{"$gt":60}}',
    '{ "a" : 1 }',
    '{"a":{"b":[1,2,{"c":null}]}}',
    '{"_id":{"$oid":"6512a3f19d3b2c0012a4b8e1"}}',
    '{"at":{"$date":"2026-01-01T00:00:00.000Z"}}',
    '{"n":{"$numberLong":"9007199254740993"}}',
    '{"d":{"$numberDecimal":"12345.678901234567890"}}',
    '[]',
    '{}',
  ])('leaves %s alone', (canonical) => {
    expect(repairToCanonicalEjson(canonical)).toEqual({ kind: 'unchanged' });
  });

  it('never returns text for the unchanged case, so the user keeps their own spacing', () => {
    const hand = '{\n  "a" : 1,\n  "b" : 2\n}';
    const r = repairToCanonicalEjson(hand);
    expect(r).toEqual({ kind: 'unchanged' });
    expect(r).not.toHaveProperty('text');
  });
});

// ─── Each Tier 2 construct ───────────────────────────────────────────────────

describe('repairToCanonicalEjson — Tier 2 constructs', () => {
  it('quotes unquoted keys', () => {
    expect(mustRepair('{age: {$gt: 60}}')).toBe('{"age": {"$gt": 60}}');
  });

  it('quotes single-quoted keys', () => {
    expect(mustRepair("{'age': 1}")).toBe('{"age": 1}');
  });

  it('converts single-quoted strings to double quotes', () => {
    expect(mustRepair("{status: 'active'}")).toBe('{"status": "active"}');
  });

  it('normalises escapes when re-quoting a string', () => {
    expect(mustRepair("{a: 'it\\'s'}")).toBe('{"a": "it\'s"}');
    expect(mustRepair("{a: 'say \"hi\"'}")).toBe('{"a": "say \\"hi\\""}');
  });

  it('removes a trailing comma in an object', () => {
    expect(mustRepair('{"a": 1,}')).toBe('{"a": 1}');
  });

  it('removes a trailing comma in an array', () => {
    expect(mustRepair('{"a": [1, 2,]}')).toBe('{"a": [1, 2]}');
  });

  it('removes trailing commas at more than one depth, including one after a nested brace', () => {
    expect(mustRepair('{a: [1, {b: 2},], c: 3,}')).toBe('{"a": [1, {"b": 2}], "c": 3}');
  });

  it('converts ObjectId(…)', () => {
    expect(value('ObjectId("6512a3f19d3b2c0012a4b8e1")')).toBe(
      '{"a": {"$oid":"6512a3f19d3b2c0012a4b8e1"}}',
    );
  });

  it('converts ISODate(…)', () => {
    expect(value('ISODate("2026-01-01T00:00:00.000Z")')).toBe(
      '{"a": {"$date":"2026-01-01T00:00:00.000Z"}}',
    );
  });

  it('converts new Date("…")', () => {
    expect(value('new Date("2026-01-01")')).toBe('{"a": {"$date":"2026-01-01"}}');
  });

  it('converts NumberLong with a quoted argument', () => {
    expect(value('NumberLong("42")')).toBe('{"a": {"$numberLong":"42"}}');
  });

  it('converts NumberLong with a bare number', () => {
    expect(value('NumberLong(42)')).toBe('{"a": {"$numberLong":"42"}}');
  });

  it('converts NumberDecimal(…)', () => {
    expect(value('NumberDecimal("12345.678901234567890")')).toBe(
      '{"a": {"$numberDecimal":"12345.678901234567890"}}',
    );
  });

  it('converts NumberInt(…)', () => {
    expect(value('NumberInt(7)')).toBe('{"a": {"$numberInt":"7"}}');
  });

  it('converts nested objects and arrays, not only the top level', () => {
    expect(mustRepair("{items: [{sku: 'a'}, {sku: 'b'}], meta: {ok: true}}")).toBe(
      '{"items": [{"sku": "a"}, {"sku": "b"}], "meta": {"ok": true}}',
    );
  });

  it('keeps booleans, null and negative numbers', () => {
    expect(mustRepair('{a: true, b: false, c: null, d: -3}')).toBe(
      '{"a": true, "b": false, "c": null, "d": -3}',
    );
  });
});

describe('repairToCanonicalEjson — Tier 3 regex literals', () => {
  it('rewrites a regex literal to the Canonical EJSON sentinel', () => {
    expect(value('/^acme/i')).toBe(
      '{"a": {"$regularExpression":{"pattern":"^acme","options":"i"}}}',
    );
  });

  it('emits an empty options string when the literal has no flags', () => {
    expect(value('/^acme/')).toBe('{"a": {"$regularExpression":{"pattern":"^acme","options":""}}}');
  });

  it('sorts the flags, because bson sorts them on the way back out', () => {
    // Unsorted, a saved query's text would differ from the text that produced
    // it the first time it was reloaded — the invariant this whole ADR rests on.
    expect(value('/^a/mi')).toBe('{"a": {"$regularExpression":{"pattern":"^a","options":"im"}}}');
  });

  it('copies the pattern source verbatim, escapes and all', () => {
    // `\d` must survive as two characters. Compiling the literal into a RegExp
    // and reading `.source` back would work here and lose ground elsewhere;
    // the point is that nothing is ever compiled.
    expect(value(String.raw`/\d+\s/`)).toBe(
      '{"a": {"$regularExpression":{"pattern":"\\\\d+\\\\s","options":""}}}',
    );
  });

  it('quotes a pattern containing a double quote', () => {
    expect(value('/a"b/')).toBe('{"a": {"$regularExpression":{"pattern":"a\\"b","options":""}}}');
  });

  it('revives to a BSONRegExp that re-serializes byte-identically', () => {
    // The reason for `$regularExpression` over the `$regex`/`$options` pair:
    // only this form is a BSON value, so the stored text survives a save and a
    // reload unchanged. Written without a space after the colon so the
    // comparison is about the sentinel, not about whitespace the transform
    // deliberately preserves.
    const text = mustRepair('{name:/^acme/mi}');
    expect(text).toBe('{"name":{"$regularExpression":{"pattern":"^acme","options":"im"}}}');
    const revived = ejsonParse<{ name: { pattern: string; options: string } }>(text);
    expect(revived.name.pattern).toBe('^acme');
    expect(revived.name.options).toBe('im');
    expect(ejsonStringify(revived)).toBe(text);
  });

  it.each([
    ['g', 'global'],
    ['y', 'sticky'],
  ])('refuses the JavaScript-only flag %s by name', (flag, name) => {
    // Only `g` and `y` reach the check: `d` and `v` are later than the
    // `ecmaVersion: 2020` acorn is configured with, so it refuses them first.
    // The allowlist in `regexText` is what keeps them refused if that changes.
    const failure = mustFail(`{a: /^x/${flag}}`);
    expect(failure.reason).toContain(`"${flag}"`);
    expect(failure.reason).toContain(name);
  });

  it('refuses the whole literal rather than dropping the flag it cannot keep', () => {
    // `/^acme/gi` silently becoming `/^acme/i` is the failure mode worth a
    // test: the query still runs and still looks right.
    expect(repairToCanonicalEjson('{a: /^acme/gi}').kind).toBe('failed');
  });
});

describe('repairToCanonicalEjson — new Date() with no argument', () => {
  it('resolves to a concrete timestamp the user can see', () => {
    const before = Date.now();
    const text = value('new Date()');
    const after = Date.now();

    const match = /^\{"a": \{"\$date":"(.+)"\}\}$/.exec(text);
    expect(match).not.toBeNull();
    const resolved = Date.parse(match![1]!);
    expect(resolved).toBeGreaterThanOrEqual(before - 1000);
    expect(resolved).toBeLessThanOrEqual(after + 1000);
  });

  it('resolves a bare Date() too', () => {
    expect(value('Date()')).toMatch(/^\{"a": \{"\$date":".+"\}\}$/);
  });
});

// ─── Precision — the reason this is a text transform ─────────────────────────

describe('repairToCanonicalEjson — integer precision', () => {
  // These assert on the output STRING on purpose. A test that parses the result
  // reintroduces the double conversion the transform exists to avoid, and would
  // pass against an implementation that silently loses digits.
  it('keeps every digit of a NumberLong beyond Number.MAX_SAFE_INTEGER', () => {
    expect(value('NumberLong("9007199254740993")')).toBe(
      '{"a": {"$numberLong":"9007199254740993"}}',
    );
  });

  it('keeps every digit of an unquoted NumberLong argument', () => {
    expect(value('NumberLong(9007199254740993)')).toBe(
      '{"a": {"$numberLong":"9007199254740993"}}',
    );
  });

  it('keeps every digit of a bare large integer literal', () => {
    expect(mustRepair('{_id: 9007199254740993}')).toBe('{"_id": 9007199254740993}');
  });

  it('keeps every significant digit of a NumberDecimal', () => {
    expect(value('NumberDecimal("123456789012345678901234567890.123456789")')).toBe(
      '{"a": {"$numberDecimal":"123456789012345678901234567890.123456789"}}',
    );
  });

  it('keeps a negative out-of-range integer intact', () => {
    expect(value('NumberLong(-9007199254740993)')).toBe(
      '{"a": {"$numberLong":"-9007199254740993"}}',
    );
  });
});

// ─── Whitespace preservation ─────────────────────────────────────────────────

describe('repairToCanonicalEjson — whitespace', () => {
  const stage = ['{', '  _id: "$status",', '  count: { $sum: 1 },', '}'].join('\n');

  it('keeps the line structure of a multi-line stage body', () => {
    const out = mustRepair(stage);
    const lines = out.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('  "_id": "$status",');
    expect(lines[2]).toBe('  "count": { "$sum": 1 }');
    expect(lines[3]).toBe('}');
  });

  it('preserves spacing inside a single line', () => {
    expect(mustRepair('{  age :  {  $gt :  60  }  }')).toBe('{  "age" :  {  "$gt" :  60  }  }');
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe('repairToCanonicalEjson — every repair is readable downstream', () => {
  it.each([
    '{age: {$gt: 60}}',
    "{status: 'active', tier: 'gold',}",
    '{_id: ObjectId("6512a3f19d3b2c0012a4b8e1")}',
    '{createdAt: {$gte: ISODate("2026-01-01T00:00:00.000Z")}}',
    '{n: NumberLong("9007199254740993")}',
    '{d: NumberDecimal("1.5")}',
    '{i: NumberInt(3)}',
    '{at: new Date()}',
    '{name: /^acme/i}',
    '{nested: {list: [1, 2, {deep: true},],}}',
  ])('%s parses as JSON and as EJSON', (shell) => {
    const text = mustRepair(shell);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(() => ejsonParse(text)).not.toThrow();
  });

  it('produces an ObjectId the EJSON reader revives', () => {
    const revived = ejsonParse<{ _id: { toHexString(): string } }>(
      mustRepair('{_id: ObjectId("6512a3f19d3b2c0012a4b8e1")}'),
    );
    expect(revived._id.toHexString()).toBe('6512a3f19d3b2c0012a4b8e1');
  });
});

// ─── Failure cases ───────────────────────────────────────────────────────────

describe('repairToCanonicalEjson — failures', () => {
  it('reports an empty input rather than transforming it', () => {
    expect(repairToCanonicalEjson('')).toEqual({ kind: 'failed', reason: expect.any(String) });
    expect(repairToCanonicalEjson('   \n ').kind).toBe('failed');
  });

  it.each([
    ['an unbalanced brace', '{a: 1'],
    ['a bare word', '{status: active}'],
    ['an unknown function', '{a: Math.max(1, 2)}'],
    ['a database call', '{a: db.foo()}'],
    ['a property access', '{a: some.thing}'],
    ['arithmetic', '{a: 1 + 2}'],
    ['a template literal', '{a: `x`}'],
    ['ObjectId with no argument', '{a: ObjectId()}'],
    ['a function', '{a: () => 1}'],
    ['a spread', '{...other}'],
    ['trailing junk', '{a: 1} nonsense'],
    ['an array hole', '{a: [1,,2]}'],
  ])('refuses %s', (_label, shell) => {
    expect(mustFail(shell).reason).toBeTruthy();
  });


  it('tells the user what the bare word was', () => {
    expect(mustFail('{status: active}').reason).toContain('active');
  });

  it('points at the offending region deep in a long query', () => {
    const shell = '{\n  aaa: 1,\n  bbb: 2,\n  ccc: broken\n}';
    const failure = mustFail(shell);
    expect(failure.index).toBe(shell.indexOf('broken'));
  });

  it('does not evaluate the text it is given', () => {
    // If the transform evaluated instead of rewriting, this call would run and
    // set the flag. It must be refused as an unknown construct instead.
    const seen: string[] = [];
    (globalThis as Record<string, unknown>).__shellSyntaxProbe = () => seen.push('ran');
    try {
      expect(mustFail('{a: __shellSyntaxProbe()}').reason).toBeTruthy();
      expect(mustFail('{a: (globalThis.__shellSyntaxProbe = 1)}').reason).toBeTruthy();
      expect(seen).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).__shellSyntaxProbe;
    }
  });

  it('fails closed on a comment rather than splicing a comma out of it', () => {
    // The trailing-comma edit is a raw text scan of the gap before the closing
    // bracket. A comment can put a comma in that gap, so this must fail rather
    // than emit text with a character removed from inside the comment.
    expect(repairToCanonicalEjson('{a: 1 /* x, y */}').kind).toBe('failed');
    expect(repairToCanonicalEjson('{a: 1, /* t */}').kind).toBe('failed');
  });

  it('fails closed on a construct it cannot represent rather than dropping it', () => {
    // `1_000` parses as JavaScript but is not a JSON number. It must not be
    // emitted as `1` or silently discarded.
    const r = repairToCanonicalEjson('{a: 1_000}');
    expect(r.kind).toBe('failed');
  });
});

// ─── refusalMessage — X14 §5 (T5) ────────────────────────────────────────────

describe('refusalMessage', () => {
  /** What the surfaces show for `text`, or null if it is not refused. */
  const messageFor = (text: string) => refusalMessage(text, repairToCanonicalEjson(text));

  it('carries the transform reason verbatim', () => {
    const failure = mustFail('{status: active}');
    expect(messageFor('{status: active}')).toContain(failure.reason);
  });

  it('prefixes the 1-based line and column the index points at', () => {
    // `index` is 0-based; a user counts from 1, and so does every editor.
    const shell = '{\n  aaa: 1,\n  ccc: broken\n}';
    expect(shell.indexOf('broken')).toBe(19);
    expect(messageFor(shell)).toBe(
      `Line 3, column 8: ${mustFail(shell).reason}`,
    );
  });

  it('names the JavaScript-only regex flag rather than dropping it', () => {
    // A dropped flag changes what the query means, silently. `g` is the one a
    // user actually pastes, because every JS example carries it.
    const msg = messageFor('{name: /^acme/gi}');
    expect(msg).toContain('"g"');
    expect(msg).toContain('global');
  });

  it('says nothing about a blank input — "no sort" is not a refusal', () => {
    // The transform reports empty input as `failed` so its callers commit
    // nothing. The guard lives here so no surface re-implements it.
    expect(repairToCanonicalEjson('').kind).toBe('failed');
    expect(messageFor('')).toBeNull();
    expect(messageFor('   \n ')).toBeNull();
  });

  it('says nothing when the text was accepted', () => {
    expect(messageFor('{"a": 1}')).toBeNull();
    expect(messageFor('{a: 1}')).toBeNull();
  });

  it('degrades to the bare reason when the transform supplies no offset', () => {
    expect(refusalMessage('{a: 1}', { kind: 'failed', reason: 'Nope.' })).toBe('Nope.');
  });

  // acorn ends its parse errors with its own `(line:column)`, counted
  // from 0, and the displayed one counts from 1. Two positions in one sentence
  // disagreeing by one is worse than either alone, so the suffix is stripped
  // where the reason is built and `refusalMessage` stays the only authority.
  it('shows exactly one position for a parse failure', () => {
    const msg = messageFor('{ bogus ')!;
    expect(msg).toMatch(/^Line \d+, column \d+: /);
    // The stripped suffix is the only other `(n:n)` such a message can hold.
    expect(msg).not.toMatch(/\(\d+:\d+\)/);
  });

  it('keeps acorn’s wording, minus the position suffix', () => {
    const failure = mustFail('{ bogus ');
    expect(failure.reason).toBe('Unexpected token');
    expect(failure.index).toBe(8);
  });

  it('leaves a reason that never carried a position untouched', () => {
    // `walk` throws its own reasons with no embedded position, so the strip
    // must be a no-op for them rather than trimming real trailing text.
    expect(mustFail('{a: 1 + 2}').reason).toMatch(/[^)]$/);
    expect(messageFor('{a: 1 + 2}')).toMatch(/^Line 1, column \d+: /);
  });

  it('strips a two-digit line and column, not just a single digit', () => {
    // A regex requiring exactly one digit before or after the colon would
    // leave a real "(11:12)" suffix in place — acorn's own positions grow
    // past one digit past line/column 9, so the digit class must be `\d+`.
    const shell = '\n'.repeat(10) + '{aaaaaaaaa: @}';
    const failure = mustFail(shell);
    expect(failure.reason).toBe("Unexpected character '@'");
    expect(failure.reason).not.toMatch(/\(\d+:\d+\)/);
  });
});

// ─── repairOnCommit — the blur/Run glue (§4) ─────────────────────────────────

describe('repairOnCommit', () => {
  it('commits and returns the repaired text for a real repair', () => {
    const commits: string[] = [];
    const result = repairOnCommit('{a: 1}', (text) => commits.push(text));
    expect(commits).toEqual(['{"a": 1}']);
    expect(result).toEqual({ text: '{"a": 1}', outcome: { kind: 'repaired', text: '{"a": 1}' } });
  });

  it('does not commit, and returns the original text, when the input is already canonical', () => {
    const commits: string[] = [];
    const result = repairOnCommit('{"a": 1}', (text) => commits.push(text));
    expect(commits).toEqual([]);
    expect(result).toEqual({ text: '{"a": 1}', outcome: { kind: 'unchanged' } });
  });

  it('does not commit, and returns the original text, when the repair fails', () => {
    const commits: string[] = [];
    const result = repairOnCommit('{a: 1', (text) => commits.push(text));
    expect(commits).toEqual([]);
    expect(result.text).toBe('{a: 1');
    expect(result.outcome.kind).toBe('failed');
  });
});

// ─── Exact refusal reasons (mutation hardening) ──────────────────────────────
//
// The failure-cases block above only asserts `.reason` is truthy, which
// cannot distinguish the real message from the generic fallback the last
// line of defence produces. These pin the exact wording so a wrong branch —
// or a branch silently skipped — is observable.

describe('repairToCanonicalEjson — exact refusal reasons', () => {
  it.each<[string, string]>([
    ['{a: some.thing}', 'This application does not support a property access here.'],
    ['{a: `x`}', 'This application does not support a template literal here.'],
    ['{a: () => 1}', 'This application does not support a function here.'],
    ['{a: function(){}}', 'This application does not support a function here.'],
    ['{a: [...b]}', 'This application does not support a spread element here.'],
    ['{a: 1 ? 2 : 3}', 'This application does not support a conditional expression here.'],
    ['{a: b = 1}', 'This application does not support an assignment here.'],
  ])('%s', (shell, reason) => {
    expect(mustFail(shell).reason).toBe(reason);
  });

  it.each<[string, string]>([
    ['{[x]: 1}', 'This is not a plain field and value.'],
    ['{get a() { return 1; }}', 'This is not a plain field and value.'],
    ['{a(){}}', 'This is not a plain field and value.'],
    ['{a}', 'A field must have a value.'],
    ['{...other}', 'A spread element is not supported here.'],
  ])('object property: %s', (shell, reason) => {
    expect(mustFail(shell).reason).toBe(reason);
  });

  it('refuses a BigInt literal value', () => {
    expect(mustFail('{a: 1n}').reason).toBe('A BigInt literal is not supported. Use NumberLong("…").');
  });

  it('refuses a BigInt literal key', () => {
    // key.type is 'Literal' but its value is neither a string nor a number,
    // so this exercises keyText's own fallback rather than the string/number
    // branches above it.
    expect(mustFail('{1n: 2}').reason).toBe('A field name must be a word or a quoted string.');
  });

  it('converts a bare numeric key to a quoted string', () => {
    expect(mustRepair('{1: "a"}')).toBe('{"1": "a"}');
  });

  it.each<[string, string]>([
    ['{a: !true}', 'The operator "!" is not supported.'],
    ['{a: -x}', 'The operator "-" is not supported.'],
    ['{a: -"x"}', 'The operator "-" is not supported.'],
  ])('refuses the unary form %s', (shell, reason) => {
    expect(mustFail(shell).reason).toBe(reason);
  });

  it('keeps a unary-plus number as a plain digit, not the "-" branch', () => {
    expect(mustRepair('{a: +3}')).toBe('{"a": 3}');
  });

  it('falls back to the generic node-type label for a construct with no named entry', () => {
    // `LogicalExpression` has no NODE_LABELS entry, unlike BinaryExpression —
    // this is the only way to reach the `?? \`a ${node.type}\`` fallback
    // itself, rather than a looked-up label.
    expect(mustFail('{a: 1 && 2}').reason).toBe('This application does not support a LogicalExpression here.');
  });

  it('refuses a unary operator other than "-"/"+" even on a plain number literal', () => {
    // Distinguishes the operator check from the two checks that already gate
    // on `arg`: "~5" satisfies "argument is a Literal number" but must still
    // be refused because "~" isn't "-" or "+".
    expect(mustFail('{a: ~5}').reason).toBe('The operator "~" is not supported.');
  });

  it('refuses a numeric argument to Date()/ISODate(), which only accept a string', () => {
    // Date/ISODate's own SENTINELS-less branch calls argText with
    // allowNumber=false — distinct from NumberLong/NumberDecimal/NumberInt.
    expect(mustFail('{a: new Date(123)}').reason).toBe('This value takes a quoted string.');
  });

  it('refuses a boolean argument to a numeric-argument constructor', () => {
    // `arg.type === 'Literal'` is true for `true`/`false` too — only the
    // paired `typeof === 'number'` check excludes them.
    expect(mustFail('{a: NumberLong(true)}').reason).toBe('This value takes a quoted string or a number.');
  });

  it('refuses a unary-minus applied to a non-numeric literal', () => {
    // Exercises the negative-number escape hatch's own `typeof === 'number'`
    // check on the *inner* literal, not the outer number check above.
    expect(mustFail('{a: NumberLong(-"x")}').reason).toBe('This value takes a quoted string or a number.');
  });

  it('refuses a binary-expression argument cleanly, not just a unary one', () => {
    // The negative-number escape hatch first confirms `arg.type ===
    // 'UnaryExpression'` before reading `arg.operator`/`arg.argument` — a
    // BinaryExpression like `5 - 3` also has an `operator` of '-' but no
    // `.argument` (it has `.left`/`.right` instead), so skipping that type
    // check would read `.type` off `undefined` and crash instead of
    // returning a clean refusal.
    expect(mustFail('{a: NumberLong(5 - 3)}').reason).toBe(
      'This value takes a quoted string or a number.',
    );
  });

  it('refuses an unknown value constructor by name', () => {
    expect(mustFail('{a: Foo(1)}').reason).toBe('"Foo" is not a MongoDB value this application knows.');
  });

  it('refuses a call whose callee is not a bare identifier', () => {
    expect(mustFail('{a: db.foo()}').reason).toBe('Only the MongoDB value constructors can be called here.');
  });

  it.each(['ObjectId()', 'NumberLong()'])('refuses %s for lacking an argument', (expr) => {
    const name = expr.slice(0, expr.indexOf('('));
    expect(mustFail(`{a: ${expr}}`).reason).toBe(`${name}() needs an argument.`);
  });

  it.each(['ObjectId("a","b")', 'new Date("a","b")'])('refuses %s for taking more than one argument', (expr) => {
    expect(mustFail(`{a: ${expr}}`).reason).toBe('This value takes exactly one argument.');
  });

  it('refuses a bare number for a constructor that only takes a string', () => {
    expect(mustFail('{a: ObjectId(123)}').reason).toBe('This value takes a quoted string.');
  });

  it('accepts a bare number for NumberDecimal, whose numericArg is true', () => {
    expect(value('NumberDecimal(123)')).toBe('{"a": {"$numberDecimal":"123"}}');
  });

  it('refuses a unary-plus argument, since only "-" is accepted alongside a number', () => {
    expect(mustFail('{a: NumberLong(+5)}').reason).toBe('This value takes a quoted string or a number.');
  });

  it('resolves a bare ISODate() with no argument to a concrete timestamp', () => {
    const before = Date.now();
    const text = value('ISODate()');
    const after = Date.now();
    const match = /^\{"a": \{"\$date":"(.+)"\}\}$/.exec(text);
    expect(match).not.toBeNull();
    const resolved = Date.parse(match![1]!);
    expect(resolved).toBeGreaterThanOrEqual(before - 1000);
    expect(resolved).toBeLessThanOrEqual(after + 1000);
  });

  it.each(['s', 'u'])('accepts the MongoDB-supported regex flag %s', (flag) => {
    expect(value(`/^a/${flag}`)).toBe(`{"a": {"$regularExpression":{"pattern":"^a","options":"${flag}"}}}`);
  });

  it('drops only the comma itself when whitespace separates it from the value', () => {
    // A gap with the comma NOT at its start distinguishes `lastEnd + offset`
    // from `lastEnd - offset`: with offset 0 (comma immediately after the
    // value) both arithmetic directions land on the same index.
    expect(mustRepair('{"a": 1  ,}')).toBe('{"a": 1  }');
  });

  it('reports an exact reason for whitespace-only input', () => {
    expect(repairToCanonicalEjson('   \n ')).toEqual({ kind: 'failed', reason: 'The input is empty.' });
  });

  it('reports an exact reason for trailing junk after a complete value', () => {
    const failure = mustFail('{a: 1} nonsense');
    expect(failure.reason).toBe('There is unexpected text after the value.');
  });

  it('tolerates trailing whitespace after a complete value', () => {
    // Distinguishes `text.trimEnd()` from `text.trimStart()`: trailing
    // spaces must not count as "unexpected text after the value".
    expect(mustRepair('{a: 1}   ')).toBe('{"a": 1}   ');
  });

  // Acorn reads NBSP, BOM and em space as whitespace and `JSON.parse` does
  // not, so such padding used to fail the last strictness check even around
  // strict JSON — while the filter's Run gate, which trims, accepted it.
  it('trims Unicode-space padding JSON refuses, strict JSON included', () => {
    expect(mustRepair('\u00a0{"a":1}\u00a0')).toBe('{"a":1}');
    expect(mustRepair('\ufeff{a: 1}\u2003')).toBe('{"a": 1}');
  });

  it('repairs padded strict JSON to the trimmed text byte for byte, escapes kept', () => {
    // The Shell Syntax walk would re-render `\u00e9` as a literal `é`.
    expect(mustRepair('\u00a0{"a":"\\u00e9"}\u00a0')).toBe('{"a":"\\u00e9"}');
  });

  it('reports the generic fallback reason, not a comment-specific one, when a comment breaks the result', () => {
    expect(repairToCanonicalEjson('{a: 1 /* x, y */}')).toEqual({
      kind: 'failed',
      reason: 'The text uses syntax this application does not support.',
    });
    expect(repairToCanonicalEjson('{a: 1, /* t */}')).toEqual({
      kind: 'failed',
      reason: 'The text uses syntax this application does not support.',
    });
  });
});

describe('acorn position suffix and regex flag order', () => {
  // `stripAcornPosition` exists because acorn appends `(line:col)` to its
  // message, counting columns from 0, while the refusal the user reads derives
  // its own position from `index`, counting from 1. Left in, the sentence
  // carried two positions disagreeing by one. Nothing asserted the strip until
  // now — the mutation run showed every mutant of that line surviving.
  it.each([
    ['{a: }', 4],
    ['{a: 1', 5],
  ])('strips acorn\'s own (line:col) from the refusal for %j', (shell, index) => {
    const outcome = repairToCanonicalEjson(shell);
    expect(outcome).toEqual({ kind: 'failed', reason: 'Unexpected token', index });
    // The position the user sees comes from `index`, never from the message.
    expect(outcome.kind === 'failed' && outcome.reason).not.toMatch(/\(\d+:\d+\)/);
  });

  // The flags are sorted so the same regex serializes identically everywhere.
  // Deliberately not `localeCompare` — this is canonical EJSON on the wire, and
  // collation is host-dependent.
  it('serializes regex flags in a fixed order however they were written', () => {
    const mi = mustRepair('{a: /x/mi}');
    expect(mi).toBe(mustRepair('{a: /x/im}'));
    expect(mi).toContain('"options":"im"');
  });

  it('keeps that order for three flags', () => {
    expect(mustRepair('{a: /x/smi}')).toContain('"options":"ims"');
  });
});
