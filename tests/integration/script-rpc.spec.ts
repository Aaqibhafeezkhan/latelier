import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { Binary, Long } from 'bson';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ScriptService } from '../../electron/services/ScriptService';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import type { Connection } from '../../shared/types';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { createTestSpawner, type TestSpawner } from '../helpers/runnerSpawner';
import { uriToHostPort, makeConnection, makeReader } from '../helpers/mongo';

/**
 * The script bridge end to end: a real runner process, a real mongod, and a
 * real pool, with the test spawner recording everything main sends the child.
 * Read-only is refused by main on every route a script can take, a script that
 * escapes its sandbox and posts frames by hand gets nowhere, and nothing the
 * child is ever sent carries a credential.
 *
 * The escape payloads live in this file only; they are what a hostile script
 * would try, kept here so the refusal stays tested.
 */

const DB = 'test';

let server: MongoMemoryServer;
let hp: { host: string; port: number };
let tmp: TempDb | undefined;
let pool: MongoPool | undefined;
let spawner: TestSpawner;
let svc: ScriptService | undefined;
let conns: Connection[];
let direct: MongoClient | undefined;

// A dedicated server, not the shared one: the cursor tests count open cursors
// through `serverStatus`, which is server-wide, so another file's cursors on a
// shared mongod would shift the count.
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  hp = uriToHostPort(server.getUri());
}, 60_000);

afterAll(async () => {
  await server.stop();
});

afterEach(async () => {
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
  await direct?.close();
  direct = undefined;
  tmp?.cleanup();
  tmp = undefined;
  expect(leaked, 'runner children still alive after the test').toBe(0);
});

function setup(): ScriptService {
  tmp = createTempDb();
  const vault = new SecretsVault(tmp.db, createSafeStorageMock());
  conns = ['rw', 'ro'].map((id) => makeConnection(id, hp, { defaultDb: DB, readOnly: id === 'ro' }));
  pool = new MongoPool({ repo: makeReader(conns), vault });
  spawner = createTestSpawner();
  svc = new ScriptService({ pool, spawner });
  direct = new MongoClient(server.getUri());
  return svc;
}

async function countDocs(coll: string, filter: Record<string, unknown> = {}): Promise<number> {
  return direct!.db(DB).collection(coll).countDocuments(filter);
}

async function until(cond: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What the script's own try/catch saw: the error name and message, or 'completed'. */
async function outcome(connectionId: string, statements: string): Promise<string> {
  const r = await svc!.run({
    connectionId,
    source: `(async () => { try { ${statements}; return 'completed'; } catch (e) { return e.name + ': ' + e.message; } })()`,
    maxTimeMs: 20_000,
  });
  return JSON.parse(r.valueJson!) as string;
}

/** Every message main posted to the child(ren) so far. */
function sentToChild(): Array<Record<string, unknown>> {
  return spawner.spawns.flatMap((s) => s.sent as Array<Record<string, unknown>>);
}

describe('read-only is refused by main, whichever way the script reaches the write', () => {
  const routes: Array<[string, string]> = [
    ['insertOne on a collection', "await db.rpc_ro.insertOne({ n: 1 })"],
    ['getCollection(...).insertOne', "await db.getCollection('rpc_ro').insertOne({ n: 1 })"],
    ['collection(...).insertOne', "await db.collection('rpc_ro').insertOne({ n: 1 })"],
    ['a cached method reference', "const insert = db.rpc_ro.insertOne; await insert({ n: 1 })"],
    ['a method reference called through call()', "const insert = db.rpc_ro.insertOne; await insert.call(null, { n: 1 })"],
    ['a sibling database', "await db.getSiblingDB('rpc_ro_sibling').x.insertOne({ n: 1 })"],
    ['use() then insert', "use('rpc_ro_used'); await db.x.insertOne({ n: 1 })"],
    ['deleteMany', "await db.rpc_ro.deleteMany({})"],
    ['updateMany', "await db.rpc_ro.updateMany({}, { $set: { n: 2 } })"],
    ['drop', "await db.rpc_ro.drop()"],
    ['createIndex', "await db.rpc_ro.createIndex({ n: 1 })"],
    ['db.admin().command', "await db.admin().command({ setParameter: 1, logLevel: 0 })"],
    ['db.admin().listDatabases', "await db.admin().listDatabases()"],
    ['a cached db.admin()', "const a = db.admin(); await a.ping()"],
    ['runCommand with insert', "await db.runCommand({ insert: 'rpc_ro', documents: [{ n: 1 }] })"],
    ['runCommand with drop', "await db.runCommand({ drop: 'rpc_ro' })"],
    ['a cached runCommand', "const rc = db.runCommand; await rc({ insert: 'rpc_ro', documents: [{ n: 1 }] })"],
    ['dropDatabase', "await db.dropDatabase()"],
    ['createCollection', "await db.createCollection('rpc_ro_made')"],
    ['aggregate with $out', "await db.rpc_ro.aggregate([{ $out: 'rpc_ro_out' }]).toArray()"],
    ['aggregate with $merge', "await db.rpc_ro.aggregate([{ $match: {} }, { $merge: { into: 'rpc_ro_out' } }]).toArray()"],
    ['aggregate with $out, never iterated by the script', "db.rpc_ro.aggregate([{ $out: 'rpc_ro_out' }]); 1"],
  ];

  it.each(routes)('%s', async (_name, statements) => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_ro.deleteMany({}); await db.rpc_ro.insertOne({ seed: 1 }); 1' });
    const result = await outcome('ro', statements);
    // Either main refused it, or the script never got to run it: nothing was written.
    expect(result).toMatch(/read-only|completed/);
    expect(await countDocs('rpc_ro')).toBe(1);
    expect(await countDocs('rpc_ro', { seed: 1 })).toBe(1);
    for (const gone of ['rpc_ro_out', 'rpc_ro_made']) {
      const names = (await direct!.db(DB).listCollections({ name: gone }).toArray()).map((c) => c.name);
      expect(names).toEqual([]);
    }
  });

  it('an aggregate with a write stage returned as the script result is refused when it is auto-iterated', async () => {
    const s = setup();
    await expect(
      s.run({ connectionId: 'ro', source: "db.rpc_ro.aggregate([{ $merge: { into: 'rpc_ro_out' } }])" }),
    ).rejects.toMatchObject({ name: 'ReadOnlyConnectionError', code: 'READ_ONLY' });
    const names = (await direct!.db(DB).listCollections({ name: 'rpc_ro_out' }).toArray()).map((c) => c.name);
    expect(names).toEqual([]);
  });

  it('every route that runs a call is answered by main with a read-only error', async () => {
    setup();
    const refused = [
      "await db.rpc_ro.insertOne({ n: 1 })",
      "await db.admin().listDatabases()",
      "await db.runCommand({ insert: 'rpc_ro', documents: [{ n: 1 }] })",
      "await db.rpc_ro.aggregate([{ $out: 'rpc_ro_out' }]).toArray()",
    ];
    for (const statements of refused) {
      expect(await outcome('ro', statements)).toMatch(/^ReadOnlyConnectionError: .*read-only/);
    }
    const errors = sentToChild().filter((m) => m.type === 'rpc-error') as Array<{ error: { name: string } }>;
    expect(errors).toHaveLength(refused.length);
    expect(errors.every((e) => e.error.name === 'ReadOnlyConnectionError')).toBe(true);
  });

  it('the driver internals a cursor or collection keeps are not reachable at all', async () => {
    setup();
    const probe = `
      const c = db.rpc_ro.find();
      const coll = db.rpc_ro;
      JSON.stringify({
        cursorClient: typeof c.cursorClient,
        cursorClientDesc: typeof Object.getOwnPropertyDescriptor(c, 'cursorClient'),
        cursorS: typeof c.s,
        collS: typeof coll.s,
        collSDesc: typeof Object.getOwnPropertyDescriptor(coll, 's'),
        collClient: typeof coll.client,
        dbS: typeof db.s,
        ownKeys: Object.getOwnPropertyNames(coll).length,
        out: typeof c.out,
      })`;
    const r = await svc!.run({ connectionId: 'ro', source: probe });
    const seen = JSON.parse(JSON.parse(r.valueJson!) as string) as Record<string, unknown>;
    expect(seen).toMatchObject({
      cursorClient: 'undefined',
      cursorClientDesc: 'undefined',
      cursorS: 'undefined',
      collS: 'undefined',
      collSDesc: 'undefined',
      collClient: 'undefined',
      dbS: 'object', // `db.s` reads as a collection named s, like any other name
      ownKeys: 0,
      out: 'undefined',
    });
  });

  it('a write reached through what a cursor appears to hold fails on the script side, having written nothing', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_ro_cur.deleteMany({}); 1' });
    const result = await outcome(
      'ro',
      "await db.rpc_ro_cur.find().cursorClient.db('test').collection('rpc_ro_cur').insertOne({ n: 1 })",
    );
    expect(result).toMatch(/^TypeError/);
    expect(await countDocs('rpc_ro_cur')).toBe(0);
  });

  it('the same write is fine on the writable connection', async () => {
    setup();
    expect(await outcome('rw', "await db.rpc_ro_ok.insertOne({ n: 1 })")).toBe('completed');
    expect(await countDocs('rpc_ro_ok')).toBeGreaterThan(0);
  });
});

