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
 * Fix for #270: the Document Editor's Fields view used to squeeze a nested
 * container's children onto the same line as its own row (a flex item next
 * to name/value/type/remove), so four levels of nesting scrolled the modal
 * body horizontally — and arrays had no per-element editing at all. This
 * proves both are fixed: deep nesting stays within the modal, and an array
 * of objects edits as expandable `[i]` element rows that save as the whole
 * array.
 */
test('editor nesting: no horizontal overflow at 4 levels deep, and an array element edits and saves', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Nesting Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            {
              _id: 1,
              sku: 'deep-nest',
              level1: { level2: { level3: { level4: 'value4' } } },
              cast: [
                { name: 'Alice', role: 'lead' },
                { name: 'Bob', role: 'support' },
              ],
            },
          ],
        },
      );
      await expectStatusDot(win, 'Nesting Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await ws.queryBarRunButton.click();
      await expect(win.getByText('deep-nest')).toBeVisible({ timeout: 8000 });

      await win.getByRole('button', { name: /^Edit document/ }).first().click();
      const editor = win.getByRole('dialog', { name: 'Edit document' });
      await expect(editor).toBeVisible({ timeout: 5000 });

      // Objects and arrays start expanded, so the 4th-level field and the
      // array's elements are already on screen without any expand clicks.
      const level4 = editor.getByRole('textbox', { name: 'level1.level2.level3.level4' });
      await expect(level4).toBeVisible();

      const fieldsBody = editor.getByTestId('document-editor-fields-body');
      const [scrollWidth, clientWidth] = await fieldsBody.evaluate((el) => [el.scrollWidth, el.clientWidth]);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // Edit an element of the array of objects; the array (not the element)
      // shows the "edited" marker, and Save sends the array whole.
      const castRow = editor.locator('[data-field="cast"]');
      await expect(castRow.getByText('edited', { exact: false })).toHaveCount(0);
      await editor.getByRole('textbox', { name: 'cast.0.name' }).fill('Alicia');
      await expect(castRow.getByText('edited', { exact: false }).first()).toBeVisible();

      await editor.getByRole('button', { name: 'Save' }).click();
      await expect(editor).not.toBeVisible({ timeout: 8000 });
      await expect(win.getByText('Document updated')).toBeVisible({ timeout: 8000 });

      // Re-open and read the stored value back: the edited element saved,
      // and its untouched sibling survived — the array was resent whole,
      // not merged field-by-field, but nothing else in the document changed.
      await win.getByRole('button', { name: /^Edit document/ }).first().click();
      const reopened = win.getByRole('dialog', { name: 'Edit document' });
      await expect(reopened).toBeVisible({ timeout: 5000 });
      await expect(reopened.getByRole('textbox', { name: 'cast.0.name' })).toHaveValue('Alicia');
      await expect(reopened.getByRole('textbox', { name: 'cast.1.name' })).toHaveValue('Bob');
    });
  });
});
