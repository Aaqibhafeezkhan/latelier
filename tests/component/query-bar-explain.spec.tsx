import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { ExplainDrawer } from '../../src/pages/Workspace/Aggregation/ExplainDrawer';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab } from '@shared/types';
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
      // explain click, desynchronizing the `toHaveBeenCalledTimes`
      // assertions below.
      lastRun: { documents: [], durationMs: 0, ranAt: now },
    },
    ...overrides,
  };
}

const baseConn = {
  id: 'c1',
  name: 'Local',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard' as const,
  readOnly: false,
  status: 'connected' as const,
};

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

async function openExplainMenu() {
  const chevron = await screen.findByTestId('query-run-options-btn');
  fireEvent.click(chevron);
  return chevron;
}

describe('QueryBar - Explain menu', () => {
  it('clicking the chevron then Explain (queryPlanner) calls api.query.explain and opens the drawer', async () => {
    const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
      verbosity: 'queryPlanner',
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => [baseConn] },
      query: {
        find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
        count: async () => ({ count: 0 }),
        explain: explainSpy,
      },
    });

    mountWorkspace();

    await openExplainMenu();
    const explainItem = await screen.findByRole('menuitem', { name: 'queryPlanner' });
    fireEvent.click(explainItem);

    await waitFor(() => {
      expect(explainSpy).toHaveBeenCalledTimes(1);
    });

    const callArgs = explainSpy.mock.calls[0]?.[0];
    expect(callArgs?.connectionId).toBe('c1');
    expect(callArgs?.dbName).toBe('mydb');
    expect(callArgs?.collection).toBe('users');
    expect(callArgs?.verbosity).toBe('queryPlanner');

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    expect(dialog).toBeTruthy();
    await waitFor(() => {
      expect(dialog.textContent).toContain('COLLSCAN');
    });
  });

  // W14 §9 — the plan has to be for the query that runs, collation included.
  it('sends the collation, hint and read preference', async () => {
    const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({ plan: {}, verbosity: 'queryPlanner' }));
    const tab = makeCollectionTab();
    tab.state.builder = {
      ...tab.state.builder,
      collation: '{"locale":"en"}',
      hint: '{"name":1}',
      maxTimeMS: '500',
      readPreference: 'primaryPreferred',
    };
    installAtelierMock({
      tabs: {
        list: async () => [tab],
        setActive: async (id) => ({ id }),
        update: async () => tab,
      },
      conn: { list: async () => [baseConn] },
      query: {
        find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
        count: async () => ({ count: 0 }),
        explain: explainSpy,
      },
    });

    mountWorkspace();
    await openExplainMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'queryPlanner' }));

    await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(1));
    expect(explainSpy.mock.calls[0]![0]).toMatchObject({
      collation: '{"locale":"en"}',
      hint: '{"name":1}',
      readPreference: 'primaryPreferred',
    });
    expect(explainSpy.mock.calls[0]![0]).not.toHaveProperty('maxTimeMS');
  });

  it('sends queryRaw as the filter', async () => {
    const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({
      plan: { ok: 1 },
      verbosity: 'queryPlanner',
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: { projection: [], sort: '', limit: '' },
              queryRaw: '{"foo":1}',
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
      conn: { list: async () => [baseConn] },
      query: {
        find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
        count: async () => ({ count: 0 }),
        explain: explainSpy,
      },
    });

    mountWorkspace();

    await openExplainMenu();
    const explainItem = await screen.findByRole('menuitem', { name: 'queryPlanner' });
    fireEvent.click(explainItem);

    await waitFor(() => {
      expect(explainSpy).toHaveBeenCalledTimes(1);
    });

    expect(explainSpy.mock.calls[0]?.[0]?.filter).toBe('{"foo":1}');
  });

  it('the chevron is disabled when the textarea has invalid EJSON, same gate as Run', async () => {
    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: { projection: [], sort: '', limit: '' },
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
      conn: { list: async () => [baseConn] },
    });

    mountWorkspace();

    const chevron = await screen.findByTestId('query-run-options-btn');
    expect(chevron).toHaveProperty('disabled', true);
  });

  it('W13 §7: a raw $elemMatch clause is now a plain runnable filter — chevron and Explain items both enabled', async () => {
    // Pre-W13 this scenario ($elemMatch, a "needs raw JSON" op the old
    // builder compiler couldn't encode) left the Run button enabled but
    // Explain disabled — two different rules for the same input. W13
    // deletes the builder-compiled filter path entirely: `queryRaw` is the
    // single source of truth, and `$elemMatch` here is just valid EJSON
    // text, so Explain follows the exact same `isValidEjson` rule as Run.
    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: { projection: [], sort: '', limit: '' },
              queryRaw: '{"items":{"$elemMatch":{"sku":1}}}',
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
      conn: { list: async () => [baseConn] },
      query: {
        find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
        count: async () => ({ count: 0 }),
        explain: vi.fn(async () => ({ plan: { ok: 1 }, verbosity: 'queryPlanner' })),
      },
    });

    mountWorkspace();

    const chevron = await screen.findByTestId('query-run-options-btn');
    expect(chevron).toHaveProperty('disabled', false);
    fireEvent.click(chevron);

    const explainItem = await screen.findByRole('menuitem', { name: 'queryPlanner' });
    expect(explainItem).toHaveProperty('disabled', false);
  });

  it('choosing a different verbosity passes it through to api.query.explain', async () => {
    const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({
      plan: { ok: 1 },
      verbosity: 'executionStats',
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => [baseConn] },
      query: {
        find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
        count: async () => ({ count: 0 }),
        explain: explainSpy,
      },
    });

    mountWorkspace();

    await openExplainMenu();
    const explainItem = await screen.findByRole('menuitem', { name: 'executionStats' });
    fireEvent.click(explainItem);

    await waitFor(() => {
      expect(explainSpy).toHaveBeenCalledTimes(1);
    });

    expect(explainSpy.mock.calls[0]?.[0]?.verbosity).toBe('executionStats');
  });

  it('renders the explain error inline in the drawer instead of throwing', async () => {
    const explainSpy = vi.fn(async () => {
      throw { code: 'MONGO_OP_FAILED', message: 'index not found' };
    });

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => [baseConn] },
      query: {
        find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
        count: async () => ({ count: 0 }),
        explain: explainSpy,
      },
    });

    mountWorkspace();

    await openExplainMenu();
    const explainItem = await screen.findByRole('menuitem', { name: 'queryPlanner' });
    fireEvent.click(explainItem);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    // X15 T6 — was `dialog.querySelector('[role="alert"]')`, which reaches into
    // the drawer's internal element tree. `within(dialog).findByRole('alert')`
    // asserts the same thing — the error is surfaced *inside* the drawer, as an
    // alert — without depending on where in the panel it lands.
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('index not found');
  });
});