describe('a connection flipped to read-only mid-run', () => {
  it('has its next write refused by main, with no kill', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_flip.deleteMany({}); await db.rpc_flip_go.deleteMany({}); 1' });
    const running = s.run({
      connectionId: 'rw',
      source: `
        await db.rpc_flip.insertOne({ i: 1 });
        while (!(await db.rpc_flip_go.findOne({}))) { }
        (async () => { try { await db.rpc_flip.insertOne({ i: 2 }); return 'wrote'; } catch (e) { return e.name + ': ' + e.message; } })()`,
      maxTimeMs: 20_000,
    });
    const settled = running.then(
      (r) => r,
      (e: unknown) => e,
    );
    await until(async () => (await countDocs('rpc_flip')) === 1, 'the first write');

    // Flip the stored flag without emitting anything: the pool never hears of it,
    // so nothing kills the run. The only thing that can stop the write is main
    // reading the flag again when the call arrives.
    conns.find((c) => c.id === 'rw')!.readOnly = true;
    await direct!.db(DB).collection('rpc_flip_go').insertOne({ go: 1 });

    const result = await settled;
    expect(result).toHaveProperty('valueJson');
    expect(JSON.parse((result as { valueJson: string }).valueJson) as string).toMatch(
      /^ReadOnlyConnectionError: .*read-only/,
    );
    expect(await countDocs('rpc_flip')).toBe(1);
  });
});

