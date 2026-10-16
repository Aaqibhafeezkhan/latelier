import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { StructureView } from '../../src/pages/Workspace/StructureView';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { DEFAULT_SCHEMA_TAB_STATE } from '@shared/defaults';
import type { CollectionTab, IndexInfo, SchemaSampleEntry } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const ID_INDEX: IndexInfo = {
  name: '_id_',
  key: [{ field: '_id', direction: 1 }],
  isIdIndex: true,
  unique: false,
  sparse: false,
  hidden: false,
  version: 2,
  sizeBytes: 4096,
};

function renderStructure(state = DEFAULT_SCHEMA_TAB_STATE, onPatch = vi.fn()) {
  return {
    onPatch,
    ...render(
      <StructureView
        connectionId="c1"
        dbName="shop"
        collection="orders"
        state={state}
        onPatch={onPatch}
      />,
    ),
  };
}

describe('StructureView — indexes above schema, one pane', () => {
  it('renders both the indexes section and the schema section', async () => {
    installAtelierMock({
      index: { list: async () => [ID_INDEX] },
      meta: { sampleSchema: async () => ({ docs: [] }) },
    });

    renderStructure();

    await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Indexes' })).toBeTruthy();
    expect(screen.getByLabelText('Sample size')).toBeTruthy();
  });

  it('calls index.list on entry', async () => {
    const list = vi.fn(async () => [ID_INDEX]);
    installAtelierMock({
      index: { list },
      meta: { sampleSchema: async () => ({ docs: [] }) },
    });

    renderStructure();

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop', collection: 'orders' }),
    );
  });

  it('does not re-sample the schema when entries are already seeded', async () => {
    const sampleSchema = vi.fn(async () => ({ docs: [] }));
    installAtelierMock({
      index: { list: async () => [ID_INDEX] },
      meta: { sampleSchema },
    });

    const entries: SchemaSampleEntry[] = [{ path: 'sku', frequency: 1, types: { string: 3 } }];
    renderStructure({ ...DEFAULT_SCHEMA_TAB_STATE, entries, sampledCount: 3, ranAt: '2026-04-21T00:00:00.000Z' });

    // Let the indexes list resolve and any queued schema-sample microtask flush.
    await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());
    await Promise.resolve();
    await Promise.resolve();

    expect(sampleSchema).not.toHaveBeenCalled();
    expect(screen.getByText('sku')).toBeTruthy();
  });

  it('Refresh re-samples the schema', async () => {
    const sampleSchema = vi.fn(async () => ({ docs: [{ sku: 'a' }] }));
    installAtelierMock({
      index: { list: async () => [] },
      meta: { sampleSchema },
    });

    const entries: SchemaSampleEntry[] = [{ path: 'sku', frequency: 1, types: { string: 3 } }];
    renderStructure({ ...DEFAULT_SCHEMA_TAB_STATE, entries, sampledCount: 3, ranAt: '2026-04-21T00:00:00.000Z' });

    await waitFor(() => expect(screen.getByText('sku')).toBeTruthy());
    expect(sampleSchema).not.toHaveBeenCalled();

    // Both sections have a "Refresh" button — the indexes one first, then
    // the schema one (indexes stacked above schema).
    const refreshButtons = screen.getAllByRole('button', { name: 'Refresh' });
    await userEvent.click(refreshButtons[refreshButtons.length - 1]!);

    await waitFor(() => expect(sampleSchema).toHaveBeenCalledTimes(1));
  });
});

describe('SchemaView — sample size is bounded by what meta:sampleSchema accepts', () => {
  it('offers exactly 50, 100 and 200', async () => {
    installAtelierMock({
      index: { list: async () => [] },
      meta: { sampleSchema: async () => ({ docs: [] }) },
    });
    renderStructure();

    const select = (await screen.findByLabelText('Sample size')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['50', '100', '200']);
  });

  it('samples at the bound when a restored tab carries a size the channel would refuse', async () => {
    const sampleSchema = vi.fn(async () => ({ docs: [{ sku: 'a' }] }));
    installAtelierMock({
      index: { list: async () => [] },
      meta: { sampleSchema },
    });
    const entries: SchemaSampleEntry[] = [{ path: 'sku', frequency: 1, types: { string: 3 } }];
    renderStructure({
      ...DEFAULT_SCHEMA_TAB_STATE,
      sampleSize: 500,
      entries,
      sampledCount: 3,
      ranAt: '2026-04-21T00:00:00.000Z',
    });

    const refreshButtons = await screen.findAllByRole('button', { name: 'Refresh' });
    await userEvent.click(refreshButtons[refreshButtons.length - 1]!);

    await waitFor(() => expect(sampleSchema).toHaveBeenCalledTimes(1));
    expect(sampleSchema).toHaveBeenCalledWith(expect.objectContaining({ size: 200 }));
  });
});

// ─── Header count on return to Documents (PanelBody's structural claim) ────

const now = '2026-04-21T12:00:00.000Z';

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
      activeView: 'documents',
      view: 'Tree',
      builder: {
        projection: [],
        sort: '',
        limit: '',
      },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
    ...overrides,
  };
}

describe('Structure view — header count on return to Documents', () => {
  // PanelBody only mounts `CollectionHeader` inside `view === 'documents'`
  // (it dims-not-unmounts the builder pane for agg/structure, but the
  // header itself is conditional). Leaving Structure and coming back to
  // Documents therefore remounts it, which re-fetches `meta.listCollections`
  // for free — no dedicated refresh signal needed. This proves that claim
  // rather than assuming it.
  it('re-fetches the header count after Structure → Documents, with no signal wired up', async () => {
    let call = 0;
    const listCollections = vi.fn(async () => {
      call += 1;
      return [
        {
          name: 'coll',
          type: 'collection' as const,
          documentCount: call === 1 ? 10 : 25,
          sizeBytes: 0,
          indexCount: 1,
          capped: false,
        },
      ];
    });
    installAtelierMock({
      tabs: {
        list: async () => [collectionTab()],
        update: async () => collectionTab() as never,
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Prod',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      meta: { listCollections, sampleSchema: async () => ({ docs: [] }) },
      index: { list: async () => [] },
    });

    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());

    await userEvent.click(screen.getByRole('tab', { name: /Structure/i }));
    await waitFor(() => expect(screen.queryByText('10')).toBeNull());

    // The navigator (DbCollectionNavigator) also fetches listCollections once,
    // independently, to auto-expand the focused tab's db — its timing floats
    // relative to these clicks (a 300ms empty-db retry can land it anywhere
    // in this test), so the total call count isn't deterministic. Snapshot
    // here and assert only that the Documents click itself caused a further
    // call — that's the behaviour this test is about.
    const callsBeforeReturn = listCollections.mock.calls.length;

    await userEvent.click(screen.getByRole('tab', { name: /Documents/i }));

    await waitFor(() => expect(screen.getByText('25')).toBeTruthy());
    expect(listCollections.mock.calls.length).toBeGreaterThan(callsBeforeReturn);
  });
});
