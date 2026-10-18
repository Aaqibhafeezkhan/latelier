import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, titleBar, waitFor, within, fireEvent, act } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigationType } from 'react-router-dom';
import {
  CommandPaletteRoot,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import { ConnectionPaletteCommands } from '../../src/commands/ConnectionPaletteCommands';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ConnectionSummary, WorkspaceTab, CollectionTab } from '@shared/types';
import type { IpcError } from '@shared/ipc';

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

// Testing decisions call for fixture density — mirrors the fixture in
// tests/component/connection-switcher.spec.tsx so both entry points are
// exercised against the same shape of data.
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

function collectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: 'orders',
    position: 0,
    isActive: true,
    openedAt: '2026-07-26T12:00:00.000Z',
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

/** The TitleBar lives in the AppShell header; scope queries to it. */
// Mantine's useHotkeys (used by Spotlight) listens on document.documentElement,
// not document — dispatch there so the shortcut handler fires. Cribbed from
// tests/component/command-palette-shell.spec.tsx.
function dispatchPaletteToggle() {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const init: KeyboardEventInit = { key: 'k', bubbles: true, cancelable: true };
  if (isMac) init.metaKey = true;
  else init.ctrlKey = true;
  document.documentElement.dispatchEvent(new KeyboardEvent('keydown', init));
}

/**
 * Opens the palette, filters to one Connection's open command, and picks it.
 * X16.4 §4.6 — "Switch to: X" is now "Open connection → X", because
 * choosing one adds a server rather than replacing the one you were on.
 */
async function openViaPalette(name: string) {
  act(() => dispatchPaletteToggle());
  fireEvent.change(screen.getByLabelText('Search commands'), {
    target: { value: `Open connection → ${name}` },
  });
  await screen.findByText(`Open connection → ${name}`);
  // Keyboard nav is bound to the search input, not the option row
  // (combobox pattern — see CommandPalette.tsx) — Enter is fired where a
  // real keyboard user would have focus.
  fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
}

async function openSwitcher() {
  const trigger = await screen.findByRole('button', { name: /^Connection: Prod — US East/i });
  await userEvent.click(trigger);
  return screen.findByRole('listbox', { name: 'Connections' });
}

// Finding 2 (code-review, LOW): records every navigation's type so a test
// can assert PUSH vs REPLACE without reaching into router internals.
let navigationTypes: string[] = [];
function NavigationTypeSpy() {
  const type = useNavigationType();
  React.useEffect(() => {
    navigationTypes.push(type);
  }, [type]);
  return null;
}

function app(initialEntries: string[]) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <ConnectionPaletteCommands />
          <NavigationTypeSpy />
          <Routes>
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/connections/:id" element={<div>connection detail screen</div>} />
          </Routes>
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  vi.restoreAllMocks();
  navigationTypes = [];
});

