import { test, expect, type Page } from '@playwright/test';
import { stopAllMemoryServers } from '../helpers/e2eApp';
import { withOpenOrders } from './helpers/uiSeed';

test.afterAll(stopAllMemoryServers);

/** ⌘K, then the action list of `shop.orders`. */
async function openOrdersActions(win: Page) {
  const palette = win.locator('[role=dialog]:has(input[role=combobox])');
  const search = palette.locator('input[role="combobox"]');
  await expect(async () => {
    if (!(await palette.isVisible())) await win.keyboard.press('ControlOrMeta+K');
    await expect(palette).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000 });

  await search.fill('shop.orders');
  await expect(palette.getByRole('option').first()).toContainText('shop.orders');
  await win.keyboard.press('Alt+Enter');
  await expect(search).toHaveAttribute('aria-label', 'Filter actions');
  return { palette, search };
}

const ORDERS = [
  { sku: 'apple-001', status: 'paid' },
  { sku: 'banana-002', status: 'pending' },
  { sku: 'cherry-003', status: 'paid' },
];

/**
 * X07 §13.6 — `Filter by field…`: ⌘K, the collection's action list, the
 * field step listing the sampled fields, a field chosen, a value typed in the
 * appended condition (the caret is already there), then a run that the result
 * reflects. Real keys and a real sample: the component test mocks both.
 */
test('palette: Filter by field… appends a condition, a typed value and a run filter the result', async () => {
  await withOpenOrders('Filter By Field Target', ORDERS, 'banana-002', async (win) => {
    const { palette, search } = await openOrdersActions(win);
    await search.fill('filter by field');
    await win.keyboard.press('Enter');

    await expect(search).toHaveAttribute('aria-label', 'Filter fields');
    await expect(palette.getByText('Fields · sampled')).toBeVisible();
    await search.fill('status');
    const status = palette.getByRole('option').filter({ hasText: 'status' }).first();
    await expect(status).toContainText('String', { timeout: 8000 });
    await expect(palette.getByText('Add "status" to the filter (nothing runs)')).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(palette).not.toBeVisible({ timeout: 4000 });

    // The caret waits in the new condition's value box; nothing has run yet.
    const value = win.locator('[data-row-path] input[placeholder="value"]').last();
    await expect(value).toBeFocused({ timeout: 4000 });
    await expect(win.getByText('banana-002')).toBeVisible();
    await win.keyboard.type('pending');

    await win.keyboard.press('ControlOrMeta+Enter');
    await expect(win.getByText('apple-001')).not.toBeVisible({ timeout: 8000 });
    await expect(win.getByText('banana-002')).toBeVisible();
  });
});

/**
 * X07 §13.6 — `Query…` on an empty filter: the palette closes and the caret
 * lands on the builder's `+ Condition`, not back where the palette opened from.
 */
test('palette: Query… leaves the focus in the builder', async () => {
  await withOpenOrders('Query Target', ORDERS, 'banana-002', async (win) => {
    const { palette, search } = await openOrdersActions(win);
    await search.fill('query');
    await expect(palette.getByRole('option').first()).toContainText('Query…');
    await win.keyboard.press('Enter');
    await expect(palette).not.toBeVisible({ timeout: 4000 });

    await expect(win.getByRole('button', { name: 'Add condition' })).toBeFocused({ timeout: 4000 });
    await expect(win.getByText('banana-002')).toBeVisible();
  });
});
