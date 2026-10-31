// W15 §13.1 / §13.7 — Reset wiped the whole tree and `queryRaw` on
// one click, from a footer button sitting beside Save, with no confirm and
// no recovery. Also covers §13.7's "copy actions report success".
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import { notifications } from '@mantine/notifications';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-06T12:00:00.000Z';
const SEEDED = '{"status":{"$eq":"paid"}}';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: SEEDED,
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

function mountWith(state: CollectionTabState) {
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
  });
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

afterEach(() => {
  notifications.clean();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('W15 §13.1 — Reset confirms before wiping the tree', () => {
  it('leaves the filter alone until the confirm is accepted', async () => {
    mountWith(makeState());
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    expect(bar.value).toBe(SEEDED);

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    // A dialog, not a wipe.
    const dialog = await screen.findByRole('dialog');
    expect(bar.value).toBe(SEEDED);

    // Backing out keeps the work.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bar.value).toBe(SEEDED);
  });

  it('wipes the filter once confirmed', async () => {
    mountWith(makeState());
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Reset' })[0]);

    await waitFor(() => expect(bar.value).toBe('{}'));
  });
});

describe('Reset names the find options it clears', () => {
  const withOptions = () =>
    makeState({
      builder: { projection: [], sort: '', limit: '', collation: '{"locale":"fr"}', hint: 'status_1' },
    });

  it('lists the options that are set, and Reset clears them', async () => {
    mountWith(withOptions());
    const collation = (await screen.findByTestId('query-bar-collation')) as HTMLInputElement;
    expect(collation.value).toBe('{"locale":"fr"}');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('the collation, hint you set');
    expect(dialog.textContent).not.toContain('maxTimeMS');

    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Reset' })[0]);
    // Reset is a load that replaces the query, so the advanced row
    // re-derives like a tab switch: nothing is set any more, so it collapses.
    await waitFor(() => expect(screen.queryByTestId('query-bar-collation')).toBeNull());
    fireEvent.click(document.querySelector('[aria-controls="query-bar-advanced"]')!);
    expect((screen.getByTestId('query-bar-collation') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('query-bar-hint') as HTMLInputElement).value).toBe('');
  });

  it('says nothing about options when none is set', async () => {
    mountWith(makeState());
    await screen.findByTestId('query-bar-input');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('the sort, limit and projection.');
    expect(dialog.textContent).not.toContain('you set');
  });
});

describe('W15 §13.7 — Copy code reports success', () => {
  it('says the command was copied', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: /Copy code/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Node.js' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await screen.findByText(/Command copied to the clipboard/);
  });
});
