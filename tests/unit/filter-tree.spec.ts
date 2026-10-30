import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseFilter,
  printFilter,
  nodeAt,
  updateAt,
  insertAt,
  removeAt,
  moveAt,
  wrapInGroup,
  unwrapGroup,
  andAtRoot,
  isGroupNode,
  toRawNode,
  tryParseRaw,
  coerceArrayElementWire,
  buildScalarWire,
  parseJsonArrayLenient,
  SIMPLE_OPS,
  ARRAY_VALUE_OPS,
  type GroupNode,
  type CondNode,
  type RawNode,
  type FilterNode,
} from '../../src/pages/Workspace/filterTree';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mustParse(ejson: string): GroupNode {
  const r = parseFilter(ejson);
  if (!r.ok) throw new Error(`expected parse ok, got: ${r.reason}`);
  return r.root;
}

function mustPrint(root: GroupNode): string {
  const p = printFilter(root);
  if (!p.ok) throw new Error(`expected print ok, got problems: ${JSON.stringify(p.problems)}`);
  return p.json;
}

/** parseFilter then printFilter in one shot — the shape most tests need. */
function roundTrip(ejson: string): string {
  return mustPrint(mustParse(ejson));
}

function cond(overrides: Partial<CondNode> = {}): CondNode {
  return { kind: 'cond', field: 'a', op: '$eq', valType: 'string', value: 'x', ...overrides };
}

function raw(json: string): RawNode {
  return { kind: 'raw', json };
}

function group(logic: GroupNode['logic'], children: FilterNode[]): GroupNode {
  return { kind: 'group', logic, children };
}

// ─── Parser (§2, §10) ────────────────────────────────────────────────────────