describe('a script that escapes its sandbox and posts frames by hand', () => {
  /**
   * Source for a script that reaches the real `process`, opens its own line to
   * main, posts each frame, and returns every reply it got. Works over either
   * channel the runner can be started on.
   */
  function crafted(frames: Array<Record<string, unknown>>): string {
    return `
      const proc = this.constructor.constructor('return process')();
      const post = (m) => (proc.parentPort ? proc.parentPort.postMessage(m) : proc.send(m));
      const waiting = new Map();
      const onReply = (m) => { const w = waiting.get(m && m.id); if (w) { waiting.delete(m.id); w(m); } };
      if (proc.parentPort) proc.parentPort.on('message', (e) => onReply(e.data));
      else proc.on('message', onReply);
      const ask = (frame) => new Promise((resolve) => { waiting.set(frame.id, resolve); post(frame); });
      const out = [];
      for (const frame of ${JSON.stringify(frames)}) out.push(await ask(frame));
      JSON.stringify(out)`;
  }
  const frame = (over: Record<string, unknown>, i: number): Record<string, unknown> => ({
    type: 'rpc',
    id: 900_000 + i,
    target: 'collection',
    dbName: DB,
    coll: 'rpc_crafted',
    method: 'insertOne',
    argsEjson: '[{"crafted":1}]',
    ...over,
  });

  it('gets an rpc-error for each crafted frame and keeps the run alive', async () => {
    const s = setup();
    const frames = [
      frame({ method: 'dropEverything' }, 1),
      frame({ method: '__proto__' }, 2),
      frame({ method: 'constructor' }, 3),
      frame({ target: 'cursor', method: 'toArray', cursorId: 'made-up' }, 4),
      frame({ method: 'find', argsEjson: 'this is not ejson' }, 5),
      frame({ target: 'db', method: 'admin' }, 6),
      frame({ target: 'client', method: 'db' }, 7),
      frame({ method: 's' }, 8),
      frame({ dbName: '' }, 9),
      frame({ coll: 7 }, 10),
    ];
    const r = await s.run({ connectionId: 'rw', source: crafted(frames), maxTimeMs: 20_000 });
    const replies = JSON.parse(JSON.parse(r.valueJson!) as string) as Array<{
      type: string;
      id: number;
      error?: { code: string; message: string };
      valueEjson?: string;
    }>;
    expect(replies).toHaveLength(frames.length);
    for (const reply of replies) {
      expect(reply.type).toBe('rpc-error');
      expect(reply.error?.code).toBe('VALIDATION');
    }
    expect(replies.map((x) => x.id)).toEqual(frames.map((f) => f.id));
    expect(await countDocs('rpc_crafted')).toBe(0);
  });

  it('cannot use a real cursor handle for anything but the allowed cursor methods', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_crafted_cur.deleteMany({}); await db.rpc_crafted_cur.insertOne({ a: 1 }); 1' });
    const source = `
      const proc = this.constructor.constructor('return process')();
      const post = (m) => (proc.parentPort ? proc.parentPort.postMessage(m) : proc.send(m));
      const waiting = new Map();
      const onReply = (m) => { const w = waiting.get(m && m.id); if (w) { waiting.delete(m.id); w(m); } };
      if (proc.parentPort) proc.parentPort.on('message', (e) => onReply(e.data));
      else proc.on('message', onReply);
      const ask = (frame) => new Promise((resolve) => { waiting.set(frame.id, resolve); post(frame); });
      const base = { type: 'rpc', dbName: 'test' };
      const opened = await ask({ ...base, id: 910001, target: 'collection', coll: 'rpc_crafted_cur', method: 'find', argsEjson: '[]' });
      const cursorId = opened.cursorId;
      const tries = [];
      for (const [i, method] of ['cursorClient', 'out', 'merge', 'constructor', '__proto__', 's'].entries()) {
        tries.push(await ask({ ...base, id: 910010 + i, target: 'cursor', cursorId, method, argsEjson: '[]' }));
      }
      const fine = await ask({ ...base, id: 910030, target: 'cursor', cursorId, method: 'toArray', argsEjson: '[]' });
      JSON.stringify({ opened: typeof cursorId, tries: tries.map((t) => t.type), fine: fine.type })`;
    const r = await s.run({ connectionId: 'rw', source, maxTimeMs: 20_000 });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual({
      opened: 'string',
      tries: Array.from({ length: 6 }, () => 'rpc-error'),
      fine: 'rpc-result',
    });
  });

  it('cannot write through a crafted frame on a read-only connection', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_crafted_ro.deleteMany({}); 1' });
    const frames = [
      frame({ coll: 'rpc_crafted_ro' }, 1),
      frame({ coll: 'rpc_crafted_ro', method: 'insertMany', argsEjson: '[[{"a":1}]]' }, 2),
      frame({ target: 'db', method: 'runCommand', argsEjson: '[{"insert":"rpc_crafted_ro","documents":[{"a":1}]}]' }, 3),
      frame({ target: 'admin', method: 'command', argsEjson: '[{"ping":1}]' }, 4),
      frame({ coll: 'rpc_crafted_ro', method: 'aggregate', argsEjson: '[[{"$out":"rpc_crafted_out"}]]' }, 5),
    ];
    const r = await s.run({ connectionId: 'ro', source: crafted(frames), maxTimeMs: 20_000 });
    const replies = JSON.parse(JSON.parse(r.valueJson!) as string) as Array<{ type: string; error?: { name: string } }>;
    expect(replies.map((x) => x.error?.name)).toEqual(Array.from({ length: 5 }, () => 'ReadOnlyConnectionError'));
    expect(await countDocs('rpc_crafted_ro')).toBe(0);
  });

  it('answers the excess of 200 frames posted at once with errors, and the run still completes', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_flood.deleteMany({}); await db.rpc_flood.insertOne({ n: 1 }); 1' });
    const count = 200;
    const source = `
      const proc = this.constructor.constructor('return process')();
      const post = (m) => (proc.parentPort ? proc.parentPort.postMessage(m) : proc.send(m));
      let left = ${count};
      const replies = [];
      await new Promise((resolve) => {
        const onReply = (m) => { replies.push(m); if (--left === 0) resolve(); };
        if (proc.parentPort) proc.parentPort.on('message', (e) => onReply(e.data));
        else proc.on('message', onReply);
        for (let i = 0; i < ${count}; i++) {
          post({ type: 'rpc', id: 800000 + i, target: 'collection', dbName: ${JSON.stringify(DB)}, coll: 'rpc_flood',
            method: 'findOne', argsEjson: '[{"$where":"sleep(100) || true"}]' });
        }
      });
      JSON.stringify(replies.map((m) => (m.type === 'rpc-error' ? m.error.message : 'ok')))`;
    const r = await s.run({ connectionId: 'rw', source, maxTimeMs: 60_000 });
    const outcomes = JSON.parse(JSON.parse(r.valueJson!) as string) as string[];
    expect(outcomes).toHaveLength(count);
    const refused = outcomes.filter((o) => o !== 'ok');
    expect(new Set(refused)).toEqual(new Set(['rpc: too many calls in flight']));
    // Those admitted before the limit was hit were answered normally.
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(64);
    expect(refused).toHaveLength(count - 64);
  }, 90_000);

  it('a frame that is not even answerable ends the run as an internal error', async () => {
    const s = setup();
    const source = `
      const proc = this.constructor.constructor('return process')();
      (proc.parentPort ? proc.parentPort.postMessage.bind(proc.parentPort) : proc.send.bind(proc))({ type: 'rpc', method: 'find' });
      await new Promise(() => {})`;
    await expect(s.run({ connectionId: 'rw', source, maxTimeMs: 20_000 })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'script runner sent a malformed message',
    });
  });

  it('holds no credentials to find: the environment, argv and every message are clean', async () => {
    const s = setup();
    const source = `
      const proc = this.constructor.constructor('return process')();
      JSON.stringify({ env: proc.env, argv: proc.argv, execArgv: proc.execArgv })`;
    const r = await s.run({ connectionId: 'rw', source });
    const seen = JSON.parse(JSON.parse(r.valueJson!) as string) as { env: Record<string, string> };
    expect(Object.keys(seen.env).sort((a, b) => a.localeCompare(b))).not.toContain('MONGODB_URI');
    expect(JSON.stringify(seen)).not.toContain('mongodb://');
  });
});

