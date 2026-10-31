import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '../helpers/render';
import { ObjectId } from 'bson';
import { useReferenceDrawer } from '../../src/pages/Workspace/useReferenceDrawer';
import { ejsonParse, ejsonStringify } from '../../src/utils/ejson';
import type { IpcApi } from '@shared/ipc';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type {
  CollectionTab,
  CollectionTabState,
  PersistedReferenceFrame,
  ReferenceRule,
  WorkspaceTab,
} from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const RULE: ReferenceRule = {
  id: 'r1',
  connectionId: 'c1',
  sourceDb: 'app',
  sourceCollection: 'orders',
  sourceField: 'userId',
  targetDb: 'app',
  targetCollection: 'users',
  targetField: '_id',
  projection: [],
  displayTemplate: undefined,
  enabled: true,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
};

function makeCollectionTab(
  id: string,
  persistedStack: PersistedReferenceFrame[] = [],
  isActive = true,
): CollectionTab {
  return {
    id,
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'app',
    collection: 'orders',
    position: 0,
    isActive,
    openedAt: '2026-04-21T12:00:00.000Z',
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
      referenceDrawer:
        persistedStack.length > 0 ? { stack: persistedStack } : undefined,
    },
  };
}

/**
 * Regression test for P0-2 (REVIEW-2026-05-12):
 *   useReferenceDrawer previously persisted `value` via `JSON.stringify`
 *   and restored via `JSON.parse`, both at the frame layer and inside
 *   `handleRefHover`. The bug: restored frames lost BSON instance
 *   identity — an ObjectId in the original frame came back as a plain
 *   `{$oid:string}` object, which breaks downstream `instanceof` checks
 *   and any code that calls methods on the typed value. The fix uses
 *   `ejsonParse` / `ejsonStringify` everywhere so the persist→restore
 *   cycle preserves BSON instances.
 */
