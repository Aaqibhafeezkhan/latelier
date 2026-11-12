// X07 §13.4: objects and their actions — the keys on an object row, the
// action list and its way back, destructive actions, verbs, the MRU, and
// Connections only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { useRegisterCommands } from '../../src/commands/useRegisterCommands';
import { useRegisterObjects } from '../../src/commands/useRegisterObjects';
import { commandRegistry } from '../../src/commands/registry';
import { collectionObject } from '../../src/pages/Workspace/collectionObject';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { WorkspaceTabsState } from '../../src/state/workspaceTabs';
import type { Command, FieldStep, ObjectAction, PaletteObject } from '../../src/commands/types';

const MRU_KEY = 'ui.commandPalette.mru';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function Register({ objects, commands }: { objects: PaletteObject[]; commands: Command[] }) {
  useRegisterObjects(objects, [objects]);
  useRegisterCommands(commands, [commands]);
  return null;
}

/** Spies for every action of every object, by `<object name>/<action id>`. */
const performed = vi.fn<(key: string) => void>();
const action = (obj: string, id: string, title: string, verb: string, over: Partial<ObjectAction> = {}): ObjectAction => ({
  id,
  verb,
  title,
  perform: () => performed(`${obj}/${id}`),
  ...over,
});

const orders: PaletteObject = {
  id: 'tab.open:c1:shop:orders',
  kind: 'collection',
  name: 'shop.orders',
  subtitle: 'Production',
  actions: [
    action('shop.orders', 'open', 'Open', 'open'),
    action('shop.orders', 'open-new-tab', 'Open in new tab', 'open', { alternate: true }),
    action('shop.orders', 'export', 'Export…', 'export'),
    action('shop.orders', 'rename', 'Rename…', 'rename', { disabledReason: () => 'This is a view' }),
    action('shop.orders', 'drop', 'Drop collection…', 'delete', { destructive: true }),
  ],
};
const conn = (name: string): PaletteObject => ({
  id: `connection.open:${name}`,
  kind: 'connection',
  name,
  subtitle: 'localhost',
  actions: [
    action(name, 'open', 'Open', 'open'),
    action(name, 'edit', 'Edit', 'edit'),
    action(name, 'delete', 'Delete…', 'delete', { destructive: true }),
  ],
});
const settings: Command = { id: 'settings.open', title: 'Open settings', group: 'general', perform: () => performed('settings') };

function mount(
  objects: PaletteObject[] = [orders, conn('Production'), conn('Staging')],
  commands: Command[] = [settings],
  stored: string[] = [],
) {
  const set = vi.fn(async (_k: string, v: unknown) => v);
  installAtelierMock({ prefs: { get: async (k: string) => (k === MRU_KEY ? stored : null), set } as never });
  render(
    <MemoryRouter>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Register objects={objects} commands={commands} />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
  return { set };
}

const palette = () => screen.queryByRole('dialog', { name: 'Command palette' });
const dialog = () => within(screen.getByRole('dialog', { name: 'Command palette' }));
const search = () => screen.getByLabelText('Search commands');
const filter = () => screen.getByLabelText('Filter actions');
const titles = () =>
  dialog()
    .queryAllByRole('option')
    .map((o) => o.querySelector('[data-title]')?.getAttribute('data-title'));
const cursorTitle = () =>
  dialog()
    .queryAllByRole('option')
    .find((o) => o.getAttribute('aria-selected') === 'true')
    ?.querySelector('[data-title]')
    ?.getAttribute('data-title');
const footer = () => document.querySelector('[data-palette-footer]')?.textContent ?? '';

function open(query = '') {
  fireEvent.click(screen.getByText('toggle'));
  if (query) fireEvent.change(search(), { target: { value: query } });
}
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { key, ...init });

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  performed.mockReset();
});

