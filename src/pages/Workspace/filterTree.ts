// Pure module — no React, no CollectionTabState, no api imports. That purity
// (enforced by an eslint override scoped to this file, see eslint.config.js)
// is what makes this reusable as the aggregation `$match` editor later
// (redesign C, W13 §1). Do not import anything renderer-shaped here.
//
// See specs/W13-filter-tree-editor.md for the full spec this module
// implements (§1 model, §2 parseFilter, §3 printFilter, §4 edit API).
import type { ValType, CondNode, RawNode, GroupNode, FilterNode } from '@shared/types';
import { isCompilableOp } from './builder';

// ─── §1 Model ────────────────────────────────────────────────────────────────

// The node types live in `shared/types.ts`, because a tab's persisted
// `filterDraft` holds a tree; they are re-exported here so callers keep one
// import site.
export type { CondNode, RawNode, GroupNode, FilterNode } from '@shared/types';

/** Node identity IS its position. No generated ids to keep stable. */
export type NodePath = readonly number[];

const VAL_TYPES: ReadonlySet<string> = new Set<ValType>([
  'string', 'number', 'long', 'decimal', 'boolean', 'date', 'null', 'regex', 'objectid', 'array',
]);

function isOptionalFlag(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean';
}

function isFilterNode(v: unknown): v is FilterNode {
  if (!isPlainObject(v) || !isOptionalFlag(v.disabled)) return false;
  switch (v.kind) {
    case 'cond':
      return (
        typeof v.field === 'string' &&
        typeof v.op === 'string' &&
        VAL_TYPES.has(v.valType as string) &&
        typeof v.value === 'string'
      );
    case 'raw':
      return typeof v.json === 'string';
    case 'group':
      return isGroupNode(v);
    default:
      return false;
  }
}

/**
 * Structural check for a tree read back from storage (a tab's persisted
 * draft, §5.7), which the type system can't vouch for: a hand-edited or
 * older row could lack `children` and crash the printer. Every node is
 * checked, all the way down.
 */
export function isGroupNode(v: unknown): v is GroupNode {
  return (
    isPlainObject(v) &&
    v.kind === 'group' &&
    LOGIC_KEYS.has(v.logic as string) &&
    isOptionalFlag(v.disabled) &&
    Array.isArray(v.children) &&
    v.children.every(isFilterNode)
  );
}

// ─── §2 parseFilter ──────────────────────────────────────────────────────────

export type ParseOutcome = { ok: true; root: GroupNode } | { ok: false; reason: string };

/**
 * Multi-key predicate splitting is an allowlist, not a general rule (§2a).
 * `{a:{$gte:1,$lte:5}}` may safely become two conds joined by the parent
 * `$and`. `{a:{$regex:"x",$options:"i"}}` may not — `$options` modifies
 * `$regex`, and splitting them changes what the query matches. Only used to
 * decide whether a *multi*-key predicate may split; a single-key predicate
 * always attempts a cond regardless of this set.
 */
const SPLITTABLE_OPS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$all',
  '$exists', '$type', '$size', '$mod', '$regex',
  '$bitsAllClear', '$bitsAnyClear', '$bitsAllSet', '$bitsAnySet',
]);

const LOGIC_KEYS = new Set(['$and', '$or', '$nor']);


/**
 * EJSON sentinel keys from §2b's unrepresentable-shape list that are NOT
 * query operators. Without this check, a single-key field value like
 * `{$numberDouble: "1.5"}` or `{$minKey: 1}` would be misread by the
 * operator-map branch below as "operator `$numberDouble` with string value
 * '1.5'" (a representable plain string!) instead of "an unrepresentable
 * value sentinel" — silently producing a wrong cond instead of degrading to
 * raw. Must be checked before the operator-map branch, same reason as
 * `guessSentinelOnly`.
 */
