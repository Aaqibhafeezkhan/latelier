// The palette's `<db>.<coll>` collection rows, against a real mounted
// `<Workspace/>`: what they list, how they are found, and that they read the
// navigator's own database/collection cache instead of fetching a second copy.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import {
  installAtelierMock,
  uninstallAtelierMock,
  connectionFixture,
  collectionTabFixture,
} from '../helpers/atelierMock';
import type { CollectionInfo, DbInfo } from '@shared/ipc';
import type { ConnectionRuntime } from '@shared/types';

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

/** Per Connection, per database: the collections the server reports. */
const SERVER: Record<string, Record<string, string[]>> = {
  c1: { shop: ['orders', 'customers'], crm: ['leads'] },
  c2: { other: ['things'] },
};

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

/** The `mongo.onStatus` listeners the mounted tree subscribed; `emit` drives them. */
let statusListeners: Array<(r: ConnectionRuntime) => void> = [];
function emit(runtime: ConnectionRuntime) {
  act(() => {
    for (const l of [...statusListeners]) l(runtime);
  });
}

function mount(
  server: Record<string, Record<string, string[]>> = SERVER,
  extraTabs: ReturnType<typeof collectionTabFixture>[] = [],
  { listOpened = false } = {},
) {
  statusListeners = [];
  const listDatabases = vi.fn(async ({ connectionId }: { connectionId: string }) =>
    Object.keys(server[connectionId] ?? {}).map(db),
  );
  const listCollections = vi.fn(
    async ({ connectionId, dbName }: { connectionId: string; dbName: string }) =>
      (server[connectionId]?.[dbName] ?? []).map(coll),
  );
  // With `listOpened`, the opened tab is listed from then on, as main lists it.
  const opened: ReturnType<typeof collectionTabFixture>[] = [];
  const openCollection = vi.fn(async (input: { connectionId: string; dbName: string; collection: string }) => {
    const tab = collectionTabFixture({ id: 't-new', ...input, isActive: true });
    if (listOpened) opened.splice(0, opened.length, tab);
    return tab;
  });
  installAtelierMock({
    conn: {
      list: async () => [
        connectionFixture({ id: 'c1', name: 'Prod' }),
        connectionFixture({ id: 'c2', name: 'Staging' }),
      ],
    },
    tabs: {
      list: async () => [
        collectionTabFixture({
          id: 't1',
          connectionId: 'c1',
          dbName: 'shop',
          collection: 'orders',
          isActive: opened.length === 0,
        }),
        ...extraTabs,
        ...opened,
      ],
      setActive: async (id: string) => collectionTabFixture({ id }),
      openCollection: openCollection as never,
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
    collection: {
      create: async (input) => ({ name: (input as { collection: string }).collection }),
    },
    database: {
      drop: async ({ connectionId, dbName }: { connectionId: string; dbName: string }) => {
        delete server[connectionId]?.[dbName];
        return { dropped: true as const };
      },
    },
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
  return { listDatabases, listCollections, openCollection };
}

function openPalette() {
  fireEvent.click(screen.getByText('toggle'));
  return screen.getByRole('dialog');
}

function search(q: string) {
  fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: q } });
}

/** Every collection row the palette shows right now. */
function openRows(): string[] {
  return within(screen.getByRole('dialog'))
    .queryAllByRole('option')
    .filter((o) => o.id.includes('-opt-tab.open:'))
    .map((o) => o.querySelector('[data-title]')?.getAttribute('data-title') ?? '');
}

/** Waits for the palette sweep to reach every database of `c1`. */
async function settled(listCollections: ReturnType<typeof mount>['listCollections']) {
  await waitFor(() => {
    const dbs = new Set(listCollections.mock.calls.map(([a]) => a.dbName));
    expect(dbs).toEqual(new Set(['shop', 'crm']));
  });
  await screen.findByTestId('nav-coll-shop-orders');
}

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  vi.restoreAllMocks();
});

