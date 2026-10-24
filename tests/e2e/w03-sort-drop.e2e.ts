import { test, expect } from '@playwright/test';
import { stopAllMemoryServers } from '../helpers/e2eApp';
import { withOpenOrders } from './helpers/uiSeed';

test.afterAll(stopAllMemoryServers);

const ORDERS = [
  { sku: 'cherry-003', qty: 3 },
  { sku: 'apple-001', qty: 1 },
  { sku: 'banana-002', qty: 2 },
];

/**
 * #323 / ADR 0007 item 4 — a field dragged from the results onto the query
 * bar's sort cell sorts by it, ascending. A real drag: jsdom has no native
 * drag-and-drop, so the component spec can only dispatch the drop event.
 */
test('dragging a result field onto Sort sorts by it, ascending', async () => {
  await withOpenOrders('Sort Drop Target', ORDERS, 'cherry-003', async (win, ws) => {
    await ws.queryBarAdvancedToggle.click();
    await expect(ws.queryBarSort).toBeVisible();

    // Documents open collapsed; the field rows are the expanded document's.
    await win.getByRole('button', { name: /^Expand document/ }).first().click();
    const skuRow = win.getByTitle(/Drag to add "sku/).first();
    await expect(skuRow).toBeVisible({ timeout: 8000 });
    await skuRow.dragTo(win.getByTestId('query-bar-sort-drop'));
    await expect(ws.queryBarSort).toHaveValue('{"sku":1}');

    await ws.queryBarRunButton.click();
    const docs = win.getByRole('treeitem', { name: /^Select document/ });
    await expect(docs.first()).toContainText('apple-001', { timeout: 8000 });
    await expect(docs.nth(1)).toContainText('banana-002');
    await expect(docs.nth(2)).toContainText('cherry-003');
  });
});
