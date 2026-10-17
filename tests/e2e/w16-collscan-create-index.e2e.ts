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
 * W16 Tier 4 — "Create an index for this query" from a COLLSCAN explain.
 * The full flow: a find with no supporting index explains to COLLSCAN,
 * clicking the new action lands in Structure with the create-index drawer
 * prefilled from `suggestIndex`, submitting creates the index for real (this
 * is the one part of the flow a component test can't see — a real Mongo
 * query planner choosing COLLSCAN vs. IXSCAN), and re-explaining the same
 * query now shows the index in use.
 *
 * Sibling of `find-explain.e2e.ts` (the plain Explain flow) and
 * `x15-admin-drawer-fill.e2e.ts` (the create-index drawer's own layout).
 */
test('COLLSCAN find -> Explain -> Create an index -> Structure lists it -> re-explain shows IXSCAN', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Create Index Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'apple-001', status: 'paid' },
            { sku: 'banana-002', status: 'pending' },
            { sku: 'cherry-003', status: 'paid' },
          ],
        },
      );
      await expectStatusDot(win, 'Create Index Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('banana-002')).toBeVisible({ timeout: 8000 });

      // The first run is `{}` over a collection with no index but `_id`: the
      // plan badge in the result bar already says so.
      const planBadge = win.getByTestId('plan-badge');
      await expect(planBadge).toHaveText('no index', { timeout: 8000 });

      // A filter with no supporting index — explains to COLLSCAN.
      await ws.queryBarTextarea.fill('{"status":"paid"}');
      await ws.queryBarRunOptionsButton.click();
      await win.getByRole('menuitem', { name: 'queryPlanner' }).click();

      const explainDrawer = win.getByRole('dialog', { name: 'Explain plan' });
      await expect(explainDrawer).toBeVisible({ timeout: 8000 });
      await expect(explainDrawer).toContainText('COLLSCAN', { timeout: 8000 });

      const createIndexBtn = explainDrawer.getByTestId('explain-create-index');
      await expect(createIndexBtn).toBeVisible();
      await createIndexBtn.click();

      // The explain drawer closes and Structure becomes the active sub-tab.
      await expect(explainDrawer).not.toBeVisible({ timeout: 4000 });
      await expect(win.getByRole('tab', { name: /Structure/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );

      // The create-index drawer is open, prefilled from the filter that was
      // just explained: `status` (equality) — the only field in play.
      const createDrawer = win.getByRole('dialog', { name: /New index/ });
      await expect(createDrawer).toBeVisible({ timeout: 8000 });
      await expect(createDrawer.getByLabel('Field 1', { exact: true })).toHaveValue('status');
      await expect(createDrawer.getByLabel('Direction 1', { exact: true })).toHaveValue('1');
      await expect(createDrawer).toContainText("MongoDB's ESR order");

      // Submitting is the user's own act — the drawer never auto-creates.
      await createDrawer.getByRole('button', { name: 'Create index' }).click();
      await expect(createDrawer).not.toBeVisible({ timeout: 8000 });

      // The created index appears in Structure's own index list. Scoped to
      // the "Indexes" region so strict mode can't trip on a second match
      // elsewhere in the pane (the create-drawer's own field prefill also
      // says "status").
      await expect(
        win.getByRole('region', { name: 'Indexes' }).getByText('status_1', { exact: true }),
      ).toBeVisible({ timeout: 8000 });

      // Re-explaining the same query now shows the index in use, not a scan.
      await win.getByRole('tab', { name: /Documents/ }).click();

      // Running it again, the badge names the index.
      await ws.queryBarRunButton.click();
      await expect(planBadge).toHaveText('status_1', { timeout: 8000 });

      await ws.queryBarRunOptionsButton.click();
      await win.getByRole('menuitem', { name: 'queryPlanner' }).click();

      const reExplainDrawer = win.getByRole('dialog', { name: 'Explain plan' });
      await expect(reExplainDrawer).toBeVisible({ timeout: 8000 });
      await expect(reExplainDrawer).toContainText('IXSCAN', { timeout: 8000 });
      await expect(reExplainDrawer.getByTestId('explain-create-index')).not.toBeVisible();
    });
  });
});
