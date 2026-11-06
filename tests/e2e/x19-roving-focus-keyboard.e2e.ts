import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean, expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

// Default page size (`PAGE_SIZE_OPTIONS`/`DEFAULT_COLLECTION_TAB_STATE` in
// `workspaceTabs.ts`) is 50 — seeded exactly at that so the query's one page
// holds every doc without touching the LIMIT field, and the 1280x800 default
// window (`electron/main.ts`'s `DEFAULT_BOUNDS`) is nowhere near tall enough
// to mount all 50 24px rows plus `overscanCount={8}` either side. Confirmed
// below rather than assumed — the first assertion of the virtualization test
// IS "row 49 isn't mounted yet"; if that ever stopped being true (a taller
// default window, a shorter row), the test fails loudly there instead of
// silently proving nothing.
const DOC_COUNT = 50;

function orderDocs(): Array<{ seq: number }> {
  return Array.from({ length: DOC_COUNT }, (_, i) => ({ seq: i }));
}

/**
 * Presses Tab up to `maxPresses` times, stopping the instant `target` has
 * focus. Returns whether it got there, and (via `sawRoles`) every `role`
 * value focus passed through on the way — the second half of "exactly one
 * tab stop for the widget": if the grid were reachable but so was some row
 * along the way, this fails on `sawRoles` even though `reached` is true.
 */
async function tabUntilFocused(
  win: Page,
  target: Locator,
  maxPresses: number,
): Promise<{ reached: boolean; sawRoles: string[] }> {
  const sawRoles: string[] = [];
  for (let i = 0; i < maxPresses; i++) {
    const isTarget = await target.evaluate((el) => el === document.activeElement).catch(() => false);
    if (isTarget) return { reached: true, sawRoles };
    const role = await win.evaluate(() => document.activeElement?.getAttribute('role') ?? null);
    if (role) sawRoles.push(role);
    await win.keyboard.press('Tab');
  }
  const isTarget = await target.evaluate((el) => el === document.activeElement).catch(() => false);
  return { reached: isTarget, sawRoles };
}

/**
 * #72 — the tests below all open the same seeded table before doing their
 * own thing with it; this was a byte-identical block (SonarCloud flagged it
 * as a self-duplicate) apart from the connection name. Pure mechanical
 * hoist: same awaits, same order, nothing added or dropped — each test
 * still does its own post-open assertions (the grid-visibility check is
 * only in the first test, deliberately). `withRovingFocusTable` below wraps
 * this together with everything that surrounds it.
 */
async function openSeededRovingFocusTable(
  win: Page,
  host: string,
  port: number,
  connectionName: string,
): Promise<{ grid: Locator; row: (i: number) => Locator }> {
  await seedActiveConnectionWithDocs(
    win,
    { ...baseConnInput(host, port), name: connectionName },
    { dbName: 'shop', collection: 'orders', docs: orderDocs() },
  );
  await expectStatusDot(win, connectionName, 'connected');

  const ws = new WorkspacePage(win);
  await ws.openCollectionFromNavigator('shop', 'orders');
  // Setup only — switching view is not the feature under test, so a click
  // here doesn't undercut "keyboard-only" below, matching
  // `conn-switcher-keyboard.e2e.ts`'s own convention of clicking to reach
  // the widget, then going keyboard-only once there. No Run click: the
  // auto-run on open is the only query run. A second one used to land its
  // result mid-test on a slow CI runner, replacing `documents` and
  // resetting the active row (PR #122's shard 4: 49 ArrowDowns ended on
  // row 48).
  await ws.viewTableButton.click();

  const grid = win.getByRole('grid', { name: 'Documents' });
  const row = (i: number) => win.locator(`#table-row-${i}`);
  return { grid, row };
}

/**
 * #60 — `openSeededRovingFocusTable` above hoisted the *seeding*; everything
 * around it stayed copied. By the third test the memory server, the app
 * window, the `domcontentloaded` wait and the `expectConsoleClean` wrapper
 * were a third identical prologue, and SonarCloud flagged the span. Same
 * mechanical hoist as #72's: same awaits, same order, nothing added or
 * dropped. Each test keeps its own visibility assertions afterwards — the
 * first one asserts more than the other two, deliberately.
 */
async function withRovingFocusTable(
  connectionName: string,
  body: (ctx: { win: Page; grid: Locator; row: (i: number) => Locator }) => Promise<void>,
): Promise<void> {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const { grid, row } = await openSeededRovingFocusTable(win, host, port, connectionName);
      await body({ win, grid, row });
    });
  });
}

