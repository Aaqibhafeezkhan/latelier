import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MongoClient } from 'mongodb';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ScriptService } from '../../electron/services/ScriptService';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { ConnectionService, connectionReader } from '../../electron/mongo/ConnectionService';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { AppError, ReadOnlyConnectionError, SystemError } from '../../electron/errors';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { createTestSpawner, type TestSpawner } from '../helpers/runnerSpawner';
import {
  getSharedServer,
  stopSharedServer,
  uriToHostPort,
  makeConnection,
  makeReader,
} from '../helpers/mongo';

// Scripts run against the `test` database unless the call names another.
const DB = 'test';

let server: MongoMemoryServer;
let hp: { host: string; port: number };
let tmp: TempDb | undefined;
let pool: MongoPool | undefined;
let spawner: TestSpawner;
let svc: ScriptService | undefined;

beforeAll(async () => {
  server = await getSharedServer();
  hp = uriToHostPort(server.getUri());
}, 60_000);

afterAll(async () => {
  await stopSharedServer();
});

afterEach(async () => {
  // A leaked runner would hold vitest open after the suite: every run must
  // have reaped its child, whichever way it ended. Checked before any cleanup
  // so cleanup cannot hide a leak.
  const deadline = Date.now() + 3000;
  while (spawner.alive().length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const leaked = spawner.alive().length;
  svc?.cancelAll();
  svc = undefined;
  spawner.killAll();
  if (pool) await pool.disconnectAll();
  pool = undefined;
  tmp?.cleanup();
  tmp = undefined;
  expect(leaked, 'runner children still alive after the test').toBe(0);
});

/** A service over a real pool and the shared mongod, forking the real runner. */
function setup(overrides: Record<string, Partial<Parameters<typeof makeConnection>[2]>> = {}): ScriptService {
  tmp = createTempDb();
  const vault = new SecretsVault(tmp.db, createSafeStorageMock());
  const conns = ['c1', 'ro', 'rw'].map((id) =>
    makeConnection(id, hp, { defaultDb: DB, readOnly: id === 'ro', ...overrides[id] }),
  );
  pool = new MongoPool({ repo: makeReader(conns), vault });
  spawner = createTestSpawner();
  svc = new ScriptService({ pool, spawner });
  return svc;
}

/** A pool stand-in for phases that never reach a real connection. */
function fakePool(readClient: () => Promise<unknown>): MongoPool {
  return Object.assign(new EventEmitter(), {
    readClient,
    isReadOnly: () => {
      throw new Error('isReadOnly must not be reached');
    },
  }) as unknown as MongoPool;
}

async function countDocs(coll: string): Promise<number> {
  const client = new MongoClient(server.getUri());
  try {
    return await client.db(DB).collection(coll).countDocuments();
  } finally {
    await client.close();
  }
}

async function until(cond: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Resolves once a run has reached the point of writing `coll`'s marker doc. */
function markerSeen(coll: string): Promise<void> {
  return until(async () => (await countDocs(coll)) > 0, `marker in ${coll}`);
}

describe('ScriptService — results', () => {
  it('captures the last expression as the result', async () => {
    const r = await setup().run({ connectionId: 'c1', source: '1 + 2' });
    expect(r.valueJson).toBe('3');
    expect(r.printBuffer).toBe('');
  });

  it('returns null valueJson when the last statement is not an expression', async () => {
    const r = await setup().run({ connectionId: 'c1', source: 'const x = 5;' });
    expect(r.valueJson).toBeNull();
  });

  it('supports top-level await against the real server', async () => {
    const r = await setup().run({ connectionId: 'c1', source: 'await db.runCommand({ ping: 1 })' });
    // valueJson is canonical EJSON, so numbers come back wrapped.
    expect(JSON.parse(r.valueJson!)).toEqual({ ok: { $numberInt: '1' } });
  });

  it('respects dbName override', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      dbName: 'another_db',
      source: 'await db.runCommand({ dbStats: 1 })',
    });
    expect(JSON.parse(r.valueJson!).db).toBe('another_db');
  });

  it("runs on the connection's default database when no dbName is given", async () => {
    const r = await setup({ c1: { defaultDb: 'script_default' } }).run({
      connectionId: 'c1',
      source: 'await db.runCommand({ dbStats: 1 })',
    });
    expect(JSON.parse(r.valueJson!).db).toBe('script_default');
  });

  it('an explicit dbName wins over the connection default', async () => {
    const r = await setup({ c1: { defaultDb: 'script_default' } }).run({
      connectionId: 'c1',
      dbName: 'another_db',
      source: 'await db.runCommand({ dbStats: 1 })',
    });
    expect(JSON.parse(r.valueJson!).db).toBe('another_db');
  });

  it('a blank dbName counts as unset, so the connection default applies', async () => {
    const r = await setup({ c1: { defaultDb: 'script_default' } }).run({
      connectionId: 'c1',
      dbName: '  ',
      source: 'await db.runCommand({ dbStats: 1 })',
    });
    expect(JSON.parse(r.valueJson!).db).toBe('script_default');
  });

  it('falls back to test when the connection has no default database', async () => {
    const r = await setup({ c1: { defaultDb: undefined } }).run({
      connectionId: 'c1',
      source: 'await db.runCommand({ dbStats: 1 })',
    });
    expect(JSON.parse(r.valueJson!).db).toBe('test');
  });

  it('use() switches the database for later calls', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      source: 'use("switched_db"); await db.runCommand({ dbStats: 1 })',
    });
    expect(JSON.parse(r.valueJson!).db).toBe('switched_db');
  });

  it('captures print() output', async () => {
    const r = await setup().run({ connectionId: 'c1', source: 'print("hello", "world"); 42' });
    expect(r.printBuffer).toContain('hello world');
    // Plain primitives (numbers/booleans/strings) bypass EJSON wrapping.
    expect(r.valueJson).toBe('42');
  });

  it('prints a Long past 2^53 with its exact digits, built in the script or read back from the database', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      source: [
        'print({ built: NumberLong("9007199254740993") });',
        'await db.print_wide.deleteMany({});',
        'await db.print_wide.insertOne({ big: NumberLong("9007199254740993"), safe: NumberLong("5") });',
        'printjson(await db.print_wide.findOne({}, { projection: { _id: 0 } }));',
        '1',
      ].join('\n'),
    });
    expect(r.printBuffer).toContain('"built": {\n    "$numberLong": "9007199254740993"\n  }');
    expect(r.printBuffer).toContain('"big": {\n    "$numberLong": "9007199254740993"\n  }');
    // A Long inside the safe range keeps printing as a bare number.
    expect(r.printBuffer).toContain('"safe": 5');
    expect(r.printBuffer).not.toContain('9007199254740992');
  });

  it('prints a function as inspect does, not as an empty line', async () => {
    const r = await setup().run({ connectionId: 'c1', source: 'function named() {}\nprint(named); 1' });
    expect(r.printBuffer).toContain('[Function: named]');
  });

  it('prints a collection and a cursor as a one-line hint, not an empty object', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      source: 'print(db.print_hint); console.log(db.print_hint.find()); use("print_other"); printjson(db.print_hint); 1',
    });
    expect(r.printBuffer).toContain('[Collection test.print_hint]');
    expect(r.printBuffer).toContain('Cursor on test.print_hint');
    expect(r.printBuffer).toContain('[Collection print_other.print_hint]');
    expect(r.printBuffer).not.toMatch(/^\{\}$/m);
  });

  it('returns a bare collection as its one-line hint, not an empty object', async () => {
    const r = await setup().run({ connectionId: 'c1', source: 'db.print_hint' });
    expect(JSON.parse(r.valueJson!)).toBe('[Collection test.print_hint]');
  });

  it('caps the print buffer at ~64 KB', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      source: 'for (let i = 0; i < 10000; i++) print("x".repeat(100));',
      maxTimeMs: 10_000,
    });
    expect(r.printBuffer.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.printBuffer.length).toBeGreaterThan(60 * 1024);
  });

  it('reports an un-awaited rejection in the print buffer instead of crashing the runner', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      // The awaited server call keeps the script alive past the tick in which
      // Node reports the stray rejection.
      source: 'Promise.reject(new Error("stray")); await db.runCommand({ ping: 1 }); 7',
    });
    expect(r.valueJson).toBe('7');
    expect(r.printBuffer).toContain('ERROR: unhandled rejection:');
    expect(r.printBuffer).toContain('stray');
  });

  it('round-trips an array of documents through EJSON', async () => {
    const s = setup();
    await s.run({
      connectionId: 'c1',
      source: 'await db.rt_docs.deleteMany({}); await db.rt_docs.insertMany([{ _id: "a" }, { _id: "b" }]); 1',
    });
    const r = await s.run({ connectionId: 'c1', source: 'await db.rt_docs.find().sort({ _id: 1 }).toArray()' });
    const docs = JSON.parse(r.valueJson!);
    expect(docs).toEqual([{ _id: 'a' }, { _id: 'b' }]);
  });

  it('a normal small result still encodes fine and fast', async () => {
    const t0 = Date.now();
    const r = await setup().run({ connectionId: 'c1', source: '({ a: 1, b: [1, 2, 3] })' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(JSON.parse(r.valueJson!).b).toHaveLength(3);
  });

  it('refuses a result over the 50 MB cap with a clear error', async () => {
    const promise = setup().run({
      connectionId: 'c1',
      // 60 MB across a handful of strings: over the cap, cheap to build.
      source: 'Array.from({ length: 60 }, () => "x".repeat(1024 * 1024))',
      maxTimeMs: 30_000,
    });
    await expect(promise).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(promise).rejects.toThrow(/exceeds 52428800 byte cap/);
  }, 60_000);

  it('a result just under the cap is returned whole', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      source: '"x".repeat(1024 * 1024)',
      maxTimeMs: 30_000,
    });
    expect(JSON.parse(r.valueJson!)).toHaveLength(1024 * 1024);
  });
});

