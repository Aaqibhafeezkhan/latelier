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
 * A06 — Explain plan. Build a valid pipeline, click Explain, and verify the
 * ExplainDrawer (`role="dialog"` + `aria-label="Explain plan"`,
 * `Aggregation/ExplainDrawer.tsx:92`) opens with content.
 */
test('explain plan: drawer opens with the dialog and renders plan content', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Explain Target' },
        { dbName: 'shop', collection: 'orders', docs: [{ sku: 'a' }, { sku: 'b' }] },
      );
      await expectStatusDot(win, 'Explain Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      // Aggregation sub-tab, scoped to the Collection view strip: since
      // X16.2 a workspace tab is named for its collection *and* its
      // Connection, so an unscoped /Aggregation/ can match two tabs.
      await ws.tablist.getByRole('tab', { name: /Aggregation/ }).click();
      await expect(win.getByText('Pipeline', { exact: true })).toBeVisible({ timeout: 5000 });

      // Add $match so the pipeline is valid (Explain is disabled until
      // `validation.ok` — `AggregationTab.tsx:441`).
      await win.getByRole('button', { name: /Add stage/ }).first().click();
      await win.getByRole('textbox', { name: 'Search stages' }).fill('match');
      await win.getByText('$match', { exact: true }).first().click();
      // Stage body editor (T2.4, CodeMirror 6) — the first stage added to an
      // empty pipeline gets id 1, so this locator is unique and stable.
      const matchBody = win.locator('[data-testid="stage-body-editor-1"] .cm-content');
      await expect(matchBody).toBeVisible({ timeout: 5000 });
      await matchBody.click();
      // Select-all + Backspace to clear the op's default scaffold body first
      // — CM's `closeBrackets` wraps a live *selection* in brackets rather
      // than replacing it, so typing over the selection directly would
      // leave the old body's brackets in place.
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await win.keyboard.press('Backspace');
      await win.keyboard.type('{}');

      // Click Explain in the toolbar. `exact` matters: this connection is
      // named "Explain Target", and the TitleBar's Connection name is itself
      // a button (the Connection Switcher trigger). Playwright's
      // `name` is a case-insensitive substring match by default, so without
      // `exact` this resolves to both buttons and fails strict mode.
      await win.getByRole('button', { name: 'Explain', exact: true }).click();

      // ExplainDrawer is a dialog with `aria-label="Explain plan"`.
      const drawer = win.getByRole('dialog', { name: 'Explain plan' });
      await expect(drawer).toBeVisible({ timeout: 8000 });

      // The "Verbosity" select is a stable child of the drawer.
      await expect(drawer.locator('[aria-label="Verbosity"]')).toBeVisible();

      // X15 — the plan output relies on `flex: 1` against the drawer
      // body's flex context, which Mantine's plain padded body does not
      // supply on its own. The component suite CANNOT catch this: jsdom does
      // no layout, so removing the `styles={{ content, body }}` block leaves
      // every one of those tests green. This is the only place it is visible.
      // Measured on body-vs-content rather than on the plan element, so it
      // does not depend on whether the drawer opens in Raw or Tree mode.
      // Measured values: 92.5% with the flex context, 44.5% without — the
      // threshold sits between them rather than at an arbitrary round number.
      const bodyFillPct = await win.evaluate(() => {
        const content = document.querySelector('.mantine-Drawer-content') as HTMLElement;
        const body = content?.querySelector('.mantine-Drawer-body') as HTMLElement | null;
        if (!content || !body) return 0;
        return (body.getBoundingClientRect().height / content.getBoundingClientRect().height) * 100;
      });
      expect(bodyFillPct).toBeGreaterThan(50);

      // The stage tree: at executionStats verbosity each row carries the
      // stage's own figures. A `$match: {}` over an unindexed collection
      // plans as a collection scan.
      await drawer.getByLabel('Verbosity').selectOption('executionStats');
      const stageTree = drawer.getByRole('list', { name: 'Plan stages' });
      await expect(stageTree).toBeVisible({ timeout: 8000 });
      await expect(stageTree).toContainText('COLLSCAN');
      await expect(stageTree).toContainText('docsExamined: 2');

      // Close via the explicit close button. X15 T6 moved the drawer onto
      // Mantine, so the bespoke `aria-label="Close explain"` ✕ is gone and the
      // close control is Mantine's, labelled "Close" like every other dialog.
      await drawer.getByRole('button', { name: 'Close' }).click();
      await expect(drawer).not.toBeVisible({ timeout: 4000 });
    });
  });
});