describe('no credential is ever sent to the child', () => {
  it('not in any message, across a script that uses every kind of call', async () => {
    tmp = createTempDb();
    const sentinel = 'pw-SENTINEL-7c21';
    const now = new Date().toISOString();
    tmp.db
      .prepare(
        `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
         VALUES ('authed', 'authed', 'standard', 'localhost', 27017, 'scram256', ?, ?)`,
      )
      .run(now, now);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    vault.set('authed', 'password', sentinel);
    conns = [makeConnection('authed', hp, { defaultDb: DB, authMech: 'scram256', authUsername: 'sentinel-user' })];
    pool = new MongoPool({ repo: makeReader(conns), vault });
    direct = new MongoClient(server.getUri());
    // The pool's own connect would fail authentication against this unauthenticated
    // server, so hand it an unauthenticated client: what is under test is what
    // main sends the child, not how the pool connects.
    vi.spyOn(pool, 'readClient').mockResolvedValue(direct);
    spawner = createTestSpawner();
    svc = new ScriptService({ pool, spawner });

    const r = await svc.run({
      connectionId: 'authed',
      source: `
        await db.cred_docs.deleteMany({});
        await db.cred_docs.insertMany([{ a: 1 }, { a: 2 }]);
        const docs = await db.cred_docs.find().sort({ a: 1 }).toArray();
        const one = await db.cred_docs.findOne({ a: 1 });
        await db.runCommand({ ping: 1 });
        const dbs = await db.admin().listDatabases();
        const colls = await db.listCollections().toArray();
        const explain = await db.cred_docs.find({ a: 1 }).explain();
        docs.length + colls.length`,
      maxTimeMs: 20_000,
    });
    expect(Number(r.valueJson)).toBeGreaterThan(1);

    const messages = spawner.spawns.flatMap((s) => s.sent);
    expect(messages.length).toBeGreaterThan(5);
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain('sentinel-user');
    expect(everything).not.toContain('mongodb://');
    expect(everything).not.toContain('mongodb+srv://');
    expect(everything).not.toContain(String(hp.port) + '/');
    const spawn = spawner.spawns[0]!;
    expect(JSON.stringify(spawn.args) + JSON.stringify(spawn.env)).not.toContain(sentinel);
    // Only the run request and RPC replies go to the child, and the request names no connection.
    const kinds = new Set(messages.map((m) => (m as { type: string }).type));
    expect([...kinds].sort((a, b) => a.localeCompare(b))).toEqual(['rpc-result', 'run']);
    await direct.close();
    direct = undefined;
  });

  it('not in an error a script provokes: a failed connection-level call reports no URI or password', async () => {
    setup();
    const sentinel = 'pw-SENTINEL-errs';
    const result = await outcome('rw', "await db.runCommand({ definitelyNotACommand: 1 })");
    expect(result).not.toContain(sentinel);
    expect(result).not.toContain('mongodb://');
    const errors = sentToChild().filter((m) => m.type === 'rpc-error');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain('mongodb://');
    expect('stack' in (errors[0] as { error: object }).error).toBe(false);
  });
});

