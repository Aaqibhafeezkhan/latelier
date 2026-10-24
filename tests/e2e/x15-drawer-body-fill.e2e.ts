import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';

test.afterAll(stopAllMemoryServers);

/**
 * The Document Editor is capped at 80vh and scrolls its field list inside
 * that, with the header and the Save row fixed.
 *
 * This lives in e2e because jsdom does no layout: every
 * `getBoundingClientRect()` there returns zeroes, so a dialog that grows past
 * the viewport is invisible to the component suite by construction.
 *
 * Mutation: drop the Modal's `styles={{ content, body }}` flex column in
 * `DocumentEditor` and the surface stops shrinking under the cap, so the
 * field list never scrolls and the dialog overflows the short window.
 */
test('the Document Editor stays inside a short window and scrolls its fields', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const wide: Record<string, unknown> = { _id: 1, sku: 'widget' };
    for (let i = 0; i < 60; i++) wide[`field_${i}`] = `value ${i}`;
    await seedActiveConnectionWithDocs(
      win,
      { ...baseConnInput(host, port), name: 'Fill Check' },
      { dbName: 'shop', collection: 'orders', docs: [wide] },
    );

    const ws = new WorkspacePage(win);
    await ws.openCollectionFromNavigator('shop', 'orders');
    await ws.queryBarRunButton.click();
    await expect(win.getByText('widget').first()).toBeVisible({ timeout: 8000 });

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1280, 420);
    });
    await win.getByRole('button', { name: /^Edit document/ }).first().click();
    const editor = win.getByRole('dialog', { name: 'Edit document' });
    await expect(editor).toBeVisible({ timeout: 5000 });

    await expect
      .poll(async () =>
        win.evaluate(() => {
          const panel = document.querySelector('[role="dialog"]') as HTMLElement;
          // The field list scrolls inside a wrapper it shares with the filter
          // box, so measure the list's nearest scrolling ancestor.
          let scroller = panel.querySelector('[role="list"]') as HTMLElement;
          while (getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement as HTMLElement;
          return {
            overflows: panel.getBoundingClientRect().bottom > window.innerHeight + 1,
            scrolls: scroller.scrollHeight > scroller.clientHeight,
          };
        }),
      )
      .toEqual({ overflows: false, scrolls: true });

    await expect(editor.getByRole('button', { name: 'Save' })).toBeInViewport();
  });
});
