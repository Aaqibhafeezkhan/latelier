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

const ORDERS = [
  { sku: 'apple-001', status: 'paid' },
  { sku: 'banana-002', status: 'pending' },
  { sku: 'cherry-003', status: 'paid' },
];

/**
 * W02 / A06 — a view made from the aggregation builder, then edited in place
 * from the navigator. The real server is the point: it is what runs the view's
 * pipeline when the view is opened, before and after `collMod`.
 */
test('Save as view from the builder, then Modify view from the navigator', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Views Target' },
        { dbName: 'shop', collection: 'orders', docs: ORDERS },
      );
      await expectStatusDot(win, 'Views Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      // --- Save as view: a $match stage saved as "v1" ----------------------
      await ws.tablist.getByRole('tab', { name: /Aggregation/ }).click();
      await expect(win.getByText('Pipeline output')).toBeVisible({ timeout: 5000 });
      await win.getByRole('button', { name: /Add stage/ }).first().click();
      await win.getByRole('textbox', { name: 'Search stages' }).fill('match');
      await win.getByText('$match', { exact: true }).first().click();
      const matchBody = win.locator('[data-testid="stage-body-editor-1"] .cm-content');
      await expect(matchBody).toBeVisible({ timeout: 5000 });
      await matchBody.click();
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await win.keyboard.press('Backspace');
      await win.keyboard.type('{ "status": "paid" }');

      await win.getByRole('button', { name: 'Save as view…' }).click();
      const saveDialog = win.getByRole('dialog', { name: 'Save pipeline as view' });
      await expect(saveDialog).toBeVisible({ timeout: 3000 });
      await saveDialog.getByLabel('View name').fill('v1');
      await saveDialog.getByRole('button', { name: 'Create view' }).click();
      await expect(saveDialog).not.toBeVisible({ timeout: 5000 });

      // The navigator is not refreshed by the save, as with Save as collection.
      await ws.dbRow('shop').click({ button: 'right' });
      await win.getByRole('menuitem', { name: 'Refresh collections' }).click();
      await expect(ws.collectionRow('shop', 'v1')).toBeVisible({ timeout: 5000 });

      // --- Modify view: the pipeline now keeps the pending order only -------
      await ws.collectionRow('shop', 'v1').click({ button: 'right' });
      await win.getByRole('menuitem', { name: 'Modify view' }).click();
      const modifyDialog = win.getByRole('dialog', { name: /Modify view "v1"/ });
      await expect(modifyDialog).toBeVisible({ timeout: 3000 });
      await expect(modifyDialog.getByLabel('Source collection')).toHaveValue('orders', { timeout: 5000 });
      await expect(modifyDialog.getByLabel('Pipeline')).toHaveValue(/"paid"/);
      await modifyDialog.getByLabel('Pipeline').fill('[{"$match":{"status":"pending"}}]');
      await modifyDialog.getByRole('button', { name: 'Save' }).click();
      await expect(modifyDialog).not.toBeVisible({ timeout: 5000 });

      await ws.collectionRow('shop', 'v1').click();
      await expect(win.getByText('banana-002').first()).toBeVisible({ timeout: 8000 });
      // Visible matches only: the orders tab opened earlier may keep its panel mounted.
      await expect(win.getByText('apple-001').filter({ visible: true })).toHaveCount(0);
      await expect(win.getByText('cherry-003').filter({ visible: true })).toHaveCount(0);

      // --- Duplicate view: v1 (now the pending filter) copied to v1_copy ----
      await ws.collectionRow('shop', 'v1').click({ button: 'right' });
      await win.getByRole('menuitem', { name: 'Duplicate view…' }).click();
      const dupDialog = win.getByRole('dialog', { name: 'Duplicate view' });
      await expect(dupDialog).toBeVisible({ timeout: 5000 });
      await expect(dupDialog.getByLabel('View name')).toHaveValue('v1_copy');
      await dupDialog.getByRole('button', { name: 'Create view' }).click();
      await expect(dupDialog).not.toBeVisible({ timeout: 5000 });
      // The duplicate refreshes the navigator itself, unlike Save as view.
      await expect(ws.collectionRow('shop', 'v1_copy')).toBeVisible({ timeout: 5000 });
    });
  });
});

/** W16 §15 — validation rules saved from Structure and read back from the server. */
test('Structure → Validation → Edit rules saves a $jsonSchema that the section then shows', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Validation Target' },
        { dbName: 'shop', collection: 'orders', docs: ORDERS },
      );
      await expectStatusDot(win, 'Validation Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await ws.tablist.getByRole('tab', { name: /Structure/ }).click();

      const validation = win.getByRole('region', { name: 'Validation' });
      await expect(validation.getByText('No validation rules')).toBeVisible({ timeout: 8000 });

      await validation.getByRole('button', { name: 'Edit rules' }).click();
      await validation.getByLabel('Validator').fill('{"$jsonSchema":{"required":["sku"]}}');
      await validation.getByLabel('Validation level').selectOption('moderate');
      await validation.getByRole('button', { name: 'Save' }).click();

      await expect(validation.getByLabel('Validator')).not.toBeVisible({ timeout: 5000 });
      await expect(validation).toContainText('"$jsonSchema"', { timeout: 5000 });
      await expect(validation).toContainText('"sku"');
      await expect(validation.getByText('Level: moderate')).toBeVisible();
    });
  });
});