describe('parseFilter — parse table (§2)', () => {
  it('{} -> root $and group, no children', () => {
    expect(mustParse('{}')).toEqual(group('$and', []));
  });

  it('{ name: "x" } -> one cond, implicit $eq', () => {
    expect(mustParse('{"name":"x"}')).toEqual(
      group('$and', [cond({ field: 'name', op: '$eq', valType: 'string', value: 'x' })]),
    );
  });

  it('{ name: { $eq: "x" } } -> one cond', () => {
    expect(mustParse('{"name":{"$eq":"x"}}')).toEqual(
      group('$and', [cond({ field: 'name', op: '$eq', valType: 'string', value: 'x' })]),
    );
  });

  it('{ a: 1, b: 2 } -> root $and, two conds', () => {
    expect(mustParse('{"a":1,"b":2}')).toEqual(
      group('$and', [
        cond({ field: 'a', op: '$eq', valType: 'number', value: '1' }),
        cond({ field: 'b', op: '$eq', valType: 'number', value: '2' }),
      ]),
    );
  });

  it('{ $and: [...] } -> root becomes that group directly (not double-wrapped)', () => {
    const root = mustParse('{"$and":[{"a":1},{"b":2}]}');
    expect(root.logic).toBe('$and');
    expect(root.children).toHaveLength(2);
  });

  it('{ $or: [...] } -> root becomes an $or group', () => {
    const root = mustParse('{"$or":[{"a":1},{"b":2}]}');
    expect(root.logic).toBe('$or');
    expect(root.children).toHaveLength(2);
  });

  it('{ $nor: [x, y] } -> root becomes a $nor group', () => {
    const root = mustParse('{"$nor":[{"a":1},{"b":2}]}');
    expect(root.logic).toBe('$nor');
    expect(root.children).toHaveLength(2);
  });

  it('{ $nor: [x] } -> a NOT group under an $and root, not a $nor root', () => {
    // A one-child $nor is how the drawer writes NOT; read back as the root
    // itself it would lose its NOT and show as a NOR picker instead.
    expect(mustParse('{"$nor":[{"a":1}]}')).toEqual(
      group('$and', [group('$nor', [cond({ field: 'a', valType: 'number', value: '1' })])]),
    );
  });

  it('{ $or: [x] } -> still the root itself', () => {
    expect(mustParse('{"$or":[{"a":1}]}')).toEqual(
      group('$or', [cond({ field: 'a', valType: 'number', value: '1' })]),
    );
  });

  it('{ a: { $gte: 1, $lte: 5 } } -> two conds (§2a splittable pair)', () => {
    expect(mustParse('{"a":{"$gte":1,"$lte":5}}')).toEqual(
      group('$and', [
        cond({ field: 'a', op: '$gte', valType: 'number', value: '1' }),
        cond({ field: 'a', op: '$lte', valType: 'number', value: '5' }),
      ]),
    );
  });

  it('{ a: { $regex: "x", $options: "i" } } -> exactly one raw node', () => {
    const root = mustParse('{"a":{"$regex":"x","$options":"i"}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it('{ items: { $elemMatch: {...} } } -> one raw node', () => {
    const root = mustParse('{"items":{"$elemMatch":{"sku":1}}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toEqual(raw('{"items":{"$elemMatch":{"sku":1}}}'));
  });

  it.each(['$expr', '$text', '$where', '$jsonSchema'])(
    '%s at top level -> one raw node, not a parse failure',
    (key) => {
      const src = `{"${key}":{"whatever":1}}`;
      const r = parseFilter(src);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.root.children).toHaveLength(1);
      expect(r.root.children[0].kind).toBe('raw');
    },
  );

  it('an unenumerated clause-level $-operator (e.g. $comment) also becomes raw, not a mangled cond', () => {
    // Regression: any clause-level `$`-key is an operator, never a field
    // name — MongoDB field names can't lead with `$`. Falling through to
    // field-predicate parsing for an operator this module doesn't name by
    // name would parse `"$comment"` as a literal field, then print it back
    // as `{"$comment":{"$eq":"why"}}` — a different, invalid filter.
    const root = mustParse('{"$comment":"why"}');
    expect(root.children).toEqual([raw('{"$comment":"why"}')]);
    expect(roundTrip('{"$comment":"why"}')).toBe('{"$comment":"why"}');
  });

  it('field-level $not -> one raw node', () => {
    const root = mustParse('{"a":{"$not":{"$gt":5}}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toEqual(raw('{"a":{"$not":{"$gt":5}}}'));
  });

  it('{ loc: { $near: {...}, $maxDistance: 10 } } -> exactly one raw node', () => {
    const src = '{"loc":{"$near":{"type":"Point","coordinates":[0,0]},"$maxDistance":10}}';
    const root = mustParse(src);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toEqual(raw(src));
  });

  it('nested { $and: [ { $or: [...] }, { a: 1 } ] } -> nested groups, arbitrary depth', () => {
    const root = mustParse('{"$and":[{"$or":[{"a":1},{"b":2}]},{"c":3}]}');
    expect(root.logic).toBe('$and');
    expect(root.children).toHaveLength(2);
    const [orGroup, cCond] = root.children;
    expect(orGroup.kind).toBe('group');
    if (orGroup.kind === 'group') {
      expect(orGroup.logic).toBe('$or');
      expect(orGroup.children).toHaveLength(2);
    }
    expect(cCond).toEqual(cond({ field: 'c', op: '$eq', valType: 'number', value: '3' }));
  });

  it('parseFilter fails only on invalid JSON and non-object root', () => {
    expect(parseFilter('not json').ok).toBe(false);
    expect(parseFilter('[1,2,3]').ok).toBe(false);
    expect(parseFilter('"a string"').ok).toBe(false);
    expect(parseFilter('42').ok).toBe(false);
    expect(parseFilter('null').ok).toBe(false);
    // Never fails on an operator it doesn't understand.
    expect(parseFilter('{"status":"active","qty":{"$gt":5}}').ok).toBe(true);
    expect(parseFilter('{"items":{"$elemMatch":{"sku":1}}}').ok).toBe(true);
  });

  it('{ status: "active", qty: { $gt: 5 } } -> two conds under root $and', () => {
    expect(mustParse('{"status":"active","qty":{"$gt":5}}')).toEqual(
      group('$and', [
        cond({ field: 'status', op: '$eq', valType: 'string', value: 'active' }),
        cond({ field: 'qty', op: '$gt', valType: 'number', value: '5' }),
      ]),
    );
  });

  it('$oid / $date / $numberLong / $numberDecimal round-trip exact value text', () => {
    const oid = '507f1f77bcf86cd799439011';
    const date = '2024-01-01T00:00:00.000Z';
    const long = '9223372036854775807';
    const decimal = '12345678901234567890.123456789';
    const root = mustParse(
      `{"a":{"$oid":"${oid}"},"b":{"$date":"${date}"},"c":{"$numberLong":"${long}"},"d":{"$numberDecimal":"${decimal}"}}`,
    );
    expect(root.children).toEqual([
      cond({ field: 'a', op: '$eq', valType: 'objectid', value: oid }),
      cond({ field: 'b', op: '$eq', valType: 'date', value: date }),
      cond({ field: 'c', op: '$eq', valType: 'long', value: long }),
      cond({ field: 'd', op: '$eq', valType: 'decimal', value: decimal }),
    ]);
  });

  it('{ $or: [...], a: 1 } -> root $and group containing the $or group and the cond as siblings', () => {
    const root = mustParse('{"$or":[{"x":1},{"y":2}],"a":3}');
    expect(root.logic).toBe('$and');
    expect(root.children).toHaveLength(2);
    expect(root.children[0].kind).toBe('group');
    expect(root.children[1]).toEqual(cond({ field: 'a', op: '$eq', valType: 'number', value: '3' }));
  });

  it('$and/$or/$nor with a non-array value -> a raw node, not a parse failure', () => {
    const r = parseFilter('{"$and":{"foo":1}}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.root.children).toEqual([raw('{"$and":{"foo":1}}')]);
  });
});

// ─── Value representability (§2b, §10, §11) ─────────────────────────────────

describe('parseFilter — value representability (§2b)', () => {
  const unrepresentable: Record<string, string> = {
    'plain nested object': '{"a":{"$eq":{"nested":1}}}',
    '$binary': '{"a":{"$binary":{"base64":"AAAA","subType":"00"}}}',
    '$timestamp': '{"a":{"$timestamp":{"t":1,"i":1}}}',
    '$numberDouble': '{"a":{"$numberDouble":"1.5"}}',
    '$numberInt': '{"a":{"$numberInt":"5"}}',
    '$regularExpression': '{"a":{"$regularExpression":{"pattern":"x","options":"i"}}}',
    '$minKey': '{"a":{"$minKey":1}}',
    '$maxKey': '{"a":{"$maxKey":1}}',
    '$code': '{"a":{"$code":"function(){}"}}',
    '$dbPointer': '{"a":{"$dbPointer":{"$ref":"x","$id":{"$oid":"507f1f77bcf86cd799439011"}}}}',
    '$in array with unrepresentable element': '{"a":{"$in":[1,{"nested":1}]}}',
  };

  it.each(Object.entries(unrepresentable))('%s -> a raw node, never a mangled cond', (_label, src) => {
    const root = mustParse(src);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
    if (root.children[0].kind === 'raw') {
      // Never the legacy "[object Object]" corruption (§2b).
      expect(root.children[0].json).not.toContain('[object Object]');
    }
  });
});

describe('parseFilter — canonical EJSON date ({$date:{$numberLong}}) stays raw (§2b)', () => {
  const canonical = '{"$date":{"$numberLong":"1700000000000"}}';

  it('a field holding the canonical date is one raw node whose JSON is the input', () => {
    const src = `{"d":${canonical}}`;
    const root = mustParse(src);
    expect(root.children).toEqual([raw(src)]);
    const printed = printFilter(root);
    expect(printed).toEqual({ ok: true, json: src });
  });

  it('the same date under $gt stays raw', () => {
    const src = `{"d":{"$gt":${canonical}}}`;
    expect(mustParse(src).children).toEqual([raw(src)]);
  });

  it('the same date inside $in stays raw', () => {
    const src = `{"d":{"$in":[${canonical}]}}`;
    expect(mustParse(src).children).toEqual([raw(src)]);
  });

  it('a nested canonical date next to a sibling field keeps the sibling a cond', () => {
    const root = mustParse(`{"d":${canonical},"n":1}`);
    expect(root.children).toEqual([
      raw(`{"d":${canonical}}`),
      cond({ field: 'n', op: '$eq', valType: 'number', value: '1' }),
    ]);
  });

  it('the string form still becomes a date cond', () => {
    const root = mustParse('{"d":{"$date":"2026-01-01T00:00:00Z"}}');
    expect(root.children).toEqual([cond({ field: 'd', op: '$eq', valType: 'date', value: '2026-01-01T00:00:00Z' })]);
  });
});

// ─── Split allowlist (§2a, §11) ──────────────────────────────────────────────

describe('parseFilter — split allowlist (§2a)', () => {
  it('$gte + $lte splits into two conds', () => {
    const root = mustParse('{"a":{"$gte":1,"$lte":5}}');
    expect(root.children.every((c) => c.kind === 'cond')).toBe(true);
    expect(root.children).toHaveLength(2);
  });

  it('$regex + $options does not split — one raw node', () => {
    const root = mustParse('{"a":{"$regex":"x","$options":"i"}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it('$near + $maxDistance does not split — one raw node', () => {
    const root = mustParse('{"loc":{"$near":{"type":"Point","coordinates":[0,0]},"$maxDistance":10}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it('a pair containing any non-allowlisted key does not split', () => {
    const root = mustParse('{"a":{"$gte":1,"$elemMatch":{"b":1}}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });
});

// ─── Printer (§3, §10) ───────────────────────────────────────────────────────

describe('printFilter — normalizations (§3a)', () => {
  it('implicit $eq prints explicit', () => {
    expect(roundTrip('{"name":"x"}')).toBe('{"name":{"$eq":"x"}}');
  });

  it('a single printable child collapses the group', () => {
    expect(roundTrip('{"$and":[{"a":1}]}')).toBe('{"a":{"$eq":1}}');
  });

  it('$nor keeps its envelope even with a single child', () => {
    expect(roundTrip('{"$nor":[{"a":1}]}')).toBe('{"$nor":[{"a":{"$eq":1}}]}');
  });

  it('single-child $and does not keep its envelope', () => {
    expect(roundTrip('{"$and":[{"a":1}]}')).toBe('{"a":{"$eq":1}}');
  });

  it('single-child $or does not keep its envelope', () => {
    expect(roundTrip('{"$or":[{"a":1}]}')).toBe('{"a":{"$eq":1}}');
  });

  it('a nested group with no printable children is omitted from its parent', () => {
    // {} as an $and array item parses to an empty nested group; once its
    // sibling is the only printable child left, the $and itself collapses.
    expect(roundTrip('{"$and":[{},{"a":1}]}')).toBe('{"a":{"$eq":1}}');
  });

  it('a root with no printable children prints {}', () => {
    expect(roundTrip('{}')).toBe('{}');
  });

  it('multiple top-level fields print as {"$and":[...]}, not the implicit form', () => {
    expect(roundTrip('{"a":1,"b":2}')).toBe('{"$and":[{"a":{"$eq":1}},{"b":{"$eq":2}}]}');
  });

  it('key order follows tree order', () => {
    expect(roundTrip('{"z":1,"a":2}')).toBe('{"$and":[{"z":{"$eq":1}},{"a":{"$eq":2}}]}');
  });

  it('raw nodes normalize through JSON.parse + JSON.stringify', () => {
    const root: GroupNode = group('$and', [raw('{ "a" : 1,  "b": [1,2, 3] }')]);
    expect(mustPrint(root)).toBe('{"a":1,"b":[1,2,3]}');
  });
});

describe('printFilter — blocking problems (§3, §10)', () => {
  it('op not starting with "$" blocks with the right path', () => {
    const root = group('$and', [cond({ op: 'eq' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems).toEqual([{ path: [0], message: 'Operator must start with "$"' }]);
  });

  it('invalid number value blocks', () => {
    const root = group('$and', [cond({ valType: 'number', value: 'abc' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
  });

  it('invalid long value blocks with the node path', () => {
    const root = group('$and', [cond({ valType: 'long', value: '1.5' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('invalid decimal value blocks with the node path', () => {
    const root = group('$and', [cond({ valType: 'decimal', value: 'abc' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('invalid $mod value blocks with the node path', () => {
    const root = group('$and', [cond({ op: '$mod', value: '[1]' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('a $mod divisor of 0 blocks with the node path', () => {
    const root = group('$and', [cond({ op: '$mod', value: '[0,1]' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('an unencodable op ($elemMatch typed onto a cond row) blocks as a backstop', () => {
    const root = group('$and', [cond({ op: '$elemMatch', value: '{}' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('a raw node holding unparseable JSON blocks', () => {
    const root = group('$and', [raw('{not json')]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems).toEqual([{ path: [0], message: 'Not valid JSON' }]);
  });

  it('a raw node whose parsed JSON is not an object blocks', () => {
    const root = group('$and', [raw('[1,2,3]')]);
    expect(printFilter(root).ok).toBe(false);
  });

  it('a cond with an empty field is skipped and never appears in problems', () => {
    const root = group('$and', [cond({ field: '' }), cond({ field: 'good', value: 'ok' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ good: { $eq: 'ok' } });
  });

  it('a cond whose op is outside FIELD_OPS[valType] still prints (applicability is advisory)', () => {
    // $size is not applicable to 'string' per FIELD_OPS, but must still print.
    const root = group('$and', [cond({ op: '$size', valType: 'string', value: '3' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(true);
  });

  it('collects every problem across the whole tree, not just the first', () => {
    const root = group('$and', [
      cond({ field: 'a', op: 'eq' }),
      group('$or', [cond({ field: 'b', valType: 'number', value: 'abc' })]),
    ]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems).toEqual(
      expect.arrayContaining([
        { path: [0], message: 'Operator must start with "$"' },
        { path: [1, 0], message: 'Value must be a valid number' },
      ]),
    );
    expect(p.problems).toHaveLength(2);
  });
});

describe('printFilter — numeric precision guard on raw nodes (§3a)', () => {
  // These two build a RawNode literal directly rather than going through
  // parseFilter. That is deliberate, not the hand-built-node flaw the
  // cond-path tests below were guilty of: a plain field value like
  // `{"a":9007199254740993}` is representable per §2b, so parseFilter would
  // turn it into a *cond*, never a raw node — this exact RawNode.json shape
  // is only reachable by the user hand-typing into a "+Raw" clause box
  // (§5 pending-raw lifecycle), which never round-trips through parseFilter
  // at all. That hand-typed path is real and is what this guard exists for.
  it('a hand-typed raw clause containing 9007199254740993 blocks with that node path', () => {
    const root = group('$and', [raw('{"a":9007199254740993}')]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0].path).toEqual([0]);
  });

  it('the same value nested inside another object still blocks, reaching nested tokens', () => {
    // Also not re-rootable at parseFilter: parseFilter's own whole-document
    // JSON.parse would already round 9007199254740993 before this RawNode
    // gets built (the documented parse-side gap on `parseFilter`), so
    // routing this input through parseFilter would silently test the
    // rounded, now-"safe-looking" value instead of proving the guard
    // reaches a nested token. Hand-building is the only way to exercise
    // this specific literal.
    const root = group('$and', [
      raw('{"loc":{"$near":{"type":"Point","coordinates":[0,0]},"$maxDistance":9007199254740993}}'),
    ]);
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('the same value as {"$numberLong": "..."} in the same position prints fine, end to end', () => {
    // Reachable via parseFilter: $near/$maxDistance is unsplittable (§2a) so
    // this whole pair degrades to one raw node regardless, and $numberLong's
    // value is a JSON *string* — never tokenized as a JS number — so nothing
    // in the parse pipeline rounds it before printFilter sees it.
    const src =
      '{"loc":{"$near":{"type":"Point","coordinates":[0,0]},"$maxDistance":{"$numberLong":"9007199254740993"}}}';
    expect(roundTrip(src)).toBe(src);
  });

  it('a lossless reformatting like 1.0 does not trip the guard (deliberate narrowing of §3a)', () => {
    // Also only reachable by hand-typing, for the same reason as above: a
    // RawNode built by parseFilter always holds already-restringified text
    // (JSON.parse('1.0') is the JS number 1, and JSON.stringify(1) is "1"),
    // so parseFilter can never produce a RawNode whose text contains "1.0"
    // in the first place — the false positive this narrowing fixes only
    // ever reaches a user typing directly into a raw-clause textarea.
    const root = group('$and', [raw('{"loc":{"$near":{"$geometry":1},"$maxDistance":1.0}}')]);
    expect(printFilter(root).ok).toBe(true);
  });
});

describe('condValueProblem — big-integer guard on the cond path', () => {
  // `number` is representable per §2b (unlike `long`/`decimal`, which carry
  // exact text), so `{"a":{"$gt":9007199254740993}}` parses to a *cond*, not
  // a raw node — the raw-node guard above never runs for it. Every case here
  // is re-rooted at parseFilter(input) rather than a hand-built CondNode:
  // an earlier round of this test suite hand-built a cond with an op/valType
  // combination (`$in` + `valType: 'number'`) that parseFilter can never
  // actually produce (array-value ops always parse to `valType: 'array'`,
  // never `'number'`) — the test passed while the branch it exercised was
  // unreachable dead code on real input. Starting from parseFilter every
  // time is what would have caught that.
  it('a scalar number cond beyond safe-integer range blocks with the node path', () => {
    const root = mustParse('{"a":{"$gt":9007199254740993}}');
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('the boundary: 9007199254740991 (safe) prints, 9007199254740993 (unsafe) blocks', () => {
    expect(printFilter(mustParse('{"a":{"$gt":9007199254740991}}')).ok).toBe(true);
    expect(printFilter(mustParse('{"a":{"$gt":9007199254740993}}')).ok).toBe(false);
  });

  it('the same value as valType long ($numberLong text) prints fine, end to end', () => {
    const src = '{"a":{"$gt":{"$numberLong":"9007199254740993"}}}';
    expect(roundTrip(src)).toBe(src);
  });

  it('an $in array containing an unsafe integer element blocks — the exact reported repro', () => {
    // {"a":{"$in":[1,9007199254740993]}} parses to
    // cond(field:'a', op:'$in', valType:'array', ...) — valType 'array', not
    // 'number'. The bug: condValueProblem's array-element check was gated on
    // `node.valType === 'number'`, a combination the parser never produces,
    // so the guard never ran and the rounded value printed as ok:true.
    const root = mustParse('{"a":{"$in":[1,9007199254740993]}}');
    expect(root.children[0]).toMatchObject({ kind: 'cond', op: '$in', valType: 'array' });
    const p = printFilter(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].path).toEqual([0]);
  });

  it('an $in array of only safe integers prints fine, end to end', () => {
    expect(roundTrip('{"a":{"$in":[1,2,3]}}')).toBe('{"a":{"$in":[1,2,3]}}');
  });

  it('an $in array element already wrapped as {$numberLong} is untouched by the number check', () => {
    // Verifies the fix's claim: the element-level `typeof el === 'number'`
    // filter already excludes long/decimal-style elements (they parse as
    // objects, not JS numbers), so dropping the valType gate cannot newly
    // block this escape-hatch form.
    const src = '{"a":{"$in":[{"$numberLong":"9007199254740993"}]}}';
    expect(roundTrip(src)).toBe(src);
  });
});

// ─── Sentinel-key exactness (§2b) ───────────────────────────────────────────
//
// guessSentinelOnly / isRepresentableArrayElement gate on an exact key match
// AND a string-typed value. Every test above that only exercises the
// matching case leaves the `&&`/`===`/`||` wiring unproven — a mutant that
// swaps `&&` for `||`, or drops the key check, or the typeof check, produces
// the same output for a *matching* input. These prove the negative: a wrong
// key, or a right key with the wrong value type, must NOT take the sentinel
// path.

describe('guessSentinelOnly — exact key AND string-typed value required (§2b)', () => {
  it.each(['$oid', '$numberLong', '$numberDecimal'] as const)(
    '%s with a non-string value is NOT a sentinel — falls to the operator map',
    (key) => {
      // A number-typed value under the sentinel key: guessSentinelOnly must
      // reject it (wrong type), so it's read as operator `key` with a
      // representable *number* value instead of the sentinel valType.
      const root = mustParse(`{"a":{"${key}":123}}`);
      expect(root.children).toEqual([cond({ field: 'a', op: key, valType: 'number', value: '123' })]);
    },
  );

  it('$date with a non-string value is one raw node, never an operator named $date', () => {
    const root = mustParse('{"a":{"$date":123}}');
    expect(root.children).toEqual([raw('{"a":{"$date":123}}')]);
  });

  it.each(['$oid', '$date', '$numberLong', '$numberDecimal'])(
    'a similarly-named but wrong key (%sx) with a string value is NOT a sentinel',
    (key) => {
      const wrongKey = `${key}x`;
      const root = mustParse(`{"a":{"${wrongKey}":"x"}}`);
      expect(root.children).toEqual([cond({ field: 'a', op: wrongKey, valType: 'string', value: 'x' })]);
    },
  );
});

describe('isRepresentableArrayElement — element-level sentinel exactness (§2b)', () => {
  it('a nested array element is not representable (isPlainObject false branch)', () => {
    const root = mustParse('{"a":{"$in":[1,[2,3]]}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it('a multi-key object element is not representable (keys.length !== 1 branch)', () => {
    const root = mustParse('{"a":{"$in":[1,{"$oid":"x","extra":1}]}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it('a single-key object element with an unrecognized key is not representable', () => {
    const root = mustParse('{"a":{"$in":[1,{"$foo":"x"}]}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it.each(['$oid', '$date', '$numberLong', '$numberDecimal'])(
    'a single-key %s element with a non-string value is not representable',
    (key) => {
      const root = mustParse(`{"a":{"$in":[1,{"${key}":123}]}}`);
      expect(root.children).toHaveLength(1);
      expect(root.children[0].kind).toBe('raw');
    },
  );

  it('every sentinel-shaped element kind is representable together in one array', () => {
    const root = mustParse(
      '{"a":{"$in":[1,"x",true,null,{"$oid":"507f1f77bcf86cd799439011"},{"$date":"2024-01-01T00:00:00.000Z"},{"$numberLong":"9"},{"$numberDecimal":"9.5"}]}}',
    );
    expect(root.children).toEqual([
      cond({
        field: 'a',
        op: '$in',
        valType: 'array',
        value: JSON.stringify([
          1,
          'x',
          true,
          null,
          { $oid: '507f1f77bcf86cd799439011' },
          { $date: '2024-01-01T00:00:00.000Z' },
          { $numberLong: '9' },
          { $numberDecimal: '9.5' },
        ]),
      }),
    ]);
  });
});

describe('guessValue — $regex-as-value branch (distinct from the $regex operator, §2b)', () => {
  it('a single-key {$regex: string} value is representable as valType regex', () => {
    const root = mustParse('{"a":{"$eq":{"$regex":"x.*"}}}');
    expect(root.children).toEqual([cond({ field: 'a', op: '$eq', valType: 'regex', value: 'x.*' })]);
  });

  it('a non-string $regex value is not representable', () => {
    const root = mustParse('{"a":{"$eq":{"$regex":123}}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it('a two-key object with $regex plus another key is not representable', () => {
    const root = mustParse('{"a":{"$eq":{"$regex":"x","extra":1}}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });

  it('a single-key object with a different key is not representable', () => {
    const root = mustParse('{"a":{"$eq":{"$notregex":"x"}}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].kind).toBe('raw');
  });
});

describe('UNREPRESENTABLE_SENTINEL_KEYS — short-circuits before the operator-map fallback (§2b)', () => {
  // $minKey/$maxKey/$code already distinguish the fast path from the
  // fallback (their values are simple representable literals, so removing
  // them from the set would visibly change the parse). $binary/$timestamp/
  // $regularExpression/$dbPointer normally carry multi-key object values,
  // which guessValue rejects either way — so a *realistic* value can't tell
  // the two paths apart. A contrived value shaped like the $regex sentinel
  // can: it proves the set is checked first, not just that the end result
  // happens to match for ordinary BSON-shaped input.
  it.each(['$binary', '$timestamp', '$regularExpression', '$dbPointer'])(
    'a contrived %s value shaped like the $regex sentinel is still raw, never smuggled through as a cond',
    (key) => {
      const src = `{"a":{"${key}":{"$regex":"x"}}}`;
      expect(mustParse(src).children).toEqual([raw(src)]);
    },
  );
});

describe('parseOperatorMap — every guess must be representable to split (§2a)', () => {
  it('one representable and one unrepresentable value in a splittable pair blocks the split', () => {
    const root = mustParse('{"a":{"$gte":1,"$lte":{"nested":1}}}');
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toEqual(raw('{"a":{"$gte":1,"$lte":{"nested":1}}}'));
  });

  it('a multi-key predicate combining every SPLITTABLE_OPS entry splits fully, proving each literal is a real member (§2a)', () => {
    const src =
      '{"a":{"$eq":1,"$ne":2,"$gt":3,"$gte":4,"$lt":5,"$lte":6,"$in":[1],"$nin":[2],"$all":[3],"$exists":true,"$type":1,"$size":1,"$mod":[2,1],"$regex":"x","$bitsAllClear":1,"$bitsAnyClear":1,"$bitsAllSet":1,"$bitsAnySet":1}}';
    const root = mustParse(src);
    expect(root.children).toHaveLength(18);
    expect(root.children.every((c) => c.kind === 'cond')).toBe(true);
  });
});

describe('parseArrayItem — a non-object array item degrades to a raw node (§2)', () => {
  it('a bare scalar as an $and array item becomes raw, not a parse failure', () => {
    const root = mustParse('{"$and":[1,{"a":2}]}');
    expect(root.children[0]).toEqual(raw('1'));
    expect(root.children[1]).toEqual(cond({ field: 'a', op: '$eq', valType: 'number', value: '2' }));
  });
});

describe('parseFilter — exact failure reasons (§2)', () => {
  it('invalid JSON reports "Invalid JSON"', () => {
    const r = parseFilter('not json');
    expect(r).toEqual({ ok: false, reason: 'Invalid JSON' });
  });

  it('a non-object root reports "Root must be an object"', () => {
    const r = parseFilter('[1,2,3]');
    expect(r).toEqual({ ok: false, reason: 'Root must be an object' });
  });

  it('blank or whitespace-only text is still invalid JSON', () => {
    for (const blank of ['', '   ', '\u00a0\ufeff']) {
      expect(parseFilter(blank)).toEqual({ ok: false, reason: 'Invalid JSON' });
    }
  });
});

// The Run gate accepts a filter padded with the Unicode spaces `trim` strips
// and `JSON.parse` refuses; the drawer and add-to-filter read the same text.
describe('parseFilter — Unicode-space padding', () => {
  it('parses NBSP/BOM/em-space-padded text to the same tree as the trimmed text', () => {
    const text = '{"status":"active","age":{"$gt":3}}';
    const trimmed = parseFilter(text);
    expect(trimmed.ok).toBe(true);
    for (const padded of [`\u00a0${text}\u00a0`, `\ufeff${text}`, `\u2003${text}\u2003\n`]) {
      expect(parseFilter(padded)).toEqual(trimmed);
    }
  });
});

// ─── Exported wire-encoding helpers (also used by builder.ts) ──────────────

describe('coerceArrayElementWire — direct (exported for builder.ts reuse)', () => {
  it('objectid: wraps a bare string, passes an already-wrapped element through', () => {
    expect(coerceArrayElementWire('507f1f77bcf86cd799439011', 'objectid')).toEqual({
      $oid: '507f1f77bcf86cd799439011',
    });
    expect(coerceArrayElementWire({ $oid: 'already' }, 'objectid')).toEqual({ $oid: 'already' });
  });

  it('long: wraps a bare value with trim, passes an already-wrapped element through unchanged', () => {
    expect(coerceArrayElementWire(' 123 ', 'long')).toEqual({ $numberLong: '123' });
    expect(coerceArrayElementWire({ $numberLong: '999' }, 'long')).toEqual({ $numberLong: '999' });
  });

  it('long: null is not an already-wrapped element, so it gets wrapped too', () => {
    expect(coerceArrayElementWire(null, 'long')).toEqual({ $numberLong: 'null' });
  });

  it('decimal: wraps a bare value with trim, passes an already-wrapped element through unchanged', () => {
    expect(coerceArrayElementWire(' 1.5 ', 'decimal')).toEqual({ $numberDecimal: '1.5' });
    expect(coerceArrayElementWire({ $numberDecimal: '9.9' }, 'decimal')).toEqual({ $numberDecimal: '9.9' });
  });

  it('date: wraps a bare string, passes an already-wrapped element through unchanged', () => {
    expect(coerceArrayElementWire('2024-01-01', 'date')).toEqual({ $date: '2024-01-01' });
    expect(coerceArrayElementWire({ $date: 'already' }, 'date')).toEqual({ $date: 'already' });
  });

  it('number: converts a non-number via Number(), passes a number through', () => {
    expect(coerceArrayElementWire('42', 'number')).toBe(42);
    expect(coerceArrayElementWire(42, 'number')).toBe(42);
  });

  it('boolean: passes booleans through, coerces only the literal string "true"', () => {
    expect(coerceArrayElementWire(true, 'boolean')).toBe(true);
    expect(coerceArrayElementWire('true', 'boolean')).toBe(true);
    expect(coerceArrayElementWire('false', 'boolean')).toBe(false);
    expect(coerceArrayElementWire('anything else', 'boolean')).toBe(false);
  });

  it('string: stringifies', () => {
    expect(coerceArrayElementWire(42, 'string')).toBe('42');
  });

  it('an unhandled valType (e.g. array/regex/null) passes the element through unchanged', () => {
    expect(coerceArrayElementWire('x', 'array')).toBe('x');
  });
});

describe('buildScalarWire — direct (exported for builder.ts reuse)', () => {
  it('string: returns verbatim', () => expect(buildScalarWire('string', 'x')).toBe('x'));
  it('number: converts via Number()', () => expect(buildScalarWire('number', '42')).toBe(42));
  it('long: wraps with trim', () => expect(buildScalarWire('long', ' 123 ')).toEqual({ $numberLong: '123' }));
  it('decimal: wraps with trim', () =>
    expect(buildScalarWire('decimal', ' 1.5 ')).toEqual({ $numberDecimal: '1.5' }));
  it('boolean: only the literal string "true" becomes true', () => {
    expect(buildScalarWire('boolean', 'true')).toBe(true);
    expect(buildScalarWire('boolean', 'false')).toBe(false);
    expect(buildScalarWire('boolean', 'anything')).toBe(false);
  });
  it('date: wraps as $date', () => expect(buildScalarWire('date', '2024-01-01')).toEqual({ $date: '2024-01-01' }));
  it('null: always null regardless of value text', () => expect(buildScalarWire('null', 'ignored')).toBeNull());
  it('regex: wraps as $regex', () => expect(buildScalarWire('regex', 'x.*')).toEqual({ $regex: 'x.*' }));
  it('objectid: wraps as $oid', () =>
    expect(buildScalarWire('objectid', '507f1f77bcf86cd799439011')).toEqual({
      $oid: '507f1f77bcf86cd799439011',
    }));
  it('array: parses JSON, empty array on parse failure', () => {
    expect(buildScalarWire('array', '[1,2,3]')).toEqual([1, 2, 3]);
    expect(buildScalarWire('array', 'not json')).toEqual([]);
  });
});

describe('parseJsonArrayLenient — direct (exported for builder.ts reuse)', () => {
  it('parses a valid JSON array', () => expect(parseJsonArrayLenient('[1,2,3]')).toEqual([1, 2, 3]));
  it('returns [] for valid JSON that is not an array', () => expect(parseJsonArrayLenient('{"a":1}')).toEqual([]));
  it('returns [] for invalid JSON', () => expect(parseJsonArrayLenient('not json')).toEqual([]));
});

// ─── condValueProblem — isScalarNumeric exclusions (§3a) ────────────────────

describe('condValueProblem — isScalarNumeric excludes $mod and array-value ops (§3a)', () => {
  it('$mod is excluded from the scalar-number checks even hand-built with valType number', () => {
    const root = group('$and', [cond({ op: '$mod', valType: 'number', value: '[2,1]' })]);
    expect(printFilter(root).ok).toBe(true);
  });

  it('an array-value op is excluded from the scalar-number checks even hand-built with valType number', () => {
    const root = group('$and', [cond({ op: '$in', valType: 'number', value: '[1,2]' })]);
    expect(printFilter(root).ok).toBe(true);
  });

  it('an empty numeric value is excluded from scalar-number checks — encodes as 0 rather than blocking', () => {
    const root = group('$and', [cond({ valType: 'number', value: '' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ a: { $eq: 0 } });
  });
});

describe('condValueProblem — $mod divisor/remainder finiteness (§3)', () => {
  it('a non-numeric divisor blocks with the finite-number message', () => {
    const p = printFilter(group('$and', [cond({ op: '$mod', value: '["x",1]' })]));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].message).toBe('$mod divisor must be a finite number');
  });

  it('a non-numeric remainder blocks with the finite-number message', () => {
    const p = printFilter(group('$and', [cond({ op: '$mod', value: '[1,"x"]' })]));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].message).toBe('$mod remainder must be a finite number');
  });

  it('a divisor of 1e400 (parses to Infinity) blocks as non-finite, not just non-numeric', () => {
    const p = printFilter(group('$and', [cond({ op: '$mod', value: '[1e400,1]' })]));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].message).toBe('$mod divisor must be a finite number');
  });

  it('a remainder of 1e400 (parses to Infinity) blocks as non-finite, not just non-numeric', () => {
    const p = printFilter(group('$and', [cond({ op: '$mod', value: '[1,1e400]' })]));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].message).toBe('$mod remainder must be a finite number');
  });
});

// ─── encodeCondValue — every op family, exact encoded shape (§3) ───────────

describe('encodeCondValue — SIMPLE_OPS / ARRAY_VALUE_OPS membership (§3)', () => {
  it.each(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'])('%s uses buildScalarWire (simple ops)', (op) => {
    expect(roundTrip(`{"a":{"${op}":5}}`)).toBe(`{"a":{"${op}":5}}`);
  });

  it.each(['$in', '$nin', '$all'])('%s uses the array-element wire coercion', (op) => {
    expect(roundTrip(`{"a":{"${op}":[1,2]}}`)).toBe(`{"a":{"${op}":[1,2]}}`);
  });
});

describe('encodeCondValue — $size / bits ops encode as a number (§3)', () => {
  it('$size with a non-numeric value encodes as 0', () => {
    const p = printFilter(group('$and', [cond({ op: '$size', value: 'abc' })]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ a: { $size: 0 } });
  });

  it.each(['$bitsAllClear', '$bitsAnyClear', '$bitsAllSet', '$bitsAnySet'])(
    '%s encodes value as a number, proving membership in BITS_OPS',
    (op) => {
      const p = printFilter(group('$and', [cond({ op, value: '5' })]));
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(JSON.parse(p.json)).toEqual({ a: { [op]: 5 } });
    },
  );
});

// ─── Long/decimal regex validation — sign and shape edges (§3) ─────────────

describe('long/decimal regex validation — sign and shape edges (§3)', () => {
  it('a leading + or - sign is valid for long', () => {
    expect(printFilter(group('$and', [cond({ valType: 'long', value: '+123' })])).ok).toBe(true);
    expect(printFilter(group('$and', [cond({ valType: 'long', value: '-123' })])).ok).toBe(true);
  });

  it('surrounding whitespace is trimmed before validating a long value', () => {
    expect(printFilter(group('$and', [cond({ valType: 'long', value: ' 123 ' })])).ok).toBe(true);
  });

  it('a bare sign with no digits is invalid for long', () => {
    expect(printFilter(group('$and', [cond({ valType: 'long', value: '+' })])).ok).toBe(false);
  });

  it('a leading + or - sign, and every numeric shape, is valid for decimal', () => {
    for (const v of ['+1.5', '-1.5', '+.5', '-.5', '+1', '1.5e10', '1.5e-10', '.5e+3']) {
      expect(printFilter(group('$and', [cond({ valType: 'decimal', value: v })])).ok).toBe(true);
    }
  });

  it('a lone decimal point, or an exponent with no digits, is invalid for decimal', () => {
    for (const v of ['.', '1.5e', '1.5e+']) {
      expect(printFilter(group('$and', [cond({ valType: 'decimal', value: v })])).ok).toBe(false);
    }
  });
});

describe('condValueProblem / encodeCondValue — .trim() edges on user-typed text (§3)', () => {
  it('$exists trims whitespace before comparing to "false"', () => {
    const p = printFilter(group('$and', [cond({ op: '$exists', value: ' false ' })]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ a: { $exists: false } });
  });

  it('a whitespace-only field is treated as pending, just like a truly empty field', () => {
    const root = group('$and', [cond({ field: '   ' }), cond({ field: 'good', value: 'ok' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ good: { $eq: 'ok' } });
  });

  it('toRawNode treats a whitespace-only field as pending too', () => {
    expect(toRawNode(cond({ field: '   ' }))).toEqual(raw(''));
  });

  it('a whitespace-only raw json is treated as pending, just like empty', () => {
    const root = group('$and', [raw('   '), cond({ field: 'good', value: 'ok' })]);
    const p = printFilter(root);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ good: { $eq: 'ok' } });
  });
});

describe('parseRawWithPrecisionCheck — exact failure reasons (§3a)', () => {
  it('a non-object raw JSON reports "Raw clause must be a JSON object"', () => {
    const p = printFilter(group('$and', [raw('[1,2,3]')]));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems).toEqual([{ path: [0], message: 'Raw clause must be a JSON object' }]);
  });

  it('a lossy raw JSON reports the number-precision message', () => {
    const p = printFilter(group('$and', [raw('{"a":9007199254740993}')]));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].message).toBe(
      'Contains a number too large to represent exactly — use {"$numberLong": "..."} or {"$numberDecimal": "..."} instead',
    );
  });
});

// ─── Fixpoint (§3b, §11) ─────────────────────────────────────────────────────

const CORPUS: string[] = [
  '{}',
  '{"name":"x"}',
  '{"name":{"$eq":"x"}}',
  '{"a":1,"b":2}',
  '{"$and":[{"a":1},{"b":2}]}',
  '{"$or":[{"a":1},{"b":2}]}',
  '{"$nor":[{"a":1}]}',
  '{"a":{"$gte":1,"$lte":5}}',
  '{"a":{"$regex":"x","$options":"i"}}',
  '{"items":{"$elemMatch":{"sku":1}}}',
  '{"$expr":{"$gt":["$a","$b"]}}',
  '{"a":{"$not":{"$gt":5}}}',
  '{"loc":{"$near":{"type":"Point","coordinates":[0,0]},"$maxDistance":10}}',
  '{"$and":[{"$or":[{"a":1},{"b":2}]},{"c":3}]}',
  '{"status":"active","qty":{"$gt":5}}',
  '{"$or":[{"x":1},{"y":2}],"a":3}',
  '{"$and":{"foo":1}}',
  '{"a":{"$eq":{"nested":1}}}',
  '{"a":{"$in":[1,{"nested":1}]}}',
  '{"a":{"$oid":"507f1f77bcf86cd799439011"}}',
  '{"a":{"$date":"2024-01-01T00:00:00.000Z"}}',
  '{"a":{"$numberLong":"9223372036854775807"}}',
  '{"a":{"$numberDecimal":"12345.6789"}}',
  '{"a":true,"b":null}',
  '{"a":{"$in":[1,2,3]}}',
  '{"a":{"$exists":false}}',
  '{"a":{"$exists":true}}',
  '{"a":{"$mod":[2,1]}}',
  '{"a":{"$size":3}}',
  '{"a":{"$bitsAllSet":5}}',
  '{"tags":["a","b"]}',
];

describe('fixpoint (§3b)', () => {
  it.each(CORPUS)('print(parse(print(parse(s)))) === print(parse(s)) for %s', (s) => {
    const parsed1 = parseFilter(s);
    expect(parsed1.ok).toBe(true);
    if (!parsed1.ok) return;
    const printed1 = printFilter(parsed1.root);
    if (!printed1.ok) return; // property is vacuous when the first print fails
    const parsed2 = parseFilter(printed1.json);
    expect(parsed2.ok).toBe(true);
    if (!parsed2.ok) return;
    const printed2 = printFilter(parsed2.root);
    expect(printed2.ok).toBe(true);
    if (!printed2.ok) return;
    expect(printed2.json).toBe(printed1.json);
  });
});

// ─── Semantics — hand-checked pairs (§3b, §11) ──────────────────────────────

describe('semantics — hand-checked (input, expectedOutput) pairs', () => {
  const pairs: Array<[string, string]> = [
    ['{}', '{}'],
    ['{"name":"x"}', '{"name":{"$eq":"x"}}'],
    [
      '{"status":"active","qty":{"$gt":5}}',
      '{"$and":[{"status":{"$eq":"active"}},{"qty":{"$gt":5}}]}',
    ],
    ['{"a":{"$gte":1,"$lte":5}}', '{"$and":[{"a":{"$gte":1}},{"a":{"$lte":5}}]}'],
    [
      '{"a":{"$regex":"x","$options":"i"}}',
      '{"a":{"$regex":"x","$options":"i"}}',
    ],
    [
      '{"loc":{"$near":{"type":"Point","coordinates":[0,0]},"$maxDistance":10}}',
      '{"loc":{"$near":{"type":"Point","coordinates":[0,0]},"$maxDistance":10}}',
    ],
    [
      '{"$and":[{"$or":[{"a":1},{"b":2}]},{"c":3}]}',
      '{"$and":[{"$or":[{"a":{"$eq":1}},{"b":{"$eq":2}}]},{"c":{"$eq":3}}]}',
    ],
    [
      '{"$or":[{"x":1},{"y":2}],"a":3}',
      '{"$and":[{"$or":[{"x":{"$eq":1}},{"y":{"$eq":2}}]},{"a":{"$eq":3}}]}',
    ],
    // $exists preserves false rather than builder.ts's always-true encoding —
    // a deliberate divergence, pinned here so it can't silently regress.
    ['{"a":{"$exists":false}}', '{"a":{"$exists":false}}'],
    ['{"a":{"$exists":true}}', '{"a":{"$exists":true}}'],
    ['{"tags":["a","b"]}', '{"tags":{"$eq":["a","b"]}}'],
    ['{"a":{"$in":[1,2,3]}}', '{"a":{"$in":[1,2,3]}}'],
    ['{"a":{"$mod":[2,1]}}', '{"a":{"$mod":[2,1]}}'],
  ];

  it.each(pairs)('parse+print(%s) === %s', (input, expected) => {
    expect(roundTrip(input)).toBe(expected);
  });
});

// ─── Edit API (§4, §11) ──────────────────────────────────────────────────────

describe('nodeAt', () => {
  it('[] returns the root itself', () => {
    const root = group('$and', [cond()]);
    expect(nodeAt(root, [])).toBe(root);
  });

  it('resolves a nested path', () => {
    const inner = cond({ field: 'inner' });
    const root = group('$and', [group('$or', [inner])]);
    expect(nodeAt(root, [0, 0])).toEqual(inner);
  });

  it('returns null for an out-of-range index', () => {
    const root = group('$and', [cond()]);
    expect(nodeAt(root, [5])).toBeNull();
  });

  it('returns null when descending past a leaf', () => {
    const root = group('$and', [cond()]);
    expect(nodeAt(root, [0, 0])).toBeNull();
  });
});

describe('updateAt — purity and path arithmetic', () => {
  it('replaces the node at path without mutating the original', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]);
    const snapshot = structuredClone(root);
    const next = updateAt(root, [1], cond({ field: 'z' }));
    expect(root).toEqual(snapshot); // original untouched
    expect(next.children[1]).toEqual(cond({ field: 'z' }));
    expect(next.children[0]).toEqual(cond({ field: 'a' }));
  });

  it('updates a deeply nested node', () => {
    const root = group('$and', [group('$or', [cond({ field: 'x' })])]);
    const next = updateAt(root, [0, 0], cond({ field: 'y' }));
    expect(nodeAt(next, [0, 0])).toEqual(cond({ field: 'y' }));
  });

  it('replaces the whole root at an empty path when next is a group', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    const next = group('$or', [cond({ field: 'b' })]);
    expect(updateAt(root, [], next)).toEqual(next);
  });

  it('is a no-op at an empty path when next is not a group (root must stay a group)', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    expect(updateAt(root, [], cond({ field: 'z' }))).toEqual(root);
  });
});

describe('insertAt — purity and path arithmetic', () => {
  it('appends a new child without mutating the original', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    const snapshot = structuredClone(root);
    const next = insertAt(root, [], cond({ field: 'b' }));
    expect(root).toEqual(snapshot);
    expect(next.children).toHaveLength(2);
    expect(next.children[1]).toEqual(cond({ field: 'b' }));
  });

  it('inserts into a nested group', () => {
    const root = group('$and', [group('$or', [cond({ field: 'x' })])]);
    const next = insertAt(root, [0], cond({ field: 'y' }));
    expect(nodeAt(next, [0])).toMatchObject({ kind: 'group', children: expect.any(Array) });
    const inner = nodeAt(next, [0]);
    expect(inner?.kind === 'group' && inner.children).toHaveLength(2);
  });

  // the optional index that makes reorder possible.
  it('inserts at an explicit index: start, middle, and end', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' }), cond({ field: 'c' })]);
    expect(fields(insertAt(root, [], cond({ field: 'n' }), 0))).toEqual(['n', 'a', 'b', 'c']);
    expect(fields(insertAt(root, [], cond({ field: 'n' }), 1))).toEqual(['a', 'n', 'b', 'c']);
    expect(fields(insertAt(root, [], cond({ field: 'n' }), 3))).toEqual(['a', 'b', 'c', 'n']);
  });

  it('clamps an out-of-range index instead of throwing', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]);
    expect(fields(insertAt(root, [], cond({ field: 'n' }), -5))).toEqual(['n', 'a', 'b']);
    expect(fields(insertAt(root, [], cond({ field: 'n' }), 99))).toEqual(['a', 'b', 'n']);
  });

  it('inserts at an index inside a nested group', () => {
    const root = group('$and', [group('$or', [cond({ field: 'x' }), cond({ field: 'y' })])]);
    const inner = nodeAt(insertAt(root, [0], cond({ field: 'n' }), 1), [0]);
    expect(inner?.kind === 'group' && inner.children.map((c) => (c.kind === 'cond' ? c.field : '?'))).toEqual([
      'x',
      'n',
      'y',
    ]);
  });

  it('is a no-op when the parent path resolves to a non-group node', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    expect(insertAt(root, [0], cond({ field: 'z' }))).toEqual(root);
  });

  it('inserting into a nested group at index 1 does not touch the group at index 0', () => {
    const root = group('$and', [
      group('$or', [cond({ field: 'untouched' })]),
      group('$or', [cond({ field: 'x' })]),
    ]);
    const next = insertAt(root, [1], cond({ field: 'y' }));
    expect(nodeAt(next, [0])).toEqual(group('$or', [cond({ field: 'untouched' })]));
    const inner = nodeAt(next, [1]);
    expect(inner?.kind === 'group' && inner.children).toHaveLength(2);
  });
});

/** Field names of a group's direct children, for order assertions. */
function fields(g: GroupNode): string[] {
  return g.children.map((c) => (c.kind === 'cond' ? c.field : c.kind));
}

describe('moveAt — reorder within a group', () => {
  it('moves a child up and down without mutating the original', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' }), cond({ field: 'c' })]);
    const snapshot = structuredClone(root);
    expect(fields(moveAt(root, [2], -1))).toEqual(['a', 'c', 'b']);
    expect(fields(moveAt(root, [0], 1))).toEqual(['b', 'a', 'c']);
    expect(root).toEqual(snapshot);
  });

  it('is a no-op at either end, and for the root itself', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]);
    expect(moveAt(root, [0], -1)).toEqual(root);
    expect(moveAt(root, [1], 1)).toEqual(root);
    expect(moveAt(root, [], -1)).toEqual(root);
  });

  it('is a no-op when the path points to a nonexistent node', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    expect(moveAt(root, [99], 1)).toEqual(root);
  });

  it('is a no-op when the parent path resolves to a non-group node', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]);
    expect(moveAt(root, [0, 0], 1)).toEqual(root);
  });

  it('is a no-op when the parent path is itself out of range', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    expect(moveAt(root, [5, 0], 1)).toEqual(root);
  });

  it('reorders inside a nested group without disturbing the outer level', () => {
    const root = group('$and', [
      cond({ field: 'outer' }),
      group('$or', [cond({ field: 'x' }), cond({ field: 'y' }), cond({ field: 'z' })]),
    ]);
    const next = moveAt(root, [1, 2], -1);
    expect(fields(next)).toEqual(['outer', 'group']);
    const inner = nodeAt(next, [1]);
    expect(inner?.kind === 'group' && fields(inner)).toEqual(['x', 'z', 'y']);
  });

  it('reorders at depth 3', () => {
    const root = group('$and', [
      group('$or', [group('$and', [cond({ field: 'p' }), cond({ field: 'q' })])]),
    ]);
    const inner = nodeAt(moveAt(root, [0, 0, 1], -1), [0, 0]);
    expect(inner?.kind === 'group' && fields(inner)).toEqual(['q', 'p']);
  });

  it('leaves a single-child group intact — the empty-group prune never fires', () => {
    const root = group('$and', [group('$or', [cond({ field: 'only' })]), cond({ field: 'sibling' })]);
    expect(moveAt(root, [0, 0], -1)).toEqual(root);
    expect(moveAt(root, [0, 0], 1)).toEqual(root);
  });
});

describe('removeAt — purity, path arithmetic, and empty-group collapsing', () => {
  it('removes a leaf without mutating the original', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]);
    const snapshot = structuredClone(root);
    const next = removeAt(root, [0]);
    expect(root).toEqual(snapshot);
    expect(next.children).toEqual([cond({ field: 'b' })]);
  });

  it('the root group is never removed, even for an empty path', () => {
    const root = group('$and', [cond()]);
    expect(removeAt(root, [])).toEqual(root);
  });

  it('the root survives becoming empty', () => {
    const root = group('$and', [cond()]);
    const next = removeAt(root, [0]);
    expect(next).toEqual(group('$and', []));
  });

  it('removing the last child of a nested group removes the empty group too', () => {
    const root = group('$and', [group('$or', [cond({ field: 'only' })]), cond({ field: 'sibling' })]);
    const next = removeAt(root, [0, 0]);
    // The now-empty $or group is pruned, leaving just the sibling.
    expect(next.children).toEqual([cond({ field: 'sibling' })]);
  });

  it('cascades the collapse through multiple nested levels', () => {
    const root = group('$and', [
      group('$or', [group('$and', [cond({ field: 'deep' })])]),
    ]);
    const next = removeAt(root, [0, 0, 0]);
    expect(next).toEqual(group('$and', []));
  });

  it('removing from a nested group at index 1 does not touch the group at index 0', () => {
    const root = group('$and', [
      group('$or', [cond({ field: 'untouched' })]),
      group('$or', [cond({ field: 'x' }), cond({ field: 'y' })]),
    ]);
    const next = removeAt(root, [1, 0]);
    expect(nodeAt(next, [0])).toEqual(group('$or', [cond({ field: 'untouched' })]));
  });

  it('descending past a leaf is a no-op, not a crash', () => {
    const root = group('$and', [group('$or', [cond({ field: 'x' })])]);
    expect(removeAt(root, [0, 0, 5])).toEqual(root);
  });
});

describe('wrapInGroup — purity', () => {
  it('wraps the node at path in a new group without mutating the original', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]);
    const snapshot = structuredClone(root);
    const next = wrapInGroup(root, [0], '$or');
    expect(root).toEqual(snapshot);
    expect(next.children[0]).toEqual(group('$or', [cond({ field: 'a' })]));
    expect(next.children[1]).toEqual(cond({ field: 'b' }));
  });
});

describe('toRawNode', () => {
  it('best-effort encodes a valid cond', () => {
    const c = cond({ field: 'a', op: '$eq', valType: 'string', value: 'x' });
    expect(toRawNode(c)).toEqual(raw('{"a":{"$eq":"x"}}'));
  });

  it('falls back to a blank pending raw node for an empty field, never {}', () => {
    const c = cond({ field: '' });
    const result = toRawNode(c);
    expect(result).toEqual(raw(''));
    expect(result.json).not.toBe('{}');
  });

  it('falls back to a blank pending raw node for an invalid value, never {}', () => {
    const c = cond({ field: 'a', valType: 'number', value: 'not a number' });
    const result = toRawNode(c);
    expect(result).toEqual(raw(''));
    expect(result.json).not.toBe('{}');
  });
});

describe('tryParseRaw', () => {
  it('a clause modeling to more than one cond returns an $and-wrapped group', () => {
    const result = tryParseRaw(raw('{"a":{"$gte":1},"b":2}'));
    expect(result.kind).toBe('group');
    if (result.kind !== 'group') return;
    expect(result.logic).toBe('$and');
    expect(result.children).toHaveLength(2);
  });

  it('a single-cond clause returns bare, not wrapped', () => {
    const result = tryParseRaw(raw('{"a":1}'));
    expect(result).toEqual(cond({ field: 'a', op: '$eq', valType: 'number', value: '1' }));
  });

  it('unparseable JSON is left unchanged', () => {
    const r = raw('{not json');
    expect(tryParseRaw(r)).toBe(r);
  });

  it('a non-object root is left unchanged', () => {
    const r = raw('[1,2,3]');
    expect(tryParseRaw(r)).toBe(r);
  });

  it('a clause §2 still cannot model (e.g. $elemMatch) is left content-equivalent (still raw)', () => {
    const result = tryParseRaw(raw('{"items":{"$elemMatch":{"sku":1}}}'));
    expect(result.kind).toBe('raw');
  });
});

// ─── Fast-check: generalizing §3b's fixpoint claim beyond the hand-picked
// CORPUS (§2, §3b) ───────────────────────────────────────────────────────────
//
// The hand-checked `fixpoint` describe block above proves the fixpoint
// property for a fixed, curated list of inputs — exactly the kind of gap
// mutation testing can't close, since it only strengthens assertions against
// inputs someone already wrote. These two properties re-run parseFilter's
// own claims ("Total on any valid JSON object", §3b's fixpoint guarantee)
// against generated input shapes nobody hand-picked.

describe('parseFilter/printFilter — fast-check: totality + fixpoint (§2, §3b)', () => {
  // Recognized value sentinels (§2b) — generated as real EJSON-sentinel
  // shapes so the operator/value-guessing paths (guessValue, guessSentinelOnly)
  // get exercised, not just the plain-scalar paths.
  const sentinelValue = fc.oneof(
    fc.string().map((s) => ({ $oid: s })),
    fc.string().map((s) => ({ $date: s })),
    fc.string().map((s) => ({ $numberLong: s })),
    fc.string().map((s) => ({ $numberDecimal: s })),
    fc.string().map((s) => ({ $regex: s })),
  );
  const scalarValue = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
  const representableArrayElement = fc.oneof(scalarValue, sentinelValue);
  const fieldValue = fc.oneof(
    scalarValue,
    sentinelValue,
    fc.array(representableArrayElement, { maxLength: 4 }),
  );
  const singleOp = fc.constantFrom(
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$all', '$exists', '$size',
  );
  // A single-key operator map is always in SPLITTABLE_OPS's trivial case
  // (keys.length === 1 skips the allowlist check entirely, §2a) — realistic
  // shape for what a field predicate actually looks like on the wire.
  const fieldPredicate = fc.oneof(
    fieldValue, // implicit $eq
    fc.dictionary(singleOp, fieldValue, { minKeys: 1, maxKeys: 1 }),
  );
  const fieldName = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.startsWith('$'));
  const filterClause = fc.dictionary(fieldName, fieldPredicate, { maxKeys: 4 });

  // Totally free-form JSON objects too — parseFilter's docstring claims
  // totality on ANY valid JSON object, not just filter-shaped ones. fc.jsonValue
  // only produces real JSON types (no NaN/Infinity/undefined), matching what
  // JSON.parse actually hands parseFilter in production.
  const arbitraryJsonObject = fc.dictionary(fc.string({ maxLength: 10 }), fc.jsonValue({ maxDepth: 2 }), {
    maxKeys: 5,
  });

  const anyInput = fc.oneof(filterClause, arbitraryJsonObject);

  it('parseFilter never fails on a JSON object, regardless of shape', () => {
    fc.assert(
      fc.property(anyInput, (obj) => {
        const result = parseFilter(JSON.stringify(obj));
        expect(result.ok).toBe(true);
      }),
    );
  });

  it('printFilter is a fixpoint after one normalization pass, for generated input', () => {
    fc.assert(
      fc.property(anyInput, (obj) => {
        const parsed1 = parseFilter(JSON.stringify(obj));
        expect(parsed1.ok).toBe(true);
        if (!parsed1.ok) return;
        const printed1 = printFilter(parsed1.root);
        // Skip (not pass) a non-printable generated input: fc.pre excludes this
        // run from the requested count instead of counting it as a vacuous
        // success, and fast-check itself fails loudly if too few runs qualify.
        fc.pre(printed1.ok);
        if (!printed1.ok) return;
        const parsed2 = parseFilter(printed1.json);
        expect(parsed2.ok).toBe(true);
        if (!parsed2.ok) return;
        const printed2 = printFilter(parsed2.root);
        expect(printed2.ok).toBe(true);
        if (!printed2.ok) return;
        expect(printed2.json).toBe(printed1.json);
      }),
    );
  });
});

// ─── Mutation-sweep gap fills ────────────────────────────────────────────────
//
// The tests below close specific mutation-testing survivors found scoping
// `npx stryker run --mutate src/pages/Workspace/filterTree.ts`. Each is a real
// behavioral distinction (not an equivalent mutant) — the file itself carries
// `// Stryker disable next-line` annotations, with evidence, for the mutants
// that turned out to be genuinely equivalent instead.

describe('guessSentinelOnly — multi-key guard (§2b)', () => {
  it('a multi-key object whose first key looks like a value sentinel is still raw, never smuggled through', () => {
    // Without the keys.length === 1 guard, guessSentinelOnly would match on
    // the first key alone and silently drop the "extra" field from the filter.
    const src = '{"a":{"$eq":{"$oid":"507f1f77bcf86cd799439011","extra":1}}}';
    const root = mustParse(src);
    expect(root.children).toEqual([raw(src)]);
  });
});

describe('guessValue — null/boolean scalars produce the exact cond shape (§2b)', () => {
  it('a null field value is a cond with valType null and empty text', () => {
    expect(mustParse('{"a":null}').children).toEqual([
      cond({ field: 'a', op: '$eq', valType: 'null', value: '' }),
    ]);
  });

  it('a boolean field value is a cond with valType boolean and stringified text', () => {
    expect(mustParse('{"a":true}').children).toEqual([
      cond({ field: 'a', op: '$eq', valType: 'boolean', value: 'true' }),
    ]);
  });
});

describe('guessValue — sentinel match nested under an operator value (§2b)', () => {
  it('{$eq: {$oid: ...}} guesses the objectid sentinel, not a raw fallback', () => {
    const oid = '507f1f77bcf86cd799439011';
    expect(mustParse(`{"a":{"$eq":{"$oid":"${oid}"}}}`).children).toEqual([
      cond({ field: 'a', op: '$eq', valType: 'objectid', value: oid }),
    ]);
  });
});

describe('parseFieldPredicate — the operator-map gate rejects non-$ and empty key sets (§2)', () => {
  it('an empty-object field value is one raw node, never silently dropped', () => {
    const src = '{"a":{}}';
    expect(mustParse(src).children).toEqual([raw(src)]);
  });

  it('a single non-$ key is never mistaken for an operator — stays raw, never becomes a cond', () => {
    const src = '{"a":{"foo":"bar"}}';
    expect(mustParse(src).children).toEqual([raw(src)]);
  });

  it('a field-value array with an unrepresentable element is one raw node (not the $in path)', () => {
    const src = '{"a":[1,{"nested":1}]}';
    expect(mustParse(src).children).toEqual([raw(src)]);
  });
});

describe('buildScalarWire — unknown valType falls through to the defensive default', () => {
  it('an out-of-union valType (reachable only via an unsafe cast) passes the value through', () => {
    expect(buildScalarWire('bogus' as unknown as CondNode['valType'], 'x')).toBe('x');
  });
});

describe('encodeCondValue — $type encodes numerically when possible, else the raw text (§3)', () => {
  it('a numeric $type alias encodes as a number', () => {
    const p = printFilter(group('$and', [cond({ op: '$type', value: '2' })]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ a: { $type: 2 } });
  });

  it('a string $type alias (e.g. "string") is not numeric — encodes as the text itself', () => {
    const p = printFilter(group('$and', [cond({ op: '$type', value: 'string' })]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ a: { $type: 'string' } });
  });

  it('an empty $type value is excluded from the numeric branch even though Number("") is finite', () => {
    const p = printFilter(group('$and', [cond({ op: '$type', value: '' })]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ a: { $type: '' } });
  });

  it('a whitespace-only $type value is excluded via trim(), not just a literal-empty check', () => {
    // Number('   ') is 0 (finite) and '   ' !== '' is true (untrimmed) — only
    // checking value.trim() !== '' correctly excludes this from the numeric
    // branch, leaving the original whitespace text untouched.
    const p = printFilter(group('$and', [cond({ op: '$type', value: '   ' })]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(JSON.parse(p.json)).toEqual({ a: { $type: '   ' } });
  });
});

describe('condValueProblem — $mod array-length guard (§3)', () => {
  it('a 3-element $mod array blocks with the exact 2-element message, not a divisor/remainder message', () => {
    // Without this guard, destructuring [divisor, remainder] from a 3-element
    // array silently ignores the third element instead of rejecting it.
    const p = printFilter(group('$and', [cond({ op: '$mod', value: '[1,2,3]' })]));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0].message).toBe('$mod value must be a 2-element array, e.g. [2, 1]');
  });
});

describe('condValueProblem — isScalarNumeric on a genuinely empty/blank long value (§3a)', () => {
  it('a whitespace-only long value is excluded from the integer-format check, not blocked', () => {
    const p = printFilter(group('$and', [cond({ valType: 'long', op: '$gt', value: '   ' })]));
    expect(p.ok).toBe(true);
  });

  it('a fully empty long value is excluded from the integer-format check, not blocked', () => {
    const p = printFilter(group('$and', [cond({ valType: 'long', op: '$gt', value: '' })]));
    expect(p.ok).toBe(true);
  });
});

describe('condValueProblem — decimal regex exactness (§3, S8786 rewrite)', () => {
  it('leading garbage before an otherwise-valid decimal blocks (proves the ^ anchor)', () => {
    const p = printFilter(group('$and', [cond({ valType: 'decimal', value: 'abc1.5' })]));
    expect(p.ok).toBe(false);
  });

  it('a multi-digit integer part is valid (proves \\d+, not a single \\d)', () => {
    const p = printFilter(group('$and', [cond({ valType: 'decimal', value: '12.5' })]));
    expect(p.ok).toBe(true);
  });

  it('a multi-digit fractional part after an integer part is valid (proves \\.\\d*, not \\.\\d)', () => {
    const p = printFilter(group('$and', [cond({ valType: 'decimal', value: '1.55' })]));
    expect(p.ok).toBe(true);
  });

  it('a multi-digit fractional part with no leading integer digit is valid (proves \\.\\d+, not \\.\\d)', () => {
    const p = printFilter(group('$and', [cond({ valType: 'decimal', value: '.55' })]));
    expect(p.ok).toBe(true);
  });

  it('surrounding whitespace is trimmed before validating a decimal value', () => {
    const p = printFilter(group('$and', [cond({ valType: 'decimal', value: ' 1.5 ' })]));
    expect(p.ok).toBe(true);
  });
});

describe('updateAt — descending past a leaf is a no-op, not a crash (§4)', () => {
  it('an over-long path through a cond leaf leaves the tree unchanged', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    expect(() => updateAt(root, [0, 0], cond({ field: 'z' }))).not.toThrow();
    expect(updateAt(root, [0, 0], cond({ field: 'z' }))).toEqual(root);
  });
});

describe('removeAt — an empty path returns the exact same root reference (§4)', () => {
  it('is a true identity no-op, not merely a structurally-equal copy', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]);
    expect(removeAt(root, [])).toBe(root);
  });
});

describe('moveAt — an out-of-range path is a no-op even when the arithmetic would land in-bounds (§4)', () => {
  it('never moves a nonexistent node into a real slot', () => {
    const root = group('$and', [cond({ field: 'a' }), cond({ field: 'b' }), cond({ field: 'c' })]);
    // path [5] doesn't resolve (only indices 0-2 exist); delta -3 would put
    // a *real* index-5 node at slot 2 — but there is no such node.
    expect(moveAt(root, [5], -3)).toEqual(root);
  });
});

describe('printFilter — a disabled node prints as pending (§3)', () => {
  it('leaves a disabled cond out of the printed filter', () => {
    const root = group('$and', [
      cond({ field: 'a', valType: 'number', value: '1' }),
      { ...cond({ field: 'b', valType: 'number', value: '2' }), disabled: true },
    ]);
    expect(printFilter(root)).toEqual({ ok: true, json: '{"a":{"$eq":1}}' });
  });

  it('a disabled cond with an invalid value raises no problem', () => {
    const root = group('$and', [{ ...cond({ field: 'n', valType: 'number', value: 'abc' }), disabled: true }]);
    expect(printFilter(root)).toEqual({ ok: true, json: '{}' });
  });

  it('a disabled raw node with invalid JSON raises no problem', () => {
    const root = group('$and', [cond({ field: 'a' }), { ...raw('{nope'), disabled: true }]);
    expect(printFilter(root)).toEqual({ ok: true, json: '{"a":{"$eq":"x"}}' });
  });

  it('omits a disabled nested group whole, even when a child would block', () => {
    const root = group('$and', [
      cond({ field: 'a' }),
      { ...group('$or', [cond({ field: 'n', valType: 'number', value: 'abc' }), cond({ field: 'b' })]), disabled: true },
    ]);
    expect(printFilter(root)).toEqual({ ok: true, json: '{"a":{"$eq":"x"}}' });
  });

  it('omits a $nor group whose only child is disabled, never printing {"$nor":[]}', () => {
    const root = group('$and', [
      cond({ field: 'a' }),
      group('$nor', [{ ...cond({ field: 'b' }), disabled: true }]),
    ]);
    expect(printFilter(root)).toEqual({ ok: true, json: '{"a":{"$eq":"x"}}' });
  });

  it('prints {} when every node is disabled', () => {
    const root = group('$or', [
      { ...cond({ field: 'a' }), disabled: true },
      { ...raw('{"b":1}'), disabled: true },
      { ...group('$and', [cond({ field: 'c' })]), disabled: true },
    ]);
    expect(printFilter(root)).toEqual({ ok: true, json: '{}' });
  });

  it('parseFilter never sets disabled on any node', () => {
    const parsed = mustParse(
      '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":2},{"c":{"$elemMatch":{"d":1}}}]},{"$nor":[{"e":{"$gt":3}}]}]}',
    );
    const visit = (n: FilterNode): void => {
      expect(n).not.toHaveProperty('disabled');
      if (n.kind === 'group') n.children.forEach(visit);
    };
    visit(parsed);
  });

  it('toRawNode carries disabled over from the cond', () => {
    expect(toRawNode({ ...cond({ field: 'a' }), disabled: true })).toEqual({
      kind: 'raw',
      json: '{"a":{"$eq":"x"}}',
      disabled: true,
    });
    expect(toRawNode({ ...cond({ field: '' }), disabled: true })).toEqual({ kind: 'raw', json: '', disabled: true });
    expect(toRawNode(cond({ field: 'a' }))).not.toHaveProperty('disabled');
  });

  it('tryParseRaw carries disabled over to what it models', () => {
    expect(tryParseRaw({ ...raw('{"a":1}'), disabled: true })).toEqual({ ...cond({ field: 'a', valType: 'number', value: '1' }), disabled: true });
    expect(tryParseRaw({ ...raw('{"a":1,"b":2}'), disabled: true })).toMatchObject({ kind: 'group', disabled: true });
    expect(tryParseRaw(raw('{"a":1}'))).not.toHaveProperty('disabled');
  });
});

describe('unwrapGroup — the inverse of a one-child wrap (§4)', () => {
  it('replaces a single-child nested group with that child, in place', () => {
    const root = group('$and', [cond({ field: 'a' }), group('$nor', [cond({ field: 'b' })]), cond({ field: 'c' })]);
    expect(unwrapGroup(root, [1])).toEqual(
      group('$and', [cond({ field: 'a' }), cond({ field: 'b' }), cond({ field: 'c' })]),
    );
  });

  it('leaves a multi-child group alone', () => {
    const root = group('$and', [group('$nor', [cond({ field: 'a' }), cond({ field: 'b' })])]);
    expect(unwrapGroup(root, [0])).toBe(root);
  });

  it('never unwraps the root, even one whose only child is a group', () => {
    const root = group('$nor', [group('$or', [cond({ field: 'a' }), cond({ field: 'b' })])]);
    expect(unwrapGroup(root, [])).toBe(root);
  });

  it('leaves a cond path alone', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    expect(unwrapGroup(root, [0])).toBe(root);
  });

  it('leaves a path that does not resolve alone', () => {
    const root = group('$and', [group('$nor', [cond({ field: 'a' })])]);
    expect(unwrapGroup(root, [3])).toBe(root);
    expect(unwrapGroup(root, [0, 0, 0])).toBe(root);
  });

  it('a switched-off group hands its state to the child it leaves behind', () => {
    const root = group('$and', [{ ...group('$nor', [cond({ field: 'a' })]), disabled: true }]);
    expect(unwrapGroup(root, [0])).toEqual(group('$and', [{ ...cond({ field: 'a' }), disabled: true }]));
  });
});

describe('negation — a single-child $nor wrap (§4)', () => {
  it('wrapping a cond in $nor prints NOT that cond, and reads back as the same $nor', () => {
    const root = group('$and', [cond({ field: 'a', valType: 'number', value: '1' })]);
    const json = mustPrint(wrapInGroup(root, [0], '$nor'));
    expect(json).toBe('{"$nor":[{"a":{"$eq":1}}]}');
    // Reads back as the same tree: the NOT group under an $and root.
    expect(mustParse(json)).toEqual(wrapInGroup(root, [0], '$nor'));
  });

  it('a field-level $not still reads as a raw clause', () => {
    expect(mustParse('{"f":{"$not":{"$gt":1}}}')).toEqual(group('$and', [raw('{"f":{"$not":{"$gt":1}}}')]));
  });
});

describe('andAtRoot — require one more condition of the whole filter (§4)', () => {
  it('appends to an $and root', () => {
    const root = group('$and', [cond({ field: 'a' })]);
    expect(andAtRoot(root, cond({ field: 'b' }))).toEqual(group('$and', [cond({ field: 'a' }), cond({ field: 'b' })]));
  });

  it.each(['$or', '$nor'] as const)('ANDs with a root %s instead of joining it', (logic) => {
    const root = group(logic, [cond({ field: 'a' }), cond({ field: 'b' })]);
    const next = andAtRoot(root, cond({ field: 'c' }));
    expect(next).toEqual(group('$and', [root, cond({ field: 'c' })]));
    expect(mustPrint(next)).toBe(
      `{"$and":[{"${logic}":[{"a":{"$eq":"x"}},{"b":{"$eq":"x"}}]},{"c":{"$eq":"x"}}]}`,
    );
  });
});

describe('isGroupNode — a persisted tree is checked before it is trusted (§5.7)', () => {
  const good = group('$and', [
    { ...cond({ field: 'a' }), disabled: true },
    raw('{"b":1}'),
    group('$nor', [cond({ field: 'c', valType: 'number', value: '2' })]),
  ]);

  it('accepts a well-formed tree', () => {
    expect(isGroupNode(good)).toBe(true);
    expect(isGroupNode(group('$or', []))).toBe(true);
  });

  it('round-trips through JSON, as a persisted draft does', () => {
    expect(isGroupNode(JSON.parse(JSON.stringify(good)))).toBe(true);
  });

  it.each([
    'string', 'number', 'long', 'decimal', 'boolean', 'date', 'null', 'regex', 'objectid', 'array',
  ] as const)('accepts a cond typed %s', (valType) => {
    expect(isGroupNode(group('$and', [cond({ valType })]))).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'group'],
    ['a cond at the root', cond()],
    ['a non-group kind carrying group fields', { kind: 'raw', json: '{}', logic: '$and', children: [] }],
    ['a group without children', { kind: 'group', logic: '$and' }],
    ['children that are not an array', { kind: 'group', logic: '$and', children: {} }],
    ['an unknown logic', { kind: 'group', logic: '$xor', children: [] }],
    ['a non-boolean disabled', { kind: 'group', logic: '$and', children: [], disabled: 'yes' }],
    ['a nested group without children', group('$and', [{ kind: 'group', logic: '$or' } as unknown as FilterNode])],
    ['a nested unknown kind', group('$and', [{ kind: 'text', json: '{}' } as unknown as FilterNode])],
    ['a nested non-object', group('$and', [null as unknown as FilterNode])],
    ['a cond without value', group('$and', [{ kind: 'cond', field: 'a', op: '$eq', valType: 'string' } as unknown as FilterNode])],
    ['a cond with a numeric field', group('$and', [{ ...cond(), field: 1 } as unknown as FilterNode])],
    ['a cond with a numeric op', group('$and', [{ ...cond(), op: 1 } as unknown as FilterNode])],
    ['a cond with an unknown valType', group('$and', [{ ...cond(), valType: 'blob' } as unknown as FilterNode])],
    ['a cond with a non-boolean disabled', group('$and', [{ ...cond(), disabled: 1 } as unknown as FilterNode])],
    ['a raw node whose json is not text', group('$and', [{ kind: 'raw', json: { b: 1 } } as unknown as FilterNode])],
    ['a raw node with a non-boolean disabled', group('$and', [{ ...raw('{}'), disabled: null } as unknown as FilterNode])],
  ])('rejects %s', (_what, value) => {
    expect(isGroupNode(value)).toBe(false);
  });
});

// ─── Value shapes the server would refuse, or that can never match ──────────

describe('printFilter blocks a value the server cannot use', () => {
  const OID = '507f1f77bcf86cd799439011';

  function problemOf(c: CondNode): string | undefined {
    const p = printFilter(group('$and', [c]));
    return p.ok ? undefined : p.problems[0]?.message;
  }

  it('exports the scalar and list operator sets', () => {
    expect([...SIMPLE_OPS]).toEqual(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
    expect([...ARRAY_VALUE_OPS]).toEqual(['$in', '$nin', '$all']);
  });

  it('an empty $in / $nin / $all list never means what was meant, so it does not print', () => {
    for (const op of ['$in', '$nin', '$all']) {
      expect(problemOf(cond({ op, valType: 'string', value: '[]' }))).toBe(`${op} needs at least one value`);
      expect(problemOf(cond({ op, valType: 'array', value: ' [ ] ' }))).toBe(`${op} needs at least one value`);
      expect(problemOf(cond({ op, valType: 'string', value: '' }))).toBe(`${op} needs at least one value`);
      expect(problemOf(cond({ op, valType: 'string', value: 'not a list' }))).toBe(`${op} needs at least one value`);
      expect(problemOf(cond({ op, valType: 'string', value: '["a"]' }))).toBeUndefined();
    }
  });

  it('an empty list the text already holds stays as written, and the rest of the filter still prints', () => {
    for (const op of ['$in', '$nin', '$all']) {
      const text = `{"a":{"${op}":[]},"b":{"$eq":1}}`;
      const root = mustParse(text);
      expect(root.children[0]).toEqual({ kind: 'raw', json: `{"a":{"${op}":[]}}` });
      // An edit to another row must not freeze the drawer on the untouched one.
      const edited = updateAt(root, [1], cond({ field: 'b', op: '$eq', valType: 'number', value: '2' }));
      expect(mustPrint(edited)).toBe(`{"$and":[{"a":{"${op}":[]}},{"b":{"$eq":2}}]}`);
      // The same rule holds when the list shares its field with another operator.
      const shared = mustParse(`{"a":{"${op}":[],"$exists":true}}`);
      expect(shared.children).toEqual([{ kind: 'raw', json: `{"a":{"${op}":[],"$exists":true}}` }]);
      // "Try to parse" on that raw clause keeps it raw rather than a blocked row.
      expect(tryParseRaw({ kind: 'raw', json: `{"a":{"${op}":[]}}` })).toEqual({ kind: 'raw', json: `{"a":{"${op}":[]}}` });
    }
    // A non-empty list is still a row, and an implicit-$eq empty array is a value, not a list op.
    expect(mustParse('{"a":{"$in":[1]}}').children[0]).toMatchObject({ kind: 'cond', op: '$in' });
    expect(mustParse('{"a":[]}').children[0]).toMatchObject({ kind: 'cond', op: '$eq', value: '[]' });
  });

  it('a boolean list item is true or false, nothing else', () => {
    const msg = 'Boolean value must be true or false';
    for (const value of ['["yes"]', '[1]', '[null]', '[true,"maybe"]', '[[true]]', '[0]']) {
      expect(problemOf(cond({ op: '$in', valType: 'boolean', value }))).toBe(msg);
    }
    const printed = printFilter(group('$and', [cond({ field: 'b', op: '$in', valType: 'boolean', value: '[true,false,"true","false"]' })]));
    expect(printed).toEqual({ ok: true, json: '{"b":{"$in":[true,false,true,false]}}' });
  });

  it('an ObjectId that is not 24 hex characters does not print', () => {
    const msg = 'ObjectId must be 24 hex characters';
    expect(problemOf(cond({ valType: 'objectid', value: 'abc' }))).toBe(msg);
    expect(problemOf(cond({ valType: 'objectid', value: '' }))).toBe(msg);
    expect(problemOf(cond({ op: '$ne', valType: 'objectid', value: `${OID}0` }))).toBe(msg);
    expect(problemOf(cond({ valType: 'objectid', value: OID }))).toBeUndefined();
    expect(problemOf(cond({ valType: 'objectid', value: OID.toUpperCase() }))).toBeUndefined();
    // Each element of a list, whether the row's type wraps it or it came wrapped.
    expect(problemOf(cond({ op: '$in', valType: 'objectid', value: `["${OID}","abc"]` }))).toBe(msg);
    expect(problemOf(cond({ op: '$nin', valType: 'array', value: `[{"$oid":"abc"}]` }))).toBe(msg);
    expect(problemOf(cond({ op: '$in', valType: 'objectid', value: `["${OID}"]` }))).toBeUndefined();
    expect(problemOf(cond({ op: '$in', valType: 'array', value: `[1,{"$oid":"${OID}"}]` }))).toBeUndefined();
  });

  it('a number, long or decimal list item is held to the rule its single value is', () => {
    const notNumber = 'Value must be a valid number';
    // Each of these used to print: "abc" and "" as null and 0, null as 0, true as 1.
    for (const value of ['["abc"]', '[1,"abc"]', '[""]', '[null]', '[true]', '[[1]]', '[" "]', '[{"$numberDecimal":"5"}]']) {
      expect(problemOf(cond({ op: '$in', valType: 'number', value }))).toBe(notNumber);
    }
    expect(problemOf(cond({ op: '$nin', valType: 'number', value: '["9007199254740993"]' }))).toBe(
      'Contains a number too large to represent exactly — use {"$numberLong": "..."} or {"$numberDecimal": "..."} instead',
    );
    // `$mod` keeps its own rule, whatever the row's type.
    expect(problemOf(cond({ op: '$mod', valType: 'number', value: '[2,"x"]' }))).toBe(
      '$mod remainder must be a finite number',
    );
    for (const value of ['["1.5"]', '["abc"]', '[null]', '[{"$numberLong":5}]', '[{"$numberLong":"x"}]']) {
      expect(problemOf(cond({ op: '$in', valType: 'long', value }))).toBe('Long value must be an integer');
    }
    for (const value of ['["abc"]', '[""]', '[{"$numberDecimal":"1.2.3"}]']) {
      expect(problemOf(cond({ op: '$all', valType: 'decimal', value }))).toBe('Decimal value must be a number');
    }
  });

  it('a valid number, long or decimal list prints as it did', () => {
    const printed = (c: Partial<CondNode>) => {
      const p = printFilter(group('$and', [cond({ field: 'n', ...c })]));
      return p.ok ? p.json : p.problems[0]?.message;
    };
    expect(printed({ op: '$in', valType: 'number', value: '[1,"2"," 3 ",-4.5,"1e3"]' })).toBe(
      '{"n":{"$in":[1,2,3,-4.5,1000]}}',
    );
    expect(printed({ op: '$nin', valType: 'long', value: '["9007199254740993",-2,{"$numberLong":"7"}]' })).toBe(
      '{"n":{"$nin":[{"$numberLong":"9007199254740993"},{"$numberLong":"-2"},{"$numberLong":"7"}]}}',
    );
    expect(printed({ op: '$in', valType: 'decimal', value: '["1.50",2,{"$numberDecimal":".5e-3"}]' })).toBe(
      '{"n":{"$in":[{"$numberDecimal":"1.50"},{"$numberDecimal":"2"},{"$numberDecimal":".5e-3"}]}}',
    );
  });

  it('a date the server cannot read does not print', () => {
    const msg = 'Date must be a date, e.g. 2026-01-31T00:00:00Z';
    expect(problemOf(cond({ op: '$gte', valType: 'date', value: 'garbage' }))).toBe(msg);
    expect(problemOf(cond({ op: '$gte', valType: 'date', value: '' }))).toBe(msg);
    expect(problemOf(cond({ op: '$in', valType: 'date', value: '["2026-01-01","nope"]' }))).toBe(msg);
    expect(problemOf(cond({ op: '$gte', valType: 'date', value: '2026-01-01T00:00:00.000Z' }))).toBeUndefined();
    expect(problemOf(cond({ op: '$in', valType: 'array', value: '[{"$date":"2026-01-01"}]' }))).toBeUndefined();
    // A `$date` that is not text (EJSON's canonical `{$numberLong}` form) is left to the server.
    expect(problemOf(cond({ op: '$in', valType: 'array', value: '[{"$date":{"$numberLong":"0"}}]' }))).toBeUndefined();
  });

  it('leaves values of other types alone', () => {
    expect(problemOf(cond({ valType: 'string', value: 'abc' }))).toBeUndefined();
    expect(problemOf(cond({ op: '$in', valType: 'string', value: '["abc"]' }))).toBeUndefined();
    expect(problemOf(cond({ op: '$exists', valType: 'objectid', value: 'true' }))).toBeUndefined();
    expect(problemOf(cond({ op: '$type', valType: 'date', value: 'date' }))).toBeUndefined();
    // `$type` takes a list of type names, which an ObjectId row must not wrap.
    expect(problemOf(cond({ op: '$type', valType: 'objectid', value: '["string","null"]' }))).toBeUndefined();
    // `$oid` beside another key is a sub-document, not an ObjectId.
    expect(problemOf(cond({ op: '$in', valType: 'array', value: '[{"$oid":"abc","extra":1}]' }))).toBeUndefined();
  });
});
