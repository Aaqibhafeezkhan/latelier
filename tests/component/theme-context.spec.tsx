import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { StrictMode } from 'react';
import { notifications } from '@mantine/notifications';
import { render, waitFor, act, screen } from '../helpers/render';
import { useTheme, type ThemeMode } from '../../src/ThemeContext';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

interface Captured {
  dark: boolean;
  toggle: () => void;
}

function Probe({ onChange }: { onChange: (s: Captured) => void }) {
  const [dark, toggle] = useTheme();
  React.useEffect(() => {
    onChange({ dark, toggle });
  }, [dark, toggle, onChange]);
  return null;
}

describe('useTheme (renderer)', () => {
  afterEach(() => {
    uninstallAtelierMock();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('migrates legacy localStorage value into prefs and clears it', async () => {
    localStorage.setItem('ml-theme', 'dark');
    const setTheme = vi.fn(async () => undefined);
    installAtelierMock({
      prefs: {
        getTheme: async () => 'dark',
        setTheme,
        onThemeChanged: () => () => {},
      },
    });

    render(<Probe onChange={() => {}} />);

    await waitFor(() => {
      expect(setTheme).toHaveBeenCalledWith('dark');
    });
    expect(localStorage.getItem('ml-theme')).toBeNull();
  });

  it('reacts to onThemeChanged broadcasts from main', async () => {
    let broadcast: ((mode: ThemeMode) => void) | null = null;
    installAtelierMock({
      prefs: {
        getTheme: async () => 'light',
        setTheme: async () => undefined,
        onThemeChanged: (cb) => {
          broadcast = cb;
          return () => {};
        },
      },
    });

    const states: Captured[] = [];
    render(<Probe onChange={(s) => states.push(s)} />);

    await waitFor(() => {
      expect(broadcast).not.toBeNull();
    });

    act(() => broadcast!('dark'));
    await waitFor(() => {
      expect(states.at(-1)?.dark).toBe(true);
    });
  });
});

describe('useTheme — a theme that could not be saved says so', () => {
  afterEach(() => {
    uninstallAtelierMock();
    notifications.clean();
  });

  it('toasts when persisting the toggled theme fails', async () => {
    let toggle!: () => void;
    installAtelierMock({
      prefs: {
        getTheme: async () => 'light',
        setTheme: async () => {
          throw { code: 'SYSTEM_ERROR', message: 'disk full' };
        },
        onThemeChanged: () => () => {},
      },
    });
    render(<Probe onChange={(s) => (toggle = s.toggle)} />);
    await waitFor(() => expect(toggle).toBeDefined());

    act(() => toggle());

    expect(await screen.findByText('Could not save the theme')).toBeTruthy();
  });

  // main.tsx mounts under <StrictMode>, which runs a state updater twice in
  // dev; a write inside the updater went out twice per click.
  it('writes the toggled theme once per toggle under StrictMode', async () => {
    let toggle!: () => void;
    const setTheme = vi.fn(async () => undefined);
    installAtelierMock({
      prefs: { getTheme: async () => 'light', setTheme, onThemeChanged: () => () => {} },
    });
    render(
      <StrictMode>
        <Probe onChange={(s) => (toggle = s.toggle)} />
      </StrictMode>,
    );
    await waitFor(() => expect(toggle).toBeDefined());

    act(() => toggle());

    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('two toggles in one tick flip the theme twice, writing light then dark', async () => {
    let toggle!: () => void;
    const setTheme = vi.fn<(mode: ThemeMode) => Promise<void>>(async () => undefined);
    installAtelierMock({
      prefs: { getTheme: async () => 'light', setTheme, onThemeChanged: () => () => {} },
    });
    render(<Probe onChange={(s) => (toggle = s.toggle)} />);
    await waitFor(() => expect(toggle).toBeDefined());

    act(() => {
      toggle();
      toggle();
    });

    expect(setTheme.mock.calls.map((c) => c[0])).toEqual(['dark', 'light']);
  });
});
