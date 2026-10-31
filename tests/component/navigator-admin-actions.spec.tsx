import { describe, it, expect, afterEach, vi } from 'vitest';
import { notifications } from '@mantine/notifications';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
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
import type { CollectionInfo } from '../../shared/ipc';
import { onCollectionChanged } from '../../src/state/collectionChanges';

function mountNavigator(props: Partial<DbCollectionNavigatorProps> = {}) {
  const baseProps: DbCollectionNavigatorProps = {
    connectionsWithTabs: new Set(),
    connections: [connectionFixture({ id: 'c1', name: 'Prod', color: '#1A6835' })],
    focusedConnectionId: 'c1',
    activeDbName: 'shop',
    activeCollection: 'orders',
    onOpenCollection: vi.fn(),
    onOpenAggregation: vi.fn(),
    ...props,
  };
  return render(<DbCollectionNavigator {...baseProps} />);
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function baseMocks(overrides: Parameters<typeof installAtelierMock>[0] = {}) {
  return installAtelierMock({
    meta: {
      listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
      listCollections: async () => [
        {
          name: 'orders',
          type: 'collection' as const,
          documentCount: 0,
          sizeBytes: 0,
          indexCount: 0,
          capped: false,
        },
      ],
    },
    ...overrides,
  });
}

describe('DbCollectionNavigator — T1.1 admin actions', () => {
  it('DB context menu "Create collection" is enabled and opens the create drawer; success refreshes the DB', async () => {
    const listCollections = vi.fn(async () => [
      {
        name: 'orders',
        type: 'collection' as const,
        documentCount: 0,
        sizeBytes: 0,
        indexCount: 0,
        capped: false,
      },
    ]);
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections,
      },
      collection: {
        create: async (input) => ({ name: (input as { collection: string }).collection }),
      },
    });

    mountNavigator();
    await screen.findByText('orders');
    const initialCalls = listCollections.mock.calls.length;

    fireEvent.contextMenu(screen.getByTestId('nav-db-shop'));
    const item = screen.getByRole('menuitem', { name: 'Create collection' });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(item);

    await waitFor(() => expect(screen.getByLabelText('Collection name')).toBeTruthy());
    await userEvent.type(screen.getByLabelText('Collection name'), 'invoices');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  it('collection context menu "Rename collection" opens the rename modal; success refreshes the DB', async () => {
    const listCollections = vi.fn(async () => [
      {
        name: 'orders',
        type: 'collection' as const,
        documentCount: 0,
        sizeBytes: 0,
        indexCount: 0,
        capped: false,
      },
    ]);
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections,
      },
      collection: {
        rename: async (input) => ({ name: (input as { newName: string }).newName }),
      },
    });

    mountNavigator();
    await screen.findByText('orders');
    const initialCalls = listCollections.mock.calls.length;

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    const item = screen.getByRole('menuitem', { name: 'Rename collection' });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(item);

    await waitFor(() => expect(screen.getByLabelText('New name')).toBeTruthy());
    await userEvent.type(screen.getByLabelText('New name'), 'purchase_orders');
    await userEvent.click(screen.getByText('Rename').closest('button')!);

    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  it('collection context menu "Import documents…" imports into that collection and refreshes the DB; a view has no such item', async () => {
    const listCollections = vi.fn(async () => [
      { name: 'orders', type: 'collection' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
      { name: 'recent', type: 'view' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
    ]);
    const importFn = vi.fn(async () => ({
      fileName: 'o.jsonl', format: 'jsonl' as const, inserted: 3, failed: 0, errors: [], errorsTruncated: false, cancelled: false,
    }));
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections },
      app: { pickFile: async () => ({ path: '/tmp/o.jsonl' }) } as never,
      data: { import: importFn },
    });

    mountNavigator();
    await screen.findByText('recent');
    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-recent'));
    expect(screen.queryByRole('menuitem', { name: 'Import documents…' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    const initialCalls = listCollections.mock.calls.length;
    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import documents…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));

    await screen.findByText('Imported 3 documents from o.jsonl.');
    expect(importFn).toHaveBeenCalledWith({
      connectionId: 'c1', dbName: 'shop', collection: 'orders', path: '/tmp/o.jsonl', cancelToken: expect.any(String),
    });
    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  // The failure carries no report, so the DB is re-listed from the
  // partial-import callback instead of `onImported`.
  it('collection context menu "Import documents…" refreshes the DB when the import fails after some documents landed', async () => {
    const listCollections = vi.fn(async () => [
      { name: 'orders', type: 'collection' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
    ]);
    const importFn = vi.fn(async () => {
      throw { code: 'MONGO_OP', message: 'batch 3 failed', details: { insertedCount: 2400 } };
    });
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections },
      app: { pickFile: async () => ({ path: '/tmp/o.jsonl' }) } as never,
      data: { import: importFn },
    });

    mountNavigator();
    await screen.findByText('orders');
    const initialCalls = listCollections.mock.calls.length;

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import documents…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/batch 3 failed/);
    expect(importFn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  it('collection context menu "Drop collection" opens type-to-confirm; success refreshes the DB', async () => {
    const listCollections = vi.fn(async () => [
      {
        name: 'orders',
        type: 'collection' as const,
        documentCount: 0,
        sizeBytes: 0,
        indexCount: 0,
        capped: false,
      },
    ]);
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections,
      },
      collection: {
        drop: async () => ({ dropped: true }),
      },
    });

    mountNavigator();
    await screen.findByText('orders');
    const initialCalls = listCollections.mock.calls.length;

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Drop collection' }));

    const confirmInput = await screen.findByLabelText('Confirm collection name');
    const dropBtn = screen.getByText('Drop').closest('button')!;
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(confirmInput, 'orders');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(dropBtn);

    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  it('DB context menu "Drop database" opens type-to-confirm; success refreshes the DB list (row disappears)', async () => {
    const listDatabases = vi.fn(async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }]);
    baseMocks({
      meta: {
        listDatabases,
        listCollections: async () => [],
      },
      database: {
        drop: async () => ({ dropped: true }),
      },
    });

    mountNavigator({ activeDbName: null, activeCollection: null });
    await screen.findByText('shop');
    const initialCalls = listDatabases.mock.calls.length;

    fireEvent.contextMenu(screen.getByTestId('nav-db-shop'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Drop database' }));

    const confirmInput = await screen.findByLabelText('Confirm database name');
    const dropBtn = screen.getByText('Drop database').closest('button')!;
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(confirmInput, 'shop');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(dropBtn);

    await waitFor(() => expect(listDatabases.mock.calls.length).toBeGreaterThan(initialCalls));
  });
});

