import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { FieldSuggestion, ValueSuggestion } from '../../src/features/fieldSuggestions/types';
import { stageBodyCompletionSource } from '../../src/components/scriptEditor/stageBodyCompletions';

// `stageBodyCompletionSource` composes `DEFAULT_FIELD_SOURCES` (lastRun +
// sampleSchema) with `operatorSource` — the same `KEY_POSITION_SOURCES` mix
// `useTextareaAutocomplete` used, so the ranking the textarea had is
// preserved. Swap `DEFAULT_FIELD_SOURCES` for a single deterministic fake so
// the field-completion assertions don't depend on the (network-backed)
// `sampleSchemaSource`; keep the real `operatorSource` + `OPERATORS` catalog
// so the operator-context assertions exercise real `validIn` data.
const { fakeFieldSource, valuesA, valuesB } = vi.hoisted(() => ({
  fakeFieldSource: vi.fn(
    async (): Promise<FieldSuggestion[]> => [
      { kind: 'field' as const, path: 'name', source: 'fake', frequency: 5 },
      { kind: 'field' as const, path: 'age', source: 'fake', frequency: 1 },
    ],
  ),
  // Two value sources, one sync and one async, so the merge across sources
  // and the mix of both kinds are exercised.
  valuesA: vi.fn<(ctx: unknown) => ValueSuggestion[]>(() => []),
  valuesB: vi.fn<(ctx: unknown) => Promise<ValueSuggestion[]>>(async () => []),
}));

vi.mock('../../src/features/fieldSuggestions/sources', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/features/fieldSuggestions/sources')>();
  return {
    ...actual,
    DEFAULT_FIELD_SOURCES: [fakeFieldSource],
    DEFAULT_VALUE_SOURCES: [valuesA, valuesB],
  };
});

/**
 * The source only reads `state.doc` and `pos` off CompletionContext — build
 * the smallest stub that satisfies that surface (mirrors the fakeCtx used in
 * script-mongo-completions.spec.ts, minus `matchBefore`, which this source
 * never calls).
 */
function fakeCtx(doc: string, cursor: string = '█'): CompletionContext {
  const pos = doc.indexOf(cursor);
  if (pos < 0) throw new Error(`cursor token ${cursor} not found in doc`);
  const stripped = doc.slice(0, pos) + doc.slice(pos + cursor.length);
  return {
    pos,
    state: { doc: { toString: () => stripped } },
  } as unknown as CompletionContext;
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((o) => o.label) ?? [];
}

function boostOf(result: CompletionResult | null, label: string): number | undefined {
  return result?.options.find((o) => o.label === label)?.boost;
}

describe('stageBodyCompletionSource', () => {
  it('returns field completions from the sampled schema source at a field-key position', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;

    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age']));
    expect(result!.from).toBe('{ '.length);
    expect(result!.to).toBe('{ '.length);
  });

  it('ranks a match-only operator ahead of a group-only accumulator for a $match stage', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;

    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['$exists', '$sum']));
    // $exists is valid only at `matchKey`; $sum is a `$group`-only
    // accumulator — it should rank behind $exists once the caret's
    // operatorContext is 'matchKey'.
    expect(boostOf(result, '$exists')!).toBeGreaterThan(boostOf(result, '$sum')!);
  });

  it('flips the ranking for a $group accumulator-value position', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$group',
    });

    // Depth 2 ("total: { █ }") is the accumulator-value slot inside $group,
    // which `detectAggGrammar` tags with the `groupValue` operator context.
    const result = (await source(
      fakeCtx('{ _id: null, total: { █ } }'),
    )) as CompletionResult | null;

    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['$exists', '$sum']));
    expect(boostOf(result, '$sum')!).toBeGreaterThan(boostOf(result, '$exists')!);
  });

  it('returns null when there is no field-key grammar hit (caret in a value slot)', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = await source(fakeCtx('{ name: █ }'));
    expect(result).toBeNull();
  });

  it('returns null when there is no active connection/db context', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => null,
      getStageOp: () => '$match',
    });

    const result = await source(fakeCtx('{ █ }'));
    expect(result).toBeNull();
  });

  it('returns null on a fieldRef grammar hit ($-prefixed string value)', async () => {
    // `detectAggGrammar` returns a truthy hit here (kind: 'fieldRef', not
    // 'fieldName') — distinct from the "no hit at all" case above. Only the
    // `hit.kind !== 'fieldName'` half of the guard rejects it.
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = await source(fakeCtx('{ status: "$█" }'));
    expect(result).toBeNull();
  });

  it('uses the quote-safe validFor when completing an already-quoted key', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ "na█" }'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.validFor).toEqual(/^[^"'\n]*$/);
  });

  it('uses the bare-identifier validFor when completing an unquoted key', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.validFor).toEqual(/^[\w$.]*$/);
  });
});

