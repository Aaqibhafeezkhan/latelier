import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  baseConnInput,
  freshUserData,
  startMemoryServer,
  stopAllMemoryServers,
  withAppOnUserData,
} from '../helpers/e2eApp';
import { ConnectionSwitcherPage, NewConnectionPage, WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * F06 §4 and §6: a tab edit waits 250ms before it is saved. Quitting, or
 * closing the window, inside that wait must still save it, and a reload away
 * from the Workspace must not make quitting forget a dirty pipeline.
 */

const CONN_NAME = 'Flush Target';

/** Quit from main on the next tick, so the evaluate itself returns before the app goes. */
const requestQuit = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });

/** Close the main window the way the user's X does, on the next tick. */
const requestWindowClose = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 0);
  });

const windowCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** Resolves with the exit code once the app's process is gone. */
const exited = (app: ElectronApplication): Promise<number | null> =>
  new Promise((resolve) => app.process().once('exit', (code) => resolve(code)));

/** Records each quit-dialog message in main and answers with the button given (0 Cancel, 1 Quit). */
async function stubQuitDialog(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    const g = globalThis as unknown as { __quitDialogs: string[] };
    g.__quitDialogs = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as {
        message: string;
      };
      g.__quitDialogs.push(options.message);
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}

const dialogMessages = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __quitDialogs: string[] }).__quitDialogs);

/** Opens `shop.orders` in the UI and types a filter, leaving it inside the 250ms debounce. */
async function typeFilter(app: ElectronApplication, host: string, port: number): Promise<void> {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await seedActiveConnectionWithDocs(
    win,
    { ...baseConnInput(host, port), name: CONN_NAME },
    { dbName: 'shop', collection: 'orders', docs: [{ sku: 'apple-001' }] },
  );
  await expectStatusDot(win, CONN_NAME, 'connected');
  const ws = new WorkspacePage(win);
  await ws.openCollectionFromNavigator('shop', 'orders');
  await expect(win.getByText('apple-001')).toBeVisible({ timeout: 8000 });
  await ws.queryBarTextarea.fill('{"n":7}');
}

/** The shutdown lines main logged about the renderer flush, from every log file in `userDataDir`. */
function flushLogLines(userDataDir: string): Array<{ level: string; msg: string; data?: { outcome?: string } }> {
  const dir = path.join(userDataDir, 'logs');
  return fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { level: string; tag: string; msg: string; data?: { outcome?: string } })
    .filter((l) => l.tag === 'shutdown' && /flush/.test(l.msg));
}

/** After a relaunch: the saved tab holds the filter, and the reopened tab shows it. */
async function expectFilterRestored(win: Page): Promise<void> {
  await win.waitForLoadState('domcontentloaded');
  const saved = await win.evaluate(async () => {
    const api = (window as unknown as {
      atelier: { tabs: { list: () => Promise<Array<{ collection: string; state: { queryRaw?: string } }>> } };
    }).atelier;
    return (await api.tabs.list()).map((t) => ({ collection: t.collection, queryRaw: t.state.queryRaw }));
  });
  expect(saved).toEqual([{ collection: 'orders', queryRaw: '{"n":7}' }]);

  await new ConnectionSwitcherPage(win).select(CONN_NAME);
  await expectStatusDot(win, CONN_NAME, 'connected', 10_000);
  await expect(new WorkspacePage(win).queryBarTextarea).toHaveValue('{"n":7}', { timeout: 8000 });
}

test('an edit typed just before quitting is saved and comes back on relaunch', async () => {
  const { host, port } = await startMemoryServer();
  const userDataDir = freshUserData();
  try {
    await withAppOnUserData(userDataDir, async (app) => {
      await typeFilter(app, host, port);
      const gone = exited(app);
      await requestQuit(app);
      expect(await gone).toBe(0);
    });
    // The edit could also have reached the database through its own debounce
    // during a slow teardown; this pins that the quit asked and was answered.
    expect(flushLogLines(userDataDir).map((l) => ({ level: l.level, outcome: l.data?.outcome }))).toEqual([
      { level: 'info', outcome: 'flushed' },
    ]);
    await withAppOnUserData(userDataDir, async (app) => {
      await expectFilterRestored(await app.firstWindow());
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Off macOS the window's close quits the app, and by `before-quit` there is
// no window left to ask, so the page's own `pagehide` flush is what saves the
// edit. On macOS the app outlives the window and is quit afterwards.
test('an edit typed just before the window closes is saved and comes back on relaunch', async () => {
  const { host, port } = await startMemoryServer();
  const userDataDir = freshUserData();
  try {
    await withAppOnUserData(userDataDir, async (app) => {
      await typeFilter(app, host, port);
      const gone = exited(app);
      await requestWindowClose(app);
      if (process.platform === 'darwin') {
        await expect.poll(() => windowCount(app), { timeout: 5000 }).toBe(0);
        await requestQuit(app);
      }
      expect(await gone).toBe(0);
    });
    await withAppOnUserData(userDataDir, async (app) => {
      await expectFilterRestored(await app.firstWindow());
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

// The Workspace reports dirty pipelines while it is mounted; a reload drops
// that report. Main recounts from the saved tabs, so quitting from a page
// without the Workspace still names the pipeline that "Reopen tabs" off loses.
test('after a reload away from the Workspace, quitting still names a dirty pipeline', async () => {
  const userDataDir = freshUserData();
  try {
    await withAppOnUserData(userDataDir, async (app) => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.evaluate(async (conn) => {
        const api = (window as unknown as {
          atelier: {
            conn: { create: (input: unknown) => Promise<{ id: string }> };
            tabs: {
              openCollection: (input: { connectionId: string; dbName: string; collection: string }) => Promise<{ id: string }>;
              update: (id: string, patch: unknown) => Promise<unknown>;
            };
            prefs: { set: (key: string, value: unknown) => Promise<unknown> };
          };
        }).atelier;
        const c = await api.conn.create(conn);
        const tab = await api.tabs.openCollection({ connectionId: c.id, dbName: 'shop', collection: 'orders' });
        await api.tabs.update(tab.id, {
          state: {
            aggregation: { stages: [], activeStageId: null, outputHeight: 260, outputView: 'Tree', dirty: true },
          },
        });
        await api.prefs.set('ui.workspace.restoreTabs', false);
      }, baseConnInput('127.0.0.1', 27017));

      const form = new NewConnectionPage(win);
      await win.evaluate(() => {
        window.location.hash = '#/connections/new';
      });
      await expect(form.nameInput).toBeVisible({ timeout: 8000 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.reload());
      await win.waitForLoadState('domcontentloaded');
      await expect(form.nameInput).toBeVisible({ timeout: 8000 });
      expect(await win.evaluate(() => window.location.hash)).toBe('#/connections/new');

      await stubQuitDialog(app, 0);
      await requestQuit(app);
      await expect.poll(() => dialogMessages(app), { timeout: 10_000 }).toHaveLength(1);
      expect((await dialogMessages(app))[0]).toContain('1 pipeline');

      await stubQuitDialog(app, 1);
      const gone = exited(app);
      await requestQuit(app);
      expect(await gone).toBe(0);
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
