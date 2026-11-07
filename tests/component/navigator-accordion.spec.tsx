import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, act, waitFor, navigatorRoot } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import {
  DbCollectionNavigator,
  type DbCollectionNavigatorProps,
} from '../../src/pages/Workspace/DbCollectionNavigator';
import {
  connectionFixture,
  installAtelierMock,
  uninstallAtelierMock,
} from '../helpers/atelierMock';
import type { CollectionInfo } from '../../shared/ipc';
import type { ConnectionSummary } from '@shared/types';

// X16.3 — the navigator is an accordion of Connection roots. Everything
// here is asserted the way a person reads it: how many roots there are, which
// one is open, what colour runs down its side, whether a root lists anything.

const PROD = connectionFixture({ id: 'c1', name: 'Prod', color: '#1A6835' });
const STAGING = connectionFixture({ id: 'c2', name: 'Staging', color: '#8A5A00' });
const ARCHIVE = connectionFixture({ id: 'c3', name: 'Archive', color: '#3B4B8A' });

const colls = (...names: string[]): CollectionInfo[] =>
  names.map((n) => ({
    name: n,
    type: 'collection' as const,
    documentCount: 0,
    sizeBytes: 0,
    indexCount: 0,
    capped: false,
  }));

function mockTree() {
  return installAtelierMock({
    meta: {
      listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
      listCollections: async () => colls('orders'),
    },
  });
}

function mount(props: Partial<DbCollectionNavigatorProps> = {}) {
  const baseProps: DbCollectionNavigatorProps = {
    connectionsWithTabs: new Set(),
    connections: [PROD, STAGING, ARCHIVE],
    focusedConnectionId: null,
    activeDbName: null,
    activeCollection: null,
    onOpenCollection: vi.fn(),
    onOpenAggregation: vi.fn(),
    ...props,
  };
  return render(<DbCollectionNavigator {...baseProps} />);
}

// #72 — was a local copy identical to navigator-disconnect.spec.tsx's own;
// SonarCloud flagged the pair. Now shared, see `navigatorRoot`'s own doc.
const root = navigatorRoot;

/** The spine is a border on the row wrapper, so read the wrapper's style. */
const spineOf = (el: HTMLElement) => el.parentElement?.getAttribute('style') ?? '';

