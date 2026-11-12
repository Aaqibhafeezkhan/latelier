import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider, usePaletteContext } from '../../src/commands/PaletteContext';
import { useRegisterCommands } from '../../src/commands/useRegisterCommands';
import { GlobalCommands } from '../../src/commands/GlobalCommands';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { commandRegistry } from '../../src/commands/registry';
import { setFocusedConnectionId } from '../../src/state/focusedConnection';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

/**
 * once the Data View became the app's home, the route no longer
 * carries a `:id` while the user is looking at it, so `PaletteContext`
 * must fall back to the Focused Tab's Connection or every command gated on
 * `connectionId` silently stops being offered.
 */

function GatedCommand() {
  useRegisterCommands(
    [
      {
        id: 'test.connection-gated',
        title: 'Connection-gated command',
        group: 'general',
        when: (ctx) => ctx.connectionId !== null,
        perform: () => {},
      },
    ],
    [],
  );
  return null;
}

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function ConnectionIdProbe() {
  const ctx = usePaletteContext();
  return <div data-testid="connection-id-probe">{ctx.connectionId ?? '(none)'}</div>;
}

function harness(initialPath: string, { probe = false } = {}) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <GatedCommand />
          <ToggleButton />
        </CommandPaletteRoot>
        {probe && <ConnectionIdProbe />}
      </PaletteContextProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  setFocusedConnectionId(null);
  uninstallAtelierMock();
});

describe('PaletteContext connectionId fallback', () => {
  it('is offered on the Data View home screen when a Focused Tab’s Connection is published', () => {
    act(() => setFocusedConnectionId('conn-1'));
    render(harness('/workspace'));
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByText('Connection-gated command')).toBeTruthy();
  });

  it('is not offered on the Data View home screen with no Focused Tab', () => {
    render(harness('/workspace'));
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.queryByText('Connection-gated command')).toBeNull();
  });

  it('prefers the route id over the Focused Tab’s Connection on the deep detail screen', () => {
    act(() => setFocusedConnectionId('conn-active'));
    render(harness('/connections/conn-route', { probe: true }));
    expect(screen.getByTestId('connection-id-probe').textContent).toBe('conn-route');
  });

  // The tests above prove the fallback mechanism in isolation; this proves
  // the real wiring — a genuine registered command, not a stand-in — is
  // actually reachable with a Connection focused. `nav.workspace` is gated on
  // `connectionId`, so it is among the commands at risk of silently disappearing.
  it('a real connectionId-gated command (nav.workspace) is offered with a Connection focused', () => {
    installAtelierMock({});
    act(() => setFocusedConnectionId('conn-1'));
    render(
      <MemoryRouter initialEntries={['/connections']}>
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
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByText('Go to workspace')).toBeTruthy();
  });
});