describe('palette namespace rows', () => {
  it('opens the typed namespace on Enter, reusing its tab', async () => {
    const { listCollections, openCollection } = mount();
    await settled(listCollections);

    openPalette();
    search('shop.orders');
    await waitFor(() => expect(openRows()).toEqual(['shop.orders']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });

    await waitFor(() =>
      expect(openCollection).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        reuseExisting: true,
      }),
    );
  });

  it('finds the namespace from a subsequence of it', async () => {
    const { listCollections } = mount();
    await settled(listCollections);

    openPalette();
    search('shord');
    await waitFor(() => expect(openRows()).toEqual(['shop.orders']));
  });

  it('lists no namespace rows on an empty query', async () => {
    const { listCollections } = mount();
    await settled(listCollections);

    openPalette();
    expect(screen.getByText('Close current tab')).toBeTruthy();
    expect(openRows()).toEqual([]);
  });

  it('shows a namespace opened from the palette under Recent on an empty query', async () => {
    const { listCollections } = mount();
    await settled(listCollections);

    openPalette();
    search('leads');
    await waitFor(() => expect(openRows()).toEqual(['crm.leads']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    openPalette();
    expect(openRows()).toEqual(['crm.leads']);
  });

  it('does not count the same namespace on another connection as recent', async () => {
    const server = { c1: { shop: ['orders'] }, c2: { shop: ['orders'] } };
    const { listCollections } = mount(server, [
      collectionTabFixture({ id: 't2', connectionId: 'c2', dbName: 'shop', collection: 'orders' }),
    ]);
    await waitFor(() => expect(listCollections).toHaveBeenCalled());

    openPalette();
    search('shop.orders');
    await waitFor(() => expect(openRows()).toEqual(['shop.orders']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Focus the tab on c2, then wait for c2's namespaces to be listed.
    fireEvent.click(screen.getAllByRole('tab', { name: /orders/ })[1]);
    await waitFor(() =>
      expect(listCollections.mock.calls.map(([a]) => a.connectionId)).toContain('c2'),
    );
    // Both connected, both listed now: one row per Connection.
    openPalette();
    search('shop.orders');
    await waitFor(() => expect(openRows()).toEqual(['shop.orders', 'shop.orders']));
    search('');

    // Only c1's was opened, so only c1's is recent.
    expect(
      within(screen.getByRole('dialog'))
        .queryAllByRole('option')
        .filter((o) => o.id.includes('-opt-tab.open:'))
        .map((o) => o.id.slice(o.id.indexOf('tab.open:'))),
    ).toEqual(['tab.open:c1:shop:orders']);
  });

  it('does not match every namespace on the letters of “Open”', async () => {
    const { listCollections } = mount();
    await settled(listCollections);

    openPalette();
    search('opn');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(openRows()).toEqual([]);
  });

  it('lists no namespaces of another connection the navigator never listed, and asks it for none', async () => {
    const { listCollections, listDatabases } = mount();
    await settled(listCollections);

    openPalette();
    search('.');
    await waitFor(() =>
      expect(openRows().sort((a, b) => a.localeCompare(b))).toEqual([
        'crm.leads',
        'shop.customers',
        'shop.orders',
      ]),
    );
    expect(listDatabases.mock.calls.map(([a]) => a.connectionId)).not.toContain('c2');
  });
});

describe('the palette shares the navigator’s cache', () => {
  it('fetches the database list once and each database’s collections once', async () => {
    const { listCollections, listDatabases } = mount();
    await settled(listCollections);
    // Let any second sweep or second mount effect have its turn.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(listDatabases).toHaveBeenCalledTimes(1);
    const perDb = listCollections.mock.calls.map(([a]) => `${a.connectionId}/${a.dbName}`);
    // One listing per database for the navigator and the palette together.
    // The open tab's header reads its counts through collectionDetails, not
    // listCollections, so it adds no listing of its own.
    expect(perDb.sort((a, b) => a.localeCompare(b))).toEqual(['c1/crm', 'c1/shop']);
  });

  it('keeps the namespaces with the navigator collapsed, without fetching again', async () => {
    const { listCollections, listDatabases } = mount();
    await settled(listCollections);
    const dbCalls = listDatabases.mock.calls.length;
    const collCalls = listCollections.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByTestId('nav-coll-shop-orders')).toBeNull());

    openPalette();
    search('leads');
    await waitFor(() => expect(openRows()).toEqual(['crm.leads']));
    expect(listDatabases).toHaveBeenCalledTimes(dbCalls);
    expect(listCollections).toHaveBeenCalledTimes(collCalls);
  });

  it('reopens the navigator from the cache it had, without listing databases again', async () => {
    const { listCollections, listDatabases } = mount();
    await settled(listCollections);
    const dbCalls = listDatabases.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByTestId('nav-coll-shop-orders')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Open navigator' }));

    expect(await screen.findByTestId('nav-coll-shop-orders')).toBeTruthy();
    expect(screen.queryAllByTestId('nav-db-skeleton')).toHaveLength(0);
    expect(listDatabases).toHaveBeenCalledTimes(dbCalls);
  });

  it('shows a database’s collections from the sweep the moment it is expanded', async () => {
    const { listCollections } = mount();
    await settled(listCollections);

    // Hold the expand's background revalidation open: what renders meanwhile
    // can only have come from the palette sweep's fill of the shared cache.
    listCollections.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-db-crm'));
    });
    expect(screen.getByTestId('nav-coll-crm-leads')).toBeTruthy();
    expect(screen.queryAllByTestId('nav-coll-skeleton')).toHaveLength(0);
  });

  it('lists a collection created through the navigator', async () => {
    const server = { c1: { shop: ['orders'] } };
    const { listCollections } = mount(server);
    await screen.findByTestId('nav-coll-shop-orders');
    await waitFor(() => expect(listCollections).toHaveBeenCalled());

    fireEvent.contextMenu(screen.getByTestId('nav-db-shop'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create collection' }));
    await userEvent.type(await screen.findByLabelText('Collection name'), 'invoices');
    server.c1.shop.push('invoices');
    await userEvent.click(screen.getByText('Create collection'));
    await screen.findByTestId('nav-coll-shop-invoices');

    openPalette();
    search('invoices');
    await waitFor(() => expect(openRows()).toEqual(['shop.invoices']));
  });
});