describe('what the script sees of the database is what the driver returns', () => {
  it('numbers come back as numbers, not wrapped', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_num.deleteMany({}); await db.rpc_num.insertOne({ _id: 1, n: 1, f: 1.5, big: NumberLong("9007199254740993") }); 1' });
    const r = await s.run({
      connectionId: 'rw',
      source: `const d = await db.rpc_num.findOne({ _id: 1 });
        JSON.stringify([typeof d.n, d.n === 1, typeof d.f, d.f === 1.5, d.big.constructor.name, String(d.big), typeof d._id, d._id === 1])`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual(['number', true, 'number', true, 'Long', '9007199254740993', 'number', true]);
  });

  it('an integer past int32 range is still stored and read as a double, as a JS number always was', async () => {
    const s = setup();
    await direct!.db(DB).collection('rpc_wide').deleteMany({});
    // Written by the script: a JS number, so a double.
    await s.run({
      connectionId: 'rw',
      source: 'await db.rpc_wide.insertOne({ _id: "w", t: Date.UTC(2024, 4, 6), neg: -3000000000, small: 7, big: NumberLong("9007199254740993") }); 1',
    });
    const types = await direct!
      .db(DB)
      .collection('rpc_wide')
      .aggregate([{ $project: { t: { $type: '$t' }, neg: { $type: '$neg' }, small: { $type: '$small' }, big: { $type: '$big' } } }])
      .toArray();
    expect(types[0]).toMatchObject({ t: 'double', neg: 'double', small: 'int', big: 'long' });
    // Read by the script: a double stored by someone else comes back a number, not a Long.
    await direct!
      .db(DB)
      .collection<{ _id: string; t: number; l: Long }>('rpc_wide')
      .insertOne({ _id: 'direct', t: 1714000000000, l: Long.fromNumber(1714000000000) });
    const r = await s.run({
      connectionId: 'rw',
      source: `const d = await db.rpc_wide.findOne({ _id: 'direct' }); const w = await db.rpc_wide.findOne({ _id: 'w' });
        JSON.stringify([typeof d.t, d.t === 1714000000000, typeof d.l, typeof w.t, w.t === Date.UTC(2024, 4, 6), w.big.constructor.name])`,
    });
    // A stored int64 inside the safe range is promoted to a number by the driver, so it is one here too.
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual(['number', true, 'number', 'number', true, 'Long']);
  });

  it('a Double the script asked for is still a double in the collection', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_dbl.deleteMany({}); await db.rpc_dbl.insertOne({ _id: 1, d: new Double(5), i: 5, l: NumberLong(5), n: NumberInt(5) }); 1' });
    const types = await direct!
      .db(DB)
      .collection('rpc_dbl')
      .aggregate([{ $project: { d: { $type: '$d' }, i: { $type: '$i' }, l: { $type: '$l' }, n: { $type: '$n' } } }])
      .toArray();
    expect(types[0]).toMatchObject({ d: 'double', i: 'int', l: 'long', n: 'int' });
  });

  it('ObjectId, Date, Decimal128, Binary and RegExp survive a round trip as the same types', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `
        await db.rpc_types.deleteMany({});
        const oid = new ObjectId();
        const at = new Date('2024-05-06T07:08:09.123Z');
        await db.rpc_types.insertOne({ _id: oid, at, dec: Decimal128.fromString('12.50'), bin: new Binary(new Uint8Array([104, 101, 108, 108, 111])), re: /^a+b$/i });
        const d = await db.rpc_types.findOne({ _id: oid });
        JSON.stringify({
          oid: d._id instanceof ObjectId && d._id.equals(oid),
          // A Date from outside the script's realm, as the driver's always were: test its tag.
          at: Object.prototype.toString.call(d.at) === '[object Date]' && d.at.getTime() === at.getTime(),
          dec: d.dec instanceof Decimal128 && d.dec.toString(),
          bin: d.bin instanceof Binary && d.bin.toString('utf8'),
          re: String(d.re.pattern) + '/' + d.re.options,
        })`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual({ oid: true, at: true, dec: '12.50', bin: 'hello', re: '^a+b$/i' });
  });

  it('a Uint8Array and a Buffer are written as binary data, at any depth, as the driver would', async () => {
    const s = setup();
    await direct!.db(DB).collection('rpc_bytes').deleteMany({});
    await s.run({
      connectionId: 'rw',
      // The sandbox has no Buffer global; a Binary's own buffer is one.
      source: `await db.rpc_bytes.insertOne({ _id: 'a', bytes: new Uint8Array([1, 2, 3]), nested: { list: [new Binary(new Uint8Array([4, 5])).buffer] } }); 1`,
    });
    const stored = await direct!.db(DB).collection<{ bytes: Binary; nested: { list: Binary[] } }>('rpc_bytes').findOne({ _id: 'a' as never });
    expect(stored!.bytes._bsontype).toBe('Binary');
    expect(stored!.bytes.sub_type).toBe(0);
    expect([...stored!.bytes.buffer]).toEqual([1, 2, 3]);
    expect(stored!.nested.list[0]!._bsontype).toBe('Binary');
    expect([...stored!.nested.list[0]!.buffer]).toEqual([4, 5]);
  });

  it('a regular expression stored in a document comes back through distinct as a RegExp', async () => {
    const s = setup();
    await direct!.db(DB).collection('rpc_re_distinct').deleteMany({});
    await direct!.db(DB).collection('rpc_re_distinct').insertOne({ re: /^a+b$/i });
    const r = await s.run({
      connectionId: 'rw',
      source: `const vals = await db.rpc_re_distinct.distinct('re');
        JSON.stringify(vals.map((v) => [v.constructor.name, String(v.pattern ?? v.source), String(v.options ?? v.flags)]))`,
    });
    const [[type, pattern, flags]] = JSON.parse(JSON.parse(r.valueJson!) as string) as string[][];
    expect([type, pattern, flags]).toEqual(['BSONRegExp', '^a+b$', 'i']);
  });

  it('a filter with $regex and $options is a filter, not a regular expression value', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `await db.rpc_re.deleteMany({}); await db.rpc_re.insertMany([{ name: 'Alpha' }, { name: 'beta' }]);
        (await db.rpc_re.find({ name: { $regex: '^a', $options: 'i' } }).toArray()).length`,
    });
    expect(r.valueJson).toBe('1');
  });

  it('documents are ordinary objects, including one with a __proto__ field', async () => {
    const s = setup();
    await direct!.db(DB).collection('rpc_proto').deleteMany({});
    await direct!.db(DB).collection('rpc_proto').insertOne(JSON.parse('{"_id":1,"__proto__":{"polluted":true},"a":1}') as object);
    const r = await s.run({
      connectionId: 'rw',
      source: `const d = await db.rpc_proto.findOne({ _id: 1 });
        JSON.stringify({ own: Object.keys(d), hasOwn: typeof d.hasOwnProperty, polluted: ({}).polluted === undefined })`,
    });
    const seen = JSON.parse(JSON.parse(r.valueJson!) as string) as { own: string[]; hasOwn: string; polluted: boolean };
    expect(seen.hasOwn).toBe('function');
    expect(seen.polluted).toBe(true);
    expect(seen.own).toContain('a');
  });

  it('a trailing undefined argument and the signal global behave as if they were not there', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `await db.rpc_args.deleteMany({}); await db.rpc_args.insertOne({ _id: 1, a: 1 });
        const a = await db.rpc_args.findOne({ _id: 1 }, undefined);
        const b = await db.rpc_args.findOne({ _id: 1 }, { signal });
        const c = await db.rpc_args.find({ _id: 1 }, { signal }).maxTimeMS(6000).toArray();
        JSON.stringify([a.a, b.a, c.length])`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual([1, 1, 1]);
  });

  it('a collection called like a database method is still a collection', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `await db.getCollection('stats').deleteMany({}); await db.getCollection('stats').insertOne({ k: 1 });
        await db.collection('admin').deleteMany({});
        JSON.stringify([await db.getCollection('stats').countDocuments({}), await db.collection('admin').countDocuments({})])`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual([1, 0]);
  });

  it('awaiting db or a collection does not hang on a thenable', async () => {
    const s = setup();
    const r = await s.run({ connectionId: 'rw', source: 'const a = await db; const b = await db.anything; typeof a + typeof b' });
    expect(JSON.parse(r.valueJson!)).toBe('functionobject');
  });

  it('getSiblingDB and use() address the right database', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `await db.getSiblingDB('rpc_sib').things.deleteMany({}); await db.getSiblingDB('rpc_sib').things.insertOne({ a: 1 });
        const here = await db.getSiblingDB('rpc_sib').things.countDocuments({});
        use('rpc_sib'); const used = await db.things.countDocuments({});
        JSON.stringify([here, used, String(db), db.getName()])`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual([1, 1, 'rpc_sib', 'rpc_sib']);
  });

  it('a collection handle keeps the database it was taken from after use()', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `await db.rpc_keep.deleteMany({}); await db.rpc_keep.insertOne({ a: 1 });
        const held = db.rpc_keep; use('rpc_elsewhere');
        (await held.countDocuments({})) + ':' + held.namespace + ':' + held.collectionName + ':' + held.dbName`,
    });
    expect(JSON.parse(r.valueJson!)).toBe('1:test.rpc_keep:rpc_keep:test');
  });

  it('db-level cursors and acknowledgements', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `await db.dropCollection('rpc_made').catch(() => null);
        const ack = await db.createCollection('rpc_made');
        const names = (await db.listCollections({ name: 'rpc_made' }).toArray()).map((c) => c.name);
        JSON.stringify({ ack, names })`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual({ ack: { ok: 1 }, names: ['rpc_made'] });
  });
});

