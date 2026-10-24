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

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * `DeleteConfirm` reads its target (connectionId/dbName/collection) live from
 * the Focused Tab at render time, while the document it opened against is
 * state set once at open time. Switching the Focused Tab while the confirm
 * is still open used to leave it open, retargeted at the new tab's
 * collection — so a click on Delete deleted the wrong document from the
 * wrong collection, silently (`{ok:true}`, no log line, no console error).
 * The fix closes every delete dialog on a Focused Tab change; this proves it
 * end to end against the real Electron app and a real `mongod`.
 */
test('switching the Focused Tab while a per-row delete confirm is open closes it, not retargets it', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      // Same `_id` in both collections: a wrong-namespace delete then
      // actually removes a document instead of silently matching nothing.
      const conn = await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Retarget Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [{ _id: 'shared-1' }, { _id: 'o2' }, { _id: 'o3' }],
        },
      );
      await seedDocuments(win, {
        connectionId: conn.id,
        dbName: 'shop',
        collection: 'users',
        docs: [{ _id: 'shared-1' }, { _id: 'u2' }],
      });
      await expectStatusDot(win, 'Retarget Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await ws.queryBarRunButton.click();
      await expect(win.getByText('o2')).toBeVisible({ timeout: 8000 });

      // `shop` is already expanded from the `orders` open above — clicking
      // the DB row again would toggle it closed instead of opening it.
      await ws.collectionRow('shop', 'users').click();
      await expect(ws.tabByName('users')).toHaveAttribute('aria-selected', 'true', {
        timeout: 5000,
      });
      await ws.queryBarRunButton.click();
      await expect(win.getByText('u2')).toBeVisible({ timeout: 8000 });

      // Back to orders (tab 1), open the per-row delete confirm on it.
      await ws.tabByName('orders').click();
      await expect(ws.tabByName('orders')).toHaveAttribute('aria-selected', 'true');
      await win.getByRole('button', { name: /^Delete document/ }).first().click();
      await expect(win.getByText('Delete document?')).toBeVisible({ timeout: 5000 });

      // ⌘2/Ctrl+2 jumps to the second tab on screen — users — while the
      // confirm opened against orders is still up.
      await win.keyboard.press(`${MOD}+2`);
      await expect(ws.tabByName('users')).toHaveAttribute('aria-selected', 'true', {
        timeout: 5000,
      });

      // The confirm must close, not silently retarget at users.
      await expect(win.getByText('Delete document?')).not.toBeVisible({ timeout: 5000 });

      // Neither collection lost anything: orders keeps its 3 docs, users its 2.
      const counts = await win.evaluate(async (cid) => {
        const api = (window as unknown as {
          atelier: {
            query: {
              find: (i: {
                connectionId: string;
                dbName: string;
                collection: string;
                filter: string;
                limit: number;
                skip: number;
              }) => Promise<{ documents: unknown[] }>;
            };
          };
        }).atelier;
        const orders = await api.query.find({
          connectionId: cid,
          dbName: 'shop',
          collection: 'orders',
          filter: '{}',
          limit: 100,
          skip: 0,
        });
        const users = await api.query.find({
          connectionId: cid,
          dbName: 'shop',
          collection: 'users',
          filter: '{}',
          limit: 100,
          skip: 0,
        });
        return { orders: orders.documents.length, users: users.documents.length };
      }, conn.id);
      expect(counts).toEqual({ orders: 3, users: 2 });
    });
  });
});

/**
 * The multi-doc gate (`DeleteConfirm`'s type-to-confirm `matchesCollectionName`)
 * is not a backstop here: it compares the collection NAME only. Two tabs on
 * same-named collections in *different* databases keep it satisfied across a
 * retarget, so a fix keyed on "did the collection name change" would miss
 * this case even though the fix above (keyed on the Focused Tab id itself)
 * does not.
 */
test('cross-database tab switch closes the confirm too, even though the collection name stays the same', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const conn = await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Cross-DB Target' },
        { dbName: 'shop', collection: 'orders', docs: [{ _id: 'shared-1' }, { _id: 'o2' }] },
      );
      await seedDocuments(win, {
        connectionId: conn.id,
        dbName: 'depot',
        collection: 'orders',
        docs: [{ _id: 'shared-1' }, { _id: 'd2' }],
      });
      await expectStatusDot(win, 'Cross-DB Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await ws.queryBarRunButton.click();
      await expect(win.getByText('o2')).toBeVisible({ timeout: 8000 });

      await ws.openCollectionFromNavigator('depot', 'orders');
      await ws.queryBarRunButton.click();
      await expect(win.getByText('d2')).toBeVisible({ timeout: 8000 });

      // Both tabs render the same visible name ("orders"), so they aren't
      // distinguishable by name from outside — `.first()` relies on the
      // deterministic open order above (shop opened, then depot).
      await ws.tabByName('orders').first().click();
      await expect(ws.tabByName('orders').first()).toHaveAttribute('aria-selected', 'true', {
        timeout: 5000,
      });
      await win.getByRole('button', { name: /^Delete document/ }).first().click();
      await expect(win.getByText('Delete document?')).toBeVisible({ timeout: 5000 });

      await win.keyboard.press(`${MOD}+2`);
      await expect(win.getByText('Delete document?')).not.toBeVisible({ timeout: 5000 });

      const counts = await win.evaluate(async (cid) => {
        const api = (window as unknown as {
          atelier: {
            query: {
              find: (i: {
                connectionId: string;
                dbName: string;
                collection: string;
                filter: string;
                limit: number;
                skip: number;
              }) => Promise<{ documents: unknown[] }>;
            };
          };
        }).atelier;
        const shop = await api.query.find({
          connectionId: cid,
          dbName: 'shop',
          collection: 'orders',
          filter: '{}',
          limit: 100,
          skip: 0,
        });
        const depot = await api.query.find({
          connectionId: cid,
          dbName: 'depot',
          collection: 'orders',
          filter: '{}',
          limit: 100,
          skip: 0,
        });
        return { shop: shop.documents.length, depot: depot.documents.length };
      }, conn.id);
      expect(counts).toEqual({ shop: 2, depot: 2 });
    });
  });
});