describe('command palette connection opening', () => {
  it('offers an "Open connection" command per saved Connection', async () => {
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => NINE_CONNECTIONS },
    });
    render(app(['/workspace']));

    // X16.1 — with no tab open the Data View names no Connection, so
    // the settle signal is the palette's own commands, which only register
    // once ConnectionPaletteCommands' `useConnections()` resolves.
    act(() => dispatchPaletteToggle());
    for (const c of NINE_CONNECTIONS) {
      const option = await screen.findByText(`Open connection → ${c.name}`);
      const row = option.closest('[role="option"]') as HTMLElement;
      expect(within(row).getByText(c.host)).toBeTruthy();
    }
  });

  // Every entry point that can open a Connection gets a row here: both route
  // through the same `openConnection` in `Workspace.tsx`.
  const ENTRY_POINTS: [string, () => Promise<void>][] = [
    ['Switcher row', async () => {
      const listbox = await openSwitcher();
      await userEvent.click(within(listbox).getByRole('option', { name: 'Staging' }));
    }],
    ['command palette', async () => {
      await openViaPalette('Staging');
    }],
  ];

  it.each(ENTRY_POINTS)(
    '%s: connects, touches used, and closes no tabs',
    async (_label, runEntryPoint) => {
      // X16.4 — this asserted "closes the outgoing tabs" before. Both
      // entry points now leave every tab alone, and open none of their own.
      const store = tabStore([collectionTab({ connectionId: 'c1', collection: 'orders' })]);
      const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
      const touchUsed = vi.fn(async (id: string) => ({ id }));
      installAtelierMock({
        tabs: store,
        conn: { list: async () => NINE_CONNECTIONS, touchUsed },
        mongo: { connect },
      });

      render(app(['/workspace']));

      await screen.findByLabelText('Close orders');
      await runEntryPoint();

      await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
      await waitFor(() => expect(touchUsed).toHaveBeenCalledWith('c3'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByLabelText('Close orders')).toBeTruthy();
    },
  );

  it('re-picking a Connection that is already open still connects and touches used', async () => {
    // A Connection can be open with `status: 'error'`, and re-picking it is
    // the obvious retry gesture — the command must not be inert.
    const store = tabStore([collectionTab({ id: 't-c3', connectionId: 'c3', collection: 'orders' })]);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const touchUsed = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      tabs: store,
      conn: { list: async () => NINE_CONNECTIONS, touchUsed },
      mongo: { connect },
    });

    render(app(['/workspace']));

    await waitFor(() => expect(titleBar().getByText('Staging')).toBeTruthy());
    await screen.findByLabelText('Close orders');

    await openViaPalette('Staging');

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    await waitFor(() => expect(touchUsed).toHaveBeenCalledWith('c3'));
    expect(screen.queryByLabelText('Close orders')).toBeTruthy();
  });

  it('opening from outside the Data View lands in the Data View and connects', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });
    render(app(['/connections/c1']));

    expect(screen.getByText('connection detail screen')).toBeTruthy();

    await openViaPalette('Staging');

    await waitFor(() => expect(screen.queryByText('connection detail screen')).toBeNull());
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    // No tab was opened, so the Data View names no Connection (§4.6).
    expect(titleBar().getByRole('button', { name: 'Connection: none selected' })).toBeTruthy();
  });

  it('opening the Connection that owns the persisted tabs, from OUTSIDE /workspace, destroys none of them', async () => {
    // The fresh-mount case: arriving from /connections/:id always mounts
    // Workspace with neither `useConnections()` nor `useWorkspaceTabs()`
    // resolved. That window used to be a data-loss path — a switch judged
    // "not already active" against empty state closed every persisted tab.
    // X16.4 removes the judgement and the teardown both.
    const closeSpy = vi.fn(async () => undefined as never);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      tabs: {
        list: async () => [collectionTab({ id: 't-c1', connectionId: 'c1', collection: 'orders' })],
        close: closeSpy,
      },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });

    render(app(['/connections/c1']));
    expect(screen.getByText('connection detail screen')).toBeTruthy();

    await openViaPalette('Prod — US East');

    await waitFor(() => expect(screen.queryByText('connection detail screen')).toBeNull());
    await waitFor(() => expect(titleBar().getByText('Prod — US East')).toBeTruthy());
    // Give any (bugged) in-flight teardown a chance to run before asserting
    // it never did.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
  });

  it('opening a DIFFERENT Connection from OUTSIDE /workspace leaves the persisted tabs open too', async () => {
    // X16.4 — the inverse of what this asserted. A different target
    // used to mean "close the outgoing tabs"; two Connections now coexist, so
    // c1's tab survives an open of c3 exactly as it survives an open of c1.
    const closeSpy = vi.fn(async () => undefined as never);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      tabs: {
        list: async () => [collectionTab({ id: 't-c1', connectionId: 'c1', collection: 'orders' })],
        close: closeSpy,
      },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });

    render(app(['/connections/c1']));
    expect(screen.getByText('connection detail screen')).toBeTruthy();

    await openViaPalette('Staging');

    await waitFor(() => expect(screen.queryByText('connection detail screen')).toBeNull());
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
    // The Focused Tab never moved, so the TitleBar still names c1.
    expect(titleBar().getByText('Prod — US East')).toBeTruthy();
  });

  it('opens the Connection whatever order conn.list and tabs.list resolve in', async () => {
    // The ordering this once decided a no-op switch by. There is no such
    // decision left — but the two subscriptions still resolve in either
    // order on a fresh mount, and the open must land regardless.
    let connCallCount = 0;
    let resolveSecondConnList: (v: ConnectionSummary[]) => void = () => {};
    const secondConnListPromise = new Promise<ConnectionSummary[]>((resolve) => {
      resolveSecondConnList = resolve;
    });
    const connList = vi.fn(async () => {
      connCallCount += 1;
      // Call #1 is ConnectionPaletteCommands' own subscription (mounted from
      // the start, above <Routes>) — resolve it immediately so the palette
      // command is clickable. Call #2 is Workspace's fresh-mount subscription
      // — held open so the test controls when it resolves relative to tabs.
      if (connCallCount === 1) return NINE_CONNECTIONS;
      return secondConnListPromise;
    });

    let rows: WorkspaceTab[] | null = null;
    let resolveTabsList: (v: WorkspaceTab[]) => void = () => {};
    const tabsListPromise = new Promise<WorkspaceTab[]>((resolve) => {
      resolveTabsList = resolve;
    });
    const closeSpy = vi.fn(async (id: string) => {
      if (rows) rows = rows.filter((t) => t.id !== id);
      return { newActiveId: rows?.find((t) => t.isActive)?.id ?? null };
    });
    const tabsList = vi.fn(async () => {
      if (rows === null) rows = await tabsListPromise;
      return rows;
    });
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const touchUsed = vi.fn(async (id: string) => ({ id }));

    installAtelierMock({
      tabs: { list: tabsList, close: closeSpy },
      conn: { list: connList, touchUsed },
      mongo: { connect },
    });

    render(app(['/connections/c1']));
    expect(screen.getByText('connection detail screen')).toBeTruthy();

    await openViaPalette('Prod — US East');

    // Connections first, tabs still pending.
    await act(async () => {
      resolveSecondConnList(NINE_CONNECTIONS);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText('connection detail screen')).toBeNull());

    // Then tabs — whose Focused Tab is on c9, a DIFFERENT Connection.
    await act(async () => {
      resolveTabsList([collectionTab({ id: 't-c9', connectionId: 'c9', collection: 'orders' })]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(touchUsed).toHaveBeenCalledWith('c1'));
    // c9's tab is not this open's business, in either resolution order.
    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
  });

  it('an errored tab list still opens the Connection, and deletes no persisted tabs', async () => {
    // Code-review finding F2 was: `refresh()` clears `loading` even when
    // `api.tabs.list()` rejects, so "loaded" could mean "errored and empty" —
    // and the switch then ran `closeAll()`, whose empty-local fallback
    // re-issued `tabs.list()` and deleted everything the retry returned.
    // X16.4 deletes both halves: the gate that read `tabs.error`, and
    // the fallback it was guarding. Opening a Connection reads no tab state,
    // so an errored list simply cannot reach a close.
    let tabsListCallCount = 0;
    const closeSpy = vi.fn(async () => undefined as never);
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    const tabsList = vi.fn(async () => {
      tabsListCallCount += 1;
      if (tabsListCallCount === 1) {
        const err: IpcError = { code: 'INTERNAL', message: 'tabs unavailable' };
        throw err;
      }
      // The transient failure "recovers" on retry, returning the tab that
      // must not be deleted.
      return [collectionTab({ id: 't-c3', connectionId: 'c3', collection: 'orders' })];
    });

    installAtelierMock({
      tabs: { list: tabsList, close: closeSpy },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });

    render(app(['/connections/c1']));
    expect(screen.getByText('connection detail screen')).toBeTruthy();

    await openViaPalette('Staging');

    await waitFor(() => expect(screen.queryByText('connection detail screen')).toBeNull());
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('opening a Connection while already on /workspace replaces history instead of pushing', async () => {
    // Finding 2 (code-review, LOW): navigate() in ConnectionPaletteCommands
    // used to always PUSH, even when already on /workspace — Workspace's own
    // effect only REPLACEs the intent back out, so each in-Workspace open
    // grew history by one functionally-identical entry, making back/forward
    // (including a trackpad/Chromium swipe-back) a no-op.
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });
    navigationTypes = [];
    render(app(['/workspace']));

    await openViaPalette('Staging');
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));

    await openViaPalette('Prod — EU West');
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c2'));

    expect(navigationTypes).not.toContain('PUSH');
    expect(navigationTypes).toContain('REPLACE');
  });

  it('does not route to the connection detail screen', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });
    render(app(['/workspace']));

    await openViaPalette('Staging');

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    expect(screen.queryByText('connection detail screen')).toBeNull();
  });

  it('overlapping palette opens both land — neither cancels the other', async () => {
    // X16.4 — the old race guard (`switchesInFlightRef` /
    // `switchGenerationRef`) is deleted along with the teardown it sequenced.
    // Two overlapping picks are no longer a race to arbitrate: both
    // Connections simply end up open, and the tab that was already there is
    // untouched by either.
    let rows: WorkspaceTab[] = [collectionTab({ id: 't-old', connectionId: 'c1' })];
    const closeSpy = vi.fn(async (id: string) => {
      rows = rows.filter((t) => t.id !== id);
      return { newActiveId: null };
    });
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      tabs: {
        list: async () => rows,
        close: closeSpy as never,
        setActive: (async (id: string) => {
          rows = rows.map((t) => ({ ...t, isActive: t.id === id }));
        }) as never,
      },
      conn: { list: async () => NINE_CONNECTIONS },
      mongo: { connect },
    });

    render(app(['/workspace']));
    await screen.findByRole('button', { name: /^Connection: Prod — US East/i });

    await openViaPalette('Staging');
    await openViaPalette('Prod — EU West');

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c3'));
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c2'));
    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Close orders')).toBeTruthy();
  });
});
