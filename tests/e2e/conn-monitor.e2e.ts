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
 * C06 §9 — the Monitor tab: its operations table renders, the profiler is set
 * to All on a database, and a query run in the workspace shows up in the
 * profile tail, all against a real mongod.
 */
test('monitor tab: profile All, run a query, see it in the profile tail', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const name = 'Monitor Target';
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name },
        { dbName: 'shop', collection: 'orders', docs: [{ sku: 'monitor-a' }, { sku: 'monitor-b' }] },
      );
      await expectStatusDot(win, name, 'connected');
      const ws = new WorkspacePage(win);

      await ws.switcher.manage(name);
      await win.getByRole('button', { name: 'Monitor', exact: true }).click();
      await expect(win.getByRole('region', { name: 'Current operations' })).toBeVisible({ timeout: 8000 });

      const prof = win.getByRole('region', { name: 'Profiler' });
      await prof.getByLabel('Profiler database').selectOption('shop');
      await expect(prof.getByText('Current: Off, slowms 100')).toBeVisible({ timeout: 8000 });
      await prof.getByText('All', { exact: true }).click();
      await prof.getByRole('button', { name: 'Apply' }).click();
      await expect(prof.getByText(/^Current: All/)).toBeVisible({ timeout: 8000 });

      await win.getByRole('button', { name: 'Open workspace' }).click();
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('monitor-a').first()).toBeVisible({ timeout: 8000 });

      await ws.switcher.manage(name);
      await win.getByRole('button', { name: 'Monitor', exact: true }).click();
      const tail = win.getByRole('region', { name: 'Profiler' });
      await tail.getByLabel('Profiler database').selectOption('shop');
      await expect(
        tail.getByRole('row').filter({ hasText: 'shop.orders' }).filter({ hasText: 'query' }).first(),
      ).toBeVisible({ timeout: 8000 });
    });
  });
});
