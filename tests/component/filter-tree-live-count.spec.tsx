// W15 §14.5 / §1.2 — feedback while composing: a debounced match count under
// the filter tree, and a line saying where sort / limit / skip / projection
// moved. Counts are asserted through `api.query.count` (what was actually
// asked of the main process) and through the status line the user reads.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, renderHook, screen, fireEvent, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { useLiveMatchCount } from '../../src/pages/Workspace/useLiveMatchCount';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import { emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-10-15T12:00:00.000Z';

// A timeout is remembered per collection for the whole run, so a test that
// times one out names its own collection.
function makeTab(
  queryRaw: string,
  collection = 'users',
  filterDraft?: CollectionTabState['filterDraft'],
): WorkspaceTab {
  const state: CollectionTabState = {
    filterDraft,
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw,
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: [], durationMs: 0, ranAt: now },
  };
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'mydb',
    collection,
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

type CountFn = IpcApi['query']['count'];

function mountWith(
  queryRaw: string,
  count: CountFn,
  collection?: string,
  filterDraft?: CollectionTabState['filterDraft'],
) {
  const countSpy = vi.fn<CountFn>(count);
  const tab = makeTab(queryRaw, collection, filterDraft);
  installAtelierMock({
    tabs: {
      list: async () => [tab],
      setActive: async (id) => ({ id }),
      update: (async () => tab) as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    query: {
      find: async () => ({ documents: [], durationMs: 3, hasMore: false }),
      count: countSpy,
    },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return countSpy;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Resolves a count call from outside, so a test controls response order. */
function deferred() {
  let resolve!: (v: { count: number }) => void;
  const promise = new Promise<{ count: number }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('Filter drawer — live match count (W15 §14.5)', () => {
  it('shows the count of the committed filter once typing settles', async () => {
    const count = mountWith('{"a":{"$eq":1}}', async () => ({ count: 1240 }));
    await screen.findByPlaceholderText('field');

    await advance(500);

    const status = await screen.findByText(/match$/);
    expect(status.textContent).toBe(`≈${(1240).toLocaleString()} match`);
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0].filter).toBe('{"a":{"$eq":1}}');
  });

  it('says it is counting before the answer arrives', async () => {
    const d = deferred();
    mountWith('{"a":{"$eq":1}}', () => d.promise);
    await screen.findByPlaceholderText('field');

    await advance(500);

    expect(await screen.findByText('Counting…')).toBeTruthy();
    d.resolve({ count: 3 });
    expect(await screen.findByText('≈3 match')).toBeTruthy();
  });

  it('asks nothing for an empty filter', async () => {
    const count = mountWith('{}', async () => ({ count: 7 }));
    await screen.findByLabelText('Drop a field here to add a condition');

    await advance(2000);

    expect(count).not.toHaveBeenCalled();
    expect(screen.queryByText(/match$/)).toBeNull();
    expect(screen.queryByText('Counting…')).toBeNull();
  });

  it('counts once, for the last value, when edits arrive faster than the debounce', async () => {
    const count = mountWith('{"a":{"$eq":1}}', async () => ({ count: 2 }));
    const value = (await screen.findByDisplayValue('1')) as HTMLInputElement;
    await advance(500);
    count.mockClear();

    for (const v of ['2', '3', '4']) {
      fireEvent.change(value, { target: { value: v } });
      await advance(30);
    }
    await advance(500);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0].filter).toBe('{"a":{"$eq":4}}');
  });

  it('stops asking while an edit is not applied', async () => {
    const count = mountWith('{"qty":{"$gt":5}}', async () => ({ count: 2 }));
    const value = (await screen.findByDisplayValue('5')) as HTMLInputElement;
    await advance(500);
    count.mockClear();

    fireEvent.change(value, { target: { value: 'not-a-number' } });
    await advance(1000);

    expect(screen.getByText(/not applied/)).toBeTruthy();
    expect(count).not.toHaveBeenCalled();
    expect(screen.queryByText(/match$/)).toBeNull();
  });

  it('keeps the newest answer when an older one arrives late', async () => {
    const a = deferred();
    const b = deferred();
    const count = mountWith('{"a":{"$eq":1}}', async () => ({ count: 0 }));
    const value = (await screen.findByDisplayValue('1')) as HTMLInputElement;
    count.mockReset();
    count.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    // The mount-time call has not fired yet (500 ms), so edit first, then let
    // exactly two calls through: one for each settled filter.
    await advance(500);
    fireEvent.change(value, { target: { value: '2' } });
    await advance(500);
    expect(count).toHaveBeenCalledTimes(2);

    b.resolve({ count: 5 });
    await advance(0);
    a.resolve({ count: 9 });
    await advance(0);

    expect(await screen.findByText('≈5 match')).toBeTruthy();
    expect(screen.queryByText('≈9 match')).toBeNull();
  });

  it('says the count is unavailable after a timeout and does not ask again', async () => {
    const count = mountWith('{"a":{"$eq":1}}', async () => {
      // The preload throws the IpcError shape itself.
      throw { code: 'TIMEOUT', message: 'operation exceeded time limit' };
    }, 'timed-out-in-drawer');
    const value = (await screen.findByDisplayValue('1')) as HTMLInputElement;
    await advance(500);

    expect(await screen.findByText('Match count unavailable')).toBeTruthy();
    expect(count).toHaveBeenCalledTimes(1);

    fireEvent.change(value, { target: { value: '2' } });
    await advance(1000);

    expect(count).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Match count unavailable')).toBeTruthy();
  });
});

describe('Filter drawer — what the live count counts (W15 §14.5)', () => {
  it('counts again without a row that is switched off', async () => {
    const count = mountWith('{"$and":[{"a":{"$eq":1}},{"b":{"$eq":2}}]}', async () => ({ count: 1 }));
    await screen.findAllByPlaceholderText('field');
    await advance(500);
    count.mockClear();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include condition b' }));
    await advance(500);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0].filter).toBe('{"a":{"$eq":1}}');
  });

  it('counts again without a group that is switched off', async () => {
    const count = mountWith('{"a":{"$eq":1},"$or":[{"b":{"$eq":2}},{"c":{"$eq":3}}]}', async () => ({ count: 1 }));
    await screen.findAllByPlaceholderText('field');
    await advance(500);
    count.mockClear();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include group 2' }));
    await advance(500);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0].filter).toBe('{"a":{"$eq":1}}');
  });

  it('asks nothing while a seeded draft holds a row that does not print', async () => {
    const text = '{"a":{"$eq":1}}';
    const count = mountWith(text, async () => ({ count: 1 }), undefined, {
      queryRaw: text,
      root: {
        kind: 'group',
        logic: '$and',
        children: [
          { kind: 'cond', field: 'a', op: '$eq', valType: 'number', value: '1' },
          { kind: 'cond', field: 'b', op: '$gt', valType: 'number', value: 'not-a-number' },
        ],
      },
    });
    await screen.findByText(/not applied/);
    await advance(1000);

    expect(count).not.toHaveBeenCalled();
  });

  it('counts through a NOT wrap', async () => {
    const count = mountWith('{"a":{"$eq":1}}', async () => ({ count: 1 }));
    await screen.findByPlaceholderText('field');
    await advance(500);
    count.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Condition options 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Negate (NOT)' }));
    await advance(500);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0].filter).toBe('{"$nor":[{"a":{"$eq":1}}]}');
  });
});

