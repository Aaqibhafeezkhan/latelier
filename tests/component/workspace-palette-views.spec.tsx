// Palette entries that reach a pane without the mouse: the Mongo shell, and
// the Structure sub-view's schema and indexes sections.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import {
  installAtelierMock,
  uninstallAtelierMock,
  connectionFixture,
  collectionTabFixture,
} from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';
import type { WorkspaceTab } from '@shared/types';

const NOW = '2026-08-01T12:00:00.000Z';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function mount(tabs: WorkspaceTab[]) {
  const start = vi.fn<IpcApi['mshell']['start']>(async () => ({
    sessionId: 's1',
    connectionId: 'c1',
    startedAt: NOW,
  }));
  installAtelierMock({
    conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    tabs: {
      list: async () => tabs,
      update: async (id: string) => tabs.find((t) => t.id === id) ?? tabs[0],
    },
    index: { list: async () => [] },
    meta: { sampleSchema: async () => ({ docs: [] }) },
    mshell: {
      start,
      write: async () => undefined,
      stop: async () => undefined,
      list: async () => [],
      onOutput: () => () => {},
    },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Workspace />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
  return { start };
}

const collectionTab = () =>
  collectionTabFixture({ id: 't1', dbName: 'shop', collection: 'orders', isActive: true });

/** Open the palette, type `q`, click the row titled `title`. */
async function run(q: string, title: string) {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: q } });
  fireEvent.click(await within(screen.getByRole('dialog')).findByText(title));
}

function paletteTitles(q: string): string[] {
  if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByText('toggle'));
  fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: q } });
  return within(screen.getByRole('dialog'))
    .queryAllByRole('option')
    .map((o) => o.querySelector('[data-title]')?.getAttribute('data-title') ?? '');
}

function structureTab() {
  return within(screen.getByRole('tablist', { name: 'Collection view' })).getByRole('tab', {
    name: /Structure/,
  });
}

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  vi.restoreAllMocks();
});

describe('palette: shell and structure entries', () => {
  it('"Shell" opens the Mongo shell pane and closes it again, the palette staying open on its row', async () => {
    const { start } = mount([collectionTab()]);
    await screen.findByLabelText('Close orders');
    expect(screen.queryByTestId('mongo-shell-pane')).toBeNull();

    fireEvent.click(screen.getByText('toggle'));
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'shell' } });
    const row = () => within(screen.getByRole('dialog')).getByRole('option', { name: /^Shell/ });
    fireEvent.click(row());

    expect(await screen.findByTestId('mongo-shell-pane')).toBeTruthy();
    await waitFor(() => expect(start).toHaveBeenCalled());
    await waitFor(() => expect(row().getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(row());
    await waitFor(() => expect(screen.queryByTestId('mongo-shell-pane')).toBeNull());
    await waitFor(() => expect(row().getAttribute('aria-checked')).toBe('false'));
  });

  it('"Go to schema" switches to the Structure view and shows the schema', async () => {
    mount([collectionTab()]);
    await screen.findByLabelText('Close orders');
    expect(structureTab().getAttribute('aria-selected')).toBe('false');

    await run('schema', 'Go to schema');

    await waitFor(() => expect(structureTab().getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByLabelText('Sample size')).toBeTruthy();
  });

  // The schema sits below the whole index list in one scroller, so selecting
  // Structure alone can leave it below the fold; the command must scroll to
  // it, and again when Structure is already the active view.
  it('"Go to schema" brings the schema section into view, also when Structure is already active', async () => {
    const scrolled: Element[] = [];
    const proto = HTMLElement.prototype as { scrollIntoView?: (arg?: unknown) => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      mount([collectionTab()]);
      await screen.findByLabelText('Close orders');

      await run('schema', 'Go to schema');
      const region = await screen.findByRole('region', { name: 'Schema' });
      await waitFor(() => expect(scrolled).toContain(region));

      scrolled.length = 0;
      await run('schema', 'Go to schema');
      await waitFor(() => expect(scrolled).toContain(region));
      expect(scrolled.some((el) => el.getAttribute('aria-label') === 'Indexes')).toBe(false);
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('"Go to indexes" switches to the Structure view and brings the indexes into view', async () => {
    const scrolled: Element[] = [];
    const proto = HTMLElement.prototype as { scrollIntoView?: (arg?: unknown) => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      mount([collectionTab()]);
      await screen.findByLabelText('Close orders');

      await run('indexes', 'Go to indexes');

      await waitFor(() => expect(structureTab().getAttribute('aria-selected')).toBe('true'));
      const region = await screen.findByRole('region', { name: 'Indexes' });
      await waitFor(() => expect(scrolled).toContain(region));
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('offers no structure entries without a collection tab, and no shell without a connection', async () => {
    mount([
      {
        id: 's1',
        kind: 'script',
        connectionId: 'c1',
        dbName: '',
        collection: '',
        position: 0,
        isActive: true,
        openedAt: NOW,
        pinned: false,
        state: { title: 'Script', source: '1', dbName: 'shop' },
      },
    ]);
    await screen.findByLabelText('Close Script');
    expect(paletteTitles('go to')).not.toEqual(expect.arrayContaining(['Go to schema']));
    expect(paletteTitles('go to')).not.toEqual(expect.arrayContaining(['Go to indexes']));
    expect(paletteTitles('shell')).toContain('Shell');
  });

  it('offers no shell entry when no connection is focused', async () => {
    mount([]);
    await waitFor(() => expect(screen.getByText('toggle')).toBeTruthy());
    expect(paletteTitles('shell')).not.toContain('Shell');
    expect(paletteTitles('schema')).not.toContain('Go to schema');
  });
});

describe('palette: Copy MQL to clipboard', () => {
  const copyRow = () => within(screen.getByRole('dialog')).getByRole('option', { name: /^Copy MQL to clipboard/ });

  it('is listed greyed, with its reason, while the filter is empty', async () => {
    mount([collectionTab()]);
    await screen.findByLabelText('Close orders');
    paletteTitles('copy mql');
    expect(copyRow().getAttribute('aria-disabled')).toBe('true');
    expect(copyRow().querySelector('[data-subtitle]')!.textContent).toBe('Type a filter first');
  });

  it('is available once a filter is typed', async () => {
    const tab = collectionTab();
    mount([{ ...tab, state: { ...tab.state, queryRaw: '{"sku":"a"}' } } as WorkspaceTab]);
    await screen.findByLabelText('Close orders');
    paletteTitles('copy mql');
    expect(copyRow().hasAttribute('aria-disabled')).toBe(false);
  });
});

