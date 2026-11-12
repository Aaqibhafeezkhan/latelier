import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '../helpers/render';
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

function Register({ commands }: { commands: Command[] }) {
  useRegisterCommands(commands, [commands]);
  return null;
}

const cmd = (over: Partial<Command> & { id: string; title: string }): Command => ({
  group: 'general',
  perform: () => {},
  ...over,
});

function mount(commands: Command[]) {
  installAtelierMock({});
  render(
    <MemoryRouter>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Register commands={commands} />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

function search(q: string) {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: q } });
}

const matched = (option: HTMLElement) =>
  Array.from(option.querySelectorAll('[data-match]')).map((n) => n.textContent);

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('palette rows on a typed query', () => {
  const commands = [
    cmd({ id: 'a', title: 'Open: shop.orders', matchText: 'shop.orders', subtitle: 'Production', group: 'workspace' }),
    cmd({ id: 'b', title: 'Run query', group: 'query' }),
    cmd({ id: 'c', title: 'Open settings', keywords: ['preferences'] }),
  ];

  it('emphasises the matched characters of an initials match', async () => {
    mount(commands);
    search('so');
    const options = await within(screen.getByRole('dialog')).findAllByRole('option');
    const byTitle = (t: string) => options.find((o) => o.textContent?.includes(t))!;
    expect(matched(byTitle('shop.orders'))).toEqual(['s', 'o']);
    expect(byTitle('shop.orders').querySelector('[data-match]')!.getAttribute('style')).toContain('--atelier-accent-ink');
    expect(byTitle('shop.orders').querySelector('[data-match]')!.getAttribute('style')).toContain('font-weight: 600');
  });

  it('emphasises something in every row whose text matched', async () => {
    mount(commands.slice(0, 2));
    search('r');
    const options = await within(screen.getByRole('dialog')).findAllByRole('option');
    expect(options).toHaveLength(2);
    for (const option of options) expect(matched(option).length).toBeGreaterThan(0);
  });

  it('renders a collection row as its match text with the Connection as subtitle', async () => {
    mount(commands);
    search('orders');
    const dialog = within(screen.getByRole('dialog'));
    const option = (await dialog.findAllByRole('option'))[0]!;
    expect(option.querySelector('[data-title]')!.getAttribute('data-title')).toBe('shop.orders');
    expect(within(option).getByText('Production')).toBeTruthy();
    expect(dialog.queryByText('Open: shop.orders')).toBeNull();
  });

  it('emphasises the subtitle characters a row was matched through', async () => {
    mount([...commands, cmd({ id: 'd', title: 'Open: shop.carts', matchText: 'shop.carts', subtitle: 'Staging' })]);
    search('production');
    const options = await within(screen.getByRole('dialog')).findAllByRole('option');
    expect(options).toHaveLength(1);
    const subtitle = options[0]!.querySelector('[data-subtitle]')!;
    expect(subtitle.getAttribute('data-subtitle')).toBe('Production');
    expect(Array.from(subtitle.querySelectorAll('[data-match]')).map((n) => n.textContent)).toEqual(['Production']);
    expect(matched(options[0]!)).toEqual(['Production']);
  });

  it('leaves the subtitle plain for a row matched by a hidden keyword', async () => {
    mount([cmd({ id: 'c', title: 'Open settings', subtitle: 'General', keywords: ['preferences'] })]);
    search('preferences');
    const [option] = await within(screen.getByRole('dialog')).findAllByRole('option');
    expect(option!.querySelector('[data-subtitle]')!.textContent).toBe('General');
    expect(matched(option!)).toEqual([]);
  });

  it('reads the row’s name as one piece, not as highlighted fragments', async () => {
    mount(commands);
    search('run');
    expect(await within(screen.getByRole('dialog')).findByRole('option', { name: 'Run query' })).toBeTruthy();
  });

  it('does not list a row that matches only through the prefix its family shares', async () => {
    mount(commands);
    search('open');
    const dialog = within(screen.getByRole('dialog'));
    await dialog.findAllByRole('option');
    expect(dialog.queryByText('shop.orders')).toBeNull();
    expect(dialog.getByText('Open settings')).toBeTruthy();
  });

  it('moves the cursor through the rows in the order they are drawn', async () => {
    mount(commands);
    search('r');
    const input = screen.getByLabelText('Search commands');
    const dialog = within(screen.getByRole('dialog'));
    const drawn = (await dialog.findAllByRole('option')).map((o) => o.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(drawn[0]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(drawn[1]);
  });

  it('performs the row under the cursor on Enter', async () => {
    const perform = vi.fn();
    mount([cmd({ id: 'z', title: 'Zeta', perform }), ...commands]);
    search('zeta');
    await within(screen.getByRole('dialog')).findAllByRole('option');
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    expect(perform).toHaveBeenCalledTimes(1);
  });
});

describe('palette rows built from the query', () => {
  const finder = (perform: () => void): Command =>
    cmd({
      id: 'find',
      title: 'Find _id',
      group: 'query',
      forQuery: (q) => (q === 'abc' ? { title: 'Find abc in a.b', subtitle: 'Does a thing', emphasis: 'abc', perform } : null),
    });

  it('shows the row first, its emphasis in monospace, and performs it on Enter', async () => {
    const perform = vi.fn();
    mount([finder(perform), cmd({ id: 'x', title: 'Abc other' })]);
    search('abc');
    const dialog = within(screen.getByRole('dialog'));
    const options = await dialog.findAllByRole('option');
    expect(options[0]!.textContent).toContain('Find abc in a.b');
    expect(dialog.getByText('Does a thing')).toBeTruthy();
    expect(dialog.getByText('In the tab in front')).toBeTruthy();
    expect(dialog.queryByText('No other matches')).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing else matches', async () => {
    mount([finder(() => {})]);
    search('abc');
    expect(await within(screen.getByRole('dialog')).findByText('No other matches')).toBeTruthy();
  });

  it('is not recorded as a recent command', async () => {
    const stored: unknown[] = [];
    installAtelierMock({
      prefs: {
        get: async () => [],
        set: async (_k: string, v: unknown) => {
          stored.push(v);
        },
      },
    } as never);
    render(
      <MemoryRouter>
        <PaletteContextProvider>
          <CommandPaletteRoot>
            <Register commands={[finder(() => {})]} />
            <ToggleButton />
          </CommandPaletteRoot>
        </PaletteContextProvider>
      </MemoryRouter>,
    );
    search('abc');
    await within(screen.getByRole('dialog')).findAllByRole('option');
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    await Promise.resolve();
    expect(stored.flat()).not.toContain('find');
  });
});
