import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient, type RunCommandOptions } from 'mongodb';
import { makeDbProxy, type DbProxyCtx } from '../../electron/mongo/dbProxy';
import { ReadOnlyConnectionError } from '../../electron/errors';
import { getSharedMongoUri, uriToHostPort } from '../helpers/mongo';

interface CursorLike {
  toArray(): Promise<unknown[]>;
}
interface CollectionLike {
  find(): CursorLike;
  aggregate(pipeline: unknown[]): CursorLike;
}
/** Bulk builder: `insert` returns the receiver so calls chain. */
interface BulkLike {
  insert(doc: unknown): BulkLike;
  execute(): Promise<unknown>;
}
interface TestDbProxy {
  collection(name: string): CollectionLike;
  things: CollectionLike;
  admin(): { listDatabases(options?: RunCommandOptions): Promise<{ databases: { name: string }[] }> };
  dropDatabase(): Promise<boolean>;
}

/**
 * Real driver + real in-memory server: signal threading is observed by
 * pre-aborting the AbortController and asserting the cursor's terminal
 * method rejects. The Node driver's AbstractCursor stores `options.signal`
 * at construction and calls `signal?.throwIfAborted()` before executing —
 * so a cursor built with the signal actually merged in will reject, and one
 * built without it (the bug: raw `db.collection(name)` never merges) will
 * happily resolve, proving the signal never made it into the driver call.
 */
const DB = 'dbproxy_test';

