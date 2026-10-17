import { describe, it, expect } from 'vitest';
import {
  CLEAR_FILTER_PATCH,
  columnResizePatch,
  rowExpandPatch,
  schemaPatch,
} from '../../src/pages/Workspace/collectionPatches';
import { DEFAULT_SCHEMA_TAB_STATE } from '@shared/defaults';
import type { CollectionTabState } from '@shared/types';

const BASE: CollectionTabState = {
  view: 'Tree',
  builder: { projection: [], sort: '', limit: '' },
  queryRaw: '{}',
  page: 0,
  pageSize: 50,
  activeBuilderTab: 'Builder',
};

describe('columnResizePatch', () => {
  it('adds a width for a field with no prior columns', () => {
    expect(columnResizePatch(BASE, 'sku', 120)).toEqual({ columns: { sku: { width: 120 } } });
  });

  it('merges into existing columns, leaving other fields untouched', () => {
    const prev = { ...BASE, columns: { sku: { width: 80 } } };
    expect(columnResizePatch(prev, 'qty', 60)).toEqual({
      columns: { sku: { width: 80 }, qty: { width: 60 } },
    });
  });

  it('overwrites the width for a field already resized', () => {
    const prev = { ...BASE, columns: { sku: { width: 80 } } };
    expect(columnResizePatch(prev, 'sku', 200)).toEqual({ columns: { sku: { width: 200 } } });
  });
});

describe('rowExpandPatch', () => {
  it('adds a row id with no prior expandedRows', () => {
    expect(rowExpandPatch(BASE, 'doc1', true)).toEqual({ expandedRows: { doc1: true } });
  });

  it('adds a second row id alongside an already-expanded one', () => {
    const prev = { ...BASE, expandedRows: { doc1: true } };
    expect(rowExpandPatch(prev, 'doc2', true)).toEqual({
      expandedRows: { doc1: true, doc2: true },
    });
  });

  // The mutant this pins: `next[docId] = false` instead of `delete
  // next[docId]`. Rendering can't tell the difference (TreeView/TableView
  // only ever read `!!expandedRows[docId]`), but `expandedRows` is
  // persisted to `workspace_tabs.state_json` on every patch — `= false`
  // would leave a permanent key for every row ever collapsed, growing the
  // stored object without bound over a session.
  it('collapsing removes the key entirely rather than setting it false', () => {
    const prev = { ...BASE, expandedRows: { doc1: true, doc2: true } };
    const result = rowExpandPatch(prev, 'doc1', false);
    expect(result).toEqual({ expandedRows: { doc2: true } });
    expect('doc1' in result.expandedRows!).toBe(false);
    expect(Object.keys(result.expandedRows!)).toEqual(['doc2']);
  });

  it('collapsing an id with no prior expandedRows yields an empty object', () => {
    expect(rowExpandPatch(BASE, 'doc1', false)).toEqual({ expandedRows: {} });
  });
});

describe('schemaPatch', () => {
  it('merges a patch on top of DEFAULT_SCHEMA_TAB_STATE when no prior schema exists', () => {
    expect(schemaPatch(BASE, { sampleSize: 25 })).toEqual({
      schema: { ...DEFAULT_SCHEMA_TAB_STATE, sampleSize: 25 },
    });
  });

  // The mutant this pins: spread order flipped to `{...patch,
  // ...(prev.schema ?? DEFAULT)}`, which would let a stale field on
  // `prev.schema` win over the incoming patch instead of the other way
  // round.
  it('the incoming patch overwrites a field already set on prev.schema', () => {
    const prev = { ...BASE, schema: { sampleSize: 10, ranAt: '2026-08-01T00:00:00.000Z' } };
    const result = schemaPatch(prev, { ranAt: '2026-08-22T00:00:00.000Z' });
    expect(result).toEqual({
      schema: { sampleSize: 10, ranAt: '2026-08-22T00:00:00.000Z' },
    });
  });

  it('preserves fields on prev.schema the patch does not touch', () => {
    const prev = { ...BASE, schema: { sampleSize: 10, sampledCount: 8 } };
    expect(schemaPatch(prev, { ranAt: 'now' })).toEqual({
      schema: { sampleSize: 10, sampledCount: 8, ranAt: 'now' },
    });
  });
});

describe('CLEAR_FILTER_PATCH', () => {
  it('is the empty-filter constant', () => {
    expect(CLEAR_FILTER_PATCH).toEqual({ queryRaw: '{}' });
  });

  it('clears the persisted filter draft too, by carrying the key as undefined', () => {
    // A patch value of `undefined` is what deletes the key on merge; a draft
    // left behind could bring back rows of the filter just cleared.
    expect('filterDraft' in CLEAR_FILTER_PATCH).toBe(true);
    expect(CLEAR_FILTER_PATCH.filterDraft).toBeUndefined();
  });
});