function value(display: string, extra: Partial<ValueSuggestion> = {}): ValueSuggestion {
  return { kind: 'value', value: display, display, source: 'fake', ...extra };
}

describe('stageBodyCompletionSource — values in a $match body', () => {
  const ctxFor = (stageOp: string) =>
    stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => stageOp,
    });

  beforeEach(() => {
    valuesA.mockReset().mockReturnValue([]);
    valuesB.mockReset().mockResolvedValue([]);
  });

  it('offers the values of the field inside a string in a $match stage', async () => {
    valuesA.mockReturnValue([value('paid', { type: 'string', frequency: 2 })]);
    valuesB.mockResolvedValue([value('pending')]);

    const result = (await ctxFor('$match')(fakeCtx('{ status: "p█" }'))) as CompletionResult | null;

    expect(result).toEqual({
      from: '{ status: "'.length,
      to: '{ status: "p'.length,
      options: [
        { label: 'paid', type: 'text', boost: 2 / 50 },
        { label: 'pending', type: 'text', boost: 0 },
      ],
      validFor: /^[^"'\n]*$/,
    });
    expect(valuesA).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'db',
      collection: 'users',
      target: { field: 'status', operator: undefined },
    });
  });

  it('replaces the whole value when the caret is in the middle of it', async () => {
    valuesA.mockReturnValue([value('paid')]);
    const doc = '{ status: "p█ending" }';
    const result = (await ctxFor('$match')(fakeCtx(doc))) as CompletionResult | null;
    expect(result?.from).toBe('{ status: "'.length);
    expect(result?.to).toBe('{ status: "pending'.length);
  });

  it('runs the replacement past escaped quotes to the closing one', async () => {
    valuesA.mockReturnValue([value('paid')]);
    const result = (await ctxFor('$match')(fakeCtx('{ s: "a█b\\"c\\\\" }'))) as CompletionResult | null;
    // a b \" c \\ then the closing quote
    expect(result?.to).toBe('{ s: "ab\\"c\\\\'.length);
  });

  it('stops the replacement at the line end when the string is not closed', async () => {
    valuesA.mockReturnValue([value('paid')]);
    const result = (await ctxFor('$match')(fakeCtx('{ s: "ab█cd\n, t: 1 }'))) as CompletionResult | null;
    expect(result?.to).toBe('{ s: "abcd'.length);
    const crlf = (await ctxFor('$match')(fakeCtx('{ s: "ab█cd\r\n}'))) as CompletionResult | null;
    expect(crlf?.to).toBe('{ s: "abcd'.length);
  });

  it('stops the replacement at the end of the text when nothing closes the string', async () => {
    valuesA.mockReturnValue([value('paid')]);
    const result = (await ctxFor('$match')(fakeCtx('{ s: "ab█cd'))) as CompletionResult | null;
    expect(result?.to).toBe('{ s: "abcd'.length);
    const trailing = (await ctxFor('$match')(fakeCtx('{ s: "ab█c\\'))) as CompletionResult | null;
    expect(trailing?.to).toBe('{ s: "abc\\'.length);
  });

  it("closes a single-quoted value at its own quote, not at a double quote", async () => {
    valuesA.mockReturnValue([value('paid')]);
    const result = (await ctxFor('$match')(fakeCtx("{ s: 'a█b\"c' }"))) as CompletionResult | null;
    expect(result?.to).toBe("{ s: 'ab\"c".length);
  });

  it('asks for the parent field, with the operator, inside an operator object', async () => {
    valuesA.mockReturnValue([value('x')]);
    await ctxFor('$match')(fakeCtx('{ status: { $ne: "█" } }'));
    expect(valuesA).toHaveBeenCalledWith(
      expect.objectContaining({ target: { field: 'status', operator: '$ne' } }),
    );
  });

  it('merges one value offered by several sources, summing its frequency', async () => {
    valuesA.mockReturnValue([value('paid', { frequency: 20 })]);
    valuesB.mockResolvedValue([value('paid', { frequency: 40 }), value('void')]);

    const result = (await ctxFor('$match')(fakeCtx('{ status: "█" }'))) as CompletionResult | null;

    expect(result?.options).toEqual([
      { label: 'paid', type: 'text', boost: 1 },
      { label: 'void', type: 'text', boost: 0 },
    ]);
  });

  it('leaves out non-string values, which would turn into strings inside the quotes', async () => {
    valuesA.mockReturnValue([
      value('42', { type: 'number' }),
      value('true', { type: 'boolean' }),
      value('507f1f77bcf86cd799439011', { type: 'objectid' }),
      value('kept', { type: 'string' }),
      value('untyped'),
    ]);

    const result = (await ctxFor('$match')(fakeCtx('{ status: "█" }'))) as CompletionResult | null;

    expect(result?.options.map((o) => o.label)).toEqual(['kept', 'untyped']);
  });

  it('leaves out values that would break the string literal', async () => {
    valuesA.mockReturnValue([
      value('say "hi"'),
      value("it's"),
      value('back\\slash'),
      value('two\nlines'),
      value('cr\rhere'),
      value('fine'),
    ]);

    const result = (await ctxFor('$match')(fakeCtx('{ status: "█" }'))) as CompletionResult | null;

    expect(result?.options.map((o) => o.label)).toEqual(['fine']);
  });

  it('returns null when no source has a value', async () => {
    expect(await ctxFor('$match')(fakeCtx('{ status: "█" }'))).toBeNull();
    expect(valuesA).toHaveBeenCalledTimes(1);
  });

  it.each(['$group', '$project', '$set'])('offers no values in a %s stage', async (op) => {
    valuesA.mockReturnValue([value('paid')]);
    expect(await ctxFor(op)(fakeCtx('{ status: "█" }'))).toBeNull();
    expect(valuesA).not.toHaveBeenCalled();
  });

  it.each([
    '{ a: { $regex: "█" } }',
    '{ a: { $type: "█" } }',
    '{ a: { $regex: "^x", $options: "█" } }',
  ])('offers no values after an operator the builder does not suggest for: %s', async (doc) => {
    valuesA.mockReturnValue([value('paid')]);
    expect(await ctxFor('$match')(fakeCtx(doc))).toBeNull();
    expect(valuesA).not.toHaveBeenCalled();
  });

  it.each(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'])('offers values after %s', async (op) => {
    valuesA.mockReturnValue([value('paid')]);
    const result = (await ctxFor('$match')(fakeCtx(`{ a: { ${op}: "█" } }`))) as CompletionResult | null;
    expect(result?.options.map((o) => o.label)).toEqual(['paid']);
  });

  it('offers no values for a string under operator keys only', async () => {
    valuesA.mockReturnValue([value('paid')]);
    expect(await ctxFor('$match')(fakeCtx('{ $expr: { $eq: "█" } }'))).toBeNull();
    expect(valuesA).not.toHaveBeenCalled();
  });
});
