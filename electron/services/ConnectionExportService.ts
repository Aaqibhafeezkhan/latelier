import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConnectionExportInput,
  ConnectionExportResult,
  ExportSecretField,
} from '@shared/types';
import { writePrivateFile } from '../utils/privateFs.ts';
import { AppError, SystemError, ValidationError } from '../errors.ts';
import type { ConnectionService } from '../mongo/ConnectionService.ts';
import type { Logger } from '../log.ts';
import type { SecretsVault } from '../secrets/SecretsVault.ts';
import {
  buildConnectionExport,
  toExportEntry,
  type ExportItem,
  type ScryptParams,
  type SecretValues,
} from './connectionExportFormat.ts';
import { checkFileSize } from './import/detect.ts';

/** Vault column for each exported secret field. */
const VAULT_FIELD = {
  password: 'password',
  sshPassword: 'ssh_password',
  sshPassphrase: 'ssh_passphrase',
} as const satisfies Record<ExportSecretField, 'password' | 'ssh_password' | 'ssh_passphrase'>;

const NO_SECURE_STORAGE_REASON =
  'No secure storage on this install, and storing passwords unencrypted is off.';

/**
 * Reads a file the user picked in main's dialog; one over the import limit is
 * refused before it is read. A file system error names the absolute path in
 * its message, so it never reaches the renderer: it is logged by its code and
 * reported in words.
 */
export async function readImportFile(file: string, log?: Logger): Promise<string> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch (err) {
    throw unreadable(err, log);
  }
  checkFileSize(size);
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    throw unreadable(err, log);
  }
}

function unreadable(err: unknown, log: Logger | undefined): ValidationError {
  log?.warn('conn-import', 'could not read the picked file', {
    code: (err as NodeJS.ErrnoException).code ?? 'unknown',
  });
  return new ValidationError("This file can't be read.");
}

/**
 * Stores an imported Connection's secrets after the row exists (C13 §4.4).
 * Secrets never go through create(): it deletes the row again when the vault
 * refuses them, and the Connection must be kept. A refusal is reported in
 * `notStored` once per Connection; it never throws.
 */
export function storeImportedSecrets(
  vault: SecretsVault,
  log: Logger | undefined,
  conn: { id: string; name: string },
  values: SecretValues | undefined,
  notStored: { name: string; reason: string }[],
): void {
  if (!values) return;
  for (const field of Object.keys(VAULT_FIELD) as ExportSecretField[]) {
    const value = values[field];
    if (value === undefined) continue;
    try {
      vault.set(conn.id, VAULT_FIELD[field], value);
    } catch (err) {
      if (err instanceof AppError && err.code === 'SECRETS_UNAVAILABLE') {
        notStored.push({ name: conn.name, reason: NO_SECURE_STORAGE_REASON });
      } else {
        log?.error('conn-import', 'could not store an imported secret', {
          cause: err instanceof Error ? err.message : String(err),
        });
        notStored.push({ name: conn.name, reason: 'The password could not be stored.' });
      }
      // Every remaining secret of this Connection fails the same way; say it once.
      return;
    }
  }
}

export interface ConnectionExportDialogs {
  /** Shows the save dialog; `null` when the user cancels. */
  savePath(defaultName: string): Promise<string | null>;
  /** Shows the open dialog; `null` when the user cancels. */
  openPath(): Promise<string | null>;
}

/**
 * Connection Export (C13). Owns the save dialog and the file, so neither a path
 * nor a plaintext secret nor the derived key ever reaches the renderer. Import
 * lives in `ImportWizardService`; the dialogs interface is shared with it.
 */
export class ConnectionExportService {
  private readonly conns: ConnectionService;
  private readonly vault: SecretsVault;
  private readonly dialogs: ConnectionExportDialogs;
  private readonly now: () => Date;
  private readonly scrypt?: ScryptParams;

  constructor(opts: {
    conns: ConnectionService;
    vault: SecretsVault;
    dialogs: ConnectionExportDialogs;
    now?: () => Date;
    /** Test hook: a cheaper scrypt cost than the default. */
    scrypt?: ScryptParams;
  }) {
    this.conns = opts.conns;
    this.vault = opts.vault;
    this.dialogs = opts.dialogs;
    this.now = opts.now ?? (() => new Date());
    this.scrypt = opts.scrypt;
  }

  async export(input: ConnectionExportInput): Promise<ConnectionExportResult> {
    if (input.includeSecrets && !input.passphrase) {
      throw new ValidationError('An Export Passphrase is required to include passwords');
    }
    const conns = [...new Set(input.ids)].map((id) => this.conns.get(id));
    const now = this.now();
    const target = await this.dialogs.savePath(
      `latelier-connections-${now.toISOString().slice(0, 10)}.json`,
    );
    // Before any crypto: cancelling must cost nothing and write nothing.
    if (target === null) return { cancelled: true };

    const omittedSecrets: { name: string; field: ExportSecretField }[] = [];
    const items: ExportItem[] = conns.map((conn) => {
      const secrets: SecretValues = {};
      if (input.includeSecrets) {
        for (const field of Object.keys(VAULT_FIELD) as ExportSecretField[]) {
          const column = VAULT_FIELD[field];
          if (!this.vault.has(conn.id, column)) continue;
          try {
            const value = this.vault.get(conn.id, column);
            if (value) secrets[field] = value;
          } catch (err) {
            // One broken secret never blocks the export (§3.4): omit it and say so.
            if (!(err instanceof AppError) || err.code !== 'SECRET_DECRYPT_FAILED') throw err;
            omittedSecrets.push({ name: conn.name, field });
          }
        }
      }
      return { entry: toExportEntry(conn), secrets };
    });

    const content = await buildConnectionExport({
      items,
      passphrase: input.passphrase,
      now,
      scrypt: this.scrypt,
    });
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      // The file can carry sealed secrets and always carries hostnames: owner-only (0600),
      // the way the diagnostic bundle is written.
      await writePrivateFile(target, content);
    } catch (err) {
      throw new SystemError(
        'INTERNAL',
        `failed to write connection export: ${(err as Error).message}`,
      );
    }
    return { written: conns.length, omittedSecrets };
  }
}
