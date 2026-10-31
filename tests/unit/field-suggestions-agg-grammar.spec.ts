import { describe, it, expect } from 'vitest';
import { detectAggGrammar } from '../../src/features/fieldSuggestions/aggGrammar';

/** Parse a fixture where `|` marks the caret. */
function fx(s: string): { value: string; caret: number } {
  const caret = s.indexOf('|');
  if (caret === -1) throw new Error('fixture missing caret marker');
  return { value: s.slice(0, caret) + s.slice(caret + 1), caret };
}

function hit(s: string, stageOp?: string) {
  const { value, caret } = fx(s);
  return detectAggGrammar(value, caret, stageOp);
}

describe('detectAggGrammar', () => {
  describe('field-name key position (bare identifier)', () => {
    it('empty object, caret at end', () => {
      const r = hit('{ |}');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('');
    });

    it('partial bare key', () => {
      const r = hit('{ stat|');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('stat');
    });

    it('after a comma', () => {
      const r = hit('{ status: 1, na|');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('na');
    });

    it('nested object key', () => {
      const r = hit('{ user: { na| } }');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('na');
    });

    it('returns fieldName for $-prefixed bare key so operator source can match', () => {
      const r = hit('{ total: { $s|');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('$s');
    });
  });

  describe('field-name key position (inside quoted key)', () => {
    it('quoted key mid-type', () => {
      const r = hit('{ "stat|" }');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('stat');
    });

    it('quoted key after comma', () => {
      const r = hit('{ a: 1, "b|" }');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('b');
    });
  });

  describe('fieldRef (string starting with $)', () => {
    it('value side $-string in $project', () => {
      const r = hit('{ name: "$stat|" }');
      expect(r?.kind).toBe('fieldRef');
      expect(r?.token).toBe('stat');
    });

    it('value side $ alone', () => {
      const r = hit('{ name: "$|" }');
      expect(r?.kind).toBe('fieldRef');
      expect(r?.token).toBe('');
    });

    it('inside an array', () => {
      const r = hit('{ $concat: ["$fir|"] }');
      expect(r?.kind).toBe('fieldRef');
      expect(r?.token).toBe('fir');
    });
  });

  describe('valueFor (known key, string value)', () => {
    it('string value for a known key', () => {
      const r = hit('{ status: "act|" }');
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') {
        expect(r.field).toBe('status');
        expect(r.token).toBe('act');
      }
    });

    it('quoted key with string value', () => {
      const r = hit('{ "status": "act|" }');
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') expect(r.field).toBe('status');
    });

    it('a plain key carries no operator', () => {
      expect(hit('{ status: "act|" }')).toEqual({
        kind: 'valueFor',
        field: 'status',
        token: 'act',
        replaceStart: '{ status: "'.length,
        replaceEnd: '{ status: "act'.length,
      });
    });

    it('an operator-nested value resolves the parent field and keeps the operator', () => {
      expect(hit('{ age: { $gt: "4|" } }')).toEqual({
        kind: 'valueFor',
        field: 'age',
        operator: '$gt',
        token: '4',
        replaceStart: '{ age: { $gt: "'.length,
        replaceEnd: '{ age: { $gt: "4'.length,
      });
    });

    it('walks past several operator scopes to the field, keeping the innermost operator', () => {
      const r = hit('{ age: { $not: { $eq: "x|" } } }');
      expect(r).toMatchObject({ kind: 'valueFor', field: 'age', operator: '$eq' });
    });

    it('walks past an array scope inside $or to the field', () => {
      const r = hit('{ $or: [{ status: { $ne: "x|" } }] }');
      expect(r).toMatchObject({ kind: 'valueFor', field: 'status', operator: '$ne' });
    });

    it('joins nested field keys into a dotted path', () => {
      expect(hit('{ address: { city: "x|" } }')).toEqual({
        kind: 'valueFor',
        field: 'address.city',
        token: 'x',
        replaceStart: '{ address: { city: "'.length,
        replaceEnd: '{ address: { city: "x'.length,
      });
      expect(hit('{ outer: { inner: { $eq: "x|" } } }')).toMatchObject({
        kind: 'valueFor',
        field: 'outer.inner',
        operator: '$eq',
      });
    });

    it('joins through $elemMatch, which names no field of its own', () => {
      expect(hit('{ items: { $elemMatch: { sku: "x|" } } }')).toMatchObject({
        kind: 'valueFor',
        field: 'items.sku',
      });
      expect(hit('{ items: { $elemMatch: { qty: { $gt: "x|" } } } }')).toMatchObject({
        kind: 'valueFor',
        field: 'items.qty',
        operator: '$gt',
      });
    });

    it('joins through a logical operator clause list', () => {
      expect(hit('{ $and: [{ a: { b: "x|" } }] }')).toMatchObject({ kind: 'valueFor', field: 'a.b' });
      expect(hit('{ $nor: [{ a: "x|" }] }')).toMatchObject({ kind: 'valueFor', field: 'a' });
    });

    it('gives null when the path cannot be read reliably', () => {
      // An array that is not a logical clause list (an exact array match).
      expect(hit('{ a: [{ b: "x|" }] }')).toBeNull();
      // An operator that does not pass a field path through.
      expect(hit('{ loc: { $geoWithin: { c: "x|" } } }')).toBeNull();
      expect(hit('{ $expr: { a: "x|" } }')).toBeNull();
      // A logical operator whose value is not a clause list.
      expect(hit('{ $or: { a: "x|" } }')).toBeNull();
      // An object with no key of its own around the value's object.
      expect(hit('{ { a: "x|" } }')).toBeNull();
    });

    it('a scope of operators only gives null', () => {
      expect(hit('{ $expr: { $eq: "x|" } }')).toBeNull();
      expect(hit('{ $comment: "x|" }')).toBeNull();
      // The walk crosses the array scope, which carries no key, and finds none.
      expect(hit('{ $or: [{ $eq: "x|" }] }')).toBeNull();
    });

    it('an element of an $in array is not a valueFor position', () => {
      expect(hit('{ status: { $in: ["x|"] } }')).toBeNull();
    });
  });

  describe('null / hide', () => {
    it('between sibling tokens with no clear context', () => {
      expect(hit('{ a: 1, |')?.kind).toBe('fieldName');
    });

    it('numeric value mid-type', () => {
      expect(hit('{ age: 30|')).toBeNull();
    });

    it('outside any object', () => {
      expect(hit('hel|lo')).toBeNull();
    });

    it('handles escaped quotes in string', () => {
      const r = hit('{ name: "he said \\"hi\\" to me|" }');
      expect(r?.kind).toBe('valueFor');
    });
  });

  describe('MQL filter shapes (queryRaw)', () => {
    it('top-level key in filter', () => {
      const r = hit('{ stat|');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('stat');
    });

    it('bare field with dotted path mid-type', () => {
      const r = hit('{ user.na|');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('user.na');
    });

    it('key after comma in filter', () => {
      const r = hit('{ status: "active", ag|');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('ag');
    });

    it('nested $or array: key position in an element object', () => {
      const r = hit('{ $or: [{ status: "a" }, { na| }] }');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('na');
    });

    it('operator-object key is a fieldName hit (operator source consumes it)', () => {
      const r = hit('{ age: { $g|');
      expect(r?.kind).toBe('fieldName');
      expect(r?.token).toBe('$g');
    });

    it('value of operator: not suggested (no string, no field ref)', () => {
      expect(hit('{ age: { $gt: 1|')).toBeNull();
    });

    it('string value inside operator object resolves to the field it compares', () => {
      const r = hit('{ status: { $eq: "act|" } }');
      expect(r).toMatchObject({ kind: 'valueFor', field: 'status', operator: '$eq' });
    });
  });

  describe('operatorContext resolution (stageOp aware)', () => {
    it('omits operatorContext when no stageOp is given', () => {
      const r = hit('{ $e|');
      expect(r?.kind).toBe('fieldName');
      if (r?.kind === 'fieldName') expect(r.operatorContext).toBeUndefined();
    });

    it('tags matchKey inside $match at any depth', () => {
      const r1 = hit('{ $e|', '$match');
      const r2 = hit('{ age: { $g| } }', '$match');
      if (r1?.kind === 'fieldName') expect(r1.operatorContext).toBe('matchKey');
      if (r2?.kind === 'fieldName') expect(r2.operatorContext).toBe('matchKey');
    });

    it('tags groupValue at depth ≥ 2 inside $group', () => {
      const shallow = hit('{ total|', '$group');
      const deep = hit('{ total: { $s| } }', '$group');
      if (shallow?.kind === 'fieldName') expect(shallow.operatorContext).toBeUndefined();
      if (deep?.kind === 'fieldName') expect(deep.operatorContext).toBe('groupValue');
    });

    it('tags projectValue at depth ≥ 2 inside $project', () => {
      const r = hit('{ full: { $c| } }', '$project');
      if (r?.kind === 'fieldName') expect(r.operatorContext).toBe('projectValue');
    });

    it('tags addFieldsValue inside $set and $addFields', () => {
      const a = hit('{ x: { $c| } }', '$set');
      const b = hit('{ x: { $c| } }', '$addFields');
      if (a?.kind === 'fieldName') expect(a.operatorContext).toBe('addFieldsValue');
      if (b?.kind === 'fieldName') expect(b.operatorContext).toBe('addFieldsValue');
    });

    it('falls back to no context inside $facet', () => {
      const r = hit('{ byStatus: [{ $match: { stat| } }] }', '$facet');
      if (r?.kind === 'fieldName') expect(r.operatorContext).toBeUndefined();
    });

    // MUTATION TARGET — a stageOp not covered by any of the earlier branches
    // (not $facet/$match/$group/$project/$set/$addFields) must fall all the
    // way through to the final `return undefined`, not stop early on the
    // (unrelated) addFieldsValue check.
    it('resolves to no context for an unrecognized stageOp at depth ≥ 2', () => {
      const r = hit('{ x: { $c| } }', '$unwind');
      if (r?.kind === 'fieldName') expect(r.operatorContext).toBeUndefined();
    });
  });

  describe('replace range', () => {
    it('bare identifier range covers the whole token', () => {
      const { value, caret } = fx('{ stat|us }');
      const r = detectAggGrammar(value, caret);
      expect(r).toMatchObject({ kind: 'fieldName', token: 'stat', replaceStart: 2, replaceEnd: caret });
    });

    it('fieldRef replace range skips the $', () => {
      const { value, caret } = fx('{ a: "$stat|" }');
      const r = detectAggGrammar(value, caret);
      expect(r?.kind).toBe('fieldRef');
      if (r?.kind === 'fieldRef') {
        expect(value.substring(r.replaceStart, r.replaceEnd)).toBe('stat');
      }
    });
  });

  describe('escape handling inside strings', () => {
    // MUTATION TARGET — an empty string closes on its very first character
    // (the closing quote). If the `escape` flag were initialized `true`, that
    // first character would be wrongly swallowed as "escaped", leaving the
    // string open past its actual close.
    it('closes an empty string correctly (escape starts false)', () => {
      // Top-level: both a correctly-closed and a wrongly-stuck-open empty
      // string end up returning null (no enclosing scope either way), so use
      // an empty *key* inside an object, where a wrongly-stuck-open string
      // swallows the closing quote as content and returns a non-null
      // fieldName hit instead of null.
      expect(hit('{ ""|')).toBeNull();
    });

    // MUTATION TARGET — an escaped quote (\") inside a string must not close
    // it; disabling the escape-consumption logic (either the `if (escape)`
    // check that resets the flag, or the `if (c === '\\')` check that sets
    // it) makes the escaped quote look like a real close, cutting the string
    // short and changing the result from `valueFor` to `null`.
    it('treats an escaped quote as literal content, not a close', () => {
      const r = hit('{ status: "a\\"b|" }');
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') {
        expect(r.field).toBe('status');
        expect(r.token).toBe('a\\"b');
      }
    });

    // MUTATION TARGET — after consuming an escaped character, the `escape`
    // flag must reset to false (`escape = false`), not stay/become true. If
    // the reset itself were broken (assigning `true` instead), `escape`
    // would latch permanently true after the first backslash, and every
    // later character — including the string's real closing quote and any
    // following syntax — would be wrongly swallowed as "escaped" for the
    // rest of the input.
    it('resumes normal parsing after the escaped character (escape flag actually resets)', () => {
      const r = hit('{ status: "a\\"b" , |');
      expect(r?.kind).toBe('fieldName');
      if (r?.kind === 'fieldName') expect(r.token).toBe('');
    });
  });

  describe('scope bookkeeping (brackets, quote-close key capture)', () => {
    it('opens a string with a single quote, not just double quotes', () => {
      const r = hit("{ a: 'hel|");
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') expect(r.field).toBe('a');
    });

    // MUTATION TARGET — without a real array scope, the bracket's content
    // would inherit the *object's* mode/lastKey ('value' / '$concat'),
    // wrongly producing a valueFor hit for a bare (non-$) array element.
    it('does not produce a valueFor hit for a bare string inside an array', () => {
      expect(hit('{ $concat: ["fir|"] }')).toBeNull();
    });

    // MUTATION TARGET — the optional-chaining `s?.type` guards against `s`
    // being undefined at the top level (no enclosing object/array). Without
    // it, closing a top-level string throws instead of returning null.
    it('does not throw on a top-level string with no enclosing scope', () => {
      expect(() => hit('"done"|')).not.toThrow();
      expect(hit('"done"|')).toBeNull();
    });

    // Exercises the top-level (no enclosing scope) open-string bookkeeping
    // directly, including the `s?.lastKey` optional chaining on open.
    it('does not throw when opening an unterminated top-level string', () => {
      expect(() => hit('"abc|')).not.toThrow();
      expect(hit('"abc|')).toBeNull();
    });

    // MUTATION TARGET — a closing `]` must pop the array scope, or the
    // subsequent bare key `c` is still (wrongly) evaluated against the
    // array scope (not type 'obj'), returning null instead of a fieldName.
    it('pops the array scope on a closing bracket', () => {
      const r = hit('{ a: [1, 2], c|');
      expect(r?.kind).toBe('fieldName');
      if (r?.kind === 'fieldName') expect(r.token).toBe('c');
    });

    // MUTATION TARGET — a closing `}` must pop the object scope, or the
    // array element string that follows is wrongly evaluated against the
    // leftover object scope (which the errant comma resets to 'key' mode),
    // returning a fieldName hit instead of null (array elements aren't keys).
    it('pops the object scope on a closing brace', () => {
      expect(hit('{ $concat: [{ a: 1 }, "fir|')).toBeNull();
    });

    // MUTATION TARGET — the `s?.type === 'obj'` guards in the colon and
    // comma handlers protect against `s` being undefined at the top level
    // (no enclosing object/array yet). Dropping the optional chaining, or
    // forcing the guard true, makes `s.mode = ...` throw on undefined.
    it('does not throw on a colon at the top level, with no enclosing scope', () => {
      expect(() => hit(':|')).not.toThrow();
      expect(hit(':|')).toBeNull();
    });

    it('does not throw on a comma at the top level, with no enclosing scope', () => {
      expect(() => hit(',|')).not.toThrow();
      expect(hit(',|')).toBeNull();
    });

    // MUTATION TARGET — the colon handler only re-derives the bare-key
    // lookback when `s.lastKey === null`. Forcing that guard true makes a
    // *second* colon (e.g. a malformed `a: b:`) overwrite the already-known
    // key ('a') with whatever bare word precedes the second colon ('b').
    it('does not re-derive the key on a second colon once one is already known', () => {
      const r = hit('{ a: b: "val|');
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') expect(r.field).toBe('a');
    });

    // MUTATION TARGET — the bare-key lookback first trims trailing
    // whitespace before the colon; breaking that trim (e.g. replacing the
    // whitespace char with an empty string before testing it) makes the
    // lookback start mid-whitespace, where the IDENT scan immediately stops,
    // so no key is captured at all.
    it('trims whitespace between a bare key and its colon', () => {
      const r = hit('{ field : "val|');
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') expect(r.field).toBe('field');
    });

    // MUTATION TARGET — when there is no identifier text immediately before
    // the colon (`end > start` false), `lastKey` must stay `null`, not
    // become `''`. `''` is falsy too, but it's not `null`: a later colon's
    // `s.lastKey === null` re-derivation check would then wrongly treat the
    // key as "already known" and skip deriving the real one.
    it('leaves lastKey null (not empty-string) when a colon has no key text before it', () => {
      const r = hit('{ : a: "val|');
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') expect(r.field).toBe('a');
    });

    // MUTATION TARGET — the `if (prevModeAtStringStart === 'value' ||
    // prevModeAtStringStart === 'arr')` guard is only reachable with 'value'
    // or 'arr' (a 'key' string returns earlier, and this is the only other
    // caller); forcing it true would also let a top-level string ('top'
    // mode, no enclosing scope) that starts with `$` return a fieldRef hit.
    it('does not resolve a fieldRef for a top-level $-prefixed string', () => {
      expect(hit('"$foo|')).toBeNull();
    });

    // MUTATION TARGET — a quoted key must only be recorded when the
    // enclosing scope is genuinely an object in 'key' mode; closing a
    // *value* string must not overwrite the key that's already recorded for
    // this object (a `&&` weakened to `||`, or the whole guard forced true,
    // would treat every closing quote as a key capture).
    it('does not treat a closed value-string as a key capture', () => {
      const r = hit('{ a: "x" "y|');
      expect(r?.kind).toBe('valueFor');
      if (r?.kind === 'valueFor') expect(r.field).toBe('a');
    });
  });
});
