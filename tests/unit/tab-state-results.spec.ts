import { describe, it, expect } from 'vitest';
import { serializeTabState, stripResultFields } from '../../electron/services/tabStateResults';

describe('stripResultFields', () => {
  it('removes lastRun, lastResult, lastError and aggregation.lastRun, keeping everything else', () => {
    const out = stripResultFields({
      queryRaw: '{}',
      lastRunHasMore: true,
      totalCount: 7,
      lastRun: { documents: [1] },
      lastResult: { value: 1 },
      lastError: { code: 'X' },
      schema: { entries: [{ path: 'a' }] },
      aggregation: { stages: [1], dirty: true, lastRun: { rows: [1] } },
    });
    expect(out).toEqual({
      queryRaw: '{}',
      lastRunHasMore: true,
      totalCount: 7,
      schema: { entries: [{ path: 'a' }] },
      aggregation: { stages: [1], dirty: true },
    });
  });

  it('does not mutate its input, including the nested aggregation object', () => {
    const agg = { stages: [1], lastRun: { rows: [1] } };
    const input = { lastRun: { documents: [1] }, aggregation: agg };
    stripResultFields(input);
    expect(input.lastRun).toEqual({ documents: [1] });
    expect(input.aggregation).toBe(agg);
    expect(agg.lastRun).toEqual({ rows: [1] });
  });

  it('leaves a non-object aggregation value untouched', () => {
    expect(stripResultFields({ aggregation: 'x' })).toEqual({ aggregation: 'x' });
    expect(stripResultFields({ aggregation: null })).toEqual({ aggregation: null });
    expect(stripResultFields({ aggregation: [{ lastRun: 1 }] })).toEqual({
      aggregation: [{ lastRun: 1 }],
    });
  });

  it('keeps an aggregation object that has no lastRun as the same reference', () => {
    const agg = { stages: [] };
    expect(stripResultFields({ aggregation: agg }).aggregation).toBe(agg);
  });

  it('is idempotent', () => {
    const once = stripResultFields({ lastRun: 1, aggregation: { lastRun: 2, k: 3 } });
    expect(stripResultFields(once)).toEqual(once);
  });
});

describe('stripResultFields — numeric stats of secret-named schema paths', () => {
  const numeric = { min: 1, max: 9, avg: 4.5 };
  const schemaOf = (paths: string[]) => ({
    sampleSize: 100,
    entries: paths.map((path) => ({ path, frequency: 1, types: { number: 3 }, distinct: 3, numeric })),
  });

  it('drops numeric from a secret-named path and keeps it on a plain one', () => {
    const out = stripResultFields({ schema: schemaOf(['pwd', 'password', 'price']) });
    const entries = (out.schema as ReturnType<typeof schemaOf>).entries;
    expect(entries.find((e) => e.path === 'pwd')).not.toHaveProperty('numeric');
    expect(entries.find((e) => e.path === 'password')).not.toHaveProperty('numeric');
    expect(entries.find((e) => e.path === 'price')?.numeric).toEqual(numeric);
  });

  it('keeps the rest of a secret-named entry, including its distinct count', () => {
    const out = stripResultFields({ schema: schemaOf(['pwd']) });
    expect((out.schema as ReturnType<typeof schemaOf>).entries[0]).toEqual({
      path: 'pwd',
      frequency: 1,
      types: { number: 3 },
      distinct: 3,
    });
  });

  it('matches a secret segment anywhere in a dotted path', () => {
    const out = stripResultFields({ schema: schemaOf(['user.Token.value', 'tokens']) });
    const entries = (out.schema as ReturnType<typeof schemaOf>).entries;
    expect(entries[0]).not.toHaveProperty('numeric');
    expect(entries[1]?.numeric).toEqual(numeric);
  });

  it('does not mutate its input', () => {
    const input = { schema: schemaOf(['pwd']) };
    stripResultFields(input);
    expect(input.schema.entries[0]?.numeric).toEqual(numeric);
  });

  it('leaves the schema reference alone when nothing needed stripping', () => {
    const schema = schemaOf(['price']);
    expect(stripResultFields({ schema }).schema).toBe(schema);
  });

  it.each([
    ['no entries', { sampleSize: 50 }],
    ['entries that is not an array', { entries: 'x' }],
  ])('passes a schema with %s through', (_what, schema) => {
    expect(stripResultFields({ schema }).schema).toEqual(schema);
  });

  it('passes a non-object schema and malformed entries through', () => {
    expect(stripResultFields({ schema: null })).toEqual({ schema: null });
    const schema = { entries: [null, 'x', { frequency: 1, numeric }, { path: 7, numeric }] };
    expect(stripResultFields({ schema }).schema).toEqual(schema);
  });

  it('is idempotent', () => {
    const once = stripResultFields({ schema: schemaOf(['pwd', 'price']) });
    expect(stripResultFields(once)).toEqual(once);
  });
});

describe('serializeTabState', () => {
  it('serializes the stripped state', () => {
    const json = serializeTabState({ page: 1, lastRun: { documents: [{ a: 1 }] } });
    expect(JSON.parse(json)).toEqual({ page: 1 });
    expect(json).not.toContain('documents');
  });
});
