import { randomUUID } from 'node:crypto';
import type {
  Connection,
  ConnectionInput,
  ConnectionSummary,
  ConnectionUpdate,
  ParsedUri,
  ProbeResult,
} from '@shared/types';
import type { ConnectionRepo } from '../db/repositories/ConnectionRepo.ts';
import {
  inputToRow,
  rowToConnection,
  mongoRelevantFieldsChanged,
  type ConnectionRow,
} from '../db/repositories/ConnectionRepo.ts';
import type { SecretsVault } from '../secrets/SecretsVault.ts';
import type { MongoPool } from './MongoPool.ts';
import { ConflictError, NotFoundError } from '../errors.ts';
import { normalizeConnectionInput } from './normalize.ts';
import { parseConnectionUri } from './uri-parse.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import type { CredentialPaths } from '../security/credentialPaths.ts';

/**
 * Connection domain service. Owns orchestration between the SQLite repo, the
 * secrets vault, and the live Mongo client pool. The only surface the IPC
 * handler layer talks to.
 */
export class ConnectionService {
  private repo: ConnectionRepo;
  private vault: SecretsVault;
  private pool: MongoPool;
  private mutexes = new Map<string, Promise<unknown>>();

  constructor(opts: { repo: ConnectionRepo; vault: SecretsVault; pool: MongoPool }) {
    this.repo = opts.repo;
    this.vault = opts.vault;
    this.pool = opts.pool;
  }

  list(): ConnectionSummary[] {
    const rows = this.repo.list();
    return rows.map((row) => {
      const runtime = this.pool.status(row.id);
      return {
        id: row.id,
        name: row.name,
        color: row.color,
        host: row.host,
        port: row.port,
        connectionType: row.connection_type,
        lastUsedAt: row.last_used_at ?? undefined,
        defaultDb: row.default_db ?? undefined,
        status: runtime.status === 'disconnected' ? 'unknown' : runtime.status,
        serverVersion: runtime.serverVersion,
        readOnly: row.read_only === 1,
      };
    });
  }

  get(id: string): Connection {
    const row = this.repo.findById(id);
    if (!row) throw new NotFoundError(`connection ${id} not found`);
    return this.rowToConnectionWithFlags(row);
  }

  /** Credential file paths currently stored on every connection. */
  storedCredentialPaths(): CredentialPaths[] {
    return this.repo.list().map((row) => ({
      caPath: row.tls_ca_path ?? undefined,
      clientCertPath: row.tls_client_cert_path ?? undefined,
      privateKeyPath: row.ssh_private_key_path ?? undefined,
    }));
  }

  async create(raw: ConnectionInput): Promise<Connection> {
    const input = normalizeConnectionInput(raw) as ConnectionInput;
    if (this.repo.findByName(input.name)) {
      throw new ConflictError(`connection name '${input.name}' already exists`, {
        field: 'name',
      });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = inputToRow(id, input, now);
    // Row and secrets commit together: a vault failure rolls the row back.
    this.repo.transaction(() => {
      this.repo.insert(row);
      if (input.password) this.vault.set(id, 'password', input.password);
      if (input.sshPassword) this.vault.set(id, 'ssh_password', input.sshPassword);
      if (input.sshPassphrase) this.vault.set(id, 'ssh_passphrase', input.sshPassphrase);
    });
    return this.get(id);
  }

  async update(id: string, patch: ConnectionUpdate): Promise<Connection> {
    return this.withMutex(id, async () => {
      const existing = this.repo.findById(id);
      if (!existing) throw new NotFoundError(`connection ${id} not found`);

      const merged: ConnectionInput = normalizeConnectionInput(
        mergeInputWithRow(existing, patch),
      ) as ConnectionInput;

      // Name uniqueness (other than self).
      if (merged.name !== existing.name) {
        const clash = this.repo.findByName(merged.name);
        if (clash && clash.id !== id) {
          throw new ConflictError(`connection name '${merged.name}' already exists`, {
            field: 'name',
          });
        }
      }

      const now = new Date().toISOString();
      const newRow: ConnectionRow = {
        ...inputToRow(id, merged, existing.created_at),
        created_at: existing.created_at,
        updated_at: now,
        last_used_at: existing.last_used_at,
      };
      this.repo.transaction(() => {
        this.repo.update(newRow);
        this.applySecretPatch(id, 'password', patch.password, patch.clearPassword);
        this.applySecretPatch(id, 'ssh_password', patch.sshPassword, patch.clearSshPassword);
        this.applySecretPatch(id, 'ssh_passphrase', patch.sshPassphrase, patch.clearSshPassphrase);
      });

      // A running script already has every call checked against the live flag,
      // but one started on a writable connection should not carry on once it is
      // turned read-only, so it must hear it.
      if (existing.read_only !== 1 && merged.readOnly === true) {
        this.pool.emit('read-only-enabled', id);
      }

      if (mongoRelevantFieldsChanged(existing, merged)) {
        await this.pool.disconnect(id);
      }
      return this.get(id);
    });
  }

  async delete(id: string): Promise<void> {
    return this.withMutex(id, async () => {
      const existing = this.repo.findById(id);
      if (!existing) throw new NotFoundError(`connection ${id} not found`);
      await this.pool.disconnect(id);
      this.repo.deleteById(id); // FK cascade wipes dependents
    });
  }

  touchUsed(id: string): void {
    const existing = this.repo.findById(id);
    if (!existing) throw new NotFoundError(`connection ${id} not found`);
    this.repo.touchLastUsed(id);
  }

  parseUri(uri: string): ParsedUri {
    return parseConnectionUri(uri);
  }

  /**
   * Non-persisting probe. Short-circuits SSH (iteration 1 deferred) and hard-
   * caps the wall-clock budget at 10s so the UI never hangs indefinitely.
   */
  async test(input: ConnectionInput): Promise<ProbeResult> {
    if (input.ssh?.enabled) {
      return {
        ok: false,
        errorCode: 'UNKNOWN',
        errorMessage: 'SSH tunnels are not supported in this iteration.',
      };
    }
    const normalized = normalizeConnectionInput(input) as ConnectionInput;
    return withTimeout<ProbeResult>(this.pool.probe(normalized), 10_000, {
      ok: false,
      errorCode: 'TIMEOUT',
      errorMessage: 'Test timed out after 10 seconds.',
    });
  }

  // ─── internal helpers ────────────────────────────────────────────────

  private applySecretPatch(
    id: string,
    kind: 'password' | 'ssh_password' | 'ssh_passphrase',
    value: string | undefined,
    clear: boolean | undefined,
  ): void {
    if (clear || value === '') {
      this.vault.delete(id, kind);
    } else if (value !== undefined) {
      this.vault.set(id, kind, value);
    }
  }

  private rowToConnectionWithFlags(row: ConnectionRow): Connection {
    return rowToConnection(row, {
      hasPasswordStored: this.vault.has(row.id, 'password'),
      hasSshPasswordStored: this.vault.has(row.id, 'ssh_password'),
      hasSshPassphraseStored: this.vault.has(row.id, 'ssh_passphrase'),
    });
  }

  private withMutex<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.mutexes.get(id) ?? Promise.resolve();
    const chained = prior.then(fn, fn);
    // Store a settled-silently version so our rejection doesn't leak as an
    // unhandled rejection when the caller handles it themselves.
    const silent = chained.catch(() => undefined);
    const stored = silent.finally(() => {
      if (this.mutexes.get(id) === stored) this.mutexes.delete(id);
    });
    this.mutexes.set(id, stored);
    return chained;
  }
}

