// A whole-connection Refresh empties the navigator cache. A collection listing
// started before it must not repopulate that emptied cache, and an unforced
// load issued after it (the active-database effect, the palette sweep) must
// send a fresh request instead of joining the stale one.
import { describe, it, expect, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { useNavigatorData } from '../../src/pages/Workspace/useNavigatorData';
import type { CollectionInfo } from '@shared/ipc';

const coll = (name: string) => ({ name, type: 'collection' }) as CollectionInfo;

afterEach(() => uninstallAtelierMock());

describe('useNavigatorData: cacheReset drops listings started before it', () => {
  it('a pre-refresh listing cannot repopulate the cache, and a fresh request goes out', async () => {
    const resolvers: Array<(rows: CollectionInfo[]) => void> = [];
    installAtelierMock({
      meta: {
        listCollections: () => new Promise<CollectionInfo[]>((r) => resolvers.push(r)),
      },
    });
    const { result } = renderHook(() => useNavigatorData());

    let stale!: Promise<void>;
    act(() => {
      stale = result.current.loadColls('c1', 'shop');
    });
    act(() => result.current.dispatch({ type: 'cacheReset', id: 'c1' }));
    let fresh!: Promise<void>;
    act(() => {
      fresh = result.current.loadColls('c1', 'shop');
    });

    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[0]([coll('removed')]);
      await stale;
    });
    expect(result.current.tree.caches.c1.colls.shop).toBeUndefined();

    await act(async () => {
      resolvers[1]([coll('added')]);
      await fresh;
    });
    expect(result.current.tree.caches.c1.colls.shop.map((c) => c.name)).toEqual(['added']);
  });

  it('a reset on one connection leaves another connection’s listing joinable', () => {
    let calls = 0;
    installAtelierMock({
      meta: {
        listCollections: () => {
          calls += 1;
          return new Promise<CollectionInfo[]>(() => {});
        },
      },
    });
    const { result } = renderHook(() => useNavigatorData());

    act(() => {
      void result.current.loadColls('c2', 'shop');
    });
    act(() => result.current.dispatch({ type: 'cacheReset', id: 'c1' }));
    act(() => {
      void result.current.loadColls('c2', 'shop');
    });

    expect(calls).toBe(1);
  });
});
