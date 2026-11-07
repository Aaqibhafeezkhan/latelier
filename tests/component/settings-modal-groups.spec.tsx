import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(uninstallAtelierMock);

async function mountModal() {
  const { SettingsModal } = await import('../../src/pages/SettingsModal');
  const { HintsProvider } = await import('../../src/hints/HintsProvider');
  installAtelierMock({ prefs: { get: async () => null, set: async (_k: string, v: unknown) => v } as never });
  render(
    <HintsProvider>
      <SettingsModal onClose={() => {}} />
    </HintsProvider>,
  );
  return screen.findByRole('tablist', { name: 'Settings sections' });
}

describe('SettingsModal: sections', () => {
  it('groups preferences apart from maintenance in a left rail', async () => {
    const rail = await mountModal();
    const text = rail.textContent ?? '';
    expect(text.indexOf('Preferences')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Maintenance')).toBeGreaterThan(text.indexOf('Preferences'));
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Appearance', 'Results', 'Editor and startup', 'Data and support']);
  });

  it('shows one section at a time and reaches the last one without scrolling', async () => {
    await mountModal();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset hints' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Data and support' }));
    expect(screen.getByRole('button', { name: 'Reset hints' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export bundle' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull();
  });
});
