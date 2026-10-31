import { EJSON } from 'bson';
import { parseJsonKeepingBigInts } from './bigIntJson';

// Mirror of electron/mongo/ejson.ts:safeEjsonParse — kept in sync manually
// because shared/ is types-only and cannot import from electron/.

const SENTINEL_SINGLE = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$timestamp',
  '$regularExpression',
  '$minKey',
  '$maxKey',
  '$undefined',
  '$code',
  '$symbol',
  '$dbPointer',
]);

/**
 * Is this object an EJSON sentinel wrapper, and nothing else?
 *
 * Exported because it decides what `walkRevive` below turns into a BSON value
 * and what it leaves as a plain sub-document — and anything that classifies a
 * value's *type* has to agree with that, or it labels a sub-document with a
 * BSON type name. `schemaSummary.ts:inferType` is the other caller.
 */
export function isExactSentinel(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 1) return SENTINEL_SINGLE.has(keys[0]!);
  // CodeWithScope: {$code, $scope}
  if (keys.length === 2 && '$code' in obj && '$scope' in obj) return true;
  return false;
}

function walkRevive(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return (node as unknown[]).map(walkRevive);
  const obj = node as Record<string, unknown>;
  if (isExactSentinel(obj)) return EJSON.parse(JSON.stringify(obj), { relaxed: false });
  // Object.create(null), not {} — a field literally named `__proto__` whose
  // value revives to a BSON object (ObjectId, Date, Int32, …) would otherwise
  // hit the `__proto__` accessor on a `{}` literal: `result[k] = v` silently
  // reassigns the object's prototype instead of creating an own property,
  // the field vanishes from Object.keys, and isPlainDocument below
  // misclassifies the corrupted result. isPlainDocument already treats a
  // null-prototype object as plain for exactly this reason.
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) result[k] = walkRevive(v);
  return result;
}

/**
 * Parse EJSON text. A bare integer token beyond 2^53 (`{ n: 9007199254740993 }`)
 * is kept exact as a Long instead of rounding to a double: the Document
 * editor and the diff re-parse what the user typed here, so a rounded token
 * would be saved wrong before main ever saw it.
 */
export function ejsonParse<T = unknown>(s: string): T {
  return walkRevive(parseJsonKeepingBigInts(s)) as T;
}

export function ejsonStringify(v: unknown, indent?: number): string {
  return EJSON.stringify(v as Parameters<typeof EJSON.stringify>[0], undefined, indent, { relaxed: false });
}

/**
 * Canonical EJSON, rendered for a human to read and edit (UX review §4.1).
 *
 * The drawers used to show `"age": {"$numberInt": "67"}` and a date as
 * `{"$date": {"$numberLong": "1738284528524"}}`, so changing an age meant
 * editing a string inside an object and changing a date meant decoding epoch
 * milliseconds. This unwraps the sentinels a person should not have to read.
 *
 * **It unwraps only what re-parses to the identical BSON.** That is the whole
 * design, and it is why the output is safe to hand back as an *editable*
 * buffer rather than needing a second canonical copy alongside it. bson's own
 * relaxed mode is not safe for this: measured against this repo's bson,
 * `{"$numberLong":"9007199254740993"}` relaxes to `9007199254740992` — the
 * silent precision loss ADR 0004's second rejected option is about, handed to
 * the user as something to copy.
 *
 * So the rules are derived from the round trip, not from readability:
 *
 * | sentinel | rendered as | why |
 * | --- | --- | --- |
 * | `$numberInt` | a plain number | int32 re-infers as int32 |
 * | `$numberDouble`, fractional | a plain number | stays a double |
 * | `$numberDouble`, integral or non-finite | unchanged | `2.0` re-infers as int32; `Infinity` is not a JSON number |
 * | `$date` | `{"$date":"<ISO>"}` | exact across the whole JS Date range |
 *
 * Note on that last row: `{"$date":"<ISO>"}` is EJSON's *Relaxed* spelling of
 * a date, not the Canonical one. It is included anyway because the rule here
 * is round-trip exactness rather than canonical form — `$date` is a single-key
 * exact sentinel in both spellings, so it revives to the identical `Date`. No
 * buffer rendered by this function is ever persisted or sent as the stored
 * query text, so ADR 0004's "stored text is always Canonical EJSON" invariant
 * is untouched.
 * | `$numberLong`, `$numberDecimal`, `$oid`, everything else | unchanged | no lossless shorter form |
 *
 * The guarantee is about text this function *emits*. Once a user edits the
 * buffer it is ordinary input again, gated by `isValidEjson` like any other.
 *
 * Renderer-only, and deliberately **not** mirrored into
 * `electron/mongo/ejson.ts`. Nothing crosses the IPC boundary in this form —
 * the wire format is still canonical, and this is a display of it.
 */