describe('makeDbProxy — db.collection(name) routing', () => {
  let client: MongoClient;

  beforeAll(async () => {
    const { host, port } = uriToHostPort(getSharedMongoUri());
    client = new MongoClient(`mongodb://${host}:${port}`);
    await client.connect();
    await client
      .db(DB)
      .collection<{ _id: number }>('things')
      .insertMany([{ _id: 1 }, { _id: 2 }]);
  });

  afterAll(async () => {
    await client.close();
  });

  function makeCtx(signal?: AbortSignal): DbProxyCtx {
    return { currentDb: DB, client, signal };
  }

  it('db.collection(name).find() honors an aborted signal (signal threading)', async () => {
    const controller = new AbortController();
    controller.abort();
    const proxy = makeDbProxy(makeCtx(controller.signal)) as unknown as TestDbProxy;
    const cursor = proxy.collection('things').find();
    await expect(cursor.toArray()).rejects.toThrow();
  });

  it('db.<collName>.find() also honors an aborted signal (regression guard)', async () => {
    const controller = new AbortController();
    controller.abort();
    const proxy = makeDbProxy(makeCtx(controller.signal)) as unknown as TestDbProxy;
    const cursor = proxy.things.find();
    await expect(cursor.toArray()).rejects.toThrow();
  });

  it('db.collection(name).aggregate([...]) also honors an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const proxy = makeDbProxy(makeCtx(controller.signal)) as unknown as TestDbProxy;
    const cursor = proxy.collection('things').aggregate([{ $match: {} }]);
    await expect(cursor.toArray()).rejects.toThrow();
  });

  it('db.collection(name).find() with no signal on ctx runs normally', async () => {
    const proxy = makeDbProxy(makeCtx(undefined)) as unknown as TestDbProxy;
    const docs = await proxy.collection('things').find().toArray();
    expect(docs).toHaveLength(2);
  });

  it('other direct Db methods (admin, dropDatabase) stay raw/unbound — unaffected by the fix', async () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as TestDbProxy;

    // admin() is untouched: still the real driver Admin object, fully functional.
    const dbs = await proxy.admin().listDatabases();
    expect(dbs.databases.map((d: { name: string }) => d.name)).toContain(DB);

    // dropDatabase is untouched: still a raw, working call — scope this to a
    // throwaway db so it doesn't disturb the `things` fixture other tests use.
    const scratchCtx: DbProxyCtx = { currentDb: 'dbproxy_scratch', client };
    const scratchProxy = makeDbProxy(scratchCtx) as unknown as TestDbProxy;
    await client.db('dbproxy_scratch').collection('x').insertOne({ a: 1 });
    await scratchProxy.dropDatabase();
    const namesAfter = (await proxy.admin().listDatabases()).databases.map(
      (d: { name: string }) => d.name,
    );
    expect(namesAfter).not.toContain('dbproxy_scratch');
  });

  // The trap used to look a property up by its stringified key, so
  // `Symbol.asyncIterator` became `"Symbol(Symbol.asyncIterator)"` — a key no
  // cursor has — and the proxy exposed no async iterator. `for await` threw
  // every time, while `.toArray()` and `.forEach()` worked, which is why
  // nothing noticed.
  it('a cursor is async-iterable, and iteration still honours the signal', async () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx(controller.signal)) as unknown as {
      things: { find(): AsyncIterable<{ _id: number }> };
    };
    const seen: number[] = [];
    for await (const doc of proxy.things.find()) seen.push(doc._id);
    expect(seen.sort()).toEqual([1, 2]);

    // The signal reaches iteration because it was merged into `find`'s
    // options, so the cursor carries it rather than the wrapper adding it.
    const aborted = new AbortController();
    aborted.abort();
    const abortedProxy = makeDbProxy(makeCtx(aborted.signal)) as unknown as {
      things: { find(): AsyncIterable<{ _id: number }> };
    };
    await expect(
      abortedProxy.things.find()[Symbol.asyncIterator]().next(),
    ).rejects.toThrow();
  });

  it('db.<collName> reaches the collection even when the name shadows an Object.prototype member', async () => {
    // `DB_ALIASES[propStr] ?? propStr` reads a plain `{ runCommand: 'command' }`
    // object with a user-controlled `propStr`. Routing that lookup through an
    // own-property-only read (so it can't return an inherited alias-map
    // member) is NOT a safe drop-in fix here: `direct = db[resolved]` walks
    // the *real* `Db` instance's prototype chain, and every one of these
    // names (`valueOf`, `constructor`, `hasOwnProperty`, `isPrototypeOf`,
    // `propertyIsEnumerable`, `toLocaleString`) genuinely resolves to a
    // function there, inherited from `Object.prototype` — regardless of what
    // the alias map says.
    //
    // Today, the alias-map bug means `resolved` ends up as that inherited
    // function object (not a string) for these names, so `db[resolved]`
    // (keyed by the stringified function) misses, and the proxy falls
    // through to `db.collection(propStr)` — the *correct* mongosh-sugar
    // behavior, arrived at by accident. An own-property-only read on
    // `DB_ALIASES` would make `resolved` the correct string, `db[resolved]`
    // would then genuinely find `Object.prototype.valueOf` as a callable
    // function, and this collection would stop being reachable this way —
    // trading one bug for a regression, so the alias-map read is left as-is.
    await client
      .db(DB)
      .collection<{ _id: number; tag: string }>('valueOf')
      .insertOne({ _id: 99, tag: 'shadowed' });
    const proxy = makeDbProxy(makeCtx()) as unknown as Record<string, CollectionLike>;
    const docs = await proxy['valueOf']!.find().toArray();
    expect(docs).toEqual([{ _id: 99, tag: 'shadowed' }]);
  });
});

