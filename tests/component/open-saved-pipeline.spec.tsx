import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { notify } from '../../src/theme/notifications';
import type { CollectionTabState, SavedQuerySummary, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-02T12:00:00.000Z';

const STATE: CollectionTabState = {
  view: 'Tree',
  builder: { projection: [], sort: '', limit: '' },
  queryRaw: '{}',
  page: 0,
  pageSize: 50,
  // The Saved list is where a pipeline is opened from.
  activeBuilderTab: 'Saved',
  // Seeded so the auto-run-on-open effect doesn't fire a background find.
  lastRun: { documents: [], durationMs: 0, ranAt: now },
};

const TAB: WorkspaceTab = {
  id: 't1',
  kind: 'collection',
  connectionId: 'c1',
  dbName: 'mydb',
  collection: 'users',
  position: 0,
  isActive: true,
  openedAt: now,
  pinned: false,
  state: STATE,
};

const CONNECTION = {
  id: 'c1',
  name: 'Local',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard' as const,
  readOnly: false,
  status: 'connected' as const,
};

const PIPELINE: SavedQuerySummary = {
  id: 's1',
  connectionId: 'c1',
  dbName: 'mydb',
  collection: 'users',
  kind: 'aggregation',
  name: 'Top spenders',
  updatedAt: now,
};

// The whole Workspace page mounts here; the first test in the file also pays the
// cold module load, which outlasts findBy's 1 s default on a loaded CI runner.
const SLOW_MOUNT = { timeout: 10_000 };

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// Opening a saved pipeline can now be refused by main (the row was deleted since
// the list loaded, or its payload is unreadable). The click is `void`-ed in
// PanelBody, so without its own catch the refusal would be an unhandled rejection
// and the user would see nothing happen.
describe('opening a saved pipeline from the Saved list', () => {
  function mount(openAggregation: IpcApi['tabs']['openAggregation']) {
    installAtelierMock({
      tabs: {
        list: async () => [TAB],
        setActive: async (id) => ({ id }),
        update: (async () => TAB) as unknown as IpcApi['tabs']['update'],
        openAggregation,
      },
      conn: { list: async () => [CONNECTION] },
      prefs: { get: async () => null, set: async () => undefined } as unknown as IpcApi['prefs'],
      query: { find: async () => ({ documents: [], durationMs: 1, hasMore: false }), count: async () => ({ count: 0 }) },
      saved: { list: async () => [PIPELINE] },
    });
    return render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
  }

  it('asks main to open it by its saved id', async () => {
    const open = vi.fn<IpcApi['tabs']['openAggregation']>(async () => TAB as never);
    mount(open);

    fireEvent.click(await screen.findByRole('button', { name: 'Open "Top spenders" in a new tab' }, SLOW_MOUNT));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'mydb',
        collection: 'users',
        savedId: 's1',
        name: 'Top spenders',
      }),
    );
  });

  it('names the pipeline when it no longer exists', async () => {
    const error = vi.spyOn(notify, 'error').mockImplementation(() => undefined as never);
    mount(async () => {
      throw Object.assign(new Error('saved query 7d1c4e0a-uuid not found'), { code: 'NOT_FOUND' });
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open "Top spenders" in a new tab' }, SLOW_MOUNT));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('It no longer exists.', { title: 'Could not open “Top spenders”' }),
    );
  });

  it("shows main's reason when it refuses for another cause", async () => {
    const error = vi.spyOn(notify, 'error').mockImplementation(() => undefined as never);
    mount(async () => {
      throw Object.assign(new Error('saved pipeline "Top spenders" is unreadable: its stages are missing or malformed'), {
        code: 'VALIDATION',
      });
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open "Top spenders" in a new tab' }, SLOW_MOUNT));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'saved pipeline "Top spenders" is unreadable: its stages are missing or malformed',
        { title: 'Could not open “Top spenders”' },
      ),
    );
  });
});