describe('ScriptService — errors', () => {
  it('throws ValidationError on syntax errors', async () => {
    await expect(setup().run({ connectionId: 'c1', source: 'const x = ;' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('the AppError thrown carries a stable code', async () => {
    let caught: unknown;
    try {
      await setup().run({ connectionId: 'c1', source: 'throw new Error("boom")' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('MONGO_ERROR');
    expect((caught as AppError).message).toContain('boom');
  });

  it('reports SyntaxError line numbers that match the user source', async () => {
    let caught: { code: string; message: string } | undefined;
    try {
      // `const x = ;` is on line 1; expect "line 1" in the message.
      await setup().run({ connectionId: 'c1', source: 'const x = ;' });
    } catch (e) {
      caught = e as { code: string; message: string };
    }
    expect(caught?.code).toBe('VALIDATION');
    expect(caught?.message).toContain('line 1');
  });

  it('reports SyntaxError on multi-line source at the correct line', async () => {
    let caught: { code: string; message: string } | undefined;
    try {
      // `const x = ;` is on line 2; expect "line 2" in the message.
      await setup().run({ connectionId: 'c1', source: 'let a = 1;\nconst x = ;' });
    } catch (e) {
      caught = e as { code: string; message: string };
    }
    expect(caught?.code).toBe('VALIDATION');
    expect(caught?.message).toContain('line 2');
  });

  it('reports runtime stack lines that match the user source', async () => {
    let caught: { stack?: string } | undefined;
    try {
      await setup().run({
        connectionId: 'c1',
        source: ['const a = 1;', 'const b = 2;', 'throw new Error("boom")'].join('\n'),
      });
    } catch (e) {
      caught = e as { stack?: string };
    }
    // The throw is on line 3. The wrapper-shifted line 4 must not appear.
    expect(caught?.stack).toMatch(/script\.js:3\b/);
    expect(caught?.stack).not.toMatch(/script\.js:4\b/);
  });

  it('classifies a driver error the way the in-process runner did', async () => {
    const s = setup();
    await s.run({ connectionId: 'c1', source: 'await db.dup_keys.deleteMany({}); await db.dup_keys.insertOne({ _id: 1 }); 1' });
    await expect(
      s.run({ connectionId: 'c1', source: 'await db.dup_keys.insertOne({ _id: 1 })' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('surfaces a connect failure from the pool before any runner is spawned', async () => {
    setup();
    await expect(svcRun({ connectionId: 'no-such-connection', source: '1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(spawner.spawns).toHaveLength(0);
  });
});

function svcRun(input: Parameters<ScriptService['run']>[0]): ReturnType<ScriptService['run']> {
  return svc!.run(input);
}

describe('ScriptService — runningCount', () => {
  it('is 1 while a script runs and 0 once it is cancelled', async () => {
    const s = setup();
    expect(s.runningCount()).toBe(0);
    const run = s.run({
      connectionId: 'c1',
      source: 'await new Promise(() => {})',
      cancelToken: 'count-cancel',
    });
    const settled = run.catch((err: unknown) => err);
    await until(async () => s.runningCount() === 1, 'the script to be counted');
    s.cancel('count-cancel');
    await settled;
    expect(s.runningCount()).toBe(0);
  });

  it('is 0 after a script finishes', async () => {
    const s = setup();
    await s.run({ connectionId: 'c1', source: '1 + 1' });
    expect(s.runningCount()).toBe(0);
  });
});

describe('ScriptService — timeouts kill the runner', () => {
  it('enforces maxTimeMs on a CPU-bound runaway', async () => {
    const t0 = Date.now();
    await expect(
      setup().run({ connectionId: 'c1', source: 'while (true) {}', maxTimeMs: 300 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'script exceeded 300ms (cancel and rerun, or raise the limit)',
    });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a microtask loop times out, the app stays responsive, and the next run works', async () => {
    const s = setup();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const t0 = Date.now();
    try {
      await expect(
        s.run({
          connectionId: 'c1',
          source: 'while (true) await Promise.resolve()',
          maxTimeMs: 500,
        }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - t0).toBeLessThan(1500);
    // This process shares nothing with the runner, so its own loop kept turning.
    expect(ticks).toBeGreaterThan(5);

    const next = await s.run({ connectionId: 'c1', source: '1 + 1' });
    expect(next.valueJson).toBe('2');
  });

  it('the microtask loop really ran before it was killed', async () => {
    const s = setup();
    await expect(
      s.run({
        connectionId: 'c1',
        source: 'await db.micro_marker.insertOne({ started: 1 }); while (true) await Promise.resolve()',
        maxTimeMs: 3000,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(await countDocs('micro_marker')).toBeGreaterThan(0);
  });

  it('a promise that never settles times out', async () => {
    const t0 = Date.now();
    await expect(
      setup().run({ connectionId: 'c1', source: 'await new Promise(() => {})', maxTimeMs: 300 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a long-awaited server call times out at maxTimeMs, not when the server answers', async () => {
    const s = setup();
    await s.run({ connectionId: 'c1', source: 'await db.slow_coll.insertOne({ n: 1 }); 1' });
    const t0 = Date.now();
    await expect(
      s.run({
        connectionId: 'c1',
        // Server-side sleep of 5 s, itself bounded so it cannot outlive the test.
        source: 'await db.slow_coll.find({ $where: "sleep(5000) || true" }).maxTimeMS(6000).toArray()',
        maxTimeMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 20_000);

  it('enforces maxTimeMs during the encode of a large result', async () => {
    const t0 = Date.now();
    await expect(
      setup().run({
        connectionId: 'c1',
        source: 'Array.from({ length: 600000 }, (_, i) => ({ n: i, s: "x" }))',
        maxTimeMs: 300,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);

  it('a script needing close to its maxTimeMs still completes', async () => {
    const r = await setup().run({
      connectionId: 'c1',
      source: 'await new Promise((r) => { const t = Date.now(); (function spin() { Promise.resolve().then(() => Date.now() - t > 400 ? r() : spin()); })(); }); "done"',
      maxTimeMs: 5000,
    });
    expect(r.valueJson).toBe('"done"');
  });
});

describe('ScriptService — runner lifecycle', () => {
  it('one runner per run, and each is reaped', async () => {
    const s = setup();
    await s.run({ connectionId: 'c1', source: '1' });
    await s.run({ connectionId: 'c1', source: '2' });
    expect(spawner.spawns).toHaveLength(2);
    await until(async () => spawner.alive().length === 0, 'runners to exit', 3000);
  });

  it('a runner that dies mid-run surfaces a clean SystemError', async () => {
    const t0 = Date.now();
    let caught: unknown;
    try {
      // Escape attempt, kept here on purpose: it is how a hostile script
      // would take its own process down.
      await setup().run({
        connectionId: 'c1',
        source: 'this.constructor.constructor("return process")().exit(3)',
        maxTimeMs: 30_000,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SystemError);
    expect((caught as SystemError).code).toBe('INTERNAL');
    expect((caught as SystemError).message).toMatch(/exited unexpectedly \(exit code 3\)/);
    // Reported promptly, not at the 30 s wall clock.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('cancelAll kills live runners, including runs with no cancel token', async () => {
    const s = setup();
    const promise = s.run({
      connectionId: 'c1',
      source: 'await db.cancelall_marker.insertOne({ t: 1 }); await new Promise(() => {})',
      maxTimeMs: 30_000,
    });
    const settled = promise.then(
      () => 'resolved',
      (e: AppError) => e,
    );
    await markerSeen('cancelall_marker');
    expect(spawner.alive()).toHaveLength(1);
    s.cancelAll();
    const outcome = await settled;
    expect(outcome).toMatchObject({ code: 'TIMEOUT', message: 'script cancelled' });
    await until(async () => spawner.alive().length === 0, 'runner to die', 3000);
  });

  it('never puts credentials anywhere the runner can see: argv, env or any message', async () => {
    setup();
    // The user is unknown to the server, so the pool's own connect would fail
    // authentication; stand in for it with an unauthenticated client. What the
    // test inspects is what main hands the runner, and the script makes a real
    // call so there are RPC frames and replies to inspect as well.
    const sentinel = 'pw-SENTINEL-9f3a';
    const now = new Date().toISOString();
    tmp!.db
      .prepare(
        `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
         VALUES ('authed', 'authed', 'standard', 'localhost', 27017, 'scram256', ?, ?)`,
      )
      .run(now, now);
    const vault = new SecretsVault(tmp!.db, createSafeStorageMock());
    vault.set('authed', 'password', sentinel);
    const authed = makeConnection('authed', hp, {
      defaultDb: DB,
      authMech: 'scram256',
      authUsername: 'nobody',
    });
    pool = new MongoPool({ repo: makeReader([authed]), vault });
    const direct = new MongoClient(server.getUri());
    vi.spyOn(pool, 'readClient').mockResolvedValue(direct);
    svc = new ScriptService({ pool, spawner });
    try {
      const r = await svc.run({
        connectionId: 'authed',
        source: 'await db.runCommand({ ping: 1 }); 1',
        maxTimeMs: 5000,
      });
      expect(r.valueJson).toBe('1');
    } finally {
      await direct.close();
    }

    expect(spawner.spawns).toHaveLength(1);
    const spawn = spawner.spawns[0]!;
    expect(JSON.stringify(spawn.args)).not.toContain(sentinel);
    expect(JSON.stringify(spawn.env)).not.toContain(sentinel);
    // The request carries the script and nothing about the connection.
    const request = spawn.sent[0] as Record<string, unknown>;
    expect(Object.keys(request).sort((a, b) => a.localeCompare(b))).toEqual([
      'dbName',
      'ejsonRelaxed',
      'source',
      'type',
    ]);
    const everything = JSON.stringify(spawn.sent);
    expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain('mongodb://');
    expect(everything).not.toContain('nobody');
    // The ping reply did come back over the bridge, so this covered a reply too.
    expect(spawn.sent.some((m) => (m as { type?: string }).type === 'rpc-result')).toBe(true);
  });
});

describe('ScriptService — cancel', () => {
  it('cancel(token) stops an in-flight script', async () => {
    const s = setup();
    const token = 'tok-inflight';
    const promise = s.run({
      connectionId: 'c1',
      source: 'await db.cancel_marker.insertOne({ t: 1 }); await new Promise(() => {})',
      cancelToken: token,
      maxTimeMs: 30_000,
    });
    const settled = promise.then(
      () => 'resolved',
      (e: AppError) => e,
    );
    await markerSeen('cancel_marker');
    s.cancel(token);
    expect(await settled).toMatchObject({ code: 'TIMEOUT', message: 'script cancelled' });
  });

  it('cancel(token) aborts a script even while the pool connect is hung', async () => {
    // The token is registered before awaiting the pool; otherwise a hung
    // connect would leave the run uncancelable.
    let rejectConnect: (e: Error) => void = () => {};
    tmp = undefined;
    spawner = createTestSpawner();
    svc = new ScriptService({
      pool: fakePool(
        () =>
          new Promise((_, reject) => {
            rejectConnect = reject;
          }),
      ),
      spawner,
    });
    const token = 'tok-hang';
    const promise = svc.run({ connectionId: 'c1', source: '1 + 1', cancelToken: token });
    setTimeout(() => {
      svc!.cancel(token);
      rejectConnect(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, 20);
    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT', message: 'script cancelled' });
    expect(spawner.spawns).toHaveLength(0);
  });

  it('a cancel that lands before the connect finishes never spawns a runner', async () => {
    const s = setup();
    const token = 'tok-early';
    const promise = s.run({ connectionId: 'c1', source: '1', cancelToken: token });
    s.cancel(token);
    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT', message: 'script cancelled' });
    expect(spawner.spawns).toHaveLength(0);
  });

  it('cancel() stops an in-progress encode of a large result', async () => {
    const s = setup();
    const token = 'tok-encode-cancel';
    const t0 = Date.now();
    const promise = s.run({
      connectionId: 'c1',
      source: 'Array.from({ length: 600000 }, (_, i) => ({ n: i, s: "x" }))',
      cancelToken: token,
      maxTimeMs: 20_000,
    });
    // Wait for the runner to have its request, then cancel mid-build/encode.
    await until(async () => spawner.spawns.length > 0, 'spawn');
    setTimeout(() => s.cancel(token), 100);
    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT', message: 'script cancelled' });
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);

  it('rejects run() with a cancelToken that is already in flight, instead of orphaning the earlier run', async () => {
    const s = setup();
    const token = 'dup-token';
    const runA = s.run({ connectionId: 'c1', source: 'await new Promise(() => {})', cancelToken: token, maxTimeMs: 30_000 });
    const settledA = runA.then(() => 'resolved', (e: AppError) => e);
    await new Promise((r) => setImmediate(r));

    await expect(
      s.run({ connectionId: 'c1', source: '1 + 1', cancelToken: token }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The token was never orphaned: cancel() still reaches run A.
    s.cancel(token);
    expect(await settledA).toMatchObject({ code: 'TIMEOUT' });
  });

  it('frees a cancelToken for reuse once the run holding it finishes', async () => {
    const s = setup();
    const token = 'reuse-token';
    await s.run({ connectionId: 'c1', source: '1 + 1', cancelToken: token });
    const r = await s.run({ connectionId: 'c1', source: '2 + 2', cancelToken: token });
    expect(r.valueJson).toBe('4');
  });

  it('two different cancelTokens cancel independently', async () => {
    const s = setup();
    const pA = s.run({ connectionId: 'c1', source: 'await new Promise(() => {})', cancelToken: 'tok-indep-a', maxTimeMs: 30_000 });
    const pB = s.run({ connectionId: 'c1', source: '"b done"', cancelToken: 'tok-indep-b' });
    const settledA = pA.then(() => 'resolved', (e: AppError) => e);
    await new Promise((r) => setImmediate(r));
    s.cancel('tok-indep-a');
    expect(await settledA).toMatchObject({ code: 'TIMEOUT' });
    // B was never cancelled: it completes normally.
    expect((await pB).valueJson).toBe('"b done"');
  });

  it('rejects a same-token run() fired immediately after cancel(), until the cancelled run finishes', async () => {
    const s = setup();
    const token = 'cancel-then-reuse-token';
    const runA = s.run({ connectionId: 'c1', source: 'await new Promise(() => {})', cancelToken: token, maxTimeMs: 30_000 });
    const settledA = runA.then(() => 'resolved', (e: AppError) => e);
    await new Promise((r) => setImmediate(r));

    s.cancel(token);

    // Run A's own cleanup has not run yet: the token is still legitimately
    // held, so a reuse must be rejected rather than silently destroyed later.
    await expect(
      s.run({ connectionId: 'c1', source: '1 + 1', cancelToken: token }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await settledA).toMatchObject({ code: 'TIMEOUT' });
    const r = await s.run({ connectionId: 'c1', source: '3 + 3', cancelToken: token });
    expect(r.valueJson).toBe('6');
  });
});

describe('ScriptService — real cursor results', () => {
  it('auto-iterates a bare find() into an array of documents', async () => {
    const s = setup();
    await s.run({ connectionId: 'c1', source: 'await db.bare_find.deleteMany({}); await db.bare_find.insertMany([{n:1},{n:2},{n:3}]); 1' });
    const r = await s.run({ connectionId: 'c1', source: 'db.bare_find.find()' });
    const docs = JSON.parse(r.valueJson!);
    expect(Array.isArray(docs)).toBe(true);
    expect(docs).toHaveLength(3);
    expect(r.printBuffer).not.toMatch(/cursor truncated/);
  });

  it('auto-iterates an aggregation cursor', async () => {
    const s = setup();
    await s.run({ connectionId: 'c1', source: 'await db.agg_find.deleteMany({}); await db.agg_find.insertMany([{g:"x"},{g:"x"},{g:"y"}]); 1' });
    const r = await s.run({
      connectionId: 'c1',
      source: 'db.agg_find.aggregate([{ $group: { _id: "$g", c: { $sum: 1 } } }])',
      ejsonRelaxed: true,
    });
    const groups = JSON.parse(r.valueJson!) as Array<{ _id: string; c: number }>;
    expect(groups.slice().sort((a, b) => a._id.localeCompare(b._id))).toEqual([
      { _id: 'x', c: 2 },
      { _id: 'y', c: 1 },
    ]);
  });

  it('caps a large find() at 50 docs and notes the truncation', async () => {
    const s = setup();
    const seed = Array.from({ length: 60 }, (_, i) => `{ n: ${i} }`).join(',');
    await s.run({ connectionId: 'c1', source: `await db.big_find.deleteMany({}); await db.big_find.insertMany([${seed}]); 1` });
    const r = await s.run({ connectionId: 'c1', source: 'db.big_find.find()' });
    expect(JSON.parse(r.valueJson!)).toHaveLength(50);
    expect(r.printBuffer).toMatch(/cursor truncated to first 50 documents/);
  });

  it('explicit .toArray() still returns the full result with no truncation note', async () => {
    const s = setup();
    const seed = Array.from({ length: 60 }, (_, i) => `{ n: ${i} }`).join(',');
    await s.run({ connectionId: 'c1', source: `await db.full_find.deleteMany({}); await db.full_find.insertMany([${seed}]); 1` });
    const r = await s.run({ connectionId: 'c1', source: 'await db.full_find.find().toArray()' });
    expect(JSON.parse(r.valueJson!)).toHaveLength(60);
    expect(r.printBuffer).not.toMatch(/cursor truncated/);
  });
});

// Read-only is enforced in main, on the calls the runner sends over the bridge;
// these pin that the ordinary script surface is refused the same way as before.
// The escape routes are covered in script-rpc.spec.ts.
describe('ScriptService — read-only connection', () => {
  it('reads still work on a read-only connection', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.ro_reads.deleteMany({}); await db.ro_reads.insertMany([{n:1},{n:2}]); 1' });
    const r = await s.run({ connectionId: 'ro', source: 'await db.ro_reads.find().toArray()' });
    expect(JSON.parse(r.valueJson!)).toHaveLength(2);
  });

  it('a write throws ReadOnlyConnectionError and does not mutate data', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.ro_writes.deleteMany({}); await db.ro_writes.insertMany([{n:1}]); 1' });
    await expect(
      s.run({ connectionId: 'ro', source: 'await db.ro_writes.deleteMany({})' }),
    ).rejects.toBeInstanceOf(ReadOnlyConnectionError);
    const r = await s.run({ connectionId: 'rw', source: 'await db.ro_writes.find().toArray()' });
    expect(JSON.parse(r.valueJson!)).toHaveLength(1);
  });

  it('an aggregate with $merge/$out throws ReadOnlyConnectionError', async () => {
    await expect(
      setup().run({ connectionId: 'ro', source: "db.ro_writes.aggregate([{ $merge: { into: 'ro_merge_target' } }])" }),
    ).rejects.toBeInstanceOf(ReadOnlyConnectionError);
  });

  it('db.dropDatabase() throws ReadOnlyConnectionError', async () => {
    await expect(
      setup().run({ connectionId: 'ro', source: 'await db.dropDatabase()' }),
    ).rejects.toBeInstanceOf(ReadOnlyConnectionError);
  });

  it('a sibling database handle is guarded too', async () => {
    await expect(
      setup().run({ connectionId: 'ro', source: "await db.getSiblingDB('script_ro_sibling').x.insertOne({ n: 1 })" }),
    ).rejects.toBeInstanceOf(ReadOnlyConnectionError);
  });

  it('the identical write succeeds on the non-read-only connection (regression)', async () => {
    const r = await setup().run({ connectionId: 'rw', source: 'await db.ro_regress.insertOne({ n: 1 }); 1' });
    expect(r.valueJson).toBe('1');
  });
});

describe('ScriptService — connection changed mid-run', () => {
  /** Real repo, vault, pool and ConnectionService: the flip goes through `update`. */
  function setupWithConnectionService(): { svc: ScriptService; conns: ConnectionService; id: Promise<string> } {
    tmp = createTempDb();
    const repo = new ConnectionRepo(tmp.db);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    const conns = new ConnectionService({ repo, vault, pool });
    spawner = createTestSpawner();
    const scriptSvc = new ScriptService({ pool, spawner });
    svc = scriptSvc;
    const id = conns
      .create({
        name: `flip-${Date.now()}`,
        color: '#1A6835',
        connectionType: 'standard',
        readOnly: false,
        host: hp.host,
        port: hp.port,
        defaultDb: DB,
        authMech: 'none',
        tls: { enabled: false, verify: true },
        advanced: {
          connectTimeoutMs: 5000,
          socketTimeoutMs: 5000,
          serverSelectionTimeoutMs: 5000,
          readPreference: 'primary',
          maxPoolSize: 5,
          directConnection: true,
        },
      })
      .then((c) => c.id);
    return { svc: scriptSvc, conns, id };
  }

  it('stops the running script with a read-only refusal, and later runs are refused writes', async () => {
    const { svc: s, conns, id } = setupWithConnectionService();
    const connectionId = await id;
    const promise = s.run({
      connectionId,
      source: 'await db.flip_target.insertOne({ n: 1 }); await new Promise(() => {})',
      maxTimeMs: 30_000,
    });
    const settled = promise.then(() => 'resolved', (e: AppError) => e);
    await markerSeen('flip_target');

    await conns.update(connectionId, { readOnly: true });

    expect(await settled).toBeInstanceOf(ReadOnlyConnectionError);
    // A run started after the flip gets the new flag from its first call.
    await expect(
      s.run({ connectionId, source: 'await db.flip_target.deleteMany({})' }),
    ).rejects.toBeInstanceOf(ReadOnlyConnectionError);
    expect(await countDocs('flip_target')).toBe(1);
  });

  it('leaves a script on a different connection alone', async () => {
    const { svc: s, conns, id } = setupWithConnectionService();
    const flipId = await id;
    const other = (
      await conns.create({
        name: `other-${Date.now()}`,
        color: '#1A6835',
        connectionType: 'standard',
        readOnly: false,
        host: hp.host,
        port: hp.port,
        defaultDb: DB,
        authMech: 'none',
        tls: { enabled: false, verify: true },
        advanced: {
          connectTimeoutMs: 5000,
          socketTimeoutMs: 5000,
          serverSelectionTimeoutMs: 5000,
          readPreference: 'primary',
          maxPoolSize: 5,
          directConnection: true,
        },
      })
    ).id;
    const running = s.run({
      connectionId: other,
      source: 'await db.flip_other.insertOne({ n: 1 }); "finished"',
      maxTimeMs: 30_000,
    });
    await conns.update(flipId, { readOnly: true });
    expect((await running).valueJson).toBe('"finished"');
  });
  it('stops the running script when the connection is disconnected, instead of letting it keep writing', async () => {
    const { svc: s, id } = setupWithConnectionService();
    const connectionId = await id;
    const promise = s.run({
      connectionId,
      source: 'await db.gone_disconnect.insertOne({ n: 1 }); await new Promise(() => {})',
      maxTimeMs: 30_000,
    });
    const settled = promise.then(() => 'resolved', (e: AppError) => e);
    await markerSeen('gone_disconnect');
    const t0 = Date.now();

    await pool!.disconnect(connectionId);

    expect(await settled).toMatchObject({ code: 'DB_ERROR' });
    expect(Date.now() - t0).toBeLessThan(2000);
    await until(async () => spawner.alive().length === 0, 'runner to die', 3000);
  });

  it('stops the running script when the connection is deleted', async () => {
    const { svc: s, conns, id } = setupWithConnectionService();
    const connectionId = await id;
    const promise = s.run({
      connectionId,
      source: 'await db.gone_delete.insertOne({ n: 1 }); await new Promise(() => {})',
      maxTimeMs: 30_000,
    });
    const settled = promise.then(() => 'resolved', (e: AppError) => e);
    await markerSeen('gone_delete');

    await conns.delete(connectionId);

    expect(await settled).toMatchObject({ code: 'DB_ERROR' });
    await until(async () => spawner.alive().length === 0, 'runner to die', 3000);
  });

  it('a read-only flip is reported as READ_ONLY, not as a disconnect', async () => {
    const { svc: s, conns, id } = setupWithConnectionService();
    const connectionId = await id;
    const promise = s.run({
      connectionId,
      source: 'await db.flip_code.insertOne({ n: 1 }); await new Promise(() => {})',
      maxTimeMs: 30_000,
    });
    const settled = promise.then(() => 'resolved', (e: AppError) => e);
    await markerSeen('flip_code');
    await conns.update(connectionId, { readOnly: true });
    expect(await settled).toMatchObject({ code: 'READ_ONLY' });
  });
});
