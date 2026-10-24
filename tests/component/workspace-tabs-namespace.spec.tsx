import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, screen, fireEvent } from '../helpers/render';
import { useWorkspaceTabs } from '../../src/state/workspaceTabs';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';

const now = '2026-04-21T12:00:00.000Z';

function collectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state: {
      view: 'Tree',
      builder: {
        projection: [],
        sort: '',
        limit: '',
      },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
    ...overrides,
  };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

/**
 * N0.5 regression coverage: dropping/renaming a namespace must not leave an
 * open workspace tab pointing at it. `closeForNamespace` and
 * `retargetCollection` are the two hook-level operations
 * `DbCollectionNavigator`'s drop/rename callbacks drive via `Workspace.tsx`.
 */
describe('useWorkspaceTabs — namespace drop/rename cleanup (N0.5)', () => {
  it('closeForNamespace closes only the tab matching {connectionId, dbName, collection}', async () => {
    const closeSpy = vi.fn(async () => ({ newActiveId: null }));
    installAtelierMock({
      tabs: {
        list: async () => [
          collectionTab({ id: 't1', connectionId: 'c1', dbName: 'db', collection: 'orders' }),
          collectionTab({
            id: 't2',
            connectionId: 'c1',
            dbName: 'db',
            collection: 'users',
            position: 1,
            isActive: false,
          }),
          // Different connection, same db/collection name — must not close.
          collectionTab({
            id: 't3',
            connectionId: 'c2',
            dbName: 'db',
            collection: 'orders',
            position: 2,
            isActive: false,
          }),
        ],
        close: closeSpy as unknown as IpcApi['tabs']['close'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.tabs).toHaveLength(3));

    await act(async () => {
      await result.current.closeForNamespace({
        connectionId: 'c1',
        dbName: 'db',
        collection: 'orders',
      });
    });

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledWith('t1');
  });

  it('closeForNamespace with no `collection` closes every tab in the dropped database', async () => {
    const closeSpy = vi.fn(async () => ({ newActiveId: null }));
    installAtelierMock({
      tabs: {
        list: async () => [
          collectionTab({ id: 't1', connectionId: 'c1', dbName: 'db', collection: 'orders' }),
          collectionTab({
            id: 't2',
            connectionId: 'c1',
            dbName: 'db',
            collection: 'users',
            position: 1,
            isActive: false,
          }),
          collectionTab({
            id: 't3',
            connectionId: 'c1',
            dbName: 'otherDb',
            collection: 'orders',
            position: 2,
            isActive: false,
          }),
        ],
        close: closeSpy as unknown as IpcApi['tabs']['close'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.tabs).toHaveLength(3));

    await act(async () => {
      await result.current.closeForNamespace({ connectionId: 'c1', dbName: 'db' });
    });

    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledWith('t1');
    expect(closeSpy).toHaveBeenCalledWith('t2');
    expect(closeSpy).not.toHaveBeenCalledWith('t3');
  });

  it('closeForNamespace prompts before closing a tab with unsaved pipeline edits, and honors Cancel', async () => {
    const closeSpy = vi.fn(async () => ({ newActiveId: null }));
    installAtelierMock({
      tabs: {
        list: async () => [
          collectionTab({
            id: 't1',
            connectionId: 'c1',
            dbName: 'db',
            collection: 'orders',
            state: {
              view: 'Tree',
              builder: { projection: [], sort: '', limit: '' },
              queryRaw: '{}',
              page: 0,
              pageSize: 50,
              activeBuilderTab: 'Builder',
              aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: true },
            },
          }),
        ],
        close: closeSpy as unknown as IpcApi['tabs']['close'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.tabs).toHaveLength(1));

    // N4.7 — this was `window.confirm`, which blocks the thread and
    // could be stubbed with a return value. It is now the app's one confirm
    // dialog, so the call does not settle until the dialog is answered. Both
    // production callers fire it with `void`, so nothing waits on the user.
    let settled = false;
    const pending = result.current
      .closeForNamespace({ connectionId: 'c1', dbName: 'db', collection: 'orders' })
      .then(() => { settled = true; });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Discard unsaved pipeline changes?');
    expect(closeSpy).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await pending;
    });

    expect(settled).toBe(true);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(result.current.tabs).toHaveLength(1);
  });

  it('closeForNamespace closes the dirty tab once the discard is confirmed', async () => {
    const closeSpy = vi.fn(async () => {});
    installAtelierMock({
      tabs: {
        list: async () => [
          collectionTab({
            id: 't1',
            connectionId: 'c1',
            dbName: 'db',
            collection: 'orders',
            state: {
              ...collectionTab({ id: 't1' }).state,
              aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: true },
            },
          }),
        ],
        close: closeSpy as unknown as IpcApi['tabs']['close'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.tabs).toHaveLength(1));

    const pending = result.current.closeForNamespace({
      connectionId: 'c1',
      dbName: 'db',
      collection: 'orders',
    });

    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }));
      await pending;
    });

    expect(closeSpy).toHaveBeenCalledWith('t1');
  });

  it('retargetCollection calls tabs.collectionRenamed with oldCollection/newCollection and refreshes', async () => {
    const renamedSpy = vi.fn(async () => ({ retargeted: true, closed: false }));
    let listCalls = 0;
    installAtelierMock({
      tabs: {
        list: async () => {
          listCalls++;
          return listCalls === 1
            ? [collectionTab({ id: 't1', connectionId: 'c1', dbName: 'db', collection: 'orders' })]
            : [collectionTab({ id: 't1', connectionId: 'c1', dbName: 'db', collection: 'orders2' })];
        },
        collectionRenamed: renamedSpy as unknown as IpcApi['tabs']['collectionRenamed'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.tabs).toHaveLength(1));

    await act(async () => {
      await result.current.retargetCollection({
        connectionId: 'c1',
        dbName: 'db',
        collection: 'orders',
        newCollection: 'orders2',
      });
    });

    expect(renamedSpy).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'db',
      oldCollection: 'orders',
      newCollection: 'orders2',
    });
    expect(result.current.tabs[0]?.collection).toBe('orders2');
  });
});

