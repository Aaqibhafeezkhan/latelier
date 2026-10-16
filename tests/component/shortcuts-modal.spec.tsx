import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { CommandPaletteRoot, usePaletteApi, _resetPaletteStoreForTests } from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { GlobalCommands } from '../../src/commands/GlobalCommands';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

const setPlatform = (platform: string | undefined) => {
  (window as unknown as { __atelierEnv__?: unknown }).__atelierEnv__ =
    platform === undefined ? undefined : { platform };
};

function mount() {
  installAtelierMock({});
  // Commands the Workspace registers; this spec mounts only the global ones.
  commandRegistry.add([
    { id: 'tab.new', title: 'New tab…', group: 'workspace', shortcut: '⌘T', perform: () => {} },
    { id: 'query.run', title: 'Run query', group: 'query', shortcut: '⌘↵', perform: () => {} },
  ]);
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
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
}

const dialog = () => screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

async function openFromPalette() {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.click(await screen.findByText('Keyboard shortcuts…'));
  return dialog();
}

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  setPlatform(undefined);
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('keyboard shortcuts cheat sheet', () => {
  it('opens from the palette and lists a command with its shortcut', async () => {
    setPlatform('darwin');
    mount();
    const dlg = await openFromPalette();
    const row = within(dlg).getByText('New tab…').closest('li')!;
    expect(within(row).getByText('⌘T')).toBeTruthy();
    expect(within(dlg).getByText('Run query')).toBeTruthy();
  });

  it('shows Ctrl combinations on Windows, in the sheet and in the palette', async () => {
    setPlatform('win32');
    mount();
    const dlg = await openFromPalette();
    const row = within(dlg).getByText('New tab…').closest('li')!;
    expect(within(row).getByText('Ctrl+T')).toBeTruthy();
    expect(within(within(dlg).getByText('Run query').closest('li')!).getByText('Ctrl+Enter')).toBeTruthy();
    expect(dlg.textContent).not.toContain('⌘');

    // Close it, then check the palette's own rows.
    fireEvent.keyDown(dlg, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
    fireEvent.click(screen.getByText('toggle'));
    const option = (await screen.findByText('New tab…')).closest('[role="option"]') as HTMLElement;
    expect(option.textContent).toContain('Ctrl+T');
    expect(option.textContent).not.toContain('⌘');
  });

  it('shows Mac glyphs on macOS', async () => {
    setPlatform('darwin');
    mount();
    const dlg = await openFromPalette();
    expect(within(dlg).getByText('⌘T')).toBeTruthy();
    expect(dlg.textContent).not.toContain('Ctrl+');
  });

  it('lists the shortcuts that are not commands', async () => {
    setPlatform('win32');
    mount();
    const dlg = await openFromPalette();
    expect(within(dlg).getByText('Ctrl+K')).toBeTruthy();
    expect(within(dlg).getByText('Ctrl+1–9')).toBeTruthy();
    expect(within(dlg).getByText('Ctrl+Alt+←')).toBeTruthy();
    expect(within(dlg).getByText('Ctrl+Alt+→')).toBeTruthy();
    expect(within(dlg).getByText('Ctrl+E')).toBeTruthy();
  });

  it('opens on mod+/, and Escape closes it and returns focus', async () => {
    setPlatform('win32');
    mount();
    const trigger = screen.getByText('toggle');
    trigger.focus();

    fireEvent.keyDown(trigger, { key: '/', ctrlKey: true });
    const dlg = await dialog();

    fireEvent.keyDown(dlg, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('opens on ⌘/ as well', async () => {
    setPlatform('darwin');
    mount();
    fireEvent.keyDown(screen.getByText('toggle'), { key: '/', metaKey: true });
    expect(await dialog()).toBeTruthy();
  });

  it('does nothing while focus is inside another dialog', async () => {
    mount();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    const inside = document.createElement('button');
    other.appendChild(inside);
    document.body.appendChild(other);
    inside.focus();
    fireEvent.keyDown(inside, { key: '/', ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    other.remove();
  });

  it('files the workspace-only and connection-form shortcuts under their own headings', async () => {
    setPlatform('win32');
    mount();
    const dlg = await openFromPalette();
    const section = (name: string) => within(dlg).getByRole('region', { name });

    expect(within(section('Anywhere')).getByText('Ctrl+K')).toBeTruthy();
    expect(within(section('Anywhere')).queryByText('Ctrl+E')).toBeNull();

    const workspace = section('In the workspace');
    for (const keys of ['Ctrl+1–9', 'Ctrl+Alt+←', 'Ctrl+Alt+→', 'Ctrl+E']) {
      expect(within(workspace).getByText(keys)).toBeTruthy();
    }

    const form = section('In the connection form');
    expect(within(form).getByText('Save connection')).toBeTruthy();
    expect(within(form).getByText('Ctrl+S')).toBeTruthy();
    expect(within(form).getByText('Test connection')).toBeTruthy();
    expect(within(form).getByText('Ctrl+Enter')).toBeTruthy();
  });

  it('does nothing while a text field has focus', async () => {
    mount();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: '/', ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    input.remove();
  });

  it('does nothing inside an editor (contenteditable)', async () => {
    mount();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    fireEvent.keyDown(editor, { key: '/', ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    editor.remove();
  });

  it('does not list a command that has no shortcut', async () => {
    mount();
    const dlg = await openFromPalette();
    expect(within(dlg).queryByText('Toggle dark mode')).toBeNull();
    expect(within(dlg).queryByText('Open settings')).toBeNull();
  });
});

describe('shortcut hints in tooltips', () => {
  it('the title bar search button names the platform shortcut', async () => {
    const { TitleBar } = await import('../../src/pages/Workspace/TitleBar');
    const open = async (platform: string) => {
      setPlatform(platform);
      const view = render(
        <TitleBar
          dark={false}
          toggle={() => {}}
          connectionName={null}
          onOpenSettings={() => {}}
          onOpenPalette={() => {}}
          shellOpen={false}
          shellAvailable={false}
          onToggleShell={() => {}}
        />,
      );
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Search actions' }));
      const tip = await screen.findByRole('tooltip');
      const text = tip.textContent;
      view.unmount();
      return text;
    };
    expect(await open('win32')).toBe('Search actions (Ctrl+K)');
    expect(await open('darwin')).toBe('Search actions (⌘K)');
  });
});
