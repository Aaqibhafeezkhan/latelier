import type { ReactNode } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, titleBar, waitFor, within } from '../helpers/render';
import { itReturnsFocusToPopoverTrigger } from '../helpers/popoverFocusReturn';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { ConnectionTransferProvider } from '../../src/features/connections/ConnectionTransferProvider';
import { collectionTabFixture, installAtelierMock, multiConnectionMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { Connection, ConnectionRuntime, ConnectionSummary, WorkspaceTab, CollectionTab } from '@shared/types';

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

// Testing decisions call for fixture density: ~9 Connections, two
// long names, two near-identical prod entries. A switcher looks fine with
// two rows and falls apart at nine — this is the shape that would expose it.
const NINE_CONNECTIONS: ConnectionSummary[] = [
  conn({ id: 'c1', name: 'Prod — US East', host: 'prod-us-east.cluster0.mongodb.net', status: 'connected' }),
  conn({ id: 'c2', name: 'Prod — EU West', host: 'prod-eu-west.cluster0.mongodb.net', status: 'unknown' }),
  conn({ id: 'c3', name: 'Staging', host: 'staging.cluster0.mongodb.net', status: 'unknown' }),
  conn({ id: 'c4', name: 'Local Dev', host: 'localhost', port: 27017, status: 'unknown' }),
  conn({ id: 'c5', name: 'QA Sandbox', host: 'qa-sandbox.internal.example.com', status: 'error' }),
  conn({
    id: 'c6',
    name: 'Analytics Warehouse Replica Set Primary',
    host: 'analytics-warehouse-replica-primary.internal.example.com',
    status: 'unknown',
  }),
  conn({
    id: 'c7',
    name: 'Customer Support Read Replica (us-west-2)',
    host: 'support-read-replica-us-west-2.cluster9.mongodb.net',
    status: 'connecting',
  }),
  conn({ id: 'c8', name: 'Backup Cluster', host: 'backup.cluster0.mongodb.net', status: 'unknown' }),
  conn({ id: 'c9', name: 'Legacy Reporting', host: 'legacy-reporting.internal.example.com', status: 'unknown' }),
];

// a full `Connection` (not just the `ConnectionSummary` list rows use)
// for tests that hydrate the edit-mode form via `conn.get`.
const CANNED_STAGING: Connection = {
  id: 'c3',
  name: 'Staging',
  color: '#1A6835',
  connectionType: 'standard',
  readOnly: false,
  host: 'staging.cluster0.mongodb.net',
  port: 27017,
  authMech: 'none',
  tls: { enabled: false, verify: true },
  advanced: {
    connectTimeoutMs: 10_000,
    socketTimeoutMs: 30_000,
    serverSelectionTimeoutMs: 30_000,
    readPreference: 'primary',
    maxPoolSize: 100,
    directConnection: false,
  },
  hasPasswordStored: false,
  hasSshPasswordStored: false,
  hasSshPassphraseStored: false,
  createdAt: now,
  updatedAt: now,
};

function collectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: 'orders',
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

/** A tab store that actually mutates, so closing a tab really removes it. */
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

/**
 * A `conn.list` backing array plus a `conn.delete` spy that actually mutates
 * it — so a delete-then-reopen spec sees the Connection really gone, not
 * just a spy that was called.
 */
function deletableBacking(initial: ConnectionSummary[]) {
  const backing = [...initial];
  const deleteSpy = vi.fn(async (id: string) => {
    const idx = backing.findIndex((c) => c.id === id);
    if (idx >= 0) backing.splice(idx, 1);
  });
  return { backing, deleteSpy };
}

/** The TitleBar lives in the AppShell header; scope queries to it. */
/**
 * X16.1 — this file's world is nine Connections and, by default, no
 * open tab, so the Data View has no Connection to name. Matching the
 * `Connection:` prefix of the trigger's own aria-label covers both that and
 * the specs that do focus a tab. The Main pane's empty state renders a second
 * trigger with the same name, hence the TitleBar scope.
 */
async function openSwitcher() {
  const trigger = await titleBar().findByRole('button', { name: /^Connection: / });
  await userEvent.click(trigger);
  return screen.findByRole('listbox', { name: 'Connections' });
}

function searchField() {
  // `combobox`, not `textbox`: the search field drives the listbox through
  // `aria-activedescendant`, and the role is what makes screen readers
  // announce the roving highlight at all.
  return screen.getByRole('combobox', { name: /search connections/i }) as HTMLInputElement;
}

/**
 * The name of the row the keyboard highlight is currently on, read the way
 * assistive tech reads it: `aria-activedescendant` on the search field, which
 * is what makes a roving highlight announceable while focus never leaves the
 * input. `null` when nothing is highlighted.
 */
function highlightedName(): string | null {
  const id = searchField().getAttribute('aria-activedescendant');
  if (!id) return null;
  return document.getElementById(id)?.getAttribute('aria-label') ?? null;
}

/**
 * The text assistive tech would read as an element's description — resolved
 * the way AT resolves it, by following `aria-describedby` to the elements it
 * names, rather than by reaching for the markup that happens to carry it.
 */
function describedTextOf(el: HTMLElement): string {
  const ids = el.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
  return ids
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}

/** Renders the current pathname so ⌘↵'s navigation is observable. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

/**
 * Every spec in this file wants the same world — nine Connections, no open
 * tabs — and differs only in which slice of the bridge it overrides or spies
 * on. Installing the mock here keeps that shape in one place, and `extra`
 * mounts a sibling of the Data View for the specs that need something outside
 * the popover to press keys against.
 */
type MockOverrides = NonNullable<Parameters<typeof installAtelierMock>[0]>;
function mount(
  opts: {
    connections?: ConnectionSummary[];
    mongo?: MockOverrides['mongo'];
    tabs?: MockOverrides['tabs'];
    conn?: Omit<NonNullable<MockOverrides['conn']>, 'list'>;
    /**
     * X16.1 — opens one tab on this Connection and focuses it, which is
     * the only way the Data View has a Connection at all now. Default: no
     * tabs, so the Data View names none — the state most specs here want,
     * since they are about the popover and not about what is behind it.
     */
    focusedConnectionId?: string;
    extra?: ReactNode;
  } = {},
) {
  const connections = opts.connections ?? NINE_CONNECTIONS;
  const focused = opts.focusedConnectionId
    ? multiConnectionMock({
        connections,
        tabs: [{ connectionId: opts.focusedConnectionId, isActive: true }],
      }).tabs
    : { list: async () => [] };
  installAtelierMock({
    tabs: opts.tabs ?? focused,
    conn: { list: async () => connections, ...opts.conn },
    ...(opts.mongo ? { mongo: opts.mongo } : {}),
  });
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      {/* The App-level owner of the Import Wizard, which the table's Paste URIs opens. */}
      <ConnectionTransferProvider>
        <Workspace />
        <LocationProbe />
        {opts.extra}
      </ConnectionTransferProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  delete (window as unknown as { __atelierEnv__?: unknown }).__atelierEnv__;
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('ConnectionSwitcher', () => {
  it('opens from the TitleBar Connection name and lists every saved Connection', async () => {
    mount();

    const listbox = await openSwitcher();
    for (const c of NINE_CONNECTIONS) {
      expect(within(listbox).getByRole('option', { name: c.name })).toBeTruthy();
    }
  });

  it('discards a typed filter when the popover is dismissed, so reopening shows every Connection', async () => {
    mount();

    const listbox = await openSwitcher();
    const search = searchField();
    await userEvent.type(search, 'zzzz');
    expect(within(listbox).getByText(/No connections match "zzzz"/i)).toBeTruthy();

    // Dismiss without picking anything. `query` lives on the component, which
    // stays mounted while only the dropdown unmounts — so without an explicit
    // reset the next open still shows the "no matches" state and the user
    // appears to have lost every Connection.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
    });

    const reopened = await openSwitcher();
    const reopenedSearch = searchField();
    expect(reopenedSearch.value).toBe('');
    for (const c of NINE_CONNECTIONS) {
      expect(within(reopened).getByRole('option', { name: c.name })).toBeTruthy();
    }
  });

  it('shows a "no connections yet" empty state rather than an empty quoted search when none are saved', async () => {
    mount({ connections: [] });

    // With no Connections the trigger reads "Select a connection", and its
    // accessible name reports the absence rather than naming a Connection
    // that doesn't exist. Scoped to the TitleBar — with zero Connections the
    // Main pane's empty state renders its own `variant="cta"` trigger with
    // the same accessible name, so an unscoped query would find two.
    await userEvent.click(
      await titleBar().findByRole('button', { name: /Connection: none selected/i }),
    );
    const listbox = await screen.findByRole('listbox', { name: 'Connections' });

    expect(within(listbox).getByText(/No connections yet/i)).toBeTruthy();
    expect(within(listbox).queryByText(/No connections match/i)).toBeNull();
  });

  it('reconnects when a Connection whose last attempt failed is clicked, rather than doing nothing', async () => {
    const connectSpy = vi.fn(async () => undefined as never);
    // c1's last attempt failed. Clicking its row is the obvious retry
    // gesture, so it must still connect.
    const errored = NINE_CONNECTIONS.map((c) =>
      c.id === 'c1' ? { ...c, status: 'error' as const } : c,
    );
    mount({ connections: errored, mongo: { connect: connectSpy as never } });

    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('option', { name: 'Prod — US East' }));

    await waitFor(() => expect(connectSpy).toHaveBeenCalledWith('c1'));
  });

  it('search filters on name, case-insensitively', async () => {
    mount();

    const listbox = await openSwitcher();
    const search = searchField();
    // "legacy reporting" with a space appears in c9's NAME but not in its host
    // (`legacy-reporting…` is hyphenated), so this can only match via the name
    // clause. Do not "simplify" this to a string the host also contains — the
    // test would then survive deleting the name clause entirely.
    await userEvent.type(search, 'LEGACY REPORTING');

    expect(within(listbox).getByRole('option', { name: 'Legacy Reporting' })).toBeTruthy();
    expect(within(listbox).queryByRole('option', { name: 'Prod — US East' })).toBeNull();
  });

  it('search filters on host, case-insensitively', async () => {
    mount();

    const listbox = await openSwitcher();
    const search = searchField();
    // "cluster9" appears only in c7's HOST — its name has no such substring,
    // and every other fixture host is on cluster0 — so this can only match via
    // the host clause. Deleting the host clause makes this test fail, which is
    // the whole point: searching a string the name also contains would not.
    await userEvent.type(search, 'CLUSTER9');

    expect(
      within(listbox).getByRole('option', { name: 'Customer Support Read Replica (us-west-2)' }),
    ).toBeTruthy();
    expect(within(listbox).queryByRole('option', { name: 'Staging' })).toBeNull();
  });

  it('shows an empty state naming what was typed when nothing matches', async () => {
    mount();

    await openSwitcher();
    const search = searchField();
    await userEvent.type(search, 'zzzznotfound');

    expect(await screen.findByText(/zzzznotfound/)).toBeTruthy();
  });

  it('marks every connected Connection, not one active one', async () => {
    // X16.4, §4.6 — the row marker became a *connected* marker,
    // because several Connections can be open at once. Two connected rows
    // here, and both must carry it: a marker that could only ever land on one
    // row would pass a single-connected fixture.
    const twoOpen = NINE_CONNECTIONS.map((c) =>
      c.id === 'c3' ? { ...c, status: 'connected' as const } : c,
    );
    mount({ connections: twoOpen, focusedConnectionId: 'c1' });

    const listbox = await openSwitcher();
    expect(
      within(listbox).getByRole('option', { name: 'Prod — US East' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      within(listbox).getByRole('option', { name: 'Staging' }).getAttribute('aria-selected'),
    ).toBe('true');
    // Two check marks, not one — the visible half of the same fact.
    expect(within(listbox).getAllByLabelText('Connected')).toHaveLength(2);
    // A Connection with no live client is not marked.
    expect(
      within(listbox).getByRole('option', { name: 'Local Dev' }).getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('clicking a row connects it, opens no tab, and closes nobody else’s', async () => {
    // X16.4 §4.6 — the acceptance criterion, and the inverse of what
    // this test asserted before: switching used to close the other
    // Connection's tabs. Two Connections, both connected, a tab on each, and
    // the row clicked is the *second* one — a click that only ever spared the
    // first Connection's tabs would pass a one-sided fixture.
    const twoOpen = NINE_CONNECTIONS.map((c) =>
      c.id === 'c3' ? { ...c, status: 'connected' as const } : c,
    );
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({ id: 't2', connectionId: 'c3', collection: 'invoices', position: 1, isActive: false }),
    ]);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      tabs: store,
      conn: { list: async () => twoOpen },
      mongo: { connect },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await screen.findByLabelText('Close orders');
    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('option', { name: 'Staging' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    // Let any (bugged) teardown run before asserting nothing was destroyed.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    // Both Connections' tabs are still on screen.
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
    expect(screen.getByLabelText('Close invoices')).toBeTruthy();
    // And no tab was opened for the Connection just clicked.
    expect(screen.getAllByLabelText(/^Close /)).toHaveLength(2);
    // The Focused Tab did not move, so the TitleBar still names its Connection.
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();
  });

  it('clicking a row closes the popover', async () => {
    mount();

    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('option', { name: 'Staging' }));

    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull());
  });

  it('updates a row status live via mongo.onStatus without reopening the popover', async () => {
    const listeners = new Set<(r: ConnectionRuntime) => void>();
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: {
        onStatus: (cb) => {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
      },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    const listbox = await openSwitcher();
    const stagingRow = within(listbox).getByRole('option', { name: 'Staging' });
    expect(stagingRow.querySelector('[data-status="unknown"]')).toBeTruthy();

    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    act(() => {
      for (const cb of listeners) cb({ id: 'c3', status: 'connected' });
    });

    await waitFor(() => {
      expect(stagingRow.querySelector('[data-status="connected"]')).toBeTruthy();
    });
    // Still open — the update did not reopen or reset the popover.
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();
  });

  it('renders connecting, connected, error and never-tried with distinct status bands', async () => {
    mount();

    const listbox = await openSwitcher();
    const connectedRow = within(listbox).getByRole('option', { name: 'Prod — US East' });
    const connectingRow = within(listbox).getByRole('option', {
      name: 'Customer Support Read Replica (us-west-2)',
    });
    const errorRow = within(listbox).getByRole('option', { name: 'QA Sandbox' });
    const neverTriedRow = within(listbox).getByRole('option', { name: 'Staging' });

    const bandOf = (row: HTMLElement, status: string) =>
      row.querySelector(`[data-status="${status}"]`) as HTMLElement | null;

    const connectedBand = bandOf(connectedRow, 'connected');
    const connectingBand = bandOf(connectingRow, 'connecting');
    const errorBand = bandOf(errorRow, 'error');
    const neverTriedBand = bandOf(neverTriedRow, 'unknown');

    expect(connectedBand).toBeTruthy();
    expect(connectingBand).toBeTruthy();
    expect(errorBand).toBeTruthy();
    expect(neverTriedBand).toBeTruthy();

    const colors = [connectedBand, connectingBand, errorBand, neverTriedBand].map(
      (el) => el!.style.background,
    );
    expect(new Set(colors).size).toBe(4);
  });

  // the band above is colour and nothing else. WCAG 1.4.1: status has
  // to reach someone who can't see it, and this is the list where knowing
  // which server is live decides what you press next.
  it('announces each row’s status in words, not colour alone', async () => {
    mount();

    const listbox = await openSwitcher();
    for (const [name, expected] of [
      ['Prod — US East', /connected/i],
      ['Customer Support Read Replica (us-west-2)', /connecting/i],
      ['QA Sandbox', /failed/i],
      ['Staging', /not connected/i],
    ] as const) {
      const row = within(listbox).getByRole('option', { name });
      expect(describedTextOf(row)).toMatch(expected);
    }

    // The Connection's identity stays the accessible *name*; status rides
    // along as the description, so the name doesn't churn as a server
    // connects and every row query in this file keeps working.
    expect(within(listbox).getByRole('option', { name: 'Staging' })).toBeTruthy();
  });

  // two Connections that look and sound alike by name ("Prod — US
  // East" / "Prod — EU West") must still be told apart by ear, via the host
  // riding along in the row's description.
  it('announces each row’s host, so similarly-named Connections are distinguishable by ear', async () => {
    mount();

    const listbox = await openSwitcher();
    const usEast = within(listbox).getByRole('option', { name: 'Prod — US East' });
    const euWest = within(listbox).getByRole('option', { name: 'Prod — EU West' });

    expect(describedTextOf(usEast)).toMatch(/prod-us-east\.cluster0\.mongodb\.net/i);
    expect(describedTextOf(euWest)).toMatch(/prod-eu-west\.cluster0\.mongodb\.net/i);
  });

  it('updates the spoken status when a connection status event arrives', async () => {
    const listeners = new Set<(r: ConnectionRuntime) => void>();
    mount({
      mongo: {
        onStatus: (cb) => {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
      },
    });

    const listbox = await openSwitcher();
    const stagingRow = within(listbox).getByRole('option', { name: 'Staging' });
    expect(describedTextOf(stagingRow)).toMatch(/not connected/i);

    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    act(() => {
      for (const cb of listeners) cb({ id: 'c3', status: 'connected' });
    });

    // A stale description is worse than none — it would state the opposite of
    // what the band shows.
    await waitFor(() => expect(describedTextOf(stagingRow)).toMatch(/connected/i));
  });

  it('a Switcher click during an in-flight "Open workspace" cancels nothing — both land', async () => {
    // X16.4 — the inverse of the race this used to guard. A navigation
    // carrying an `openCollection` used to await `closeAll()` first, so a
    // Switcher click in that window had to *abandon* the older flow or it
    // would open a tab on a Connection the user had left. Nothing is torn
    // down any more, so there is nothing to abandon: the navigation opens its
    // collection and the clicked Connection connects, and neither cancels the
    // other.
    const openCollectionSpy = vi.fn(async () => collectionTab({ id: 't-nav' }) as never);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));

    let rows: WorkspaceTab[] = [collectionTab({ id: 't-old', connectionId: 'c1' })];
    installAtelierMock({
      tabs: {
        list: async () => rows,
        close: (async (id: string) => {
          rows = rows.filter((t) => t.id !== id);
        }) as never,
        setActive: (async (id: string) => {
          rows = rows.map((t) => ({ ...t, isActive: t.id === id }));
        }) as never,
        openCollection: openCollectionSpy as never,
      },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });

    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/workspace',
            state: {
              openConnectionId: 'c3',
              openCollection: { dbName: 'db', collection: 'orders' },
            },
          },
        ]}
      >
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));

    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('option', { name: 'QA Sandbox' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c5'));
    // The navigation's own collection still opened — it was never superseded.
    await waitFor(() =>
      expect(openCollectionSpy).toHaveBeenCalledWith({
        connectionId: 'c3',
        dbName: 'db',
        collection: 'orders',
      }),
    );
    // And the tab that was already open survived both.
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
  });
});

