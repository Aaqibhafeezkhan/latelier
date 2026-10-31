import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '../helpers/render';
import { useWorkspaceTabs } from '../../src/state/workspaceTabs';
import { flushAll } from '../../src/state/pendingFlush';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

// Tab edits are held back 250ms before `tabs.update` saves them. These cover
// the ways the page can go inside that window without the edit being dropped:
// unmounting, `pagehide`, and main asking before it quits (`flushAll`).

const tab: CollectionTab = {
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
};

afterEach(() => {
  uninstallAtelierMock();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(update: IpcApi['tabs']['update'] = async () => tab) {
  const updateSpy = vi.fn<IpcApi['tabs']['update']>(update);
  installAtelierMock({ tabs: { list: async () => [tab], update: updateSpy } });
  const hook = renderHook(() => useWorkspaceTabs());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  // Edits only after this point, so the 250ms debounce never runs out on its own.
  vi.useFakeTimers();
  return { hook, updateSpy };
}

describe('useWorkspaceTabs — flushing held-back edits', () => {
  it('saves an edit made just before unmount', async () => {
    const { hook, updateSpy } = await mount();
    act(() => hook.result.current.patchCollectionState('t1', { queryRaw: '{"n":7}' }));
    expect(updateSpy).not.toHaveBeenCalled();

    hook.unmount();

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith('t1', { state: { queryRaw: '{"n":7}' } });
    // The debounce timer went with it: nothing fires a second save later.
    await vi.advanceTimersByTimeAsync(300);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('saves an edit on pagehide, and stops listening once unmounted', async () => {
    const { hook, updateSpy } = await mount();
    act(() => hook.result.current.patchCollectionState('t1', { queryRaw: '{"n":7}' }));

    window.dispatchEvent(new Event('pagehide'));
    expect(updateSpy).toHaveBeenCalledWith('t1', { state: { queryRaw: '{"n":7}' } });

    hook.unmount();
    // A patch left pending, so a listener still attached would have something to send.
    act(() => hook.result.current.patchCollectionState('t1', { queryRaw: '{"n":8}' }));
    updateSpy.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('flushAll sends the edit and resolves only once its save has settled', async () => {
    let release: () => void = () => {};
    const { hook, updateSpy } = await mount(
      () => new Promise<CollectionTab>((resolve) => { release = () => resolve(tab); }),
    );
    act(() => hook.result.current.patchCollectionState('t1', { queryRaw: '{"n":7}' }));

    let flushed = false;
    const flushing = flushAll().then(() => { flushed = true; });
    expect(updateSpy).toHaveBeenCalledWith('t1', { state: { queryRaw: '{"n":7}' } });
    await Promise.resolve();
    expect(flushed).toBe(false);

    release();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('flushAll no longer reaches a hook that has unmounted', async () => {
    const { hook, updateSpy } = await mount();
    hook.unmount();
    act(() => hook.result.current.patchCollectionState('t1', { queryRaw: '{"n":7}' }));
    updateSpy.mockClear();
    await flushAll();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('a failed save still lets flushAll resolve, and tells the user', async () => {
    const { notify } = await import('../../src/theme/notifications');
    const errorSpy = vi.spyOn(notify, 'error').mockImplementation(() => '');
    const { hook } = await mount(async () => {
      throw { code: 'INTERNAL', message: 'db closed' };
    });
    act(() => hook.result.current.patchCollectionState('t1', { queryRaw: '{"n":7}' }));
    await expect(flushAll()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('Tab changes could not be saved');
  });
});
