import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { notifications } from '@mantine/notifications';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

// Every gate in front of `findCode` exists so it never throws; making it throw
// on demand is the only way to reach the copy handler's last-resort catch.
const findCodeFault = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('../../src/utils/driverCode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/driverCode')>();
  return {
    ...actual,
    findCode: (...args: Parameters<typeof actual.findCode>) => {
      if (findCodeFault.error) throw findCodeFault.error;
      return actual.findCode(...args);
    },
  };
});

/**
 * W15 Tier 1 — every statement the composition surface makes about the
 * query it runs is either true or absent.
 *
 * §3.1 sort is gated client-side like the filter, §4.1 a coerced limit says
 * what it actually runs as, §1.1 Copy code reproduces the query as run, §7.1
 * "Set default" is gone.
 */

const now = '2026-08-06T12:00:00.000Z';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    // Seeded so the auto-run-on-open effect doesn't fire a background
    // find and desynchronize the call-count assertions below.
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

function mountWith(state: CollectionTabState, tabsOverrides: Partial<IpcApi['tabs']> = {}) {
  const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
    documents: [],
    durationMs: 3,
    hasMore: false,
  }));
  const prefsSetSpy = vi.fn(async (_key: string, value: unknown) => value);

  installAtelierMock({
    tabs: {
      list: async () => [makeCollectionTab(state)],
      setActive: async (id) => ({ id }),
      update: (async () => makeCollectionTab(state)) as unknown as IpcApi['tabs']['update'],
      ...tabsOverrides,
    },
    conn: { list: async () => [CONNECTION] },
    prefs: {
      get: async () => null,
      set: prefsSetSpy,
    } as unknown as IpcApi['prefs'],
    query: { find: findSpy, count: async () => ({ count: 0 }) },
  });

  const utils = render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { ...utils, findSpy, prefsSetSpy };
}

// jsdom has no clipboard; Copy code writes to it unconditionally.
let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});

afterEach(() => {
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
  uninstallAtelierMock();
  // Mantine's notification store is module-global and survives unmount, so a
  // toast raised in one test is still in the DOM for the next one — which
  // turns a `findByText` in a later case into "found multiple elements"
  // against a toast that case never raised. Same call the drawer specs make.
  notifications.clean();
  vi.restoreAllMocks();
});

// Copy code is a menu of languages (#23): open it, pick one.
const copyAs = async (label: string) => {
  fireEvent.click(await screen.findByRole('button', { name: 'Copy code' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: label }));
};

const copiedText = (): string => {
  const mock = navigator.clipboard.writeText as unknown as { mock: { calls: string[][] } };
  return mock.mock.calls.at(-1)?.[0] ?? '';
};

// ─── §3.1 ───────────────────────────────────────────────────────────────────

