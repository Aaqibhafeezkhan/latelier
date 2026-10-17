// W15 §14.7 — the sampled schema behind a row's type warning belongs to one
// collection. A row that moves to another collection must not keep reading
// the previous collection's sample while the new one loads.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '../helpers/render';
import { useStructureEntries } from '../../src/pages/Workspace/useStructureEntries';
import type { SchemaSampleEntry } from '@shared/types';
import type { SuggestionContext } from '../../src/features/fieldSuggestions/types';

const pending = new Map<string, (entries: SchemaSampleEntry[]) => void>();

vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', () => ({
  getStructureEntries: (_c: string, _d: string, collection: string) =>
    new Promise<SchemaSampleEntry[]>((resolve) => pending.set(collection, resolve)),
}));

const ctx = (collection: string): SuggestionContext => ({ connectionId: 'c1', dbName: 'db', collection });
const entry = (path: string): SchemaSampleEntry => ({ path, frequency: 1, types: { string: 1 } });

afterEach(() => {
  pending.clear();
});

describe('useStructureEntries', () => {
  it('shows nothing from the previous collection while the next one loads', async () => {
    const { result, rerender } = renderHook(({ c }) => useStructureEntries(ctx(c), true), {
      initialProps: { c: 'orders' },
    });
    await waitFor(() => expect(pending.has('orders')).toBe(true));
    pending.get('orders')!([entry('status')]);
    await waitFor(() => expect(result.current.has('status')).toBe(true));

    rerender({ c: 'users' });

    expect(result.current.size).toBe(0);
    await waitFor(() => expect(pending.has('users')).toBe(true));
    pending.get('users')!([entry('email')]);
    await waitFor(() => expect(result.current.has('email')).toBe(true));
    expect(result.current.has('status')).toBe(false);
  });

  it('asks for nothing and shows nothing while disabled', async () => {
    const { result } = renderHook(() => useStructureEntries(ctx('orders'), false));

    await new Promise((r) => setTimeout(r, 20));
    expect(pending.size).toBe(0);
    expect(result.current.size).toBe(0);
  });
});
