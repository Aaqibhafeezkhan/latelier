import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { RenameCollectionModal } from '../../src/pages/Workspace/RenameCollectionModal';
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

describe('RenameCollectionModal', () => {
  it('disables submit when empty or unchanged, then calls api.collection.rename', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        rename: async (input) => {
          calls.push(input);
          return { name: (input as { newName: string }).newName };
        },
      },
    });
    const onRenamed = vi.fn();

    render(
      <RenameCollectionModal
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onCancel={() => {}}
        onRenamed={onRenamed}
      />,
    );

    const submit = screen.getByText('Rename').closest('button')!;
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByLabelText('New name');
    await userEvent.type(input, 'orders');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(input);
    await userEvent.type(input, 'purchase_orders');
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(submit);

    await waitFor(() => expect(calls).toEqual([
      { connectionId: 'c1', dbName: 'shop', collection: 'orders', newName: 'purchase_orders' },
    ]));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('purchase_orders'));
    expect(vi.mocked(invalidateSchemaEnumCache).mock.calls).toEqual([
      ['c1', 'shop', 'orders'],
      ['c1', 'shop', 'purchase_orders'],
    ]);
  });

  // #91 — the button stays real-enabled while submitting (SubmitButton), so
  // the handler's own `submitting` guard is what stops a second activation
  // from firing a second request.
  it('ignores a second click while a rename is in flight, making one api.collection.rename call', async () => {
    let resolveRename!: (v: { name: string }) => void;
    const rename = vi.fn(() => new Promise<{ name: string }>((r) => (resolveRename = r)));
    installAtelierMock({ collection: { rename } });

    render(
      <RenameCollectionModal
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onCancel={() => {}}
        onRenamed={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('New name'), 'purchase_orders');
    const submit = screen.getByText('Rename').closest('button')!;
    await userEvent.click(submit);
    await userEvent.click(submit);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    resolveRename({ name: 'purchase_orders' });
  });

  it('shows an inline error on CONFLICT', async () => {
    installAtelierMock({
      collection: {
        rename: async () => {
          throw { code: 'CONFLICT', message: 'target already exists' };
        },
      },
    });

    render(
      <RenameCollectionModal
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onCancel={() => {}}
        onRenamed={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('New name'), 'existing');
    await userEvent.click(screen.getByText('Rename').closest('button')!);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/already exists/),
    );
  });
});
