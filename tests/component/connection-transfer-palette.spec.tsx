import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { CommandPaletteRoot, _resetPaletteStoreForTests } from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import { GlobalCommands } from '../../src/commands/GlobalCommands';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { ConnectionTransferProvider } from '../../src/features/connections/ConnectionTransferProvider';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
});

function openPalette() {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const init: KeyboardEventInit = { key: 'k', bubbles: true, cancelable: true };
  if (isMac) init.metaKey = true;
  else init.ctrlKey = true;
  act(() => {
    document.documentElement.dispatchEvent(new KeyboardEvent('keydown', init));
  });
}

describe('Connection Export / Import palette commands', () => {
  it.each([
    ['Export connections…', 'Export Connections'],
    ['Import connections…', 'Import Connections'],
  ])('%s opens its dialog', async (title, dialogName) => {
    installAtelierMock({});
    render(
      <MemoryRouter>
          <PaletteContextProvider>
            <SettingsProvider>
              <ConnectionTransferProvider>
                <CommandPaletteRoot>
                  <GlobalCommands />
                </CommandPaletteRoot>
              </ConnectionTransferProvider>
            </SettingsProvider>
          </PaletteContextProvider>
      </MemoryRouter>,
    );
    openPalette();
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: title.slice(0, 6) } });
    await screen.findByText(title);
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: dialogName })).toBeTruthy();
  });
});
