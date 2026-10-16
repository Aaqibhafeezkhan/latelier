// Phase 1 characterization tests (specs/PLAN-workspace-decomposition.md §5,
// T4) for the prefs load effect at Workspace.tsx:573-600 and the
// fire-and-forget writers at lines 609, 642, 656, 2131, 2173, 2291, 2344.
//
// The load is async: panels first render at their default sizes, then
// `prefsReady` flips and the `PanelGroup`s remount once (`key={`v-${prefsReady}`}`
// / `key={`h-${prefsReady}`}`) with the persisted sizes. Every case here
// waits past that resolution — asserting before it would read the defaults
// and pass vacuously.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { notifications } from '@mantine/notifications';
import { render, renderHook, act, screen, fireEvent, waitFor, titleBar } from '../helpers/render';
import { useWorkspacePanelPrefs } from '../../src/pages/Workspace/useWorkspacePanelPrefs';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock, connectionFixture } from '../helpers/atelierMock';
import type { CollectionTab, ReferenceRule } from '@shared/types';

const NOW = '2026-08-01T12:00:00.000Z';
const DOC = { _id: '1', sku: 'widget', customerId: 'cust-1' };

const RULE: ReferenceRule = {
  id: 'r1',
  connectionId: 'c1',
  sourceDb: 'shop',
  sourceCollection: 'orders',
  sourceField: 'customerId',
  targetDb: 'shop',
  targetCollection: 'customers',
  targetField: '_id',
  projection: [],
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function tab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    position: 0,
    isActive: true,
    openedAt: NOW,
    pinned: false,
    state: {
      view: 'Table',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      lastRun: { documents: [DOC], durationMs: 1, ranAt: NOW },
    },
    ...overrides,
  };
}

