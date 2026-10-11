import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { ConnectionService, connectionReader } from '../../electron/mongo/ConnectionService';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import {
  ConnectionExportService,
  type ConnectionExportDialogs,
} from '../../electron/services/ConnectionExportService';
import { MAX_FILE_BYTES } from '../../electron/services/connectionExportFormat';
import { ConflictError, type AppError } from '../../electron/errors';
import type { ConnectionInput, ImportPreview } from '@shared/types';
import { createTempDb, type TempDb } from '../helpers/db';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { useUmask022 } from '../helpers/umask';

const FAST = { N: 1024, r: 8, p: 1 };
const PASS = 'correct horse battery';
const NOW = new Date('2026-10-02T09:00:00.000Z');

function input(over: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Prod',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'db.example.com',
    port: 27017,
    authMech: 'scram256',
    authUsername: 'alice',
    tls: { enabled: true, verify: true },
    advanced: {
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
      serverSelectionTimeoutMs: 30_000,
      readPreference: 'primary',
      maxPoolSize: 100,
      directConnection: false,
    },
    ...over,
  };
}

/** One app install: its own database, keychain and services. */
function makeInstall(dialogs: ConnectionExportDialogs, opts: { allowPlaintext?: boolean } = {}) {
  const tmp: TempDb = createTempDb();
  const keychain = createSafeStorageMock();
  const vault = new SecretsVault(tmp.db, keychain, { getAllowPlaintext: () => opts.allowPlaintext ?? false });
  const repo = new ConnectionRepo(tmp.db);
  const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
  const conns = new ConnectionService({ repo, vault, pool });
  const service = new ConnectionExportService({ conns, vault, dialogs, now: () => NOW, scrypt: FAST });
  return { tmp, keychain, vault, repo, conns, service };
}

const expectCode = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e as AppError,
  );
  expect(err, `expected ${code}`).not.toBeNull();
  expect(err!.code).toBe(code);
};

