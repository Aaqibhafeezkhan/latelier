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
 * W14 §9 — a case-insensitive collation set in the options row reaches the
 * find and the count alike: the mixed-case row shows, and the total says so.
 * A count that dropped the collation would still say 1.
 */
test('a case-insensitive collation matches the mixed-case row, and the count agrees', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Find Options' },
        {
          dbName: 'shop',
          collection: 'people',
          docs: [{ name: 'Ada' }, { name: 'ada' }, { name: 'Bob' }],
        },
      );
      await expectStatusDot(win, 'Find Options', 'connected');

      const ws = new WorkspacePage(win);
      // The rows, not the filter drawer, which shows the filter's own value.
      const rows = win.getByTestId('h-result');
      await ws.openCollectionFromNavigator('shop', 'people');
      await expect(rows.getByText('"Bob"', { exact: true })).toBeVisible({ timeout: 8000 });

      // Without a collation the match is binary: only the lower-case row.
      await ws.queryBarTextarea.fill('{"name":"ada"}');
      await ws.queryBarRunButton.click();
      await expect(rows.getByText('"Bob"', { exact: true })).toHaveCount(0, { timeout: 8000 });
      await expect(rows.getByText('"ada"', { exact: true })).toBeVisible();
      await expect(rows.getByText('"Ada"', { exact: true })).toHaveCount(0);
      await expect(win.getByText('1 results', { exact: true })).toBeVisible();

      await ws.queryBarAdvancedToggle.click();
      await expect(ws.queryBarAdvanced).toBeVisible();
      const collation = win.locator('[data-testid="query-bar-collation"]');
      await collation.fill('{"locale":"en","strength":2}');
      await expect(collation).toHaveValue('{"locale":"en","strength":2}');
      await ws.queryBarRunButton.click();

      await expect(rows.getByText('"Ada"', { exact: true })).toBeVisible({ timeout: 8000 });
      await expect(rows.getByText('"ada"', { exact: true })).toBeVisible();
      await expect(win.getByText('2 results', { exact: true })).toBeVisible();
    });
  });
});
