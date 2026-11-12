import { test, expect, type Page } from '@playwright/test';
import { baseConnInput, startMemoryServer, stopAllMemoryServers, withApp } from '../helpers/e2eApp';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean } from './helpers/uiAsserts';
import { WorkspacePage } from './pages/WorkspacePage';

test.afterAll(stopAllMemoryServers);

async function openPalette(win: Page, key: string) {
  const palette = win.locator('[role=dialog]:has(input[role=combobox])');
  await expect(async () => {
    if (!(await palette.isVisible())) await win.keyboard.press(key);
    await expect(palette).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000 });
  return palette;
}

/**
 * X07 §13.11 — a search typed in the wrong word order still finds the
 * collection, Enter opens it with Documents showing, and ⌘P opens the palette
 * on the Collections scope. No tab is open beforehand, so the landing tab can
 * only have come from the palette.
 */
test('palette: reversed words open shop.orders, and ⌘P opens on Collections', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Palette Search Target' },
        { dbName: 'shop', collection: 'orders', docs: [{ sku: 'apple-001' }] },
      );
      const ws = new WorkspacePage(win);
      // The palette indexes the collections the navigator has loaded, so the
      // database is expanded, but no collection is opened.
      await ws.waitForDb('shop');
      await ws.dbRow('shop').click();
      await expect(ws.collectionRow('shop', 'orders')).toBeVisible({ timeout: 5000 });
      await expect(ws.tabByName('orders')).toHaveCount(0);

      const palette = await openPalette(win, 'ControlOrMeta+K');
      await palette.locator('input[role="combobox"]').fill('orders shop');
      await expect(palette.getByRole('option').first()).toContainText('shop.orders');
      await win.keyboard.press('Enter');
      await expect(palette).not.toBeVisible({ timeout: 4000 });

      await expect(ws.tabByName('orders')).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });
      await expect(ws.collectionRow('shop', 'orders')).toHaveAttribute('aria-selected', 'true');
      await expect(win.getByText('apple-001')).toBeVisible({ timeout: 8000 });

      const scoped = await openPalette(win, 'ControlOrMeta+P');
      await expect(scoped.getByRole('tab', { name: 'Collections' })).toHaveAttribute('aria-selected', 'true');
      await expect(scoped.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false');
    });
  });
});
