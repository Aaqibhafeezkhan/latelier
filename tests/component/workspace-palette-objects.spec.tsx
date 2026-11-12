// Tab, Saved and Database palette objects, and the collections of every
// connected Connection (X07 §13.5), against a real mounted `<Workspace/>`.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import { _resetTabRequestsForTests, tabRequested } from '../../src/pages/Workspace/tabRequest';
import {
  installAtelierMock,
  uninstallAtelierMock,
  connectionFixture,
  collectionTabFixture,
} from '../helpers/atelierMock';
import type { CollectionInfo, DbInfo } from '@shared/ipc';
import type { CollectionTab, ConnectionRuntime, SavedQuerySummary } from '@shared/types';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';

// A name ending in `_view` is listed as a view.
const coll = (name: string): CollectionInfo => ({
  name,
  type: name.endsWith('_view') ? 'view' : 'collection',
  documentCount: 0,
  sizeBytes: 0,
  indexCount: 0,
  capped: false,
});
const db = (name: string): DbInfo => ({ name, sizeOnDisk: 1, empty: false });

const SERVER: Record<string, Record<string, string[]>> = {
  c1: { shop: ['orders', 'customers'] },
  c2: { ordering: ['carts'] },
  c3: { archive: ['old'] },
};

const summary = (over: Partial<SavedQuerySummary>): SavedQuerySummary => ({
  id: 'q1',
  connectionId: 'c1',
  dbName: 'shop',
  collection: 'orders',
  kind: 'find',
  name: 'Open orders last 7 days',
  updatedAt: '2026-11-11T10:00:00.000Z',
  ...over,
});
const SAVED = [
  summary({}),
  summary({ id: 'q2', kind: 'aggregation', name: 'Orders by region' }),
  summary({ id: 'q3', kind: 'script', name: 'Seed orders script' }),
];

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

let statusListeners: Array<(r: ConnectionRuntime) => void> = [];
function emit(runtime: ConnectionRuntime) {
  act(() => {
    for (const l of [...statusListeners]) l(runtime);
  });
}

