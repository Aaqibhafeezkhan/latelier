// The palette's Recent group survives a relaunch: it is seeded from the
// `ui.commandPalette.mru` pref and every performed command writes it back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { useRegisterCommands } from '../../src/commands/useRegisterCommands';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

const KEY = 'ui.commandPalette.mru';

function Commands() {
  useRegisterCommands(
    [
      { id: 'test.alpha', title: 'Test Alpha', group: 'general', perform: () => {} },
      { id: 'test.beta', title: 'Test Beta', group: 'general', perform: () => {} },
    ],
    [],
  );
  return null;
}

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function mount() {
  render(
    <MemoryRouter>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Commands />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

/** Row titles under the "Recent" header, top to bottom; [] when there is no such group. */
function recentTitles(): string[] {
  const header = screen.queryByText('Recent');
  if (!header) return [];
  return within(header.parentElement!)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
}

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
});

describe('palette history persists across launches', () => {
  it('seeds the Recent group from the stored history', async () => {
    const get = vi.fn(async (key: string) => (key === KEY ? ['test.beta'] : null));
    installAtelierMock({ prefs: { get } as never });
    mount();
    await waitFor(() => expect(get).toHaveBeenCalledWith(KEY));

    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(recentTitles()).toEqual(['Test Beta']));
  });

  it('writes the performed command to the front of the stored history', async () => {
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({
      prefs: { get: async (key: string) => (key === KEY ? ['test.beta'] : null), set } as never,
    });
    mount();
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(recentTitles()).toEqual(['Test Beta']));

    fireEvent.click(screen.getByText('Test Alpha'));

    await waitFor(() => expect(set).toHaveBeenCalledWith(KEY, ['test.alpha', 'test.beta']));
    // The seed itself is not written back: only a performed command writes.
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('ignores a stored id that no registered command has', async () => {
    installAtelierMock({
      prefs: { get: async (key: string) => (key === KEY ? ['gone.command', 'test.alpha'] : null) } as never,
    });
    mount();
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(recentTitles()).toEqual(['Test Alpha']));
  });

  it('ignores a stored value that is not a list of strings', async () => {
    installAtelierMock({
      prefs: { get: async (key: string) => (key === KEY ? ['test.alpha', 7] : null) } as never,
    });
    mount();
    fireEvent.click(screen.getByText('toggle'));
    // Give the read a chance to land before asserting nothing was seeded.
    await waitFor(() => expect(screen.getByText('Test Beta')).toBeTruthy());
    await Promise.resolve();
    expect(recentTitles()).toEqual([]);
  });

  it('starts with an empty Recent group when the read fails, and still works', async () => {
    const get = vi.fn(async () => {
      throw new Error('prefs unavailable');
    });
    installAtelierMock({ prefs: { get } as never });
    mount();
    await waitFor(() => expect(get).toHaveBeenCalled());

    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByText('Test Alpha')).toBeTruthy();
    expect(recentTitles()).toEqual([]);
  });

  it('keeps a command performed before the stored history arrives, ahead of it', async () => {
    let release: (v: string[]) => void = () => {};
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({
      prefs: {
        get: (key: string) =>
          key === KEY ? new Promise<string[]>((r) => { release = r; }) : Promise.resolve(null),
        set,
      } as never,
    });
    mount();
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('Test Alpha'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(KEY, ['test.alpha']));

    release(['test.beta']);
    await Promise.resolve();

    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(recentTitles()).toEqual(['Test Alpha', 'Test Beta']));
  });
});