describe('W15 §3.1 — an unparseable sort is refused client-side', () => {
  it('gates Run, renders an inline message, and never calls find', async () => {
    // Typed rather than seeded: the round trip this replaces only happened
    // because nothing looked at the text between keystroke and IPC.
    const { findSpy } = mountWith(makeState({ builder: { projection: [], sort: '{"a":1}', limit: '' } }));

    const runBtn = await screen.findByTestId('query-run-btn');
    expect(runBtn).toHaveProperty('disabled', false);

    fireEvent.change(screen.getByTestId('query-bar-sort'), { target: { value: '{"a":1' } });

    await waitFor(() => {
      expect(screen.getByTestId('query-run-btn')).toHaveProperty('disabled', true);
    });
    expect(screen.getByText(/Can't parse this sort/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('query-run-btn'));
    await new Promise((r) => setTimeout(r, 0));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('the runner refuses too, on the paths with no button to disable', async () => {
    // The button gate is half the filter's treatment; the other half is
    // `useQueryRunner`'s own guard (a comment there names the four paths it
    // exists for: auto-run on tab open, palette `query.run`, post-write
    // re-runs). Without it, a palette run still round-trips to main to come
    // back as the VALIDATION pill §3.1 says must not happen — so drive the
    // palette, not the button.
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: '{"a":1', limit: '' } }),
    );

    await screen.findByTestId('query-run-btn');
    const runCmd = commandRegistry.list().find((c) => c.id === 'query.run');
    expect(runCmd).toBeDefined();

    act(() => {
      void runCmd!.perform({ pathname: '/workspace', connectionId: 'c1' });
    });

    await waitFor(() => {
      expect(screen.getByText(/VALIDATION: Can't parse this sort/)).toBeTruthy();
    });
    expect(findSpy).not.toHaveBeenCalled();
  });

  // the same gate, one step further. `[1,2]` parses, so the gate used
  // to wave it through; the driver then ignores it and returns unsorted rows
  // with no error at all, which is worse than the round trip §3.1 set out to
  // remove — there is nothing to surface.
  it('refuses a sort that parses but is not a document, and says which problem it is', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: '{"a":1}', limit: '' } }),
    );

    const runBtn = await screen.findByTestId('query-run-btn');
    expect(runBtn).toHaveProperty('disabled', false);

    fireEvent.change(screen.getByTestId('query-bar-sort'), { target: { value: '[1,2]' } });

    await waitFor(() => {
      expect(screen.getByTestId('query-run-btn')).toHaveProperty('disabled', true);
    });
    expect(screen.getByText(/must be a document/i)).toBeTruthy();
    // Told the right thing: there is no syntax error to hunt for here.
    expect(screen.queryByText(/Can't parse this sort/)).toBeNull();

    fireEvent.click(screen.getByTestId('query-run-btn'));
    await new Promise((r) => setTimeout(r, 0));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('the palette refuses a non-document sort too, with no button to disable', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: 'null', limit: '' } }),
    );

    await screen.findByTestId('query-run-btn');
    const runCmd = commandRegistry.list().find((c) => c.id === 'query.run');
    expect(runCmd).toBeDefined();

    act(() => {
      void runCmd!.perform({ pathname: '/workspace', connectionId: 'c1' });
    });

    await waitFor(() => {
      expect(screen.getByText(/VALIDATION: A sort must be a document/)).toBeTruthy();
    });
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('a blank sort is not an invalid sort', async () => {
    const { findSpy } = mountWith(makeState({ builder: { projection: [], sort: '{"a":1}', limit: '' } }));

    fireEvent.change(await screen.findByTestId('query-bar-sort'), { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByTestId('query-run-btn')).toHaveProperty('disabled', false);
    });
    expect(screen.queryByText(/Can't parse this sort/)).toBeNull();

    fireEvent.click(screen.getByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.sort).toBeUndefined();
  });
});

// ─── §4.1 ───────────────────────────────────────────────────────────────────

describe('W15 §4.1 — a coerced limit says what it actually runs as', () => {
  it('limit 0 warns "no limit", and the request really carries no cap', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: '', limit: '0' } }),
    );

    // The message states the outcome…
    expect(await screen.findByText(/"0" is not a positive number — running with no limit\./))
      .toBeTruthy();

    // …and the outcome is what the runner sends: the full page, uncapped,
    // which is the opposite of what a user typing `0` asked for.
    fireEvent.click(screen.getByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.limit).toBe(50);
    expect(findSpy.mock.calls[0]?.[0]?.skip).toBe(0);
  });

  it('trailing junk warns with the number that survives, not "no limit"', async () => {
    // `parseInt('5xyz', 10)` is 5 — this case runs *with* a limit, so it must
    // not borrow the "no limit" wording.
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: '', limit: '5xyz' } }),
    );

    expect(await screen.findByText(/Running with limit 5 — the rest of "5xyz" is ignored\./))
      .toBeTruthy();

    fireEvent.click(screen.getByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.limit).toBe(5);
  });

  it('an honest limit says nothing', async () => {
    mountWith(makeState({ builder: { projection: [], sort: '', limit: '25' } }));

    await screen.findByTestId('query-bar-limit');
    expect(screen.queryByText(/no limit|is ignored/)).toBeNull();
  });
});

// ─── §1.1 ───────────────────────────────────────────────────────────────────

