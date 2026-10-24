// the real regression: `App.tsx` mounts `<HintsProvider>` above
// `<Workspace />`, but every other Workspace-level test mounts `<Workspace />`
// bare, so its `useHints()` falls back to the inert `NULL_HINTS` default and
// no hint can ever become visible there. This file adds the provider back so
// `run.execute`'s real trigger — wired in `Workspace.tsx`, not reproducible
// by importing a pure function — gets exercised end to end.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { HintsProvider } from '../../src/hints/HintsProvider';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';
import type { CollectionTab } from '@shared/types';

const now = '2026-06-01T12:00:00.000Z';

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
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
    ...overrides,
  };
}

const connections = [
  {
    id: 'c1',
    name: 'Local',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard' as const,
    readOnly: false,
    status: 'connected' as const,
  },
];

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function mountWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <HintsProvider>
        <Workspace />
      </HintsProvider>
    </MemoryRouter>,
  );
}

describe('Workspace — the run.execute hint fires on an edit past auto-run', () => {
  it('stays hidden right after auto-run, then appears on the Run button once the filter is edited without running', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [{ _id: { $oid: 'abc123abc123abc123abc123' }, name: 'Alice' }],
      durationMs: 5,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 1 }) },
    });

    const { container } = mountWorkspace();

    // Let the collection auto-run — the same landing `workspace-auto-run.spec.tsx`
    // covers, and the case a `!lastRun` trigger would have kept firing on.
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.textContent).toContain('Alice'));

    // Its own query just ran; nothing to teach yet.
    expect(screen.queryByRole('dialog', { name: /press run/i })).toBeNull();

    // Edit the Filter Bar to a different query, without running it.
    const filterInput = screen.getByTestId('query-bar-input');
    fireEvent.change(filterInput, { target: { value: '{"name":"Bob"}' } });
    fireEvent.blur(filterInput);

    const popover = await waitFor(
      () => screen.getByRole('dialog', { name: /press run/i }),
      { timeout: 3000 },
    );
    expect(popover).toBeTruthy();
    // Anchored on the real Run button — always mounted, unlike ResultBar's
    // pre-run affordance, which stops rendering once lastRun is set.
    expect(document.querySelector('[data-hint-anchor="run.execute"]')).toBe(
      screen.getByTestId('query-run-btn'),
    );
    // The edit was never run.
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  // W14 §9 — the runner records its run key with the find options; the key
  // the hint looks up has to carry them too, or a tab with a collation never
  // reads as run and the hint asks for a Run that already happened.
  it('stays hidden after the run of a query that carries find options', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [{ _id: { $oid: 'abc123abc123abc123abc123' }, name: 'Alice' }],
      durationMs: 5,
      hasMore: false,
    }));
    const collated = makeCollectionTab();
    collated.state.builder = { ...collated.state.builder, collation: '{"locale":"en","strength":2}', maxTimeMS: '500' };

    installAtelierMock({
      tabs: {
        list: async () => [collated],
        setActive: async (id) => ({ id }),
        update: async () => collated,
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 1 }) },
    });

    const { container } = mountWorkspace();
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]![0].collation).toBe('{"locale":"en","strength":2}');
    await waitFor(() => expect(container.textContent).toContain('Alice'));

    // Long enough to clear the hint's 1.5s post-mount settle window.
    await new Promise((r) => setTimeout(r, 1800));
    expect(screen.queryByRole('dialog', { name: /press run/i })).toBeNull();
  });

  it('stays hidden while the filter is unparseable, even though it has never been run', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [{ _id: { $oid: 'abc123abc123abc123abc123' }, name: 'Alice' }],
      durationMs: 5,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 1 }) },
    });

    const { container } = mountWorkspace();
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.textContent).toContain('Alice'));

    // Not a repairable Shell Syntax typo (`query-error-feedback.spec.tsx`
    // covers that string specifically) — the transform leaves it refused,
    // so Run stays disabled on it.
    const filterInput = screen.getByTestId('query-bar-input');
    fireEvent.change(filterInput, { target: { value: '{status: active}' } });
    fireEvent.blur(filterInput);

    const runBtn = await screen.findByTestId('query-run-btn');
    await waitFor(() => expect((runBtn as HTMLButtonElement).disabled).toBe(true));

    // Long enough to clear the hint's 1.5s post-mount settle window.
    await new Promise((r) => setTimeout(r, 1800));
    expect(screen.queryByRole('dialog', { name: /press run/i })).toBeNull();
  });

  it('stays hidden while a find is in flight (Run has become Cancel)', async () => {
    let resolveFind!: (v: { documents: unknown[]; durationMs: number; hasMore: boolean }) => void;
    const pending = new Promise<{ documents: unknown[]; durationMs: number; hasMore: boolean }>(
      (resolve) => {
        resolveFind = resolve;
      },
    );
    const findSpy = vi.fn<IpcApi['query']['find']>(() => pending);

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    mountWorkspace();

    // The auto-run's find is now stuck pending — `isLoading` stays true and
    // Run has become Cancel — for long enough to clear the hint's settle
    // window while it's still in flight.
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    await screen.findByTestId('query-cancel-btn');
    await new Promise((r) => setTimeout(r, 1800));
    expect(screen.queryByRole('dialog', { name: /press run/i })).toBeNull();

    resolveFind({ documents: [], durationMs: 1, hasMore: false });
  });
});
