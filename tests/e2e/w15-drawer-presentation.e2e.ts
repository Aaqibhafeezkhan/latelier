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
 * W15 §13 — the drawer's presentation, in the real app.
 *
 * The component suite covers each fix in isolation; what only a real
 * Electron window can prove is that the two pieces relying on app-level
 * providers actually mount — Reset's `modals.openConfirmModal` needs the
 * `ModalsProvider` in `App.tsx`, and Mantine's `Tabs` needs real focus and
 * key handling for arrow-key roving. Both are silent no-ops if wired wrong.
 */
test('drawer presentation: Reset confirms, and the tab strip roves with the arrow keys', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Drawer Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'apple-001', status: 'paid' },
            { sku: 'banana-002', status: 'pending' },
          ],
        },
      );
      await expectStatusDot(win, 'Drawer Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('banana-002')).toBeVisible({ timeout: 8000 });

      // ── the empty tree explains itself ────────────────────────────────
      await expect(win.getByText(/matches every document/i)).toBeVisible();

      // Build something worth protecting.
      await win.getByRole('button', { name: 'Add condition' }).click();
      await win.getByPlaceholder('field').first().fill('status');
      await win.getByPlaceholder('value').first().fill('paid');
      const bar = win.getByTestId('query-bar-input');
      await expect(bar).toHaveValue('{"status":{"$eq":"paid"}}');

      // The row's single Remove control names what it removes.
      await expect(
        win.getByRole('button', { name: 'Remove condition status' }),
      ).toBeVisible();

      // ── Reset confirms rather than wiping on one click ────────────────
      await win.getByRole('button', { name: 'Reset' }).click();
      const dialog = win.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 4000 });
      await expect(bar).toHaveValue('{"status":{"$eq":"paid"}}');

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 4000 });
      await expect(bar).toHaveValue('{"status":{"$eq":"paid"}}');

      await win.getByRole('button', { name: 'Reset' }).click();
      await expect(win.getByRole('dialog')).toBeVisible({ timeout: 4000 });
      await win.getByRole('dialog').getByRole('button', { name: 'Reset' }).click();
      await expect(bar).toHaveValue('{}');

      // ── the tab strip is one tab stop that roves ──────────────────────
      const strip = win.getByRole('tablist', { name: 'Query drawer' });
      const filterTab = strip.getByRole('tab', { name: 'Filter' });
      await expect(filterTab).toHaveAttribute('aria-selected', 'true');

      await filterTab.focus();
      await win.keyboard.press('ArrowRight');
      await expect(strip.getByRole('tab', { name: 'Saved' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await win.keyboard.press('ArrowRight');
      await expect(strip.getByRole('tab', { name: 'Recent' })).toHaveAttribute(
        'aria-selected',
        'true',
      );

      // ── a Recent row says what it would re-run ────────────────────────
      // The auto-run on tab open recorded the unfiltered `{}` find.
      await expect(win.getByText('Recent · orders')).toBeVisible({ timeout: 5000 });
      await expect(
        win.getByRole('button', { name: /^Copy MQL to the clipboard$/ }).first(),
      ).toBeVisible({ timeout: 8000 });
    });
  });
});

/**
 * W15 §14.5 / §1.2 — feedback while composing, in the real app: the drawer
 * shows how many documents the filter matches before Run is pressed, and
 * points at where sort / limit / skip / projection are edited.
 */
test('drawer feedback: the match count appears without pressing Run, and the pointer line shows', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Count Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'apple-001', a: 'x' },
            { sku: 'banana-002', a: 'x' },
            { sku: 'cherry-003', a: 'y' },
          ],
        },
      );
      await expectStatusDot(win, 'Count Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('cherry-003')).toBeVisible({ timeout: 8000 });

      await expect(win.getByText(/sort, limit and skip are set in the query bar/i)).toBeVisible();

      await win.getByRole('button', { name: 'Add condition' }).click();
      await win.getByPlaceholder('field').first().fill('a');
      await win.getByPlaceholder('value').first().fill('x');

      // No Run: the count comes from the committed filter alone.
      await expect(win.getByText('≈2 match')).toBeVisible({ timeout: 5000 });
    });
  });
});
