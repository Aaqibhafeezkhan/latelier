import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ConnectionExportDialog } from '../../src/features/connections/ConnectionExportDialog';
import type { ConnectionExportInput, ConnectionExportResult, ConnectionSummary } from '@shared/types';

const row = (id: string, name: string): ConnectionSummary => ({
  id,
  name,
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard',
  readOnly: false,
  status: 'unknown',
});
const ROWS = [row('c1', 'Prod'), row('c2', 'Staging'), row('c3', 'Dev')];

function setup(result: ConnectionExportResult | Error = { written: 3, omittedSecrets: [] }) {
  const exportFn = vi.fn<(i: ConnectionExportInput) => Promise<ConnectionExportResult>>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  installAtelierMock({ conn: { list: async () => ROWS, export: exportFn } });
  const onClose = vi.fn();
  render(<ConnectionExportDialog onClose={onClose} />);
  return { exportFn, onClose };
}

const exportButton = () => screen.getByRole('button', { name: 'Export' });
const PASS = 'correct horse battery';

afterEach(uninstallAtelierMock);

describe('ConnectionExportDialog', () => {
  it('lists every Connection ticked and exports them all without passwords by default', async () => {
    const { exportFn } = setup();
    for (const r of ROWS) {
      expect(((await screen.findByRole('checkbox', { name: r.name })) as HTMLInputElement).checked).toBe(true);
    }
    expect((screen.getByRole('checkbox', { name: /Include passwords/ }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(exportButton());
    await waitFor(() => expect(exportFn).toHaveBeenCalledWith({ ids: ['c1', 'c2', 'c3'], includeSecrets: false }));
  });

  it('keeps the passphrase fields in the dialog, disabled until passwords are included', async () => {
    setup();
    await screen.findByRole('checkbox', { name: 'Prod' });
    // Always present, so ticking the box never resizes the dialog or moves Export.
    expect((screen.getByLabelText('Export Passphrase') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Confirm Export Passphrase') as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /Include passwords/ }));
    expect((screen.getByLabelText('Export Passphrase') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Confirm Export Passphrase') as HTMLInputElement).disabled).toBe(false);
  });

  it('holds one dialog height, so the passphrase fields appearing or a result replacing the form does not resize it', async () => {
    setup();
    await screen.findByRole('checkbox', { name: 'Prod' });
    const height = () => screen.getByRole('dialog').style.height;
    const before = height();
    expect(before).toContain('440px');
    await userEvent.click(screen.getByRole('checkbox', { name: /Include passwords/ }));
    expect(height()).toBe(before);
    await userEvent.click(screen.getByRole('checkbox', { name: /Include passwords/ }));
    await userEvent.click(exportButton());
    await screen.findByRole('status');
    expect(height()).toBe(before);
  });

  it('opens on the first Connection checkbox, not on Close', async () => {
    setup();
    const first = await screen.findByRole('checkbox', { name: 'Prod' });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it('sends only the ticked ids', async () => {
    const { exportFn } = setup();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Staging' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Dev' }));
    await userEvent.click(exportButton());
    await waitFor(() => expect(exportFn).toHaveBeenCalledWith({ ids: ['c1'], includeSecrets: false }));
  });

  it('disables Export when no Connection is ticked', async () => {
    setup();
    for (const r of ROWS) await userEvent.click(await screen.findByRole('checkbox', { name: r.name }));
    expect((exportButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Dev' }));
    expect((exportButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps Export disabled until the Export Passphrase is 12+ characters and confirmed', async () => {
    const { exportFn } = setup();
    await userEvent.click(await screen.findByRole('checkbox', { name: /Include passwords/ }));
    const pass = screen.getByLabelText('Export Passphrase');
    const confirm = screen.getByLabelText('Confirm Export Passphrase');
    const disabled = () => (exportButton() as HTMLButtonElement).disabled;

    expect(disabled()).toBe(true);
    await userEvent.type(pass, 'x'.repeat(11));
    await userEvent.type(confirm, 'x'.repeat(11));
    expect(disabled()).toBe(true);
    expect(screen.getByText('At least 12 characters.')).toBeTruthy();

    await userEvent.clear(pass);
    await userEvent.clear(confirm);
    await userEvent.type(pass, PASS);
    await userEvent.type(confirm, PASS.slice(0, -1));
    expect(disabled()).toBe(true);
    expect(screen.getByText('Does not match.')).toBeTruthy();

    await userEvent.type(confirm, PASS.slice(-1));
    expect(disabled()).toBe(false);
    await userEvent.click(exportButton());
    await waitFor(() =>
      expect(exportFn).toHaveBeenCalledWith({ ids: ['c1', 'c2', 'c3'], includeSecrets: true, passphrase: PASS }),
    );
  });

  it('accepts a passphrase of exactly 12 characters', async () => {
    setup();
    await userEvent.click(await screen.findByRole('checkbox', { name: /Include passwords/ }));
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'x'.repeat(12));
    await userEvent.type(screen.getByLabelText('Confirm Export Passphrase'), 'x'.repeat(12));
    expect((exportButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the count and each omitted secret on success', async () => {
    setup({ written: 2, omittedSecrets: [{ name: 'Prod', field: 'password' }] });
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('status')).textContent).toBe('2 Connections written.');
    expect(screen.getByText("Prod: password not included, it couldn't be read.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('shows nothing and stays editable when the save dialog is cancelled', async () => {
    const { exportFn, onClose } = setup({ cancelled: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    await waitFor(() => expect(exportFn).toHaveBeenCalled());
    await waitFor(() => expect((exportButton() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows an export failure and lets the user retry', async () => {
    setup(Object.assign(new Error('disk full'), { code: 'SYSTEM' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('alert')).textContent).toBe('disk full');
    expect((exportButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('Cancel and Escape close without calling export', async () => {
    const { exportFn, onClose } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(exportFn).not.toHaveBeenCalled();
  });
});
