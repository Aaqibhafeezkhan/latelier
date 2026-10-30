import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Collection, MongoClient, MongoNetworkError } from 'mongodb';
import { createRouter } from '../../electron/ipc/router';
import { registerDataChannels } from '../../electron/ipc/handlers/data';
import { registerAuditChannels } from '../../electron/ipc/handlers/audit';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { ImportService } from '../../electron/mongo/ImportService';
import { importDigest } from '../../electron/mongo/undo';
import { AuditRepo } from '../../electron/db/repositories/AuditRepo';
import { AuditService } from '../../electron/services/AuditService';
import { UndoStore } from '../../electron/services/UndoStore';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import type { Logger } from '../../electron/log';
import { IPC_CHANNELS, type Envelope } from '../../shared/ipc';
import type { AuditEntry, ImportReport, UndoResult } from '../../shared/types';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb, createTempCipher } from '../helpers/db';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { getSharedMongoUri, uriToHostPort, makeConnection, makeReader } from '../helpers/mongo';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

// A value that exists only inside the imported file. If it shows up in an
// audit row, the summary has started persisting document bodies.
const BODY_MARKER = 'body-only-value-9c1e';

describe('data:import via the router', () => {
  let client: MongoClient;
  let tmp: TempDb;
  let pool: MongoPool;
  let dir: string;
  let dbName: string;
  let auditRepo: AuditRepo;
  let undoStore: UndoStore;
  // What the open dialog would have returned: `file()` adds each path it
  // writes, as picking it would.
  let picked: Set<string>;
  const handlers = new Map<string, Handler>();

  const invoke = async <T,>(payload: unknown): Promise<Envelope<T>> =>
    (await handlers.get(IPC_CHANNELS.dataImport)!(invokeEvent, payload)) as Envelope<T>;

  const invokeUndo = async (entryId: string): Promise<Envelope<UndoResult>> =>
    (await handlers.get(IPC_CHANNELS.auditUndo)!(invokeEvent, { entryId })) as Envelope<UndoResult>;

  // The stored summary is sealed; the plaintext check runs on what it decrypts to.
  const summaryText = (r: Record<string, unknown>): string =>
    createTempCipher().open('audit_log', 'summary_json', r.id as string, r.summary_json as Buffer);
  const rows = (): AuditEntry[] =>
    (tmp.db.prepare('SELECT * FROM audit_log').all() as Record<string, unknown>[]).map((r) => ({
      op: r.op,
      outcome: r.outcome,
      errorCode: r.error_code,
      collection: r.collection,
      summary: JSON.parse(summaryText(r)),
      reversible: r.reversible === 1,
      raw: summaryText(r),
    }) as unknown as AuditEntry);

  beforeAll(async () => {
    client = await MongoClient.connect(getSharedMongoUri());
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    tmp = createTempDb();
    picked = new Set();
    const now = new Date().toISOString();
    for (const id of ['c1', 'c-ro']) {
      tmp.db.prepare(
        `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
         VALUES (?, ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
      ).run(id, `conn-${id}`, now, now);
    }
    const hp = uriToHostPort(getSharedMongoUri());
    pool = new MongoPool({
      repo: makeReader([makeConnection('c1', hp), makeConnection('c-ro', hp, { readOnly: true })]),
      vault: new SecretsVault(tmp.db, createSafeStorageMock()),
    });
    const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    auditRepo = new AuditRepo(tmp.db, createTempCipher());
    undoStore = new UndoStore();
    const auditSvc = new AuditService(auditRepo, pool, undoStore, log);
    handlers.clear();
    const router = createRouter(
      { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) },
      testSenderCheck,
      log,
      auditSvc,
    );
    registerDataChannels(router, new ImportService(pool), picked);
    registerAuditChannels(router, auditSvc);
    dbName = `data_${randomUUID().slice(0, 8)}`;
    await client.db(dbName).createCollection('people');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latelier-data-'));
  });

  afterEach(async () => {
    await client.db(dbName).dropDatabase();
    await pool.disconnectAll();
    await fs.rm(dir, { recursive: true, force: true });
    tmp.cleanup();
  });

  async function file(name: string, content: string): Promise<string> {
    const p = path.join(dir, name);
    await fs.writeFile(p, content, 'utf8');
    picked.add(p);
    return p;
  }

  const target = () => ({ connectionId: 'c1', dbName, collection: 'people' });

  it('records one ok row per clean import, naming the file but not its directory or contents, and offers Undo', async () => {
    const p = await file('clean.jsonl', `{"_id":1,"s":"${BODY_MARKER}"}\n{"_id":2}\n`);
    const env = await invoke<ImportReport>({ ...target(), path: p });
    expect(env).toMatchObject({ ok: true, data: { inserted: 2, failed: 0 } });
    expect(env.ok && env.data.auditId).toBeTruthy();
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      op: 'import',
      outcome: 'ok',
      errorCode: null,
      collection: 'people',
      reversible: true,
      summary: { op: 'import', fileName: 'clean.jsonl', format: 'jsonl', insertedCount: 2, failedCount: 0 },
    });
    const raw = (row as unknown as { raw: string }).raw;
    expect(raw).not.toContain(BODY_MARKER);
    expect(raw).not.toContain(dir);
  });

  it('records an import with rejected documents as partial', async () => {
    const p = await file('dup.json', `[{"_id":1},{"_id":1,"s":"${BODY_MARKER}"}]`);
    const env = await invoke<ImportReport>({ ...target(), path: p });
    expect(env).toMatchObject({ ok: true, data: { format: 'json', inserted: 1, failed: 1 } });
    expect(rows()).toMatchObject([{
      outcome: 'partial',
      errorCode: null,
      summary: { op: 'import', fileName: 'dup.json', format: 'json', insertedCount: 1, failedCount: 1 },
    }]);
    expect((rows()[0] as unknown as { raw: string }).raw).not.toContain(BODY_MARKER);
  });

  it('records a refused import as an error that still names the file', async () => {
    const p = await file('people.jsonl', '{"_id":1}\n');
    const env = await invoke({ ...target(), connectionId: 'c-ro', path: p });
    expect(env).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
    expect(rows()).toMatchObject([{ op: 'import', outcome: 'error', errorCode: 'READ_ONLY', summary: { op: 'import', fileName: 'people.jsonl', format: 'jsonl' } }]);
    expect(await client.db(dbName).collection('people').countDocuments()).toBe(0);
  });

  it('imports a CSV through its mapping, records it as csv, and undoes it by digest', async () => {
    const p = await file('people.csv', `_id,when,ref,a.b,s\n1,2024-01-02T03:04:05Z,507f1f77bcf86cd799439011,x,${BODY_MARKER}\n2,,,,\n`);
    const columns = [
      { header: '_id', type: 'number', emptyAsNull: false },
      { header: 'when', type: 'date', emptyAsNull: false },
      { header: 'ref', type: 'objectId', emptyAsNull: true },
      { header: 'a.b', type: 'string', emptyAsNull: false },
      { header: 's', type: 'string', emptyAsNull: false },
    ];
    const env = await invoke<ImportReport>({ ...target(), path: p, csv: { columns } });
    expect(env).toMatchObject({ ok: true, data: { format: 'csv', inserted: 2, failed: 0 } });
    expect(rows()).toMatchObject([{ outcome: 'ok', reversible: true, summary: { fileName: 'people.csv', format: 'csv', insertedCount: 2 } }]);
    expect((rows()[0] as unknown as { raw: string }).raw).not.toContain(BODY_MARKER);

    const undo = await invokeUndo(env.ok ? env.data.auditId! : '');
    expect(undo).toMatchObject({ ok: true, data: { restored: 2, skipped: 0 } });
    expect(await client.db(dbName).collection('people').countDocuments()).toBe(0);
  });

  it('refuses a CSV column mapping that is not the documented shape', async () => {
    const p = await file('people.csv', 'a\n1\n');
    for (const csv of [
      { columns: [] },
      { columns: [{ header: 'a', type: 'int', emptyAsNull: false }] },
      { columns: [{ header: 'a', type: 'string' }] },
    ]) {
      expect(await invoke({ ...target(), path: p, csv })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(await client.db(dbName).collection('people').countDocuments()).toBe(0);
  });

  it('previews a CSV without recording an audit row', async () => {
    const preview = (payload: unknown) => handlers.get(IPC_CHANNELS.dataPreviewCsv)!(invokeEvent, payload) as Promise<Envelope<unknown>>;
    const p = await file('people.csv', 'name,n\nann,1\n');
    expect(await preview({ path: p })).toEqual({
      ok: true,
      data: { fileName: 'people.csv', headers: ['name', 'n'], rows: [['ann', '1']], inferred: ['string', 'number'] },
    });
    expect(await preview({})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await preview({ path: await file('people.jsonl', '{}\n') })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(rows()).toEqual([]);
  });

  it('reads no file the open dialog did not return — neither to import nor to preview', async () => {
    const preview = (payload: unknown) => handlers.get(IPC_CHANNELS.dataPreviewCsv)!(invokeEvent, payload) as Promise<Envelope<unknown>>;
    // Written straight to disk, never "picked": exactly what a renderer
    // naming an arbitrary path would send.
    const csv = path.join(dir, 'unpicked.csv');
    const jsonl = path.join(dir, 'unpicked.jsonl');
    await fs.writeFile(csv, 'secret,n\nhunter2,1\n', 'utf8');
    await fs.writeFile(jsonl, '{"_id":1}\n', 'utf8');

    const refused = { ok: false, error: { code: 'VALIDATION', message: 'only a file chosen in the import dialog can be read' } };
    expect(await preview({ path: csv })).toMatchObject(refused);
    expect(await invoke({ ...target(), path: jsonl })).toMatchObject(refused);
    expect(await client.db(dbName).collection('people').countDocuments()).toBe(0);
  });

  it('refuses a payload without a path before reaching the service', async () => {
    const env = await invoke({ ...target() });
    expect(env).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('refuses an empty cancelToken rather than accepting an uncancellable run', async () => {
    const p = await file('people.jsonl', '{"_id":1}\n');
    const env = await invoke({ ...target(), path: p, cancelToken: '' });
    expect(env).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('records a cancelled import as partial, with cancelled in the summary', async () => {
    // A dedicated router+service for this test: the cancel must fire from
    // inside the progress event, before `data:import`'s own promise settles.
    const localHandlers = new Map<string, Handler>();
    const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const auditSvc = new AuditService(new AuditRepo(tmp.db, createTempCipher()), pool, undoStore, log);
    const router = createRouter(
      { handle: (channel: string, fn: Handler) => void localHandlers.set(channel, fn) },
      testSenderCheck,
      log,
      auditSvc,
    );
    const importSvc = new ImportService(pool, {
      batchSize: 5,
      emit: (e) => {
        void localHandlers.get(IPC_CHANNELS.dataCancelImport)!(invokeEvent, { token: e.cancelToken });
      },
    });
    registerDataChannels(router, importSvc, picked);
    const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ _id: i })).join('\n');
    const p = await file('cancel.jsonl', lines);
    const env = (await localHandlers.get(IPC_CHANNELS.dataImport)!(
      invokeEvent,
      { ...target(), path: p, cancelToken: 'ct1' },
    )) as Envelope<ImportReport>;
    expect(env).toMatchObject({ ok: true, data: { inserted: 5, cancelled: true } });
    const [row] = tmp.db.prepare('SELECT * FROM audit_log').all() as Record<string, unknown>[];
    expect(row).toMatchObject({ outcome: 'partial', reversible: 1 });
    expect(JSON.parse(summaryText(row!))).toMatchObject({ cancelled: true, insertedCount: 5 });
  });

  describe('undo', () => {
    async function importAuditId(fileName: string, content: string): Promise<string> {
      const env = await invoke<ImportReport>({ ...target(), path: await file(fileName, content) });
      if (!env.ok) throw new Error(`import failed: ${JSON.stringify(env.error)}`);
      return env.data.auditId!;
    }

    it('restores landed documents that are still unchanged, and skips one edited since', async () => {
      const auditId = await importAuditId('three.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
      await client.db(dbName).collection('people').updateOne({ _id: 2 } as never, { $set: { edited: true } });

      const env = await invokeUndo(auditId);
      expect(env).toMatchObject({ ok: true, data: { restored: 2, skipped: 1 } });
      const remaining = await client.db(dbName).collection('people').find().sort({ _id: 1 }).toArray();
      expect(remaining).toEqual([{ _id: 2, edited: true }]);
    });

    it('keeps the capture in memory only: the column stays NULL, and a restart makes the import not undoable', async () => {
      const auditId = await importAuditId('mem.jsonl', '{"_id":1,"secret":"import-body-marker"}\n');
      const row = tmp.db.prepare('SELECT reversible, undo_json FROM audit_log WHERE id = ?').get(auditId);
      expect(row).toEqual({ reversible: 1, undo_json: null });
      expect(undoStore.has(auditId)).toBe(true);

      const restarted = new AuditService(auditRepo, pool, new UndoStore(), { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
      expect(restarted.list({ connectionId: 'c1' })[0]).toMatchObject({ id: auditId, reversible: false });
      await expect(restarted.undo({ entryId: auditId })).rejects.toMatchObject({ code: 'AUDIT_UNDO_EXPIRED' });
      expect(await invokeUndo(auditId)).toMatchObject({ ok: true, data: { restored: 1, skipped: 0 } });
    });

    it('is not offered above the capture ceiling — reversible is false and there is no auditId to undo', async () => {
      const localHandlers = new Map<string, Handler>();
      const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const auditSvc = new AuditService(new AuditRepo(tmp.db, createTempCipher()), pool, undoStore, log);
      const router = createRouter(
        { handle: (channel: string, fn: Handler) => void localHandlers.set(channel, fn) },
        testSenderCheck,
        log,
        auditSvc,
      );
      registerDataChannels(router, new ImportService(pool, { maxUndoCaptureDocs: 2 }), picked);
      const p = await file('over-ceiling.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
      const env = (await localHandlers.get(IPC_CHANNELS.dataImport)!(
        invokeEvent,
        { ...target(), path: p },
      )) as Envelope<ImportReport>;
      expect(env).toMatchObject({ ok: true, data: { inserted: 3 } });
      expect(env.ok && env.data.auditId).toBeUndefined();
      expect(rows()).toMatchObject([{ reversible: false }]);
    });

    it('keeps a document another client edits between Undo\'s read and its delete', async () => {
      const auditId = await importAuditId('race.jsonl', '{"_id":1}\n{"_id":2}\n');
      const original = Collection.prototype.bulkWrite;
      vi.spyOn(Collection.prototype, 'bulkWrite').mockImplementationOnce(async function (
        this: Collection,
        ...args: Parameters<Collection['bulkWrite']>
      ) {
        await client.db(dbName).collection('people').updateOne({ _id: 1 } as never, { $set: { edited: true } });
        return original.apply(this, args);
      });

      const env = await invokeUndo(auditId);
      vi.restoreAllMocks();
      expect(env).toMatchObject({ ok: true, data: { restored: 1, skipped: 1 } });
      const remaining = await client.db(dbName).collection('people').find().toArray();
      expect(remaining).toEqual([{ _id: 1, edited: true }]);
    });

    it('stays undoable for the batches that fully landed when a later batch fails outright', async () => {
      const localHandlers = new Map<string, Handler>();
      const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const auditSvc = new AuditService(new AuditRepo(tmp.db, createTempCipher()), pool, undoStore, log);
      const router = createRouter(
        { handle: (channel: string, fn: Handler) => void localHandlers.set(channel, fn) },
        testSenderCheck,
        log,
        auditSvc,
      );
      registerDataChannels(router, new ImportService(pool, { batchSize: 2 }), picked);
      registerAuditChannels(router, auditSvc);
      const original = Collection.prototype.insertMany;
      let calls = 0;
      const spy = vi.spyOn(Collection.prototype, 'insertMany').mockImplementation(function (
        this: Collection,
        ...args: Parameters<Collection['insertMany']>
      ) {
        calls++;
        if (calls === 2) return Promise.reject(new MongoNetworkError('connection reset'));
        return original.apply(this, args);
      });
      const p = await file('drop.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n{"_id":4}\n{"_id":5}\n');
      const env = (await localHandlers.get(IPC_CHANNELS.dataImport)!(
        invokeEvent,
        { ...target(), path: p },
      )) as Envelope<ImportReport>;
      spy.mockRestore();
      expect(env).toMatchObject({ ok: false, error: { code: 'NETWORK', details: { insertedCount: 2 } } });
      // The capture never crosses IPC with the error.
      expect(JSON.stringify(env)).not.toContain('digests');

      const [row] = tmp.db.prepare('SELECT * FROM audit_log').all() as Record<string, unknown>[];
      expect(row).toMatchObject({ outcome: 'partial', reversible: 1 });
      const undo = (await localHandlers.get(IPC_CHANNELS.auditUndo)!(
        invokeEvent,
        { entryId: row!.id },
      )) as Envelope<UndoResult>;
      expect(undo).toMatchObject({ ok: true, data: { restored: 2, skipped: 0 } });
      expect(await client.db(dbName).collection('people').countDocuments()).toBe(0);
    });

    it('is not undoable when an import fails before any batch landed', async () => {
      const localHandlers = new Map<string, Handler>();
      const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const auditSvc = new AuditService(new AuditRepo(tmp.db, createTempCipher()), pool, undoStore, log);
      const router = createRouter(
        { handle: (channel: string, fn: Handler) => void localHandlers.set(channel, fn) },
        testSenderCheck,
        log,
        auditSvc,
      );
      registerDataChannels(router, new ImportService(pool, { batchSize: 2 }), picked);
      const spy = vi
        .spyOn(Collection.prototype, 'insertMany')
        .mockImplementation(() => Promise.reject(new MongoNetworkError('connection reset')));
      const p = await file('drop-first.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
      const env = (await localHandlers.get(IPC_CHANNELS.dataImport)!(
        invokeEvent,
        { ...target(), path: p },
      )) as Envelope<ImportReport>;
      spy.mockRestore();
      expect(env).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
      expect(rows()).toMatchObject([{ outcome: 'error', reversible: false }]);
    });

    it('refuses a second Undo of the same import', async () => {
      const auditId = await importAuditId('again.jsonl', '{"_id":1}\n');
      expect(await invokeUndo(auditId)).toMatchObject({ ok: true, data: { restored: 1, skipped: 0 } });
      expect(await invokeUndo(auditId)).toMatchObject({ ok: false, error: { code: 'AUDIT_ALREADY_UNDONE' } });
    });

    it('refuses to undo an import whose connection is read-only', async () => {
      // `c-ro` targets the same server as `c1` but is flagged read-only in the
      // pool, the same way `audit-handlers.spec.ts` covers this refusal: a
      // synthetic row, since a real import through `c-ro` would itself be
      // refused before ever landing anything to undo.
      const doc = { _id: 1 };
      await client.db(dbName).collection('people').insertOne(doc as never);
      auditRepo.insert({
        id: 'ro-import',
        connection_id: 'c-ro',
        db_name: dbName,
        collection: 'people',
        op: 'import',
        summary_json: '{"op":"import","fileName":"ro.jsonl"}',
        outcome: 'ok',
        error_code: null,
        ran_at: new Date().toISOString(),
        duration_ms: 1,
        reversible: 1,
        undone_at: null,
      });
      undoStore.put('ro-import', 'c-ro', JSON.stringify({ importedIds: [1], digests: [importDigest(doc)] }));

      expect(await invokeUndo('ro-import')).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
      expect(await client.db(dbName).collection('people').countDocuments()).toBe(1);
    });
  });
});
