import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

const invalidateRecentValuesCache = vi.fn();
vi.mock('../../src/features/fieldSuggestions/sources', () => ({
  invalidateRecentValuesCache,
}));

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('SettingsModal — clear value history', () => {
  it('calls recent.clearFieldValues and invalidates the recent-values cache', async () => {
    const { SettingsModal } = await import('../../src/pages/SettingsModal');
    const { HintsProvider } = await import('../../src/hints/HintsProvider');
    const clearFieldValues = vi.fn(async () => ({ deleted: 3 }));
    installAtelierMock({
      prefs: { get: async () => null, set: async (_k, v) => v },
      recent: { clearFieldValues: clearFieldValues as never } as never,
    });

    render(
      <HintsProvider>
        <SettingsModal onClose={() => {}} />
      </HintsProvider>,
    );

    fireEvent.click(await screen.findByRole('tab', { name: 'Data and support' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear value history' }));

    await waitFor(() => expect(clearFieldValues).toHaveBeenCalledTimes(1));
    expect(invalidateRecentValuesCache).toHaveBeenCalledTimes(1);
  });
});
