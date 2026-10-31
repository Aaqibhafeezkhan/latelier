import { test, expect } from '@playwright/test';
import { stopAllMemoryServers, withApp } from '../helpers/e2eApp';
import { expectConsoleClean } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * F04 — Command palette. Opening with ⌘K, filtering to a command, and pressing
 * Enter runs it. Also exercises F02 theme toggle via the palette: theme is
 * registered as `theme.toggle` (`src/commands/GlobalCommands.tsx:19`) so this
 * one spec covers both palette wiring and the theme command's effect.
 *
 * Mantine's Spotlight renders its content as `role="dialog"`, but the
 * `aria-label="Command palette"` lands on the hidden modal root — so we anchor
 * the palette on its search input (`aria-label="Search commands"`, forwarded to
 * the input by `SpotlightSearch`; see `CommandPalette.tsx`).
 */
test('command palette: ⌘K opens, "new connection" navigates, theme toggle persists', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      // the Data View is the app's home now. Don't open the
      // Connection Switcher popover first: its search field autofocuses, and
      // Mantine's Spotlight hotkey does not fire while focus sits in another
      // text field, so a stray popover open would silently swallow ⌘K.
      await win.getByRole('button', { name: /^Connection:/ }).waitFor({ state: 'visible' });

      // ── Open palette via ⌘K (Meta on macOS, Ctrl elsewhere) ──────────────
      // The search input carries a stable aria-label; the palette is the dialog
      // that contains it.
      const search = win.locator('input[aria-label="Search commands"]');
      const palette = win.getByRole('dialog').filter({ has: search });
      // On CI this first ⌘K after a cold launch is sometimes lost: the app is
      // fully rendered, the window is focused on <body>, and no palette opens.
      // The cause is not known. Press again while the palette is still closed
      // (never while open, which would toggle it shut).
      await expect(async () => {
        if (!(await palette.isVisible())) {
          await win.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
        }
        await expect(palette).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 8000 });
      await search.fill('new connection');

      // The matching option renders with role="option". "New connection"
      // appears as the command title.
      await expect(palette.getByRole('option', { name: /New connection/ })).toBeVisible();
      await win.keyboard.press('Enter');

      // Palette closes; route navigated to /connections/new (we land on the
      // form, not the list). The Test-connection button is the form anchor.
      await expect(palette).not.toBeVisible({ timeout: 4000 });
      await expect(win.getByRole('button', { name: /Test connection/i })).toBeVisible({
        timeout: 5000,
      });

      // Back to the Data View so we're in a stable state for the
      // theme test — deliberately not reopening the Switcher popover, for
      // the same focus-stealing reason as above.
      await win.getByRole('button', { name: 'Cancel' }).click();
      await win.getByRole('button', { name: /^Connection:/ }).waitFor({ state: 'visible' });

      // ── Theme toggle via the palette ────────────────────────────────────
      // Capture the current theme via IPC so we can confirm the click flipped it.
      const before = await win.evaluate(async () => {
        return (window as unknown as {
          atelier: { prefs: { getTheme: () => Promise<string> } };
        }).atelier.prefs.getTheme();
      });

      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
      await expect(palette).toBeVisible({ timeout: 4000 });
      await search.fill('toggle dark');
      await expect(palette.getByRole('option', { name: /Toggle dark mode/ })).toBeVisible();
      await win.keyboard.press('Enter');
      await expect(palette).not.toBeVisible({ timeout: 4000 });

      // Theme persistence is asynchronous (palette → useTheme → api.prefs.setTheme).
      // Poll until the IPC reflects the flip — `before` was either 'system'/'light'
      // (becomes 'dark') or 'dark' (becomes 'light'); either way the value changes.
      await expect
        .poll(
          async () =>
            win.evaluate(async () => {
              return (window as unknown as {
                atelier: { prefs: { getTheme: () => Promise<string> } };
              }).atelier.prefs.getTheme();
            }),
          { timeout: 4000 },
        )
        .not.toBe(before);
    });
  });
});
