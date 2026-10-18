import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { Long } from 'bson';
import type { ShellOutputEvent } from '@shared/types';
import { ShellService } from '../../electron/services/ShellService';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { createTestSpawner, type TestSpawner } from '../helpers/runnerSpawner';
import {
  getSharedMongoUri,
  uriToHostPort,
  makeConnection,
  makeReader,
} from '../helpers/mongo';

/**
 * The shell's REPL runs in a runner child; main holds the client and answers
 * the child's calls. These tests fork the real runner under Node and drive it
 * through the real service against a real mongod.
 */

// Unique to this file: every integration file shares one mongod.
const DB = 'shell_runner_db';

let hp: { host: string; port: number };
let tmp: TempDb | undefined;
let pool: MongoPool | undefined;
let spawner: TestSpawner;
let svc: ShellService | undefined;
let events: ShellOutputEvent[];

beforeAll(async () => {
  hp = uriToHostPort(getSharedMongoUri());
});

afterEach(async () => {
  // A leaked child would hold vitest open: the assertion runs before cleanup
  // so cleanup cannot hide a leak.
  await svc?.disposeAll();
  await until(async () => spawner.alive().length === 0, 'shell children to die', 3000);
  const leaked = spawner.alive().length;
  svc = undefined;
  spawner.killAll();
  if (pool) await pool.disconnectAll();
  pool = undefined;
  tmp?.cleanup();
  tmp = undefined;
  expect(leaked, 'shell children still alive after the test').toBe(0);
});

function setup(
  readOnlyIds: string[] = [],
  overrides: Record<string, Partial<Parameters<typeof makeConnection>[2]>> = {},
): ShellService {
  tmp = createTempDb();
  const vault = new SecretsVault(tmp.db, createSafeStorageMock());
  const conns = ['c1', 'c2'].map((id) =>
    makeConnection(id, hp, {
      defaultDb: DB,
      readOnly: readOnlyIds.includes(id),
      ...overrides[id],
    }),
  );
  pool = new MongoPool({ repo: makeReader(conns), vault });
  spawner = createTestSpawner();
  events = [];
  svc = new ShellService({ pool, spawner, emit: (e) => events.push(e) });
  return svc;
}

async function until(cond: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const outputOf = (from = 0): string =>
  events
    .slice(from)
    .filter((e) => e.kind === 'stdout' || e.kind === 'stderr')
    .map((e) => e.data ?? '')
    .join('');

/** Send one line and wait for `marker` in what the session prints next. */
async function say(sessionId: string, line: string, marker: string): Promise<string> {
  const from = events.length;
  svc!.write(sessionId, line + '\n');
  await until(() => outputOf(from).includes(marker), `"${marker}" after "${line}"`);
  return outputOf(from);
}

async function countDocs(dbName: string, coll: string): Promise<number> {
  const client = new MongoClient(getSharedMongoUri());
  try {
    return await client.db(dbName).collection(coll).countDocuments();
  } finally {
    await client.close();
  }
}

describe('ShellService — the REPL runs in a child', () => {
  it('evaluates JS, reads and writes through main, and reports it as output events', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    expect(await say(info.sessionId, '1+1', '2')).toContain('2');

    await say(info.sessionId, 'await db.shell_items.insertOne({ k: "v1" })', 'acknowledged');
    expect(await countDocs(DB, 'shell_items')).toBe(1);
    const read = await say(info.sessionId, 'await db.shell_items.findOne()', '"k": "v1"');
    expect(read).toContain('"k": "v1"');
    // The REPL ran in a child of its own, not in this process.
    expect(spawner.spawns).toHaveLength(1);
    const pid = spawner.spawns[0]!.child.pid;
    expect(pid).not.toBe(process.pid);
    expect(await say(info.sessionId, 'process.pid', String(pid))).toContain(String(pid));
  });

  it('`use` switches the database for later calls and the prompt follows', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, 'use shell_other', 'switched to db shell_other');
    await say(info.sessionId, 'await db.moved.insertOne({ here: 1 })', 'acknowledged');
    // The prompt follows the db the REPL is on.
    await until(() => outputOf().endsWith('shell_other> '), 'prompt for the new db');
    expect(await countDocs('shell_other', 'moved')).toBe(1);
    expect(await countDocs(DB, 'moved')).toBe(0);
  });

  it('`show dbs` and `show collections` go through main', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, 'await db.listed_coll.insertOne({})', 'acknowledged');
    expect(await say(info.sessionId, 'show dbs', 'admin')).toContain('admin');
    expect(await say(info.sessionId, 'show collections', 'listed_coll')).toContain('listed_coll');
  });
});