describe('every call the bridge carries comes back as data', () => {
  it('none of the allowlisted methods is refused as "not plain data" or breaks', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `
        await db.rpc_sweep.deleteMany({});
        await db.dropCollection('rpc_sweep_renamed').catch(() => null);
        const calls = {
          insertOne: () => db.rpc_sweep.insertOne({ _id: 1, a: 1 }),
          insertMany: () => db.rpc_sweep.insertMany([{ _id: 2, a: 2 }, { _id: 3, a: 3 }]),
          bulkWrite: () => db.rpc_sweep.bulkWrite([{ insertOne: { document: { _id: 4, a: 4 } } }, { updateOne: { filter: { _id: 1 }, update: { $set: { a: 10 } } } }, { deleteOne: { filter: { _id: 3 } } }]),
          updateOne: () => db.rpc_sweep.updateOne({ _id: 1 }, { $set: { b: 1 } }),
          updateMany: () => db.rpc_sweep.updateMany({}, { $set: { c: 1 } }),
          replaceOne: () => db.rpc_sweep.replaceOne({ _id: 2 }, { a: 22 }),
          findOneAndUpdate: () => db.rpc_sweep.findOneAndUpdate({ _id: 1 }, { $set: { d: 1 } }),
          findOneAndReplace: () => db.rpc_sweep.findOneAndReplace({ _id: 2 }, { a: 222 }),
          findOneAndDelete: () => db.rpc_sweep.findOneAndDelete({ _id: 4 }),
          deleteOne: () => db.rpc_sweep.deleteOne({ _id: 99 }),
          deleteMany: () => db.rpc_sweep.deleteMany({ _id: 98 }),
          findOne: () => db.rpc_sweep.findOne({ _id: 1 }),
          countDocuments: () => db.rpc_sweep.countDocuments({}),
          count: () => db.rpc_sweep.count({}),
          estimatedDocumentCount: () => db.rpc_sweep.estimatedDocumentCount(),
          distinct: () => db.rpc_sweep.distinct('a'),
          aggregate: () => db.rpc_sweep.aggregate([{ $match: {} }]).toArray(),
          find: () => db.rpc_sweep.find({}).toArray(),
          createIndex: () => db.rpc_sweep.createIndex({ a: 1 }),
          createIndexes: () => db.rpc_sweep.createIndexes([{ key: { b: 1 }, name: 'b_1' }]),
          indexExists: () => db.rpc_sweep.indexExists('a_1'),
          indexInformation: () => db.rpc_sweep.indexInformation(),
          indexes: () => db.rpc_sweep.indexes(),
          listIndexes: () => db.rpc_sweep.listIndexes().toArray(),
          dropIndex: () => db.rpc_sweep.dropIndex('a_1'),
          dropIndexes: () => db.rpc_sweep.dropIndexes(),
          options: () => db.rpc_sweep.options(),
          isCapped: () => db.rpc_sweep.isCapped(),
          rename: () => db.rpc_sweep.rename('rpc_sweep_renamed'),
          drop: () => db.rpc_sweep_renamed.drop(),
          listSearchIndexes: () => db.rpc_sweep.listSearchIndexes().toArray(),
          createSearchIndex: () => db.rpc_sweep.createSearchIndex({ name: 'x', definition: { mappings: { dynamic: true } } }),
          dropSearchIndex: () => db.rpc_sweep.dropSearchIndex('x'),
          updateSearchIndex: () => db.rpc_sweep.updateSearchIndex('x', { mappings: { dynamic: true } }),
          'db.runCommand': () => db.runCommand({ ping: 1 }),
          'db.command': () => db.command({ ping: 1 }),
          'db.listCollections': () => db.listCollections().toArray(),
          'db.runCursorCommand': () => db.runCursorCommand({ find: 'rpc_sweep' }).toArray(),
          'db.createCollection': () => db.createCollection('rpc_sweep_made'),
          'db.createIndex': () => db.createIndex('rpc_sweep_made', { z: 1 }),
          'db.indexInformation': () => db.indexInformation('rpc_sweep_made'),
          'db.renameCollection': () => db.renameCollection('rpc_sweep_made', 'rpc_sweep_made2'),
          'db.dropCollection': () => db.dropCollection('rpc_sweep_made2'),
          'db.stats': () => db.stats(),
          'db.profilingLevel': () => db.profilingLevel(),
          'db.setProfilingLevel': () => db.setProfilingLevel('off'),
          'admin.command': () => db.admin().command({ ping: 1 }),
          'admin.buildInfo': () => db.admin().buildInfo(),
          'admin.serverInfo': () => db.admin().serverInfo(),
          'admin.serverStatus': () => db.admin().serverStatus(),
          'admin.ping': () => db.admin().ping(),
          'admin.validateCollection': () => db.admin().validateCollection('rpc_sweep'),
          'admin.listDatabases': () => db.admin().listDatabases(),
          'admin.replSetGetStatus': () => db.admin().replSetGetStatus(),
          'cursor.count': () => db.rpc_sweep.find({}).count(),
          'cursor.explain': () => db.rpc_sweep.find({}).explain(),
          'cursor.tryNext': () => db.rpc_sweep.find({}).tryNext(),
        };
        const out = {};
        for (const [name, call] of Object.entries(calls)) {
          try { await call(); out[name] = 'ok'; } catch (e) { out[name] = String(e.message); }
        }
        JSON.stringify(out)`,
      maxTimeMs: 60_000,
    });
    const out = JSON.parse(JSON.parse(r.valueJson!) as string) as Record<string, string>;
    const plainDataRefusals = Object.entries(out).filter(([, v]) => /not plain data|not available|is not callable/.test(v));
    expect(plainDataRefusals).toEqual([]);
    // The calls that exist on a standalone mongod worked; the Atlas-only and replica-set-only ones failed on the server, not in the bridge.
    const worked = Object.entries(out).filter(([, v]) => v === 'ok').map(([k]) => k);
    expect(worked).toEqual(
      expect.arrayContaining([
        'insertOne', 'insertMany', 'bulkWrite', 'updateOne', 'findOneAndUpdate', 'find', 'aggregate', 'createIndex',
        'rename', 'drop', 'db.runCommand', 'db.listCollections', 'db.runCursorCommand', 'db.createCollection',
        'db.renameCollection', 'db.dropCollection', 'admin.ping', 'admin.listDatabases', 'cursor.count', 'cursor.explain',
      ]),
    );
  }, 90_000);

  it('bulkWrite reports its counts and the writes landed', async () => {
    const s = setup();
    const r = await s.run({
      connectionId: 'rw',
      source: `await db.rpc_bulk.deleteMany({});
        const res = await db.rpc_bulk.bulkWrite([{ insertOne: { document: { _id: 1 } } }, { insertOne: { document: { _id: 2 } } }, { deleteOne: { filter: { _id: 2 } } }]);
        JSON.stringify([res.insertedCount, res.deletedCount, res.matchedCount, Object.keys(res.insertedIds).length, res.ok])`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual([2, 1, 0, 2, 1]);
    expect(await countDocs('rpc_bulk')).toBe(1);
  });
});

