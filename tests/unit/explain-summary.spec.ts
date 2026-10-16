import { describe, it, expect } from 'vitest';
import { buildPlanTree, summarizeExplain } from '../../src/utils/explainSummary';

describe('summarizeExplain', () => {
  it('(a) find COLLSCAN → collscan:true, usesIndex:false', () => {
    const plan = { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['COLLSCAN']);
    expect(summary?.collscan).toBe(true);
    expect(summary?.usesIndex).toBe(false);
    expect(summary?.indexName).toBeUndefined();
  });

  it('(b) find IXSCAN → usesIndex:true + indexName/keyPattern', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          stage: 'FETCH',
          inputStage: {
            stage: 'IXSCAN',
            indexName: 'email_1',
            keyPattern: { email: 1 },
          },
        },
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['FETCH', 'IXSCAN']);
    expect(summary?.collscan).toBe(false);
    expect(summary?.usesIndex).toBe(true);
    expect(summary?.indexName).toBe('email_1');
    expect(summary?.keyPattern).toEqual({ email: 1 });
  });

  it('(c) aggregation {stages:[{$cursor:{queryPlanner:…}}]} → normalized stage chain', () => {
    const plan = {
      stages: [
        {
          $cursor: {
            queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
          },
        },
      ],
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['COLLSCAN']);
    expect(summary?.collscan).toBe(true);
  });

  it('(d) executionStats present → metric fields populated', () => {
    const plan = {
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: {
        nReturned: 5,
        totalDocsExamined: 100,
        totalKeysExamined: 0,
        executionTimeMillis: 12,
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBe(5);
    expect(summary?.docsExamined).toBe(100);
    expect(summary?.keysExamined).toBe(0);
    expect(summary?.executionTimeMillis).toBe(12);
  });

  it('(d2) executionStats nested under aggregation $cursor → metric fields populated', () => {
    const plan = {
      stages: [
        {
          $cursor: {
            queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
            executionStats: {
              nReturned: 3,
              totalDocsExamined: 3,
              totalKeysExamined: 0,
              executionTimeMillis: 1,
            },
          },
        },
      ],
    };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBe(3);
    expect(summary?.docsExamined).toBe(3);
  });

  it('(e) queryPlanner-only → metrics undefined', () => {
    const plan = { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBeUndefined();
    expect(summary?.docsExamined).toBeUndefined();
    expect(summary?.keysExamined).toBeUndefined();
    expect(summary?.executionTimeMillis).toBeUndefined();
  });

  it('(f) sharded shards[] → does not crash, extracts what it can', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          stage: 'SINGLE_SHARD',
          shards: [
            {
              shardName: 'shard01',
              winningPlan: {
                stage: 'FETCH',
                inputStage: {
                  stage: 'IXSCAN',
                  indexName: 'a_1',
                  keyPattern: { a: 1 },
                },
              },
            },
          ],
        },
      },
      executionStats: {
        nReturned: 5,
        totalDocsExamined: 5,
        totalKeysExamined: 5,
        executionTimeMillis: 12,
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['FETCH', 'IXSCAN']);
    expect(summary?.usesIndex).toBe(true);
    expect(summary?.indexName).toBe('a_1');
    expect(summary?.nReturned).toBe(5);
  });

  it('(g) SBE / queryPlan-nested → no crash', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'FETCH',
            inputStage: {
              stage: 'IXSCAN',
              indexName: 'x_1',
              keyPattern: { x: 1 },
            },
          },
          slotBasedPlan: { stages: 'irrelevant string form' },
        },
      },
      executionStats: {
        nReturned: 1,
        totalDocsExamined: 1,
        totalKeysExamined: 1,
        executionTimeMillis: 0,
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['FETCH', 'IXSCAN']);
    expect(summary?.indexName).toBe('x_1');
  });

  it('(h) unknown/empty {} → null', () => {
    expect(summarizeExplain({})).toBeNull();
  });

  it('(h) unrecognized shape → null', () => {
    expect(summarizeExplain({ weird: 1 })).toBeNull();
  });

  it('(h) non-object → null', () => {
    expect(summarizeExplain(null)).toBeNull();
    expect(summarizeExplain(undefined)).toBeNull();
    expect(summarizeExplain(42)).toBeNull();
    expect(summarizeExplain('foo')).toBeNull();
    expect(summarizeExplain([1, 2, 3])).toBeNull();
  });

  it('(i) inputStages[] fallback is only used when inputStage is absent, and only its first element is read', () => {
    // No `inputStage`, so nextStage must fall through to the `inputStages`
    // array branch — and it must actually return element 0, not skip it.
    const plan = {
      queryPlanner: {
        winningPlan: { stage: 'A', inputStages: [{ stage: 'B' }] },
      },
    };
    expect(summarizeExplain(plan)?.stages).toEqual(['A', 'B']);
  });

  it('(j) a stage node with no `stage` string of its own contributes nothing to the chain', () => {
    const plan = {
      queryPlanner: {
        winningPlan: { stage: 'A', inputStage: { indexName: 'no-stage-field' } },
      },
    };
    // The inner node has no `.stage` string, so it must not appear (not even
    // as `undefined`) in the collected chain.
    expect(summarizeExplain(plan)?.stages).toEqual(['A']);
  });

  it('(k) IXSCAN indexName is only read when it is actually a string', () => {
    const plan = {
      queryPlanner: {
        winningPlan: { stage: 'IXSCAN', indexName: 42, keyPattern: { a: 1 } },
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary?.indexName).toBeUndefined();
    expect(summary?.keyPattern).toEqual({ a: 1 });
  });

  it('(l) the aggregation $cursor lookup skips a non-cursor entry ahead of the real one', () => {
    const plan = {
      stages: [
        { tag: 'noise' },
        { $cursor: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } } },
      ],
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['COLLSCAN']);
  });

  it('(m) an aggregation stages[] with no $cursor entry at all → null, not a crash', () => {
    expect(summarizeExplain({ stages: [{ tag: 'noise' }] })).toBeNull();
  });

  it('(n) a non-record queryPlanner (e.g. carrying its own stray winningPlan property) is rejected, not read through', () => {
    const fakeQueryPlanner = (() => undefined) as unknown as Record<string, unknown> & {
      winningPlan?: unknown;
    };
    fakeQueryPlanner.winningPlan = { stage: 'IXSCAN', indexName: 'ghost_1' };
    expect(summarizeExplain({ queryPlanner: fakeQueryPlanner })).toBeNull();
  });

  it('(o) a winning plan with no recognizable `stage` anywhere in its chain → null', () => {
    expect(summarizeExplain({ queryPlanner: { winningPlan: { foo: 1 } } })).toBeNull();
  });

  it('(p) executionStats fields are only copied when they are actually numbers', () => {
    const plan = {
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: {
        nReturned: 'five',
        totalDocsExamined: 'lots',
        totalKeysExamined: 'none',
        executionTimeMillis: 'slow',
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBeUndefined();
    expect(summary?.docsExamined).toBeUndefined();
    expect(summary?.keysExamined).toBeUndefined();
    expect(summary?.executionTimeMillis).toBeUndefined();
  });

  it('(q) a sharded winningPlan with a non-array shards holder is not treated as shards[]', () => {
    // `shards` here is array-*like* (has a numeric '0' key) but is not a real
    // array, so `Array.isArray` must reject it — isolates that guard from the
    // `isRecord(shard0) && isRecord(shard0.winningPlan)` check just below it.
    const winningPlan: Record<string, unknown> = { stage: 'FETCH' };
    (winningPlan as Record<string, unknown>).shards = {
      0: { winningPlan: { stage: 'IXSCAN', indexName: 'z_1' } },
    };
    const summary = summarizeExplain({ queryPlanner: { winningPlan } });
    expect(summary?.stages).toEqual(['FETCH']);
    expect(summary?.usesIndex).toBe(false);
  });

  it('(q2) a non-record winningPlan (e.g. carrying its own stray queryPlan property) is rejected before the SBE-nesting check ever sees it', () => {
    const rootPlan = (() => undefined) as unknown as Record<string, unknown> & {
      queryPlan?: unknown;
    };
    rootPlan.queryPlan = { stage: 'IXSCAN', indexName: 'y_1' };
    expect(summarizeExplain({ queryPlanner: { winningPlan: rootPlan } })).toBeNull();
  });

  it('(r) shards[0] is only followed when it is a record whose own winningPlan is also a record', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          stage: 'FETCH',
          shards: [{ shardName: 'shard0', winningPlan: 'not-a-record' }],
        },
      },
    };
    // shard0.winningPlan fails isRecord, so the outer winningPlan must be left
    // alone — not replaced by the string.
    expect(summarizeExplain(plan)?.stages).toEqual(['FETCH']);
  });
});