describe('namespace rows follow the focused connection’s status', () => {
  it('lists no namespace rows while the focused connection is disconnected', async () => {
    const { listCollections } = mount();
    await settled(listCollections);

    emit({ id: 'c1', status: 'disconnected' });
    openPalette();
    search('.');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(openRows()).toEqual([]);
  });

  it('re-lists every database of the connection after a reconnect', async () => {
    const server = {
      c1: { shop: ['orders'], crm: ['leads'] } as Record<string, string[]>,
    };
    const { listCollections } = mount(server);
    await settled(listCollections);

    emit({ id: 'c1', status: 'disconnected' });
    server.c1.crm.push('contacts');
    server.c1.billing = ['invoices'];
    emit({ id: 'c1', status: 'connected' });

    openPalette();
    search('.');
    await waitFor(() =>
      expect(openRows().sort((a, b) => a.localeCompare(b))).toEqual([
        'billing.invoices',
        'crm.contacts',
        'crm.leads',
        'shop.orders',
      ]),
    );
  });
});

describe('a refresh after a change never joins an older listing', () => {
  it('lists the databases again after a drop, while an older listing is still in flight', async () => {
    const server = {
      c1: { shop: ['orders'], crm: ['leads'] } as Record<string, string[]>,
    };
    const { listCollections, listDatabases } = mount(server);
    await settled(listCollections);

    // The reconnect's database listing hangs, answering with the list as it
    // was before the drop.
    let releaseStale: () => void = () => {};
    listDatabases.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = () => resolve([db('shop'), db('crm')]);
        }),
    );
    emit({ id: 'c1', status: 'disconnected' });
    emit({ id: 'c1', status: 'connected' });
    await waitFor(() => expect(listDatabases).toHaveBeenCalledTimes(2));

    fireEvent.contextMenu(screen.getByTestId('nav-db-crm'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Drop database' }));
    await userEvent.type(await screen.findByLabelText('Confirm database name'), 'crm');
    await userEvent.click(screen.getByRole('button', { name: 'Drop database' }));

    await waitFor(() => expect(listDatabases).toHaveBeenCalledTimes(3));
    await screen.findByTestId('nav-db-shop');
    await waitFor(() => expect(screen.queryByTestId('nav-db-crm')).toBeNull());
    await act(async () => {
      releaseStale();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId('nav-db-crm')).toBeNull();
  });
  it('lists the collections again after a create, while an older listing is still in flight', async () => {
    const server = { c1: { shop: ['orders'], crm: ['leads'] } };
    const { listCollections } = mount(server);
    await settled(listCollections);

    // Expanding crm revalidates it; that listing hangs on the old answer.
    let releaseStale: () => void = () => {};
    listCollections.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = () => resolve([coll('leads')]);
        }),
    );
    const calls = listCollections.mock.calls.length;
    fireEvent.click(screen.getByTestId('nav-db-crm'));
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(calls + 1));

    fireEvent.contextMenu(screen.getByTestId('nav-db-crm'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create collection' }));
    await userEvent.type(await screen.findByLabelText('Collection name'), 'contacts');
    server.c1.crm.push('contacts');
    await userEvent.click(screen.getByText('Create collection'));

    await screen.findByTestId('nav-coll-crm-contacts');
    await act(async () => {
      releaseStale();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('nav-coll-crm-contacts')).toBeTruthy();
  });
});

