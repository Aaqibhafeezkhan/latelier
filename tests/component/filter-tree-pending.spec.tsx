// W13 §11 — "filter-tree-pending.spec.tsx: the pending-row lifecycle of §5,
// including a bar edit landing underneath a pending row, and switching tabs
// discarding pending rows even when both tabs' text is identical (the
// drawer remounts on `key={tabId}`)."
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-04T12:00:00.000Z';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: [], durationMs: 0, ranAt: now },
    ...overrides,
  };
}

function makeCollectionTab(
  id: string,
  collection: string,
  state: CollectionTabState,
  position: number,
  isActive: boolean,
): WorkspaceTab {
  return {
    id,
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'mydb',
    collection,
    position,
    isActive,
    openedAt: now,
    pinned: false,
    state,
  };
}

const CONNECTION = {
  id: 'c1',
  name: 'Local',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard' as const,
  readOnly: false,
  status: 'connected' as const,
};

function lastWrittenQueryRaw(updateSpy: ReturnType<typeof vi.fn>): string | undefined {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const arg = updateSpy.mock.calls[i]?.[1] as { state?: Partial<CollectionTabState> } | undefined;
    const patch = arg?.state;
    if (patch && 'queryRaw' in patch) return patch.queryRaw;
  }
  return undefined;
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('Filter drawer — pending-row lifecycle (W13 §5, §11)', () => {
  it('"+ Condition" adds a row that persists on screen and does not change queryRaw', async () => {
    const state = makeState();
    const updateSpy = vi.fn(async () => makeCollectionTab('t1', 'users', state, 0, true));
    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab('t1', 'users', state, 0, true)],
        setActive: async (id) => ({ id }),
        update: updateSpy as unknown as IpcApi['tabs']['update'],
      },
      conn: { list: async () => [CONNECTION] },
      query: { find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })), count: async () => ({ count: 0 }) },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));

    const fieldInput = await screen.findByPlaceholderText('field');
    expect(fieldInput).toBeTruthy();
    // The query bar's textarea mirrors `state.queryRaw` synchronously (it's
    // a controlled input) — unlike `tabs.update`, which is 250ms-debounced
    // (`src/state/workspaceTabs.ts`), so it's an immediate, race-free
    // oracle for "did queryRaw change" instead of racing a fixed sleep
    // against that debounce.
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    expect(bar.value).toBe('{}');
    // Wait past the debounce window too, to also rule out an eventual write
    // that the bar's local state wouldn't reflect (it always would, but this
    // keeps the assertion honest about what `tabs.update` actually saw).
    await new Promise((r) => setTimeout(r, 350));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });

  it('"+ Raw" adds a row that persists on screen and does not change queryRaw', async () => {
    const state = makeState();
    const updateSpy = vi.fn(async () => makeCollectionTab('t1', 'users', state, 0, true));
    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab('t1', 'users', state, 0, true)],
        setActive: async (id) => ({ id }),
        update: updateSpy as unknown as IpcApi['tabs']['update'],
      },
      conn: { list: async () => [CONNECTION] },
      query: { find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })), count: async () => ({ count: 0 }) },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add raw clause' }));

    const rawInput = await screen.findByLabelText('Raw clause 1');
    expect(rawInput).toBeTruthy();
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    expect(bar.value).toBe('{}');
    await new Promise((r) => setTimeout(r, 350));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });

  it('typing in the query bar re-seeds the tree and discards a pending row', async () => {
    const state = makeState();
    const updateSpy = vi.fn(async () => makeCollectionTab('t1', 'users', state, 0, true));
    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab('t1', 'users', state, 0, true)],
        setActive: async (id) => ({ id }),
        update: updateSpy as unknown as IpcApi['tabs']['update'],
      },
      conn: { list: async () => [CONNECTION] },
      query: { find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })), count: async () => ({ count: 0 }) },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    // A pending row landing underneath a bar edit — add it, then type in the
    // bar out from under it.
    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    await screen.findByPlaceholderText('field');

    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: '{"a":1}' } });

    await waitFor(() => {
      // The pending row is gone — only the one real cond from the bar text
      // renders now.
      const fields = screen.getAllByPlaceholderText('field') as HTMLInputElement[];
      expect(fields).toHaveLength(1);
      expect(fields[0]!.value).toBe('a');
    });
  });

  it('switching tabs re-seeds each tab from its own state, even when both tabs share the same text', async () => {
    // §5.6 — the crux of the test: BOTH tabs hold the default '{}' text, so
    // text equality alone can never detect the switch. Only remounting on
    // `key={tabId}` catches it. Each tab then seeds from its own persisted
    // draft (§5.7): tab B has none, tab A has its pending row.
    const stateA = makeState();
    const stateB = makeState();
    const tabs = [
      makeCollectionTab('tA', 'orders', stateA, 0, true),
      makeCollectionTab('tB', 'users', stateB, 1, false),
    ];
    const updateSpy = vi.fn(async (id: string) => tabs.find((t) => t.id === id)!);
    const setActiveSpy = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      tabs: {
        list: async () => tabs,
        setActive: setActiveSpy as unknown as IpcApi['tabs']['setActive'],
        update: updateSpy as unknown as IpcApi['tabs']['update'],
      },
      conn: { list: async () => [CONNECTION] },
      query: { find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })), count: async () => ({ count: 0 }) },
    });
    const { container } = render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    // Both tabs render (TabStrip) — wait for tab A's collection to load.
    await screen.findByRole('tab', { name: /orders/ });

    // Add a pending condition row on tab A.
    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    await screen.findByPlaceholderText('field');
    expect(screen.getAllByPlaceholderText('field')).toHaveLength(1);

    // Switch to tab B.
    const tabBEl = container.querySelector('[data-tab-id="tB"]');
    expect(tabBEl).toBeTruthy();
    fireEvent.click(tabBEl!);
    await waitFor(() => expect(setActiveSpy).toHaveBeenCalledWith('tB'));

    // Tab B has no conditions of its own — the drawer must show zero field
    // rows, not tab A's pending one.
    await waitFor(() => {
      expect(screen.queryAllByPlaceholderText('field')).toHaveLength(0);
    });

    // Switch back to tab A — its pending row comes back from tab A's own
    // draft: the switch remounted the drawer, and the remount re-seeded from
    // the draft because it still matches tab A's '{}'.
    const tabAEl = container.querySelector('[data-tab-id="tA"]');
    fireEvent.click(tabAEl!);
    await waitFor(() => expect(setActiveSpy).toHaveBeenCalledWith('tA'));

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryAllByPlaceholderText('field')).toHaveLength(1);
  });

  it('a tab switch while the bar is invalid keeps the switched-off row for when the text comes back', async () => {
    // The drawer remounts on the switch back, over text that doesn't parse.
    // It opens frozen, but the tab's draft still stands for the text it was
    // recorded against, so fixing the bar back to that text brings the tree
    // back rather than re-parsing it without the switched-off row.
    const A = '{"a":{"$eq":1}}';
    const stateA = makeState({
      queryRaw: A,
      filterDraft: {
        queryRaw: A,
        root: {
          kind: 'group',
          logic: '$and',
          children: [
            { kind: 'cond', field: 'a', op: '$eq', valType: 'number', value: '1' },
            { kind: 'cond', field: 'b', op: '$eq', valType: 'number', value: '2', disabled: true },
          ],
        },
      },
    });
    const tabs = [
      makeCollectionTab('tA', 'orders', stateA, 0, true),
      makeCollectionTab('tB', 'users', makeState(), 1, false),
    ];
    const updateSpy = vi.fn(async (id: string) => tabs.find((t) => t.id === id)!);
    const setActiveSpy = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      tabs: {
        list: async () => tabs,
        setActive: setActiveSpy as unknown as IpcApi['tabs']['setActive'],
        update: updateSpy as unknown as IpcApi['tabs']['update'],
      },
      conn: { list: async () => [CONNECTION] },
      query: { find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })), count: async () => ({ count: 0 }) },
    });
    const { container } = render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    const fields = () => (screen.queryAllByPlaceholderText('field') as HTMLInputElement[]).map((f) => f.value);
    await waitFor(() => expect(fields()).toEqual(['a', 'b']));

    fireEvent.change(await screen.findByTestId('query-bar-input'), { target: { value: `${A}x` } });
    await screen.findByText(/isn't valid JSON/);
    fireEvent.click(container.querySelector('[data-tab-id="tB"]')!);
    await waitFor(() => expect(setActiveSpy).toHaveBeenCalledWith('tB'));
    await waitFor(() => expect(fields()).toEqual([]));
    fireEvent.click(container.querySelector('[data-tab-id="tA"]')!);
    await waitFor(() => expect(setActiveSpy).toHaveBeenCalledWith('tA'));
    await screen.findByText(/isn't valid JSON/);
    const callsBefore = updateSpy.mock.calls.length;

    fireEvent.change(await screen.findByTestId('query-bar-input'), { target: { value: A } });
    await waitFor(() => expect(screen.queryByText(/isn't valid JSON/)).toBeNull());

    expect(fields()).toEqual(['a', 'b']);
    expect((screen.getByRole('checkbox', { name: 'Include condition b' }) as HTMLInputElement).checked).toBe(false);
    // The draft holding the switched-off row is not cleared.
    const later = updateSpy.mock.calls.slice(callsBefore).map((c) => (c as unknown[])[1] as { state?: object });
    expect(later.some((arg) => arg.state && 'filterDraft' in arg.state)).toBe(false);
  });
});
