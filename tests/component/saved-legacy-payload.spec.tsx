import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, RecentQuery, SavedQuery, SavedQuerySummary, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-04T12:00:00.000Z';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Saved',
    lastRun: { documents: [], durationMs: 0, ranAt: now },
    ...overrides,
  };
}

function makeCollectionTab(state: CollectionTabState): WorkspaceTab {
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
    state,
  };
}

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

const SAVED_SUMMARY: SavedQuerySummary = {
  id: 'q1',
  connectionId: 'c1',
  dbName: 'mydb',
  collection: 'users',
  kind: 'find',
  name: 'Legacy filter',
  updatedAt: now,
};

/**
 * A saved find payload as it would have been written before `queryRaw`
 * existed: the filter lives only in `builder.conditions`, and `builder`
 * carries the sort/limit/projection the shim must not lose either.
 */
// Typed loosely (not `: SavedQuery`) on purpose: the live `SavedQuery`
// payload type now requires `queryRaw` and shrinks `builder` to
// sort/limit/projection, but a row written before W13 — which this fixture
// simulates — has neither `queryRaw` nor a shrunk `builder`. The wire's IPC
// schema validates loosely (`z.record`), so a legacy row really can arrive
// shaped like this despite the live type claiming otherwise; the cast below
// mirrors that mismatch instead of typechecking it away.
const LEGACY_SAVED = {
  ...SAVED_SUMMARY,
  createdAt: now,
  payload: {
    kind: 'find',
    builder: {
      conditions: [
        { id: 1, field: 'status', op: '$eq', valType: 'string', value: 'active' },
      ],
      logic: 'AND',
      projection: ['name'],
      sort: '{"age":1}',
      limit: '10',
    },
    // No `queryRaw` — the pre-W13 shape.
  },
} as unknown as SavedQuery;

/**
 * A find saved after the raw-projection surface shipped, carrying a raw projection. The live
 * `SavedFindPayload` does have `projectionRaw`; the cast is only here because
 * this fixture shares `LEGACY_SAVED`'s loose typing so both can go through the
 * same mount helper.
 */
const RAW_PROJECTION_SAVED = {
  ...SAVED_SUMMARY,
  createdAt: now,
  payload: {
    kind: 'find',
    builder: { projection: [], projectionRaw: '{"_id":0}', sort: '', limit: '' },
    queryRaw: '{}',
  },
} as unknown as SavedQuery;

function mountWith(state: CollectionTabState, saved: SavedQuery = LEGACY_SAVED, recent: RecentQuery[] = []) {
  const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
    documents: [],
    durationMs: 3,
    hasMore: false,
  }));
  const updateSpy = vi.fn(async () => makeCollectionTab(state));

  installAtelierMock({
    tabs: {
      list: async () => [makeCollectionTab(state)],
      setActive: async (id) => ({ id }),
      update: updateSpy as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    saved: {
      list: async () => [SAVED_SUMMARY],
      get: async () => saved,
    } as unknown as IpcApi['saved'],
    recent: { list: async () => recent } as unknown as IpcApi['recent'],
    query: { find: findSpy, count: async () => ({ count: 0 }) },
  });

  const utils = render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { ...utils, findSpy, updateSpy };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// W13-2 — the §8 shim. A saved find payload written before `queryRaw`
// existed must still hydrate to its original filter (not `{}`) when the user
// clicks "Run here", with its sort/limit/projection intact. This drives the
// real UI path — SavedTab's "Run here" click through BuilderPane's actual
// hydrate call site — not a hand-constructed shortcut.
describe(' legacy saved-find payload hydrates through the shim', () => {
  it('a pre-queryRaw saved find compiles its filter, not {}, on Run here', async () => {
    mountWith(makeState());

    const runHere = await screen.findByRole('button', { name: /in this tab$/ });
    fireEvent.click(runHere);

    const textarea = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(JSON.parse(textarea.value)).toEqual({ status: { $eq: 'active' } });
    });
    // The dangerous regression: a broken shim leaves this as '{}', which
    // silently drops the user's filter instead of erroring.
    expect(textarea.value).not.toBe('{}');
  });

  it('sort, limit, and projection survive alongside the compiled filter', async () => {
    // The advanced sort/projection/limit grid in QueryBar only opens itself
    // on mount (`useState(hasAdvanced)`), before the hydrate patch lands —
    // asserting on those inputs would test QueryBar's disclosure behavior,
    // not the shim, and where they're edited is about to move anyway.
    // Assert on the actual find request "Run here" fires instead: that's the
    // real output of the hydrated builder, not a hand-constructed stand-in.
    const { findSpy } = mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    const call = findSpy.mock.calls[0]?.[0];
    expect(call?.sort).toBe('{"age":1}');
    expect(call?.limit).toBe(10);
    expect(JSON.parse(call?.projection ?? '{}')).toEqual({ _id: 1, name: 1 });
  });
});

