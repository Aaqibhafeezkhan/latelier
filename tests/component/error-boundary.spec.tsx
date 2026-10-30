import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';

function Thrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <div>thrower ok</div>;
}

function NonThrower() {
  return <div>never throws</div>;
}

describe('<ErrorBoundary>', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installAtelierMock();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    uninstallAtelierMock();
    consoleErrorSpy.mockRestore();
  });

  it('renders fallback UI with Reload/Report controls when a child throws', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();
    expect(screen.queryByText('thrower ok')).toBeNull();
  });

  it('announces the fallback as an alert and moves focus to its heading', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    const heading = screen.getByRole('heading', { name: 'Something went wrong' });
    expect(alert.contains(heading)).toBe(true);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
  });

  it('logs the caught error via console.error with the boundary tag', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>,
    );

    const taggedCalls = consoleErrorSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === '[ErrorBoundary] uncaught render error',
    );
    expect(taggedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('calls window.location.reload when Reload is clicked', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // jsdom (29.x) marks location.reload non-configurable, so
    // vi.spyOn(window.location, 'reload') throws "Cannot redefine property".
    // Replacing the whole (configurable) location object is the portable mock;
    // the try/finally guarantees restoration even if an assertion throws.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    try {
      render(
        <ErrorBoundary>
          <Thrower shouldThrow />
        </ErrorBoundary>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reloadSpy).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('surfaces the diagnostic bundle path when Report is clicked', async () => {
    installAtelierMock({
      app: {
        diagnosticBundle: async () => ({ path: '/tmp/bundle.zip' }),
      },
    });

    render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Report' }));

    await waitFor(() => {
      expect(screen.getByText('Saved to /tmp/bundle.zip')).toBeTruthy();
    });
  });

  it('renders children normally with zero console.error calls when nothing throws', () => {
    render(
      <ErrorBoundary>
        <NonThrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText('never throws')).toBeTruthy();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('sends the caught error to the main log with its stack and the component stack', () => {
    const log = vi.fn<IpcApi['app']['log']>(async () => undefined);
    installAtelierMock({ app: { log } });

    render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>,
    );

    expect(log).toHaveBeenCalledTimes(1);
    const sent = log.mock.calls[0]![0];
    expect(sent).toMatchObject({ level: 'error', message: 'boom', source: 'errorBoundary' });
    // The error's own stack first, then the component stack naming the thrower.
    expect(sent.stack).toMatch(/^Error: boom\n/);
    expect(sent.stack).toMatch(/\n\s*at Thrower/);
  });

  it('cuts a stack longer than the channel accepts instead of losing the line', () => {
    const log = vi.fn<IpcApi['app']['log']>(async () => undefined);
    installAtelierMock({ app: { log } });
    function DeepThrower(): React.ReactNode {
      const err = new Error('deep');
      err.stack = `Error: deep\n${'    at frame (x.js:1:1)\n'.repeat(1000)}`;
      throw err;
    }

    render(
      <ErrorBoundary>
        <DeepThrower />
      </ErrorBoundary>,
    );

    expect(log.mock.calls[0]![0].stack).toHaveLength(8000);
  });
});
