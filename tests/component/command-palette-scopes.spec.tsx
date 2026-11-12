// X07 §13.3: the scope row, capped groups in All, the row limit in a scope,
// the counts, and ⌘P.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { useRegisterCommands } from '../../src/commands/useRegisterCommands';
import { commandRegistry, objectRow } from '../../src/commands/registry';
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

const coll = (name: string): Command =>
  objectRow({
    id: `tab.open:c1:shop:${name}`,
    kind: 'collection',
    name: `shop.${name}`,
    subtitle: 'Production',
    actions: [{ id: 'open', verb: 'open', title: 'Open', perform: () => {} }],
  });

const action = (id: string, title: string): Command => ({ id, title, group: 'general', perform: () => {} });

function mount(commands: Command[]) {
  installAtelierMock({});
  render(
    <MemoryRouter>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Register commands={commands} />
          <ToggleButton />
          <input aria-label="elsewhere" />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

const input = () => screen.getByLabelText('Search commands');
const dialog = () => within(screen.getByRole('dialog'));
const selectedScope = () => dialog().getByRole('tab', { selected: true }).firstChild?.textContent;
const titles = () =>
  dialog()
    .queryAllByRole('option')
    .map((o) => o.querySelector('[data-title]')?.getAttribute('data-title') ?? o.textContent);

function open(query = '') {
  fireEvent.click(screen.getByText('toggle'));
  if (query) fireEvent.change(input(), { target: { value: query } });
}

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(input(), { key, ...init });
}

const many = (n: number) => Array.from({ length: n }, (_, i) => coll(`orders${String(i).padStart(2, '0')}`));

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('the scope row', () => {
  it('is a tablist of the five scopes, All selected on open, none of them focusable', () => {
    mount([action('a', 'Alpha')]);
    open();
    const tabs = within(dialog().getByRole('tablist', { name: 'Scope' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Collections', 'Actions', 'Saved', 'Tabs']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1', '-1', '-1']);
    expect(selectedScope()).toBe('All');
    expect(dialog().getByText('Tab to switch scope')).toBeTruthy();
  });

  it('cycles with Tab and Shift+Tab, wrapping both ways, keeping the query and the focus', () => {
    mount([action('a', 'Alpha')]);
    open('alp');
    input().focus();
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      press('Tab');
      seen.push(selectedScope()!);
    }
    expect(seen).toEqual(['Collections', 'Actions', 'Saved', 'Tabs', 'All']);
    press('Tab', { shiftKey: true });
    expect(selectedScope()).toBe('Tabs');
    press('Tab', { shiftKey: true });
    expect(selectedScope()).toBe('Saved');
    expect((input() as HTMLInputElement).value).toBe('alp');
    expect(document.activeElement).toBe(input());
  });

  it('cancels the browser’s own Tab, so focus never leaves the input', () => {
    mount([action('a', 'Alpha')]);
    open();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input().dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
  });

  it('selects a scope on click', () => {
    mount([action('a', 'Alpha')]);
    open();
    fireEvent.click(dialog().getByRole('tab', { name: 'Actions' }));
    expect(selectedScope()).toBe('Actions');
  });

  it('shows each scope’s count once a query is typed, and drops the Tab hint', () => {
    mount([...many(7), action('a', 'Reorders report')]);
    open('orders');
    const counts = within(dialog().getByRole('tablist')).getAllByRole('tab').map((t) => t.querySelector('[data-count]')?.textContent ?? null);
    expect(counts).toEqual([null, '7', '1', '0', '0']);
    expect(dialog().queryByText('Tab to switch scope')).toBeNull();
  });

  it('shows no count on an empty query', () => {
    mount(many(3));
    open();
    expect(screen.getByRole('dialog').querySelector('[data-count]')).toBeNull();
  });
});

describe('All on a typed query', () => {
  it('lists five rows per kind, then Show <n> more, which switches to the kind’s scope with the query kept', () => {
    mount([...many(8), action('a', 'Reorders report')]);
    open('orders');
    expect(titles()).toEqual([
      'shop.orders00',
      'shop.orders01',
      'shop.orders02',
      'shop.orders03',
      'shop.orders04',
      'Show 3 more collections',
      'Reorders report',
    ]);
    expect(dialog().getByText('Collections', { selector: '[id$="-grp-collection"]' })).toBeTruthy();
    for (let i = 0; i < 5; i++) press('ArrowDown');
    press('Enter');
    expect(selectedScope()).toBe('Collections');
    expect((input() as HTMLInputElement).value).toBe('orders');
    expect(titles()).toHaveLength(8);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('switches scope on a click on Show more', () => {
    mount(many(6));
    open('orders');
    fireEvent.click(dialog().getByRole('option', { name: 'Show 1 more collection' }));
    expect(selectedScope()).toBe('Collections');
  });
});

describe('a single scope', () => {
  it('lists the 50 best matches, then the row limit line under the list', () => {
    mount(many(60));
    open('orders');
    press('Tab');
    expect(titles()).toHaveLength(50);
    const limit = screen.getByRole('dialog').querySelector('[data-row-limit]');
    expect(limit?.textContent).toBe('Showing the best 50 · keep typing to narrow 10 more');
    expect(dialog().getByRole('listbox').contains(limit)).toBe(false);
  });

  it('has no limit line when everything fits', () => {
    mount(many(50));
    open('orders');
    press('Tab');
    expect(titles()).toHaveLength(50);
    expect(screen.getByRole('dialog').querySelector('[data-row-limit]')).toBeNull();
  });

  it('lists only its own kind', () => {
    mount([...many(2), action('a', 'Reorders report')]);
    open('orders');
    press('Tab');
    expect(titles()).toEqual(['shop.orders00', 'shop.orders01']);
    press('Tab');
    expect(titles()).toEqual(['Reorders report']);
    press('Tab');
    expect(titles()).toEqual([]);
    expect(dialog().getByText('No matches for "orders"')).toBeTruthy();
  });

  it('offers ⇧Tab in the footer, naming the scope it goes to', () => {
    mount(many(2));
    open('orders');
    const footer = () => screen.getByRole('dialog').querySelector('[data-palette-footer]')!.textContent;
    expect(footer()).toContain('Open');
    expect(footer()).not.toContain('All');
    press('Tab');
    expect(footer()).toMatch(/Tab\s*All$/);
    press('Tab');
    expect(footer()).toMatch(/Tab\s*Collections$/);
  });
});

describe('⌘P', () => {
  const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

  it('opens the palette on Collections, and ⌘K still opens on All', async () => {
    mount(many(2));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true, ...mod }));
    });
    expect(selectedScope()).toBe('Collections');
    fireEvent.click(screen.getByText('toggle'));
    await act(async () => {});
    open();
    expect(selectedScope()).toBe('All');
  });

  it('cancels the browser’s ⌘P', () => {
    mount(many(2));
    const e = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true, ...mod });
    act(() => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
  });

  it('switches to Collections from inside the palette', () => {
    mount(many(2));
    open('orders');
    press('p', mod);
    expect(selectedScope()).toBe('Collections');
  });

  it('is left alone with Shift or Alt held, and inside another dialog', () => {
    mount(many(2));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, ...mod, shiftKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, ...mod, altKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    document.body.appendChild(other);
    try {
      act(() => {
        other.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, metaKey: true }));
      });
      expect(screen.queryByLabelText('Search commands')).toBeNull();
    } finally {
      other.remove();
    }
  });

  it('reaches a text field with ⌘ only, never with a bare Ctrl', () => {
    mount(many(2));
    const field = screen.getByLabelText('elsewhere');
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, ctrlKey: true }));
    });
    expect(screen.queryByLabelText('Search commands')).toBeNull();
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', bubbles: true, metaKey: true }));
    });
    expect(selectedScope()).toBe('Collections');
  });
});