describe('ShellService — the database a session starts on', () => {
  it("starts on the connection's default database and writes land there", async () => {
    const s = setup([], { c1: { defaultDb: 'smoke' } });
    const info = await s.start({ connectionId: 'c1' });
    expect(info.dbName).toBe('smoke');
    await until(() => outputOf().endsWith('smoke> '), 'prompt for the default db');
    await say(info.sessionId, 'await db.items.insertOne({ k: 1 })', 'acknowledged');
    expect(await countDocs('smoke', 'items')).toBe(1);
    expect(await countDocs(DB, 'items')).toBe(0);
  });

  it('an explicit dbName wins over the connection default', async () => {
    const s = setup([], { c1: { defaultDb: 'smoke' } });
    const info = await s.start({ connectionId: 'c1', dbName: 'other' });
    expect(info.dbName).toBe('other');
    await until(() => outputOf().endsWith('other> '), 'prompt for the explicit db');
  });

  it('a blank dbName counts as unset, so the connection default applies', async () => {
    const s = setup([], { c1: { defaultDb: 'smoke' } });
    const info = await s.start({ connectionId: 'c1', dbName: '  ' });
    expect(info.dbName).toBe('smoke');
    await until(() => outputOf().endsWith('smoke> '), 'prompt for the default db');
  });

  it('falls back to test when the connection has no default database', async () => {
    const s = setup([], { c1: { defaultDb: undefined } });
    const info = await s.start({ connectionId: 'c1' });
    expect(info.dbName).toBe('test');
    await until(() => outputOf().endsWith('test> '), 'prompt for the fallback db');
  });

  it('a Restart (stop not awaited, then start) reopens on the new database', async () => {
    // The pane's cleanup fires `stop` without awaiting it and starts again at
    // once. start() reuses a live session for the connection and ignores
    // dbName then, so stop must end the session before its first await.
    const s = setup();
    const first = await s.start({ connectionId: 'c1', dbName: 'first_db' });
    void s.stop(first.sessionId);
    const second = await s.start({ connectionId: 'c1', dbName: 'second_db' });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.dbName).toBe('second_db');
    await until(() => outputOf().endsWith('second_db> '), 'prompt for the restarted db');
  });
});

describe('ShellService — cursors', () => {
  it('a bare cursor prints a one-line hint, not its internals', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    const out = await say(info.sessionId, 'db.hint_items.find()', 'Cursor on');
    expect(out).toContain(`Cursor on ${DB}.hint_items — iterate it or call .toArray()`);
    expect(out).not.toContain('FacadeCursor');
    // A database-level cursor names the database.
    const dbOut = await say(info.sessionId, 'db.listCollections()', `Cursor on ${DB} —`);
    expect(dbOut).toContain(`Cursor on ${DB} — iterate it or call .toArray()`);
  });

  it('a long session never runs out of cursor slots', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, 'await db.slots.insertOne({ n: 1 })', 'acknowledged');
    // Past the host's 256-handle table, in one session. Each bare find() opens
    // a handle only once something iterates it, so drive 300 through next().
    const from = events.length;
    s.write(info.sessionId, 'for (let i = 0; i < 300; i++) { await db.slots.find().next(); }; "looped"\n');
    await until(() => outputOf(from).includes('looped'), 'the loop to finish', 20_000);
    expect(outputOf(from)).not.toMatch(/cursors|Error/);
    expect(await say(info.sessionId, 'JSON.stringify(await db.slots.find().toArray())', '"n":1')).toContain('"n":1');
  });
});

