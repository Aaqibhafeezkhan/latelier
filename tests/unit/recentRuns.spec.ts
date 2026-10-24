import { describe, it, expect } from 'vitest';
import { mergeConsecutive } from '../../src/pages/Workspace/views/recentRuns';
import type { RecentQuery } from '@shared/types';

let seq = 0;
function run(overrides: Partial<RecentQuery> = {}): RecentQuery {
  seq++;
  return {
    id: `r${seq}`,
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    kind: 'find',
    payload: {
      kind: 'find',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{ "status": "open" }',
    },
    ranAt: `2026-10-22T10:00:${String(60 - seq).padStart(2, '0')}Z`,
    durationMs: seq,
    resultCount: seq * 10,
    ...overrides,
  };
}

describe('mergeConsecutive', () => {
  it('returns an empty list for no runs', () => {
    expect(mergeConsecutive([])).toEqual([]);
  });

  it('keeps a lone run as a group of one', () => {
    const a = run();
    expect(mergeConsecutive([a])).toEqual([{ ...a, ids: [a.id] }]);
  });

  it('collapses adjacent identical runs into the newest (first) one', () => {
    const newest = run({ durationMs: 7, resultCount: 3, errorCode: 'X' });
    const middle = run();
    const oldest = run();
    const merged = mergeConsecutive([newest, middle, oldest]);
    expect(merged).toEqual([{ ...newest, ids: [newest.id, middle.id, oldest.id] }]);
  });

  it('does not merge identical runs that are not adjacent', () => {
    const a = run();
    const b = run({ collection: 'users' });
    const c = run();
    const merged = mergeConsecutive([a, b, c]);
    expect(merged.map((m) => m.ids)).toEqual([[a.id], [b.id], [c.id]]);
  });

  it('merges each group separately', () => {
    const a1 = run();
    const a2 = run();
    const b1 = run({ dbName: 'other' });
    const b2 = run({ dbName: 'other' });
    const b3 = run({ dbName: 'other' });
    const merged = mergeConsecutive([a1, a2, b1, b2, b3]);
    expect(merged.map((m) => [m.id, m.ids])).toEqual([
      [a1.id, [a1.id, a2.id]],
      [b1.id, [b1.id, b2.id, b3.id]],
    ]);
  });

  it('does not mutate its input', () => {
    const a = run();
    const b = run();
    mergeConsecutive([a, b]);
    expect(a).not.toHaveProperty('ids');
    expect(b).not.toHaveProperty('ids');
  });

  // One field differs at a time, so each half of the identity check is pinned.
  it.each<[string, Partial<RecentQuery>]>([
    ['connectionId', { connectionId: 'c2' }],
    ['dbName', { dbName: 'other' }],
    ['collection', { collection: 'users' }],
    ['kind', { kind: 'aggregation' }],
    [
      'payload',
      {
        payload: {
          kind: 'find',
          builder: { projection: [], sort: '', limit: '' },
          queryRaw: '{ "status": "closed" }',
        },
      },
    ],
  ])('does not merge adjacent runs whose %s differs', (_field, diff) => {
    const a = run();
    const b = run(diff);
    expect(mergeConsecutive([a, b]).map((m) => m.ids)).toEqual([[a.id], [b.id]]);
  });
});
