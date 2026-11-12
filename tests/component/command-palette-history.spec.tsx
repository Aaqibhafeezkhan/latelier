// X07 §13.3 "Last query": the palette reopens on its previous query, selected,
// and `↑` on an empty input walks back through the session's earlier queries.
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { Command } from '../../src/commands/types';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

const perform = vi.fn();
const COMMANDS: Command[] = [
  { id: 'a', title: 'Alpha', group: 'general', perform },
  { id: 'b', title: 'Beta', group: 'general', perform },
  { id: 'c', title: 'Gamma', group: 'general', perform },
];

function Register() {
  useRegisterCommands(COMMANDS, []);
  return null;
}

const set = vi.fn(async (_k: string, v: unknown) => v);

function mount() {
  installAtelierMock({ prefs: { get: async () => null, set } as never });
  render(
    <MemoryRouter>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Register />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

const input = () => screen.getByLabelText('Search commands') as HTMLInputElement;
const type = (q: string) => fireEvent.change(input(), { target: { value: q } });
const press = (key: string) => fireEvent.keyDown(input(), { key });

async function toggle() {
  fireEvent.click(screen.getByText('toggle'));
  await act(async () => {});
}

/** Opens, types `q`, and closes without performing. */
async function search(q: string) {
  await toggle();
  type(q);
  await toggle();
}

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  perform.mockClear();
  set.mockClear();
});

describe('the last query', () => {
  it('comes back on reopen, fully selected', async () => {
    mount();
    await search('gam');
    await toggle();
    expect(input().value).toBe('gam');
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 3]);
    expect(screen.getAllByRole('option').map((o) => o.querySelector('[data-title]')?.getAttribute('data-title'))).toEqual(['Gamma']);
  });

  it('comes back after a perform, so Enter repeats it', async () => {
    mount();
    await toggle();
    type('bet');
    press('Enter');
    expect(perform).toHaveBeenCalledTimes(1);
    await act(async () => {});
    await toggle();
    expect(input().value).toBe('bet');
    press('Enter');
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('lets ↓ move through the results of the query it reopened on', async () => {
    mount();
    await search('a');
    await toggle();
    const first = input().getAttribute('aria-activedescendant');
    press('ArrowDown');
    expect(input().value).toBe('a');
    expect(input().getAttribute('aria-activedescendant')).not.toBe(first);
  });
});

describe('↑ and ↓ on an empty input', () => {
  it('step back through earlier queries and forward again, to an empty input', async () => {
    mount();
    await search('alp');
    await search('bet');
    await search('gam');
    await toggle();
    expect(input().value).toBe('gam');
    type('');
    press('ArrowUp');
    expect(input().value).toBe('bet');
    press('ArrowUp');
    expect(input().value).toBe('alp');
    press('ArrowUp');
    expect(input().value).toBe('alp');
    press('ArrowDown');
    expect(input().value).toBe('bet');
    press('ArrowDown');
    expect(input().value).toBe('gam');
    press('ArrowDown');
    expect(input().value).toBe('');
    press('ArrowDown');
    expect(input().value).toBe('');
  });

  it('keeps one entry per query, newest first', async () => {
    mount();
    await search('alp');
    await search('bet');
    await search('alp');
    await toggle();
    type('');
    press('ArrowUp');
    expect(input().value).toBe('bet');
    press('ArrowUp');
    expect(input().value).toBe('bet');
  });

  it('stop stepping once the query is edited: the arrows move the cursor again', async () => {
    mount();
    await search('a');
    await search('b');
    await toggle();
    type('');
    press('ArrowUp');
    expect(input().value).toBe('a');
    type('al');
    const before = input().getAttribute('aria-activedescendant');
    press('ArrowUp');
    expect(input().value).toBe('al');
    press('ArrowDown');
    expect(input().value).toBe('al');
    expect(input().getAttribute('aria-activedescendant')).toBe(before);
  });

  it('move the cursor when there is no history', async () => {
    mount();
    await toggle();
    const first = input().getAttribute('aria-activedescendant');
    press('ArrowUp');
    expect(input().value).toBe('');
    expect(input().getAttribute('aria-activedescendant')).not.toBe(first);
  });

  it('never write the history anywhere', async () => {
    mount();
    await search('alp');
    await search('bet');
    expect(set).not.toHaveBeenCalled();
  });
});