const tree = () => screen.getByRole('tree');

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('DbCollectionNavigator — a filter with no match', () => {
  const connected = connectionFixture({ id: 'c1', name: 'Prod', status: 'connected' });

  it('says so and offers clearing it, once every list has loaded', async () => {
    mockTree();
    mount({ connections: [connected], focusedConnectionId: 'c1' });
    await screen.findByTestId('nav-db-shop');
    const filter = screen.getByRole('textbox', { name: 'Filter collections' });

    await userEvent.type(filter, 'zzz');

    expect((await screen.findByTestId('nav-filter-empty')).textContent).toContain('No collections match “zzz”');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect((filter as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('nav-filter-empty')).toBeNull();
  });

  it('stays quiet while a filter still matches', async () => {
    mockTree();
    mount({ connections: [connected], focusedConnectionId: 'c1' });
    await screen.findByTestId('nav-db-shop');

    await userEvent.type(screen.getByRole('textbox', { name: 'Filter collections' }), 'ord');

    await waitFor(() => expect(within(tree()).getByText('orders')).toBeTruthy());
    expect(screen.queryByTestId('nav-filter-empty')).toBeNull();
  });
});

describe('DbCollectionNavigator — an accordion of Connection roots', () => {
  it('renders one root per Connection, each named', () => {
    mockTree();
    mount();

    expect(screen.getAllByTestId('nav-connection')).toHaveLength(3);
    expect(root('Prod')).toBeTruthy();
    expect(root('Staging')).toBeTruthy();
    expect(root('Archive')).toBeTruthy();
  });

  it('expanding one root collapses the one that was open', async () => {
    mockTree();
    mount({ focusedConnectionId: 'c1' });

    // The Focused Tab's Connection opens first.
    await waitFor(() => expect(root('Prod').getAttribute('aria-expanded')).toBe('true'));
    expect(root('Staging').getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.click(root('Staging'));
    });

    expect(root('Staging').getAttribute('aria-expanded')).toBe('true');
    expect(root('Prod').getAttribute('aria-expanded')).toBe('false');
    expect(root('Archive').getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking the open root closes it, and nothing else opens in its place', async () => {
    mockTree();
    mount({ focusedConnectionId: 'c1' });
    await screen.findByTestId('nav-db-shop');

    await act(async () => {
      fireEvent.click(root('Prod'));
    });

    for (const name of ['Prod', 'Staging', 'Archive']) {
      expect(root(name).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.queryByTestId('nav-db-shop')).toBeNull();
  });

  it('carries the Connection colour down its section, and a muted rail when there is no live client', async () => {
    mockTree();
    mount({
      // Dormant, not Saved — no live client, but a tab keeps its root.
      connectionsWithTabs: new Set(['c2']),
      connections: [PROD, { ...STAGING, status: 'unknown' }],
      focusedConnectionId: 'c1',
    });

    await screen.findByTestId('nav-db-shop');

    // Header row and expanded subtree alike carry Prod's own colour (#1A6835,
    // which the DOM reports back in rgb()).
    const PROD_SPINE = 'rgb(26, 104, 53)';
    expect(spineOf(root('Prod'))).toContain(PROD_SPINE);
    expect(spineOf(screen.getByTestId('nav-db-shop'))).toContain(PROD_SPINE);

    // Staging has no live client, so its rail is muted rather than its colour.
    expect(spineOf(root('Staging'))).not.toContain('rgb(138, 90, 0)');
    expect(spineOf(root('Staging'))).toContain('var(--atelier-border)');
  });

  it('marks a read-only Connection on its root, in words and not only in colour', () => {
    mockTree();
    mount({ connections: [PROD, { ...STAGING, readOnly: true }] });

    expect(within(root('Staging')).getByText('RO')).toBeTruthy();
    expect(root('Staging').getAttribute('aria-label')).toContain('Read-only');
    expect(within(root('Prod')).queryByText('RO')).toBeNull();
    expect(root('Prod').getAttribute('aria-label')).not.toContain('Read-only');
  });

  it('says a root is not connected in words, not only by its rail', () => {
    mockTree();
    mount({
      connectionsWithTabs: new Set(['c2']),
      connections: [PROD, { ...STAGING, status: 'unknown' }],
    });

    expect(within(root('Staging')).getByText('not connected')).toBeTruthy();
    expect(root('Staging').getAttribute('aria-label')).toContain('Not connected');
    expect(within(root('Prod')).queryByText('not connected')).toBeNull();
  });

  it('lists no Databases and no Collections once the Connection loses its live client, however full the cache is', async () => {
    // The fixture that makes this discriminate: two Connections, and the one
    // under test has a *populated* cache while it is not connected. Gate the
    // tree on the cache instead of the live-client flag and this stays green
    // on an empty cache — so the cache is filled first, on purpose, and then
    // only the status changes.
    mockTree();
    const connected: ConnectionSummary[] = [PROD, STAGING];
    const { rerender } = mount({
      connectionsWithTabs: new Set(['c2']),
      connections: connected,
      focusedConnectionId: 'c2',
    });

    // Staging is Open: its tree fills.
    const dbRow = await screen.findByTestId('nav-db-shop');
    await act(async () => {
      fireEvent.click(dbRow);
    });
    await screen.findByTestId('nav-coll-shop-orders');

    // It drops. Nothing else changes — the cache still holds shop/orders.
    rerender(
      <DbCollectionNavigator
        connectionsWithTabs={new Set(['c2'])}
        connections={[PROD, { ...STAGING, status: 'unknown' }]}
        focusedConnectionId="c2"
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('nav-db-shop')).toBeNull();
    expect(screen.queryByTestId('nav-coll-shop-orders')).toBeNull();
    expect(screen.getByText('Not connected. Nothing to browse.')).toBeTruthy();
    // The root itself stays: a Dormant Connection is still somewhere you are.
    expect(root('Staging')).toBeTruthy();
  });

  it('does not go looking for databases on a Connection with no live client', async () => {
    const listDatabases = vi.fn(async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }]);
    installAtelierMock({
      meta: { listDatabases: listDatabases as never, listCollections: async () => colls('orders') },
    });
    mount({
      connectionsWithTabs: new Set(['c1']),
      connections: [{ ...PROD, status: 'unknown' }],
      focusedConnectionId: 'c1',
    });

    await waitFor(() => expect(root('Prod').getAttribute('aria-expanded')).toBe('true'));
    expect(listDatabases).not.toHaveBeenCalled();
  });

  it('a Connection that connects into an empty navigator opens its root', async () => {
    let emit: ((r: { id: string; status: 'connected' }) => void) | null = null;
    installAtelierMock({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => colls('orders'),
      },
      mongo: {
        onStatus: ((cb: (r: { id: string; status: 'connected' }) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        }) as never,
      },
    });
    // No Focused Tab, so nothing is expanded to begin with.
    mount({ focusedConnectionId: null });
    await waitFor(() => expect(emit).not.toBeNull());
    expect(root('Staging').getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      emit!({ id: 'c2', status: 'connected' });
    });

    expect(root('Staging').getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByTestId('nav-db-shop')).toBeTruthy();

    // A second Connection coming up must not close the root being read.
    await act(async () => {
      emit!({ id: 'c3', status: 'connected' });
    });
    expect(root('Staging').getAttribute('aria-expanded')).toBe('true');
    expect(root('Archive').getAttribute('aria-expanded')).toBe('false');
  });

  // #72 — the two tests below were flagged as a self-duplicate: same
  // "press keys, assert which root is expanded" shape, just with different
  // keys/roots each time. `press`/`expectExpanded` name the shape once; the
  // key sequence and expected root stay literal at each call site.
  function press(key: string): void {
    fireEvent.keyDown(tree(), { key });
  }
  function expectExpanded(name: string, expanded: boolean): void {
    expect(root(name).getAttribute('aria-expanded')).toBe(String(expanded));
  }

  it('keyboard: Down/Up walk the roots and Enter opens the one in focus', async () => {
    mockTree();
    mount();

    press('ArrowDown'); // Prod
    press('ArrowDown'); // Staging
    press('Enter');
    expectExpanded('Staging', true);
    expectExpanded('Prod', false);

    press('ArrowUp'); // back to Prod
    press('Enter');
    expectExpanded('Prod', true);
    expectExpanded('Staging', false);
  });

  it('keyboard: Home/End reach the first and last root, and Right expands one', () => {
    mockTree();
    mount();

    press('End');
    press('ArrowRight');
    expectExpanded('Archive', true);

    press('Home');
    press('ArrowRight');
    expectExpanded('Prod', true);
    expectExpanded('Archive', false);
  });

  // #58 — the roving highlight already worked (the tests above); nothing told
  // assistive tech it moved. `aria-activedescendant` on the container, naming
  // a real per-row DOM `id`, is the missing half.
  it('keyboard: aria-activedescendant names the focused row as Down moves it', () => {
    mockTree();
    mount();

    fireEvent.keyDown(tree(), { key: 'ArrowDown' }); // Prod
    expect(tree().getAttribute('aria-activedescendant')).toBe('navigator-row-conn:c1');
    expect(root('Prod').id).toBe('navigator-row-conn:c1');

    fireEvent.keyDown(tree(), { key: 'ArrowDown' }); // Staging
    expect(tree().getAttribute('aria-activedescendant')).toBe('navigator-row-conn:c2');
    expect(root('Staging').id).toBe('navigator-row-conn:c2');
  });

  // #58 — a row used to carry `tabIndex={-1}`, which the HTML focusing-steps
  // algorithm still treats as click-focusable even though it's excluded from
  // Tab order. `userEvent.click` (not `fireEvent.click`, which does no focus
  // management at all — see the CLAUDE.md/#20 note on this exact trap) moves
  // real focus, so this is the only kind of click that can catch the bug.
  it('click on a row keeps real focus on the tree container and sets the row active', async () => {
    mockTree();
    mount();
    const treeEl = tree();

    // Clicking a Connection root also expands it (existing accordion
    // behaviour above), so wait for its one database to mount before
    // reading the flat row order below.
    await userEvent.setup().click(root('Staging'));
    await screen.findByTestId('nav-db-shop');

    expect(document.activeElement).toBe(treeEl);
    expect(treeEl.getAttribute('aria-activedescendant')).toBe('navigator-row-conn:c2');

    // The next Arrow key continues from the row just clicked (Staging), not
    // from wherever the highlight was sitting before — its own newly
    // revealed "shop" database is the very next row.
    fireEvent.keyDown(treeEl, { key: 'ArrowDown' });
    expect(treeEl.getAttribute('aria-activedescendant')).toBe('navigator-row-db:c2:shop');
  });

  it('keyboard: Left from a database row lands on that database’s own root, not the first one', async () => {
    // Staging is the expanded root, and it is not the first: a Left that
    // walked to row 0 would collapse Prod instead, and Staging would stay open.
    mockTree();
    mount({ focusedConnectionId: 'c2' });
    await screen.findByTestId('nav-db-shop');

    fireEvent.keyDown(tree(), { key: 'Home' }); // Prod's root
    fireEvent.keyDown(tree(), { key: 'ArrowDown' }); // Staging's root
    fireEvent.keyDown(tree(), { key: 'ArrowDown' }); // the shop DB row under it
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' }); // up to Staging's root
    fireEvent.keyDown(tree(), { key: 'Enter' }); // which collapses

    expect(root('Staging').getAttribute('aria-expanded')).toBe('false');
    expect(root('Prod').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('nav-db-shop')).toBeNull();
  });

  // Collection rows carry no tabIndex (the tree container owns focus via
  // aria-activedescendant), so the keyboard path onto them is the only way a
  // keyboard user opens a collection — it needs its own proof.
  describe('keyboard: acting on a collection row', () => {
    const ORDERS = { connectionId: 'c1', dbName: 'shop', collection: 'orders' };

    async function focusOrders() {
      mockTree();
      const onOpenCollection = vi.fn();
      const onOpenAggregation = vi.fn();
      mount({
        focusedConnectionId: 'c1',
        activeDbName: 'shop',
        activeCollection: 'orders',
        onOpenCollection,
        onOpenAggregation,
      });
      const rowEl = await screen.findByTestId('nav-coll-shop-orders');
      await waitFor(() => expect(tree().getAttribute('aria-activedescendant')).toBe(rowEl.id));
      return { onOpenCollection, onOpenAggregation };
    }

    it('Enter opens the collection, reusing an existing tab', async () => {
      const { onOpenCollection, onOpenAggregation } = await focusOrders();
      fireEvent.keyDown(tree(), { key: 'Enter' });
      expect(onOpenCollection).toHaveBeenCalledWith(ORDERS, { reuseExisting: true });
      expect(onOpenAggregation).not.toHaveBeenCalled();
    });

    it.each([
      ['Ctrl', { ctrlKey: true }],
      ['Cmd', { metaKey: true }],
    ])('%s+Enter opens the collection in a new tab', async (_label, mods) => {
      const { onOpenCollection } = await focusOrders();
      fireEvent.keyDown(tree(), { key: 'Enter', ...mods });
      expect(onOpenCollection).toHaveBeenCalledWith(ORDERS, { reuseExisting: false });
    });

    it('Alt+Enter opens the collection as an aggregation', async () => {
      const { onOpenCollection, onOpenAggregation } = await focusOrders();
      fireEvent.keyDown(tree(), { key: 'Enter', altKey: true });
      expect(onOpenAggregation).toHaveBeenCalledWith(ORDERS);
      expect(onOpenCollection).not.toHaveBeenCalled();
    });

    it('Left moves to the collection’s own database row', async () => {
      await focusOrders();
      fireEvent.keyDown(tree(), { key: 'ArrowLeft' });
      expect(tree().getAttribute('aria-activedescendant')).toBe(
        screen.getByTestId('nav-db-shop').id,
      );
    });
  });

  // #55 — the shared ContextMenu had no keyboard open path. Shift+F10 and the
  // dedicated ContextMenu key are the platform conventions for "open the
  // context menu for the focused thing".
  describe('keyboard: opening the context menu (#55)', () => {
    async function focusOrdersRow() {
      mockTree();
      mount({ focusedConnectionId: 'c1', activeDbName: 'shop', activeCollection: 'orders' });
      const rowEl = await screen.findByTestId('nav-coll-shop-orders');
      const treeEl = tree();
      await waitFor(() => expect(treeEl.getAttribute('aria-activedescendant')).toBe(rowEl.id));
      return { rowEl, treeEl };
    }

    it('Shift+F10 opens the menu for the focused row', async () => {
      const { treeEl } = await focusOrdersRow();

      fireEvent.keyDown(treeEl, { key: 'F10', shiftKey: true });

      expect(await screen.findByRole('menuitem', { name: 'Rename collection' })).toBeTruthy();
    });

    // #133 — the navigator is virtualized: PageDown or the wheel can scroll
    // the focused row out and unmount it. jsdom mounts every row, so the
    // lookup is made to miss the way a real unmounted row would.
    it('Shift+F10 still opens the menu when the focused row is not mounted', async () => {
      const { rowEl, treeEl } = await focusOrdersRow();
      const realGet = document.getElementById.bind(document);
      const spy = vi
        .spyOn(document, 'getElementById')
        .mockImplementation((id) => (id === rowEl.id ? null : realGet(id)));
      // react-window's `scrollToRow` ends in `element.scrollTo(...)`. The row
      // is already the focused one, so nothing else scrolls it back: only the
      // handler's own `scrollToRow` can make this call.
      const originalScrollTo = Element.prototype.scrollTo;
      const scrollTo = vi.fn();
      Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
      try {
        fireEvent.keyDown(treeEl, { key: 'F10', shiftKey: true });

        expect(await screen.findByRole('menuitem', { name: 'Rename collection' })).toBeTruthy();
        expect(scrollTo).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        Element.prototype.scrollTo = originalScrollTo;
      }
    });

    it('the ContextMenu key opens the same menu', async () => {
      const { treeEl } = await focusOrdersRow();

      fireEvent.keyDown(treeEl, { key: 'ContextMenu' });

      expect(await screen.findByRole('menuitem', { name: 'Rename collection' })).toBeTruthy();
    });

    it('F10 without Shift does not open the menu', async () => {
      const { treeEl } = await focusOrdersRow();

      fireEvent.keyDown(treeEl, { key: 'F10', shiftKey: false });

      expect(screen.queryByRole('menuitem', { name: 'Rename collection' })).toBeNull();
    });

    it('anchors the menu to the focused row, not a stale {0,0}', async () => {
      const { rowEl, treeEl } = await focusOrdersRow();
      vi.spyOn(rowEl, 'getBoundingClientRect').mockReturnValue({
        left: 42,
        bottom: 84,
        top: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 42,
        y: 84,
        toJSON: () => {},
      } as DOMRect);

      fireEvent.keyDown(treeEl, { key: 'ContextMenu' });
      await screen.findByRole('menuitem', { name: 'Rename collection' });

      const anchor = screen.getByTestId('context-menu-anchor');
      expect(anchor.style.left).toBe('42px');
      expect(anchor.style.top).toBe('84px');
    });

    it('focus enters the menu on open and Escape returns it to the tree', async () => {
      const { treeEl } = await focusOrdersRow();

      fireEvent.keyDown(treeEl, { key: 'ContextMenu' });
      await screen.findByRole('menuitem', { name: 'Rename collection' });
      await waitFor(() =>
        expect(document.activeElement?.closest('[role="menu"]')).toBeTruthy(),
      );

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

      await waitFor(() => expect(document.activeElement).toBe(treeEl));
    });

    // #69 — this used to assert the bug: `openMenuFor`'s mouse path left
    // `returnFocusTo` `undefined`, so closing a right-click-opened menu
    // stranded focus on `<body>` (`focusBefore`, here, since nothing had
    // focus yet). `openMenuFor` now sets `returnFocusTo: trigger` (the tree)
    // on both open paths, so closing restores focus there instead.
    it('a right-click-opened menu closes and returns focus to the tree, not <body>', async () => {
      const { treeEl, rowEl } = await focusOrdersRow();

      fireEvent.contextMenu(rowEl);
      // "Copy name" has no follow-on dialog, unlike Rename/Drop — a plain
      // close is the only way to see whether *this* menu's own close path
      // restores focus, independent of whatever a dialog's own autoFocus
      // would do afterward.
      const item = await screen.findByRole('menuitem', { name: 'Copy name' });
      fireEvent.click(item);

      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(treeEl);
    });

    // Mantine's own `FocusTrap` grabs focus into the menu on any open,
    // mouse or keyboard, independent of `returnFocusTo` — so #69's fix
    // (setting `returnFocusTo` on the mouse path too) only changes what
    // happens on *close*. This is the one thing #69 says must stay true.
    it('right-click still opens without a pointer-driven focus change of its own — Mantine grabs it either way', async () => {
      const { rowEl } = await focusOrdersRow();

      fireEvent.contextMenu(rowEl);

      await waitFor(() =>
        expect(document.activeElement?.closest('[role="menu"]')).toBeTruthy(),
      );
    });
  });

  it('marks the active namespace only under the Focused Tab’s own Connection', async () => {
    // Both servers have a shop.orders. The Focused Tab is on Prod, so
    // Staging's identically-named collection is a different collection and
    // must not read as the one you are looking at.
    mockTree();
    mount({
      focusedConnectionId: 'c1',
      activeDbName: 'shop',
      activeCollection: 'orders',
    });

    await act(async () => {
      fireEvent.click(root('Staging'));
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('nav-db-shop'));
    });
    const stagingOrders = await screen.findByTestId('nav-coll-shop-orders');
    expect(stagingOrders.getAttribute('aria-selected')).toBe('false');

    await act(async () => {
      fireEvent.click(root('Prod'));
    });
    const prodOrders = await screen.findByTestId('nav-coll-shop-orders');
    expect(prodOrders.getAttribute('aria-selected')).toBe('true');
  });

  it('opens a collection on the root it was clicked in, not on the Focused Tab’s Connection', async () => {
    mockTree();
    const onOpenCollection = vi.fn();
    mount({ focusedConnectionId: 'c1', onOpenCollection });

    // Move to Staging's root and open a collection there while the Focused
    // Tab still belongs to Prod.
    await act(async () => {
      fireEvent.click(root('Staging'));
    });
    const dbRow = await screen.findByTestId('nav-db-shop');
    await act(async () => {
      fireEvent.click(dbRow);
    });
    fireEvent.click(await screen.findByTestId('nav-coll-shop-orders'));

    expect(onOpenCollection).toHaveBeenCalledWith(
      { connectionId: 'c2', dbName: 'shop', collection: 'orders' },
      { reuseExisting: true },
    );
  });
});

