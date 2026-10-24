import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab } from '@shared/types';

const now = '2026-04-21T12:00:00.000Z';

function collectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: 'coll',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state: {
      view: 'Tree',
      builder: {
        projection: [],
        sort: '',
        limit: '',
      },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
    ...overrides,
  };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('Workspace shell', () => {
  it('shows empty state when no tabs are open', async () => {
    installAtelierMock({
      tabs: { list: async () => [] },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Prod',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
    });
    render(
      <MemoryRouter initialEntries={[{ pathname: '/workspace', state: { openConnectionId: 'c1' } }]}>
        <Workspace />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Select a collection from the sidebar/i)).toBeTruthy();
    expect(screen.getByText(/Open a collection/i)).toBeTruthy();
  });

  it('renders tabs from api.tabs.list', async () => {
    installAtelierMock({
      tabs: {
        list: async () => [
          collectionTab({ id: 'a', collection: 'alpha', isActive: true, position: 0 }),
          collectionTab({ id: 'b', collection: 'beta', isActive: false, position: 1 }),
        ],
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Prod',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    const alphas = await screen.findAllByText('alpha');
    expect(alphas.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('beta')).toBeTruthy();
  });

  it('close button fires tabs.close and refreshes', async () => {
    const closeSpy = vi.fn(async () => ({ newActiveId: null }));
    let calls = 0;
    installAtelierMock({
      tabs: {
        list: async () => {
          calls++;
          return calls === 1
            ? [collectionTab({ id: 'a', collection: 'alpha', isActive: true, position: 0 })]
            : [];
        },
        close: closeSpy,
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Prod',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    const closeBtn = await screen.findByLabelText(/Close alpha/i);
    fireEvent.click(closeBtn);
    await waitFor(() => expect(closeSpy).toHaveBeenCalledWith('a'));
  });

  it('⌘T opens the new-tab picker, populated from the Focused Tab\'s Connection', async () => {
    installAtelierMock({
      // A tab open: the picker lists Databases for one Connection, and that
      // is the Focused Tab's (there is no session pin to fall back
      // on when nothing is open).
      tabs: { list: async () => [collectionTab({ id: 'a', collection: 'alpha', isActive: true })] },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Prod',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      meta: {
        listDatabases: async () => [
          { name: 'app', sizeOnDisk: 0, empty: false },
        ],
        listCollections: async () => [
          {
            name: 'users',
            type: 'collection',
            documentCount: 0,
            sizeBytes: 0,
            indexCount: 0,
            capped: false,
          },
        ],
      },
    });
    render(
      <MemoryRouter initialEntries={[{ pathname: '/workspace', state: { openConnectionId: 'c1' } }]}>
        <Workspace />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'New script tab' });
    fireEvent.keyDown(document, { key: 't', metaKey: true });
    expect(await screen.findByText(/Open collection/i)).toBeTruthy();
    const dbSelect = screen.getByLabelText('Database') as HTMLSelectElement;
    await waitFor(() => expect(dbSelect.value).toBe('app'));
  });

  it('shows the New script tab tooltip when keyboard focus lands on the + Script button', async () => {
    installAtelierMock({
      tabs: { list: async () => [collectionTab({ id: 'a', collection: 'alpha', isActive: true })] },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Prod',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
    });
    render(
      <MemoryRouter initialEntries={[{ pathname: '/workspace', state: { openConnectionId: 'c1' } }]}>
        <Workspace />
      </MemoryRouter>,
    );

    fireEvent.focus(await screen.findByRole('button', { name: 'New script tab' }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('New script tab');
  });
});

// ─── X15 T5 — NewTabPicker on Mantine ─────────────────────────────────
//
// The picker holds no typed input, so it takes no dirty guard and keeps
// Mantine's default `closeOnClickOutside`. Adding or removing that prop here is
// an equivalent mutation, so nothing below pretends to cover it.

const DB = { name: 'app', sizeOnDisk: 0, empty: false };
const coll = (name: string) => ({
  name,
  type: 'collection' as const,
  documentCount: 0,
  sizeBytes: 0,
  indexCount: 0,
  capped: false,
});

/**
 * Mounts a workspace with one open tab and opens the picker from the tab
 * strip's "+".
 *
 * X16.4 — this used to mount an *empty* workspace and open the picker
 * from the empty state's CTA. That CTA is gone: the picker asks one Connection
 * for its Databases, and with no tab open there is no Connection that answers
 * without guessing. The strip's "+" is the surviving entry point, and it has a
 * Focused Tab behind it by construction.
 *
 * `userEvent`, not `fireEvent`: focus return is only observable if the trigger
 * actually held focus when the dialog opened, and `fireEvent.click` does not
 * move focus.
 */
async function openPicker(meta: Record<string, unknown>) {
  installAtelierMock({
    tabs: { list: async () => [collectionTab({ id: 'a', collection: 'alpha', isActive: true })] },
    conn: {
      list: async () => [
        {
          id: 'c1',
          name: 'Prod',
          color: '#1A6835',
          host: 'localhost',
          port: 27017,
          connectionType: 'standard',
          readOnly: false,
          status: 'connected',
        },
      ],
    },
    meta: meta as never,
  });
  render(
    <MemoryRouter initialEntries={[{ pathname: '/workspace' }]}>
      <Workspace />
    </MemoryRouter>,
  );
  // The tab strip has no "+" any more; ⌘T is the shortcut. Focus a real
  // button first so Mantine has somewhere to return focus to on close.
  const trigger = await screen.findByRole('button', { name: 'New script tab' });
  trigger.focus();
  fireEvent.keyDown(document, { key: 't', metaKey: true });
  return trigger;
}

const picker = () => screen.getByRole('dialog', { name: 'Open collection' });
const openButton = () => within(picker()).getByRole('button', { name: 'Open' }) as HTMLButtonElement;

describe('NewTabPicker — dialog shell (X15 T5)', () => {
  it('puts role="dialog" on the panel with an accessible name, not on the backdrop', async () => {
    await openPicker({
      listDatabases: async () => [DB],
      listCollections: async () => [coll('users')],
    });

    await waitFor(() => expect(within(picker()).getByLabelText('Database')).toBeTruthy());
    const overlay = document.body.querySelector('.mantine-Modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('role')).toBeNull();
    expect(within(picker()).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('moves focus into the panel on open and returns it to the trigger on Escape', async () => {
    const trigger = await openPicker({
      listDatabases: async () => [DB],
      listCollections: async () => [coll('users')],
    });

    await waitFor(() => expect(picker().contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open collection' })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * MUTATION TARGET — drop the `disabled={!canOpen}` from the Open button and
   * this goes red. Before X15 T5 the button was always live and `submit`
   * silently returned, so the click read as the app hanging.
   */
  it('keeps Open disabled while the collection list is still loading', async () => {
    await openPicker({
      listDatabases: async () => [DB],
      // Never settles — the window the user sees between opening the picker
      // and the list arriving.
      listCollections: () => new Promise<never>(() => undefined),
    });

    await waitFor(() => expect(within(picker()).getByLabelText('Collection')).toBeTruthy());
    expect(within(picker()).getByText('Loading…')).toBeTruthy();
    expect(openButton().disabled).toBe(true);
  });

  it('enables Open once the collection list has loaded', async () => {
    await openPicker({
      listDatabases: async () => [DB],
      listCollections: async () => [coll('users')],
    });

    await waitFor(() => expect(openButton().disabled).toBe(false));
  });

  it('keeps Open live when the user switches back to an already-loaded database', async () => {
    // The fetch effect early-returns on a cached database, so re-selecting one
    // never re-seeds the collection through it. Without the seed in the
    // dropdown's own onChange, Open is dead under a populated list.
    await openPicker({
      listDatabases: async () => [DB, { name: 'other', sizeOnDisk: 0, empty: false }],
      listCollections: async ({ dbName }: { dbName: string }) => [coll(`${dbName}-coll`)],
    });

    await waitFor(() => expect(openButton().disabled).toBe(false));
    const dbSelect = within(picker()).getByLabelText('Database');

    fireEvent.change(dbSelect, { target: { value: 'other' } });
    await waitFor(() => expect(openButton().disabled).toBe(false));

    fireEvent.change(dbSelect, { target: { value: 'app' } });
    await waitFor(() => expect(within(picker()).getByLabelText('Collection')).toBeTruthy());
    expect(openButton().disabled).toBe(false);
  });
});