function mountWorkspace(prefsGet: (key: string) => Promise<unknown> = async () => null) {
  installAtelierMock({
    tabs: { list: async () => [tab()] },
    conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    prefs: { get: prefsGet as never },
    refs: {
      list: async () => [RULE],
      resolve: async () => ({ ruleId: 'r1', found: false, documents: [], durationMs: 0 }),
    },
  });
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('workspace panel prefs (T4)', () => {
  // NOTE on scope: this proves the boolean pref (`sidebarCollapsed`) is
  // applied once the async load resolves. It deliberately does NOT try to
  // assert the *numeric* prefs (leftWidth, innerHSplit, shellSplit,
  // refDrawerWidth) landed, and does NOT assert the `key={prefsReady}`
  // PanelGroup remount count — verified empirically (see report) that
  // neither is observable from the DOM in jsdom: react-resizable-panels'
  // percentage sizing depends on `ResizeObserver` (stubbed as a no-op in
  // tests/helpers/jsdomSetup.ts) and never serializes a percent/pixel value
  // into any element's `style` attribute or a `<style>` tag either way, so a
  // test asserting on it would pass identically whether or not the value
  // actually took effect. The write side of those four prefs (that dragging
  // /committing a handle calls `api.prefs.set` with the right value) is
  // covered directly below instead, which needs no such reading of layout.
  it('reflects a stored boolean pref (sidebarCollapsed) once the async load resolves, past the "Loading workspace…" gate', async () => {
    const stored: Record<string, unknown> = {
      'ui.workspace.sidebarCollapsed': true,
    };
    mountWorkspace(async (key: string) => stored[key] ?? null);

    // `initialLoadPending` (`!prefsReady || connectionsLoading`) gates this
    // text — its disappearance is what actually proves `prefsReady` flipped,
    // rather than the collapsed-navbar affordance merely being the default.
    await waitFor(() => expect(screen.queryByText('Loading workspace…')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open navigator' })).toBeTruthy();
    expect(screen.queryByRole('separator', { name: 'Resize navigator' })).toBeNull();
  });

  // Guardrail 3 of specs/PLAN-workspace-decomposition.md. The vertical
  // `PanelGroup` carries `key={`v-${String(prefsReady)}`}` so it remounts once
  // when the async prefs load resolves, re-applying `defaultSize` with the
  // persisted values. Delete that key and every launch renders at the defaults
  // and stays there — a layout shift on every start.
  //
  // The remount is not observable through sizes: `react-resizable-panels`
  // needs `ResizeObserver` to compute percentages, and
  // `tests/helpers/jsdomSetup.ts` stubs it as a no-op, so no percent or pixel
  // value ever reaches a `style` attribute. **Node identity is observable.** A
  // remount replaces the group's DOM subtree, so the `v-main` Panel element
  // captured before the flip is a different object afterwards.
  //
  // The control assertion is what makes this specific rather than a test that
  // "something re-rendered": the navigator's resize handle lives in
  // `AppShell.Navbar`, outside the `PanelGroup`, and must keep its identity
  // across the same flip. Without it, a whole-page remount would pass too.
  //
  // Only the vertical group is asserted, and that is not an omission. The
  // horizontal group's `key={`h-${String(prefsReady)}`}` can never flip:
  // `initialLoadPending` (`!prefsReady || connectionsLoading`,
  // Workspace.tsx:667) gates the subtree that contains it, so it first mounts
  // with `prefsReady` already true. The key is inert today — harmless, and
  // load-bearing again the moment that gate changes — so it is left in place
  // and recorded here rather than asserted on or deleted.
  it('the vertical PanelGroup remounts when prefsReady flips, and nothing outside it does (guardrail 3)', async () => {
    let releasePrefs: () => void = () => {};
    const prefsGate = new Promise<void>((resolve) => {
      releasePrefs = resolve;
    });

    mountWorkspace(async () => {
      await prefsGate;
      return null;
    });

    // Hold the load open and capture identities while `prefsReady` is false.
    await waitFor(() => expect(screen.queryByText('Loading workspace…')).not.toBeNull());
    const panelBefore = document.getElementById('v-main');
    const outsideBefore = screen.getByRole('separator', { name: 'Resize navigator' });
    expect(panelBefore).not.toBeNull();

    releasePrefs();
    await waitFor(() => expect(screen.queryByText('Loading workspace…')).toBeNull());

    const panelAfter = document.getElementById('v-main');
    expect(panelAfter).not.toBeNull();
    // The remount: same id, different element object.
    expect(panelAfter).not.toBe(panelBefore);
    // The control: outside the group, identity is preserved.
    expect(screen.getByRole('separator', { name: 'Resize navigator' })).toBe(outsideBefore);
  });

  it('a rejected prefs.get still clears the "Loading workspace…" gate (no hang) and leaves the defaults in place', async () => {
    mountWorkspace(async () => {
      throw new Error('boom');
    });

    await waitFor(() => expect(screen.queryByText('Loading workspace…')).toBeNull());
    // Defaults: navigator open (not collapsed), so the resize handle renders.
    expect(screen.getByRole('separator', { name: 'Resize navigator' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse navigator' })).toBeTruthy();
  });

  it('dragging the navigator resize handle writes ui.workspace.leftWidth', async () => {
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      prefs: { set: set as never },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    const handle = await screen.findByRole('separator', { name: 'Resize navigator' });
    fireEvent.mouseDown(handle, { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 340, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 340, clientY: 300 });

    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.workspace.leftWidth', 246));
  });

  it('dragging the reference-drawer resize handle writes ui.workspace.refDrawerWidth', async () => {
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      prefs: { set: set as never },
      refs: {
        list: async () => [RULE],
        resolve: async () => ({ ruleId: 'r1', found: false, documents: [], durationMs: 0 }),
      },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    // The reference drawer (and its resize handle) only renders once a
    // reference has actually been opened — the chip next to the matching
    // field's value, wired to `handleRefOpen`.
    await screen.findByText(/widget/);
    const chip = await screen.findByRole('button', { name: 'Open reference to customers' });
    fireEvent.click(chip);

    const handle = await screen.findByRole('separator', { name: 'Resize reference drawer' });
    fireEvent.mouseDown(handle, { clientX: 500, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 560, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 560, clientY: 300 });

    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.workspace.refDrawerWidth', 320));
  });

  it('committing the builder split writes ui.workspace.innerHSplit; committing the shell split writes ui.workspace.shellSplit', async () => {
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      prefs: { set: set as never },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    // `react-resizable-panels`' own keyboard affordance (arrow keys nudge by
    // 5%) — deliberately used over a pointer drag: jsdom reports zero-sized
    // rects for everything (see tests/helpers/jsdomSetup.ts's comment on
    // `getBoundingClientRect`), which the library's pointer path hit-tests against, but its
    // keyboard path resizes off stored percentages and needs no real layout.
    const builderHandle = await screen.findByRole('separator', { name: 'Resize Query Builder' });
    fireEvent.keyDown(builderHandle, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith('ui.workspace.innerHSplit', expect.any(Number)),
    );

    // Open the shell pane so its own split handle renders (Workspace.tsx
    // only mounts it while `shellOpen && focusedConnection`).
    fireEvent.click(titleBar().getByRole('button', { name: 'Shell' }));
    const shellHandle = await screen.findByRole('separator', { name: 'Resize shell pane' });
    fireEvent.keyDown(shellHandle, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith('ui.workspace.shellSplit', expect.any(Number)),
    );
  });

  it('the sidebar toggle writes ui.workspace.sidebarCollapsed; the builder toggle writes ui.workspace.builderCollapsed', async () => {
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      prefs: { set: set as never },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith('ui.workspace.sidebarCollapsed', true),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Collapse Query Builder' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith('ui.workspace.builderCollapsed', true),
    );
  });

  it('a rejected prefs.set does not throw into the render', async () => {
    // The local click handler flips `sidebarCollapsed` synchronously
    // regardless of whether the write is `.catch()`-guarded, so that alone
    // can't tell a swallowed rejection from an unswallowed one — both toggle
    // the button label the same way. What actually distinguishes them is
    // whether the rejected `prefs.set` promise surfaces as an unhandled
    // rejection once its microtask runs; every writer in Workspace.tsx is
    // `void`-ed and `.catch(() => {})`-guarded specifically so it never does.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      installAtelierMock({
        tabs: { list: async () => [tab()] },
        conn: { list: async () => [connectionFixture({ id: 'c1' })] },
        prefs: {
          set: async () => {
            throw new Error('write failed');
          },
        },
      });
      render(
        <MemoryRouter initialEntries={['/workspace']}>
          <Workspace />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Collapse navigator' }));

      // The toggle itself still took effect locally.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open navigator' })).toBeTruthy(),
      );
      // Let the rejected write's microtask actually run before checking.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('useWorkspacePanelPrefs — a layout setting that could not be saved says so', () => {
  afterEach(() => {
    uninstallAtelierMock();
    notifications.clean();
  });

  function failingSet() {
    installAtelierMock({
      prefs: {
        get: async () => null,
        set: (async () => {
          throw { code: 'SYSTEM_ERROR', message: 'disk full' };
        }) as never,
      },
    });
  }

  it('shows one toast when two writes fail, not one per write', async () => {
    failingSet();
    const { result } = renderHook(() => useWorkspacePanelPrefs());
    await waitFor(() => expect(result.current.prefsReady).toBe(true));

    act(() => {
      result.current.commitLeftWidth(300);
      result.current.commitShellSplit(40);
    });

    await waitFor(() => expect(screen.getAllByText('Could not save the layout')).toHaveLength(1));
  });

  it('toasts for the sidebar toggle, and the toggle still applies locally', async () => {
    failingSet();
    const { result } = renderHook(() => useWorkspacePanelPrefs());
    await waitFor(() => expect(result.current.prefsReady).toBe(true));

    act(() => result.current.toggleSidebar());

    expect(result.current.sidebarCollapsed).toBe(true);
    expect(await screen.findByText('Could not save the layout')).toBeTruthy();
  });
});