/**
 * Opening a saved pipeline reseeds the aggregation on the collection's tab
 * when one is open, so unsaved stage edits there need the same confirm
 * that closing the tab asks for.
 */
describe('useWorkspaceTabs — opening a saved pipeline over unsaved edits', () => {
  const dirtyOrders = (overrides: Partial<CollectionTab> = {}): CollectionTab =>
    collectionTab({
      id: 't1',
      connectionId: 'c1',
      dbName: 'db',
      collection: 'orders',
      state: {
        ...collectionTab({ id: 't1' }).state,
        aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: true },
      },
      ...overrides,
    });
  const saved = { connectionId: 'c1', dbName: 'db', collection: 'orders', savedId: 's1', name: 'by status' };

  function setup(tab: CollectionTab) {
    const openSpy = vi.fn(async () => tab);
    installAtelierMock({
      tabs: {
        list: async () => [tab],
        openAggregation: openSpy as unknown as IpcApi['tabs']['openAggregation'],
      },
    });
    const hook = renderHook(() => useWorkspaceTabs());
    return { openSpy, hook };
  }

  it('asks first, and Cancel keeps the unsaved pipeline', async () => {
    const { openSpy, hook } = setup(dirtyOrders());
    await waitFor(() => expect(hook.result.current.tabs).toHaveLength(1));

    let outcome: unknown = 'unsettled';
    const pending = hook.result.current.openAggregation(saved).then((tab) => { outcome = tab; });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Discard unsaved pipeline changes?');
    expect(dialog.textContent).toContain('"by status"');
    expect(dialog.textContent).toContain('"db.orders"');
    expect(openSpy).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await pending;
    });

    expect(outcome).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens the saved pipeline once the discard is confirmed', async () => {
    const { openSpy, hook } = setup(dirtyOrders());
    await waitFor(() => expect(hook.result.current.tabs).toHaveLength(1));

    const pending = hook.result.current.openAggregation(saved);
    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard and open' }));
      await pending;
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(saved);
  });

  it('asks first when the open seeds stages (Open as pipeline, #156)', async () => {
    const { openSpy, hook } = setup(dirtyOrders());
    await waitFor(() => expect(hook.result.current.tabs).toHaveLength(1));
    const seeded = {
      connectionId: 'c1',
      dbName: 'db',
      collection: 'orders',
      initialState: { stages: [{ id: 1, op: '$limit', body: '5', enabled: true }], activeStageId: null, dirty: true },
    };

    let outcome: unknown = 'unsettled';
    const pending = hook.result.current.openAggregation(seeded).then((tab) => { outcome = tab; });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Discard unsaved pipeline changes?');
    expect(openSpy).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await pending;
    });
    expect(outcome).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['the tab has no unsaved edits', dirtyOrders({ state: { ...collectionTab().state, aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: false } } }), saved],
    ['the dirty tab is on another collection', dirtyOrders({ collection: 'users' }), saved],
    ['the dirty tab is on another database', dirtyOrders({ dbName: 'other' }), saved],
    ['the dirty tab is on another connection', dirtyOrders({ connectionId: 'c2' }), saved],
    ['nothing replaces the pipeline (no saved pipeline, no name)', dirtyOrders(), { connectionId: 'c1', dbName: 'db', collection: 'orders' }],
  ])('opens without asking when %s', async (_name, tab, input) => {
    const { openSpy, hook } = setup(tab);
    await waitFor(() => expect(hook.result.current.tabs).toHaveLength(1));

    await act(async () => {
      await hook.result.current.openAggregation(input);
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('asks for a name alone, which also replaces the pipeline', async () => {
    const { openSpy, hook } = setup(dirtyOrders());
    await waitFor(() => expect(hook.result.current.tabs).toHaveLength(1));

    const pending = hook.result.current.openAggregation({ connectionId: 'c1', dbName: 'db', collection: 'orders', name: 'draft' });
    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await pending;
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('names "this pipeline" when no name comes with the saved pipeline', async () => {
    const { hook } = setup(dirtyOrders());
    await waitFor(() => expect(hook.result.current.tabs).toHaveLength(1));

    const pending = hook.result.current.openAggregation({ connectionId: 'c1', dbName: 'db', collection: 'orders', savedId: 's1' });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Opening this pipeline replaces');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await pending;
    });
  });
});
