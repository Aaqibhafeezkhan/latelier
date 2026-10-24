import { describe, it, expect } from 'vitest';
import {
  CountInputSchema,
  ExplainInputSchema,
  ExportInputSchema,
  FindInputSchema,
} from '../../electron/ipc/handlers/query';
import type { CountInput } from '@shared/types';

// Phase 2B (#2.12) — `skip` is bounded so deep pagination can't trigger an
// unbounded O(n) server-side scan with no time ceiling.
describe('FindInputSchema skip bound (#2.12)', () => {
  const base = {
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    filter: '{}',
    limit: 50,
  };

  it('accepts a skip within the bound', () => {
    expect(FindInputSchema.safeParse({ ...base, skip: 0 }).success).toBe(true);
    expect(FindInputSchema.safeParse({ ...base, skip: 10_000_000 }).success).toBe(true);
  });

  it('rejects a skip past the 10M bound', () => {
    expect(FindInputSchema.safeParse({ ...base, skip: 10_000_001 }).success).toBe(false);
  });

  it('rejects a negative skip', () => {
    expect(FindInputSchema.safeParse({ ...base, skip: -1 }).success).toBe(false);
  });
});

// W14 §9 — zod strips keys it does not name, so a schema missing an option
// would drop it silently and count/explain/export would describe a different
// set of documents than the find on screen.
describe('find options on the query schemas', () => {
  const target = { connectionId: 'c1', dbName: 'db', collection: 'coll', filter: '{}' };
  const options = {
    collation: '{"locale":"en","strength":2}',
    hint: '_id_',
    readPreference: 'nearest',
  };

  it.each([
    ['find', FindInputSchema, { limit: 50, skip: 0 }],
    ['count', CountInputSchema, {}],
    ['explain', ExplainInputSchema, { verbosity: 'queryPlanner' }],
    ['export', ExportInputSchema, { format: 'json' }],
  ] as const)('%s keeps collation, hint and readPreference', (_name, schema, rest) => {
    const parsed = schema.parse({ ...target, ...rest, ...options });
    expect(parsed).toMatchObject(options);
  });

  it('refuses a readPreference outside the driver enum', () => {
    const r = FindInputSchema.safeParse({ ...target, limit: 50, skip: 0, readPreference: 'secondaryOnly' });
    expect(r.success).toBe(false);
    expect(CountInputSchema.safeParse({ ...target, readPreference: 'PRIMARY' }).success).toBe(false);
  });

  it('takes maxTimeMS on find as an integer of at least 1', () => {
    const find = (maxTimeMS: unknown) =>
      FindInputSchema.safeParse({ ...target, limit: 50, skip: 0, maxTimeMS }).success;
    expect(find(1)).toBe(true);
    expect(find(40000)).toBe(true);
    expect(find(0)).toBe(false);
    expect(find(1.5)).toBe(false);
    expect(find('100')).toBe(false);
  });

  it('count drops maxTimeMS, and the renderer-facing CountInput type has none either', () => {
    // The count runs on its own probe timeout; a type that allowed the field
    // would let a caller believe it was sent.
    // @ts-expect-error maxTimeMS is not a count input
    const input: CountInput = { ...target, maxTimeMS: 5 };
    expect(CountInputSchema.parse(input)).not.toHaveProperty('maxTimeMS');
  });
});
