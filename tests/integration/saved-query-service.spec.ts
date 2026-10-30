import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { ConflictError, NotFoundError } from '../../electron/errors';
import { createTempDb, type TempDb, createTempCipher, cellType } from '../helpers/db';
import type { SavedFindPayload } from '@shared/types';

const CONNECTION_ID = 'conn-1';
const DB_NAME = 'mydb';
const COLLECTION = 'users';

function makeFindPayload(): SavedFindPayload {
  return {
    kind: 'find',
    builder: {
      projection: [],
      sort: '',
      limit: '',
    },
    queryRaw: '{}',
  };
}

describe('SavedQueryService', () => {
  let tmp: TempDb;
  let repo: SavedQueryRepo;
  let svc: SavedQueryService;

  beforeEach(() => {
    tmp = createTempDb();
    repo = new SavedQueryRepo(tmp.db, createTempCipher());
    svc = new SavedQueryService(repo);

    // Insert a real connection row so FK constraint passes
    tmp.db.prepare(`
      INSERT INTO connections (
        id, name, color, connection_type, host, port,
        auth_mech, tls_enabled, tls_verify, ssh_enabled,
        connect_timeout_ms, socket_timeout_ms, server_selection_timeout_ms,
        read_preference, max_pool_size, direct_connection,
        created_at, updated_at
      ) VALUES (
        ?, 'Test', '#1A6835', 'standard', 'localhost', 27017,
        'none', 1, 1, 0,
        10000, 30000, 30000,
        'primary', 100, 0,
        ?, ?
      )
    `).run(CONNECTION_ID, new Date().toISOString(), new Date().toISOString());
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('create and get round-trip', () => {
    const created = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'My Query',
      payload: makeFindPayload(),
    });

    expect(created.id).toBeTruthy();
    expect(created.name).toBe('My Query');
    expect(created.kind).toBe('find');
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const fetched = svc.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe('My Query');
    expect(cellType(tmp.db, 'saved_queries', 'payload_json', created.id)).toBe('blob');
  });

  it('list returns created queries', () => {
    svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Query A',
      payload: makeFindPayload(),
    });
    svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Query B',
      payload: makeFindPayload(),
    });

    const list = svc.list({ connectionId: CONNECTION_ID });
    expect(list).toHaveLength(2);
    const names = list.map((q) => q.name);
    expect(names).toContain('Query A');
    expect(names).toContain('Query B');
  });

  it('update changes name and payload', () => {
    const created = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Original',
      payload: makeFindPayload(),
    });

    const updated = svc.update(created.id, {
      name: 'Renamed',
      payload: { ...makeFindPayload(), queryRaw: '{"active":true}' },
    });

    expect(updated.name).toBe('Renamed');
    expect((updated.payload as SavedFindPayload).queryRaw).toBe('{"active":true}');
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    expect(cellType(tmp.db, 'saved_queries', 'payload_json', created.id)).toBe('blob');
  });

  it('update keeps the stored description when the new payload names none', () => {
    const created = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Described',
      payload: { ...makeFindPayload(), description: 'keep me' },
    });

    const updated = svc.update(created.id, { payload: { ...makeFindPayload(), queryRaw: '{"a":1}' } });

    expect((updated.payload as SavedFindPayload).queryRaw).toBe('{"a":1}');
    expect((updated.payload as SavedFindPayload).description).toBe('keep me');
    expect(svc.get(created.id).description).toBe('keep me');
  });

  it('update with a name only leaves the stored description alone', () => {
    const created = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Described',
      payload: { ...makeFindPayload(), description: 'keep me' },
    });

    expect(svc.update(created.id, { name: 'Renamed' }).description).toBe('keep me');
  });

  it('delete removes the query', () => {
    const created = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'To Delete',
      payload: makeFindPayload(),
    });

    svc.delete(created.id);
    expect(() => svc.get(created.id)).toThrow(NotFoundError);
  });

  it('delete of non-existent id throws NotFoundError', () => {
    expect(() => svc.delete('does-not-exist')).toThrow(NotFoundError);
  });

  it('duplicate creates a new query with the new name', () => {
    const original = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Original',
      payload: makeFindPayload(),
    });

    const copy = svc.duplicate(original.id, 'Copy of Original');
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Copy of Original');
    expect(copy.connectionId).toBe(original.connectionId);
    expect(copy.kind).toBe(original.kind);
  });

  it('duplicate name within same scope throws ConflictError', () => {
    svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Existing',
      payload: makeFindPayload(),
    });

    expect(() =>
      svc.create({
        connectionId: CONNECTION_ID,
        dbName: DB_NAME,
        collection: COLLECTION,
        kind: 'find',
        name: 'Existing',
        payload: makeFindPayload(),
      }),
    ).toThrow(ConflictError);
  });

  it('same name is allowed in different collection scopes', () => {
    svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: 'colA',
      kind: 'find',
      name: 'SameName',
      payload: makeFindPayload(),
    });

    // Should not throw
    const second = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: 'colB',
      kind: 'find',
      name: 'SameName',
      payload: makeFindPayload(),
    });
    expect(second.id).toBeTruthy();
  });

  it('get throws NotFoundError for unknown id', () => {
    expect(() => svc.get('unknown-id')).toThrow(NotFoundError);
  });

  it('create with description persists it in payload and derives it onto the top-level summary/query', () => {
    const created = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Described Query',
      payload: { ...makeFindPayload(), description: 'my note' },
    });

    expect((created.payload as SavedFindPayload).description).toBe('my note');
    expect(created.description).toBe('my note');

    const fetched = svc.get(created.id);
    expect((fetched.payload as SavedFindPayload).description).toBe('my note');
    expect(fetched.description).toBe('my note');

    const list = svc.list({ connectionId: CONNECTION_ID });
    const summary = list.find((q) => q.id === created.id);
    expect(summary?.description).toBe('my note');
  });

  it('create without description leaves it undefined everywhere (backward compat)', () => {
    const created = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'No Description',
      payload: makeFindPayload(),
    });

    expect(created.description).toBeUndefined();

    const list = svc.list({ connectionId: CONNECTION_ID });
    const summary = list.find((q) => q.id === created.id);
    expect(summary?.description).toBeUndefined();
  });

  it('list() survives a row with corrupted payload_json instead of throwing', () => {
    // A well-formed sibling row — must still list correctly alongside the corrupted one.
    const good = svc.create({
      connectionId: CONNECTION_ID,
      dbName: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Healthy Row',
      payload: { ...makeFindPayload(), description: 'fine' },
    });

    // Bypass the service (which would JSON.stringify a valid payload) and write
    // deliberately corrupted JSON straight through the repo, simulating on-disk
    // corruption or a hand-edited row.
    repo.insert({
      id: 'corrupted-row',
      connection_id: CONNECTION_ID,
      db_name: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Corrupted Row',
      payload_json: '{not valid json',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    let list: ReturnType<typeof svc.list> = [];
    expect(() => {
      list = svc.list({ connectionId: CONNECTION_ID });
    }).not.toThrow();

    expect(list).toHaveLength(2);
    const corrupted = list.find((q) => q.id === 'corrupted-row');
    expect(corrupted).toBeDefined();
    expect(corrupted?.description).toBeUndefined();

    const healthy = list.find((q) => q.id === good.id);
    expect(healthy?.description).toBe('fine');
  });

  it('get() on a row with corrupted payload_json does not throw', () => {
    repo.insert({
      id: 'corrupted-row-2',
      connection_id: CONNECTION_ID,
      db_name: DB_NAME,
      collection: COLLECTION,
      kind: 'find',
      name: 'Corrupted Row 2',
      payload_json: '{not valid json',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    let fetched: ReturnType<typeof svc.get> | undefined;
    expect(() => {
      fetched = svc.get('corrupted-row-2');
    }).not.toThrow();

    expect(fetched?.id).toBe('corrupted-row-2');
    expect(fetched?.description).toBeUndefined();
  });
});
