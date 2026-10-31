import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTempDb, type TempDb, createTempCipher } from '../helpers/db';
import { RecentFieldValueRepo } from '../../electron/db/repositories/RecentFieldValueRepo';
import { RecentFieldValueService } from '../../electron/services/RecentFieldValueService';

function insertConnection(tmp: TempDb, id: string): void {
  const now = new Date().toISOString();
  tmp.db.prepare(
    `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
     VALUES (?, ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
  ).run(id, id, now, now);
}

describe('RecentFieldValueService', () => {
  let tmp: TempDb | null = null;

  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  function setup(): { svc: RecentFieldValueService; repo: RecentFieldValueRepo } {
    tmp = createTempDb();
    insertConnection(tmp, 'c1');
    const repo = new RecentFieldValueRepo(tmp.db, createTempCipher());
    return { svc: new RecentFieldValueService(repo), repo };
  }

  it('upserting the same (field, value) again bumps use_count instead of inserting a second row', () => {
    const { svc } = setup();
    const entry = { field: 'status', value: 'shipped', valType: 'string' as const, op: '$eq' };
    svc.recordMany('c1', 'shop', 'orders', [entry]);
    svc.recordMany('c1', 'shop', 'orders', [entry]);
    const values = svc.listForField('c1', 'shop', 'orders', 'status');
    expect(values).toHaveLength(1);
    expect(values[0]!.frequency).toBe(2);
    expect(tmp!.db.prepare('SELECT typeof(value) AS v, typeof(value_mac) AS m FROM recent_field_values').all()).toEqual([
      { v: 'blob', m: 'text' },
    ]);
  });

  it('evicts down to the 50-row cap, keeping the most recently used', () => {
    const { svc } = setup();
    // `last_used_at` breaks the eviction tie, so the clock must actually
    // advance between inserts, or same-millisecond timestamps make eviction
    // order (and this assertion) nondeterministic.
    const base = new Date('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      for (let i = 0; i < 55; i += 1) {
        svc.recordMany('c1', 'shop', 'orders', [
          { field: 'status', value: `status-${i}`, valType: 'string', op: '$eq' },
        ]);
        vi.setSystemTime(new Date(base.getTime() + (i + 1) * 1000));
      }
    } finally {
      vi.useRealTimers();
    }
    const values = svc.listForField('c1', 'shop', 'orders', 'status', 100);
    expect(values).toHaveLength(50);
    // The earliest-inserted values (status-0..status-4) were evicted first.
    expect(values.map((v) => v.value)).not.toContain('status-0');
    expect(values.map((v) => v.value)).toContain('status-54');
  });

  it('refuses a field whose path names a secret, at any dotted depth', () => {
    const { svc } = setup();
    const result = svc.recordMany('c1', 'shop', 'orders', [
      { field: 'password', value: 'hunter2', valType: 'string', op: '$eq' },
      { field: 'auth.sshPassword', value: 'hunter2', valType: 'string', op: '$eq' },
      { field: 'status', value: 'shipped', valType: 'string', op: '$eq' },
    ]);
    expect(result.recorded).toBe(1);
    expect(svc.listForField('c1', 'shop', 'orders', 'password')).toHaveLength(0);
    expect(svc.listForField('c1', 'shop', 'orders', 'auth.sshPassword')).toHaveLength(0);
    expect(svc.listForField('c1', 'shop', 'orders', 'status')).toHaveLength(1);
  });

  it.each(['token', 'secret', 'apiKey', 'authorization', 'passphrase', 'ssh_password', 'ssh_passphrase', 'session.Token'])(
    'refuses the secret-named field %s',
    (field) => {
      const { svc } = setup();
      const result = svc.recordMany('c1', 'shop', 'orders', [
        { field, value: 'abc', valType: 'string', op: '$eq' },
      ]);
      expect(result.recorded).toBe(0);
      expect(svc.listForField('c1', 'shop', 'orders', field)).toHaveLength(0);
    },
  );

  it('refuses an op outside the recordable set', () => {
    const { svc } = setup();
    const result = svc.recordMany('c1', 'shop', 'orders', [
      { field: 'tags', value: 'x', valType: 'string', op: '$regex' },
      { field: 'tags', value: 'x', valType: 'string', op: '$exists' },
    ]);
    expect(result.recorded).toBe(0);
    expect(svc.listForField('c1', 'shop', 'orders', 'tags')).toHaveLength(0);
  });

  it('scopes lookups to (connection, db, collection, field) — no cross-connection leak', () => {
    const { svc } = setup();
    insertConnection(tmp!, 'c2');
    svc.recordMany('c1', 'shop', 'orders', [
      { field: 'status', value: 'shipped', valType: 'string', op: '$eq' },
    ]);
    svc.recordMany('c2', 'shop', 'orders', [
      { field: 'status', value: 'pending', valType: 'string', op: '$eq' },
    ]);
    expect(svc.listForField('c1', 'shop', 'orders', 'status').map((v) => v.value)).toEqual(['shipped']);
    expect(svc.listForField('c2', 'shop', 'orders', 'status').map((v) => v.value)).toEqual(['pending']);
  });

  it('clearAll wipes every row regardless of scope', () => {
    const { svc } = setup();
    svc.recordMany('c1', 'shop', 'orders', [
      { field: 'status', value: 'shipped', valType: 'string', op: '$eq' },
    ]);
    expect(svc.clearAll()).toEqual({ deleted: 1 });
    expect(svc.listForField('c1', 'shop', 'orders', 'status')).toHaveLength(0);
  });

  it('cascades on connection delete', () => {
    const { svc, repo } = setup();
    svc.recordMany('c1', 'shop', 'orders', [
      { field: 'status', value: 'shipped', valType: 'string', op: '$eq' },
    ]);
    expect(repo.deleteByConnection('c1')).toBe(1);
    expect(svc.listForField('c1', 'shop', 'orders', 'status')).toHaveLength(0);
  });
});
