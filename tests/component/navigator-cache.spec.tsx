import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../helpers/render';
import { DbCollectionNavigator } from '../../src/pages/Workspace/DbCollectionNavigator';
import {
  connectionFixture,
  installAtelierMock,
  uninstallAtelierMock,
} from '../helpers/atelierMock';
import type { CollectionInfo } from '../../shared/ipc';
import type { ConnectionRuntime } from '@shared/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DB_NAME = 'shop';
const DB_ROWS = [{ name: DB_NAME, sizeOnDisk: 1, empty: false }];

const DB_A = 'shop';
const DB_B = 'archive';
const DB_ROWS_MULTI = [
  { name: DB_A, sizeOnDisk: 1, empty: false },
  { name: DB_B, sizeOnDisk: 1, empty: false },
];

const makeColls = (...names: string[]): CollectionInfo[] =>
  names.map((n) => ({
    name: n,
    type: 'collection' as const,
    documentCount: 0,
    sizeBytes: 0,
    indexCount: 0,
    capped: false,
  }));

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Mount in 'connected' state with activeDbName=null so no auto-expand fires
 * against the tested DB. The status IIFE will resolve quickly so isConnected
 * flips to true before the first expand completes.
 */
function mountConnected(listCollections: (args: { connectionId: string; dbName: string }) => Promise<CollectionInfo[]>) {
  installAtelierMock({
    mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
    meta: {
      listDatabases: async () => DB_ROWS,
      listCollections: listCollections as never,
    },
  });
  return render(
    <DbCollectionNavigator
      connectionsWithTabs={new Set()}
      connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
      focusedConnectionId="c1"
      activeDbName={null}
      activeCollection={null}
      onOpenCollection={vi.fn()}
      onOpenAggregation={vi.fn()}
    />,
  );
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// ── AC#4: fresh-load skeleton ─────────────────────────────────────────────────

describe('DbCollectionNavigator — AC#4 fresh-load skeleton', () => {
  it('shows no coll rows while first load is in-flight; populates after resolve', async () => {
    const deferred = makeDeferred<CollectionInfo[]>();
    // No status override — starts disconnected, which is fine; first-load works
    // via the `!cache.colls[db]` branch regardless of isConnected.
    installAtelierMock({
      meta: {
        listDatabases: async () => DB_ROWS,
        listCollections: () => deferred.promise,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    await screen.findByTestId(`nav-db-${DB_NAME}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });

    // No collection rows while first load is in-flight (skeleton divs present but
    // have no data-testid).
    expect(screen.queryByTestId(`nav-coll-${DB_NAME}-orders`)).toBeNull();

    // Resolve → collections appear, no more skeleton.
    await act(async () => {
      deferred.resolve(makeColls('orders'));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);
  });
});

// ── AC#1 / AC#2 / AC#3: cached re-expand + background refresh ────────────────

describe('DbCollectionNavigator — cached re-expand + background refresh', () => {
  it('AC#1: re-expanding a cached DB renders collection rows immediately (no skeleton flash)', async () => {
    const listCollections = vi.fn(async () => makeColls('orders'));
    mountConnected(listCollections);

    await screen.findByTestId(`nav-db-${DB_NAME}`);

    // First expand — populates cache.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);

    // Collapse.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });

    // Re-expand — rows must be present immediately (cache hit, no skeleton flash).
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    // Synchronously visible after act() completes.
    expect(screen.queryByTestId(`nav-coll-${DB_NAME}-orders`)).toBeTruthy();
  });

  it('AC#2: background refresh fires on re-expand (listCollections called twice)', async () => {
    const listCollections = vi.fn(async () => makeColls('orders'));
    mountConnected(listCollections);

    await screen.findByTestId(`nav-db-${DB_NAME}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    }); // collapse
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    }); // re-expand

    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));
  });

  it('AC#2 changed list: after background refresh resolves the updated list replaces the old one', async () => {
    let call = 0;
    const listCollections = vi.fn(async () => {
      call += 1;
      return call === 1 ? makeColls('alpha', 'bravo') : makeColls('alpha', 'charlie');
    });
    mountConnected(listCollections);

    await screen.findByTestId(`nav-db-${DB_NAME}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-alpha`);
    expect(screen.queryByTestId(`nav-coll-${DB_NAME}-bravo`)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    }); // collapse
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    }); // re-expand

    // After second call resolves, charlie appears and bravo disappears.
    await waitFor(() => {
      expect(screen.queryByTestId(`nav-coll-${DB_NAME}-charlie`)).toBeTruthy();
      expect(screen.queryByTestId(`nav-coll-${DB_NAME}-bravo`)).toBeNull();
    });
  });

  it('AC#3: DB-row spinner visible during background refresh; cached rows remain; spinner gone after resolve', async () => {
    const deferred = makeDeferred<CollectionInfo[]>();
    let call = 0;
    const listCollections = vi.fn(async () => {
      call += 1;
      if (call === 1) return makeColls('orders');
      return deferred.promise;
    });
    mountConnected(listCollections);

    await screen.findByTestId(`nav-db-${DB_NAME}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    }); // collapse
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    }); // re-expand

    // Spinner must be present while background refresh is in-flight.
    await waitFor(() => {
      expect(
        screen.queryByTestId(`nav-db-spinner-${DB_NAME}`),
      ).toBeTruthy();
    });
    // Cached rows still present during refresh.
    expect(screen.queryByTestId(`nav-coll-${DB_NAME}-orders`)).toBeTruthy();

    // Resolve → spinner gone.
    await act(async () => {
      deferred.resolve(makeColls('orders'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`nav-db-spinner-${DB_NAME}`)).toBeNull();
    });
  });
});

// ── refreshDb explicit background refresh ─────────────────────────────────────

describe('DbCollectionNavigator — refreshDb (explicit DB-row refresh)', () => {
  it('refreshes without skeleton flash, shows spinner, re-issues listCollections', async () => {
    const deferred = makeDeferred<CollectionInfo[]>();
    let call = 0;
    const listCollections = vi.fn(async () => {
      call += 1;
      if (call === 1) return makeColls('orders');
      return deferred.promise;
    });
    mountConnected(listCollections);

    await screen.findByTestId(`nav-db-${DB_NAME}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);

    // Trigger refresh via the hover-bar "Refresh collections" button.
    fireEvent.mouseEnter(screen.getByTestId(`nav-db-${DB_NAME}`));
    const refreshBtn = screen.getByRole('button', { name: 'Refresh collections' });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    // Cached collection rows must stay visible (no skeleton flash).
    expect(screen.queryByTestId(`nav-coll-${DB_NAME}-orders`)).toBeTruthy();
    // Spinner must appear on the DB row.
    await waitFor(() => {
      expect(screen.queryByTestId(`nav-db-spinner-${DB_NAME}`)).toBeTruthy();
    });
    expect(listCollections).toHaveBeenCalledTimes(2);

    // Resolve → spinner disappears.
    await act(async () => {
      deferred.resolve(makeColls('orders'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`nav-db-spinner-${DB_NAME}`)).toBeNull();
    });
  });

  it('dedup: a second refresh while the first is in-flight does not issue a third call', async () => {
    const deferred = makeDeferred<CollectionInfo[]>();
    let call = 0;
    const listCollections = vi.fn(async () => {
      call += 1;
      if (call === 1) return makeColls('orders');
      return deferred.promise;
    });
    mountConnected(listCollections);

    await screen.findByTestId(`nav-db-${DB_NAME}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);

    // First refresh — hangs.
    fireEvent.mouseEnter(screen.getByTestId(`nav-db-${DB_NAME}`));
    const refreshBtn = screen.getByRole('button', { name: 'Refresh collections' });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));

    // Second refresh while first is in-flight — dedup gate must block it.
    await act(async () => {
      fireEvent.click(refreshBtn);
    });
    // Still only 2 calls.
    expect(listCollections).toHaveBeenCalledTimes(2);

    // Clean up the hanging promise.
    await act(async () => {
      deferred.resolve(makeColls('orders'));
    });
  });
});

// ── AC#5: reconnect refetch ───────────────────────────────────────────────────

describe('DbCollectionNavigator — AC#5 reconnect refetch', () => {
  it('refetches all currently-expanded DBs after disconnect → connecting → connected', async () => {
    let capturedCb: ((r: ConnectionRuntime) => void) | null = null;

    const listCollections = vi.fn(async () => makeColls('orders'));
    installAtelierMock({
      mongo: {
        status: async (id: string) => ({ id, status: 'connected' as const }),
        onStatus: (cb: (r: ConnectionRuntime) => void) => {
          capturedCb = cb;
          return () => {
            capturedCb = null;
          };
        },
      },
      meta: {
        listDatabases: async () => DB_ROWS,
        listCollections: listCollections as never,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    // Wait for onStatus callback to be registered.
    await waitFor(() => expect(capturedCb).not.toBeNull());
    await screen.findByTestId(`nav-db-${DB_NAME}`);

    // Expand DB → listCollections ×1, rows present.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(1));

    // Disconnect → rows still present, no refetch.
    act(() => {
      capturedCb!({ id: 'c1', status: 'disconnected' });
    });
    expect(screen.queryByTestId(`nav-coll-${DB_NAME}-orders`)).toBeTruthy();
    expect(listCollections).toHaveBeenCalledTimes(1);

    // Connecting → still ×1.
    act(() => {
      capturedCb!({ id: 'c1', status: 'connecting' });
    });
    expect(listCollections).toHaveBeenCalledTimes(1);

    // Connected → refetch fires for expanded DB.
    act(() => {
      capturedCb!({ id: 'c1', status: 'connected' });
    });
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));
  });

  it('plain first-connect (no preceding disconnect) does NOT trigger a refetch', async () => {
    let capturedCb: ((r: ConnectionRuntime) => void) | null = null;

    const listCollections = vi.fn(async () => makeColls('orders'));
    installAtelierMock({
      mongo: {
        status: async (id: string) => ({ id, status: 'connected' as const }),
        onStatus: (cb: (r: ConnectionRuntime) => void) => {
          capturedCb = cb;
          return () => {
            capturedCb = null;
          };
        },
      },
      meta: {
        listDatabases: async () => DB_ROWS,
        listCollections: listCollections as never,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedCb).not.toBeNull());
    await screen.findByTestId(`nav-db-${DB_NAME}`);

    // Expand DB → listCollections ×1.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_NAME}`));
    });
    await screen.findByTestId(`nav-coll-${DB_NAME}-orders`);
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(1));

    // Fire 'connected' without any preceding disconnect — sawDisconnectRef is false.
    act(() => {
      capturedCb!({ id: 'c1', status: 'connected' });
    });

    // Flush all pending React updates and microtasks.
    await act(async () => {});

    // Must still be exactly 1 call — no spurious refetch.
    expect(listCollections).toHaveBeenCalledTimes(1);
  });
});

