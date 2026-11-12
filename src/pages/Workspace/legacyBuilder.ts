/**
 * FROZEN — W13-2, spec §8.
 *
 * Pins the pre-W13 filter compiler and the pre-`queryRaw` saved-payload
 * shape so a find saved before `queryRaw` existed — whose filter lives only
 * in `builder.conditions` — still hydrates correctly once W13-5
 * deletes `conditions`/`logic` from the live `BuilderState`. Without this,
 * every such saved find would silently load as `{}`: the user's filter gone,
 * no error, no way to notice.
 *
 * Read-only. Never used for editing, never extended — except
 * `LegacySavedFindPayload`, which is the read boundary this shim exists to
 * serve. `legacyCompileFilter` is a standalone copy of the filter half of
 * `compileMql` (as it stood pre-W13), not a delegation into it: `builder.ts`
 * loses that half once W13-5 lands, and a delegating shim would break with it.
 */

import type { BuilderState } from '@shared/types';

// ─── Legacy shapes ───────────────────────────────────────────────────────────

export type LegacyValType =
  | 'string' | 'number' | 'long' | 'decimal' | 'boolean' | 'date' | 'null' | 'regex' | 'objectid' | 'array';

export interface LegacyCond {
  id: number;
  field: string;
  op: string;
  valType: LegacyValType;
  value: string;
}

export interface LegacyBuilderState {
  conditions: LegacyCond[];
  logic: 'AND' | 'OR';
  projection: string[];
  sort: string;
  limit: string;
}

/**
 * Stored find-payload shape as it may exist on disk from before `queryRaw`
 * existed. Distinct from the live `SavedFindPayload` on purpose: the read
 * boundary must not drift when the live type changes shape.
 */
export interface LegacySavedFindPayload {
  kind: 'find';
  builder: LegacyBuilderState;
  queryRaw?: string;
  description?: string;
}

// ─── legacyCompileFilter — frozen copy of pre-W13 compileMql's filter half ──

// Stryker disable next-line ArrayDeclaration,StringLiteral: SIMPLE_OPS gates
// an early `return buildTypedValue(cond)` in buildCondValue below, but every
// other branch there is disjoint from these six op strings, so the function
// falls through all of them to its own final `return buildTypedValue(cond)`
// for any op this set does or doesn't contain — the early return and the
// fallthrough return the identical value either way (verified empirically:
// probe-legacy-simpleops.mjs). This set's actual membership is unobservable
// as long as it stays disjoint from $regex/$type/$mod/$size/BITS_OPS, which
// this frozen file's contents already are.
const SIMPLE_OPS = new Set<string>(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const ARRAY_VALUE_OPS = new Set<string>(['$in', '$nin', '$all']);
const BITS_OPS = new Set<string>(['$bitsAllClear', '$bitsAnyClear', '$bitsAllSet', '$bitsAnySet']);

function parseJsonArray(raw: string): unknown[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function buildTypedValue(cond: LegacyCond): unknown {
  const { valType, value } = cond;
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
        return JSON.parse(value) as unknown;
      } catch {
        return [];
      }
    default:
      return value;
  }
}

function isEjsonWrapped(el: unknown, key: string): boolean {
  return typeof el === 'object' && el !== null && key in el;
}

function coerceArrayElement(el: unknown, valType: LegacyValType): unknown {
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
      // Stryker disable next-line ConditionalExpression,StringLiteral: for
      // any real JS number el, Number(el) === el (a no-op round trip), so
      // forcing the branch to always coerce — or comparing typeof against
      // the wrong literal — produces the identical value either way
      // (Number() is idempotent on values that are already numbers).
      return typeof el === 'number' ? el : Number(el);
    case 'boolean':
      return typeof el === 'boolean' ? el : el === 'true';
    case 'string':
      return String(el);
    default:
      return el;
  }
}