describe('cursors', () => {
  async function seed(s: ScriptService, coll: string, n: number): Promise<void> {
    await s.run({
      connectionId: 'rw',
      source: `await db.${coll}.deleteMany({}); await db.${coll}.insertMany(Array.from({ length: ${n} }, (_, i) => ({ _id: i, n: i }))); 1`,
    });
  }

  it('shaping, forEach, map, hasNext, next and for await all work', async () => {
    const s = setup();
    await seed(s, 'rpc_cur', 10);
    const r = await s.run({
      connectionId: 'rw',
      source: `
        const shaped = await db.rpc_cur.find({}).sort({ n: -1 }).skip(1).limit(3).project({ _id: 0 }).toArray();
        const seen = []; await db.rpc_cur.find().sort({ n: 1 }).forEach((d) => { seen.push(d.n); });
        const early = []; await db.rpc_cur.find().sort({ n: 1 }).forEach((d) => { early.push(d.n); return d.n < 2; });
        const mapped = await db.rpc_cur.find().sort({ n: 1 }).limit(3).map((d) => d.n * 10).toArray();
        const c = db.rpc_cur.find().sort({ n: 1 }); const has = await c.hasNext(); const first = await c.next(); await c.close();
        const iter = []; for await (const d of db.rpc_cur.find().sort({ n: 1 }).limit(2)) iter.push(d.n);
        JSON.stringify({ shaped: shaped.map((d) => d.n), seen: seen.length, early, mapped, has, first: first.n, iter })`,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual({
      shaped: [8, 7, 6],
      seen: 10,
      early: [0, 1, 2],
      mapped: [0, 10, 20],
      has: true,
      first: 0,
      iter: [0, 1],
    });
  });

  it('explain works on a find cursor', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_ex', 3);
    const r = await s.run({ connectionId: 'rw', source: 'const e = await db.rpc_cur_ex.find({ n: 1 }).explain(); typeof e.queryPlanner' });
    expect(JSON.parse(r.valueJson!)).toBe('object');
  });

  it('refuses to reshape a cursor that has started', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_late', 3);
    const result = await outcome('rw', "const c = db.rpc_cur_late.find(); await c.next(); c.limit(1)");
    expect(result).toMatch(/^ValidationError: cursor\.limit\(\): the cursor has already started/);
  });

  it('a method the bridge does not carry is simply not there', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_gone', 3);
    expect(await outcome('rw', "db.rpc_cur_gone.find().out('x')")).toMatch(/^TypeError/);
    expect(await outcome('rw', "db.rpc_cur_gone.watch()")).toMatch(/^TypeError/);
  });

  it('a bare find() still auto-iterates, and an aggregation too', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_auto', 60);
    const r = await s.run({ connectionId: 'rw', source: 'db.rpc_cur_auto.find()' });
    expect(JSON.parse(r.valueJson!)).toHaveLength(50);
    expect(r.printBuffer).toMatch(/cursor truncated to first 50 documents/);
  });

  it('a script that ends with a cursor half read leaves no cursor open on the server', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_open', 50);
    const open = async (): Promise<number> => {
      const status = await direct!.db('admin').command({ serverStatus: 1 });
      return (status.metrics as { cursor: { open: { total: number } } }).cursor.open.total;
    };
    const before = await open();
    await s.run({
      connectionId: 'rw',
      source: 'globalThis.keep = db.rpc_cur_open.find().batchSize(2); await keep.next(); 1',
    });
    await until(async () => (await open()) <= before, 'the cursor to be closed');
    expect(await open()).toBeLessThanOrEqual(before);
  });

  it('a regular cursor read to the end with tryNext gives its slot back, so a live tailable cursor is never evicted', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_try', 3);
    await direct!.db(DB).collection('rpc_tail_slot').drop().catch(() => undefined);
    const r = await s.run({
      connectionId: 'rw',
      source: `(async () => {
        await db.createCollection('rpc_tail_slot', { capped: true, size: 65536 });
        await db.rpc_tail_slot.insertOne({ n: 1 });
        const tail = db.rpc_tail_slot.find({}, { tailable: true });
        await tail.tryNext();
        // 300 cursors read to the end and never closed: past the cap if the handles were kept,
        // and the oldest handle (the tailable one) would be the one evicted.
        let complete = true;
        let last;
        for (let i = 0; i < 300; i++) {
          const c = db.rpc_cur_try.find().batchSize(1);
          let n = 0;
          while ((await c.tryNext()) !== null) n++;
          if (n !== 3) complete = false;
          last = c;
        }
        await last.close();
        await db.rpc_tail_slot.insertOne({ n: 2 });
        const next = await tail.tryNext();
        await tail.close();
        return JSON.stringify({ complete, next: next.n });
      })()`,
      maxTimeMs: 30_000,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual({ complete: true, next: 2 });
  });

  it('a tailable cursor survives an empty tryNext, yields the next insert, and still closes', async () => {
    const s = setup();
    await direct!.db(DB).collection('rpc_tail').drop().catch(() => undefined);
    const r = await s.run({
      connectionId: 'rw',
      source: `(async () => {
        await db.createCollection('rpc_tail', { capped: true, size: 65536 });
        await db.rpc_tail.insertOne({ n: 1 });
        const open = async () => Number((await db.getSiblingDB('admin').runCommand({ serverStatus: 1 })).metrics.cursor.open.total);
        const before = await open();
        const c = db.rpc_tail.find({}, { tailable: true });
        const first = await c.tryNext();
        const empty = await c.tryNext();
        await db.rpc_tail.insertOne({ n: 2 });
        const second = await c.tryNext();
        const held = await open();
        await c.close();
        return JSON.stringify({ first: first.n, empty, second: second.n, held: held - before, left: (await open()) - before });
      })()`,
      maxTimeMs: 20_000,
    });
    expect(JSON.parse(JSON.parse(r.valueJson!) as string)).toEqual({ first: 1, empty: null, second: 2, held: 1, left: 0 });
  });

  it('a run that is killed leaves no cursor open either', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_kill', 50);
    const open = async (): Promise<number> => {
      const status = await direct!.db('admin').command({ serverStatus: 1 });
      return (status.metrics as { cursor: { open: { total: number } } }).cursor.open.total;
    };
    const before = await open();
    await expect(
      s.run({
        connectionId: 'rw',
        source: 'const c = db.rpc_cur_kill.find().batchSize(2); await c.next(); await new Promise(() => {})',
        maxTimeMs: 600,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await until(async () => (await open()) <= before, 'the cursor to be closed after the kill');
    expect(await open()).toBeLessThanOrEqual(before);
  });

  it('a script that opens more cursors than the cap has its oldest ones closed, not refused', async () => {
    const s = setup();
    await seed(s, 'rpc_cur_cap', 5);
    const open = async (): Promise<number> => {
      const status = await direct!.db('admin').command({ serverStatus: 1 });
      return (status.metrics as { cursor: { open: { total: number } } }).cursor.open.total;
    };
    const before = await open();
    // batchSize(1) over 5 documents keeps every cursor open on the server
    // after its first read, so the open count would reach 300 without eviction.
    const r = await s.run({
      connectionId: 'rw',
      source: `(async () => {
        for (let i = 0; i < 300; i++) { await db.rpc_cur_cap.find().batchSize(1).hasNext(); }
        const st = await db.getSiblingDB('admin').runCommand({ serverStatus: 1 });
        return Number(st.metrics.cursor.open.total);
      })()`,
      maxTimeMs: 20_000,
    });
    expect(Number(JSON.parse(r.valueJson!))).toBeLessThanOrEqual(before + 256);
    await until(async () => (await open()) <= before, 'the remaining cursors to be closed');
  });
});

describe('a kill stops the work main started for the script', () => {
  it('aborts an operation in flight when the run times out', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_slow.deleteMany({}); await db.rpc_slow.insertOne({ n: 1 }); 1' });
    const slowOps = async (): Promise<number> => {
      const ops = await direct!
        .db('admin')
        .aggregate([{ $currentOp: { allUsers: true } }, { $match: { ns: `${DB}.rpc_slow` } }])
        .toArray();
      return ops.length;
    };
    const running = s.run({
      connectionId: 'rw',
      // Long enough that the server would still be working well after the test is over.
      source: 'await db.rpc_slow.find({ $where: "sleep(20000) || true" }).maxTimeMS(30000).toArray()',
      maxTimeMs: 1500,
    });
    const settled = running.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await until(async () => (await slowOps()) === 1, 'the operation to start on the server');
    expect(await settled).toMatchObject({ code: 'TIMEOUT' });
    await until(async () => (await slowOps()) === 0, 'the abandoned operation to stop', 5_000);
    expect(await slowOps()).toBe(0);
  }, 30_000);
});

