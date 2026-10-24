import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { freshUserData, withAppOnUserData } from '../helpers/e2eApp';

/**
 * GAP 9 — theme preference round-trips through `app_state` across relaunch,
 * and the `prefs.onThemeChanged` push channel fires on set.
 *
 * Two failures only this test catches:
 *   - A migration drops `app_state` (or the `theme.mode` key encoding
 *     changes), so `getTheme()` returns 'system' on cold start.
 *   - The `prefs:theme-event` channel name drifts or `webContents.send`
 *     races with renderer load — listener is silently dead.
 */
test('theme persists across relaunch + onThemeChanged fires on set', async () => {
  const userDataDir = freshUserData();
  try {
    // --- first launch: assert default, set to dark, observe push event. ---
    await withAppOnUserData(userDataDir, async (app) => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');

      const result = await win.evaluate(async () => {
        const api = (window as unknown as {
          atelier: {
            prefs: {
              getTheme: () => Promise<'light' | 'dark' | 'system'>;
              setTheme: (mode: 'light' | 'dark' | 'system') => Promise<void>;
              onThemeChanged: (
                cb: (mode: 'light' | 'dark' | 'system') => void,
              ) => () => void;
            };
          };
        }).atelier;

        const before = await api.prefs.getTheme();
        const events: Array<'light' | 'dark' | 'system'> = [];
        const unsub = api.prefs.onThemeChanged((m) => events.push(m));
        await api.prefs.setTheme('dark');
        // Allow the IPC event tick to round-trip back through ipcRenderer.on.
        await new Promise((r) => setTimeout(r, 100));
        unsub();
        // After unsub, further sets must not be observed.
        await api.prefs.setTheme('light');
        await new Promise((r) => setTimeout(r, 100));
        const after = await api.prefs.getTheme();
        return { before, events, after };
      });

      // Default on a fresh userData is 'system'.
      expect(result.before).toBe('system');
      // Push channel delivered the dark event before unsubscribe.
      expect(result.events).toContain('dark');
      // Unsub stopped further events; 'light' must NOT be in the list.
      expect(result.events).not.toContain('light');
      // The set still persisted in app_state.
      expect(result.after).toBe('light');
    });

    // --- relaunch: theme survives cold start. ---
    await withAppOnUserData(userDataDir, async (app) => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      const restored = await win.evaluate(async () => {
        const api = (window as unknown as {
          atelier: {
            prefs: { getTheme: () => Promise<'light' | 'dark' | 'system'> };
          };
        }).atelier;
        return api.prefs.getTheme();
      });
      expect(restored).toBe('light');
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

/**
 * Settings → Theme offers System, and the choice survives a relaunch. Starts
 * from 'dark' so System is a real change, not the first-run default.
 */
test('System picked in Settings persists across relaunch', async () => {
  const userDataDir = freshUserData();
  try {
    await withAppOnUserData(userDataDir, async (app) => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.evaluate(() =>
        (window as unknown as { atelier: { prefs: { setTheme: (m: string) => Promise<void> } } })
          .atelier.prefs.setTheme('dark'),
      );

      await win.getByRole('button', { name: 'Open settings' }).click();
      const theme = win.getByRole('radiogroup', { name: 'Theme' });
      await expect(theme.getByRole('radio', { name: 'Dark' })).toBeChecked();
      // The Mantine radio input is visually hidden; its label is what a user clicks.
      await theme.getByText('System', { exact: true }).click();
      await expect(theme.getByRole('radio', { name: 'System' })).toBeChecked();
      await expect
        .poll(() =>
          win.evaluate(() =>
            (window as unknown as { atelier: { prefs: { getTheme: () => Promise<string> } } })
              .atelier.prefs.getTheme(),
          ),
        )
        .toBe('system');
    });

    await withAppOnUserData(userDataDir, async (app) => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.getByRole('button', { name: 'Open settings' }).click();
      await expect(
        win.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System' }),
      ).toBeChecked();
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
