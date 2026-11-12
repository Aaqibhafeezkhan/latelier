// X07 §13.3: a toggle flips and keeps the palette open on its row; a command
// with a disabledReason is listed greyed, does nothing, and never enters the MRU.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '../helpers/render';
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

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

const disabledPerform = vi.fn();

/** Registered after the toggle's batch, which re-registering then moves behind these. */
function Others() {
  useRegisterCommands(
    [
      { id: 'other', title: 'Open settings', group: 'general', perform: () => {} },
      {
        id: 'copy',
        title: 'Copy MQL to clipboard',
        group: 'general',
        disabledReason: () => 'Type a filter first',
        perform: disabledPerform,
      },
    ],
    [],
  );
  return null;
}

/** A real on/off state, re-registered on every flip as the app's toggles are. */
function DarkMode() {
  const [dark, setDark] = React.useState(false);
  useRegisterCommands(
    [
      { id: 'theme.toggle', title: 'Dark mode', group: 'general', toggle: { checked: dark }, perform: () => setDark((d) => !d) },
      { id: 'after', title: 'Open audit log', group: 'general', perform: () => {} },
    ],
    [dark],
  );
  return null;
}

const set = vi.fn(async (_k: string, v: unknown) => v);

function mount() {
  installAtelierMock({ prefs: { get: async () => null, set } as never });
  render(
    <MemoryRouter>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <DarkMode />
          <Others />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

const input = () => screen.getByLabelText('Search commands');
const option = (name: RegExp) => within(screen.getByRole('dialog')).getByRole('option', { name });
const ids = () => within(screen.getByRole('dialog')).getAllByRole('option').map((o) => o.id);
const recentHeader = () => within(screen.getByRole('dialog')).queryByText('Recent');

async function toggle() {
  fireEvent.click(screen.getByText('toggle'));
  await act(async () => {});
}

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  disabledPerform.mockClear();
  set.mockClear();
});

describe('a toggle', () => {
  it('shows a switch, flips it on Enter, and stays open with the cursor on its row', async () => {
    mount();
    await toggle();
    const row = option(/^Dark mode/);
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(row.querySelector('[data-switch]')!.getAttribute('data-switch')).toBe('off');
    const order = ids();
    // Walk the cursor onto the toggle.
    while (input().getAttribute('aria-activedescendant') !== row.id) fireEvent.keyDown(input(), { key: 'ArrowDown' });

    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(option(/^Dark mode/).getAttribute('aria-checked')).toBe('true'));
    expect(option(/^Dark mode/).querySelector('[data-switch]')!.getAttribute('data-switch')).toBe('on');
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Re-registering moved the row, and the cursor went with it.
    expect(ids()).not.toEqual(order);
    expect(input().getAttribute('aria-activedescendant')).toBe(option(/^Dark mode/).id);
    expect(recentHeader()).toBeNull();
    expect(screen.getByRole('dialog').querySelector('[data-palette-footer]')!.textContent).toContain('Toggle');
  });

  it('flips on a click too, and enters the MRU once the palette closes', async () => {
    mount();
    await toggle();
    fireEvent.click(option(/^Dark mode/));
    await waitFor(() => expect(option(/^Dark mode/).getAttribute('aria-checked')).toBe('true'));
    expect(recentHeader()).toBeNull();
    await toggle();
    await waitFor(() => expect(set).toHaveBeenCalledWith(KEY, ['theme.toggle']));
    await toggle();
    expect(recentHeader()).toBeTruthy();
  });
  it('keeps the focus in the search input when its row is pressed', async () => {
    mount();
    await toggle();
    // jsdom moves no focus on mousedown: a cancelled default is what keeps Chromium's input focused.
    expect(fireEvent.mouseDown(option(/^Dark mode/))).toBe(false);
  });

  it('lets the cursor go back to the best row once the query changes', async () => {
    mount();
    await toggle();
    fireEvent.click(option(/^Dark mode/));
    await waitFor(() => expect(option(/^Dark mode/).getAttribute('aria-checked')).toBe('true'));
    // The click put the cursor on the toggle; a new query is a new list.
    fireEvent.change(input(), { target: { value: 'o' } });
    await act(async () => {});
    const first = ids()[0];
    expect(option(/^Dark mode/).id).not.toBe(first);
    expect(input().getAttribute('aria-activedescendant')).toBe(first);
  });

  it('enters the MRU behind a command performed later on the same open', async () => {
    mount();
    await toggle();
    fireEvent.click(option(/^Dark mode/));
    await waitFor(() => expect(option(/^Dark mode/).getAttribute('aria-checked')).toBe('true'));
    fireEvent.change(input(), { target: { value: 'settings' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(set).toHaveBeenLastCalledWith(KEY, ['other', 'theme.toggle']));
    await toggle();
    fireEvent.change(input(), { target: { value: '' } });
    const header = recentHeader()!;
    const recent = within(header.parentElement!).getAllByRole('option').map((o) => o.querySelector('[data-title]')!.getAttribute('data-title'));
    expect(recent).toEqual(['Open settings', 'Dark mode']);
  });
});

describe('an unavailable command', () => {
  it('is listed greyed with its reason as the subtitle', async () => {
    mount();
    await toggle();
    const row = option(/^Copy MQL to clipboard/);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector('[data-subtitle]')!.textContent).toBe('Type a filter first');
    expect(row.getAttribute('style')).toContain('--atelier-text-ghost');
  });

  it('shows no accent emphasis on a matched greyed row', async () => {
    mount();
    await toggle();
    fireEvent.change(input(), { target: { value: 'copy' } });
    expect(option(/^Copy MQL/).querySelector('[data-match]')).toBeNull();
  });

  it('does nothing on Enter or a click, keeps the palette open, and never enters the MRU', async () => {
    mount();
    await toggle();
    fireEvent.change(input(), { target: { value: 'copy' } });
    expect(input().getAttribute('aria-activedescendant')).toBe(option(/^Copy MQL/).id);
    expect(screen.getByRole('dialog').querySelector('[data-palette-footer]')!.textContent).not.toContain('Run');
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.click(option(/^Copy MQL/));
    expect(disabledPerform).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await toggle();
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.change(input(), { target: { value: '' } });
    expect(recentHeader()).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });
});