function buildCondValue(cond: LegacyCond): unknown {
  const { op, value, valType } = cond;
  if (op === '$exists') return true;
  // Stryker disable next-line ConditionalExpression: every other branch
  // below is disjoint from SIMPLE_OPS's members ($eq/$ne/$gt/$gte/$lt/$lte
  // never match $regex/$type/$mod/$size/BITS_OPS), so forcing this to false
  // for a SIMPLE_OPS op just falls through all of them to the function's own
  // final `return buildTypedValue(cond)` — the identical value this early
  // return already gives (verified empirically: probe-legacy-simpleops.mjs).
  if (SIMPLE_OPS.has(op)) return buildTypedValue(cond);
  if (ARRAY_VALUE_OPS.has(op)) {
    return parseJsonArray(value).map((el) => coerceArrayElement(el, valType));
  }
  if (op === '$regex') return value;
  if (op === '$type') {
    const n = Number(value);
    return Number.isFinite(n) && value.trim() !== '' ? n : value;
  }
  if (op === '$mod') {
    const arr = parseJsonArray(value);
    return arr.length === 2 ? arr : [0, 0];
  }
  if (op === '$size' || BITS_OPS.has(op)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return buildTypedValue(cond);
}

function buildCondObject(cond: LegacyCond): Record<string, unknown> {
  return { [cond.field]: { [cond.op]: buildCondValue(cond) } };
}

/**
 * Pre-W13 filter compile: `state.conditions` + `state.logic` → an MQL
 * filter string. Mirrors `compileMql`'s filter half exactly (as of W13),
 * frozen — this is the only thing standing between a pre-`queryRaw` saved
 * find and `{}` once W13-5 deletes the live compiler's filter half.
 */
export function legacyCompileFilter(state: LegacyBuilderState): string {
  const activeConds = state.conditions.filter((c) => c.field.trim() !== '');

  let filter: unknown;
  if (activeConds.length === 0) {
    filter = {};
  } else if (activeConds.length === 1 && activeConds[0]) {
    filter = buildCondObject(activeConds[0]);
  } else {
    const op = state.logic === 'OR' ? '$or' : '$and';
    filter = { [op]: activeConds.map(buildCondObject) };
  }

  return JSON.stringify(filter);
}

/**
 * Hydrate a stored find payload (saved or recent) into a builder patch —
 * the single call site for the W13-2 shim (spec §8). `queryRaw` when
 * present, else the pre-W13 filter compiled from `builder.conditions` via
 * the frozen `legacyCompileFilter`. Sort/limit/projection are copied
 * explicitly into the shrunk `BuilderState` shape (§8.4) rather than
 * passed through wholesale — the legacy `builder` also carries
 * `conditions`/`logic`, which the live type no longer has room for.
 *
 * `payload` is typed against `LegacySavedFindPayload`, not the live
 * `SavedFindPayload`, on purpose: if the live type's `queryRaw` is ever
 * made required, an annotation borrowed from that type would let
 * TypeScript "prove" the `??` fallback below unreachable and invite
 * deleting it — reintroducing the exact data loss this shim exists to
 * prevent for every find saved before `queryRaw` existed. On the wire,
 * writes are checked per kind and reads are not, so a
 * pre-`queryRaw` row really can arrive shaped like `LegacySavedFindPayload`
 * despite the live `SavedQuery`/`RecentQuery` types claiming otherwise —
 * that mismatch is exactly what this cast bridges.
 */
export function hydrateFindPayload(
  payload: LegacySavedFindPayload,
  /** The tab's builder now: what a payload without one keeps. */
  current: BuilderState,
): { builder: BuilderState; queryRaw: string } {
  // `payload.builder` is typed required, but this reads data straight off
  // the wire (writes are checked per kind, reads are not, §8.3)
  // — a row missing it entirely isn't ruled out. Fall back to an empty
  // legacy builder (no conditions → `legacyCompileFilter` produces '{}')
  // rather than throwing inside a click handler with no feedback.
  const legacyBuilder: LegacyBuilderState = payload.builder ?? {
    conditions: [],
    logic: 'AND',
    sort: current.sort,
    limit: current.limit,
    projection: current.projection,
  };
  const { sort, limit, projection } = legacyBuilder;
  // `projectionRaw` (W15 §9(b)) is saved and round-trips through SQLite,
  // so it has to be read here too, not dropped: dropping it means "Run
  // here" on a query saved with `{_id: 0}` runs with every field instead —
  // the §11 fail-open, from a saved query. `LegacyBuilderState` is frozen
  // and has no room for it, so TypeScript can't catch a drop here on its
  // own — the cast reads it off the wire shape the same way the
  // `queryRaw` fallback above does.
  //
  // Written explicitly, including when there is none: `onPatch` replaces
  // the whole builder, so a payload with no raw projection has to *clear*
  // one already on the tab, and clearing by omission is what caused this.
  const projectionRaw = payload.builder
    ? (payload.builder as { projectionRaw?: string }).projectionRaw
    : current.projectionRaw;
  // W14 §9's find options, for the same reason: a collation changes which
  // documents match, so dropping it reruns a different query. A payload
  // without them clears the tab's, and so does a row with no builder at
  // all, unlike the raw projection above: such a row predates the options,
  // so the query it saved never had any.
  const options = (payload.builder ?? {}) as Pick<
    BuilderState,
    'collation' | 'hint' | 'maxTimeMS' | 'readPreference'
  >;
  return {
    builder: {
      sort,
      limit,
      projection,
      projectionRaw,
      collation: options.collation,
      hint: options.hint,
      maxTimeMS: options.maxTimeMS,
      readPreference: options.readPreference,
    },
    queryRaw: payload.queryRaw ?? legacyCompileFilter(legacyBuilder),
  };
}