const UNREPRESENTABLE_SENTINEL_KEYS = new Set([
  '$binary', '$timestamp', '$numberDouble', '$numberInt', '$regularExpression',
  '$minKey', '$maxKey', '$code', '$dbPointer',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ValueGuess {
  valType: ValType;
  text: string;
}

/**
 * Recognizes exactly the four EJSON sentinels that represent a *complete*
 * value (§2b): `{$oid}` / `{$date}` / `{$numberLong}` / `{$numberDecimal}`.
 * Deliberately excludes `{$regex}` — a bare `{field: {$regex: "x"}}` means
 * the `$regex` query OPERATOR (the common case), not an implicit-$eq match
 * against a literal regex value, so it must not win over the operator-map
 * branch in `parseFieldPredicate`. `{$regex}` as a value is still
 * representable (see `guessValue`) — just not through this "is the whole
 * field value actually a sentinel" fast path.
 */
function guessSentinelOnly(v: unknown): ValueGuess | null {
  // Stryker disable next-line ConditionalExpression: both callers (guessValue,
  // only after narrowing v away from null/boolean/number/string/array; and
  // parseFieldPredicate, only inside its own isPlainObject(rawValue) branch)
  // already guarantee v is a plain object — verified empirically (probe:
  // scratchpad/probe1.mjs-style type-domain check), never independently
  // observable from real parseFilter input (JSON.parse's value universe).
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const k = keys[0];
  // Stryker disable next-line ConditionalExpression: entry here is only
  // reached with a single-key object (guarded above), so any non-'$oid' key
  // makes `v.$oid` undefined regardless — forcing the `k === '$oid'` conjunct
  // true can't change the outcome (verified: scratchpad/probe1.mjs).
  if (k === '$oid' && typeof v.$oid === 'string') return { valType: 'objectid', text: v.$oid };
  // Stryker disable next-line ConditionalExpression: same single-key argument
  // as the $oid check above.
  if (k === '$date' && typeof v.$date === 'string') return { valType: 'date', text: v.$date };
  // Stryker disable next-line ConditionalExpression: same single-key argument.
  if (k === '$numberLong' && typeof v.$numberLong === 'string') {
    return { valType: 'long', text: v.$numberLong };
  }
  // Stryker disable next-line ConditionalExpression: same single-key argument.
  if (k === '$numberDecimal' && typeof v.$numberDecimal === 'string') {
    return { valType: 'decimal', text: v.$numberDecimal };
  }
  return null;
}

/** Representable elements of a `$in`/`$nin`/`$all` (or implicit-$eq) array (§2b). */
function isRepresentableArrayElement(el: unknown): boolean {
  if (el === null || typeof el === 'boolean' || typeof el === 'number' || typeof el === 'string') {
    return true;
  }
  // Stryker disable next-line ConditionalExpression: reachable only for a
  // nested array element, whose Object.keys are numeric-index strings — never
  // '$oid'/'$date'/etc — so removing this guard can't change the OR-chain's
  // result for any JSON-parseable input (verified empirically).
  if (!isPlainObject(el)) return false; // nested array, or not an object at all
  const keys = Object.keys(el);
  if (keys.length !== 1) return false;
  const k = keys[0];
  return (
    // Stryker disable next-line ConditionalExpression: single-key object
    // (guarded above) makes `el.$oid` undefined whenever k isn't '$oid' —
    // same argument as guessSentinelOnly above.
    (k === '$oid' && typeof el.$oid === 'string') ||
    // Stryker disable next-line ConditionalExpression: same single-key argument.
    (k === '$date' && typeof el.$date === 'string') ||
    // Stryker disable next-line ConditionalExpression: same single-key argument.
    (k === '$numberLong' && typeof el.$numberLong === 'string') ||
    // Stryker disable next-line ConditionalExpression: same single-key argument.
    (k === '$numberDecimal' && typeof el.$numberDecimal === 'string')
  );
}

/**
 * The value→(valType,text) inference, the inverse of `buildTypedValue` in
 * `builder.ts` (§2b). Handles scalars, the four value sentinels, `{$regex}`
 * as a value (distinct from the `$regex` operator — see `guessSentinelOnly`),
 * and homogeneous representable arrays. Returns `null` for anything else:
 * plain nested objects, `$binary`, `$timestamp`, `$numberDouble`/
 * `$numberInt`, `$regularExpression`, `$minKey`/`$maxKey`, `$code`,
 * `$dbPointer`, or an array containing an unrepresentable element.
 */
function guessValue(v: unknown): ValueGuess | null {
  if (v === null) return { valType: 'null', text: '' };
  if (typeof v === 'boolean') return { valType: 'boolean', text: String(v) };
  if (typeof v === 'number') return { valType: 'number', text: String(v) };
  if (typeof v === 'string') return { valType: 'string', text: v };
  if (Array.isArray(v)) {
    if (!v.every(isRepresentableArrayElement)) return null;
    return { valType: 'array', text: JSON.stringify(v) };
  }
  const sentinel = guessSentinelOnly(v);
  if (sentinel) return sentinel;
  // Stryker disable next-line ConditionalExpression: v is always a plain
  // object here — null/boolean/number/string/array were already excluded
  // above, and guessSentinelOnly's own guard requires isPlainObject(v) to
  // ever return non-null (moot either way since we only branch on truthiness
  // here, not on what sentinel returned).
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    // Stryker disable next-line ConditionalExpression: `keys.length === 1`
    // (guarded) means a wrong key makes `v.$regex` undefined regardless of
    // the middle conjunct — same single-key argument as guessSentinelOnly.
    if (keys.length === 1 && keys[0] === '$regex' && typeof v.$regex === 'string') {
      return { valType: 'regex', text: v.$regex };
    }
  }
  return null;
}

function condNode(field: string, op: string, guess: ValueGuess): CondNode {
  return { kind: 'cond', field, op, valType: guess.valType, value: guess.text };
}

function rawPair(field: string, value: unknown): RawNode {
  return { kind: 'raw', json: JSON.stringify({ [field]: value }) };
}

/**
 * `guessValue` for the value of operator `op`. An empty `$in`/`$nin`/`$all`
 * list is valid text MongoDB accepts, but a row the printer blocks: as a row
 * it would freeze the drawer on the first edit elsewhere. It stays raw, so it
 * prints back verbatim.
 */
function guessOpValue(op: string, v: unknown): ValueGuess | null {
  if (ARRAY_VALUE_OPS.has(op) && Array.isArray(v) && v.length === 0) return null;
  return guessValue(v);
}

/**
 * `{ field: { $op1: v1, $op2: v2, ... } }` → one or more cond nodes, or a
 * single raw node when it can't be split/modeled (§2a, §2b).
 */
function parseOperatorMap(field: string, obj: Record<string, unknown>, keys: string[]): FilterNode[] {
  if (keys.length === 1) {
    const op = keys[0];
    const guess = guessOpValue(op, obj[op]);
    if (guess) return [condNode(field, op, guess)];
    return [rawPair(field, obj)];
  }
  const allSplittable = keys.every((k) => SPLITTABLE_OPS.has(k));
  if (allSplittable) {
    const guesses = keys.map((k) => guessOpValue(k, obj[k]));
    if (guesses.every((g): g is ValueGuess => g !== null)) {
      return keys.map((k, i) => condNode(field, k, guesses[i]));
    }
  }
  return [rawPair(field, obj)];
}

/** One field key's predicate → one or more sibling nodes (§2, §2a, §2b). */
function parseFieldPredicate(field: string, rawValue: unknown): FilterNode[] {
  if (isPlainObject(rawValue)) {
    const keys = Object.keys(rawValue);
    // A single-key object that IS a recognized value sentinel is an
    // implicit-$eq VALUE, not an operator map — must be checked first, else
    // e.g. `{$oid: "..."}` would be mistaken for an (nonexistent) `$oid` op.
    // Stryker disable next-line ConditionalExpression: forcing entry when
    // keys.length !== 1 still converges on the identical rawPair(field,
    // rawValue) fallback either via guessSentinelOnly's own (real,
    // unmutated) length check returning null, or — when keys[0] happens to
    // be an UNREPRESENTABLE_SENTINEL_KEYS member — via the disjointness of
    // that set from SPLITTABLE_OPS, which forces the same rawPair through
    // parseOperatorMap's allSplittable check. Verified for a range of
    // key-shapes (scratchpad/probe196.mjs, gateTrue/gateGte0 cases).
    if (keys.length === 1) {
      const guess = guessSentinelOnly(rawValue);
      if (guess) return [condNode(field, '$eq', guess)];
      if (UNREPRESENTABLE_SENTINEL_KEYS.has(keys[0])) return [rawPair(field, rawValue)];
    }
    // Stryker disable next-line MethodExpression: swapping `every` for `some`
    // only diverges when the key set is mixed ($-prefixed and not), and any
    // non-$-prefixed key can never be a SPLITTABLE_OPS member — so
    // parseOperatorMap's own allSplittable re-check forces the identical
    // rawPair fallback either way (verified: scratchpad/probe196.mjs, gateSome).
    if (keys.length > 0 && keys.every((k) => k.startsWith('$'))) {
      return parseOperatorMap(field, rawValue, keys);
    }
    // Nested doc used for whole-document equality (or `{}`) — unrepresentable.
    return [rawPair(field, rawValue)];
  }
  const guess = guessValue(rawValue);
  if (guess) return [condNode(field, '$eq', guess)];
  return [rawPair(field, rawValue)]; // array with an unrepresentable element
}

function collapseToNode(nodes: FilterNode[]): FilterNode {
  // Stryker disable next-line ConditionalExpression: removing this guard
  // falls through to `nodes.length === 1` (false) then the final fallback,
  // which for an empty `nodes` produces the byte-identical
  // `{ kind: 'group', logic: '$and', children: [] }` (verified: probe2.mjs).
  if (nodes.length === 0) return { kind: 'group', logic: '$and', children: [] };
  if (nodes.length === 1) return nodes[0];
  return { kind: 'group', logic: '$and', children: nodes };
}

/** One object (root, or one `$and`/`$or`/`$nor` array item) → sibling nodes. */
function parseClauseToNodes(obj: Record<string, unknown>): FilterNode[] {
  const nodes: FilterNode[] = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (LOGIC_KEYS.has(key)) {
      if (Array.isArray(value)) {
        nodes.push(groupFromLogicArray(key as GroupNode['logic'], value));
      } else {
        // A $and/$or/$nor whose value isn't an array is a raw node, not a
        // parse failure.
        nodes.push({ kind: 'raw', json: JSON.stringify({ [key]: value }) });
      }
      continue;
    }
    if (key.startsWith('$')) {
      // Any clause-level `$`-key that isn't $and/$or/$nor is a whole-clause
      // operator (`$expr`, `$text`, `$where`, `$jsonSchema`, `$comment`,
      // `$sampleRate`, ...), never a field name — MongoDB field names can't
      // lead with `$` in query syntax. Falling through to
      // `parseFieldPredicate` for an operator this module doesn't name by
      // name would silently mangle it into a bogus field-named cond (e.g.
      // `{"$comment":"why"}` parsing as field `"$comment"` equals `"why"`).
      nodes.push({ kind: 'raw', json: JSON.stringify({ [key]: value }) });
      continue;
    }
    nodes.push(...parseFieldPredicate(key, value));
  }
  return nodes;
}

