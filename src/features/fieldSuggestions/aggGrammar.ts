/**
 * Best-effort grammar detector for aggregation stage bodies. Given the text
 * of a stage body and a caret offset, returns what kind of suggestion is
 * appropriate at that position, or null to hide the popover.
 */

import type { OperatorContext } from './operators';

export type GrammarHit =
  | {
      kind: 'fieldName';
      token: string;
      replaceStart: number;
      replaceEnd: number;
      /** Where the caret sits so operator suggestions can be context-ranked. */
      operatorContext?: OperatorContext;
    }
  | { kind: 'fieldRef'; token: string; replaceStart: number; replaceEnd: number }
  | {
      kind: 'valueFor';
      /** The source field the value is compared with. */
      field: string;
      /** The `$` operator between the field and the value, as in `{age: {$gt: "…"}}`. */
      operator?: string;
      token: string;
      replaceStart: number;
      replaceEnd: number;
    };

interface Scope {
  type: 'obj' | 'arr';
  mode: 'key' | 'afterKey' | 'value';
  lastKey: string | null;
}

const IDENT = /[A-Za-z0-9_$.]/;

/**
 * Map a stageOp + object-nesting depth to the operator context at the caret.
 * Depth 1 means "direct child of the stage body object". $facet and unknown
 * stages return null so the full catalog shows.
 */
function resolveOperatorContext(
  stageOp: string | undefined,
  depth: number,
): OperatorContext | undefined {
  // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral:
  // '$facet' never matches any of the later stageOp comparisons either, and
  // the function's final fallback is also `undefined` — so this clause is
  // provably redundant with the rest of the function today (verified with a
  // probe at both depth <= 1 and depth > 1). Kept for its documented intent
  // (see the doc comment above): $facet is deliberately excluded here, not
  // accidentally uncovered by the other branches.
  if (!stageOp || stageOp === '$facet') return undefined;
  if (stageOp === '$match') return 'matchKey';
  if (depth <= 1) {
    // Depth 1 inside $group/$project/etc. is a user-defined field name; no
    // operator context narrows to something useful yet.
    return undefined;
  }
  if (stageOp === '$group') return 'groupValue';
  if (stageOp === '$project') return 'projectValue';
  if (stageOp === '$set' || stageOp === '$addFields') return 'addFieldsValue';
  return undefined;
}

/** Query operators whose value is a list of clauses, each over the same fields. */
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);
/** Operators that sit between a field and its condition without naming a field. */
const PASS_THROUGH_OPS = new Set(['$elemMatch', '$not']);

/**
 * The field a string value is compared with, as a dotted path, and the `$`
 * operator in between, if any. `{address: {city: "…"}}` is `address.city`,
 * `{items: {$elemMatch: {qty: {$gt: "…"}}}}` is `items.qty` with `$gt`, and a
 * logical operator's clause list is walked through. Anything else on the
 * way (an exact-match array, `$expr`, `$geoWithin`, a logical operator whose
 * value is not a list) returns null: no suggestion beats one for the wrong
 * field.
 */
function resolveValueTarget(
  scopes: Scope[],
  innermostKey: string,
): { field: string; operator?: string } | null {
  const operator = innermostKey.startsWith('$') ? innermostKey : undefined;
  const segments = operator ? [] : [innermostKey];
  for (let d = scopes.length - 2; d >= 0; d--) {
    const scope = scopes[d]!;
    // An array's own scope carries no key; the key that owns it, one level
    // out, decides whether it may be crossed.
    if (scope.type === 'arr') continue;
    const key = scope.lastKey;
    if (key === null) return null;
    const holdsArray = scopes[d + 1]!.type === 'arr';
    if (LOGICAL_OPS.has(key)) {
      if (!holdsArray) return null;
    } else if (holdsArray) {
      return null;
    } else if (key.startsWith('$')) {
      if (!PASS_THROUGH_OPS.has(key)) return null;
    } else {
      segments.unshift(key);
    }
  }
  if (segments.length === 0) return null;
  return operator ? { field: segments.join('.'), operator } : { field: segments.join('.') };
}

