import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '../helpers/render';
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
});

async function mountModal(status: () => Promise<{ columnKeyProtected: boolean }>) {
  const { SettingsModal } = await import('../../src/pages/SettingsModal');
  const { HintsProvider } = await import('../../src/hints/HintsProvider');
  installAtelierMock({ secrets: { status } as never });
  render(
    <HintsProvider>
      <SettingsModal onClose={() => {}} />
    </HintsProvider>,
  );
}

describe('SettingsModal: local data protection', () => {
  it('says the data is encrypted with a keychain-held key when the key is protected', async () => {
    await mountModal(async () => ({ columnKeyProtected: true }));
    const line = await screen.findByTestId('local-data-protection');
    expect(line.textContent).toMatch(/encrypted on disk with a key held by the OS keychain/);
  });

  it('says the key is stored unprotected, and never calls the data encrypted, when no keychain exists', async () => {
    await mountModal(async () => ({ columnKeyProtected: false }));
    const line = await screen.findByTestId('local-data-protection');
    expect(line.textContent).toMatch(/stored unprotected/);
    expect(line.textContent).not.toMatch(/encrypt/i);
  });

  it('shows no line and reports the failure when the status cannot be read', async () => {
    await mountModal(async () => {
      throw new Error('boom');
    });
    await vi.waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(screen.queryByTestId('local-data-protection')).toBeNull();
  });
});