// X16.3 — which Connection an admin action runs against.
//
// Every id in this component is a string, so pointing a destructive path at
// the Focused Tab's Connection, or at the first root, typechecks perfectly and
// drops a collection on the wrong server. The fixture keeps those three apart:
// `c1` is first in the list, `c2` is the Focused Tab's, and `c3` is the root
// the action is performed in. An assertion of `'c3'` therefore fails for a
// path that reads either of the other two.
describe('DbCollectionNavigator — an admin action runs against the row’s own Connection', () => {
  const THREE = [
    connectionFixture({ id: 'c1', name: 'Prod' }),
    connectionFixture({ id: 'c2', name: 'Staging' }),
    connectionFixture({ id: 'c3', name: 'Archive' }),
  ];

  /** Expand Archive (`c3`) and its `shop` DB while the Focused Tab is on `c2`. */
  async function mountOnArchive(props: Partial<DbCollectionNavigatorProps> = {}) {
    const rendered = mountNavigator({
      connectionsWithTabs: new Set(),
      connections: THREE,
      focusedConnectionId: 'c2',
      activeDbName: null,
      activeCollection: null,
      ...props,
    });
    const archive = screen
      .getAllByTestId('nav-connection')
      .find((r) => r.getAttribute('data-connection-id') === 'c3')!;
    fireEvent.click(archive);
    fireEvent.click(await screen.findByTestId('nav-db-shop'));
    await screen.findByTestId('nav-coll-shop-orders');
    return rendered;
  }

  it('drops the collection on that Connection, and closes that Connection’s tabs', async () => {
    const drop = vi.fn<(i: { connectionId: string; dbName: string; collection: string }) => Promise<{ dropped: boolean }>>(
      async () => ({ dropped: true }),
    );
    const listCollections = vi.fn<(i: { connectionId: string; dbName: string }) => Promise<CollectionInfo[]>>(
      async () => [
        { name: 'orders', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
      ],
    );
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections },
      collection: { drop: drop as never },
    });
    const onCollectionDropped = vi.fn();
    await mountOnArchive({ onCollectionDropped });
    listCollections.mockClear();

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Drop collection' }));
    await userEvent.type(await screen.findByLabelText('Confirm collection name'), 'orders');
    await userEvent.click(screen.getByText('Drop').closest('button')!);

    await waitFor(() => expect(drop).toHaveBeenCalled());
    expect(drop.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3', dbName: 'shop', collection: 'orders' });
    expect(onCollectionDropped).toHaveBeenCalledWith('c3', 'shop', 'orders');
    // The refresh that follows reads the same server, not the expanded root by
    // coincidence or the Focused Tab's.
    await waitFor(() => expect(listCollections).toHaveBeenCalled());
    expect(listCollections.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3' });
  });

  it('drops the database on that Connection, and closes that Connection’s tabs', async () => {
    const drop = vi.fn<(i: { connectionId: string; dbName: string }) => Promise<{ dropped: true }>>(
      async () => ({ dropped: true as const }),
    );
    const listDatabases = vi.fn<(i: { connectionId: string }) => Promise<{ name: string; sizeOnDisk: number; empty: boolean }[]>>(
      async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
    );
    baseMocks({
      meta: {
        listDatabases: listDatabases as never,
        listCollections: async () => [
          { name: 'orders', type: 'collection' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
        ],
      },
      database: { drop: drop as never },
    });
    const onDatabaseDropped = vi.fn();
    await mountOnArchive({ onDatabaseDropped });
    listDatabases.mockClear();

    fireEvent.contextMenu(screen.getByTestId('nav-db-shop'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Drop database' }));
    await userEvent.type(await screen.findByLabelText('Confirm database name'), 'shop');
    await userEvent.click(screen.getByText('Drop database').closest('button')!);

    await waitFor(() => expect(drop).toHaveBeenCalled());
    expect(drop.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3', dbName: 'shop' });
    expect(onDatabaseDropped).toHaveBeenCalledWith('c3', 'shop');
    await waitFor(() => expect(listDatabases).toHaveBeenCalled());
    expect(listDatabases.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3' });
  });

  it('renames the collection on that Connection, and re-points that Connection’s tabs', async () => {
    const rename = vi.fn<(i: { connectionId: string; dbName: string; collection: string }) => Promise<{ name: string }>>(
      async () => ({ name: 'purchase_orders' }),
    );
    const listCollections = vi.fn<(i: { connectionId: string; dbName: string }) => Promise<CollectionInfo[]>>(
      async () => [
        { name: 'orders', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
      ],
    );
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections },
      collection: { rename: rename as never },
    });
    const onCollectionRenamed = vi.fn();
    await mountOnArchive({ onCollectionRenamed });
    listCollections.mockClear();

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename collection' }));
    await userEvent.type(await screen.findByLabelText('New name'), 'purchase_orders');
    await userEvent.click(screen.getByText('Rename').closest('button')!);

    await waitFor(() => expect(rename).toHaveBeenCalled());
    expect(rename.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3', dbName: 'shop', collection: 'orders' });
    expect(onCollectionRenamed).toHaveBeenCalledWith('c3', 'shop', 'orders', 'purchase_orders');
    await waitFor(() => expect(listCollections).toHaveBeenCalled());
    expect(listCollections.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3' });
  });

  it('creates the collection on that Connection', async () => {
    const create = vi.fn<(i: { connectionId: string; dbName: string }) => Promise<{ name: string }>>(
      async () => ({ name: 'invoices' }),
    );
    const listCollections = vi.fn<(i: { connectionId: string; dbName: string }) => Promise<CollectionInfo[]>>(
      async () => [
        { name: 'orders', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
      ],
    );
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections },
      collection: { create: create as never },
    });
    await mountOnArchive();
    listCollections.mockClear();

    fireEvent.contextMenu(screen.getByTestId('nav-db-shop'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create collection' }));
    await userEvent.type(await screen.findByLabelText('Collection name'), 'invoices');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3', dbName: 'shop' });
    await waitFor(() => expect(listCollections).toHaveBeenCalled());
    expect(listCollections.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3' });
  });

  it('refreshes the Connection the dialog acted on, even if the open root moved under it', async () => {
    // The dialog outlives the accordion: switching tabs while a confirm is up
    // expands another root, and the refresh that follows the drop must still
    // read the server the drop ran against.
    const drop = vi.fn<(i: { connectionId: string; dbName: string; collection: string }) => Promise<{ dropped: boolean }>>(
      async () => ({ dropped: true }),
    );
    const listCollections = vi.fn<(i: { connectionId: string; dbName: string }) => Promise<CollectionInfo[]>>(
      async () => [
        { name: 'orders', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
      ],
    );
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections },
      collection: { drop: drop as never },
    });
    const { rerender } = await mountOnArchive();

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Drop collection' }));
    await userEvent.type(await screen.findByLabelText('Confirm collection name'), 'orders');

    // The Focused Tab moves to Prod, so Prod's root opens and Archive's closes.
    rerender(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={THREE}
        focusedConnectionId="c1"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('nav-connection')
          .find((r) => r.getAttribute('data-connection-id') === 'c1')!
          .getAttribute('aria-expanded'),
      ).toBe('true'),
    );
    listCollections.mockClear();

    await userEvent.click(screen.getByText('Drop').closest('button')!);

    await waitFor(() => expect(drop).toHaveBeenCalled());
    expect(drop.mock.calls[0]![0]).toMatchObject({ connectionId: 'c3' });
    await waitFor(() => expect(listCollections).toHaveBeenCalled());
    for (const [args] of listCollections.mock.calls) {
      expect(args).toMatchObject({ connectionId: 'c3' });
    }
  });

  it('reads the read-only marker off that Connection, not the Focused Tab’s', async () => {
    // `c3` is read-only and `c2` is not. The marker is a label, never
    // the guard (ADR 0005), but a label taken from the wrong Connection is
    // exactly how someone talks themselves into confirming.
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => [
          { name: 'orders', type: 'collection' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
        ],
      },
    });
    await mountOnArchive({
      connectionsWithTabs: new Set(),
      connections: [
        connectionFixture({ id: 'c1', name: 'Prod' }),
        connectionFixture({ id: 'c2', name: 'Staging' }),
        connectionFixture({ id: 'c3', name: 'Archive', readOnly: true }),
      ],
    });

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Drop collection' }));
    await userEvent.type(await screen.findByLabelText('Confirm collection name'), 'orders');

    expect(screen.getByText('This connection is read-only. Dropping is disabled.')).toBeTruthy();
    expect((screen.getByText('Drop').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DbCollectionNavigator — views and the connection string', () => {
  // Mantine's notification store outlives an unmount, so one test's toast
  // would otherwise be found by the next one's alert query.
  afterEach(() => notifications.clean());

  const VIEW_ROWS = [
    { name: 'orders', type: 'collection' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
    { name: 'recent', type: 'view' as const, capped: false },
  ];

  it('connection menu "Copy connection string" copies the URI main built, and says the password is left out', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const getUri = vi.fn(async () => ({ uri: 'mongodb://alice@db.example:27017/?tls=false' }));
    baseMocks({ conn: { list: async () => [], getUri } });

    mountNavigator();
    fireEvent.contextMenu(await screen.findByTestId('nav-connection'));
    const item = screen.getByRole('menuitem', { name: 'Copy connection string' });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(item);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('mongodb://alice@db.example:27017/?tls=false'));
    expect(getUri).toHaveBeenCalledWith('c1');
    await screen.findByText(/password not included/);
  });

  it('connection menu "Copy connection string" reports a failure to build the URI', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    baseMocks({
      conn: {
        list: async () => [],
        getUri: async () => {
          throw { code: 'NOT_FOUND', message: 'connection c1 not found' };
        },
      },
    });

    mountNavigator();
    fireEvent.contextMenu(await screen.findByTestId('nav-connection'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy connection string' }));

    await screen.findByText(/connection c1 not found/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('view menu "Modify view" opens a dialog prefilled from the view’s definition; Save modifies it and refreshes the DB', async () => {
    const listCollections = vi.fn(async () => VIEW_ROWS);
    const collectionDetails = vi.fn(async () => ({
      name: 'recent',
      type: 'view' as const,
      capped: false,
      options: { viewOn: 'orders', pipeline: '[{"$match":{"a":{"$numberInt":"1"}}}]' },
    }));
    const modify = vi.fn(async () => ({ ok: true as const }));
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections, collectionDetails },
      collection: { modify },
    });

    mountNavigator();
    await screen.findByText('recent');
    const initialCalls = listCollections.mock.calls.length;
    // What an open Structure tab on the view listens for.
    const changes: unknown[] = [];
    const off = onCollectionChanged((c) => changes.push(c));

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-recent'));
    const item = screen.getByRole('menuitem', { name: 'Modify view' });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(item);

    const source = (await screen.findByLabelText('Source collection')) as HTMLInputElement;
    await waitFor(() => expect(source.value).toBe('orders'));
    const pipeline = screen.getByLabelText('Pipeline') as HTMLTextAreaElement;
    expect(JSON.parse(pipeline.value)).toEqual([{ $match: { a: 1 } }]);
    expect(collectionDetails).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop', collection: 'recent' });

    fireEvent.change(pipeline, { target: { value: '[{"$match":{"a":2}}]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(modify).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'recent',
        options: { viewOn: 'orders', pipeline: '[{"$match":{"a":2}}]' },
      }),
    );
    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(initialCalls));
    await waitFor(() => expect(screen.queryByLabelText('Pipeline')).toBeNull());
    expect(changes).toEqual([{ connectionId: 'c1', dbName: 'shop', collection: 'recent' }]);
    off();
  });

  it('"Modify view" refuses a pipeline that is not a JSON array, inline and without a call', async () => {
    const modify = vi.fn(async () => ({ ok: true as const }));
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => VIEW_ROWS,
        collectionDetails: async () => ({
          name: 'recent', type: 'view' as const, capped: false, options: { viewOn: 'orders', pipeline: '[]' },
        }),
      },
      collection: { modify },
    });

    mountNavigator();
    await screen.findByText('recent');
    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-recent'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Modify view' }));
    const pipeline = (await screen.findByLabelText('Pipeline')) as HTMLTextAreaElement;
    await waitFor(() => expect(pipeline.value).toBe('[]'));

    for (const bad of ['[{"$match":', '{"$match":{}}']) {
      fireEvent.change(pipeline, { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/JSON array/);
    }
    expect(modify).not.toHaveBeenCalled();
  });

  it('view menu "Duplicate view…" opens a prefilled dialog; Create makes <name>_copy verbatim and refreshes the DB', async () => {
    const listCollections = vi.fn(async () => VIEW_ROWS);
    const pipeline = '[{"$match":{"a":{"$numberInt":"1"}}}]';
    const collectionDetails = vi.fn(async () => ({
      name: 'recent',
      type: 'view' as const,
      capped: false,
      options: { viewOn: 'orders', pipeline, collation: '{"locale":"fr"}' },
    }));
    const create = vi.fn(async (input: { collection: string }) => ({ name: input.collection }));
    baseMocks({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }], listCollections, collectionDetails },
      collection: { create },
    });

    mountNavigator();
    await screen.findByText('recent');
    const initialCalls = listCollections.mock.calls.length;

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-recent'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate view…' }));

    const name = (await screen.findByLabelText('View name')) as HTMLInputElement;
    expect(name.value).toBe('recent_copy');
    expect(collectionDetails).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop', collection: 'recent' });
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'recent_copy',
        options: { viewOn: 'orders', pipeline, collation: '{"locale":"fr"}' },
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText('View name')).toBeNull());
    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  it('"Duplicate view…" reports an unreadable view instead of opening the dialog', async () => {
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => VIEW_ROWS,
        collectionDetails: async () => {
          throw { code: 'NOT_FOUND', message: 'view recent is gone' };
        },
      },
    });

    mountNavigator();
    await screen.findByText('recent');
    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-recent'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate view…' }));

    await screen.findByText(/view recent is gone/);
    expect(screen.queryByLabelText('View name')).toBeNull();
  });

  it('"Duplicate view…" on two views in quick succession opens only the latest, whatever order the reads finish in', async () => {
    const resolvers: Record<string, () => void> = {};
    const details = (name: string) => ({
      name,
      type: 'view' as const,
      capped: false,
      options: { viewOn: `${name}_src`, pipeline: '[]' },
    });
    const collectionDetails = vi.fn(
      ({ collection }: { collection: string }) =>
        new Promise<ReturnType<typeof details>>((r) => (resolvers[collection] = () => r(details(collection)))),
    );
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => [
          { name: 'first', type: 'view' as const, capped: false },
          { name: 'second', type: 'view' as const, capped: false },
        ],
        collectionDetails: collectionDetails as never,
      },
    });

    mountNavigator();
    await screen.findByText('first');
    for (const name of ['first', 'second']) {
      fireEvent.contextMenu(screen.getByTestId(`nav-coll-shop-${name}`));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate view…' }));
    }
    await waitFor(() => expect(collectionDetails).toHaveBeenCalledTimes(2));

    resolvers.second!();
    expect(((await screen.findByLabelText('View name')) as HTMLInputElement).value).toBe('second_copy');
    resolvers.first!();
    await new Promise((r) => setTimeout(r, 20));
    expect((screen.getByLabelText('View name') as HTMLInputElement).value).toBe('second_copy');
    expect(screen.getByText(/A copy of second on shop\.second_src/)).toBeTruthy();
    expect(screen.getByText(/same pipeline and collation/)).toBeTruthy();
    expect(screen.queryByText(/runs the enabled stages/)).toBeNull();
  });

  it('"Duplicate view…" is offered on views only', async () => {
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => VIEW_ROWS,
      },
    });

    mountNavigator();
    await screen.findByText('recent');
    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    expect(screen.queryByRole('menuitem', { name: 'Duplicate view…' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Rename collection' })).toBeTruthy();
  });

  it('no menu item is left as a "Coming soon" stub', async () => {
    baseMocks({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => VIEW_ROWS,
      },
    });

    mountNavigator();
    await screen.findByText('recent');

    fireEvent.contextMenu(screen.getByTestId('nav-connection'));
    expect(screen.getByRole('menuitem', { name: 'Copy connection string' })).toBeTruthy();
    expect(screen.queryByTitle('Coming soon')).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-recent'));
    expect(screen.getByRole('menuitem', { name: 'Modify view' })).toBeTruthy();
    expect(screen.queryByTitle('Coming soon')).toBeNull();
  });
});
