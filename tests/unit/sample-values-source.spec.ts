import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sampleSchema } = vi.hoisted(() => ({
  sampleSchema: vi.fn<(input: unknown) => Promise<{ docs: unknown[] }>>(),
}));

vi.mock('../../src/api/atelier', () => ({ api: { meta: { sampleSchema } } }));

import { sampleValuesSource } from '../../src/features/fieldSuggestions/sources/sampleValuesSource';
import {
  invalidateSampleSchemaCache,
  sampleSchemaSource,
} from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';

const ctx = { connectionId: 'c1', dbName: 'db', collection: 'orders' };

function ask(field: string) {
  return sampleValuesSource({ ...ctx, target: { field } });
}

function docsWith(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ status: `s${i}` }));
}

beforeEach(() => {
  invalidateSampleSchemaCache();
  sampleSchema.mockReset();
});

describe('sampleValuesSource', () => {
  it('suggests the values of a low-cardinality field from the sample, counted', async () => {
    sampleSchema.mockResolvedValue({
      docs: [{ status: 'paid' }, { status: 'paid' }, { status: 'pending' }, { other: 1 }],
    });
    expect(await ask('status')).toEqual([
      { kind: 'value', value: 'paid', display: 'paid', type: 'string', source: 'sample', frequency: 2 },
      { kind: 'value', value: 'pending', display: 'pending', type: 'string', source: 'sample', frequency: 1 },
    ]);
  });

  it('suggests a field with exactly 20 distinct values', async () => {
    sampleSchema.mockResolvedValue({ docs: docsWith(20) });
    expect(await ask('status')).toHaveLength(20);
  });

  it('suggests nothing for a field with 21 distinct values', async () => {
    sampleSchema.mockResolvedValue({ docs: docsWith(21) });
    expect(await ask('status')).toEqual([]);
  });

  it('reads every doc in the sample, not only the first 50', async () => {
    const docs = [...Array.from({ length: 60 }, () => ({ status: 'a' })), { status: 'late' }];
    sampleSchema.mockResolvedValue({ docs });
    expect((await ask('status')).map((s) => s.display)).toEqual(['a', 'late']);
  });

  it('suggests nothing for a blank field, without a fetch', async () => {
    expect(await ask(' ')).toEqual([]);
    expect(sampleSchema).not.toHaveBeenCalled();
  });

  it('shares one sample fetch with the field-name source', async () => {
    sampleSchema.mockResolvedValue({ docs: [{ status: 'paid' }] });
    const [fields, values] = await Promise.all([sampleSchemaSource(ctx), ask('status')]);
    expect(fields.map((f) => (f.kind === 'field' ? f.path : f.name))).toEqual(['status']);
    expect(values.map((v) => v.display)).toEqual(['paid']);
    await ask('status');
    expect(sampleSchema).toHaveBeenCalledTimes(1);
  });

  it.each(['token', 'password', 'secret', 'auth.ApiKey'])(
    'never suggests sampled values of the secret-named field %s',
    async (field) => {
      sampleSchema.mockResolvedValue({
        docs: [{ token: 't1', password: 'p1', secret: 's1', auth: { ApiKey: 'k1' } }],
      });
      expect(await ask(field)).toEqual([]);
    },
  );

  it('fails open to [] when the sample fetch rejects', async () => {
    sampleSchema.mockRejectedValue(new Error('down'));
    expect(await ask('status')).toEqual([]);
    expect(sampleSchema).toHaveBeenCalledTimes(1);
  });
});