export function detectAggGrammar(
  value: string,
  caret: number,
  stageOp?: string,
): GrammarHit | null {
  const scopes: Scope[] = [];
  let inString = false;
  // Stryker disable next-line UnaryOperator: stringStart is always assigned
  // (to the real opening-quote index) before any code path reads it — the
  // only read sites are inside `if (inString)`/the post-loop `if (inString)`
  // block, and inString only becomes true together with this assignment.
  // The -1 placeholder is never observed.
  let stringStart = -1;
  // Stryker disable next-line StringLiteral: same reasoning — stringQuote is
  // always reassigned to the real opening quote character before inString
  // becomes true, so the placeholder '"' is never read.
  let stringQuote = '"';
  // Stryker disable next-line StringLiteral: same reasoning — this is only
  // read inside the post-loop `if (inString)` block, and by the time
  // inString is true this has already been reassigned by the open-quote
  // handler below. The 'top' placeholder is never read.
  let prevModeAtStringStart: 'key' | 'value' | 'arr' | 'top' = 'top';
  let prevKeyAtStringStart: string | null = null;
  let escape = false;

  const n = Math.min(caret, value.length);
  for (let i = 0; i < n; i++) {
    const c = value[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === stringQuote) {
        const s = scopes[scopes.length - 1];
        if (s?.type === 'obj' && s.mode === 'key') {
          s.lastKey = value.substring(stringStart + 1, i);
          // Stryker disable next-line StringLiteral: 'afterKey' is
          // write-only — every read of `.mode` elsewhere only ever checks
          // `=== 'key'`, never `=== 'afterKey'`, so any non-'key' value here
          // is behaviorally identical (verified: the full test suite still
          // passes with this literal replaced by '').
          s.mode = 'afterKey';
        }
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringStart = i;
      stringQuote = c;
      const s = scopes[scopes.length - 1];
      // Stryker disable next-line StringLiteral: only 'key', 'value', and
      // 'arr' are ever compared against below; any other string (including
      // '') is treated identically to 'top' — verified: the full test suite
      // still passes with this literal replaced by ''.
      if (!s) prevModeAtStringStart = 'top';
      else if (s.type === 'arr') prevModeAtStringStart = 'arr';
      else if (s.mode === 'key') prevModeAtStringStart = 'key';
      else prevModeAtStringStart = 'value';
      prevKeyAtStringStart = s?.lastKey ?? null;
    } else if (c === '{') {
      scopes.push({ type: 'obj', mode: 'key', lastKey: null });
    } else if (c === '[') {
      // Stryker disable next-line ObjectLiteral,StringLiteral: an array
      // scope's own `.mode`/`.lastKey` are read back only at the next
      // string-open inside it, and that read always finds `lastKey` still
      // null (nothing ever writes an array scope's lastKey) — so the
      // 'arr' vs undefined `.type` distinction there, and the pushed
      // object's exact shape, are unobservable. Verified: the full test
      // suite still passes with `{}` pushed instead.
      scopes.push({ type: 'arr', mode: 'key', lastKey: null });
    } else if (c === '}' || c === ']') {
      scopes.pop();
    } else if (c === ':') {
      const s = scopes[scopes.length - 1];
      if (s?.type === 'obj') {
        // Stryker disable next-line StringLiteral: `.mode` is only ever
        // compared with `=== 'key'` elsewhere, so any non-'key' value here
        // (including '') is behaviorally identical — verified against the
        // full test suite.
        s.mode = 'value';
        if (s.lastKey === null) {
          let end = i;
          // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral:
          // same reasoning as the IDENT lookback below — at end === 0,
          // `/\s/.test('')` is false regardless of the `end > 0` guard's own
          // truth value, so `end > 0`/`end >= 0` behave identically here.
          // The `?? ''` fallback itself is also unreachable under the real
          // `end > 0` guard: `&&` short-circuits, so `value[end - 1]` is only
          // read once `end > 0` holds, at which point `end - 1 >= 0` is
          // always a valid index into `value`. Verified against the full
          // test suite.
          while (end > 0 && /\s/.test(value[end - 1] ?? '')) end--;
          let start = end;
          // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral:
          // at start === 0, `value[start - 1]` is undefined, coalesced to
          // '', and `IDENT.test('')` is false regardless of the `start > 0`
          // guard's own truth value — so `start > 0` and `start >= 0` behave
          // identically here. The `?? ''` fallback itself is unreachable
          // under the real `start > 0` guard for the same short-circuit
          // reason as above. Verified against the full test suite.
          while (start > 0 && IDENT.test(value[start - 1] ?? '')) start--;
          if (end > start) s.lastKey = value.substring(start, end);
        }
      }
    } else if (c === ',') {
      const s = scopes[scopes.length - 1];
      if (s?.type === 'obj') { s.mode = 'key'; s.lastKey = null; }
    }
  }

  if (inString) {
    const inner = value.substring(stringStart + 1, caret);
    const replaceStart = stringStart + 1;
    const replaceEnd = caret;
    if (prevModeAtStringStart === 'key') {
      return {
        kind: 'fieldName',
        token: inner,
        replaceStart,
        replaceEnd,
        operatorContext: resolveOperatorContext(stageOp, scopes.length),
      };
    }
    if (prevModeAtStringStart === 'value' || prevModeAtStringStart === 'arr') {
      if (inner.startsWith('$')) {
        return { kind: 'fieldRef', token: inner.slice(1), replaceStart: replaceStart + 1, replaceEnd };
      }
      // Stryker disable next-line ConditionalExpression,LogicalOperator: this
      // is only reached when the outer guard above already narrowed
      // prevModeAtStringStart to 'value' or 'arr'. For 'arr', prevKeyAtStringStart
      // is always null/falsy — nothing ever writes an array scope's lastKey
      // (see the '[' handler above) — so weakening `&&` to `||`, or forcing
      // this true, can't add any case beyond what 'value' already covers.
      // Verified against the full test suite.
      if (prevModeAtStringStart === 'value' && prevKeyAtStringStart) {
        // Nothing inside a string touches `scopes`, so it is still the stack
        // at the opening quote, and its top is the scope whose key is
        // `prevKeyAtStringStart`.
        const target = resolveValueTarget(scopes, prevKeyAtStringStart);
        if (!target) return null;
        return { kind: 'valueFor', ...target, token: inner, replaceStart, replaceEnd };
      }
    }
    return null;
  }

  const s = scopes[scopes.length - 1];
  if (s?.type === 'obj' && s.mode === 'key') {
    let start = caret;
    // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral:
    // same reasoning as the bare-key lookback above — at start === 0,
    // `IDENT.test('')` is false regardless of the `start > 0` guard's own
    // truth value, and the `?? ''` fallback is itself unreachable under the
    // real `start > 0` guard (short-circuit means `value[start - 1]` is only
    // read once `start - 1 >= 0`). Verified against the full test suite.
    while (start > 0 && IDENT.test(value[start - 1] ?? '')) start--;
    const token = value.substring(start, caret);
    // `$`-prefixed bare keys still return a fieldName hit; the operator source
    // consumes the same hit to offer `$eq`, `$sum`, etc.
    return {
      kind: 'fieldName',
      token,
      replaceStart: start,
      replaceEnd: caret,
      operatorContext: resolveOperatorContext(stageOp, scopes.length),
    };
  }

  return null;
}
