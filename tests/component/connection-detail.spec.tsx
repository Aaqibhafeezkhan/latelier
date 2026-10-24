import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ConnectionManager from '../../src/pages/ConnectionManager';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSchemaEnumCache } from '../../src/features/fieldSuggestions/sources/schemaEnumSource';

// Spied so the write can be checked for dropping the cached enum suggestions.
vi.mock('../../src/features/fieldSuggestions/sources/schemaEnumSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/schemaEnumSource')>()),
  invalidateSchemaEnumCache: vi.fn(),
}));
import type { ConnectionSummary } from '@shared/types';

function renderDetail(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/connections/:id" element={<ConnectionManager />} />
        <Route path="/workspace" element={<div>workspace-route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function summary(overrides: Partial<ConnectionSummary>): ConnectionSummary {
  return {
    id: 'id',
    name: 'Test',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard',
    readOnly: false,
    status: 'unknown',
    ...overrides,
  };
}

describe('ConnectionManager deep detail screen', () => {
  afterEach(() => {
  vi.mocked(invalidateSchemaEnumCache).mockClear();
    uninstallAtelierMock();
  });

  it('renders the connection named by the route param', async () => {
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha' })] },
    });
    renderDetail('/connections/a');
    const alphas = await screen.findAllByText('Alpha');
    expect(alphas.length).toBeGreaterThanOrEqual(1);
  });

  it('shows a loading state, not "not found", while the connection list is still resolving', async () => {
    let resolveList: (rows: ConnectionSummary[]) => void = () => {};
    // `useConnections()` kicks off its first `conn.list()` from a
    // `queueMicrotask` inside a mount effect, not synchronously during
    // render — so the mock's `list` factory isn't actually invoked (and
    // `resolveList` isn't assigned) until after `render()` returns. This
    // promise is what lets the test wait for that real invocation instead
    // of resolving a stale no-op closure and leaving the real fetch hanging.
    let listCalled: () => void = () => {};
    const listCalledPromise = new Promise<void>((resolve) => { listCalled = resolve; });
    installAtelierMock({
      conn: {
        list: () => {
          listCalled();
          return new Promise((resolve) => { resolveList = resolve; });
        },
      },
    });
    renderDetail('/connections/does-not-exist');
    // Before conn.list() resolves, the id genuinely can't be judged missing
    // yet — the not-found copy must not appear.
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
    await listCalledPromise;
    resolveList([summary({ id: 'a', name: 'Alpha' })]);
    await waitFor(() => {
      expect(screen.getByText(/no longer exists/i)).toBeTruthy();
    });
  });

  it('shows a not-found state and back affordance for an id with no match once the list has resolved', async () => {
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha' })] },
    });
    renderDetail('/connections/does-not-exist');
    await waitFor(() => {
      expect(screen.getByText(/no longer exists/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Back to Data View/i }));
    await waitFor(() => expect(screen.getByText('workspace-route')).toBeTruthy());
  });

  it('the TitleBar back affordance returns to the Data View', async () => {
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha' })] },
    });
    renderDetail('/connections/a');
    await screen.findAllByText('Alpha');
    fireEvent.click(screen.getByRole('button', { name: /Data View/i }));
    await waitFor(() => expect(screen.getByText('workspace-route')).toBeTruthy());
  });

  it('deleting the connection navigates back to the Data View', async () => {
    const del = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      conn: {
        list: async () => [summary({ id: 'a', name: 'Alpha' })],
        delete: del,
      },
    });
    renderDetail('/connections/a');
    await screen.findAllByText('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // opening the dialog now fetches the tab count first
    // (`api.tabs.list()`), so it's async: `findByRole`, not `getByRole`.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Delete "Alpha"/i)).toBeTruthy();
    // docs/adr/0013 — the confirm button stays disabled until the
    // connection name is typed back.
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Confirm connection name' }), {
      target: { value: 'Alpha' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(screen.getByText('workspace-route')).toBeTruthy());
    expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('a');
  });

  /**
   * docs/adr/0013 — deleting a connection irreversibly drops its saved
   * queries and history, so it sits on the type-to-confirm tier, not a
   * plain two-button confirm.
   *
   * MUTATION TARGET — replace `matches` with `true` in
   * `ConnectionDeleteDialog` and this goes red: Delete stays clickable
   * (and callable) with nothing typed.
   */
  it('keeps Delete disabled until the connection name is typed back', async () => {
    const del = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha' })], delete: del },
    });
    renderDetail('/connections/a');
    await screen.findAllByText('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    const input = within(dialog).getByRole('textbox', { name: 'Confirm connection name' });

    expect(confirmButton.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: 'Alp' } });
    expect(confirmButton.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: 'Alpha' } });
    expect(confirmButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(confirmButton);
    await waitFor(() => expect(del).toHaveBeenCalledWith('a'));
  });

  // X16 §4.6 — this screen has no `useWorkspaceTabs()`
  // (`ConnectionManager` owns the confirm + tab count itself, per
  // CLAUDE.md's one-call-site rule), so the whole round trip goes through
  // `api.tabs.list()`/`api.tabs.close()` rather than the renderer's tab
  // state.
  const serverInfoStub = async () => ({
    version: '7.0.5',
    uptimeSeconds: 1,
    connectionsCurrent: 1,
    connectionsAvailable: 1,
    opcountersPerSec: 1,
    databaseCount: 1,
    dataSizeBytes: 1,
    storageSizeBytes: 1,
    indexCount: 1,
    topology: 'Single' as const,
    serverStatsAvailable: true,
  });

  it('the Disconnect button opens a confirmation naming the Connection and its tab count, before disconnecting anything', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha', status: 'connected' })] },
      mongo: {
        status: async (id) => ({ id, status: 'connected' }),
        disconnect,
        serverInfo: serverInfoStub,
      },
      tabs: {
        list: async () => [
          { id: 't1', kind: 'collection', connectionId: 'a', dbName: 'db', collection: 'orders', position: 0, isActive: true, openedAt: '2026-01-01T00:00:00.000Z', pinned: false, state: { view: 'Tree', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}', page: 0, pageSize: 50, activeBuilderTab: 'Builder' } },
        ] as never,
      },
    });
    renderDetail('/connections/a');
    await screen.findAllByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Disconnect "Alpha"/i)).toBeTruthy();
    expect(within(dialog).getByText(/closes 1 open tab\b/)).toBeTruthy();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('confirming Disconnect calls api.mongo.disconnect and closes that Connection\'s tabs', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    const close = vi.fn(async () => ({ newActiveId: null }));
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha', status: 'connected' })] },
      mongo: {
        status: async (id) => ({ id, status: 'connected' }),
        disconnect,
        serverInfo: serverInfoStub,
      },
      tabs: {
        list: async () => [
          { id: 't1', kind: 'collection', connectionId: 'a', dbName: 'db', collection: 'orders', position: 0, isActive: true, openedAt: '2026-01-01T00:00:00.000Z', pinned: false, state: { view: 'Tree', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}', page: 0, pageSize: 50, activeBuilderTab: 'Builder' } },
        ] as never,
        close: close as never,
      },
    });
    renderDetail('/connections/a');
    await screen.findAllByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(close).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Unlike Delete, this screen stays put — Disconnect doesn't navigate away.
    expect(screen.queryByText('workspace-route')).toBeNull();
  });

  it('cancelling the Disconnect confirmation disconnects nothing and closes no tabs', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    const close = vi.fn(async () => ({ newActiveId: null }));
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha', status: 'connected' })] },
      mongo: {
        status: async (id) => ({ id, status: 'connected' }),
        disconnect,
        serverInfo: serverInfoStub,
      },
      tabs: {
        list: async () => [
          { id: 't1', kind: 'collection', connectionId: 'a', dbName: 'db', collection: 'orders', position: 0, isActive: true, openedAt: '2026-01-01T00:00:00.000Z', pinned: false, state: { view: 'Tree', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}', page: 0, pageSize: 50, activeBuilderTab: 'Builder' } },
        ] as never,
        close: close as never,
      },
    });
    renderDetail('/connections/a');
    await screen.findAllByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Cancel'));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  // Regression — the sibling surface this ticket must NOT touch: "Cancel
  // connection" (shown while `isConnecting`) stays wired to the raw
  // `disconnectConnection` helper with no confirmation.
  it('"Cancel connection" while connecting still disconnects immediately, with no confirmation dialog', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha', status: 'unknown' })] },
      mongo: {
        status: async (id) => ({ id, status: 'connecting' }),
        disconnect,
      },
    });
    renderDetail('/connections/a');
    await screen.findAllByText('Alpha');

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel connection' });
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('a'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // sister of the TabStrip case: the breadcrumb's second segment must
  // never read the bare literal "Connection" for a Connection missing from
  // the list, since a user can legitimately name a Connection that.
  it('breadcrumb shows the resolved Connection\'s real name, not a state label', async () => {
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Connection' })] },
    });
    renderDetail('/connections/a');
    await waitFor(() => {
      expect(within(screen.getByRole('banner')).getByText('Connection')).toBeTruthy();
    });
  });

  it('breadcrumb reads "(unresolved connection)", not "Connection", once the list has resolved without a match', async () => {
    installAtelierMock({
      conn: { list: async () => [summary({ id: 'a', name: 'Alpha' })] },
    });
    renderDetail('/connections/does-not-exist');
    await waitFor(() => {
      const banner = within(screen.getByRole('banner'));
      expect(banner.getByText('(unresolved connection)')).toBeTruthy();
      expect(banner.queryByText('Connection')).toBeNull();
    });
  });
});
