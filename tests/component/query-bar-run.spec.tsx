import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { QueryBar } from '../../src/pages/Workspace/QueryBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import { resultQueryKey } from '../../src/pages/Workspace/builder';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab, CollectionTabState } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-04-21T12:00:00.000Z';

function makeCollectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'mydb',
    collection: 'users',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state: {
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
      // Seeded so these tests read as "already run" — otherwise the
      // auto-run-on-open effect would fire a background find before the
      // manual Run click, desynchronizing the `toHaveBeenCalledTimes`
      // assertions below.
      lastRun: { documents: [], durationMs: 0, ranAt: now },
    },
    ...overrides,
  };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function mountWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

describe('QueryBar - the hint that the next Run leaves this page (W07 §3)', () => {
  const stateWith = (over: Partial<CollectionTabState>): CollectionTabState => ({
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{"a":1}',
    page: 2,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    ...over,
  });
  const ranKey = resultQueryKey(stateWith({}))!;
  const hintFor = (over: Partial<CollectionTabState>) => {
    render(
      <CollectionWorkspaceProvider
        state={stateWith({ lastRunQueryKey: ranKey, ...over })}
        actions={emptyWorkspaceActions()}
        meta={emptyWorkspaceMeta()}
      >
        <QueryBar suggestionContext={null} loadGen={0} />
      </CollectionWorkspaceProvider>,
    );
    return screen.queryByTestId('page-reset-hint');
  };

  it('appears on a later page once the query differs from the one that ran', () => {
    expect(hintFor({ queryRaw: '{"a":2}' })?.textContent).toBe('Will jump to page 1 on run');
  });

  it('stays away while the query is the one that ran', () => {
    expect(hintFor({})).toBeNull();
  });

  it('stays away on the first page, where there is nothing to jump from', () => {
    expect(hintFor({ queryRaw: '{"a":2}', page: 0 })).toBeNull();
  });

  it('stays away while the edit cannot run', () => {
    expect(hintFor({ queryRaw: '{"a":' })).toBeNull();
  });

  it('stays away on a tab with no recorded run', () => {
    expect(hintFor({ queryRaw: '{"a":2}', lastRunQueryKey: undefined })).toBeNull();
  });
});

