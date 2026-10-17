import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { freshUserData, launchApp, startMemoryServer, stopAllMemoryServers } from '../helpers/e2eApp';
import { WorkspacePage } from './pages/WorkspacePage';
import { expectStatusDot } from './helpers/uiAsserts';
import {
  allowSecretStorage,
  buildEncryptedCompassExport,
  openWizardFromEmptyScreen,
  stubOpenDialog,
} from './helpers/importWizard';

/**
 * C14 §4 — import a passphrase-encrypted MongoDB Compass export through the
 * Import Wizard: a wrong passphrase keeps the final approval open with main's
 * message, the right one creates the Connections.
 *
 * The committed fixture is a real Compass 1.49.7 export, so its hosts point
 * nowhere. A second test builds an export in the same format against an
 * auth-enabled memory server, to prove a Connection imported this way connects
 * without the password being typed again.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/compass');
const FIXTURE_PASSPHRASE = fs.readFileSync(path.join(FIXTURES, 'passphrase.txt'), 'utf8').trim();

test.afterAll(stopAllMemoryServers);

test('encrypted Compass fixture: wrong passphrase stays in review, the right one imports the favourites', async () => {
  const dir = freshUserData();
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(dir);
    await stubOpenDialog(app, path.join(FIXTURES, 'encrypted.json'));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await allowSecretStorage(app, win);

    const wizard = await openWizardFromEmptyScreen(win);
    await wizard.getByRole('button', { name: 'Choose file…' }).click();

    // A Compass export goes straight to the final approval, with no Field Mapping.
    const review = wizard.getByRole('table', { name: 'Connections to import' });
    for (const name of ['Fixture favourite', 'Fixture SSH password', 'Fixture SSH key']) {
      await expect(review.getByRole('checkbox', { name: `Import ${name}`, exact: true })).toBeChecked();
    }
    // OIDC can't be represented: listed, with its reason, and not tickable.
    await expect(review.getByRole('checkbox', { name: 'Import row 4' })).toBeDisabled();
    await expect(review.getByText("Not importable: OIDC sign-in isn't supported yet.")).toBeVisible();
    await expect(review.getByText('re-pick SSH key')).toBeVisible();

    await wizard.getByLabel('Export Passphrase').fill('not the passphrase');
    await wizard.getByRole('button', { name: 'Import 3 Connections' }).click();
    await expect(wizard.getByText('Wrong passphrase for this Compass export.', { exact: true })).toBeVisible();
    // Still the review, still retryable; nothing was written.
    await expect(review).toBeVisible();
    await expect(wizard.getByRole('status')).toHaveCount(0);

    await wizard.getByLabel('Export Passphrase').fill(FIXTURE_PASSPHRASE);
    await wizard.getByRole('button', { name: 'Import 3 Connections' }).click();

    await expect(wizard.getByRole('status')).toHaveText('3 Connections imported.');
    await expect(wizard.getByLabel('Secrets not stored')).toHaveCount(0);
    // The identity-key path is never imported; the user is told to pick the file again.
    await expect(
      wizard.getByLabel('Files to pick again').getByText('Fixture SSH key: re-pick SSH key'),
    ).toBeVisible();
    await wizard.getByRole('button', { name: 'Done' }).click();
    await expect(wizard).toBeHidden();

    const names = await win.evaluate(async () => {
      const api = (window as unknown as { atelier: { conn: { list: () => Promise<{ name: string }[]> } } }).atelier;
      return (await api.conn.list()).map((c) => c.name);
    });
    expect(names.sort((a, b) => a.localeCompare(b))).toEqual([
      'Fixture favourite',
      'Fixture SSH key',
      'Fixture SSH password',
    ]);
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Compass export imported with its passphrase connects without typing the password again', async () => {
  const { host, port } = await startMemoryServer({
    auth: { enable: true, customRootName: 'admin', customRootPwd: 'rootpw' },
  });
  const passphrase = 'compass test passphrase';
  const name = 'Compass live';
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c14-compass-'));
  const exportFile = path.join(exportDir, 'compass-connections.json');
  fs.writeFileSync(
    exportFile,
    buildEncryptedCompassExport({ name, username: 'admin', password: 'rootpw', host, port, passphrase }),
  );
  const dir = freshUserData();
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(dir);
    await stubOpenDialog(app, exportFile);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await allowSecretStorage(app, win);

    const wizard = await openWizardFromEmptyScreen(win);
    await wizard.getByRole('button', { name: 'Choose file…' }).click();

    const review = wizard.getByRole('table', { name: 'Connections to import' });
    await expect(review.getByRole('checkbox', { name: `Import ${name}` })).toBeChecked();
    // The password is sealed in the file, so the row asks for no credentials.
    await expect(wizard.getByLabel(`Password for ${name}`)).toHaveCount(0);
    await wizard.getByLabel('Export Passphrase').fill(passphrase);
    await wizard.getByRole('button', { name: 'Import 1 Connection' }).click();

    await expect(wizard.getByRole('status')).toHaveText('1 Connection imported.');
    await expect(wizard.getByLabel('Secrets not stored')).toHaveCount(0);
    await wizard.getByRole('button', { name: 'Done' }).click();
    await expect(wizard).toBeHidden();

    // Connecting is a plain row click; a wrong or missing password would leave the dot unknown.
    const switcher = new WorkspacePage(win).switcher;
    await switcher.waitVisible();
    await switcher.select(name);
    await expectStatusDot(win, name, 'connected');
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});
