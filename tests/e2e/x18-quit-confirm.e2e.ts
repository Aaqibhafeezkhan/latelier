import { test, expect } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
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

const exited = (app: ElectronApplication): Promise<unknown> =>
  new Promise((resolve) => app.process().once('exit', resolve));

test('quitting with nothing running does not ask', async () => {
  await withApp(async (app) => {
    await stubQuitDialog(app, 0);
    const gone = exited(app);
    await requestQuit(app);
    await gone;
    // The process is gone, so the stub's record cannot be read: that the app
    // left although the stub would have answered Cancel is the proof.
  });
});

test('quitting with a script running asks, stays open on Cancel, and quits on Quit', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.evaluate(
      async ({ host, port, conn }) => {
        const api = (window as unknown as {
          atelier: {
            conn: { create: (input: unknown) => Promise<{ id: string }> };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            script: { run: (input: { connectionId: string; source: string }) => Promise<unknown> };
          };
        }).atelier;
        const created = await api.conn.create({ ...conn, host, port });
        await api.mongo.connect(created.id);
        // Not awaited: the script is meant to still be running when the app is asked to quit.
        (window as unknown as { __longRun: Promise<unknown> }).__longRun = api
          .script.run({
            connectionId: created.id,
            source:
              'await db.quit_marker.insertOne({ started: 1 }); await new Promise(() => {})',
          })
          .then(() => 'finished', () => 'stopped');
        (window as unknown as { __connId: string }).__connId = created.id;
      },
      { host, port, conn: baseConnInput(host, port) },
    );

    // The marker is written once the script has started, so it is surely in flight.
    await expect
      .poll(
        () =>
          win.evaluate(async () => {
            const w = window as unknown as {
              __connId: string;
              atelier: {
                script: { run: (i: { connectionId: string; source: string }) => Promise<{ valueJson: string }> };
              };
            };
            const r = await w.atelier.script.run({
              connectionId: w.__connId,
              source: 'await db.quit_marker.countDocuments({})',
            });
            return r.valueJson;
          }),
        { timeout: 15_000 },
      )
      .toBe('1');

    await stubQuitDialog(app, 0);
    await requestQuit(app);
    await expect.poll(() => dialogMessages(app), { timeout: 10_000 }).toHaveLength(1);
    expect((await dialogMessages(app))[0]).toContain('1 running script');
    // Cancel: the app is still there and still answers.
    expect(await win.evaluate(() => 1 + 1)).toBe(2);

    await stubQuitDialog(app, 1);
    const gone = exited(app);
    await requestQuit(app);
    await gone;
  });
});
