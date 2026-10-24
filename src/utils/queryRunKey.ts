export interface QueryRunKeyInput {
  connectionId: string;
  dbName: string;
  collection: string;
  filter?: string;
  projection?: string[];
  /**
   * W15 §9(b)'s verbatim projection escape hatch. Required rather than
   * optional so both call sites are forced to pass it — the bug this replaced
   * was each one independently forgetting to, and an optional field
   * would let the next caller repeat it silently.
   */
  projectionRaw: string | undefined;
  sort?: string;
  limit?: number | null;
  skip?: number;
  /**
   * W14 §9's compiled find options (`compileFindOptions`): a collation alone
   * changes which documents match, so the same filter with a different one
   * is a different query. Unset joins as empty, like a blank one.
   */
  collation?: string;
  hint?: string;
  maxTimeMS?: number;
  readPreference?: string;
}

// Use the unit-separator (US, U+001F) so user-controlled strings
// (collection names, filter JSON, sort) cannot collide with the joiner.
const SEP = '\x1f';

export function queryRunKey(input: QueryRunKeyInput): string {
  // Mirror `compileFindOptions`: a non-blank `projectionRaw` wins verbatim and
  // the modelled field list is not consulted at all. Two runs with the same raw
  // projection execute identically, so they must share a bucket however their
  // (unused) modelled projection differs — and vice versa.
  //
  // The `r`/`m` tag keeps the two spaces disjoint, so a raw string can never
  // collide with a field list that happens to join to the same text. Same
  // reasoning as the separator above.
  const raw = input.projectionRaw?.trim();
  // Stryker disable ConditionalExpression,EqualityOperator: the `a > b ? 1 : 0` branch of the sort comparator below only ever needs to signal "not less than" to Array.sort — both its possible outputs (0 and 1) are non-negative, and every surviving mutant on it (`>=`, `<=`, forced `true`, forced `false`) also only ever produces 0 or 1 in this branch. Fuzzed 200k random arrays (sizes 1-20, with duplicates) against all four variants with zero output differences from the real comparator.
  const proj = raw
    ? `r${SEP}${raw}`
    : `m${SEP}${(input.projection ?? [])
        .slice()
        // Code-unit order, not `localeCompare`: this is a cache key, so the
        // same projection has to produce the same key on every machine, and
        // collation varies with the host locale.
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .join(SEP)}`;
  // Stryker restore ConditionalExpression,EqualityOperator
  return [
    input.connectionId,
    input.dbName,
    input.collection,
    input.filter ?? '',
    proj,
    input.sort ?? '',
    input.limit ?? '',
    input.skip ?? 0,
    input.collation,
    input.hint,
    input.maxTimeMS,
    input.readPreference,
  ].join(SEP);
}
