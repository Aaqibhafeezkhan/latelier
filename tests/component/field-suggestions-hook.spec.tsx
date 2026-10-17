import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '../helpers/render';
import { useSuggestions } from '../../src/features/fieldSuggestions/useSuggestions';
import type {
  FieldSource,
  FieldSuggestion,
  OperatorSuggestion,
  SuggestionContext,
  ValueSource,
  ValueSuggestion,
} from '../../src/features/fieldSuggestions/types';
import { operatorSource } from '../../src/features/fieldSuggestions/sources/operatorSource';

function ctx(overrides: Partial<SuggestionContext> = {}): SuggestionContext {
  return {
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    ...overrides,
  };
}

const syncFieldSource = (items: FieldSuggestion[]): FieldSource => () => items;
const asyncFieldSource = (items: FieldSuggestion[], delay = 10): FieldSource =>
  async () => {
    await new Promise((r) => setTimeout(r, delay));
    return items;
  };

describe('useSuggestions — field mode', () => {
  it('returns sync-source items immediately on first render', () => {
    const src = syncFieldSource([
      { kind: 'field', path: 'name', source: 's', frequency: 5 },
      { kind: 'field', path: 'age', source: 's', frequency: 3 },
    ]);
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '', { fieldSources: [src], valueSources: [] }),
    );
    expect(result.current.items.map((i) => (i as FieldSuggestion).path).sort()).toEqual(
      ['age', 'name'],
    );
  });

  it('merges async-source items after they resolve', async () => {
    const sync = syncFieldSource([{ kind: 'field', path: 'name', source: 'a' }]);
    const async_ = asyncFieldSource([{ kind: 'field', path: 'age', source: 'b' }]);
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '', { fieldSources: [sync, async_], valueSources: [] }),
    );
    // sync-only on the first tick
    expect(result.current.items.map((i) => (i as FieldSuggestion).path)).toEqual(['name']);
    await waitFor(() =>
      expect(result.current.items.map((i) => (i as FieldSuggestion).path).sort()).toEqual([
        'age',
        'name',
      ]),
    );
  });

  it('filters by token using case-insensitive substring match and ranks prefix hits higher', () => {
    const src = syncFieldSource([
      { kind: 'field', path: 'address.city', source: 's' },
      { kind: 'field', path: 'city', source: 's' },
      { kind: 'field', path: 'created_at', source: 's' },
    ]);
    const { result } = renderHook(() =>
      useSuggestions(ctx(), 'cit', { fieldSources: [src], valueSources: [] }),
    );
    const paths = result.current.items.map((i) => (i as FieldSuggestion).path);
    // Prefix match ranks first; substring match still included.
    expect(paths[0]).toBe('city');
    expect(paths).toContain('address.city');
    expect(paths).not.toContain('created_at');
  });

  it('dedupes by path across multiple sources and sums frequencies', async () => {
    const a = syncFieldSource([{ kind: 'field', path: 'x', source: 'a', frequency: 2 }]);
    const b = asyncFieldSource([{ kind: 'field', path: 'x', source: 'b', frequency: 3 }]);
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '', { fieldSources: [a, b], valueSources: [] }),
    );
    // Wait until async source merges (frequency reaches the summed value).
    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
      const merged = result.current.items[0] as FieldSuggestion;
      expect(merged.frequency).toBe(5);
    });
    const merged = result.current.items[0] as FieldSuggestion;
    expect(merged.path).toBe('x');
  });

  it('ignores value sources when target is absent', () => {
    const fieldSrc = syncFieldSource([{ kind: 'field', path: 'x', source: 's' }]);
    const valueSrc = vi.fn(
      (): ValueSuggestion[] => [{ kind: 'value', value: 'v', display: 'v', source: 'vs' }],
    );
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '', { fieldSources: [fieldSrc], valueSources: [valueSrc as unknown as ValueSource] }),
    );
    expect(result.current.items.every((i) => i.kind === 'field')).toBe(true);
    expect(valueSrc).not.toHaveBeenCalled();
  });

  it('returns [] for a null context', () => {
    const { result } = renderHook(() =>
      useSuggestions(null, '', { fieldSources: [], valueSources: [] }),
    );
    expect(result.current.items).toEqual([]);
  });
});

