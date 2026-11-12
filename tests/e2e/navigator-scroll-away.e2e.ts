import { test, expect } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { baseConnInput, startMemoryServer, stopAllMemoryServers, withApp } from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean, expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

// With the selected collection near the top of a long navigator, scrolling it
// off screen must leave the tree where the person put it. It used to jump
// back to the selected row on every collection listing the palette's
// background sweep finished, and with this many databases that sweep is still
// running while the test scrolls.
test('scrolling the selected collection out of view does not pull it back', async () => {
  const { host, port } = await startMemoryServer();
  // Enough databases that the tree scrolls well past its viewport.
  const client = await MongoClient.connect(`mongodb://${host}:${port}/?directConnection=true`);
  try {
    for (let i = 0; i < 150; i++) {
      await client.db(`db${String(i).padStart(3, '0')}`).createCollection('c');
    }
  } finally {
    await client.close();
  }

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Many DBs' },
        { dbName: 'aaa', collection: 'orders', docs: [{ n: 1 }] },
      );
      await expectStatusDot(win, 'Many DBs', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('aaa', 'orders');

      const scroller = ws.navigatorTree.locator('[style*="overflow-y: auto"]').first();
      await scroller.hover();
      await win.mouse.wheel(0, 5000);
      await expect(ws.collectionRow('aaa', 'orders')).toBeHidden();

      const scrolled = await scroller.evaluate((el) => el.scrollTop);
      expect(scrolled).toBeGreaterThan(0);
      // Long enough for more of the sweep's listings to land.
      await win.waitForTimeout(1000);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);
    });
  });
});
