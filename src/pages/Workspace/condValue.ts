// Pure helpers behind the filter tree's type-aware value editors (W15 §14.3).
// A condition's value is always text (`CondNode.value`); these convert between
// that text and what each editor shows, without React.
import type { CondNode, SchemaSampleEntry, ValType } from '@shared/types';
import { checkFieldType, inferType, type TypeWarning } from './schemaSummary';
import { SIMPLE_OPS, coerceArrayElementWire, parseJsonArrayLenient } from './filterTree';

export type DatePresetId = 'now' | 'startOfToday' | '7d' | '30d' | 'startOfMonth';

export const DATE_PRESETS: { id: DatePresetId; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'startOfToday', label: 'Start of today' },
  { id: '7d', label: '7 days ago' },
  { id: '30d', label: '30 days ago' },
  { id: 'startOfMonth', label: 'Start of this month' },
];

const DAY_MS = 86_400_000;

/**
 * The ISO timestamp a date preset stands for at `now`. "N days ago" is exact
 * elapsed time; the day and month boundaries are local midnight, which is
 * what a person means by "today".
 */
export function datePresetValue(id: DatePresetId, now: Date): string {
  switch (id) {
    case 'now':
      return now.toISOString();
    case 'startOfToday':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case '7d':
      return new Date(now.getTime() - 7 * DAY_MS).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS).toISOString();
    case 'startOfMonth':
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
}

/** A `datetime-local` input's text (local time) as an ISO timestamp; `''` when it isn't a date. */
export function localInputToIso(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** An ISO timestamp as a `datetime-local` input's `YYYY-MM-DDTHH:mm`, local time; `''` when it isn't a date. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export type Chip = string | number | boolean | null;

function isChip(v: unknown): v is Chip {
  if (typeof v === 'number') {
    // An integer past 2^53 has already been rounded by `JSON.parse`; writing
    // it back from a chip would send the rounded number. The text input
    // keeps the digits the user typed.
    return !Number.isInteger(v) || Number.isSafeInteger(v);
  }
  return v === null || typeof v === 'string' || typeof v === 'boolean';
}

/**
 * The chips a `$in` / `$nin` / `$all` value of a `valType` row shows, or
 * `null` when the value holds something a chip can't show faithfully (a
 * sub-document, an EJSON sentinel, text that isn't a JSON array, anything but
 * text in a text-typed row), which keeps the text input. A text row reads
 * every typed chip as text, so its `1` or `null` would come back as `"1"` or
 * `"null"` after the next edit.
 */
export function chipsFromValue(value: string, valType: ValType): Chip[] | null {
  if (value.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  }
  // Stryker disable next-line BlockStatement: emptied, the catch leaves
  // `parsed` undefined, which the `Array.isArray` check below refuses the
  // same way — the early return only says so sooner.
  catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isChip)) return null;
  return TEXT_CHIP_TYPES.has(valType) && !parsed.every((el) => typeof el === 'string') ? null : parsed;
}

// Two digit runs that can't be re-split against each other: no super-linear
// backtracking on a long run of digits.
const NUMBER_TEXT = /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Row types whose list elements are text the row's type wraps on the wire
 * (`{$oid}`, `{$numberLong}`, …). Reading `007`, a 19-digit long or an
 * all-digit ObjectId as a JS number first would lose digits before the
 * wrapping ever saw them.
 */
const TEXT_CHIP_TYPES: ReadonlySet<ValType> = new Set<ValType>(['string', 'objectid', 'long', 'decimal', 'date']);

/**
 * What a typed chip means for a row of `valType`. In a text-typed row it is
 * the text itself. Elsewhere it is a number, `true` / `false` / `null`, or a
 * string. Quoting (`"42"`) asks for the string either way.
 */
export function parseChipText(t: string, valType: ValType): Chip {
  const s = t.trim();
  if (TEXT_CHIP_TYPES.has(valType)) return jsonString(s) ?? s;
  if (NUMBER_TEXT.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  return jsonString(s) ?? s;
}

/** `s` read as a JSON string literal, or `null` when it is any other text. */
function jsonString(s: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(s);
  }
  // Stryker disable next-line BlockStatement: emptied, the catch leaves `v`
  // undefined, which the `typeof` check below turns into the same `null`.
  catch {
    return null;
  }
  return typeof v === 'string' ? v : null;
}

/** A chip's label in a row of `valType`: quoted only when the bare text would read back as something else. */
export function chipText(el: Chip, valType: ValType): string {
  // String(-0) is '0', which reads back as +0: keep the sign the user typed.
  if (typeof el !== 'string') return Object.is(el, -0) ? '-0' : String(el);
  return parseChipText(el, valType) === el ? el : JSON.stringify(el);
}

export function valueFromChips(els: Chip[]): string {
  return JSON.stringify(els);
}

/** The `inferType` name of what a scalar `valType` sends; types with no single answer are absent. */
const INFER_TYPE_OF: Partial<Record<ValType, string>> = {
  string: 'string',
  number: 'number',
  long: 'long',
  decimal: 'decimal',
  boolean: 'boolean',
  date: 'date',
  objectid: 'objectid',
};

const NUMBER_FAMILY: ReadonlySet<string> = new Set(['number', 'long', 'decimal']);

/** The `inferType` of what a condition's value sends, or `null` where a type comparison means nothing. */
function sentType(cond: CondNode): string | null {
  if (SIMPLE_OPS.has(cond.op)) return INFER_TYPE_OF[cond.valType] ?? null;
  if (cond.op !== '$in' && cond.op !== '$nin') return null;
  const first = parseJsonArrayLenient(cond.value)
    .map((el) => coerceArrayElementWire(el, cond.valType))
    .find((el) => el !== null);
  return first === undefined ? null : inferType(first);
}

/**
 * W15 §14.7 — does a condition's value disagree with the type the sampled
 * documents hold for its field? Advisory: it never blocks printing.
 *
 * Silent wherever the comparison means nothing: an operator that doesn't
 * compare a value (`$exists`, `$type`, `$regex`, `$all`, …), a `null` /
 * `regex` / array value, a field the sample shows as an array (it matches by
 * element), and number against long or decimal (MongoDB compares them as
 * numbers).
 */
export function condTypeWarning(
  entriesByPath: ReadonlyMap<string, SchemaSampleEntry>,
  cond: CondNode,
): TypeWarning | null {
  const field = cond.field.trim();
  const actual = sentType(cond);
  if (field === '' || actual === null) return null;
  const warning = checkFieldType(entriesByPath, field, actual);
  if (!warning || warning.expectedType === 'array') return null;
  if (NUMBER_FAMILY.has(warning.expectedType) && NUMBER_FAMILY.has(actual)) return null;
  return warning;
}
