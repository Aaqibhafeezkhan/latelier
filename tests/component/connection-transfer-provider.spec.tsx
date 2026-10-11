import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import {
  ConnectionTransferProvider,
  useConnectionTransfer,
} from '../../src/features/connections/ConnectionTransferProvider';
import type { MenuCommand } from '@shared/ipc';

function Triggers() {
  const t = useConnectionTransfer();
  return (
    <>
      <button onClick={() => t.openExport()}>open export</button>
      <button onClick={t.openImport}>open import</button>
    </>
  );
}

function setup() {
  let fire: (c: MenuCommand) => void = () => {};
  const off = vi.fn();
  installAtelierMock({
    app: {
      onMenuCommand: (cb) => {
        fire = cb;
        return off;
      },
    },
  });
  const view = render(
    <ConnectionTransferProvider>
      <Triggers />
    </ConnectionTransferProvider>,
  );
  return { fire: (c: MenuCommand) => act(() => fire(c)), off, view };
}

afterEach(uninstallAtelierMock);

describe('ConnectionTransferProvider', () => {
  it('opens the matching dialog for each native menu command', async () => {
    const { fire } = setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    fire('connections.export');
    expect(await screen.findByRole('dialog', { name: 'Export Connections' })).toBeTruthy();
    fire('connections.import');
    expect(await screen.findByRole('dialog', { name: 'Import Connections' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Export Connections' })).toBeNull();
  });

  it('opens Export and the Import Wizard from the context API and closes on Cancel', async () => {
    setup();
    await userEvent.click(screen.getByText('open export'));
    expect(await screen.findByRole('dialog', { name: 'Export Connections' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByText('open import'));
    const wizard = await screen.findByRole('dialog', { name: 'Import Connections' });
    // The Import Wizard, opened at its file source.
    await waitFor(() => expect(document.activeElement).toBe(within(wizard).getByRole('button', { name: 'Choose file…' })));
    expect(within(wizard).getByRole('textbox', { name: /paste connection strings/i })).toBeTruthy();
  });

  it('stops listening to the menu when unmounted', () => {
    const { off, view } = setup();
    view.unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
