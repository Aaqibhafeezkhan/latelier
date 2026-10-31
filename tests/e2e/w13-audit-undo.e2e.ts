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
 * X13 test case 26 — delete a document from the result view, use the
 * success toast's Undo action, and confirm the row is back.
 */
test('audit undo: deleting a document offers Undo on the toast, and Undo restores the row', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Undo Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [{ _id: 1, sku: 'undo-me', status: 'pending' }],
        },
      );
      await expectStatusDot(win, 'Undo Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('undo-me')).toBeVisible({ timeout: 8000 });

      // Per-row Delete, then confirm.
      await win.getByRole('button', { name: /^Delete document/ }).first().click();
      await expect(win.getByText('Delete document?')).toBeVisible({ timeout: 4000 });
      await win.getByRole('button', { name: 'Delete', exact: true }).click();

      await expect(win.getByText('undo-me')).not.toBeVisible({ timeout: 8000 });

      // Success toast carries an Undo action (offerUndo, Workspace/useDocumentDialogs.ts).
      await expect(win.getByText('Document deleted')).toBeVisible({ timeout: 4000 });
      await win.getByRole('button', { name: 'Undo', exact: true }).click();

      // Undo re-runs the tab's source; the row comes back.
      await expect(win.getByText('undo-me')).toBeVisible({ timeout: 8000 });
    });
  });
});