describe('ShellService — a bare collection', () => {
  it('prints a one-line hint naming the collection, not an empty object', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    // The banner ends in a newline too: wait for the first prompt so only a result can match below.
    await until(() => outputOf().endsWith(`${DB}> `), 'the first prompt');
    // A printed result ends in a newline, a prompt does not.
    const out = await say(info.sessionId, 'db.hint_coll', '\n');
    expect(out).toContain(`[Collection ${DB}.hint_coll]`);
    expect(out).not.toMatch(/(?:^|> )\{\}$/m);
    // The hint follows `use`, and a cursor off the same collection still prints its own.
    await say(info.sessionId, 'use hint_other', 'switched to db hint_other');
    expect(await say(info.sessionId, 'db.hint_coll', '\n')).toContain('[Collection hint_other.hint_coll]');
    expect(await say(info.sessionId, 'db.hint_coll.find()', '\n')).toContain('Cursor on hint_other.hint_coll');
  });

  it('leaves documents printing as EJSON', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, 'await db.hint_docs.deleteMany({}); await db.hint_docs.insertOne({ _id: 1, at: new Date(0) })', 'acknowledged');
    const out = await say(info.sessionId, 'await db.hint_docs.findOne()', '1970');
    expect(out).toContain('"_id": 1');
    expect(out).toContain('"$date": "1970-01-01T00:00:00Z"');
    expect(out).not.toContain('[Collection');
  });
});

describe('ShellService — a Long past 2^53', () => {
  it('prints a stored Long with its exact digits, and a safe one as a bare number', async () => {
    // The shell has no Long constructor, so the document goes in from outside.
    const client = new MongoClient(getSharedMongoUri());
    try {
      const coll = client.db(DB).collection('shell_wide');
      await coll.deleteMany({});
      await coll.insertOne({ big: Long.fromString('9007199254740993'), safe: Long.fromString('5') });
    } finally {
      await client.close();
    }
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    const out = await say(info.sessionId, 'await db.shell_wide.findOne()', '"safe"');
    expect(out).toContain('"big": {\n    "$numberLong": "9007199254740993"\n  }');
    expect(out).toContain('"safe": 5');
    expect(out).not.toContain('9007199254740992');
  });
});

describe('ShellService — `.clear`', () => {
  it('drops what the user defined but keeps db, use, help and show working', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, 'use clear_db', 'switched to db clear_db');
    // `var` evaluates to undefined, which the shell prints as nothing, so there is no output to wait for.
    svc!.write(info.sessionId, 'var defined_by_user = 41\n');
    expect(await say(info.sessionId, 'typeof defined_by_user', '\n')).toContain('number');

    await say(info.sessionId, '.clear', 'Clearing context');
    // The context really was reset, so the checks below are not vacuous.
    expect(await say(info.sessionId, 'typeof defined_by_user', '\n')).toContain('undefined');

    // The database chosen before `.clear` is still the one in use.
    expect(await say(info.sessionId, 'db.getName() + "!"', '\n')).toContain('clear_db!');
    expect(await say(info.sessionId, 'help()', '\n')).toContain("L'Atelier shell");
    expect(await say(info.sessionId, 'show dbs', 'admin')).toContain('admin');
    await say(info.sessionId, 'use clear_again', 'switched to db clear_again');
    expect(await say(info.sessionId, 'db.getName() + "?"', '\n')).toContain('clear_again?');
  });
});

