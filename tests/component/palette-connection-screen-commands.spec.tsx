// `Open monitor`, `Open users` and `Open roles` (X07 §13.5): offered with a
// Connection in context, they land on that Connection's screen with the tab
// selected, also when that screen is already showing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '../helpers/render';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CommandPaletteRoot, usePaletteApi, _resetPaletteStoreForTests } from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { GlobalCommands } from '../../src/commands/GlobalCommands';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { DetailPanel } from '../../src/pages/DetailPanel';
import { commandRegistry } from '../../src/commands/registry';
import { setFocusedConnectionId } from '../../src/state/focusedConnection';
import { installAtelierMock, uninstallAtelierMock, connectionFixture } from '../helpers/atelierMock';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function mount() {
  installAtelierMock({
    mongo: {
      status: async (id: string) => ({ id, status: 'disconnected' as const }),
      onStatus: () => () => {},
    },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <SettingsProvider>
          <CommandPaletteRoot>
            <GlobalCommands />
            <ToggleButton />
            <Routes>
              <Route path="/workspace" element={<div>workspace</div>} />
              <Route
                path="/connections/:id"
                element={
                  <DetailPanel
                    selected={connectionFixture({ status: 'disconnected' })}
                    loading={false}
                    onDelete={() => {}}
                    onDisconnect={() => {}}
                  />
                }
              />
            </Routes>
          </CommandPaletteRoot>
        </SettingsProvider>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

function run(title: string) {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: title } });
  const row = within(screen.getByRole('dialog', { name: 'Command palette' }))
    .getAllByRole('option')
    .find((o) => o.querySelector('[data-title]')?.getAttribute('data-title') === title)!;
  fireEvent.click(row);
}

/** The Connection screen's tab drawn as selected. */
function selectedTab(): string | undefined {
  return ['Overview', 'Monitor', 'Collections', 'Users', 'Roles'].find(
    (t) => screen.getByRole('button', { name: t }).style.fontWeight === '600',
  );
}

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  act(() => setFocusedConnectionId(null));
  vi.restoreAllMocks();
});

describe('Connection screen commands', () => {
  it('are not offered with no Connection in context', () => {
    mount();
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'Open' } });
    const titles = within(screen.getByRole('dialog', { name: 'Command palette' }))
      .queryAllByRole('option')
      .map((o) => o.querySelector('[data-title]')?.getAttribute('data-title'));
    expect(titles).not.toContain('Open monitor');
    expect(titles).not.toContain('Open users');
    expect(titles).not.toContain('Open roles');
  });

  it('open the focused Connection’s screen on the tab named, again from that screen', async () => {
    act(() => setFocusedConnectionId('c1'));
    mount();
    run('Open users');
    await waitFor(() => expect(selectedTab()).toBe('Users'));
    run('Open roles');
    await waitFor(() => expect(selectedTab()).toBe('Roles'));
    run('Open monitor');
    await waitFor(() => expect(selectedTab()).toBe('Monitor'));
  });
});
