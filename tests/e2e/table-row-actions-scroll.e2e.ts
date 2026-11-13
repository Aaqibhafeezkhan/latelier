import { test, expect } from '@playwright/test';
import { stopAllMemoryServers } from '../helpers/e2eApp';
import { withOpenOrders } from './helpers/uiSeed';

test.afterAll(stopAllMemoryServers);

/**
 * The Table view's per-row actions column can't use native
 * `position: sticky; right: 0` — its nearest non-`visible`-overflow
 * ancestor is react-window's own `List` element (`[role="grid"]`), which
 * never actually scrolls itself (see `TableView.tsx`'s own comment on
 * `data-testid="table-scroll-container"`). The offset that keeps it pinned
 * under horizontal scroll is computed by hand instead, and nothing but this
 * spec exercises it against a real, laid-out browser — jsdom's component
 * tests have no real box model to catch a wrong formula.
 */
test('Table row actions stay within view while scrolled horizontally, and back', async () => {
  // Enough columns that the grid needs to scroll — each ~160px wide, well
  // past the 1280px default window width once the gutter/actions columns
  // and a dozen fields are laid out.
  const fields = Array.from({ length: 12 }, (_, i) => String.fromCharCode(97 + i, 97 + i)); // 'aa'..'ll'
  const doc: Record<string, string> = { _id: '1' };
  for (const f of fields) doc[f] = `val-${f}`;

  await withOpenOrders('Row Actions Scroll', [doc], 'val-aa', async (win, ws) => {
    await ws.viewTableButton.click();
    await expect(ws.tableHeader('aa')).toBeVisible({ timeout: 5000 });

    const scrollContainer = win.locator('[data-testid="table-scroll-container"]');
    await expect(scrollContainer).toBeVisible();

    // Click a data cell (not a button) to make its row the active row —
    // the same click a keyboard-reachable row would have from Enter/Space,
    // which is what makes the actions column's Edit button reachable at
    // all (it shows on hover, active-row, or focus). By role rather than
    // exact text: the cell's text also carries its expand affordance's glyph.
    await win.getByRole('gridcell', { name: /^val-aa\b/ }).click();

    const editButton = win.getByRole('button', { name: 'Edit document 1' });
    await expect(editButton).toBeVisible();

    const withinContainer = async () => {
      const editBox = await editButton.boundingBox();
      const containerBox = await scrollContainer.boundingBox();
      if (!editBox || !containerBox) return false;
      // A tiny epsilon absorbs sub-pixel rounding between the two boxes.
      return (
        editBox.x >= containerBox.x - 1 &&
        editBox.x + editBox.width <= containerBox.x + containerBox.width + 1
      );
    };

    // Unscrolled: the button already sits at the container's right edge.
    await expect.poll(withinContainer).toBe(true);

    // Scroll the ACTUAL horizontal scroll container (not `[role="grid"]`,
    // which never scrolls itself) all the way right.
    await scrollContainer.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect.poll(withinContainer).toBe(true);

    // ...and back. A formula that only happens to work at one end (e.g. an
    // off-by-`scrollLeft` sign error) would fail exactly one of these three
    // checks, not all of them.
    await scrollContainer.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await expect.poll(withinContainer).toBe(true);
  });
});

/**
 * The expanded detail is a row child, so it used to scroll away with the
 * cells. It is laid out against the scroll container's visible slice instead
 * (`detailLeft`/`detailWidth` in `TableView.tsx`) — again only a laid-out
 * browser can say whether the arithmetic is right.
 */
test('Table expanded detail stays inside the visible box after horizontal scroll', async () => {
  const fields = Array.from({ length: 12 }, (_, i) => String.fromCharCode(97 + i, 97 + i));
  const doc: Record<string, string> = { _id: '1' };
  for (const f of fields) doc[f] = `val-${f}`;

  await withOpenOrders('Detail Scroll', [doc], 'val-aa', async (win, ws) => {
    await ws.viewTableButton.click();
    await expect(ws.tableHeader('aa')).toBeVisible({ timeout: 5000 });

    const scrollContainer = win.locator('[data-testid="table-scroll-container"]');
    await win.getByRole('button', { name: 'Expand document' }).click();
    const detail = win.locator('[data-expanded-doc-section]');
    await expect(detail).toBeVisible();

    const withinContainer = async () => {
      const box = await detail.boundingBox();
      const containerBox = await scrollContainer.boundingBox();
      if (!box || !containerBox) return false;
      return (
        box.x >= containerBox.x - 1 &&
        box.x + box.width <= containerBox.x + containerBox.width + 1
      );
    };

    await expect.poll(withinContainer).toBe(true);

    await scrollContainer.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect.poll(async () => scrollContainer.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(withinContainer).toBe(true);

    // The last row must not be clipped at full scroll (whole-pixel row heights).
    const box = await detail.boundingBox();
    const containerBox = await scrollContainer.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(containerBox!.y + containerBox!.height + 1);
  });
});
