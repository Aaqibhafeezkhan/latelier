/**
 * Result-bearing fields of a tab's `state_json`. They hold real documents from
 * the user's databases, so they live in renderer memory only and are removed
 * before any write to SQLite.
 */

import { isSecretFieldPath } from '../log.ts';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns a copy of `state` without `lastRun`, `aggregation.lastRun`,
 * `lastResult` and `lastError`. Everything else (including `lastRunHasMore`
 * and `totalCount`) is kept. Never mutates its input.
 *
 * `schema.entries[].numeric` (min/max/avg) is also dropped for a secret-named
 * field path: min and max are literal values from single documents, so they
 * are results in all but name, and `isSecretFieldPath` is the repo's rule for
 * which paths hold secrets. The renderer cannot import it, so main enforces it
 * here, on the way to SQLite.
 */
export function stripResultFields(state: Record<string, unknown>): Record<string, unknown> {
  const out = { ...state };
  delete out.lastRun;
  delete out.lastResult;
  delete out.lastError;
  const agg = out.aggregation;
  if (isPlainObject(agg) && 'lastRun' in agg) {
    const aggCopy = { ...agg };
    delete aggCopy.lastRun;
    out.aggregation = aggCopy;
  }
  const schema = out.schema;
  const list: unknown = isPlainObject(schema) ? schema.entries : undefined;
  if (isPlainObject(schema) && Array.isArray(list)) {
    const entries = list.map(dropSecretNumeric);
    if (entries.some((e, i) => e !== list[i])) out.schema = { ...schema, entries };
  }
  return out;
}

function dropSecretNumeric(entry: unknown): unknown {
  if (!isPlainObject(entry) || typeof entry.path !== 'string') return entry;
  if (!('numeric' in entry) || !isSecretFieldPath(entry.path)) return entry;
  const copy = { ...entry };
  delete copy.numeric;
  return copy;
}

/** Single serialization point for every `state_json` write. */
export function serializeTabState(state: Record<string, unknown>): string {
  return JSON.stringify(stripResultFields(state));
}
