import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, within } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DetailPanel } from '../../src/pages/DetailPanel';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ConnectionSummary, ConnectionRuntime } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const baseConn: ConnectionSummary = {
  id: 'c1',
  name: 'MyConn',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard',
  readOnly: false,
  status: 'connected',
  serverVersion: '7.0.0',
};

function renderDetail(conn: ConnectionSummary) {
  return render(
    <MemoryRouter initialEntries={['/connections/c1']}>
        <DetailPanel selected={conn} loading={false} onDelete={() => {}} onDisconnect={() => {}} />
    </MemoryRouter>,
  );
}

describe('DetailPanel Overview', () => {
  it('shows Connect button when status is disconnected', async () => {
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'disconnected' }),
        connect: async (id) => ({ id, status: 'connecting' }),
        disconnect: async (id) => ({ id }),
        ping: async () => ({ roundTripMs: 0 }),
        serverInfo: async () => ({
          version: '7.0.0',
          uptimeSeconds: 0,
          connectionsCurrent: 0,
          connectionsAvailable: 0,
          opcountersPerSec: 0,
          databaseCount: 0,
          dataSizeBytes: 0,
          storageSizeBytes: 0,
          indexCount: 0,
          topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: () => () => { /* ok */ },
      },
    });
    renderDetail({ ...baseConn, status: 'unknown' });
    expect(await screen.findByText('Connect')).toBeTruthy();
  });

  it('loads serverInfo when connected and renders version', async () => {
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connected', serverVersion: '7.0.0' }),
        connect: async (id) => ({ id, status: 'connected' }),
        disconnect: async (id) => ({ id }),
        ping: async () => ({ roundTripMs: 1 }),
        serverInfo: async () => ({
          version: '7.0.5',
          uptimeSeconds: 90061,
          connectionsCurrent: 3,
          connectionsAvailable: 200,
          opcountersPerSec: 42,
          databaseCount: 3,
          dataSizeBytes: 10 * 1024 * 1024,
          storageSizeBytes: 12 * 1024 * 1024,
          indexCount: 7,
          topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: () => () => { /* ok */ },
      },
    });
    renderDetail(baseConn);
    await waitFor(() => {
      expect(screen.getByText('7.0.5')).toBeTruthy();
      expect(screen.getByText(/Databases/)).toBeTruthy();
    });
  });
});

describe('DetailPanel Overview connecting state', () => {
  it('shows Cancel connection button alongside Connecting… text', async () => {
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connecting' }),
        connect: async (id) => ({ id, status: 'connecting' }),
        disconnect: async (id) => ({ id }),
        ping: async () => ({ roundTripMs: 0 }),
        serverInfo: async () => ({
          version: '7.0.0', uptimeSeconds: 0,
          connectionsCurrent: 0, connectionsAvailable: 0,
          opcountersPerSec: 0, databaseCount: 0, dataSizeBytes: 0,
          storageSizeBytes: 0, indexCount: 0, topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: () => () => { /* ok */ },
      },
    });
    renderDetail({ ...baseConn, status: 'connecting' });
    expect(await screen.findByText('Connecting…')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel connection/i })).toBeTruthy();
  });

  it('clicking Cancel connection calls api.mongo.disconnect with the connection id', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connecting' }),
        connect: async (id) => ({ id, status: 'connecting' }),
        disconnect,
        ping: async () => ({ roundTripMs: 0 }),
        serverInfo: async () => ({
          version: '7.0.0', uptimeSeconds: 0,
          connectionsCurrent: 0, connectionsAvailable: 0,
          opcountersPerSec: 0, databaseCount: 0, dataSizeBytes: 0,
          storageSizeBytes: 0, indexCount: 0, topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: () => () => { /* ok */ },
      },
    });
    renderDetail({ ...baseConn, status: 'connecting' });
    await screen.findByText('Connecting…');
    await userEvent.click(screen.getByRole('button', { name: /Cancel connection/i }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
  });

  it('after cancel, onStatus disconnected event returns panel to Connect CTA', async () => {
    let statusCb: ((r: ConnectionRuntime) => void) | null = null;
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connecting' }),
        connect: async (id) => ({ id, status: 'connecting' }),
        disconnect: async (id) => ({ id }),
        ping: async () => ({ roundTripMs: 0 }),
        serverInfo: async () => ({
          version: '7.0.0', uptimeSeconds: 0,
          connectionsCurrent: 0, connectionsAvailable: 0,
          opcountersPerSec: 0, databaseCount: 0, dataSizeBytes: 0,
          storageSizeBytes: 0, indexCount: 0, topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: (cb) => {
          statusCb = cb;
          return () => {};
        },
      },
    });
    renderDetail({ ...baseConn, status: 'connecting' });
    await screen.findByText('Connecting…');

    // Simulate the pool emitting disconnected after the cancel.
    act(() => {
      statusCb?.({ id: 'c1', status: 'disconnected' });
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Connect$/i })).toBeTruthy(),
    );
  });
});