describe('ShellService — un-awaited results', () => {
  // A result starts right after its prompt (`shell_runner_db> 3`) unless that prompt was
  // already printed before the line was sent, so a line start is `> ` or `^`.
  const emptyObject = /(?:^|> )\{\}$/m;

  /** A session on `DB` with exactly three documents in `async_items`; the mongod outlives each test. */
  async function seeded(): Promise<string> {
    const info = await setup().start({ connectionId: 'c1' });
    await say(
      info.sessionId,
      'await db.async_items.deleteMany({}); await db.async_items.insertMany([{n:1},{n:2},{n:3}])',
      'acknowledged',
    );
    return info.sessionId;
  }

  it('prints the documents of a find().toArray() left without await', async () => {
    const sessionId = await seeded();
    const out = await say(sessionId, 'db.async_items.find({n:{$gt:1}}).toArray()', '"n": 3');
    expect(out).toContain('"n": 2');
    expect(out).not.toContain('"n": 1');
    expect(out).not.toMatch(emptyObject);
  });

  it('prints the number of a countDocuments() left without await', async () => {
    const sessionId = await seeded();
    const from = events.length;
    svc!.write(sessionId, 'db.async_items.countDocuments()\n');
    await until(() => /(?:^|> )3$/m.test(outputOf(from)), 'a result line that is exactly 3');
    expect(outputOf(from)).not.toMatch(emptyObject);
  });

  it('prints the same documents with and without await', async () => {
    const sessionId = await seeded();
    const documents = (out: string): string | undefined => /\[[\s\S]*\]/.exec(out)?.[0];
    const awaited = await say(sessionId, 'await db.async_items.find({n:2}).toArray()', '"n": 2');
    const bare = await say(sessionId, 'db.async_items.find({n:2}).toArray()', '"n": 2');
    expect(documents(awaited)).toContain('"n": 2');
    expect(documents(bare)).toBe(documents(awaited));
  });

  it('prints the message of a rejection left without await, and the session stays alive', async () => {
    const sessionId = await seeded();
    const out = await say(sessionId, 'db.runCommand({ definitelyNotACommand: 1 })', 'definitelyNotACommand');
    expect(out).not.toMatch(emptyObject);
    expect(await say(sessionId, '40+2', '42')).toContain('42');
  });

  it('prints the message of a rejection that is awaited, and of a synchronous throw', async () => {
    const sessionId = await seeded();
    expect(await say(sessionId, 'await Promise.reject(new Error("await-boom"))', 'await-boom')).toContain(
      'await-boom',
    );
    expect(await say(sessionId, 'throw new Error("boom-sync")', 'boom-sync')).toContain('boom-sync');
    expect(await say(sessionId, '40+2', '42')).toContain('42');
  });

  it('prints a non-Error rejection or throw readably', async () => {
    const sessionId = await seeded();
    expect(await say(sessionId, 'Promise.reject("plain-reason")', 'plain-reason')).toContain('plain-reason');
    expect(await say(sessionId, 'Promise.reject({ code: 7 })', '"code": 7')).toContain('"code": 7');
    expect(await say(sessionId, 'throw "thrown-string"', 'thrown-string')).toContain('thrown-string');
    expect(await say(sessionId, 'throw { code: 8 }', '"code": 8')).toContain('"code": 8');
    // A falsy reason would read as success to the REPL and print nothing.
    expect(await say(sessionId, 'Promise.reject(null)', 'rejected with null')).toContain('rejected with null');
    expect(await say(sessionId, '40+2', '42')).toContain('42');
  });

  it('an Error with a cause and extra fields prints its message and does not take the session down', async () => {
    const sessionId = await seeded();
    const out = await say(
      sessionId,
      '(() => { const e = new Error("outer-msg", { cause: new Error("inner-msg") }); e.code = 42; e.self = e; throw e; })()',
      'outer-msg',
    );
    // One line, not the stack the writer's fallback would print.
    expect(out).toMatch(/Error: outer-msg\n/);
    expect(out).not.toMatch(/^\s+at /m);
    expect(await say(sessionId, '40+2', '42')).toContain('42');
  });

  it('a result that never settles leaves later commands working', async () => {
    const sessionId = await seeded();
    const from = events.length;
    svc!.write(sessionId, 'new Promise(() => {})\n');
    svc!.write(sessionId, '({ then() {} })\n');
    expect(await say(sessionId, '40+2', '42')).toContain('42');
    expect(await say(sessionId, 'await db.async_items.countDocuments()', '3')).toContain('3');
    expect(outputOf(from)).not.toMatch(emptyObject);
  });

  it('a result that settles late prints after the commands that ran meanwhile', async () => {
    const sessionId = await seeded();
    svc!.write(sessionId, 'new Promise((resolve) => { globalThis.release = resolve; })\n');
    const from = events.length;
    expect(await say(sessionId, '40+2', '42')).toContain('42');
    expect(await say(sessionId, 'release("late-value")', 'late-value')).toContain('late-value');
    expect(outputOf(from).indexOf('42')).toBeLessThan(outputOf(from).indexOf('late-value'));
  });

  it('a thenable that settles twice prints once', async () => {
    const sessionId = await seeded();
    await say(sessionId, '({ then(resolve) { resolve("first-value"); resolve("second-value"); } })', 'first-value');
    expect(await say(sessionId, '40+2', '42')).toContain('42');
    expect(outputOf()).not.toContain('second-value');
  });

  it('a `then` that throws fails that command and not the session', async () => {
    const sessionId = await seeded();
    const getter = await say(sessionId, '({ get then() { throw new Error("getter-boom"); } })', 'getter-boom');
    expect(getter).toContain('getter-boom');
    const method = await say(sessionId, '({ then() { throw new Error("method-boom"); } })', 'method-boom');
    expect(method).toContain('method-boom');
    expect(await say(sessionId, '40+2', '42')).toContain('42');
    expect(svc!.list()).toHaveLength(1);
  });

  it('a command typed while a multi-line one is pending is not glued onto it', async () => {
    const sessionId = await seeded();
    // The REPL prefixes each line with the lines buffered so far and only
    // clears that buffer when the pending command finishes.
    svc!.write(sessionId, 'new Promise((r) => {\n');
    svc!.write(sessionId, 'globalThis.rel2 = r })\n');
    expect(await say(sessionId, '40+2', '42')).toContain('42');
    expect(await say(sessionId, 'rel2("late-x")', 'late-x')).toContain('late-x');
    expect(await say(sessionId, '40+3', '43')).toContain('43');
  });

  it('a multi-line call whose result is pending leaves the next command working', async () => {
    const sessionId = await seeded();
    // One write, so the third line arrives before the call can answer.
    const from = events.length;
    svc!.write(sessionId, 'db.async_items.countDocuments(\n)\n"after-count"\n');
    await until(() => outputOf(from).includes('after-count'), '"after-count" typed while the count is pending');
    await until(() => /(?:^|> )3$/m.test(outputOf(from)), 'the count of the multi-line call');
    expect(outputOf(from)).toContain('after-count');
    expect(outputOf(from)).toMatch(/(?:^|> )3$/m);
  });

  it('a multi-line function definition still continues across lines', async () => {
    const sessionId = await seeded();
    // Three lines: the second is still incomplete, so it must keep what the first buffered.
    svc!.write(sessionId, 'function f() {\n');
    svc!.write(sessionId, 'const x = 40;\n');
    svc!.write(sessionId, 'return x + 1 }\n');
    expect(await say(sessionId, 'f()', '41')).toContain('41');
  });

  it('`_` holds the settled value of an un-awaited result', async () => {
    const sessionId = await seeded();
    const from = events.length;
    svc!.write(sessionId, 'db.async_items.countDocuments()\n');
    await until(() => /(?:^|> )3$/m.test(outputOf(from)), 'the count');
    expect(await say(sessionId, '_ * 100', '300')).toContain('300');
  });

  it('`_error` holds an un-awaited rejection', async () => {
    const sessionId = await seeded();
    await say(sessionId, 'Promise.reject(new Error("kept-error"))', 'kept-error');
    expect(await say(sessionId, '_error.message + "!"', 'kept-error!')).toContain('kept-error!');
  });

  it('a bare cursor and a bare collection are not awaited', async () => {
    const sessionId = await seeded();
    expect(await say(sessionId, 'db.async_items.find()', `Cursor on ${DB}.async_items`)).toContain(
      `Cursor on ${DB}.async_items — iterate it or call .toArray()`,
    );
    // A printed result ends in a newline, a prompt does not, so a newline
    // means the proxy was printed rather than mistaken for a thenable and awaited.
    expect(await say(sessionId, 'db.async_items', '\n')).not.toContain('Promise');
    expect(await say(sessionId, 'db', '\n')).toContain('[Function: db]');
  });
});