describe('makeDbProxy — read-only connection (ADR 0005 Bucket C)', () => {
  let client: MongoClient;

  beforeAll(async () => {
    const { host, port } = uriToHostPort(getSharedMongoUri());
    client = new MongoClient(`mongodb://${host}:${port}`);
    await client.connect();
    await client
      .db(DB)
      .collection<{ _id: number }>('ro_things')
      .insertMany([{ _id: 1 }, { _id: 2 }]);
  });

  afterAll(async () => {
    await client.close();
  });

  function roCtx(): DbProxyCtx {
    return { currentDb: DB, client, isReadOnly: () => true };
  }

  const countRoThings = (filter: Record<string, unknown>): Promise<number> =>
    client.db(DB).collection('ro_things').countDocuments(filter);

  it('find/findOne/countDocuments/distinct still work read-only, via both access styles', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: CollectionLike;
      collection(name: string): CollectionLike;
    };
    expect(await proxy.ro_things.find().toArray()).toHaveLength(2);
    expect(await proxy.collection('ro_things').find().toArray()).toHaveLength(2);
  });

  // Denied methods throw SYNCHRONOUSLY (see readOnlyDenied's comment in
  // dbProxy.ts) — `aggregate`/`admin` return a cursor/object synchronously
  // in the real driver, so a rejected Promise here would make `.toArray()`/
  // `.listDatabases()` crash with a confusing "not a function" instead of
  // this error. A sync throw is caught identically to a rejection by any
  // await/try-catch wrapping it in real sandboxed script usage.

  it('deleteMany throws ReadOnlyConnectionError via db.<name> and db.collection(name)', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: CollectionLike & { deleteMany(filter: unknown): Promise<unknown> };
      collection(name: string): { deleteMany(filter: unknown): Promise<unknown> };
    };
    expect(() => proxy.ro_things.deleteMany({})).toThrow(ReadOnlyConnectionError);
    expect(() => proxy.collection('ro_things').deleteMany({})).toThrow(ReadOnlyConnectionError);
    // Nothing was actually deleted.
    expect(await proxy.ro_things.find().toArray()).toHaveLength(2);
  });

  it('a collection method with no read/write classification (e.g. createIndex) is denied by default', () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: { createIndex(spec: unknown): Promise<unknown> };
    };
    expect(() => proxy.ro_things.createIndex({ a: 1 })).toThrow(ReadOnlyConnectionError);
  });

  it('aggregate without a write stage still works read-only', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as { ro_things: CollectionLike };
    const docs = await proxy.ro_things.aggregate([{ $match: {} }]).toArray();
    expect(docs).toHaveLength(2);
  });

  it('aggregate with $merge/$out is denied read-only, at the aggregate() call itself', () => {
    const proxy = makeDbProxy(roCtx()) as unknown as { ro_things: CollectionLike };
    expect(() =>
      proxy.ro_things.aggregate([{ $merge: { into: 'ro_merge_target' } }]),
    ).toThrow(ReadOnlyConnectionError);
    expect(() => proxy.ro_things.aggregate([{ $out: 'ro_out_target' }])).toThrow(
      ReadOnlyConnectionError,
    );
  });

  it('direct Db methods other than collection() are denied read-only (dropDatabase, admin, createCollection)', () => {
    const proxy = makeDbProxy(roCtx()) as unknown as TestDbProxy & {
      createCollection(name: string): Promise<unknown>;
    };
    expect(() => proxy.dropDatabase()).toThrow(ReadOnlyConnectionError);
    expect(() => proxy.admin()).toThrow(ReadOnlyConnectionError);
    expect(() => proxy.createCollection('ro_new_coll')).toThrow(ReadOnlyConnectionError);
  });

  // Every driver class keeps its internals in a plain `s` bag, and
  // `Collection`'s holds the real `Db`. It is an ordinary enumerable
  // property, so a trap that only guards functions hands back a full write
  // surface for one property read — no method call, no state change, and the
  // Connection read-only the whole time. This wrote a document before
  // non-function properties were guarded too.
  it('the driver state bag does not hand back an unguarded Db', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: { s: { db: { collection(n: string): { insertOne(d: unknown): Promise<unknown> } } } };
    };
    expect(() => proxy.ro_things.s.db.collection('ro_things').insertOne({ x: 1 })).toThrow(
      ReadOnlyConnectionError,
    );
    expect(await countRoThings({ x: 1 })).toBe(0);
  });

  // `find()` is always allowed under read-only, and the cursor it returns
  // keeps the live MongoClient on `cursorClient` — a plain own property. An
  // unguarded cursor is therefore a write surface for the whole deployment,
  // reached by the most ordinary thing a script does, with the Connection
  // never writable at any point. This wrote a document, signal or no signal.
  it('a cursor does not hand back the live client', async () => {
    for (const signal of [new AbortController().signal, undefined]) {
      const proxy = makeDbProxy({
        currentDb: DB,
        client,
        isReadOnly: () => true,
        ...(signal ? { signal } : {}),
      }) as unknown as {
        ro_things: { find(): { cursorClient?: { db(n: string): { collection(n: string): { insertOne(d: unknown): Promise<unknown> } } } } };
      };
      const cursor = proxy.ro_things.find();
      expect(() =>
        cursor.cursorClient!.db(DB).collection('ro_things').insertOne({ y: 1 }),
      ).toThrow(ReadOnlyConnectionError);
    }
    expect(await countRoThings({ y: 1 })).toBe(0);
  });

  // Iteration is a read, so read-only allows it — but reaching it must not
  // become a way back out to a write surface.
  it('a read-only script can iterate, and gets nothing writable from doing so', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: {
        find(): AsyncIterable<{ _id: number }> & {
          cursorClient?: { db(n: string): unknown };
        };
      };
    };
    const cursor = proxy.ro_things.find();
    const seen: number[] = [];
    for await (const doc of cursor) seen.push(doc._id);
    expect(seen).toHaveLength(2);
    // The same cursor still refuses to hand back the live client.
    expect(() => cursor.cursorClient!.db(DB)).toThrow(ReadOnlyConnectionError);
  });

  // Cursor shaping chains, and the wrapper has to survive the chain — it
  // used to hand back the bare receiver, dropping the guard mid-expression.
  it('a shaped cursor keeps the guard through the chain', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: { find(): { sort(s: unknown): { cursorClient?: { db(n: string): unknown } } } };
    };
    const shaped = proxy.ro_things.find().sort({ _id: 1 });
    expect(() => shaped.cursorClient!.db(DB)).toThrow(ReadOnlyConnectionError);
  });

  // `get` is not the only way to read a property. `Object.getOwnPropertyDescriptor`
  // goes through [[GetOwnProperty]], which a get-only proxy leaves pointing at
  // the raw target — so the descriptor's `value` was the unguarded field. The
  // script VM exposes the standard `Object` intrinsic, so this is ordinary
  // script code, and it produced a real write on both the collection and the
  // cursor.
  it('a descriptor read does not hand back what the get trap would have guarded', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: { find(): object };
    };

    const collBag = Object.getOwnPropertyDescriptor(proxy.ro_things, 's') as
      | { value: { db: { collection(n: string): { insertOne(d: unknown): Promise<unknown> } } } }
      | undefined;
    expect(() =>
      collBag!.value.db.collection('ro_things').insertOne({ z: 1 }),
    ).toThrow(ReadOnlyConnectionError);

    const cursorClient = Object.getOwnPropertyDescriptor(
      proxy.ro_things.find(),
      'cursorClient',
    ) as { value: { db(n: string): unknown } } | undefined;
    expect(() => cursorClient!.value.db(DB)).toThrow(ReadOnlyConnectionError);

    expect(await countRoThings({ z: 1 })).toBe(0);
  });

  // Sealing is the script's own lever on the descriptor trap. `Object.seal`
  // forwards through the default integrity traps and makes the driver's `s`
  // bag non-configurable on the target; a trap that bailed out on
  // `configurable === false` then handed the raw value straight back. Probed
  // against a real server with `isReadOnly()` true throughout: the insert
  // returned `acknowledged`.
  //
  // The invariant never required that bail-out. [[GetOwnProperty]] pins the
  // value only when the property is non-configurable *and* non-writable, and
  // `seal` leaves `writable` alone.
  it('sealing a handle does not reopen the raw state bag', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as { ro_things: object };
    const coll = proxy.ro_things;
    Object.seal(coll);

    const bag = Object.getOwnPropertyDescriptor(coll, 's') as
      | { value: { db: { collection(n: string): { insertOne(d: unknown): Promise<unknown> } } } }
      | undefined;
    expect(() =>
      bag!.value.db.collection('ro_things').insertOne({ sealed: 1 }),
    ).toThrow(ReadOnlyConnectionError);
    expect(await countRoThings({ sealed: 1 })).toBe(0);
  });

  // `freeze` does clear `writable`, and then no guarded value can be reported
  // at all — returning one makes the engine throw `TypeError`. Refuse in our
  // own words instead: an opaque engine error and a leaked write surface are
  // both worse than naming the rule that stopped the script.
  it('freezing a handle refuses the read rather than leaking the raw value', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as { ro_things: object };
    const coll = proxy.ro_things;
    Object.freeze(coll);

    expect(() => Object.getOwnPropertyDescriptor(coll, 's')).toThrow(
      ReadOnlyConnectionError,
    );
    expect(await countRoThings({ frozen: 1 })).toBe(0);
  });

  // A primitive field carries no write surface, so nothing is substituted and
  // the descriptor is reported verbatim. Without the "did anything actually
  // change" check, the refusal above would swallow these too and locking a
  // handle would break ordinary reads rather than writes.
  //
  // A cursor, because a Collection's only own properties are `db`, `s` and
  // `client` — all objects the guard does replace. Sealed and not frozen
  // because the driver assigns `isClosed` on a live cursor during teardown,
  // so freezing one breaks the driver's own bookkeeping rather than testing
  // ours. Seal still sets `configurable: false`, which is the flag that
  // matters here.
  it('a locked handle still reports its primitive fields', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as {
      ro_things: { find(): object };
    };
    const cursor = proxy.ro_things.find();
    Object.seal(cursor);
    const d = Object.getOwnPropertyDescriptor(cursor, 'initialized') as
      | { value: boolean }
      | undefined;
    expect(d?.value).toBe(false);
  });

  // Object.keys/values/entries read the value through `get`, so they were
  // never the hole — pinned so a future change to the descriptor trap can't
  // quietly make them one.
  it('enumeration does not hand back a raw handle either', async () => {
    const proxy = makeDbProxy(roCtx()) as unknown as { ro_things: object };
    const bag = Object.values(proxy.ro_things).find(
      (v) => v !== null && typeof v === 'object' && 'db' in (v as object),
    ) as { db: { collection(n: string): { insertOne(d: unknown): Promise<unknown> } } };
    expect(() => bag.db.collection('ro_things').insertOne({ w: 1 })).toThrow(
      ReadOnlyConnectionError,
    );
    expect(await countRoThings({ w: 1 })).toBe(0);
  });

  it('the same connection NOT read-only is fully unaffected (regression)', async () => {
    const proxy = makeDbProxy({ currentDb: DB, client }) as unknown as TestDbProxy;
    const dbs = await proxy.admin().listDatabases();
    expect(dbs.databases.map((d: { name: string }) => d.name)).toContain(DB);
  });
});

