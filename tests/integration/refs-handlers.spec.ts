import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { MongoClient, ObjectId } from 'mongodb';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  ReferenceAutodetectCandidate,
  ReferenceResolveResult,
  ReferenceRule,
} from '@shared/types';
import { createRouter } from '../../electron/ipc/router';
import { registerRefsChannels } from '../../electron/ipc/handlers/refs';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { ReferenceRulesRepo } from '../../electron/db/repositories/ReferenceRulesRepo';
import { ReferenceRulesService } from '../../electron/services/ReferenceRulesService';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, insertConnectionRow, type TempDb } from '../helpers/db';
import { createIpcShim } from '../helpers/ipcShim';
import { testSenderCheck } from '../helpers/ipcSender';
import {
  getSharedMongoUri,
  makeConnection,
  makeReader,
  uriToHostPort,
} from '../helpers/mongo';

/**
 * Drives `refs:*` through the real router, zod validators,
 * `ReferenceRulesService`, a temp SQLite file and a real mongod. The service
 * spec skips the router and the registration spec stubs the service, so
 * neither proves that the schemas accept what the renderer sends or that a
 * service failure crosses as a typed code.
 *
 * Values are `$oid` sentinels and strings only: the shapes the renderer
 * actually serialises, and none of the large-integer territory.
 */
const DB = 'refs_router_db';
const CONN = 'refs-conn';
// Exists in SQLite (the foreign key needs a row) but the pool's reader cannot
// find it, so the pool raises NotFoundError and `resolve` must surface it as
// a NOT_FOUND envelope.
const GHOST_CONN = 'refs-ghost-conn';

const ACME = new ObjectId();
const GLOBEX = new ObjectId();

const ruleInput = (overrides: Record<string, unknown> = {}) => ({
  connectionId: CONN,
  sourceDb: DB,
  sourceCollection: 'orders',
  sourceField: 'customer_id',
  targetDb: DB,
  targetCollection: 'customers',
  ...overrides,
});

