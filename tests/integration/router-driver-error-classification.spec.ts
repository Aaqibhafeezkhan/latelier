import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import type { Envelope } from '@shared/ipc';
import { IPC_CHANNELS } from '@shared/ipc';
import { createRouter } from '../../electron/ipc/router';
import { registerQueryChannels } from '../../electron/ipc/handlers/query';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { QueryService } from '../../electron/mongo/QueryService';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb, createTempCipher } from '../helpers/db';
import { makeConnection, makeReader, uriToHostPort } from '../helpers/mongo';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

/**
 * X18 §7 / T16: a raw driver error must reach the router already classified,
 * so the renderer can tell a timeout from a bug.
 *
 * Nothing else in the suite covers this. The `*-handlers.spec.ts` files stub
 * the service, so no driver error ever exists in them; the service specs call
 * the service directly, so the router is never involved. The gap that hid was
 * real: `count`, `findOne` and `explain` had no classifier at all, and every
 * driver error from them arrived at `toIpcError` as a bare `Error` and left it
 * labelled `INTERNAL`.
 *
 * So this test drives a real server-side failure, through the real registered
 * channel, and asserts on the envelope the renderer would actually receive.
 */
type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

const DB = 'router_cls';
const COLL = 'items';

describe('a driver error reaches the renderer classified, not as INTERNAL', () => {
  let server: MongoMemoryServer;
  let pool: MongoPool;
  let tmp: TempDb;
  let handlers: Map<string, Handler>;
  const connId = 'cls-conn';

  const invoke = async <T>(channel: string, payload: unknown): Promise<Envelope<T>> => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return (await h(invokeEvent, payload)) as Envelope<T>;
  };

  beforeAll(async () => {
    // `failCommand` needs `enableTestCommands`, so this gets its own server.
    server = await MongoMemoryServer.create({
      instance: { args: ['--setParameter', 'enableTestCommands=1'] },
    });
    const seed = new MongoClient(server.getUri());
    await seed.connect();
    await seed.db(DB).collection(COLL).insertOne({ a: 1 });
    await seed.close();

    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, uriToHostPort(server.getUri()), { defaultDb: DB });
    pool = new MongoPool({ repo: makeReader([conn]), vault });

    tmp.db
      .prepare(
        `INSERT INTO connections (
           id, name, color, connection_type, host, port,
           auth_mech, tls_enabled, tls_verify, ssh_enabled,
           connect_timeout_ms, socket_timeout_ms, server_selection_timeout_ms,
           read_preference, max_pool_size, direct_connection,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'standard', ?, ?, 'none', 0, 1, 0, 5000, 5000, 5000,
                   'primary', 5, 1, datetime('now'), datetime('now'))`,
      )
      .run(connId, 'cls', '#1A6835', conn.host, conn.port);

    const svc = new QueryService(
      pool,
      new RecentQueryService(new RecentQueryRepo(tmp.db, createTempCipher())),
    );
    handlers = new Map();
    const router = createRouter(
      { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) } as never,
      testSenderCheck,
    );
    registerQueryChannels(router, svc, async () => null);
  }, 60_000);

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
    await server.stop();
  });

  const failNext = async (commands: string[], errorCode: number): Promise<void> => {
    const client = await pool.readClient(connId);
    await client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: commands, errorCode },
    });
  };

  // `count`, `findOne` and `explain` each route to a different driver command,
  // so one failpoint per channel rather than one shared case.
  const cases: Array<{
    what: string;
    channel: string;
    command: string;
    payload: Record<string, unknown>;
  }> = [
    {
      what: 'count',
      channel: IPC_CHANNELS.queryCount,
      // `countDocuments` is an aggregate with `$match`/`$group`, not the
      // legacy `count` command.
      command: 'aggregate',
      payload: { connectionId: connId, dbName: DB, collection: COLL, filter: '{}' },
    },
    {
      what: 'findOne',
      channel: IPC_CHANNELS.queryFindOne,
      command: 'find',
      payload: { connectionId: connId, dbName: DB, collection: COLL, filter: '{}' },
    },
    {
      what: 'explain',
      channel: IPC_CHANNELS.queryExplain,
      command: 'explain',
      payload: {
        connectionId: connId,
        dbName: DB,
        collection: COLL,
        filter: '{}',
        verbosity: 'queryPlanner',
      },
    },
  ];

  for (const c of cases) {
    it(`${c.what}: a server timeout arrives as TIMEOUT`, async () => {
      await failNext([c.command], 50); // MaxTimeMSExpired
      const env = await invoke(c.channel, c.payload);
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('TIMEOUT');
    });

    it(`${c.what}: a permission failure arrives as UNAUTHORIZED`, async () => {
      await failNext([c.command], 13); // Unauthorized
      const env = await invoke(c.channel, c.payload);
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('UNAUTHORIZED');
    });
  }

  it('an error that is not from the driver is still INTERNAL', async () => {
    // The backstop must not relabel our own bugs as database problems.
    const local = new Map<string, Handler>();
    const router = createRouter(
      { handle: (channel: string, fn: Handler) => local.set(channel, fn) } as never,
      testSenderCheck,
    );
    router.register(
      'test:boom',
      (p) => p,
      () => {
        throw new TypeError('x is not a function');
      },
    );
    const env = (await local.get('test:boom')!(invokeEvent, {})) as Envelope<unknown>;
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INTERNAL');
  });

  // The cases above all go through `QueryService`, which classifies before the
  // router sees anything — so they pass whether or not the backstop exists.
  // Removing it left the entire suite green, which is what a backstop behind a
  // working catch looks like from any test that goes through a service.
  //
  // This one has no service in the path. It captures a real `MongoServerError`
  // straight off the driver, then throws it from a bare registered handler, so
  // the router is the only thing that can classify it. It fails if the
  // backstop is removed.
  it('classifies a raw driver error that reaches it with no service in the path', async () => {
    await failNext(['find'], 50); // MaxTimeMSExpired
    const client = await pool.readClient(connId);
    let raw: unknown;
    try {
      await client.db(DB).collection(COLL).find({}).toArray();
    } catch (err) {
      raw = err;
    }
    // Guard the guard: if the failpoint stopped firing, the assertion below
    // would pass against `undefined` for the wrong reason.
    expect((raw as { name?: string })?.name).toBe('MongoServerError');
    expect((raw as { codeName?: string })?.codeName).toBe('MaxTimeMSExpired');

    const local = new Map<string, Handler>();
    const router = createRouter(
      { handle: (channel: string, fn: Handler) => local.set(channel, fn) } as never,
      testSenderCheck,
    );
    router.register(
      'test:raw-driver',
      (p) => p,
      () => {
        throw raw;
      },
    );
    const env = (await local.get('test:raw-driver')!(invokeEvent, {})) as Envelope<unknown>;
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('TIMEOUT');
  });

  // A thrown value need not be a well-behaved object, and the classifier now
  // runs in front of `toIpcError` for every channel. `instanceof` triggers a
  // Proxy's `getPrototypeOf` trap and reading `name` runs whatever getter is
  // there — either can throw, and when it did the handler rejected instead of
  // returning an envelope, which is the one thing the IPC contract promises.
  it.each([
    [
      'a Proxy whose getPrototypeOf trap throws',
      (): unknown => new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } }),
    ],
    [
      'a value whose name getter throws',
      (): unknown => ({ get name(): string { throw new Error('name getter'); } }),
    ],
  ])('still returns an envelope for %s', async (_what, make) => {
    const local = new Map<string, Handler>();
    const router = createRouter(
      { handle: (channel: string, fn: Handler) => local.set(channel, fn) } as never,
      testSenderCheck,
    );
    router.register(
      'test:hostile',
      (p) => p,
      () => {
        throw make();
      },
    );
    const env = (await local.get('test:hostile')!(invokeEvent, {})) as Envelope<unknown>;
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INTERNAL');
  });

  it('a successful call is unaffected', async () => {
    const env = await invoke<{ count: number }>(IPC_CHANNELS.queryCount, {
      connectionId: connId,
      dbName: DB,
      collection: COLL,
      filter: '{}',
    });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.count).toBe(1);
  });
});
