/**
 * The ceilings a Find runs under, worded for the person reading the Query
 * bar. The main process enforces them (`QUERY_TIMEOUT_MS` in
 * `electron/mongo/timeouts.ts`, `DEFAULT_MAX_EJSON_BYTES` in
 * `electron/mongo/ejson.ts`); `tests/unit/query-caps.spec.ts` pins these to
 * the same numbers, so the sentence can't drift from what actually stops a
 * query.
 */
export const QUERY_CAPS = { timeoutSeconds: 30, maxResultMb: 50 } as const;

export const LIMIT_EXPLANATION = `Total across all pages. Queries stop after ${QUERY_CAPS.timeoutSeconds} s; results over ${QUERY_CAPS.maxResultMb} MB are refused.`;

/** "limit N" for a limit that is really applied, `null` when the query has none. */
export function limitChipText(limit: number | null): string | null {
  return limit === null ? null : `limit ${limit}`;
}