const t1 = (over: Partial<CollectionTab> = {}) =>
  collectionTabFixture({ id: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders', isActive: true, ...over });
const t2 = collectionTabFixture({ id: 't2', connectionId: 'c2', dbName: 'ordering', collection: 'carts', position: 1 });

function mount(
  opts: {
    tabs?: CollectionTab[];
    opened?: CollectionTab;
    server?: typeof SERVER;
    savedQueryRaw?: string;
    /** Whether the tab list shows the opened pipeline afterwards, as main lists it. */
    listsOpenedPipeline?: boolean;
  } = {},
) {
  const server = opts.server ?? SERVER;
  statusListeners = [];
  const tabs = opts.tabs ?? [t1(), t2];
  const listDatabases = vi.fn(async ({ connectionId }: { connectionId: string }) =>
    Object.keys(server[connectionId] ?? {}).map(db),
  );
  const listCollections = vi.fn(async ({ connectionId, dbName }: { connectionId: string; dbName: string }) =>
    (server[connectionId]?.[dbName] ?? []).map(coll),
  );
  const savedList = vi.fn(async ({ connectionId }: { connectionId?: string }) =>
    SAVED.filter((s) => s.connectionId === connectionId),
  );
  const savedGet = vi.fn(async ({ id }: { id: string }) => ({
    ...SAVED.find((s) => s.id === id)!,
    createdAt: '2026-11-11T10:00:00.000Z',
    payload: { kind: 'find', builder: { projection: [], sort: '', limit: '' }, queryRaw: opts.savedQueryRaw ?? '{"status":"open"}' },
  }));
  const savedDelete = vi.fn(async () => {});
  const savedUpdate = vi.fn(async ({ id, patch }: { id: string; patch: { name?: string } }) => ({
    ...SAVED.find((s) => s.id === id)!,
    ...patch,
    createdAt: '2026-11-11T10:00:00.000Z',
    payload: {},
  }));
  const setActive = vi.fn(async (id: string) => collectionTabFixture({ id }));
  const close = vi.fn(async () => ({ newActiveId: null }));
  const setPinned = vi.fn(async (id: string) => collectionTabFixture({ id }));
  let rows = tabs;
  const openCollection = vi.fn(async () => {
    const opened = opts.opened ?? tabs[0]!;
    if (!rows.some((r) => r.id === opened.id)) rows = [...rows.map((r) => ({ ...r, isActive: false })), opened];
    return opened;
  });
  const openAggregation = vi.fn(async ({ savedId }: { savedId?: string }) => {
    if (opts.listsOpenedPipeline !== false) {
      rows = rows.map((r, i) =>
        i === 0 && r.kind === 'collection'
          ? // The view is left alone, so the request stays to be read.
            { ...r, state: { ...r.state, aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, savedId } } }
          : r,
      );
    }
    return tabs[0]!;
  });
  const tabsList = vi.fn(async () => rows);
  const find = vi.fn(async () => ({ documents: [], durationMs: 1 }));
  installAtelierMock({
    conn: {
      list: async () => [
        connectionFixture({ id: 'c1', name: 'Production' }),
        connectionFixture({ id: 'c2', name: 'Staging' }),
        connectionFixture({ id: 'c3', name: 'Old', status: 'disconnected' }),
      ],
    },
    tabs: {
      list: tabsList as never,
      setActive: setActive as never,
      close: close as never,
      setPinned: setPinned as never,
      openCollection: openCollection as never,
      openAggregation: openAggregation as never,
      update: async (id: string) => collectionTabFixture({ id }),
    },
    meta: { listDatabases: listDatabases as never, listCollections: listCollections as never },
    mongo: {
      onStatus: (cb: (r: ConnectionRuntime) => void) => {
        statusListeners.push(cb);
        return () => {
          statusListeners = statusListeners.filter((l) => l !== cb);
        };
      },
    },
    query: { find: find as never },
    saved: { list: savedList as never, get: savedGet as never, delete: savedDelete as never, update: savedUpdate as never },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Workspace />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
  return {
    listCollections,
    listDatabases,
    savedList,
    savedGet,
    savedDelete,
    savedUpdate,
    setActive,
    close,
    setPinned,
    openCollection,
    openAggregation,
    tabsList,
    find,
  };
}

const input = () => screen.getByLabelText('Search commands');
function openPalette() {
  fireEvent.click(screen.getByText('toggle'));
  return screen.getByRole('dialog', { name: 'Command palette' });
}
function closePalette() {
  fireEvent.click(screen.getByText('toggle'));
}
function search(q: string) {
  fireEvent.change(input(), { target: { value: q } });
}

/** The palette's rows of `kind`: title, subtitle, and the tag or action at the right. */
function rowsOf(kind: string): string[][] {
  return within(screen.getByRole('dialog', { name: 'Command palette' }))
    .queryAllByRole('option')
    .filter((o) => o.getAttribute('data-kind') === kind)
    .map((o) => {
      const title = o.querySelector('[data-title]')?.getAttribute('data-title') ?? '';
      const sub = o.querySelector('[data-subtitle]')?.getAttribute('data-subtitle') ?? '';
      const last = o.lastElementChild;
      const aside = !last || last.querySelector('[data-title]') ? '' : (last.textContent ?? '');
      return [title, sub, aside];
    });
}

/** Waits for the sweep to list c1, focuses c2's tab so it is listed too, then comes back to c1. */
async function listBoth(m: ReturnType<typeof mount>) {
  await screen.findByTestId('nav-coll-shop-orders');
  fireEvent.click(screen.getByRole('tab', { name: /carts/ }));
  await waitFor(() => expect(m.listCollections.mock.calls.map(([a]) => a.connectionId)).toContain('c2'));
  fireEvent.click(screen.getByRole('tab', { name: /orders/ }));
}

afterEach(() => {
  act(() => notifications.clean());
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  _resetTabRequestsForTests();
  vi.restoreAllMocks();
});

describe('Tab objects', () => {
  it('lists each open tab by its name, with `<db> · <Connection>` and the Open tab tag', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('carts');
    await waitFor(() => expect(rowsOf('tab')).toEqual([['carts', 'ordering · Staging', 'Open tab']]));
  });

  it('switches to the tab on Enter, with the tab strip’s own handler', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('carts');
    await waitFor(() => expect(rowsOf('tab')).toHaveLength(1));
    // The collection row ranks first in All; the Tabs scope holds the tab alone.
    fireEvent.keyDown(input(), { key: 'Tab' });
    fireEvent.keyDown(input(), { key: 'Tab' });
    fireEvent.keyDown(input(), { key: 'Tab' });
    fireEvent.keyDown(input(), { key: 'Tab' });
    await waitFor(() => expect(rowsOf('tab')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(m.setActive).toHaveBeenCalledWith('t2'));
  });

  it('`pin carts` pins the tab, and `close` asks first about unsaved pipeline edits as the close button does', async () => {
    const dirty = t1({ state: { ...t1().state, aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: true } } });
    const m = mount({ tabs: [dirty, t2] });
    await screen.findByTestId('nav-coll-shop-orders');

    openPalette();
    search('pin carts');
    await waitFor(() => expect(rowsOf('tab')).toEqual([['carts', 'ordering · Staging', 'Pin']]));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(m.setPinned).toHaveBeenCalledWith({ id: 't2', pinned: true }));

    openPalette();
    search('close orders');
    await waitFor(() => expect(rowsOf('tab')).toEqual([['orders', 'shop · Production', 'Close']]));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved pipeline changes?' })).toBeTruthy();
    expect(m.close).not.toHaveBeenCalled();
  });

  it('Close current tab and ⌘W ask too, before closing a tab with unsaved pipeline edits', async () => {
    const dirty = t1({ state: { ...t1().state, aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: true } } });
    const m = mount({ tabs: [dirty, t2] });
    await screen.findByTestId('nav-coll-shop-orders');

    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved pipeline changes?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard unsaved pipeline changes?' })).toBeNull());

    openPalette();
    search('Close current tab');
    await waitFor(() => expect(rowsOf('action').map(([t]) => t)).toContain('Close current tab'));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved pipeline changes?' })).toBeTruthy();
    expect(m.close).not.toHaveBeenCalled();
  });
});