/**
 * X14 — Explain and Shell Syntax.
 *
 * Neither test blurs the textarea. They cannot: the point of this repair is the paths
 * where nothing blurs.
 */
describe('QueryBar — Explain reads through the X14 repair', () => {
  function tabWith(queryRaw: string, seedLastRun: boolean) {
    return makeCollectionTab({
      state: {
        view: 'Tree',
        builder: { projection: [], sort: '', limit: '' },
        queryRaw,
        page: 0,
        pageSize: 50,
        activeBuilderTab: 'Builder',
        // Omitting `lastRun` lets the auto-run-on-open effect fire, which
        // is the no-blur repair path this test needs.
        ...(seedLastRun ? { lastRun: { documents: [], durationMs: 0, ranAt: now } } : {}),
      },
    });
  }

  function mountWith(tab: ReturnType<typeof makeCollectionTab>, explainSpy: IpcApi['query']['explain']) {
    installAtelierMock({
      tabs: {
        list: async () => [tab],
        setActive: async (id) => ({ id }),
        update: async () => tab,
      },
      conn: { list: async () => [baseConn] },
      query: {
        find: async () => ({ documents: [], durationMs: 0, hasMore: false }),
        count: async () => ({ count: 0 }),
        explain: explainSpy,
      },
    });
    mountWorkspace();
  }

  it('gates Explain on Shell Syntax exactly as it gates Run — one rule, not two', async () => {
    const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({
      plan: { ok: 1 },
      verbosity: 'queryPlanner',
    }));
    // A tab can open holding Shell Syntax: state written before X14, or a
    // saved query from elsewhere. `isDefaultQueryState` refuses to auto-run a
    // non-default filter, so nothing repairs it until the user commits the
    // box. Until then Run and Explain are both closed — which is the property
    // worth pinning. This repair was about the two disagreeing; they must not.
    mountWith(tabWith('{age: {$gt: 60}}', false), explainSpy);

    const chevron = await screen.findByTestId('query-run-options-btn');
    const run = await screen.findByTestId('query-run-btn');
    expect(chevron).toHaveProperty('disabled', true);
    expect(run).toHaveProperty('disabled', true);
    expect(explainSpy).not.toHaveBeenCalled();
  });

  // The Run gate trims, so NBSP padding opens Explain; the repair Explain
  // reads through used to refuse the same text and leave the click dead.
  it('explains a filter padded with Unicode spaces, sending it trimmed', async () => {
    const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({
      plan: { ok: 1 },
      verbosity: 'queryPlanner',
    }));
    mountWith(tabWith('\u00a0{"foo":1}\u00a0', true), explainSpy);

    await openExplainMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'queryPlanner' }));

    await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(1));
    expect(explainSpy.mock.calls[0]?.[0]?.filter).toBe('{"foo":1}');
  });

  it('sends the filter byte-identical when it already parses strictly', async () => {
    const explainSpy = vi.fn<IpcApi['query']['explain']>(async () => ({
      plan: { ok: 1 },
      verbosity: 'queryPlanner',
    }));
    // The gate opens on strict text and on strict text padded with Unicode
    // spaces; the repair Explain reads through trims only that padding (the
    // test above). Strict text with ordinary spacing comes back `unchanged`,
    // so a reformatting repair fails here rather than Explain quietly
    // rewriting a filter the user arranged.
    const hand = '{ "b" : 1,   "a" : 2 }';
    mountWith(tabWith(hand, true), explainSpy);

    await openExplainMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'queryPlanner' }));

    await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(1));
    expect(explainSpy.mock.calls[0]?.[0]?.filter).toBe(hand);
  });
});

describe('ExplainDrawer - onCancelToken stability', () => {
  // Regression guard: `onCancelToken` is read through `useLatest` (like
  // `runExplain`) and the fetch effect keys only on `verbosity`. A caller
  // passing an unmemoized `onCancelToken` — which neither current call site
  // does, but nothing should assume that — must not cancel/refetch the
  // in-flight explain on every re-render.
  it('a new onCancelToken reference on re-render does not re-trigger the explain fetch', async () => {
    const runExplain = vi.fn(async () => ({ plan: { queryPlanner: { winningPlan: {} } } }));

    const { rerender } = render(
      <ExplainDrawer onClose={() => {}} runExplain={runExplain} onCancelToken={() => {}} />,
    );

    await waitFor(() => {
      expect(runExplain).toHaveBeenCalledTimes(1);
    });

    // Re-render with a brand-new `onCancelToken` identity, simulating an
    // unmemoized caller callback.
    rerender(
      <ExplainDrawer onClose={() => {}} runExplain={runExplain} onCancelToken={() => {}} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runExplain).toHaveBeenCalledTimes(1);
  });
});