/**
 * #20's roving-focus driver, driven with the keyboard alone against a real
 * Electron window and a real `mongodb-memory-server` — no `.click()` once
 * the grid itself is reached.
 *
 * The component suite (`table-view.spec.tsx`) already covers the
 * `aria-activedescendant` contract in isolation. What it cannot cover
 * honestly is virtualization: jsdom's `offsetWidth`/`offsetHeight` shim
 * (`tests/helpers/jsdomSetup.ts`) is sized so react-window renders the
 * *whole* list, which is exactly the condition #20 exists to handle
 * correctly when it's false. Only a real window has a real viewport height,
 * real `overscanCount` math, and a real `listRef.scrollToRow` — this test
 * seeds enough documents that some are provably unmounted at rest, then
 * proves the newly-active one is mounted and on-screen after moving to it.
 */
test('table roving focus: keyboard-only navigation, including a row virtualization forces unmounted', async () =>
  withRovingFocusTable('Roving Focus Target', async ({ win, grid, row }) => {
    await expect(grid).toBeVisible({ timeout: 8000 });

    // Confirms the query actually returned and rendered rows before the
    // "row 49 isn't mounted" premise below is asserted — otherwise that
    // assertion would trivially pass against an empty, not-yet-loaded grid.
    await expect(row(0)).toBeVisible({ timeout: 8000 });

    // 1. The grid is reachable by Tab, and nothing with role="row" ever
    // takes focus along the way — exactly one tab stop for the widget.
    const { reached, sawRoles } = await tabUntilFocused(win, grid, 60);
    expect(reached).toBe(true);
    expect(sawRoles).not.toContain('row');
    await expect(grid).toBeFocused();
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-0');

    // Confirm the premise the virtualization assertion below depends on,
    // rather than assuming it: with 50 docs seeded, the last row must NOT
    // be mounted at rest. If this fails, the window/row-height math this
    // file's docs comment above relies on no longer holds — DOC_COUNT (or
    // the window size) needs revisiting, not the assertion below deleted.
    await expect(row(DOC_COUNT - 1)).toHaveCount(0);

    // 2. ArrowDown moves the active descendant one row at a time.
    await win.keyboard.press('ArrowDown');
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-1');
    await win.keyboard.press('ArrowUp');
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-0');

    // 3. End jumps to the last row — the virtualization case. The row
    // must exist in the DOM (react-window actually scrolled to mount it,
    // not just moved an index that names nothing) — a dropped or
    // made-async `scrollToRow` call would leave it absent instead. #62 —
    // it must also land fully on-screen, not merely mounted: on the first
    // jump, 47 intervening rows have never rendered, so
    // `useDynamicRowHeight` (TableView.tsx) still has each at its 24px
    // default estimate, and `scrollToRow({index: 49, align: 'auto'})`
    // computes its target offset from those estimates — landing the row
    // clipped off the bottom. `toBeInViewport({ ratio: 1 })` is the
    // regression test for that: `toBeVisible` alone would pass against a
    // half-clipped row.
    await win.keyboard.press('End');
    await expect(grid).toHaveAttribute('aria-activedescendant', `table-row-${DOC_COUNT - 1}`);
    await expect(row(DOC_COUNT - 1)).toBeInViewport({ ratio: 1 });

    // Home jumps back to the first row, scrolling it back into view too —
    // and, unlike End above, row 0 was already measured, so this is the
    // clean case: fully mounted AND fully back on-screen.
    await win.keyboard.press('Home');
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-0');
    await expect(row(0)).toBeInViewport({ ratio: 1 });

    // 4. Enter on the grid itself selects the active row (`aria-selected`
    // on the row itself) — no click, no per-row focus, just the
    // container's own key handling acting on whichever row is active.
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
    await expect(row(1)).toHaveAttribute('aria-selected', 'true');
    await expect(row(0)).toHaveAttribute('aria-selected', 'false');
  }));

/**
 * #62 — the acceptance criteria on this issue cover more than the single
 * `End` jump: "also holds for a long ArrowDown run that crosses unmeasured
 * rows". This does NOT reproduce #62 and is green before the fix too: each
 * `ArrowDown` moves by one row, so there's never an unmeasured span for
 * react-window's estimate to drift over — confirmed in the round that added
 * this test, not assumed. It's a regression guard for the long-ArrowDown
 * path specifically (a fresh grid, so every row past the initial mounted
 * range is genuinely unmeasured, unlike the test above where `End`/`Home`
 * have already measured a chunk of the list), not evidence the fix holds
 * for the general case — the `End` test above is what actually proves that.
 */
