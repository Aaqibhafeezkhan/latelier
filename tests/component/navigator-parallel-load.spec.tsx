import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '../helpers/render';
import { DbCollectionNavigator } from '../../src/pages/Workspace/DbCollectionNavigator';
import { connectionFixture, installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionInfo } from '../../shared/ipc';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const coll = (name: string): CollectionInfo => ({
  name,
  type: 'collection',
  documentCount: 0,
  sizeBytes: 0,
  indexCount: 0,
  capped: false,
});

function mountActive(
  listDatabases: () => Promise<Array<{ name: string; sizeOnDisk: number; empty: boolean }>>,
  listCollections: (a: { connectionId: string; dbName: string }) => Promise<CollectionInfo[]>,
) {
  installAtelierMock({
    mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
    meta: { listDatabases, listCollections: listCollections as never },
  });
  return render(
    <DbCollectionNavigator
      connectionsWithTabs={new Set()}
      connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
      focusedConnectionId="c1"
      activeDbName="shop"
      activeCollection={null}
      onOpenCollection={vi.fn()}
      onOpenAggregation={vi.fn()}
    />,
  );
}

describe('DbCollectionNavigator — the active DB loads in parallel with the database list', () => {
  it('requests the active DB collections while listDatabases is still pending', async () => {
    let releaseDbs!: (v: Array<{ name: string; sizeOnDisk: number; empty: boolean }>) => void;
    const listDatabases = vi.fn(
      () => new Promise<Array<{ name: string; sizeOnDisk: number; empty: boolean }>>((r) => { releaseDbs = r; }),
    );
    const listCollections = vi.fn(async () => [coll('orders')]);
    mountActive(listDatabases, listCollections);

    await waitFor(() => expect(listCollections).toHaveBeenCalledWith(expect.objectContaining({ dbName: 'shop' })));
    expect(listDatabases).toHaveBeenCalled();

    await act(async () => releaseDbs([{ name: 'shop', sizeOnDisk: 1, empty: false }]));
    expect(await screen.findByText('shop')).toBeTruthy();
    expect(await screen.findByText('orders')).toBeTruthy();
  });

  it('leaves nothing expanded and does not crash when the active DB was dropped', async () => {
    const listDatabases = vi.fn(async () => [{ name: 'other', sizeOnDisk: 1, empty: false }]);
    const listCollections = vi.fn(async () => {
      throw { code: 'MONGO_ERROR', message: 'ns not found' };
    });
    mountActive(listDatabases, listCollections);

    expect(await screen.findByText('other')).toBeTruthy();
    await waitFor(() => expect(listCollections).toHaveBeenCalled());
    expect(screen.queryByText('shop')).toBeNull();
    expect(screen.queryByText('orders')).toBeNull();
  });
});

describe('DbCollectionNavigator — the early collections fetch respects the connection state', () => {
  it('does not fetch collections for an active DB on a disconnected connection', async () => {
    const listCollections = vi.fn(async () => [coll('orders')]);
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'disconnected' as const }) },
      meta: { listDatabases: async () => [], listCollections: listCollections as never },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test', status: 'disconnected' })]}
        focusedConnectionId="c1"
        activeDbName="shop"
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(listCollections).not.toHaveBeenCalled();
  });

  it('tries a failing fetch once instead of looping', async () => {
    const listCollections = vi.fn(async () => {
      throw { code: 'MONGO_ERROR', message: 'ns not found' };
    });
    mountActive(async () => [{ name: 'other', sizeOnDisk: 1, empty: false }], listCollections);
    await screen.findByText('other');
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(listCollections).toHaveBeenCalledTimes(1);
  });
});