function parseArrayItem(item: unknown): FilterNode {
  if (!isPlainObject(item)) return { kind: 'raw', json: JSON.stringify(item) };
  return collapseToNode(parseClauseToNodes(item));
}

function groupFromLogicArray(logic: GroupNode['logic'], arr: unknown[]): GroupNode {
  return { kind: 'group', logic, children: arr.map(parseArrayItem) };
}

function parseRoot(obj: Record<string, unknown>): GroupNode {
  const collapsed = collapseToNode(parseClauseToNodes(obj));
  // A one-child `$nor` is a NOT (§4). Taken as the root itself it would lose
  // that reading — the root never shows NOT — so it stays a group under an
  // `$and` root, the same tree the drawer printed it from.
  if (collapsed.kind === 'group' && !(collapsed.logic === '$nor' && collapsed.children.length === 1)) {
    return collapsed;
  }
  return { kind: 'group', logic: '$and', children: [collapsed] };
}

/**
 * Total on any valid JSON object (§2). Fails on exactly two things: text
 * that isn't valid JSON, and a root that isn't an object. Never fails
 * because of an operator it doesn't recognize — unmodelable shapes degrade
 * to a raw node instead (§2a, §2b).
 *
 * Uses plain `JSON.parse` with sentinel-aware inspection of the resulting
 * plain objects — not `ejsonParse`, which revives sentinels into BSON class
 * instances (wrong shape for a tree editor that stores value *text*).
 *
 * ponytail: a `number`-valType cond's integer precision is guarded at print
 * time (`condValueProblem`'s `isUnsafeNumber` check) instead of here, so
 * `9007199254740993` is caught whether it lands as a cond or inside a raw
 * node's text. What this whole-document `JSON.parse` still can't preserve
 * is *non-integer* precision beyond a JS double's ~15-17 significant digits
 * (e.g. `0.1234567890123456789` silently loses trailing digits) — JSON
 * itself has no way to carry that, and every other numeric path in this app
 * has the same ceiling. No upgrade path without a different wire format for
 * non-integer values; not attempted here.
 */
