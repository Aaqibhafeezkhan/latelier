import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionInput, ImportOpenResult, Review, ReviewRow } from '@shared/types';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { ConflictError, ValidationError, type AppError } from '../../electron/errors';
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
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const wizard = new ImportWizardService({ conns, vault, dialogs, log });
    const exporter = new ConnectionExportService({ conns, vault, dialogs, scrypt: FAST });
    return { keychain, vault, repo, conns, wizard, exporter, log };
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

    it('refuses a file that is gone without naming its path', async () => {
      const a = install();
      openFrom = path.join(dir, 'gone.json');
      const err = (await a.wizard.importOpen().then(
        () => null,
        (e: unknown) => e,
      )) as AppError;
      expect(err).toMatchObject({ code: 'VALIDATION', message: "This file can't be read." });
      expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(dir);
      expect(a.log.warn).toHaveBeenCalledWith('conn-import', 'could not read the picked file', { code: 'ENOENT' });
      expect(JSON.stringify(a.log.warn.mock.calls)).not.toContain(dir);
    });

    // Root reads a mode-000 file anyway, so the read error can't be produced there.
    it.skipIf(process.getuid?.() === 0)('refuses a file it may not read without naming its path', async () => {
      const a = install();
      openFrom = writeFile('locked.json', '{"servers":[{"host":"h"}]}');
      fs.chmodSync(openFrom, 0o000);
      const err = (await a.wizard.importOpen().then(
        () => null,
        (e: unknown) => e,
      )) as AppError;
      expect(err).toMatchObject({ code: 'VALIDATION', message: "This file can't be read." });
      expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(dir);
      expect(a.log.warn).toHaveBeenCalledWith('conn-import', 'could not read the picked file', { code: 'EACCES' });
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
        a.wizard.importCommit({
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
      const result = await a.wizard.importCommit({
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
        a.wizard.importCommit({ token, indices, passphrase: COMPASS_PASS, readOnly: false, credentials: [], directConnection: [] });
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
      const result = await a.wizard.importCommit({
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

      const result = await a.wizard.importCommit({
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
        b.wizard.importCommit({ token, indices: [0, 1], passphrase, readOnly: true, credentials: [], directConnection: [] });
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
      const result = await b.wizard.importCommit({
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
        await codeOf(a.wizard.importCommit({ token, indices: [0], readOnly: false, credentials: [], directConnection: [] })),
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

      const result = await a.wizard.importCommit({
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

  describe('Unknown JSON: paths that name two things', () => {
    // `db.servers` is both a literal dotted key and real nesting: picking one must never import the other.
    const REVIEWED = '{"db.servers":[{"host":"first.example"}],"db":{"servers":[{"host":"second.example"}]}';

    it('does not offer or import lists that share a path, and says how many paths were left out', async () => {
      const a = install();
      const opened = await open(a.wizard, writeFile('u.json', `${REVIEWED},"ok":[{"host":"ok.example"}]}`));
      if (opened.source !== 'unknown') throw new Error('expected unknown');
      expect(opened.collections.map((c) => c.at)).toEqual(['ok']);
      expect(opened.ambiguousCollections).toBe(1);
      expect(await codeOf(() => a.wizard.importMap({ token: opened.token, at: 'db.servers', mapping: { host: 'host' } }))).toBe(
        'VALIDATION',
      );
      const mapped = a.wizard.importMap({ token: opened.token, at: 'ok', mapping: { host: 'host' } });
      expect(okRow(mapped.review, 0)).toMatchObject({ host: 'ok.example' });
    });

    it('refuses a file whose only lists share a path', async () => {
      const a = install();
      openFrom = writeFile('u.json', `${REVIEWED}}`);
      const err = await a.wizard.importOpen().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).not.toMatch(/example|db\.servers/);
    });

    it('reads neither value of a field two leaves share, and says how many fields were left out', async () => {
      const a = install();
      const opened = await open(a.wizard, writeFile('u.json', '[{"host":"h.example","a.b":"first","a":{"b":"second"}}]'));
      if (opened.source !== 'unknown') throw new Error('expected unknown');
      expect(opened.collections[0]).toMatchObject({ fields: [{ path: 'host' }], ambiguousFields: 1 });
      const mapped = a.wizard.importMap({ token: opened.token, at: '', mapping: { host: 'host', name: 'a.b' } });
      expect(okRow(mapped.review, 0).savedAs).toBe('h.example');
    });

    it('saves a row whose password came without a username, left untouched, without authentication', async () => {
      const a = install();
      const opened = await open(a.wizard, writeFile('p.json', '[{"uri":"mongodb://h.example","pass":"from-file"}]'));
      if (opened.source !== 'unknown') throw new Error('expected unknown');
      const mapped = a.wizard.importMap({ token: opened.token, at: '', mapping: { connectionString: 'uri', password: 'pass' } });
      expect(okRow(mapped.review, 0)).toMatchObject({ hasPassword: true, needsCredentials: true });
      // The review sends no credentials for a row the user never touched.
      const result = await a.wizard.importCommit({ token: opened.token, indices: [0], readOnly: false, credentials: [], directConnection: [] });
      expect(result.skipped).toEqual([]);
      const saved = a.conns.get(result.created[0]!.id);
      expect(saved).toMatchObject({ authMech: 'none', hasPasswordStored: false });
      expect(saved.authUsername ?? '').toBe('');
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
      const result = await a.wizard.importCommit({
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
        a.wizard.importCommit({ token, indices, readOnly: false, credentials: [], directConnection: [] });
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
      const result = await a.wizard.importCommit({ token, indices: [0, 1], readOnly: false, credentials: [], directConnection: [] });
      expect(result.created.map((c) => c.name)).toEqual(['h (2)', 'k']);
      expect(result.renamed).toEqual([{ index: 0, from: 'h', to: 'h (2)' }]);
    });

    it('skips a row the import rules reject and still creates the rest', async () => {
      const a = install();
      const { token } = a.wizard.importUris(['mongodb://h', 'mongodb://k']);
      const result = await a.wizard.importCommit({
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
      const result = await a.wizard.importCommit({ token, indices: [0], readOnly: false, credentials: [], directConnection: [] });
      expect(result.created).toHaveLength(1);
      expect(result.secretsNotStored).toEqual([
        { name: 'h', reason: 'No secure storage on this install, and storing passwords unencrypted is off.' },
      ]);
      expect(a.conns.get(result.created[0]!.id).hasPasswordStored).toBe(false);
    });
  });

  describe('commit', () => {
    const commitAll = (w: ImportWizardService, token: string, indices: number[]) =>
      w.importCommit({ token, indices, readOnly: false, credentials: [], directConnection: [] });

    describe('sealed secrets of a L\'Atelier export', () => {
      /** Exports one Connection holding all three secret kinds and opens it on a second install. */
      const sealedImport = async (second: { allowPlaintext?: boolean }, setup?: (b: ReturnType<typeof install>) => void) => {
        const a = install();
        const c = await a.conns.create(input({ name: 'Many', password: 'p1', sshPassword: 's1', sshPassphrase: 's2' }));
        await a.exporter.export({ ids: [c.id], includeSecrets: true, passphrase: EXPORT_PASS });
        const b = install(second);
        setup?.(b);
        const { token } = await openReview(b.wizard, path.join(dir, 'export.json'));
        const run = () =>
          b.wizard.importCommit({ token, indices: [0], passphrase: EXPORT_PASS, readOnly: false, credentials: [], directConnection: [] });
        return { b, run };
      };

      it('reports an unstorable Connection once, however many of its secrets there are', async () => {
        const { run } = await sealedImport({}, (b) => b.keychain.setAvailable(false));
        const result = await run();
        expect(result.created).toHaveLength(1);
        expect(result.secretsNotStored).toHaveLength(1);
      });

      it('stores the secrets in the vault when the install allows plaintext storage', async () => {
        const { b, run } = await sealedImport({ allowPlaintext: true }, (i) => i.keychain.setAvailable(false));
        const result = await run();
        expect(result.secretsNotStored).toEqual([]);
        expect(b.vault.get(result.created[0]!.id, 'password')).toBe('p1');
      });

      it('reports a secret the vault failed to store, and keeps the Connection', async () => {
        const { b, run } = await sealedImport({});
        vi.spyOn(b.vault, 'set').mockImplementation(() => {
          throw new Error('disk on fire');
        });
        const result = await run();
        expect(result.created).toHaveLength(1);
        expect(result.secretsNotStored).toEqual([{ name: 'Many', reason: 'The password could not be stored.' }]);
      });
    });

    it('lets one of two concurrent commits on a token through, so rows are created once', async () => {
      const a = install();
      const { token } = a.wizard.importUris(['mongodb://h', 'mongodb://k']);
      const outcomes = await Promise.allSettled([commitAll(a.wizard, token, [0, 1]), commitAll(a.wizard, token, [0, 1])]);
      const refused = outcomes.filter((o) => o.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'VALIDATION' });
      expect(a.conns.list().map((c) => c.name).sort((x, y) => x.localeCompare(y))).toEqual(['h', 'k']);
    });

    it('skips a row create() refuses and still creates the rows after it', async () => {
      const a = install();
      const { token } = a.wizard.importUris(['mongodb://h', 'mongodb://k', 'mongodb://m']);
      const create = a.conns.create.bind(a.conns);
      vi.spyOn(a.conns, 'create')
        .mockRejectedValueOnce(new Error('disk full at /secret/path'))
        .mockRejectedValueOnce(new ConflictError("connection name 'k' already exists"))
        .mockImplementation(create);
      const result = await commitAll(a.wizard, token, [0, 1, 2]);
      expect(result.skipped).toEqual([
        { index: 0, name: 'h', reason: 'Unexpected error' },
        { index: 1, name: 'k', reason: "connection name 'k' already exists" },
      ]);
      expect(result.created.map((c) => c.name)).toEqual(['m']);
      expect(a.log.error).toHaveBeenCalledTimes(2);
    });

    it('a window closing while a passphrase is checked clears the token for good', async () => {
      const a = install();
      const { token } = await openReview(a.wizard, ENCRYPTED);
      const commit = (passphrase: string) =>
        a.wizard.importCommit({ token, indices: [0], passphrase, readOnly: false, credentials: [], directConnection: [] });
      const wrong = commit('not the passphrase');
      // The commit is waiting on the key derivation; the window closes now.
      a.wizard.clearPending();
      expect(await codeOf(wrong)).toBe('BAD_PASSPHRASE');
      await expect(commit(COMPASS_PASS)).rejects.toMatchObject({
        code: 'VALIDATION',
        message: 'This import has expired. Choose the file again.',
      });
      expect(a.conns.list()).toEqual([]);
    });
  });

  describe('tokens', () => {
    it.each(['importOpen', 'importUris'] as const)('%s drops the token of an earlier, abandoned import', async (next) => {
      const a = install();
      const first = a.wizard.importUris(['mongodb://alice:hunter2@h']);
      if (next === 'importOpen') await open(a.wizard, writeFile('b.json', '{"servers":[{"host":"h"}]}'));
      else a.wizard.importUris(['mongodb://k']);
      await expect(
        a.wizard.importCommit({ token: first.token, indices: [0], readOnly: false, credentials: [], directConnection: [] }),
      ).rejects.toMatchObject({
        code: 'VALIDATION',
        message: 'This import has expired. Choose the file again.',
      });
      expect(a.conns.list()).toEqual([]);
    });

    it('keeps the token of the newest import usable', async () => {
      const a = install();
      a.wizard.importUris(['mongodb://h']);
      const second = a.wizard.importUris(['mongodb://k']);
      const result = await a.wizard.importCommit({
        token: second.token, indices: [0], readOnly: false, credentials: [], directConnection: [],
      });
      expect(result.created.map((c) => c.name)).toEqual(['k']);
    });

    it('clearPending invalidates every token, whatever its source', async () => {
      const a = install();
      const uris = a.wizard.importUris(['mongodb://h']);
      const unknown: ImportOpenResult = await open(a.wizard, writeFile('u.json', '{"servers":[{"host":"h"}]}'));
      a.wizard.clearPending();
      expect(
        await codeOf(a.wizard.importCommit({ token: uris.token, indices: [0], readOnly: false, credentials: [], directConnection: [] })),
      ).toBe('VALIDATION');
      if (!('token' in unknown)) throw new Error('expected a token');
      expect(await codeOf(() => a.wizard.importMap({ token: unknown.token, at: 'servers', mapping: { host: 'host' } }))).toBe(
        'VALIDATION',
      );
    });
  });
});
