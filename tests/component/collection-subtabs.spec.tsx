// The Documents / Aggregation / Structure strip above a collection tab was
// three hand-rolled buttons: arrow keys did nothing and no tab pointed at a
// panel. It is Mantine's Tabs now, like the Query drawer's strip.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-06T12:00:00.000Z';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
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

function mount() {
  const state = makeState();
  installAtelierMock({
    tabs: {
      list: async () => [makeCollectionTab(state)],
      setActive: async (id) => ({ id }),
      update: (async () => makeCollectionTab(state)) as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    query: {
      find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })),
      count: async () => ({ count: 0 }),
    },
    index: { list: async () => [] },
    meta: { sampleSchema: async () => ({ docs: [] }) },
  });
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

const strip = () => screen.findByRole('tablist', { name: 'Collection view' });
const selected = (name: string) =>
  screen.getByRole('tab', { name }).getAttribute('aria-selected') === 'true';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('collection view strip — keyboard and ARIA', () => {
  it('arrow keys move focus and selection, Home and End move focus', async () => {
    mount();
    const list = await strip();
    const documents = within(list).getByRole('tab', { name: /Documents/ });
    documents.focus();

    fireEvent.keyDown(documents, { key: 'ArrowRight' });
    await waitFor(() => expect(selected('Aggregation')).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Aggregation' }));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await waitFor(() => expect(selected('Documents')).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Documents' }));

    // Home and End only move focus (Mantine does not activate on them).
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Structure' }));
    expect(selected('Documents')).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Documents' }));
  });

  it('is a single tab stop: only the selected tab is keyboard-reachable', async () => {
    mount();
    const tabs = within(await strip()).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringMatching(/Documents/),
      expect.stringMatching(/Aggregation/),
      expect.stringMatching(/Structure/),
    ]);
    const reachable = tabs.filter((t) => t.getAttribute('tabindex') !== '-1');
    expect(reachable).toHaveLength(1);
    expect(reachable[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('the selected tab points at a real tabpanel that points back at it', async () => {
    mount();
    const list = await strip();
    const current = within(list)
      .getAllByRole('tab')
      .find((t) => t.getAttribute('aria-selected') === 'true')!;
    const panel = document.getElementById(current.getAttribute('aria-controls')!);
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute('role')).toBe('tabpanel');
    expect(panel!.getAttribute('aria-labelledby')).toBe(current.id);
  });

  it('clicking a tab changes the view', async () => {
    mount();
    await strip();
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }));
    await waitFor(() => expect(selected('Structure')).toBe(true));
    expect(screen.getByRole('region', { name: 'Indexes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Documents/ }));
    await waitFor(() => expect(selected('Documents')).toBe(true));
    expect(screen.queryByRole('region', { name: 'Indexes' })).toBeNull();
  });
});
