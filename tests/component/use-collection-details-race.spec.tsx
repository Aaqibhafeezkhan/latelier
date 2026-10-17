import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCollectionDetails } from '../../src/pages/Workspace/useCollectionDetails';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionDetails } from '@shared/ipc';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const details = (name: string): CollectionDetails => ({ name, type: 'collection', capped: false, options: {} });

describe('useCollectionDetails — a reload captured for a collection the hook has left', () => {
  it('does nothing, so the collection now on screen still gets its details', async () => {
    let resolveCustomers!: (d: CollectionDetails) => void;
    const collectionDetails = vi.fn(({ collection }: { collection: string }) =>
      collection === 'orders'
        ? Promise.resolve(details('orders'))
        : new Promise<CollectionDetails>((r) => (resolveCustomers = r)),
    );
    installAtelierMock({ meta: { collectionDetails } });

    const { result, rerender } = renderHook(
      ({ collection }) => useCollectionDetails('c1', 'shop', collection),
      { initialProps: { collection: 'orders' } },
    );
    await waitFor(() => expect(result.current.details?.name).toBe('orders'));
    // What a Save in the validation section still holds after the tab moved on.
    const staleReload = result.current.reload;

    rerender({ collection: 'customers' });
    await waitFor(() => expect(collectionDetails).toHaveBeenCalledTimes(2));
    await act(async () => staleReload());
    await act(async () => resolveCustomers(details('customers')));

    expect(collectionDetails).toHaveBeenCalledTimes(2);
    expect(result.current.details?.name).toBe('customers');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('still reloads the collection it was captured for', async () => {
    const collectionDetails = vi.fn(async ({ collection }: { collection: string }) => details(collection));
    installAtelierMock({ meta: { collectionDetails } });

    const { result } = renderHook(() => useCollectionDetails('c1', 'shop', 'orders'));
    await waitFor(() => expect(result.current.details?.name).toBe('orders'));
    await act(async () => result.current.reload());

    expect(collectionDetails).toHaveBeenCalledTimes(2);
    expect(result.current.details?.name).toBe('orders');
  });
});