describe('a kill aborts an operation that has no cursor', () => {
  it('stops a findOne in flight, which only the run signal can reach', async () => {
    const s = setup();
    await s.run({ connectionId: 'rw', source: 'await db.rpc_slow_one.deleteMany({}); await db.rpc_slow_one.insertOne({ n: 1 }); 1' });
    const slowOps = async (): Promise<number> => {
      const ops = await direct!
        .db('admin')
        .aggregate([{ $currentOp: { allUsers: true } }, { $match: { ns: `${DB}.rpc_slow_one` } }])
        .toArray();
      return ops.length;
    };
    const running = s.run({
      connectionId: 'rw',
      source: 'await db.rpc_slow_one.findOne({ $where: "sleep(20000) || true" }, { maxTimeMS: 30000 })',
      maxTimeMs: 1500,
    });
    const settled = running.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await until(async () => (await slowOps()) === 1, 'the operation to start on the server');
    expect(await settled).toMatchObject({ code: 'TIMEOUT' });
    await until(async () => (await slowOps()) === 0, 'the abandoned operation to stop', 5_000);
    expect(await slowOps()).toBe(0);
  }, 30_000);
});

describe('a result through the bridge', () => {
  it('a large result crosses whole', async () => {
    const s = setup();
    await s.run({
      connectionId: 'rw',
      source: `await db.rpc_big.deleteMany({}); const s = 'x'.repeat(1000);
        for (let b = 0; b < 5; b++) await db.rpc_big.insertMany(Array.from({ length: 1000 }, (_, i) => ({ _id: b * 1000 + i, s })));
        1`,
      maxTimeMs: 60_000,
    });
    const r = await s.run({ connectionId: 'rw', source: '(await db.rpc_big.find().toArray()).length', maxTimeMs: 60_000 });
    expect(r.valueJson).toBe('5000');
  }, 90_000);

  it('a call result over the cap is reported as an error the script can catch', async () => {
    const s = setup();
    await s.run({
      connectionId: 'rw',
      source: `await db.rpc_huge.deleteMany({}); const s = 'y'.repeat(4 * 1024 * 1024);
        for (let b = 0; b < 14; b++) await db.rpc_huge.insertOne({ _id: b, s });
        1`,
      maxTimeMs: 60_000,
    });
    const result = await outcome('rw', 'await db.rpc_huge.find().toArray()');
    expect(result).toMatch(/result size exceeds 52428800 byte cap/);
  }, 90_000);
});
