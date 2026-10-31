import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { DropDatabaseConfirm } from '../../src/pages/Workspace/DropDatabaseConfirm';
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

describe('DropDatabaseConfirm', () => {
  it('states the drop cannot be undone', () => {
    render(
      <DropDatabaseConfirm
        connectionId="c1"
        dbName="app"
        onCancel={() => undefined}
        onDropped={() => undefined}
      />,
    );

    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
  });

  it('keeps Drop disabled until the typed DB name matches, then calls api.database.drop', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      database: {
        drop: async (input) => {
          calls.push(input);
          return { dropped: true };
        },
      },
    });
    const onDropped = vi.fn();

    render(
      <DropDatabaseConfirm
        connectionId="c1"
        dbName="shop"
        onCancel={() => {}}
        onDropped={onDropped}
      />,
    );

    const confirmInput = screen.getByLabelText('Confirm database name');
    const dropBtn = screen.getByText('Drop database').closest('button')!;
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(confirmInput, 'wrong');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(confirmInput);
    await userEvent.type(confirmInput, 'shop');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(dropBtn);

    await waitFor(() => expect(calls).toEqual([{ connectionId: 'c1', dbName: 'shop' }]));
    await waitFor(() => expect(onDropped).toHaveBeenCalled());
    expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('shows an inline error on API failure', async () => {
    installAtelierMock({
      database: {
        drop: async () => {
          throw { code: 'UNAUTHORIZED', message: 'not allowed' };
        },
      },
    });

    render(
      <DropDatabaseConfirm connectionId="c1" dbName="shop" onCancel={() => {}} onDropped={() => {}} />,
    );

    await userEvent.type(screen.getByLabelText('Confirm database name'), 'shop');
    await userEvent.click(screen.getByText('Drop database').closest('button')!);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not allowed/));
  });

  // read-only connections keep Drop database disabled even once the
  // typed name matches, and never call api.database.drop.
  it('keeps Drop database disabled and never calls api.database.drop when readOnly is true, even with a matching name typed', async () => {
    const drop = vi.fn(async () => ({ dropped: true as const }));
    installAtelierMock({ database: { drop } });

    render(
      <DropDatabaseConfirm connectionId="c1" dbName="shop" readOnly onCancel={() => {}} onDropped={() => {}} />,
    );

    const confirmInput = screen.getByLabelText('Confirm database name');
    const dropBtn = screen.getByText('Drop database').closest('button')! as HTMLButtonElement;

    await userEvent.type(confirmInput, 'shop');
    expect(dropBtn.disabled).toBe(true);

    await userEvent.click(dropBtn);
    expect(drop).not.toHaveBeenCalled();
    expect(
      screen.getByText('This connection is read-only. Dropping is disabled.'),
    ).toBeTruthy();
  });
});
