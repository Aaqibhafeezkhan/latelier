import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  failOnCiWhenKeychainMissing,
  selectedStorageBackend,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { NewConnectionPage, WorkspacePage } from './pages';
import { expectConsoleClean } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * X06 — Secrets vault (UI-driven). The existing `secrets-vault.e2e.ts` IPC
 * test verifies the safeStorage round-trip across a relaunch. This spec
 * drives the form: create with a SCRAM password, save, reopen edit, and
 * verify the password field is masked and shows the stored indicator
 * placeholder ("••••• (stored — enter new to replace)" — see
 * `NewConnection.tsx:464`). It also asserts the "Remove stored password"
 * affordance is present.
 *
 * Skips on a developer machine with no usable keychain (Linux without a
 * reachable keyring), and fails on CI, where the runner is set up to provide
 * one. Mirrors the strategy in `secrets-vault.e2e.ts`: probe via IPC
 * `conn.create` with a password and inspect the error code. If
 * `SECRETS_UNAVAILABLE`, the *encrypted* contract under test cannot be
 * exercised on this host. End users on such hosts can still save passwords by
 * opting into the plaintext fallback (issue #4), but that is a separate code
 * path with its own component-level coverage.
 */
test('secrets vault ui: SCRAM password is masked + stored on edit reopen', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // Probe safeStorage availability before driving the UI. Saving with a
    // password through the form swallows the IPC error into a banner, so we
    // can't detect SECRETS_UNAVAILABLE post-hoc — probe up-front instead.
    const probe = await win.evaluate(async (input) => {
      const api = (window as unknown as {
        atelier: {
          conn: {
            create: (i: unknown) => Promise<{ id: string }>;
            delete: (id: string) => Promise<void>;
          };
        };
      }).atelier;
      try {
        const created = await api.conn.create({
          ...input,
          name: 'secrets-probe',
          authMech: 'scram256',
          authUsername: 'probe',
          password: 'probe-password',
        });
        await api.conn.delete(created.id);
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          code: (err as { code?: string }).code,
          message: (err as { message?: string }).message,
        };
      }
    }, baseConnInput(host, port));

    if (!probe.ok && probe.code === 'SECRETS_UNAVAILABLE') {
      failOnCiWhenKeychainMissing(await selectedStorageBackend(app));
      test.skip(
        true,
        'no usable OS keychain on this host (safeStorage is unavailable)',
      );
      return;
    }
    if (!probe.ok) {
      throw new Error(`secrets probe failed unexpectedly: ${JSON.stringify(probe)}`);
    }

    // With a usable keychain the column key is wrapped, and Settings says so.
    await win.getByRole('button', { name: 'Open settings' }).click();
    await expect(win.getByTestId('local-data-protection')).toContainText(
      'encrypted on disk with a key held by the OS keychain',
    );
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('local-data-protection')).toBeHidden();

    await expectConsoleClean(win, async () => {
      const switcher = new WorkspacePage(win).switcher;
      await switcher.waitVisible();
      await switcher.openNew();

      const form = new NewConnectionPage(win);
      await form.waitVisible();

      // General tab — Standard mode + identity.
      await form.selectConnectionType('Standard (mongodb://)');
      await form.nameInput.fill('Vault Target');
      await form.hostnameInput.fill(host);
      await form.portInput.fill(String(port));

      // Auth tab — SCRAM-SHA-256 + username + password. We don't run Test
      // because the memory server has no auth configured; this spec only
      // cares about the secret-storage round-trip, not the probe.
      await form.selectAuthMechanism('SCRAM-SHA-256');
      await win.getByPlaceholder('admin').first().fill('alice');
      await win.locator('input[type="password"]').fill('s3cret-password');

      // Save closes the modal; the new Connection becomes Active over the
      // Data View (there is no more standalone list screen to land on).
      await form.saveButton.click();
      await switcher.waitVisible();
      await expect(switcher.item('Vault Target')).toBeVisible({ timeout: 8000 });

      // Reopen for edit via the row's inline Edit action.
      await switcher.edit('Vault Target');
      await form.waitVisible();
      await form.clickTab('Auth');

      // The password field's placeholder switches to the stored indicator
      // — the actual password is NEVER pre-filled or rendered.
      const storedIndicator = win.getByPlaceholder('••••• (stored — enter new to replace)');
      await expect(storedIndicator).toBeVisible({ timeout: 5000 });

      // Sanity: the input has type=password (masked) and an empty value.
      await expect(storedIndicator).toHaveAttribute('type', 'password');
      await expect(storedIndicator).toHaveValue('');

      // The "Remove stored password" affordance is present.
      await expect(win.getByText('Remove stored password')).toBeVisible();
    });
  }, { nativeCredentialStore: true });
});
