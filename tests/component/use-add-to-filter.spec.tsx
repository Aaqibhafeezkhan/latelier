import { describe, it, expect } from 'vitest';
import { act, renderHook, emptyWorkspaceActions } from '../helpers/render';
import { useAddToFilter } from '../../src/pages/Workspace/views/useAddToFilter';
import type { CollectionTabState } from '@shared/types';

// The Run gate accepts a filter padded with Unicode spaces (NBSP, BOM) that
// `JSON.parse` refuses. Add to filter reads the same `queryRaw`, so it must
// extend that filter rather than refuse it as "not valid JSON".
describe('useAddToFilter — a filter padded with Unicode spaces', () => {
  it('adds the field to the padded filter instead of refusing it', async () => {
    const state: CollectionTabState = {
      view: 'Table',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '﻿{"status":"active"} ',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Saved',
    };
    const actions = emptyWorkspaceActions();
    const { result } = renderHook(() => useAddToFilter({ state, actions }));

    await act(async () => {
      await result.current('name', 'ada');
    });

    expect(actions.patch).toHaveBeenCalledTimes(1);
    const patch = (actions.patch as unknown as { mock: { calls: [Partial<CollectionTabState>][] } }).mock.calls[0]![0];
    expect(JSON.parse(patch.queryRaw!)).toEqual({
      $and: [{ status: { $eq: 'active' } }, { name: { $eq: 'ada' } }],
    });
  });
});
