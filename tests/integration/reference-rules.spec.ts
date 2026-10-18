import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ObjectId } from 'bson';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { ReferenceRulesRepo } from '../../electron/db/repositories/ReferenceRulesRepo';
import { ReferenceRulesService } from '../../electron/services/ReferenceRulesService';
import { NotFoundError } from '../../electron/errors';
import { createTempDb, type TempDb } from '../helpers/db';
import { getSharedMongoUri, makeConnection, makeReader } from '../helpers/mongo';

const CONN_ID = 'ref-conn';
const DB_NAME = 'refdb';

async function seedConnection(tmp: TempDb): Promise<void> {
  tmp.db.prepare(`
    INSERT INTO connections (
      id, name, color, connection_type, host, port,
      auth_mech, tls_enabled, tls_verify, ssh_enabled,
      connect_timeout_ms, socket_timeout_ms, server_selection_timeout_ms,
      read_preference, max_pool_size, direct_connection,
      created_at, updated_at
    ) VALUES (
      ?, 'Test', '#1A6835', 'standard', 'localhost', 27017,
      'none', 0, 1, 0,
      5000, 5000, 5000,
      'primary', 5, 1,
      ?, ?
    )
  `).run(CONN_ID, new Date().toISOString(), new Date().toISOString());
}

