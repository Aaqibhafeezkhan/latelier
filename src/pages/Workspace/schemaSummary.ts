import type { SchemaSampleEntry } from '@shared/types';
import { isExactSentinel } from '../../utils/ejson';

/**
 * Walk a sample of EJSON-shaped documents and aggregate field paths and their
 * BSON-shaped type histograms. Output is sorted with `_id` first, then by
 * descending frequency, then alphabetically — matches Compass's IA roughly.
 *
 * Frequency = fraction of documents in which the field appears, regardless
 * of how many times the field repeats inside an array. Type histograms also
 * count once per document so percentages add up to the field's frequency.
 *
 * `distinct` and `numeric` are derived from the same sample and are numbers
 * only: the sample values themselves are never kept, because `entries` is
 * persisted with the tab (W16 §14).
 */
export function summarizeSchema(docs: unknown[]): SchemaSampleEntry[] {
  const counts = new Map<string, PathInfo>();
  for (const doc of docs) {
    // Stryker disable next-line ConditionalExpression: `walk` opens with the
    // same `!isObject(value)` guard and returns immediately for a non-object
    // argument, so skipping this `continue` changes nothing observable —
    // verified against the full test suite.
    if (!isObject(doc)) continue;
    // Per-document de-dupe guards: a path is counted at most once per doc,
    // and a (path, type) pair is also counted at most once per doc — so
    // `items.qty` doesn't get +5 from a 5-element array of objects.
    walk('', doc, counts, new Set(), new Set());
  }
  const total = docs.length || 1;
  const out: SchemaSampleEntry[] = [];
  for (const [path, info] of counts.entries()) {
    const entry: SchemaSampleEntry = {
      path,
      frequency: info.total / total,
      types: Object.fromEntries(info.types.entries()),
    };
    if (info.values.size > 0) entry.distinct = info.values.size;
    // A sum that overflows makes the average Infinity, which JSON persists as
    // null; a null `avg` would crash the row on restore, so there is no range.
    const avg = info.numSum / info.numCount;
    if (info.numCount > 0 && Number.isFinite(avg)) {
      entry.numeric = { min: info.numMin, max: info.numMax, avg };
    }
    out.push(entry);
  }
  out.sort((a, b) => {
    if (a.path === '_id') return -1;
    if (b.path === '_id') return 1;
    if (a.frequency !== b.frequency) return b.frequency - a.frequency;
    return a.path.localeCompare(b.path);
  });
  return out;
}

interface PathInfo {
  types: Map<string, number>;
  total: number;
  /** `JSON.stringify` of each distinct scalar occurrence, so `1` and `"1"` differ. */
  values: Set<string>;
  numCount: number;
  numMin: number;
  numMax: number;
  numSum: number;
}

/**
 * The finite number a scalar holds, or undefined. Docs arrive as canonical
 * EJSON, so a number is a `$number*` sentinel wrapping a string; a raw JS
 * number is accepted too. `$numberDouble: "NaN"` and the infinities are not
 * data a range can summarise.
 */
