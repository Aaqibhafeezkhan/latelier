import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConnectionExportInput,
  ConnectionExportResult,
  ExportSecretField,
  ImportCommitInput,
  ImportCommitResult,
  ImportPreview,
  UriCommitInput,
  UriPreview,
} from '@shared/types';
import { AppError, SystemError, ValidationError } from '../errors.ts';
import type { ConnectionService } from '../mongo/ConnectionService.ts';
import type { Logger } from '../log.ts';
import type { SecretsVault } from '../secrets/SecretsVault.ts';
import {
  buildConnectionExport,
  decryptSelected,
  entryToConnectionInput,
  MAX_FILE_BYTES,
  parseConnectionExport,
  planNames,
  toExportEntry,
  type ExportItem,
  type ParsedExport,
  type ScryptParams,
  type SecretValues,
} from './connectionExportFormat.ts';
import {
  lineInputProblem,
  lineToInput,
  parseLine,
  planLineNames,
  previewEntry,
} from './connectionBulkAdd.ts';

/** Vault column for each exported secret field. */
const VAULT_FIELD = {
  password: 'password',
  sshPassword: 'ssh_password',
  sshPassphrase: 'ssh_passphrase',
} as const satisfies Record<ExportSecretField, 'password' | 'ssh_password' | 'ssh_passphrase'>;

const NO_SECURE_STORAGE_REASON =
  'No secure storage on this install, and storing passwords unencrypted is off.';

export interface ConnectionExportDialogs {
  /** Shows the save dialog; `null` when the user cancels. */
  savePath(defaultName: string): Promise<string | null>;
  /** Shows the open dialog; `null` when the user cancels. */
  openPath(): Promise<string | null>;
}

/**
 * Connection Export / Import (C13). Owns both dialogs and the file, so neither
 * a path nor a plaintext secret nor the derived key ever reaches the renderer;
 * the only thing carried between preview and commit is a token for the parsed
 * file held here.
 */
export class ConnectionExportService {
  private readonly conns: ConnectionService;
  private readonly vault: SecretsVault;
  private readonly dialogs: ConnectionExportDialogs;
  private readonly now: () => Date;
  private readonly scrypt?: ScryptParams;
  private readonly log?: Logger;
  private readonly pending = new Map<string, ParsedExport>();

  constructor(opts: {
    conns: ConnectionService;
    vault: SecretsVault;
    dialogs: ConnectionExportDialogs;
    now?: () => Date;
    /** Test hook: a cheaper scrypt cost than the default. */
    scrypt?: ScryptParams;
    log?: Logger;
  }) {
    this.conns = opts.conns;
    this.vault = opts.vault;
    this.dialogs = opts.dialogs;
    this.now = opts.now ?? (() => new Date());
    this.scrypt = opts.scrypt;
    this.log = opts.log;
  }