export function ejsonStringifyReadable(v: unknown, indent?: number): string {
  return JSON.stringify(relaxLosslessly(JSON.parse(ejsonStringify(v))), null, indent);
}

/**
 * Walks canonical EJSON *text* already parsed to a plain tree.
 *
 * Recognises a sentinel with `isExactSentinel` — the same rule `walkRevive`
 * uses on the way in — so the two cannot disagree about what a sentinel is. A
 * user field genuinely named `$date` sits in an object with other keys and is
 * left alone; a single-key `{"$date":…}` is the BSON value.
 *
 * A recognised sentinel is never recursed into. That is what stops the
 * `$numberLong` inside `$date`'s canonical form from being unwrapped as if it
 * were a number of its own.
 */
function relaxLosslessly(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(relaxLosslessly);
  const obj = node as Record<string, unknown>;
  if (isExactSentinel(obj)) return relaxSentinel(obj);
  // Object.create(null), not {} — see walkRevive's identical guard above.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) out[k] = relaxLosslessly(v);
  return out;
}

function relaxSentinel(obj: Record<string, unknown>): unknown {
  if (typeof obj.$numberInt === 'string') return plainNumber(obj.$numberInt, true) ?? obj;
  if (typeof obj.$numberDouble === 'string') return plainNumber(obj.$numberDouble, false) ?? obj;
  // Stryker disable next-line ConditionalExpression: `isExactSentinel` already guarantees `obj` has exactly one recognised sentinel key (or the $code/$scope pair); when that key isn't '$date', `obj.$date` is simply undefined, so `isoDate(obj)` computes NaN internally, `.toISOString()` throws, and the catch returns null — the same `?? obj` fallback the real `false` branch takes. Forcing this condition true is unobservable for every sentinel shape.
  if (obj.$date !== undefined) return isoDate(obj) ?? obj;
  return obj;
}

/**
 * The digits as a JSON number, or `null` where that would change the type.
 *
 * Three guards, and each one catches a case the others do not:
 *
 * - `Number.isFinite` — `{"$numberDouble":"Infinity"}` passes the text check
 *   below (`String(Infinity)` really is `"Infinity"`) and would be emitted as
 *   a bare `Infinity`, which is not JSON at all.
 * - `Number.isInteger(n) !== integral` — the guard that actually fires, and
 *   the only one covering a double bson spells in exponent form. `Double(1e30)`
 *   canonicalizes to `"1e+30"`, so the text check below agrees and would wave
 *   it through. Unwrapping it happens to be lossless on today's bson; it stays
 *   wrapped anyway, because the day that spelling changes the failure mode is
 *   a silent type change on a surface that writes documents.
 * - `String(n) === text` — rejects any spelling bson would not produce again.
 *   Unreachable against today's bson: every mis-spelling it could catch, the
 *   integral guard catches first, and deleting this line breaks no test. It
 *   is kept because the two cover *different* hypotheticals — the integral
 *   guard survives bson writing `Double(2)` as `"2"`, this one survives bson
 *   writing `Double(1.5)` as `"1.50"` — and one line is cheap on a path where
 *   being wrong rewrites a stored document.
 */
function plainNumber(text: string, integral: boolean): number | null {
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n) !== integral) return null;
  return String(n) === text ? n : null;
}

