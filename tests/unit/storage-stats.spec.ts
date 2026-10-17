import { describe, it, expect } from 'vitest';
import { foldStorageStats } from '../../electron/mongo/MetaService';

describe('foldStorageStats', () => {
  it('reads a single-node reply', () => {
    expect(
      foldStorageStats([
        { storageStats: { count: 3, size: 300, nindexes: 2, storageSize: 4096, totalIndexSize: 8192, avgObjSize: 100 } },
      ]),
    ).toEqual({
      documentCount: 3,
      sizeBytes: 300,
      indexCount: 2,
      storageSizeBytes: 4096,
      totalIndexSizeBytes: 8192,
      avgObjSizeBytes: 100,
    });
  });

  it('sums count and sizes across the per-shard documents of a sharded cluster', () => {
    const out = foldStorageStats([
      { storageStats: { count: 3, size: 300, nindexes: 2, storageSize: 1000, totalIndexSize: 50 } },
      { storageStats: { count: 7, size: 700, nindexes: 2, storageSize: 2000, totalIndexSize: 70 } },
    ]);
    expect(out).toMatchObject({
      documentCount: 10,
      sizeBytes: 1000,
      storageSizeBytes: 3000,
      totalIndexSizeBytes: 120,
    });
    // Every shard holds the same indexes: summing would double the count.
    expect(out.indexCount).toBe(2);
    // Recomputed from the totals; the per-shard averages cannot be added.
    expect(out.avgObjSizeBytes).toBe(100);
  });

  it('leaves a figure undefined when no shard reported it (time-series has no count)', () => {
    const out = foldStorageStats([{ storageStats: { size: 10, nindexes: 0, storageSize: 5, totalIndexSize: 1 } }]);
    expect(out.documentCount).toBeUndefined();
    expect(out.avgObjSizeBytes).toBeUndefined();
    expect(out.sizeBytes).toBe(10);
  });

  it('sums only the shards that reported a figure', () => {
    expect(
      foldStorageStats([{ storageStats: { count: 4 } }, { storageStats: {} }, {}]).documentCount,
    ).toBe(4);
  });

  it('takes the first creation time it finds', () => {
    expect(
      foldStorageStats([
        { storageStats: { wiredTiger: { creationTime: 'a' } } },
        { storageStats: { wiredTiger: { creationTime: 'b' } } },
      ]).lastModified,
    ).toBe('a');
  });

  it('reports nothing for an empty reply', () => {
    expect(foldStorageStats([])).toEqual({});
  });
});