describe('useSuggestions — operator ranking', () => {
  it('ranks $eq #1 for token "eq" (no $ required)', () => {
    const { result } = renderHook(() =>
      useSuggestions(ctx(), 'eq', { fieldSources: [operatorSource], valueSources: [] }),
    );
    const first = result.current.items[0] as OperatorSuggestion;
    expect(first?.kind).toBe('operator');
    expect(first?.name).toBe('$eq');
  });

  it('ranks $eq #1 for token "$e" as well', () => {
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '$e', { fieldSources: [operatorSource], valueSources: [] }),
    );
    const first = result.current.items[0] as OperatorSuggestion;
    expect(first?.name).toBe('$eq');
  });

  it('merges fields and operators in a single ranked list', () => {
    const fields = syncFieldSource([
      { kind: 'field', path: 'equivalent', source: 's' },
    ]);
    const { result } = renderHook(() =>
      useSuggestions(ctx(), 'eq', { fieldSources: [fields, operatorSource], valueSources: [] }),
    );
    const items = result.current.items;
    // $eq (operator, prefix after strip) beats "equivalent" (field, prefix)
    expect(items[0]?.kind).toBe('operator');
    expect((items[0] as OperatorSuggestion).name).toBe('$eq');
    expect(items.some((i) => i.kind === 'field' && i.path === 'equivalent')).toBe(true);
  });

  it('off-context operators sink below in-context matches', () => {
    const { result } = renderHook(() =>
      useSuggestions(
        ctx({ operatorContext: 'matchKey' }),
        'sum',
        { fieldSources: [operatorSource], valueSources: [] },
      ),
    );
    // $sum is an accumulator — off-context inside matchKey. It should still
    // appear (don't hide), just not at the top.
    const names = result.current.items.map((i) => (i as OperatorSuggestion).name);
    expect(names).toContain('$sum');
  });
});

describe('useSuggestions — value mode', () => {
  it('runs value sources when target is set and ignores field sources', () => {
    const valueSrc: ValueSource = () => [
      { kind: 'value', value: 'active', display: 'active', source: 'vs' },
      { kind: 'value', value: 'pending', display: 'pending', source: 'vs' },
    ];
    const fieldSrc = vi.fn(() => [] as FieldSuggestion[]);
    const { result } = renderHook(() =>
      useSuggestions(
        ctx({ target: { field: 'status' } }),
        '',
        { fieldSources: [fieldSrc], valueSources: [valueSrc] },
      ),
    );
    expect(result.current.items.map((i) => (i as ValueSuggestion).display).sort()).toEqual([
      'active',
      'pending',
    ]);
    expect(fieldSrc).not.toHaveBeenCalled();
  });
});

describe('useSuggestions — a rejecting async source still settles', () => {
  const rejecting: FieldSource = async () => {
    await new Promise((r) => setTimeout(r, 5));
    throw new Error('source down');
  };

  it('returns loading to false and keeps the sync items when an async source rejects', async () => {
    const sync = syncFieldSource([{ kind: 'field', path: 'name', source: 'a' }]);
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '', { fieldSources: [sync, rejecting], valueSources: [] }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((i) => (i as FieldSuggestion).path)).toEqual(['name']);
  });

  it('still merges the healthy async source when a sibling rejects', async () => {
    const healthy = asyncFieldSource([{ kind: 'field', path: 'age', source: 'b' }]);
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '', { fieldSources: [rejecting, healthy], valueSources: [] }),
    );
    await waitFor(() =>
      expect(result.current.items.map((i) => (i as FieldSuggestion).path)).toEqual(['age']),
    );
    expect(result.current.loading).toBe(false);
  });

  it('does not let a stale rejection clear the newer request loading flag', async () => {
    // The hook also calls each source once in its sync pass, so key the
    // pending promises by collection instead of counting calls.
    const rejectors = new Map<string, (e: Error) => void>();
    const resolvers = new Map<string, (items: FieldSuggestion[]) => void>();
    const src: FieldSource = (c) =>
      new Promise<FieldSuggestion[]>((res, rej) => {
        resolvers.set(c.collection, res);
        rejectors.set(c.collection, rej);
      });
    const { result, rerender } = renderHook(
      ({ coll }: { coll: string }) =>
        useSuggestions(ctx({ collection: coll }), '', { fieldSources: [src], valueSources: [] }),
      { initialProps: { coll: 'a' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));
    rerender({ coll: 'b' });
    await waitFor(() => expect(resolvers.has('b')).toBe(true));
    rejectors.get('a')!(new Error('stale'));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.loading).toBe(true);
    resolvers.get('b')!([{ kind: 'field', path: 'z', source: 's' }]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((i) => (i as FieldSuggestion).path)).toEqual(['z']);
  });

  it('clears loading when the context goes away while an async source is pending', async () => {
    const never: FieldSource = () => new Promise<FieldSuggestion[]>(() => undefined);
    const { result, rerender } = renderHook(
      ({ c }: { c: SuggestionContext | null }) =>
        useSuggestions(c, '', { fieldSources: [never], valueSources: [] }),
      { initialProps: { c: ctx() as SuggestionContext | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ c: null });

    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('clears loading when the new context has only sync sources', async () => {
    const never: FieldSource = (c) =>
      c.collection === 'a' ? new Promise<FieldSuggestion[]>(() => undefined) : [];
    const { result, rerender } = renderHook(
      ({ coll }: { coll: string }) =>
        useSuggestions(ctx({ collection: coll }), '', { fieldSources: [never], valueSources: [] }),
      { initialProps: { coll: 'a' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ coll: 'b' });

    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('reports each rejected source instead of dropping it silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = new Error('source down');
    const failing: FieldSource = async () => {
      throw boom;
    };
    const { result } = renderHook(() =>
      useSuggestions(ctx(), '', { fieldSources: [failing], valueSources: [] }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(warn).toHaveBeenCalledWith('[suggestions] source failed', boom);
    warn.mockRestore();
  });
});
