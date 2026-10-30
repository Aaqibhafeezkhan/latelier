import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { Binary, Collection, Decimal128, Double, Int32, Long, MongoClient, ObjectId, BSONRegExp } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { createRouter } from '../../electron/ipc/router';
import { registerDocChannels } from '../../electron/ipc/handlers/doc';
import { registerCollectionAdminChannels } from '../../electron/ipc/handlers/collectionAdmin';
import { registerAuditChannels } from '../../electron/ipc/handlers/audit';
import { registerQueryChannels } from '../../electron/ipc/handlers/query';
import { registerIndexChannels } from '../../electron/ipc/handlers/indexes';
import { registerUserChannels } from '../../electron/ipc/handlers/users';
import { registerScriptChannels } from '../../electron/ipc/handlers/script';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { DocumentService } from '../../electron/mongo/DocumentService';
import { CollectionAdminService } from '../../electron/mongo/CollectionAdminService';
import { QueryService } from '../../electron/mongo/QueryService';
import { IndexService } from '../../electron/mongo/IndexService';
import { UserService } from '../../electron/mongo/UserService';
import { ScriptService } from '../../electron/services/ScriptService';
import { createTestSpawner } from '../helpers/runnerSpawner';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { AuditRepo } from '../../electron/db/repositories/AuditRepo';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { AuditService } from '../../electron/services/AuditService';
import { UndoStore } from '../../electron/services/UndoStore';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import type { Logger } from '../../electron/log';
import { IPC_CHANNELS, type Envelope } from '../../shared/ipc';
import type { AuditEntry, UndoResult } from '../../shared/types';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb, createTempCipher } from '../helpers/db';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { getSharedMongoUri, uriToHostPort, makeConnection, makeReader } from '../helpers/mongo';

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

function seedConnectionRow(db: TempDb['db'], id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
     VALUES (?, ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
  ).run(id, `conn-${id}`, now, now);
}

function silentLogger() {
  const error = vi.fn<Logger['error']>();
  const warn = vi.fn<Logger['warn']>();
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn, error };
  return { log, error, warn };
}

// A value that exists only inside document bodies. If it ever shows up in an
// audit row, a summary has started persisting what it must not.
const BODY_MARKER = 'body-only-value-7f3a';