// X16 §2 — a Connection is Saved when it has no live client *and* no
// open tab. Saved is the one state with no navigator root at all: it lives in
// the Connection Switcher until someone opens it. Every other state keeps its
// root, which is what these cases pin down separately, so a filter that is too
// eager is as red as one that never fires.
describe('DbCollectionNavigator — a Saved Connection has no root', () => {
  /** The names on the roots currently rendered, in order. */
  const rootNames = () =>
    screen.queryAllByTestId('nav-connection').map((r) => r.textContent ?? '');
  const hasRoot = (name: string) => rootNames().some((t) => t.includes(name));

  it('renders no root for a Saved Connection — no live client, no tabs', () => {
    mockTree();
    mount({
      connectionsWithTabs: new Set(),
      connections: [PROD, { ...STAGING, status: 'unknown' }],
    });

    expect(hasRoot('Prod')).toBe(true);
    expect(hasRoot('Staging')).toBe(false);
  });

  it('keeps the root for an Open Connection', () => {
    mockTree();
    mount({ connectionsWithTabs: new Set(), connections: [PROD, STAGING] });

    expect(hasRoot('Prod')).toBe(true);
    expect(hasRoot('Staging')).toBe(true);
  });

  // Connecting and Failed have no live client either, so they would fall into
  // the same filter as Saved if it keyed on the client alone.
  it.each(['connecting', 'error'] as const)('keeps the root for a %s Connection', (status) => {
    mockTree();
    mount({ connectionsWithTabs: new Set(), connections: [PROD, { ...STAGING, status }] });

    expect(hasRoot('Staging')).toBe(true);
  });

  it('keeps the greyed, data-less root of a Dormant Connection — no client, but a tab', async () => {
    mockTree();
    mount({
      connectionsWithTabs: new Set(['c2']),
      connections: [PROD, { ...STAGING, status: 'unknown' }],
      focusedConnectionId: 'c2',
    });

    expect(hasRoot('Staging')).toBe(true);
    // Dormant, so the root is there but browses nothing.
    expect(await screen.findByText('Not connected. Nothing to browse.')).toBeTruthy();
    expect(screen.queryByTestId('nav-db-shop')).toBeNull();
    expect(spineOf(root('Staging'))).toContain('var(--atelier-border)');
  });

  // Spec §4.6 — Disconnect closes that Connection's tabs and removes its root.
  // Deliberately a rerender of a live tree rather than a fresh mount: the row
  // list is memoized, and only an in-place prop change can catch a stale
  // dependency list. A remount rebuilds the memo and would pass either way.
  it('drops the root when Disconnect leaves a Connection with no client and no tabs', async () => {
    mockTree();
    const { rerender } = mount({
      connectionsWithTabs: new Set(['c2']),
      connections: [PROD, STAGING],
      focusedConnectionId: 'c2',
    });
    await screen.findByTestId('nav-db-shop');
    expect(hasRoot('Staging')).toBe(true);

    // Disconnect: the pool drops the client and the caller closes the tabs.
    rerender(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={[PROD, { ...STAGING, status: 'unknown' }]}
        focusedConnectionId={null}
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    expect(hasRoot('Staging')).toBe(false);
    expect(hasRoot('Prod')).toBe(true);
  });

  // Closing the last tab is the other way into Saved, and the only one where
  // `connections` does not change at all — the Connection was already without
  // a client. The same array instance goes into both renders on purpose: it
  // makes the tab set the single moving part, which is what a row memo that
  // forgot to depend on it would sleep through.
  it('drops the root when the last tab on a Dormant Connection closes', () => {
    mockTree();
    const dormant: ConnectionSummary[] = [PROD, { ...STAGING, status: 'unknown' }];
    const { rerender } = mount({
      connectionsWithTabs: new Set(['c2']),
      connections: dormant,
    });
    expect(hasRoot('Staging')).toBe(true);

    rerender(
      <DbCollectionNavigator
        connectionsWithTabs={new Set()}
        connections={dormant}
        focusedConnectionId={null}
        activeDbName={null}
        activeCollection={null}
        onOpenCollection={vi.fn()}
        onOpenAggregation={vi.fn()}
      />,
    );

    expect(hasRoot('Staging')).toBe(false);
  });
});
