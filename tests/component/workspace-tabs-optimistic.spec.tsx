import { describe, it, expect, afterEach, vi } from 'vitest';
import { notifications } from '@mantine/notifications';
import { notify } from '../../src/theme/notifications';
import { renderHook, act, waitFor, screen } from '../helpers/render';
import { useWorkspaceTabs } from '../../src/state/workspaceTabs';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab, WorkspaceTab } from '@shared/types';

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

describe('useWorkspaceTabs — optimistic local updates', () => {
  it('closeForConnection drops that Connection\'s tabs synchronously (before the close IPC resolves)', async () => {
    // Pending promise for close() — never resolves during the sync window.
    let releaseClose: (v: { newActiveId: string | null }) => void = () => {};
    const closeSpy = vi.fn(
      () => new Promise<{ newActiveId: string | null }>((r) => { releaseClose = r; }),
    );

    installAtelierMock({
      tabs: {
        list: async () => [
          collectionTab({ id: 't1', connectionId: 'cA', dbName: 'dbA', isActive: true }),
          collectionTab({ id: 't2', connectionId: 'cB', dbName: 'dbB', isActive: false, position: 1 }),
          collectionTab({ id: 't3', connectionId: 'cB', dbName: 'dbC', isActive: false, position: 2 }),
        ],
        close: closeSpy as unknown as import('@shared/ipc').IpcApi['tabs']['close'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tabs).toHaveLength(3);

    // Fire it but do not await; the close IPC is pending. cB, the *second*
    // Connection, so a first-Connection assumption cannot pass.
    act(() => {
      void result.current.closeForConnection('cB');
    });

    // Local state already reflects it — and cA's tab is untouched.
    expect(result.current.tabs.map((t) => t.id)).toEqual(['t1']);
    expect(result.current.activeId).toBe('t1');

    // Main was asked to close cB's two tabs and nothing else.
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledWith('t2');
    expect(closeSpy).toHaveBeenCalledWith('t3');
    expect(closeSpy).not.toHaveBeenCalledWith('t1');

    // Release the IPC so the effect can complete cleanly.
    releaseClose({ newActiveId: null });
  });

  it('setActive flips isActive synchronously before the setActive IPC resolves', async () => {
    let releaseSetActive: (v: { id: string }) => void = () => {};
    const setActiveSpy = vi.fn(
      () => new Promise<{ id: string }>((r) => { releaseSetActive = r; }),
    );

    installAtelierMock({
      tabs: {
        list: async () => [
          collectionTab({ id: 't1', isActive: true, position: 0 }),
          collectionTab({ id: 't2', isActive: false, position: 1 }),
        ],
        setActive: setActiveSpy as unknown as import('@shared/ipc').IpcApi['tabs']['setActive'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeId).toBe('t1');

    act(() => {
      void result.current.setActive('t2');
    });

    // Synchronous flip — no waiting for the IPC.
    expect(result.current.activeId).toBe('t2');
    expect(result.current.tabs.find((t) => t.id === 't1')?.isActive).toBe(false);
    expect(result.current.tabs.find((t) => t.id === 't2')?.isActive).toBe(true);

    expect(setActiveSpy).toHaveBeenCalledWith('t2');

    releaseSetActive({ id: 't2' });
  });

  it('closeForConnection called before the initial refresh closes nothing, rather than fetching every persisted tab', async () => {
    // X16.4 — the old empty-local fallback is deleted with the switch
    // teardown it protected. It re-fetched the whole persisted list whenever
    // local state was still empty, which is a way to close tabs nobody has
    // seen yet. The two callers left (Disconnect, Delete) act on a Connection
    // the user is looking at, so the list has always loaded by then.
    const persisted: WorkspaceTab[] = [
      collectionTab({ id: 'tA', connectionId: 'cA', isActive: true }),
      collectionTab({ id: 'tB', connectionId: 'cB', isActive: false, position: 1 }),
    ];
    const closeSpy = vi.fn(async () => ({ newActiveId: null }));
    installAtelierMock({
      tabs: {
        list: (async () => persisted) as unknown as import('@shared/ipc').IpcApi['tabs']['list'],
        close: closeSpy as unknown as import('@shared/ipc').IpcApi['tabs']['close'],
      },
    });

    // Fire immediately, before the initial refresh resolves — tabsRef is [].
    const { result } = renderHook(() => useWorkspaceTabs());
    await act(async () => {
      await result.current.closeForConnection('cB');
    });

    expect(closeSpy).not.toHaveBeenCalled();
    // And both tabs are still there once the refresh lands.
    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
  });

  it('closeForConnection leaves the other Connection\'s tabs open', async () => {
    // The whole point of this: two Connections, tabs on each, and closing one
    // is not an event in the other's life. The subject is the *second*
    // Connection so a hardcoded-first bug cannot pass.
    let rows: WorkspaceTab[] = [
      collectionTab({ id: 'tA1', connectionId: 'cA', isActive: true }),
      collectionTab({ id: 'tB1', connectionId: 'cB', isActive: false, position: 1 }),
      collectionTab({ id: 'tA2', connectionId: 'cA', isActive: false, position: 2 }),
    ];
    const closeSpy = vi.fn(async (id: string) => {
      rows = rows.filter((t) => t.id !== id);
      return { newActiveId: null };
    });
    installAtelierMock({
      tabs: {
        list: (async () => rows) as unknown as import('@shared/ipc').IpcApi['tabs']['list'],
        close: closeSpy as unknown as import('@shared/ipc').IpcApi['tabs']['close'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.tabs).toHaveLength(3));

    await act(async () => {
      await result.current.closeForConnection('cB');
    });

    expect(result.current.tabs.map((t) => t.id)).toEqual(['tA1', 'tA2']);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledWith('tB1');
  });

  it('closeForConnection reconciles with main after the IPCs settle', async () => {
    const closeSpy = vi.fn(async () => ({ newActiveId: null }));
    let listCalls = 0;
    installAtelierMock({
      tabs: {
        list: async () => {
          listCalls++;
          // First list populates the tabs; subsequent lists (from the
          // refresh afterwards) return empty to simulate main's state.
          return listCalls === 1
            ? [collectionTab({ id: 't1', connectionId: 'cA' })]
            : [];
        },
        close: closeSpy as unknown as import('@shared/ipc').IpcApi['tabs']['close'],
      },
    });

    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.tabs).toHaveLength(1));

    await act(async () => {
      await result.current.closeForConnection('cA');
    });

    expect(result.current.tabs).toEqual([]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useWorkspaceTabs — tab state that could not be saved says so', () => {
  afterEach(() => {
    notifications.clean();
  });

  it('toasts once for a burst of failed flushes, not once per flush', async () => {
    const errorSpy = vi.spyOn(notify, 'error');
    installAtelierMock({
      tabs: {
        list: async () => [collectionTab({ id: 't1' })],
        update: (async () => {
          throw { code: 'SYSTEM_ERROR', message: 'disk full' };
        }) as never,
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.patchCollectionState('t1', { page: 1 }));
    await screen.findByText('Tab changes could not be saved');
    act(() => result.current.patchCollectionState('t1', { page: 2 }));
    await new Promise((r) => setTimeout(r, 400));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Tab changes could not be saved')).toHaveLength(1);
  });

  it('toasts again for a second outage after a flush succeeded in between', async () => {
    const errorSpy = vi.spyOn(notify, 'error');
    let failing = true;
    let updates = 0;
    installAtelierMock({
      tabs: {
        list: async () => [collectionTab({ id: 't1' })],
        update: (async () => {
          updates += 1;
          if (failing) throw { code: 'SYSTEM_ERROR', message: 'disk full' };
          return collectionTab({ id: 't1' });
        }) as never,
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.patchCollectionState('t1', { page: 1 }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));

    failing = false;
    act(() => result.current.patchCollectionState('t1', { page: 2 }));
    await waitFor(() => expect(updates).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(errorSpy).toHaveBeenCalledTimes(1);

    failing = true;
    act(() => result.current.patchCollectionState('t1', { page: 3 }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(2));
  });
});
