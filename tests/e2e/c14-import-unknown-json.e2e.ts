import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { freshUserData, launchApp, startMemoryServer, stopAllMemoryServers } from '../helpers/e2eApp';
import { WorkspacePage } from './pages/WorkspacePage';
import { expectStatusDot } from './helpers/uiAsserts';
import { allowSecretStorage, openWizardFromEmptyScreen, stubOpenDialog } from './helpers/importWizard';

/**
 * C14 §5 — a JSON file in no known format: the wizard offers Field Mapping
 * with suggestions pre-filled, masks the secret-looking field's sample, and
 * after the final approval the created Connection connects.
 */

test.afterAll(stopAllMemoryServers);

test('unknown JSON: accept the suggested mapping, secret sample masked, import, connect', async () => {
  const { host, port } = await startMemoryServer();
  const label = 'Mapped server';
  const secret = 'unknown-json-secret-marker';
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c14-unknown-json-'));
  const file = path.join(fileDir, 'servers.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ servers: [{ label, uri: `mongodb://${host}:${port}`, secret }] }),
  );
  const dir = freshUserData();
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(dir);
    await stubOpenDialog(app, file);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await allowSecretStorage(app, win);

    const wizard = await openWizardFromEmptyScreen(win);
    await wizard.getByRole('button', { name: 'Choose file…' }).click();

    // Field Mapping, with the key-name suggestions already chosen.
    const fields = wizard.getByRole('table', { name: 'Fields in the file' });
    await expect(fields).toBeVisible();
    await expect(wizard.getByRole('combobox', { name: 'Use label as' })).toHaveValue('name');
    await expect(wizard.getByRole('combobox', { name: 'Use uri as' })).toHaveValue('connectionString');

    // The secret's sample is masked in main: only the dots and the hint reach the screen.
    const secretRow = fields.getByRole('row').filter({ hasText: 'secret' });
    await expect(secretRow).toContainText('Taken from the file — not shown');
    await expect(secretRow.locator('[aria-hidden="true"]')).toHaveText('••••');
    await expect(wizard).not.toContainText(secret);

    await wizard.getByRole('button', { name: 'Next' }).click();

    const review = wizard.getByRole('table', { name: 'Connections to import' });
    await expect(review.getByRole('checkbox', { name: `Import ${label}`, exact: true })).toBeChecked();
    await wizard.getByRole('button', { name: 'Import 1 Connection' }).click();

    await expect(wizard.getByRole('status')).toHaveText('1 Connection imported.');
    await wizard.getByRole('button', { name: 'Done' }).click();
    await expect(wizard).toBeHidden();

    const switcher = new WorkspacePage(win).switcher;
    await switcher.waitVisible();
    await switcher.select(label);
    await expectStatusDot(win, label, 'connected');
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fileDir, { recursive: true, force: true });
  }
});
