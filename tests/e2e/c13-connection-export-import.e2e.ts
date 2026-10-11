import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { freshUserData, launchApp, startMemoryServer, stopAllMemoryServers } from '../helpers/e2eApp';

/**
 * C13 — export two of three Connections with passwords, import them into a
 * fresh userData with the Export Passphrase, then connect without typing the
 * password again.
 *
 * The native save/open/message dialogs are replaced in the main process by
 * patching Electron's `dialog` object (`app.evaluate`), so no production code
 * path bypasses them. The File menu is installed only in packaged builds, so
 * the palette is the entry point driven here.
 */

const PASSPHRASE = 'correct horse battery';
const OPEN_PALETTE = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

type Atelier = {
  conn: {
    create: (input: unknown) => Promise<{ id: string; name: string }>;
    list: () => Promise<{ id: string; name: string }[]>;
  };
  mongo: { connect: (id: string) => Promise<{ status: string }> };
  secrets: { setPlaintextFallback: (enabled: boolean) => Promise<{ enabled: boolean }> };
};

async function stubDialogs(
  app: ElectronApplication,
  stubs: { savePath?: string; openPath?: string },
): Promise<void> {
  await app.evaluate(({ dialog }, s) => {
    // 'Enable' is button 1 in main's plaintext-fallback warning.
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    if (s.savePath) {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: s.savePath })) as typeof dialog.showSaveDialog;
    }
    if (s.openPath) {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [s.openPath] })) as typeof dialog.showOpenDialog;
    }
  }, stubs);
}

async function runPaletteCommand(win: Page, title: string): Promise<void> {
  await win.keyboard.press(OPEN_PALETTE);
  const search = win.locator('input[aria-label="Search commands"]');
  await expect(search).toBeVisible({ timeout: 4000 });
  await search.fill(title.slice(0, 8));
  await win.getByRole('option', { name: title }).click();
}

test.afterAll(stopAllMemoryServers);

test('export two of three Connections with passwords, import into a fresh profile, connect without re-entering the password', async () => {
  const { host, port } = await startMemoryServer({
    auth: { enable: true, customRootName: 'admin', customRootPwd: 'rootpw' },
  });
  const dirs = [freshUserData(), freshUserData()];
  const exportFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c13-export-')), 'connections.json');
  dirs.push(path.dirname(exportFile));
  const apps: ElectronApplication[] = [];

  const scram = (name: string) => ({
    name,
    color: '#1A6835',
    connectionType: 'standard' as const,
    host,
    port,
    authMech: 'scram256' as const,
    authUsername: 'admin',
    authDatabase: 'admin',
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 5000,
      socketTimeoutMs: 5000,
      serverSelectionTimeoutMs: 5000,
      readPreference: 'primary' as const,
      maxPoolSize: 1,
      directConnection: true,
    },
    password: 'rootpw',
  });
  const noAuth = { ...scram('Gamma'), authMech: 'none' as const, password: undefined, authUsername: undefined };

  try {
    // ---- A: seed three Connections, export two with passwords. ----------
    const appA = await launchApp(dirs[0]!);
    apps.push(appA);
    await stubDialogs(appA, { savePath: exportFile });
    const winA = await appA.firstWindow();
    await winA.waitForLoadState('domcontentloaded');

    const needsFallback = await winA.evaluate(async (inputs) => {
      const api = (window as unknown as { atelier: Atelier }).atelier;
      let fallback = false;
      for (const input of inputs) {
        try {
          await api.conn.create(input);
        } catch (err) {
          if (fallback || (err as { code?: string }).code !== 'SECRETS_UNAVAILABLE') throw err;
          // No OS keychain (Linux CI): opt into the plaintext fallback, as a user would.
          await api.secrets.setPlaintextFallback(true);
          fallback = true;
          await api.conn.create(input);
        }
      }
      return fallback;
    }, [scram('Alpha'), scram('Beta'), noAuth]);
    expect(
      (await winA.evaluate(() => (window as unknown as { atelier: Atelier }).atelier.conn.list())).length,
    ).toBe(3);

    await winA.reload();
    await winA.waitForLoadState('domcontentloaded');
    await runPaletteCommand(winA, 'Export Connections…');
    const exportDialog = winA.getByRole('dialog', { name: 'Export Connections' });
    await expect(exportDialog.getByRole('checkbox', { name: 'Gamma' })).toBeChecked();
    await exportDialog.getByRole('checkbox', { name: 'Gamma' }).uncheck();
    await exportDialog.getByRole('checkbox', { name: 'Include passwords' }).check();
    await exportDialog.getByLabel('Export Passphrase', { exact: true }).fill(PASSPHRASE);
    await exportDialog.getByLabel('Confirm Export Passphrase').fill(PASSPHRASE);
    await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(exportDialog.getByRole('status')).toHaveText('2 Connections written.');

    const written = fs.readFileSync(exportFile, 'utf8');
    expect(written).not.toContain('rootpw');
    expect(written).toContain('Alpha');
    expect(written).not.toContain('Gamma');
    await appA.close();
    apps.pop();

    // ---- B: fresh profile (the wipe): import through the empty screen. ---
    const appB = await launchApp(dirs[1]!);
    apps.push(appB);
    await stubDialogs(appB, { openPath: exportFile });
    const winB = await appB.firstWindow();
    await winB.waitForLoadState('domcontentloaded');
    if (needsFallback) {
      await winB.evaluate(() => (window as unknown as { atelier: Atelier }).atelier.secrets.setPlaintextFallback(true));
    }

    await winB.getByRole('button', { name: 'Import connections' }).click();
    const wizard = winB.getByRole('dialog', { name: 'Import Connections', exact: true });
    await wizard.getByRole('button', { name: 'Choose file…' }).click();

    // A Connection Export goes straight to the final approval, with no Field Mapping.
    const review = wizard.getByRole('table', { name: 'Connections to import' });
    await expect(review.getByRole('checkbox', { name: 'Import Alpha' })).toBeChecked();
    await expect(review.getByRole('checkbox', { name: 'Import Beta' })).toBeChecked();
    await expect(review.getByRole('checkbox', { name: 'Import Gamma' })).toHaveCount(0);

    await wizard.getByLabel('Export Passphrase').fill('not the passphrase');
    await wizard.getByRole('button', { name: 'Import 2 Connections' }).click();
    await expect(wizard.getByText('Wrong Export Passphrase.', { exact: true })).toBeVisible();
    // An inline field error, not the wizard-level failure banner.
    await expect(wizard.getByRole('alert')).toHaveCount(0);

    await wizard.getByLabel('Export Passphrase').fill(PASSPHRASE);
    await wizard.getByRole('button', { name: 'Import 2 Connections' }).click();
    await expect(wizard.getByRole('status')).toHaveText('2 Connections imported.');
    await expect(wizard.getByLabel('Secrets not stored')).toHaveCount(0);

    const status = await winB.evaluate(async () => {
      const api = (window as unknown as { atelier: Atelier }).atelier;
      const rows = await api.conn.list();
      const alpha = rows.find((r) => r.name === 'Alpha');
      if (!alpha) throw new Error(`Alpha was not imported: ${JSON.stringify(rows)}`);
      return { names: rows.map((r) => r.name), status: (await api.mongo.connect(alpha.id)).status };
    });
    expect(status.names.sort((a, b) => a.localeCompare(b))).toEqual(['Alpha', 'Beta']);
    expect(status.status).toBe('connected');
  } finally {
    await Promise.all(apps.map((a) => a.close().catch(() => {})));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