describe('DetailPanel Collections', () => {
  it('lists dbs and loads collections on expand', async () => {
    let listCollsCalls = 0;
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connected', serverVersion: '7.0.0' }),
        connect: async (id) => ({ id, status: 'connected' }),
        disconnect: async (id) => ({ id }),
        ping: async () => ({ roundTripMs: 1 }),
        serverInfo: async () => ({
          version: '7.0.5', uptimeSeconds: 0,
          connectionsCurrent: 0, connectionsAvailable: 0,
          opcountersPerSec: 0, databaseCount: 1, dataSizeBytes: 0,
          storageSizeBytes: 0, indexCount: 0, topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: () => () => { /* ok */ },
      },
      meta: {
        listDatabases: async () => [
          { name: 'alpha', sizeOnDisk: 1024, empty: false },
          { name: 'beta', sizeOnDisk: 2048, empty: false },
        ],
        listCollections: async ({ dbName }) => {
          listCollsCalls++;
          if (dbName === 'alpha') {
            return [
              { name: 'products', type: 'collection' as const, documentCount: 3,
                sizeBytes: 1024, indexCount: 1, capped: false },
            ];
          }
          return [];
        },
      },
      prefs: {
        get: async () => null,
        set: async (_k, v) => v,
      },
    });
    renderDetail(baseConn);
    await userEvent.click(screen.getByText('Collections'));
    // Alpha is auto-expanded since <= 2 DBs.
    await waitFor(() => expect(listCollsCalls).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(screen.getByText('products')).toBeTruthy());
  });

  it('"New collection" opens the create drawer (not the old copy-snippet dialog) and refreshes on success', async () => {
    const listDatabases = vi.fn(async () => [
      { name: 'alpha', sizeOnDisk: 1024, empty: false },
    ]);
    const create = vi.fn(async (input: { dbName: string; collection: string }) => ({
      name: input.collection,
    }));
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connected', serverVersion: '7.0.0' }),
        connect: async (id) => ({ id, status: 'connected' }),
        disconnect: async (id) => ({ id }),
        ping: async () => ({ roundTripMs: 1 }),
        serverInfo: async () => ({
          version: '7.0.5', uptimeSeconds: 0,
          connectionsCurrent: 0, connectionsAvailable: 0,
          opcountersPerSec: 0, databaseCount: 1, dataSizeBytes: 0,
          storageSizeBytes: 0, indexCount: 0, topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: () => () => { /* ok */ },
      },
      meta: {
        listDatabases,
        listCollections: async () => [],
      },
      collection: {
        create: create as never,
      },
      prefs: {
        get: async () => null,
        set: async (_k, v) => v,
      },
    });
    renderDetail(baseConn);
    await userEvent.click(screen.getByText('Collections'));
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy());
    const initialCalls = listDatabases.mock.calls.length;

    await userEvent.click(screen.getByText('New collection'));

    // Real create drawer, not the old "db.createCollection(...)" snippet dialog.
    expect(await screen.findByLabelText('Database name')).toBeTruthy();
    expect(screen.getByLabelText('Collection name')).toBeTruthy();
    expect(screen.queryByText(/db\.createCollection/)).toBeNull();

    await userEvent.type(screen.getByLabelText('Database name'), 'newapp');
    await userEvent.type(screen.getByLabelText('Collection name'), 'first');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listDatabases.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  // The db header used to be a bare `<div onClick>` — a mouse-only control.
  // Now that it's a real `<button>`, Enter/Space activate it for free; this
  // pins that the a11y fix (S6848) actually bought keyboard users something,
  // not just a quieter linter.
  it('expands a db section with the keyboard, not just a click', async () => {
    const listCollections = vi.fn(async ({ dbName }: { dbName: string }) => {
      if (dbName !== 'beta') return [];
      return [
        { name: 'widgets', type: 'collection' as const, documentCount: 1,
          sizeBytes: 512, indexCount: 1, capped: false },
      ];
    });
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connected', serverVersion: '7.0.0' }),
        connect: async (id) => ({ id, status: 'connected' }),
        disconnect: async (id) => ({ id }),
        ping: async () => ({ roundTripMs: 1 }),
        serverInfo: async () => ({
          version: '7.0.5', uptimeSeconds: 0,
          connectionsCurrent: 0, connectionsAvailable: 0,
          opcountersPerSec: 0, databaseCount: 3, dataSizeBytes: 0,
          storageSizeBytes: 0, indexCount: 0, topology: 'Single',
          serverStatsAvailable: true,
        }),
        onStatus: () => () => { /* ok */ },
      },
      meta: {
        // >2 dbs so none auto-expand on load — the keypress below has to be
        // what drives expansion.
        listDatabases: async () => [
          { name: 'alpha', sizeOnDisk: 0, empty: false },
          { name: 'beta', sizeOnDisk: 0, empty: false },
          { name: 'gamma', sizeOnDisk: 0, empty: false },
        ],
        listCollections,
      },
      prefs: {
        get: async () => null,
        set: async (_k, v) => v,
      },
    });
    renderDetail(baseConn);
    await userEvent.click(screen.getByText('Collections'));
    const betaHeader = await screen.findByRole('button', { name: /beta/ });

    expect(betaHeader.getAttribute('aria-expanded')).toBe('false');
    betaHeader.focus();
    await userEvent.keyboard('{Enter}');

    expect(betaHeader.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(listCollections).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'beta',
    }));
    await screen.findByText('widgets');
  });
});