  /** Called when the window closes: a token does not outlive it. */
  clearPending(): void {
    this.pending.clear();
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
      await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
      // `mode` only applies to a file that is being created; the user may have
      // picked an existing one, and this file can carry sealed secrets.
      await fs.chmod(target, 0o600);
    } catch (err) {
      throw new SystemError(
        'INTERNAL',
        `failed to write connection export: ${(err as Error).message}`,
      );
    }
    return { written: conns.length, omittedSecrets };
  }

  async importPreview(): Promise<ImportPreview> {
    const source = await this.dialogs.openPath();
    if (source === null) return { cancelled: true };
    const size = (await fs.stat(source)).size;
    if (size > MAX_FILE_BYTES) {
      throw new ValidationError(
        `This file is too large to be a Connection Export (${MAX_FILE_BYTES / 1024 / 1024} MB limit).`,
      );
    }
    // A failure here throws before a token exists, so nothing is held or written.
    const file = parseConnectionExport(await fs.readFile(source, 'utf8'));
    const token = randomUUID();
    this.pending.set(token, file);
    const savedAs = planNames(
      this.conns.list().map((c) => c.name),
      file.connections.map((c) => c.name),
    );
    return {
      token,
      hasSecrets: file.connections.some((c) => c.secrets !== undefined),
      entries: file.connections.map((c, index) => ({
        index,
        name: c.name,
        savedAs: savedAs[index]!,
        repick: c.repick ?? [],
        hasSecrets: c.secrets !== undefined,
      })),
    };
  }

  async importCommit(input: ImportCommitInput): Promise<ImportCommitResult> {
    const file = this.pending.get(input.token);
    if (!file) throw new ValidationError('This import has expired. Choose the file again.');
    const indices = [...input.indices].sort((a, b) => a - b);
    if (new Set(indices).size !== indices.length) {
      throw new ValidationError('Each connection can only be imported once.');
    }
    if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= file.connections.length)) {
      throw new ValidationError('The selection includes a connection that is not in the file.');
    }

    // Single-use even under concurrent commits: take the file out before the
    // first await. A failed decrypt (wrong passphrase, damaged file, missing
    // passphrase) puts it back, so a retry or "without passwords" still works.
    this.pending.delete(input.token);
    let secrets: Map<number, SecretValues>;
    try {
      secrets = input.withoutSecrets
        ? new Map<number, SecretValues>()
        : await decryptSelected(file, input.passphrase, indices);
    } catch (err) {
      this.pending.set(input.token, file);
      throw err;
    }

    // The preview was a forecast; clashes are resolved against what exists now.
    // Planned over every entry in the file, as the preview did, so unticking an
    // entry cannot move another one's name.
    const names = planNames(
      this.conns.list().map((c) => c.name),
      file.connections.map((c) => c.name),
    );
    const result: ImportCommitResult = { created: [], failed: [], secretsNotStored: [] };
    for (const i of indices) {
      const entry = file.connections[i]!;
      let created;
      try {
        // Secrets never go through create(): it deletes the row again when the
        // vault refuses them, and §4.4 wants the Connection kept.
        created = await this.conns.create({ ...entryToConnectionInput(entry), name: names[i]! });
      } catch (err) {
        // Carry on: the rows already created stay, so the result must say which did not.
        this.log?.error('conn-import', 'could not create an imported connection', {
          index: i,
          cause: err instanceof Error ? err.message : String(err),
        });
        result.failed.push({
          index: i,
          name: entry.name,
          reason: err instanceof AppError ? err.message : 'Unexpected error',
        });
        continue;
      }
      result.created.push({ index: i, id: created.id, name: created.name });
      this.storeSecrets(created.id, created.name, secrets.get(i), result);
    }
    return result;
  }

  /** C13 §7.1 — nothing is written; a line's password is reported as present, never returned. */
  previewUris(uris: readonly string[]): UriPreview {
    const lines = uris.map(parseLine);
    const names = planLineNames(this.conns.list().map((c) => c.name), lines);
    return { entries: lines.map((l, i) => previewEntry(l, i, names[i]!)) };
  }

  /**
   * C13 §7.1 — re-parses and re-plans against what exists now, like
   * `importCommit`, and keeps a Connection whose password the vault refuses.
   */
  async createFromUris(input: UriCommitInput): Promise<ImportCommitResult> {
    const lines = input.uris.map(parseLine);
    const names = planLineNames(this.conns.list().map((c) => c.name), lines);
    const creds = new Map(input.credentials.map((c) => [c.index, c]));
    const result: ImportCommitResult = { created: [], failed: [], secretsNotStored: [] };
    for (const [i, line] of lines.entries()) {
      const label = `Line ${i + 1}`;
      if (!line.ok) {
        result.failed.push({ index: i, name: label, reason: line.reason });
        continue;
      }
      // A line that sets directConnection itself keeps its own value over the batch default.
      const direct = line.explicitDirect ? line.input.advanced!.directConnection : input.defaults.directConnection;
      const { password, ...conn } = lineToInput(
        line,
        names[i]!,
        { readOnly: input.defaults.readOnly, directConnection: direct },
        creds.get(i),
      );
      const problem = lineInputProblem({ ...conn, ...(password ? { password } : {}) });
      if (problem) {
        result.failed.push({ index: i, name: names[i]!, reason: problem });
        continue;
      }
      let created;
      try {
        created = await this.conns.create(conn);
      } catch (err) {
        this.log?.error('conn-add', 'could not create a connection from a connection string', {
          index: i,
          cause: err instanceof Error ? err.message : String(err),
        });
        result.failed.push({
          index: i,
          name: names[i]!,
          reason: err instanceof AppError ? err.message : 'Unexpected error',
        });
        continue;
      }
      result.created.push({ index: i, id: created.id, name: created.name });
      this.storeSecrets(created.id, created.name, password ? { password } : undefined, result);
    }
    return result;
  }

  private storeSecrets(
    id: string,
    name: string,
    values: SecretValues | undefined,
    result: ImportCommitResult,
  ): void {
    if (!values) return;
    for (const field of Object.keys(VAULT_FIELD) as ExportSecretField[]) {
      const value = values[field];
      if (value === undefined) continue;
      try {
        this.vault.set(id, VAULT_FIELD[field], value);
      } catch (err) {
        if (err instanceof AppError && err.code === 'SECRETS_UNAVAILABLE') {
          result.secretsNotStored.push({ name, reason: NO_SECURE_STORAGE_REASON });
        } else {
          this.log?.error('conn-import', 'could not store an imported secret', {
            cause: err instanceof Error ? err.message : String(err),
          });
          result.secretsNotStored.push({ name, reason: 'The password could not be stored.' });
        }
        // Every remaining secret of this Connection fails the same way; say it once.
        return;
      }
    }
  }
}
