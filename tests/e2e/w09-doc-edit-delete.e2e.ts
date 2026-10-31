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
 * W09 — Document insert + edit + delete via the workspace doc toolbar and
 * TreeView per-row buttons. (DeleteMany requires the multi-doc confirmation
 * flow which is also a separate surface.)
 */
test('doc writes: insert adds a row; edit changes a field; delete removes the row', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Writes Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { _id: 1, sku: 'before-edit', status: 'pending' },
            { _id: 2, sku: 'to-be-deleted', status: 'pending' },
          ],
        },
      );
      await expectStatusDot(win, 'Writes Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('before-edit')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('to-be-deleted')).toBeVisible();

      // ── Insert ──────────────────────────────────────────────────────────
      // Toolbar Insert button (visible "+ Insert", aria-label
      // "Insert document") opens the Document Editor in insert mode. Its own
      // primary action is just "Insert" so the regex below distinguishes
      // them — we want the toolbar one here.
      await win.getByRole('button', { name: /Insert document/ }).click();

      const insertDialog = win.getByRole('dialog', { name: 'Insert document' });
      await expect(insertDialog).toBeVisible({ timeout: 5000 });

      // Fields is the default view (W18 §2); switch to JSON to paste the
      // whole document the way the drawer's textarea used to take it.
      await insertDialog.getByRole('radiogroup', { name: 'View' }).getByText('JSON', { exact: true }).click();
      const insertBox = insertDialog.getByRole('textbox', { name: 'Document JSON' });
      await insertBox.fill('{"_id": 3, "sku": "fresh-insert", "status": "pending"}');

      // The editor's primary "Insert" button is the only "Insert" rendered.
      await win.getByRole('button', { name: /^Insert$/ }).click();

      // Editor closes, run reruns automatically. New row appears.
      await expect(win.getByText('fresh-insert')).toBeVisible({ timeout: 8000 });

      // ── Edit ────────────────────────────────────────────────────────────
      // Per-row Edit button: the pencil button named "Edit document" in TreeView.
      await win.getByRole('button', { name: /^Edit document/ }).first().click();

      // The Document Editor opens, one labelled input per field.
      const editor = win.getByRole('dialog', { name: 'Edit document' });
      await expect(editor).toBeVisible({ timeout: 5000 });
      await editor.getByRole('textbox', { name: 'status' }).fill('shipped');
      await editor.getByRole('button', { name: 'Save' }).click();

      // The editor closes and the query re-runs.
      await expect(editor).not.toBeVisible({ timeout: 8000 });
      await expect(win.getByText('shipped')).toBeVisible({ timeout: 8000 });

      // ── Delete ──────────────────────────────────────────────────────────
      // Per-row Delete: the trash-icon button named "Delete document".
      // Its accessible name is "Delete document", which won't collide with
      // the DeleteConfirm dialog's button (whose accessible name is "Delete").
      // Click on the row containing 'to-be-deleted' to target that doc's
      // delete button — `.first()` of the matched row's children.
      await win.getByRole('button', { name: /^Delete document/ }).nth(1).click();

      // DeleteConfirm dialog: button with exact text "Delete" — unique on the
      // page when the dialog is open (per-row buttons name is "Delete document").
      await expect(win.getByText('Delete document?')).toBeVisible({ timeout: 4000 });
      await win.getByRole('button', { name: 'Delete', exact: true }).click();

      // Re-run happens via onDeleted (Workspace.tsx:1830). The deleted row's
      // sku is gone; the edited row remains.
      await expect(win.getByText('to-be-deleted')).not.toBeVisible({ timeout: 8000 });
      await expect(win.getByText('before-edit')).toBeVisible();
    });
  });
});

/**
 * The Document Editor saves a diff: this proves the save only touches the
 * field the user changed, leaving the others on the document untouched, and
 * that `E` on the focused Tree row opens the editor.
 */
test('doc writes: E opens the editor; a number edit saves one field and leaves the others untouched', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Update Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [{ _id: 10, sku: 'multi-field', status: 'pending', qty: 5 }],
        },
      );
      await expectStatusDot(win, 'Update Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('multi-field')).toBeVisible({ timeout: 8000 });

      // `E` on the focused result tree opens the editor on its active row.
      const results = win.getByRole('tree', { name: 'Documents' });
      await results.focus();
      await win.keyboard.press('e');
      const editor = win.getByRole('dialog', { name: 'Edit document' });
      await expect(editor).toBeVisible({ timeout: 5000 });

      await editor.getByRole('textbox', { name: 'qty' }).fill('6');
      // ⌘↵ / Ctrl+↵ saves from anywhere in the editor.
      await win.keyboard.press('ControlOrMeta+Enter');
      await expect(editor).not.toBeVisible({ timeout: 8000 });

      // Scoped to the result tree (the navigator is a tree too): an exact
      // digit page-wide would also match the ResultBar's query duration.
      await expect(results.getByText('6', { exact: true }).first()).toBeVisible({ timeout: 8000 });
      // Load-bearing: fields the user never touched survive — the save is a
      // diff, not a full-document rewrite.
      await expect(results.getByText('multi-field')).toBeVisible();
      await expect(results.getByText('pending')).toBeVisible();
    });
  });
});
