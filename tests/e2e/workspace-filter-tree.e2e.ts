import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs, seedDocuments } from './helpers/uiSeed';
import { expectConsoleClean, expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * W13 §11 — the end-to-end proof for the filter tree editor. Builds
 * a nested `(a AND (b OR c))` filter entirely through the drawer's own
 * add-condition / add-group / logic-picker controls, runs it, then hand-edits
 * the query bar to an `$elemMatch` clause — a shape the pre-W13 builder could
 * never compile — and confirms the drawer degrades to an editable raw clause
 * (§2) rather than disabling, and that Run still works from there.
 */
test('filter tree editor: build a nested filter in the drawer, run it, then hand-edit to a raw $elemMatch clause', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Filter Tree Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            // Matches (a AND (b OR c)) via the a+b branch.
            { name: 'match-ab', a: 'x', b: 'y', items: [{ sku: 1 }] },
            // Matches (a AND (b OR c)) via the a+c branch.
            { name: 'match-ac', a: 'x', c: 'z', items: [{ sku: 2 }] },
            // Has "a" but neither "b" nor "c" — excluded.
            { name: 'no-match-a-only', a: 'x', items: [{ sku: 1 }] },
            // Has "b" and "c" but no "a" — excluded.
            { name: 'no-match-bc-only', b: 'y', c: 'z', items: [{ sku: 1 }] },
          ],
        },
      );
      await expectStatusDot(win, 'Filter Tree Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      // The auto-run-on-open fires the base (unfiltered) query. Wait
      // for it to land before driving the drawer — a manual Run racing the
      // auto-run's single-flight guard would silently drop.
      await expect(win.getByText('no-match-bc-only')).toBeVisible({ timeout: 8000 });

      // ─── Build (a AND (b OR c)) in the drawer ─────────────────────────

      // Root group defaults to AND. Add its first condition: a = "x".
      await win.getByRole('button', { name: 'Add condition', exact: true }).click();
      await win.getByPlaceholder('field').nth(0).fill('a');
      await win.getByPlaceholder('value').nth(0).fill('x');

      // Add a nested group as the root's second child.
      await win.getByRole('button', { name: 'Add group', exact: true }).click();

      // The nested group is the second "Group logic" control in the tree —
      // flip it from its AND default to OR.
      const nestedLogic = win.getByRole('radiogroup', { name: 'Group logic' }).nth(1);
      await nestedLogic.getByRole('radio', { name: 'OR', exact: true }).click();

      // Add the nested group's two conditions: b = "y", c = "z". The group is
      // the root's second child, and its add button says so.
      const nestedAddCondition = win.getByRole('button', { name: 'Add condition to group 2', exact: true });
      await nestedAddCondition.click();
      await win.getByPlaceholder('field').nth(1).fill('b');
      await win.getByPlaceholder('value').nth(1).fill('y');

      await nestedAddCondition.click();
      await win.getByPlaceholder('field').nth(2).fill('c');
      await win.getByPlaceholder('value').nth(2).fill('z');

      // The printed filter should now be {"$and":[{"a":...},{"$or":[...]}]}.
      await expect(ws.queryBarTextarea).toHaveValue(
        '{"$and":[{"a":{"$eq":"x"}},{"$or":[{"b":{"$eq":"y"}},{"c":{"$eq":"z"}}]}]}',
      );

      await ws.queryBarRunButton.click();

      await expect(win.getByText('match-ab')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('match-ac')).toBeVisible();
      await expect(win.getByText('no-match-a-only')).not.toBeVisible();
      await expect(win.getByText('no-match-bc-only')).not.toBeVisible();

      // ─── Hand-edit the bar to an $elemMatch clause ────────────────────
      //
      // Pre-W13 this op couldn't compile — the builder disabled itself.
      // W13's parseFilter degrades it to a raw node instead (§2): the
      // drawer stays editable, showing a raw-clause textarea rather than a
      // "Builder disabled" dead end.
      await ws.queryBarTextarea.fill('{"items":{"$elemMatch":{"sku":2}}}');

      const rawClause = win.getByRole('textbox', { name: 'Raw clause 1', exact: true });
      await expect(rawClause).toBeVisible({ timeout: 5000 });
      await expect(rawClause).toHaveValue('{"items":{"$elemMatch":{"sku":2}}}');
      // Not frozen read-only: the "isn't valid JSON" banner must be absent.
      await expect(win.getByText(/isn't valid JSON/)).not.toBeVisible();

      await ws.queryBarRunButton.click();

      await expect(win.getByText('match-ac')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('match-ab')).not.toBeVisible();
      await expect(win.getByText('no-match-a-only')).not.toBeVisible();
      await expect(win.getByText('no-match-bc-only')).not.toBeVisible();
    });
  });
});

/**
 * W13 §3 and §5.7 end to end: a switched-off condition leaves the filter that
 * runs, survives a switch to another tab and back (from the tab's persisted
 * draft), and a negated one runs as NOT against a real mongod.
 */
