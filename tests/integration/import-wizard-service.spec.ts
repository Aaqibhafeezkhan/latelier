import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionInput, ImportOpenResult, Review, ReviewRow } from '@shared/types';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import type { AppError } from '../../electron/errors';
import { ConnectionService, connectionReader } from '../../electron/mongo/ConnectionService';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { ConnectionExportService } from '../../electron/services/ConnectionExportService';
import { MAX_FILE_BYTES } from '../../electron/services/connectionExportFormat';
import { ImportWizardService } from '../../electron/services/ImportWizardService';
import { createTempDb, type TempDb } from '../helpers/db';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { useUmask022 } from '../helpers/umask';

const COMPASS = path.join(__dirname, '../fixtures/compass');
const PLAIN = path.join(COMPASS, 'plain.json');
const ENCRYPTED = path.join(COMPASS, 'encrypted.json');
const COMPASS_PASS = fs.readFileSync(path.join(COMPASS, 'passphrase.txt'), 'utf8').trim();
const EXPORT_PASS = 'twelve chars!!';
const FAST = { N: 1024, r: 8, p: 1 };

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

/** Compass's blob layout, for an entry the real fixture doesn't have (a secret L'Atelier has no place for). */
function compassBlob(secrets: Record<string, string>, pass: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(pass, salt, 100_000, 32, 'sha512'), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify({ secrets }), 'utf8'), cipher.final()]);
  const version = Buffer.alloc(2);
  version.writeUInt16BE(1);
  return Buffer.concat([version, salt, iv, cipher.getAuthTag(), ct]).toString('base64');
}

const codeOf = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    return (err as AppError).code;
  }
  throw new Error('expected a refusal');
};

type OkRow = Extract<ReviewRow, { ok: true }>;
const okRow = (review: Review, i: number): OkRow => {
  const r = review.rows[i]!;
  if (!r.ok) throw new Error(`row ${i} is unusable: ${r.reason}`);
  return r;
};