// #133 — the wheel (or PageDown) scrolls the focused grid natively, so the
// active row can unmount. Shift+F10 used to find no row element and silently
// do nothing; it must still open the row menu and bring the row back.
test('table: Shift+F10 opens the row menu after the wheel scrolled the active row out', async () =>
  withRovingFocusTable('Roving Focus Scrolled Out', async ({ win, grid, row }) => {
    await expect(row(0)).toBeVisible({ timeout: 8000 });
    await tabUntilFocused(win, grid, 60);
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-0');

    await grid.hover();
    await win.mouse.wheel(0, 4000);
    await expect(row(0)).toHaveCount(0);
    await expect(grid).toBeFocused();

    await win.keyboard.press('Shift+F10');
    await expect(win.getByRole('group', { name: 'Cell actions' })).toBeVisible();
    await expect(row(0)).toBeInViewport();
  }));

test('table roving focus: a long ArrowDown run lands fully in the viewport, not just mounted', async () =>
  withRovingFocusTable('Roving Focus ArrowDown Run', async ({ win, grid, row }) => {
    await expect(row(0)).toBeVisible({ timeout: 8000 });
    await tabUntilFocused(win, grid, 60);
    await expect(grid).toBeFocused();

    for (let i = 0; i < DOC_COUNT - 1; i++) {
      await win.keyboard.press('ArrowDown');
    }
    await expect(grid).toHaveAttribute('aria-activedescendant', `table-row-${DOC_COUNT - 1}`);
    await expect(row(DOC_COUNT - 1)).toBeInViewport({ ratio: 1 });
  }));

/**
 * #62 — `TreeView.tsx` wires the identical `useDynamicRowHeight` +
 * `scrollToRow({ align: 'auto' })` pattern through the same
 * `useRovingFocus` driver as `TableView`, so the fix belongs in the shared
 * hook rather than either view. This proves it actually holds there too,
 * not just in the view the issue happened to be filed against.
 */
test('tree roving focus: End lands the last row fully in the viewport', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Roving Focus Tree' },
        { dbName: 'shop', collection: 'orders', docs: orderDocs() },
      );
      await expectStatusDot(win, 'Roving Focus Tree', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      // The auto-run on open is the only query run. A second Run click used to
      // land its result mid-test on a slow CI runner, replacing `documents`
      // and resetting the active row (PR #122's shard 4).
      await ws.viewTreeButton.click();

      const tree = win.getByRole('tree', { name: 'Documents' });
      const row = (i: number) => win.locator(`#tree-row-${i}`);
      await expect(row(0)).toBeVisible({ timeout: 8000 });
      await tabUntilFocused(win, tree, 60);
      await expect(tree).toBeFocused();

      // Collapsed rows default to 44px (`TreeView.tsx`'s own comment) in an
      // 800px window — well short of mounting all 50, so this is the same
      // "most rows never rendered" premise the table test confirms directly.
      await expect(row(DOC_COUNT - 1)).toHaveCount(0);

      await win.keyboard.press('End');
      await expect(tree).toHaveAttribute('aria-activedescendant', `tree-row-${DOC_COUNT - 1}`);
      await expect(row(DOC_COUNT - 1)).toBeInViewport({ ratio: 1 });
    });
  });
});

/**
 * Found in review, and only a real browser exposes it honestly: a `<div
 * tabIndex={-1}>` is excluded from *sequential* (Tab) focus per the HTML
 * focusing-steps algorithm, but is still click-focusable — jsdom's
 * `fireEvent.click` (used throughout the component suite) does no focus
 * management at all, so 48 passing component tests never caught a real
 * click leaving DOM focus on the row itself. From there every later
 * keydown reached the grid's `onKeyDown` with `e.target` = the row, not the
 * grid, and its own-target guard swallowed Arrow/Home/End until focus moved
 * again by hand. Playwright's `.click()` drives Chromium's actual focusing
 * steps, so this is the one place that regression can be caught for real.
 */
test('table roving focus: a real click does not trap focus on the row — ArrowDown still moves the grid afterward', async () =>
  withRovingFocusTable('Click Focus Target', async ({ win, grid, row }) => {
    await expect(row(0)).toBeVisible({ timeout: 8000 });

    // The click also makes row 1 the active row — not just clickable —
    // so the very next Arrow continues from there, not from row 0.
    await row(1).click();
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-1');

    await win.keyboard.press('ArrowDown');
    await expect(grid).toBeFocused();
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-2');
  }));

/**
 * The table case above, for the tree view and for the field tree an expanded
 * document mounts. A row that declares any `tabIndex` (even -1) takes focus
 * on a real click, and from there the container's own-target guard swallows
 * the next Arrow — which jsdom's `fireEvent.click` cannot show.
 */