describe('ConnectionExportService', () => {
  let dir: string;
  let file: string;
  let saveTo: string | null;
  let openFrom: string | null;
  let installs: ReturnType<typeof makeInstall>[];
  let restoreUmask: () => void;
  const dialogs: ConnectionExportDialogs = {
    savePath: async () => saveTo,
    openPath: async () => openFrom,
  };
  const install = (opts?: { allowPlaintext?: boolean }) => {
    const i = makeInstall(dialogs, opts);
    installs.push(i);
    return i;
  };

  beforeEach(() => {
    restoreUmask = useUmask022();
    installs = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-conn-export-'));
    file = path.join(dir, 'out', 'export.json');
    saveTo = file;
    openFrom = file;
  });

  afterEach(() => {
    for (const i of installs) i.tmp.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    restoreUmask();
    vi.restoreAllMocks();
  });

  describe('export', () => {
    it('writes the chosen connections as a 0600 file with no credential paths and no ids', async () => {
      const a = install();
      const prod = await a.conns.create(
        input({
          tls: { enabled: true, verify: true, caPath: '/etc/ca.pem', clientCertPath: '/etc/client.pem' },
          ssh: { enabled: false, host: 'bastion', privateKeyPath: '/home/me/.ssh/id_rsa' },
          password: 'hunter2',
        }),
      );
      await a.conns.create(input({ name: 'Other' }));

      const result = await a.service.export({ ids: [prod.id], includeSecrets: false });

      expect(result).toEqual({ written: 1, omittedSecrets: [] });
      const text = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(text);
      expect(json.connections).toHaveLength(1);
      expect(json.connections[0].name).toBe('Prod');
      expect(json.connections[0].repick).toEqual(['tlsCa', 'tlsClientCert', 'sshKey']);
      expect(json.encryption).toBeNull();
      for (const leaked of ['/etc/ca.pem', '/etc/client.pem', 'id_rsa', prod.id, 'hunter2', 'secrets']) {
        expect(text).not.toContain(leaked);
      }
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('tightens an existing, wider file to 0600', async () => {
      const a = install();
      const c = await a.conns.create(input());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'old', { mode: 0o644 });

      await a.service.export({ ids: [c.id], includeSecrets: false });

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('exports a connection whose saved password cannot be read, without it, and says so', async () => {
      const a = install();
      const broken = await a.conns.create(input({ name: 'Broken', password: 'lost' }));
      const fine = await a.conns.create(input({ name: 'Fine', password: 'kept' }));
      // A foreign install's keychain: the stored ciphertext no longer decrypts.
      // Re-saving 'Fine' after the reset puts a readable secret back.
      a.keychain.reset();
      a.vault.set(fine.id, 'password', 'kept');

      const result = await a.service.export({ ids: [broken.id, fine.id], includeSecrets: true, passphrase: PASS });

      expect(result).toEqual({ written: 2, omittedSecrets: [{ name: 'Broken', field: 'password' }] });
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(json.connections[0].secrets).toBeUndefined();
      expect(json.connections[1].secrets.password).toBeDefined();
      expect(json.encryption).not.toBeNull();
    });

    it('does not swallow any other vault failure', async () => {
      const a = install();
      const c = await a.conns.create(input({ password: 'pw' }));
      vi.spyOn(a.vault, 'get').mockImplementation(() => {
        throw new Error('disk on fire');
      });
      await expect(
        a.service.export({ ids: [c.id], includeSecrets: true, passphrase: PASS }),
      ).rejects.toThrow('disk on fire');
      expect(fs.existsSync(file)).toBe(false);
    });

    it('writes no encryption block and reads no secret when passwords are not included', async () => {
      const a = install();
      const c = await a.conns.create(input({ password: 'pw' }));
      const get = vi.spyOn(a.vault, 'get');
      await a.service.export({ ids: [c.id], includeSecrets: false });
      expect(get).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).encryption).toBeNull();
    });

    it('needs a passphrase to include passwords', async () => {
      const a = install();
      const c = await a.conns.create(input());
      await expectCode(a.service.export({ ids: [c.id], includeSecrets: true }), 'VALIDATION');
      expect(fs.existsSync(file)).toBe(false);
    });

    it('cancelling the save dialog writes nothing and does no crypto', async () => {
      const a = install();
      const c = await a.conns.create(input({ password: 'pw' }));
      const get = vi.spyOn(a.vault, 'get');
      saveTo = null;

      const result = await a.service.export({ ids: [c.id], includeSecrets: true, passphrase: PASS });

      expect(result).toEqual({ cancelled: true });
      expect(get).not.toHaveBeenCalled();
      expect(fs.existsSync(path.dirname(file))).toBe(false);
    });

    it('an unknown id is NOT_FOUND before any dialog opens', async () => {
      const a = install();
      const save = vi.fn(async () => file);
      const service = new ConnectionExportService({
        conns: a.conns,
        vault: a.vault,
        dialogs: { savePath: save, openPath: async () => null },
      });
      await expectCode(service.export({ ids: ['nope'], includeSecrets: false }), 'NOT_FOUND');
      expect(save).not.toHaveBeenCalled();
    });

    it('proposes a dated file name, and writes each connection once however often its id repeats', async () => {
      const a = install();
      const c = await a.conns.create(input());
      const save = vi.fn(async () => file);
      const service = new ConnectionExportService({
        conns: a.conns,
        vault: a.vault,
        dialogs: { savePath: save, openPath: async () => null },
        now: () => NOW,
      });
      const result = await service.export({ ids: [c.id, c.id], includeSecrets: false });
      expect(save).toHaveBeenCalledWith('latelier-connections-2026-10-02.json');
      expect(result).toMatchObject({ written: 1 });
    });

    it('a write failure is an INTERNAL error', async () => {
      const a = install();
      const c = await a.conns.create(input());
      saveTo = path.join(dir, 'a-file');
      fs.writeFileSync(saveTo, 'x');
      // A path below a regular file cannot be created.
      saveTo = path.join(saveTo, 'child.json');
      await expectCode(a.service.export({ ids: [c.id], includeSecrets: false }), 'INTERNAL');
    });
  });

  describe('import', () => {
    async function exportTwoOfThree(source: ReturnType<typeof makeInstall>) {
      const one = await source.conns.create(input({ name: 'One', password: 'pw-one' }));
      await source.conns.create(input({ name: 'Skipped', password: 'pw-skipped' }));
      const three = await source.conns.create(
        input({ name: 'Three', authMech: 'none', authUsername: undefined, tls: { enabled: false, verify: true } }),
      );
      await source.service.export({ ids: [one.id, three.id], includeSecrets: true, passphrase: PASS });
    }

    const previewOf = async (b: ReturnType<typeof makeInstall>) => {
      const p = await b.service.importPreview();
      if ('cancelled' in p) throw new Error('preview was cancelled');
      return p;
    };

    it('round trip: a second install gets the connections, their passwords, and fresh ids', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();

      const preview = await previewOf(b);
      expect(preview.hasSecrets).toBe(true);
      expect(preview.entries.map((e) => [e.index, e.name, e.savedAs, e.hasSecrets])).toEqual([
        [0, 'One', 'One', true],
        [1, 'Three', 'Three', false],
      ]);

      const result = await b.service.importCommit({ token: preview.token, indices: [0, 1], passphrase: PASS });

      expect(result.secretsNotStored).toEqual([]);
      expect(result.created.map((c) => c.name)).toEqual(['One', 'Three']);
      const one = b.conns.get(result.created[0]!.id);
      expect(one).toMatchObject({ name: 'One', host: 'db.example.com', authUsername: 'alice', hasPasswordStored: true });
      expect(b.vault.get(one.id, 'password')).toBe('pw-one');
      expect(b.conns.get(result.created[1]!.id).hasPasswordStored).toBe(false);
      // New identity, never the exporter's.
      const sourceIds = new Set(a.conns.list().map((c) => c.id));
      expect(result.created.some((c) => sourceIds.has(c.id))).toBe(false);
    });

    it('imports only the ticked entries, in index order', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);
      const result = await b.service.importCommit({ token: preview.token, indices: [1], withoutSecrets: true });
      expect(result.created.map((c) => c.name)).toEqual(['Three']);
      expect(b.conns.list().map((c) => c.name)).toEqual(['Three']);
    });

    it('never modifies an existing connection, and renames a clash', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const existing = await b.conns.create(input({ name: 'One', host: 'mine.example.com', password: 'mine' }));
      await b.conns.create(input({ name: 'One (2)' }));

      const preview = await previewOf(b);
      expect(preview.entries[0]!.savedAs).toBe('One (3)');
      const result = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });

      expect(result.created[0]!.name).toBe('One (3)');
      expect(result.created[0]!.id).not.toBe(existing.id);
      expect(b.conns.get(existing.id)).toMatchObject({ name: 'One', host: 'mine.example.com' });
      expect(b.vault.get(existing.id, 'password')).toBe('mine');
    });

    it('resolves clashes against the connections that exist at commit, not at preview', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);
      expect(preview.entries[0]!.savedAs).toBe('One');
      await b.conns.create(input({ name: 'One' }));

      const result = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });

      expect(result.created[0]!.name).toBe('One (2)');
    });

    it('a wrong passphrase writes nothing and keeps the token for a retry; a used token is gone', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);

      await expectCode(
        b.service.importCommit({ token: preview.token, indices: [0, 1], passphrase: 'not the passphrase' }),
        'BAD_PASSPHRASE',
      );
      expect(b.conns.list()).toEqual([]);
      expect(b.repo.list()).toEqual([]);

      const result = await b.service.importCommit({ token: preview.token, indices: [0, 1], passphrase: PASS });
      expect(result.created).toHaveLength(2);
      expect(b.vault.get(result.created[0]!.id, 'password')).toBe('pw-one');

      await expectCode(
        b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS }),
        'VALIDATION',
      );
      expect(b.conns.list()).toHaveLength(2);
    });

    it('a missing passphrase writes nothing and keeps the token', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);
      await expectCode(b.service.importCommit({ token: preview.token, indices: [0] }), 'VALIDATION');
      expect(b.conns.list()).toEqual([]);
      const result = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });
      expect(result.created).toHaveLength(1);
    });

    it('"without passwords" needs no passphrase and stores no secret', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);

      const result = await b.service.importCommit({ token: preview.token, indices: [0, 1], withoutSecrets: true });

      expect(result.created).toHaveLength(2);
      expect(result.secretsNotStored).toEqual([]);
      expect(b.conns.get(result.created[0]!.id).hasPasswordStored).toBe(false);
    });

    it('without secure storage and with the plaintext fallback off, imports the connections without secrets and says why', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install({ allowPlaintext: false });
      b.keychain.setAvailable(false);
      const preview = await previewOf(b);

      const result = await b.service.importCommit({ token: preview.token, indices: [0, 1], passphrase: PASS });

      expect(result.created.map((c) => c.name)).toEqual(['One', 'Three']);
      expect(result.secretsNotStored).toEqual([
        {
          name: 'One',
          reason: 'No secure storage on this install, and storing passwords unencrypted is off.',
        },
      ]);
      expect(b.vault.has(result.created[0]!.id, 'password')).toBe(false);
      expect(b.conns.get(result.created[0]!.id).hasPasswordStored).toBe(false);
    });

    it('reports an unstorable connection once, however many of its secrets there are', async () => {
      const a = install();
      const c = await a.conns.create(input({ name: 'Many', password: 'p1', sshPassword: 's1', sshPassphrase: 's2' }));
      await a.service.export({ ids: [c.id], includeSecrets: true, passphrase: PASS });
      const b = install();
      b.keychain.setAvailable(false);
      const preview = await previewOf(b);

      const result = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });

      expect(result.created).toHaveLength(1);
      expect(result.secretsNotStored).toHaveLength(1);
    });

    it('stores secrets in the vault when the install allows plaintext storage', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install({ allowPlaintext: true });
      b.keychain.setAvailable(false);
      const preview = await previewOf(b);
      const result = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });
      expect(result.secretsNotStored).toEqual([]);
      expect(b.vault.get(result.created[0]!.id, 'password')).toBe('pw-one');
    });

    it('imports ssh-enabled connections with ssh left on, and all three secret kinds', async () => {
      const a = install();
      const c = await a.conns.create(
        input({
          name: 'Tunnelled',
          ssh: { enabled: true, host: 'bastion', port: 22, username: 'me', authMethod: 'password' },
          password: 'db-pw',
          sshPassword: 'ssh-pw',
          sshPassphrase: 'ssh-phrase',
        }),
      );
      await a.service.export({ ids: [c.id], includeSecrets: true, passphrase: PASS });
      const b = install();
      const preview = await previewOf(b);

      const result = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });

      const id = result.created[0]!.id;
      expect(b.conns.get(id).ssh).toEqual({ enabled: true, host: 'bastion', port: 22, username: 'me', authMethod: 'password' });
      expect(b.vault.get(id, 'password')).toBe('db-pw');
      expect(b.vault.get(id, 'ssh_password')).toBe('ssh-pw');
      expect(b.vault.get(id, 'ssh_passphrase')).toBe('ssh-phrase');
    });

    it('imports an x509 connection that carries no certificate path, and lists what to re-pick', async () => {
      const a = install();
      const c = await a.conns.create(
        input({
          name: 'Cert',
          authMech: 'x509',
          authUsername: 'CN=me',
          tls: { enabled: true, verify: true, caPath: '/ca.pem', clientCertPath: '/me.pem' },
        }),
      );
      await a.service.export({ ids: [c.id], includeSecrets: false });
      const b = install();
      const preview = await previewOf(b);
      expect(preview.entries[0]!.repick).toEqual(['tlsCa', 'tlsClientCert']);
      const result = await b.service.importCommit({ token: preview.token, indices: [0] });
      const stored = b.conns.get(result.created[0]!.id);
      expect(stored.tls.clientCertPath).toBeUndefined();
      expect(stored.tls.caPath).toBeUndefined();
    });

    it('a file that sets tls.clientCertPath is rejected at preview and creates nothing', async () => {
      const a = install();
      const c = await a.conns.create(input());
      await a.service.export({ ids: [c.id], includeSecrets: false });
      const crafted = JSON.parse(fs.readFileSync(file, 'utf8'));
      crafted.connections[0].tls.clientCertPath = '/home/victim/.ssh/id_rsa';
      fs.writeFileSync(file, JSON.stringify(crafted));
      const b = install();

      await expectCode(b.service.importPreview(), 'VALIDATION');

      expect(b.repo.list()).toEqual([]);
    });

    it('a rejected file issues no token, so nothing can be committed', async () => {
      const a = install();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ format: 'something.else' }));
      await expectCode(a.service.importPreview(), 'VALIDATION');
      await expectCode(a.service.importCommit({ token: 'anything', indices: [0] }), 'VALIDATION');
    });

    it('cancelling the open dialog is not an error', async () => {
      const a = install();
      openFrom = null;
      expect(await a.service.importPreview()).toEqual({ cancelled: true });
    });

    it('refuses a file larger than the limit without reading it', async () => {
      const a = install();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x'.repeat(MAX_FILE_BYTES + 1));
      const read = vi.spyOn(fs.promises, 'readFile');
      await expectCode(a.service.importPreview(), 'VALIDATION');
      expect(read).not.toHaveBeenCalled();
    });

    it('clearPending invalidates every token', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);
      b.service.clearPending();
      await expectCode(
        b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS }),
        'VALIDATION',
      );
      expect(b.conns.list()).toEqual([]);
    });

    it.each([
      ['an out-of-range index', [5]],
      ['a negative index', [-1]],
      ['a fractional index', [0.5]],
      ['a repeated index', [0, 0]],
    ])('rejects %s without writing anything or spending the token', async (_label, indices) => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);
      await expectCode(
        b.service.importCommit({ token: preview.token, indices, passphrase: PASS }),
        'VALIDATION',
      );
      expect(b.conns.list()).toEqual([]);
      const ok = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });
      expect(ok.created).toHaveLength(1);
    });

    it('an unknown token is VALIDATION', async () => {
      const a = install();
      await expectCode(a.service.importCommit({ token: 'nope', indices: [0] }), 'VALIDATION');
    });

    it('names are planned over the whole file, so unticking an entry cannot move another one\'s name', async () => {
      const a = install();
      const first = await a.conns.create(input({ name: 'Prod', host: 'a.example.com' }));
      const second = await a.conns.create(
        input({ name: 'Prod 2', host: 'b.example.com', tls: { enabled: true, verify: true, caPath: '/ca.pem' } }),
      );
      await a.service.export({ ids: [first.id, second.id], includeSecrets: false });
      // Both entries are called "Prod" in the file.
      const crafted = JSON.parse(fs.readFileSync(file, 'utf8'));
      crafted.connections[1].name = 'Prod';
      fs.writeFileSync(file, JSON.stringify(crafted));
      const b = install();
      await b.conns.create(input({ name: 'Prod' }));
      const preview = await previewOf(b);
      expect(preview.entries.map((e) => e.savedAs)).toEqual(['Prod (2)', 'Prod (3)']);

      const result = await b.service.importCommit({ token: preview.token, indices: [1] });

      expect(result.created).toEqual([expect.objectContaining({ index: 1, name: 'Prod (3)' })]);
      expect(preview.entries[result.created[0]!.index]!.repick).toEqual(['tlsCa']);
      expect(b.conns.get(result.created[0]!.id).host).toBe('b.example.com');
    });

    it('keeps going when one entry cannot be created, and reports which', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const service = new ConnectionExportService({ conns: b.conns, vault: b.vault, dialogs, scrypt: FAST, log });
      const preview = (await service.importPreview()) as Exclude<ImportPreview, { cancelled: true }>;
      const create = b.conns.create.bind(b.conns);
      vi.spyOn(b.conns, 'create').mockImplementationOnce(async () => {
        throw new ConflictError("connection name 'One' already exists");
      }).mockImplementation(create);

      const result = await service.importCommit({ token: preview.token, indices: [0, 1], passphrase: PASS });

      expect(result.failed).toEqual([{ index: 0, name: 'One', reason: "connection name 'One' already exists" }]);
      expect(result.created.map((c) => [c.index, c.name])).toEqual([[1, 'Three']]);
      expect(b.conns.list().map((c) => c.name)).toEqual(['Three']);
      expect(log.error).toHaveBeenCalledWith('conn-import', expect.any(String), expect.objectContaining({ index: 0 }));
    });

    it('reports a secret the vault failed to store, and keeps the connection', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);
      vi.spyOn(b.vault, 'set').mockImplementation(() => {
        throw new Error('disk on fire');
      });
      const result = await b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });
      expect(result.created).toHaveLength(1);
      expect(result.secretsNotStored).toEqual([{ name: 'One', reason: 'The password could not be stored.' }]);
    });

    it('a token is single-use even for two commits racing on it', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const preview = await previewOf(b);
      const attempt = () => b.service.importCommit({ token: preview.token, indices: [0], passphrase: PASS });

      const outcomes = await Promise.allSettled([attempt(), attempt()]);

      expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(b.conns.list()).toHaveLength(1);
    });

    it('two previews hold independent tokens', async () => {
      const a = install();
      await exportTwoOfThree(a);
      const b = install();
      const first = await previewOf(b);
      const second = (await b.service.importPreview()) as Exclude<ImportPreview, { cancelled: true }>;
      expect(second.token).not.toBe(first.token);
      await b.service.importCommit({ token: second.token, indices: [1], withoutSecrets: true });
      const later = await b.service.importCommit({ token: first.token, indices: [0], passphrase: PASS });
      expect(later.created).toHaveLength(1);
    });
  });

  describe('connection strings (C13 §7.1)', () => {
    const DEFAULTS = { readOnly: false, directConnection: false };

    it('previews names against existing Connections and never returns a password', async () => {
      const a = install();
      await a.conns.create(input({ name: 'db.example.com' }));

      const preview = a.service.previewUris([
        'mongodb://alice:s3cret@db.example.com',
        'not a uri',
        'mongodb://localhost:1',
        'mongodb://localhost:2',
      ]);

      expect(preview.entries.map((e) => (e.ok ? e.savedAs : e.reason))).toEqual([
        'db.example.com (2)',
        'URI must start with mongodb:// or mongodb+srv://',
        'localhost:1',
        'localhost:2',
      ]);
      expect(preview.entries[0]).toMatchObject({ hasPassword: true, needsCredentials: false, authUsername: 'alice' });
      expect(JSON.stringify(preview)).not.toContain('s3cret');
    });

    it('creates every good line with the defaults and typed credentials, and reports the bad ones', async () => {
      const a = install();

      const result = await a.service.createFromUris({
        uris: ['mongodb://alice:pw1@one', 'nope', 'mongodb://two', 'mongodb+srv://c.example.net'],
        defaults: { readOnly: true, directConnection: true },
        credentials: [{ index: 2, username: 'bob', password: 'pw2' }],
      });

      expect(result.created.map((c) => [c.index, c.name])).toEqual([
        [0, 'one'],
        [2, 'two'],
        [3, 'c.example.net'],
      ]);
      expect(result.failed).toEqual([
        { index: 1, name: 'Line 2', reason: 'URI must start with mongodb:// or mongodb+srv://' },
      ]);
      expect(result.secretsNotStored).toEqual([]);

      const [one, two, srv] = result.created.map((c) => a.conns.get(c.id));
      expect(one).toMatchObject({ readOnly: true, authUsername: 'alice', hasPasswordStored: true });
      expect(one!.advanced.directConnection).toBe(true);
      expect(two).toMatchObject({ authMech: 'default', authUsername: 'bob', hasPasswordStored: true });
      expect(a.vault.get(two!.id, 'password')).toBe('pw2');
      expect(srv!.advanced.directConnection).toBe(false);
      expect(srv).toMatchObject({ authMech: 'none', hasPasswordStored: false });
    });

    it("keeps a line's own directConnection over the batch default", async () => {
      const a = install();
      const result = await a.service.createFromUris({
        uris: ['mongodb://off/?directConnection=false', 'mongodb://on'],
        defaults: { readOnly: false, directConnection: true },
        credentials: [],
      });
      const [off, on] = result.created.map((c) => a.conns.get(c.id));
      expect(off!.advanced.directConnection).toBe(false);
      expect(on!.advanced.directConnection).toBe(true);
    });

    it('saves a line with blank credentials without authentication', async () => {
      const a = install();
      const result = await a.service.createFromUris({
        uris: ['mongodb://local'],
        defaults: DEFAULTS,
        credentials: [{ index: 0, username: '', password: '' }],
      });
      expect(a.conns.get(result.created[0]!.id)).toMatchObject({ authMech: 'none', hasPasswordStored: false });
    });

    it('fails a line the import rules reject and still creates the rest', async () => {
      const a = install();
      const result = await a.service.createFromUris({
        uris: ['mongodb://h', 'mongodb://k'],
        defaults: DEFAULTS,
        credentials: [{ index: 0, password: 'orphan' }],
      });
      expect(result.failed).toEqual([
        { index: 0, name: 'h', reason: 'Password must be empty when authentication is none' },
      ]);
      expect(result.created.map((c) => c.name)).toEqual(['k']);
    });

    it('re-plans names at commit, so a Connection created since the preview is not clashed with', async () => {
      const a = install();
      expect(a.service.previewUris(['mongodb://h']).entries[0]).toMatchObject({ savedAs: 'h' });
      await a.conns.create(input({ name: 'h' }));

      const result = await a.service.createFromUris({ uris: ['mongodb://h'], defaults: DEFAULTS, credentials: [] });

      expect(result.created[0]!.name).toBe('h (2)');
    });

    it('keeps the Connection and says why when the password cannot be stored securely', async () => {
      const a = install({ allowPlaintext: false });
      a.keychain.setAvailable(false);

      const result = await a.service.createFromUris({
        uris: ['mongodb://u:p@h'],
        defaults: DEFAULTS,
        credentials: [],
      });

      expect(result.created).toHaveLength(1);
      expect(a.conns.get(result.created[0]!.id).hasPasswordStored).toBe(false);
      expect(result.secretsNotStored).toEqual([
        { name: 'h', reason: 'No secure storage on this install, and storing passwords unencrypted is off.' },
      ]);
    });

    it('reports a line the repository refuses and carries on', async () => {
      const a = install();
      const real = a.conns.create.bind(a.conns);
      const spy = vi.spyOn(a.conns, 'create');
      spy.mockImplementationOnce(async () => {
        throw new ConflictError('taken');
      });
      spy.mockImplementation(real);

      const result = await a.service.createFromUris({
        uris: ['mongodb://h', 'mongodb://k'],
        defaults: DEFAULTS,
        credentials: [],
      });

      expect(result.failed).toEqual([{ index: 0, name: 'h', reason: 'taken' }]);
      expect(result.created.map((c) => c.name)).toEqual(['k']);
    });

    it('reports a non-app error generically', async () => {
      const a = install();
      vi.spyOn(a.conns, 'create').mockRejectedValueOnce(new Error('disk on fire'));
      const result = await a.service.createFromUris({ uris: ['mongodb://h'], defaults: DEFAULTS, credentials: [] });
      expect(result.failed).toEqual([{ index: 0, name: 'h', reason: 'Unexpected error' }]);
    });
  });
});