describe('ImportWizardService', () => {
  let dir: string;
  let openFrom: string | null;
  let installs: TempDb[];
  let restoreUmask: () => void;

  /** One app install: its own database, keychain and services; both share the dialogs. */
  const install = (opts: { allowPlaintext?: boolean } = {}) => {
    const tmp = createTempDb();
    installs.push(tmp);
    const keychain = createSafeStorageMock();
    const vault = new SecretsVault(tmp.db, keychain, { getAllowPlaintext: () => opts.allowPlaintext ?? false });
    const repo = new ConnectionRepo(tmp.db);
    const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    const conns = new ConnectionService({ repo, vault, pool });
    const dialogs = { savePath: async () => path.join(dir, 'export.json'), openPath: async () => openFrom };
    const wizard = new ImportWizardService({ conns, vault, dialogs });
    const exporter = new ConnectionExportService({ conns, vault, dialogs, scrypt: FAST });
    return { keychain, vault, repo, conns, wizard, exporter };
  };

  const writeFile = (name: string, content: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  const open = async (w: ImportWizardService, file: string) => {
    openFrom = file;
    const result = await w.importOpen();
    if ('cancelled' in result) throw new Error('unexpected cancel');
    return result;
  };
  const openReview = async (w: ImportWizardService, file: string) => {
    const result = await open(w, file);
    if (result.source === 'unknown') throw new Error('expected a known source');
    return result;
  };

  beforeEach(() => {
    restoreUmask = useUmask022();
    installs = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-import-wizard-'));
    openFrom = null;
  });

  afterEach(() => {
    for (const t of installs) t.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    restoreUmask();
    vi.restoreAllMocks();
  });

  describe('importOpen', () => {
    it('cancelling the dialog is not an error', async () => {
      const a = install();
      expect(await a.wizard.importOpen()).toEqual({ cancelled: true });
    });

    it('refuses a file over the limit without reading it', async () => {
      const a = install();
      const file = writeFile('big.json', 'x'.repeat(MAX_FILE_BYTES + 1));
      const read = vi.spyOn(fs.promises, 'readFile');
      openFrom = file;
      await expect(a.wizard.importOpen()).rejects.toMatchObject({
        code: 'VALIDATION',
        message: 'This file is too large to import (5 MB limit).',
      });
      expect(read).not.toHaveBeenCalled();
    });

    it.each([
      ['a file that is not JSON', 'not json', "This isn't a JSON file."],
      ['JSON with nothing to map', '42', 'No connections found in this file.'],
    ])('refuses %s', async (_label, content, message) => {
      const a = install();
      openFrom = writeFile('f.json', content);
      await expect(a.wizard.importOpen()).rejects.toMatchObject({ code: 'VALIDATION', message });
    });

    it('lists an unknown file\'s collections, largest first, with masked samples', async () => {
      const a = install();
      const file = writeFile(
        'unknown.json',
        JSON.stringify({ data: { servers: [{ label: 'A', secret: 's-marker' }], other: [{ x: 1 }, { x: 2 }] } }),
      );
      const result = await open(a.wizard, file);
      if (result.source !== 'unknown') throw new Error('expected unknown');
      expect(result.collections.map((c) => [c.at, c.rows])).toEqual([
        ['data.other', 2],
        ['data.servers', 1],
      ]);
      expect(result.collections[1]!.fields).toContainEqual({ path: 'secret', sample: '••••', masked: true });
      expect(JSON.stringify(result)).not.toContain('s-marker');
    });
  });

  describe('a real Compass export with a passphrase', () => {
    it('reviews without the passphrase, refuses a wrong one, then imports with the right one', async () => {
      const a = install();
      const opened = await openReview(a.wizard, ENCRYPTED);
      expect(opened.source).toBe('compass');
      const { review } = opened;
      expect(review.hasEncryptedSecrets).toBe(true);
      expect(okRow(review, 0)).toMatchObject({
        savedAs: 'Fixture favourite',
        authUsername: 'alice',
        hasPassword: true,
        passwordSealed: true,
        needsCredentials: false,
        directConnection: true,
        defaultTicked: true,
        ssh: false,
      });
      expect(okRow(review, 1)).toMatchObject({ savedAs: 'Fixture SSH password', ssh: true, repick: [] });
      expect(okRow(review, 2)).toMatchObject({ savedAs: 'Fixture SSH key', ssh: true, repick: ['sshKey'] });
      expect(review.rows[3]).toEqual({ index: 3, ok: false, reason: "OIDC sign-in isn't supported yet." });

      const commit = (passphrase?: string) =>
        a.wizard.importCommitV2({
          token: opened.token,
          indices: [0, 1, 2],
          ...(passphrase === undefined ? {} : { passphrase }),
          readOnly: false,
          credentials: [],
          directConnection: [],
        });

      expect(await codeOf(commit('not the passphrase'))).toBe('BAD_PASSPHRASE');
      expect(await codeOf(commit())).toBe('VALIDATION');
      expect(a.conns.list()).toEqual([]);

      const result = await commit(COMPASS_PASS);
      expect(result.created.map((c) => c.name)).toEqual(['Fixture favourite', 'Fixture SSH password', 'Fixture SSH key']);
      expect(result.skipped).toEqual([]);
      expect(result.renamed).toEqual([]);
      expect(result.secretsNotStored).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.repick).toEqual([{ name: 'Fixture SSH key', files: ['sshKey'] }]);

      const [fav, sshPw, sshKey] = result.created.map((c) => c.id);
      expect(a.vault.get(fav!, 'password')).toBe('fixture-pw-1');
      expect(a.vault.get(sshPw!, 'password')).toBe('fixture-pw-2');
      expect(a.vault.get(sshPw!, 'ssh_password')).toBe('fixture-ssh-pw');
      expect(a.vault.get(sshKey!, 'password')).toBe('fixture-pw-3');
      expect(a.vault.get(sshKey!, 'ssh_passphrase')).toBe('fixture-key-pass');
      expect(a.conns.get(fav!)).toMatchObject({
        host: 'db1.example.test',
        authMech: 'default',
        authUsername: 'alice',
        authDatabase: 'admin',
        color: '#7c6af7',
        hasPasswordStored: true,
      });
      expect(a.conns.get(sshKey!).ssh).toEqual({
        enabled: true,
        host: 'bastion.example.test',
        port: 2222,
        username: 'tunnel',
        authMethod: 'key',
      });

      // The successful commit consumed the token.
      expect(await codeOf(commit(COMPASS_PASS))).toBe('VALIDATION');
      expect(a.conns.list()).toHaveLength(3);
    });

    it('"Import without passwords" needs no passphrase and takes typed credentials', async () => {
      const a = install();
      const { token } = await openReview(a.wizard, ENCRYPTED);
      const result = await a.wizard.importCommitV2({
        token,
        indices: [0, 1],
        withoutSecrets: true,
        readOnly: false,
        credentials: [{ index: 0, password: 'typed-pw' }],
        directConnection: [],
      });
      const [fav, ssh] = result.created.map((c) => c.id);
      expect(a.vault.get(fav!, 'password')).toBe('typed-pw');
      expect(a.conns.get(ssh!)).toMatchObject({ hasPasswordStored: false, hasSshPasswordStored: false });
    });

    it('refuses to tick the OIDC row and keeps the token', async () => {
      const a = install();
      const { token } = await openReview(a.wizard, ENCRYPTED);
      const commit = (indices: number[]) =>
        a.wizard.importCommitV2({ token, indices, passphrase: COMPASS_PASS, readOnly: false, credentials: [], directConnection: [] });
      await expect(commit([0, 3])).rejects.toMatchObject({
        code: 'VALIDATION',
        message: "The selection includes a connection that can't be imported.",
      });
      expect((await commit([0])).created).toHaveLength(1);
    });

    it("reports a Compass secret L'Atelier has no place for by its name only", async () => {
      const a = install();
      const file = writeFile(
        'extra.json',
        JSON.stringify({
          type: 'Compass Connections',
          version: { $numberInt: '1' },
          connections: [
            {
              favorite: { name: 'Extra' },
              connectionOptions: { connectionString: 'mongodb://u@h.example/' },
              savedConnectionType: 'favorite',
              connectionSecrets: compassBlob({ password: 'pw', awsSessionToken: 'tok-marker' }, 'blob pass'),
            },
          ],
        }),
      );
      const { token } = await openReview(a.wizard, file);
      const result = await a.wizard.importCommitV2({
        token,
        indices: [0],
        passphrase: 'blob pass',
        readOnly: false,
        credentials: [],
        directConnection: [],
      });
      expect(result.warnings).toEqual([{ name: 'Extra', message: 'The "awsSessionToken" secret was not imported.' }]);
      expect(a.vault.get(result.created[0]!.id, 'password')).toBe('pw');
      expect(JSON.stringify(result)).not.toContain('tok-marker');
    });
  });

  describe('a real Compass export without a passphrase', () => {
    it('imports the secrets in clear, with the batch Read-only and Direct connection as sent', async () => {
      const a = install();
      const { token, review } = await openReview(a.wizard, PLAIN);
      expect(review.hasEncryptedSecrets).toBe(false);
      expect(okRow(review, 0)).toMatchObject({ hasPassword: true, passwordSealed: false, needsCredentials: false });

      const result = await a.wizard.importCommitV2({
        token,
        indices: [0, 2],
        readOnly: true,
        credentials: [],
        directConnection: [{ index: 0, value: false }],
      });

      const [fav, key] = result.created.map((c) => a.conns.get(c.id));
      expect(fav).toMatchObject({ name: 'Fixture favourite', readOnly: true, hasPasswordStored: true });
      expect(fav!.advanced.directConnection).toBe(false);
      // Not sent: the review's default for a single host, which is on.
      expect(key!.advanced.directConnection).toBe(true);
      expect(a.vault.get(key!.id, 'ssh_passphrase')).toBe('fixture-key-pass');
      // Unticked rows are not created.
      expect(a.conns.list().map((c) => c.name).sort((x, y) => x.localeCompare(y))).toEqual([
        'Fixture favourite',
        'Fixture SSH key',
      ]);
    });
  });

  describe("a L'Atelier export", () => {
    it('round-trips settings and sealed secrets, ignoring the batch Read-only', async () => {
      const a = install();
      const ro = await a.conns.create(input({ name: 'RO', readOnly: true, password: 'pw-ro' }));
      const rw = await a.conns.create(
        input({
          name: 'RW',
          color: '#123456',
          authMech: 'x509',
          authUsername: 'CN=me',
          tls: { enabled: true, verify: true, clientCertPath: '/me.pem' },
        }),
      );
      await a.exporter.export({ ids: [ro.id, rw.id], includeSecrets: true, passphrase: EXPORT_PASS });

      const b = install();
      const { token, source, review } = await openReview(b.wizard, path.join(dir, 'export.json'));
      expect(source).toBe('latelier');
      expect(review.hasEncryptedSecrets).toBe(true);
      expect(okRow(review, 0)).toMatchObject({ savedAs: 'RO', hasPassword: true, passwordSealed: true, directConnection: false });
      expect(okRow(review, 1)).toMatchObject({ savedAs: 'RW', hasPassword: false, needsCredentials: false, repick: ['tlsClientCert'] });

      const commit = (passphrase: string) =>
        b.wizard.importCommitV2({ token, indices: [0, 1], passphrase, readOnly: true, credentials: [], directConnection: [] });
      expect(await codeOf(commit('wrong passphrase!'))).toBe('BAD_PASSPHRASE');
      const result = await commit(EXPORT_PASS);

      const [roB, rwB] = result.created.map((c) => b.conns.get(c.id));
      expect(roB).toMatchObject({ readOnly: true, color: '#1A6835', hasPasswordStored: true });
      expect(rwB).toMatchObject({ readOnly: false, color: '#123456', authMech: 'x509' });
      expect(rwB!.tls.clientCertPath).toBeUndefined();
      expect(roB!.advanced.directConnection).toBe(false);
      expect(b.vault.get(roB!.id, 'password')).toBe('pw-ro');
      expect(result.repick).toEqual([{ name: 'RW', files: ['tlsClientCert'] }]);
    });

    it("applies a Direct connection the user turned on over the export's own value", async () => {
      const a = install();
      const c = await a.conns.create(input({ name: 'One', password: 'pw' }));
      await a.exporter.export({ ids: [c.id], includeSecrets: false });
      const b = install();
      const { token } = await openReview(b.wizard, path.join(dir, 'export.json'));
      const result = await b.wizard.importCommitV2({
        token,
        indices: [0],
        readOnly: false,
        credentials: [{ index: 0, password: 'typed' }],
        directConnection: [{ index: 0, value: true }],
      });
      const one = b.conns.get(result.created[0]!.id);
      expect(one.advanced.directConnection).toBe(true);
      expect(b.vault.get(one.id, 'password')).toBe('typed');
    });
  });

  describe('Unknown JSON', () => {
    const FILE = {
      data: {
        servers: [
          { label: 'A', uri: 'mongodb://u:pw-a@a.example/?directConnection=false', secret: 's-marker' },
          { label: 'B', host: 'b.example', port: 2000 },
        ],
      },
    };

    it('maps, re-maps on the same token, and commits the last mapping', async () => {
      const a = install();
      const opened = await open(a.wizard, writeFile('u.json', JSON.stringify(FILE)));
      if (opened.source !== 'unknown') throw new Error('expected unknown');
      const { token } = opened;

      // Nothing to commit before a mapping, and the refusal keeps the token.
      expect(
        await codeOf(a.wizard.importCommitV2({ token, indices: [0], readOnly: false, credentials: [], directConnection: [] })),
      ).toBe('VALIDATION');

      const first = a.wizard.importMap({ token, at: 'data.servers', mapping: { name: 'label', connectionString: 'uri' } });
      expect(okRow(first.review, 0)).toMatchObject({ savedAs: 'A', hasPassword: true, directConnection: false });
      expect(first.review.rows[1]).toEqual({ index: 1, ok: false, reason: 'No connection string or host in this row.' });

      const second = a.wizard.importMap({
        token,
        at: 'data.servers',
        mapping: { name: 'label', connectionString: 'uri', host: 'host', port: 'port' },
      });
      expect(okRow(second.review, 1)).toMatchObject({ savedAs: 'B', host: 'b.example', port: 2000 });

      const result = await a.wizard.importCommitV2({
        token,
        indices: [0, 1],
        readOnly: false,
        credentials: [],
        directConnection: [],
      });
      const [rowA, rowB] = result.created.map((c) => a.conns.get(c.id));
      expect(a.vault.get(rowA!.id, 'password')).toBe('pw-a');
      expect(rowA!.advanced.directConnection).toBe(false);
      expect(rowB).toMatchObject({ host: 'b.example', port: 2000, authMech: 'none' });
    });

    it('refuses a list that is not in the file, and mapping a known source', async () => {
      const a = install();
      const opened = await open(a.wizard, writeFile('u.json', JSON.stringify(FILE)));
      expect(await codeOf(() => a.wizard.importMap({ token: opened.token, at: 'data', mapping: {} }))).toBe('VALIDATION');

      const compass = await open(a.wizard, PLAIN);
      expect(() => a.wizard.importMap({ token: compass.token, at: '', mapping: {} })).toThrow(
        'Only a file in an unrecognised format has fields to map.',
      );
    });
  });

  describe('Pasted URIs', () => {
    const URIS = [
      'mongodb://alice:pw1@one',
      'nope',
      'mongodb://two',
      'mongodb+srv://c.example.net',
      'mongodb://a1,a2/',
    ];

    it('reviews every line, bad ones with their reason', () => {
      const a = install();
      const { review } = a.wizard.importUris(URIS);
      expect(review.hasEncryptedSecrets).toBe(false);
      expect(okRow(review, 0)).toMatchObject({ savedAs: 'one', hasPassword: true, directConnection: true });
      expect(review.rows[1]).toEqual({ index: 1, ok: false, reason: 'URI must start with mongodb:// or mongodb+srv://' });
      expect(okRow(review, 3)).toMatchObject({ srv: true, directConnection: null });
      expect(okRow(review, 4)).toMatchObject({ savedAs: 'a1', directConnection: false });
      expect(JSON.stringify(review)).not.toContain('pw1');
    });

    it('creates only the ticked rows, with credentials, Direct connection and Read-only as sent', async () => {
      const a = install();
      const { token } = a.wizard.importUris(URIS);
      const result = await a.wizard.importCommitV2({
        token,
        indices: [0, 2, 3],
        readOnly: true,
        credentials: [{ index: 2, username: 'bob', password: 'pw2' }],
        directConnection: [
          { index: 0, value: false },
          { index: 3, value: true },
        ],
      });
      expect(result.created.map((c) => [c.index, c.name])).toEqual([
        [0, 'one'],
        [2, 'two'],
        [3, 'c.example.net'],
      ]);
      const [one, two, srv] = result.created.map((c) => a.conns.get(c.id));
      expect(one).toMatchObject({ readOnly: true, hasPasswordStored: true });
      expect(one!.advanced.directConnection).toBe(false);
      expect(two).toMatchObject({ authMech: 'default', authUsername: 'bob' });
      expect(a.vault.get(two!.id, 'password')).toBe('pw2');
      // The driver refuses direct connection over SRV, whatever is sent.
      expect(srv!.advanced.directConnection).toBe(false);
      expect(a.conns.list()).toHaveLength(3);
    });

    it('refuses a bad selection before anything is written, keeping the token', async () => {
      const a = install();
      const { token } = a.wizard.importUris(URIS);
      const commit = (indices: number[]) =>
        a.wizard.importCommitV2({ token, indices, readOnly: false, credentials: [], directConnection: [] });
      expect(await codeOf(commit([1]))).toBe('VALIDATION');
      expect(await codeOf(commit([0, 0]))).toBe('VALIDATION');
      expect(await codeOf(commit([5]))).toBe('VALIDATION');
      expect(a.conns.list()).toEqual([]);
      expect((await commit([0])).created).toHaveLength(1);
    });

    it('re-plans names at commit and reports what moved since the review', async () => {
      const a = install();
      const { token, review } = a.wizard.importUris(['mongodb://h', 'mongodb://k']);
      expect(okRow(review, 0).savedAs).toBe('h');
      await a.conns.create(input({ name: 'h', password: 'x' }));
      const result = await a.wizard.importCommitV2({ token, indices: [0, 1], readOnly: false, credentials: [], directConnection: [] });
      expect(result.created.map((c) => c.name)).toEqual(['h (2)', 'k']);
      expect(result.renamed).toEqual([{ index: 0, from: 'h', to: 'h (2)' }]);
    });

    it('skips a row the import rules reject and still creates the rest', async () => {
      const a = install();
      const { token } = a.wizard.importUris(['mongodb://h', 'mongodb://k']);
      const result = await a.wizard.importCommitV2({
        token,
        indices: [0, 1],
        readOnly: false,
        credentials: [{ index: 0, password: 'orphan' }],
        directConnection: [],
      });
      expect(result.skipped).toEqual([{ index: 0, name: 'h', reason: 'Password must be empty when authentication is none' }]);
      expect(result.created.map((c) => c.name)).toEqual(['k']);
    });

    it('keeps the Connection and says why when its password cannot be stored securely', async () => {
      const a = install({ allowPlaintext: false });
      a.keychain.setAvailable(false);
      const { token } = a.wizard.importUris(['mongodb://u:p@h']);
      const result = await a.wizard.importCommitV2({ token, indices: [0], readOnly: false, credentials: [], directConnection: [] });
      expect(result.created).toHaveLength(1);
      expect(result.secretsNotStored).toEqual([
        { name: 'h', reason: 'No secure storage on this install, and storing passwords unencrypted is off.' },
      ]);
      expect(a.conns.get(result.created[0]!.id).hasPasswordStored).toBe(false);
    });
  });

  describe('tokens', () => {
    it('clearPending invalidates every token, whatever its source', async () => {
      const a = install();
      const uris = a.wizard.importUris(['mongodb://h']);
      const unknown: ImportOpenResult = await open(a.wizard, writeFile('u.json', '{"servers":[{"host":"h"}]}'));
      a.wizard.clearPending();
      expect(
        await codeOf(a.wizard.importCommitV2({ token: uris.token, indices: [0], readOnly: false, credentials: [], directConnection: [] })),
      ).toBe('VALIDATION');
      if (!('token' in unknown)) throw new Error('expected a token');
      expect(await codeOf(() => a.wizard.importMap({ token: unknown.token, at: 'servers', mapping: { host: 'host' } }))).toBe(
        'VALIDATION',
      );
    });
  });
});
