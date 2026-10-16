import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queryObjects } from 'node:v8';
import type { IpcApi } from '@shared/ipc';
import { act, renderHook, waitFor } from '../helpers/render';
import { useQueryRunner } from '../../src/pages/Workspace/useQueryRunner';
import type { RunnerTarget } from '../../src/pages/Workspace/useQueryRunner';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState } from '@shared/types';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
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
    ...overrides,
  };
}

function makeTarget(stateOverrides: Partial<CollectionTabState> = {}): RunnerTarget {
  return {
    id: 't1',
    connectionId: 'c1',
    dbName: 'app',
    collection: 'users',
    state: makeState(stateOverrides),
  };
}

afterEach(() => {
  vi.useRealTimers();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('useQueryRunner', () => {
  it('success path: posts findResult into patchCollectionState as EJSON-aware documents', async () => {
    const documents = [
      { _id: { $oid: 'a'.repeat(24) }, name: 'alice' },
    ];
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents,
      durationMs: 12,
      hasMore: false,
    }));
    installAtelierMock({
      query: { find: findSpy, count: async () => ({ count: 1 }) },
    });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget(),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    // First patch is the lastRun update with the returned documents
    const lastRunCall = patch.mock.calls.find(
      (c) => c[1].lastRun !== undefined,
    );
    expect(lastRunCall).toBeDefined();
    expect(lastRunCall?.[1].lastRun.documents).toBe(documents);
    expect(lastRunCall?.[1].lastRun.durationMs).toBe(12);
    // EJSON sentinel survives unchanged (renderer parses at the wire edge,
    // not in the runner — sentinel objects pass through as-is).
    const sentinelDoc = lastRunCall?.[1].lastRun.documents[0] as { _id: { $oid: string } };
    expect(sentinelDoc._id.$oid).toBe('a'.repeat(24));
  });

  it('count side-fires after find and patches totalCount', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 5,
      hasMore: false,
    }));
    const countSpy = vi.fn(async () => ({ count: 42 }));
    installAtelierMock({
      query: { find: findSpy, count: countSpy },
    });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget(),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });
    // count is fire-and-forget — wait for the patch
    await waitFor(() => {
      const countCall = patch.mock.calls.find(
        (c) => c[1].totalCount !== undefined,
      );
      expect(countCall).toBeDefined();
      expect(countCall?.[1].totalCount).toBe(42);
    });
    expect(countSpy).toHaveBeenCalledTimes(1);
  });

  it('stale count from older run is ignored when a newer run completes first', async () => {
    // Two pending count promises: the first run's count resolves AFTER the
    // second run's count. Without the runToken guard, the late count would
    // clobber totalCount with the older value (1) instead of the newer (2).
    let resolveCount1: ((value: { count: number }) => void) | undefined;
    let resolveCount2: ((value: { count: number }) => void) | undefined;
    const countPromise1 = new Promise<{ count: number }>((res) => {
      resolveCount1 = res;
    });
    const countPromise2 = new Promise<{ count: number }>((res) => {
      resolveCount2 = res;
    });
    const countSpy = vi
      .fn<() => Promise<{ count: number }>>()
      .mockImplementationOnce(() => countPromise1)
      .mockImplementationOnce(() => countPromise2);
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 1,
      hasMore: false,
    }));
    installAtelierMock({
      query: { find: findSpy, count: countSpy },
    });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget(),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    // First run completes the find (count still pending).
    await act(async () => {
      await result.current.run();
    });
    // Second run completes the find (its count still pending too).
    await act(async () => {
      await result.current.run();
    });
    // Newer run's count resolves first → totalCount = 2.
    await act(async () => {
      resolveCount2!({ count: 2 });
      await countPromise2;
    });
    // Older run's count resolves later → must be discarded.
    await act(async () => {
      resolveCount1!({ count: 1 });
      await countPromise1;
    });

    const totalPatches = patch.mock.calls.filter(
      (c) => c[1].totalCount !== undefined,
    );
    expect(totalPatches.length).toBe(1);
    expect(totalPatches[0][1].totalCount).toBe(2);
  });

  it('a run for a different target does not discard this target\'s own pending count', async () => {
    // runTokenRef used to be a single global counter — starting target B's
    // run bumped it, so target A's still-in-flight count failed its
    // freshness check even though nothing about A itself went stale.
    let resolveCountA: ((value: { count: number }) => void) | undefined;
    const countPromiseA = new Promise<{ count: number }>((res) => {
      resolveCountA = res;
    });
    const countSpy = vi
      .fn<() => Promise<{ count: number }>>()
      .mockImplementationOnce(() => countPromiseA)
      .mockImplementationOnce(async () => ({ count: 99 }));
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 1,
      hasMore: false,
    }));
    installAtelierMock({
      query: { find: findSpy, count: countSpy },
    });

    const patch = vi.fn();
    const targetA = makeTarget(); // 't1'
    const targetB = { ...makeTarget(), id: 't2' };
    const { result } = renderHook(() =>
      useQueryRunner({
        active: targetA,
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    // A's run starts: find resolves, count stays pending.
    await act(async () => {
      await result.current.run();
    });
    // B's run starts and fully resolves (find + count) before A's count does.
    await act(async () => {
      await result.current.run(undefined, targetB);
    });

    expect(countSpy).toHaveBeenCalledTimes(2);
    const bTotalPatch = patch.mock.calls.find(
      (c) => c[0] === 't2' && c[1].totalCount !== undefined,
    );
    expect(bTotalPatch?.[1].totalCount).toBe(99);

    // A's count finally resolves — must still land, not be discarded.
    await act(async () => {
      resolveCountA!({ count: 7 });
      await countPromiseA;
    });

    const aTotalPatch = patch.mock.calls.find(
      (c) => c[0] === 't1' && c[1].totalCount !== undefined,
    );
    expect(aTotalPatch).toBeDefined();
    expect(aTotalPatch?.[1].totalCount).toBe(7);
  });

  it('error path: writes lastRun.error and keeps previous documents visible', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => {
      throw Object.assign(new Error('boom'), { code: 'INTERNAL' });
    });
    installAtelierMock({
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    const previousDocs = [{ _id: 'old' }];
    const patch = vi.fn();
    const target = makeTarget({
      lastRun: {
        documents: previousDocs,
        durationMs: 1,
        ranAt: new Date().toISOString(),
      },
    });
    const { result } = renderHook(() =>
      useQueryRunner({
        active: target,
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    const errCall = patch.mock.calls.find((c) => c[1].lastRun?.error);
    expect(errCall).toBeDefined();
    expect(errCall?.[1].lastRun.error.code).toBe('INTERNAL');
    // Stale docs remain visible per W06 §5.
    expect(errCall?.[1].lastRun.documents).toBe(previousDocs);
  });

  it('cancel aborts the in-flight find via api.query.cancel and returns to idle without touching lastRun', async () => {
    let rejectFind: ((err: unknown) => void) | undefined;
    const findPromise = new Promise<never>((_res, rej) => {
      rejectFind = rej;
    });
    const findSpy = vi.fn<IpcApi['query']['find']>(() => findPromise);
    const cancelSpy = vi.fn(async () => {});
    installAtelierMock({
      query: { find: findSpy, count: async () => ({ count: 0 }), cancel: cancelSpy },
    });

    const previousDocs = [{ _id: 'old' }];
    const patch = vi.fn();
    const target = makeTarget({
      lastRun: { documents: previousDocs, durationMs: 1, ranAt: new Date().toISOString() },
    });
    const { result } = renderHook(() =>
      useQueryRunner({ active: target, patchCollectionState: patch, loadingDelayMs: 0 }),
    );

    let runPromise: Promise<void> = Promise.resolve();
    act(() => {
      runPromise = result.current.run();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    const [{ cancelToken }] = findSpy.mock.calls[0];
    act(() => {
      result.current.cancel();
    });

    expect(cancelSpy).toHaveBeenCalledWith({ token: cancelToken });
    expect(result.current.isLoading).toBe(false);

    // The aborted find rejecting afterwards must not surface as an error —
    // this run was disowned the instant cancel() fired.
    await act(async () => {
      rejectFind!(Object.assign(new Error('aborted'), { code: 'INTERNAL' }));
      await runPromise;
    });
    expect(patch.mock.calls.some((c) => c[1].lastRun !== undefined)).toBe(false);
  });

  it('a newer run supersedes an older in-flight one: cancels it and its late result is discarded', async () => {
    let resolveFind1: ((v: { documents: unknown[]; durationMs: number; hasMore: boolean }) => void) | undefined;
    const find1 = new Promise<{ documents: unknown[]; durationMs: number; hasMore: boolean }>((res) => {
      resolveFind1 = res;
    });
    const findSpy = vi
      .fn<IpcApi['query']['find']>()
      .mockImplementationOnce(() => find1)
      .mockImplementationOnce(async () => ({ documents: [{ _id: 'new' }], durationMs: 2, hasMore: false }));
    const cancelSpy = vi.fn(async () => {});
    installAtelierMock({
      query: { find: findSpy, count: async () => ({ count: 0 }), cancel: cancelSpy },
    });

    const patch = vi.fn();
    const target = makeTarget();
    const { result } = renderHook(() =>
      useQueryRunner({ active: target, patchCollectionState: patch, loadingDelayMs: 0 }),
    );

    let firstRun: Promise<void> = Promise.resolve();
    act(() => {
      firstRun = result.current.run();
    });
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    const firstToken = findSpy.mock.calls[0][0].cancelToken;

    // A second run fires while the first is still in flight — it must
    // cancel the first server-side and not be blocked by it.
    await act(async () => {
      await result.current.run();
    });
    expect(cancelSpy).toHaveBeenCalledWith({ token: firstToken });
    expect(findSpy).toHaveBeenCalledTimes(2);
    const newestPatch = patch.mock.calls.findLast((c) => c[1].lastRun !== undefined);
    expect(newestPatch?.[1].lastRun.documents).toEqual([{ _id: 'new' }]);

    // The stale first find finally resolves — it must not overwrite the
    // newer run's result.
    await act(async () => {
      resolveFind1!({ documents: [{ _id: 'stale' }], durationMs: 1, hasMore: false });
      await firstRun;
    });
    const finalPatch = patch.mock.calls.findLast((c) => c[1].lastRun !== undefined);
    expect(finalPatch?.[1].lastRun.documents).toEqual([{ _id: 'new' }]);
  });

  it('cancel is a no-op when nothing is running', async () => {
    const cancelSpy = vi.fn(async () => {});
    installAtelierMock({
      query: { find: async () => ({ documents: [], durationMs: 0, hasMore: false }), cancel: cancelSpy },
    });
    const { result } = renderHook(() =>
      useQueryRunner({ active: makeTarget(), patchCollectionState: vi.fn(), loadingDelayMs: 0 }),
    );

    act(() => result.current.cancel());

    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('pagination override merges into state — page used by skip computation', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 3,
      hasMore: false,
    }));
    installAtelierMock({
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    const patch = vi.fn();
    const target = makeTarget({ page: 0, pageSize: 50 });
    const { result } = renderHook(() =>
      useQueryRunner({
        active: target,
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      // Page 3 override — skip should be 3 * 50 = 150, even though target's
      // state still says page=0.
      await result.current.run({ page: 3 });
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(findSpy.mock.calls[0][0].skip).toBe(150);
    expect(findSpy.mock.calls[0][0].limit).toBe(50);
  });

  it('past-cap short-circuit: limit=0 skips the find and patches empty result', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    installAtelierMock({
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    const patch = vi.fn();
    // userLimit=10 with page=1, pageSize=50 → skip=50 > 10 → past cap.
    const target = makeTarget({
      page: 1,
      pageSize: 50,
      builder: {
        projection: [],
        sort: '',
        limit: '10',
      },
    });
    const { result } = renderHook(() =>
      useQueryRunner({
        active: target,
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(findSpy).not.toHaveBeenCalled();
    const emptyCall = patch.mock.calls.find(
      (c) => c[1].lastRun?.documents?.length === 0 && c[1].totalCount === 10,
    );
    expect(emptyCall).toBeDefined();
  });

  describe('plan side-fire (plan badge)', () => {
    const plan = { queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: 'a_1' } } };

    it('explains a successful find once at queryPlanner and patches lastRun.plan', async () => {
      const documents = [{ _id: 1 }];
      const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({ plan, verbosity: 'queryPlanner' }));
      installAtelierMock({
        query: {
          find: async () => ({ documents, durationMs: 4, hasMore: false }),
          count: async () => ({ count: 1 }),
          explain: explainSpy,
        },
      });
      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({
          active: makeTarget({
            queryRaw: '{"a":1}',
            builder: { projection: [], sort: '{"b":-1}', limit: '', projectionRaw: '{"a":1}' },
          }),
          patchCollectionState: patch,
          loadingDelayMs: 0,
        }),
      );

      await act(async () => {
        await result.current.run();
      });

      await waitFor(() => {
        const planned = patch.mock.calls.find((c) => c[1].lastRun?.plan !== undefined);
        expect(planned?.[1].lastRun.plan).toBe(plan);
        // The plan rides on the same run's result, not a fresh blank one.
        expect(planned?.[1].lastRun.documents).toBe(documents);
        expect(planned?.[1].lastRun.durationMs).toBe(4);
      });
      expect(explainSpy).toHaveBeenCalledTimes(1);
      expect(explainSpy).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'app',
        collection: 'users',
        filter: '{"a":1}',
        sort: '{"b":-1}',
        projection: '{"a":1}',
        verbosity: 'queryPlanner',
      });
    });

    it('does not delay the documents or the count behind the explain', async () => {
      installAtelierMock({
        query: {
          find: async () => ({ documents: [], durationMs: 1, hasMore: false }),
          count: async () => ({ count: 9 }),
          explain: () => new Promise<never>(() => {}),
        },
      });
      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({ active: makeTarget(), patchCollectionState: patch, loadingDelayMs: 0 }),
      );

      await act(async () => {
        await result.current.run();
      });

      await waitFor(() =>
        expect(patch.mock.calls.some((c) => c[1].totalCount === 9)).toBe(true),
      );
      expect(patch.mock.calls.some((c) => c[1].lastRun?.documents !== undefined)).toBe(true);
    });

    it('a rejected explain leaves the documents patched, with no plan and no error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      installAtelierMock({
        query: {
          find: async () => ({ documents: [{ _id: 1 }], durationMs: 4, hasMore: false }),
          count: async () => ({ count: 1 }),
          explain: async () => {
            throw new Error('explain refused');
          },
        },
      });
      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({ active: makeTarget(), patchCollectionState: patch, loadingDelayMs: 0 }),
      );

      await act(async () => {
        await result.current.run();
      });

      await waitFor(() => expect(warn).toHaveBeenCalled());
      const runs = patch.mock.calls.filter((c) => c[1].lastRun !== undefined);
      expect(runs).toHaveLength(1);
      expect(runs[0][1].lastRun.documents).toEqual([{ _id: 1 }]);
      expect(runs[0][1].lastRun.plan).toBeUndefined();
      expect(runs[0][1].lastRun.error).toBeUndefined();
    });

    it('a run superseded before its explain resolves never patches that stale plan', async () => {
      let resolveExplain1: ((v: { plan: unknown; verbosity: string }) => void) | undefined;
      const explain1 = new Promise<{ plan: unknown; verbosity: string }>((res) => {
        resolveExplain1 = res;
      });
      const explainSpy = vi
        .fn<IpcApi['query']['explain']>()
        .mockImplementationOnce(() => explain1)
        .mockImplementationOnce(async () => ({
          plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
          verbosity: 'queryPlanner',
        }));
      installAtelierMock({
        query: {
          find: async () => ({ documents: [], durationMs: 1, hasMore: false }),
          count: async () => ({ count: 0 }),
          explain: explainSpy,
        },
      });
      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({ active: makeTarget(), patchCollectionState: patch, loadingDelayMs: 0 }),
      );

      await act(async () => {
        await result.current.run();
      });
      await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(1));
      await act(async () => {
        await result.current.run();
      });
      await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(2));

      await act(async () => {
        resolveExplain1!({ plan, verbosity: 'queryPlanner' });
        await explain1;
      });
      const planPatches = patch.mock.calls.filter((c) => c[1].lastRun?.plan !== undefined);
      expect(planPatches).toHaveLength(1);
      expect(planPatches[0][1].lastRun.plan).not.toBe(plan);
    });

    it('keeps run N\'s plan when the run that followed it was cancelled before it wrote anything', async () => {
      let resolveExplain1: ((v: { plan: unknown; verbosity: string }) => void) | undefined;
      const explain1 = new Promise<{ plan: unknown; verbosity: string }>((res) => {
        resolveExplain1 = res;
      });
      const explainSpy = vi.fn<IpcApi['query']['explain']>().mockImplementationOnce(() => explain1);
      const documents = [{ _id: 1 }];
      const findSpy = vi
        .fn<IpcApi['query']['find']>()
        .mockImplementationOnce(async () => ({ documents, durationMs: 1, hasMore: false }))
        .mockImplementationOnce(() => new Promise<never>(() => {}));
      installAtelierMock({
        query: { find: findSpy, count: async () => ({ count: 1 }), explain: explainSpy, cancel: async () => {} },
      });
      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({ active: makeTarget(), patchCollectionState: patch, loadingDelayMs: 0 }),
      );

      await act(async () => {
        await result.current.run();
      });
      await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(1));
      // Run N+1 starts (its find never settles) and is cancelled: it wrote no lastRun.
      act(() => {
        void result.current.run();
      });
      await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(2));
      act(() => result.current.cancel());

      await act(async () => {
        resolveExplain1!({ plan, verbosity: 'queryPlanner' });
        await explain1;
      });

      const planned = patch.mock.calls.filter((c) => c[1].lastRun?.plan === plan);
      expect(planned).toHaveLength(1);
      expect(planned[0][1].lastRun.documents).toBe(documents);
    });

    // Shared by the page-change tests below: a runner whose first run has
    // fully landed (documents, then its plan) before the next run starts.
    async function runnerAfterFirstRun(explainImpl?: IpcApi['query']['explain']) {
      const explainSpy = vi.fn<IpcApi['query']['explain']>(
        explainImpl ?? (async () => ({ plan, verbosity: 'queryPlanner' })),
      );
      installAtelierMock({
        query: {
          find: async () => ({ documents: [{ _id: 1 }], durationMs: 1, hasMore: false }),
          count: async () => ({ count: 0 }),
          explain: explainSpy,
        },
      });
      const patch = vi.fn();
      const target = makeTarget({ queryRaw: '{"a":1}' });
      const { result, rerender } = renderHook(
        ({ active }) => useQueryRunner({ active, patchCollectionState: patch, loadingDelayMs: 0 }),
        { initialProps: { active: target } },
      );
      await act(async () => {
        await result.current.run();
      });
      return { explainSpy, patch, target, result, rerender };
    }
    const planPatches = (patch: ReturnType<typeof vi.fn>) =>
      patch.mock.calls.filter((c) => c[1].lastRun?.plan === plan);

    it('does not explain again on a page change, and the new page keeps the plan badge', async () => {
      const { explainSpy, patch, result } = await runnerAfterFirstRun();
      await waitFor(() => expect(planPatches(patch)).toHaveLength(1));

      await act(async () => {
        await result.current.run({ page: 2 });
      });

      expect(explainSpy).toHaveBeenCalledTimes(1);
      // The page's own result carries the plan from the start, not a badge-less gap.
      expect(planPatches(patch)).toHaveLength(2);
    });

    it('does not explain again when only the page size changes', async () => {
      const { explainSpy, patch, result } = await runnerAfterFirstRun();
      await waitFor(() => expect(planPatches(patch)).toHaveLength(1));

      await act(async () => {
        await result.current.run({ pageSize: 25, page: 0 });
      });

      expect(explainSpy).toHaveBeenCalledTimes(1);
      expect(planPatches(patch)).toHaveLength(2);
    });

    it('explains again on an explicit Run of the same query', async () => {
      const { explainSpy, patch, result } = await runnerAfterFirstRun();
      await waitFor(() => expect(planPatches(patch)).toHaveLength(1));

      await act(async () => {
        await result.current.run();
      });

      await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(2));
    });

    it('explains a page change again while the first plan has not arrived', async () => {
      const { explainSpy, result } = await runnerAfterFirstRun(() => new Promise<never>(() => {}));

      await act(async () => {
        await result.current.run({ page: 2 });
      });

      await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(2));
    });

    // A page change reads the tab's current query, which may differ from the
    // one last explained (edited since, not yet Run).
    it.each([
      ['filter', { queryRaw: '{"a":2}' }],
      ['sort', { queryRaw: '{"a":1}', builder: { projection: [], sort: '{"b":1}', limit: '' } }],
      ['projection', { queryRaw: '{"a":1}', builder: { projection: [], sort: '', limit: '', projectionRaw: '{"a":1}' } }],
      ['limit', { queryRaw: '{"a":1}', builder: { projection: [], sort: '', limit: '100' } }],
    ] as [string, Partial<CollectionTabState>][])(
      'explains a page change again when the %s differs from the explained query',
      async (_, state) => {
        const { explainSpy, patch, result, rerender } = await runnerAfterFirstRun();
        await waitFor(() => expect(planPatches(patch)).toHaveLength(1));
        rerender({ active: makeTarget(state) });

        await act(async () => {
          await result.current.run({ page: 1 });
        });

        await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(2));
      },
    );

    it('explains again when the filter changes together with the page', async () => {
      const { explainSpy, patch, result } = await runnerAfterFirstRun();
      await waitFor(() => expect(planPatches(patch)).toHaveLength(1));

      await act(async () => {
        await result.current.run({ queryRaw: '{"a":2}', page: 1 });
      });

      await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(2));
    });

    it('explains again for another collection on a page change', async () => {
      const { explainSpy, patch, target, result } = await runnerAfterFirstRun();
      await waitFor(() => expect(planPatches(patch)).toHaveLength(1));

      await act(async () => {
        await result.current.run({ page: 1 }, { ...target, collection: 'orders' });
      });

      await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(2));
      expect(explainSpy.mock.calls[1][0].collection).toBe('orders');
    });

    it('does not explain on the past-cap short-circuit', async () => {
      const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({ plan, verbosity: 'queryPlanner' }));
      installAtelierMock({
        query: {
          find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
          count: async () => ({ count: 0 }),
          explain: explainSpy,
        },
      });
      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({
          active: makeTarget({
            page: 1,
            pageSize: 50,
            builder: { projection: [], sort: '', limit: '10' },
          }),
          patchCollectionState: patch,
          loadingDelayMs: 0,
        }),
      );

      await act(async () => {
        await result.current.run();
      });

      expect(explainSpy).not.toHaveBeenCalled();
    });

    it('does not explain a refused filter or a failed find', async () => {
      const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({ plan, verbosity: 'queryPlanner' }));
      installAtelierMock({
        query: {
          find: async () => {
            throw Object.assign(new Error('nope'), { code: 'INTERNAL' });
          },
          count: async () => ({ count: 0 }),
          explain: explainSpy,
        },
      });
      const patch = vi.fn();
      const refused = renderHook(() =>
        useQueryRunner({
          active: makeTarget({ queryRaw: 'not json' }),
          patchCollectionState: patch,
          loadingDelayMs: 0,
        }),
      );
      await act(async () => {
        await refused.result.current.run();
      });
      const failed = renderHook(() =>
        useQueryRunner({ active: makeTarget(), patchCollectionState: patch, loadingDelayMs: 0 }),
      );
      await act(async () => {
        await failed.result.current.run();
      });

      expect(explainSpy).not.toHaveBeenCalled();
    });
  });

  it('records a session event with queryRunKey when a recorder is supplied', async () => {
    installAtelierMock({
      query: {
        find: async () => ({ documents: [], durationMs: 5, hasMore: false }),
        count: async () => ({ count: 0 }),
      },
    });

    const patch = vi.fn();
    const recordEvent = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget(),
        patchCollectionState: patch,
        recordSessionEvent: recordEvent,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0][0]).toBe('queryRun');
    expect(typeof recordEvent.mock.calls[0][1]).toBe('string');
  });

  it('no-op when target is null', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: null,
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });
    expect(findSpy).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  // X14 §2. The textarea's blur covers the surfaces with a box to
  // leave; this covers the Run paths that have none — auto-run on tab open,
  // the palette's `query.run`, post-write re-runs — which is what makes
  // "`queryRaw` never holds Shell Syntax after a blur *or a Run*" true rather
  // than nearly true.
  it('repairs Shell Syntax on a run with no textarea to blur', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 1,
      hasMore: false,
    }));
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget({ queryRaw: '{age: {$gt: 60}}' }),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    // The repaired text both reached Mongo and was written back to the tab.
    expect(findSpy.mock.calls[0]?.[0].filter).toBe('{"age": {"$gt": 60}}');
    expect(patch.mock.calls.some((c) => c[1].queryRaw === '{"age": {"$gt": 60}}')).toBe(true);
  });

  it('leaves a strictly-parsing filter untouched on a run', async () => {
    const HAND_ARRANGED = '{ "b" : 1,   "a" : 2 }';
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 1,
      hasMore: false,
    }));
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget({ queryRaw: HAND_ARRANGED }),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(findSpy.mock.calls[0]?.[0].filter).toBe(HAND_ARRANGED);
    expect(patch.mock.calls.some((c) => c[1].queryRaw !== undefined)).toBe(false);
  });

  // X14 §3 — the second of the two layers. The button gate judges
  // what the blur committed; this judges what it just repaired, and both run
  // `sortProblem` / `projectionProblem` on post-repair text, so the two can't
  // disagree. Covers the paths with no field to blur: auto-run on tab open,
  // the palette's `query.run`, post-write re-runs.
  it('repairs a Shell Syntax sort and raw projection on a run with no field to blur', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 1,
      hasMore: false,
    }));
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget({
          builder: { projection: [], sort: '{name: 1}', limit: '', projectionRaw: '{_id: 0}' },
        }),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(findSpy.mock.calls[0]?.[0].sort).toBe('{"name": 1}');
    expect(findSpy.mock.calls[0]?.[0].projection).toBe('{"_id": 0}');
    // One patch carrying both, not one per field — `patchCollectionState` is
    // not a functional updater, so a second call in the same tick would
    // clobber the first.
    const builderPatch = patch.mock.calls.find((c) => c[1].builder !== undefined)?.[1].builder;
    expect(builderPatch).toMatchObject({ sort: '{"name": 1}', projectionRaw: '{"_id": 0}' });
  });

  it('leaves a strictly-parsing sort and raw projection untouched on a run', async () => {
    const HAND_SORT = '{ "b" : 1,   "a" : 2 }';
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 1,
      hasMore: false,
    }));
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget({
          builder: { projection: [], sort: HAND_SORT, limit: '', projectionRaw: '{"_id":0}' },
        }),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(findSpy.mock.calls[0]?.[0].sort).toBe(HAND_SORT);
    expect(patch.mock.calls.some((c) => c[1].builder !== undefined)).toBe(false);
  });

  // Blank stays blank: the transform reports empty input as `failed`, which
  // must commit nothing rather than read as an error.
  // Review finding — the in-flight guard used to be a single boolean shared by
  // every target. A pinned drawer's post-write refresh of tab A (explicit
  // target) would silently no-op whenever the focused tab B happened to have
  // its own find in flight.
  it('an explicit-target refresh is not blocked by another target already in flight', async () => {
    let resolveFindB: ((v: Awaited<ReturnType<IpcApi['query']['find']>>) => void) | undefined;
    const pendingFindB = new Promise<Awaited<ReturnType<IpcApi['query']['find']>>>((res) => {
      resolveFindB = res;
    });
    const findSpy = vi
      .fn<IpcApi['query']['find']>()
      .mockImplementationOnce(() => pendingFindB)
      .mockImplementationOnce(async () => ({ documents: [], durationMs: 1, hasMore: false }));
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const targetA = makeTarget(); // 't1' — the pinned drawer's target
    const targetB = { ...makeTarget(), id: 't2' };

    const { result } = renderHook(() =>
      useQueryRunner({ active: targetB, patchCollectionState: patch, loadingDelayMs: 0 }),
    );

    // B's own run starts (implicitly, via `active`) and stays in flight.
    let runBPromise: Promise<void> = Promise.resolve();
    act(() => {
      runBPromise = result.current.run();
    });

    // A's explicit-target refresh must still execute while B is running.
    await act(async () => {
      await result.current.run(undefined, targetA);
    });

    expect(findSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFindB!({ documents: [], durationMs: 1, hasMore: false });
      await runBPromise;
    });
  });

  // Review finding — `isLoading` used to be one flag shared by every target. A
  // background refresh of an unfocused tab would flip the focused tab's
  // loading overlay even though the focused tab wasn't running anything.
  it('isLoading stays scoped to the active target', async () => {
    let resolveFind: ((v: Awaited<ReturnType<IpcApi['query']['find']>>) => void) | undefined;
    const pending = new Promise<Awaited<ReturnType<IpcApi['query']['find']>>>((res) => {
      resolveFind = res;
    });
    const findSpy = vi.fn<IpcApi['query']['find']>(() => pending);
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const targetA = makeTarget(); // 't1' — background target (pinned drawer)
    const targetB = { ...makeTarget(), id: 't2' }; // focused tab

    const { result, rerender } = renderHook(
      ({ active }: { active: RunnerTarget }) =>
        useQueryRunner({ active, patchCollectionState: patch, loadingDelayMs: 0 }),
      { initialProps: { active: targetB } },
    );

    let runPromise: Promise<void> = Promise.resolve();
    act(() => {
      runPromise = result.current.run(undefined, targetA);
    });
    // Let the 0ms loading-delay timer fire for A's run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // B is focused and idle — must not show loading for A's background run.
    expect(result.current.isLoading).toBe(false);

    // Focus moves to A — the same in-flight run now reads as loading.
    rerender({ active: targetA });
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveFind!({ documents: [], durationMs: 1, hasMore: false });
      await runPromise;
    });
  });

  it('does not patch a blank sort or an absent raw projection on a run', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 1,
      hasMore: false,
    }));
    installAtelierMock({ query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const patch = vi.fn();
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget(),
        patchCollectionState: patch,
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(findSpy.mock.calls[0]?.[0].sort).toBeUndefined();
    expect(patch.mock.calls.some((c) => c[1].builder !== undefined)).toBe(false);
  });

  // A successful run fire-and-forgets the filter's conditions
  // to `recent:recordFieldValues` for the value-suggestion popover.
  describe('value-suggestion recording', () => {
    it('records a scalar $eq condition after a successful run', async () => {
      const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
        documents: [],
        durationMs: 1,
        hasMore: false,
      }));
      const recordFieldValues = vi.fn(async () => ({ recorded: 1 }));
      installAtelierMock({
        query: { find: findSpy, count: async () => ({ count: 0 }) },
        recent: { recordFieldValues: recordFieldValues as never } as never,
      });

      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({
          active: makeTarget({ queryRaw: '{"status":{"$eq":"shipped"}}' }),
          patchCollectionState: patch,
          loadingDelayMs: 0,
        }),
      );

      await act(async () => {
        await result.current.run();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(recordFieldValues).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'app',
        collection: 'users',
        entries: [{ field: 'status', value: 'shipped', valType: 'string', op: '$eq' }],
      });
    });

    it('splits an $in condition element-wise and drops an empty element', async () => {
      const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
        documents: [],
        durationMs: 1,
        hasMore: false,
      }));
      const recordFieldValues = vi.fn(async () => ({ recorded: 1 }));
      installAtelierMock({
        query: { find: findSpy, count: async () => ({ count: 0 }) },
        recent: { recordFieldValues: recordFieldValues as never } as never,
      });

      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({
          active: makeTarget({ queryRaw: '{"tags":{"$in":["","x"]}}' }),
          patchCollectionState: patch,
          loadingDelayMs: 0,
        }),
      );

      await act(async () => {
        await result.current.run();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(recordFieldValues).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'app',
        collection: 'users',
        entries: [{ field: 'tags', value: 'x', valType: 'string', op: '$in' }],
      });
    });

    it('does not call recordFieldValues when the filter has no recordable condition', async () => {
      const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
        documents: [],
        durationMs: 1,
        hasMore: false,
      }));
      const recordFieldValues = vi.fn(async () => ({ recorded: 0 }));
      installAtelierMock({
        query: { find: findSpy, count: async () => ({ count: 0 }) },
        recent: { recordFieldValues: recordFieldValues as never } as never,
      });

      const patch = vi.fn();
      const { result } = renderHook(() =>
        useQueryRunner({
          active: makeTarget({ queryRaw: '{"tags":{"$exists":true}}' }),
          patchCollectionState: patch,
          loadingDelayMs: 0,
        }),
      );

      await act(async () => {
        await result.current.run();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(recordFieldValues).not.toHaveBeenCalled();
    });
  });

  // Workspace keeps one runner mounted for every tab, so whatever it keeps
  // per tab outlives the tab. Its record of the last result written must not
  // hold that result's documents, or each closed tab leaves a page behind.
  it('keeps no result documents alive once the run has been written', async () => {
    class ResultRow {}
    installAtelierMock({
      query: {
        find: async () => ({ documents: [new ResultRow(), new ResultRow()], durationMs: 1, hasMore: false }),
        count: async () => ({ count: 2 }),
        explain: async () => ({ plan: {}, verbosity: 'queryPlanner' }),
      },
    });
    let written = 0;
    const { result } = renderHook(() =>
      useQueryRunner({
        active: makeTarget(),
        // Counts the writes without keeping them, so only the runner can hold a row.
        patchCollectionState: (_id, p) => {
          if (p.lastRun) written++;
        },
        loadingDelayMs: 0,
      }),
    );

    await act(async () => {
      await result.current.run();
    });
    // The result, then the same result with its plan.
    await waitFor(() => expect(written).toBe(2));

    expect(queryObjects(ResultRow, { format: 'count' })).toBe(0);
  });
});
