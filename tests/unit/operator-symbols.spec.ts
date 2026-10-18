// ADR 0004's "Scope note: symbolic operators in the Query Builder".
//
// The resolver is pure text-in / operator-out, so everything except the blur
// timing is testable here. The blur timing — and the popover race it creates —
// is in `tests/component/builder-operator-symbols.spec.tsx`.
import { describe, it, expect } from 'vitest';
import { OPERATORS, resolveOperatorSymbol } from '../../src/features/fieldSuggestions/operators';
import { isCompilableOp } from '../../src/pages/Workspace/filterTree';
import { operatorSource } from '../../src/features/fieldSuggestions/sources/operatorSource';

/**
 * The query-catalog entry for a name. Not `class === 'query'`: `$type` is
 * `element` and `$mod` is `evaluation`. The query entries are the ones tagged
 * for the match-key context alone; an expression entry carries four contexts.
 */
function queryOp(name: string) {
  return OPERATORS.find(
    (op) => op.name === name && op.validIn?.length === 1 && op.validIn[0] === 'matchKey',
  );
}

describe('resolveOperatorSymbol', () => {
  it.each([
    ['=', '$eq'],
    ['==', '$eq'],
    ['!=', '$ne'],
    ['<>', '$ne'],
    ['≠', '$ne'],
    ['>', '$gt'],
    ['>=', '$gte'],
    ['≥', '$gte'],
    ['<', '$lt'],
    ['<=', '$lte'],
    ['≤', '$lte'],
  ])('resolves %s to %s', (symbol, op) => {
    expect(resolveOperatorSymbol(symbol)).toBe(op);
  });

  it('resolves both halves of a prefix pair, so blur timing is the only guard', () => {
    // `>` is a prefix of `>=`. Both are real entries, which is exactly why the
    // caller cannot resolve per keystroke: a keystroke map would fire on `>`
    // and the user would never reach the `=`.
    expect(resolveOperatorSymbol('>')).toBe('$gt');
    expect(resolveOperatorSymbol('>=')).toBe('$gte');
  });

  it('returns null for an operator, so re-running it over a resolved value is a no-op', () => {
    for (const name of ['$gt', '$gte', '$in', '$group']) {
      expect(resolveOperatorSymbol(name)).toBeNull();
    }
  });

  it('returns null for anything it does not know, rather than guessing', () => {
    for (const text of ['', '   ', '>>', '=>', 'gt', '$', '~=']) {
      expect(resolveOperatorSymbol(text)).toBeNull();
    }
  });

  it('trims, because a paste carries whitespace', () => {
    expect(resolveOperatorSymbol('  >=  ')).toBe('$gte');
  });

  it('matches exactly — a symbol with anything appended is not that symbol', () => {
    expect(resolveOperatorSymbol('>x')).toBeNull();
    expect(resolveOperatorSymbol('a>')).toBeNull();
  });
});

describe('operator labels and symbols in the catalog', () => {
  it('gives a query operator its symbol and English name', () => {
    expect(queryOp('$gt')).toMatchObject({ symbol: '>', label: 'greater than' });
    expect(queryOp('$gte')).toMatchObject({ symbol: '>=', label: 'greater than or equal to' });
  });

  it('labels an operator that has no natural symbol, and gives it no symbol', () => {
    const inOp = queryOp('$in');
    expect(inOp?.label).toBe('is one of');
    expect(inOp?.symbol).toBeUndefined();
  });

  it('leaves a stage alone — a pipeline is written in real operator names', () => {
    const group = OPERATORS.find((op) => op.name === '$group' && op.class === 'stage');
    expect(group?.label).toBeUndefined();
    expect(group?.symbol).toBeUndefined();
  });

  it('labels the query $type and not the expression $type', () => {
    // The same name exists in two classes. The label rides on the query entry
    // only, which is the whole "query context only" rule falling out of where
    // the table is applied rather than out of a runtime check.
    expect(queryOp('$type')?.label).toBe('has BSON type');
    const expressionType = OPERATORS.find(
      (op) => op.name === '$type' && op.class === 'expression',
    );
    expect(expressionType).toBeDefined();
    expect(expressionType?.label).toBeUndefined();
  });

  it('only names operators the builder can actually compile', () => {
    // A label makes an operator easier to reach. Reaching one the row would
    // immediately flag as needing a raw clause is not a kindness.
    for (const op of OPERATORS) {
      if (op.label) expect(isCompilableOp(op.name)).toBe(true);
    }
  });

  it('every symbol belongs to exactly one operator', () => {
    const seen = new Map<string, string>();
    for (const op of OPERATORS) {
      if (!op.symbol) continue;
      expect(seen.has(op.symbol)).toBe(false);
      seen.set(op.symbol, op.name);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('carries both fields through to the suggestion the popover renders', () => {
    const items = operatorSource({ connectionId: 'c1', dbName: 'db', collection: 'coll' }) as Array<{
      name: string;
      label?: string;
      symbol?: string;
    }>;
    const gt = items.find((s) => s.name === '$gt' && s.symbol === '>');
    expect(gt?.label).toBe('greater than');
  });
});
