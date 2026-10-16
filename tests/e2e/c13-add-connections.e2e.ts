import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { freshUserData, launchApp, startMemoryServer, stopAllMemoryServers } from '../helpers/e2eApp';
import { WorkspacePage } from './pages/WorkspacePage';
import { wizardDialog } from './helpers/importWizard';

/**
 * C13 §7–8 through the C14 Import Wizard — paste connection strings into the
 * Connections table's "Paste URIs" (one complete, one missing its credentials,
 * one bad), type the missing credentials in the final approval, connect with
 * them, then check both rows and delete them in one batch without the table
 * closing.
 */

type Atelier = {
  conn: {
    create: (input: unknown) => Promise<{ id: string }>;
    delete: (id: string) => Promise<unknown>;
    list: () => Promise<{ id: string; name: string; readOnly: boolean }[]>;
  };
  mongo: { connect: (id: string) => Promise<{ status: string }> };
  secrets: { setPlaintextFallback: (enabled: boolean) => Promise<{ enabled: boolean }> };
};

test.afterAll(stopAllMemoryServers);

test('add Connections from pasted strings, with typed credentials, then batch-delete them', async () => {
  const { host, port } = await startMemoryServer({
    auth: { enable: true, customRootName: 'admin', customRootPwd: 'rootpw' },
  });
  const dir = freshUserData();
  let app: ElectronApplication | null = null;

  try {
    app = await launchApp(dir);
    // 'Enable' is button 1 in main's plaintext-fallback warning.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // No OS keychain (Linux CI): opt into the plaintext fallback, as a user would.
    await win.evaluate(async (probe) => {
      const api = (window as unknown as { atelier: Atelier }).atelier;
      try {
        const c = await api.conn.create(probe);
        await api.conn.delete(c.id);
      } catch (err) {
        if ((err as { code?: string }).code !== 'SECRETS_UNAVAILABLE') throw err;
        await api.secrets.setPlaintextFallback(true);
      }
    }, {
      name: 'probe', color: '#1A6835', connectionType: 'standard', host, port,
      authMech: 'scram256', authUsername: 'u', password: 'p', tls: { enabled: false, verify: true },
      advanced: {
        connectTimeoutMs: 5000, socketTimeoutMs: 5000, serverSelectionTimeoutMs: 5000,
        readPreference: 'primary', maxPoolSize: 1, directConnection: true,
      },
    });

    const switcher = new WorkspacePage(win).switcher;
    await switcher.openExpandedTable();
    const table = switcher.expandedTableDialog;
    await table.getByRole('button', { name: 'Paste URIs' }).click();

    const wizard = wizardDialog(win);
    await wizard.getByRole('textbox', { name: 'Or paste connection strings' }).fill(
      [
        `mongodb://admin:rootpw@${host}:${port}/?authSource=admin&serverSelectionTimeoutMS=5000`,
        `mongodb://${host}:${port}/?authSource=admin&serverSelectionTimeoutMS=5000`,
        'not a connection string',
      ].join('\n'),
    );
    await wizard.getByRole('button', { name: 'Next' }).click();

    // Paste URIs goes straight to the final approval, with every line listed.
    const review = wizard.getByRole('table', { name: 'Connections to import' });
    await expect(review.getByRole('checkbox', { name: `Import ${host}`, exact: true })).toBeChecked();
    await expect(review.getByRole('checkbox', { name: `Import ${host} (2)`, exact: true })).toBeChecked();
    await expect(review.getByRole('checkbox', { name: 'Import row 3' })).toBeDisabled();
    await expect(review.getByText(/Not importable/)).toBeVisible();
    await wizard.getByRole('checkbox', { name: 'Read-only, for all rows' }).check();

    // The second string has no credentials, so its row asks for them inline.
    await wizard.getByRole('textbox', { name: `Username for ${host} (2)` }).fill('admin');
    await wizard.getByLabel(`Password for ${host} (2)`).fill('rootpw');
    await wizard.getByRole('button', { name: 'Import 2 Connections' }).click();

    await expect(wizard.getByRole('status')).toHaveText('2 Connections imported.');
    await expect(wizard.getByLabel('Secrets not stored')).toHaveCount(0);
    await wizard.getByRole('button', { name: 'Done' }).click();
    await expect(wizard).toBeHidden();

    // The table stayed open underneath, and now lists both.
    await expect(table.getByText(`${host} (2)`, { exact: true })).toBeVisible();
    const typed = await win.evaluate(async (name) => {
      const api = (window as unknown as { atelier: Atelier }).atelier;
      const rows = await api.conn.list();
      const row = rows.find((r) => r.name === name);
      if (!row) throw new Error(`${name} was not added: ${JSON.stringify(rows)}`);
      return { readOnly: row.readOnly, status: (await api.mongo.connect(row.id)).status };
    }, `${host} (2)`);
    expect(typed).toEqual({ readOnly: true, status: 'connected' });

    await table.getByRole('checkbox', { name: 'Check all shown connections' }).check();
    await table.getByRole('toolbar', { name: 'Checked connections' }).getByRole('button', { name: 'Delete' }).click();
    const confirm = win.getByRole('dialog', { name: 'Delete 2 connections?' });
    await confirm.getByRole('textbox', { name: 'Confirm deletion' }).fill('delete 2');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(table.getByText('No connections yet')).toBeVisible();
    await expect(table).toBeVisible();
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