describe('the keys on an object row', () => {
  it('Enter performs the default action and closes', async () => {
    mount();
    open('orders');
    expect(titles()).toEqual(['shop.orders']);
    expect(footer()).toContain('Open');
    expect(footer()).toContain('Open in new tab');
    expect(footer()).toContain('Actions');
    press(search(), 'Enter');
    await waitFor(() => expect(performed).toHaveBeenCalledWith('shop.orders/open'));
    expect(performed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(palette()).toBeNull());
  });

  it('⌘↵ performs the alternate', async () => {
    mount();
    open('orders');
    press(search(), 'Enter', { metaKey: true });
    await waitFor(() => expect(performed).toHaveBeenCalledWith('shop.orders/open-new-tab'));
    expect(performed).toHaveBeenCalledTimes(1);
  });

  it('⌘↵ does nothing on an object without an alternate, and performs a command', async () => {
    mount();
    open('staging');
    expect(footer()).not.toContain('⌘');
    press(search(), 'Enter', { metaKey: true });
    expect(performed).not.toHaveBeenCalled();
    fireEvent.change(search(), { target: { value: 'settings' } });
    press(search(), 'Enter', { metaKey: true });
    await waitFor(() => expect(performed).toHaveBeenCalledWith('settings'));
  });

  it('⌥↵ opens the action list, and so does → with the caret at the end', () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    expect(screen.getByLabelText('Filter actions')).toBeTruthy();
    expect(performed).not.toHaveBeenCalled();
    press(filter(), 'Escape');

    const input = search() as HTMLInputElement;
    input.setSelectionRange(2, 2);
    press(input, 'ArrowRight');
    expect(screen.queryByLabelText('Filter actions')).toBeNull();
    input.setSelectionRange(6, 6);
    press(input, 'ArrowRight');
    expect(screen.getByLabelText('Filter actions')).toBeTruthy();
  });

  it('→ on a command row moves nothing', () => {
    mount();
    open('settings');
    press(search(), 'ArrowRight');
    expect(screen.queryByLabelText('Filter actions')).toBeNull();
  });
});

