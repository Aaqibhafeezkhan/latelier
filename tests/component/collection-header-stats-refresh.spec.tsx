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

describe('CollectionHeader — stats refresh', () => {
  // The fetch effect used to be keyed only on connectionId|dbName|collection,
  // so a write in the still-mounted tab never bumped the doc count on screen.
  it('re-fetches the doc count when refreshSignal changes, without remounting', async () => {
    let call = 0;
    const listCollections = vi.fn(async () => {
      call += 1;
      return [
        {
          name: 'orders',
          type: 'collection' as const,
          documentCount: call === 1 ? 10 : 13,
          sizeBytes: 0,
          indexCount: 1,
          capped: false,
        },
      ];
    });
    installAtelierMock({ meta: { listCollections } });

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
    expect(listCollections).toHaveBeenCalledTimes(2);
  });

  it('clears a stale count rather than leaving it on screen when a refresh fails', async () => {
    let call = 0;
    const listCollections = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return [
          { name: 'orders', type: 'collection' as const, documentCount: 10, sizeBytes: 0, indexCount: 1, capped: false },
        ];
      }
      throw new Error('boom');
    });
    installAtelierMock({ meta: { listCollections } });

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
