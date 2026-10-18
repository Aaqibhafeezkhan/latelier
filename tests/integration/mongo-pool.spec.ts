import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { KEYCHAIN_BLOCKED_MESSAGE, SECRET_UNREADABLE_MESSAGE } from '../../electron/mongo/errors';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { ConnectionService, connectionReader } from '../../electron/mongo/ConnectionService';
import type { ConnectionInput } from '@shared/types';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import {
  getSharedMongoUri,
  uriToHostPort,
  makeConnection,
  makeReader,
  makeCountingReader,
} from '../helpers/mongo';

const validConnectionInput: ConnectionInput = {
  name: 'Unreadable',
  color: '#1A6835',
  connectionType: 'standard',
  readOnly: false,
  host: '127.0.0.1',
  port: 1,
  authMech: 'none',
  tls: { enabled: false, verify: true },
  advanced: {
    connectTimeoutMs: 1000,
    socketTimeoutMs: 1000,
    serverSelectionTimeoutMs: 1000,
    readPreference: 'primary',
    maxPoolSize: 1,
    directConnection: true,
  },
};

// Every fake client below carries a no-op `on` because a real MongoClient is
// an EventEmitter and the pool now subscribes to `topologyDescriptionChanged`
// on every client it builds, for involuntary-loss detection.
describe('MongoPool', () => {
  let hp: { host: string; port: number };
  let tmp: TempDb;
  let vault: SecretsVault;

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
  });

  afterEach(() => {
    tmp?.cleanup();
    vi.restoreAllMocks();
  });

  it('readClient happy path: status transitions disconnected → connecting → connected', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);
    const pool = new MongoPool({ repo: makeReader([conn]), vault });

    const events: string[] = [];
    pool.on('status', (r) => events.push(r.status));

    const client = await pool.readClient('c1');
    expect(client).toBeDefined();
    expect(pool.status('c1').status).toBe('connected');
    expect(pool.status('c1').serverVersion).toMatch(/^\d/);
    expect(events).toContain('connecting');
    expect(events).toContain('connected');

    await pool.disconnectAll();
  });

  it('concurrent readClient calls produce a single MongoClient construction', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);
    let constructed = 0;
    const pool = new MongoPool({
      repo: makeReader([conn]),
      vault,
      clientFactory: (uri, opts) => {
        constructed++;
        // Lazy-import to avoid circular dep at module load.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MongoClient } = require('mongodb');
        return new MongoClient(uri, opts);
      },
    });

    const [a, b, c] = await Promise.all([pool.readClient('c1'), pool.readClient('c1'), pool.readClient('c1')]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(constructed).toBe(1);

    await pool.disconnectAll();
  });

  it('reports error status on unreachable host, then succeeds on retry with good config', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const badConn = makeConnection('c1', { host: '127.0.0.1', port: 1 }, {
      advanced: {
        connectTimeoutMs: 1000,
        socketTimeoutMs: 1000,
        serverSelectionTimeoutMs: 1000,
        readPreference: 'primary',
        maxPoolSize: 1,
        directConnection: true,
      },
    });
    const goodConn = makeConnection('c1', hp);

    const conns = [badConn];
    const pool = new MongoPool({ repo: makeReader(conns), vault });

    const r1 = await pool.connect('c1');
    expect(r1.status).toBe('error');
    // Driver wraps the underlying cause in varying ways; any non-AUTH code is
    // acceptable here — the point of the test is the retry semantics.
    expect(r1.errorCode).not.toBe('AUTH');

    conns[0] = goodConn;
    const r2 = await pool.connect('c1');
    expect(r2.status).toBe('connected');

    await pool.disconnectAll();
  });

  // status() dropped errorCode even though the entry held one, so
  // every troubleshooting recipe keyed on errorCode alone was unreachable
  // from the real IPC path (mongo:status just forwards pool.status(id)).
  it('status() carries the classified errorCode after a real failed connect', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    // MongoServerSelectionError on an unreachable host classifies as TIMEOUT
    // deterministically (classifyMongoError checks `name` before message
    // pattern-matching), unlike the retry test above which only pins "not AUTH".
    const badConn = makeConnection('c1', { host: '127.0.0.1', port: 1 }, {
      advanced: {
        connectTimeoutMs: 1000,
        socketTimeoutMs: 1000,
        serverSelectionTimeoutMs: 1000,
        readPreference: 'primary',
        maxPoolSize: 1,
        directConnection: true,
      },
    });
    const pool = new MongoPool({ repo: makeReader([badConn]), vault });

    await pool.connect('c1');
    const status = pool.status('c1');
    expect(status.status).toBe('error');
    expect(status.errorCode).toBe('TIMEOUT');
    expect(status.errorMessage).toBeTruthy();

    await pool.disconnectAll();
  });

  // The vault throws SECRET_DECRYPT_FAILED before any client exists (#396), so
  // no server is needed — and it must surface as its own code, not UNKNOWN.
  it('a saved password the vault cannot decrypt connects as SECRET_UNREADABLE', async () => {
    tmp = createTempDb();
    const safeStorage = createSafeStorageMock();
    vault = new SecretsVault(tmp.db, safeStorage);
    const repo = new ConnectionRepo(tmp.db);
    const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    const created = await new ConnectionService({ repo, vault, pool }).create({
      ...validConnectionInput,
      authMech: 'scram256',
      authUsername: 'u',
      password: 'hunter2',
    });
    // An empty mock store makes decryptString throw, as a foreign install would.
    safeStorage.reset();

    await pool.connect(created.id);
    const status = pool.status(created.id);
    expect(status.status).toBe('error');
    expect(status.errorCode).toBe('SECRET_UNREADABLE');
    expect(status.errorMessage).toBe(SECRET_UNREADABLE_MESSAGE);

    await pool.disconnectAll();
  });

  it('on macOS, a decrypt failure with the keychain unavailable connects as KEYCHAIN_BLOCKED', async () => {
    tmp = createTempDb();
    const safeStorage = createSafeStorageMock();
    vault = new SecretsVault(tmp.db, safeStorage);
    const repo = new ConnectionRepo(tmp.db);
    const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    const created = await new ConnectionService({ repo, vault, pool }).create({
      ...validConnectionInput,
      authMech: 'scram256',
      authUsername: 'u',
      password: 'hunter2',
    });
    // Same state as a denied keychain prompt: nothing decrypts, and the
    // availability check now reports false for the rest of the process.
    safeStorage.reset();
    safeStorage.setAvailable(false);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    await pool.connect(created.id);
    const status = pool.status(created.id);
    expect(status.errorCode).toBe('KEYCHAIN_BLOCKED');
    expect(status.errorMessage).toBe(KEYCHAIN_BLOCKED_MESSAGE);

    await pool.disconnectAll();
  });

  // disconnect() cleared client/status/connectedAt/defaultDb but left
  // errorCode/errorMessage on the entry. Unreachable through a plain
  // connect-fails-then-disconnect flow (disconnect() no-ops when there's no
  // client to close), but reachable via Cancel: disconnect() during an
  // in-flight retry closes a live (not-yet-connected) client, landing on
  // 'disconnected' while the retry's predecessor failure is still on the
  // entry. Same fixture shape as "disconnect cancels an in-flight connect"
  // above, plus a first attempt that fails before the retry starts.
  it('disconnect() clears a stale errorCode/errorMessage left by a prior failed attempt', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const connA = makeConnection('a', hp);

    let attempt = 0;
    let rejectRetryConnect: ((err: Error) => void) | null = null;
    const pool = new MongoPool({
      repo: makeReader([connA]),
      vault,
      clientFactory: () => {
        attempt++;
        if (attempt === 1) {
          // First attempt fails immediately, classified as AUTH.
          return {
            connect: async () => {
              throw Object.assign(new Error('Authentication failed'), {
                codeName: 'AuthenticationFailed',
              });
            },
            close: async () => {},
            on: () => {},
            db: () => ({ command: async () => ({ version: '0.0.0' }) }),
          } as unknown as import('mongodb').MongoClient;
        }
        // Retry hangs until cancelled via disconnect().
        return {
          connect: () =>
            new Promise<void>((_resolve, reject) => {
              rejectRetryConnect = reject;
            }),
          close: async () => {
            rejectRetryConnect?.(new Error('client closed'));
          },
          on: () => {},
          db: () => ({ command: async () => ({ version: '0.0.0' }) }),
        } as unknown as import('mongodb').MongoClient;
      },
    });

    const r1 = await pool.connect('a');
    expect(r1.status).toBe('error');
    expect(r1.errorCode).toBe('AUTH');

    // Retry — kick off without awaiting, it hangs until cancelled.
    const retryPromise = pool.connect('a');
    expect(pool.status('a').status).toBe('connecting');

    // Cancel the in-flight retry (the Cancel action of X16 §4.3).
    await pool.disconnect('a');
    await retryPromise;

    const status = pool.status('a');
    expect(status.status).toBe('disconnected');
    expect(status.errorCode).toBeUndefined();
    expect(status.errorMessage).toBeUndefined();

    await pool.disconnectAll();
  });

  // connect() must never leak the previous client on a reconnect.
  it('connecting twice on the same id closes the first client, not just replaces it', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);

    const clients: { closed: boolean }[] = [];
    const pool = new MongoPool({
      repo: makeReader([conn]),
      vault,
      clientFactory: (uri, opts) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, opts);
        const record = { closed: false };
        clients.push(record);
        const originalClose = client.close.bind(client);
        client.close = (async (force?: boolean) => {
          record.closed = true;
          return originalClose(force);
        }) as typeof client.close;
        return client;
      },
    });

    const r1 = await pool.connect('c1');
    expect(r1.status).toBe('connected');
    expect(clients).toHaveLength(1);
    expect(clients[0].closed).toBe(false);

    // Second connect() on the same, already-connected id — the normal case
    // for re-clicking an already-connected row in the Switcher.
    const r2 = await pool.connect('c1');
    expect(r2.status).toBe('connected');
    expect(clients).toHaveLength(2);

    expect(clients[0].closed).toBe(true); // the leak this test guards against
    expect(clients[1].closed).toBe(false);

    await pool.disconnectAll();
  });

  it('a failure closing the previous client does not block the reconnect', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);

    let attempt = 0;
    const pool = new MongoPool({
      repo: makeReader([conn]),
      vault,
      clientFactory: (uri, opts) => {
        const idx = attempt++;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, opts);
        if (idx === 0) {
          client.close = (async () => {
            throw new Error('close boom');
          }) as typeof client.close;
        }
        return client;
      },
    });

    await pool.connect('c1');
    expect(pool.status('c1').status).toBe('connected');

    const r2 = await pool.connect('c1');
    expect(r2.status).toBe('connected');

    await pool.disconnectAll();
  });

  it('a previous client whose close() hangs does not block the reconnect', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);

    let attempt = 0;
    const pool = new MongoPool({
      repo: makeReader([conn]),
      vault,
      clientFactory: (uri, opts) => {
        const idx = attempt++;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, opts);
        if (idx === 0) {
          // Mirrors disconnectAll's own hanging-close fixture — close()
          // never resolves.
          client.close = (() => new Promise<void>(() => {})) as typeof client.close;
        }
        return client;
      },
    });

    await pool.connect('c1');
    expect(pool.status('c1').status).toBe('connected');

    const t0 = Date.now();
    const r2 = await pool.connect('c1');
    const elapsed = Date.now() - t0;
    expect(r2.status).toBe('connected');
    expect(elapsed).toBeLessThan(2_000);

    await pool.disconnectAll();
  });

  it('reconnecting after an edit rebuilds the client with the new settings — no short-circuit — and closes the old one', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conns = [makeConnection('c1', hp, { defaultDb: 'before' })];
    const closedFlags: boolean[] = [];
    const pool = new MongoPool({
      repo: { findById: (id) => conns.find((c) => c.id === id) ?? null },
      vault,
      clientFactory: (uri, opts) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, opts);
        const flagIdx = closedFlags.push(false) - 1;
        const originalClose = client.close.bind(client);
        client.close = (async (force?: boolean) => {
          closedFlags[flagIdx] = true;
          return originalClose(force);
        }) as typeof client.close;
        return client;
      },
    });

    await pool.connect('c1');
    expect(pool.status('c1').status).toBe('connected');
    expect((await pool.readDb('c1')).databaseName).toBe('before');

    // Simulate handleConnectionSaved: the repo row changes (defaultDb here
    // stands in for host/auth/TLS — same code path) and connect() is called
    // again WITHOUT an intervening disconnect() — the edit-reconnect path
    // never calls disconnect() itself.
    conns[0] = makeConnection('c1', hp, { defaultDb: 'after' });
    await pool.connect('c1');
    expect(pool.status('c1').status).toBe('connected');

    expect((await pool.readDb('c1')).databaseName).toBe('after');
    expect(closedFlags[0]).toBe(true); // old client closed, not leaked

    await pool.disconnectAll();
  });

  it('probe returns ok with serverVersion for a reachable server and does not retain a client', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('probe', hp);
    const pool = new MongoPool({ repo: makeReader([]), vault });
    const r = await pool.probe(conn);
    expect(r.ok).toBe(true);
    expect(r.serverVersion).toMatch(/^\d/);
    expect(typeof r.roundTripMs).toBe('number');
    // No entry stored for the probe id.
    expect(pool.status('probe').status).toBe('disconnected');
  });

  it('probe returns AUTH-ish error for wrong credentials (or refuses handshake)', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp, {
      authMech: 'scram256',
      authUsername: 'nobody',
      authDatabase: 'admin',
    });
    const pool = new MongoPool({ repo: makeReader([]), vault });
    const r = await pool.probe({ ...conn, password: 'wrong' });
    expect(r.ok).toBe(false);
    expect(['AUTH', 'UNKNOWN', 'NETWORK']).toContain(r.errorCode ?? 'UNKNOWN');
  });

  it('ping returns a positive number', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);
    const pool = new MongoPool({ repo: makeReader([conn]), vault });
    const ms = await pool.ping('c1');
    expect(ms).toBeGreaterThanOrEqual(0);
    await pool.disconnectAll();
  });

  it('serverInfo returns populated stats and topology', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);
    const pool = new MongoPool({ repo: makeReader([conn]), vault });
    const info = await pool.serverInfo('c1');
    expect(info.version).toMatch(/^\d/);
    expect(info.databaseCount).toBeGreaterThanOrEqual(0);
    expect(info.connectionsCurrent).toBeGreaterThanOrEqual(0);
    // mongodb-memory-server is a standalone.
    expect(info.topology).toBe('Single');
    await pool.disconnectAll();
  });

  describe('topology from the hello reply (#281)', () => {
    // A MongoClient stand-in that records the name of every admin command and
    // answers `hello` / `isMaster` from the test. `buildInfo` and `ping` succeed;
    // everything else rejects, as a role without the privilege would.
    const makeHelloClient = (answers: { hello?: () => unknown; isMaster?: () => unknown }) => {
      const commands: string[] = [];
      const client = {
        connect: async () => {},
        close: async () => {},
        on: () => {},
        db: () => ({
          command: async (cmd: Record<string, unknown>) => {
            const name = Object.keys(cmd)[0]!;
            commands.push(name);
            if (name === 'buildInfo') return { version: '8.0.0' };
            if (name === 'ping') return { ok: 1 };
            const answer = (answers as Record<string, (() => unknown) | undefined>)[name];
            if (answer) return answer();
            throw new Error(`unexpected command ${name}`);
          },
        }),
      } as unknown as import('mongodb').MongoClient;
      return { client, commands };
    };

    const poolWithClient = (client: import('mongodb').MongoClient, log?: ConstructorParameters<typeof MongoPool>[0]['log']) => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      return new MongoPool({ repo: makeReader([makeConnection('c1', hp)]), vault, log, clientFactory: () => client });
    };

    it('reports Single for a real standalone on connect, serverInfo and probe', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const pool = new MongoPool({ repo: makeReader([makeConnection('c1', hp)]), vault });

      await pool.readClient('c1');
      expect(pool.status('c1').topology).toBe('Single');
      expect((await pool.serverInfo('c1')).topology).toBe('Single');
      expect((await pool.probe(makeConnection('probe', hp))).topology).toBe('Single');
      await pool.disconnectAll();
    });

    // The one real replica set in the suite: a hand-built hello can only show
    // that the pool trusts the reply, this shows the reply a mongod actually
    // sends classifies. Started on first use and stopped in afterAll.
    describe('real replica set', () => {
      let replSet: MongoMemoryReplSet | undefined;
      afterAll(async () => {
        await replSet?.stop();
      }, 60_000);

      it('reports ReplicaSet on connect, serverInfo and probe', async () => {
        replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        const rsHp = uriToHostPort(replSet.getUri());
        tmp = createTempDb();
        vault = new SecretsVault(tmp.db, createSafeStorageMock());
        const pool = new MongoPool({ repo: makeReader([makeConnection('rs', rsHp)]), vault });

        await pool.readClient('rs');
        expect(pool.status('rs').topology).toBe('ReplicaSet');
        expect((await pool.serverInfo('rs')).topology).toBe('ReplicaSet');
        expect((await pool.probe(makeConnection('probe', rsHp))).topology).toBe('ReplicaSet');
        await pool.disconnectAll();
      }, 90_000);
    });

    it('reports Single for a real standalone when a logger is attached too', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const noop = () => {};
      const log = { debug: noop, info: noop, warn: noop, error: noop };
      const pool = new MongoPool({ repo: makeReader([makeConnection('c1', hp)]), vault, log });

      await pool.readClient('c1');
      expect(pool.status('c1').topology).toBe('Single');
      expect((await pool.probe(makeConnection('probe', hp))).topology).toBe('Single');
      await pool.disconnectAll();
    });

    it.each([
      ['a replica set member', { setName: 'rs0', isWritablePrimary: true, ok: 1 }, 'ReplicaSet'],
      ['a mongos', { msg: 'isdbgrid', isWritablePrimary: true, ok: 1 }, 'Sharded'],
    ] as const)('takes the topology from the hello reply of %s', async (_name, reply, expected) => {
      const { client } = makeHelloClient({ hello: () => reply });
      const pool = poolWithClient(client);

      await pool.connect('c1');
      expect(pool.status('c1').topology).toBe(expected);
      expect((await pool.serverInfo('c1')).topology).toBe(expected);
      expect((await pool.probe(makeConnection('probe', hp))).topology).toBe(expected);
      await pool.disconnectAll();
    });

    it('falls back to isMaster on a server that predates hello', async () => {
      const { client, commands } = makeHelloClient({
        hello: () => {
          throw new Error('no such command: hello');
        },
        isMaster: () => ({ ismaster: true, ok: 1 }),
      });
      const pool = poolWithClient(client);

      await pool.connect('c1');
      expect(pool.status('c1').topology).toBe('Single');
      expect(commands.filter((c) => c === 'hello' || c === 'isMaster')).toEqual(['hello', 'isMaster']);
      await pool.disconnectAll();
    });

    it('drops the topology and version with the connection on disconnect', async () => {
      const { client } = makeHelloClient({ hello: () => ({ setName: 'rs0', isWritablePrimary: true, ok: 1 }) });
      const pool = poolWithClient(client);

      await pool.connect('c1');
      expect(pool.status('c1')).toMatchObject({ status: 'connected', topology: 'ReplicaSet', serverVersion: '8.0.0' });

      await pool.disconnect('c1');
      const after = pool.status('c1');
      expect(after.status).toBe('disconnected');
      expect(after.topology).toBeUndefined();
      expect(after.serverVersion).toBeUndefined();
    });

    it('does not show the previous server\'s topology when a reconnect fails', async () => {
      const replicaSet = makeHelloClient({ hello: () => ({ setName: 'rs0', isWritablePrimary: true, ok: 1 }) }).client;
      const unreachable = {
        connect: async () => {
          throw Object.assign(new Error('Authentication failed'), { codeName: 'AuthenticationFailed' });
        },
        close: async () => {},
        on: () => {},
        db: () => ({ command: async () => ({}) }),
      } as unknown as import('mongodb').MongoClient;
      const clients = [replicaSet, unreachable];
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const pool = new MongoPool({
        repo: makeReader([makeConnection('c1', hp)]),
        vault,
        clientFactory: () => clients.shift()!,
      });

      await pool.connect('c1');
      expect(pool.status('c1').topology).toBe('ReplicaSet');

      const failed = await pool.connect('c1');
      expect(failed.status).toBe('error');
      expect(failed.topology).toBeUndefined();
      expect(failed.serverVersion).toBeUndefined();
    });

    it.each([
      ['no logger', undefined],
      ['a logger', { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }],
    ])('costs one hello round trip on connect with %s', async (_name, log) => {
      const { client, commands } = makeHelloClient({ hello: () => ({ isWritablePrimary: true, ok: 1 }) });
      const pool = poolWithClient(client, log);

      await pool.connect('c1');
      expect(commands).toEqual(['buildInfo', 'hello']);
      await pool.disconnectAll();
    });

    it('still connects and reports Unknown when hello fails outright', async () => {
      const fail = () => {
        throw new Error('operation timed out');
      };
      const { client } = makeHelloClient({ hello: fail, isMaster: fail });
      const pool = poolWithClient(client);

      await pool.connect('c1');
      expect(pool.status('c1').status).toBe('connected');
      expect(pool.status('c1').topology).toBe('Unknown');
      expect((await pool.serverInfo('c1')).topology).toBe('Unknown');
      const probed = await pool.probe(makeConnection('probe', hp));
      expect(probed.ok).toBe(true);
      expect(probed.topology).toBe('Unknown');
      await pool.disconnectAll();
    });

    it('logs the failure at debug when hello fails and a logger is attached', async () => {
      const fail = () => {
        throw new Error('operation timed out');
      };
      const { client } = makeHelloClient({ hello: fail, isMaster: fail });
      const debug = vi.fn();
      const pool = poolWithClient(client, { debug, info: () => {}, warn: () => {}, error: () => {} });

      await pool.connect('c1');
      expect(debug).toHaveBeenCalledWith('mongo', 'hello snapshot failed', expect.objectContaining({ source: 'connect', message: 'operation timed out' }));
      await pool.disconnectAll();
    });
  });


  it('disconnectAll honors a 5-second budget even if a client hangs', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp);

    const fakeClient = {
      connect: async () => {},
      close: () => new Promise<void>(() => {}), // hangs forever
      on: () => {},
      db: () => ({ command: async () => ({ version: '0.0.0' }) }),
    };
    const pool = new MongoPool({
      repo: makeReader([conn]),
      vault,
      clientFactory: () => fakeClient as unknown as import('mongodb').MongoClient,
    });
    await pool.connect('c1');

    const t0 = Date.now();
    await pool.disconnectAll();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_500);
  });

  it('a hung connect on one connection does not block a fresh connect on another', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const connA = makeConnection('a', hp);
    const connB = makeConnection('b', hp);

    // Fake client whose connect() never resolves until close() is called —
    // mimics an unreachable host churning through serverSelectionTimeoutMs.
    // Boxed rather than two `let`s: a local assigned only inside a closure keeps
    // the type it was narrowed to by its initializer, so calling it later fails to
    // typecheck. `resolve === null` also doubles as the "A not yet handed out"
    // sentinel the clientFactory below keys off.
    const aConnect: { resolve: (() => void) | null; reject: ((err: Error) => void) | null } = {
      resolve: null,
      reject: null,
    };
    const fakeA = {
      connect: () =>
        new Promise<void>((resolve, reject) => {
          aConnect.resolve = () => resolve();
          aConnect.reject = reject;
        }),
      close: async () => {
        aConnect.reject?.(new Error('client closed'));
      },
      on: () => {},
      db: () => ({ command: async () => ({ version: '0.0.0' }) }),
    };

    const pool = new MongoPool({
      repo: makeReader([connA, connB]),
      vault,
      clientFactory: (uri, opts) => {
        if (uri.includes(`:${connA.port}/`) && aConnect.resolve === null) {
          return fakeA as unknown as import('mongodb').MongoClient;
        }
        // Fall through to a real client for B (and anything after A's release).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MongoClient } = require('mongodb');
        return new MongoClient(uri, opts);
      },
    });

    // Kick off A's connect; it hangs until this test drains it.
    const aPromise = pool.connect('a');

    // Race: B's connect should resolve quickly even though A is still hanging.
    const t0 = Date.now();
    const r = await pool.connect('b');
    const elapsed = Date.now() - t0;
    expect(r.status).toBe('connected');
    expect(elapsed).toBeLessThan(2_000);
    // X16 §4.1 — connecting B no longer touches A. Previously this asserted
    // 'disconnected', because the preemption loop force-closed A's in-flight
    // client on the way in. A now stays hung until someone cancels it, which
    // was made an action the user takes ("Cancel makes a hung connect reject
    // rather than run to serverSelectionTimeoutMs" below covers that half).
    // What this line pins is the other half, and it is no longer a regression:
    // connecting B must not disturb A at all.
    expect(pool.status('a').status).toBe('connecting');

    // Drain A so the test doesn't dangle.
    aConnect.resolve?.();
    await aPromise.catch(() => {});
    await pool.disconnectAll();
  });

  it('disconnect cancels an in-flight connect: terminal status is disconnected, not error', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const connA = makeConnection('a', hp);

    let rejectAConnect: ((err: Error) => void) | null = null;
    const fakeA = {
      connect: () =>
        new Promise<void>((_resolve, reject) => {
          rejectAConnect = reject;
        }),
      close: async () => {
        rejectAConnect?.(new Error('client closed'));
      },
      on: () => {},
      db: () => ({ command: async () => ({ version: '0.0.0' }) }),
    };

    const pool = new MongoPool({
      repo: makeReader([connA]),
      vault,
      clientFactory: () => fakeA as unknown as import('mongodb').MongoClient,
    });

    // Kick off connect without awaiting — it will hang until we cancel.
    const connectPromise = pool.connect('a');

    // pool.connect synchronously sets status to 'connecting' before returning.
    expect(pool.status('a').status).toBe('connecting');

    // Cancel the in-flight connect.
    await pool.disconnect('a');

    // The connect promise resolves (swallowed internally); wait for it to settle.
    await connectPromise;

    // Terminal status must be disconnected, not error.
    expect(pool.status('a').status).toBe('disconnected');
  });

  // X16 §4.3 / test case 2 — Cancel. Real driver, real socket, real
  // `serverSelectionTimeoutMs`: the escape hatch is a driver behaviour (closing
  // the client drains the topology wait queue and rejects the pending
  // `connect()`), and a fake client would assert the fake rather than that.
  it('Cancel makes a hung connect reject rather than run to serverSelectionTimeoutMs, and leaves the other Connection connected', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    // Port 1 is unreachable and stays unreachable: `connect()` churns until
    // serverSelectionTimeoutMs, which is set 60x the budget this test allows.
    const unreachable = makeConnection('a', { host: '127.0.0.1', port: 1 }, {
      advanced: {
        connectTimeoutMs: 30_000,
        socketTimeoutMs: 30_000,
        serverSelectionTimeoutMs: 30_000,
        readPreference: 'primary',
        maxPoolSize: 1,
        directConnection: true,
      },
    });
    // Two Connections on purpose: "Cancelling one leaves every other Connection
    // connected and usable" cannot fail against a one-Connection fixture.
    const good = makeConnection('b', hp);
    const pool = new MongoPool({ repo: makeReader([unreachable, good]), vault });

    await pool.connect('b');
    expect(pool.status('b').status).toBe('connected');

    const hung = pool.connect('a');
    expect(pool.status('a').status).toBe('connecting');

    const t0 = Date.now();
    await pool.disconnect('a');
    await hung;
    const elapsed = Date.now() - t0;

    // The whole point: it settled on the Cancel, not on the timeout.
    expect(elapsed).toBeLessThan(5_000);
    expect(pool.status('a').status).toBe('disconnected');

    // B never noticed, and is still usable rather than merely labelled.
    expect(pool.status('b').status).toBe('connected');
    const db = await pool.write('b').db('cancel-check');
    await db.collection('probe').insertOne({ ok: 1 });
    expect(await db.collection('probe').countDocuments()).toBe(1);

    await pool.disconnectAll();
  }, 40_000);

  // X16 §4.3 — Cancel → Retry. The ordering is forced, not hoped for:
  // the cancelled attempt is released only after the retry has fully
  // succeeded, which is exactly the interleaving that used to corrupt it.
  it('a cancelled connect that settles after a Retry does not clobber the retry', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const connA = makeConnection('a', hp);

    interface FakeClient {
      n: number;
      closed: boolean;
      connect: () => Promise<void>;
      close: () => Promise<void>;
      on: () => void;
      db: () => { command: () => Promise<{ version: string }> };
    }
    const clients: FakeClient[] = [];
    // Attempt 0 hangs and is released only by `releaseFirst`; its `close()`
    // deliberately does NOT settle it, which is what puts its settle after the
    // retry's. Attempt 1 connects immediately.
    let releaseFirst: ((err: Error) => void) | null = null;
    const makeFake = (n: number): FakeClient => {
      const client: FakeClient = {
        n,
        closed: false,
        connect: () =>
          n === 0
            ? new Promise<void>((_resolve, reject) => {
                releaseFirst = reject;
              })
            : Promise.resolve(),
        close: async () => {
          client.closed = true;
        },
        on: () => {},
        db: () => ({ command: async () => ({ version: '9.9.9' }) }),
      };
      clients.push(client);
      return client;
    };

    const pool = new MongoPool({
      repo: makeReader([connA]),
      vault,
      clientFactory: () => makeFake(clients.length) as unknown as import('mongodb').MongoClient,
    });

    const events: string[] = [];
    pool.on('status', (r) => events.push(r.status));

    // Connect, hang, Cancel.
    const cancelled = pool.connect('a');
    expect(pool.status('a').status).toBe('connecting');
    await pool.disconnect('a');
    expect(pool.status('a').status).toBe('disconnected');

    // Retry, all the way to connected — before the cancelled attempt settles.
    await pool.connect('a');
    expect(pool.status('a').status).toBe('connected');
    expect(clients).toHaveLength(2);

    // Only now does the cancelled attempt reject, as a real driver's would
    // once its wait queue drains.
    releaseFirst!(new Error('drained'));
    await cancelled;
    await new Promise((r) => setTimeout(r, 20));

    // The retry survives it, whole: its status, its message, and its client.
    expect(pool.status('a').status).toBe('connected');
    expect(pool.status('a').errorMessage).toBeUndefined();
    expect(clients[1].closed).toBe(false);
    expect(await pool.readClient('a')).toBe(clients[1] as unknown as import('mongodb').MongoClient);
    // Exactly one status event per real transition — no 'error' describing a
    // transition the live attempt never made.
    expect(events).toEqual(['connecting', 'disconnected', 'connecting', 'connected']);

    await pool.disconnectAll();
  });

  // Cancel can land after client.connect() resolved, while the post-connect
  // buildInfo or hello read is still in flight. A real driver rejects every
  // command once its client is closed, and readHello swallows that rejection
  // by design, so without a second guard the entry would be written back as
  // 'connected' around a closed client.
  describe('Cancel landing during the post-connect reads', () => {
    it.each([
      { pending: 'hello', settle: 'reject' },
      { pending: 'buildInfo', settle: 'resolve' },
      { pending: 'buildInfo', settle: 'reject' },
    ] as const)('$pending pending, then $settle: stays disconnected, client closed, no server facts', async ({ pending, settle }) => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const closedError = () => new Error('Client must be connected before running operations');

      let settlePending: (() => void) | undefined;
      const fake = {
        closed: false,
        connect: async () => {},
        close: async () => {
          fake.closed = true;
        },
        on: () => {},
        db: () => ({
          command: async (cmd: Record<string, unknown>) => {
            const name = Object.keys(cmd)[0]!;
            if (name === pending) {
              return new Promise((resolve, reject) => {
                settlePending = () => (settle === 'resolve' ? resolve({ version: '8.0.0' }) : reject(closedError()));
              });
            }
            // A closed client refuses everything, including the isMaster
            // fallback readHello tries after a failed hello.
            if (fake.closed) throw closedError();
            if (name === 'buildInfo') return { version: '8.0.0' };
            if (name === 'hello') return { ok: 1, isWritablePrimary: true };
            throw new Error(`unexpected command ${name}`);
          },
        }),
      };
      const pool = new MongoPool({
        repo: makeReader([makeConnection('c1', hp)]),
        vault,
        clientFactory: () => fake as unknown as import('mongodb').MongoClient,
      });
      const events: string[] = [];
      pool.on('status', (r) => events.push(r.status));

      const connecting = pool.connect('c1');
      // connect() is parked on the pending read, past the first guard.
      await vi.waitFor(() => expect(settlePending).toBeDefined());
      await pool.disconnect('c1');
      expect(fake.closed).toBe(true);

      settlePending!();
      const result = await connecting;

      expect(result.status).toBe('disconnected');
      expect(result.errorCode).toBeUndefined();
      expect(result.connectedAt).toBeUndefined();
      expect(result.serverVersion).toBeUndefined();
      expect(result.topology).toBeUndefined();
      expect(pool.status('c1')).toEqual(result);
      // No 'connected' event for a connection nobody can use.
      expect(events).toEqual(['connecting', 'disconnected']);
      expect(fake.closed).toBe(true);
    });
  });

  // X16 §4.1 / test cases 1 and 3. These replace the old
  // "connecting one connection disconnects any other that was previously
  // connected", which pinned the deleted preemption loop.
  it('connecting a second Connection leaves the first connected, and readDb works on both', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const connA = makeConnection('a', hp);
    const connB = makeConnection('b', hp);
    const pool = new MongoPool({ repo: makeReader([connA, connB]), vault });

    await pool.connect('a');
    expect(pool.status('a').status).toBe('connected');

    await pool.connect('b');
    expect(pool.status('b').status).toBe('connected');
    expect(pool.status('a').status).toBe('connected');

    // Usable at once, not merely both flagged connected: a real command on
    // each, against its own client.
    const [pingA, pingB] = await Promise.all([
      pool.readDb('a', 'admin').then((db) => db.command({ ping: 1 })),
      pool.readDb('b', 'admin').then((db) => db.command({ ping: 1 })),
    ]);
    expect(pingA.ok).toBe(1);
    expect(pingB.ok).toBe(1);

    await pool.disconnectAll();
  });

  it('disconnecting one Connection leaves the other connected and its readDb usable', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const connA = makeConnection('a', hp);
    const connB = makeConnection('b', hp);
    const pool = new MongoPool({ repo: makeReader([connA, connB]), vault });

    await pool.connect('a');
    await pool.connect('b');

    await pool.disconnect('a');
    expect(pool.status('a').status).toBe('disconnected');
    expect(pool.status('b').status).toBe('connected');

    const db = await pool.readDb('b', 'admin');
    expect((await db.command({ ping: 1 })).ok).toBe(1);

    await pool.disconnectAll();
  });

  describe('readDb defaultDb cache', () => {
    it('populates the cache on connect and does not re-read the repo per op', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp, { defaultDb: 'mydb' });
      const reader = makeCountingReader([conn]);
      const pool = new MongoPool({ repo: reader, vault });

      const db1 = await pool.readDb('c1');
      expect(db1.databaseName).toBe('mydb');
      const afterFirst = reader.calls;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      for (let i = 0; i < 25; i++) {
        const db = await pool.readDb('c1');
        expect(db.databaseName).toBe('mydb');
      }
      expect(reader.calls).toBe(afterFirst);

      await pool.disconnectAll();
    });

    it('explicit dbName argument bypasses the cache', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp, { defaultDb: 'default' });
      const pool = new MongoPool({ repo: makeReader([conn]), vault });

      const db = await pool.readDb('c1', 'other');
      expect(db.databaseName).toBe('other');

      // Works even if the connection has no defaultDb.
      const connNoDefault = makeConnection('c2', hp);
      const pool2 = new MongoPool({ repo: makeReader([connNoDefault]), vault });
      const db2 = await pool2.readDb('c2', 'explicit');
      expect(db2.databaseName).toBe('explicit');

      await pool.disconnectAll();
      await pool2.disconnectAll();
    });

    it('throws VALIDATION when no dbName given and connection has no default_db', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp);
      const pool = new MongoPool({ repo: makeReader([conn]), vault });

      await expect(pool.readDb('c1')).rejects.toThrow(/no database/i);

      await pool.disconnectAll();
    });

    it('cached defaultDb refreshes after disconnect → reconnect when the repo row changes', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conns = [makeConnection('c1', hp, { defaultDb: 'before' })];
      const pool = new MongoPool({
        repo: { findById: (id) => conns.find((c) => c.id === id) ?? null },
        vault,
      });

      const first = await pool.readDb('c1');
      expect(first.databaseName).toBe('before');

      // Simulate ConnectionService.update: repo row mutates, pool is disconnected.
      conns[0] = makeConnection('c1', hp, { defaultDb: 'after' });
      await pool.disconnect('c1');

      const second = await pool.readDb('c1');
      expect(second.databaseName).toBe('after');

      await pool.disconnectAll();
    });

    it('concurrent readDb calls share a single connect and a single repo read', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp, { defaultDb: 'mydb' });
      const reader = makeCountingReader([conn]);
      const pool = new MongoPool({ repo: reader, vault });

      const dbs = await Promise.all([
        pool.readDb('c1'),
        pool.readDb('c1'),
        pool.readDb('c1'),
        pool.readDb('c1'),
      ]);
      expect(dbs.every((d) => d.databaseName === 'mydb')).toBe(true);
      expect(reader.calls).toBe(1);

      await pool.disconnectAll();
    });

    it('does not retain defaultDb on the entry after a failed connect', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const badConn = makeConnection('c1', { host: '127.0.0.1', port: 1 }, {
        defaultDb: 'should_not_persist',
        advanced: {
          connectTimeoutMs: 500,
          socketTimeoutMs: 500,
          serverSelectionTimeoutMs: 500,
          readPreference: 'primary',
          maxPoolSize: 1,
          directConnection: true,
        },
      });
      const goodConn = makeConnection('c1', hp);
      const conns = [badConn];
      const pool = new MongoPool({ repo: makeReader(conns), vault });

      const r1 = await pool.connect('c1');
      expect(r1.status).toBe('error');

      // Switch the repo to a connection without a defaultDb, then connect
      // successfully. If the failed-connect path had cached defaultDb, readDb()
      // would silently use the stale value instead of throwing.
      conns[0] = goodConn;
      const r2 = await pool.connect('c1');
      expect(r2.status).toBe('connected');

      await expect(pool.readDb('c1')).rejects.toThrow(/no database/i);

      await pool.disconnectAll();
    });

    it('clears defaultDb on disconnect so a stale value cannot leak across reconnects', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conns = [makeConnection('c1', hp, { defaultDb: 'before' })];
      const pool = new MongoPool({
        repo: { findById: (id) => conns.find((c) => c.id === id) ?? null },
        vault,
      });

      const first = await pool.readDb('c1');
      expect(first.databaseName).toBe('before');

      conns[0] = makeConnection('c1', hp); // no defaultDb
      await pool.disconnect('c1');

      // After reconnect the cache should reflect the current repo row, not the
      // pre-disconnect value.
      await expect(pool.readDb('c1')).rejects.toThrow(/no database/i);

      await pool.disconnectAll();
    });

    it('cache survives an unrelated readClient path and reflects defaultDb at connect time', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp, { defaultDb: 'mydb' });
      const reader = makeCountingReader([conn]);
      const pool = new MongoPool({ repo: reader, vault });

      // Prime via readClient (no dbName involved).
      await pool.readClient('c1');
      const priming = reader.calls;

      const db = await pool.readDb('c1');
      expect(db.databaseName).toBe('mydb');
      // readDb must not have added any repo reads on top of the connect.
      expect(reader.calls).toBe(priming);

      await pool.disconnectAll();
    });
  });

  it('probe short-circuits when ssh.enabled is true', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp, {
      ssh: { enabled: true, host: 'bastion', port: 22 },
    });
    const pool = new MongoPool({ repo: makeReader([]), vault });
    const r = await pool.probe(conn);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/SSH tunnels/i);
  });

  it('connect refuses a stored ssh_enabled=1 row and leaves no pool entry behind', async () => {
    tmp = createTempDb();
    vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', hp, {
      ssh: { enabled: true, host: 'bastion', port: 22 },
    });
    const pool = new MongoPool({ repo: makeReader([conn]), vault });
    const events: string[] = [];
    pool.on('status', (r) => events.push(r.status));

    await expect(pool.connect('c1')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/SSH tunnels are not supported/i),
    });
    // Any route to a handle goes through connect(), so the read path is refused too.
    await expect(pool.readClient('c1')).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(events).toEqual([]);
    expect(pool.status('c1').status).toBe('disconnected');
  });

  describe('diagnostic logging (#9)', () => {
    interface CapturedLog {
      level: 'debug' | 'info' | 'warn' | 'error';
      tag: string;
      msg: string;
      data?: unknown;
    }

    const makeFakeLog = () => {
      const calls: CapturedLog[] = [];
      const push = (level: CapturedLog['level']) =>
        (tag: string, msg: string, data?: unknown) => calls.push({ level, tag, msg, data });
      return {
        log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
        calls,
      };
    };

    it('logs a hello snapshot on probe success with topology fields', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const { log, calls } = makeFakeLog();
      const pool = new MongoPool({ repo: makeReader([]), vault, log });
      const r = await pool.probe(makeConnection('probe', hp));
      expect(r.ok).toBe(true);

      const hello = calls.find((c) => c.tag === 'mongo' && c.msg === 'hello snapshot');
      expect(hello, 'expected hello snapshot log entry').toBeTruthy();
      const data = hello!.data as { source: string; role: string; connectionId: string };
      expect(data.source).toBe('probe');
      // mongodb-memory-server is a standalone — driver's hello returns a
      // primary-shaped document. We don't pin to a specific value because the
      // driver may report 'primary' or 'unknown' depending on version, but it
      // must be a known role string.
      expect(['primary', 'secondary', 'unknown', 'mongos', 'arbiter']).toContain(data.role);
    });

    it('logs a hello snapshot on connect success', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const { log, calls } = makeFakeLog();
      const conn = makeConnection('c1', hp);
      const pool = new MongoPool({ repo: makeReader([conn]), vault, log });
      await pool.readClient('c1');

      const hello = calls.find((c) => c.tag === 'mongo' && c.msg === 'hello snapshot');
      expect(hello).toBeTruthy();
      expect((hello!.data as { source: string }).source).toBe('connect');

      await pool.disconnectAll();
    });

    it('does not attach driver-event listeners when debugDriverEvents is false (default)', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const { log, calls } = makeFakeLog();
      const conn = makeConnection('c1', hp);
      const pool = new MongoPool({ repo: makeReader([conn]), vault, log });
      await pool.readClient('c1');
      await pool.disconnectAll();

      const driverEvents = calls.filter((c) => c.tag === 'mongo:driver');
      expect(driverEvents).toHaveLength(0);
    });

    it('captures driver events when debugDriverEvents=true', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const { log, calls } = makeFakeLog();
      const conn = makeConnection('c1', hp);
      const pool = new MongoPool({
        repo: makeReader([conn]),
        vault,
        log,
        debugDriverEvents: true,
      });
      await pool.readClient('c1');
      await pool.disconnectAll();

      // The driver fires `topologyDescriptionChanged` synchronously during
      // connect (Unknown → Single). Other events may or may not arrive
      // depending on timing, but topology change is reliable.
      const driverEvents = calls.filter((c) => c.tag === 'mongo:driver');
      expect(driverEvents.length).toBeGreaterThan(0);
      const topo = driverEvents.find((c) => c.msg === 'topologyDescriptionChanged');
      expect(topo).toBeTruthy();
      expect((topo!.data as { connectionId: string }).connectionId).toBe('c1');
    });
  });

  describe('involuntary connection loss', () => {
    it('flips a connected entry to Dormant when the deployment goes away', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      // Its own server: this test kills the mongod, so it must not be the one
      // every other test in the suite is sharing.
      const dedicated = await MongoMemoryServer.create();
      try {
        const conn = makeConnection('lost', uriToHostPort(dedicated.getUri()));
        const pool = new MongoPool({
          repo: makeReader([conn]),
          vault,
          connectionLossGraceMs: 250,
        });
        await pool.readClient('lost');
        expect(pool.status('lost').status).toBe('connected');
        expect(pool.status('lost').topology).toBe('Single');
        expect(pool.status('lost').serverVersion).toMatch(/^\d/);

        const seen: string[] = [];
        pool.on('status', (r: { status: string }) => seen.push(r.status));

        await dedicated.stop();

        // Poll status() — a pure read. Calling readClient/readDb/ping here would
        // kick off a fresh connect against the dead server and land the entry
        // on 'error', which is a different transition than the one under test.
        const deadline = Date.now() + 20_000;
        while (pool.status('lost').status === 'connected' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }

        expect(pool.status('lost').status).toBe('disconnected');
        expect(pool.status('lost').connectedAt).toBeUndefined();
        // What the dead connection learned about its server is gone with it.
        expect(pool.status('lost').topology).toBeUndefined();
        expect(pool.status('lost').serverVersion).toBeUndefined();
        // No errorCode: an involuntary drop renders Dormant, not failed.
        expect(pool.status('lost').errorCode).toBeUndefined();
        // The renderer's existing mongo.onStatus subscription rides this emit,
        // so no new IPC channel is involved.
        expect(seen).toContain('disconnected');

        await pool.disconnectAll();
      } finally {
        await dedicated.stop().catch(() => {});
      }
    }, 60_000);

    // The grace window is the whole reason this feature doesn't flap the UI:
    // SDAM marks a server Unknown on ONE missed heartbeat, so without the timer
    // every ordinary blip would flip the Connection to Dormant and back. Driven
    // through a real EventEmitter rather than a real server — a blip is not
    // something a memory server can be made to produce on cue.
    it('rides out a transient blip, and still fires on a sustained loss', async () => {
      tmp = createTempDb();
      vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const conn = makeConnection('c1', hp);
      const emitter = new EventEmitter();
      const fake = {
        on: (ev: string, fn: (...a: unknown[]) => void) => {
          emitter.on(ev, fn);
          return fake;
        },
        connect: async () => {},
        close: async () => {},
        db: () => ({ command: async () => ({ version: '0.0.0' }) }),
      };
      const pool = new MongoPool({
        repo: makeReader([conn]),
        vault,
        connectionLossGraceMs: 300,
        clientFactory: () => fake as unknown as import('mongodb').MongoClient,
      });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const unreachable = () =>
        emitter.emit('topologyDescriptionChanged', { newDescription: { hasKnownServers: false } });
      const reachable = () =>
        emitter.emit('topologyDescriptionChanged', { newDescription: { hasKnownServers: true } });

      await pool.readClient('c1');
      expect(pool.status('c1').status).toBe('connected');

      // Blip: gone, then back well inside the 300ms window.
      unreachable();
      await sleep(100);
      reachable();
      await sleep(400);
      expect(pool.status('c1').status).toBe('connected');

      // Sustained: gone and stays gone past the window.
      unreachable();
      await sleep(500);
      expect(pool.status('c1').status).toBe('disconnected');

      await pool.disconnectAll();
    });
  });
});

