import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, titleBar, waitFor, within } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, multiConnectionMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';
import type {
  ConnectionSummary,
  WorkspaceTab,
  CollectionTab,
  ScriptTab,
  ShellSessionInfo,
} from '@shared/types';

const now = '2026-07-26T12:00:00.000Z';

function conn(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'c1',
    name: 'Prod',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard',
    readOnly: false,
    status: 'connected',
    ...overrides,
  };
}

function collectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    position: 0,
    isActive: true,
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
    ...overrides,
  };
}

/**
 * A tab store that actually mutates, so closing a tab really empties the list
 * on the next `tabs.list()` the way the real service does.
 */
function tabStore(initial: WorkspaceTab[]) {
  let rows = [...initial];
  return {
    list: async () => rows,
    close: async (id: string) => {
      rows = rows.filter((t) => t.id !== id);
      return { newActiveId: rows.find((t) => t.isActive)?.id ?? null };
    },
    setActive: async (id: string) => {
      rows = rows.map((t) => ({ ...t, isActive: t.id === id }));
      return { id };
    },
  };
}

/** The TitleBar and the tab strip both live in the AppShell header. */
function header() {
  return within(screen.getByRole('banner'));
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('The Focused Tab’s Connection', () => {
  it('names no Connection on a launch with no tab open, however many are saved', async () => {
    // X16.1, spec §4.7 — the Focused Tab is where Connection identity
    // comes from, and a launch with no tabs has none. Quitting with a
    // Connection connected but nothing open used to be restored from a pref;
    // it now lands on the empty state, which is the right answer for a
    // Connection that was not being used.
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => [conn()] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/Select a collection from the sidebar/i)).toBeTruthy());
    expect(titleBar().queryByText('Prod')).toBeNull();
  });

  it('stops naming a Connection once the last tab is closed', async () => {
    // X16.4 — the inverse of what this used to assert. The session pin
    // is what kept the Connection named after its last tab closed, and the
    // pin is retired: identity is the Focused Tab's, and there is no Focused
    // Tab. The navigator still shows the Connection's root, which is where
    // you re-open something from.
    const store = tabStore([collectionTab()]);
    installAtelierMock({
      tabs: store,
      conn: { list: async () => [conn()] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    const close = await screen.findByLabelText('Close coll');
    await userEvent.click(close);

    await waitFor(() => expect(screen.queryByLabelText('Close coll')).toBeNull());
    await waitFor(() =>
      expect(titleBar().getByRole('button', { name: 'Connection: none selected' })).toBeTruthy(),
    );
  });

  it('does not repeat the collection path in the TitleBar', async () => {
    // The TitleBar used to breadcrumb `dbName › collection` next to the
    // Connection name — the same path CollectionHeader already owns. The
    // TabStrip legitimately shows the tab's collection as its label, but
    // dbName never renders anywhere but the retired breadcrumb, so its
    // absence from the banner is the regression guard.
    const store = tabStore([collectionTab({ dbName: 'salesdb', collection: 'orders' })]);
    installAtelierMock({
      tabs: store,
      conn: { list: async () => [conn()] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(header().getByText('orders')).toBeTruthy());
    expect(header().queryByText('salesdb')).toBeNull();
    expect(header().queryByText('(no db)')).toBeNull();
    expect(header().queryByText('(no collection)')).toBeNull();
  });

  it('does not drift when the Connection list is reordered underneath it', async () => {
    // `conn:list` is ordered by last_used_at, and `useConnections` re-fetches on
    // window focus — so touching another Connection elsewhere reorders the
    // list. This used to matter because the Active Connection could
    // fall back to `connections[0]`, so a reorder could silently move it.
    // X16.1 — identity is now the Focused Tab's `connectionId`, an id
    // and never a position, so a reorder cannot move it.
    let calls = 0;
    installAtelierMock({
      tabs: { list: async () => [collectionTab({ connectionId: 'c1' })] },
      conn: {
        list: async () => {
          calls += 1;
          const prod = conn();
          const staging = conn({ id: 'c2', name: 'Staging' });
          return calls === 1 ? [prod, staging] : [staging, prod];
        },
      },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(titleBar().getByText('Prod')).toBeTruthy());

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(calls).toBeGreaterThan(1));
    await waitFor(() => expect(titleBar().getByText('Prod')).toBeTruthy());
    expect(titleBar().queryByText('Staging')).toBeNull();
  });

  it('a Switcher row click connects and opens no tab (§4.6)', async () => {
    // The acceptance criterion. Opening a tab would mean guessing a Database
    // and a Collection, so the click adds a navigator root and nothing else —
    // which also means the TitleBar keeps naming the Focused Tab's
    // Connection, not the one just opened.
    const store = tabStore([collectionTab({ connectionId: 'c1', collection: 'orders' })]);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const openCollection = vi.fn(async () => collectionTab({ id: 't-new' }));
    installAtelierMock({
      tabs: { ...store, openCollection: openCollection as never },
      conn: { list: async () => [conn(), conn({ id: 'c2', name: 'Staging' })] },
      mongo: { connect },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await screen.findByLabelText('Close orders');
    const trigger = titleBar().getByRole('button', { name: /Connection: Prod/i });
    await userEvent.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: 'Connections' });
    await userEvent.click(within(listbox).getByRole('option', { name: 'Staging' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c2'));
    expect(openCollection).not.toHaveBeenCalled();
    // The one open tab is untouched, and it still says where the user is.
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
    expect(titleBar().getByText('Prod')).toBeTruthy();
  });

  it.each([
    { saved: 0, rows: [] as ConnectionSummary[], offered: true },
    { saved: 1, rows: [conn({ status: 'unknown' })], offered: false },
  ])('Import connections on the empty screen with $saved saved: shown=$offered', async ({ rows, offered }) => {
    installAtelierMock({ tabs: { list: async () => [] }, conn: { list: async () => rows } });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(offered ? /No connections yet\. Add one/i : /No connection is open/i)).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Import connections' }) !== null).toBe(offered);
  });

  it('first run: zero Connections show a "New connection" CTA that opens the add form', async () => {
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => [] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/No connections yet\. Add one to get started/i)).toBeTruthy());
    const emptyState = within(
      screen.getByText(/No connections yet\. Add one to get started/i).parentElement as HTMLElement,
    );
    await userEvent.click(emptyState.getByRole('button', { name: 'New connection' }));

    expect(await screen.findByRole('dialog', { name: 'New Connection' })).toBeTruthy();
  });

  it('zero Connections: the TitleBar Switcher still opens in add-mode, focusing "Manage connections"', async () => {
    // ADR 0001's add-mode: with nothing to search, focus lands on the way to
    // add one. The empty-state CTA is no longer a popover here, so the
    // TitleBar trigger is the way in.
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => [] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await userEvent.click(await titleBar().findByRole('button', { name: /Connection: none selected/i }));

    const manageButton = await screen.findByRole('button', { name: 'Manage connections' });
    await waitFor(() => expect(document.activeElement).toBe(manageButton));
  });

  it('one saved Connection, none open: the empty-state CTA is still the "Select a connection" picker', async () => {
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => [conn({ status: 'unknown' })] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/No connection is open/i)).toBeTruthy());
    // Scoped to the empty state's own container: both triggers render at once.
    const emptyState = within(
      screen.getByText(/No connection is open/i).parentElement as HTMLElement,
    );
    await userEvent.click(emptyState.getByRole('button', { name: 'Select a connection' }));

    expect(await screen.findByRole('listbox', { name: 'Connections' })).toBeTruthy();
  });

  it('treats a Focused Tab whose Connection no longer exists as unrestorable — the empty state, not a crash', async () => {
    // "A Connection that can no longer be restored yields the empty state —
    // not a crash and not a redirect." Simulates a relaunch after the
    // Connection was deleted from another window: the persisted tab still
    // names it, but `conn.list` no longer does.
    installAtelierMock({
      tabs: { list: async () => [collectionTab({ connectionId: 'c1' })] },
      conn: { list: async () => [conn({ id: 'c2', name: 'Staging' })] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    // The tab is still listed — nothing crashes and nothing is silently
    // destroyed — but no Connection is named, because the one its Focused Tab
    // points at is gone. (A dangling Connection gives that tab's pane a not-connected state;
    // here the point is that the shell survives a dangling id.)
    await screen.findByLabelText('Close coll');
    await waitFor(() =>
      expect(titleBar().getByRole('button', { name: 'Connection: none selected' })).toBeTruthy(),
    );
    // Not silently renamed to the Connection that does exist either.
    expect(titleBar().queryByText('Staging')).toBeNull();
  });

  it('disconnecting a Connection closes its tabs and leaves the other Connection\'s open', async () => {
    // Acceptance criterion — the user stays in the Data View with the
    // Switcher available — plus X16.4 §4.6: Disconnect closes *that*
    // Connection's tabs, not every tab. The Connection disconnected is the
    // second one, so a teardown that only ever spared the first would fail.
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({ id: 't2', connectionId: 'c2', collection: 'invoices', position: 1, isActive: false }),
    ]);
    const disconnect = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      tabs: store,
      conn: { list: async () => [conn(), conn({ id: 'c2', name: 'Staging' })] },
      mongo: { disconnect },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await screen.findByLabelText('Close orders');
    const trigger = titleBar().getByRole('button', { name: /Connection: Prod/i });
    await userEvent.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: 'Connections' });
    await userEvent.hover(within(listbox).getByRole('option', { name: 'Staging' }));
    await userEvent.click(within(listbox).getByRole('button', { name: 'Disconnect Staging' }));
    // the click opens a confirmation now; only confirming disconnects.
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Staging"?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c2'));
    // Staging's tab is gone; Prod's is not.
    await waitFor(() => expect(screen.queryByLabelText('Close invoices')).toBeNull());
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
    // Still in the Data View, still naming where the user is.
    expect(titleBar().getByRole('button', { name: /Connection: Prod/i })).toBeTruthy();
  });

  // X16.4 — the strip's "New script" and its "+" picker each need one
  // Connection, and with no tab open there is no Focused Tab to name it.
  // "Connected, but no tab yet" is the *normal* state after §4.6, so leaving
  // these inert there would make a script unreachable by the usual route.
  it('opens a script on the only Open Connection when no tab is open', async () => {
    const openScript = vi.fn(async () => ({ id: 's1' }));
    installAtelierMock({
      tabs: { list: async () => [], openScript: openScript as never },
      conn: {
        list: async () => [conn(), conn({ id: 'c2', name: 'Staging', status: 'unknown' })],
      },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'New script tab' }));

    // c1 is the only one with a live client — not the only one saved, and not
    // simply the first.
    await waitFor(() => expect(openScript).toHaveBeenCalledWith({ connectionId: 'c1' }));
  });

  it('opens the empty state\u2019s picker on the only Open Connection', async () => {
    // Same question as "New script", so it takes the same answer: this empty
    // state only renders with something connected, and exactly one open
    // Connection resolves the picker without a guess.
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: {
        list: async () => [conn(), conn({ id: 'c2', name: 'Staging', status: 'unknown' })],
      },
      meta: {
        listDatabases: async () => [{ name: 'app', sizeOnDisk: 0, empty: false }],
        listCollections: async () => [
          { name: 'users', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
        ],
      } as never,
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: /Open a collection/i }));

    // Populated from c1, the only one with a live client.
    const dbSelect = (await screen.findByLabelText('Database')) as HTMLSelectElement;
    await waitFor(() => expect(dbSelect.value).toBe('app'));
  });

  it('opens no script when two Connections are open and no tab says which', async () => {
    // The guess §4.6 refuses to make. Inert, rather than picking one — the
    // same shape recurs in the command palette.
    const openScript = vi.fn(async () => ({ id: 's1' }));
    installAtelierMock({
      tabs: { list: async () => [], openScript: openScript as never },
      conn: { list: async () => [conn(), conn({ id: 'c2', name: 'Staging' })] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await screen.findByText(/Select a collection from the sidebar/i);
    await userEvent.click(screen.getByRole('button', { name: 'New script tab' }));

    await new Promise((r) => setTimeout(r, 20));
    expect(openScript).not.toHaveBeenCalled();
  });

  it('follows the Focused Tab when it belongs to another Connection', async () => {
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({
        id: 't2',
        connectionId: 'c2',
        collection: 'events',
        position: 1,
        isActive: false,
      }),
    ]);
    installAtelierMock({
      tabs: store,
      conn: { list: async () => [conn(), conn({ id: 'c2', name: 'Staging' })] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(titleBar().getByText('Prod')).toBeTruthy());

    await userEvent.click(await screen.findByText('events'));

    await waitFor(() => expect(titleBar().getByText('Staging')).toBeTruthy());
    expect(titleBar().queryByText('Prod')).toBeNull();
  });

  // X16.1, spec §4.5 — the Focused Tab is `is_active`, not "the first
  // tab". Both tabs below sit in `position` order 0, 1 with the Focused Tab
  // second, so a reading that follows the strip order instead of the focus
  // would name the wrong server here — and, worse, mark a read-only
  // Connection as writable.
  it('names the Focused Tab’s Connection even when another tab comes first in the strip', async () => {
    installAtelierMock({
      ...multiConnectionMock({
        connections: [
          { id: 'c1', name: 'Prod' },
          { id: 'c2', name: 'Staging', readOnly: true },
        ],
        tabs: [
          { id: 't1', connectionId: 'c1', collection: 'orders' },
          { id: 't2', connectionId: 'c2', collection: 'events', isActive: true },
        ],
      }),
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(titleBar().getByText('Staging')).toBeTruthy());
    expect(titleBar().queryByText('Prod')).toBeNull();
    // The read-only marker describes the server the Focused Tab is talking to.
    expect(titleBar().getByTitle('Read-only connection')).toBeTruthy();
  });

  it('moves the read-only marker with the Focused Tab', async () => {
    installAtelierMock({
      ...multiConnectionMock({
        connections: [
          { id: 'c1', name: 'Prod' },
          { id: 'c2', name: 'Staging', readOnly: true },
        ],
        tabs: [
          { id: 't1', connectionId: 'c1', collection: 'orders', isActive: true },
          { id: 't2', connectionId: 'c2', collection: 'events' },
        ],
      }),
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    // Focused on the writable Connection: no marker.
    await waitFor(() => expect(titleBar().getByText('Prod')).toBeTruthy());
    expect(titleBar().queryByTitle('Read-only connection')).toBeNull();

    await userEvent.click(await screen.findByText('events'));

    // Focus moved to the read-only Connection, and the marker moved with it.
    await waitFor(() => expect(titleBar().getByText('Staging')).toBeTruthy());
    expect(titleBar().getByTitle('Read-only connection')).toBeTruthy();
  });
});

describe('The database a Shell or Script tab starts on', () => {
  function scriptTab(dbName?: string): ScriptTab {
    return {
      id: 't1',
      kind: 'script',
      connectionId: 'c1',
      dbName: '',
      collection: '',
      position: 0,
      isActive: true,
      openedAt: now,
      pinned: false,
      state: { title: 'Script', source: '1', dbName },
    };
  }

  function installWithShell(tab: WorkspaceTab, summary: Partial<ConnectionSummary> = {}) {
    const start = vi.fn<IpcApi['mshell']['start']>(
      async (): Promise<ShellSessionInfo> => ({
        sessionId: 's1',
        connectionId: 'c1',
        startedAt: now,
      }),
    );
    const listCollections = vi.fn<IpcApi['meta']['listCollections']>(async () => []);
    installAtelierMock({
      tabs: { list: async () => [tab] },
      conn: { list: async () => [conn(summary)] },
      meta: { listCollections },
      mshell: {
        start,
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: () => () => {},
      },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    return { start, listCollections };
  }

  async function openShell() {
    await userEvent.click(await within(screen.getByRole('banner')).findByRole('button', { name: 'Shell' }));
  }

  it("opens the Shell on a collection tab's own database", async () => {
    const { start } = installWithShell(collectionTab({ dbName: 'shop', collection: 'orders' }), {
      defaultDb: 'smoke',
    });
    await screen.findByLabelText('Close orders');
    await openShell();
    await waitFor(() => expect(start).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop' }));
  });

  it("opens the Shell on a script tab's own database field", async () => {
    const { start } = installWithShell(scriptTab('ledger'), { defaultDb: 'smoke' });
    await screen.findByLabelText('Close Script');
    await openShell();
    await waitFor(() => expect(start).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'ledger' }));
  });

  it('leaves the Shell database to the connection when a script tab has a blank field', async () => {
    const { start } = installWithShell(scriptTab('  '), { defaultDb: 'smoke' });
    await screen.findByLabelText('Close Script');
    await openShell();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0]).toEqual({ connectionId: 'c1' });
  });

  it("completes a blank-field script tab against the connection's default database", async () => {
    const { listCollections } = installWithShell(scriptTab(), { defaultDb: 'smoke' });
    await screen.findByLabelText('Close Script');
    await waitFor(() =>
      expect(listCollections).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'smoke' }),
    );
  });
});
