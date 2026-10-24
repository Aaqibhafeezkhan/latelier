import type { BuilderState, CollectionTabState, MqlOp, ReadPreferenceMode, ValType } from '@shared/types';
import { toDisplayValue, type DisplayType } from '../../utils/displayValue';
import { ejsonParse, isEjsonDocument, isPlainDocument, isValidEjson } from '../../utils/ejson';
import {
  buildScalarWire,
  coerceArrayElementWire,
  parseJsonArrayLenient,
  type CondNode,
  type FilterNode,
} from './filterTree';
import { isRawProjection } from './projection';
import { ownGet, ownSet } from '../../utils/ownProperty';
import { repairToCanonicalEjson } from '../../utils/shellSyntax';

export const FIELD_OPS: Record<ValType, MqlOp[]> = {
  string:   ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$regex', '$exists', '$type'],
  number:   ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type', '$mod',
             '$bitsAllClear', '$bitsAnyClear', '$bitsAllSet', '$bitsAnySet'],
  // $mod/$bits route through Number() coercion, which would reintroduce the
  // precision loss long/decimal exist to avoid — omitted deliberately.
  long:     ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type'],
  decimal:  ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type'],
  boolean:  ['$eq', '$ne', '$exists', '$type'],
  date:     ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$exists', '$type'],
  null:     ['$eq', '$ne', '$exists', '$type'],
  regex:    ['$regex', '$exists', '$type'],
  objectid: ['$eq', '$ne', '$in', '$nin', '$exists', '$type'],
  array:    ['$in', '$nin', '$all', '$exists', '$type', '$size'],
};

export function valTypeFromDisplayType(dt: DisplayType | undefined): ValType {
  switch (dt) {
    case 'objectid': return 'objectid';
    case 'date':     return 'date';
    case 'long':     return 'long';
    case 'decimal':  return 'decimal';
    case 'number':   return 'number';
    case 'boolean':  return 'boolean';
    case 'null':     return 'null';
    case 'regex':    return 'regex';
    case 'array':    return 'array';
    default:         return 'string';
  }
}

/** Prefers the caller's current op if still applicable to the new valType. */
export function opForValType(valType: ValType, currentOp: string): MqlOp {
  const ops = FIELD_OPS[valType] ?? FIELD_OPS.string;
  if ((ops as readonly string[]).includes(currentOp)) return currentOp as MqlOp;
  // Stryker disable next-line StringLiteral: FIELD_OPS is a total, non-empty
  // Record over every ValType, and the fallback FIELD_OPS.string is also
  // non-empty — ops[0] can never be undefined for any real or invalid-cast
  // valType, so this `?? '$eq'` fallback is unreachable defensive code.
  return ops[0] ?? '$eq';
}

export type SortDir = 1 | -1;

/**
 * The driver's own rule (`prepareDirection` in node_modules/mongodb/lib/sort.js):
 * a direction is valid only when its lowercased string form is one of these six
 * words. bson numerics stringify to their digits, so `{"$numberInt":"1"}`
 * counts; `2`, `0.5` and `" asc"` make the driver throw, so they draw nothing.
 * `{$meta}` is valid but has no ±1 to draw. Sub-documents and arrays are
 * skipped before stringifying: `ejsonParse` builds sub-documents with a null
 * prototype, which `String()` throws on. The driver would accept `[1]`; no
 * sort the app writes has that shape.
 */
const SORT_DIRECTIONS: Record<string, SortDir> = {
  '1': 1,
  asc: 1,
  ascending: 1,
  '-1': -1,
  desc: -1,
  descending: -1,
};

function normalizeSortDir(v: unknown): SortDir | undefined {
  if (Array.isArray(v) || isPlainDocument(v)) return undefined;
  return ownGet(SORT_DIRECTIONS, String(v).toLowerCase());
}

