import { test, expect, type Page } from '@playwright/test';
import { baseConnInput, startMemoryServer, stopAllMemoryServers, withApp } from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean, expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * The toolbars' geometry, which only a real layout can show: jsdom reports every
 * width as zero. "Does not clip" is measured here: each control's rect against
 * its bar, and scrollWidth against clientWidth.
 */
const SIZES: Array<[number, number]> = [
  [900, 600],
  [1024, 768],
  [1100, 800],
  [1280, 800],
  [1440, 900],
];

const DOCS = Array.from({ length: 60 }, (_, n) => ({ n, status: n % 3 ? 'paid' : 'open', total: n * 3.5 }));

interface BarReading {
  overflow: number;
  clipped: string[];
  left: Record<string, number>;
  heights: number[];
  barHeight: number;
}

function readBar(win: Page, testId: string): Promise<BarReading> {
  return win.evaluate((id) => {
    const bar = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!bar) throw new Error(`no ${id} on screen`);
    const barRect = bar.getBoundingClientRect();
    const clipped: string[] = [];
    const left: Record<string, number> = {};
    const heights: number[] = [];
    for (const el of bar.querySelectorAll<HTMLElement>('button, [class*="SegmentedControl-root"]')) {
      const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
      const r = el.getBoundingClientRect();
      // A blank pill is a control narrower than its content, or one outside its bar.
      if (el.scrollWidth > el.clientWidth + 1 || r.right > barRect.right + 1 || r.width < 16) clipped.push(name);
      left[name] = Math.round(r.left);
      if (el.tagName === 'BUTTON') heights.push(Math.round(r.height));
    }
    return { overflow: bar.scrollWidth - bar.clientWidth, clipped, left, heights, barHeight: Math.round(barRect.height) };
  }, testId);
}

// The count has to stay readable: an ellipsis inside the slot shows on no control's rect.
function countIsCut(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const count = document.querySelector<HTMLElement>('[data-testid="result-count-slot"] > span');
    if (!count) throw new Error('no count on screen');
    return count.scrollWidth > count.clientWidth;
  });
}

// The memory server is shared across this file, so each test seeds its own database.
let seeded = 0;

async function open(win: Page) {
  const server = await startMemoryServer();
  const dbName = `toolbar${++seeded}`;
  await seedActiveConnectionWithDocs(
    win,
    { ...baseConnInput(server.host, server.port), name: 'Toolbar' },
    { dbName, collection: 'orders', docs: DOCS },
  );
  await expectStatusDot(win, 'Toolbar', 'connected');
  await new WorkspacePage(win).openCollectionFromNavigator(dbName, 'orders');
  await expect(win.getByTestId('result-bar')).toBeVisible({ timeout: 8000 });
}

test('results toolbar never clips, and a stale query changes nothing about it', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await open(win);
      const input = win.getByTestId('query-bar-input');
      for (const [width, height] of SIZES) {
        await win.setViewportSize({ width, height });
        await win.waitForTimeout(300);
        const fresh = await readBar(win, 'result-bar');
        expect(fresh.overflow, `${width}: bar overflow`).toBeLessThanOrEqual(0);
        expect(fresh.clipped, `${width}: clipped`).toEqual([]);
        expect(fresh.barHeight, `${width}: one row`).toBe(44);
        expect(await countIsCut(win), `${width}: count cut`).toBe(false);

        await input.fill('{ bad:');
        await expect(win.getByTestId('result-count-stale')).toBeVisible();
        const stale = await readBar(win, 'result-bar');
        expect(stale.clipped, `${width}: clipped when stale`).toEqual([]);
        expect(stale.left, `${width}: stale moved a control`).toEqual(fresh.left);
        expect(await countIsCut(win), `${width}: count cut when stale`).toBe(false);
        // From the default window up there is room to say it whole.
        const label = await win.getByTestId('result-count-stale').evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            text: el.scrollWidth,
            box: el.clientWidth,
            slot: el.parentElement?.clientWidth,
            bar: el.closest('[data-testid="result-bar"]')?.clientWidth,
            font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
          };
        });
        expect(
          label.text > label.box && width >= 1280,
          `${width}: "not current" cut ${JSON.stringify(label)}`,
        ).toBe(false);

        await input.fill('{}');
        await expect(win.getByTestId('result-count-stale')).toHaveCount(0);
      }
    });
  });
});