describe('ShellService — error output', () => {
  it('a validator rejection says which rule failed, not only that validation failed', async () => {
    const coll = `validated_${Date.now()}`;
    const client = new MongoClient(getSharedMongoUri());
    try {
      await client.db(DB).createCollection(coll, {
        validator: { $jsonSchema: { bsonType: 'object', required: ['name'], properties: { name: { bsonType: 'string' } } } },
      });
    } finally {
      await client.close();
    }
    const info = await setup().start({ connectionId: 'c1' });
    const out = await say(info.sessionId, `db.${coll}.insertOne({ name: 5 })`, 'propertiesNotSatisfied');
    expect(out).toMatch(/Document failed validation/);
    expect(out).toContain('errInfo');
    // Still readable: the message line comes first.
    expect(out.indexOf('Document failed validation')).toBeLessThan(out.indexOf('errInfo'));
  });

  it('an error nested in a result prints its message, not {}', async () => {
    const info = await setup().start({ connectionId: 'c1' });
    const settled = await say(
      info.sessionId,
      'Promise.allSettled([Promise.reject(new Error("inner-x")), 1])',
      'inner-x',
    );
    expect(settled).toContain('Error: inner-x');
    expect(settled).not.toMatch(/"reason": \{\}/);
    const literal = await say(info.sessionId, '({ a: [new TypeError("lit-e")], b: 1 })', 'lit-e');
    expect(literal).toContain('TypeError: lit-e');
    expect(literal).toContain('"b": 1');
  });

  it('an object holding an error, shared twice in a result, prints twice, and a cycle does not crash the writer', async () => {
    const info = await setup().start({ connectionId: 'c1' });
    const twice = await say(
      info.sessionId,
      '(() => { const shared = { err: new Error("dag-e") }; return { first: shared, second: shared }; })()',
      'second',
    );
    expect(twice.match(/Error: dag-e/g)).toHaveLength(2);
    const cyclic = await say(
      info.sessionId,
      '(() => { const o = { err: new Error("cyc-e") }; o.self = o; return o; })()',
      'cyc-e',
    );
    expect(cyclic).toContain('cyc-e');
    expect(await say(info.sessionId, '40+2', '42')).toContain('42');
  });

  it('an AggregateError lists the errors it holds', async () => {
    const info = await setup().start({ connectionId: 'c1' });
    const out = await say(
      info.sessionId,
      'Promise.any([Promise.reject(new Error("first-e")), Promise.reject(new TypeError("second-e"))])',
      'second-e',
    );
    expect(out).toContain('AggregateError');
    expect(out).toContain('Error: first-e');
    expect(out).toContain('TypeError: second-e');
  });

  it('an error with an empty message or name prints without stray punctuation', async () => {
    const info = await setup().start({ connectionId: 'c1' });
    expect(await say(info.sessionId, 'throw new Error()', 'Uncaught Error\n')).toMatch(/Uncaught Error\n/);
    const named = await say(info.sessionId, 'throw Object.assign(new Error("nm-only"), { name: "" })', 'nm-only\n');
    expect(named).toMatch(/Uncaught nm-only\n/);
  });
});

