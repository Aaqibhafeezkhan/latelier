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
import type { AppError } from '../../electron/errors';
import type { ConnectionInput } from '@shared/types';
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
});
