import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { DarkCtx } from '../../src/ThemeContext';
import { AggregationTab } from '../../src/pages/Workspace/Aggregation/AggregationTab';
import { DbCollectionNavigator } from '../../src/pages/Workspace/DbCollectionNavigator';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';
import { connectionFixture, installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionInfo } from '../../shared/ipc';
import type { AggregationTabState } from '@shared/types';

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

function mountNavigatorAndTab(
  rows: () => CollectionInfo[],
  mocks: Parameters<typeof installAtelierMock>[0],
  state: AggregationTabState = DEFAULT_AGGREGATION_TAB_STATE,
) {
  installAtelierMock({
    meta: {
      listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
      listCollections: async () => rows(),
    },
    ...mocks,
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
        state={state}
        darkMode={false}
        sourceCount={null}
        onPatch={vi.fn()}
      />
    </DarkCtx.Provider>,
  );
}

describe('Save as view — navigator refresh', () => {
  it('lists the new view in the navigator without a manual refresh', async () => {
    let created = false;
    mountNavigatorAndTab(
      () => (created ? [row('orders', 'collection'), row('open_orders', 'view')] : [row('orders', 'collection')]),
      {
        collection: {
          create: async (input) => {
            created = true;
            return { name: (input as { collection: string }).collection };
          },
        },
      },
    );
    await screen.findByTestId('nav-coll-shop-orders');
    expect(screen.queryByTestId('nav-coll-shop-open_orders')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Save as view/ }));
    await userEvent.type(await screen.findByLabelText('View name'), 'open_orders');
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() => expect(screen.getByTestId('nav-coll-shop-open_orders')).toBeTruthy());
  });
});

describe('Save as collection — navigator refresh', () => {
  it('lists the collection a $out created without a manual refresh', async () => {
    let written = false;
    mountNavigatorAndTab(
      () => (written ? [row('orders', 'collection'), row('monthly', 'collection')] : [row('orders', 'collection')]),
      {
        agg: {
          runAndSave: (async () => {
            written = true;
            return { writtenCount: 3 };
          }) as never,
        },
      },
      // Save as… needs a result to save.
      {
        ...DEFAULT_AGGREGATION_TAB_STATE,
        lastRun: { rows: [{ a: 1 }], durationMs: 1, ranAt: '2026-01-01T00:00:00.000Z', stageCounts: {}, stageSamples: {} },
      },
    );
    await screen.findByTestId('nav-coll-shop-orders');
    expect(screen.queryByTestId('nav-coll-shop-monthly')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    fireEvent.change(await screen.findByLabelText(/Target collection/), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'monthly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm $out' }));

    await waitFor(() => expect(screen.getByTestId('nav-coll-shop-monthly')).toBeTruthy());
  });
});
