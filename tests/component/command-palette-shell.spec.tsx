import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { useRegisterCommands } from '../../src/commands/useRegisterCommands';
import { commandRegistry } from '../../src/commands/registry';

function harness(ui: React.ReactElement) {
  return (
      <MemoryRouter>
        <PaletteContextProvider>
          <CommandPaletteRoot>{ui}</CommandPaletteRoot>
        </PaletteContextProvider>
      </MemoryRouter>
  );
}

// X12 Phase 5: Mantine's useHotkeys listens on document.documentElement, not
// document itself — so synthetic keyboard events must be dispatched on the
// documentElement to reach Spotlight's shortcut handler.
function dispatchToggle() {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const init: KeyboardEventInit = { key: 'k', bubbles: true, cancelable: true };
  if (isMac) init.metaKey = true;
  else init.ctrlKey = true;
  document.documentElement.dispatchEvent(new KeyboardEvent('keydown', init));
}

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function RegisterTest({ perform }: { perform: () => void }) {
  useRegisterCommands(
    [
      { id: 'test.alpha', title: 'Test Alpha', group: 'general', perform },
      { id: 'test.beta', title: 'Test Beta', group: 'general', perform: () => {} },
    ],
    [perform],
  );
  return null;
}

afterEach(() => {
  commandRegistry._resetForTests();
  // Module-level Spotlight store persists across tests; reset its open/query
  // state so each test starts with the palette closed.
  _resetPaletteStoreForTests();
});

describe('<CommandPalette>', () => {
  it('opens on ⌘K and closes on Esc', async () => {
    render(harness(<RegisterTest perform={() => {}} />));

    act(() => dispatchToggle());
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Mantine Modal listens for Escape on the focus trap root; fire on the
    // dialog itself rather than document so the listener picks it up.
    act(() => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).not.toBeTruthy();
  });

  it('renders registered commands and filters on substring', () => {
    render(harness(<RegisterTest perform={() => {}} />));
    act(() => dispatchToggle());
    expect(screen.getByText('Test Alpha')).toBeTruthy();
    expect(screen.getByText('Test Beta')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'alpha' } });
    expect(screen.getByText('Test Alpha')).toBeTruthy();
    expect(screen.queryByText('Test Beta')).not.toBeTruthy();
  });

  it('Enter performs the cursor command and closes', () => {
    const perform = vi.fn();
    render(harness(<RegisterTest perform={perform} />));
    act(() => dispatchToggle());
    // Keyboard nav is bound to the search input, not the dialog or the
    // option rows (combobox pattern — see CommandPalette.tsx) — Enter is
    // fired where a real keyboard user would have focus.
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeTruthy();
  });

  it('shows a no-matches message when the query matches nothing', () => {
    render(harness(<RegisterTest perform={() => {}} />));
    act(() => dispatchToggle());
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No matches for "zzz"/)).toBeTruthy();
  });

  describe('combobox semantics', () => {
    const scrollIntoView = vi.fn();
    beforeEach(() => {
      // jsdom has no scrollIntoView.
      Element.prototype.scrollIntoView = scrollIntoView;
    });
    afterEach(() => {
      scrollIntoView.mockClear();
      // @ts-expect-error -- restoring jsdom's absence of the method
      delete Element.prototype.scrollIntoView;
    });

    function options() {
      return screen.getAllByRole('option');
    }

    it('wires the search input to one listbox and points aria-activedescendant at the cursor row', () => {
      render(harness(<RegisterTest perform={() => {}} />));
      act(() => dispatchToggle());
      const input = screen.getByRole('combobox', { name: 'Search commands' });
      const listbox = screen.getByRole('listbox');

      expect(screen.getAllByRole('listbox')).toHaveLength(1);
      expect(input.getAttribute('aria-expanded')).toBe('true');
      expect(input.getAttribute('aria-autocomplete')).toBe('list');
      expect(input.getAttribute('aria-controls')).toBe(listbox.id);
      expect(listbox.contains(options()[0])).toBe(true);
      expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
      expect(options()[0].getAttribute('aria-selected')).toBe('true');
    });

    it('ArrowDown moves aria-activedescendant to the next row and scrolls it into view', () => {
      render(harness(<RegisterTest perform={() => {}} />));
      act(() => dispatchToggle());
      const input = screen.getByRole('combobox', { name: 'Search commands' });
      const first = options()[0].id;
      scrollIntoView.mockClear();

      fireEvent.keyDown(input, { key: 'ArrowDown' });

      const second = options()[1];
      expect(second.id).not.toBe(first);
      expect(input.getAttribute('aria-activedescendant')).toBe(second.id);
      expect(second.getAttribute('aria-selected')).toBe('true');
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(second);
    });

    it('drops aria-activedescendant when nothing matches', () => {
      render(harness(<RegisterTest perform={() => {}} />));
      act(() => dispatchToggle());
      const input = screen.getByRole('combobox', { name: 'Search commands' });
      fireEvent.change(input, { target: { value: 'zzz' } });
      expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    });
  });

  it('exposes a stable api: toggle button works before keyboard listener fires', () => {
    render(harness(<><RegisterTest perform={() => {}} /><ToggleButton /></>));
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.queryByRole('dialog')).not.toBeTruthy();
  });
});

describe('useRegisterCommands', () => {
  it('registers on mount and unregisters on unmount', () => {
    const { unmount } = render(harness(<RegisterTest perform={() => {}} />));
    expect(commandRegistry.list().map((c) => c.id).sort()).toEqual(['test.alpha', 'test.beta']);
    unmount();
    expect(commandRegistry.list()).toHaveLength(0);
  });
});