describe('DetailPanel Collections table', () => {
  it('lists collections in a real table with column headers, one row each', async () => {
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connected', serverVersion: '7.0.0' }),
        onStatus: () => () => { /* ok */ },
      },
      meta: {
        listDatabases: async () => [{ name: 'alpha', sizeOnDisk: 1024, empty: false }],
        listCollections: async () => [
          { name: 'products', type: 'collection' as const, documentCount: 1234,
            sizeBytes: 1024, indexCount: 2, capped: false },
          { name: 'orders', type: 'collection' as const, documentCount: 5,
            sizeBytes: 2048, indexCount: 1, capped: false },
        ],
      },
    });
    renderDetail(baseConn);
    await userEvent.click(screen.getByRole('button', { name: 'Collections' }));
    const table = await screen.findByRole('table', { name: 'Collections in alpha' });

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Collection', 'Documents', 'Size', 'Indexes', 'Modified', 'Actions']);

    const rows = within(table).getAllByRole('row');
    // Header row plus one per collection.
    expect(rows).toHaveLength(3);
    const cells = within(rows[1]!).getAllByRole('cell').map((c) => c.textContent);
    expect(cells.slice(0, 4)).toEqual(['products', (1234).toLocaleString(), '1.0 KB', '2']);
    expect(within(rows[2]!).getByRole('button', { name: 'Open' })).toBeTruthy();
  });
});

describe('DetailPanel Monitor tab', () => {
  it('sits right after Overview and opens the monitor', async () => {
    const currentOp = vi.fn(async () => ({ ops: [] }));
    installAtelierMock({
      mongo: {
        status: async (id) => ({ id, status: 'connected', serverVersion: '7.0.0' }),
        onStatus: () => () => { /* ok */ },
      },
      admin: { currentOp },
    });
    renderDetail(baseConn);
    const tabs = ['Overview', 'Monitor', 'Collections'].map((name) =>
      screen.getByRole('button', { name }),
    );
    expect(tabs[0]!.compareDocumentPosition(tabs[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs[1]!.compareDocumentPosition(tabs[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(tabs[1]!);
    expect(await screen.findByRole('region', { name: 'Current operations' })).toBeTruthy();
    await waitFor(() => expect(currentOp).toHaveBeenCalled());
  });
});