describe('Saved objects', () => {
  it('lists the focused Connection’s saved queries and pipelines, tagged, with the namespace; no scripts', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('orders');
    await waitFor(() =>
      expect(rowsOf('saved').sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
        ['Open orders last 7 days', 'shop.orders', 'Query'],
        ['Orders by region', 'shop.orders', 'Pipeline'],
      ]),
    );
  });

  it('reads the saved list once per open: never while closed, never per keystroke or move', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    expect(m.savedList).not.toHaveBeenCalled();

    openPalette();
    search('o');
    search('or');
    search('orders');
    await waitFor(() => expect(rowsOf('saved')).toHaveLength(2));
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    closePalette();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(m.savedList).toHaveBeenCalledTimes(1);

    openPalette();
    await waitFor(() => expect(m.savedList).toHaveBeenCalledTimes(2));
    expect(m.savedList).toHaveBeenLastCalledWith({ connectionId: 'c1' });
  });

  it('Enter loads the saved query into its tab without running it; ⌘↵ runs it', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    await waitFor(() => expect(m.find).toHaveBeenCalled());
    const runsBefore = m.find.mock.calls.length;

    openPalette();
    search('last 7 days');
    await waitFor(() => expect(rowsOf('saved')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(m.savedGet).toHaveBeenCalledWith({ id: 'q1' }));
    await waitFor(() =>
      expect(m.openCollection).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        reuseExisting: true,
      }),
    );
    await waitFor(() => expect(screen.getByDisplayValue('{"status":"open"}')).toBeTruthy());
    expect(m.find.mock.calls.length).toBe(runsBefore);

    openPalette();
    search('last 7 days');
    await waitFor(() => expect(rowsOf('saved')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(m.find.mock.calls.length).toBe(runsBefore + 1));
    expect(m.find).toHaveBeenLastCalledWith(expect.objectContaining({ filter: '{"status":"open"}' }));
  });

  it.each([
    ['Enter', false],
    ['⌘↵', true],
  ])('%s on a collection with no tab open runs nothing but the saved query, if asked', async (_key, runIt) => {
    // A fresh tab in its default state: the auto-run must not run `{}` over it.
    const fresh = collectionTabFixture({ id: 't9', connectionId: 'c1', dbName: 'shop', collection: 'customers', isActive: true });
    const m = mount({ opened: fresh });
    await screen.findByTestId('nav-coll-shop-orders');
    await waitFor(() => expect(m.find).toHaveBeenCalled());
    const before = m.find.mock.calls.length;
    openPalette();
    search('last 7 days');
    await waitFor(() => expect(rowsOf('saved')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: runIt });
    await waitFor(() => expect(m.openCollection).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const after = (m.find.mock.calls.slice(before) as unknown as [{ filter: string; collection: string }][]).map(([a]) => a);
    expect(after).toEqual(runIt ? [expect.objectContaining({ collection: 'customers', filter: '{"status":"open"}' })] : []);
    // Loaded into the new tab either way.
    expect(screen.getByDisplayValue('{"status":"open"}')).toBeTruthy();
  });

  it.each([
    ['Enter', false, 0],
    ['⌘↵', true, 1],
  ])('%s on a saved `{}` into a restored tab off Documents runs only what was asked (run: %s)', async (_key, runIt, runs) => {
    // Restored: `lastRun` is never persisted, so the switch to Documents would re-fire the auto-run.
    const onStructure = t1({ state: { ...t1().state, activeView: 'structure' } });
    const m = mount({ tabs: [onStructure, t2], savedQueryRaw: '{}' });
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('last 7 days');
    await waitFor(() => expect(rowsOf('saved')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: runIt });
    await waitFor(() => expect(m.savedGet).toHaveBeenCalledWith({ id: 'q1' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const onOrders = (m.find.mock.calls as unknown as [{ collection: string }][]).filter(([a]) => a.collection === 'orders');
    expect(onOrders).toHaveLength(runs);
  });

  it('Run on a saved pipeline asks its Aggregation tab to run once it opens', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    // The tab the pipeline opens on, raised by the mock's openAggregation.
    openPalette();
    search('run region');
    await waitFor(() => expect(rowsOf('saved')).toEqual([['Orders by region', 'shop.orders', 'Run']]));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(tabRequested('runPipeline', 't1')).toBe(true));
  });

  it('asks no run while the tab still shows the pipeline it had before', async () => {
    const m = mount({ listsOpenedPipeline: false });
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('run region');
    await waitFor(() => expect(rowsOf('saved')).toEqual([['Orders by region', 'shop.orders', 'Run']]));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(m.openAggregation).toHaveBeenCalled());
    await waitFor(() => expect(m.tabsList.mock.calls.length).toBeGreaterThan(1));
    expect(tabRequested('runPipeline', 't1')).toBe(false);
  });

  it('Run on a saved pipeline of a Connection that is not connected says so, opens it, and queues no run', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    emit({ id: 'c1', status: 'disconnected' });
    openPalette();
    search('run region');
    await waitFor(() => expect(rowsOf('saved')).toEqual([['Orders by region', 'shop.orders', 'Run']]));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByText('Connect to Production first, then run.')).toBeTruthy();
    await waitFor(() => expect(m.openAggregation).toHaveBeenCalled());
    expect(tabRequested('runPipeline', 't1')).toBe(false);
  });

  it('⌘↵ on a saved query of a Connection that is not connected says so, loads it, and runs nothing', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    await waitFor(() => expect(m.find).toHaveBeenCalled());
    emit({ id: 'c1', status: 'disconnected' });
    const before = m.find.mock.calls.length;
    openPalette();
    search('last 7 days');
    await waitFor(() => expect(rowsOf('saved')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    expect(await screen.findByText('Connect to Production first, then run.')).toBeTruthy();
    await waitFor(() => expect(m.savedGet).toHaveBeenCalledWith({ id: 'q1' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(m.find.mock.calls.length).toBe(before);
  });

  it('a saved Open into the same tab clears the complaint the replaced filter left', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    const field = screen.getByLabelText('Query filter');
    fireEvent.change(field, { target: { value: '{ nope' } });
    fireEvent.blur(field);
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    const alertsBefore = screen.queryAllByRole('alert').map((a) => a.textContent);
    openPalette();
    search('last 7 days');
    await waitFor(() => expect(rowsOf('saved')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByDisplayValue('{"status":"open"}')).toBeTruthy());
    const left = screen.queryAllByRole('alert').map((a) => a.textContent);
    for (const text of alertsBefore) expect(left).not.toContain(text);
  });

  it('Delete… asks the saved list’s own question, then deletes', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('delete region');
    await waitFor(() => expect(rowsOf('saved')).toEqual([['Orders by region', 'shop.orders', 'Delete…']]));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await screen.findByRole('dialog', { name: 'Delete "Orders by region"?' });
    expect(m.savedDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(m.savedDelete).toHaveBeenCalledWith({ id: 'q2' }));
  });

  it('Rename… opens the collection’s Saved list with the entry in its rename input', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('rename region');
    await waitFor(() => expect(rowsOf('saved')).toEqual([['Orders by region', 'shop.orders', 'Rename…']]));
    fireEvent.keyDown(input(), { key: 'Enter' });

    const field = (await screen.findByLabelText('New name for "Orders by region"')) as HTMLInputElement;
    expect(field.value).toBe('Orders by region');
    expect(screen.getByRole('tab', { name: 'Saved', selected: true })).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Region totals' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(m.savedUpdate).toHaveBeenCalledWith({ id: 'q2', patch: { name: 'Region totals' } }));
  });
});

