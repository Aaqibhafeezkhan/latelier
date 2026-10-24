import type { CollectionTabState, Stage } from '@shared/types';
import { compileFindOptions, findProblem, parseSortString } from './builder';
import { refusalMessage, repairToCanonicalEjson } from '../../utils/shellSyntax';
import { stagesToPipelineJson } from './Aggregation/pipeline';

/**
 * `$sort` takes only 1, -1 or `{ $meta }`, where a find sort also takes
 * "asc"/"desc"; those are rewritten to their number. A sort without one is
 * kept verbatim, and so is every other direction: the rewrite parses plain
 * JSON, so a `{"$numberLong": "-1"}` stays that text. Only runs past
 * `sortProblem`, so every string is a direction.
 */
function stageSort(sort: string): string {
  const parsed = JSON.parse(sort) as Record<string, unknown>;
  if (!Object.values(parsed).some((v) => typeof v === 'string')) return sort;
  const dirs = parseSortString(sort);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, typeof v === 'string' ? dirs[k] : v]),
    ),
  );
}

/** `{}` sorts nothing and projects everything in a find; `$sort` and `$project` refuse it. */
const isEmptyDoc = (text: string): boolean => Object.keys(JSON.parse(text) as object).length === 0;

/**
 * The first key anywhere in `node` that `name` recognises, as `name` words
 * it. An array walks like an object: its index keys never match.
 */
function firstKey(node: unknown, name: (k: string) => string | null): string | null {
  if (node === null || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    const found = name(k) ?? firstKey(v, name);
    if (found) return found;
  }
  return null;
}

/**
 * Find-only projection operators, which `$project` refuses: `$slice` (and a
 * find's `$slice` also keeps every other field, unlike the aggregation
 * expression), `$elemMatch`, or a positional `field.$`.
 */
function findOnlyProjection(k: string): string | null {
  if (k === '$slice' || k === '$elemMatch') return k;
  return k.endsWith('.$') ? `the positional "${k}"` : null;
}

/**
 * Filter operators a find runs but `$match` refuses ("not allowed in this
 * context"): `$where`, and `$near`/`$nearSphere`, which need `$geoNear` as
 * the first stage. Searched everywhere, `$and`/`$or`/`$nor` arrays included.
 */
const MATCH_FORBIDDEN = new Set(['$where', '$near', '$nearSphere']);
const matchForbidden = (k: string): string | null => (MATCH_FORBIDDEN.has(k) ? k : null);

export type StagesResult = { ok: true; stages: Stage[] } | { ok: false; problem: string };

/**
 * The builder's query as aggregation stages: `$match`, `$sort`, `$limit`,
 * `$project`, in the order the find applies them. Refused through the same
 * `findProblem` gate as Run and Copy code.
 *
 * Bodies are the builder's own text, never re-serialized, so a Long or an
 * ObjectId reaches the pipeline byte-for-byte; only a sort's direction words
 * are rewritten (`stageSort`). An empty sort or projection is omitted, like
 * an empty filter, and a find-only filter or projection operator refuses
 * the conversion rather than open a pipeline that cannot run. The limit is the user's cap
 * (`builder.limit`), not the page's: the page skip/limit is how the table
 * pages the result, not part of the query.
 */
export function builderToStages(state: CollectionTabState): StagesResult {
  const problem = findProblem(state);
  if (problem) return { ok: false, problem };
  const opts = compileFindOptions(state.builder);
  // The aggregate channel takes no collation or hint, and a pipeline that
  // dropped the collation would match a different set of documents.
  if (opts.collation || opts.hint) {
    return {
      ok: false,
      problem: `Open as pipeline does not carry the ${opts.collation ? 'collation' : 'hint'}. Clear it to open this query as a pipeline.`,
    };
  }
  const forbidden = firstKey(JSON.parse(state.queryRaw), matchForbidden);
  if (forbidden) {
    return {
      ok: false,
      problem: `The filter uses ${forbidden}, which a pipeline's $match does not allow. Remove it to open this query as a pipeline.`,
    };
  }
  const findOnly = opts.projection ? firstKey(JSON.parse(opts.projection), findOnlyProjection) : null;
  if (findOnly) {
    return {
      ok: false,
      problem: `The projection uses ${findOnly}, which only a find supports. Remove it to open this query as a pipeline.`,
    };
  }
  const bodies: [string, string][] = [];
  if (state.queryRaw.trim() !== '{}') bodies.push(['$match', state.queryRaw]);
  if (opts.sort && !isEmptyDoc(opts.sort)) bodies.push(['$sort', stageSort(opts.sort)]);
  if (opts.limit !== null) bodies.push(['$limit', String(opts.limit)]);
  if (opts.projection && !isEmptyDoc(opts.projection)) bodies.push(['$project', opts.projection]);
  return {
    ok: true,
    stages: bodies.map(([op, body], i) => ({ id: i + 1, op, body, enabled: true })),
  };
}

export type PipelineJsonResult = { ok: true; json: string } | { ok: false; problem: string };

/**
 * The enabled stages as one Canonical EJSON array, for copying. A stage body
 * may be Shell Syntax (`{ status: "open" }`), so each enabled one is repaired
 * first; the first that cannot be is refused by its 1-based stage number, the
 * numbering `stagesToPipelineJson` uses for a body that repairs but does not
 * parse.
 */
export function pipelineJsonForCopy(stages: Stage[]): PipelineJsonResult {
  const repaired: Stage[] = [];
  for (const [i, s] of stages.entries()) {
    if (!s.enabled) {
      repaired.push(s);
      continue;
    }
    const outcome = repairToCanonicalEjson(s.body);
    if (outcome.kind === 'failed') {
      return { ok: false, problem: `stage ${i + 1} (${s.op}): ${refusalMessage(s.body, outcome) ?? outcome.reason}` };
    }
    repaired.push(outcome.kind === 'repaired' ? { ...s, body: outcome.text } : s);
  }
  try {
    return { ok: true, json: stagesToPipelineJson(repaired) };
  } catch (e) {
    return { ok: false, problem: (e as Error).message };
  }
}
