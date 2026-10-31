import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean, expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * W06 — Result view modes (Tree / JSON / Table). Run a query, toggle each
 * view button, assert the seeded document data is visible in every mode and
 * that the active button reflects the current view.
 */
test('result views: Tree, JSON, and Table all render the same docs', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Views Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'unique-token-x', total: 11 },
            { sku: 'unique-token-y', total: 22 },
          ],
        },
      );
      await expectStatusDot(win, 'Views Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await ws.queryBarRunButton.click();

      // Tree (default) — sku appears in every row's collapsed preview.
      await expect(ws.viewTreeButton).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('unique-token-x')).toBeVisible();

      // Switch to JSON.
      await ws.viewJsonButton.click();
      await expect(win.getByText('unique-token-x')).toBeVisible();
      await expect(win.getByText('unique-token-y')).toBeVisible();

      // Switch to Table.
      await ws.viewTableButton.click();
      await expect(win.getByText('unique-token-x')).toBeVisible();
      await expect(win.getByText('unique-token-y')).toBeVisible();

      // Switch back to Tree to confirm the toggle round-trips.
      await ws.viewTreeButton.click();
      await expect(win.getByText('unique-token-x')).toBeVisible();
    });
  });
});

/**
 * W06 §3 and §2 keyboard paths: the JSON view's active card follows a click
 * and the arrow keys, and Enter on an active Tree leaf shows its full value.
 */
test('result views: JSON active card moves with ArrowDown; Enter on a Tree leaf shows its full value', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Views Keys' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'unique-token-x', total: 11 },
            { sku: 'unique-token-y', total: 22 },
          ],
        },
      );
      await expectStatusDot(win, 'Views Keys', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await ws.queryBarRunButton.click();
      await expect(ws.viewTreeButton).toBeVisible({ timeout: 8000 });

      // JSON: a click makes the card active, ArrowDown moves on to the next.
      await ws.viewJsonButton.click();
      const list = win.getByRole('tree', { name: 'Documents' });
      await win.getByRole('treeitem', { name: 'Document 1' }).click();
      await expect(list).toHaveAttribute('aria-activedescendant', 'json-row-0');
      await win.keyboard.press('ArrowDown');
      await expect(list).toHaveAttribute('aria-activedescendant', 'json-row-1');

      // Tree: expand the first document, click its `sku` leaf (focus lands
      // on that document's field tree), then Enter opens the full value.
      await ws.viewTreeButton.click();
      await win.getByTitle('Click to expand · ⌘/Ctrl+click to select').first().click();
      await win.getByTitle(/^Drag to add "sku \$eq/).first().click();
      await win.keyboard.press('Enter');
      const dialog = win.getByRole('dialog', { name: 'Full value' });
      await expect(dialog).toBeFocused();
      await expect(dialog.getByText(/^"unique-token-[xy]"$/)).toBeVisible();
      await win.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
});