describe('the shared cache follows connection status while the navigator is collapsed', () => {
  const crmCalls = (lc: ReturnType<typeof mount>['listCollections']) =>
    lc.mock.calls.filter(([a]) => a.dbName === 'crm').length;

  it('re-lists an expanded database after a reconnect that happened while collapsed', async () => {
    const { listCollections } = mount();
    await settled(listCollections);
    // crm, not the open tab's shop: the tab header re-reads shop's counts on
    // its own, which would mask a missing re-list.
    fireEvent.click(screen.getByTestId('nav-db-crm'));
    await screen.findByTestId('nav-coll-crm-leads');
    await waitFor(() => expect(crmCalls(listCollections)).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());

    emit({ id: 'c1', status: 'disconnected' });
    emit({ id: 'c1', status: 'connected' });
    fireEvent.click(screen.getByRole('button', { name: 'Open navigator' }));
    await screen.findByTestId('nav-coll-crm-leads');

    await waitFor(() => expect(crmCalls(listCollections)).toBe(3));
  });

  it('drops a connect error that cleared while collapsed', async () => {
    const { listCollections } = mount();
    await settled(listCollections);
    emit({ id: 'c1', status: 'error', errorMessage: 'connection refused' });
    // Both the navigator and the results pane say so.
    expect((await screen.findAllByText('connection refused')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());
    emit({ id: 'c1', status: 'connected' });
    fireEvent.click(screen.getByRole('button', { name: 'Open navigator' }));

    await screen.findByRole('tree');
    expect(screen.queryByText('connection refused')).toBeNull();
  });
});

describe('the palette sweep on a server with many databases', () => {
  it('lists at most 4 databases at once, and still reaches every one of them', async () => {
    const swept = Array.from({ length: 10 }, (_, i) => `db${i}`);
    // `shop` holds the open tab, whose header lists it on its own: answered at once.
    const server = { c1: Object.fromEntries(['shop', ...swept].map((n) => [n, [`in_${n}`]])) };
    const { listCollections } = mount(server);
    const answer = (connectionId: string, dbName: string) =>
      (server[connectionId as 'c1']?.[dbName] ?? []).map(coll);
    // Every other listing hangs until released, so the in-flight count is observable.
    let inFlight = 0;
    let peak = 0;
    const waiting: Array<() => void> = [];
    listCollections.mockImplementation(async ({ connectionId, dbName }) => {
      if (dbName === 'shop') return answer(connectionId, dbName);
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        waiting.push(() => {
          inFlight--;
          resolve(answer(connectionId, dbName));
        });
      });
    });
    const listed = () =>
      new Set(listCollections.mock.calls.map(([a]) => a.dbName).filter((n) => n !== 'shop'));

    await waitFor(() => expect(listed().size).toBeGreaterThan(0));
    for (let round = 0; round < 20 && listed().size < swept.length; round++) {
      // Let every listing the sweep would start right now get started...
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      // ...then answer them all.
      await act(async () => {
        for (const release of waiting.splice(0)) release();
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    expect(listed()).toEqual(new Set(swept));
    expect(peak).toBe(4);
    await act(async () => {
      for (const release of waiting.splice(0)) release();
    });
    openPalette();
    search('in_db9');
    await waitFor(() => expect(openRows()).toEqual(['db9.in_db9']));
  });
});

describe('palette Collection actions', () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.activeElement ?? screen.getByLabelText('Search commands'), { key, ...init });
  const actionTitles = () =>
    within(screen.getByRole('dialog', { name: 'Command palette' }))
      .getAllByRole('option')
      .map((o) => [o.querySelector('[data-title]')?.getAttribute('data-title'), o.getAttribute('aria-disabled') === 'true']);

  it('lists the actions in order, and ⌘↵ opens a second tab', async () => {
    const { listCollections, openCollection } = mount();
    await settled(listCollections);
    openPalette();
    search('leads');
    await waitFor(() => expect(openRows()).toEqual(['crm.leads']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter', altKey: true });
    expect(actionTitles()).toEqual([
      ['Open', false],
      ['Open in new tab', false],
      ['Query…', false],
      ['Filter by field…', false],
      ['Aggregate', false],
      ['Schema', false],
      ['Indexes', false],
      ['Export…', false],
      ['Import…', false],
      ['Rename…', false],
      ['Drop collection…', false],
    ]);
    fireEvent.keyDown(screen.getByLabelText('Filter actions'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(openCollection).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'crm', collection: 'leads' }),
    );
  });

  it.each(['Schema', 'Indexes'])('%s on a collection with no tab opens one on Structure', async (action) => {
    const { listCollections, openCollection } = mount(SERVER, [], { listOpened: true });
    await settled(listCollections);
    openPalette();
    search('leads');
    await waitFor(() => expect(openRows()).toEqual(['crm.leads']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter', altKey: true });
    fireEvent.change(screen.getByLabelText('Filter actions'), { target: { value: action } });
    fireEvent.keyDown(screen.getByLabelText('Filter actions'), { key: 'Enter' });

    await waitFor(() => expect(openCollection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Structure', selected: true })).toBeTruthy());
  });

  it('disables the writing actions on a view, with a reason', async () => {
    const { listCollections } = mount({ c1: { shop: ['orders', 'big_view'], crm: ['leads'] } });
    await settled(listCollections);
    openPalette();
    search('big_view');
    await waitFor(() => expect(openRows()).toEqual(['shop.big_view']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter', altKey: true });
    const disabled = actionTitles().filter(([, d]) => d).map(([t]) => t);
    expect(disabled).toEqual(['Import…', 'Rename…', 'Drop collection…']);
    expect(screen.getByText("This is a view, so it can't be renamed here")).toBeTruthy();
  });

  it('`drop <name>` opens the navigator’s own drop confirmation', async () => {
    const { listCollections } = mount();
    await settled(listCollections);
    openPalette();
    search('drop leads');
    await waitFor(() => expect(openRows()).toEqual(['crm.leads']));
    press('Enter');
    expect(await screen.findByRole('dialog', { name: 'Drop collection "leads"?' })).toBeTruthy();
  });

  it('Rename… opens the navigator’s rename dialog, opening a collapsed sidebar first', async () => {
    const { listCollections } = mount();
    await settled(listCollections);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByTestId('nav-coll-shop-orders')).toBeNull());

    openPalette();
    search('rename leads');
    await waitFor(() => expect(openRows()).toEqual(['crm.leads']));
    press('Enter');
    expect(await screen.findByRole('dialog', { name: 'Rename "leads"' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse navigator' })).toBeTruthy();
  });
});