describe('buildPlanTree', () => {
  const sortFetchIx = {
    queryPlanner: {
      winningPlan: {
        stage: 'SORT',
        inputStage: {
          stage: 'FETCH',
          inputStage: { stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } },
        },
      },
    },
    executionStats: {
      executionStages: {
        stage: 'SORT',
        nReturned: 9,
        executionTimeMillisEstimate: 2,
        inputStage: {
          stage: 'FETCH',
          nReturned: 9,
          executionTimeMillisEstimate: 1,
          docsExamined: 10,
          inputStage: {
            stage: 'IXSCAN',
            nReturned: 10,
            executionTimeMillisEstimate: 0,
            keysExamined: 10,
            indexName: 'a_1',
            keyPattern: { a: 1 },
          },
        },
      },
    },
  };

  it('(1) executionStats SORT -> FETCH -> IXSCAN is a 3-deep tree carrying each node\'s own figures', () => {
    const root = buildPlanTree(sortFetchIx);
    expect(root).toMatchObject({ stage: 'SORT', nReturned: 9, timeMs: 2, collscan: false });
    expect(root?.children).toHaveLength(1);
    const fetch = root!.children[0];
    expect(fetch).toMatchObject({ stage: 'FETCH', nReturned: 9, timeMs: 1, docsExamined: 10 });
    expect(fetch.keysExamined).toBeUndefined();
    const ix = fetch.children[0];
    expect(ix).toMatchObject({
      stage: 'IXSCAN',
      nReturned: 10,
      timeMs: 0,
      keysExamined: 10,
      indexName: 'a_1',
      keyPattern: { a: 1 },
    });
    expect(ix.docsExamined).toBeUndefined();
    expect(ix.children).toEqual([]);
  });

  it('(2) inputStages yields one child per element, not just the first', () => {
    const root = buildPlanTree({
      queryPlanner: {
        winningPlan: {
          stage: 'SUBPLAN',
          inputStage: {
            stage: 'OR',
            inputStages: [
              { stage: 'IXSCAN', indexName: 'a_1' },
              { stage: 'IXSCAN', indexName: 'b_1' },
            ],
          },
        },
      },
    });
    const or = root!.children[0];
    expect(or.children.map((c) => c.indexName)).toEqual(['a_1', 'b_1']);
  });

  it('(3) only COLLSCAN nodes are flagged collscan', () => {
    const root = buildPlanTree({
      queryPlanner: { winningPlan: { stage: 'FETCH', inputStage: { stage: 'COLLSCAN' } } },
    });
    expect(root?.collscan).toBe(false);
    expect(root?.children[0].collscan).toBe(true);
  });

  it('(4) a queryPlanner-only plan has the same shape with every figure undefined', () => {
    const root = buildPlanTree({ queryPlanner: sortFetchIx.queryPlanner });
    expect(root?.stage).toBe('SORT');
    expect(root?.children[0].stage).toBe('FETCH');
    const ix = root!.children[0].children[0];
    expect(ix).toMatchObject({ stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } });
    for (const n of [root!, root!.children[0], ix]) {
      expect(Object.keys(n).filter((k) => ['nReturned', 'docsExamined', 'keysExamined', 'timeMs'].includes(k))).toEqual([]);
    }
    expect('keyPattern' in root!).toBe(false);
  });

  it('(5) an aggregation puts the $cursor subtree first under a synthetic pipeline root', () => {
    const root = buildPlanTree({
      stages: [
        { $cursor: sortFetchIx },
        { $group: { _id: '$a' }, nReturned: 4, executionTimeMillisEstimate: 3 },
        { $sort: { n: 1 }, nReturned: 4, executionTimeMillisEstimate: 1 },
      ],
    });
    expect(root?.stage).toBe('pipeline');
    expect(root?.collscan).toBe(false);
    expect(root?.children.map((c) => c.stage)).toEqual(['SORT', '$group', '$sort']);
    expect(root!.children[0].children[0].stage).toBe('FETCH');
    expect(root!.children[1]).toMatchObject({ nReturned: 4, timeMs: 3, collscan: false, children: [] });
    expect(root!.children[2]).toMatchObject({ nReturned: 4, timeMs: 1 });
  });

  it('(6) SBE builds the classic-name tree from queryPlan, with no per-stage counts', () => {
    const root = buildPlanTree({
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'FETCH',
            inputStage: { stage: 'IXSCAN', indexName: 'x_1' },
          },
          slotBasedPlan: { stages: '[1] project ...' },
        },
      },
      executionStats: {
        executionStages: { stage: 'project', nReturned: 5, inputStage: { stage: 'ixseek', nReturned: 5 } },
      },
    });
    expect(root?.stage).toBe('FETCH');
    expect(root?.nReturned).toBeUndefined();
    expect(root?.children[0]).toMatchObject({ stage: 'IXSCAN', indexName: 'x_1' });
    expect(root?.children[0].nReturned).toBeUndefined();
  });

  it('(7) a sharded plan has one child per shard', () => {
    const root = buildPlanTree({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { shardName: 's0', winningPlan: { stage: 'COLLSCAN' } },
            { shardName: 's1', winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN' } } },
          ],
        },
      },
    });
    expect(root?.stage).toBe('SHARD_MERGE');
    expect(root?.children.map((c) => c.stage)).toEqual(['COLLSCAN', 'FETCH']);
  });

  it('(7b) a sharded executionStats plan reads each shard\'s executionStages', () => {
    const root = buildPlanTree({
      queryPlanner: { winningPlan: { stage: 'SHARD_MERGE' } },
      executionStats: {
        executionStages: {
          stage: 'SHARD_MERGE',
          nReturned: 3,
          shards: [{ shardName: 's0', executionStages: { stage: 'COLLSCAN', nReturned: 3, docsExamined: 8 } }],
        },
      },
    });
    expect(root?.children).toHaveLength(1);
    expect(root?.children[0]).toMatchObject({ stage: 'COLLSCAN', nReturned: 3, docsExamined: 8, collscan: true });
  });

  it('(8) non-numeric figures are not copied', () => {
    const root = buildPlanTree({
      queryPlanner: { winningPlan: { stage: 'IXSCAN' } },
      executionStats: {
        executionStages: {
          stage: 'IXSCAN',
          nReturned: '9',
          executionTimeMillisEstimate: null,
          docsExamined: {},
          keysExamined: 'x',
          indexName: 5,
        },
      },
    });
    expect(root).toStrictEqual({ stage: 'IXSCAN', collscan: false, children: [] });
  });

  it('(9) null, {}, and unknown shapes give null', () => {
    expect(buildPlanTree(null)).toBeNull();
    expect(buildPlanTree(undefined)).toBeNull();
    expect(buildPlanTree('plan')).toBeNull();
    expect(buildPlanTree({})).toBeNull();
    expect(buildPlanTree({ weird: 1 })).toBeNull();
    expect(buildPlanTree({ queryPlanner: { winningPlan: {} } })).toBeNull();
    expect(buildPlanTree({ stages: [{ $group: {} }] })).toBeNull();
  });

  it('(9b) falls back to the winning plan when executionStages is not a record', () => {
    const root = buildPlanTree({
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: { executionStages: 'nope' },
    });
    expect(root).toMatchObject({ stage: 'COLLSCAN', collscan: true });
  });

  it('(9c) skips non-record entries among inputStages and a stage with no name', () => {
    const root = buildPlanTree({
      queryPlanner: {
        winningPlan: { stage: 'OR', inputStages: [null, 'x', { stage: 'IXSCAN' }, { noStage: 1 }] },
      },
    });
    expect(root?.children.map((c) => c.stage)).toEqual(['IXSCAN']);
  });

  it('(9d) stays total on malformed shards, winning plans and aggregation entries', () => {
    expect(buildPlanTree({ queryPlanner: { winningPlan: null } })).toBeNull();
    expect(
      buildPlanTree({ queryPlanner: { winningPlan: { stage: 'SHARD_MERGE', shards: [null, 'x'] } } })?.children,
    ).toEqual([]);
    expect(buildPlanTree({ stages: [{ $cursor: { weird: 1 } }, { $group: {} }] })).toBeNull();
  });

  it('(9e) an aggregation lists the entries after the $cursor that name a $-operator', () => {
    const cursor = { $cursor: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } } };
    const root = buildPlanTree({
      stages: [{ $limit: 1 }, cursor, null, 'x', { nReturned: 3 }, { $sort: {}, nReturned: 1 }],
    });
    expect(root?.children.map((c) => c.stage)).toEqual(['COLLSCAN', '$sort']);
  });

  // `agg:explain` sends the plan through canonical EJSON, so every number in a
  // real aggregation explain arrives as `{ $numberInt: '2' }` (find:explain does
  // not). Shape captured from MongoDB 8.0.5 for `aggregate([{ $match: {} }])`.
  const canonicalAggStats = {
    queryPlanner: { winningPlan: { isCached: false, stage: 'COLLSCAN', direction: 'forward' } },
    executionStats: {
      executionSuccess: true,
      nReturned: { $numberInt: '2' },
      executionTimeMillis: { $numberInt: '0' },
      totalKeysExamined: { $numberInt: '0' },
      totalDocsExamined: { $numberInt: '2' },
      executionStages: {
        isCached: false,
        stage: 'COLLSCAN',
        nReturned: { $numberInt: '2' },
        executionTimeMillisEstimate: { $numberInt: '3' },
        docsExamined: { $numberInt: '2' },
        direction: 'forward',
      },
    },
  };

  it('(11) reads figures wrapped as canonical EJSON numbers, as an aggregation explain sends them', () => {
    expect(buildPlanTree(canonicalAggStats)).toStrictEqual({
      stage: 'COLLSCAN',
      collscan: true,
      nReturned: 2,
      timeMs: 3,
      docsExamined: 2,
      children: [],
    });
    expect(summarizeExplain(canonicalAggStats)).toMatchObject({
      nReturned: 2,
      docsExamined: 2,
      keysExamined: 0,
      executionTimeMillis: 0,
    });
  });

  it('(11b) accepts $numberLong and $numberDouble, and refuses anything that is not a lone numeric wrapper', () => {
    const stage = (v: unknown) =>
      buildPlanTree({ queryPlanner: { winningPlan: { stage: 'FETCH', nReturned: v } } })?.nReturned;
    expect(stage({ $numberLong: '12' })).toBe(12);
    expect(stage({ $numberDouble: '1.5' })).toBe(1.5);
    expect(stage({ $numberInt: 'abc' })).toBeUndefined();
    expect(stage({ $numberInt: '' })).toBeUndefined();
    expect(stage({ $numberInt: '  ' })).toBeUndefined();
    expect(stage({ $numberInt: 7 })).toBeUndefined();
    expect(stage({ $numberInt: '1', extra: 1 })).toBeUndefined();
    expect(stage({ $numberDecimal: '1' })).toBeUndefined();
  });

  it('(11c) shows a wrapped keyPattern as plain numbers', () => {
    const root = buildPlanTree({
      queryPlanner: {
        winningPlan: {
          stage: 'DISTINCT_SCAN',
          indexName: 'sku_1',
          keyPattern: { sku: { $numberInt: '1' }, tags: [{ $numberInt: '-1' }] },
        },
      },
    });
    expect(root?.keyPattern).toEqual({ sku: 1, tags: [-1] });
  });

  it('(11d) leaves non-numeric keyPattern values as they are', () => {
    const root = buildPlanTree({
      queryPlanner: { winningPlan: { stage: 'IXSCAN', keyPattern: { body: 'text', gone: null } } },
    });
    expect(root?.keyPattern).toStrictEqual({ body: 'text', gone: null });
  });

  it('(11e) the summary has no metric keys when the stats carry no numbers', () => {
    const summary = summarizeExplain({
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: { nReturned: 'x', totalDocsExamined: null, totalKeysExamined: {}, executionTimeMillis: [] },
    });
    expect(Object.keys(summary!).sort()).toEqual(['collscan', 'stages', 'usesIndex']);
  });

  it('(12c) a shard name that is not a string is not copied', () => {
    const root = buildPlanTree({
      queryPlanner: { winningPlan: { stage: 'SHARD_MERGE', shards: [{ shardName: 5, winningPlan: { stage: 'COLLSCAN' } }] } },
    });
    expect(root?.children[0]).toStrictEqual({ stage: 'COLLSCAN', collscan: true, children: [] });
  });

  it('(12) an SBE shard builds its classic tree from queryPlan and names its shard', () => {
    const root = buildPlanTree({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            {
              shardName: 'rs0',
              winningPlan: {
                queryPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'x_1' } },
                slotBasedPlan: { stages: '[1] ...' },
              },
            },
            { shardName: 'rs1', winningPlan: { stage: 'COLLSCAN' } },
          ],
        },
      },
    });
    expect(root?.shardName).toBeUndefined();
    expect(root?.children.map((c) => [c.shardName, c.stage])).toEqual([
      ['rs0', 'FETCH'],
      ['rs1', 'COLLSCAN'],
    ]);
    expect(root?.children[0].children[0]).toMatchObject({ stage: 'IXSCAN', indexName: 'x_1' });
    expect(root?.children[0].children[0].shardName).toBeUndefined();
  });

  it('(12b) a shard with SBE winning plan ignores its lowercase slot-tree executionStages', () => {
    const root = buildPlanTree({
      queryPlanner: { winningPlan: { stage: 'SHARD_MERGE' } },
      executionStats: {
        executionStages: {
          stage: 'SHARD_MERGE',
          shards: [
            {
              shardName: 'rs0',
              winningPlan: { queryPlan: { stage: 'COLLSCAN' } },
              executionStages: { stage: 'project', nReturned: 4 },
            },
          ],
        },
      },
    });
    expect(root?.children[0]).toMatchObject({ stage: 'COLLSCAN', shardName: 'rs0' });
    expect(root?.children[0].nReturned).toBeUndefined();
  });

  it('(10) the badge summary names the index for IXSCAN and none for COLLSCAN', () => {
    expect(summarizeExplain(sortFetchIx)).toMatchObject({ usesIndex: true, collscan: false, indexName: 'a_1' });
    const scan = summarizeExplain({ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } });
    expect(scan).toMatchObject({ collscan: true, usesIndex: false });
    expect(scan?.indexName).toBeUndefined();
  });
});
