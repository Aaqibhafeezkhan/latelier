import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { DarkCtx } from '../../src/ThemeContext';
import { AggregationTab } from '../../src/pages/Workspace/Aggregation/AggregationTab';
import { DbCollectionNavigator } from '../../src/pages/Workspace/DbCollectionNavigator';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';
import { connectionFixture, installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionInfo } from '../../shared/ipc';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const row = (name: string, type: 'collection' | 'view'): CollectionInfo => ({
  name,
  type,
  documentCount: 0,
  sizeBytes: 0,
  indexCount: 0,
  capped: false,
});

describe('Save as view — navigator refresh', () => {
  it('lists the new view in the navigator without a manual refresh', async () => {
    let created = false;
    installAtelierMock({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () =>
          created ? [row('orders', 'collection'), row('open_orders', 'view')] : [row('orders', 'collection')],
      },
      collection: {
        create: async (input) => {
          created = true;
          return { name: (input as { collection: string }).collection };
        },
      },
    });

    render(
      <DarkCtx.Provider value={false}>
        <DbCollectionNavigator
          connectionsWithTabs={new Set()}
          connections={[connectionFixture({ id: 'c1', name: 'Prod' })]}
          focusedConnectionId="c1"
          activeDbName="shop"
          activeCollection="orders"
          onOpenCollection={vi.fn()}
          onOpenAggregation={vi.fn()}
        />
        <AggregationTab
          connectionId="c1"
          dbName="shop"
          collection="orders"
          state={DEFAULT_AGGREGATION_TAB_STATE}
          darkMode={false}
          sourceCount={null}
          onPatch={vi.fn()}
        />
      </DarkCtx.Provider>,
    );
    await screen.findByTestId('nav-coll-shop-orders');
    expect(screen.queryByTestId('nav-coll-shop-open_orders')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Save as view/ }));
    await userEvent.type(await screen.findByLabelText('View name'), 'open_orders');
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() => expect(screen.getByTestId('nav-coll-shop-open_orders')).toBeTruthy());
  });
});
