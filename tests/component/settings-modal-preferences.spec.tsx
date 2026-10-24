import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { within } from '@testing-library/react';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

const notifyError = vi.fn();
vi.mock('../../src/theme/notifications', async (orig) => {
  const mod = await orig<typeof import('../../src/theme/notifications')>();
  return { ...mod, notify: { ...mod.notify, error: notifyError } };
});

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  notifyError.mockReset();
  document.documentElement.style.removeProperty('--atelier-editor-font-size');
});

interface Mounted {
  set: ReturnType<typeof vi.fn>;
  setTheme: ReturnType<typeof vi.fn>;
}

async function mount(
  stored: Record<string, unknown> = {},
  opts: { theme?: 'light' | 'dark' | 'system'; setFails?: boolean } = {},
): Promise<Mounted> {
  const { SettingsModal } = await import('../../src/pages/SettingsModal');
  const { HintsProvider } = await import('../../src/hints/HintsProvider');
  const set = vi.fn(async (_k: string, v: unknown) => {
    if (opts.setFails) throw new Error('disk full');
    return v;
  });
  const setTheme = vi.fn(async () => undefined);
  const get = vi.fn(async (key: string) => (key in stored ? stored[key] : null));
  installAtelierMock({
    prefs: {
      get,
      set,
      getTheme: async () => opts.theme ?? 'system',
      setTheme,
      onThemeChanged: () => () => {},
    } as never,
  });
  render(
    <HintsProvider>
      <SettingsModal onClose={() => {}} />
    </HintsProvider>,
  );
  await waitFor(() => expect(get).toHaveBeenCalledWith('ui.editor.fontSize'));
  return { set, setTheme };
}

const radio = (group: string, name: string) =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });
describe('SettingsModal: theme', () => {
  it('offers Light, Dark and System and shows the stored mode', async () => {
    await mount({}, { theme: 'dark' });
    await waitFor(() => expect((radio('Theme', 'Dark') as HTMLInputElement).checked).toBe(true));
    expect(radio('Theme', 'Light')).toBeTruthy();
    expect(radio('Theme', 'System')).toBeTruthy();
  });

  it('System is selectable and is what gets saved', async () => {
    const { setTheme } = await mount({}, { theme: 'dark' });
    await waitFor(() => expect((radio('Theme', 'Dark') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(radio('Theme', 'System'));
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith('system'));
    expect((radio('Theme', 'System') as HTMLInputElement).checked).toBe(true);
  });

  it('reverts and toasts when the theme cannot be saved', async () => {
    const { SettingsModal } = await import('../../src/pages/SettingsModal');
    const { HintsProvider } = await import('../../src/hints/HintsProvider');
    installAtelierMock({
      prefs: {
        get: async () => null,
        set: async (_k: string, v: unknown) => v,
        getTheme: async () => 'light',
        setTheme: async () => {
          throw new Error('disk full');
        },
        onThemeChanged: () => () => {},
      } as never,
    });
    render(
      <HintsProvider>
        <SettingsModal onClose={() => {}} />
      </HintsProvider>,
    );
    await waitFor(() => expect((radio('Theme', 'Light') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(radio('Theme', 'Dark'));
    await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((radio('Theme', 'Light') as HTMLInputElement).checked).toBe(true));
  });
});

describe('SettingsModal: default page size', () => {
  it('shows the stored size', async () => {
    await mount({ 'ui.workspace.defaultPageSize': 250 });
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'Default page size' }) as HTMLInputElement).value).toBe('250'),
    );
  });

  it('ignores a stored size that is not an option and shows 50', async () => {
    await mount({ 'ui.workspace.defaultPageSize': 77 });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Default page size' })).toBeTruthy());
    expect((screen.getByRole('combobox', { name: 'Default page size' }) as HTMLInputElement).value).toBe('50');
  });

  it('saves the picked size', async () => {
    const { set } = await mount();
    fireEvent.click(screen.getByRole('combobox', { name: 'Default page size' }));
    fireEvent.click(await screen.findByRole('option', { name: '100' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.workspace.defaultPageSize', 100));
  });
});

describe('SettingsModal: default result view', () => {
  it('shows the stored view', async () => {
    await mount({ 'ui.workspace.defaultView': 'JSON' });
    await waitFor(() =>
      expect((radio('Default result view', 'JSON') as HTMLInputElement).checked).toBe(true),
    );
  });

  it('saves the picked view', async () => {
    const { set } = await mount();
    fireEvent.click(radio('Default result view', 'Table'));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.workspace.defaultView', 'Table'));
  });

  it('reverts and toasts when the save is rejected', async () => {
    await mount({ 'ui.workspace.defaultView': 'Tree' }, { setFails: true });
    await waitFor(() =>
      expect((radio('Default result view', 'Tree') as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(radio('Default result view', 'JSON'));
    await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((radio('Default result view', 'Tree') as HTMLInputElement).checked).toBe(true),
    );
  });
});

describe('SettingsModal: editor font size', () => {
  it('shows the stored size', async () => {
    await mount({ 'ui.editor.fontSize': 16 });
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'Editor font size' }) as HTMLInputElement).value).toBe('16'),
    );
  });

  it('saves the size and applies it to the page at once', async () => {
    const { set } = await mount();
    fireEvent.click(screen.getByRole('combobox', { name: 'Editor font size' }));
    fireEvent.click(await screen.findByRole('option', { name: '18' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.editor.fontSize', 18));
    expect(document.documentElement.style.getPropertyValue('--atelier-editor-font-size')).toBe('18px');
  });

  it('puts the old size back when the save is rejected', async () => {
    await mount({ 'ui.editor.fontSize': 12 }, { setFails: true });
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'Editor font size' }) as HTMLInputElement).value).toBe('12'),
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Editor font size' }));
    fireEvent.click(await screen.findByRole('option', { name: '20' }));
    await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--atelier-editor-font-size')).toBe('12px'),
    );
  });
});
