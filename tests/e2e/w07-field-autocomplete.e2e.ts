import { test, expect, type Page } from '@playwright/test';
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
 * W07 — Field autocomplete. Run a query so the suggestion sources have field
 * data, add a builder condition, focus the field input, click a suggestion,
 * and verify the input filled with the selected field path.
 *
 * SuggestionPopover renders `role="listbox"` (aria-label "Field suggestions")
 * + `role="option"` items (`src/features/fieldSuggestions/SuggestionPopover.tsx`).
 * The aria-label disambiguates it from the builder's "Value type" Select, which
 * also exposes role="listbox".
 */
test('autocomplete: focusing builder field input lists known fields; click fills the input', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Autocomplete Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'apple', stockLevel: 12, status: 'paid' },
            { sku: 'banana', stockLevel: 3, status: 'pending' },
          ],
        },
      );
      await expectStatusDot(win, 'Autocomplete Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      // Run once so suggestions ingest the schema from rendered docs.
      await ws.queryBarRunButton.click();
      await expect(win.getByText('apple')).toBeVisible({ timeout: 8000 });

      // Add a condition row, focus its field input → popover opens on focus
      // (`BuilderPane.tsx:109` — onFocus={() => setFieldPopoverOpen(true)}).
      await win.getByRole('button', { name: 'Add condition' }).click();
      const fieldInput = win.getByPlaceholder('field').first();
      await fieldInput.click();

      // Popover lists known fields. Pick `stockLevel` — unique enough to be
      // unambiguous across the page (the docs themselves render the value, not
      // the path, so the only "stockLevel" text comes from the popover).
      const popover = win.getByRole('listbox', { name: 'Field suggestions' });
      await expect(popover).toBeVisible({ timeout: 4000 });
      await popover.getByRole('option', { name: /stockLevel/ }).first().click();

      // Input now contains the picked field path.
      await expect(fieldInput).toHaveValue('stockLevel');
    });
  });
});

/**
 * Opens `shop.orders` (seeded with `docs`), switches to the Aggregation
 * sub-tab and adds one `$match` stage with an empty body, focused. Mirrors
 * `a01-aggregation-run.e2e.ts`: stage 1's editor is `stage-body-editor-1`,
 * and the scaffold body is cleared with select-all + Backspace because CM's
 * `closeBrackets` wraps a live selection instead of replacing it.
 */
async function openEmptyMatchStage(
  win: Page,
  host: string,
  port: number,
  docs: Record<string, unknown>[],
) {
  await seedActiveConnectionWithDocs(
    win,
    { ...baseConnInput(host, port), name: 'Value Target' },
    { dbName: 'shop', collection: 'orders', docs },
  );
  await expectStatusDot(win, 'Value Target', 'connected');
  const ws = new WorkspacePage(win);
  await ws.openCollectionFromNavigator('shop', 'orders');
  await ws.tablist.getByRole('tab', { name: /Aggregation/ }).click();
  await expect(win.getByText('Pipeline output')).toBeVisible({ timeout: 5000 });
  await win.getByRole('button', { name: /Add stage/ }).first().click();
  await win.getByRole('textbox', { name: 'Search stages' }).fill('match');
  await win.getByText('$match', { exact: true }).first().click();
  const body = win.locator('[data-testid="stage-body-editor-1"] .cm-content');
  await expect(body).toBeVisible({ timeout: 5000 });
  await body.click();
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await win.keyboard.press('Backspace');
  return ws;
}

/**
 * Inside a string in a `$match` body, CodeMirror's completion list offers
 * the field's values from the sampled docs (`sampleValuesSource`). Nothing
 * was run first, so the sample is the only place `pending` can come from.
 */
test('autocomplete: a string value in a $match stage body offers values from the sampled docs', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await openEmptyMatchStage(win, host, port, [
        { sku: 'apple', status: 'paid' },
        { sku: 'banana', status: 'pending' },
      ]);

      // closeBrackets supplies the closing quote and brace.
      await win.keyboard.type('{ status: "pe');

      const completions = win.locator('.cm-tooltip-autocomplete');
      const pending = completions.getByRole('option', { name: /pending/ });
      await expect(pending).toBeVisible({ timeout: 5000 });
      // A click, not Enter: CodeMirror ignores Enter for its `interactionDelay`
      // after the list opens, and Enter in that window inserts a line break.
      await pending.click();
      await expect(
        win.locator('[data-testid="stage-body-editor-1"] .cm-content'),
      ).toHaveText('{ status: "pending"}');
    });
  });
});

/**
 * A successful aggregation run records its leading `$match` values, and the
 * builder's value box offers them for the same field. The value is in no
 * seeded document, so only the recorded history can supply it.
 */
test('autocomplete: a value from an aggregation $match is offered in the builder value box', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const ws = await openEmptyMatchStage(win, host, port, [
        { sku: 'apple', status: 'paid' },
        { sku: 'banana', status: 'pending' },
      ]);
      await win.keyboard.type('{ status: "archived-x');
      // Close the completion list (if any) so Run is not hidden under it.
      await win.keyboard.press('Escape');
      await win.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(win.getByText('Pipeline returned no documents.')).toBeVisible({ timeout: 8000 });

      await ws.tablist.getByRole('tab', { name: /Documents/ }).click();
      await win.getByRole('button', { name: 'Add condition' }).click();
      await win.getByPlaceholder('field').first().fill('status');
      // The field popover stays open over the value box until dismissed.
      await win.keyboard.press('Escape');
      const value = win.getByPlaceholder('value').first();
      await value.click();

      const popover = win.getByRole('listbox', { name: 'Value suggestions' });
      await expect(popover.getByRole('option', { name: /archived-x/ })).toBeVisible({ timeout: 5000 });
    });
  });
});
