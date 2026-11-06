import { describe, it, expect } from 'vitest';
import { isViewCollection } from '../../src/pages/Workspace/isViewCollection';
import type { NavigatorTreeState } from '../../src/pages/Workspace/navigatorTreeReducer';

const tree = {
  caches: {
    c1: {
      dbs: null,
      colls: {
        shop: [
          { name: 'orders', type: 'collection', capped: false },
          { name: 'orders_view', type: 'view', capped: false },
        ],
      },
      err: null,
      dbsLoading: false,
      collsLoading: {},
    },
  },
} as unknown as NavigatorTreeState;

describe('isViewCollection', () => {
  it('is true only for a listed view', () => {
    expect(isViewCollection(tree, 'c1', 'shop', 'orders_view')).toBe(true);
    expect(isViewCollection(tree, 'c1', 'shop', 'orders')).toBe(false);
  });

  it('is false for a namespace the listing has not reached', () => {
    expect(isViewCollection(tree, 'c1', 'other', 'orders_view')).toBe(false);
    expect(isViewCollection(tree, 'c2', 'shop', 'orders_view')).toBe(false);
    expect(isViewCollection(tree, 'c1', 'shop', 'missing')).toBe(false);
  });
});