describe('Live match count — a timeout outlives the drawer (W15 §14.5)', () => {
  const TIMEOUT = { code: 'TIMEOUT', message: 'operation exceeded time limit' };

  function countHook(collection: string, queryRaw: string) {
    return renderHook(() =>
      useLiveMatchCount({ connectionId: 'c1', dbName: 'mydb', collection, queryRaw, paused: false }),
    );
  }

  it('a collection that timed out is not asked again when the drawer remounts, while another collection still is', async () => {
    const count = vi.fn<CountFn>(async () => {
      throw TIMEOUT;
    });
    installAtelierMock({ query: { count } });

    const first = countHook('huge', '{"a":1}');
    await advance(500);
    expect(first.result.current).toEqual({ state: 'unavailable' });
    first.unmount();

    // A tab switch or Reset remounts the drawer, with any filter.
    const again = countHook('huge', '{"a":2}');
    await advance(1000);
    expect(again.result.current).toEqual({ state: 'unavailable' });
    expect(count).toHaveBeenCalledTimes(1);

    count.mockImplementation(async () => ({ count: 3 }));
    const other = countHook('small', '{"a":1}');
    await advance(500);
    expect(other.result.current).toEqual({ state: 'ok', count: 3 });
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('a failure that is not an IpcError shows unavailable and is rethrown, not swallowed', async () => {
    const bug = new TypeError('count is not a function');
    installAtelierMock({
      query: {
        count: async () => {
          throw bug;
        },
      },
    });
    // The rethrow surfaces as an unhandled rejection, which is how the
    // renderer reports it; caught here so the run itself stays clean.
    const saved = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const reported: unknown[] = [];
    process.on('unhandledRejection', (reason) => reported.push(reason));
    try {
      const { result } = countHook('buggy', '{"a":1}');
      await advance(500);
      await act(async () => {
        await new Promise((r) => setImmediate(r));
      });
      expect(result.current).toEqual({ state: 'unavailable' });
      expect(reported).toEqual([bug]);
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const l of saved) process.on('unhandledRejection', l);
    }
  });
});

describe('Filter drawer — a count that fails for one filter (W15 §14.5)', () => {
  it('a failure other than a timeout is unavailable for that filter only, and the next edit asks again', async () => {
    const count = mountWith('{"a":{"$eq":1}}', async () => ({ count: 4 }));
    const value = (await screen.findByDisplayValue('1')) as HTMLInputElement;
    await advance(500);
    expect(await screen.findByText('≈4 match')).toBeTruthy();

    count.mockImplementationOnce(async () => {
      throw { code: 'MONGO_ERROR', message: 'Regular expression is invalid' };
    });
    fireEvent.change(value, { target: { value: '2' } });
    await advance(500);
    expect(await screen.findByText('Match count unavailable')).toBeTruthy();

    fireEvent.change(value, { target: { value: '3' } });
    await advance(500);

    expect(await screen.findByText('≈4 match')).toBeTruthy();
    expect(count).toHaveBeenCalledTimes(3);
    expect(count.mock.calls[2]?.[0].filter).toBe('{"a":{"$eq":3}}');
  });

  it('an invalid ObjectId never reaches the count, and the count comes back once it is fixed', async () => {
    const OID = '507f1f77bcf86cd799439011';
    const count = mountWith(`{"o":{"$eq":{"$oid":"${OID}"}}}`, async () => ({ count: 1 }));
    const value = (await screen.findByDisplayValue(OID)) as HTMLInputElement;
    await advance(500);
    expect(await screen.findByText('≈1 match')).toBeTruthy();
    count.mockClear();

    fireEvent.change(value, { target: { value: OID.slice(0, 10) } });
    await advance(1000);
    expect(count).not.toHaveBeenCalled();
    expect(screen.getByText(/not applied/)).toBeTruthy();

    fireEvent.change(value, { target: { value: OID.replace('5', '6') } });
    await advance(500);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0].filter).toBe(`{"o":{"$eq":{"$oid":"${OID.replace('5', '6')}"}}}`);
    expect(await screen.findByText('≈1 match')).toBeTruthy();
  });
});

