import { test, expect, type Page } from '@playwright/test';
import { baseConnInput, startMemoryServer, stopAllMemoryServers, withApp } from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';

test.afterAll(stopAllMemoryServers);

/**
 * The drawer's limits and its condition rows, which only a real layout can
 * show: jsdom reports every width as zero.
 */
async function open(win: Page) {
  const { host, port } = await startMemoryServer();
  await seedActiveConnectionWithDocs(
    win,
    { ...baseConnInput(host, port), name: 'Drawer Limits' },
    { dbName: 'shop', collection: 'orders', docs: [{ name: 'doc-1' }] },
  );
  await new WorkspacePage(win).openCollectionFromNavigator('shop', 'orders');
  await expect(win.getByText('doc-1')).toBeVisible({ timeout: 8000 });
}

const drawerWidth = (win: Page) =>
  win.getByRole('tablist', { name: 'Query drawer' }).evaluate((el) => el.closest('[data-panel]')!.getBoundingClientRect().width);

const groupWidth = (win: Page) =>
  win.getByRole('tablist', { name: 'Query drawer' }).evaluate((el) => el.closest('[data-group]')!.getBoundingClientRect().width);

test('the drawer cannot be dragged narrower than 15% of the split', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.setViewportSize({ width: 1600, height: 900 });
    await open(win);

    // Drag the divider to leave the drawer about 150 px: past a 15 px minimum
    // that would simply stay 150 px wide, while the 15% minimum holds it up
    // (and 150 px is far enough above the collapse point not to collapse it).
    const handle = win.getByRole('separator', { name: 'Resize Query Builder' });
    const box = await handle.boundingBox();
    expect(box, 'the divider has a layout box').not.toBeNull();
    const y = box!.y + 100;
    await win.mouse.move(box!.x + 2, y);
    await win.mouse.down();
    await win.mouse.move(1600 - 150, y, { steps: 15 });
    await win.mouse.up();
    await win.waitForTimeout(300);

    const group = await groupWidth(win);
    expect(await drawerWidth(win)).toBeGreaterThanOrEqual(group * 0.15 - 1);
  });
});

test('a drag to the window edge stops at the minimum, and the toggle still works', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.setViewportSize({ width: 1600, height: 900 });
    await open(win);

    const handle = win.getByRole('separator', { name: 'Resize Query Builder' });
    const box = await handle.boundingBox();
    expect(box, 'the divider has a layout box').not.toBeNull();
    const y = box!.y + 100;
    await win.mouse.move(box!.x + 2, y);
    await win.mouse.down();
    await win.mouse.move(1598, y, { steps: 20 });
    await win.mouse.up();
    await win.waitForTimeout(300);

    const group = await groupWidth(win);
    expect(await drawerWidth(win)).toBeGreaterThanOrEqual(group * 0.15 - 1);

    await win.getByRole('button', { name: 'Collapse Query Builder' }).click();
    await win.getByRole('button', { name: 'Open Query Builder' }).click();
    await expect(win.getByRole('tablist', { name: 'Query drawer' })).toBeVisible();
  });
});

test('a dragged width comes back after the window has been narrow', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.setViewportSize({ width: 1600, height: 900 });
    await open(win);

    const handle = win.getByRole('separator', { name: 'Resize Query Builder' });
    const box = await handle.boundingBox();
    expect(box, 'the divider has a layout box').not.toBeNull();
    const y = box!.y + 100;
    await win.mouse.move(box!.x + 2, y);
    await win.mouse.down();
    await win.mouse.move(box!.x - 120, y, { steps: 15 });
    await win.mouse.up();
    await win.waitForTimeout(300);
    const dragged = await drawerWidth(win);

    await win.setViewportSize({ width: 900, height: 700 });
    await win.waitForTimeout(400);
    await win.setViewportSize({ width: 1600, height: 900 });
    await win.waitForTimeout(400);

    expect(Math.abs((await drawerWidth(win)) - dragged)).toBeLessThanOrEqual(2);
  });
});

test('the shell pane cannot be dragged shorter than 10% of the column', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.setViewportSize({ width: 1600, height: 900 });
    await open(win);

    await win.getByRole('banner').getByRole('button', { name: /Shell/ }).click();
    const handle = win.getByRole('separator', { name: 'Resize shell pane' });
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box, 'the divider has a layout box').not.toBeNull();
    await win.mouse.move(box!.x + 200, box!.y + 2);
    await win.mouse.down();
    await win.mouse.move(box!.x + 200, 898, { steps: 20 });
    await win.mouse.up();
    await win.waitForTimeout(300);

    const { pane, column } = await handle.evaluate((el) => {
      const shell = el.nextElementSibling!.getBoundingClientRect();
      return { pane: shell.height, column: el.closest('[data-group]')!.getBoundingClientRect().height };
    });
    expect(pane).toBeGreaterThanOrEqual(column * 0.1 - 1);
  });
});

test('every control in a condition row stays inside the drawer at 1280, with no sideways scroll', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.setViewportSize({ width: 1280, height: 800 });
    await open(win);

    const overflow = () =>
      win.evaluate(() => {
        const drawer = document.querySelector('[aria-label="Query drawer"]')!.closest('[data-panel]')!;
        const right = drawer.getBoundingClientRect().right;
        const stray = [...drawer.querySelectorAll<HTMLElement>('[data-row-path] button, [data-row-path] input')]
          .filter((el) => el.getBoundingClientRect().right > right + 0.5)
          .map((el) => el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.tagName);
        const scrolling = [...drawer.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
          .map((el) => el.tagName);
        return { stray, scrolling };
      });

    await win.getByRole('button', { name: 'Add condition', exact: true }).click();
    await expect(win.getByRole('button', { name: 'Remove condition' })).toBeVisible();
    expect(await overflow()).toEqual({ stray: [], scrolling: [] });

    // The longest value type has to fit its select too, not only the default one.
    await win.locator('input[aria-label="Value type"]').click();
    await win.getByRole('option', { name: 'objectid', exact: true }).click();
    expect(await overflow()).toEqual({ stray: [], scrolling: [] });

    await win.getByRole('button', { name: 'More ways to add', exact: true }).click();
    await win.getByRole('menuitem', { name: 'Add group', exact: true }).click();
    await win.getByRole('button', { name: 'Add condition to group 2', exact: true }).click();
    expect(await overflow()).toEqual({ stray: [], scrolling: [] });
  });
});
