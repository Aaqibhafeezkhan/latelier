import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '../helpers/render';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider, usePaletteContext } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import { ConnectionPaletteCommands } from '../../src/commands/ConnectionPaletteCommands';
import { installAtelierMock, multiConnectionMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ConnectionSummary } from '@shared/types';

function conn(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'c1',
    name: 'Prod',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard',
    readOnly: false,
    status: 'connected',
    ...overrides,
  };
}

/** Renders which Connection the palette believes the Focused Tab is on. */
function ContextProbe() {
  const ctx = usePaletteContext();
  return <div data-testid="palette-connection">{ctx.connectionId ?? 'none'}</div>;
}

/** Opens the palette on `query`: a Connection is listed once the user types. */
function openPalette(query: string) {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: query } });
}

const optionTitles = () =>
  within(screen.getByRole('dialog', { name: 'Command palette' }))
    .queryAllByRole('option')
    .map((o) => o.querySelector('[data-title]')?.getAttribute('data-title'));

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function app() {
  return (
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <ConnectionPaletteCommands />
          <Workspace />
          <ContextProbe />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>
  );
}

/**
 * Routed variant — `ConnectionPaletteCommands` is registered globally, so its
 * Connection actions fire from any route, not just `/workspace`. Mirrors `app()` in
 * `tests/component/connection-palette-switch.spec.tsx`.
 */
function routedApp(initialEntries: string[]) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <ConnectionPaletteCommands />
          <ToggleButton />
          <Routes>
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/connections/:id" element={<div>connection detail screen</div>} />
          </Routes>
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
});

/**
 * Each saved Connection is one Connection object (X07 §13.4) whose actions are
 * Open · Edit · Disconnect (while connected) · Delete…, registered by
 * `ConnectionPaletteCommands`. The id is baked into each action at creation
 * time, which is what keeps an action's gate and its target from disagreeing:
 * a Connection open with no tab (the normal state) keeps its actions.
 */