describe('Filter drawer — pointer to the other query controls (W15 §1.2)', () => {
  it('says where sort, limit, skip and projection are edited', async () => {
    mountWith('{}', async () => ({ count: 0 }));

    const note = await screen.findByText(/sort, limit and skip are set in the query bar/i);
    expect(note.textContent).toMatch(/projection is under fields/i);
  });
});

// W14 §9 — a collation changes which documents match, so the live count
// carries the tab's options to agree with Run, and asks again when they move.
describe('Live match count — find options', () => {
  it('counts with the tab collation, hint and read preference, and recounts when one changes', async () => {
    const count = vi.fn<CountFn>(async () => ({ count: 2 }));
    installAtelierMock({ query: { count } });
    const state = (collation: string): CollectionTabState => ({
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '', collation, hint: ' _id_ ', maxTimeMS: '500', readPreference: 'nearest' },
      queryRaw: '{"name":"a"}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    });
    let collation = '{"locale":"en","strength":2}';
    const hook = renderHook(
      () => useLiveMatchCount({ connectionId: 'c1', dbName: 'mydb', collection: 'opts', queryRaw: '{"name":"a"}', paused: false }),
      {
        wrapper: ({ children }) => (
          <CollectionWorkspaceProvider state={state(collation)} actions={emptyWorkspaceActions()} meta={emptyWorkspaceMeta()}>
            {children}
          </CollectionWorkspaceProvider>
        ),
      },
    );
    await advance(500);
    expect(hook.result.current).toEqual({ state: 'ok', count: 2 });
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]![0]).toEqual({
      connectionId: 'c1',
      dbName: 'mydb',
      collection: 'opts',
      filter: '{"name":"a"}',
      collation: '{"locale":"en","strength":2}',
      hint: '_id_',
      readPreference: 'nearest',
    });

    collation = '{"locale":"fr"}';
    hook.rerender();
    expect(hook.result.current).toEqual({ state: 'counting' });
    await advance(500);
    expect(count).toHaveBeenCalledTimes(2);
    expect(count.mock.calls[1]![0].collation).toBe('{"locale":"fr"}');
  });

  // A half-typed collation would come back as a server refusal, shown as
  // "unavailable" for a filter that is fine: say nothing until it runs.
  it('asks nothing while a find option cannot run, and counts once it can', async () => {
    const count = vi.fn<CountFn>(async () => ({ count: 2 }));
    installAtelierMock({ query: { count } });
    let collation = '{"locale":';
    const hook = renderHook(
      () => useLiveMatchCount({ connectionId: 'c1', dbName: 'mydb', collection: 'half', queryRaw: '{"name":"a"}', paused: false }),
      {
        wrapper: ({ children }) => (
          <CollectionWorkspaceProvider
            state={{
              view: 'Tree',
              builder: { projection: [], sort: '', limit: '', collation },
              queryRaw: '{"name":"a"}',
              page: 0,
              pageSize: 50,
              activeBuilderTab: 'Builder',
            }}
            actions={emptyWorkspaceActions()}
            meta={emptyWorkspaceMeta()}
          >
            {children}
          </CollectionWorkspaceProvider>
        ),
      },
    );
    await advance(500);
    expect(hook.result.current).toEqual({ state: 'idle' });
    expect(count).not.toHaveBeenCalled();

    collation = '{"locale":"en"}';
    hook.rerender();
    await advance(500);
    expect(hook.result.current).toEqual({ state: 'ok', count: 2 });
    expect(count.mock.calls[0]![0].collation).toBe('{"locale":"en"}');
  });
});