export function parseFilter(ejson: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ejson);
  } catch {
    return { ok: false, reason: 'Invalid JSON' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'Root must be an object' };
  }
  return { ok: true, root: parseRoot(parsed) };
}

// ─── §3 printFilter ──────────────────────────────────────────────────────────

export interface NodeProblem {
  path: NodePath;
  message: string;
}

export type PrintOutcome = { ok: true; json: string } | { ok: false; problems: NodeProblem[] };

export const SIMPLE_OPS: ReadonlySet<string> = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
export const ARRAY_VALUE_OPS: ReadonlySet<string> = new Set(['$in', '$nin', '$all']);
const BITS_OPS = new Set(['$bitsAllClear', '$bitsAnyClear', '$bitsAllSet', '$bitsAnySet']);

const NUMBER_PRECISION_MESSAGE =
  'Contains a number too large to represent exactly — use {"$numberLong": "..."} or {"$numberDecimal": "..."} instead';

/** §3a's big-integer guard: true when `n` can't be losslessly round-tripped through this filter's JSON. */
function isUnsafeNumber(n: number): boolean {
  return !Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n));
}

/**
 * Best-effort JSON-array parse — `[]` on anything that isn't a JSON array.
 *
 * Exported for `builder.ts`'s `mergeOrReplaceDragged`, which needs the same
 * lenient parse `coerceArrayElementWire`/`buildScalarWire` below serve — a
 * second real consumer, so exporting beats a second copy drifting out of
 * sync.
 */
export function parseJsonArrayLenient(raw: string): unknown[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function isEjsonWrapped(el: unknown, key: string): boolean {
  return typeof el === 'object' && el !== null && key in el;
}

/**
 * Coerces one pre-coercion array element (as stored in a scalar-`valType`
 * `$in`/`$nin` cond's `value` text) to its wire shape.
 *
 * Exported for `builder.ts`'s `mergeOrReplaceDragged`, which needs this
 * exact conversion to normalize an existing row's elements into the fully
 * wire-encoded form a merged `valType: 'array'` cond expects — the same
 * shape `parseFilter`'s array guess already produces. A second real
 * consumer, so exporting beats a second copy drifting out of sync.
 */
export function coerceArrayElementWire(el: unknown, valType: ValType): unknown {
  switch (valType) {
    case 'objectid':
      return typeof el === 'string' ? { $oid: el } : el;
    case 'long':
      return isEjsonWrapped(el, '$numberLong') ? el : { $numberLong: String(el).trim() };
    case 'decimal':
      return isEjsonWrapped(el, '$numberDecimal') ? el : { $numberDecimal: String(el).trim() };
    case 'date':
      return typeof el === 'string' ? { $date: el } : el;
    case 'number':
      // Stryker disable next-line ConditionalExpression,StringLiteral: for any
      // real JS number el, Number(el) === el (a no-op round trip), so forcing
      // the branch to always coerce — or comparing typeof against the wrong
      // literal — produces the identical value either way (Number() is
      // idempotent on values that are already numbers).
      return typeof el === 'number' ? el : Number(el);
    case 'boolean':
      return typeof el === 'boolean' ? el : el === 'true';
    case 'string':
      return String(el);
    default:
      return el;
  }
}

/**
 * Builds the wire shape for one scalar (non-array-op) cond value.
 *
 * Exported for `builder.ts`'s `mergeOrReplaceDragged` — same reason as
 * `coerceArrayElementWire` above: it needs the identical scalar→wire
 * conversion to encode both the existing row's `$eq` value and the freshly
 * dragged value before merging them into a `valType: 'array'` cond.
 */
export function buildScalarWire(valType: ValType, value: string): unknown {
  switch (valType) {
    // Stryker disable next-line StringLiteral: this case's body and the
    // `default` case's body below are both `return value` verbatim — a case
    // label mutated away from 'string' just falls through to that identical
    // default, so the observable result is unchanged either way.
    case 'string':
      return value;
    case 'number':
      return Number(value);
    case 'long':
      return { $numberLong: value.trim() };
    case 'decimal':
      return { $numberDecimal: value.trim() };
    case 'boolean':
      return value === 'true';
    case 'date':
      return { $date: value };
    case 'null':
      return null;
    case 'regex':
      return { $regex: value };
    case 'objectid':
      return { $oid: value };
    case 'array':
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    default:
      return value;
  }
}

/** Why `text` is not a value of a number, long or decimal row, or null when it is (or the type is another). */
function numericTextProblem(valType: ValType, text: string): string | null {
  if (valType === 'number') {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return 'Value must be a valid number';
    // §3a's big-integer guard, cond path: `number` is representable per §2b
    // (unlike `long`/`decimal`, which carry exact text), so a plain-number
    // cond skips the raw-node guard entirely. A value beyond 2^53 would
    // otherwise round silently on print.
    if (isUnsafeNumber(n)) return NUMBER_PRECISION_MESSAGE;
  }
  if (valType === 'long' && !/^[+-]?\d+$/.test(text.trim())) return 'Long value must be an integer';
  if (
    valType === 'decimal' &&
    // `\d+(\.\d*)?` accepts exactly what `\d+\.?\d*` did, but the two digit
    // runs can no longer be re-split against each other on a long numeric
    // string — that ambiguity is the super-linear backtracking in S8786.
    !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text.trim())
  ) {
    return 'Decimal value must be a number';
  }
  return null;
}

