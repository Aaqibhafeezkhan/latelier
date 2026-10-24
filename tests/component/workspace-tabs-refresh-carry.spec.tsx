import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '../helpers/render';
import { useWorkspaceTabs } from '../../src/state/workspaceTabs';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab, ScriptTab } from '@shared/types';

const now = '2026-04-21T12:00:00.000Z';

function collectionTab(id: string): CollectionTab {
  return {
    id,
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: id,
    position: 0,
    isActive: false,
    openedAt: now,
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
}

function scriptTab(id: string): ScriptTab {
  return {
    id,
    kind: 'script',
    connectionId: 'c1',
    dbName: '',
    collection: '',
    position: 1,
    isActive: false,
    openedAt: now,
    pinned: false,
    state: { title: 'S', source: '' },
  };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useWorkspaceTabs — results survive a refresh', () => {
  it('opening or closing another tab keeps every other tab\'s in-memory results', async () => {
    // Main never persists results, so every listing comes back without them.
    const listed = () => [collectionTab('a'), scriptTab('s')];
    installAtelierMock({
      tabs: {
        list: async () => listed(),
        openCollection: async () => collectionTab('b'),
        close: async () => ({ newActiveId: null }),
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const run = { documents: [{ _id: 1 }], durationMs: 1, ranAt: now };
    act(() => {
      result.current.patchCollectionState('a', { lastRun: run });
      result.current.patchScriptState('s', {
        lastResult: { valueJson: '[1]', printBuffer: '', durationMs: 1 },
      });
    });

    await act(async () => {
      await result.current.openCollection({ connectionId: 'c1', dbName: 'db', collection: 'b' });
    });
    await act(async () => {
      await result.current.close('b');
    });

    const a = result.current.tabs.find((t) => t.id === 'a') as CollectionTab;
    const s = result.current.tabs.find((t) => t.id === 's') as ScriptTab;
    expect(a.state.lastRun).toEqual(run);
    expect(s.state.lastResult?.valueJson).toBe('[1]');
  });

  it('never sends result documents to main, and skips an update that carries nothing else', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async () => collectionTab('a'));
    installAtelierMock({
      tabs: {
        list: async () => [collectionTab('a')],
        update: update as unknown as import('@shared/ipc').IpcApi['tabs']['update'],
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.patchCollectionState('a', {
        lastRun: { documents: [{ _id: 1 }], durationMs: 1, ranAt: now },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(update).not.toHaveBeenCalled();

    act(() => {
      result.current.patchCollectionState('a', {
        page: 2,
        lastRun: { documents: [{ _id: 2 }], durationMs: 1, ranAt: now },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('a', { state: { page: 2 } });
  });
});

describe('useWorkspaceTabs — a refresh inside the debounce window', () => {
  const run = (id: number) => ({ documents: [{ _id: id }], durationMs: 1, ranAt: now });

  async function mount(listed: () => Array<CollectionTab | ScriptTab>, extra = {}) {
    vi.useFakeTimers();
    const update = vi.fn(async () => collectionTab('a'));
    installAtelierMock({
      tabs: {
        list: async () => listed(),
        openCollection: async () => collectionTab('b'),
        close: async () => ({ newActiveId: null }),
        update: update as unknown as import('@shared/ipc').IpcApi['tabs']['update'],
        ...extra,
      },
    });
    const hook = renderHook(() => useWorkspaceTabs());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.loading).toBe(false);
    return { ...hook, update };
  }

  it('keeps a page-forward run\'s page next to its documents, before and after the flush', async () => {
    const { result, update } = await mount(() => [collectionTab('a')]);
    act(() => {
      result.current.patchCollectionState('a', { lastRun: run(1) });
    });
    // page forward: new page and its documents, not yet flushed
    act(() => {
      result.current.patchCollectionState('a', { page: 1, lastRunHasMore: true, lastRun: run(2) });
    });

    // another tab opens: the list still carries page 0, as persisted
    await act(async () => {
      await result.current.openCollection({ connectionId: 'c1', dbName: 'db', collection: 'b' });
    });
    const a = () => result.current.tabs.find((t) => t.id === 'a') as CollectionTab;
    expect(a().state.page).toBe(1);
    expect(a().state.lastRunHasMore).toBe(true);
    expect(a().state.lastRun).toEqual(run(2));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(update).toHaveBeenCalledWith('a', { state: { page: 1, lastRunHasMore: true } });
    expect(a().state.page).toBe(1);
    expect(a().state.lastRun).toEqual(run(2));
  });

  it('keeps a patch whose flush fires while the list is still in flight', async () => {
    let releaseList: (tabs: CollectionTab[]) => void = () => undefined;
    let calls = 0;
    const { result, update } = await mount(() => [collectionTab('a')], {
      list: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([collectionTab('a')]);
        // dispatched before the flush; answers after it, without the patch
        return new Promise<CollectionTab[]>((resolve) => {
          releaseList = resolve;
        });
      },
    });
    act(() => {
      result.current.patchCollectionState('a', { page: 2 });
    });
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = result.current.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(update).toHaveBeenCalledWith('a', { state: { page: 2 } });
    await act(async () => {
      releaseList([collectionTab('a')]);
      await refreshing;
    });
    expect((result.current.tabs[0] as CollectionTab).state.page).toBe(2);
  });

  it('keeps every other pending field too: query text, aggregation stages, script source', async () => {
    const { result } = await mount(() => [collectionTab('a'), scriptTab('s')]);
    const stage = { id: 1, op: '$match', body: '{"x":1}', enabled: true };
    act(() => {
      result.current.patchCollectionState('a', { queryRaw: '{"x":1}' });
      result.current.patchAggregationState('a', { stages: [stage], lastRun: {
        rows: [{ x: 1 }], durationMs: 1, ranAt: now, stageCounts: {}, stageSamples: {},
      } });
      result.current.patchScriptState('s', { source: 'db.x.find()' });
    });

    await act(async () => {
      await result.current.close('b');
    });
    const a = result.current.tabs.find((t) => t.id === 'a') as CollectionTab;
    const s = result.current.tabs.find((t) => t.id === 's') as ScriptTab;
    expect(a.state.queryRaw).toBe('{"x":1}');
    expect(a.state.aggregation?.stages).toEqual([stage]);
    // the edited pipeline is the one the output belongs to, so it is kept
    expect(a.state.aggregation?.lastRun?.rows).toEqual([{ x: 1 }]);
    expect(s.state.source).toBe('db.x.find()');
  });

  it('openAggregation without a saved pipeline keeps a newer pending aggregation', async () => {
    const stage = { id: 1, op: '$match', body: '{"x":1}', enabled: true };
    const { result } = await mount(() => [collectionTab('a')], {
      openAggregation: async () => collectionTab('a'),
    });
    act(() => {
      result.current.patchAggregationState('a', { stages: [stage] });
    });
    await act(async () => {
      await result.current.openAggregation({ connectionId: 'c1', dbName: 'db', collection: 'a' });
    });
    const a = result.current.tabs[0] as CollectionTab;
    expect(a.state.aggregation?.stages).toEqual([stage]);
  });

  it('openAggregation with seeded stages drops the pending aggregation main just replaced (#156)', async () => {
    const stale = { id: 1, op: '$match', body: '{"x":1}', enabled: true };
    const { result } = await mount(() => [collectionTab('a')], {
      openAggregation: async () => collectionTab('a'),
    });
    act(() => {
      result.current.patchAggregationState('a', { stages: [stale] });
    });
    await act(async () => {
      await result.current.openAggregation({
        connectionId: 'c1',
        dbName: 'db',
        collection: 'a',
        initialState: { stages: [{ id: 1, op: '$limit', body: '5', enabled: true }] },
      });
    });
    const a = result.current.tabs[0] as CollectionTab;
    expect(a.state.aggregation?.stages).not.toEqual([stale]);
  });

  it('openAggregation drops a pending activeView main just overwrote', async () => {
    const { result, update } = await mount(() => [collectionTab('a')], {
      openAggregation: async () => collectionTab('a'),
    });
    act(() => {
      result.current.setActiveView('a', 'structure');
    });
    await act(async () => {
      await result.current.openAggregation({ connectionId: 'c1', dbName: 'db', collection: 'a' });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceTabs — openAggregation reseeding', () => {
  it('does not show the previous pipeline output under a pipeline main reseeded', async () => {
    const stage = { id: 1, op: '$match', body: '{}', enabled: true };
    const base = { stages: [stage], activeStageId: 1, outputHeight: 260, outputView: 'Tree' as const };
    const withAgg = (aggregation: typeof base & { name?: string; savedId?: string }) => {
      const tab = collectionTab('a');
      return { ...tab, state: { ...tab.state, aggregation } };
    };
    let listed = withAgg({ ...base });
    installAtelierMock({
      tabs: {
        list: async () => [listed],
        openAggregation: async () => {
          // main replaces `aggregation` with the seed of the loaded saved pipeline
          listed = withAgg({ ...base, stages: [{ ...stage, body: '{"x":1}' }], name: 'saved', savedId: 's1' });
          return listed;
        },
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const aggRun = {
      rows: [{ old: true }],
      durationMs: 1,
      ranAt: now,
      stageCounts: {},
      stageSamples: {},
    };
    act(() => {
      result.current.patchAggregationState('a', { lastRun: aggRun });
    });
    expect((result.current.tabs[0] as CollectionTab).state.aggregation?.lastRun).toEqual(aggRun);

    await act(async () => {
      await result.current.openAggregation({
        connectionId: 'c1',
        dbName: 'db',
        collection: 'a',
        savedId: 's1',
        name: 'saved',
      });
    });
    const agg = (result.current.tabs[0] as CollectionTab).state.aggregation;
    expect(agg?.savedId).toBe('s1');
    expect(agg?.lastRun).toBeUndefined();
  });
});
