import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';

test.afterAll(stopAllMemoryServers);

/**
 * Quitting asks first when a script or a shell command is running, because
 * quitting kills it. The question is a native dialog in main, so it is stubbed
 * from main here: the stub records the message it was given and answers with
 * the button index chosen (0 Cancel, 1 Quit).
 */
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

type Api = {
  conn: { create: (input: unknown) => Promise<{ id: string }> };
  mongo: { connect: (id: string) => Promise<{ status: string }> };
  script: { run: (input: { connectionId: string; source: string }) => Promise<{ valueJson: string }> };
  mshell: {
    start: (input: { connectionId: string }) => Promise<{ sessionId: string }>;
    write: (input: { sessionId: string; data: string }) => Promise<void>;
  };
};

async function connect(win: Page, host: string, port: number): Promise<void> {
  await win.evaluate(
    async ({ host, port, conn }) => {
      const w = window as unknown as { atelier: Api; __connId: string };
      const created = await w.atelier.conn.create({ ...conn, host, port });
      await w.atelier.mongo.connect(created.id);
      w.__connId = created.id;
    },
    { host, port, conn: baseConnInput(host, port) },
  );
}

/** Leaves a script awaiting forever, and returns once it has started. */
async function startLongScript(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as { atelier: Api; __connId: string; __longRun: Promise<unknown> };
    // Not awaited: the script is meant to still be running when the app is asked to quit.
    w.__longRun = w.atelier.script
      .run({
        connectionId: w.__connId,
        source: 'await db.quit_marker.insertOne({ started: 1 }); await new Promise(() => {})',
      })
      .then(
        () => 'finished',
        () => 'stopped',
      );
  });
  // The marker is written once the script has started, so it is surely in flight.
  await expect
    .poll(
      () =>
        win.evaluate(async () => {
          const w = window as unknown as { atelier: Api; __connId: string };
          const r = await w.atelier.script.run({
            connectionId: w.__connId,
            source: 'await db.quit_marker.countDocuments({})',
          });
          return r.valueJson;
        }),
      { timeout: 15_000 },
    )
    .toBe('1');
}

test('quitting with nothing running does not ask', async () => {
  await withApp(async (app) => {
    await stubQuitDialog(app, 0);
    const gone = exited(app);
    await requestQuit(app);
    // The stub would have answered Cancel and kept the app alive: that the
    // process left, cleanly, is the proof that no question was put.
    expect(await gone).toBe(0);
  });
});

test('quitting with a script running asks, stays open on Cancel, and quits on Quit', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await connect(win, host, port);
    await startLongScript(win);

    await stubQuitDialog(app, 0);
    await requestQuit(app);
    await expect.poll(() => dialogMessages(app), { timeout: 10_000 }).toHaveLength(1);
    expect((await dialogMessages(app))[0]).toContain('1 running script');
    // Cancel: the app is still there and still answers.
    expect(await win.evaluate(() => 1 + 1)).toBe(2);

    await stubQuitDialog(app, 1);
    const gone = exited(app);
    await requestQuit(app);
    expect(await gone).toBe(0);
  });
});

test('quitting with a shell command running asks, naming it', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await connect(win, host, port);
    // A line the shell never finishes. Main counts it from the write, so the
    // write having returned means the shell is already busy.
    await win.evaluate(async () => {
      const w = window as unknown as { atelier: Api; __connId: string };
      const session = await w.atelier.mshell.start({ connectionId: w.__connId });
      await w.atelier.mshell.write({ sessionId: session.sessionId, data: 'await new Promise(() => {})\n' });
    });

    await stubQuitDialog(app, 0);
    await requestQuit(app);
    await expect.poll(() => dialogMessages(app), { timeout: 10_000 }).toHaveLength(1);
    expect((await dialogMessages(app))[0]).toContain('1 running shell command');
    expect(await win.evaluate(() => 1 + 1)).toBe(2);

    await stubQuitDialog(app, 1);
    const gone = exited(app);
    await requestQuit(app);
    expect(await gone).toBe(0);
  });
});

// Closing the last window quits the app off macOS, where the question has to
// come before the window goes: after, a Cancel would leave an app with no
// window. On macOS closing the window leaves the app running and stops nothing.
test('closing the window with a script running asks once, keeps the window on Cancel, and quits on Quit', async () => {
  test.skip(process.platform === 'darwin', 'closing the last window does not quit the app on macOS');
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await connect(win, host, port);
    await startLongScript(win);

    await stubQuitDialog(app, 0);
    await requestWindowClose(app);
    await expect.poll(() => dialogMessages(app), { timeout: 10_000 }).toHaveLength(1);
    // Give a second, wrongly raised question the time to show up.
    await new Promise((r) => setTimeout(r, 500));
    expect(await dialogMessages(app)).toHaveLength(1);
    expect(await windowCount(app)).toBe(1);

    await stubQuitDialog(app, 1);
    const gone = exited(app);
    await requestWindowClose(app);
    expect(await gone).toBe(0);
    // Asked once for this close, not again when the app quit that followed it.
  });
});