/** Parses `{"name":1,"age":-1}` as EJSON. Unparseable/unmodeled shapes drop silently to `{}`. */
export function parseSortString(raw: string): Record<string, SortDir> {
  // Stryker disable next-line StringLiteral: this fallback only fires when
  // `raw` is null/undefined, and ejsonParse throws on '' and on any
  // placeholder text Stryker substitutes alike, so the catch returns the
  // identical {} either way.
  const trimmed = (raw ?? '').trim();
  let parsed: unknown;
  try {
    parsed = ejsonParse(trimmed);
  }
  // Stryker disable next-line BlockStatement: an emptied catch leaves
  // `parsed` at its initial `undefined`, which isPlainDocument on the next
  // line rejects — returning the identical `{}` this catch returns.
  catch {
    return {};
  }
  if (!isPlainDocument(parsed)) return {};
  const out: Record<string, SortDir> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const dir = normalizeSortDir(v);
    if (dir !== undefined) ownSet(out, k, dir);
  }
  return out;
}

/** not-present → asc → desc → cleared; replaces any existing multi-field sort. */
export function cycleSortField(currentRaw: string, field: string): string {
  const current = parseSortString(currentRaw);
  const dir = ownGet(current, field);
  if (dir === undefined) return JSON.stringify({ [field]: 1 });
  if (dir === 1) return JSON.stringify({ [field]: -1 });
  return '';
}

export function sortFieldPatch(
  state: CollectionTabState,
  field: string,
): Partial<CollectionTabState> {
  const builder = { ...state.builder, sort: cycleSortField(state.builder.sort, field) };
  return { builder };
}

export interface CompiledFindOptions {
  sort?: string;
  projection?: string;
  limit: number | null;
  collation?: string;
  hint?: string;
  maxTimeMS?: number;
  readPreference?: ReadPreferenceMode;
}

/** The driver's read preference modes, in the order the query bar lists them. */
export const READ_PREFERENCE_MODES: readonly ReadPreferenceMode[] = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
];

/**
 * The find's own server-side cap, `QUERY_TIMEOUT_MS` in
 * `electron/mongo/timeouts.ts` (the renderer cannot import it). A larger
 * maxTimeMS is clamped to it there: a user value can only lower the cap.
 */
export const MAX_TIME_MS_CAP = 30_000;

function isReadPreference(raw: string | undefined): raw is ReadPreferenceMode {
  return (READ_PREFERENCE_MODES as readonly (string | undefined)[]).includes(raw);
}