test('filter tree editor: switch a condition off, keep it across a tab switch, then negate it', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const conn = await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Filter Toggle Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { name: 'doc-xy', a: 'x', b: 'y' },
            { name: 'doc-xz', a: 'x', b: 'z' },
            { name: 'doc-wy', a: 'w', b: 'y' },
          ],
        },
      );
      await seedDocuments(win, {
        connectionId: conn.id,
        dbName: 'shop',
        collection: 'users',
        docs: [{ name: 'user-1' }],
      });
      await expectStatusDot(win, 'Filter Toggle Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText('doc-wy')).toBeVisible({ timeout: 8000 });

      // ─── a = x AND b = y: one row ─────────────────────────────────────
      const addCondition = win.getByRole('button', { name: 'Add condition' }).first();
      await addCondition.click();
      await win.getByPlaceholder('field').nth(0).fill('a');
      await win.getByPlaceholder('value').nth(0).fill('x');
      await addCondition.click();
      await win.getByPlaceholder('field').nth(1).fill('b');
      await win.getByPlaceholder('value').nth(1).fill('y');
      await expect(ws.queryBarTextarea).toHaveValue('{"$and":[{"a":{"$eq":"x"}},{"b":{"$eq":"y"}}]}');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('doc-xy')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('doc-xz')).not.toBeVisible();
      await expect(win.getByText('doc-wy')).not.toBeVisible();

      // ─── switch b off: two rows ───────────────────────────────────────
      const includeB = win.getByRole('checkbox', { name: 'Include condition b' });
      await includeB.uncheck();
      await expect(ws.queryBarTextarea).toHaveValue('{"a":{"$eq":"x"}}');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('doc-xz')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('doc-xy')).toBeVisible();
      await expect(win.getByText('doc-wy')).not.toBeVisible();

      // ─── another tab and back: b is still there, still off ───────────
      // `shop` is already expanded, so the collection row is clicked directly.
      await ws.collectionRow('shop', 'users').click();
      await expect(ws.tabByName('users')).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });
      await expect(win.getByPlaceholder('field')).toHaveCount(0);

      await ws.tabByName('orders').click();
      await expect(ws.tabByName('orders')).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });
      await expect(win.getByPlaceholder('field').nth(1)).toHaveValue('b');
      await expect(includeB).not.toBeChecked();

      // ─── b back on, then NOT b: only a = x with b ≠ y ────────────────
      await includeB.check();
      await expect(ws.queryBarTextarea).toHaveValue('{"$and":[{"a":{"$eq":"x"}},{"b":{"$eq":"y"}}]}');
      await win.getByRole('button', { name: 'Condition options 2', exact: true }).click();
      await win.getByRole('menuitem', { name: 'Negate (NOT)' }).click();
      await expect(ws.queryBarTextarea).toHaveValue(
        '{"$and":[{"a":{"$eq":"x"}},{"$nor":[{"b":{"$eq":"y"}}]}]}',
      );

      await ws.queryBarRunButton.click();
      await expect(win.getByText('doc-xz')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('doc-xy')).not.toBeVisible();
      await expect(win.getByText('doc-wy')).not.toBeVisible();
    });
  });
});

/**
 * W15 §14.3 and §14.8 end to end: a starter row and the chip editor build
 * filters a real mongod runs. The case-insensitive starter relies on `(?i)`,
 * PCRE's inline flag, which only a real server can confirm.
 */
test('filter tree editor: starters and chips build filters that run', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Filter Starter Target' },
        {
          dbName: 'shop',
          collection: 'people',
          docs: [
            { name: 'Alice', tags: ['a'] },
            { name: 'bob', tags: ['b'] },
            { name: 'ALINA', tags: ['c'] },
          ],
        },
      );
      await expectStatusDot(win, 'Filter Starter Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'people');
      await expect(win.getByText('bob')).toBeVisible({ timeout: 8000 });

      // ─── Contains text (any case): name ~ (?i)ali ─────────────────────
      await win.getByRole('button', { name: 'Contains text (any case)' }).click();
      await expect(win.getByPlaceholder('field')).toBeFocused();
      await win.getByPlaceholder('field').fill('name');
      await win.getByPlaceholder('value').fill('(?i)ali');
      await expect(ws.queryBarTextarea).toHaveValue('{"name":{"$regex":"(?i)ali"}}');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('ALINA')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('Alice')).toBeVisible();
      await expect(win.getByText('bob')).not.toBeVisible();

      // ─── Reset, confirmed ─────────────────────────────────────────────
      await win.getByRole('button', { name: 'Reset' }).click();
      await expect(win.getByRole('dialog')).toBeVisible({ timeout: 4000 });
      await win.getByRole('dialog').getByRole('button', { name: 'Reset' }).click();
      await expect(ws.queryBarTextarea).toHaveValue('{}');

      // ─── One of a list: tags in [a, c], entered as chips ─────────────
      await win.getByRole('button', { name: 'One of a list' }).click();
      await win.getByPlaceholder('field').fill('tags');
      const chips = win.getByRole('combobox', { name: 'Values' });
      await chips.fill('a');
      await chips.press('Enter');
      await chips.fill('c');
      await chips.press('Enter');
      await expect(win.getByRole('button', { name: 'Remove c', exact: true })).toBeVisible();
      await expect(ws.queryBarTextarea).toHaveValue('{"tags":{"$in":["a","c"]}}');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('ALINA')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('Alice')).toBeVisible();
      await expect(win.getByText('bob')).not.toBeVisible();
    });
  });
});
