import { test, expect, type Locator, type Page } from '@playwright/test';
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
 * A condition row at the drawer's default width left the value box a few
 * characters wide: the mongosh preview sat beside it and took the room the
 * box and its error message needed, and the field box had no floor at all.
 *
 * This has to be an e2e. jsdom has no layout engine, so a component test
 * cannot tell a 30px input from a 300px one.
 */
const MIN_VALUE_WIDTH = 140;
const MIN_FIELD_WIDTH = 96;

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, 'element has a layout box').not.toBeNull();
  return box!.width;
}

/**
 * Fills the `index`th condition row (document order) with an ObjectId that
 * is not one, so the row shows its value error, and measures the row.
 */
async function fillAndMeasure(win: Page, index: number) {
  await win.getByPlaceholder('field').nth(index).fill(`o${index}`);
  await win.locator('input[aria-label="Value type"]').nth(index).click();
  await win.getByRole('option', { name: 'objectid', exact: true }).click();
  const value = win.getByPlaceholder('value').nth(index);
  await value.fill('zzz');

  const describedBy = await value.getAttribute('aria-describedby');
  expect(describedBy, 'the invalid value is described on its input').toBeTruthy();
  const error = win.locator(`[id="${describedBy}"]`);
  await expect(error).toHaveText('ObjectId must be 24 hex characters');

  const valueWidth = await width(value);
  expect(valueWidth).toBeGreaterThanOrEqual(MIN_VALUE_WIDTH);
  expect(await width(error)).toBeGreaterThanOrEqual(valueWidth);
  expect(await width(win.getByPlaceholder('field').nth(index))).toBeGreaterThanOrEqual(MIN_FIELD_WIDTH);
}

test('a condition row keeps its value box, error and field box usable at the default drawer width, nested or not', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await seedActiveConnectionWithDocs(
      win,
      { ...baseConnInput(host, port), name: 'Row Width Target' },
      { dbName: 'shop', collection: 'orders', docs: [{ name: 'doc-1' }] },
    );

    const ws = new WorkspacePage(win);
    await ws.openCollectionFromNavigator('shop', 'orders');
    await expect(win.getByText('doc-1')).toBeVisible({ timeout: 8000 });

    await win.getByRole('button', { name: 'Add condition', exact: true }).click();
    await fillAndMeasure(win, 0);

    await win.getByRole('button', { name: 'Add group', exact: true }).click();
    await win.getByRole('button', { name: 'Add condition to group 2', exact: true }).click();
    await fillAndMeasure(win, 1);
  });
});