test('right-hand controls and row buttons hold still when results change', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await open(win);
      await win.setViewportSize({ width: 1280, height: 800 });
      await win.waitForTimeout(300);
      const anchored = async () => {
        const { left } = await readBar(win, 'result-bar');
        return [left.Fields, left['Insert document'], left.Documents];
      };
      const rowButton = () =>
        win.evaluate(() =>
          Math.round(document.querySelector('[aria-label^="Edit document"]')!.getBoundingClientRect().left),
        );
      const many = await anchored();
      const scrolling = await rowButton();

      // A list that fits: no scrollbar, and a count of a different length.
      await win.getByTestId('query-bar-input').fill('{"n":{"$lt":3}}');
      await win.getByTestId('query-run-btn').click();
      await expect(win.getByRole('tree', { name: 'Documents' }).getByRole('treeitem')).toHaveCount(3, { timeout: 8000 });
      expect(await anchored()).toEqual(many);
      expect(await rowButton()).toBe(scrolling);
    });
  });
});

test('below 1100 px one side panel shows, and focus cannot scroll the pane sideways', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await open(win);
      await win.setViewportSize({ width: 900, height: 600 });

      const openBuilder = win.getByRole('button', { name: 'Open Query Builder', exact: true });
      await expect(openBuilder).toBeVisible();
      await expect(win.getByRole('button', { name: 'Collapse navigator', exact: true })).toBeVisible();

      await openBuilder.click();
      await expect(win.getByRole('button', { name: 'Open navigator', exact: true })).toBeVisible();
      await expect(win.getByRole('tablist', { name: 'Query drawer' })).toBeVisible();
      await win.waitForTimeout(300);
      const drawer = await win.getByRole('tablist', { name: 'Query drawer' }).boundingBox();
      expect(drawer!.width).toBeGreaterThanOrEqual(270);

      const scrolled = () =>
        win.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.scrollLeft > 0).map((e) => e.tagName));
      await win.locator('input[type="radio"][value="Table"]').first().focus();
      await win.waitForTimeout(150);
      expect(await scrolled()).toEqual([]);

      // The wide layout comes back untouched: both panels, the drawer at its stored share.
      await win.setViewportSize({ width: 1280, height: 800 });
      await expect(win.getByRole('button', { name: 'Collapse navigator', exact: true })).toBeVisible();
      await expect(win.getByRole('button', { name: 'Collapse Query Builder', exact: true })).toBeVisible();
      await win.waitForTimeout(300);
      const wide = await win.getByRole('tablist', { name: 'Query drawer' }).boundingBox();
      expect(wide!.width).toBeGreaterThan(260);
      expect(wide!.width).toBeLessThan(290);
    });
  });
});

test('filter status line holds its height, whatever the state', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await open(win);
      const line = win.getByTestId('filter-status-line');
      const read = async () => {
        const box = await line.boundingBox();
        return { height: box!.height, y: box!.y };
      };
      const start = await read();
      expect(start.height).toBe(24);
      await win.getByTestId('query-bar-input').fill('{"status":"paid"}');
      await expect(line).toContainText('match', { timeout: 8000 });
      expect(await read()).toEqual(start);
      await win.getByTestId('query-bar-input').fill('{ bad:');
      await expect(line).toContainText('Invalid text');
      expect(await read()).toEqual(start);
    });
  });
});

test('aggregation bar never clips, and a stage preview does not push the page', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await open(win);
      await new WorkspacePage(win).tablist.getByRole('tab', { name: /Aggregation/ }).click();
      await win.getByRole('button', { name: /Add stage/ }).first().click();
      await win.getByRole('textbox', { name: 'Search stages' }).fill('match');
      await win.getByText('$match', { exact: true }).first().click();
      const body = win.locator('[data-testid="stage-body-editor-1"] .cm-content');
      await body.click();
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await win.keyboard.press('Backspace');
      await win.keyboard.type('{}');

      const stageRow = win.getByTestId('stage-row-1');
      const before = await stageRow.boundingBox();
      await win.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(win.getByText(/5 docs|60 docs/).first()).toBeVisible({ timeout: 8000 });
      await win.waitForTimeout(300);
      expect((await stageRow.boundingBox())!.height).toBe(before!.height);

      for (const [width, height] of SIZES) {
        await win.setViewportSize({ width, height });
        await win.waitForTimeout(300);
        const bar = await readBar(win, 'output-bar');
        expect(bar.overflow, `${width}: bar overflow`).toBeLessThanOrEqual(0);
        expect(bar.clipped, `${width}: clipped`).toEqual([]);
        expect(bar.barHeight, `${width}: one row`).toBe(42);
        // Below some width the editor stacks over its preview instead of shrinking.
        const editor = await win.getByTestId('stage-body-editor-1').boundingBox();
        expect(editor!.width, `${width}: stage editor width`).toBeGreaterThanOrEqual(300);
      }
    });
  });
});