describe('ShellService — knowing the shell is busy', () => {
  const prompts = (): number => events.filter((e) => e.kind === 'prompt').length;

  it('says "prompt" once per line, and not for the prompt the REPL shows on start', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await until(() => outputOf().includes('Connected to'), 'the banner');
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts()).toBe(0);

    await say(info.sessionId, '1+1', '2');
    await until(() => prompts() >= 1, 'a prompt after the line');
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts()).toBe(1);
  });

  it('counts a session busy from the line until its prompt, and idle after', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    expect(s.busyCount()).toBe(0);

    s.write(info.sessionId, 'await new Promise((r) => setTimeout(r, 600))\n');
    expect(s.busyCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.busyCount()).toBe(1);
    expect(prompts()).toBe(0);

    await until(() => s.busyCount() === 0, 'the call to finish', 5000);
    expect(prompts()).toBe(1);
  });

  it('counts several calls pending at once, one per line', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    s.write(info.sessionId, 'await new Promise((r) => setTimeout(r, 500))\n');
    s.write(info.sessionId, 'await new Promise((r) => setTimeout(r, 500))\n');
    expect(s.busyCount()).toBe(1);
    await until(() => s.busyCount() === 0, 'both calls to finish', 5000);
    expect(prompts()).toBe(2);
  });

  it('is not busy once an idle session has answered', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, '1+1', '2');
    await until(() => s.busyCount() === 0, 'the prompt');
    expect(s.busyCount()).toBe(0);
  });

  it('a session stopped while busy is no longer counted', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    s.write(info.sessionId, 'await new Promise(() => {})\n');
    expect(s.busyCount()).toBe(1);
    await s.stop(info.sessionId);
    expect(s.busyCount()).toBe(0);
  });

  it('cannot tell an awaited rejection with a null reason from a success (Node hands the REPL no error)', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    // Node resolves the REPL's eval callback with (null, undefined) for this,
    // the same as for `await undefined`, so it prints nothing and does not
    // read as an uncaught rejection. Pinned so a Node that starts reporting it
    // is noticed (a rejected-with-null message could then be added).
    await say(info.sessionId, 'await Promise.reject(null)', '');
    await until(() => s.busyCount() === 0, 'the prompt');
    expect(outputOf()).not.toContain('Uncaught');
  });
});