// ── AC#6 (N0.6): whole-connection refresh re-populates every previously-
// expanded database, not just the active one ───────────────────────────────

describe('DbCollectionNavigator — AC#6 whole-connection refresh repopulates expanded DBs', () => {
  it('re-fetches every previously-expanded non-active DB; active DB fetched exactly once (no double call)', async () => {
    const listCollections = vi.fn(
      async ({ dbName }: { connectionId: string; dbName: string }) => makeColls(`${dbName}-coll`),
    );
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: {
        listDatabases: async () => DB_ROWS_MULTI,
        listCollections: listCollections as never,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={DB_A}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    // Active DB auto-expands + auto-fetches.
    await screen.findByTestId(`nav-coll-${DB_A}-${DB_A}-coll`);
    // Expand the non-active DB manually so it's cached too.
    await screen.findByTestId(`nav-db-${DB_B}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_B}`));
    });
    await screen.findByTestId(`nav-coll-${DB_B}-${DB_B}-coll`);
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));

    // Whole-connection Refresh.
    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    // Both previously-expanded DBs re-render their collection rows — neither
    // stays blank after the cache clear.
    await waitFor(() => {
      expect(screen.queryByTestId(`nav-coll-${DB_A}-${DB_A}-coll`)).toBeTruthy();
      expect(screen.queryByTestId(`nav-coll-${DB_B}-${DB_B}-coll`)).toBeTruthy();
    });

    // Exactly one extra fetch per DB (2 → 4 total): the active DB is re-fetched
    // once by the active-DB auto-expand effect, not doubled by refreshAll's loop.
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(4));
    const dbNameArgs = listCollections.mock.calls.map(([args]) => args.dbName);
    expect(dbNameArgs.filter((n) => n === DB_A)).toHaveLength(2);
    expect(dbNameArgs.filter((n) => n === DB_B)).toHaveLength(2);
  });

  it('an explicit Refresh retries the active DB whose first collections fetch failed', async () => {
    let call = 0;
    const listCollections = vi.fn(async ({ dbName }: { connectionId: string; dbName: string }) => {
      call += 1;
      if (call === 1) throw new Error('transient');
      return makeColls(`${dbName}-coll`);
    });
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: {
        listDatabases: async () => DB_ROWS_MULTI,
        listCollections: listCollections as never,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={DB_A}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId(`nav-coll-${DB_A}-${DB_A}-coll`)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });
    await screen.findByTestId(`nav-coll-${DB_A}-${DB_A}-coll`);
    expect(listCollections).toHaveBeenCalledTimes(2);
  });

  it('a previously-expanded DB absent from the refreshed list is skipped: no crash, no fetch', async () => {
    let dbCall = 0;
    const listDatabases = vi.fn(async () => {
      dbCall += 1;
      return dbCall === 1 ? DB_ROWS_MULTI : [DB_ROWS_MULTI[0]!];
    });
    const listCollections = vi.fn(
      async ({ dbName }: { connectionId: string; dbName: string }) => makeColls(`${dbName}-coll`),
    );
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: {
        listDatabases: listDatabases as never,
        listCollections: listCollections as never,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={DB_A}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    await screen.findByTestId(`nav-coll-${DB_A}-${DB_A}-coll`);
    await screen.findByTestId(`nav-db-${DB_B}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_B}`));
    });
    await screen.findByTestId(`nav-coll-${DB_B}-${DB_B}-coll`);
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));

    // Refresh: the fresh DB list no longer contains DB_B (dropped externally).
    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    // No crash: DB_A's row (and only DB_A's row) is present after refresh.
    await waitFor(() => {
      expect(screen.queryByTestId(`nav-coll-${DB_A}-${DB_A}-coll`)).toBeTruthy();
    });
    expect(screen.queryByTestId(`nav-db-${DB_B}`)).toBeNull();

    // DB_B must not be re-fetched — its previously-expanded flag is intersected
    // against the fresh list, which no longer contains it.
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(3));
    const dbNameArgs = listCollections.mock.calls.map(([args]) => args.dbName);
    expect(dbNameArgs.filter((n) => n === DB_B)).toHaveLength(1);
  });

  it('rapid double-click on Refresh does not double-fetch a previously-expanded DB', async () => {
    const listCollections = vi.fn(
      async ({ dbName }: { connectionId: string; dbName: string }) => makeColls(`${dbName}-coll`),
    );
    let dbCall = 0;
    const dbDeferred = makeDeferred<typeof DB_ROWS_MULTI>();
    // First call (mount) resolves immediately; the refresh-triggered call
    // stays pending so the second click of the double-click lands while
    // refreshAll's first invocation is still awaiting loadDbs.
    const listDatabases = vi.fn(async () => {
      dbCall += 1;
      if (dbCall === 1) return DB_ROWS_MULTI;
      return dbDeferred.promise;
    });
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: {
        listDatabases: listDatabases as never,
        listCollections: listCollections as never,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={DB_A}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    await screen.findByTestId(`nav-coll-${DB_A}-${DB_A}-coll`);
    await screen.findByTestId(`nav-db-${DB_B}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_B}`));
    });
    await screen.findByTestId(`nav-coll-${DB_B}-${DB_B}-coll`);
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));

    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    // Rapid double-click: fire both before the (deferred) loadDbs call from
    // the first click resolves — the second click's refreshAll invocation
    // must bail out via the in-flight guard instead of re-fanning-out.
    await act(async () => {
      fireEvent.click(refreshBtn);
      fireEvent.click(refreshBtn);
    });

    // Only one loadDbs call happened while in flight: the second click's
    // refreshAll returned early without calling loadDbs at all.
    expect(dbCall).toBe(2);

    await act(async () => {
      dbDeferred.resolve(DB_ROWS_MULTI);
    });

    // Exactly one extra fetch per DB from the single effective refresh (2 → 4
    // total), same as the non-racing case — the double-click did not cause
    // DB_B to be fetched a third time.
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(4));
    const dbNameArgs = listCollections.mock.calls.map(([args]) => args.dbName);
    expect(dbNameArgs.filter((n) => n === DB_B)).toHaveLength(2);
  });

  it('residual window: second click after loadDbs settles but while a fanned-out loadColls is still pending does not double-fetch', async () => {
    const collsDeferred = makeDeferred<CollectionInfo[]>();
    // Keyed by dbName rather than call order: the refresh also triggers an
    // immediate re-fetch of the *active* DB (DB_A, via the dbsPresent-gated
    // auto-expand effect, once the cache clear makes its cached collections
    // disappear) in addition to refreshAll's fan-out for the previously-
    // expanded non-active DB (DB_B). Only DB_B's *second* call — the
    // refresh-triggered one — is deferred; everything else resolves
    // immediately, so the two refresh-triggered fetches race in whichever
    // order and only DB_B's is left pending.
    let dbBCallCount = 0;
    const listCollections = vi.fn(
      async ({ dbName }: { connectionId: string; dbName: string }) => {
        if (dbName === DB_B) {
          dbBCallCount += 1;
          if (dbBCallCount >= 2) return collsDeferred.promise;
        }
        return makeColls(`${dbName}-coll`);
      },
    );
    const listDatabases = vi.fn(async () => DB_ROWS_MULTI);
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: {
        listDatabases: listDatabases as never,
        listCollections: listCollections as never,
      },
    });
    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={DB_A}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    await screen.findByTestId(`nav-coll-${DB_A}-${DB_A}-coll`);
    await screen.findByTestId(`nav-db-${DB_B}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_B}`));
    });
    await screen.findByTestId(`nav-coll-${DB_B}-${DB_B}-coll`);
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));
    expect(listDatabases).toHaveBeenCalledTimes(1);

    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });

    // First click: cache clear -> loadDbs (resolves immediately, not
    // deferred) -> re-fetches active DB_A (resolves immediately) and fans
    // out loadColls for DB_B (excluded-from-active fan-out), whose second
    // listCollections call is deferred and stays pending. By the time both
    // of those refresh-triggered calls have fired, loadDbs has long since
    // settled — this is the residual window.
    await act(async () => {
      fireEvent.click(refreshBtn);
    });
    await waitFor(() => expect(listDatabases).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(4));
    expect(dbBCallCount).toBe(2);

    // Second click, fired only now — after loadDbs has fully settled but
    // while DB_B's refresh-triggered listCollections call is still
    // in-flight. Pre-fix, refreshInFlightRef was cleared as soon as loadDbs
    // resolved, so this click would start its own refreshAll (a second
    // loadDbs plus a second fan-out, re-fetching DB_B a third time). Post-
    // fix, the guard stays held until the fan-out settles, so this click
    // must bail out with no additional calls.
    await act(async () => {
      fireEvent.click(refreshBtn);
    });
    expect(listDatabases).toHaveBeenCalledTimes(2);
    expect(listCollections).toHaveBeenCalledTimes(4);
    expect(dbBCallCount).toBe(2);

    // Let the deferred DB_B fetch resolve and confirm no extra call ever
    // landed for it.
    await act(async () => {
      collsDeferred.resolve(makeColls(`${DB_B}-coll`));
    });
    await waitFor(() => expect(screen.queryByTestId(`nav-coll-${DB_B}-${DB_B}-coll`)).toBeTruthy());
    expect(listCollections).toHaveBeenCalledTimes(4);
    expect(dbBCallCount).toBe(2);
  });

  it('tab switch mid-refresh: reads the current active DB (not a stale closure), so the newly-active DB is not double-fetched and the old one is not left blank', async () => {
    const listCollections = vi.fn(
      async ({ dbName }: { connectionId: string; dbName: string }) => makeColls(`${dbName}-coll`),
    );
    let dbCall = 0;
    const dbDeferred = makeDeferred<typeof DB_ROWS_MULTI>();
    // Mount call resolves immediately; the refresh-triggered loadDbs stays
    // pending so we can switch the Focused Tab while refreshAll is mid-await.
    const listDatabases = vi.fn(async () => {
      dbCall += 1;
      if (dbCall === 1) return DB_ROWS_MULTI;
      return dbDeferred.promise;
    });
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: {
        listDatabases: listDatabases as never,
        listCollections: listCollections as never,
      },
    });
    const { rerender } = render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={DB_A}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    // DB_A active (auto-fetched); expand DB_B so both are cached (2 calls).
    await screen.findByTestId(`nav-coll-${DB_A}-${DB_A}-coll`);
    await screen.findByTestId(`nav-db-${DB_B}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`nav-db-${DB_B}`));
    });
    await screen.findByTestId(`nav-coll-${DB_B}-${DB_B}-coll`);
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(2));

    // Start the refresh; its loadDbs is deferred, so refreshAll is now awaiting.
    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    // The user switches the Focused Tab to DB_B while the refresh is in flight.
    rerender(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={DB_B}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    // Let loadDbs resolve; refreshAll's fan-out and the active-DB effect run.
    await act(async () => {
      dbDeferred.resolve(DB_ROWS_MULTI);
    });

    // Both DBs come back, and each is re-fetched EXACTLY once by the refresh
    // (2 → 4 total): refreshAll's loop, reading the *current* active DB (DB_B)
    // via the ref, re-fetches DB_A (now non-active) while the active-DB effect
    // re-fetches DB_B. A stale closure read of activeDbName (=DB_A) would
    // instead double-fetch DB_B (loop + effect) and leave DB_A blank → 1/3.
    await waitFor(() => {
      expect(screen.queryByTestId(`nav-coll-${DB_A}-${DB_A}-coll`)).toBeTruthy();
      expect(screen.queryByTestId(`nav-coll-${DB_B}-${DB_B}-coll`)).toBeTruthy();
    });
    await waitFor(() => expect(listCollections).toHaveBeenCalledTimes(4));
    const dbNameArgs = listCollections.mock.calls.map(([args]) => args.dbName);
    expect(dbNameArgs.filter((n) => n === DB_A)).toHaveLength(2);
    expect(dbNameArgs.filter((n) => n === DB_B)).toHaveLength(2);
  });

  it('cross-connection: a refresh on connection B is NOT blocked while connection A\'s refresh is still in-flight', async () => {
    // The single navigator instance serves every connection via the
    // connectionId prop. The in-flight guard is keyed per connectionId, so an
    // in-flight refresh on connection A must never suppress an explicit
    // refresh the user triggers on connection B. Pre-fix (a single global
    // boolean) B's refresh saw A's flag and silently no-op'd.
    const dbCalls: Record<string, number> = {};
    const cADbsDeferred = makeDeferred<typeof DB_ROWS>();
    const listDatabases = vi.fn(async ({ connectionId }: { connectionId: string }) => {
      dbCalls[connectionId] = (dbCalls[connectionId] ?? 0) + 1;
      // The refresh-triggered load for connection A hangs, holding A's guard
      // for the whole duration of the cross-connection assertions.
      if (connectionId === 'cA' && dbCalls['cA'] === 2) return cADbsDeferred.promise;
      return DB_ROWS;
    });
    const listCollections = vi.fn(
      async ({ dbName }: { connectionId: string; dbName: string }) => makeColls(`${dbName}-coll`),
    );
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: {
        listDatabases: listDatabases as never,
        listCollections: listCollections as never,
      },
    });
    const { rerender } = render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[
          connectionFixture({ id: 'cA', name: 'Conn A' }),
          connectionFixture({ id: 'cB', name: 'Conn B' }),
        ]}
        focusedConnectionId="cA"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    // Connection A mounts and loads its DB list once.
    await screen.findByTestId(`nav-db-${DB_NAME}`);
    await waitFor(() => expect(dbCalls['cA']).toBe(1));

    // Refresh A → loadDbs('cA') #2 fires and hangs, so A's guard stays held.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });
    await waitFor(() => expect(dbCalls['cA']).toBe(2));

    // Switch the Focused Tab to connection B while A's refresh is still in
    // flight. B mounts and loads its DB list once.
    rerender(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[
          connectionFixture({ id: 'cA', name: 'Conn A' }),
          connectionFixture({ id: 'cB', name: 'Conn B' }),
        ]}
        focusedConnectionId="cB"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );
    await waitFor(() => expect(dbCalls['cB']).toBe(1));

    // Refresh B — must fire loadDbs('cB') despite A's guard still being held.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });
    await waitFor(() => expect(dbCalls['cB']).toBe(2));

    // A's guard was never released (its load is still pending): A saw exactly
    // two loadDbs calls, and B's refresh was independent of it.
    expect(dbCalls['cA']).toBe(2);

    // Clean up the hanging A load so no update fires outside act after teardown.
    await act(async () => {
      cADbsDeferred.resolve(DB_ROWS);
    });
  });
});

// ── bounded retry on an empty listDatabases result ───────────────────────────

describe('DbCollectionNavigator empty-result retry', () => {
  it('a first empty result followed by a populated one recovers, without a second unbounded retry', async () => {
    const listDatabases = vi.fn<() => Promise<typeof DB_ROWS>>();
    listDatabases.mockResolvedValueOnce([]).mockResolvedValueOnce(DB_ROWS);
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: { listDatabases, listCollections: async () => makeColls('orders') },
    });

    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    // The retry recovers the database that a bare "no retry" first fetch
    // would have permanently cached as absent.
    await screen.findByTestId(`nav-db-${DB_NAME}`, {}, { timeout: 2000 });
    // Exactly one retry, not an unbounded poll: the initial call plus one.
    await waitFor(() => expect(listDatabases).toHaveBeenCalledTimes(2));
  });

  it('two consecutive empty results settle on "No databases", without retrying a third time', async () => {
    const listDatabases = vi.fn(async () => []);
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: { listDatabases, listCollections: async () => [] },
    });

    render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    await screen.findByText('No databases.', {}, { timeout: 2000 });
    expect(listDatabases).toHaveBeenCalledTimes(2);

    // Give any spurious further retry a chance to fire before asserting it
    // didn't — a bounded retry must stay bounded even once genuinely empty.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(listDatabases).toHaveBeenCalledTimes(2);
  });

  it('does not issue the retry listDatabases once the navigator unmounted before the empty result arrived', async () => {
    // The first call is held open, so the unmount provably lands before the
    // empty result does and the test never races the retry delay.
    const firstCall = makeDeferred<typeof DB_ROWS>();
    const listDatabases = vi.fn(() => firstCall.promise);
    installAtelierMock({
      mongo: { status: async (id: string) => ({ id, status: 'connected' as const }) },
      meta: { listDatabases, listCollections: async () => [] },
    });

    const { unmount } = render(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[connectionFixture({ id: 'c1', name: 'Test' })]}
        focusedConnectionId="c1"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    await waitFor(() => expect(listDatabases).toHaveBeenCalledTimes(1));
    unmount();
    firstCall.resolve([]);

    // Outlast the retry delay: a gone navigator must not hit the main process again.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(listDatabases).toHaveBeenCalledTimes(1);
  });
});