/**
 * Merge an update patch onto an existing row, producing a complete
 * ConnectionInput. Fields missing from the patch fall back to the row's
 * current value. Clear flags (clearPassword etc.) are handled separately by
 * the caller — they do not appear in the merged row.
 */
function mergeInputWithRow(
  row: ConnectionRow,
  patch: ConnectionUpdate,
): ConnectionInput {
  const current: ConnectionInput = {
    name: row.name,
    color: row.color,
    connectionType: row.connection_type,
    host: row.host,
    port: row.port,
    defaultDb: row.default_db ?? undefined,
    authMech: row.auth_mech,
    authUsername: row.auth_username ?? undefined,
    authDatabase: row.auth_database ?? undefined,
    tls: {
      enabled: row.tls_enabled === 1,
      verify: row.tls_verify === 1,
      caPath: row.tls_ca_path ?? undefined,
      clientCertPath: row.tls_client_cert_path ?? undefined,
    },
    ssh: {
      enabled: row.ssh_enabled === 1,
      host: row.ssh_host ?? undefined,
      port: row.ssh_port ?? undefined,
      username: row.ssh_username ?? undefined,
      authMethod: row.ssh_auth_method ?? undefined,
      privateKeyPath: row.ssh_private_key_path ?? undefined,
    },
    advanced: {
      connectTimeoutMs: row.connect_timeout_ms,
      socketTimeoutMs: row.socket_timeout_ms,
      serverSelectionTimeoutMs: row.server_selection_timeout_ms,
      readPreference: row.read_preference,
      maxPoolSize: row.max_pool_size,
      directConnection: row.direct_connection === 1,
      appName: row.app_name ?? undefined,
    },
    readOnly: row.read_only === 1,
  };

  return {
    name: patch.name ?? current.name,
    color: patch.color ?? current.color,
    connectionType: patch.connectionType ?? current.connectionType,
    host: patch.host ?? current.host,
    port: patch.port ?? current.port,
    defaultDb: 'defaultDb' in patch ? patch.defaultDb : current.defaultDb,
    authMech: patch.authMech ?? current.authMech,
    authUsername: 'authUsername' in patch ? patch.authUsername : current.authUsername,
    authDatabase: 'authDatabase' in patch ? patch.authDatabase : current.authDatabase,
    tls: patch.tls ? { ...current.tls, ...patch.tls } : current.tls,
    ssh: patch.ssh ? { ...current.ssh!, ...patch.ssh } : current.ssh,
    advanced: patch.advanced ? { ...current.advanced, ...patch.advanced } : current.advanced,
    readOnly: patch.readOnly ?? current.readOnly,
    // Plaintext secrets are handled separately.
  };
}

/**
 * MongoPool expects a ConnectionReader. Wrap ConnectionRepo + the vault flags
 * via the service so existing tests keep their injection points.
 */
export function connectionReader(
  repo: ConnectionRepo,
  vault: SecretsVault,
): { findById: (id: string) => Connection | null } {
  return {
    findById(id: string) {
      const row = repo.findById(id);
      if (!row) return null;
      return rowToConnection(row, {
        hasPasswordStored: vault.has(id, 'password'),
        hasSshPasswordStored: vault.has(id, 'ssh_password'),
        hasSshPassphraseStored: vault.has(id, 'ssh_passphrase'),
      });
    },
  };
}