// Add/edit a Connection in a modal over the Data View, hosted from the
// Switcher. Payoff for the earlier form extraction: the same `ConnectionForm`, a
// second host.
describe('ConnectionSwitcher — add/edit', () => {
  it('the full form, reached from the table, opens as a modal over the Data View', async () => {
    mount();

    await openAddForm();

    const dialog = await screen.findByRole('dialog', { name: 'New Connection' });
    expect(within(dialog).getByPlaceholderText(/My MongoDB Server/i)).toBeTruthy();
    expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
    // Still the Data View underneath — a modal, not a navigation.
    expect(screen.getByTestId('pathname').textContent).toBe('/workspace');
  });

  it('"Manage connections" is guarded against Enter falling through to the roving-highlight contract', async () => {
    // Regression: the button lives inside `Popover.Dropdown`, whose own
    // `onKeyDown` is `handleKeyDown` — its Enter case unconditionally acts on
    // the *highlighted row*. Without a `stopPropagation` guard on the button
    // itself, Tab-ing to it and pressing Enter would switch to the
    // highlighted Connection (and close its tabs) instead of opening the
    // table — the button's click handler never even running, since
    // `handleKeyDown`'s Enter case also calls `preventDefault`.
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect } });

    await openSwitcher();
    await userEvent.tab(); // search field → "Manage connections", the first tab stop
    expect(screen.getByRole('button', { name: 'Manage connections' })).toBe(document.activeElement);

    await userEvent.keyboard('{Enter}');

    await screen.findByRole('dialog', { name: 'Connections' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('⌘E still opens the table while "Manage connections" holds focus', async () => {
    // With zero Connections this button is where focus lands on open; its
    // Enter guard must not swallow the shortcut the legend advertises.
    mount({ connections: [] });
    await userEvent.click(await titleBar().findByRole('button', { name: /Connection: none selected/i }));
    const manage = await screen.findByRole('button', { name: 'Manage connections' });
    await waitFor(() => expect(document.activeElement).toBe(manage));

    fireEvent.keyDown(manage, { key: 'e', metaKey: true });

    await screen.findByRole('dialog', { name: 'Connections' });
    expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
  });

  it('offers no Add, Import or Export of its own — those live in the table', async () => {
    mount();
    const listbox = await openSwitcher();
    const dropdown = listbox.parentElement!;
    expect(within(dropdown).queryByRole('button', { name: /add connection/i })).toBeNull();
    expect(within(dropdown).queryByRole('button', { name: /import/i })).toBeNull();
    expect(within(dropdown).queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('a row’s edit button opens the same form as a modal, prefilled from that Connection, without switching to it', async () => {
    const getSpy = vi.fn(async () => CANNED_STAGING);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect }, conn: { get: getSpy as never } });

    const listbox = await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Staging');
    await userEvent.click(within(listbox).getByRole('button', { name: 'Edit Staging' }));

    expect(getSpy).toHaveBeenCalledWith('c3');
    const dialog = await screen.findByRole('dialog', { name: 'Edit Connection' });
    await waitFor(() => {
      expect((within(dialog).getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe(
        'Staging',
      );
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('the highlighted row’s edit button is guarded against Enter falling through to the roving-highlight contract', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect }, conn: { get: async () => CANNED_STAGING } });

    await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Staging');
    // search field → "Manage connections" → manage → the highlighted row's
    // edit button. Staging has never been tried this session, so the disconnect
    // button doesn't sit between manage and edit here — see the "only for a
    // connected Connection" case elsewhere for that row's tab order.
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Edit Staging' })).toBe(document.activeElement);

    await userEvent.keyboard('{Enter}');

    await screen.findByRole('dialog', { name: 'Edit Connection' });
    // A row-select (switch), not just a management-screen detour, is the
    // failure mode this button's own `stopPropagation` guards against.
    expect(connect).not.toHaveBeenCalled();
  });

  it('creating a Connection from the modal connects it and does not navigate away', async () => {
    // Mutated in place, not rebound: `mount` closes over this array by
    // reference, so a fresh binding would never reach `conn.list`.
    const backing = [...NINE_CONNECTIONS];
    const createSpy = vi.fn(async () => {
      backing.push(conn({ id: 'new1', name: 'Fresh', host: 'fresh.example.com', status: 'unknown' }));
      return { id: 'new1' } as never;
    });
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ connections: backing, mongo: { connect }, conn: { create: createSpy as never } });

    await openAddForm();
    await screen.findByRole('dialog', { name: 'New Connection' });

    await userEvent.type(screen.getByPlaceholderText(/My MongoDB Server/i), 'Fresh');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'fresh.example.com');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');
    fireEvent.click(screen.getByText(/^Save$/));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    await waitFor(() => expect(connect).toHaveBeenCalledWith('new1'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Connection' })).toBeNull());
    // X16.4 — the new Connection is *connected* (asserted above), not
    // named in the TitleBar: opening a Connection opens no tab, and the
    // trigger names the Focused Tab's Connection. With still no tab open, it
    // names none.
    expect(titleBar().getByRole('button', { name: 'Connection: none selected' })).toBeTruthy();
    expect(screen.getByTestId('pathname').textContent).toBe('/workspace');
  });

  it('editing another Connection from the modal neither connects it nor moves the Focused Tab', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const updateSpy = vi.fn(async () => CANNED_STAGING as never);
    mount({ mongo: { connect }, conn: { get: async () => CANNED_STAGING, update: updateSpy as never } , focusedConnectionId: 'c1' });

    const listbox = await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await userEvent.click(within(listbox).getByRole('button', { name: 'Edit Staging' }));
    await screen.findByRole('dialog', { name: 'Edit Connection' });
    fireEvent.click(screen.getByText(/Save changes/i));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit Connection' })).toBeNull());
    expect(connect).not.toHaveBeenCalled();
    // Still Prod — editing Staging must not move where the user is.
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();
  });

  it('editing a Connection that is open reconnects it, without closing its tabs', async () => {
    // A mongo-relevant field change makes `ConnectionService` drop the
    // client server-side (electron/mongo/ConnectionService.ts) — this is the
    // first host where a user can edit the Connection they're currently on
    // without first navigating away, so nothing else would ever reconnect it.
    const store = tabStore([collectionTab({ connectionId: 'c1', collection: 'orders' })]);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const updateSpy = vi.fn(
      async () =>
        ({ id: 'c1', name: 'Prod — US East', host: 'prod-us-east.cluster0.mongodb.net' }) as never,
    );
    mount({
      tabs: store,
      mongo: { connect },
      conn: {
        get: async () => ({ ...CANNED_STAGING, id: 'c1', name: 'Prod — US East' }),
        update: updateSpy as never,
      },
    });

    // c1 ("Prod — US East") is the open Connection and the default highlight.
    await screen.findByLabelText('Close orders');
    await openSwitcher();
    const listbox = screen.getByRole('listbox', { name: 'Connections' });
    await userEvent.click(within(listbox).getByRole('button', { name: 'Edit Prod — US East' }));
    await screen.findByRole('dialog', { name: 'Edit Connection' });
    fireEvent.click(screen.getByText(/Save changes/i));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c1'));
    // Reconnecting must not tear down its own tabs. X16.4 — nothing
    // tears down anybody's tabs any more, but this is still the assertion
    // that would catch a reconnect that closed them.
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
  });

  it('editing a Connection whose last connect failed reconnects it with the corrected config', async () => {
    // Fixing a wrong host is the main reason this modal is ever opened on an
    // errored Connection, so a save has to retry — the base connected
    // unconditionally and an `error` Connection was reachable as the Active
    // one. An earlier pass narrowed this to `connected` and dropped the
    // flow; `error` and `connecting` both mean the user is working on this
    // Connection right now.
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const updateSpy = vi.fn(async () => ({ id: 'c5', name: 'QA Sandbox' }) as never);
    // c5 ("QA Sandbox") is the fixture's `status: 'error'` row.
    mount({
      mongo: { connect },
      conn: {
        get: async () => ({ ...CANNED_STAGING, id: 'c5', name: 'QA Sandbox' }),
        update: updateSpy as never,
      },
    });

    const listbox = await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('QA Sandbox');
    await userEvent.click(within(listbox).getByRole('button', { name: 'Edit QA Sandbox' }));
    await screen.findByRole('dialog', { name: 'Edit Connection' });
    fireEvent.click(screen.getByText(/Save changes/i));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c5'));
  });

  it('cancelling the modal leaves the Data View and the Connection list unchanged', async () => {
    const createSpy = vi.fn();
    mount({ conn: { create: createSpy as never } , focusedConnectionId: 'c1' });

    await openAddForm();
    const dialog = await screen.findByRole('dialog', { name: 'New Connection' });

    // Scoped to the dialog: the navigator behind it can be showing a
    // "Cancel connecting" button on a Connecting root, and a global text query
    // matches that one too.
    fireEvent.click(within(dialog).getByText(/^Cancel$/));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Connection' })).toBeNull());
    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('pathname').textContent).toBe('/workspace');
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();
  });
});

