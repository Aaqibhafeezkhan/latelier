import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isLogFile, redactSecrets } from '../log.ts';

export interface DiagnosticBundle {
  generatedAt: string;
  app: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    electron: string;
    node: string;
    chrome: string;
  };
  connections: Array<{
    id: string;
    name: string;
    connectionType: string;
    host: string;
    port: number;
    authMech: string;
    tlsEnabled: boolean;
    sshEnabled: boolean;
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string | null;
  }>;
  /** Present only when the service was given a `secretsStatus` probe. */
  secrets?: SecretsStatus;
  logs: Record<string, string>;
}

export interface SecretsStatus {
  encryptionAvailable: boolean;
  backend: string | null;
  /** False when the column key is stored unwrapped because no usable keychain exists. */
  columnKeyProtected: boolean;
}

export interface DiagnosticServiceOpts {
  userDataDir: string;
  connRepo: ConnectionReader;
  /** Reports whether secrets get real encryption and which keychain backend serves them. */
  secretsStatus?: () => SecretsStatus;
  /** Number of most recent log files to include. Defaults to 7. */
  maxLogFiles?: number;
  /** Cap each log file at this many bytes (most recent slice). Defaults to 1 MiB. */
  maxLogFileBytes?: number;
}

export interface ConnectionReader {
  list(): Array<{
    id: string;
    name: string;
    connection_type: string;
    host: string;
    port: number;
    auth_mech: string;
    tls_enabled: number;
    ssh_enabled: number;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
  }>;
}

const DEFAULT_MAX_FILES = 7;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export class DiagnosticService {
  private userDataDir: string;
  private connRepo: ConnectionReader;
  private secretsStatus: DiagnosticServiceOpts['secretsStatus'];
  private maxLogFiles: number;
  private maxLogFileBytes: number;

  constructor(opts: DiagnosticServiceOpts) {
    this.userDataDir = opts.userDataDir;
    this.connRepo = opts.connRepo;
    this.secretsStatus = opts.secretsStatus;
    this.maxLogFiles = opts.maxLogFiles ?? DEFAULT_MAX_FILES;
    this.maxLogFileBytes = opts.maxLogFileBytes ?? DEFAULT_MAX_BYTES;
  }

  async build(): Promise<DiagnosticBundle> {
    return {
      generatedAt: new Date().toISOString(),
      app: this.appMetadata(),
      connections: this.redactedConnections(),
      ...(this.secretsStatus ? { secrets: this.secretsStatus() } : {}),
      logs: await this.recentLogs(),
    };
  }

  /**
   * Build a bundle and stringify it. redactSecrets() runs once more here so
   * any future field that happens to match a redaction key (`password`, etc.)
   * is scrubbed even if a caller forgets to shape-filter it.
   */
  async serialize(): Promise<string> {
    const bundle = await this.build();
    return JSON.stringify(redactSecrets(bundle), null, 2);
  }

  defaultFilename(): string {
    // `slice(0, 19)` drops the `.sssZ` tail. The `/\..+$/` it replaces had an
    // unanchored start over an unbounded `.+`, which backtracks super-linearly
    // (S8786) — irrelevant on a 24-character ISO string, but the slice is both
    // shorter and linear.
    const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `latelier-diagnostic-${now}.json`;
  }

  private appMetadata(): DiagnosticBundle['app'] {
    return {
      version: safeAppVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'unknown',
    };
  }

  private redactedConnections(): DiagnosticBundle['connections'] {
    return this.connRepo.list().map((row) => ({
      id: row.id,
      name: row.name,
      connectionType: row.connection_type,
      host: row.host,
      port: row.port,
      authMech: row.auth_mech,
      tlsEnabled: row.tls_enabled === 1,
      sshEnabled: row.ssh_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  private async recentLogs(): Promise<Record<string, string>> {
    const logsDir = path.join(this.userDataDir, 'logs');
    let entries: string[];
    try {
      entries = await fs.readdir(logsDir);
    } catch {
      return {};
    }
    const files = entries
      .filter(isLogFile)
      // Order by the date after the prefix: the prefix changed with the rename
      // and `l` < `m`, so whole-name order puts every legacy `mongolab.*` log
      // after the newer `latelier.*` ones and the `slice` below would keep the
      // old logs and drop the newest. On the upgrade day both prefixes share a
      // date; the `mongolab.` file was written first, so it sorts first.
      // ISO date, so code-unit order IS chronological order. Deliberately not
      // `localeCompare`: its collation is locale-dependent, and which files
      // survive the `slice` below must not be.
      .map((name) => ({ name, key: name.slice(name.indexOf('.') + 1) + (name.startsWith('mongolab.') ? '0' : '1') }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((f) => f.name)
      .slice(-this.maxLogFiles);

    const out: Record<string, string> = {};
    for (const name of files) {
      const full = path.join(logsDir, name);
      try {
        out[name] = await readTail(full, this.maxLogFileBytes);
      } catch {
        // Skip unreadable files; bundle is best-effort.
      }
    }
    return out;
  }
}

async function readTail(file: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(file);
  if (stat.size <= maxBytes) {
    return await fs.readFile(file, 'utf8');
  }
  // Stream the last `maxBytes` bytes and discard the partial first line so we
  // don't ship a bundle that starts mid-record.
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    // Decode only the bytes actually returned — concurrent truncation can
    // shrink the file between stat and read, leaving zero-padded tail bytes
    // in the pre-allocated buffer.
    const { bytesRead } = await fh.read(buf, 0, maxBytes, stat.size - maxBytes);
    const text = buf.toString('utf8', 0, bytesRead);
    const newlineIdx = text.indexOf('\n');
    return newlineIdx >= 0 ? text.slice(newlineIdx + 1) : text;
  } finally {
    await fh.close();
  }
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}
