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
 * W15 §12 case 11 — one flow: set a sort and a limit from the advanced
 * row, run, read them back off the *header* and the *pager* rather than off
 * the inputs that set them, then reload and confirm the whole composition
 * survived.
 *
 * Reading the result surfaces is the point. Asserting the inputs still hold
 * what was typed proves only that a controlled input is controlled; the
 * defect W15 §3.2 describes is precisely the header disagreeing with the
 * query that ran.
 */
test('a sort and a limit set in the advanced row reach the header and the pager, and survive a reload', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Sort And Limit' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'aaa-1', qty: 1 },
            { sku: 'bbb-2', qty: 2 },
            { sku: 'ccc-3', qty: 3 },
          ],
        },
      );
      await expectStatusDot(win, 'Sort And Limit', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      // opening a tab auto-runs the base query. Let it land first.
      await expect(win.getByText('aaa-1')).toBeVisible({ timeout: 8000 });

      // ── The disclosure trigger's focus ring (W15 §5, closing W14 §2). ──
      // Asserted here rather than in a component test because jsdom applies
      // no stylesheet and cannot evaluate `:focus-visible` at all.
      await expect(ws.queryBarAdvanced).toHaveCount(0);
      const outline = () =>
        ws.queryBarAdvancedToggle.evaluate((el) => {
          const s = getComputedStyle(el);
          return { style: s.outlineStyle, width: s.outlineWidth };
        });
      // Loose on purpose: the point is that the ring is not simply always
      // on. Pinning the exact computed serialization of `outline-style: none`
      // would bet the criterion on a UA detail.
      expect((await outline()).style).not.toBe('solid');

      // Reached with a real keyboard press: Chromium's `:focus-visible`
      // heuristic does not fire for a programmatic `.focus()`. The trigger is
      // the focusable immediately before the filter textarea.
      await ws.queryBarTextarea.click();
      await win.keyboard.press('Shift+Tab');
      await expect(ws.queryBarAdvancedToggle).toBeFocused();
      const focused = await outline();
      expect(focused.style).toBe('solid');
      expect(focused.width).toBe('2px');

      // ── Compose: sort descending on `sku`, limit 2. ──
      await ws.queryBarAdvancedToggle.press('Enter');
      await expect(ws.queryBarAdvanced).toBeVisible();

      await ws.queryBarSort.fill('{"sku":-1}');
      await ws.queryBarLimit.fill('2');
      await ws.queryBarRunButton.click();

      // The header agrees with the sort that ran.
      await ws.viewTableButton.click();
      await expect(ws.tableHeader('sku')).toContainText('↓', { timeout: 8000 });
      await expect(ws.tableHeader('sku').getByLabel('sorted descending')).toBeVisible();
      // Nothing was dropped, so the table-level note stays away.
      await expect(ws.tableSortNote).toHaveCount(0);
      // Descending: `ccc-3` is the first row.
      await expect(win.getByText('ccc-3')).toBeVisible();

      // The pager agrees with the limit that ran — 2 of 3 documents.
      await expect(win.getByText(/^1–2 of/)).toBeVisible({ timeout: 8000 });

      // ── Reload and confirm the composition restored. ──
      // `patchCollectionState` writes through a 250ms debounce, so a reload
      // fired immediately would race the write it is meant to be testing.
      await win.waitForTimeout(1200);
      await win.reload();
      await win.waitForLoadState('domcontentloaded');

      await expect(ws.tabByName('orders')).toHaveAttribute('aria-selected', 'true', {
        timeout: 10000,
      });
      // The row re-opens because the restored tab has advanced values set.
      await expect(ws.queryBarAdvanced).toBeVisible({ timeout: 8000 });
      await expect(ws.queryBarSort).toHaveValue('{"sku":-1}');
      await expect(ws.queryBarLimit).toHaveValue('2');
      await expect(ws.queryBarSkip).toHaveValue('0');

      // A restored tab carrying a non-default query does not auto-run,
      // so run it: the assertion that matters is that the restored state
      // still produces the same header and pager.
      await ws.queryBarRunButton.click();
      await expect(ws.tableHeader('sku')).toContainText('↓', { timeout: 8000 });
      await expect(win.getByText(/^1–2 of/)).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('ccc-3')).toBeVisible();
    });
  });
});

/**
 * W15 §3.2 — the other half: a sort the header *cannot* draw must
 * still say something. `{ $meta: … }` is valid Mongo and runs, and
 * `parseSortString` drops it, so before this the header was
 * indistinguishable from an unsorted one.
 */
test('a sort the column arrows cannot express is still announced in the header', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await seedActiveConnectionWithDocs(
      win,
      { ...baseConnInput(host, port), name: 'Unrepresentable Sort' },
      {
        dbName: 'shop',
        collection: 'notes',
        docs: [{ body: 'alpha' }, { body: 'beta' }],
      },
    );
    await expectStatusDot(win, 'Unrepresentable Sort', 'connected');

    const ws = new WorkspacePage(win);
    await ws.openCollectionFromNavigator('shop', 'notes');
    await expect(win.getByText('alpha')).toBeVisible({ timeout: 8000 });

    await ws.viewTableButton.click();
    await expect(ws.tableSortNote).toHaveCount(0);

    await ws.queryBarAdvancedToggle.click();
    await ws.queryBarSort.fill('{"score":{"$meta":"textScore"}}');

    // No column arrow appears anywhere — that is the defect — but the gutter
    // now carries a named note instead of silence.
    await expect(ws.tableSortNote).toBeVisible();
    await expect(
      win.getByLabel('Sorted by a rule this header cannot show'),
    ).toBeVisible();
  });
});