describe('refs:* channels via router', () => {
  let tmp: TempDb;
  let pool: MongoPool;
  const shim = createIpcShim();

  /** Creates a rule through the channel and returns it, failing loudly if the channel did not. */
  async function createRule(overrides: Record<string, unknown> = {}): Promise<ReferenceRule> {
    const env = await shim.invoke<ReferenceRule>(IPC_CHANNELS.refsCreate, ruleInput(overrides));
    if (!env.ok) throw new Error(`refs:create failed: ${env.error.code} ${env.error.message}`);
    return env.data;
  }

  beforeAll(async () => {
    const seed = new MongoClient(getSharedMongoUri());
    try {
      await seed.connect();
      await seed
        .db(DB)
        .collection('customers')
        .insertMany([
          { _id: ACME, name: 'Acme' },
          { _id: GLOBEX, name: 'Globex' },
        ]);
      await seed.db(DB).collection('orders').insertOne({ customer_id: ACME, total: 1 });
    } finally {
      await seed.close();
    }

    tmp = createTempDb();
    insertConnectionRow(tmp.db, CONN);
    insertConnectionRow(tmp.db, GHOST_CONN);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(CONN, uriToHostPort(getSharedMongoUri()), { defaultDb: DB });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    registerRefsChannels(
      createRouter(shim.ipcMain, testSenderCheck),
      new ReferenceRulesService(new ReferenceRulesRepo(tmp.db), pool),
    );
  });

  beforeEach(() => {
    tmp.db.prepare('DELETE FROM reference_rules').run();
  });

  afterAll(async () => {
    await pool.disconnectAll();
    tmp.cleanup();
  });

  describe('refs:create', () => {
    it('stores the rule with the documented defaults', async () => {
      const env = await shim.invoke<ReferenceRule>(IPC_CHANNELS.refsCreate, ruleInput());
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toMatchObject({
        connectionId: CONN,
        sourceField: 'customer_id',
        targetCollection: 'customers',
        targetField: '_id',
        enabled: true,
        projection: [],
      });
      expect(env.data.id).toEqual(expect.any(String));
    });

    it('answers CONFLICT for a second rule on the same source field', async () => {
      await createRule();
      const env = await shim.invoke(IPC_CHANNELS.refsCreate, ruleInput({ targetCollection: 'other' }));
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('CONFLICT');
    });

    it('answers NOT_FOUND for a connection that does not exist', async () => {
      const env = await shim.invoke(
        IPC_CHANNELS.refsCreate,
        ruleInput({ connectionId: 'no-such-conn' }),
      );
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
      expect(env.error.message).toBe('connection no-such-conn not found');
      const stored = tmp.db.prepare('SELECT COUNT(*) AS n FROM reference_rules').get() as {
        n: number;
      };
      expect(stored.n).toBe(0);
    });

    it.each([
      ['a missing targetCollection', { targetCollection: undefined }],
      ['an empty sourceField', { sourceField: '' }],
      ['a non-array projection', { projection: 'name' }],
    ])('rejects %s with VALIDATION', async (_what, overrides) => {
      const env = await shim.invoke(IPC_CHANNELS.refsCreate, ruleInput(overrides));
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });

  describe('refs:get', () => {
    it('returns the stored rule', async () => {
      const rule = await createRule();
      const env = await shim.invoke<ReferenceRule>(IPC_CHANNELS.refsGet, { id: rule.id });
      expect(env).toEqual({ ok: true, data: rule });
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const env = await shim.invoke(IPC_CHANNELS.refsGet, { id: 'no-such-rule' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('rejects an empty id with VALIDATION', async () => {
      const env = await shim.invoke(IPC_CHANNELS.refsGet, { id: '' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });

  describe('refs:list', () => {
    it('returns every rule of the connection and none of another', async () => {
      await createRule({ sourceField: 'customer_id' });
      await createRule({ sourceCollection: 'invoices', sourceField: 'customer_id' });
      await createRule({ connectionId: GHOST_CONN });
      const env = await shim.invoke<ReferenceRule[]>(IPC_CHANNELS.refsList, {
        connectionId: CONN,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((r) => r.sourceCollection).sort((a, b) => a.localeCompare(b))).toEqual([
        'invoices',
        'orders',
      ]);
    });

    it('narrows to one collection when dbName and collection are both given', async () => {
      await createRule();
      await createRule({ sourceCollection: 'invoices' });
      const env = await shim.invoke<ReferenceRule[]>(IPC_CHANNELS.refsList, {
        connectionId: CONN,
        dbName: DB,
        collection: 'invoices',
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((r) => r.sourceCollection)).toEqual(['invoices']);
    });

    // The handler narrows only when both dbName and collection are present; a
    // lone dbName is accepted by the schema and ignored.
    it('ignores a partial filter and returns every rule of the connection', async () => {
      await createRule();
      await createRule({ sourceCollection: 'invoices' });
      const env = await shim.invoke<ReferenceRule[]>(IPC_CHANNELS.refsList, {
        connectionId: CONN,
        dbName: DB,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((r) => r.sourceCollection).sort((a, b) => a.localeCompare(b))).toEqual([
        'invoices',
        'orders',
      ]);
    });

    it('rejects a missing connectionId with VALIDATION', async () => {
      const env = await shim.invoke(IPC_CHANNELS.refsList, {});
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });

  describe('refs:update', () => {
    it('applies the patch and leaves the other fields alone', async () => {
      const rule = await createRule();
      const env = await shim.invoke<ReferenceRule>(IPC_CHANNELS.refsUpdate, {
        id: rule.id,
        patch: { targetCollection: 'accounts', projection: [' name ', 'name', ''], enabled: false },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toMatchObject({
        id: rule.id,
        targetCollection: 'accounts',
        projection: ['name'],
        enabled: false,
        targetField: '_id',
        sourceField: 'customer_id',
      });
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const env = await shim.invoke(IPC_CHANNELS.refsUpdate, {
        id: 'no-such-rule',
        patch: { enabled: false },
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('rejects an empty patch.targetDb with VALIDATION', async () => {
      const rule = await createRule();
      const env = await shim.invoke(IPC_CHANNELS.refsUpdate, {
        id: rule.id,
        patch: { targetDb: '' },
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });

  describe('refs:delete', () => {
    it('removes the rule and returns no data', async () => {
      const rule = await createRule();
      const del = await shim.invoke(IPC_CHANNELS.refsDelete, { id: rule.id });
      expect(del).toStrictEqual({ ok: true, data: undefined });
      const after = await shim.invoke(IPC_CHANNELS.refsGet, { id: rule.id });
      expect(after.ok).toBe(false);
      if (after.ok) return;
      expect(after.error.code).toBe('NOT_FOUND');
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const env = await shim.invoke(IPC_CHANNELS.refsDelete, { id: 'no-such-rule' });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });

  describe('refs:resolve', () => {
    const oidEjson = (id: ObjectId) => JSON.stringify({ $oid: id.toHexString() });

    it('finds the referenced document for a single value', async () => {
      const rule = await createRule();
      const env = await shim.invoke<ReferenceResolveResult>(IPC_CHANNELS.refsResolve, {
        ruleId: rule.id,
        valueEjson: oidEjson(ACME),
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toMatchObject({ ruleId: rule.id, found: true });
      expect(env.data.documents).toHaveLength(1);
      expect(env.data.documents[0]).toMatchObject({
        _id: { $oid: ACME.toHexString() },
        name: 'Acme',
      });
    });

    it('reports found: false for a value no document has', async () => {
      const rule = await createRule();
      const env = await shim.invoke<ReferenceResolveResult>(IPC_CHANNELS.refsResolve, {
        ruleId: rule.id,
        valueEjson: oidEjson(new ObjectId()),
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toMatchObject({ ruleId: rule.id, found: false, documents: [] });
    });

    it('resolves an array value through $in, in the order of the source array', async () => {
      const rule = await createRule();
      const env = await shim.invoke<ReferenceResolveResult>(IPC_CHANNELS.refsResolve, {
        ruleId: rule.id,
        valueEjson: JSON.stringify([
          { $oid: GLOBEX.toHexString() },
          { $oid: new ObjectId().toHexString() },
          { $oid: ACME.toHexString() },
        ]),
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.found).toBe(true);
      expect(env.data.documents.map((d) => (d as { name: string }).name)).toEqual([
        'Globex',
        'Acme',
      ]);
    });

    it('matches on a non-_id targetField with a string value', async () => {
      const rule = await createRule({ targetField: 'name' });
      const env = await shim.invoke<ReferenceResolveResult>(IPC_CHANNELS.refsResolve, {
        ruleId: rule.id,
        valueEjson: JSON.stringify('Globex'),
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.found).toBe(true);
      expect(env.data.documents[0]).toMatchObject({ name: 'Globex' });
    });

    it.each([
      ['an empty ruleId', { ruleId: '', valueEjson: '"x"' }],
      ['a missing valueEjson', { ruleId: 'r1' }],
    ])('rejects %s with VALIDATION (zod)', async (_what, payload) => {
      const env = await shim.invoke(IPC_CHANNELS.refsResolve, payload);
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });

    it('rejects malformed EJSON with VALIDATION (raised by the service, zod accepts any string)', async () => {
      const rule = await createRule();
      const env = await shim.invoke(IPC_CHANNELS.refsResolve, {
        ruleId: rule.id,
        valueEjson: '{not json',
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
      expect(env.error.message).toContain('valueEjson');
    });

    it('answers NOT_FOUND for an unknown rule', async () => {
      const env = await shim.invoke(IPC_CHANNELS.refsResolve, {
        ruleId: 'no-such-rule',
        valueEjson: '"x"',
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });

    it('answers NOT_FOUND when the rule belongs to a connection the pool does not know', async () => {
      const rule = await createRule({ connectionId: GHOST_CONN });
      const env = await shim.invoke(IPC_CHANNELS.refsResolve, {
        ruleId: rule.id,
        valueEjson: oidEjson(ACME),
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
    });
  });

  describe('refs:autodetect', () => {
    const auto = { connectionId: CONN, dbName: DB, collection: 'orders' };

    it('proposes the collection a *_id field points at', async () => {
      const env = await shim.invoke<ReferenceAutodetectCandidate[]>(IPC_CHANNELS.refsAutodetect, {
        ...auto,
        sampleDocs: [{ customer_id: { $oid: ACME.toHexString() } }],
      });
      expect(env).toEqual({
        ok: true,
        data: [
          {
            sourceField: 'customer_id',
            targetDb: DB,
            targetCollection: 'customers',
            targetField: '_id',
            alreadyConfigured: false,
          },
        ],
      });
    });

    it('samples the collection itself when the caller sends no sampleDocs', async () => {
      const env = await shim.invoke<ReferenceAutodetectCandidate[]>(
        IPC_CHANNELS.refsAutodetect,
        auto,
      );
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.map((c) => c.targetCollection)).toEqual(['customers']);
    });

    it('flags a candidate that already has a rule', async () => {
      await createRule();
      const env = await shim.invoke<ReferenceAutodetectCandidate[]>(IPC_CHANNELS.refsAutodetect, {
        ...auto,
        sampleDocs: [{ customer_id: 'x' }],
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toHaveLength(1);
      expect(env.data[0]).toMatchObject({ sourceField: 'customer_id', alreadyConfigured: true });
    });

    // specs/X05-document-references.md section 9: autodetect fails open, so a
    // pool failure (an unknown connection included) is an empty list and the
    // user keeps the manual "New rule" path.
    it('returns an empty list, not an error, for an unknown connection', async () => {
      const env = await shim.invoke(IPC_CHANNELS.refsAutodetect, {
        ...auto,
        connectionId: 'no-such-conn',
        sampleDocs: [{ customer_id: 'x' }],
      });
      expect(env).toEqual({ ok: true, data: [] });
    });

    it.each([
      ['a missing dbName', { connectionId: CONN, collection: 'orders' }],
      ['a missing collection', { connectionId: CONN, dbName: DB }],
      ['a non-array sampleDocs', { ...auto, sampleDocs: 'x' }],
    ])('rejects %s with VALIDATION', async (_what, payload) => {
      const env = await shim.invoke(IPC_CHANNELS.refsAutodetect, payload);
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('VALIDATION');
    });
  });
});
