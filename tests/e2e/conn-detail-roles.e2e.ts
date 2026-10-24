import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnection } from './helpers/uiSeed';
import { expectStatusDot, expectConsoleClean } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * C10 §Roles tab — the detail panel's Roles tab creates a custom role through
 * `role:create` and lists it from `role:list` against a real mongod.
 */
test('detail roles tab: create a custom role and see it listed', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const switcher = new WorkspacePage(win).switcher;
      const { name } = await seedActiveConnection(win, {
        ...baseConnInput(host, port),
        name: 'Roles Target',
      });
      await switcher.waitVisible();
      await expect(switcher.item(name)).toBeVisible({ timeout: 8000 });
      await expectStatusDot(win, name, 'connected');
      await switcher.manage(name);

      await win.getByRole('button', { name: 'Roles', exact: true }).click();
      // The tab opens on admin, where a fresh server has no custom roles.
      await expect(win.getByText('No custom roles on admin.')).toBeVisible({ timeout: 8000 });

      await win.getByRole('button', { name: '+ New role' }).click();
      await win.getByLabel('Role name', { exact: true }).fill('e2eAuditor');
      await win
        .getByLabel('Privileges')
        .fill('[{"resource": {"db": "admin", "collection": ""}, "actions": ["find"]}]');
      await win.getByRole('button', { name: 'Create role' }).click();

      const roles = win.getByRole('region', { name: 'Roles' });
      await expect(roles.getByText('e2eAuditor', { exact: true })).toBeVisible({ timeout: 8000 });
      await expect(roles.getByLabel('Edit role e2eAuditor')).toBeVisible();
    });
  });
});