/** Digits only, unlike `limit`: `5xyz` or `1.5` is refused rather than coerced. */
function parseMaxTimeMS(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** The text as EJSON: Shell Syntax repaired (X14), strict text as is; undefined when it cannot be read. */
function repairedText(text: string): string | undefined {
  const outcome = repairToCanonicalEjson(text);
  if (outcome.kind === 'failed') return undefined;
  return outcome.kind === 'repaired' ? outcome.text : text;
}

/** A collation or key-pattern hint as sent, or undefined when it is not a document. */
function documentOption(text: string): string | undefined {
  const json = repairedText(text);
  return json !== undefined && isEjsonDocument(json) ? json : undefined;
}

/**
 * A hint as sent. `{` starts a key pattern, which must be a document. A
 * quoted name (`"_id_"`, `'_id_'`) is the name it quotes: sent with its
 * quotes it would name no index. Any other text is an index name, which only
 * the server can check. Undefined when a key pattern or quoted name cannot be
 * read.
 */
function hintOption(text: string): string | undefined {
  if (text.startsWith('{')) return documentOption(text);
  if (!/^["']/.test(text)) return text;
  const json = repairedText(text);
  // A read text that opens with a quote is one JSON string: the repair
  // refuses anything after the closing quote.
  return json === undefined ? undefined : (JSON.parse(json) as string);
}

export function compileFindOptions(state: BuilderState): CompiledFindOptions {
  let sort: string | undefined;
  if (state.sort.trim()) {
    sort = state.sort.trim();
  }

  let projection: string | undefined;
  const raw = state.projectionRaw?.trim();
  if (raw) {
    // Used verbatim, unvalidated — projectionProblem is the gate. Falling
    // back to undefined here would silently return every field instead.
    projection = raw;
  } else if (state.projection.length > 0) {
    const projObj: Record<string, number> = { _id: 1 };
    for (const f of state.projection) {
      ownSet(projObj, f, 1);
    }
    projection = JSON.stringify(projObj);
  }

  // Mongo treats `.limit(0)` as unlimited; collapse non-finite/zero/negative to null.
  //
  // Stryker disable next-line MethodExpression: Number.parseInt already skips
  // leading whitespace and stops at the first non-digit character on its
  // own, so parsing the untrimmed `state.limit` instead of the trimmed copy
  // yields the identical integer (or NaN) for every input — verified across
  // a range of padded/garbage limit strings (scratchpad/probe5.mjs).
  const parsedLimit = state.limit.trim() ? Number.parseInt(state.limit.trim(), 10) : null;
  const limit =
    // Stryker disable next-line ConditionalExpression: Number.isFinite(null)
    // is false (type-strict), so dropping the redundant `parsedLimit !== null`
    // conjunct can't change the result.
    parsedLimit !== null && Number.isFinite(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : null;

  // Collation and hint go out as EJSON, so Shell Syntax runs as typed;
  // `optionsProblem` is the gate, and text it refuses is passed through
  // unchanged. A blank one is unset.
  const collation = state.collation?.trim();
  const hint = state.hint?.trim();
  return {
    sort,
    projection,
    limit,
    collation: collation ? (documentOption(collation) ?? collation) : undefined,
    hint: hint ? (hintOption(hint) ?? hint) : undefined,
    maxTimeMS: parseMaxTimeMS(state.maxTimeMS),
    readPreference: isReadPreference(state.readPreference) ? state.readPreference : undefined,
  };
}

export type FindOptionKey = 'collation' | 'hint' | 'maxTimeMS' | 'readPreference';

/**
 * Each find option that cannot run, by option, for the options row's own
 * notices. A blank option is unset, never a problem. A collation, and a hint
 * that starts with `{` (a key pattern, the rule `QueryService` applies
 * main-side), must be a document, Shell Syntax allowed; a quoted hint must be
 * one closed string.
 */
export function findOptionProblems(state: BuilderState): Partial<Record<FindOptionKey, string>> {
  const problems: Partial<Record<FindOptionKey, string>> = {};
  const collation = state.collation?.trim();
  if (collation && documentOption(collation) === undefined) {
    problems.collation = 'Can\'t parse this collation. Expected EJSON like { "locale": "en", "strength": 2 }.';
  }
  const hint = state.hint?.trim();
  if (hint && hintOption(hint) === undefined) {
    problems.hint = 'Can\'t parse this hint. Expected an index name like _id_ or a key pattern like { "a": 1 }.';
  }
  if (state.maxTimeMS?.trim() && parseMaxTimeMS(state.maxTimeMS) === undefined) {
    problems.maxTimeMS = 'maxTimeMS must be a whole number of milliseconds, at least 1.';
  }
  if (state.readPreference && !isReadPreference(state.readPreference)) {
    problems.readPreference = `"${state.readPreference}" is not a read preference. Expected one of ${READ_PREFERENCE_MODES.join(', ')}.`;
  }
  return problems;
}

/** The first find option that cannot run, or null. */
export function optionsProblem(state: BuilderState): string | null {
  return Object.values(findOptionProblems(state))[0] ?? null;
}

/** A runnable maxTimeMS over the cap still runs, at the cap: say so rather than clamp silently. */
export function maxTimeMSWarning(raw: string | undefined): string | null {
  const n = parseMaxTimeMS(raw);
  if (n === undefined || n <= MAX_TIME_MS_CAP) return null;
  return `Running with maxTimeMS ${MAX_TIME_MS_CAP}, the most a query may run.`;
}

/** Shared by the Run button and useQueryRunner so sort-validity can't drift between them. */
export function sortProblem(raw: string): string | null {
  if (raw.trim() === '') return null;
  if (!isValidEjson(raw)) return "Can't parse this sort. Expected EJSON like { field: 1 }.";
  if (!isEjsonDocument(raw)) return 'A sort must be a document, like { field: 1 }.';
  for (const [field, dir] of Object.entries(ejsonParse<Record<string, unknown>>(raw))) {
    if (normalizeSortDir(dir) === undefined && !isMetaSort(dir)) {
      return `Sort direction for "${field}" must be 1, -1, "asc" or "desc".`;
    }
  }
  return null;
}

/** The driver's `isMeta`: a `{ $meta: "<string>" }` direction, e.g. `textScore`. */
function isMetaSort(dir: unknown): boolean {
  return isPlainDocument(dir) && typeof ownGet(dir as Record<string, unknown>, '$meta') === 'string';
}

export type SortClass =
  | 'none'
  | 'mapped'
  | 'partial'
  | 'hidden'
  | 'absent'
  | 'unrepresentable'
  | 'invalid';

/**
 * How much of a sort string the table header's per-column arrows can draw.
 * `shownFields`/`schemaFields` distinguish "hidden" (unhide the column) from
 * "absent" (no column could show it) from "unrepresentable" (no key mapped).
 */
export function classifySort(
  raw: string,
  shownFields?: ReadonlySet<string>,
  schemaFields?: ReadonlySet<string>,
): SortClass {
  if ((raw ?? '').trim() === '') return 'none';
  if (sortProblem(raw) !== null) return 'invalid';
  // sortProblem has already parsed `raw` as an EJSON document whose every
  // value is a driver direction or a `$meta`, so this parse cannot throw.
  const total = Object.keys(ejsonParse<Record<string, unknown>>(raw)).length;
  if (total === 0) return 'none';
  const mapped = Object.keys(parseSortString(raw));
  const drawn = shownFields ? mapped.filter((k) => shownFields.has(k)).length : mapped.length;
  if (drawn === 0) {
    if (mapped.length === 0) return 'unrepresentable';
    if (!schemaFields) return 'hidden';
    return mapped.some((k) => schemaFields.has(k)) ? 'hidden' : 'absent';
  }
  return drawn === total ? 'mapped' : 'partial';
}

/** `0`/`-3`/`abc` compile to no-limit; `5xyz` compiles to `5` (parseInt stops at the junk). */
export function limitWarning(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return `"${text}" is not a positive number — running with no limit.`;
  }
  if (String(parsed) !== text) {
    return `Running with limit ${parsed} — the rest of "${text}" is ignored.`;
  }
  return null;
}

export function projectionProblem(state: BuilderState): string | null {
  const raw = state.projectionRaw?.trim();
  if (!raw || isRawProjection(raw)) return null;
  return 'Can\'t parse this projection. Expected EJSON like { "_id": 0 }.';
}

/** First unrunnable clause of the query, or null. Order matches the command's clause order. */
export function findProblem(state: CollectionTabState): string | null {
  return (
    filterProblem(state.queryRaw) ??
    sortProblem(state.builder.sort) ??
    projectionProblem(state.builder) ??
    optionsProblem(state.builder)
  );
}

export function filterProblem(queryRaw: string): string | null {
  // A blank box is missing a filter, not holding one that fails to parse. It
  // stays a problem: this is also the Run gate, and a null here would enable
  // Run, Explain and delete-all on an empty filter.
  if (queryRaw.trim() === '') {
    return 'Enter a filter, like { "status": "active" }, or {} to match every document.';
  }
  if (!isValidEjson(queryRaw)) {
    return 'Can\'t parse this filter. Expected EJSON like { "status": "active" }.';
  }
  if (!isEjsonDocument(queryRaw)) {
    return 'A filter must be a document, like { "status": "active" }.';
  }
  return null;
}

/** True at the "no filter, default sort/limit/projection" starting point — gates auto-run-on-open. */
export function isDefaultQueryState(state: CollectionTabState): boolean {
  const filter = state.queryRaw.trim();
  const isDefaultFilter = filter === '' || filter === '{}';
  return (
    isDefaultFilter &&
    state.builder.sort === '' &&
    state.builder.limit === '' &&
    state.builder.projection.length === 0 &&
    !state.builder.projectionRaw?.trim()
  );
}

/**
 * The filter a tab's `run()` would actually send right now, or `null` if
 * none is runnable. Callers MUST NOT widen `null` to `{}` — delete-all reads
 * this to decide whether it has a filter to act on at all.
 */
export function currentFilterJson(state: CollectionTabState): string | null {
  const raw = state.queryRaw.trim();
  // Stryker disable next-line ConditionalExpression,StringLiteral:
  // isEjsonDocument('') starts with `if (!t) return false;` for a blank
  // string, so whenever `raw === ''` this line's second disjunct is already
  // true on its own — disabling (or misdirecting) the first disjunct can't
  // change the result.
  if (raw === '' || !isEjsonDocument(raw)) return null;
  return raw;
}

/**
 * True when an empty result is because the collection itself is empty
 * rather than because the committed filter matched nothing: no filter, on
 * the first page, and the run didn't error. `ResultViewer`'s `EmptyState`
 * uses this to decide between "This collection is empty" (with an Import
 * CTA) and "No matching documents".
 */
export function isUnfilteredFirstPage(state: CollectionTabState): boolean {
  const filter = state.queryRaw.trim();
  return (filter === '' || filter === '{}') && state.page === 0 && !state.lastRun?.error;
}

/**
 * `{ skip, limit }` for one page, treating `userLimit` as a hard cap across
 * pages. Past the cap `limit` is `0` — callers MUST short-circuit rather than
 * send that to Mongo, which reads `limit: 0` as unlimited.
 */
export function effectivePageLimit(
  userLimit: number | null,
  page: number,
  pageSize: number,
): { skip: number; limit: number } {
  const skip = page * pageSize;
  if (userLimit === null) return { skip, limit: pageSize };
  const remaining = Math.max(0, userLimit - skip);
  return { skip, limit: Math.min(pageSize, remaining) };
}

export const DRAGGED_FIELD_MIME = 'application/x-atelier-field';

export interface DraggedField {
  field: string;
  value: unknown;
}

/** Builds a `$eq` CondNode from a dragged field/value, inferring ValType from the value's shape. */
export function condFromDragged(dragged: DraggedField): CondNode {
  const { field, value } = dragged;
  const dv = toDisplayValue(value);
  const valType = valTypeFromDisplayType(dv.type);

  let valueStr: string;
  if (valType === 'null') {
    valueStr = '';
  } else if (
    valType === 'objectid' ||
    valType === 'date' ||
    valType === 'number' ||
    valType === 'long' ||
    valType === 'decimal'
  ) {
    valueStr = dv.display;
  } else if (
    // Stryker disable next-line ConditionalExpression,StringLiteral: for a
    // boolean value, String(value) and this function's own final-fallback
    // `JSON.stringify(value)` produce the byte-identical text ("true"/
    // "false"), so skipping this branch (falling through to that fallback)
    // is unobservable — verified: String(true)===JSON.stringify(true) and
    // likewise for false.
    valType === 'boolean'
  ) {
    valueStr = String(value);
  } else if (
    valType === 'regex' &&
    value &&
    // Stryker disable next-line ConditionalExpression: whenever
    // `valType === 'regex'`, `value` is already guaranteed to be a plain
    // object — that's the only shape valTypeFromDisplayType/toDisplayValue
    // ever assigns 'regex' from (see displayValue.ts's `isRecord(v)` guard
    // around the regex branch) — so forcing this conjunct to `true` can't
    // change the result for any real call.
    typeof value === 'object' &&
    '$regex' in value
  ) {
    const r = (value as Record<string, unknown>).$regex;
    // Stryker disable next-line ConditionalExpression,StringLiteral: `r` is
    // guaranteed to be a string whenever this branch runs (same invariant as
    // above — displayValue.ts only assigns 'regex' when `typeof v.$regex
    // === 'string'`), so forcing the true branch, or changing the
    // unreachable false branch's text, can't change the result.
    valueStr = typeof r === 'string' ? r : '';
  } else if (
    // Stryker disable next-line ConditionalExpression,StringLiteral: this
    // branch's body and the final `else` branch's body below are both
    // `JSON.stringify(value)` verbatim — skipping this branch (e.g. via
    // `typeof value === 'string'`, false for an array) falls straight
    // through to that identical fallback.
    valType === 'array'
  ) {
    valueStr = JSON.stringify(value);
  } else if (typeof value === 'string') {
    valueStr = value;
  } else {
    valueStr = JSON.stringify(value);
  }

  return { kind: 'cond', field, op: '$eq', valType, value: valueStr };
}

/** Ops a drop onto an existing cond row can merge into, rather than replace. */
const MERGEABLE_DROP_OPS = new Set<string>(['$eq', '$in', '$nin']);

function isJsonArray(raw: string): boolean {
  try {
    return Array.isArray(JSON.parse(raw));
  }
  // Stryker disable next-line BlockStatement: this private function's only
  // caller (mergeOrReplaceDragged below) uses it solely under `!isJsonArray(
  // ...)` — a truthiness check — and an emptied catch body leaves the
  // function returning `undefined`, which is exactly as falsy as `false` in
  // that one call site (`!undefined === !false === true`).
  catch {
    return false;
  }
}

/**
 * Drop onto an existing row: same field + mergeable op extends it as an
 * `$in`/`$nin` list (values normalized via buildScalarWire/coerceArrayElementWire,
 * duplicates skipped); anything else falls back to `condFromDragged`'s replace.
 */
export function mergeOrReplaceDragged(target: FilterNode, dragged: DraggedField): CondNode {
  // Stryker disable next-line ConditionalExpression: a RawNode/GroupNode has
  // no `.field`/`.op` own properties, so `target.field` is `undefined` —
  // strictly unequal to `dragged.field` (always a real string) — for every
  // non-cond FilterNode. The second disjunct already catches every such
  // target, making the `target.kind !== 'cond'` check redundant (verified
  // by the existing "target is a raw clause" test, which never touched
  // .field at all).
  if (target.kind !== 'cond' || target.field !== dragged.field || !MERGEABLE_DROP_OPS.has(target.op)) {
    return condFromDragged(dragged);
  }
  if (target.op !== '$eq' && !isJsonArray(target.value)) {
    return condFromDragged(dragged);
  }

  const fresh = condFromDragged(dragged);
  const newElement = buildScalarWire(fresh.valType, fresh.value);

  const current: unknown[] =
    target.op === '$eq'
      ? [buildScalarWire(target.valType, target.value)]
      : parseJsonArrayLenient(target.value).map((el) =>
          // Stryker disable next-line StringLiteral: coerceArrayElementWire's
          // switch has no 'array' case (only objectid/long/decimal/date/
          // number/boolean/string), so it falls to `default: return el;` for
          // valType 'array' — the identical passthrough this ternary's true
          // branch already gives. Comparing against the wrong literal here
          // still routes every valType through the same coerce call, whose
          // result for 'array' happens to equal the passthrough anyway.
          //
          // Known residual mutation-testing gap (not fixable with a disable
          // comment): Stryker's "always-coerce" (false-forcing) variant of
          // this ternary's ConditionalExpression mutant is equivalent for the
          // same reason as the StringLiteral mutant above, but its sibling
          // "always-passthrough" (true-forcing) variant is a real, separately
          // tested gap (see the "objectid $in row coerces a bare unwrapped
          // string" test) — Stryker shares one mutator-name+location for
          // both, so a disable comment here would silence the real gap's
          // coverage too. Left un-annotated on purpose; the false-forcing
          // mutant will keep showing as one honestly-accepted "Survived".
          target.valType === 'array' ? el : coerceArrayElementWire(el, target.valType),
        );

  // Unparsable "number" text silently becomes NaN → JSON.stringify → null;
  // fall back to replace rather than merge a corrupted value into the list.
  // Stryker disable next-line ConditionalExpression: Number.isFinite is
  // type-strict — already false for any non-number `el` — so dropping the
  // redundant `typeof el !== 'number'` disjunct can't change the result.
  if (target.valType === 'number' && current.some((el) => typeof el !== 'number' || !Number.isFinite(el))) {
    return condFromDragged(dragged);
  }

  const alreadyPresent = current.some((el) => JSON.stringify(el) === JSON.stringify(newElement));
  const nextArray = alreadyPresent ? current : [...current, newElement];

  return {
    kind: 'cond',
    field: target.field,
    op: target.op === '$nin' ? '$nin' : '$in',
    valType: 'array',
    value: JSON.stringify(nextArray),
  };
}

export function emptyBuilder(): BuilderState {
  return {
    projection: [],
    sort: '',
    limit: '',
  };
}