describe('ReferenceRulesService', () => {
  let pool: MongoPool;
  let tmp: TempDb;
  let svc: ReferenceRulesService;
  let repo: ReferenceRulesRepo;

  beforeAll(async () => {
    const uri = getSharedMongoUri();
    const hp = { host: new URL(uri).hostname, port: Number(new URL(uri).port) };
    const conn = makeConnection(CONN_ID, hp, { defaultDb: DB_NAME });
    pool = new MongoPool({
      repo: makeReader([conn]),
      vault: { get: () => null } as unknown as import('../../electron/secrets/SecretsVault').SecretsVault,
    });
  });

  beforeEach(async () => {
    tmp = createTempDb();
    await seedConnection(tmp);
    repo = new ReferenceRulesRepo(tmp.db);
    svc = new ReferenceRulesService(repo, pool);
  });

  afterAll(async () => {
    await pool.disconnectAll();
  });

  it('create + list + get round-trips a rule', () => {
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'contact_id',
      targetDb: DB_NAME,
      targetCollection: 'contacts',
      projection: ['name', 'email'],
      displayTemplate: '{name}',
    });
    expect(rule.id).toBeTruthy();
    expect(rule.targetField).toBe('_id');
    expect(rule.enabled).toBe(true);

    const list = svc.list(CONN_ID);
    expect(list).toHaveLength(1);
    expect(list[0]!.sourceField).toBe('contact_id');
    expect(list[0]!.projection).toEqual(['name', 'email']);

    const filtered = svc.listForCollection(CONN_ID, DB_NAME, 'orders');
    expect(filtered).toHaveLength(1);

    const other = svc.listForCollection(CONN_ID, DB_NAME, 'invoices');
    expect(other).toHaveLength(0);

    expect(svc.get(rule.id).sourceField).toBe('contact_id');
  });

  it('rejects duplicate rules on the same source field', () => {
    const base = {
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'contact_id',
      targetDb: DB_NAME,
      targetCollection: 'contacts',
    };
    svc.create(base);
    expect(() => svc.create(base)).toThrow(/already exists/);
  });

  it('create for an unknown connection throws NotFoundError, not the raw foreign-key error', () => {
    const create = () =>
      svc.create({
        connectionId: 'no-such-conn',
        sourceDb: DB_NAME,
        sourceCollection: 'orders',
        sourceField: 'contact_id',
        targetDb: DB_NAME,
        targetCollection: 'contacts',
      });
    expect(create).toThrow(NotFoundError);
    expect(create).toThrow('connection no-such-conn not found');
    expect(repo.listByConnection('no-such-conn')).toEqual([]);
  });

  it('update mutates allowed fields and bumps updated_at', async () => {
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'contact_id',
      targetDb: DB_NAME,
      targetCollection: 'contacts',
      projection: ['name'],
    });
    await new Promise((r) => setTimeout(r, 5));
    const updated = svc.update(rule.id, {
      projection: ['name', 'email'],
      enabled: false,
      displayTemplate: '{email}',
    });
    expect(updated.projection).toEqual(['name', 'email']);
    expect(updated.enabled).toBe(false);
    expect(updated.displayTemplate).toBe('{email}');
    expect(updated.updatedAt > rule.updatedAt).toBe(true);
  });

  it('delete removes the rule', () => {
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'contact_id',
      targetDb: DB_NAME,
      targetCollection: 'contacts',
    });
    svc.delete(rule.id);
    expect(repo.findById(rule.id)).toBeNull();
    expect(() => svc.delete(rule.id)).toThrow(/not found/);
  });

  it('resolves a reference by ObjectId with projection applied', async () => {
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    await db.collection('contacts').deleteMany({});
    const contactId = new ObjectId();
    await db.collection('contacts').insertOne({
      _id: contactId,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '555-0100',
    });

    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'contact_id',
      targetDb: DB_NAME,
      targetCollection: 'contacts',
      projection: ['name', 'email'],
    });

    const result = await svc.resolve({
      ruleId: rule.id,
      valueEjson: JSON.stringify({ $oid: contactId.toHexString() }),
    });
    expect(result.found).toBe(true);
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0] as Record<string, unknown>;
    expect(doc.name).toBe('Ada Lovelace');
    expect(doc.email).toBe('ada@example.com');
    expect(doc.phone).toBeUndefined();
    // _id is always carried.
    expect(doc._id).toBeTruthy();
  });

  it('resolves a string-keyed reference', async () => {
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    await db.collection('products').deleteMany({});
    await db.collection<{ _id: string; name: string }>('products').insertOne({
      _id: 'sku-123',
      name: 'Gadget',
    });

    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'productId',
      targetDb: DB_NAME,
      targetCollection: 'products',
    });

    const result = await svc.resolve({
      ruleId: rule.id,
      valueEjson: JSON.stringify('sku-123'),
    });
    expect(result.found).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect((result.documents[0] as Record<string, unknown>).name).toBe('Gadget');
  });

  it('returns found=false when the target document is missing', async () => {
    const client = await pool.write(CONN_ID).client();
    await client.db(DB_NAME).collection('contacts').deleteMany({});
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'contact_id',
      targetDb: DB_NAME,
      targetCollection: 'contacts',
    });
    const missingId = new ObjectId();
    const result = await svc.resolve({
      ruleId: rule.id,
      valueEjson: JSON.stringify({ $oid: missingId.toHexString() }),
    });
    expect(result.found).toBe(false);
    expect(result.documents).toEqual([]);
  });

  it('resolves an array of ObjectIds, preserving source order, dropping misses', async () => {
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    await db.collection('items').deleteMany({});
    const a = new ObjectId();
    const b = new ObjectId();
    const c = new ObjectId();
    const missing = new ObjectId();
    // Insert out-of-source-order to confirm the resolver re-sorts.
    await db.collection('items').insertMany([
      { _id: c, name: 'C' },
      { _id: a, name: 'A' },
      { _id: b, name: 'B' },
    ]);

    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_ids',
      targetDb: DB_NAME,
      targetCollection: 'items',
      projection: ['name'],
    });

    const result = await svc.resolve({
      ruleId: rule.id,
      valueEjson: JSON.stringify([
        { $oid: a.toHexString() },
        { $oid: missing.toHexString() },
        { $oid: b.toHexString() },
        { $oid: c.toHexString() },
      ]),
    });

    expect(result.found).toBe(true);
    expect(result.documents).toHaveLength(3);
    const names = result.documents.map((d) => (d as Record<string, unknown>).name);
    expect(names).toEqual(['A', 'B', 'C']);
  });

  it('returns an empty list for an empty array source', async () => {
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_ids',
      targetDb: DB_NAME,
      targetCollection: 'items',
    });
    const result = await svc.resolve({
      ruleId: rule.id,
      valueEjson: JSON.stringify([]),
    });
    expect(result.found).toBe(false);
    expect(result.documents).toEqual([]);
  });

  it('returns an empty list when no array element matches', async () => {
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    await db.collection('items').deleteMany({});
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_ids',
      targetDb: DB_NAME,
      targetCollection: 'items',
    });
    const result = await svc.resolve({
      ruleId: rule.id,
      valueEjson: JSON.stringify([
        { $oid: new ObjectId().toHexString() },
        { $oid: new ObjectId().toHexString() },
      ]),
    });
    expect(result.found).toBe(false);
    expect(result.documents).toEqual([]);
  });

  it('rejects malformed EJSON values', async () => {
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'contact_id',
      targetDb: DB_NAME,
      targetCollection: 'contacts',
    });
    await expect(
      svc.resolve({ ruleId: rule.id, valueEjson: '{"not"' }),
    ).rejects.toThrow(/invalid valueEjson/);
  });

  it('autodetects convention-based fields against live collections', async () => {
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    // Ensure the target collections exist.
    await db.collection('contacts').deleteMany({});
    await db.collection('contacts').insertOne({ _id: new ObjectId(), name: 'Seed' });
    await db.collection('products').deleteMany({});
    await db.collection<{ _id: string; name: string }>('products').insertOne({ _id: 'seed', name: 'Seed' });

    const candidates = await svc.autodetect({
      connectionId: CONN_ID,
      dbName: DB_NAME,
      collection: 'orders',
      sampleDocs: [
        { contact_id: new ObjectId(), productId: 'sku-1', note: 'x' },
      ],
    });
    const byField = Object.fromEntries(candidates.map((c) => [c.sourceField, c]));
    expect(byField.contact_id?.targetCollection).toBe('contacts');
    expect(byField.productId?.targetCollection).toBe('products');
  });
});
