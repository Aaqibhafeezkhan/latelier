// The palette's `Open: <db>.<coll>` rows, against a real mounted
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

const coll = (name: string): CollectionInfo => ({
  name,
  type: 'collection',
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
) {
  statusListeners = [];
  const listDatabases = vi.fn(async ({ connectionId }: { connectionId: string }) =>
    Object.keys(server[connectionId] ?? {}).map(db),
  );
  const listCollections = vi.fn(
    async ({ connectionId, dbName }: { connectionId: string; dbName: string }) =>
      (server[connectionId]?.[dbName] ?? []).map(coll),
  );
  const openCollection = vi.fn(async (input: { connectionId: string; dbName: string; collection: string }) =>
    collectionTabFixture({ id: 't-new', ...input, isActive: true }),
  );
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
          isActive: true,
        }),
        ...extraTabs,
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

/** Every `Open: …` row the palette shows right now. */
function openRows(): string[] {
  return within(screen.getByRole('dialog'))
    .queryAllByRole('option')
    .map((o) => o.textContent ?? '')
    .filter((t) => t.startsWith('Open: '));
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
    await waitFor(() => expect(openRows()).toEqual(['Open: shop.orders']));
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
    await waitFor(() => expect(openRows()).toEqual(['Open: shop.orders']));
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
    await waitFor(() => expect(openRows()).toEqual(['Open: crm.leads']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    openPalette();
    expect(openRows()).toEqual(['Open: crm.leads']);
  });

  it('does not count the same namespace on another connection as recent', async () => {
    const server = { c1: { shop: ['orders'] }, c2: { shop: ['orders'] } };
    const { listCollections } = mount(server, [
      collectionTabFixture({ id: 't2', connectionId: 'c2', dbName: 'shop', collection: 'orders' }),
    ]);
    await waitFor(() => expect(listCollections).toHaveBeenCalled());

    openPalette();
    search('shop.orders');
    await waitFor(() => expect(openRows()).toEqual(['Open: shop.orders']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Focus the tab on c2, then wait for c2's namespaces to be listed.
    fireEvent.click(screen.getAllByRole('tab', { name: /orders/ })[1]);
    await waitFor(() =>
      expect(listCollections.mock.calls.map(([a]) => a.connectionId)).toContain('c2'),
    );
    openPalette();
    search('shop.orders');
    await waitFor(() => expect(openRows()).toEqual(['Open: shop.orders']));
    search('');

    expect(openRows()).toEqual([]);
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

  it('lists only the focused connection’s namespaces', async () => {
    const { listCollections, listDatabases } = mount();
    await settled(listCollections);

    openPalette();
    search('Open:');
    await waitFor(() =>
      expect(openRows().sort((a, b) => a.localeCompare(b))).toEqual([
        'Open: crm.leads',
        'Open: shop.customers',
        'Open: shop.orders',
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
    // The second `shop` call is the open tab's header reading fresh document
    // and index counts, a separate consumer that never used either cache.
    expect(perDb.sort((a, b) => a.localeCompare(b))).toEqual(['c1/crm', 'c1/shop', 'c1/shop']);
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
    await waitFor(() => expect(openRows()).toEqual(['Open: crm.leads']));
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
    await waitFor(() => expect(openRows()).toEqual(['Open: shop.invoices']));
  });
});

describe('namespace rows follow the focused connection’s status', () => {
  it('lists no namespace rows while the focused connection is disconnected', async () => {
    const { listCollections } = mount();
    await settled(listCollections);

    emit({ id: 'c1', status: 'disconnected' });
    openPalette();
    search('Open:');
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
    search('Open:');
    await waitFor(() =>
      expect(openRows().sort((a, b) => a.localeCompare(b))).toEqual([
        'Open: billing.invoices',
        'Open: crm.contacts',
        'Open: crm.leads',
        'Open: shop.orders',
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
    expect(await screen.findByText('connection refused')).toBeTruthy();

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
    await waitFor(() => expect(openRows()).toEqual(['Open: db9.in_db9']));
  });
});
