import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { CollectionHeader } from '../../src/pages/Workspace/CollectionHeader';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderHeader(refreshSignal: number | undefined) {
  return render(
    <CollectionHeader
      connectionId="c1"
      dbName="shop"
      collection="orders"
      onOpenReferences={() => {}}
      referenceRuleCount={0}
      refreshSignal={refreshSignal}
    />,
  );
}

const details = (stats?: { documentCount?: number; indexCount?: number }) => ({
  name: 'orders',
  type: 'collection' as const,
  capped: false,
  stats,
  options: {},
});

describe('CollectionHeader — stats refresh', () => {
  // The fetch effect used to be keyed only on connectionId|dbName|collection,
  // so a write in the still-mounted tab never bumped the doc count on screen.
  it('re-fetches the doc count when refreshSignal changes, without remounting', async () => {
    let call = 0;
    const collectionDetails = vi.fn(async () => {
      call += 1;
      return details({ documentCount: call === 1 ? 10 : 13, indexCount: 1 });
    });
    installAtelierMock({ meta: { collectionDetails } });

    const { rerender } = renderHeader(0);
    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());

    rerender(
      <CollectionHeader
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onOpenReferences={() => {}}
        referenceRuleCount={0}
        refreshSignal={1}
      />,
    );

    await waitFor(() => expect(screen.getByText('13')).toBeTruthy());
    expect(collectionDetails).toHaveBeenCalledTimes(2);
  });

  it('reads the one collection, not the whole database', async () => {
    const collectionDetails = vi.fn(async () => details({ documentCount: 10, indexCount: 1 }));
    const listCollections = vi.fn(async () => []);
    installAtelierMock({ meta: { collectionDetails, listCollections } });

    renderHeader(0);
    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());

    expect(collectionDetails).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop', collection: 'orders' });
    expect(listCollections).not.toHaveBeenCalled();
  });

  it('hides a figure the server did not report instead of showing 0', async () => {
    installAtelierMock({
      meta: { collectionDetails: async () => details({ indexCount: 3 }) },
    });

    renderHeader(0);

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.queryByText(/docs in collection/)).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows no figures for a view', async () => {
    const collectionDetails = vi.fn(async () => ({
      name: 'orders',
      type: 'view' as const,
      capped: false,
      options: { viewOn: 'src', pipeline: '[]' },
    }));
    installAtelierMock({ meta: { collectionDetails } });

    renderHeader(0);

    await waitFor(() => expect(collectionDetails).toHaveBeenCalled());
    expect(screen.queryByText(/docs in collection/)).toBeNull();
    expect(screen.queryByText(/indexes/)).toBeNull();
  });

  it('clears a stale count rather than leaving it on screen when a refresh fails', async () => {
    let call = 0;
    const collectionDetails = vi.fn(async () => {
      call += 1;
      if (call === 1) return details({ documentCount: 10, indexCount: 1 });
      throw new Error('boom');
    });
    installAtelierMock({ meta: { collectionDetails } });

    const { rerender } = renderHeader(0);
    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());

    rerender(
      <CollectionHeader
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onOpenReferences={() => {}}
        referenceRuleCount={0}
        refreshSignal={1}
      />,
    );

    await waitFor(() => expect(screen.queryByText('10')).toBeNull());
    expect(screen.queryByText(/docs/)).toBeNull();
  });

  // Insert lives in ResultBar; the header keeps the References button and
  // reports its rule count.
  it('renders no Insert control and a References button that opens the editor', () => {
    const onOpenReferences = vi.fn();
    render(
      <CollectionHeader
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onOpenReferences={onOpenReferences}
        referenceRuleCount={3}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Insert document' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'References (3)' }));
    expect(onOpenReferences).toHaveBeenCalledTimes(1);
  });
});