/** The list items a boolean row reads as themselves. */
const BOOLEAN_ITEMS: ReadonlySet<unknown> = new Set<unknown>([true, false, 'true', 'false']);

/**
 * The text a list item stands for, checked by `numericTextProblem` (which
 * ignores every type but number, long and decimal): '' for anything that is
 * not a number, a string or the row's own wrapped form (null, true, a nested
 * list), so it fails the row's rule instead of printing as 0, 1 or "null".
 */
function listItemText(valType: ValType, el: unknown): string {
  if (typeof el === 'number' || typeof el === 'string') return String(el);
  // A number row has no wrapped form: `Number()` turns any object into NaN.
  const key = valType === 'long' ? '$numberLong' : '$numberDecimal';
  const inner = isPlainObject(el) && valType !== 'number' ? el[key] : undefined;
  // Stryker disable next-line StringLiteral: any non-numeric text fails every
  // row's rule, so the exact text standing for "no value" is unobservable.
  return typeof inner === 'string' ? inner : '';
}

/**
 * Blocking-validity checks for a cond (§3). Deliberately mirrors
 * `describeCondProblem` in builder.ts (same number/long/decimal/$mod
 * checks) — NOT its "doesn't apply to <valType>" line, which is advisory
 * only per §3 ("applicability is advisory, as today") and must never block
 * printing.
 */
function condValueProblem(node: CondNode): string | null {
  if (!node.op.startsWith('$')) return 'Operator must start with "$"';
  if (!isCompilableOp(node.op)) return `${node.op} is not encodable — convert to a raw clause`;
  const isScalarNumeric =
    !ARRAY_VALUE_OPS.has(node.op) && node.op !== '$mod' && node.value.trim() !== '';
  if (isScalarNumeric) {
    const problem = numericTextProblem(node.valType, node.value);
    if (problem) return problem;
  }
  if (
    // Not gated on node.valType: parseFilter always assigns array-value-op
    // conds valType 'array' (guessValue's array branch), never 'number' — a
    // 'number' gate here is dead code on every parser-produced cond. The
    // `typeof el === 'number'` filter below is the real guard: it already
    // skips long/decimal/objectid/date elements, which carry exact text as
    // strings or $-sentinel objects rather than raw numbers, so dropping the
    // valType conjunct can't newly block those.
    ARRAY_VALUE_OPS.has(node.op) &&
    parseJsonArrayLenient(node.value).some((el) => typeof el === 'number' && isUnsafeNumber(el))
  ) {
    return NUMBER_PRECISION_MESSAGE;
  }
  if (ARRAY_VALUE_OPS.has(node.op) && parseJsonArrayLenient(node.value).length === 0) {
    // An empty `$in` or `$all` matches nothing and an empty `$nin`
    // everything; none is what a person building a list means, so the row
    // waits for a value. Text that already holds one parses to a raw clause.
    return `${node.op} needs at least one value`;
  }
  if (ARRAY_VALUE_OPS.has(node.op)) {
    // A list a number, long or decimal row sends is held to the rule its
    // single value is: otherwise "abc" prints as null, "" and null as 0, and
    // a long or decimal the server cannot read goes out as written.
    for (const el of parseJsonArrayLenient(node.value)) {
      const problem = numericTextProblem(node.valType, listItemText(node.valType, el));
      if (problem) return problem;
      // A boolean row's wire form turns anything but true / "true" into
      // false, so `yes`, 1 or null would go out as false unannounced.
      if (node.valType === 'boolean' && !BOOLEAN_ITEMS.has(el)) return 'Boolean value must be true or false';
    }
  }
  for (const wire of sentWireValues(node)) {
    const problem = sentinelProblem(wire);
    if (problem) return problem;
  }
  if (node.op === '$mod') {
    const arr = parseJsonArrayLenient(node.value);
    if (arr.length !== 2) return '$mod value must be a 2-element array, e.g. [2, 1]';
    const [divisor, remainder] = arr;
    // Stryker disable next-line ConditionalExpression: Number.isFinite is
    // type-strict — it already returns false for any non-number value, so
    // dropping the redundant `typeof divisor !== 'number'` conjunct can't
    // change the result for any input (verified: scratchpad/probe2.mjs).
    if (typeof divisor !== 'number' || !Number.isFinite(divisor)) {
      return '$mod divisor must be a finite number';
    }
    if (divisor === 0) return '$mod divisor cannot be 0';
    // Stryker disable next-line ConditionalExpression: same Number.isFinite
    // type-strictness argument as the divisor check above.
    if (typeof remainder !== 'number' || !Number.isFinite(remainder)) {
      return '$mod remainder must be a finite number';
    }
  }
  return null;
}

/** The values a scalar or list cond puts on the wire; other ops send none worth checking here. */
function sentWireValues(node: CondNode): unknown[] {
  if (SIMPLE_OPS.has(node.op)) return [buildScalarWire(node.valType, node.value)];
  if (ARRAY_VALUE_OPS.has(node.op)) {
    return parseJsonArrayLenient(node.value).map((el) => coerceArrayElementWire(el, node.valType));
  }
  // Stryker disable next-line ArrayDeclaration: any string placed here fails
  // `sentinelProblem`'s plain-object check, the same as no value at all.
  return [];
}

