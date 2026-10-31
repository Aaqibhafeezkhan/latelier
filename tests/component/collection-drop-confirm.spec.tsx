import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { DropCollectionConfirm } from '../../src/pages/Workspace/DropCollectionConfirm';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSchemaEnumCache } from '../../src/features/fieldSuggestions/sources/schemaEnumSource';

// Spied so the write can be checked for dropping the cached enum suggestions.
vi.mock('../../src/features/fieldSuggestions/sources/schemaEnumSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/schemaEnumSource')>()),
  invalidateSchemaEnumCache: vi.fn(),
}));

afterEach(() => {
  vi.mocked(invalidateSchemaEnumCache).mockClear();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('DropCollectionConfirm', () => {
  it('states the drop cannot be undone', () => {
    render(
      <DropCollectionConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        onCancel={() => undefined}
        onDropped={() => undefined}
      />,
    );

    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
  });

  it('keeps Drop disabled until the typed name matches, then calls api.collection.drop', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        drop: async (input) => {
          calls.push(input);
          return { dropped: true };
        },
      },
    });
    const onDropped = vi.fn();

    render(
      <DropCollectionConfirm
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onCancel={() => {}}
        onDropped={onDropped}
      />,
    );

    const confirmInput = screen.getByLabelText('Confirm collection name');
    const dropBtn = screen.getByText('Drop').closest('button')!;
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(confirmInput, 'wrong');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(confirmInput);
    await userEvent.type(confirmInput, 'orders');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(dropBtn);

    await waitFor(() => expect(calls).toEqual([
      { connectionId: 'c1', dbName: 'shop', collection: 'orders' },
    ]));
    await waitFor(() => expect(onDropped).toHaveBeenCalled());
    expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1', 'shop', 'orders');
  });

  it('shows an inline error on API failure', async () => {
    installAtelierMock({
      collection: {
        drop: async () => {
          throw { code: 'UNAUTHORIZED', message: 'not allowed' };
        },
      },
    });

    render(
      <DropCollectionConfirm
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onCancel={() => {}}
        onDropped={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('Confirm collection name'), 'orders');
    await userEvent.click(screen.getByText('Drop').closest('button')!);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not allowed/));
  });

  // read-only connections keep Drop disabled even once the typed
  // name matches, and never call api.collection.drop.
  it('keeps Drop disabled and never calls api.collection.drop when readOnly is true, even with a matching name typed', async () => {
    const drop = vi.fn(async () => ({ dropped: true }));
    installAtelierMock({ collection: { drop } });

    render(
      <DropCollectionConfirm
        connectionId="c1"
        dbName="shop"
        collection="orders"
        readOnly
        onCancel={() => {}}
        onDropped={() => {}}
      />,
    );

    const confirmInput = screen.getByLabelText('Confirm collection name');
    const dropBtn = screen.getByText('Drop').closest('button')! as HTMLButtonElement;

    await userEvent.type(confirmInput, 'orders');
    expect(dropBtn.disabled).toBe(true);

    await userEvent.click(dropBtn);
    expect(drop).not.toHaveBeenCalled();
    expect(
      screen.getByText('This connection is read-only. Dropping is disabled.'),
    ).toBeTruthy();
  });
});