describe('Workspace palette Connection objects', () => {
  it('lists no row per Connection on an empty query, and one row once its name is typed', async () => {
    installAtelierMock({
      conn: { list: async () => [conn()] },
      tabs: { list: async () => [] },
    });

    render(app());

    fireEvent.click(screen.getByText('toggle'));
    await act(async () => {});
    expect(optionTitles()).not.toContain('Prod');
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'prod' } });
    await waitFor(() => expect(optionTitles()).toEqual(['Prod']));
    const footer = document.querySelector('[data-palette-footer]')!;
    expect(footer.textContent).toContain('Open');
    expect(footer.textContent).toContain('Actions');
    expect(footer.textContent).not.toContain('Open in new tab');
  });

  it('lists Edit, Disconnect and Delete… for a connected Connection with no tabs open', async () => {
    installAtelierMock({
      conn: { list: async () => [conn()] },
      tabs: { list: async () => [] },
    });

    render(app());

    openPalette('prod');
    await waitFor(() => expect(optionTitles()).toEqual(['Prod']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter', altKey: true });
    expect(optionTitles()).toEqual(['Open', 'Edit', 'Disconnect', 'Delete…']);
    // Refresh is a whole-list refetch, still a command gated on the route.
    fireEvent.keyDown(screen.getByLabelText('Filter actions'), { key: 'Escape' });
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'refresh connection' } });
    expect(optionTitles()).toContain('Refresh connection');
  });

  it('offers no Disconnect for a Connection that is not connected', async () => {
    installAtelierMock({
      conn: { list: async () => [conn({ status: 'disconnected' })] },
      tabs: { list: async () => [] },
    });

    render(app());

    openPalette('prod');
    await waitFor(() => expect(optionTitles()).toEqual(['Prod']));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter', altKey: true });
    expect(optionTitles()).toEqual(['Open', 'Edit', 'Delete…']);
  });

  // Two Connections, tabs on both, Focused Tab on Staging (c2) — not the
  // first Connection in the list, and not Prod either.
  async function renderTwoConnectionsFocusedOnStaging() {
    installAtelierMock({
      ...multiConnectionMock({
        connections: [conn(), conn({ id: 'c2', name: 'Staging' })],
        tabs: [
          { id: 't1', connectionId: 'c1', collection: 'orders' },
          { id: 't2', connectionId: 'c2', collection: 'events', isActive: true },
        ],
      }),
    });

    render(app());

    await waitFor(() => expect(screen.getByTestId('palette-connection').textContent).toBe('c2'));
  }

  /** Types `query` and performs the first row with Enter. */
  async function perform(query: string, title: string) {
    openPalette(query);
    await waitFor(() => expect(optionTitles()[0]).toBe(title));
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
  }

  // X16.1, spec §4.5 — the Focused Tab here is Staging (c2). An action that
  // read `ctx.connectionId` at call time, or a palette that only offered the
  // Focused Tab's Connection, would hand a "delete Prod" pick to Staging.
  it('names and acts on the Connection the action says, not the Focused Tab', async () => {
    await renderTwoConnectionsFocusedOnStaging();

    await perform('delete staging', 'Staging');
    expect(await screen.findByRole('dialog', { name: 'Delete "Staging"?' })).toBeTruthy();

    await perform('drop prod', 'Prod');
    expect(await screen.findByRole('dialog', { name: 'Delete "Prod"?' })).toBeTruthy();
  });

  it('cancelling from the palette-triggered dialog reaches the same ConnectionDeleteDialog', async () => {
    await renderTwoConnectionsFocusedOnStaging();

    await perform('delete staging', 'Staging');
    const dialog = await screen.findByRole('dialog', { name: 'Delete "Staging"?' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Delete "Staging"?' })).toBeNull(),
    );
  });

  it('Disconnect reaches the Workspace confirm dialog, which counts the open tabs', async () => {
    await renderTwoConnectionsFocusedOnStaging();

    await perform('disconnect prod', 'Prod');
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect "Prod"?' });
    expect(dialog.textContent).toMatch(/1 (open )?tab/);
  });

  // The object is registered globally, so its action can fire from OUTSIDE
  // /workspace and land on a fresh Workspace mount whose own `connections`
  // hasn't resolved yet. `openDeleteConnectionModal` looks the id up in
  // `connections` and no-ops on a miss — acting (and clearing the nav state)
  // before that first load lands would drop the intent silently.
  // `openDeleteConnectionModal` refuses while the tabs are loading (it counts
  // them for its copy): an intent acted on before they land is dropped (#746).
  it('a delete triggered from outside /workspace survives tabs that resolve late', async () => {
    let resolveTabs: (v: unknown[]) => void = () => {};
    const tabsPromise = new Promise<unknown[]>((resolve) => {
      resolveTabs = resolve;
    });
    installAtelierMock({
      conn: { list: async () => [conn()] },
      tabs: { list: () => tabsPromise as never },
    });

    render(routedApp(['/connections/c1']));
    await perform('delete prod', 'Prod');

    await waitFor(() => expect(screen.queryByText('connection detail screen')).toBeNull());
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: 'Delete "Prod"?' })).toBeNull();

    await act(async () => {
      resolveTabs([]);
      await Promise.resolve();
    });

    expect(await screen.findByRole('dialog', { name: 'Delete "Prod"?' })).toBeTruthy();
  });

  it('a delete triggered from outside /workspace survives the fresh mount, even if connections resolve late', async () => {
    let connCallCount = 0;
    let resolveSecondConnList: (v: ConnectionSummary[]) => void = () => {};
    const secondConnListPromise = new Promise<ConnectionSummary[]>((resolve) => {
      resolveSecondConnList = resolve;
    });
    const connections = [conn()];
    const connList = vi.fn(async () => {
      connCallCount += 1;
      // Call #1 is ConnectionPaletteCommands' own subscription (mounted from
      // the start). Call #2 is Workspace's fresh-mount subscription — held
      // open so this test controls when it resolves relative to the intent.
      if (connCallCount === 1) return connections;
      return secondConnListPromise;
    });
    installAtelierMock({
      conn: { list: connList },
      tabs: { list: async () => [] },
    });

    render(routedApp(['/connections/c1']));
    expect(screen.getByText('connection detail screen')).toBeTruthy();

    await perform('delete prod', 'Prod');

    await waitFor(() => expect(screen.queryByText('connection detail screen')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Delete "Prod"?' })).toBeNull();

    await act(async () => {
      resolveSecondConnList(connections);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole('dialog', { name: 'Delete "Prod"?' })).toBeTruthy();
  });
});
