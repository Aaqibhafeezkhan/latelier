// X07 §13.7 rule 1: opening the palette, typing in it and moving through it
// send nothing to a MongoDB server. Checked against a real mounted
// `<Workspace/>`, with every server-reaching channel of `window.atelier`
// watched once the navigator has listed what it lists on its own.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { ConnectionPaletteCommands } from '../../src/commands/ConnectionPaletteCommands';
import { useRegisterCommands } from '../../src/commands/useRegisterCommands';
import { api } from '../../src/api/atelier';
import { commandRegistry } from '../../src/commands/registry';
import { _resetTabRequestsForTests } from '../../src/pages/Workspace/tabRequest';
import {
  installAtelierMock,
  uninstallAtelierMock,
  connectionFixture,
  collectionTabFixture,
  watchServerCalls,
} from '../helpers/atelierMock';
import type { CollectionInfo, DbInfo } from '@shared/ipc';
import type { SavedQuerySummary } from '@shared/types';

const coll = (name: string): CollectionInfo => ({
  name,
  type: 'collection',
  documentCount: 0,
  sizeBytes: 0,
  indexCount: 0,
  capped: false,
});
const db = (name: string): DbInfo => ({ name, sizeOnDisk: 1, empty: false });
const SERVER: Record<string, string[]> = { shop: ['orders', 'customers'], ordering: ['carts'] };

const SAVED: SavedQuerySummary[] = [
  {
    id: 'q1',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    kind: 'find',
    name: 'Open orders',
    updatedAt: '2026-11-11T10:00:00.000Z',
  },
];

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

/**
 * The injected fault the watch must catch: a command whose `when`, read each
 * time the palette ranks, calls a server channel.
 */
function LeakOnRank() {
  useRegisterCommands(
    [
      {
        id: 'test.leak',
        title: 'Leaky command',
        group: 'general',
        when: () => {
          void api.meta.listCollections({ connectionId: 'c1', dbName: 'shop' });
          return true;
        },
        perform: () => {},
      },
    ],
    [],
  );
  return null;
}

function mount(leak = false) {
  const tabs = [collectionTabFixture({ id: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders', isActive: true })];
  const mock = installAtelierMock({
    conn: {
      list: async () => [
        connectionFixture({ id: 'c1', name: 'Production' }),
        connectionFixture({ id: 'c2', name: 'Staging', status: 'disconnected' }),
      ],
    },
    tabs: { list: async () => tabs, update: async (id: string) => collectionTabFixture({ id }) },
    meta: {
      listDatabases: async () => Object.keys(SERVER).map(db),
      listCollections: async ({ dbName }: { dbName: string }) => (SERVER[dbName] ?? []).map(coll),
    },
    query: { find: async () => ({ documents: [], durationMs: 1 }) as never },
    saved: { list: async () => SAVED },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <ConnectionPaletteCommands />
          <Workspace />
          <ToggleButton />
          {leak && <LeakOnRank />}
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
  return mock;
}

const input = () => screen.getByLabelText('Search commands');
const key = (k: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(input(), { key: k, ...extra });
const search = (q: string) => fireEvent.change(input(), { target: { value: q } });

/** Lets every pending effect and promise land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** Mounts, waits for the navigator's own listings, then starts watching. */
async function mountWatched(leak = false) {
  const mock = mount(leak);
  await screen.findByTestId('nav-coll-shop-orders');
  await settle();
  const watch = watchServerCalls(mock);
  return watch;
}

/** Opens the palette, types and moves through it the way a user does, without performing anything. */
async function browse() {
  fireEvent.click(screen.getByText('toggle'));
  await screen.findByRole('dialog', { name: 'Command palette' });
  for (const q of ['orders', 'prod open', 'open', 'drop ord', 'production', 'so', '6650c1f2a9e4b31d2c8f0a17', 'zzz', '']) {
    search(q);
    await settle();
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowUp');
    key('Tab');
    key('Tab');
    key('Tab', { shiftKey: true });
    key('End');
    key('Home');
  }
  // Back to All, then into a collection's action list and out again.
  search('shop.orders');
  for (let i = 0; i < 4; i++) key('Tab');
  await screen.findByRole('option', { name: /shop\.orders/ });
  key('Enter', { altKey: true });
  await screen.findByLabelText('Filter actions');
  const actions = screen.getByLabelText('Filter actions');
  fireEvent.keyDown(actions, { key: 'ArrowDown' });
  fireEvent.change(actions, { target: { value: 'exp' } });
  fireEvent.change(actions, { target: { value: '' } });
  fireEvent.keyDown(actions, { key: 'Escape' });
  await settle();
  fireEvent.click(screen.getByText('toggle'));
  await settle();
}

afterEach(() => {
  act(() => notifications.clean());
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  _resetTabRequestsForTests();
  vi.restoreAllMocks();
});

describe('the palette sends nothing to a server', () => {
  it('while it opens, is typed in, moved through and an action list is opened', async () => {
    const watch = await mountWatched();
    await browse();
    expect(watch.calls).toEqual([]);
  });

  it('would say so: a channel called while the palette is open is caught', async () => {
    const watch = await mountWatched(true);
    await browse();
    await waitFor(() => expect(watch.calls).toContain('meta.listCollections'));
  });
});