// the same hydrate call site, the other direction. `projectionRaw` is
// persisted by SaveModal and round-trips through SQLite (the wire schema is
// `z.record`), but `hydrateFindPayload` rebuilt the builder from
// sort/limit/projection only. Save `{_id: 0}`, Run here, get every field —
// the §11 fail-open reached from a saved query. `LegacyBuilderState` has no
// `projectionRaw`, so only a test can catch the drop.
describe(' a saved raw projection survives Run here', () => {
  it('sends the saved `projectionRaw` verbatim, not the empty inclusion list', async () => {
    const { findSpy } = mountWith(makeState(), RAW_PROJECTION_SAVED);

    fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.projection).toBe('{"_id":0}');
  });

  it('a saved query with no raw projection clears one already on the tab', async () => {
    // `onPatch` replaces the whole builder, so loading the legacy payload
    // (which has none) must not leave the tab's own raw projection behind
    // for the compiler to prefer over the loaded inclusion list.
    const { findSpy } = mountWith(
      makeState({
        builder: { projection: [], projectionRaw: '{"secret":1}', sort: '', limit: '' },
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    const sent = findSpy.mock.calls[0]?.[0]?.projection;
    expect(sent).not.toBe('{"secret":1}');
    expect(JSON.parse(sent ?? '{}')).toEqual({ _id: 1, name: 1 });
  });
});

// W14 §9 — the find options persist with a saved query and a Recent row, but
// the hydrate call site rebuilt the builder field by field and dropped them.
// A collation changes which documents match, so the rerun was not the query.
describe('saved find options survive Run here', () => {
  const OPTIONS_SAVED = {
    ...SAVED_SUMMARY,
    createdAt: now,
    payload: {
      kind: 'find',
      builder: {
        projection: [],
        sort: '',
        limit: '',
        collation: '{"locale":"en","strength":2}',
        hint: '_id_',
        maxTimeMS: '500',
        readPreference: 'nearest',
      },
      queryRaw: '{"name":"a"}',
    },
  } as unknown as SavedQuery;

  it('sends the saved collation, hint, maxTimeMS and read preference', async () => {
    const { findSpy } = mountWith(makeState(), OPTIONS_SAVED);

    fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]).toMatchObject({
      filter: '{"name":"a"}',
      collation: '{"locale":"en","strength":2}',
      hint: '_id_',
      maxTimeMS: 500,
      readPreference: 'nearest',
    });
  });

  it('a saved query with no options clears the ones already on the tab', async () => {
    const { findSpy } = mountWith(
      makeState({
        builder: { projection: [], sort: '', limit: '', collation: '{"locale":"fr"}', hint: 'x_1' },
      }),
      RAW_PROJECTION_SAVED,
    );

    fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    const call = findSpy.mock.calls[0]?.[0];
    expect(call?.collation).toBeUndefined();
    expect(call?.hint).toBeUndefined();
  });

  // A row written before the builder carried options never had any: keeping
  // the tab's would rerun the saved filter under a collation it never had.
  it('a legacy row with no builder at all clears the options on the tab too', async () => {
    const NO_BUILDER_SAVED = {
      ...SAVED_SUMMARY,
      createdAt: now,
      payload: { kind: 'find', queryRaw: '{"name":"a"}' },
    } as unknown as SavedQuery;
    const { findSpy } = mountWith(
      makeState({
        builder: {
          projection: [],
          sort: '',
          limit: '',
          collation: '{"locale":"fr"}',
          hint: 'x_1',
          maxTimeMS: '500',
          readPreference: 'nearest',
        },
      }),
      NO_BUILDER_SAVED,
    );

    fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    const call = findSpy.mock.calls[0]?.[0];
    expect(call?.filter).toBe('{"name":"a"}');
    expect(call?.collation).toBeUndefined();
    expect(call?.hint).toBeUndefined();
    expect(call?.maxTimeMS).toBeUndefined();
    expect(call?.readPreference).toBeUndefined();
  });
});

// A Saved or Recent load into a tab whose advanced row already held a sort
// and was collapsed leaves "has advanced values" true → true; only the load
// count BuilderPane bumps tells QueryBar a different query arrived. Driven
// through the real Workspace so dropping the bump from either Run here fails
// here, not only in QueryBar's own harness.
describe('Run here shows the loaded advanced values', () => {
  const RECENT: RecentQuery = {
    id: 'r1',
    connectionId: 'c1',
    dbName: 'mydb',
    collection: 'users',
    kind: 'find',
    payload: { kind: 'find', builder: { projection: [], sort: '{"age":1}', limit: '' }, queryRaw: '{"a":1}' },
    ranAt: now,
    durationMs: 3,
    resultCount: 1,
  };

  for (const list of ['Saved', 'Recent'] as const) {
    it(`${list}: opens a row the user had collapsed over a sort of its own`, async () => {
      mountWith(
        makeState({ activeBuilderTab: list, builder: { projection: [], sort: '{"name":1}', limit: '' } }),
        LEGACY_SAVED,
        [RECENT],
      );

      await screen.findByTestId('query-bar-sort');
      fireEvent.click(document.querySelector('[aria-controls="query-bar-advanced"]')!);
      expect(document.getElementById('query-bar-advanced')).toBeNull();

      fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

      await waitFor(() => expect(document.getElementById('query-bar-advanced')).not.toBeNull());
      expect((screen.getByTestId('query-bar-sort') as HTMLInputElement).value).toBe('{"age":1}');
    });
  }
});
