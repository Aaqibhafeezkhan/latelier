import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import { IndexesTab } from '../../src/pages/IndexesTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// The disconnected/empty-pick states this file used to cover here belonged
// to `IndexesHost`, the Connection Manager's Indexes-tab picker — deleted
// along with that tab (W16 Tier 2, ADR 0003; the index surface is now the
// collection tab's Structure view, which is namespace-scoped and has no
// picker to be empty).
describe('IndexesTab — error states', () => {
  it('shows an UNAUTHORIZED-specific banner when index:list throws', async () => {
    installAtelierMock({
      index: {
        list: async () => {
          throw { code: 'UNAUTHORIZED', message: 'not authorized on alpha' };
        },
      },
    });
    render(<IndexesTab connectionId="c1" dbName="alpha" collection="people" />);
    await waitFor(() => {
      expect(
        screen.getByText(/lacks the privilege to read indexes on alpha\.people/),
      ).toBeTruthy();
    });
  });
});

describe('IndexesTab — a view', () => {
  it('makes no index.list call and says the view uses its source collection indexes', async () => {
    const list = vi.fn(async () => []);
    installAtelierMock({ index: { list } });
    render(<IndexesTab connectionId="c1" dbName="shop" collection="v_paid" viewOn="orders" />);
    expect(
      await screen.findByText(
        'Views have no indexes of their own. This view uses the indexes of orders, the collection it reads from.',
      ),
    ).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /New index/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Drop/ })).toBeNull();
  });

  it('still lists indexes for a collection', async () => {
    const list = vi.fn(async () => []);
    installAtelierMock({ index: { list } });
    render(<IndexesTab connectionId="c1" dbName="shop" collection="orders" />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /New index/ })).toBeTruthy();
  });
});
