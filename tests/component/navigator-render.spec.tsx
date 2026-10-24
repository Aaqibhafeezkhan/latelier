import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import {
  DbCollectionNavigator,
  type DbCollectionNavigatorProps,
} from '../../src/pages/Workspace/DbCollectionNavigator';
import {
  connectionFixture,
  installAtelierMock,
  uninstallAtelierMock,
} from '../helpers/atelierMock';

function mountNavigator(props: Partial<DbCollectionNavigatorProps> = {}) {
  const baseProps: DbCollectionNavigatorProps = {
    connectionsWithTabs: new Set(),
    connections: [connectionFixture({ id: 'c1', name: 'Prod', color: '#1A6835' })],
    focusedConnectionId: 'c1',
    activeDbName: 'downlink',
    activeCollection: 'journalEntry',
    onOpenCollection: vi.fn(),
    onOpenAggregation: vi.fn(),
    ...props,
  };
  return {
    ...render(
        <DbCollectionNavigator {...baseProps} />
    ),
    props: baseProps,
  };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('DbCollectionNavigator — render', () => {
  it('auto-expands the active DB and fetches its collections', async () => {
    installAtelierMock({
      meta: {
        listDatabases: async () => [
          { name: 'downlink', sizeOnDisk: 1, empty: false },
          { name: 'config', sizeOnDisk: 1, empty: false },
        ],
        listCollections: async ({ dbName }) =>
          dbName === 'downlink'
            ? [
                {
                  name: 'journalEntry',
                  type: 'collection',
                  documentCount: 0,
                  sizeBytes: 0,
                  indexCount: 0,
                  capped: false,
                },
                {
                  name: 'order',
                  type: 'collection',
                  documentCount: 0,
                  sizeBytes: 0,
                  indexCount: 0,
                  capped: false,
                },
              ]
            : [],
      },
    });

    mountNavigator();

    // The active DB was auto-expanded, so its collections appear.
    expect(await screen.findByText('journalEntry')).toBeTruthy();
    expect(screen.getByText('order')).toBeTruthy();
    // config is collapsed by default (not the active DB), so no fetch yet.
    expect(screen.getByText('config')).toBeTruthy();
  });

  it('shows the Refresh connection tooltip when keyboard focus lands on the refresh icon button', async () => {
    installAtelierMock({
      meta: {
        listDatabases: async () => [{ name: 'downlink', sizeOnDisk: 1, empty: false }],
        listCollections: async () => [],
      },
    });
    mountNavigator();
    await screen.findByText('downlink');

    fireEvent.focus(screen.getByRole('button', { name: 'Refresh' }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Refresh connection');
  });

  it('badges a capped collection CAPPED, a view VIEW and a time-series TS, and a plain collection not at all', async () => {
    const base = { documentCount: 0, sizeBytes: 0, indexCount: 0 };
    installAtelierMock({
      meta: {
        listDatabases: async () => [{ name: 'downlink', sizeOnDisk: 1, empty: false }],
        listCollections: async () => [
          { ...base, name: 'plain', type: 'collection', capped: false },
          { ...base, name: 'log', type: 'collection', capped: true },
          { ...base, name: 'recent', type: 'view', capped: false },
          { ...base, name: 'metrics', type: 'timeseries', capped: false },
        ],
      },
    });

    mountNavigator();
    await screen.findByText('plain');

    const badgeOf = (name: string) => screen.getByTestId(`nav-coll-downlink-${name}`).textContent;
    expect(badgeOf('plain')).toBe('plain');
    expect(badgeOf('log')).toBe('logCAPPED');
    expect(screen.getByTestId('nav-coll-downlink-log').getAttribute('title')).toBe('Capped collection');
    expect(badgeOf('recent')).toBe('recentVIEW');
    expect(badgeOf('metrics')).toBe('metricsTS');
  });

  it('filter narrows collections and hides DBs with no match', async () => {
    installAtelierMock({
      meta: {
        listDatabases: async () => [
          { name: 'downlink', sizeOnDisk: 1, empty: false },
          { name: 'config', sizeOnDisk: 1, empty: false },
        ],
        listCollections: async ({ dbName }) =>
          dbName === 'downlink'
            ? [
                {
                  name: 'journalEntry',
                  type: 'collection',
                  documentCount: 0,
                  sizeBytes: 0,
                  indexCount: 0,
                  capped: false,
                },
                {
                  name: 'orders',
                  type: 'collection',
                  documentCount: 0,
                  sizeBytes: 0,
                  indexCount: 0,
                  capped: false,
                },
              ]
            : [
                {
                  name: 'settings',
                  type: 'collection',
                  documentCount: 0,
                  sizeBytes: 0,
                  indexCount: 0,
                  capped: false,
                },
              ],
      },
    });

    mountNavigator({ activeDbName: 'downlink', activeCollection: null });
    await screen.findByText('journalEntry');

    // Expand `config` too so we can observe filter-hide behavior.
    fireEvent.click(screen.getByText('config'));
    await screen.findByText('settings');

    const input = screen.getByLabelText('Filter collections');
    await userEvent.type(input, 'orders');

    await waitFor(() => {
      expect(screen.queryByText('journalEntry')).toBeNull();
    });
    expect(screen.getByText('orders')).toBeTruthy();
    // `config` DB has no match → hidden entirely.
    expect(screen.queryByText('config')).toBeNull();
    expect(screen.queryByText('settings')).toBeNull();
  });

  it('refresh invalidates the cache and re-fetches databases', async () => {
    const listDbs = vi.fn(async () => [
      { name: 'downlink', sizeOnDisk: 1, empty: false },
    ]);
    installAtelierMock({
      meta: {
        listDatabases: listDbs,
        listCollections: async () => [],
      },
    });

    mountNavigator({ activeDbName: null, activeCollection: null });
    await waitFor(() => expect(listDbs).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByLabelText('Refresh'));
    await waitFor(() => expect(listDbs).toHaveBeenCalledTimes(2));
  });

  it('renders an error card with Retry when listDatabases fails', async () => {
    let calls = 0;
    installAtelierMock({
      meta: {
        listDatabases: async () => {
          calls++;
          if (calls === 1) {
            throw { code: 'NETWORK', message: 'could not reach server' };
          }
          return [{ name: 'app', sizeOnDisk: 1, empty: false }];
        },
        listCollections: async () => [],
      },
    });

    mountNavigator({ activeDbName: null, activeCollection: null });
    expect(await screen.findByText(/could not reach server/i)).toBeTruthy();
    const retry = screen.getByText('Retry');

    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() => expect(screen.queryByText(/could not reach server/i)).toBeNull());
    expect(await screen.findByText('app')).toBeTruthy();
  });

  it('renders an empty, disabled tree when there is no Connection', async () => {
    // the Data View's centered empty state (Workspace.tsx) is the one
    // place that names the no-Connection case now; this component just has
    // nothing to show and disables the affordance that needs a live
    // Connection.
    installAtelierMock({
      meta: {
        listDatabases: async () => [],
        listCollections: async () => [],
      },
    });
    mountNavigator({ connections: [], focusedConnectionId: null });
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('treeitem')).toBeNull();
  });

  it('renders a database named "constructor" without throwing', async () => {
    // The row-build loop reads `cache.colls[db.name]` for every listed
    // database, even a collapsed one — for a database literally named
    // `constructor`, an unguarded bracket read resolves to the inherited
    // `Object.prototype.constructor` function instead of `undefined`, and
    // `.filter` on that throws before the tree ever renders.
    installAtelierMock({
      meta: {
        listDatabases: async () => [
          { name: 'constructor', sizeOnDisk: 1, empty: false },
        ],
        listCollections: async () => [
          {
            name: 'logs',
            type: 'collection',
            documentCount: 0,
            sizeBytes: 0,
            indexCount: 0,
            capped: false,
          },
        ],
      },
    });

    mountNavigator({ activeDbName: null, activeCollection: null });

    expect(await screen.findByText('constructor')).toBeTruthy();

    // Expanding it exercises the `collsLoading`/`colls` reads on the same
    // hostile key once a load is actually in flight.
    fireEvent.click(screen.getByText('constructor'));
    expect(await screen.findByText('logs')).toBeTruthy();
  });

  it('renders collections in alphabetical order regardless of server order', async () => {
    installAtelierMock({
      meta: {
        listDatabases: async () => [{ name: 'downlink', sizeOnDisk: 1, empty: false }],
        listCollections: async () => [
          // Server returns insertion order — out of A→Z order on purpose.
          { name: 'zeta', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
          { name: 'beta', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
          { name: 'Alpha', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
          { name: 'gamma', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
        ],
      },
    });

    mountNavigator({
      activeDbName: 'downlink',
      activeCollection: null,
    });

    await screen.findByText('Alpha');
    // Read DOM order directly from the row data-testids. Comparing
    // `getBoundingClientRect().top` would be brittle in jsdom (layout is a
    // no-op there, so `top` is typically 0 for every element).
    const renderedOrder = Array.from(
      document.querySelectorAll('[data-testid^="nav-coll-downlink-"]'),
    ).map((el) =>
      el.getAttribute('data-testid')!.replace('nav-coll-downlink-', ''),
    );
    expect(renderedOrder).toEqual(['Alpha', 'beta', 'gamma', 'zeta']);
  });
});