// `databaseCount`, `dataSizeBytes` and `storageSizeBytes` are all derived
// from one `listDatabases`. When it fails there is nothing to derive them
// from, and summing an empty reply to 0 reports a cluster the app could not
// read as an empty one — the detail panel prints all three.
//
// A dedicated server, not the shared one: `failCommand` needs
// `enableTestCommands`, which nothing else in this suite wants turned on. The
// refusal then comes from the real mongod, not from a stubbed client.
describe('MongoPool.serverInfo — listDatabases refused', () => {
  let ftServer: MongoMemoryServer;
  let ftTmp: TempDb;
  let ftVault: SecretsVault;
  let pool: MongoPool;

  beforeAll(async () => {
    ftServer = await MongoMemoryServer.create({
      instance: { args: ['--setParameter', 'enableTestCommands=1'] },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.disconnectAll();
    ftTmp.cleanup();
    await ftServer.stop();
  });

  it('reports the three derived figures as null rather than zero', async () => {
    ftTmp = createTempDb();
    ftVault = new SecretsVault(ftTmp.db, createSafeStorageMock());
    const conn = makeConnection('c1', uriToHostPort(ftServer.getUri()));
    pool = new MongoPool({ repo: makeReader([conn]), vault: ftVault });

    const client = await pool.readClient('c1');
    await client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['listDatabases'], errorCode: 13 },
    });

    const info = await pool.serverInfo('c1');
    expect(info.databaseCount).toBeNull();
    expect(info.dataSizeBytes).toBeNull();
    expect(info.storageSizeBytes).toBeNull();
    // A partial failure, not a failed call — the rest of the reply stands.
    expect(info.version).toMatch(/^\d/);

    // And the very next call, with the failpoint spent, measures for real.
    const after = await pool.serverInfo('c1');
    expect(after.databaseCount).not.toBeNull();
    expect(after.storageSizeBytes).not.toBeNull();
  });

  // A refusal and an expiry fall through the same catch but are not the same
  // answer. Only the expiry has something cheaper to fall back on: the cost
  // that blew the bound was the per-database stats total, so the names-only
  // read still recovers the count.
  it('recovers the count but not the sizes when the bound fires', async () => {
    const client = await pool.readClient('c1');
    await client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['listDatabases'], errorCode: 50 },
    });

    const info = await pool.serverInfo('c1');
    expect(info.databaseCount).not.toBeNull();
    expect(info.dataSizeBytes).toBeNull();
    expect(info.storageSizeBytes).toBeNull();
  });
});