/**
 * `{"$date":{"$numberLong":"1738284528524"}}` → `{"$date":"2025-01-31T…Z"}`.
 *
 * `toISOString` rather than bson's relaxed mode: bson keeps the `$numberLong`
 * form for anything before 1970, and the ISO string is exact there too —
 * verified lossless across the whole representable range, from
 * `-271821-04-20` to `+275760-09-13`.
 */
function isoDate(obj: Record<string, unknown>): { $date: string } | null {
  const inner = obj.$date;
  const ms =
    typeof inner === 'object' && inner !== null && typeof (inner as { $numberLong?: unknown }).$numberLong === 'string'
      ? Number((inner as { $numberLong: string }).$numberLong)
      : Number.NaN;
  try {
    return { $date: new Date(ms).toISOString() };
  } catch {
    // A mutant that empties this catch body (returning `undefined` instead of
    // `null`) is unobservable: the only caller is `relaxSentinel`'s
    // `isoDate(obj) ?? obj`, and `??` treats `null`/`undefined` identically.
    // `// Stryker disable` doesn't attach cleanly to a catch block's own
    // BlockStatement node here, so this stays prose rather than a directive.
    //
    // `toISOString` is the whole range check. Every millisecond value a `Date`
    // can hold is inside ±8.64e15 and therefore a safe integer, so anything
    // this rejects — a value past the range, or a `$date` that was not the
    // `{"$numberLong":…}` shape and left `ms` as NaN — lands here as a
    // RangeError. An explicit `Number.isSafeInteger` in front of it was dead:
    // removing it broke no test, because there is nothing it reaches first.
    return null;
  }
}

export function isValidEjson(s: string): boolean {
  try {
    ejsonParse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this text parse as an EJSON *document* — the shape `find` takes for a
 * filter, a sort or a projection? Arrays, `null` and scalars are out: they
 * parse, so `isValidEjson` says yes, and the driver then ignores a `null` or
 * array sort/projection and runs the query unsorted or full-width.
 *
 * The one rule the raw fields share (`isRawProjection`, `sortProblem`), and
 * the mirror of `parseEjsonDocument` in `electron/mongo/ejson.ts`.
 */
export function isEjsonDocument(s: string): boolean {
  // Trimmed, not left to `JSON.parse`: it ignores ASCII whitespace but refuses
  // the Unicode spaces `String.prototype.trim` strips (NBSP, BOM, em space),
  // and the filter's Run gate accepts a document padded with those.
  const t = s.trim();
  if (!t) return false;
  try {
    return isPlainDocument(ejsonParse(t));
  } catch {
    return false;
  }
}

/**
 * Is this parsed value a *plain* document, as opposed to a BSON instance?
 *
 * `typeof x === 'object' && !Array.isArray(x)` is not enough: a bare sentinel
 * like `{"$oid":"507f1f77bcf86cd799439011"}` revives to an `ObjectId`, which
 * satisfies all of it and reaches the driver as a sort or projection.
 * Two of those cases are silent — `{"$date":…}` as a sort runs in insertion
 * order because `Object.keys(new Date())` is `[]`, and `{"$oid":…}` as a
 * filter matches nothing — which is the W15 §11 fail-open reopened through
 * a sentinel after it had already been closed for `[1,2]` and `null`.
 *
 * The prototype test rather than an `_bsontype` / `instanceof Date` list: it
 * covers every BSON type, including ones added later, and `walkRevive` and
 * `JSON.parse` both produce ordinary object literals for real documents.
 *
 * Only the *top level* is checked. `{"createdAt":{"$date":"…"}}` is an
 * ordinary filter and must keep working.
 *
 * Mirrored by `parseEjsonDocument` in `electron/mongo/ejson.ts` — `shared/` is
 * types-only, so the rule cannot be hoisted into one module. The two copies
 * are pinned together by `tests/unit/ejson-document-guard.spec.ts`.
 */
export function isPlainDocument(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const proto = Object.getPrototypeOf(parsed) as unknown;
  return proto === Object.prototype || proto === null;
}
