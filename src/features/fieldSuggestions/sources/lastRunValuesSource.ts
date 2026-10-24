import { toDisplayValue, type DisplayType } from '../../../utils/displayValue';
import { isSecretFieldPath } from '../../../utils/secretFieldPath';
import type { ValueSource, ValueSuggestion } from '../types';

const MAX_DOCS = 50;

/**
 * Dotted-path lookup that only descends through plain objects, mirroring
 * `lastRunSource`'s walk. Own properties only: `{constructor: "…"}` must not
 * read `Object.prototype.constructor` and suggest its source text.
 */
function readPath(doc: unknown, segments: string[]): unknown {
  let cur: unknown = doc;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The distinct scalar values `field` holds across `docs`, each with how many
 * times it appeared and its display type. Arrays at the leaf expand into one
 * entry per element rather than one `[n]` entry, since that's what a person
 * typing into an `$in`/`$eq` box actually wants to pick from. Shared by the
 * current-results source below and the sampled-docs source.
 */
export function distinctValuesAt(
  docs: readonly unknown[],
  field: string,
  maxDocs = docs.length,
): Array<Omit<ValueSuggestion, 'source'>> {
  const segments = field.split('.');
  const counts = new Map<string, { type: DisplayType; frequency: number }>();
  for (const doc of docs.slice(0, maxDocs)) {
    const leaf = readPath(doc, segments);
    if (leaf === undefined) continue;
    const values = Array.isArray(leaf) ? leaf : [leaf];
    for (const v of values) {
      const dv = toDisplayValue(v);
      // Objects, arrays-of-arrays and undefined have no single scalar text a
      // cond's `value` field could hold — skip rather than suggest garbage.
      if (dv.type === 'object' || dv.type === 'array' || dv.type === 'undefined') continue;
      const seen = counts.get(dv.display);
      if (seen) seen.frequency++;
      else counts.set(dv.display, { type: dv.type, frequency: 1 });
    }
  }
  const out: Array<Omit<ValueSuggestion, 'source'>> = [];
  for (const [display, { type, frequency }] of counts) {
    out.push({ kind: 'value', value: display, display, type, frequency });
  }
  return out;
}

/**
 * Values a field actually held in the current results (Source 1, X02
 * "Value suggestions"). `value === display`: every suggestion is a plain
 * string, since `CondRow`'s pick just writes `s.display` into the cond's
 * text `value` field — there's no separate wire encoding to carry here, only
 * the human-readable form.
 */
export const lastRunValuesSource: ValueSource = (ctx) => {
  const docs = ctx.recentDocs;
  const field = ctx.target.field.trim();
  // A secret-named field never offers its values, here or in any source.
  if (!docs || docs.length === 0 || !field || isSecretFieldPath(field)) return [];
  return distinctValuesAt(docs, field, MAX_DOCS).map((s) => ({ ...s, source: 'lastRun' }));
};
