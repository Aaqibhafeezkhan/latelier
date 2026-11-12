import { test, expect, type Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { baseConnInput, startMemoryServer, stopAllMemoryServers, withApp } from '../helpers/e2eApp';
import { seedActiveConnectionWithDocs, withOpenOrders } from './helpers/uiSeed';
import { expectConsoleClean } from './helpers/uiAsserts';
import { WorkspacePage } from './pages/WorkspacePage';

test.afterAll(stopAllMemoryServers);

async function openPalette(win: Page) {
  const palette = win.locator('[role=dialog]:has(input[role=combobox])');
  const search = palette.locator('input[role="combobox"]');
  await expect(async () => {
    if (!(await palette.isVisible())) await win.keyboard.press('ControlOrMeta+K');
    await expect(palette).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000 });
  return { palette, search };
}

const ORDERS = [{ sku: 'apple-001' }, { sku: 'banana-002' }];

/**
 * X07 §13.11 — a collection row's action list (⌥↵) offers `Export…`, which
 * opens the export dialog for that collection's open tab.
 */
test('palette: the collection action list opens Export…', async () => {
  await withOpenOrders('Palette Export Target', ORDERS, 'banana-002', async (win) => {
    const { palette, search } = await openPalette(win);
    await search.fill('shop.orders');
    await expect(palette.getByRole('option').first()).toContainText('shop.orders');
    await win.keyboard.press('Alt+Enter');
    await expect(search).toHaveAttribute('aria-label', 'Filter actions');
    await search.fill('export');
    await expect(palette.getByRole('option').first()).toContainText('Export…');
    await win.keyboard.press('Enter');

    await expect(palette).not.toBeVisible({ timeout: 4000 });
    await expect(win.getByRole('dialog', { name: 'Export documents' })).toBeVisible({ timeout: 5000 });
  });
});

/**
 * X07 §13.11 — `drop orders` + Enter opens the drop confirmation and runs
 * nothing: cancelling leaves the collection in the navigator and on the server.
 */
test('palette: drop orders asks for confirmation, and Cancel keeps the collection', async () => {
  const { server, host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Palette Drop Target' },
        { dbName: 'shop', collection: 'orders', docs: ORDERS },
      );
      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('banana-002')).toBeVisible({ timeout: 8000 });

      const { palette, search } = await openPalette(win);
      await search.fill('drop orders');
      await expect(palette.getByRole('option').first()).toContainText('Drop collection…');
      await win.keyboard.press('Enter');

      const dialog = win.getByRole('dialog', { name: /Drop collection "orders"/ });
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 4000 });

      await expect(ws.collectionRow('shop', 'orders')).toBeVisible();
      const client = new MongoClient(server.getUri());
      try {
        const names = (await client.db('shop').listCollections().toArray()).map((c) => c.name);
        expect(names).toContain('orders');
      } finally {
        await client.close();
      }
    });
  });
});

/**
 * X07 §13.4, W09 §8 — a saved query's `Rename…` opens its collection's Saved
 * list with the entry in its rename input, focused once the palette has closed.
 */
test('palette: Rename… on a saved query renames it in the Saved list', async () => {
  await withOpenOrders('Palette Rename Saved', ORDERS, 'banana-002', async (win) => {
    // Seeded through the bridge: the Saved list is the surface under test, not the Save dialog.
    const created = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: {
          conn: { list: () => Promise<{ id: string }[]> };
          saved: { create: (input: unknown) => Promise<{ name: string }> };
        };
      }).atelier;
      const [conn] = await api.conn.list();
      const saved = await api.saved.create({
        connectionId: conn!.id,
        dbName: 'shop',
        collection: 'orders',
        kind: 'find',
        name: 'Paid orders',
        payload: { kind: 'find', builder: { conditions: [], logic: 'AND', projection: [], sort: '', limit: '50' }, queryRaw: '{}' },
      });
      return saved.name;
    });
    expect(created).toBe('Paid orders');

    const { palette, search } = await openPalette(win);
    await search.fill('rename paid');
    await expect(palette.getByRole('option').first()).toContainText('Paid orders');
    await win.keyboard.press('Enter');

    await expect(palette).not.toBeVisible({ timeout: 4000 });
    const field = win.getByLabel('New name for "Paid orders"');
    await expect(field).toBeFocused({ timeout: 5000 });
    await field.fill('Settled orders');
    await win.keyboard.press('Enter');
    await expect(win.getByRole('button', { name: 'Rename "Settled orders"' })).toBeVisible({ timeout: 5000 });
  });
});
