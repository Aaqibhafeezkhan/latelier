import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { baseConnInput, startMemoryServer, stopAllMemoryServers } from '../helpers/e2eApp';

const here = path.dirname(fileURLToPath(import.meta.url));

test.afterAll(stopAllMemoryServers);

/**
 * collapsing the query drawer overwrote the user's preferred width with
 * the 4% collapsed rail, so reopening gave back a sliver that then survived a
 * relaunch. Binding ⌘B to collapse turned that from a rare annoyance into a constant one.
 *
 * This has to be an e2e. jsdom has no layout engine, so `react-resizable-panels`
 * never produces the collapsed layout there — a component test toggling the
 * drawer writes the *seeded* value and passes identically against the broken
 * code. Real Electron has real widths, and the bug reproduces.
 */
test('collapsing the query drawer does not destroy its stored width', async () => {
  const { host, port } = await startMemoryServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-e2e-'));

  const app = await electron.launch({
    args: [path.resolve(here, '../..', 'dist-electron/main.js')],
    env: { ...process.env, ATELIER_USER_DATA_DIR: userDataDir, NODE_ENV: 'test' },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // Seed a collection tab so the drawer is on screen at all. Connected, not
    // just created — X16.5 renders a "not connected" placeholder
    // instead of the builder pane for a Dormant Connection, and this test's
    // subject (the drawer's stored width) only exists on the real pane.
    await win.evaluate(async (input) => {
      const api = (window as unknown as {
        atelier: {
          conn: { create: (i: unknown) => Promise<{ id: string }> };
          mongo: { connect: (id: string) => Promise<unknown> };
          tabs: {
            openCollection: (input: {
              connectionId: string;
              dbName: string;
              collection: string;
            }) => Promise<{ id: string }>;
          };
          prefs: { set: (key: string, value: unknown) => Promise<unknown> };
        };
      }).atelier;
      const c = await api.conn.create(input);
      await api.mongo.connect(c.id);
      await api.tabs.openCollection({
        connectionId: c.id,
        dbName: 'db',
        collection: 'orders',
      });
      await api.prefs.set('ui.workspace.innerHSplit', 30);
    }, baseConnInput(host, port));
    await win.reload();
    await win.waitForLoadState('domcontentloaded');

    const collapseNotch = win.getByRole('button', { name: 'Collapse Query Builder' });
    await expect(collapseNotch).toBeVisible({ timeout: 15_000 });

    const readSplit = () =>
      win.evaluate(async () => {
        const api = (window as unknown as {
          atelier: { prefs: { get: (key: string) => Promise<unknown> } };
        }).atelier;
        return api.prefs.get('ui.workspace.innerHSplit');
      });

    await collapseNotch.click();
    await expect(win.getByRole('button', { name: 'Open Query Builder' })).toBeVisible();

    // The regression: the collapsed rail width used to land here.
    const afterCollapse = await readSplit();
    expect(typeof afterCollapse).toBe('number');
    expect(afterCollapse as number).toBeGreaterThanOrEqual(15);

    await win.getByRole('button', { name: 'Open Query Builder' }).click();
    await expect(collapseNotch).toBeVisible();

    // Checked before the width, and the order matters. Reopening at the rail
    // width is what *writes* the rail width back — the panel sits at 4% while
    // `builderCollapsed` is already false, so a guard that trusts that flag
    // hands the sliver to `prefs.set` as if the user had chosen it. That is
    // what made the narrow drawer sticky rather than merely annoying.
    const afterReopen = await readSplit();
    expect(afterReopen as number).toBeGreaterThanOrEqual(15);

    // And it comes back usable. Measured on the drawer's own tablist rather
    // than the panel element: this version of `react-resizable-panels` renders
    // a bare `data-panel` with no id, and the tablist width is what the user
    // is actually complaining about.
    const drawer = win.getByRole('tablist', { name: 'Query drawer' });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(120);

    // Off Documents the drawer shuts without writing the pref, and Documents
    // gets it back at the same width.
    const subTabs = win.locator('[role="tablist"][aria-label="Collection view"]');
    await subTabs.getByRole('tab', { name: /Aggregation/ }).click();
    await expect(drawer).toBeHidden();
    await expect(win.getByRole('button', { name: /Query Builder$/ })).toHaveCount(0);
    // A stray press on the inert divider must not mark the restore below as the user's split.
    const divider = win.getByRole('separator', { name: 'Resize Query Builder' });
    await divider.dispatchEvent('pointerdown');
    await divider.focus();
    await win.keyboard.press('ArrowLeft');
    await subTabs.getByRole('tab', { name: /Documents/ }).click();
    await expect(drawer).toBeVisible();
    await win.waitForTimeout(300);
    const back = await drawer.boundingBox();
    expect(Math.abs(back!.width - box!.width)).toBeLessThanOrEqual(2);
    expect(await readSplit()).toBe(afterReopen);
    const collapsedPref = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: { prefs: { get: (key: string) => Promise<unknown> } };
      }).atelier;
      return api.prefs.get('ui.workspace.builderCollapsed');
    });
    expect(collapsedPref).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