async function withClickedTreeFixture(
  connectionName: string,
  body: (ctx: { win: Page; ws: WorkspacePage }) => Promise<void>,
): Promise<void> {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: connectionName },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: Array.from({ length: 5 }, (_, i) => ({ seq: i, sku: `sku-${i}` })),
        },
      );
      await expectStatusDot(win, connectionName, 'connected');
      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await ws.viewTreeButton.click();
      await body({ win, ws });
    });
  });
}

test('tree roving focus: a real click does not trap focus on the row — ArrowDown still moves the tree afterward', async () =>
  withClickedTreeFixture('Tree Click Focus', async ({ win }) => {
    const tree = win.getByRole('tree', { name: 'Documents' });
    await expect(win.locator('#tree-row-1')).toBeVisible({ timeout: 8000 });

    await win.locator('#tree-row-1').click();
    await expect(tree).toHaveAttribute('aria-activedescendant', 'tree-row-1');

    await win.keyboard.press('ArrowDown');
    await expect(tree).toBeFocused();
    await expect(tree).toHaveAttribute('aria-activedescendant', 'tree-row-2');
  }));

test('field tree roving focus: a real click on a field row does not trap focus — ArrowDown still moves the field tree', async () =>
  withClickedTreeFixture('Field Tree Click Focus', async ({ win }) => {
    await expect(win.locator('#tree-row-0')).toBeVisible({ timeout: 8000 });
    await win.getByRole('button', { name: 'Expand document' }).first().click();

    const fieldRows = win.locator('[id^="field-row-"]');
    await expect(fieldRows.nth(1)).toBeVisible();
    const fieldTree = fieldRows.first().locator('xpath=ancestor::*[@role="tree"][1]');

    await fieldRows.first().click();
    await expect(fieldTree).toHaveAttribute('aria-activedescendant', (await fieldRows.first().getAttribute('id')) ?? '');

    await win.keyboard.press('ArrowDown');
    await expect(fieldTree).toBeFocused();
    await expect(fieldTree).toHaveAttribute('aria-activedescendant', (await fieldRows.nth(1).getAttribute('id')) ?? '');
  }));

/**
 * Every resize separator that is not a react-resizable-panels one opts in to
 * `.resize-separator`, whose `:focus-visible` rule paints the accent colour.
 * jsdom evaluates no stylesheet, so only a real window can show the paint.
 */
test('table column separator: Tab-focusing it paints the accent background', async () =>
  withRovingFocusTable('Separator Focus Target', async ({ win, row }) => {
    await expect(row(0)).toBeVisible({ timeout: 8000 });
    const separator = win.getByRole('separator', { name: /^Resize .* column$/ }).first();
    await expect(separator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    const { reached } = await tabUntilFocused(win, separator, 60);
    expect(reached).toBe(true);
    await expect(separator).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }));

/**
 * X19 #60 — `table-view.spec.tsx` already proves the active-row outline is
 * set as an inline style; that's the source of truth for whether the code
 * decided to paint it, but it's not proof the browser actually paints it.
 * Only a real window's `getComputedStyle` closes that gap, and only a real
 * `ArrowDown` proves the paint moves rather than sticking to row 0.
 */
test('table roving focus: the active row\'s outline is actually painted, and moves with the arrow keys', async () =>
  withRovingFocusTable('Outline Paint Target', async ({ win, grid, row }) => {
    await expect(row(0)).toBeVisible({ timeout: 8000 });

    // No outline anywhere before the grid has focus. `outline-width`
    // itself is the wrong property to assert "no outline" with — unlike
    // `border-width`, a browser's computed `outline-width` does NOT
    // collapse to 0 when `outline-style` is `none` (confirmed against
    // this real Chromium: it reported "3px", the platform default
    // `medium`, even with no `outline` style ever set). `outline-style`
    // is the property that actually reflects whether anything paints.
    await expect(row(0)).toHaveCSS('outline-style', 'none');

    const { reached } = await tabUntilFocused(win, grid, 60);
    expect(reached).toBe(true);
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-0');
    await expect(row(0)).toHaveCSS('outline-style', 'solid');
    await expect(row(0)).toHaveCSS('outline-width', '2px');
    await expect(row(1)).toHaveCSS('outline-style', 'none');

    await win.keyboard.press('ArrowDown');
    await expect(grid).toHaveAttribute('aria-activedescendant', 'table-row-1');
    await expect(row(1)).toHaveCSS('outline-style', 'solid');
    await expect(row(1)).toHaveCSS('outline-width', '2px');
    await expect(row(0)).toHaveCSS('outline-style', 'none');
  }));