/**
 * The cases above all run against `isReadOnly: () => true` — a flag that was
 * already set before the proxy existed. That fixture cannot express the
 * failure these cases cover, because the failure needs the reference to be
 * taken while the Connection is still writable.
 *
 * Every test here caches something first and flips afterwards. Accessing the
 * property after the flip is NOT the discriminator: that path was already
 * refused, so a test written that way passes against the bug.
 */
describe('makeDbProxy — a mid-run flip reaches references already handed out', () => {
  let client: MongoClient;
  let readOnly = false;

  beforeAll(async () => {
    const { host, port } = uriToHostPort(getSharedMongoUri());
    client = new MongoClient(`mongodb://${host}:${port}`);
    await client.connect();
    await client.db(DB).collection('flip_things').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  // The live flag the Connection's read-only state stands in for.
  const flipCtx = (): DbProxyCtx => ({
    currentDb: DB,
    client,
    isReadOnly: () => readOnly,
  });

  const countProbe = (probe: string): Promise<number> =>
    client.db(DB).collection('flip_things').countDocuments({ probe });

  it('a collection method cached while writable refuses after the flip', async () => {
    readOnly = false;
    const proxy = makeDbProxy(flipCtx()) as unknown as {
      flip_things: { insertOne(d: unknown): Promise<unknown> };
    };
    const insert = proxy.flip_things.insertOne;
    readOnly = true;
    expect(() => insert({ probe: 'coll' })).toThrow(ReadOnlyConnectionError);
    expect(await countProbe('coll')).toBe(0);
  });

  it('a direct Db method cached while writable refuses after the flip', async () => {
    readOnly = false;
    const proxy = makeDbProxy(flipCtx()) as unknown as {
      command(c: unknown): Promise<unknown>;
    };
    const cmd = proxy.command;
    readOnly = true;
    expect(() =>
      cmd({ insert: 'flip_things', documents: [{ probe: 'cmd' }] }),
    ).toThrow(ReadOnlyConnectionError);
    expect(await countProbe('cmd')).toBe(0);
  });

  it('an aggregate cached while writable still refuses a $out pipeline', async () => {
    readOnly = false;
    const proxy = makeDbProxy(flipCtx()) as unknown as {
      flip_things: { aggregate(p: unknown[]): CursorLike };
    };
    const agg = proxy.flip_things.aggregate;
    readOnly = true;
    expect(() => agg([{ $match: {} }, { $out: 'flip_out' }])).toThrow(
      ReadOnlyConnectionError,
    );
    expect(
      await client.db(DB).listCollections({ name: 'flip_out' }).toArray(),
    ).toHaveLength(0);
  });

  // `db.admin()` hands back a raw driver Admin. Denying the `admin()` call is
  // not enough when the object was taken before the flip — its `command` runs
  // against the driver directly.
  it('an Admin captured while writable refuses after the flip', async () => {
    readOnly = false;
    const proxy = makeDbProxy(flipCtx()) as unknown as {
      admin(): { command(c: unknown): Promise<unknown> };
    };
    const admin = proxy.admin();
    readOnly = true;
    expect(() =>
      admin.command({ insert: 'flip_things', documents: [{ probe: 'admin' }], $db: DB }),
    ).toThrow(ReadOnlyConnectionError);
    expect(await countProbe('admin')).toBe(0);
  });

  // A builder method returns its own receiver so calls chain, which is the
  // driver's documented idiom. Guarding only the object `initializeUnordered-
  // BulkOp()` handed back is not enough: the reference `insert()` returns is
  // the raw builder, and every call made on it bypasses the guard. Two
  // documents were written this way before the guard re-wrapped its returns.
  it('a builder reference captured mid-chain refuses after the flip', async () => {
    readOnly = false;
    const proxy = makeDbProxy(flipCtx()) as unknown as {
      flip_things: { initializeUnorderedBulkOp(): BulkLike };
    };
    const bulk = proxy.flip_things.initializeUnorderedBulkOp();
    const chained = bulk.insert({ probe: 'bulk' });
    readOnly = true;
    expect(() => chained.insert({ probe: 'bulk' })).toThrow(ReadOnlyConnectionError);
    expect(() => chained.execute()).toThrow(ReadOnlyConnectionError);
    expect(await countProbe('bulk')).toBe(0);
  });

  // Same state-bag escape, reached through a handle captured while writable
  // rather than through the collection proxy. `db.admin()`'s `s.db` is the
  // real Db.
  it('a captured handle does not leak an unguarded Db through its state bag', async () => {
    readOnly = false;
    const proxy = makeDbProxy(flipCtx()) as unknown as {
      admin(): { s: { db: { collection(n: string): { insertOne(d: unknown): Promise<unknown> } } } };
    };
    const rawDb = proxy.admin().s.db;
    readOnly = true;
    expect(() => rawDb.collection('flip_things').insertOne({ probe: 'bag' })).toThrow(
      ReadOnlyConnectionError,
    );
    expect(await countProbe('bag')).toBe(0);
  });

  // The other direction is live too, and deliberately so: the check reads the
  // flag at call time, so it has no way to stay stuck on a stale `true`.
  it('a reference denied under read-only works again once the Connection is writable', async () => {
    readOnly = true;
    const proxy = makeDbProxy(flipCtx()) as unknown as {
      flip_things: { insertOne(d: unknown): Promise<unknown> };
    };
    const insert = proxy.flip_things.insertOne;
    expect(() => insert({ probe: 'back' })).toThrow(ReadOnlyConnectionError);
    readOnly = false;
    await insert({ probe: 'back' });
    expect(await countProbe('back')).toBe(1);
    readOnly = false;
  });
});
