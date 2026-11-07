import { describe, it, expect } from 'vitest';
import {
  bandOccupant,
  latestFailedConnection,
  resultPaneKind,
  revertTarget,
} from '../../src/pages/Workspace/resultPaneState';
import { resultQueryKey } from '../../src/pages/Workspace/builder';
import type { CollectionTabState, ConnectionSummary, LastRun } from '@shared/types';

function state(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    ...overrides,
  };
}

const run = (overrides: Partial<LastRun> = {}): LastRun => ({
  documents: [],
  durationMs: 0,
  ranAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('resultPaneKind', () => {
  it('a tab with no run has not run', () => {
    expect(resultPaneKind(state())).toBe('never-run');
  });

  it('rows are rows, even when a refused run left an error beside them', () => {
    expect(resultPaneKind(state({ lastRun: run({ documents: [{ _id: 1 }] }) }))).toBe('rows');
    expect(
      resultPaneKind(
        state({
          lastRun: run({ documents: [{ _id: 1 }], error: { code: 'VALIDATION', message: 'bad' } }),
        }),
      ),
    ).toBe('rows');
  });

  it.each(['VALIDATION', 'MONGO_ERROR', 'TIMEOUT', 'NOT_FOUND'])('%s is the query failing', (code) => {
    expect(resultPaneKind(state({ lastRun: run({ error: { code, message: 'x' } }) }))).toBe('query-error');
  });

  it.each(['NETWORK', 'UNAUTHORIZED', 'DB_ERROR', 'INTERNAL'])('%s is not about the query', (code) => {
    expect(resultPaneKind(state({ lastRun: run({ error: { code, message: 'x' } }) }))).toBe('failed');
  });

  it('nothing back from {} on the first page means the collection is empty', () => {
    expect(resultPaneKind(state({ lastRun: run() }))).toBe('empty-collection');
  });

  it('nothing back from a filter, or past the first page, means no match', () => {
    expect(resultPaneKind(state({ queryRaw: '{"a":1}', lastRun: run() }))).toBe('no-match');
    expect(resultPaneKind(state({ page: 2, lastRun: run() }))).toBe('no-match');
  });

  it('{} in the box does not make a filter that found nothing an empty collection', () => {
    const ran = resultQueryKey(state({ queryRaw: '{"a":1}' }))!;
    expect(resultPaneKind(state({ queryRaw: '{}', lastRun: run(), lastRunQueryKey: ran }))).toBe('no-match');
  });

  it('{} that did run and found nothing is an empty collection', () => {
    const ran = resultQueryKey(state())!;
    expect(resultPaneKind(state({ lastRun: run(), lastRunQueryKey: ran }))).toBe('empty-collection');
  });
});

describe('revertTarget', () => {
  const builder = { projection: [], sort: '', limit: '' };

  it('has nothing to offer before a query has succeeded', () => {
    expect(revertTarget(state())).toBeNull();
  });

  it('offers the last valid query when the filter differs', () => {
    const last = { queryRaw: '{"a":1}', builder };
    expect(revertTarget(state({ queryRaw: '{"$bad":1}', lastValidQuery: last }))).toBe(last);
  });

  it('offers it when only the options differ', () => {
    const last = { queryRaw: '{}', builder };
    expect(
      revertTarget(state({ builder: { ...builder, hint: 'gone_1' }, lastValidQuery: last })),
    ).toBe(last);
  });

  it('does not offer the very query that just failed', () => {
    expect(revertTarget(state({ lastValidQuery: { queryRaw: '{}', builder } }))).toBeNull();
  });
});

describe('bandOccupant', () => {
  it.each([
    [{ lost: true, running: true, selected: true }, 'lost'],
    [{ lost: false, running: true, selected: true }, 'running'],
    [{ lost: false, running: false, selected: true }, 'selection'],
    [{ lost: false, running: false, selected: false }, 'none'],
  ] as const)('%o holds %s', (input, expected) => {
    expect(bandOccupant(input)).toBe(expected);
  });
});

describe('latestFailedConnection', () => {
  const conn = (id: string, status: ConnectionSummary['status']) =>
    ({ id, name: id, status }) as ConnectionSummary;

  it('is null when none has failed, whatever the error map still holds', () => {
    expect(latestFailedConnection([conn('a', 'connected')], { a: {} })).toBeNull();
  });

  it('is the one that failed last', () => {
    const list = [conn('a', 'error'), conn('b', 'error')];
    expect(latestFailedConnection(list, { b: {}, a: {} })?.id).toBe('a');
    expect(latestFailedConnection(list, { a: {}, b: {} })?.id).toBe('b');
  });

  it('is the last of three, not the second', () => {
    const list = [conn('a', 'error'), conn('b', 'error'), conn('c', 'error')];
    expect(latestFailedConnection(list, { a: {}, b: {}, c: {} })?.id).toBe('c');
  });

  it('still names a failure with no message yet', () => {
    expect(latestFailedConnection([conn('a', 'unknown'), conn('b', 'error')], {})?.id).toBe('b');
  });
});
