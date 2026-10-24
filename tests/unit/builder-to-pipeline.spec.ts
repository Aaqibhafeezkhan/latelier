import { describe, it, expect } from 'vitest';
import { DEFAULT_COLLECTION_TAB_STATE } from '@shared/defaults';
import type { BuilderState, CollectionTabState } from '@shared/types';
import { builderToStages, pipelineJsonForCopy } from '../../src/pages/Workspace/builderToPipeline';

function tab(queryRaw: string, builder: Partial<BuilderState> = {}, rest: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    ...DEFAULT_COLLECTION_TAB_STATE,
    ...rest,
    queryRaw,
    builder: { ...DEFAULT_COLLECTION_TAB_STATE.builder, ...builder },
  };
}

const opsOf = (s: CollectionTabState) => {
  const r = builderToStages(s);
  if (!r.ok) throw new Error(r.problem);
  return r.stages.map((st) => `${st.op} ${st.body}`);
};

describe('builderToStages (#156)', () => {
  it('emits $match, $sort, $limit, $project in find order, numbered from 1 and enabled', () => {
    const r = builderToStages(
      tab('{"status":"open"}', { sort: '{"age":-1}', limit: '25', projection: ['name'] }),
    );
    expect(r).toEqual({
      ok: true,
      stages: [
        { id: 1, op: '$match', body: '{"status":"open"}', enabled: true },
        { id: 2, op: '$sort', body: '{"age":-1}', enabled: true },
        { id: 3, op: '$limit', body: '25', enabled: true },
        { id: 4, op: '$project', body: '{"_id":1,"name":1}', enabled: true },
      ],
    });
  });

  it('omits each clause that is not set, and an empty filter', () => {
    expect(opsOf(tab('{}'))).toEqual([]);
    expect(opsOf(tab('  {}  '))).toEqual([]);
    expect(opsOf(tab('{}', { sort: '{"a":1}' }))).toEqual(['$sort {"a":1}']);
    expect(opsOf(tab('{}', { limit: '7' }))).toEqual(['$limit 7']);
    expect(opsOf(tab('{}', { projectionRaw: '{"_id":0}' }))).toEqual(['$project {"_id":0}']);
    expect(opsOf(tab('{"a":1}'))).toEqual(['$match {"a":1}']);
  });

  it('keeps Long and ObjectId text byte-for-byte', () => {
    const filter = '{"_id":{"$oid":"64b7f0c2a1b2c3d4e5f60718"},"n":{"$numberLong":"9007199254740993"}}';
    expect(opsOf(tab(filter))).toEqual([`$match ${filter}`]);
    const big = '{"n":9007199254740993}';
    expect(opsOf(tab(big))).toEqual([`$match ${big}`]);
  });

  it("uses the user's limit, not the page's skip/limit", () => {
    expect(opsOf(tab('{}', { limit: '120' }, { page: 2, pageSize: 50 }))).toEqual(['$limit 120']);
    expect(opsOf(tab('{}', { limit: '0' }))).toEqual([]);
  });

  it('rewrites "asc"/"desc" sort directions to numbers, which $sort requires', () => {
    expect(opsOf(tab('{}', { sort: '{"a":"asc","b":"DESC","c":1}' }))).toEqual([
      '$sort {"a":1,"b":-1,"c":1}',
    ]);
    expect(opsOf(tab('{}', { sort: '{"s":{"$meta":"textScore"},"d":"descending"}' }))).toEqual([
      '$sort {"s":{"$meta":"textScore"},"d":-1}',
    ]);
    // Numeric-only sorts stay verbatim, spacing included.
    expect(opsOf(tab('{}', { sort: '{ "a" : -1 }' }))).toEqual(['$sort { "a" : -1 }']);
  });

  it('refuses a filter operator that $match does not allow, wherever it sits', () => {
    const pt = '{"$geometry":{"type":"Point","coordinates":[0,0]}}';
    for (const [filter, op] of [
      ['{"$where":"true"}', '$where'],
      [`{"loc":{"$near":${pt}}}`, '$near'],
      [`{"loc":{"$nearSphere":${pt}}}`, '$nearSphere'],
      ['{"a":1,"$or":[{"b":2},{"$and":[{"$where":"this.a > 1"}]}]}', '$where'],
      [`{"$nor":[{"loc":{"$near":${pt}}}]}`, '$near'],
    ] as const) {
      expect(builderToStages(tab(filter))).toEqual({
        ok: false,
        problem: `The filter uses ${op}, which a pipeline's $match does not allow. Remove it to open this query as a pipeline.`,
      });
    }
  });

  it('keeps $text, $geoWithin and $expr, which $match allows', () => {
    for (const filter of [
      '{"$text":{"$search":"hello"}}',
      '{"loc":{"$geoWithin":{"$centerSphere":[[0,0],1]}}}',
      '{"$expr":{"$eq":["$a",1]}}',
      '{"s":"$where","n":null}',
    ]) {
      expect(opsOf(tab(filter))).toEqual([`$match ${filter}`]);
    }
  });

  it('refuses a find-only projection operator, which $project rejects', () => {
    for (const projectionRaw of [
      '{"items":{"$slice":2}}',
      '{"items":{"$slice":[1,2]}}',
      '{"items":{"$elemMatch":{"q":{"$gt":1}}}}',
      '{"items.$":1}',
      '{"a":{"b":{"$slice":1}}}',
      '{"a":1,"items":{"$slice":2}}',
      '{"a":[1],"b":{"c":1},"items.$":1}',
    ]) {
      const r = builderToStages(tab('{}', { projectionRaw }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toMatch(/^The projection uses .+, which only a find supports/);
    }
    expect(opsOf(tab('{}', { projectionRaw: '{"s":{"$meta":"textScore"},"a.b":1,"n":null}' }))).toEqual([
      '$project {"s":{"$meta":"textScore"},"a.b":1,"n":null}',
    ]);
  });

  it('keeps a non-string sort direction verbatim while rewriting the words', () => {
    // Re-serialising the parsed Long wrote its internals: {"high":-1,"low":-1,"unsigned":false}.
    expect(opsOf(tab('{}', { sort: '{"a":"desc","b":{"$numberLong":"-1"},"c":{"$numberInt":"1"}}' }))).toEqual([
      '$sort {"a":-1,"b":{"$numberLong":"-1"},"c":{"$numberInt":"1"}}',
    ]);
  });

  it('omits an empty sort or projection, which $sort and $project refuse', () => {
    expect(opsOf(tab('{}', { sort: '{}' }))).toEqual([]);
    expect(opsOf(tab('{}', { sort: ' { } ' }))).toEqual([]);
    expect(opsOf(tab('{}', { projectionRaw: '{}' }))).toEqual([]);
  });

  it('refuses an unrunnable query with the same reason Run gives', () => {
    expect(builderToStages(tab('{bad'))).toEqual({
      ok: false,
      problem: 'Can\'t parse this filter. Expected EJSON like { "status": "active" }.',
    });
    const r = builderToStages(tab('{}', { sort: '{"a":2}' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/Sort direction for "a"/);
  });
});

// W14 §9 — the aggregate channel takes no collation or hint, and dropping a
// collation would open a pipeline that matches a different set of documents.
describe('builderToStages with find options', () => {
  it('refuses a collation or a hint, naming which', () => {
    expect(builderToStages(tab('{}', { collation: '{"locale":"en"}' }))).toEqual({
      ok: false,
      problem: 'Open as pipeline does not carry the collation. Clear it to open this query as a pipeline.',
    });
    expect(builderToStages(tab('{}', { hint: '_id_' }))).toEqual({
      ok: false,
      problem: 'Open as pipeline does not carry the hint. Clear it to open this query as a pipeline.',
    });
  });

  it('opens a query whose only options are maxTimeMS and readPreference, or blank ones', () => {
    expect(opsOf(tab('{"a":1}', { maxTimeMS: '500', readPreference: 'nearest', collation: ' ', hint: '' }))).toEqual([
      '$match {"a":1}',
    ]);
  });
});

describe('pipelineJsonForCopy (#23)', () => {
  const st = (id: number, op: string, body: string, enabled = true) => ({ id, op, body, enabled });

  it('repairs Shell Syntax bodies and returns the enabled stages as Canonical EJSON', () => {
    expect(
      pipelineJsonForCopy([
        st(1, '$match', '{ status: "open" }'),
        st(2, '$limit', '9', false),
        st(3, '$sort', '{"n":-1}'),
      ]),
    ).toEqual({
      ok: true,
      json: '[{"$match":{"status":"open"}},{"$sort":{"n":{"$numberInt":"-1"}}}]',
    });
  });

  it('keeps a Long exact', () => {
    const r = pipelineJsonForCopy([st(1, '$match', '{"n":9007199254740993}')]);
    expect(r).toEqual({ ok: true, json: '[{"$match":{"n":{"$numberLong":"9007199254740993"}}}]' });
  });

  it('refuses the first body that cannot be repaired, by its position among all stages', () => {
    const r = pipelineJsonForCopy([st(1, '$limit', 'oops(', false), st(2, '$match', '{}'), st(3, '$match', '{ a: }')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/^stage 3 \(\$match\): Line 1, column 6: /);
    expect(pipelineJsonForCopy([st(1, '$match', '  ')])).toEqual({
      ok: false,
      problem: 'stage 1 ($match): The input is empty.',
    });
  });

  it('refuses a body that repairs but does not parse as EJSON', () => {
    const r = pipelineJsonForCopy([st(1, '$skip', '1', false), st(2, '$match', '{"_id":{"$oid":"nope"}}')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/^stage 2 \(\$match\): invalid EJSON/);
  });
});
