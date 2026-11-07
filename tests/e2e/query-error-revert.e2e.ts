import { test, expect, type Page } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/** Where the results toolbar, the band and whatever fills the pane begin. */
async function layout(win: Page) {
  return win.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top;
    return {
      toolbar: top('[data-testid="result-bar"]'),
      band: top('[data-testid="selection-bar"]'),
      firstRow: top('main [role="treeitem"]'),
    };
  });
}

/**
 * The maintainer's rule for a query that fails: pressing Run replaces the
 * results with the error, whole, with a way back to the last query that worked.
 * And nothing above the pane moves for any of it.
 */
test('Run on a failing query shows the error, Revert restores the last valid query, and nothing shifts', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Revert' },
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

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('banana-002')).toBeVisible({ timeout: 8000 });

      const idle = await layout(win);
      expect(idle.firstRow).toBeDefined();

      // Typing something that cannot parse: rows stay, dimmed; nothing moves.
      await ws.queryBarTextarea.fill('{ bad:');
      await ws.queryBarTextarea.blur();
      await expect(win.locator('#query-bar-filter-error')).toBeVisible();
      await expect(win.getByTestId('result-count-stale')).toBeVisible();
      await expect(win.getByText('banana-002')).toBeVisible();
      expect(await layout(win)).toEqual(idle);

      // Running: the band says so, over no row.
      await ws.queryBarTextarea.fill('{"$where":"sleep(400)||true"}');
      await ws.queryBarTextarea.blur();
      await ws.queryBarRunButton.click();
      await expect(win.getByTestId('selection-bar').getByRole('status')).toHaveText('Running…');
      expect(await layout(win)).toEqual(idle);
      await expect(win.getByTestId('selection-bar').getByRole('status')).toHaveCount(0, { timeout: 8000 });

      // This filter is the last to succeed, so it is what there is to come back to.
      await ws.queryBarTextarea.fill('{"status":"pending"}');
      await ws.queryBarTextarea.blur();
      await ws.queryBarRunButton.click();
      await expect(win.getByText('apple-001')).toHaveCount(0);
      await expect(win.getByText('banana-002')).toBeVisible();
      expect(await layout(win)).toEqual(idle);

      // Run on a query the server refuses: no rows, the whole error, the way back.
      await ws.queryBarTextarea.fill('{"$badOp":1}');
      await ws.queryBarTextarea.blur();
      await ws.queryBarRunButton.click();
      const pane = win.getByTestId('pane-state');
      await expect(pane).toContainText('unknown top level operator: $badOp');
      await expect(win.getByText('banana-002')).toHaveCount(0);
      await expect(win.getByTestId('result-count-failed')).toBeVisible();
      const failed = await layout(win);
      expect(failed.toolbar).toBe(idle.toolbar);
      expect(failed.band).toBe(idle.band);

      // Revert: the query that worked is back in the box and on screen.
      await pane.getByRole('button', { name: 'Revert to last valid query' }).click();
      await expect(win.getByText('banana-002')).toBeVisible();
      await expect(ws.queryBarTextarea).toHaveValue('{"status":"pending"}');
      await expect(pane).toHaveCount(0);
      expect(await layout(win)).toEqual(idle);
    });
  });
});

test('a filter with no match says so, and clearing it brings the rows back', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'No Match' },
        { dbName: 'shop', collection: 'orders', docs: [{ sku: 'apple-001' }] },
      );

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('apple-001')).toBeVisible({ timeout: 8000 });

      await ws.queryBarTextarea.fill('{"sku":"nope"}');
      await ws.queryBarTextarea.blur();
      await ws.queryBarRunButton.click();
      const pane = win.getByTestId('pane-state');
      await expect(pane).toContainText('No matching documents');

      await pane.getByRole('button', { name: 'Clear filter' }).click();
      await expect(win.getByText('apple-001')).toBeVisible();
      await expect(pane).toHaveCount(0);
    });
  });
});
