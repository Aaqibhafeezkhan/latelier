import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { ImportCommitResult, ImportOpenResult, ImportUrisResult, Review } from '@shared/types';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { registerConnImportChannels } from '../../electron/ipc/handlers/connImport';
import { createRouter } from '../../electron/ipc/router';
import { ConnectionService, connectionReader } from '../../electron/mongo/ConnectionService';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { ImportWizardService } from '../../electron/services/ImportWizardService';
import { buildConnectionExport } from '../../electron/services/connectionExportFormat';
import { IPC_CHANNELS, type Envelope } from '../../shared/ipc';
import { createTempDb, type TempDb } from '../helpers/db';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { createSafeStorageMock } from '../helpers/safeStorageMock';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

function createShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        handlers.set(channel, fn);
      },
    } as const,
    async invoke<T>(channel: string, payload: unknown): Promise<Envelope<T>> {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return (await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

const code = (env: Envelope<unknown>) => (env.ok ? null : env.error.code);
const data = <T>(env: Envelope<T>): T => {
  if (!env.ok) throw new Error(`${env.error.code}: ${env.error.message}`);
  return env.data;
};

const COMMIT = { token: 't', indices: [0], readOnly: false, credentials: [], directConnection: [] };

describe('conn:import* handlers: payload validation', () => {
  let shim: ReturnType<typeof createShim>;
  let svc: Record<'importOpen' | 'importMap' | 'importUris' | 'importCommit', ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    shim = createShim();
    svc = {
      importOpen: vi.fn(async () => ({ cancelled: true as const })),
      importMap: vi.fn(() => ({ review: { hasEncryptedSecrets: false, rows: [] } })),
      importUris: vi.fn(() => ({ token: 't', review: { hasEncryptedSecrets: false, rows: [] } })),
      importCommit: vi.fn(async () => ({ created: [] })),
    };
    registerConnImportChannels(createRouter(shim.ipcMain, testSenderCheck), svc as unknown as ImportWizardService);
  });

  describe('conn:importOpen', () => {
    it.each([undefined, null, {}])('accepts %j and calls the service', async (payload) => {
      expect(await shim.invoke(IPC_CHANNELS.connImportOpen, payload)).toEqual({ ok: true, data: { cancelled: true } });
      expect(svc.importOpen).toHaveBeenCalledOnce();
    });

    it('rejects a payload with keys', async () => {
      expect(code(await shim.invoke(IPC_CHANNELS.connImportOpen, { path: '/etc/passwd' }))).toBe('VALIDATION');
      expect(svc.importOpen).not.toHaveBeenCalled();
    });
  });

  describe('conn:importMap', () => {
    it('passes paths and targets through, including the top level', async () => {
      const payload = { token: 't', at: '', mapping: { name: 'label', connectionString: 'servers.0.uri', tls: 'ssl' } };
      expect((await shim.invoke(IPC_CHANNELS.connImportMap, payload)).ok).toBe(true);
      expect(svc.importMap).toHaveBeenCalledWith(payload);
    });

    it.each([
      ['a target that is not one of the list', { token: 't', at: '', mapping: { sshHost: 'h' } }],
      ['one path mapped to two targets', { token: 't', at: '', mapping: { username: 'x', password: 'x' } }],
      ['an empty path', { token: 't', at: '', mapping: { host: '' } }],
      ['a value instead of a path', { token: 't', at: '', mapping: { host: 1 } }],
      ['an empty token', { token: '', at: '', mapping: {} }],
      ['an unknown key', { token: 't', at: '', mapping: {}, values: ['x'] }],
      ['a missing at', { token: 't', mapping: {} }],
      ['an at of 4097 characters', { token: 't', at: 'a'.repeat(4097), mapping: {} }],
      ['a mapping path of 4097 characters', { token: 't', at: '', mapping: { host: 'a'.repeat(4097) } }],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connImportMap, payload))).toBe('VALIDATION');
      expect(svc.importMap).not.toHaveBeenCalled();
    });
  });

  describe('conn:importUris', () => {
    it('accepts 100 lines of 4096 characters', async () => {
      const uris = Array.from({ length: 100 }, () => `mongodb://${'h'.repeat(4086)}`);
      expect((await shim.invoke(IPC_CHANNELS.connImportUris, { uris })).ok).toBe(true);
      expect(svc.importUris).toHaveBeenCalledWith(uris);
    });

    it.each([
      ['no lines', { uris: [] }],
      ['101 lines', { uris: Array.from({ length: 101 }, () => 'mongodb://h') }],
      ['a line of 4097 characters', { uris: [`mongodb://${'h'.repeat(4087)}`] }],
      ['an empty line', { uris: [''] }],
      ['an unknown key', { uris: ['mongodb://h'], defaults: {} }],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connImportUris, payload))).toBe('VALIDATION');
      expect(svc.importUris).not.toHaveBeenCalled();
    });
  });

  describe('conn:importCommit', () => {
    it('passes a full payload through', async () => {
      const payload = {
        ...COMMIT,
        indices: [2, 0],
        passphrase: 'p',
        withoutSecrets: false,
        credentials: [{ index: 0, username: 'u', password: 'pw' }],
        directConnection: [{ index: 2, value: true }],
      };
      expect((await shim.invoke(IPC_CHANNELS.connImportCommit, payload)).ok).toBe(true);
      expect(svc.importCommit).toHaveBeenCalledWith(payload);
    });

    it.each([
      ['no indices', { ...COMMIT, indices: [] }],
      ['a negative index', { ...COMMIT, indices: [-1] }],
      ['a fractional index', { ...COMMIT, indices: [0.5] }],
      ['a repeated index', { ...COMMIT, indices: [1, 1] }],
      ['more than 1000 indices', { ...COMMIT, indices: Array.from({ length: 1001 }, (_, i) => i) }],
      ['more than 1000 credentials', { ...COMMIT, credentials: Array.from({ length: 1001 }, (_, index) => ({ index })) }],
      ['more than 1000 direct choices', { ...COMMIT, directConnection: Array.from({ length: 1001 }, (_, index) => ({ index, value: true })) }],
      ['an empty passphrase', { ...COMMIT, passphrase: '' }],
      ['a missing readOnly', { token: 't', indices: [0], credentials: [], directConnection: [] }],
      ['a username of 129 characters', { ...COMMIT, credentials: [{ index: 0, username: 'u'.repeat(129) }] }],
      ['a credential with an unknown key', { ...COMMIT, credentials: [{ index: 0, sshPassword: 'x' }] }],
      ['a direct choice that is not a boolean', { ...COMMIT, directConnection: [{ index: 0, value: 'on' }] }],
      ['an unknown key', { ...COMMIT, uris: ['mongodb://h'] }],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connImportCommit, payload))).toBe('VALIDATION');
      expect(svc.importCommit).not.toHaveBeenCalled();
    });
  });
});

