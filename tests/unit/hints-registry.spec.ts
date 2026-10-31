import { describe, it, expect } from 'vitest';
import { HINT_REGISTRY } from '../../src/hints/registry';
import type { FeatureHintId } from '../../shared/types';
import { MONITOR_POLL_MS } from '../../src/utils/monitorPoll';
import { queryRunKey } from '../../src/utils/queryRunKey';

describe('HINT_REGISTRY', () => {
  const ids: FeatureHintId[] = [
    'run.execute',
    'refs.configure',
    'tabs.pin',
    'saved.create',
    'palette.discover',
    'suggestions.keyboard',
    'startup.restore',
    'monitor.live',
    'monitor.profiler',
    'indexes.usage',
    'find.options',
  ];

  it('contains every FeatureHintId exactly once', () => {
    for (const id of ids) {
      expect(HINT_REGISTRY[id]).toBeDefined();
      expect(HINT_REGISTRY[id].id).toBe(id);
    }
  });

  it('keeps copy lengths within reasonable bounds', () => {
    for (const id of ids) {
      const c = HINT_REGISTRY[id];
      expect(c.title.length).toBeLessThanOrEqual(60);
      expect(c.body.length).toBeLessThanOrEqual(200);
      expect(c.title.trim()).toBe(c.title);
    }
  });

  it('orders the behaviour hints after the original catalog', () => {
    const order: FeatureHintId[] = ['startup.restore', 'monitor.live', 'monitor.profiler', 'indexes.usage', 'find.options'];
    expect(order.map((id) => HINT_REGISTRY[id].priority)).toEqual([60, 70, 80, 90, 100]);
  });

  it('derives the monitor poll interval from the constant the tab polls on', () => {
    expect(HINT_REGISTRY['monitor.live'].body).toContain(`every ${MONITOR_POLL_MS / 1000} s`);
  });

  it('gives the primary-path Run hint the lowest priority number', () => {
    const runPriority = HINT_REGISTRY['run.execute'].priority;
    for (const id of ids) {
      if (id === 'run.execute') continue;
      expect(runPriority).toBeLessThan(HINT_REGISTRY[id].priority);
    }
  });
});

describe('queryRunKey', () => {
  const base = {
    connectionId: 'c1',
    dbName: 'db',
    collection: 'orders',
    projectionRaw: undefined,
  };

  it('produces the same key for equal inputs', () => {
    const a = queryRunKey({ ...base, filter: '{"x":1}', limit: 50 });
    const b = queryRunKey({ ...base, filter: '{"x":1}', limit: 50 });
    expect(a).toBe(b);
  });

  it('changes when the filter changes', () => {
    const a = queryRunKey({ ...base, filter: '{"x":1}' });
    const b = queryRunKey({ ...base, filter: '{"x":2}' });
    expect(a).not.toBe(b);
  });

  it('treats projection order as irrelevant', () => {
    const a = queryRunKey({ ...base, projection: ['name', 'email'] });
    const b = queryRunKey({ ...base, projection: ['email', 'name'] });
    expect(a).toBe(b);
  });

  it('separates two runs that differ only in the raw projection', () => {
    const a = queryRunKey({ ...base, projectionRaw: '{"secret":0}' });
    const b = queryRunKey({ ...base, projectionRaw: '{"notes":0}' });
    expect(a).not.toBe(b);
  });

  it('produces the same key for an identical raw projection', () => {
    const a = queryRunKey({ ...base, projectionRaw: '{"secret":0}' });
    const b = queryRunKey({ ...base, projectionRaw: '{"secret":0}' });
    expect(a).toBe(b);
  });

  // `compileFindOptions` lets a non-blank raw projection win verbatim and never
  // reads the modelled list, so these two runs execute identically and belong in
  // the same bucket.
  it('ignores the modelled projection once a raw one is set', () => {
    const a = queryRunKey({ ...base, projection: ['name'], projectionRaw: '{"secret":0}' });
    const b = queryRunKey({ ...base, projection: ['email'], projectionRaw: '{"secret":0}' });
    expect(a).toBe(b);
  });

  it('separates a raw projection from an equivalent modelled one', () => {
    const a = queryRunKey({ ...base, projection: ['name'] });
    const b = queryRunKey({ ...base, projectionRaw: '{"_id":1,"name":1}' });
    expect(a).not.toBe(b);
  });

  // Blank raw is what the escape hatch holds when it has been opened and left
  // empty; the compiler falls through to the modelled list, and so must this.
  it('falls back to the modelled projection when raw is blank', () => {
    const a = queryRunKey({ ...base, projection: ['name'], projectionRaw: '   ' });
    const b = queryRunKey({ ...base, projection: ['name'], projectionRaw: undefined });
    expect(a).toBe(b);
  });

  it('separates by collection', () => {
    expect(queryRunKey({ ...base })).not.toBe(
      queryRunKey({ ...base, collection: 'users' }),
    );
  });

  it('does not mutate the caller-provided projection array', () => {
    const projection = ['Zip', 'Name', 'age'];
    const before = [...projection];
    queryRunKey({ ...base, projection });
    expect(projection).toEqual(before);
  });

  it('joins every field into an exact, stable key for a fully-specified input', () => {
    // Locks down the literal separator and every field's blank/zero default,
    // not just pairwise equality — a wrong fallback (`&&` for `??`, or a
    // different fallback literal) changes this exact string.
    const key = queryRunKey({
      ...base,
      filter: '{"x":1}',
      sort: '{"x":1}',
      limit: 10,
      skip: 5,
      projection: ['b', 'a'],
      collation: '{"locale":"en"}',
      hint: '_id_',
      maxTimeMS: 500,
      readPreference: 'nearest',
    });
    const SEP = '\x1f';
    expect(key).toBe(
      [
        'c1', 'db', 'orders', '{"x":1}', `m${SEP}a${SEP}b`, '{"x":1}', 10, 5,
        '{"locale":"en"}', '_id_', 500, 'nearest',
      ].join(SEP),
    );
  });

  it('joins every field into an exact key when the optional fields are all absent', () => {
    const key = queryRunKey({ ...base });
    const SEP = '\x1f';
    expect(key).toBe(['c1', 'db', 'orders', '', `m${SEP}`, '', '', 0, '', '', '', ''].join(SEP));
  });

  it('sorts three distinct fields into exact code-unit order', () => {
    // Upper-case 'A' (0x41) sorts before either lower-case letter, and among
    // the lower-case ones 'b' (0x62) precedes 'c' (0x63) — every branch of
    // the comparator's three-way ternary is exercised by these two pairs.
    const key = queryRunKey({ ...base, projection: ['cherry', 'Apple', 'banana'] });
    const SEP = '\x1f';
    expect(key).toBe(
      ['c1', 'db', 'orders', '', `m${SEP}Apple${SEP}banana${SEP}cherry`, '', '', 0, '', '', '', ''].join(SEP),
    );
  });
});