describe('W15 §4.2 — the limit says what it caps and what else stops a query', () => {
  it('describes the limit as a total across pages, with the time and size caps', async () => {
    mountWith(makeState({ builder: { projection: [], sort: '', limit: '10' } }));

    const input = await screen.findByTestId('query-bar-limit');
    const helpId = input.getAttribute('aria-describedby')?.split(' ') ?? [];
    const help = helpId.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');

    expect(help).toContain('all pages');
    expect(help).toContain('30 s');
    expect(help).toContain('50 MB');
  });
});

describe('W15 §1.1 — Copy code reproduces the query as run', () => {
  // NBSP padding passes the Run gate, which trims; `findCode` parses the text
  // it is given, so it must be given the trimmed filter `find` sends.
  it('copies and runs a filter padded with Unicode spaces as its trimmed text', async () => {
    const { findSpy } = mountWith(makeState({ queryRaw: '\u00a0{"status":"active"}\u00a0' }));

    await copyAs('mongosh');
    expect(copiedText()).toBe('db.getCollection("users").find({"status":"active"}).limit(50)');

    fireEvent.click(screen.getByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.filter).toBe('{"status":"active"}');
  });

  it('emits the projection, sort, skip and limit useQueryRunner would send', async () => {
    // userLimit 120, pageSize 50, page 2 → skip 100, limit 20.
    const { findSpy } = mountWith(
      makeState({
        queryRaw: '{"status":"active"}',
        builder: { projection: ['name'], sort: '{"createdAt":-1}', limit: '120' },
        page: 2,
      }),
    );

    await copyAs('mongosh');

    expect(copiedText()).toBe(
      'db.getCollection("users").find({"status":"active"}, {"_id":1,"name":1})' +
        '.sort({"createdAt":-1}).skip(100).limit(20)',
    );

    // The same values, from the other end of the app: the copied command and
    // the issued find are the same query or one of them is lying.
    fireEvent.click(screen.getByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    const sent = findSpy.mock.calls[0]?.[0];
    expect(sent?.filter).toBe('{"status":"active"}');
    expect(sent?.projection).toBe('{"_id":1,"name":1}');
    expect(sent?.sort).toBe('{"createdAt":-1}');
    expect(sent?.skip).toBe(100);
    expect(sent?.limit).toBe(20);
  });

  // this case used to assert the copied text *contained* the words
  // "past the limit", pinning an output of the form
  // `db.users.find({}).skip(50)  // this page is past the limit`. That is an
  // executable expression followed by a comment: pasting it ran an unbounded
  // cursor while the app showed zero rows. A later revision added the branch to avoid
  // `.limit(0)` — which the driver reads as "no limit" — and reached the same
  // full-collection scan by another route.
  //
  // The old assertion is deleted rather than adjusted, because it encoded the
  // defect. What replaces it is stricter, not weaker: nothing is copied at all.
  it('refuses to copy when the page is past the limit', async () => {
    // userLimit 10, pageSize 50, page 1 → past the cap. The runner
    // short-circuits to an empty result, and no `find` reproduces that.
    mountWith(
      makeState({ builder: { projection: [], sort: '', limit: '10' }, page: 1 }),
    );

    await copyAs('mongosh');

    const writeText = navigator.clipboard.writeText as unknown as {
      mock: { calls: string[][] };
    };
    expect(writeText.mock.calls).toHaveLength(0);
    expect(await screen.findByText(/Nothing copied — this page is past the limit/)).toBeTruthy();
  });

  it('an ObjectId filter copies as code that keeps the ObjectId (#23)', async () => {
    // Canonical EJSON pasted raw into mongosh reads `$oid` as an unknown
    // query operator, so the sentinel goes through EJSON.parse instead.
    const oid = '{"$oid":"64b7f0c2a1b2c3d4e5f60718"}';
    mountWith(makeState({ queryRaw: `{"_id":${oid}}` }));

    await copyAs('mongosh');
    expect(copiedText()).toBe(
      `db.getCollection("users").find({"_id":EJSON.parse(${JSON.stringify(oid)}, { relaxed: false })}).limit(50)`,
    );

    await copyAs('Python');
    expect(copiedText()).toBe(
      ['from bson import json_util', '', `query = {"_id":json_util.loads(${JSON.stringify(oid)})}`, 'cursor = db["users"].find(query, limit=50)'].join('\n'),
    );
  });

  // W14 §9 — a collation changes which documents match, so the copied find
  // carries it (and the hint); maxTimeMS and the read preference do not
  // change the result and are left out.
  it('carries the collation and hint, not maxTimeMS or the read preference', async () => {
    mountWith(
      makeState({
        builder: {
          projection: [],
          sort: '',
          limit: '',
          collation: '{"locale":"en","strength":2}',
          hint: '_id_',
          maxTimeMS: '500',
          readPreference: 'nearest',
        },
      }),
    );

    await copyAs('mongosh');
    expect(copiedText()).toBe(
      'db.getCollection("users").find({}).collation({"locale":"en","strength":2}).hint("_id_").limit(50)',
    );
  });

  it('the page before the cap still copies, with its real limit', async () => {
    // The guard must be the past-the-cap case only, not "any page > 0".
    // userLimit 60, pageSize 50, page 1 → skip 50, limit 10.
    mountWith(
      makeState({ builder: { projection: [], sort: '', limit: '60' }, page: 1 }),
    );

    await copyAs('mongosh');

    expect(copiedText()).toContain('.skip(50)');
    expect(copiedText()).toContain('.limit(10)');
  });
});

/**
 * W15 §1.1 — and the corollary of "reproduces the query as run": when
 * the query will not run, there is nothing to reproduce.
 *
 * Copy code emitted whatever was in composition state without asking whether
 * it was runnable, so an unparseable sort or raw projection went to the
 * clipboard as broken text — from a button the user has been given every
 * reason to trust, since a fix made it match the issued find exactly.
 *
 * Every case asserts **`writeText` was not called**, not merely that an error
 * appeared. "An error fired" passes just as happily while broken text still
 * lands on the clipboard, which is the whole defect.
 */
describe('W15 §1.1 — Copy code refuses a query that will not run', () => {
  const writeTextMock = () =>
    navigator.clipboard.writeText as unknown as { mock: { calls: string[][] } };

  const clickCopy = () => copyAs('mongosh');

  it('an unparseable sort is refused, and nothing reaches the clipboard', async () => {
    mountWith(makeState({ builder: { projection: [], sort: '{"a":1', limit: '' } }));

    await clickCopy();

    expect(writeTextMock().mock.calls).toHaveLength(0);
    expect(await screen.findByText(/Nothing copied/)).toBeTruthy();
  });

  it('an unparseable raw projection is refused too — the half raw projections opened', async () => {
    mountWith(
      makeState({
        builder: { projection: [], sort: '', limit: '', projectionRaw: '{"_id": 0' },
      }),
    );

    await clickCopy();

    expect(writeTextMock().mock.calls).toHaveLength(0);
    expect(await screen.findByText(/Nothing copied/)).toBeTruthy();
  });

  it('an unparseable filter is refused — the clause the button never checked', async () => {
    mountWith(makeState({ queryRaw: '{"status":' }));

    await clickCopy();

    expect(writeTextMock().mock.calls).toHaveLength(0);
    expect(await screen.findByText(/Nothing copied/)).toBeTruthy();
  });

  it('a sort that parses but is not a document is refused', async () => {
    // `[1,2]` satisfies `isValidEjson`. The driver would ignore it and run
    // unsorted, so the copied command would silently differ from the query —
    // the same fail-open `findProblem` inherits from `sortProblem`.
    mountWith(makeState({ builder: { projection: [], sort: '[1,2]', limit: '' } }));

    await clickCopy();

    expect(writeTextMock().mock.calls).toHaveLength(0);
  });

  it('names the clause rather than blaming the clipboard', async () => {
    // The clipboard is working; the query is not. "Could not copy to the
    // clipboard" — `copyToClipboard`'s own failure message — would send the
    // user to check browser permissions instead of their sort.
    mountWith(makeState({ builder: { projection: [], sort: '{"a":1', limit: '' } }));

    await clickCopy();

    // Anchored on the toast's full sentence: the query bar's own inline
    // notice already says "Can't parse this sort" a few rows up, so matching
    // the clause alone would pass without the toast existing at all.
    expect(await screen.findByText(/Nothing copied — Can't parse this sort/)).toBeTruthy();
    expect(screen.queryByText(/Could not copy to the clipboard/)).toBeNull();
  });

  it('a quoted hint opening with a brace copies as the index name it quotes', async () => {
    // `"{x"` names the index `{x`, as main runs it; read as a key pattern it
    // used to throw out of the menu click and copy nothing.
    mountWith(makeState({ builder: { projection: [], sort: '', limit: '', hint: '"{x"' } }));

    await clickCopy();

    await waitFor(() => expect(writeTextMock().mock.calls).toHaveLength(1));
    expect(copiedText()).toContain('.hint("{x")');
  });

  it('a snippet the generator cannot write says why, and copies nothing', async () => {
    findCodeFault.error = new Error('findCode: cannot write this clause');
    try {
      mountWith(makeState({ queryRaw: '{"status":"active"}' }));

      await clickCopy();

      expect(await screen.findByText('Nothing copied — findCode: cannot write this clause')).toBeTruthy();
      expect(writeTextMock().mock.calls).toHaveLength(0);
    } finally {
      findCodeFault.error = undefined;
    }
  });

  it('still copies a runnable query — the guard is not a blanket refusal', async () => {
    mountWith(
      makeState({
        queryRaw: '{"status":"active"}',
        builder: { projection: [], sort: '{"createdAt":-1}', limit: '25' },
      }),
    );

    await clickCopy();

    expect(writeTextMock().mock.calls).toHaveLength(1);
    expect(copiedText()).toContain('.sort({"createdAt":-1})');
  });
});

// ─── §7.1 ───────────────────────────────────────────────────────────────────

describe('W15 §7.1 — "Set default" is gone', () => {
  it('the control does not render and nothing writes a query.default preference', async () => {
    const { prefsSetSpy } = mountWith(makeState());

    // Anchored on a sibling of the deleted button so an unrendered toolbar
    // can't pass this vacuously.
    await screen.findByRole('button', { name: 'History' });
    expect(screen.queryByRole('button', { name: 'Set default' })).toBeNull();
    expect(
      prefsSetSpy.mock.calls.filter((c) => String(c[0]).startsWith('query.default.')),
    ).toEqual([]);
  });
});

/**
 * #156 — "Open as pipeline" hands the builder's query to the Aggregation view
 * as stages, through the same gate as Run and Copy code.
 */
describe('Open as pipeline', () => {
  it('opens the collection with the query as stages, dirty and unselected', async () => {
    const state = makeState({
      queryRaw: '{"_id":{"$oid":"64b7f0c2a1b2c3d4e5f60718"}}',
      builder: { projection: [], sort: '{"age":-1}', limit: '120' },
      page: 2,
    });
    const openSpy = vi.fn<IpcApi['tabs']['openAggregation']>(async () => makeCollectionTab(state) as never);
    mountWith(state, { openAggregation: openSpy });

    fireEvent.click(await screen.findByRole('button', { name: 'Open as pipeline' }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'mydb',
      collection: 'users',
      initialState: {
        stages: [
          { id: 1, op: '$match', body: '{"_id":{"$oid":"64b7f0c2a1b2c3d4e5f60718"}}', enabled: true },
          { id: 2, op: '$sort', body: '{"age":-1}', enabled: true },
          { id: 3, op: '$limit', body: '120', enabled: true },
        ],
        activeStageId: null,
        dirty: true,
      },
    });
  });

  it('opens nothing for a query that will not run, and says why', async () => {
    const openSpy = vi.fn<IpcApi['tabs']['openAggregation']>();
    mountWith(makeState({ queryRaw: '{"status":' }), { openAggregation: openSpy });

    fireEvent.click(await screen.findByRole('button', { name: 'Open as pipeline' }));

    expect(await screen.findByText(/Nothing opened — Can't parse this filter/)).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
