import type { FieldSource, OperatorSuggestion } from '../types';
import { FIELD_POSITION_OPS, OPERATORS } from '../operators';

/**
 * Static operator-name source. Sync, pure; returns every catalog entry wrapped
 * as an `OperatorSuggestion`. Context-aware filtering/downranking is applied
 * later when `ctx.operatorContext` is set (Phase B).
 */

// The no-context output is a pure function of the (frozen) catalog, so cache
// it. Typing autocomplete probes this source on every keystroke — re-
// allocating 200+ suggestion objects each time is wasted work.
const BASE_SUGGESTIONS: readonly OperatorSuggestion[] = OPERATORS.map((op) => ({
  kind: 'operator' as const,
  name: op.name,
  class: op.class,
  summary: op.summary,
  label: op.label,
  symbol: op.symbol,
  description: op.description,
  syntax: op.syntax,
  example: op.example,
  url: op.url,
  source: 'operators',
  offContext: false,
}));

export const operatorSource: FieldSource = (ctx) => {
  const wanted = ctx.operatorContext;
  if (!wanted) return BASE_SUGGESTIONS.slice();
  const out: OperatorSuggestion[] = [];
  for (let i = 0; i < OPERATORS.length; i++) {
    const op = OPERATORS[i]!;
    const base = BASE_SUGGESTIONS[i]!;
    const offContext = !!op.validIn && !op.validIn.includes(wanted);
    out.push(offContext ? { ...base, offContext: true } : base);
  }
  return out;
};

// Every FIELD_POSITION_OPS name is tagged validIn: matchKey (see operators.ts),
// so this filter alone is sufficient — nothing here needs offContext ranking.
// The catalog also carries an aggregation-expression twin of ten of these names
// (`$eq`, `$gt`, `$size`, ...): a different operator that is only valid inside
// `$expr`. Matching on the name alone would list each of those twice, so the
// expression class is left out; every name still has its query-position entry.
const FIELD_POSITION_SUGGESTIONS: readonly OperatorSuggestion[] = BASE_SUGGESTIONS.filter(
  (s) => FIELD_POSITION_OPS.has(s.name) && s.class !== 'expression',
);

/**
 * Operator source strictly filtered to names valid at a field's own operator
 * position (`{ field: { $op: value } }`). Unlike `operatorSource`'s
 * off-context downranking, out-of-list operators never appear at all — the
 * Query Builder's op box is always in this exact position, so there is no
 * "off-context but still relevant" case to preserve.
 */
export const fieldOperatorSource: FieldSource = () => FIELD_POSITION_SUGGESTIONS.slice();