describe('ShellService — lifecycle', () => {
  it('stop() kills the child', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, '1', '1');
    expect(spawner.alive()).toHaveLength(1);
    await s.stop(info.sessionId);
    await until(() => spawner.alive().length === 0, 'child to die', 3000);
    expect(events.at(-1)).toMatchObject({ kind: 'exit', exitCode: 0 });
  });

  it('disposeAll() (app quit) kills every child', async () => {
    const s = setup();
    await s.start({ connectionId: 'c1' });
    await s.start({ connectionId: 'c2' });
    expect(spawner.alive()).toHaveLength(2);
    await s.disposeAll();
    await until(() => spawner.alive().length === 0, 'children to die', 3000);
    expect(s.list()).toHaveLength(0);
  });

  it('a pool disconnect ends the session and kills the child', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await pool!.disconnect('c1');
    await until(() => s.list().length === 0, 'session to end');
    await until(() => spawner.alive().length === 0, 'child to die', 3000);
    const end = events.at(-1)!;
    expect(end).toMatchObject({ sessionId: info.sessionId, kind: 'exit', exitCode: 1 });
    expect(outputOf()).toContain('the connection was disconnected');
    expect(() => s.write(info.sessionId, '1\n')).toThrow();
  });

  it('a disconnect of another connection leaves the session alone', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await pool!.readClient('c2');
    await pool!.disconnect('c2');
    expect(await say(info.sessionId, '40+2', '42')).toContain('42');
    expect(s.list()).toHaveLength(1);
  });

  it('a connection that turns read-only ends the session', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    pool!.emit('read-only-enabled', 'c1');
    await until(() => s.list().length === 0, 'session to end');
    await until(() => spawner.alive().length === 0, 'child to die', 3000);
    expect(outputOf()).toContain('set to read-only');
    expect(() => s.write(info.sessionId, '1\n')).toThrow();
  });

  it('a child that dies on its own ends the session with an error event', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    await say(info.sessionId, '1', '1');
    spawner.spawns[0]!.child.kill('SIGKILL');
    await until(() => s.list().length === 0, 'session to end');
    const err = events.find((e) => e.kind === 'stderr');
    expect(err?.data).toMatch(/exited unexpectedly/);
    expect(events.at(-1)).toMatchObject({ sessionId: info.sessionId, kind: 'exit', exitCode: 1 });
  });

  it('process.exit() inside the REPL is a clean error, not a hang', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    s.write(info.sessionId, 'process.exit(3)\n');
    await until(() => s.list().length === 0, 'session to end');
    expect(outputOf()).toContain('exit code 3');
  });

  it('`.exit` in the REPL ends the session cleanly', async () => {
    const s = setup();
    const info = await s.start({ connectionId: 'c1' });
    s.write(info.sessionId, '.exit\n');
    await until(() => s.list().length === 0, 'session to end');
    await until(() => spawner.alive().length === 0, 'child to die', 3000);
    expect(events.at(-1)).toMatchObject({ sessionId: info.sessionId, kind: 'exit', exitCode: 0 });
  });

  it('refuses a read-only connection wholesale, before spawning anything', async () => {
    const s = setup(['c2']);
    await expect(s.start({ connectionId: 'c2' })).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(spawner.spawns).toHaveLength(0);
  });
});