describe('Database objects and the collections of every connected Connection', () => {
  it('lists the databases and collections of both connected Connections, each with its Connection’s name', async () => {
    const m = mount();
    await listBoth(m);
    openPalette();
    search('ord');
    // Collections scope: collections and databases together.
    fireEvent.keyDown(input(), { key: 'Tab' });
    await waitFor(() =>
      expect(rowsOf('database')).toEqual([['ordering', 'Staging · database', '']]),
    );
    search('carts');
    await waitFor(() => expect(rowsOf('collection')).toEqual([['ordering.carts', 'Staging', '']]));
    search('shop.orders');
    await waitFor(() => expect(rowsOf('collection')[0]).toEqual(['shop.orders', 'Production', expect.any(String)]));
  });

  it('lists nothing of a Connection that is not connected, even what the navigator had listed', async () => {
    const m = mount();
    await listBoth(m);
    expect(m.listDatabases.mock.calls.map(([a]) => a.connectionId)).not.toContain('c3');
    emit({ id: 'c2', status: 'disconnected' });
    openPalette();
    search('ord');
    fireEvent.keyDown(input(), { key: 'Tab' });
    await waitFor(() => expect(rowsOf('collection').length).toBeGreaterThan(0));
    expect(rowsOf('database')).toEqual([]);
    search('carts');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rowsOf('collection')).toEqual([]);
    search('archive');
    expect(rowsOf('database')).toEqual([]);
  });

  it('a database’s Enter reveals it in a collapsed navigator: expanded, its row focused', async () => {
    const m = mount();
    await listBoth(m);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());
    openPalette();
    search('ordering');
    fireEvent.keyDown(input(), { key: 'Tab' });
    await waitFor(() => expect(rowsOf('database')).toHaveLength(1));
    const row = within(screen.getByRole('dialog', { name: 'Command palette' }))
      .getAllByRole('option')
      .find((o) => o.getAttribute('data-kind') === 'database')!;
    fireEvent.click(row);

    const dbRow = await screen.findByTestId('nav-db-ordering');
    await waitFor(() => expect(screen.getByRole('tree').getAttribute('aria-activedescendant')).toBe(dbRow.id));
    // Expanded: its collections are drawn under it.
    expect(await screen.findByTestId('nav-coll-ordering-carts')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'New collection — ordering' })).toBeNull();
  });

  it('a database’s action list opens the navigator’s Create collection, and `drop` lists its Drop database', async () => {
    const m = mount();
    await listBoth(m);
    openPalette();
    search('ordering');
    fireEvent.keyDown(input(), { key: 'Tab' });
    await waitFor(() => expect(rowsOf('database')).toHaveLength(1));
    const row = within(screen.getByRole('dialog', { name: 'Command palette' }))
      .getAllByRole('option')
      .find((o) => o.getAttribute('data-kind') === 'database')!;
    fireEvent.mouseEnter(row);
    fireEvent.keyDown(input(), { key: 'Enter', altKey: true });
    fireEvent.click(await screen.findByRole('option', { name: /Create collection…/ }));
    expect(await screen.findByRole('dialog', { name: 'New collection — ordering' })).toBeTruthy();

    openPalette();
    search('drop ordering');
    await waitFor(() => expect(rowsOf('database')).toEqual([['ordering', 'Staging · database', 'Drop database…']]));
  });
});