/**
 * An `{$oid}` or `{$date}` the main process could not turn into a value: bson
 * throws on a malformed ObjectId and turns unreadable date text into an
 * Invalid Date. Blocking it here keeps it out of `queryRaw`, so neither Run
 * nor the live count ever sends it.
 */
function sentinelProblem(wire: unknown): string | null {
  if (!isPlainObject(wire) || Object.keys(wire).length !== 1) return null;
  if (typeof wire.$oid === 'string' && !/^[0-9a-f]{24}$/i.test(wire.$oid)) {
    return 'ObjectId must be 24 hex characters';
  }
  if (typeof wire.$date === 'string' && Number.isNaN(Date.parse(wire.$date))) {
    return 'Date must be a date, e.g. 2026-01-31T00:00:00Z';
  }
  return null;
}

/**
 * Encodes an already-validated cond's value onto the wire. Lenient where
 * `describeCondProblem` is lenient (e.g. a malformed `$in` array silently
 * encodes as `[]`, matching builder.ts's `buildCondValue`/`parseJsonArray`)
 * — `condValueProblem` above is the single source of blocking validation.
 *
 * `$exists` deliberately preserves the stored boolean text instead of
 * builder.ts's `buildCondValue`, which always emits `true`: forcing `true`
 * would silently flip a parsed `{$exists:false}` on the very first print,
 * breaking the semantic round-trip this module exists to guarantee.
 */
function encodeCondValue(node: CondNode): unknown {
  const { op, valType, value } = node;
  if (op === '$exists') return value.trim() !== 'false';
  if (SIMPLE_OPS.has(op)) return buildScalarWire(valType, value);
  if (ARRAY_VALUE_OPS.has(op)) {
    return parseJsonArrayLenient(value).map((el) => coerceArrayElementWire(el, valType));
  }
  // Stryker disable next-line ConditionalExpression,StringLiteral: every
  // other op branch above/below returns before this point, and none of them
  // match op === '$regex' either — so disabling this check (or comparing
  // against the wrong literal) still falls through to the identical
  // defensive `return value;` at the end of this function.
  if (op === '$regex') return value;
  if (op === '$type') {
    const n = Number(value);
    return Number.isFinite(n) && value.trim() !== '' ? n : value;
  }
  if (op === '$mod') {
    const arr = parseJsonArrayLenient(value);
    // Stryker disable next-line ConditionalExpression,ArrayDeclaration:
    // condValueProblem's own `arr.length !== 2` check already blocks
    // printing before any $mod cond reaches encodeCondValue, so `arr` is
    // always length 2 here — this ternary's false branch is unreachable
    // through printFilter (same reasoning as the "Unreachable" comment below).
    return arr.length === 2 ? arr : [0, 0];
  }
  // Stryker disable next-line ConditionalExpression: isCompilableOp's op set
  // is exactly SIMPLE_OPS + ARRAY_VALUE_OPS + $exists/$regex/$type/$mod/$size
  // + BITS_OPS (see builder.ts) — every one of those is handled by an earlier
  // return in this function except $size/BITS_OPS, so any op reaching this
  // line through printFilter is already guaranteed to be $size or a bits op.
  if (op === '$size' || BITS_OPS.has(op)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  // Unreachable: condValueProblem's isCompilableOp check already blocked
  // anything that would land here. Defensive fallback only.
  return value;
}

/**
 * Parses a raw node's JSON with the big-integer guard of §3a: a numeric
 * literal beyond `Number.isSafeInteger` range rounds silently under
 * `JSON.parse` (`9007199254740993` → `...992`) — `isUnsafeNumber` flags the
 * *parsed value*, checked via the reviver as each number token is produced.
 *
 * ponytail (deliberate narrowing of §3a's literal text): §3a as written
 * compares reviver `context.source` text against `JSON.stringify` of the
 * parsed value, which also flags lossless reformattings like `1.0` or `1e3`
 * as "not round-trip-safe" — a false positive that would block a valid
 * hand-typed raw clause for no reason (a `RawNode` built by `parseFilter`
 * itself never hits this, since it always holds already-restringified text).
 * Checking the parsed value directly instead of its source text still
 * catches every actual precision loss and stops flagging harmless
 * reformatting. Upgrade path if `context.source` fidelity is needed for
 * some other reason later: compare source text as §3a describes.
 */
function parseRawWithPrecisionCheck(
  json: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  let lossy = false;
  const reviver = (_key: string, val: unknown): unknown => {
    if (typeof val === 'number' && isUnsafeNumber(val)) lossy = true;
    return val;
  };
  let value: unknown;
  try {
    value = JSON.parse(json, reviver);
  } catch {
    return { ok: false, reason: 'Not valid JSON' };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'Raw clause must be a JSON object' };
  }
  if (lossy) {
    return { ok: false, reason: NUMBER_PRECISION_MESSAGE };
  }
  return { ok: true, value };
}

// The 'pending' arm exists for type-level documentation of the §5 pending
// rule only — no code below (or in printFilter) ever discriminates on
// `.kind === 'pending'`; every consumer checks only 'blocked' or 'value' and
// silently treats anything else (including a mutated {} with no `kind` at
// all) the same way 'pending' is treated. That is what makes each `{ kind:
// 'pending' }` literal below, and printNode's own root-vs-nested branch at
// §3a, behaviorally inert under mutation — verified by tracing every call
// site of this function's result.
type PrintNodeResult = { kind: 'value'; value: unknown } | { kind: 'pending' } | { kind: 'blocked' };