describe('the action list', () => {
  it('lists every action, destructive last after a divider, hides the scope row', () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    expect(titles()).toEqual(['Open', 'Open in new tab', 'Export…', 'Rename…', 'Drop collection…']);
    expect(dialog().queryByRole('tablist')).toBeNull();
    expect(dialog().getAllByRole('separator')).toHaveLength(1);
    const drop = dialog().getAllByRole('option')[4]!;
    expect(drop.getAttribute('data-destructive')).toBe('true');
    expect(drop.textContent).toContain('asks to confirm');
    const first = dialog().getAllByRole('option')[0]!;
    expect(first.textContent).toContain('reuses the open tab');
    expect(document.querySelector('[data-object-chip]')?.textContent).toBe('shop.orders · Production');
    expect(footer()).toContain('Run action');
    expect(footer()).toContain('Back to results');
    expect(footer()).toContain('Back, on an empty input');
    expect((filter() as HTMLInputElement).placeholder).toBe('Filter actions…');
  });

  it('names the highlighted action through aria-activedescendant', () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    const input = filter();
    const active = () => document.getElementById(input.getAttribute('aria-activedescendant') ?? '');
    expect(active()?.textContent).toContain('Open');
    press(input, 'ArrowDown');
    expect(active()?.textContent).toContain('Open in new tab');
    press(input, 'End');
    expect(active()?.textContent).toContain('Drop collection…');
    press(input, 'Home');
    expect(active()?.getAttribute('data-palette-action')).toBe('open');
    press(input, 'ArrowUp');
    expect(active()?.getAttribute('data-palette-action')).toBe('drop');
  });

  it('filters with the palette matcher, and Enter performs the highlighted one and closes', async () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    fireEvent.change(filter(), { target: { value: 'exp' } });
    expect(titles()).toEqual(['Export…']);
    press(filter(), 'Enter');
    await waitFor(() => expect(performed).toHaveBeenCalledWith('shop.orders/export'));
    await waitFor(() => expect(palette()).toBeNull());
  });

  it('performs a destructive action from the list (its own dialog confirms)', async () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    fireEvent.click(dialog().getAllByRole('option')[4]!);
    await waitFor(() => expect(performed).toHaveBeenCalledWith('shop.orders/drop'));
  });

  it('greys a disabled action with its reason and does not perform it', () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    fireEvent.change(filter(), { target: { value: 'rename' } });
    const row = dialog().getByRole('option');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('This is a view');
    press(filter(), 'Enter');
    fireEvent.click(row);
    expect(performed).not.toHaveBeenCalled();
    expect(palette()).not.toBeNull();
  });

  it.each([
    ['Escape', {}],
    ['ArrowLeft', {}],
    ['Backspace', {}],
  ])('%s on an empty filter goes back with the query and the cursor kept', (key) => {
    mount();
    open('o');
    press(search(), 'ArrowDown');
    const before = cursorTitle();
    expect(before).toBeTruthy();
    // The cursor may land on a command: walk to an object.
    while (dialog().getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.getAttribute('data-kind') === 'action') {
      press(search(), 'ArrowDown');
    }
    const at = cursorTitle();
    press(search(), 'Enter', { altKey: true });
    press(filter(), key);
    expect(palette()).not.toBeNull();
    expect((search() as HTMLInputElement).value).toBe('o');
    expect(cursorTitle()).toBe(at);
  });

  it('keeps the list on ← or Backspace while the filter has text, and Escape still goes back', () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    fireEvent.change(filter(), { target: { value: 'ex' } });
    press(filter(), 'ArrowLeft');
    press(filter(), 'Backspace');
    expect(screen.getByLabelText('Filter actions')).toBeTruthy();
    press(filter(), 'Escape');
    expect(screen.queryByLabelText('Filter actions')).toBeNull();
    expect(palette()).not.toBeNull();
  });

  it('goes back with the back button, and the next list starts unfiltered', () => {
    mount();
    open('orders');
    press(search(), 'Enter', { altKey: true });
    fireEvent.change(filter(), { target: { value: 'exp' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Back to results' }));
    expect((search() as HTMLInputElement).value).toBe('orders');
    press(search(), 'Enter', { altKey: true });
    expect((filter() as HTMLInputElement).value).toBe('');
  });

  it('marks the filter input so the modal does not close on its Escape', () => {
    mount();
    open('orders');
    expect(search().getAttribute('data-mantine-stop-propagation')).toBeNull();
    press(search(), 'Enter', { altKey: true });
    expect(filter().getAttribute('data-mantine-stop-propagation')).toBe('true');
  });
});

describe('a field step', () => {
  const withStep = (step: Partial<FieldStep>): PaletteObject => ({
    ...orders,
    actions: [
      ...orders.actions.slice(0, 2),
      action('shop.orders', 'filter-field', 'Filter by field…', 'filter', {
        fieldStep: () => ({
          title: 'Filter by field',
          loadFields: async () => [{ path: 'status', type: 'String' }],
          starters: [{ id: 'last7d', label: 'Last 7 days' }],
          chooseField: (f) => performed(`field/${f.path}`),
          chooseStarter: (id) => performed(`starter/${id}`),
          ...step,
        }),
      }),
    ],
  });
  const openStep = async () => {
    open('filter orders');
    press(search(), 'Enter');
    return screen.findByLabelText('Filter fields');
  };

  it('a sample that rejects lists no fields, the starters still', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount([withStep({ loadFields: () => Promise.reject(new Error('boom')) })]);
    await openStep();
    await waitFor(() => expect(dialog().getByRole('status').textContent).toBe('No fields sampled'));
    expect(titles()).toEqual(['Last 7 days']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('performs the chosen field or starter, closing the palette, with ↑↓ between them', async () => {
    mount([withStep({})]);
    const el = await openStep();
    await waitFor(() => expect(titles()).toEqual(['status', 'Last 7 days']));
    expect(cursorTitle()).toBe('status');
    press(el, 'End');
    expect(cursorTitle()).toBe('Last 7 days');
    press(el, 'Home');
    press(el, 'ArrowDown');
    expect(cursorTitle()).toBe('Last 7 days');
    press(el, 'ArrowUp');
    press(el, 'Tab');
    expect(cursorTitle()).toBe('status');
    press(el, 'ArrowDown');
    press(el, 'Enter');
    await waitFor(() => expect(performed).toHaveBeenCalledWith('starter/last7d'));
    await waitFor(() => expect(palette()).toBeNull());
  });

  it('a click chooses a row; ← on an empty input and the back button go back to the actions', async () => {
    mount([withStep({})]);
    let el = await openStep();
    press(el, 'ArrowLeft');
    expect(await screen.findByLabelText('Filter actions')).toBeTruthy();
    fireEvent.change(filter(), { target: { value: 'field' } });
    press(filter(), 'Enter');
    el = await screen.findByLabelText('Filter fields');
    // Typed text is not empty: ← stays.
    fireEvent.change(el, { target: { value: 'sta' } });
    press(el, 'ArrowLeft');
    expect(screen.getByLabelText('Filter fields')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to actions' }));
    expect(await screen.findByLabelText('Filter actions')).toBeTruthy();
    fireEvent.change(filter(), { target: { value: 'field' } });
    press(filter(), 'Enter');
    await screen.findByLabelText('Filter fields');
    await waitFor(() => expect(titles()).toEqual(['status', 'Last 7 days']));
    fireEvent.click(dialog().getAllByRole('option')[0]!);
    await waitFor(() => expect(performed).toHaveBeenCalledWith('field/status'));
  });

  it('hides the fields group when no field matches, and says so when nothing does', async () => {
    mount([withStep({})]);
    const el = await openStep();
    await waitFor(() => expect(titles()).toEqual(['status', 'Last 7 days']));
    fireEvent.change(el, { target: { value: 'days' } });
    expect(titles()).toEqual(['Last 7 days']);
    expect(dialog().queryByText('Fields · sampled')).toBeNull();
    fireEvent.change(el, { target: { value: 'zzz' } });
    expect(titles()).toEqual([]);
    expect(dialog().getByText('No matches for "zzz"')).toBeTruthy();
    fireEvent.change(el, { target: { value: 'sta' } });
    expect(dialog().getByText('Fields · sampled')).toBeTruthy();
    expect(dialog().queryByText(/No matches/)).toBeNull();
  });

  it('performs the action when its step returns null', async () => {
    mount([{ ...orders, actions: [action('shop.orders', 'filter-field', 'Filter by field…', 'filter', { fieldStep: () => null })] }]);
    open('filter orders');
    press(search(), 'Enter');
    await waitFor(() => expect(performed).toHaveBeenCalledWith('shop.orders/filter-field'));
  });
});

describe('destructive actions', () => {
  it('are never listed outside the action list without their verb', () => {
    mount();
    open('orders');
    expect(dialog().queryByText('Drop collection…')).toBeNull();
    expect(document.querySelector('[data-action-tag]')).toBeNull();
  });

  it('are reached by their verb: the row tags the action in red, and Enter performs it', async () => {
    mount();
    open('drop orders');
    expect(titles()).toEqual(['shop.orders']);
    const tag = document.querySelector('[data-action-tag]');
    expect(tag?.textContent).toBe('Drop collection…');
    expect(tag?.getAttribute('data-action-tag')).toBe('destructive');
    expect(document.querySelector('[data-verb-line]')?.textContent).toBe(
      'Read as the verb delete (from “drop”): only things that can be deleted are listed',
    );
    expect(footer()).toContain('Drop collection… (opens its confirm dialog)');
    expect(footer()).toContain('All actions');
    press(search(), 'Enter');
    await waitFor(() => expect(performed).toHaveBeenCalledWith('shop.orders/drop'));
  });

  it('⌘↵ on a row listed for a verb does nothing: the verb picked the action', async () => {
    mount();
    open('open orders');
    expect(titles()).toEqual(['shop.orders']);
    press(search(), 'Enter', { metaKey: true });
    await act(async () => {});
    expect(performed).not.toHaveBeenCalled();
    expect(dialog().getByRole('option')).toBeTruthy();
  });

  it('a verb an object lacks hides it, and a command on the whole query stays', () => {
    mount();
    open('open settings');
    expect(titles()).toEqual(['Open settings']);
    fireEvent.change(search(), { target: { value: 'export prod' } });
    expect(titles()).toEqual(['shop.orders']);
  });
});

describe('the MRU', () => {
  it('resolves a v1-stored id to its object under Recent', async () => {
    const built = collectionObject({
      connectionId: 'c1',
      db: 'shop',
      coll: 'orders',
      isView: false,
      connectionName: 'Production',
      tabs: () => ({}) as WorkspaceTabsState,
      showStructure: () => {},
      requestDialog: () => {},
      dormant: () => false,
      running: () => false,
      sampleSchema: async () => [],
      startQuery: () => {},
    });
    // The id a v1 `Open: shop.orders` row stored.
    expect(built.id).toBe('tab.open:c1:shop:orders');
    mount([built, conn('Production')], [], ['tab.open:c1:shop:orders', 'connection.open:Production']);
    await act(async () => {});
    open();
    await waitFor(() => expect(titles()).toEqual(['shop.orders', 'Production']));
    expect(dialog().getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Collection'),
      expect.stringContaining('Connection'),
    ]);
  });

  it('records the object whichever of its actions ran', async () => {
    const { set } = mount();
    await act(async () => {});
    open('orders');
    press(search(), 'Enter', { altKey: true });
    fireEvent.change(filter(), { target: { value: 'export' } });
    press(filter(), 'Enter');
    await waitFor(() => expect(set).toHaveBeenCalledWith(MRU_KEY, ['tab.open:c1:shop:orders']));
    open('drop staging');
    press(search(), 'Enter');
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(MRU_KEY, ['connection.open:Staging', 'tab.open:c1:shop:orders']),
    );
  });
});

describe('a verb alone and Connections only', () => {
  it('lists a row per kind with its destination, then the commands', () => {
    mount();
    open('open');
    expect(titles()).toEqual(['Open a collection…', 'Open a connection…', 'Open settings']);
    expect(dialog().getByText('Collections scope ›')).toBeTruthy();
    expect(dialog().getByText('All, connections only ›')).toBeTruthy();
    // Nothing follows the verb yet, so there is no verb line.
    expect(document.querySelector('[data-verb-line]')).toBeNull();
    expect(footer()).toContain('Switch scope');
    expect(footer()).toContain('Keep typing a name:open shop.or');
  });

  it('switches to the kind’s scope with the query kept', () => {
    mount();
    open('open');
    press(search(), 'Enter');
    expect(dialog().getByRole('tab', { selected: true }).textContent).toMatch(/^Collections/);
    expect((search() as HTMLInputElement).value).toBe('open');
    expect(titles()).toEqual(['shop.orders']);
  });

  it('`… a connection…` keeps All and lists Connections only, until the chip is removed', () => {
    mount();
    open('open');
    press(search(), 'ArrowDown');
    press(search(), 'Enter');
    expect(dialog().getByRole('tab', { selected: true }).textContent).toBe('All');
    // Shorter names first, inside one match class.
    expect(titles()).toEqual(['Staging', 'Production']);
    expect(document.querySelector('[data-verb-line]')).toBeNull();
    const chip = document.querySelector('[data-connections-only]');
    expect(chip?.textContent).toContain('Connections only');
    // The chip sits outside the tablist, which holds tabs only.
    expect(dialog().getByRole('tablist').contains(chip)).toBe(false);
    fireEvent.change(search(), { target: { value: 'open stag' } });
    expect(titles()).toEqual(['Staging']);
    fireEvent.click(dialog().getByRole('button', { name: 'Remove Connections only' }));
    expect(document.querySelector('[data-connections-only]')).toBeNull();
    expect(titles()).toContain('Staging');
  });

  it('ends Connections only when the query is cleared or the scope changes', () => {
    mount();
    open('open');
    press(search(), 'ArrowDown');
    press(search(), 'Enter');
    fireEvent.change(search(), { target: { value: '' } });
    fireEvent.change(search(), { target: { value: 'open' } });
    expect(document.querySelector('[data-connections-only]')).toBeNull();
    expect(titles()[0]).toBe('Open a collection…');

    // A retyped query starts at the top (#745).
    expect(cursorTitle()).toBe('Open a collection…');
    press(search(), 'ArrowDown');
    expect(cursorTitle()).toBe('Open a connection…');
    press(search(), 'Enter');
    expect(document.querySelector('[data-connections-only]')).not.toBeNull();
    press(search(), 'Tab');
    press(search(), 'Tab', { shiftKey: true });
    expect(document.querySelector('[data-connections-only]')).toBeNull();
  });
});
