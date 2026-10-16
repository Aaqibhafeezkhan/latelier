import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';

/**
 * Shared steps for the Import Wizard specs. The native open dialog is replaced
 * in the main process (`app.evaluate`), so the wizard's own code path, from
 * the button to the commit, is the one that runs.
 */

/** The wizard's modal; `exact` keeps the Connections table (also a dialog) out. */
export function wizardDialog(win: Page) {
  return win.getByRole('dialog', { name: 'Import Connections', exact: true });
}

/** Makes main's open dialog answer with this path, as if the user had picked it. */
export async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, filePath);
}

type Atelier = {
  conn: {
    create: (input: unknown) => Promise<{ id: string }>;
    delete: (id: string) => Promise<unknown>;
  };
  secrets: { setPlaintextFallback: (enabled: boolean) => Promise<{ enabled: boolean }> };
};

/**
 * Where there is no OS keychain (Linux CI), opt into the plaintext fallback as
 * a user would, so imported passwords are stored and the result has no
 * "Secrets not stored" list. A no-op where the keychain works.
 */
export async function allowSecretStorage(app: ElectronApplication, win: Page): Promise<void> {
  // 'Enable' is button 1 in main's plaintext-fallback warning.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  await win.evaluate(async () => {
    const api = (window as unknown as { atelier: Atelier }).atelier;
    const probe = {
      name: 'secret-store-probe',
      color: '#1A6835',
      connectionType: 'standard',
      host: '127.0.0.1',
      port: 27017,
      authMech: 'scram256',
      authUsername: 'u',
      password: 'p',
      tls: { enabled: false, verify: true },
      advanced: {
        connectTimeoutMs: 5000,
        socketTimeoutMs: 5000,
        serverSelectionTimeoutMs: 5000,
        readPreference: 'primary',
        maxPoolSize: 1,
        directConnection: true,
      },
    };
    try {
      const c = await api.conn.create(probe);
      await api.conn.delete(c.id);
    } catch (err) {
      if ((err as { code?: string }).code !== 'SECRETS_UNAVAILABLE') throw err;
      await api.secrets.setPlaintextFallback(true);
    }
  });
}

/** Opens the wizard from the first-launch screen, which shows it only with no Connections. */
export async function openWizardFromEmptyScreen(win: Page) {
  await win.getByRole('button', { name: 'Import connections' }).click();
  const dialog = wizardDialog(win);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * A Compass "Export Connections" file with one passphrase-encrypted favourite,
 * built the way Compass does (its connection-storage `encrypt.ts`): the
 * password leaves the connection string and goes into `connectionSecrets`, a
 * base64 blob of u16 BE version 1 | 16-byte salt | 16-byte IV | 16-byte GCM tag
 * | ciphertext. Key = PBKDF2-SHA512(passphrase, salt, 100000, 32 bytes);
 * AES-256-GCM with no additional data; plaintext `{"secrets":{"password"}}`.
 * Written as canonical EJSON, so numbers are `$numberInt`.
 */
export function buildEncryptedCompassExport(opts: {
  name: string;
  username: string;
  password: string;
  host: string;
  port: number;
  passphrase: string;
}): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(opts.passphrase, salt, 100_000, 32, 'sha512');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify({ secrets: { password: opts.password } }), 'utf8'),
    cipher.final(),
  ]);
  const version = Buffer.alloc(2);
  version.writeUInt16BE(1);
  const blob = Buffer.concat([version, salt, iv, cipher.getAuthTag(), sealed]).toString('base64');
  return JSON.stringify(
    {
      type: 'Compass Connections',
      version: { $numberInt: '1' },
      connections: [
        {
          id: '6f1d1a62-1f0e-4c0b-9d43-0a1e2f3b4d01',
          favorite: { name: opts.name },
          connectionOptions: {
            connectionString: `mongodb://${opts.username}@${opts.host}:${opts.port}/?authSource=admin&serverSelectionTimeoutMS=5000`,
          },
          savedConnectionType: 'favorite',
          connectionSecrets: blob,
        },
      ],
    },
    null,
    2,
  );
}