function numericValue(v: unknown): number | undefined {
  let n: number | undefined;
  if (typeof v === 'number') n = v;
  else if (isObject(v)) {
    const raw = v.$numberInt ?? v.$numberDouble ?? v.$numberLong ?? v.$numberDecimal;
    if (typeof raw === 'string') n = Number.parseFloat(raw);
  }
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

function walk(
  prefix: string,
  value: unknown,
  acc: Map<string, PathInfo>,
  seenPaths: Set<string>,
  seenPathTypes: Set<string>,
): void {
  // Stryker disable next-line ConditionalExpression: every call site already
  // guards its argument with `isObject` before calling `walk` (the initial
  // call in `summarizeSchema`, and both recursive calls below), so this
  // guard is never actually reached with a non-object value — verified
  // against the full test suite.
  if (!isObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const t = inferType(v);
    let info = acc.get(path);
    if (!info) {
      info = {
        types: new Map(),
        total: 0,
        values: new Set(),
        numCount: 0,
        numMin: Number.POSITIVE_INFINITY,
        numMax: Number.NEGATIVE_INFINITY,
        numSum: 0,
      };
      acc.set(path, info);
    }
    if (!seenPaths.has(path)) {
      info.total += 1;
      seenPaths.add(path);
    }
    const typeKey = `${path}::${t}`;
    if (!seenPathTypes.has(typeKey)) {
      info.types.set(t, (info.types.get(t) ?? 0) + 1);
      seenPathTypes.add(typeKey);
    }
    // A scalar is anything that is not an array or a plain sub-document: an
    // exact EJSON sentinel (ObjectId, Date, a number...) is one value.
    if (!Array.isArray(v) && (!isObject(v) || isExactSentinel(v))) {
      info.values.add(String(JSON.stringify(v)));
      const n = numericValue(v);
      if (n !== undefined) {
        info.numCount += 1;
        info.numMin = Math.min(info.numMin, n);
        info.numMax = Math.max(info.numMax, n);
        info.numSum += n;
      }
    }
    // Recurse into plain objects — but skip EJSON wrappers (they are not
    // user-meaningful sub-documents).
    if (isObject(v) && !isEjsonWrapper(v)) {
      walk(path, v, acc, seenPaths, seenPathTypes);
    } else if (
      Array.isArray(v) &&
      // Stryker disable next-line ConditionalExpression,EqualityOperator:
      // an array's `.length` is never negative, so weakening `> 0` to
      // `>= 0` (or forcing this arm to `true`) only changes behavior for an
      // empty array — and an empty array's `v[0]` is `undefined`, which
      // `isObject` always rejects, so the overall condition is false
      // either way. Verified against the full test suite.
      v.length > 0 &&
      isObject(v[0])
    ) {
      // Inspect array elements one level deep to capture nested document
      // shapes (common pattern: items[].productId, items[].qty). Each
      // element shares the same `seenPaths` set so an N-element array
      // contributes at most one bump per nested field path.
      for (const item of v) {
        if (isObject(item) && !isEjsonWrapper(item)) {
          walk(path, item, acc, seenPaths, seenPathTypes);
        }
      }
    }
  }
}

/** 0-1. A type must hold at least this share of a field's own histogram
 *  before disagreeing with it counts as a warning (W17 §2). */
const DOMINANT_SHARE = 0.9;

export interface TypeWarning {
  field: string;
  expectedType: string;
  actualType: string;
  /** 0-100, rounded, of `expectedType` among this field's typed occurrences. */
  percent: number;
}

/**
 * W17 — does `actualType` disagree with what `field` usually holds?
 *
 * Returns null unless one sampled type holds ≥90% of that field's own type
 * histogram and the new value is something else. Silence covers three
 * different cases on purpose: the field was never sampled (nothing to compare
 * against — absence of data is not disagreement), the field is genuinely mixed
 * in real data (a fourth type is not obviously wrong), and the value agrees.
 *
 * `actualType` must come from `inferType`, not from `displayValue.ts` —
 * `entry.types`'s keys are `inferType`'s vocabulary and the check is an
 * equality.
 */
export function checkFieldType(
  entriesByPath: ReadonlyMap<string, SchemaSampleEntry>,
  field: string,
  actualType: string,
): TypeWarning | null {
  const entry = entriesByPath.get(field);
  if (!entry) return null;

  let total = 0;
  // Stryker disable next-line StringLiteral: only read after the loop below,
  // and the loop always overwrites it before the `total === 0` guard lets
  // execution past — when the loop never runs, `total` stays 0 and the
  // function returns before `topType` is read. The '' placeholder is never
  // observed. Verified against the full test suite.
  let topType = '';
  let topCount = 0;
  for (const [type, count] of Object.entries(entry.types)) {
    total += count;
    // Stryker disable next-line EqualityOperator: weakening `>` to `>=`
    // only changes which key wins a tie for the running max, never the max
    // *value* itself — and `share` (below) is computed from that value, not
    // from which key produced it. A genuine tie for the top count can never
    // itself be dominant (>= 90%): two equal shares of a total can each be
    // at most 50%. So no input can make this distinction observable through
    // `checkFieldType`'s return value. Verified against the full test suite.
    if (count > topCount) {
      topCount = count;
      topType = type;
    }
  }
  if (total === 0) return null;

  // The cutoff reads the unrounded fraction. A 0.895 share displays as 90%
  // but is not dominant, and must not warn.
  const share = topCount / total;
  if (share < DOMINANT_SHARE) return null;
  if (topType === actualType) return null;

  return {
    field,
    expectedType: topType,
    actualType,
    percent: Math.round(share * 100),
  };
}

export function inferType(v: unknown): string {
  if (v === null) return 'null';
  // Stryker disable next-line ConditionalExpression: unlike the `null`
  // check above (typeof null is famously 'object', which would otherwise
  // mis-tag it), `typeof undefined` really is the string 'undefined' — so
  // skipping this branch still reaches the same result through the
  // function's own final `return t;` fallback. Verified against the full
  // test suite.
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  // Stryker disable next-line ConditionalExpression,StringLiteral: these
  // three branches are redundant with the function's own final fallback
  // (`return t;`, below the object branch) — `t` already equals 'string',
  // 'number', or 'boolean' whenever one of these checks would match, so
  // skipping the early return here (forcing it false, or comparing against
  // '' instead) still produces the same output once execution falls through
  // `isObject(v)` (false for all three, since `typeof` for none of them is
  // 'object') to the final `return t;`. Verified against the full test
  // suite.
  if (t === 'string') return 'string';
  // Stryker disable next-line ConditionalExpression,StringLiteral: same
  // reasoning as the 'string' branch above.
  if (t === 'number') return 'number';
  // Stryker disable next-line ConditionalExpression,StringLiteral: same
  // reasoning as the 'string' branch above.
  if (t === 'boolean') return 'boolean';
  if (isObject(v)) {
    // A sentinel is only a sentinel when it is the *whole* object. bson's
    // revival rule (`isExactSentinel`) is the authority: it leaves
    // `{"$oid": "…", "extra": true}` as a plain sub-document, so that value
    // is written as a sub-document and must be typed as one. Testing
    // `'$oid' in v` alone labels it `objectid` and disagrees with what
    // actually gets stored.
    if (!isExactSentinel(v)) return 'object';
    if ('$oid' in v) return 'objectid';
    if ('$date' in v) return 'date';
    if ('$numberInt' in v || '$numberDouble' in v) return 'number';
    if ('$numberLong' in v) return 'long';
    if ('$numberDecimal' in v) return 'decimal';
    // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral:
    // `'$regex' in v` can never be true here — `isExactSentinel` (guarding
    // this whole branch above) only accepts single keys from its own
    // SENTINEL_SINGLE set, and that set has `$regularExpression`, not the
    // shorthand `$regex` — so a bare `{ $regex: … }` value never reaches
    // past the `!isExactSentinel(v)` guard. Weakening or removing the left
    // operand can't add a reachable case beyond what `$regularExpression`
    // already covers. Verified against the full test suite.
    if ('$regex' in v || '$regularExpression' in v) return 'regex';
    if ('$binary' in v) return 'binary';
    if ('$timestamp' in v) return 'timestamp';
    return 'object';
  }
  return t;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEjsonWrapper(v: Record<string, unknown>): boolean {
  for (const k of Object.keys(v)) {
    if (k.startsWith('$')) return true;
  }
  return false;
}