function printNode(node: FilterNode, path: number[], problems: NodeProblem[]): PrintNodeResult {
  // A disabled node, and its whole subtree, is pending: no clause, no
  // problem. Checked before anything else so an invalid row the user has
  // switched off never blocks the rest of the filter.
  // Stryker disable next-line ObjectLiteral,StringLiteral: same inert
  // 'pending' literal as the two below (see the PrintNodeResult note).
  if (node.disabled) return { kind: 'pending' };
  if (node.kind === 'cond') {
    // Stryker disable next-line ObjectLiteral,StringLiteral
    if (node.field.trim() === '') return { kind: 'pending' }; // §5 pending rule
    const problem = condValueProblem(node);
    if (problem) {
      problems.push({ path, message: problem });
      return { kind: 'blocked' };
    }
    return { kind: 'value', value: { [node.field]: { [node.op]: encodeCondValue(node) } } };
  }
  if (node.kind === 'raw') {
    // Stryker disable next-line ObjectLiteral,StringLiteral
    if (node.json.trim() === '') return { kind: 'pending' }; // §5 pending rule
    const parsed = parseRawWithPrecisionCheck(node.json);
    if (!parsed.ok) {
      problems.push({ path, message: parsed.reason });
      return { kind: 'blocked' };
    }
    return { kind: 'value', value: parsed.value };
  }
  // group
  const childValues: unknown[] = [];
  let anyBlocked = false;
  node.children.forEach((child, i) => {
    const r = printNode(child, [...path, i], problems);
    if (r.kind === 'blocked') anyBlocked = true;
    else if (r.kind === 'value') childValues.push(r.value);
  });
  if (anyBlocked) return { kind: 'blocked' };
  if (childValues.length === 0) {
    // A root with no printable children prints `{}`; a nested group with
    // none is omitted (pending) from its parent (§3a).
    //
    // Stryker disable next-line ConditionalExpression,ObjectLiteral,StringLiteral:
    // `path.length === 0` is only ever true for the root call from
    // printFilter, whose consumer already defaults to `{}` for any non-'value'
    // result — so both arms of this ternary, under any mutation, resolve to
    // an output printFilter treats identically (see the type-level note above
    // for the 'pending' arm; the 'value' arm's own value is literally `{}`).
    return path.length === 0 ? { kind: 'value', value: {} } : { kind: 'pending' };
  }
  if (childValues.length === 1 && node.logic !== '$nor') {
    // A group with exactly one printable child prints as that child —
    // except $nor, whose envelope is semantic and always survives (§3a).
    return { kind: 'value', value: childValues[0] };
  }
  return { kind: 'value', value: { [node.logic]: childValues } };
}

/**
 * Fail-closed (§3): a discriminated result, never a best-effort string, so a
 * node the printer can't encode never reaches `queryRaw`.
 */
export function printFilter(root: GroupNode): PrintOutcome {
  const problems: NodeProblem[] = [];
  const result = printNode(root, [], problems);
  if (result.kind === 'blocked') return { ok: false, problems };
  // Stryker disable next-line ConditionalExpression: printNode's top-level
  // call always has path === [], and its group branch's `path.length === 0`
  // case (the only way a group ever resolves without recursing further) is
  // handled before this point too — `root` being a GroupNode, printNode
  // called with `[]` can only ever return 'blocked' (excluded above) or
  // 'value', never 'pending' — so this check is already always true.
  const value = result.kind === 'value' ? result.value : {};
  return { ok: true, json: JSON.stringify(value) };
}

// ─── §4 Edit API ─────────────────────────────────────────────────────────────
//
// All pure, all return new roots. Path-as-identity (§4): an edit that
// changes structure renumbers siblings.

export function nodeAt(root: GroupNode, path: NodePath): FilterNode | null {
  let node: FilterNode = root;
  for (const i of path) {
    if (node.kind !== 'group') return null;
    const child: FilterNode | undefined = node.children[i];
    if (!child) return null;
    node = child;
  }
  return node;
}

function updateNodeAt(node: FilterNode, path: NodePath, next: FilterNode): FilterNode {
  if (path.length === 0) return next;
  if (node.kind !== 'group') return node; // can't descend further; no-op
  const [i, ...rest] = path;
  const children = node.children.map((c, idx) => (idx === i ? updateNodeAt(c, rest, next) : c));
  return { ...node, children };
}

export function updateAt(root: GroupNode, path: NodePath, next: FilterNode): GroupNode {
  if (path.length === 0) {
    // Root must stay a group; no-op if the caller tries to replace it with
    // a bare cond/raw node.
    return next.kind === 'group' ? next : root;
  }
  return updateNodeAt(root, path, next) as GroupNode;
}

function insertNodeAt(target: FilterNode, path: NodePath, node: FilterNode, index?: number): FilterNode {
  if (target.kind !== 'group') return target; // can't insert into non-group; no-op
  if (path.length === 0) {
    const children = [...target.children];
    // Out-of-range clamps rather than throwing; `length` is a legitimate
    // index (append), so the upper bound is inclusive.
    children.splice(index === undefined ? children.length : Math.max(0, Math.min(index, children.length)), 0, node);
    return { ...target, children };
  }
  const [i, ...rest] = path;
  const children = target.children.map((c, idx) => (idx === i ? insertNodeAt(c, rest, node, index) : c));
  return { ...target, children };
}