describe('the added commands’ gates', () => {
  const titles = () => rowsOf('action').map(([t, sub]) => [t, sub]);

  it('lists Create collection…, Create index… and Explain query only with a collection tab in front', async () => {
    mount({ tabs: [] });
    await waitFor(() => expect(screen.getByText('toggle')).toBeTruthy());
    openPalette();
    for (const q of ['Create collection', 'Create index', 'Explain query']) {
      search(q);
      expect(titles().map(([t]) => t)).not.toContain(q.endsWith('query') ? q : `${q}…`);
    }
  });

  it('Create collection… and Create index… are listed with a collection tab in front, and open their drawers', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('Create collection');
    await waitFor(() => expect(titles()[0]).toEqual(['Create collection…', '']));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'New collection — shop' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'New collection — shop' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New collection — shop' })).toBeNull());

    openPalette();
    search('Create index');
    await waitFor(() => expect(titles()[0]).toEqual(['Create index…', '']));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'New index — shop.orders' })).toBeTruthy();
  });

  it('Explain query is greyed with the filter’s problem, and asks the Run menu’s Explain otherwise', async () => {
    const bad = t1({ state: { ...t1().state, queryRaw: '{ nope' } });
    mount({ tabs: [bad, t2] });
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('Explain query');
    await waitFor(() => expect(titles()[0]?.[0]).toBe('Explain query'));
    expect(titles()[0]?.[1]).not.toBe('');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(tabRequested('explain', 't1')).toBe(false);
  });

  it('Explain query is greyed when the focused Connection is not connected, and asks nothing', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    emit({ id: 'c1', status: 'disconnected' });
    openPalette();
    search('Explain query');
    await waitFor(() => expect(titles()[0]).toEqual(['Explain query', 'Connect to Production first']));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(tabRequested('explain', 't1')).toBe(false);
  });

  it('Create index… is greyed with a view in front', async () => {
    mount({
      server: { ...SERVER, c1: { shop: ['orders', 'orders_view'] } },
      tabs: [t1({ collection: 'orders_view' }), t2],
    });
    await screen.findByTestId('nav-coll-shop-orders_view');
    openPalette();
    search('Create index');
    await waitFor(() =>
      expect(titles()[0]).toEqual(['Create index…', "This is a view, so indexes can't be created here"]),
    );
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: /New index/ })).toBeNull();
  });

  it('Explain query opens the plan for a valid filter', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    openPalette();
    search('Explain query');
    await waitFor(() => expect(titles()[0]).toEqual(['Explain query', '']));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: /plan|explain/i })).toBeTruthy();
  });

  it('New script tab is greyed with a reason when no Connection can be named', async () => {
    mount({ tabs: [] });
    await waitFor(() => expect(screen.getByText('toggle')).toBeTruthy());
    openPalette();
    search('New script tab');
    await waitFor(() => expect(titles()[0]?.[0]).toBe('New script tab'));
    expect(titles()[0]?.[1]).toBe('Open a tab on the Connection first');
  });
});