describe('QueryBar - Run button', () => {
  it('clicking Run calls api.query.find with correct args', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [{ _id: { $oid: 'abc123abc123abc123abc123' }, name: 'Alice' }],
      durationMs: 12,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      query: {
        find: findSpy,
        count: async () => ({ count: 1 }),
      },
    });

    mountWorkspace();

    // Wait for tab to render and Run button to appear
    const runBtn = await screen.findByTestId('query-run-btn');
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(findSpy).toHaveBeenCalledTimes(1);
    });

    const callArgs = findSpy.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.connectionId).toBe('c1');
    expect(callArgs?.dbName).toBe('mydb');
    expect(callArgs?.collection).toBe('users');
    expect(callArgs?.filter).toBe('{}');
  });

  it('Run button is disabled when textarea has invalid EJSON', async () => {
    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: {
                projection: [],
                sort: '',
                limit: '',
              },
              queryRaw: 'not valid json{{{',
              page: 0,
              pageSize: 50,
              activeBuilderTab: 'Builder',
              lastRun: { documents: [], durationMs: 0, ranAt: now },
            },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
    });

    mountWorkspace();

    const runBtn = await screen.findByTestId('query-run-btn');
    expect(runBtn).toHaveProperty('disabled', true);
  });

  it('builder.limit caps the find limit when smaller than pageSize', async () => {
    // Regression: BuilderPane Limit field accepts input but
    // wasn't threaded into query.find — pageSize was always sent.
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [
        { _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, n: 1 },
        { _id: { $oid: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, n: 2 },
      ],
      // Server still says hasMore (pageSize+1 trim trick), but the renderer
      // must override it because the user cap is reached.
      durationMs: 5,
      hasMore: true,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: {
                projection: [],
                sort: '',
                limit: '2',
              },
              queryRaw: '{}',
              page: 0,
              pageSize: 50,
              activeBuilderTab: 'Builder',
            },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      query: {
        find: findSpy,
        // Server has 60 docs but the user cap is 2 — pagination should
        // display "2", not "60".
        count: async () => ({ count: 60 }),
      },
    });

    mountWorkspace();

    const runBtn = await screen.findByTestId('query-run-btn');
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(findSpy).toHaveBeenCalledTimes(1);
    });

    expect(findSpy.mock.calls[0]?.[0]?.limit).toBe(2);
    expect(findSpy.mock.calls[0]?.[0]?.skip).toBe(0);
  });

  it('builder.limit larger than pageSize still paginates within the cap', async () => {
    // userLimit=120, pageSize=50, page=2 → skip=100, remaining=20.
    // We expect the find to be issued with limit=20 (not 50, not 120).
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: Array.from({ length: 20 }, (_, i) => ({
        _id: { $oid: 'a'.repeat(24) },
        n: i,
      })),
      durationMs: 7,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: {
                projection: [],
                sort: '',
                limit: '120',
              },
              queryRaw: '{}',
              page: 2,
              pageSize: 50,
              activeBuilderTab: 'Builder',
            },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      query: { find: findSpy, count: async () => ({ count: 500 }) },
    });

    mountWorkspace();

    const runBtn = await screen.findByTestId('query-run-btn');
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(findSpy).toHaveBeenCalledTimes(1);
    });

    expect(findSpy.mock.calls[0]?.[0]?.limit).toBe(20);
    expect(findSpy.mock.calls[0]?.[0]?.skip).toBe(100);
  });

  it('builder.limit reached on a later page moves back inside the cap instead of finding with limit 0', async () => {
    // userLimit=10, pageSize=50, page=1 → skip=50, past the cap.
    // Sending limit=0 to Mongo would mean "no limit" and dump the whole
    // collection, so the renderer must not issue the find.
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 0,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: {
                projection: [],
                sort: '',
                limit: '10',
              },
              queryRaw: '{}',
              page: 1,
              pageSize: 50,
              activeBuilderTab: 'Builder',
            },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      query: { find: findSpy, count: async () => ({ count: 1000 }) },
    });

    mountWorkspace();

    const runBtn = await screen.findByTestId('query-run-btn');
    fireEvent.click(runBtn);

    // limit=0 never reaches the find: the page moves back inside the cap.
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.skip).toBe(0);
    expect(findSpy.mock.calls[0]?.[0]?.limit).toBe(10);
  });

  it('after a successful run, result count appears in result bar', async () => {
    const documents = [
      { _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, name: 'Alice' },
      { _id: { $oid: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, name: 'Bob' },
    ];

    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents,
      durationMs: 42,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      query: {
        find: findSpy,
        count: async () => ({ count: 2 }),
      },
    });

    mountWorkspace();

    const runBtn = await screen.findByTestId('query-run-btn');
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(findSpy).toHaveBeenCalledTimes(1);
    });

    // Result bar — its text is split across siblings (a <strong>2</strong>
    // followed by " results"), so a string matcher won't catch it. We
    // assert on the bold count and the timing chip independently.
    await waitFor(() => {
      expect(screen.getByText('2', { selector: 'strong' })).toBeTruthy();
      expect(screen.getByText('42', { selector: 'strong' })).toBeTruthy();
    });
  });

  it('Run swaps to Cancel while a find is in flight; Cancel aborts it and returns to idle with no error banner', async () => {
    let rejectFind: ((err: unknown) => void) | undefined;
    const findSpy = vi.fn<IpcApi['query']['find']>(
      () =>
        new Promise((_res, rej) => {
          rejectFind = rej;
        }),
    );
    const cancelSpy = vi.fn<IpcApi['query']['cancel']>(async () => undefined);

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      query: {
        find: findSpy,
        count: async () => ({ count: 0 }),
        cancel: cancelSpy,
      },
    });

    mountWorkspace();

    const runBtn = await screen.findByTestId('query-run-btn');
    fireEvent.click(runBtn);
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));

    // isLoading flips true after the loading-delay timer — the Run button
    // is replaced by a keyboard-accessible native Cancel button.
    const cancelBtn = await screen.findByTestId('query-cancel-btn');
    expect(cancelBtn.tagName).toBe('BUTTON');
    expect(screen.queryByTestId('query-run-btn')).toBeNull();

    fireEvent.click(cancelBtn);

    const callArgs = cancelSpy.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(typeof callArgs?.token).toBe('string');

    // Back to idle immediately, without waiting for the abort to settle.
    await screen.findByTestId('query-run-btn');
    expect(screen.queryByTestId('query-cancel-btn')).toBeNull();

    // The aborted find rejecting afterwards must not surface as an error —
    // a cancelled run is not a failure.
    rejectFind!(Object.assign(new Error('aborted'), { code: 'INTERNAL' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/INTERNAL:/)).toBeNull();
  });
});
