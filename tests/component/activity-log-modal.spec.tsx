import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { CommandPaletteRoot, usePaletteApi, _resetPaletteStoreForTests } from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { GlobalCommands } from '../../src/commands/GlobalCommands';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { commandRegistry } from '../../src/commands/registry';
import { ActivityLogModal } from '../../src/pages/ActivityLogModal';
import { notify } from '../../src/theme/notifications';
import { clearActivity } from '../../src/theme/activityLog';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

beforeEach(() => clearActivity());

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('ActivityLogModal', () => {
  it('shows an error toast from notify.error when opened from the command palette', async () => {
    installAtelierMock({});
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <PaletteContextProvider>
          <SettingsProvider>
            <CommandPaletteRoot>
              <GlobalCommands />
              <ToggleButton />
            </CommandPaletteRoot>
          </SettingsProvider>
        </PaletteContextProvider>
      </MemoryRouter>,
    );
    act(() => {
      notify.error('Could not reach the server', { title: 'Connection failed' });
    });

    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('Show activity log'));

    const dialog = await screen.findByRole('dialog', { name: 'Activity log' });
    const row = within(dialog).getByText('Could not reach the server').closest('tr')!;
    expect(within(row).getByText('Error')).toBeTruthy();
    expect(within(row).getByText('Connection failed')).toBeTruthy();
  });

  it('records errors and warnings, newest first, but not info or success', () => {
    act(() => {
      notify.info('just so you know');
      notify.success('saved');
      notify.warning('slow query');
      notify.error('failed');
    });
    render(<ActivityLogModal onClose={() => {}} />);
    // The toasts themselves are on screen too; only the dialog's table counts.
    const dialog = screen.getByRole('dialog', { name: 'Activity log' });
    const rows = within(dialog).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[3]!.textContent)).toEqual(['failed', 'slow query']);
    expect(within(rows[1]!).getByText('Warning')).toBeTruthy();
  });

  it('shows the empty state, and Clear empties a filled log', () => {
    act(() => {
      notify.error('boom');
    });
    render(<ActivityLogModal onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Activity log' });
    expect(within(dialog).getByText('boom')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(within(dialog).getByText('No errors or warnings in this session.')).toBeTruthy();
    expect(within(dialog).queryByText('boom')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an entry recorded while it is open', () => {
    render(<ActivityLogModal onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Activity log' });
    expect(within(dialog).getByText('No errors or warnings in this session.')).toBeTruthy();
    act(() => {
      notify.warning('late warning');
    });
    expect(within(dialog).getByText('late warning')).toBeTruthy();
  });

  it('names its table', () => {
    act(() => {
      notify.error('boom');
    });
    render(<ActivityLogModal onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Activity log' });
    expect(within(within(dialog).getByRole('table', { name: 'Errors and warnings' })).getByText('boom')).toBeTruthy();
  });

  it('moves focus to Close after Clear, since Clear disables itself', () => {
    act(() => {
      notify.error('boom');
    });
    render(<ActivityLogModal onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Activity log' });
    const clear = within(dialog).getByRole('button', { name: 'Clear' });
    clear.focus();
    fireEvent.click(clear);
    // The footer's Close, not the header's X (which is also named Close).
    expect(document.activeElement).toBe(within(dialog).getByText('Close', { selector: 'button *' }).closest('button'));
    expect(clear).not.toBe(document.activeElement);
  });
});
