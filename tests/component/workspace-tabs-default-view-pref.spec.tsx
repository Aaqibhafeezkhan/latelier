import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcApi } from '@shared/ipc';
import type { CollectionTab } from '@shared/types';
import { renderHook, act, waitFor } from '../helpers/render';
import { useWorkspaceTabs } from '../../src/state/workspaceTabs';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function collectionTab(): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    position: 0,
    isActive: true,
    openedAt: '2026-04-21T12:00:00.000Z',
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
  } as CollectionTab;
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

async function openWith(prefs: Record<string, unknown>) {
  const open = vi.fn<IpcApi['tabs']['openCollection']>(async () => collectionTab());
  installAtelierMock({
    tabs: { list: async () => [], openCollection: open as unknown as IpcApi['tabs']['openCollection'] },
    prefs: {
      get: (async (key: string) => (key in prefs ? prefs[key] : null)) as unknown as IpcApi['prefs']['get'],
    },
  });
  const { result } = renderHook(() => useWorkspaceTabs());
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    await result.current.openCollection({ connectionId: 'c1', dbName: 'db', collection: 'coll' });
  });
  expect(open).toHaveBeenCalledTimes(1);
  return open.mock.calls[0]![0] as { initialState?: unknown };
}

describe('useWorkspaceTabs: openCollection default-view pref', () => {
  it.each(['Table', 'Tree', 'JSON'])('seeds a new tab with the stored %s view', async (view) => {
    const call = await openWith({ 'ui.workspace.defaultView': view });
    expect(call.initialState).toEqual({ view });
  });

  it('seeds the view and the page size together', async () => {
    const call = await openWith({
      'ui.workspace.defaultView': 'JSON',
      'ui.workspace.defaultPageSize': 100,
    });
    expect(call.initialState).toEqual({ view: 'JSON', pageSize: 100 });
  });

  it.each([['Grid'], ['table'], [7], [null]])(
    'omits initialState when the stored view is %j',
    async (stored) => {
      const call = await openWith({ 'ui.workspace.defaultView': stored });
      expect(call.initialState).toBeUndefined();
    },
  );

  it('still seeds the page size when reading the view pref fails', async () => {
    const open = vi.fn<IpcApi['tabs']['openCollection']>(async () => collectionTab());
    installAtelierMock({
      tabs: { list: async () => [], openCollection: open as unknown as IpcApi['tabs']['openCollection'] },
      prefs: {
        get: (async (key: string) => {
          if (key === 'ui.workspace.defaultView') throw new Error('boom');
          return 25;
        }) as unknown as IpcApi['prefs']['get'],
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.openCollection({ connectionId: 'c1', dbName: 'db', collection: 'coll' });
    });
    expect(open.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ initialState: { pageSize: 25 } }),
    );
  });
});