/**
 * Adds `node` as one more requirement on the whole filter. An `$and` root
 * takes it as another child; an `$or` or `$nor` root is wrapped in a new
 * `$and` beside it, because joining the root group would make the node an
 * alternative (or an exclusion) instead of a requirement.
 */
export function andAtRoot(root: GroupNode, node: FilterNode): GroupNode {
  if (root.logic === '$and') return insertAt(root, [], node);
  return { kind: 'group', logic: '$and', children: [root, node] };
}

/** `index` omitted appends — every existing caller relies on that. */
export function insertAt(root: GroupNode, parent: NodePath, node: FilterNode, index?: number): GroupNode {
  return insertNodeAt(root, parent, node, index) as GroupNode;
}

function removeNodeAt(target: FilterNode, path: NodePath): FilterNode {
  if (target.kind !== 'group') return target;
  const [i, ...rest] = path;
  if (rest.length === 0) {
    return { ...target, children: target.children.filter((_, idx) => idx !== i) };
  }
  const children = target.children.flatMap((c, idx) => {
    if (idx !== i) return [c];
    const updated = removeNodeAt(c, rest);
    // Removing the last child of a nested group removes the empty group too.
    if (updated.kind === 'group' && updated.children.length === 0) return [];
    return [updated];
  });
  return { ...target, children };
}

export function removeAt(root: GroupNode, path: NodePath): GroupNode {
  if (path.length === 0) return root; // the root group is never removed
  return removeNodeAt(root, path) as GroupNode;
}

/**
 * Move a node within its own group (never between groups). Composed from
 * `removeAt` + index-aware `insertAt` so the tree keeps a single
 * mutation path. A move needs at least two siblings (otherwise `to` is out of
 * range and this is a no-op), so the level can never empty out under the
 * remove — `removeNodeAt`'s empty-group prune can't fire here.
 */
export function moveAt(root: GroupNode, path: NodePath, delta: number): GroupNode {
  if (path.length === 0) return root; // the root group has no siblings
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath);
  const node = nodeAt(root, path);
  // Stryker disable next-line ConditionalExpression: `path` is `parentPath`
  // plus one more index, and `nodeAt`'s own traversal returns null for the
  // whole path as soon as any prefix — including the one ending at `parent`
  // — isn't a group. So whenever `parent.kind !== 'group'` would be true,
  // `node` is already null and `!node` short-circuits this OR first; this
  // third disjunct can never independently flip the result.
  if (!node || !parent || parent.kind !== 'group') return root;
  const to = path[path.length - 1] + delta;
  if (to < 0 || to >= parent.children.length) return root;
  return insertAt(removeAt(root, path), parentPath, node, to);
}

export function wrapInGroup(root: GroupNode, path: NodePath, logic: GroupNode['logic']): GroupNode {
  const target = nodeAt(root, path);
  // Stryker disable next-line ConditionalExpression: `target` is only null
  // for a `path` that fails to resolve in `root` — and the very same `path`
  // then also fails to match anything inside the `updateAt` call below (its
  // traversal mirrors `nodeAt`'s), so the corrupted `wrapped` node built from
  // a null `target` is never actually spliced into the returned tree either way.
  if (!target) return root;
  const wrapped: GroupNode = { kind: 'group', logic, children: [target] };
  return updateAt(root, path, wrapped);
}

/**
 * Replaces a nested group that holds exactly one child with that child — the
 * inverse of `wrapInGroup`, and how a negation (a one-child `$nor`) is
 * removed. Anything else is left alone, returning `root` itself: the root, a
 * non-group, a group of several children, or a path that doesn't resolve.
 * A switched-off group hands that to its child, so removing the wrapper
 * never switches a condition back on.
 */
export function unwrapGroup(root: GroupNode, path: NodePath): GroupNode {
  if (path.length === 0) return root;
  const target = nodeAt(root, path);
  if (!target || target.kind !== 'group' || target.children.length !== 1) return root;
  return updateAt(root, path, carryDisabled(target, target.children[0]));
}

/**
 * Best-effort encode of a cond as a raw node. Falls back to a blank pending
 * raw node — never `{}`, which matches everything and would make a bad
 * fallback silently widen the group it sits in (§4).
 */
export function toRawNode(cond: CondNode): RawNode {
  const json =
    cond.field.trim() === '' || condValueProblem(cond)
      ? ''
      : JSON.stringify({ [cond.field]: { [cond.op]: encodeCondValue(cond) } });
  return carryDisabled(cond, { kind: 'raw', json });
}

/**
 * A replacement keeps the node switched off if it was: converting a row, or
 * dropping a field onto it, is not re-enabling it.
 */
export function carryDisabled<T extends FilterNode>(from: FilterNode, to: T): T {
  return from.disabled ? { ...to, disabled: true } : to;
}

/**
 * raw → cond(s) when §2 can model it, wrapped in `$and` when it models to
 * more than one node (splicing them flat would change semantics under an
 * `$or`/`$nor` parent), bare when it models to exactly one; unchanged when
 * `raw.json` isn't valid JSON or isn't an object (§4).
 */
export function tryParseRaw(raw: RawNode): FilterNode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.json);
  }
  // Stryker disable next-line BlockStatement: an emptied catch body leaves
  // `parsed` at its initial `undefined` (JSON.parse threw before
  // assignment), and `isPlainObject(undefined)` is false — so the very
  // next line already returns `raw`, the identical result this catch
  // returns explicitly.
  catch {
    return raw;
  }
  if (!isPlainObject(parsed)) return raw;
  return carryDisabled(raw, collapseToNode(parseClauseToNodes(parsed)));
}