describe('audit log via the router', () => {
  let hp: { host: string; port: number };
  let client: MongoClient;
  let tmp: TempDb;
  let pool: MongoPool;
  let docSvc: DocumentService;
  let scriptSvc: ScriptService;
  let auditRepo: AuditRepo;
  let undoStore: UndoStore;
  let logSpy: ReturnType<typeof silentLogger>;
  let shim: ReturnType<typeof createShim>;
  let dbName: string;

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    client = await MongoClient.connect(getSharedMongoUri());
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(() => {
    tmp = createTempDb();
    for (const id of ['c1', 'c2', 'c-ro']) seedConnectionRow(tmp.db, id);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    pool = new MongoPool({
      repo: makeReader([
        makeConnection('c1', hp),
        makeConnection('c2', hp),
        makeConnection('c-ro', hp, { readOnly: true }),
      ]),
      vault,
    });
    logSpy = silentLogger();
    docSvc = new DocumentService(pool, { log: logSpy.log });
    scriptSvc = new ScriptService({ pool, spawner: createTestSpawner() });
    auditRepo = new AuditRepo(tmp.db, createTempCipher());
    undoStore = new UndoStore();
    shim = createShim();
    const auditSvc = new AuditService(auditRepo, pool, undoStore, logSpy.log);
    const router = createRouter(shim.ipcMain, testSenderCheck, logSpy.log, auditSvc);
    registerDocChannels(router, docSvc);
    registerCollectionAdminChannels(router, new CollectionAdminService(pool));
    registerAuditChannels(router, auditSvc);
    registerQueryChannels(
      router,
      new QueryService(pool, new RecentQueryService(new RecentQueryRepo(tmp.db, createTempCipher()))),
      async () => null,
    );
    registerIndexChannels(router, new IndexService(pool));
    registerUserChannels(router, new UserService(pool));
    registerScriptChannels(router, scriptSvc);
    dbName = `audit_${randomUUID().slice(0, 8)}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    docSvc.dispose();
    scriptSvc.cancelAll();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  async function ok<T>(channel: string, payload: unknown): Promise<T> {
    const env = await shim.invoke<T>(channel, payload);
    if (!env.ok) throw new Error(`${channel} failed: ${env.error.code} ${env.error.message}`);
    return env.data;
  }

  async function list(input: Record<string, unknown> = {}): Promise<AuditEntry[]> {
    return ok<AuditEntry[]>(IPC_CHANNELS.auditList, { connectionId: 'c1', ...input });
  }

  function rowCount(): number {
    return (tmp.db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
  }

  const target = (collection: string) => ({ connectionId: 'c1', dbName, collection });

  it('each audited channel writes one row with its op, namespace, outcome and duration', async () => {
    const envelopes: unknown[] = [];
    const okAndKeep = async <T,>(channel: string, payload: unknown): Promise<T> => {
      const data = await ok<T>(channel, payload);
      envelopes.push(data);
      return data;
    };
    await okAndKeep(IPC_CHANNELS.docInsertMany, {
      ...target('orders'),
      docsJson: JSON.stringify([
        { _id: 1, note: BODY_MARKER },
        { _id: 2, note: BODY_MARKER },
        { _id: 3, note: BODY_MARKER },
      ]),
    });
    await okAndKeep(IPC_CHANNELS.docUpdateOne, {
      ...target('orders'),
      filterJson: '{"_id":1}',
      updateJson: JSON.stringify({ $set: { note: `${BODY_MARKER}-2` } }),
    });
    const { confirmToken: updateManyToken } = await ok<{ confirmToken: string }>(
      IPC_CHANNELS.docConfirmUpdateMany,
      { ...target('orders'), filterJson: '{"_id":{"$gte":2}}', updateJson: JSON.stringify({ $set: { note: `${BODY_MARKER}-3` } }) },
    );
    await ok(IPC_CHANNELS.docUpdateMany, {
      ...target('orders'),
      filterJson: '{"_id":{"$gte":2}}',
      updateJson: JSON.stringify({ $set: { note: `${BODY_MARKER}-3` } }),
      confirmToken: updateManyToken,
    });
    await okAndKeep(IPC_CHANNELS.docDeleteOne, { ...target('orders'), filterJson: '{"_id":2}' });
    const { confirmToken } = await ok<{ confirmToken: string }>(IPC_CHANNELS.docConfirmDeleteMany, {
      ...target('orders'),
      filterJson: '{"_id":{"$gte":1}}',
    });
    await ok(IPC_CHANNELS.docDeleteMany, { ...target('orders'), filterJson: '{"_id":{"$gte":1}}', confirmToken });
    await client.db(dbName).collection('scratch').insertOne({ a: 1 });
    await ok(IPC_CHANNELS.collectionRename, { ...target('scratch'), newName: 'scratch2' });
    await ok(IPC_CHANNELS.collectionDrop, target('scratch2'));
    await ok(IPC_CHANNELS.databaseDrop, { connectionId: 'c1', dbName });

    const entries = (await list()).reverse();
    expect(entries.map((e) => e.op)).toEqual([
      'insertMany',
      'updateOne',
      'updateMany',
      'deleteOne',
      'deleteMany',
      'collectionRename',
      'collectionDrop',
      'databaseDrop',
    ]);
    expect(entries.map((e) => e.summary)).toEqual([
      { op: 'insertMany', insertedCount: 3 },
      { op: 'updateOne', filter: '{"_id":1}', matchedCount: 1, modifiedCount: 1 },
      { op: 'updateMany', filter: '{"_id":{"$gte":2}}', matchedCount: 2, modifiedCount: 2 },
      { op: 'deleteOne', filter: '{"_id":2}', deletedCount: 1 },
      { op: 'deleteMany', filter: '{"_id":{"$gte":1}}', deletedCount: 2 },
      { op: 'collectionRename', fromName: 'scratch', toName: 'scratch2' },
      { op: 'collectionDrop' },
      { op: 'databaseDrop' },
    ]);
    expect(entries.map((e) => e.collection)).toEqual([
      'orders', 'orders', 'orders', 'orders', 'orders', 'scratch', 'scratch2', null,
    ]);
    // Every write op keeps a Pre-image under X13's bounds; the two drops
    // never capture one.
    expect(entries.map((e) => e.reversible)).toEqual([true, true, true, true, true, true, false, false]);
    for (const e of entries) {
      expect(e).toMatchObject({ connectionId: 'c1', dbName, outcome: 'ok' });
      expect(e.errorCode).toBeUndefined();
      expect(Number.isInteger(e.durationMs) && e.durationMs >= 0).toBe(true);
      expect(Number.isNaN(Date.parse(e.ranAt))).toBe(false);
    }
    // Document bodies live only in `undo_json`, never in the durable record
    // and never in what the renderer receives.
    const raw = tmp.db
      .prepare('SELECT id, db_name, collection, op, summary_json, outcome, error_code, ran_at FROM audit_log')
      .all();
    expect(JSON.stringify(raw)).not.toContain(BODY_MARKER);
    expect(tmp.db.prepare('SELECT DISTINCT typeof(summary_json) AS t FROM audit_log').all()).toEqual([{ t: 'blob' }]);
    expect(JSON.stringify(envelopes)).not.toContain(BODY_MARKER);
    expect(JSON.stringify(await list())).not.toContain(BODY_MARKER);
    expect(JSON.stringify(raw)).not.toContain(confirmToken);
    expect(JSON.stringify(raw)).not.toContain(updateManyToken);
  });

  it('channels outside the audit table write no rows, even when they change data', async () => {
    const coll = target('things');
    await ok(IPC_CHANNELS.docInsert, { ...coll, docJson: '{"_id":1,"a":1}' });
    await ok(IPC_CHANNELS.queryFind, { ...coll, filter: '{}', limit: 10, skip: 0 });
    await ok(IPC_CHANNELS.docConfirmDeleteMany, { ...coll, filterJson: '{}' });
    await ok(IPC_CHANNELS.docConfirmUpdateMany, { ...coll, filterJson: '{}', updateJson: '{"$set":{"a":1}}' });
    await ok(IPC_CHANNELS.indexCreate, { ...coll, fields: [{ field: 'a', direction: 1 }], options: { name: 'a_1' } });
    await ok(IPC_CHANNELS.indexDrop, { ...coll, name: 'a_1' });
    await ok(IPC_CHANNELS.userCreate, {
      connectionId: 'c1',
      dbName,
      username: 'auditee',
      password: 'pw-not-for-the-log',
      roles: [{ role: 'read', db: dbName }],
    });
    await ok(IPC_CHANNELS.scriptRun, { connectionId: 'c1', dbName, source: 'db.things.deleteMany({})' });

    expect(rowCount()).toBe(0);
  });

  it('records a refused Operation as an error with its code, never reversible', async () => {
    const env = await shim.invoke(IPC_CHANNELS.docDeleteOne, {
      connectionId: 'c-ro',
      dbName,
      collection: 'orders',
      filterJson: '{"_id":1}',
    });
    expect(env.ok).toBe(false);

    const [entry] = await list({ connectionId: 'c-ro' });
    expect(entry).toMatchObject({
      op: 'deleteOne',
      outcome: 'error',
      errorCode: 'READ_ONLY',
      reversible: false,
      summary: { op: 'deleteOne', filter: '{"_id":1}' },
    });
    expect(entry!.summary).not.toHaveProperty('deletedCount');
  });

  it('records a failure the service raises after the schema passed, but not a payload the schema rejects', async () => {
    const refused = await shim.invoke(IPC_CHANNELS.docDeleteOne, { ...target('orders'), filterJson: '{}' });
    expect(refused.ok).toBe(false);
    const malformed = await shim.invoke(IPC_CHANNELS.docDeleteOne, { ...target('orders') });
    expect(malformed.ok).toBe(false);

    const entries = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'error', errorCode: 'VALIDATION' });
  });

  it('records a part-applied insertMany as partial with its inserted count', async () => {
    // Ten documents; the fourth repeats the first document's `_id`.
    const docs = Array.from({ length: 10 }, (_, i) => ({ _id: i === 3 ? 0 : i }));
    const env = await shim.invoke(IPC_CHANNELS.docInsertMany, { ...target('orders'), docsJson: JSON.stringify(docs) });
    expect(env.ok).toBe(false);
    expect(await client.db(dbName).collection('orders').countDocuments()).toBe(3);

    const [entry] = await list();
    expect(entry).toMatchObject({
      op: 'insertMany',
      outcome: 'partial',
      reversible: false,
      summary: { op: 'insertMany', insertedCount: 3 },
    });
    expect(entry!.errorCode).toBe(env.ok ? undefined : env.error.code);
  });

  it('records an insertMany that failed on its first document as an error, not a partial', async () => {
    await client.db(dbName).collection<{ _id: number }>('orders').insertOne({ _id: 1 });
    await shim.invoke(IPC_CHANNELS.docInsertMany, { ...target('orders'), docsJson: '[{"_id":1},{"_id":2}]' });

    const [entry] = await list();
    expect(entry).toMatchObject({ outcome: 'error', summary: { op: 'insertMany', insertedCount: 0 } });
  });

  it('records an updateOne that matched nothing as ok with matched 0', async () => {
    await ok(IPC_CHANNELS.docUpdateOne, {
      ...target('orders'),
      filterJson: '{"_id":"missing"}',
      updateJson: '{"$set":{"a":1}}',
    });

    const [entry] = await list();
    expect(entry).toMatchObject({
      outcome: 'ok',
      reversible: false,
      summary: { op: 'updateOne', matchedCount: 0, modifiedCount: 0 },
    });
  });

  it('an audit write that throws leaves the Operation succeeded and logs the loss', async () => {
    await client.db(dbName).collection<{ _id: number }>('orders').insertOne({ _id: 1 });
    vi.spyOn(auditRepo, 'insert').mockImplementation(() => {
      throw new Error('disk full');
    });

    const env = await shim.invoke(IPC_CHANNELS.docDeleteOne, { ...target('orders'), filterJson: '{"_id":1}' });

    expect(env).toEqual({ ok: true, data: { deletedCount: 1 } });
    expect(await client.db(dbName).collection('orders').countDocuments()).toBe(0);
    expect(logSpy.error).toHaveBeenCalledWith('audit.write', IPC_CHANNELS.docDeleteOne, { message: 'disk full' });
  });

  describe('audit:list', () => {
    function seed(id: string, over: { connectionId?: string; dbName?: string; collection?: string; ranAt: string }) {
      auditRepo.insert({
        id,
        connection_id: over.connectionId ?? 'c1',
        db_name: over.dbName ?? 'shop',
        collection: over.collection ?? 'orders',
        op: 'deleteOne',
        summary_json: '{"op":"deleteOne","filter":"{}"}',
        outcome: 'ok',
        error_code: null,
        ran_at: over.ranAt,
        duration_ms: 1,
        reversible: 0,
        undone_at: null,
      });
    }

    beforeEach(() => {
      seed('a', { ranAt: '2026-01-01T00:00:01.000Z' });
      seed('b', { ranAt: '2026-01-01T00:00:02.000Z', collection: 'users' });
      seed('c', { ranAt: '2026-01-01T00:00:03.000Z', dbName: 'crm' });
      seed('d', { ranAt: '2026-01-01T00:00:04.000Z' });
      seed('other', { ranAt: '2026-01-01T00:00:05.000Z', connectionId: 'c2' });
      tmp.db.prepare('UPDATE audit_log SET reversible = 1').run();
      for (const id of ['a', 'b', 'c', 'd', 'other']) undoStore.put(id, id === 'other' ? 'c2' : 'c1', '{"preImage":1}');
    });

    it('lists one Connection newest-first', async () => {
      expect((await list()).map((e) => e.id)).toEqual(['d', 'c', 'b', 'a']);
    });

    it('filters by database and collection', async () => {
      expect((await list({ dbName: 'shop' })).map((e) => e.id)).toEqual(['d', 'b', 'a']);
      expect((await list({ dbName: 'shop', collection: 'orders' })).map((e) => e.id)).toEqual(['d', 'a']);
    });

    it('honours limit and the before cursor', async () => {
      expect((await list({ limit: 2 })).map((e) => e.id)).toEqual(['d', 'c']);
      expect((await list({ before: '2026-01-01T00:00:03.000Z' })).map((e) => e.id)).toEqual(['b', 'a']);
    });

    it('never returns the Pre-image', async () => {
      const entries = await list();
      expect(entries[0]!.reversible).toBe(true);
      for (const e of entries) {
        expect(Object.keys(e)).not.toContain('undo_json');
        expect(Object.keys(e)).not.toContain('undoJson');
        expect(JSON.stringify(e)).not.toContain('preImage');
      }
    });

    it('rejects a list without a connection', async () => {
      const env = await shim.invoke(IPC_CHANNELS.auditList, {});
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    });

    it('deleting a Connection removes its rows and no other Connection\'s', () => {
      new ConnectionRepo(tmp.db).deleteById('c1');
      const left = tmp.db.prepare('SELECT id FROM audit_log').all() as { id: string }[];
      expect(left.map((r) => r.id)).toEqual(['other']);
    });
  });

  describe('audit:undo', () => {
    const orders = () =>
      client.db(dbName).collection<{ _id: ObjectId | number | { k: number }; [k: string]: unknown }>('orders');
    // Raw BSON bytes: "restored exactly" means the same bytes, not a
    // document that merely compares equal after type promotion.
    const rawDoc = async (id: ObjectId) =>
      (await orders().findOne({ _id: id }, { raw: true })) as unknown as Uint8Array;

    async function undo(entryId: string): Promise<Envelope<UndoResult>> {
      return shim.invoke<UndoResult>(IPC_CHANNELS.auditUndo, { entryId });
    }

    async function undoError(entryId: string): Promise<string> {
      const env = await undo(entryId);
      if (env.ok) throw new Error('expected audit:undo to fail');
      return env.error.code;
    }

    async function updateOne(id: unknown, set: Record<string, unknown>) {
      return ok<{ matchedCount: number; auditId?: string }>(IPC_CHANNELS.docUpdateOne, {
        ...target('orders'),
        filterJson: JSON.stringify({ _id: id }),
        updateJson: JSON.stringify({ $set: set }),
      });
    }

    // Every BSON type the default driver promotion would silently change on
    // a read-then-reinsert: Double → Int32, Long → number, regex flags.
    const typed = () => ({
      _id: new ObjectId(),
      dbl: new Double(5),
      int: new Int32(7),
      long: Long.fromString('9007199254740993'),
      dec: Decimal128.fromString('1.10'),
      at: new Date('2026-01-02T03:04:05.678Z'),
      re: new BSONRegExp('^a', 'imx'),
      bin: new Binary(Buffer.from('xyz'), 0x80),
      uuid: new Binary(Buffer.alloc(16, 7), Binary.SUBTYPE_UUID),
      nested: { b: 2, a: [1, 'two', { c: null }] },
    });

    it('undoes a deleteOne by putting the exact document back', async () => {
      const doc = typed();
      await orders().insertOne(doc);
      const before = await rawDoc(doc._id);

      const deleted = await ok<{ deletedCount: number; auditId?: string }>(IPC_CHANNELS.docDeleteOne, {
        ...target('orders'),
        filterJson: JSON.stringify({ _id: { $oid: doc._id.toHexString() } }),
      });
      expect(deleted.deletedCount).toBe(1);
      expect(typeof deleted.auditId).toBe('string');
      expect(await orders().countDocuments()).toBe(0);

      const rowsBefore = rowCount();
      expect(await undo(deleted.auditId!)).toEqual({ ok: true, data: { restored: 1, skipped: 0 } });
      expect(Buffer.compare(await rawDoc(doc._id), before)).toBe(0);
      // The Undo is not an Operation of its own.
      expect(rowCount()).toBe(rowsBefore);
      const [entry] = await list();
      expect(entry).toMatchObject({ id: deleted.auditId, reversible: false });
      expect(Number.isNaN(Date.parse(entry!.undoneAt ?? ''))).toBe(false);
    });

    it('undoes an updateOne back to its Pre-image exactly', async () => {
      const doc = typed();
      await orders().insertOne(doc);
      const before = await rawDoc(doc._id);

      const res = await ok<{ matchedCount: number; auditId?: string }>(IPC_CHANNELS.docUpdateOne, {
        ...target('orders'),
        filterJson: JSON.stringify({ _id: { $oid: doc._id.toHexString() } }),
        updateJson: '{"$set":{"dbl":"changed"},"$unset":{"re":""}}',
      });
      expect(res.matchedCount).toBe(1);

      expect((await undo(res.auditId!)).ok).toBe(true);
      expect(Buffer.compare(await rawDoc(doc._id), before)).toBe(0);
    });

    it('refuses to undo an update once the document changed again, and unwinds in reverse order', async () => {
      await orders().insertOne({ _id: 1, v: 0 });
      const first = await updateOne(1, { v: 1 });
      const second = await updateOne(1, { v: 2 });

      expect(await undoError(first.auditId!)).toBe('AUDIT_TARGET_CHANGED');
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 2 });
      const [, firstEntry] = await list();
      expect(firstEntry).toMatchObject({ id: first.auditId, reversible: true });
      expect(firstEntry!.undoneAt).toBeUndefined();

      expect((await undo(second.auditId!)).ok).toBe(true);
      expect((await undo(first.auditId!)).ok).toBe(true);
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 0 });
    });

    it('refuses to undo an update whose document was deleted since', async () => {
      await orders().insertOne({ _id: 1, v: 0 });
      const res = await updateOne(1, { v: 1 });
      await orders().deleteOne({ _id: 1 });

      expect(await undoError(res.auditId!)).toBe('AUDIT_TARGET_CHANGED');
      expect(await orders().countDocuments()).toBe(0);
    });

    it('refuses a second undo of the same entry without writing again', async () => {
      await orders().insertOne({ _id: 1, v: 0 });
      const res = await updateOne(1, { v: 1 });
      expect((await undo(res.auditId!)).ok).toBe(true);
      const replace = vi.spyOn(Collection.prototype, 'replaceOne');

      expect(await undoError(res.auditId!)).toBe('AUDIT_ALREADY_UNDONE');
      expect(replace).not.toHaveBeenCalled();
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 0 });
    });

    it('refuses to undo an Operation that kept no Pre-image', async () => {
      await orders().insertOne({ _id: 1 });
      await ok(IPC_CHANNELS.collectionDrop, target('orders'));
      const [entry] = await list();

      expect(entry!.op).toBe('collectionDrop');
      expect(await undoError(entry!.id)).toBe('AUDIT_NOT_REVERSIBLE');
    });

    it('refuses to undo after a restart, and lists the entry as no longer undoable', async () => {
      await orders().insertOne({ _id: 1 });
      const res = await ok<{ auditId?: string }>(IPC_CHANNELS.docDeleteOne, { ...target('orders'), filterJson: '{"_id":1}' });
      expect((await list())[0]!.reversible).toBe(true);

      // A restart: the same database, a service with nothing in memory.
      const restarted = new AuditService(auditRepo, pool, new UndoStore(), logSpy.log);
      const [entry] = restarted.list({ connectionId: 'c1' });
      expect(entry).toMatchObject({ id: res.auditId, op: 'deleteOne', reversible: false });
      await expect(restarted.undo({ entryId: res.auditId! })).rejects.toMatchObject({ code: 'AUDIT_UNDO_EXPIRED' });
      expect(await orders().countDocuments()).toBe(0);
    });

    it('never writes a Pre-image to disk, and still undoes in-session, for every reversible Operation', async () => {
      const undoJsonRows = () =>
        tmp.db.prepare('SELECT op, reversible, undo_json FROM audit_log ORDER BY rowid').all() as {
          op: string;
          reversible: number;
          undo_json: string | null;
        }[];
      await orders().insertMany([{ _id: 1, v: BODY_MARKER }, { _id: 2, v: BODY_MARKER }, { _id: 3, v: BODY_MARKER }]);
      const one = await updateOne(1, { v: `${BODY_MARKER}-edited` });
      const many = await confirmedUpdateMany('{"_id":{"$gte":2}}', `{"$set":{"v":"${BODY_MARKER}-many"}}`);
      const ins = await ok<{ auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ _id: 10, v: BODY_MARKER }]),
      });
      const del = await ok<{ auditId?: string }>(IPC_CHANNELS.docDeleteOne, { ...target('orders'), filterJson: '{"_id":10}' });
      const bulk = await deleteManyAll();

      const rows = undoJsonRows();
      expect(rows.map((r) => r.op)).toEqual(['updateOne', 'updateMany', 'insertMany', 'deleteOne', 'deleteMany']);
      expect(rows.every((r) => r.reversible === 1)).toBe(true);
      expect(rows.every((r) => r.undo_json === null)).toBe(true);
      // The capture exists only in memory, and Undo still runs from it.
      for (const id of [one.auditId, many.auditId, ins.auditId, del.auditId, bulk.auditId]) {
        expect(id).toEqual(expect.any(String));
        expect(undoStore.has(id!)).toBe(true);
      }
      expect(await undo(bulk.auditId!)).toMatchObject({ ok: true });
      expect(await undo(del.auditId!)).toMatchObject({ ok: true });
      expect(await undo(ins.auditId!)).toMatchObject({ ok: true });
      expect(await undo(many.auditId!)).toMatchObject({ ok: true });
      expect(await undo(one.auditId!)).toMatchObject({ ok: true });
      expect(await orders().find().sort({ _id: 1 }).toArray()).toEqual([
        { _id: 1, v: BODY_MARKER },
        { _id: 2, v: BODY_MARKER },
        { _id: 3, v: BODY_MARKER },
      ]);
      expect(undoJsonRows().every((r) => r.undo_json === null)).toBe(true);
      // A spent Pre-image is released from memory too.
      expect(undoStore.has(one.auditId!)).toBe(false);
    });

    it('surfaces CONFLICT when the deleted _id exists again', async () => {
      await orders().insertOne({ _id: 1, v: 'old' });
      const res = await ok<{ auditId?: string }>(IPC_CHANNELS.docDeleteOne, { ...target('orders'), filterJson: '{"_id":1}' });
      await orders().insertOne({ _id: 1, v: 'new' });

      expect(await undoError(res.auditId!)).toBe('CONFLICT');
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 'new' });
      expect((await list())[0]!.undoneAt).toBeUndefined();
    });

    it('refuses on a Connection that is read-only now', async () => {
      auditRepo.insert({
        id: 'ro-entry',
        connection_id: 'c-ro',
        db_name: dbName,
        collection: 'orders',
        op: 'deleteOne',
        summary_json: '{"op":"deleteOne","filter":"{}"}',
        outcome: 'ok',
        error_code: null,
        ran_at: new Date().toISOString(),
        duration_ms: 1,
        reversible: 1,
        undone_at: null,
      });
      undoStore.put('ro-entry', 'c-ro', '{"preImage":{"_id":1}}');

      expect(await undoError('ro-entry')).toBe('READ_ONLY');
      expect(await orders().countDocuments()).toBe(0);
    });

    it('answers NOT_FOUND for an unknown entry', async () => {
      expect(await undoError('no-such-entry')).toBe('NOT_FOUND');
    });

    /**
     * Runs `write` from another client right after the next call to `method`
     * returns — the gap between two steps of a capture.
     */
    function interleaveAfter(method: 'findOne' | 'findOneAndUpdate', write: () => Promise<unknown>) {
      const original = Collection.prototype[method] as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(Collection.prototype, method).mockImplementationOnce(async function (
        this: Collection,
        ...args: unknown[]
      ) {
        const result = await original.apply(this, args);
        await write();
        return result;
      } as never);
    }

    it('a write from another client right after the update is not overwritten by Undo', async () => {
      await orders().insertOne({ _id: 1, v: 0, other: 'a' });
      interleaveAfter('findOneAndUpdate', () => orders().updateOne({ _id: 1 }, { $set: { other: 'theirs' } }));

      const res = await updateOne(1, { v: 1 });

      expect(await undoError(res.auditId!)).toBe('AUDIT_TARGET_CHANGED');
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 1, other: 'theirs' });
    });

    it('a write from another client between the Pre-image read and the update costs the Undo, not the update', async () => {
      await orders().insertOne({ _id: 1, v: 0, other: 'a' });
      interleaveAfter('findOne', () => orders().updateOne({ _id: 1 }, { $set: { other: 'theirs' } }));

      const res = await updateOne(1, { v: 1 });

      expect(res).toEqual({ matchedCount: 1, modifiedCount: 1 });
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 1, other: 'theirs' });
      expect((await list())[0]).toMatchObject({ outcome: 'ok', reversible: false });
    });

    it('an update that changes nothing reports modified 0 and still undoes cleanly', async () => {
      await orders().insertOne({ _id: 1, v: 1 });

      const res = await updateOne(1, { v: 1 });

      expect(res).toMatchObject({ matchedCount: 1, modifiedCount: 0 });
      expect((await undo(res.auditId!)).ok).toBe(true);
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 1 });
    });

    it('a Pre-image too large to pin the write to still updates, offering no Undo', async () => {
      await orders().insertOne({ _id: 1, v: 0, blob: 'x'.repeat(5 * 1024 * 1024) });

      const res = await updateOne(1, { v: 1 });

      expect(res).toEqual({ matchedCount: 1, modifiedCount: 1 });
      expect((await orders().findOne({ _id: 1 }, { projection: { v: 1 } }))).toEqual({ _id: 1, v: 1 });
      expect((await list())[0]).toMatchObject({ outcome: 'ok', reversible: false });
    });

    it('a failed Pre-image read still runs the update, offering no Undo', async () => {
      await orders().insertOne({ _id: 1, v: 0 });
      vi.spyOn(Collection.prototype, 'findOne').mockRejectedValueOnce(new Error('read refused'));

      const res = await updateOne(1, { v: 1 });

      expect(res).toEqual({ matchedCount: 1, modifiedCount: 1 });
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 1 });
      expect((await list())[0]).toMatchObject({ outcome: 'ok', reversible: false });
      expect(logSpy.warn).toHaveBeenCalledWith('audit.capture', expect.any(String), { message: 'read refused' });
    });

    it('offers no Undo for a document whose Pre-image would not read back, and still deletes it', async () => {
      // A UUID-subtype Binary must be 16 bytes; the server stores a short one,
      // but the EJSON reviver refuses it, so an Undo could only ever fail.
      await orders().insertOne({ _id: 1, bad: new Binary(Buffer.from('xyz'), Binary.SUBTYPE_UUID) });

      const res = await ok<{ deletedCount: number; auditId?: string }>(IPC_CHANNELS.docDeleteOne, {
        ...target('orders'),
        filterJson: '{"_id":1}',
      });

      expect(res).toEqual({ deletedCount: 1 });
      expect(await orders().countDocuments()).toBe(0);
      expect((await list())[0]).toMatchObject({ outcome: 'ok', reversible: false });
      expect(logSpy.warn).toHaveBeenCalledWith('audit.capture', expect.any(String), expect.anything());
    });

    it('offers no Undo for an update or delete that matched nothing', async () => {
      const upd = await updateOne('missing', { v: 1 });
      const del = await ok<{ deletedCount: number }>(IPC_CHANNELS.docDeleteOne, {
        ...target('orders'),
        filterJson: '{"_id":"missing"}',
      });

      expect(upd).toEqual({ matchedCount: 0, modifiedCount: 0 });
      expect(del).toEqual({ deletedCount: 0 });
      expect((await list()).map((e) => e.reversible)).toEqual([false, false]);
    });

    async function deleteManyAll(): Promise<{ deletedCount: number; auditId?: string }> {
      const { confirmToken } = await ok<{ confirmToken: string }>(IPC_CHANNELS.docConfirmDeleteMany, {
        ...target('orders'),
        filterJson: '{}',
      });
      return ok(IPC_CHANNELS.docDeleteMany, { ...target('orders'), filterJson: '{}', confirmToken });
    }

    it('deleteMany matching 1001 documents deletes all of them and keeps no Pre-image', async () => {
      await orders().insertMany(Array.from({ length: 1001 }, (_, i) => ({ _id: i })));

      const res = await deleteManyAll();
      expect(res.deletedCount).toBe(1001);
      expect(res.auditId).toBeUndefined();
      expect(await orders().countDocuments()).toBe(0);
      expect((await list())[0]).toMatchObject({ op: 'deleteMany', reversible: false });
    });

    it('deleteMany over the byte ceiling still deletes and keeps no Pre-image', async () => {
      await orders().insertMany(
        Array.from({ length: 20 }, (_, i) => ({ _id: i, blob: 'x'.repeat(100_000) })),
      );

      const res = await deleteManyAll();
      expect(res.deletedCount).toBe(20);
      expect(res.auditId).toBeUndefined();
      expect((await list())[0]).toMatchObject({ op: 'deleteMany', reversible: false });
    });

    it('deleteMany under both ceilings undoes to the original document set, byte-identically', async () => {
      const docs = [typed(), typed(), typed()];
      await orders().insertMany(docs);
      const before = await Promise.all(docs.map((d) => rawDoc(d._id)));

      const res = await deleteManyAll();
      expect(res.deletedCount).toBe(3);
      expect(typeof res.auditId).toBe('string');
      expect(await orders().countDocuments()).toBe(0);

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 3, skipped: 0 } });
      const after = await Promise.all(docs.map((d) => rawDoc(d._id)));
      for (let i = 0; i < docs.length; i++) expect(Buffer.compare(after[i]!, before[i]!)).toBe(0);
    });

    it('deleteMany undo restores the rest and skips a document whose _id exists again', async () => {
      await orders().insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
      const res = await deleteManyAll();
      await orders().insertOne({ _id: 2, v: 'recreated' });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 2, skipped: 1 } });
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1 });
      expect(await orders().findOne({ _id: 3 })).toEqual({ _id: 3 });
      expect(await orders().findOne({ _id: 2 })).toEqual({ _id: 2, v: 'recreated' });
    });

    it('deleteMany undo does not count a non-duplicate-key write failure as skipped', async () => {
      await orders().insertMany([{ _id: 1, v: 0 }, { _id: 2, v: 0 }]);
      const res = await deleteManyAll();
      // A validator added since the delete rejects `v: 0` — a write failure
      // that is NOT a reused `_id`, so it must not be folded into `skipped`
      // the way a genuine 11000 duplicate-key failure is.
      await client.db(dbName).command({
        collMod: 'orders',
        validator: { v: { $ne: 0 } },
        validationLevel: 'strict',
      });

      expect(await undoError(res.auditId!)).toBe('VALIDATION');
      expect(await orders().countDocuments()).toBe(0);
      const [entry] = await list();
      expect(entry).toMatchObject({ id: res.auditId, reversible: true });
      expect(entry!.undoneAt).toBeUndefined();
    });

    it('insertMany undo deletes exactly the inserted ids, leaving a similar pre-existing document', async () => {
      await orders().insertOne({ _id: 0, note: 'pre-existing' });
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ _id: 1 }, { _id: 2 }]),
      });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 2, skipped: 0 } });
      expect(await orders().countDocuments()).toBe(1);
      expect(await orders().findOne({ _id: 0 })).toEqual({ _id: 0, note: 'pre-existing' });
    });

    it('insertMany undo skips ids already removed since', async () => {
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ _id: 1 }, { _id: 2 }]),
      });
      await orders().deleteOne({ _id: 1 });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 1, skipped: 1 } });
      expect(await orders().countDocuments()).toBe(0);
    });

    it('insertMany undo removes every document when none were changed since', async () => {
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ _id: 1, v: 'a' }, { _id: 2, v: 'b' }, { _id: 3, v: 'c' }]),
      });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 3, skipped: 0 } });
      expect(await orders().countDocuments()).toBe(0);
    });

    it('insertMany undo leaves an edited document alone and reports it skipped', async () => {
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ _id: 1, v: 'original' }, { _id: 2, v: 'original' }]),
      });
      await orders().updateOne({ _id: 1 }, { $set: { v: 'edited-since' } });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 1, skipped: 1 } });
      // The edited document survives Undo untouched — undoing an insert must
      // never discard an edit it didn't know about.
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 'edited-since' });
      expect(await orders().findOne({ _id: 2 })).toBeNull();
    });

    it('insertMany undo removes documents inserted without an _id or with _id not first', async () => {
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ v: 'no-id' }, { v: 'id-last', _id: 7 }]),
      });
      expect(await orders().countDocuments()).toBe(2);

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 2, skipped: 0 } });
      expect(await orders().countDocuments()).toBe(0);
    });

    it('insertMany undo removes a document holding an integer past int32 (stored as a double)', async () => {
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ _id: 1, at: 1700000000000 }, { _id: 2, at: 5 }]),
      });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 2, skipped: 0 } });
      expect(await orders().countDocuments()).toBe(0);
    });

    it('insertMany undo keeps a document another client edits between its read and its delete', async () => {
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify([{ _id: 1, v: 'original' }, { _id: 2, v: 'original' }]),
      });
      // Undo has already read both documents and found them unchanged when
      // this edit lands, just before its delete goes out.
      const original = Collection.prototype.bulkWrite;
      vi.spyOn(Collection.prototype, 'bulkWrite').mockImplementationOnce(async function (
        this: Collection,
        ...args: Parameters<Collection['bulkWrite']>
      ) {
        await orders().updateOne({ _id: 1 }, { $set: { v: 'edited-mid-undo' } });
        return original.apply(this, args);
      });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 1, skipped: 1 } });
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 'edited-mid-undo' });
      expect(await orders().findOne({ _id: 2 })).toBeNull();
    });

    it('insertMany over the bulk capture ceiling is not reversible', async () => {
      const docs = Array.from({ length: 1001 }, (_, i) => ({ _id: i }));
      const res = await ok<{ insertedCount: number; auditId?: string }>(IPC_CHANNELS.docInsertMany, {
        ...target('orders'),
        docsJson: JSON.stringify(docs),
      });

      expect(res.insertedCount).toBe(1001);
      expect(res.auditId).toBeUndefined();
      expect((await list())[0]).toMatchObject({ op: 'insertMany', reversible: false });
    });

    async function confirmedUpdateMany(filterJson: string, updateJson: string) {
      const { confirmToken } = await ok<{ confirmToken: string }>(IPC_CHANNELS.docConfirmUpdateMany, {
        ...target('orders'),
        filterJson,
        updateJson,
      });
      return ok<{ matchedCount: number; auditId?: string }>(IPC_CHANNELS.docUpdateMany, {
        ...target('orders'),
        filterJson,
        updateJson,
        confirmToken,
      });
    }

    it('updateMany undoes every matched document back to its Pre-image', async () => {
      await orders().insertMany([{ _id: 1, v: 0 }, { _id: 2, v: 0 }]);
      const res = await confirmedUpdateMany('{}', '{"$set":{"v":1}}');
      expect(res.matchedCount).toBe(2);

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 2, skipped: 0 } });
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 0 });
      expect(await orders().findOne({ _id: 2 })).toEqual({ _id: 2, v: 0 });
    });

    it('updateMany undo skips a document changed again, restores the rest', async () => {
      await orders().insertMany([{ _id: 1, v: 0 }, { _id: 2, v: 0 }]);
      const res = await confirmedUpdateMany('{}', '{"$set":{"v":1}}');
      await updateOne(2, { v: 2 });

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 1, skipped: 1 } });
      expect(await orders().findOne({ _id: 1 })).toEqual({ _id: 1, v: 0 });
      expect(await orders().findOne({ _id: 2 })).toEqual({ _id: 2, v: 2 });
    });

    it('updateMany undoes documents with non-scalar _ids without pairing the wrong Pre-image to the wrong document', async () => {
      // `String(_id)` collides both of these to the same key
      // ("[object Object]"); undo must pair each Pre-image with its own
      // document, not whichever post-image the collision left in the map.
      await orders().insertMany([
        { _id: { k: 1 }, v: 0 },
        { _id: { k: 2 }, v: 0 },
      ]);
      const res = await confirmedUpdateMany('{}', '{"$set":{"v":1}}');
      expect(res.matchedCount).toBe(2);

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 2, skipped: 0 } });
      expect(await orders().findOne({ _id: { k: 1 } })).toEqual({ _id: { k: 1 }, v: 0 });
      expect(await orders().findOne({ _id: { k: 2 } })).toEqual({ _id: { k: 2 }, v: 0 });
    });

    it('collectionRename undo restores the original name', async () => {
      await client.db(dbName).collection('renameme').insertOne({ a: 1 });
      const res = await ok<{ name: string; auditId?: string }>(IPC_CHANNELS.collectionRename, {
        ...target('renameme'),
        newName: 'renamed',
      });
      expect(typeof res.auditId).toBe('string');

      expect(await undo(res.auditId!)).toEqual({ ok: true, data: { restored: 1, skipped: 0 } });
      const names = (await client.db(dbName).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
      expect(names).toContain('renameme');
      expect(names).not.toContain('renamed');
    });

    it('collectionRename undo surfaces the driver error when a collection already holds the old name', async () => {
      await client.db(dbName).collection('renameme').insertOne({ a: 1 });
      const res = await ok<{ name: string; auditId?: string }>(IPC_CHANNELS.collectionRename, {
        ...target('renameme'),
        newName: 'renamed',
      });
      await client.db(dbName).createCollection('renameme');

      expect(await undoError(res.auditId!)).toBe('CONFLICT');
    });
  });
});
