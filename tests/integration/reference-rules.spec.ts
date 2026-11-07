import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Double, Int32, Long, ObjectId } from 'bson';
import type { Document } from 'mongodb';
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

  it('resolves an array of numbers whatever numeric type each side stores', async () => {
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    await db.collection('items').deleteMany({});
    await db.collection('items').insertMany([
      { _id: new Int32(5), name: 'int' },
      { _id: Long.fromNumber(6), name: 'long' },
      { _id: new Double(7), name: 'double' },
    ] as unknown as Document[]);

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
      valueEjson: JSON.stringify([{ $numberLong: '5' }, { $numberDouble: '6.0' }, { $numberInt: '7' }]),
    });

    expect(result.documents.map((d) => (d as Record<string, unknown>).name)).toEqual(['int', 'long', 'double']);
  });

  it('returns a resolved document with its numbers in their stored type', async () => {
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    await db.collection('items').deleteMany({});
    await db.collection('items').insertOne({
      _id: new Int32(1),
      code: Long.fromNumber(5),
      qty: new Double(7),
      nested: { qty: new Double(7) },
    } as unknown as Document);

    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_code',
      targetDb: DB_NAME,
      targetCollection: 'items',
      targetField: 'code',
    });

    // The source holds an Int32; the server matches it to the stored Long.
    const result = await svc.resolve({ ruleId: rule.id, valueEjson: '{"$numberInt":"5"}' });

    expect(result.documents).toEqual([
      {
        _id: { $numberInt: '1' },
        code: { $numberLong: '5' },
        qty: { $numberDouble: '7.0' },
        nested: { qty: { $numberDouble: '7.0' } },
      },
    ]);
  });

  it('keeps source order across numeric types and returns each number as stored', async () => {
    const wide = '9007199254740993';
    const client = await pool.write(CONN_ID).client();
    const db = client.db(DB_NAME);
    await db.collection('items').deleteMany({});
    await db.collection('items').insertMany([
      { _id: new Int32(5), name: 'int' },
      { _id: Long.fromNumber(6), name: 'long' },
      { _id: new Double(7), name: 'double' },
      { _id: new Double(2.5), name: 'fraction' },
      { _id: Long.fromString(wide), name: 'wide' },
    ] as unknown as Document[]);

    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_ids',
      targetDb: DB_NAME,
      targetCollection: 'items',
      projection: ['name'],
    });

    // Every whole number here is spelled in a type other than the stored one.
    const result = await svc.resolve({
      ruleId: rule.id,
      valueEjson: JSON.stringify([
        { $numberLong: wide },
        { $numberLong: '7' },
        { $numberInt: '6' },
        { $numberDouble: '2.5' },
        { $numberDouble: '5.0' },
      ]),
    });

    expect(result.documents).toEqual([
      { _id: { $numberLong: wide }, name: 'wide' },
      { _id: { $numberDouble: '7.0' }, name: 'double' },
      { _id: { $numberLong: '6' }, name: 'long' },
      { _id: { $numberDouble: '2.5' }, name: 'fraction' },
      { _id: { $numberInt: '5' }, name: 'int' },
    ]);
  });

  async function seedItems(docs: Document[]): Promise<void> {
    const db = (await pool.write(CONN_ID).client()).db(DB_NAME);
    await db.collection('items').deleteMany({});
    await db.collection('items').insertMany(docs);
  }

  function names(result: { documents: unknown[] }): unknown[] {
    return result.documents.map((d) => (d as Record<string, unknown>).name);
  }

  it('keeps source order when the projection leaves out the target field (#706)', async () => {
    await seedItems([
      { code: 'b', name: 'B' },
      { code: 'a', name: 'A' },
    ]);
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_codes',
      targetDb: DB_NAME,
      targetCollection: 'items',
      targetField: 'code',
      projection: ['name'],
    });

    const result = await svc.resolve({ ruleId: rule.id, valueEjson: '["a","b"]' });

    expect(names(result)).toEqual(['A', 'B']);
  });

  it.each([
    ['no projection', []],
    ['a projection without it', ['name']],
  ])('keeps source order for a dotted target field with %s (#706)', async (_label, projection) => {
    await seedItems([
      { n: { k: 'b' }, name: 'B' },
      { n: { k: 'a' }, name: 'A' },
    ]);
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_keys',
      targetDb: DB_NAME,
      targetCollection: 'items',
      targetField: 'n.k',
      projection,
    });

    const result = await svc.resolve({ ruleId: rule.id, valueEjson: '["a","b"]' });

    expect(names(result)).toEqual(['A', 'B']);
  });

  it('projects nothing extra when the projection already covers the target field', async () => {
    // Adding `n.k` beside `n` would be a path collision the server refuses.
    await seedItems([
      { n: { k: 'b' }, name: 'B' },
      { n: { k: 'a' }, name: 'A' },
    ]);
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_keys',
      targetDb: DB_NAME,
      targetCollection: 'items',
      targetField: 'n.k',
      projection: ['n'],
    });

    const result = await svc.resolve({ ruleId: rule.id, valueEjson: '["a","b"]' });

    expect(result.documents.map((d) => (d as { n: { k: string } }).n.k)).toEqual(['a', 'b']);
  });

  it.each([
    ['a Decimal128 against an Int32', new Int32(5), { $numberDecimal: '5' }],
    ['a Double against a Long past 2^53', Long.fromString('9007199254740994'), { $numberDouble: '9007199254740994' }],
    ['-0 against 0', new Double(0), { $numberDouble: '-0.0' }],
  ])('keeps a match the key cannot pair: %s (#706)', async (_label, stored, source) => {
    await seedItems([
      { _id: stored, name: 'odd' },
      { _id: new Int32(1), name: 'plain' },
    ] as unknown as Document[]);
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_ids',
      targetDb: DB_NAME,
      targetCollection: 'items',
    });

    const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify([source, { $numberInt: '1' }]) });

    // Paired documents keep source order; the server's other matches follow.
    expect(names(result)).toEqual(['plain', 'odd']);
  });

  it('keeps every document that shares a target value (#706)', async () => {
    await seedItems([
      { code: 'a', name: 'A1' },
      { code: 'a', name: 'A2' },
    ]);
    const rule = svc.create({
      connectionId: CONN_ID,
      sourceDb: DB_NAME,
      sourceCollection: 'orders',
      sourceField: 'item_codes',
      targetDb: DB_NAME,
      targetCollection: 'items',
      targetField: 'code',
    });

    const result = await svc.resolve({ ruleId: rule.id, valueEjson: '["a"]' });

    expect([...names(result)].sort((x, y) => String(x).localeCompare(String(y)))).toEqual(['A1', 'A2']);
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

  describe('array source, a document the server matched is never dropped', () => {
    async function seedItems(docs: unknown[]): Promise<void> {
      const client = await pool.write(CONN_ID).client();
      const items = client.db(DB_NAME).collection('items');
      await items.deleteMany({});
      await items.insertMany(docs as Document[]);
    }

    function itemsRule(targetField: string, projection?: string[]) {
      return svc.create({
        connectionId: CONN_ID,
        sourceDb: DB_NAME,
        sourceCollection: 'orders',
        sourceField: 'item_ids',
        targetDb: DB_NAME,
        targetCollection: 'items',
        targetField,
        projection,
      });
    }

    it('pairs by a targetField the projection leaves out, and does not show it', async () => {
      await seedItems([
        { _id: 1, code: 'c', name: 'C' },
        { _id: 2, code: 'a', name: 'A' },
        { _id: 3, code: 'b', name: 'B' },
      ]);
      const rule = itemsRule('code', ['name']);

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify(['a', 'b', 'c']) });

      expect(result.found).toBe(true);
      expect(result.documents).toEqual([
        { _id: { $numberInt: '2' }, name: 'A' },
        { _id: { $numberInt: '3' }, name: 'B' },
        { _id: { $numberInt: '1' }, name: 'C' },
      ]);
    });

    it('pairs by a dotted targetField', async () => {
      await seedItems([
        { _id: 1, n: { k: 'c' }, name: 'C' },
        { _id: 2, n: { k: 'a' }, name: 'A' },
      ]);
      const rule = itemsRule('n.k');

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify(['a', 'c']) });

      expect(result.documents.map((d) => (d as Record<string, unknown>).name)).toEqual(['A', 'C']);
    });

    it('pairs by a dotted targetField the projection leaves out, without leaking its parent', async () => {
      await seedItems([
        { _id: 1, n: { k: 'c' }, name: 'C' },
        { _id: 2, n: { k: 'a' }, name: 'A' },
      ]);
      const rule = itemsRule('n.k', ['name']);

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify(['a', 'c']) });

      expect(result.documents).toEqual([
        { _id: { $numberInt: '2' }, name: 'A' },
        { _id: { $numberInt: '1' }, name: 'C' },
      ]);
    });

    it('pairs when the projection already reaches into the targetField', async () => {
      await seedItems([
        { _id: 1, n: { k: 'c', z: 1 } },
        { _id: 2, n: { k: 'a', z: 2 } },
      ]);
      const rule = itemsRule('n.k', ['n.k', 'n.z']);

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify(['a', 'c']) });

      expect(result.documents).toEqual([
        { _id: { $numberInt: '2' }, n: { k: 'a', z: { $numberInt: '2' } } },
        { _id: { $numberInt: '1' }, n: { k: 'c', z: { $numberInt: '1' } } },
      ]);
    });

    it('pairs when the projection holds only a part of the targetField', async () => {
      await seedItems([
        { _id: 1, n: { k: { x: 1, y: 1 } }, name: 'C' },
        { _id: 2, n: { k: { x: 2, y: 2 } }, name: 'A' },
      ]);
      const rule = itemsRule('n.k.x', ['n.k.y']);

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify([2, 1]) });

      expect(result.documents).toEqual([
        { _id: { $numberInt: '2' }, n: { k: { y: { $numberInt: '2' } } } },
        { _id: { $numberInt: '1' }, n: { k: { y: { $numberInt: '1' } } } },
      ]);
    });

    it('pairs through an array of subdocuments on the targetField path', async () => {
      await seedItems([
        { _id: 1, n: [{ k: 'x' }, { k: 'c' }], name: 'C' },
        { _id: 2, n: [{ k: 'a' }], name: 'A' },
      ]);
      const rule = itemsRule('n.k');

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify(['a', 'c']) });

      expect(result.documents.map((d) => (d as Record<string, unknown>).name)).toEqual(['A', 'C']);
    });

    it('keeps every document that shares a targetField value', async () => {
      await seedItems([
        { _id: 1, code: 'a', name: 'first' },
        { _id: 2, code: 'a', name: 'second' },
      ]);
      const rule = itemsRule('code');

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: JSON.stringify(['a', 'a']) });

      expect(result.documents.map((d) => (d as Record<string, unknown>).name)).toEqual(['first', 'second']);
    });

    it('keeps a Decimal128 source value that matches a stored Int32', async () => {
      await seedItems([{ _id: new Int32(5), name: 'int' }]);
      const rule = itemsRule('_id', ['name']);

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: '[{"$numberDecimal":"5"}]' });

      expect(result.found).toBe(true);
      expect(result.documents).toEqual([{ _id: { $numberInt: '5' }, name: 'int' }]);
    });

    it('keeps a Double source value that matches a wide stored Long', async () => {
      const wide = '9007199254740994';
      await seedItems([{ _id: Long.fromString(wide), name: 'wide' }]);
      const rule = itemsRule('_id', ['name']);

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: `[{"$numberDouble":"${wide}.0"}]` });

      expect(result.found).toBe(true);
      expect(result.documents).toEqual([{ _id: { $numberLong: wide }, name: 'wide' }]);
    });

    it('keeps a negative-zero source value that matches a stored zero', async () => {
      await seedItems([{ _id: new Double(0), name: 'zero' }]);
      const rule = itemsRule('_id', ['name']);

      const result = await svc.resolve({ ruleId: rule.id, valueEjson: '[{"$numberDouble":"-0.0"}]' });

      expect(result.found).toBe(true);
      expect(result.documents).toEqual([{ _id: { $numberDouble: '0.0' }, name: 'zero' }]);
    });

    it('puts a document that pairs with no source value after the ones that do, in server order', async () => {
      await seedItems([
        { _id: new Int32(1), name: 'one' },
        { _id: new Int32(5), name: 'five' },
        { _id: new Int32(2), name: 'two' },
      ]);
      const rule = itemsRule('_id', ['name']);

      // 1 and 2 pair; Decimal128(5) matches the stored Int32 5 but keys apart.
      const result = await svc.resolve({
        ruleId: rule.id,
        valueEjson: '[{"$numberInt":"2"},{"$numberDecimal":"5"},{"$numberInt":"1"}]',
      });

      expect(result.documents.map((d) => (d as Record<string, unknown>).name)).toEqual(['two', 'one', 'five']);
    });

    it('agrees with the single-value path on the same rule and value', async () => {
      await seedItems([{ _id: 1, code: 'a', name: 'A' }]);
      const rule = itemsRule('code', ['name']);

      const single = await svc.resolve({ ruleId: rule.id, valueEjson: '"a"' });
      const array = await svc.resolve({ ruleId: rule.id, valueEjson: '["a"]' });

      expect(array.found).toBe(single.found);
      expect(array.documents).toEqual(single.documents);
    });
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