describe('ShellService — what the child can see', () => {
  const sentinel = 'pw-SENTINEL-9f3a';

  /** A connection with a stored password, whose pool client is a stand-in for the authenticated one. */
  async function authedSession(): Promise<{ s: ShellService; sessionId: string }> {
    tmp = createTempDb();
    const now = new Date().toISOString();
    tmp.db
      .prepare(
        `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
         VALUES ('authed', 'authed', 'standard', 'localhost', 27017, 'scram256', ?, ?)`,
      )
      .run(now, now);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    vault.set('authed', 'password', sentinel);
    const authed = makeConnection('authed', hp, {
      defaultDb: DB,
      authMech: 'scram256',
      authUsername: 'nobody',
    });
    pool = new MongoPool({ repo: makeReader([authed]), vault });
    // The user is unknown to the server, so the pool's own connect would fail
    // authentication; stand in for it with an unauthenticated client. What the
    // tests inspect is what main hands the child.
    const direct = new MongoClient(getSharedMongoUri());
    pool.readClient = () => Promise.resolve(direct);
    spawner = createTestSpawner();
    events = [];
    svc = new ShellService({ pool, spawner, emit: (e) => events.push(e) });
    const info = await svc.start({ connectionId: 'authed' });
    return { s: svc, sessionId: info.sessionId };
  }

  it('no message posted to the child carries a URI, a user or a password', async () => {
    const { sessionId } = await authedSession();
    await say(sessionId, 'await db.runCommand({ ping: 1 })', 'ok');
    const spawn = spawner.spawns[0]!;
    expect(JSON.stringify(spawn.args)).not.toContain(sentinel);
    expect(JSON.stringify(spawn.env)).not.toContain(sentinel);
    // The start request names a database and a banner, and nothing else.
    const start = spawn.sent[0] as Record<string, unknown>;
    expect(Object.keys(start).sort((a, b) => a.localeCompare(b))).toEqual(['banner', 'dbName', 'type']);
    const everything = JSON.stringify(spawn.sent);
    expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain('mongodb://');
    expect(everything).not.toContain('nobody');
    // Input lines and RPC replies were both among what was posted.
    const types = spawn.sent.map((m) => (m as { type?: string }).type);
    expect(types).toContain('shell-in');
    expect(types).toContain('rpc-result');
  });

  it('an escape through process.env and process.argv finds no URI and no password', async () => {
    const { sessionId } = await authedSession();
    const env = await say(sessionId, 'JSON.stringify(process.env)', 'PATH');
    const argv = await say(sessionId, 'JSON.stringify(process.argv)', 'runner');
    for (const seen of [env, argv, outputOf()]) {
      expect(seen).not.toContain(sentinel);
      expect(seen).not.toContain('mongodb://');
      expect(seen).not.toContain('nobody');
    }
    // A shell-out sees the same scrubbed environment.
    const viaChild = await say(
      sessionId,
      "require('child_process').execSync('env').toString()",
      'PATH=',
    );
    expect(viaChild).not.toContain(sentinel);
    expect(viaChild).not.toContain('mongodb://');
  });

  it('the child has no client of its own: the facade exposes no driver internals', async () => {
    const { sessionId } = await authedSession();
    const out = await say(
      sessionId,
      'JSON.stringify([db.items.s, db.items.client, db.items.topology, db.items.db, db.items.namespace])',
      'items',
    );
    // Only the namespace is a real property of the facade; the rest are absent
    // (JSON turns `undefined` into `null` inside an array).
    expect(out).toContain('[null,null,null,null,"test.items"]');
  });
});
