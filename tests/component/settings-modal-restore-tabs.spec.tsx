import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

const notifyError = vi.fn();
vi.mock('../../src/theme/notifications', async (orig) => {
  const mod = await orig<typeof import('../../src/theme/notifications')>();
  return { ...mod, notify: { ...mod.notify, error: notifyError } };
});

const KEY = 'ui.workspace.restoreTabs';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  notifyError.mockReset();
});

async function mountModal(prefs: {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<unknown>;
}) {
  const { SettingsModal } = await import('../../src/pages/SettingsModal');
  const { HintsProvider } = await import('../../src/hints/HintsProvider');
  installAtelierMock({ prefs: prefs as never });
  render(
    <HintsProvider>
      <SettingsModal onClose={() => {}} />
    </HintsProvider>,
  );
  return screen.findByRole('switch', { name: 'Reopen tabs on launch' });
}

describe('SettingsModal: reopen tabs on launch', () => {
  it('is on when the preference was never set', async () => {
    const sw = await mountModal({ get: async () => null, set: async (_k, v) => v });
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(true));
  });

  it('is off when the stored preference is false', async () => {
    const get = vi.fn(async (key: string) => (key === KEY ? false : null));
    const sw = await mountModal({ get, set: async (_k, v) => v });
    await waitFor(() => expect(get).toHaveBeenCalledWith(KEY));
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(false));
  });

  it('says that turning it off loses unsaved pipelines along with the tabs', async () => {
    const sw = await mountModal({ get: async () => null, set: async (_k, v) => v });
    const describedBy = sw.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'When off, the app starts with no tabs open, pinned ones included, and pipeline changes that were never saved are lost with them.',
    );
  });

  it('saves false when switched off', async () => {
    const set = vi.fn(async (_k: string, v: unknown) => v);
    const sw = await mountModal({ get: async () => null, set });
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(true));
    fireEvent.click(sw);
    await waitFor(() => expect(set).toHaveBeenCalledWith(KEY, false));
    expect((sw as HTMLInputElement).checked).toBe(false);
  });

  it('toasts and reverts when the save is rejected', async () => {
    const set = vi.fn(async () => {
      throw new Error('disk full');
    });
    const sw = await mountModal({ get: async () => null, set });
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(true));
    fireEvent.click(sw);
    await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(true));
  });
});