// the remaining ADR 0001 row actions (manage, disconnect, delete),
// reachable inline on the highlighted row rather than a per-row `⋯` menu.
// Manage and disconnect already have keyboard coverage above (⌘↵, ⌫); these
// specs cover the pointer path plus delete, which has none.
describe('ConnectionSwitcher — manage/disconnect/delete row actions', () => {
  it('shows manage, disconnect, edit and delete only on the highlighted row — no per-row menu anywhere else', async () => {
    mount();
    const listbox = await openSwitcher();
    // c1 ("Prod — US East") is highlighted on open and is connected.
    expect(within(listbox).getByRole('button', { name: 'Manage Prod — US East' })).toBeTruthy();
    expect(within(listbox).getByRole('button', { name: 'Disconnect Prod — US East' })).toBeTruthy();
    expect(within(listbox).getByRole('button', { name: 'Edit Prod — US East' })).toBeTruthy();
    expect(within(listbox).getByRole('button', { name: 'Delete Prod — US East' })).toBeTruthy();
    // Every other row — including another live one — has no actions and no
    // `⋯`-style menu trigger. ADR 0001's original per-row menu was replaced,
    // not supplemented.
    expect(within(listbox).queryByRole('button', { name: /Prod — EU West/ })).toBeNull();
    expect(within(listbox).queryByRole('button', { name: /^More/i })).toBeNull();
    expect(within(listbox).queryByLabelText(/options|actions menu/i)).toBeNull();
  });

  it('the manage button opens the highlighted Connection’s management screen and closes the popover, without switching to it', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect } });

    const listbox = await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Staging');
    await userEvent.click(within(listbox).getByRole('button', { name: 'Manage Staging' }));

    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/connections/c3'));
    expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('offers the disconnect button only for a Connection that is actually connected', async () => {
    mount();
    const listbox = await openSwitcher();
    expect(within(listbox).getByRole('button', { name: 'Disconnect Prod — US East' })).toBeTruthy();

    await userEvent.keyboard('{ArrowDown}{ArrowDown}'); // c3, Staging — never tried this session
    expect(highlightedName()).toBe('Staging');
    expect(within(listbox).queryByRole('button', { name: /^Disconnect/ })).toBeNull();
  });

  // X16.6, spec §4.3 — Cancel. The one row action that is deliberately
  // not gated on the roving highlight, and the reason is in the component's own
  // comment: the highlighted-row rule (ADR 0001) assumes the user is already
  // looking at the row they mean, and a connect hanging on an unreachable host
  // is the case where they are not. `c7` is `connecting` in the fixture and is
  // never the highlighted row, which is exactly what makes this discriminate.
  it('offers Cancel on a Connection that is still connecting, without waiting for the highlight to reach it', async () => {
    mount();
    const listbox = await openSwitcher();
    expect(highlightedName()).toBe('Prod — US East');

    expect(
      within(listbox).getByRole('button', {
        name: 'Cancel connecting to Customer Support Read Replica (us-west-2)',
      }),
    ).toBeTruthy();
    // Still no per-row action set anywhere else: the never-tried rows carry
    // nothing, and the connecting row carries Cancel and nothing more.
    expect(within(listbox).queryByRole('button', { name: /Prod — EU West/ })).toBeNull();
    expect(
      within(listbox).queryByRole('button', {
        name: /^(Manage|Edit|Delete|Disconnect) Customer Support/,
      }),
    ).toBeNull();
  });

  it('Cancel calls disconnect for the connecting Connection and leaves every other row alone', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({ mongo: { disconnect } });
    const listbox = await openSwitcher();

    await userEvent.click(
      within(listbox).getByRole('button', {
        name: 'Cancel connecting to Customer Support Read Replica (us-west-2)',
      }),
    );

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c7'));
    expect(disconnect).toHaveBeenCalledTimes(1);
    // c1 is connected and untouched — still marked as the Switcher's own
    // "this one is live". Cancelling one Connection drops one client.
    expect(
      within(listbox).getByRole('option', { name: 'Prod — US East' }).getAttribute('aria-selected'),
    ).toBe('true');
    // Same as Disconnect: dropping a client is not leaving the Switcher.
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByTestId('pathname').textContent).toBe('/workspace');
  });

  // X16 §4.6 — the button now opens a confirmation naming the
  // Connection and its tab count before it disconnects anything.
  it('the disconnect button opens a confirmation naming the Connection and its tab count, and disconnect is not called until confirmed', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({ id: 't2', connectionId: 'c1', collection: 'invoices', position: 1, isActive: false }),
    ]);
    mount({ mongo: { disconnect }, tabs: store });

    const listbox = await openSwitcher();
    expect(highlightedName()).toBe('Prod — US East');
    await userEvent.click(within(listbox).getByRole('button', { name: 'Disconnect Prod — US East' }));

    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod — US East"?' });
    expect(within(dialog).getByText(/closes 2 open tabs/)).toBeTruthy();
    // Not yet — only the confirm click in the dialog may trigger it.
    expect(disconnect).not.toHaveBeenCalled();
  });

  // X16 §4.6 acceptance criteria — confirming closes exactly that
  // Connection's tabs and leaves every other Connection's tabs untouched.
  it('confirming disconnect closes exactly that Connection\'s tabs and leaves another Connection\'s alone', async () => {
    const twoOpen = NINE_CONNECTIONS.map((c) =>
      c.id === 'c3' ? { ...c, status: 'connected' as const } : c,
    );
    const disconnect = vi.fn(async (id: string) => ({ id }));
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({ id: 't2', connectionId: 'c3', collection: 'invoices', position: 1, isActive: false }),
    ]);
    mount({ connections: twoOpen, tabs: store, mongo: { disconnect } });

    await screen.findByLabelText('Close orders');
    const listbox = await openSwitcher();
    // c1 ("Prod — US East") is highlighted on open.
    await userEvent.click(within(listbox).getByRole('button', { name: 'Disconnect Prod — US East' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod — US East"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(screen.queryByLabelText('Close orders')).toBeNull());
    // Staging's tab, which this disconnect has nothing to do with, stays.
    expect(screen.getByLabelText('Close invoices')).toBeTruthy();
    expect(disconnect).not.toHaveBeenCalledWith('c3');
  });

  it('confirming the disconnect dialog disconnects the highlighted Connection and leaves the popover open, without navigating away', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({ mongo: { disconnect } });

    const listbox = await openSwitcher();
    expect(highlightedName()).toBe('Prod — US East');
    await userEvent.click(within(listbox).getByRole('button', { name: 'Disconnect Prod — US East' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod — US East"?' });
    // Zero-tabs case gets its own sentence, not "closes 0 open tabs".
    expect(within(dialog).getByText(/has no open tabs/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
    // Scoped by name: the Switcher popover itself also carries `role="dialog"`
    // and, unlike Delete, stays open behind Disconnect's confirm — a bare
    // `queryByRole('dialog')` would match the popover forever.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Disconnect "Prod — US East"?' })).toBeNull(),
    );
    // Matches the ⌫ shortcut: dropping a client is not leaving the Switcher.
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();
    // The acceptance criterion's actual wording is "no redirect" — assert
    // the pathname itself, not just that some listbox is on screen.
    expect(screen.getByTestId('pathname').textContent).toBe('/workspace');
  });

  /**
   * X16 §4.6 says Disconnect "closes that Connection's tabs". The tab list
   * arrives over IPC one microtask after mount, and the Switcher opens with
   * row 0 already highlighted, so both the ⌫ shortcut and this button are
   * live before it lands. Acting in that window used to read an unloaded
   * `tabsRef` as "no tabs": the dialog said so, the user accepted it, and the
   * tabs then appeared anyway.
   *
   * MUTATION TARGET — drop `if (tabsRef.current.loading) return;` from
   * `requestDisconnect` and the first assertion goes red: the confirm opens
   * on an empty tab list.
   */
  it('the disconnect button waits for the tab list rather than confirming "no open tabs"', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({ id: 't2', connectionId: 'c1', collection: 'invoices', position: 1, isActive: false }),
    ]);
    let land!: () => void;
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    mount({
      mongo: { disconnect },
      tabs: { ...store, list: async () => { await landed; return store.list(); } },
    });

    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('button', { name: 'Disconnect Prod — US East' }));

    expect(screen.queryByRole('dialog', { name: 'Disconnect "Prod — US East"?' })).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();

    await act(async () => {
      land();
      await landed;
    });
    await screen.findByLabelText('Close orders');

    await userEvent.click(
      within(await screen.findByRole('listbox', { name: 'Connections' }))
        .getByRole('button', { name: 'Disconnect Prod — US East' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod — US East"?' });
    expect(within(dialog).getByText(/closes 2 open tabs/)).toBeTruthy();
  });

  /**
   * The same window on the delete path, where the consequence is worse: the
   * Connection is destroyed, so tabs left behind point at one that no longer
   * exists.
   *
   * MUTATION TARGET — drop `if (tabsRef.current.loading) return;` from
   * `openDeleteConnectionModal` and the first assertion goes red.
   */
  it('the delete button waits for the tab list rather than confirming "no open tabs"', async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({ id: 't2', connectionId: 'c1', collection: 'invoices', position: 1, isActive: false }),
    ]);
    let land!: () => void;
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    mount({
      conn: { delete: deleteSpy as never },
      tabs: { ...store, list: async () => { await landed; return store.list(); } },
    });

    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('button', { name: 'Delete Prod — US East' }));

    expect(screen.queryByRole('dialog', { name: 'Delete "Prod — US East"?' })).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();

    await act(async () => {
      land();
      await landed;
    });
    await screen.findByLabelText('Close orders');

    // Reopened, not re-queried: the delete action closes the popover before
    // the handler runs (unlike disconnect), so the refused click costs the
    // popover as well. Still the right trade against destroying a Connection
    // under a confirm that undercounted its tabs.
    await userEvent.click(
      within(await openSwitcher()).getByRole('button', { name: 'Delete Prod — US East' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete "Prod — US East"?' });
    expect(within(dialog).getByText(/2 open tabs/)).toBeTruthy();
  });

  it('cancelling the disconnect confirmation disconnects nothing and closes nothing', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    const closeSpy = vi.fn(async () => ({ newActiveId: null }));
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
    ]);
    store.close = closeSpy as never;
    mount({ mongo: { disconnect }, tabs: store });

    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('button', { name: 'Disconnect Prod — US East' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod — US East"?' });
    fireEvent.click(within(dialog).getByText('Cancel'));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Disconnect "Prod — US East"?' })).toBeNull(),
    );
    expect(disconnect).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();
  });

  it('recovers focus to the search field when the live status event that follows a disconnect click unmounts the button holding it', async () => {
    // Regression: the disconnect button is gated on `presentation.live`
    // (its own acceptance criterion — only offered while actually connected),
    // and it's the one row action that deliberately leaves the popover open
    // rather than closing it. Click it, and the pool's `mongo:status-event`
    // repaints the row to `disconnected` — which unmounts the very button
    // that still holds focus. With nothing else to claim it, focus would
    // otherwise fall to `<body>`, and since `handleKeyDown` only lives on the
    // dropdown, every keyboard path into the still-open popover — Escape
    // included — would go dead until the user clicks out or reopens it.
    const listeners = new Set<(r: { id: string; status: string }) => void>();
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({
      mongo: {
        disconnect,
        onStatus: (cb: (r: { id: string; status: string }) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      } as never,
    });

    const listbox = await openSwitcher();
    const disconnectButton = within(listbox).getByRole('button', {
      name: 'Disconnect Prod — US East',
    });
    await userEvent.click(disconnectButton);
    // the click opens the confirmation; only confirming it disconnects.
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod — US East"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Disconnect "Prod — US East"?' })).toBeNull(),
    );
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));

    act(() => {
      for (const cb of listeners) cb({ id: 'c1', status: 'disconnected' });
    });
    // The row repainted and the button that held focus is gone.
    await waitFor(() =>
      expect(within(listbox).queryByRole('button', { name: /^Disconnect/ })).toBeNull(),
    );

    // Focus landed back on the search field, not `<body>` — so the popover
    // is still drivable...
    expect(document.activeElement).toBe(searchField());
    // ...which this proves directly: Escape still closes it.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
  });

  it('recovers focus to the search field when moving the mouse to a different row unmounts the button holding it', async () => {
    // A second, independent path to the same focus loss as the test above:
    // the whole row-actions cluster is gated on `isHighlighted`, so
    // Tab-focusing a button on one row and then moving the mouse over a
    // *different* row unmounts the first row's buttons — no click, no
    // status event, just the highlight moving — out from under whichever
    // button held focus.
    mount();
    const listbox = await openSwitcher();
    const manageButton = within(listbox).getByRole('button', { name: 'Manage Prod — US East' });
    manageButton.focus();
    expect(manageButton).toBe(document.activeElement);

    fireEvent.mouseMove(within(listbox).getByRole('option', { name: 'Prod — EU West' }));

    await waitFor(() => expect(highlightedName()).toBe('Prod — EU West'));
    await waitFor(() =>
      expect(within(listbox).queryByRole('button', { name: 'Manage Prod — US East' })).toBeNull(),
    );
    expect(document.activeElement).toBe(searchField());
  });

  it('the delete button opens a confirmation dialog naming the Connection and closes the popover', async () => {
    mount();
    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('button', { name: 'Delete Prod — US East' }));

    expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
    expect(await screen.findByRole('dialog', { name: 'Delete "Prod — US East"?' })).toBeTruthy();
  });

  it('cancelling the delete confirmation leaves the Connection saved and unchanged', async () => {
    const deleteSpy = vi.fn(async () => undefined);
    mount({ conn: { delete: deleteSpy as never } , focusedConnectionId: 'c1' });

    const listbox = await openSwitcher();
    await userEvent.click(within(listbox).getByRole('button', { name: 'Delete Prod — US East' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete "Prod — US East"?' });
    fireEvent.click(within(dialog).getByText('Cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();
  });

  it('confirming delete destroys that Connection and removes it from the Switcher, leaving the Focused Tab where it was', async () => {
    const { backing, deleteSpy } = deletableBacking(NINE_CONNECTIONS);
    mount({ connections: backing, conn: { delete: deleteSpy as never } , focusedConnectionId: 'c1' });

    const listbox = await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}'); // c3, Staging — not the Focused Tab's
    expect(highlightedName()).toBe('Staging');
    await userEvent.click(within(listbox).getByRole('button', { name: 'Delete Staging' }));
    await screen.findByRole('dialog', { name: 'Delete "Staging"?' });
    // docs/adr/0013 — Delete stays disabled until the name is typed back.
    fireEvent.change(screen.getByRole('textbox', { name: 'Confirm connection name' }), {
      target: { value: 'Staging' },
    });
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('c3'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();

    const reopened = await openSwitcher();
    expect(within(reopened).queryByRole('option', { name: 'Staging' })).toBeNull();
  });

  it('deleting a Connection closes its own tabs and leaves another Connection\'s alone', async () => {
    // this used to fall forward to `connections[0]` (whichever
    // Connection was next in the list). ADR 0001 replaced that with an
    // explicit empty state.
    //
    // X16.4 — delete used to close *every* tab, which was only ever
    // right because one Connection owned them all. Two Connections with tabs
    // here, and deleting the first must not touch the second's.
    const twoOpen = NINE_CONNECTIONS.map((c) =>
      c.id === 'c3' ? { ...c, status: 'connected' as const } : c,
    );
    const store = tabStore([
      collectionTab({ id: 't1', connectionId: 'c1', collection: 'orders', isActive: true }),
      collectionTab({ id: 't2', connectionId: 'c3', collection: 'invoices', position: 1, isActive: false }),
    ]);
    const { backing, deleteSpy } = deletableBacking(twoOpen);
    mount({ connections: backing, tabs: store, conn: { delete: deleteSpy as never } });

    await screen.findByLabelText('Close orders');
    const listbox = await openSwitcher();
    // c1 ("Prod — US East") is highlighted on open.
    await userEvent.click(within(listbox).getByRole('button', { name: 'Delete Prod — US East' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete "Prod — US East"?' });
    // the count is c1's own tab (1), not both Connections' combined (2).
    expect(within(dialog).getByText(/closes 1 open tab\b/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Confirm connection name' }), {
      target: { value: 'Prod — US East' },
    });
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('c1'));
    // Not a Data View still pointed at a collection tab on a Connection that
    // no longer exists...
    await waitFor(() => expect(screen.queryByLabelText('Close orders')).toBeNull());
    // ...and Staging's tab, which this delete has nothing to do with, stays.
    expect(screen.getByLabelText('Close invoices')).toBeTruthy();
  });

  it('deleting the only saved Connection leaves the trigger showing no Connection selected, not broken', async () => {
    // A dedicated "Empty state" is a later ticket's UI — this only
    // asserts the trigger's accessible name falls back correctly once
    // `connections` is empty, not that a dedicated empty-state screen exists.
    const { backing, deleteSpy } = deletableBacking([conn({ id: 'c1', name: 'Solo', status: 'connected' })]);
    mount({ connections: backing, conn: { delete: deleteSpy as never } , focusedConnectionId: 'c1' });

    // The only Connection is the Focused Tab's — not "Prod — US East", so
    // this can't use the shared `openSwitcher()` helper.
    await userEvent.click(await screen.findByRole('button', { name: /Solo/i }));
    const listbox = await screen.findByRole('listbox', { name: 'Connections' });
    await userEvent.click(within(listbox).getByRole('button', { name: 'Delete Solo' }));
    await screen.findByRole('dialog', { name: 'Delete "Solo"?' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Confirm connection name' }), {
      target: { value: 'Solo' },
    });
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('c1'));
    // Scoped to the TitleBar: with zero Connections left, the Main pane's
    // empty state also renders its own `variant="cta"` Switcher trigger with
    // the same accessible name, so an unscoped query would find two.
    await waitFor(() =>
      expect(titleBar().getByRole('button', { name: 'Connection: none selected' })).toBeTruthy(),
    );
  });

  it('the highlighted row’s delete button is guarded against Enter falling through to the roving-highlight contract', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect } });

    await openSwitcher();
    // c1 ("Prod — US East") is highlighted on open and connected, so all four
    // actions render: search field → Manage connections → manage →
    // disconnect → edit → delete.
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Delete Prod — US East' })).toBe(document.activeElement);

    await userEvent.keyboard('{Enter}');

    // A row-select (switch, closing tabs) is the failure mode this button's
    // own `stopPropagation` guards against — not just a missing confirm.
    await screen.findByRole('dialog', { name: 'Delete "Prod — US East"?' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('Esc still closes the popover while focus is on a row action button', async () => {
    // Regression check: each row action `ActionIcon`'s `onKeyDown` guard
    // stops propagation unconditionally, not just for Enter/Space — so this
    // isn't obvious from reading the guard alone. It stays safe because Mantine's
    // own close-on-Escape handler is wired as `onKeyDownCapture` on the
    // dropdown (see PopoverDropdown), which runs in the capture phase and so
    // fires on the way *down* to this button, before our bubble-phase
    // `stopPropagation` on the button ever runs.
    mount();
    const listbox = await openSwitcher();
    const manageButton = within(listbox).getByRole('button', { name: 'Manage Prod — US East' });
    manageButton.focus();
    expect(manageButton).toBe(document.activeElement);

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
  });

  it('an arrow key while focus is on a row action button is inert rather than moving the highlight out from under focus', async () => {
    // The same unconditional `stopPropagation` also swallows ↑/↓ while focus
    // is on a row action button — `handleKeyDown` (which owns the highlight)
    // is bound via bubble-phase `onKeyDown` on that same dropdown, so the
    // button's bubble-phase guard, being the target, runs first and the
    // event never reaches it. Confirms the highlight can't move — and this
    // button unmount from under itself — while a keyboard user is sitting on
    // one of these buttons.
    mount();
    const listbox = await openSwitcher();
    const manageButton = within(listbox).getByRole('button', { name: 'Manage Prod — US East' });
    manageButton.focus();

    await userEvent.keyboard('{ArrowDown}');

    expect(document.activeElement).toBe(manageButton);
    expect(within(listbox).getByRole('button', { name: 'Manage Prod — US East' })).toBeTruthy();
  });
});

/**
 * the expanded surface the ADR 0001 prototype findings added. `⌘E` and
 * the popover's "Manage connections" button both open it; opening it always closes the
 * popover (ADR 0001: the two are never on screen together), and its footer
 * actions are deliberately routed through the same handlers the popover uses
 * for manage/edit/delete/switch, which the "closes the table" assertions
 * below indirectly confirm — a parallel implementation would have no reason
 * to close anything.
 */
async function openExpandedTable() {
  await openSwitcher();
  // Pinned above the listbox, a sibling of it — not inside it.
  await userEvent.click(screen.getByRole('button', { name: 'Manage connections' }));
  return screen.findByRole('dialog', { name: 'Connections' });
}

/** The full form: the table's "+ New" (C13 §7). */
async function openAddForm() {
  const dialog = await openExpandedTable();
  await userEvent.click(within(dialog).getByRole('button', { name: '+ New' }));
}

/** The `<tr>` for a given Connection's row, found via its visible name cell. */
function tableRow(dialog: HTMLElement, name: string): HTMLElement {
  const row = within(dialog).getByText(name).closest('tr');
  if (!row) throw new Error(`No table row found for "${name}"`);
  return row;
}

describe('ConnectionSwitcher — expanded table', () => {
  it('"Manage connections" opens the expanded table and closes the popover', async () => {
    mount();
    const dialog = await openExpandedTable();

    expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull();
    expect(within(dialog).getByText('Prod — US East')).toBeTruthy();
  });

  it('focuses the search field when the table opens, so "search-first" holds inside a Modal too', async () => {
    // Regression: Mantine's `FocusTrap` (which `Modal` wraps its body in)
    // looks for `[data-autofocus]` first and only falls back to "the first
    // tabbable element" if it finds none — and that fallback is the Modal's
    // own header close button, rendered before the body. The React
    // `autoFocus` prop (which works fine inside the popover, since `Popover`
    // doesn't focus-trap) sets a plain DOM attribute the trap never looks at.
    mount();
    const dialog = await openExpandedTable();

    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('textbox', { name: /search connections/i }),
      ),
    );
  });

  it('carries the popover’s typed search into the table, rather than discarding it', async () => {
    // The issue's own motivating scenario: narrow to tell "Prod — US East"
    // and "Prod — EU West" apart, then expand — losing the three letters
    // just typed would defeat the point of expanding from a live search.
    mount();
    const listbox = await openSwitcher();
    await userEvent.type(searchField(), 'prod');
    expect(within(listbox).queryByRole('option', { name: 'Staging' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Manage connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connections' });

    expect(
      (within(dialog).getByRole('textbox', { name: /search connections/i }) as HTMLInputElement)
        .value,
    ).toBe('prod');
    expect(within(dialog).getByText('Prod — US East')).toBeTruthy();
    expect(within(dialog).queryByText('Staging')).toBeNull();
  });

  it('returns focus to the TitleBar Connection trigger when the table closes', async () => {
    // Matches the popover's own behavior (`ConnectionSwitcher.tsx`'s
    // `wasOpenRef` effect) for the same reason: without it, closing drops a
    // keyboard user at `<body>`, the top of the Data View's tab order.
    // Mantine `Modal`'s own `returnFocus` can't do this on its own — by the
    // time the table mounts, the popover's "Manage connections" button it would have
    // captured as "previous focus" is already unmounted.
    mount({ focusedConnectionId: 'c1' });
    const trigger = await screen.findByRole('button', { name: /Connection: Prod — US East/i });
    await openExpandedTable();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('returns focus to the empty-state CTA trigger — not the TitleBar trigger — when opened from there', async () => {
    // Regression: both the TitleBar's `title` trigger and the empty state's
    // `cta` trigger are mounted at once whenever no tab is open
    //, and the fix keys focus-return off the trigger that actually
    // fired `onExpand`, not a DOM-wide "the Switcher trigger" query — a query
    // like that has no way to prefer the one the user actually used, and used
    // to land back on the TitleBar trigger regardless of which one opened it.
    mount({ connections: [] });
    const ctaTrigger = await screen.findByRole('button', { name: 'Select a connection' });

    await userEvent.click(ctaTrigger);
    await screen.findByRole('listbox', { name: 'Connections' });
    await userEvent.click(screen.getByRole('button', { name: 'Manage connections' }));
    await screen.findByRole('dialog', { name: 'Connections' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(ctaTrigger));
  });

  it('offers "+ New" instead of a dead end when there are no saved Connections', async () => {
    // With zero Connections there is nothing to select, so no row action ever
    // renders — without this, a first-run `⌘E` could only be escaped, never
    // acted on. This button is a permanent footer fixture (not only shown
    // in the empty-state cell), and the only place a Connection is added.
    mount({ connections: [] });
    // Scoped to the TitleBar — with zero Connections the Main pane's empty
    // state renders its own `variant="cta"` trigger with the same accessible
    // name, so an unscoped query would find two.
    await userEvent.click(await titleBar().findByRole('button', { name: /Connection: none selected/i }));
    await screen.findByRole('listbox', { name: 'Connections' });
    await userEvent.click(screen.getByRole('button', { name: 'Manage connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connections' });

    await userEvent.click(within(dialog).getByRole('button', { name: '+ New' }));

    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
    await screen.findByRole('dialog', { name: 'New Connection' });
  });

  it('⌘E opens the expanded table and closes the popover', async () => {
    mount();
    await openSwitcher();

    fireEvent.keyDown(searchField(), { key: 'e', metaKey: true });

    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull());
    expect(await screen.findByRole('dialog', { name: 'Connections' })).toBeTruthy();
  });

  it('⌘E opens the table from the Data View with the Switcher closed, every time', async () => {
    // Regression: ⌘E used to work only inside the open Switcher, so after
    // the table closed (and with it the popover) the shortcut did nothing.
    mount();
    await titleBar().findByRole('button', { name: /^Connection: / });
    for (let i = 0; i < 2; i++) {
      fireEvent.keyDown(document.body, { key: 'e', metaKey: true });
      expect(await screen.findByRole('dialog', { name: 'Connections' })).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull());
    }
  });

  it('leaves ⌘E alone inside an open dialog, and with Shift or Alt held', async () => {
    mount();
    await titleBar().findByRole('button', { name: /^Connection: / });
    fireEvent.keyDown(document.body, { key: 'e', metaKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'e', ctrlKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();

    fireEvent.keyDown(document.body, { key: 'E', ctrlKey: true });
    const table = await screen.findByRole('dialog', { name: 'Connections' });
    await userEvent.click(within(table).getByRole('button', { name: 'Paste URIs' }));
    const add = await screen.findByRole('dialog', { name: 'Import Connections' });
    fireEvent.keyDown(within(add).getByRole('textbox', { name: /paste connection strings/i }), { key: 'e', metaKey: true });
    // Still exactly one table, and the Import Wizard is still on top of it.
    expect(screen.getAllByRole('dialog', { name: 'Connections' })).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Import Connections' })).toBeTruthy();
  });

  it('leaves Ctrl+E to a text field as end-of-line, while ⌘E there still opens the table', async () => {
    mount();
    await titleBar().findByRole('button', { name: /^Connection: / });
    const field = document.createElement('input');
    document.body.append(field);
    try {
      expect(fireEvent.keyDown(field, { key: 'e', ctrlKey: true })).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();

      expect(fireEvent.keyDown(field, { key: 'e', metaKey: true })).toBe(false);
      expect(await screen.findByRole('dialog', { name: 'Connections' })).toBeTruthy();
    } finally {
      field.remove();
    }
  });

  it('keeps ⌘E as Explain on an Aggregation tab', async () => {
    mount({
      tabs: {
        list: async () => [
          collectionTabFixture({
            isActive: true,
            state: { ...collectionTabFixture().state, activeView: 'aggregation' },
          }),
        ],
      },
    });
    await titleBar().findByRole('button', { name: /^Connection: Prod/ });
    fireEvent.keyDown(document.body, { key: 'e', metaKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
  });

  it('a bare "e" with no modifier types into the search field instead of expanding', async () => {
    mount();
    await openSwitcher();

    await userEvent.type(searchField(), 'e');

    expect(searchField().value).toBe('e');
    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();
  });

  it('lists every saved Connection with name, host (+ type), status and last used, and a match count', async () => {
    mount();
    const dialog = await openExpandedTable();

    expect(within(dialog).getByText('9 of 9')).toBeTruthy();
    expect(within(dialog).getByText('prod-us-east.cluster0.mongodb.net:27017')).toBeTruthy();
    // Type folds into the host cell as a dimmed suffix, not its own
    // column, so its own text is "· Standard" rather than "Standard" alone.
    expect(within(dialog).getAllByText(/Standard/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Connected')).toBeTruthy();
    // The table's Status column uses `presentation.label` ("Error"), not
    // `presentation.spoken` ("Last connection attempt failed") — that full
    // sentence is the popover's `VisuallyHidden` description text, too long
    // for a column cell sitting next to "Connected".
    expect(within(dialog).getByText('Error')).toBeTruthy();
    // c1 has no `lastUsedAt` in the fixture.
    expect(within(dialog).getAllByText('Never').length).toBeGreaterThan(0);
  });

  it('search matches name and host, identically to the popover, and updates the match count', async () => {
    mount();
    const dialog = await openExpandedTable();
    const search = within(dialog).getByRole('textbox', { name: /search connections/i });

    // Host-only match, same fixture as the popover's own host-search spec.
    await userEvent.type(search, 'CLUSTER9');

    expect(within(dialog).getByText('1 of 9')).toBeTruthy();
    expect(within(dialog).getByText('Customer Support Read Replica (us-west-2)')).toBeTruthy();
    expect(within(dialog).queryByText('Staging')).toBeNull();
  });

  it('clicking a row reveals its detail inline; clicking it again collapses it', async () => {
    mount({ conn: { get: async () => CANNED_STAGING } });
    const dialog = await openExpandedTable();

    await userEvent.click(tableRow(dialog, 'Staging'));
    expect(await within(dialog).findByText(/Default DB/i)).toBeTruthy();

    await userEvent.click(tableRow(dialog, 'Staging'));
    await waitFor(() => expect(within(dialog).queryByText(/Default DB/i)).toBeNull());
  });

  it.each([
    ['TLS off on a remote host', { tls: { enabled: false, verify: true } }, 'Disabled, plaintext to a remote host', true],
    ['TLS on, certificate unverified', { tls: { enabled: true, verify: false } }, 'Enabled, unverified', true],
    ['TLS off on localhost', { host: 'localhost', tls: { enabled: false, verify: true } }, 'Disabled', false],
    ['TLS on and verified', { tls: { enabled: true, verify: true } }, 'Enabled, verified', false],
  ])('detail row, %s: states the TLS posture in text and colours only weak ones', async (_n, patch, text, weak) => {
    mount({ conn: { get: async () => ({ ...CANNED_STAGING, ...patch }) as Connection } });
    const dialog = await openExpandedTable();
    await userEvent.click(tableRow(dialog, 'Staging'));
    const field = (await within(dialog).findByText('TLS')).parentElement!;
    expect(field.textContent).toBe(`TLS · ${text}`);
    const [, value] = Array.from(field.querySelectorAll('span'));
    expect(value?.style.color ?? '').toBe(weak ? 'var(--atelier-red-text)' : '');
  });

  it('caches a row’s detail across collapse/expand instead of refetching it', async () => {
    // The detail row unmounts on collapse, discarding its own state — without
    // a cache one level up (in the table itself, which stays mounted for the
    // whole session), re-opening a row already viewed — e.g. while comparing
    // two similarly-named Connections — re-fetches and re-shows "Loading…"
    // every time.
    const getSpy = vi.fn(async () => CANNED_STAGING);
    mount({ conn: { get: getSpy } });
    const dialog = await openExpandedTable();

    await userEvent.click(tableRow(dialog, 'Staging'));
    expect(await within(dialog).findByText(/Default DB/i)).toBeTruthy();
    expect(getSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(tableRow(dialog, 'Staging'));
    await waitFor(() => expect(within(dialog).queryByText(/Default DB/i)).toBeNull());

    await userEvent.click(tableRow(dialog, 'Staging'));
    expect(await within(dialog).findByText(/Default DB/i)).toBeTruthy();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('the search field keeps focus; ArrowDown moves a highlight and Enter selects it, so the footer is reachable without a mouse', async () => {
    mount({ conn: { get: async () => CANNED_STAGING } });
    const dialog = await openExpandedTable();
    const search = within(dialog).getByRole('textbox', { name: /search connections/i });

    // Unfiltered order is Prod — US East, Prod — EU West, Staging, ... —
    // two ArrowDowns from the initial highlight reaches Staging.
    search.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(search);

    await userEvent.keyboard('{Enter}');

    expect(await within(dialog).findByText(/Default DB/i)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // Focus never left the search field.
    expect(document.activeElement).toBe(search);

    // Enter again toggles it back off, same as a second click.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(within(dialog).queryByText(/Default DB/i)).toBeNull());
  });

  it('ArrowDown/Up move the highlight without opening a row’s detail or rendering row actions', async () => {
    // Matches the popover's own contract: arrowing past a row is a visual
    // pointer only — nothing "happens" (detail opens, actions render) until
    // an explicit Enter or click commits to it.
    mount();
    const dialog = await openExpandedTable();
    const search = within(dialog).getByRole('textbox', { name: /search connections/i });

    search.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');

    expect(within(dialog).queryByText(/Default DB/i)).toBeNull();
    // no footer to disable: Connect simply isn't rendered on any row
    // until one is selected.
    expect(within(dialog).queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('does not let a key it handles reach the Data View’s window shortcuts', async () => {
    // Same trap as the popover's own guarded test above: this Modal sits
    // above `AggregationTab`'s window-level ⌘↵ listener, which never checks
    // `defaultPrevented`. Without `stopPropagation` on the search field's
    // `onKeyDown`, ⌘↵ here both toggles the highlighted row's detail *and*
    // runs the pipeline behind the modal.
    const keysSeenByWindow: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => keysSeenByWindow.push(e.key);
    window.addEventListener('keydown', onWindowKey);
    try {
      mount();
      const dialog = await openExpandedTable();
      const search = within(dialog).getByRole('textbox', { name: /search connections/i });
      search.focus();
      keysSeenByWindow.length = 0;

      await userEvent.keyboard('{ArrowDown}{ArrowUp}');
      await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

      expect(keysSeenByWindow).not.toContain('ArrowDown');
      expect(keysSeenByWindow).not.toContain('ArrowUp');
      expect(keysSeenByWindow).not.toContain('Enter');
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('holds on to its keys even when the search matches nothing', async () => {
    // The empty-match case is the dangerous one, same reasoning as the
    // popover: there's no row to act on, but the window listeners behind the
    // modal are still live.
    const keysSeenByWindow: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => keysSeenByWindow.push(e.key);
    window.addEventListener('keydown', onWindowKey);
    try {
      mount();
      const dialog = await openExpandedTable();
      const search = within(dialog).getByRole('textbox', { name: /search connections/i });
      await userEvent.type(search, 'zzzz');
      expect(within(dialog).getByText('0 of 9')).toBeTruthy();
      keysSeenByWindow.length = 0;

      await userEvent.keyboard('{ArrowDown}{ArrowUp}');
      await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

      expect(keysSeenByWindow).not.toContain('ArrowDown');
      expect(keysSeenByWindow).not.toContain('ArrowUp');
      expect(keysSeenByWindow).not.toContain('Enter');
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('row actions render only on the selected row, gone again once deselected', async () => {
    // `conn.get`, not the unused-stub default: selecting a row mounts
    // `ConnectionDetailRow`, which fetches detail regardless of what this
    // test asserts — an unhandled rejection here would be silent noise, not
    // a failure this test is about.
    mount({ conn: { get: async () => CANNED_STAGING } });
    const dialog = await openExpandedTable();

    // the footer action bar is gone; Connect/Manage/Edit/Delete
    // render on the selected row only, matching the popover's own
    // aria-labels (`Manage ${name}` / `Edit ${name}` / `Delete ${name}`).
    // Connect alone stays a plain-labelled button — it's the reason the
    // surface exists.
    expect(within(dialog).queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Manage Staging' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Edit Staging' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete Staging' })).toBeNull();

    await userEvent.click(tableRow(dialog, 'Staging'));

    expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Manage Staging' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Edit Staging' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Delete Staging' })).toBeTruthy();

    // Deselecting (second click) drops the actions again — they belong to
    // "selected", not "was ever selected this session".
    await userEvent.click(tableRow(dialog, 'Staging'));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Connect' })).toBeNull());
  });

  it('Connect connects the selected Connection and closes the table', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect }, conn: { get: async () => CANNED_STAGING } });
    const dialog = await openExpandedTable();

    await userEvent.click(tableRow(dialog, 'Staging'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull());
  });

  it('Edit closes the table and opens the Connection form prefilled, without switching', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const getSpy = vi.fn(async () => CANNED_STAGING);
    mount({ mongo: { connect }, conn: { get: getSpy as never } , focusedConnectionId: 'c1' });
    const dialog = await openExpandedTable();

    await userEvent.click(tableRow(dialog, 'Staging'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Staging' }));

    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
    expect(getSpy).toHaveBeenCalledWith('c3');
    const formDialog = await screen.findByRole('dialog', { name: 'Edit Connection' });
    await waitFor(() => {
      expect(
        (within(formDialog).getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value,
      ).toBe('Staging');
    });
    expect(connect).not.toHaveBeenCalled();
    // Regression: the table's focus-return-to-trigger only fires from an
    // actual "just close" gesture (Escape / the header's × / outside click),
    // never from a row action that hands off to another surface in the
    // same commit — Edit does exactly that, unmounting the table straight
    // into this form. Wiring the return unconditionally to unmount would
    // race the form's own focus trap for a coin-flip winner; the trigger
    // must lose every time.
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: /Connection: Prod — US East/i }),
    );
  });

  it('Manage closes the table and opens the Collections & indexes screen, without switching', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect }, conn: { get: async () => CANNED_STAGING } });
    const dialog = await openExpandedTable();

    await userEvent.click(tableRow(dialog, 'Staging'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Manage Staging' }));

    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/connections/c3'));
    expect(connect).not.toHaveBeenCalled();
  });

  it('Delete closes the table and asks for confirmation, same as the popover', async () => {
    const { backing, deleteSpy } = deletableBacking(NINE_CONNECTIONS);
    mount({
      connections: backing,
      conn: { delete: deleteSpy as never, get: async () => CANNED_STAGING },
    });
    const dialog = await openExpandedTable();

    await userEvent.click(tableRow(dialog, 'Staging'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Staging' }));

    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
    await screen.findByRole('dialog', { name: 'Delete "Staging"?' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Confirm connection name' }), {
      target: { value: 'Staging' },
    });
    fireEvent.click(screen.getByText(/^Delete$/));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('c3'));
  });

  it('closing the table (Escape) leaves everything unchanged', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect } , focusedConnectionId: 'c1' });
    await openExpandedTable();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull());
    expect(connect).not.toHaveBeenCalled();
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();
  });
});

// the keyboard contract. Find-and-switch has to be one uninterrupted
// gesture; that is the reason the search-first shape won the prototype, and
// it only pays off if the whole thing is drivable without the mouse.
describe('ConnectionSwitcher keyboard contract', () => {
  it('focuses the search field when the popover opens', async () => {
    mount();

    await openSwitcher();
    await waitFor(() => expect(document.activeElement).toBe(searchField()));
  });

  it('highlights the first row on open', async () => {
    mount();

    await openSwitcher();
    expect(highlightedName()).toBe('Prod — US East');
  });

  it('starts the highlight back at the top when the popover is reopened', async () => {
    mount();

    await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Local Dev');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull());

    // The component stays mounted while only the dropdown unmounts, so a
    // highlight left three rows down would still be there on reopen — pointing
    // a fresh ↵ at whatever happens to sit at that index now.
    await openSwitcher();
    expect(highlightedName()).toBe('Prod — US East');
  });

  it('↓ moves the highlight down and wraps past the last row', async () => {
    mount();

    await openSwitcher();
    // Narrow to a two-row list so the wrap is two keystrokes away rather than
    // nine — the wrap is the assertion, not the walk.
    await userEvent.type(searchField(), 'prod');
    expect(highlightedName()).toBe('Prod — US East');

    await userEvent.keyboard('{ArrowDown}');
    expect(highlightedName()).toBe('Prod — EU West');

    await userEvent.keyboard('{ArrowDown}');
    expect(highlightedName()).toBe('Prod — US East');
  });

  it('↑ moves the highlight up and wraps past the first row', async () => {
    mount();

    await openSwitcher();
    await userEvent.type(searchField(), 'prod');

    await userEvent.keyboard('{ArrowUp}');
    expect(highlightedName()).toBe('Prod — EU West');

    await userEvent.keyboard('{ArrowUp}');
    expect(highlightedName()).toBe('Prod — US East');
  });

  it('keeps the highlight on a row that still exists when filtering shrinks the list beneath it', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect } });

    const listbox = await openSwitcher();
    // Walk down to row 4 ("QA Sandbox"), then type a filter that excludes it.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('QA Sandbox');

    await userEvent.type(searchField(), 'prod');

    // The highlight must land on a row that is actually in the filtered list —
    // a stale index would either point at nothing or, worse, at a Connection
    // the user can no longer see, and ↵ would then switch to it.
    const highlighted = highlightedName();
    expect(highlighted).toBe('Prod — US East');
    expect(within(listbox).getByRole('option', { name: highlighted! })).toBeTruthy();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c1'));
    expect(connect).not.toHaveBeenCalledWith('c5');
  });

  it('↵ connects the highlighted Connection', async () => {
    const store = tabStore([collectionTab({ connectionId: 'c1', collection: 'orders' })]);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ tabs: store, mongo: { connect } });

    await screen.findByLabelText('Close orders');
    await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Staging');

    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull());
    // Opening a Connection opens no tab, so the open one is untouched.
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
  });

  it('⌘↵ opens the highlighted Connection’s management screen without switching to it', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect } });

    await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Staging');

    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/connections/c3'),
    );
    // Manage is a detour, not a switch — it must not connect on the way.
    expect(connect).not.toHaveBeenCalled();
  });

  // X16 §4.6 — ⌫ on a *connected* row opens the same confirmation the
  // Disconnect button does; only confirming it calls disconnect.
  it('⌫ on an empty search opens a disconnect confirmation for the highlighted Connection', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({ mongo: { disconnect } });

    await openSwitcher();
    // c1 is highlighted on open and is the one row with a live client.
    expect(highlightedName()).toBe('Prod — US East');

    await userEvent.keyboard('{Backspace}');

    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod — US East"?' });
    expect(disconnect).not.toHaveBeenCalled();
    // Dropping a client is not leaving the Switcher — the row's status band is
    // what the user came to watch, so the popover stays open behind it.
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
  });

  it('⌫ does nothing on a Connection with no live client', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({ mongo: { disconnect } });

    await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Staging'); // never tried this session

    await userEvent.keyboard('{Backspace}');

    // ⌫ acts on the *highlighted* row, which on open is row 1 rather than
    // whatever the user was looking at, with no prompt and no undo. Confining
    // it to rows that actually hold a client is what stops a reflexive
    // "clear the field" ⌫ from silently killing a server nobody selected.
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('⌫ aborts a connection attempt that is still in flight', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({ mongo: { disconnect } });

    await openSwitcher();
    await userEvent.type(searchField(), 'cluster9'); // c7, mid-connect
    await userEvent.clear(searchField());
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(highlightedName()).toBe('Customer Support Read Replica (us-west-2)');

    await userEvent.keyboard('{Backspace}');

    // `connecting` counts as live: the pool exposes the in-flight client so a
    // slow attempt can be called off, which is half the point of the gesture.
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c7'));
  });

  it('⌫ edits the search text instead of disconnecting when the search is not empty', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({ mongo: { disconnect } });

    const listbox = await openSwitcher();
    await userEvent.type(searchField(), 'stagingx');
    expect(within(listbox).queryByRole('option', { name: 'Staging' })).toBeNull();

    await userEvent.keyboard('{Backspace}');

    expect(searchField().value).toBe('staging');
    expect(within(listbox).getByRole('option', { name: 'Staging' })).toBeTruthy();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('Esc closes the popover and changes nothing', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const disconnect = vi.fn(async (id: string) => ({ id }));
    mount({ mongo: { connect, disconnect } , focusedConnectionId: 'c1' });

    await openSwitcher();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Connections' })).toBeNull());
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(screen.getByTestId('pathname').textContent).toBe('/workspace');
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();
  });

  // #79 — the Escape guard already passed before this fix, since the
  // Switcher's own (pre-existing) effect already special-cased "focus is
  // still inside the dropdown". What it missed is a click that closes the
  // popover on a non-focusable area: Chromium's mousedown default action
  // blurs the search field to <body> there, and nothing recovered from it.
  // Shared with column-chooser/preview-picker/table-view specs — see the
  // helper's docstring.
  describe('focus return on close (#79)', () => {
    itReturnsFocusToPopoverTrigger(async () => {
      mount({ focusedConnectionId: 'c1' });
      const trigger = await screen.findByRole('button', { name: /Connection: Prod — US East/i });
      await openSwitcher();
      return { trigger };
    });
  });

  it('lists three shortcuts in a footer, the rest taught by row-action tooltips', async () => {
    (window as unknown as { __atelierEnv__?: unknown }).__atelierEnv__ = { platform: 'darwin' };
    mount();

    await openSwitcher();

    // down from six entries to the three a pointer user cannot
    // otherwise discover; ⌘↵ manage / ⌫ disconnect / esc close are taught by
    // the row-action tooltips and platform convention instead.
    const legend = screen.getByRole('note', { name: 'Keyboard shortcuts' });
    const text = legend.textContent ?? '';
    expect(text).toContain('↑↓');
    expect(text).toContain('navigate');
    expect(text).toContain('↵');
    expect(text).toContain('connect');
    expect(text).toContain('⌘E');
    // "manage" here is ⌘E's "Manage connections", not the per-row ⌘↵.
    expect(text).toContain('manage');
    expect(text).not.toContain('⌘↵');
    expect(text).not.toContain('disconnect');
    expect(text).not.toContain('esc close');
  });

  it('writes the footer shortcuts for Windows and Linux off a Mac', async () => {
    (window as unknown as { __atelierEnv__?: unknown }).__atelierEnv__ = { platform: 'win32' };
    mount();

    await openSwitcher();

    const text = screen.getByRole('note', { name: 'Keyboard shortcuts' }).textContent ?? '';
    expect(text).toContain('Ctrl+E');
    expect(text).toContain('Enter');
    expect(text).not.toContain('⌘');
  });

  it('does not let a key it handles reach the Data View’s window shortcuts', async () => {
    // `AggregationTab` binds ⌘↵ on `window` and does not check
    // `defaultPrevented`, so `preventDefault` alone is not enough: ⌘↵ in the
    // Switcher would open the management screen *and* run the pipeline
    // underneath. Same trap for ↵ (QueryBar) and ⌫. Assert on `window`
    // directly rather than mounting an aggregation tab — the leak is the
    // mechanism, and every window listener behind the popover inherits it.
    const keysSeenByWindow: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => keysSeenByWindow.push(e.key);
    window.addEventListener('keydown', onWindowKey);
    try {
      mount();
      await openSwitcher();
      keysSeenByWindow.length = 0;

      await userEvent.keyboard('{ArrowDown}');
      await userEvent.keyboard('{Backspace}');
      await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

      // Bare modifier presses are their own keydown and are not ours to
      // swallow — it is the four acted-on keys that must not escape.
      expect(keysSeenByWindow).not.toContain('ArrowDown');
      expect(keysSeenByWindow).not.toContain('Backspace');
      expect(keysSeenByWindow).not.toContain('Enter');
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('holds on to its keys even when the search matches nothing', async () => {
    // The empty list is the dangerous case, not the safe one: there is no row
    // to act on, so it is tempting to bail early — but the window listeners
    // behind the popover are still there, and ⌘↵ reaching `AggregationTab`
    // would run the pipeline underneath a popover showing "no matches".
    // Owning a key while open is a separate question from having something
    // to do with it.
    const keysSeenByWindow: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => keysSeenByWindow.push(e.key);
    window.addEventListener('keydown', onWindowKey);
    try {
      mount();
      const listbox = await openSwitcher();
      await userEvent.type(searchField(), 'zzzz');
      expect(within(listbox).getByText(/No connections match/i)).toBeTruthy();
      expect(highlightedName()).toBeNull();
      keysSeenByWindow.length = 0;

      await userEvent.keyboard('{ArrowDown}{ArrowUp}');
      await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

      expect(keysSeenByWindow).not.toContain('ArrowDown');
      expect(keysSeenByWindow).not.toContain('ArrowUp');
      expect(keysSeenByWindow).not.toContain('Enter');
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('leaves ⏎ to the IME while a composition is in progress', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    mount({ mongo: { connect } });

    await openSwitcher();
    const search = searchField();

    // Someone naming a Connection in Japanese, Chinese or Korean presses ⏎ to
    // commit the IME candidate they are building. Taking that keystroke would
    // connect to whatever row is highlighted and throw the half-typed name
    // away — the search field would be unusable in those languages.
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });

    expect(connect).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();

    // Once the composition ends, ⏎ is the Switcher's again.
    fireEvent.compositionEnd(search);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c1'));
  });

  it('does not intercept arrow keys pressed in an input outside the popover', async () => {
    // A stand-in for any text-entry surface in the Data View — the query bar,
    // the script editor, a rename field. The Switcher must reach these keys
    // only through its own dropdown subtree; a document-level listener would
    // move the highlight (and swallow the caret movement) from anywhere. That
    // scoping is the whole mechanism, which is why there is no separate guard
    // in the handler to test.
    mount({ extra: <textarea aria-label="Elsewhere in the Data View" /> });

    await openSwitcher();
    expect(highlightedName()).toBe('Prod — US East');

    const elsewhere = screen.getByLabelText('Elsewhere in the Data View');
    const down = fireEvent.keyDown(elsewhere, { key: 'ArrowDown' });
    const up = fireEvent.keyDown(elsewhere, { key: 'ArrowUp' });

    expect(down).toBe(true); // not preventDefault()-ed
    expect(up).toBe(true);
    expect(highlightedName()).toBe('Prod — US East');
  });
});

// a read-only Connection gets a lock badge in the row and in the
// trigger, plus a spoken cue, so the restriction is visible before a write
// is ever attempted.
describe('ConnectionSwitcher — read-only indicator', () => {
  it('shows a lock icon and an extra spoken sentence on a read-only row, and not on an ordinary one', async () => {
    const connections = NINE_CONNECTIONS.map((c) =>
      c.id === 'c3' ? { ...c, readOnly: true } : c,
    );
    mount({ connections });

    const listbox = await openSwitcher();
    const readOnlyRow = within(listbox).getByRole('option', { name: 'Staging' });
    expect(within(readOnlyRow).getByTitle('Read-only connection')).toBeTruthy();
    expect(describedTextOf(readOnlyRow)).toMatch(/read-only connection/i);

    const ordinaryRow = within(listbox).getByRole('option', { name: 'Prod — US East' });
    expect(within(ordinaryRow).queryByTitle('Read-only connection')).toBeNull();
    expect(describedTextOf(ordinaryRow)).not.toMatch(/read-only connection/i);
  });

  it('shows the lock indicator on the trigger and folds it into the aria-label when the Focused Tab\'s Connection is read-only', async () => {
    const connections = NINE_CONNECTIONS.map((c) =>
      c.id === 'c1' ? { ...c, readOnly: true } : c,
    );
    mount({ connections , focusedConnectionId: 'c1' });

    const trigger = await titleBar().findByRole('button', { name: /Connection: Prod — US East/i });
    expect(within(trigger).getByTitle('Read-only connection')).toBeTruthy();
    expect(trigger.getAttribute('aria-label')).toMatch(/Read-only connection/i);
  });

  it('does not show a lock indicator on the trigger when the Focused Tab\'s Connection is not read-only', async () => {
    mount({ focusedConnectionId: 'c1' });

    const trigger = await titleBar().findByRole('button', { name: /Connection: Prod — US East/i });
    expect(within(trigger).queryByTitle('Read-only connection')).toBeNull();
    expect(trigger.getAttribute('aria-label')).not.toMatch(/Read-only connection/i);
  });
});