describe('useReferenceDrawer — EJSON persistence round-trip', () => {
  it('restores a persisted frame as an ObjectId instance, not a plain object', async () => {
    installAtelierMock();
    const oid = new ObjectId('64a7f0e1b1d4e8f2c3a45678');
    const persistedFrame: PersistedReferenceFrame = {
      id: 'frame-1',
      rule: RULE,
      valueEjson: ejsonStringify(oid),
      label: 'userId',
    };
    const tab = makeCollectionTab('t1', [persistedFrame]);
    const tabs: WorkspaceTab[] = [tab];
    const patchCollectionState = vi.fn();

    const { result } = renderHook(() =>
      useReferenceDrawer('t1', tabs, patchCollectionState, 't1'),
    );

    expect(result.current.refStack).toHaveLength(1);
    expect(result.current.refStack[0]!.value).toBeInstanceOf(ObjectId);
    expect((result.current.refStack[0]!.value as ObjectId).toHexString()).toBe(
      oid.toHexString(),
    );
  });

  it('drops a frame whose stored value is corrupt, keeps the rest, and logs it without the value', async () => {
    const log = vi.fn<IpcApi['app']['log']>(async () => undefined);
    installAtelierMock({ app: { log } });
    const good: PersistedReferenceFrame = { id: 'ok', rule: RULE, valueEjson: ejsonStringify('fine'), label: 'a' };
    const bad: PersistedReferenceFrame = { id: 'bad', rule: RULE, valueEjson: '{"secret": ', label: 'b' };
    const tabs: WorkspaceTab[] = [makeCollectionTab('t1', [bad, good])];

    const { result } = renderHook(() => useReferenceDrawer('t1', tabs, vi.fn(), 't1'));

    expect(result.current.refStack.map((f) => f.id)).toEqual(['ok']);
    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0]!;
    expect(line.level).toBe('warn');
    expect(line.message).toContain('rule r1');
    expect(line.message).not.toContain('secret');
  });

  it('persists a pushed ObjectId frame as canonical EJSON (round-trips back to ObjectId)', async () => {
    installAtelierMock();
    const oid = new ObjectId('64a7f0e1b1d4e8f2c3a45679');
    const tab = makeCollectionTab('t1');
    const tabs: WorkspaceTab[] = [tab];
    const patchCollectionState = vi.fn();

    const { result } = renderHook(() =>
      useReferenceDrawer('t1', tabs, patchCollectionState, 't1'),
    );

    // Push a frame whose `value` is a live ObjectId instance.
    act(() => {
      result.current.handleRefOpen(RULE, 'userId', oid);
    });

    // The persist effect fires when refStack changes (after the initial
    // restore-skip). It calls patchCollectionState with the serialized
    // stack.
    expect(patchCollectionState).toHaveBeenCalled();
    const lastCall = patchCollectionState.mock.calls.at(-1)!;
    const patch = lastCall[1] as Partial<CollectionTabState>;
    const persisted = patch.referenceDrawer?.stack ?? [];
    expect(persisted).toHaveLength(1);

    // Round-trip the persisted valueEjson back through ejsonParse — it
    // must come back as a true ObjectId instance.
    const back = ejsonParse(persisted[0]!.valueEjson);
    expect(back).toBeInstanceOf(ObjectId);
    expect((back as ObjectId).toHexString()).toBe(oid.toHexString());
  });

  it('skips a persisted frame whose valueEjson is unparseable, keeps the rest', async () => {
    installAtelierMock();
    const oid = new ObjectId('64a7f0e1b1d4e8f2c3a45680');
    const persisted: PersistedReferenceFrame[] = [
      { id: 'bad', rule: RULE, valueEjson: '{not valid', label: 'broken' },
      { id: 'good', rule: RULE, valueEjson: ejsonStringify(oid), label: 'userId' },
    ];
    const tab = makeCollectionTab('t1', persisted);
    const { result } = renderHook(() =>
      useReferenceDrawer('t1', [tab], vi.fn(), 't1'),
    );

    expect(result.current.refStack).toHaveLength(1);
    expect(result.current.refStack[0]!.id).toBe('good');
    expect(result.current.refStack[0]!.value).toBeInstanceOf(ObjectId);
  });

  /**
   * Regression test for P1-5 (REVIEW-2026-05-12):
   *   The persist effect used to omit `activeCollectionId` from its dep
   *   array and capture it via closure. A tab-switch between refStack
   *   mutation and effect firing could persist the new tab's stack to the
   *   previous tab's state_json. The fix reads activeCollectionId from a
   *   ref synced via a separate effect, so persist always uses the latest
   *   value.
   */
  it('persists to the current activeCollectionId even after a tab switch (P1-5)', () => {
    installAtelierMock();
    const oidA = new ObjectId('64a7f0e1b1d4e8f2c3a45681');
    const oidB = new ObjectId('64a7f0e1b1d4e8f2c3a45682');
    const tabA = makeCollectionTab('t1');
    const tabB = makeCollectionTab('t2', [], false);
    const tabs: WorkspaceTab[] = [tabA, tabB];
    const patchCollectionState = vi.fn();

    let activeCollectionId: string | null = 't1';
    const { result, rerender } = renderHook(
      ({ activeId }: { activeId: string | null }) =>
        useReferenceDrawer(activeId, tabs, patchCollectionState, activeId),
      { initialProps: { activeId: activeCollectionId } },
    );

    act(() => {
      result.current.handleRefOpen(RULE, 'userId', oidA);
    });
    expect(patchCollectionState).toHaveBeenLastCalledWith(
      't1',
      expect.objectContaining({ referenceDrawer: expect.anything() }),
    );

    // Simulate a tab switch. The active id changes; on the next refStack
    // mutation, the persist effect must use 't2', not 't1'.
    activeCollectionId = 't2';
    rerender({ activeId: activeCollectionId });

    act(() => {
      result.current.handleRefOpen(RULE, 'userId', oidB);
    });
    expect(patchCollectionState).toHaveBeenLastCalledWith(
      't2',
      expect.objectContaining({ referenceDrawer: expect.anything() }),
    );
  });
});
