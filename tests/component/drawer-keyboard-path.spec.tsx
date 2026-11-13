// W15 §13.6 — the query drawer was reachable only by Tabbing to a
// 14×36px notch. These pin the two routes that replace that, and the guard
// that keeps them from firing into a pane the user cannot see.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab, CollectionView, ConnectionSummary } from '@shared/types';

const now = new Date('2026-01-01T00:00:00Z').toISOString();

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

function collectionTab(activeView: CollectionView = 'documents'): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state: {
      view: 'Table',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      activeView,
    },
  };
}

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function renderWorkspace(activeView: CollectionView = 'documents') {
  installAtelierMock({
    tabs: { list: async () => [collectionTab(activeView)] },
    conn: { list: async () => [conn()] },
  });
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Workspace />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
});

describe('the query drawer has a palette entry', () => {
  it('offers a toggle whose switch shows the drawer’s state', async () => {
    renderWorkspace();
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('Prod'));

    fireEvent.click(screen.getByText('toggle'));
    // The drawer starts expanded, so the switch is on.
    const row = screen.getByRole('option', { name: /^Query drawer/ });
    expect(row.getAttribute('aria-checked')).toBe('true');
  });

  it('is withheld in the aggregation view, where the builder is shut and hidden', async () => {
    renderWorkspace('aggregation');
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('Prod'));

    fireEvent.click(screen.getByText('toggle'));
    expect(screen.queryByRole('option', { name: /^Query drawer/ })).toBeNull();
  });
});

describe('⌘B toggles the drawer', () => {
  it('collapses the drawer and moves focus to the notch', async () => {
    renderWorkspace();
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('Prod'));
    await screen.findByRole('button', { name: 'Collapse Query Builder' });

    fireEvent.keyDown(window, { key: 'b', metaKey: true });

    // Focus must not be left where it was, or the shortcut changes the layout
    // out from under the user and the next Tab continues from nowhere useful.
    const notch = await screen.findByRole('button', { name: 'Open Query Builder' });
    await waitFor(() => expect(document.activeElement).toBe(notch));
  });

  it('expands again and puts focus on the drawer tablist', async () => {
    renderWorkspace();
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('Prod'));
    await screen.findByRole('button', { name: 'Collapse Query Builder' });

    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    await screen.findByRole('button', { name: 'Open Query Builder' });

    fireEvent.keyDown(window, { key: 'b', metaKey: true });

    // The roving tablist is the landing target.
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement | null;
      expect(focused?.getAttribute('role')).toBe('tab');
      expect(focused?.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('does nothing in the aggregation view', async () => {
    renderWorkspace('aggregation');
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('Prod'));
    // Off Documents the drawer is shut with no notch to reopen it.
    await screen.findByRole('tab', { name: /Aggregation/ });
    expect(screen.queryByRole('button', { name: /Query Builder$/ })).toBeNull();

    fireEvent.keyDown(window, { key: 'b', metaKey: true });

    // The stored state never flipped: Documents still shows the drawer open.
    fireEvent.click(screen.getByRole('tab', { name: /Documents/ }));
    expect(await screen.findByRole('button', { name: 'Collapse Query Builder' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Query Builder' })).toBeNull();
  });
});
