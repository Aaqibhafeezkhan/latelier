import { describe, it, expect, afterEach } from 'vitest';
import { act, render as rtlRender, screen } from '@testing-library/react';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { notify } from '../../src/theme/notifications';
import App from '../../src/App';

afterEach(uninstallAtelierMock);

describe('App — toast placement', () => {
  it('shows toasts at the bottom left, clear of every dialog footer\'s right-aligned buttons', async () => {
    installAtelierMock({});
    // Rendered straight through RTL, not the shared helper: that helper mounts
    // its own Notifications, and this is about the app's.
    rtlRender(<App />);
    act(() => {
      notify.success('placement probe');
    });
    const toast = await screen.findByText('placement probe');
    expect(toast.closest('.mantine-Notifications-root')?.getAttribute('data-position')).toBe('bottom-left');
  });
});
