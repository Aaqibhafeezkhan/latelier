import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
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
                refreshSignal={1}
      />,
    );

    await waitFor(() => expect(screen.queryByText('10')).toBeNull());
    expect(screen.queryByText(/docs/)).toBeNull();
  });

  // Insert and References both live in ResultBar now; the header is the breadcrumb and stats.
  it('renders no Insert and no References control', () => {
    render(<CollectionHeader connectionId="c1" dbName="shop" collection="orders" />);
    expect(screen.queryByRole('button', { name: 'Insert document' })).toBeNull();
    expect(screen.queryByRole('button', { name: /References/ })).toBeNull();
  });

  it('reads "1 index", not "1 indexes", and keeps the plural otherwise', async () => {
    installAtelierMock({
      meta: { collectionDetails: vi.fn(async () => details({ documentCount: 4, indexCount: 1 })) },
    });
    const { container, rerender } = renderHeader(0);
    await waitFor(() => expect(container.textContent).toContain('1 index'));
    expect(container.textContent).not.toContain('1 indexes');
    installAtelierMock({
      meta: { collectionDetails: vi.fn(async () => details({ documentCount: 4, indexCount: 2 })) },
    });
    rerender(
      <CollectionHeader
        connectionId="c1"
        dbName="shop"
        collection="orders"
                refreshSignal={1}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain('2 indexes'));
  });
});