/**
 * AC17: no plaintext secret crosses into the renderer. Every response of every
 * channel, as the renderer receives it, is searched for secrets planted in
 * each place a source can hold one.
 */
describe('conn:import* handlers: no secret reaches the renderer', () => {
  const COMPASS = path.join(__dirname, '../fixtures/compass');
  const COMPASS_PASS = fs.readFileSync(path.join(COMPASS, 'passphrase.txt'), 'utf8').trim();
  const LATELIER_PASS = 'latelier-passphrase-marker';
  const MARKERS = [
    // The real Compass fixtures: plain values, and the same values sealed in the encrypted export.
    'fixture-pw-1',
    'fixture-pw-2',
    'fixture-pw-3',
    'fixture-ssh-pw',
    'fixture-key-pass',
    COMPASS_PASS,
    'uri-pw-marker',
    'bad-line-pw-marker',
    'proxy-pw-marker',
    'json-secret-marker',
    'json-uri-pw-marker',
    'typed-pw-marker',
    'latelier-pw-marker',
    'latelier-ssh-pw-marker',
    'latelier-ssh-phrase-marker',
    LATELIER_PASS,
  ];

  let shim: ReturnType<typeof createShim>;
  let tmp: TempDb;
  let dir: string;
  let openFrom: string | null;
  let responses: unknown[];

  const call = async <T>(channel: string, payload: unknown): Promise<Envelope<T>> => {
    const env = await shim.invoke<T>(channel, payload);
    responses.push(env);
    return env;
  };

  beforeEach(() => {
    tmp = createTempDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-import-ac17-'));
    responses = [];
    const vault = new SecretsVault(tmp.db, createSafeStorageMock(), { getAllowPlaintext: () => false });
    const repo = new ConnectionRepo(tmp.db);
    const conns = new ConnectionService({ repo, vault, pool: new MongoPool({ repo: connectionReader(repo, vault), vault }) });
    shim = createShim();
    registerConnImportChannels(
      createRouter(shim.ipcMain, testSenderCheck),
      new ImportWizardService({ conns, vault, dialogs: { openPath: async () => openFrom } }),
    );
  });

  afterEach(() => {
    // Every response collected by the test, success or error, is free of every marker.
    const wire = JSON.stringify(responses);
    expect(responses.length).toBeGreaterThan(0);
    for (const marker of MARKERS) expect(wire, marker).not.toContain(marker);
    tmp.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const commit = (token: string, indices: number[], over: object = {}) =>
    call<ImportCommitResult>(IPC_CHANNELS.connImportCommit, { token, indices, readOnly: false, credentials: [], directConnection: [], ...over });

  it('a plain Compass export: open and commit', async () => {
    openFrom = path.join(COMPASS, 'plain.json');
    const opened = data(await call<ImportOpenResult>(IPC_CHANNELS.connImportOpen, {}));
    if (!('token' in opened)) throw new Error('expected a token');
    expect(data(await commit(opened.token, [0, 1, 2])).created).toHaveLength(3);
  });

  it('an encrypted Compass export: open, a wrong passphrase, then the right one', async () => {
    openFrom = path.join(COMPASS, 'encrypted.json');
    const opened = data(await call<ImportOpenResult>(IPC_CHANNELS.connImportOpen, {}));
    if (!('token' in opened)) throw new Error('expected a token');
    expect(code(await commit(opened.token, [0, 1, 2], { passphrase: 'wrong passphrase' }))).toBe('BAD_PASSPHRASE');
    expect(data(await commit(opened.token, [0, 1, 2], { passphrase: COMPASS_PASS })).created).toHaveLength(3);
  });

  it("a L'Atelier export with sealed secrets: open, a wrong passphrase, then the right one", async () => {
    openFrom = path.join(dir, 'export.json');
    fs.writeFileSync(
      openFrom,
      await buildConnectionExport({
        items: [
          {
            entry: {
              name: 'Sealed',
              color: '#1A6835',
              connectionType: 'standard',
              readOnly: false,
              host: 'db.example.com',
              port: 27017,
              authMech: 'scram256',
              authUsername: 'alice',
              tls: { enabled: false, verify: true },
              ssh: { enabled: true, host: 'bastion', port: 22, username: 'me', authMethod: 'password' },
              advanced: {
                connectTimeoutMs: 10_000,
                socketTimeoutMs: 30_000,
                serverSelectionTimeoutMs: 30_000,
                readPreference: 'primary',
                maxPoolSize: 100,
                directConnection: false,
              },
            },
            secrets: {
              password: 'latelier-pw-marker',
              sshPassword: 'latelier-ssh-pw-marker',
              sshPassphrase: 'latelier-ssh-phrase-marker',
            },
          },
        ],
        passphrase: LATELIER_PASS,
        scrypt: { N: 1024, r: 8, p: 1 },
      }),
    );
    const opened = data(await call<ImportOpenResult>(IPC_CHANNELS.connImportOpen, {}));
    if (!('token' in opened)) throw new Error('expected a token');
    expect(code(await commit(opened.token, [0], { passphrase: 'wrong passphrase' }))).toBe('BAD_PASSPHRASE');
    expect(data(await commit(opened.token, [0], { passphrase: LATELIER_PASS })).created).toHaveLength(1);
  });

  it('unknown JSON: open, map, re-map and commit', async () => {
    openFrom = path.join(dir, 'servers.json');
    fs.writeFileSync(
      openFrom,
      JSON.stringify({
        servers: [
          {
            label: 'A',
            uri: 'mongodb://u:json-uri-pw-marker@a.example/?proxyHost=p&proxyPassword=proxy-pw-marker',
            secret: 'json-secret-marker',
          },
        ],
      }),
    );
    const opened = data(await call<ImportOpenResult>(IPC_CHANNELS.connImportOpen, {}));
    if (!('token' in opened)) throw new Error('expected a token');
    // Mapping the secret to a shown field is refused by the row, not echoed.
    await call(IPC_CHANNELS.connImportMap, { token: opened.token, at: 'servers', mapping: { name: 'secret', host: 'label' } });
    const mapped = data(
      await call<{ review: Review }>(IPC_CHANNELS.connImportMap, {
        token: opened.token,
        at: 'servers',
        mapping: { name: 'label', connectionString: 'uri', password: 'secret' },
      }),
    );
    expect(mapped.review.rows[0]).toMatchObject({ ok: true, hasPassword: true });
    expect(data(await commit(opened.token, [0])).created).toHaveLength(1);
  });

  it('unknown JSON: a __proto__ or constructor key is a field like any other', async () => {
    openFrom = path.join(dir, 'proto.json');
    // Written as JSON text: JSON.parse makes `__proto__` an own key, as a real file would.
    fs.writeFileSync(openFrom, '[{"__proto__":"mongodb://proto.example","constructor":"Proto"}]');
    const opened = data(await call<ImportOpenResult>(IPC_CHANNELS.connImportOpen, {}));
    if (!('collections' in opened)) throw new Error('expected an unknown file');
    expect(opened.collections[0]!.fields).toEqual([
      { path: '__proto__', sample: 'mongodb://proto.example', masked: false, suggested: 'connectionString' },
      { path: 'constructor', sample: 'Proto', masked: false },
    ]);
    const mapped = data(
      await call<{ review: Review }>(IPC_CHANNELS.connImportMap, {
        token: opened.token,
        at: '',
        mapping: { connectionString: '__proto__', name: 'constructor' },
      }),
    );
    expect(mapped.review.rows[0]).toMatchObject({ ok: true, savedAs: 'Proto', host: 'proto.example' });
    expect(data(await commit(opened.token, [0])).created).toHaveLength(1);
  });

  it('pasted URIs, an unparseable one included: review, a refused payload, commit', async () => {
    const uris = [
      'mongodb://u:uri-pw-marker@h1/?proxyHost=p&proxyPassword=proxy-pw-marker',
      'mongodb://u:bad-line-pw-marker@h2:99999',
      'mongodb://u:bad-line-pw-marker@bad host',
      'mongodb://h3',
    ];
    const { token, review } = data(await call<ImportUrisResult>(IPC_CHANNELS.connImportUris, { uris }));
    expect(review.rows.filter((r) => !r.ok)).toHaveLength(2);
    expect(code(await call(IPC_CHANNELS.connImportUris, { uris: [`mongodb://u:uri-pw-marker@${'h'.repeat(4090)}`] }))).toBe(
      'VALIDATION',
    );
    const result = data(
      await commit(token, [0, 3], { credentials: [{ index: 3, username: 'me', password: 'typed-pw-marker' }] }),
    );
    expect(result).toMatchObject({ created: [{ index: 0 }, { index: 3 }] });
  });
});
