import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { CommandPaletteRoot, usePaletteApi, _resetPaletteStoreForTests } from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { GlobalCommands } from '../../src/commands/GlobalCommands';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// A dialog opened from the palette must hand focus back to the control that
// had it before the palette opened, not to the palette's search input (which
// unmounts with the palette) and so, on a close, to <body>.
describe('dialogs opened from the command palette return focus to the opener', () => {
  it.each([
    ['Keyboard shortcuts…', 'Keyboard shortcuts'],
    ['Show activity log', 'Activity log'],
    ['Open audit log', 'Audit log'],
    ['Open settings', 'Settings'],
  ])('%s: Escape lands focus back on the control that opened the palette', async (row, name) => {
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

    const opener = screen.getByText('toggle');
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    // The search input has taken focus by the time a row is chosen.
    const search = await screen.findByLabelText('Search commands');
    search.focus();
    fireEvent.click(await screen.findByText(row));

    const dialog = await screen.findByRole('dialog', { name });
    // A person takes longer than the palette's own 10ms focus-return timer
    // to reach for Escape; without the settle the result depends on which of
    // the two timers fires first.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    await waitFor(() => expect(screen.queryByRole('dialog', { name })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});
