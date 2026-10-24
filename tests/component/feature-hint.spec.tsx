import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '../helpers/render';
import { FeatureHint } from '../../src/hints/FeatureHint';
import { HintsProvider } from '../../src/hints/HintsProvider';
import { useFeatureHint } from '../../src/hints/useFeatureHint';
import { useHints } from '../../src/hints/HintsContext';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function withTheme(ui: React.ReactElement) {
  return ui;
}

describe('<FeatureHint>', () => {
  beforeEach(() => {
    installAtelierMock({ prefs: { get: async () => null, set: async (_k, v) => v } });
  });
  afterEach(() => {
    uninstallAtelierMock();
    vi.useRealTimers();
  });

  it('renders title, body, and Got it button when visible', async () => {
    render(
      withTheme(
        <>
          <button data-hint-anchor="refs.configure" type="button">
            References
          </button>
          <FeatureHint
            id="refs.configure"
            visible
            onDismiss={() => {}}
          />
        </>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Link this field to another doc?' })).toBeTruthy();
    });
    expect(screen.getByText(/Got it/)).toBeTruthy();
  });

  it('calls onDismiss when "Got it" is clicked', async () => {
    const onDismiss = vi.fn();
    render(
      withTheme(
        <>
          <button data-hint-anchor="refs.configure" type="button">
            References
          </button>
          <FeatureHint
            id="refs.configure"
            visible
            onDismiss={onDismiss}
          />
        </>,
      ),
    );
    await waitFor(() => screen.getByText(/Got it/));
    fireEvent.click(screen.getByText(/Got it/));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders nothing when visible is false', () => {
    const { container } = render(
      withTheme(
        <FeatureHint
          id="tabs.pin"
          visible={false}
          onDismiss={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[data-feature-hint]')).toBeNull();
  });
});

describe('<FeatureHint> focus', () => {
  beforeEach(() => {
    installAtelierMock({ prefs: { get: async () => null, set: async (_k, v) => v } });
  });
  afterEach(() => {
    uninstallAtelierMock();
  });

  function Harness({
    onDismiss,
    onCta,
    parentKeyDown,
    visible = true,
  }: {
    onDismiss: () => void;
    onCta?: () => void;
    parentKeyDown?: (e: React.KeyboardEvent) => void;
    visible?: boolean;
  }) {
    return (
      <div onKeyDown={parentKeyDown}>
        <input aria-label="Filter" />
        <button data-hint-anchor="refs.configure" type="button">
          References
        </button>
        <FeatureHint id="refs.configure" visible={visible} onDismiss={onDismiss} onCta={onCta} />
      </div>
    );
  }

  // fireEvent returns false when the event was default-prevented.
  const pressF6 = () => fireEvent.keyDown(window, { key: 'F6' });

  it('leaves focus where it is when the hint appears, and announces the title', async () => {
    render(<Harness onDismiss={() => {}} />);
    const input = screen.getByLabelText('Filter');
    input.focus();
    const dialog = await screen.findByRole('dialog', { name: 'Link this field to another doc?' });
    expect(document.activeElement).toBe(input);
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('Link this field to another doc?');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/\S/);
  });

  it('F6 moves focus to Got it', async () => {
    render(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    screen.getByLabelText('Filter').focus();
    expect(pressF6()).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Got it' }));
  });

  it('F6 is ignored while a modal dialog is open', async () => {
    render(
      <>
        <Harness onDismiss={() => {}} />
        <div role="dialog" aria-modal="true" aria-label="Some modal" />
      </>,
    );
    await screen.findByRole('dialog', { name: 'Link this field to another doc?' });
    const input = screen.getByLabelText('Filter');
    input.focus();
    expect(pressF6()).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('F6 does nothing once the hint is hidden', async () => {
    const { rerender } = render(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    const input = screen.getByLabelText('Filter');
    input.focus();
    rerender(<Harness onDismiss={() => {}} visible={false} />);
    pressF6();
    expect(document.activeElement).toBe(input);
  });

  it('Escape inside dismisses, gives focus back, and stays out of the parent', async () => {
    const onDismiss = vi.fn();
    const parentKeyDown = vi.fn();
    render(<Harness onDismiss={onDismiss} parentKeyDown={parentKeyDown} />);
    await screen.findByRole('dialog');
    const input = screen.getByLabelText('Filter');
    input.focus();
    pressF6();
    const gotIt = screen.getByRole('button', { name: 'Got it' });
    expect(document.activeElement).toBe(gotIt);
    fireEvent.keyDown(gotIt, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it('Got it restores focus to where F6 found it', async () => {
    const input = () => screen.getByLabelText('Filter');
    render(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    input().focus();
    pressF6();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(document.activeElement).toBe(input());
  });

  it('dismissing a hint that never took focus leaves focus alone', async () => {
    render(<Harness onDismiss={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const input = screen.getByLabelText('Filter');
    input.focus();
    expect(dialog.contains(document.activeElement)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(document.activeElement).toBe(input);
  });

  it('does not steal focus back after focus left the hint on its own', async () => {
    render(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    const input = screen.getByLabelText('Filter');
    input.focus();
    pressF6();
    const refs = screen.getByRole('button', { name: 'References' });
    act(() => refs.focus());
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(document.activeElement).toBe(refs);
  });

  it('Tab from the last control wraps inside the hint once focus is in it', async () => {
    render(<Harness onDismiss={() => {}} onCta={() => {}} />);
    await screen.findByRole('dialog');
    screen.getByLabelText('Filter').focus();
    pressF6();
    const gotIt = screen.getByRole('button', { name: 'Got it' });
    fireEvent.keyDown(gotIt, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss hint' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Dismiss hint' }), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(gotIt);
  });

  it('a later visit that did not start with F6 does not jump back to the earlier spot', async () => {
    render(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    const input = screen.getByLabelText('Filter');
    input.focus();
    pressF6();
    const gotIt = screen.getByRole('button', { name: 'Got it' });
    fireEvent.click(gotIt);
    expect(document.activeElement).toBe(input);
    // Tabbed in this time: the hint (still mounted, as the parent ignores onDismiss) has no spot to go back to.
    act(() => gotIt.focus());
    fireEvent.click(gotIt);
    expect(document.activeElement).toBe(gotIt);
  });

  it('a hint that hid without a blur and comes back does not steal focus', async () => {
    const { rerender } = render(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    const input = screen.getByLabelText('Filter');
    input.focus();
    pressF6();
    // The parent hides it (a mouse "Got it", a trigger flipping) with focus still inside.
    rerender(<Harness onDismiss={() => {}} visible={false} />);
    act(() => screen.getByLabelText('Filter').focus());
    rerender(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    expect(document.activeElement).toBe(screen.getByLabelText('Filter'));
  });

  it('keeps its live region mounted while hidden and fills it when shown', async () => {
    const { rerender } = render(<Harness onDismiss={() => {}} visible={false} />);
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe('');
    rerender(<Harness onDismiss={() => {}} />);
    await screen.findByRole('dialog');
    expect(document.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region?.textContent).toBe('Link this field to another doc?');
    // Every hint call site mounts a region; none may claim the page's status role.
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('the call to action also hands focus back', async () => {
    const onCta = vi.fn();
    render(<Harness onDismiss={() => {}} onCta={onCta} />);
    await screen.findByRole('dialog');
    const input = screen.getByLabelText('Filter');
    input.focus();
    pressF6();
    const cta = screen.getByRole('button', { name: 'Configure references' });
    act(() => cta.focus());
    fireEvent.click(cta);
    expect(onCta).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
  });
});

describe('HintsProvider + useFeatureHint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installAtelierMock({ prefs: { get: async () => null, set: async (_k, v) => v } });
  });
  afterEach(() => {
    uninstallAtelierMock();
    vi.useRealTimers();
  });

  it('only the first registered candidate becomes visible', async () => {
    function Probe() {
      const a = useFeatureHint('refs.configure', true);
      const b = useFeatureHint('tabs.pin', true);
      return (
        <div>
          <span data-testid="a">{a.visible ? 'visible' : 'hidden'}</span>
          <span data-testid="b">{b.visible ? 'visible' : 'hidden'}</span>
        </div>
      );
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    // Allow loaded promise to resolve, then advance the settle timer.
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('a').textContent).toBe('visible');
    expect(screen.getByTestId('b').textContent).toBe('hidden');
  });

  it('a hint is suppressed during the initial settle window', async () => {
    function Probe() {
      const h = useFeatureHint('refs.configure', true);
      return <span data-testid="h">{h.visible ? 'visible' : 'hidden'}</span>;
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('h').textContent).toBe('hidden');
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('h').textContent).toBe('visible');
  });

  it('the lower-priority hint wins even when it registers second', async () => {
    // `tabs.pin` (priority 20) mounts first here; `run.execute` (priority 0)
    // registers after it. `HintsProvider` must still pick `run.execute` —
    // priority beats registration order, otherwise the primary Run hint
    // could lose to whichever secondary hint happened to mount first.
    function Probe() {
      const secondary = useFeatureHint('tabs.pin', true);
      const primary = useFeatureHint('run.execute', true);
      return (
        <div>
          <span data-testid="secondary">{secondary.visible ? 'visible' : 'hidden'}</span>
          <span data-testid="primary">{primary.visible ? 'visible' : 'hidden'}</span>
        </div>
      );
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('primary').textContent).toBe('visible');
    expect(screen.getByTestId('secondary').textContent).toBe('hidden');
  });

  it('with a run already recorded, editing the filter makes run.execute visible and it outranks a secondary hint', async () => {
    // Mirrors `Workspace.tsx`'s wiring: a query-run key is recorded for the
    // filter that was actually run (`ranKey`, standing in for `lastRun`
    // being set); `run.execute`'s trigger reads the session count for the
    // *current* query's key (`editedKey`, standing in for the filter after
    // an edit). Zero means the query on screen has never itself been run,
    // even though something else in this tab has.
    const ranKey = 'find:c1:db:coll:{"a":1}';
    const editedKey = 'find:c1:db:coll:{"a":2}';
    function Probe() {
      const h = useHints();
      React.useEffect(() => {
        h.recordSessionEvent('queryRun', ranKey);
      }, [h]);
      const runExecute = useFeatureHint(
        'run.execute',
        h.getSessionEventCount('queryRun', editedKey) === 0,
      );
      const secondary = useFeatureHint('tabs.pin', true);
      return (
        <div>
          <span data-testid="run">{runExecute.visible ? 'visible' : 'hidden'}</span>
          <span data-testid="secondary">{secondary.visible ? 'visible' : 'hidden'}</span>
        </div>
      );
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('run').textContent).toBe('visible');
    expect(screen.getByTestId('secondary').textContent).toBe('hidden');
  });

  it('a dismissed hint stays hidden even when the trigger is true', async () => {
    installAtelierMock({
      prefs: {
        get: async () => ({ dismissedIds: ['refs.configure'] }) as never,
        set: async (_k, v) => v as never,
      },
    });
    function Probe() {
      const h = useFeatureHint('refs.configure', true);
      return <span data-testid="h">{h.visible ? 'visible' : 'hidden'}</span>;
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('h').textContent).toBe('hidden');
  });
});
