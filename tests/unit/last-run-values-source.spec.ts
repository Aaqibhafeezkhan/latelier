import { describe, it, expect } from 'vitest';
import { lastRunValuesSource } from '../../src/features/fieldSuggestions/sources/lastRunValuesSource';
import type { SuggestionContext, ValueSuggestion } from '../../src/features/fieldSuggestions/types';

function ctx(
  field: string,
  overrides: Partial<SuggestionContext> = {},
): SuggestionContext & { target: { field: string; operator?: string } } {
  return {
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    target: { field },
    ...overrides,
  };
}

function sync(out: ReturnType<typeof lastRunValuesSource>): ValueSuggestion[] {
  if (!Array.isArray(out)) throw new Error('lastRunValuesSource must stay synchronous');
  return out;
}

describe('lastRunValuesSource', () => {
  it('returns [] with no docs, or an empty field', () => {
    expect(lastRunValuesSource(ctx('status'))).toEqual([]);
    expect(lastRunValuesSource(ctx('status', { recentDocs: [] }))).toEqual([]);
    expect(lastRunValuesSource(ctx('', { recentDocs: [{ status: 'a' }] }))).toEqual([]);
  });

  it('extracts a top-level scalar field, counting frequency across docs', () => {
    const out = sync(
      lastRunValuesSource(
        ctx('status', {
          recentDocs: [{ status: 'shipped' }, { status: 'shipped' }, { status: 'pending' }],
        }),
      ),
    );
    const byDisplay = Object.fromEntries(out.map((s) => [s.display, s]));
    expect(byDisplay.shipped?.frequency).toBe(2);
    expect(byDisplay.pending?.frequency).toBe(1);
    expect(byDisplay.shipped?.value).toBe('shipped');
  });

  it('reads a dotted path through nested objects', () => {
    const out = sync(
      lastRunValuesSource(ctx('address.city', { recentDocs: [{ address: { city: 'Ottawa' } }] })),
    );
    expect(out.map((s) => s.display)).toEqual(['Ottawa']);
  });

  it('expands an array leaf into one suggestion per element', () => {
    const out = sync(
      lastRunValuesSource(ctx('tags', { recentDocs: [{ tags: ['red', 'blue'] }, { tags: ['red'] }] })),
    );
    const byDisplay = Object.fromEntries(out.map((s) => [s.display, s]));
    expect(byDisplay.red?.frequency).toBe(2);
    expect(byDisplay.blue?.frequency).toBe(1);
  });

  it('renders an ObjectId leaf as its hex string and a Date leaf as ISO text', () => {
    const out = sync(
      lastRunValuesSource(
        ctx('owner', {
          recentDocs: [{ owner: { $oid: '507f1f77bcf86cd799439011' } }],
        }),
      ),
    );
    expect(out.map((s) => s.display)).toEqual(['507f1f77bcf86cd799439011']);

    const dateOut = sync(
      lastRunValuesSource(
        ctx('createdAt', {
          recentDocs: [{ createdAt: { $date: '2026-01-01T00:00:00.000Z' } }],
        }),
      ),
    );
    expect(dateOut.map((s) => s.display)).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('skips a nested-object leaf rather than suggesting garbage', () => {
    const out = sync(
      lastRunValuesSource(ctx('address', { recentDocs: [{ address: { city: 'Ottawa' } }] })),
    );
    expect(out).toEqual([]);
  });

  it('does not descend through an array to reach a further dotted segment', () => {
    const out = sync(
      lastRunValuesSource(ctx('items.name', { recentDocs: [{ items: [{ name: 'a' }] }] })),
    );
    expect(out).toEqual([]);
  });

  it('caps at the first 50 docs', () => {
    const docs = Array.from({ length: 60 }, (_, i) => ({ status: `s${i}` }));
    const out = sync(lastRunValuesSource(ctx('status', { recentDocs: docs })));
    expect(out).toHaveLength(50);
    expect(out.map((s) => s.display)).not.toContain('s59');
  });

  it('tags each value with its source, display type and count', () => {
    const out = sync(
      lastRunValuesSource(ctx(' n ', { recentDocs: [{ n: 1 }, { n: 1 }, { n: 'a' }] })),
    );
    expect(out).toEqual([
      { kind: 'value', value: '1', display: '1', type: 'number', source: 'lastRun', frequency: 2 },
      { kind: 'value', value: 'a', display: 'a', type: 'string', source: 'lastRun', frequency: 1 },
    ]);
  });

  it.each(['constructor', 'toString', '__proto__', 'a.constructor'])(
    'never reads the inherited property %s',
    (field) => {
      const out = sync(lastRunValuesSource(ctx(field, { recentDocs: [{ a: { b: 1 } }] })));
      expect(out).toEqual([]);
    },
  );

  it('reads an own property literally named constructor', () => {
    const doc = JSON.parse('{"constructor":"own"}') as unknown;
    const out = sync(lastRunValuesSource(ctx('constructor', { recentDocs: [doc] })));
    expect(out.map((s) => s.display)).toEqual(['own']);
  });

  it.each(['token', 'auth.Secret'])('never offers values of the secret-named field %s', (field) => {
    const docs = [{ token: 't1', auth: { Secret: 's1' } }];
    expect(sync(lastRunValuesSource(ctx(field, { recentDocs: docs })))).toEqual([]);
  });
});
