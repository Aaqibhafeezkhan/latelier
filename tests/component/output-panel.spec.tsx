import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  fireEvent,
  screen,
  expectSeparatorClampedAtBounds,
  expectSeparatorResizesPanel,
} from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { OutputPanel } from '../../src/pages/Workspace/Aggregation/OutputPanel';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { notifications } from '@mantine/notifications';
import type { AggregationLastRun, ResultViewMode } from '@shared/types';

let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  installAtelierMock();
  originalClipboard = navigator.clipboard;
});
afterEach(() => {
  // Mantine's notification store is module-global and outlives RTL's
  // unmount, so a toast raised by one test would still be on screen for the
  // next one's "did it *not* claim success?" assertion.
  notifications.clean();
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderPanel(
  overrides: {
    view?: ResultViewMode;
    lastRun?: AggregationLastRun | undefined;
    running?: boolean;
    onViewChange?: (v: ResultViewMode) => void;
    onSaveAsCollection?: () => void;
    onSaveAsView?: () => void;
  } = {},
) {
  return render(
      <OutputPanel
        height={260}
        view={overrides.view ?? 'Tree'}
        lastRun={overrides.lastRun}
        running={overrides.running ?? false}
        pipelineName={null}
        onHeightChange={vi.fn()}
        onHeightCommit={vi.fn()}
        onViewChange={overrides.onViewChange ?? vi.fn()}
        onSaveAsCollection={overrides.onSaveAsCollection ?? vi.fn()}
        onSaveAsView={overrides.onSaveAsView ?? vi.fn()}
      />
  );
}

/**
 * P1-12 coverage for OutputPanel.
 */
// Required by `AggregationLastRun`; these specs assert on rows/duration/error only.
const runMeta = { ranAt: '2026-04-21T12:00:00.000Z', stageCounts: {}, stageSamples: {} };

describe('OutputPanel — rendering and view switching', () => {
  it('shows row count and durationMs from lastRun', () => {
    const lastRun: AggregationLastRun = {
      ...runMeta,
      rows: [{ _id: 1 }, { _id: 2 }, { _id: 3 }],
      durationMs: 42,
    };
    const { container } = renderPanel({ lastRun });
    expect(container.textContent).toContain('3 docs');
    expect(container.textContent).toContain('42ms');
  });

  it('renders an error banner from lastRun.error with role="alert"', () => {
    const lastRun: AggregationLastRun = {
      ...runMeta,
      rows: [],
      durationMs: 0,
      error: { code: 'MONGO_ERROR', message: 'pipeline blew up' },
    };
    renderPanel({ lastRun });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('pipeline blew up');
  });

  it('invokes onViewChange when the user clicks a view button', () => {
    const onViewChange = vi.fn();
    renderPanel({ view: 'Tree', onViewChange });
    fireEvent.click(screen.getByText('JSON'));
    expect(onViewChange).toHaveBeenCalledWith('JSON');
    fireEvent.click(screen.getByText('Table'));
    expect(onViewChange).toHaveBeenLastCalledWith('Table');
  });

  it('disables copy / save / download when there are no rows', () => {
    renderPanel({ lastRun: { ...runMeta, rows: [], durationMs: 5 } });
    const copyBtn = screen.getByText('Copy').closest('button')!;
    const saveBtn = screen.getByText('Save as…').closest('button')!;
    expect(copyBtn.hasAttribute('disabled')).toBe(true);
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
  });

  // Copy used to `.catch(() => {})`, so a denied clipboard was
  // indistinguishable from a successful copy.
  it('reports a copied output', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel({ lastRun: { ...runMeta, rows: [{ _id: 1 }], durationMs: 5 } });

    fireEvent.click(screen.getByText('Copy').closest('button')!);

    expect(await screen.findByText(/Output copied to the clipboard/)).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Could not copy to the clipboard/)).toBeNull();
  });

  it('reports a rejected copy rather than claiming success', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel({ lastRun: { ...runMeta, rows: [{ _id: 1 }], durationMs: 5 } });

    fireEvent.click(screen.getByText('Copy').closest('button')!);

    await screen.findByText(/Could not copy to the clipboard/);
    expect(screen.queryByText(/Output copied to the clipboard/)).toBeNull();
  });

  it('reports a failed save instead of swallowing it', async () => {
    const saveFile = vi.fn(async () => {
      throw new Error('EACCES: permission denied');
    });
    installAtelierMock({ app: { saveFile } as never });
    renderPanel({ lastRun: { ...runMeta, rows: [{ _id: 1 }], durationMs: 5 } });

    fireEvent.click(screen.getByRole('button', { name: 'Download output as JSON' }));

    expect(await screen.findByText(/Could not save the output: .*permission denied/)).toBeTruthy();
  });

  it('says nothing when the save panel is cancelled', async () => {
    const saveFile = vi.fn(async () => ({ path: null }));
    installAtelierMock({ app: { saveFile } as never });
    renderPanel({ lastRun: { ...runMeta, rows: [{ _id: 1 }], durationMs: 5 } });

    fireEvent.click(screen.getByRole('button', { name: 'Download output as JSON' }));

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Could not save the output/)).toBeNull();
  });

  it('shows the Running… overlay when running is true', () => {
    const { container } = renderPanel({ running: true, lastRun: { ...runMeta, rows: [], durationMs: 0 } });
    expect(container.textContent).toContain('Running');
  });

  it('keeps one polite status region mounted and announces both start and finish of a run', () => {
    const finished: AggregationLastRun = { ...runMeta, rows: [{ _id: 1 }, { _id: 2 }], durationMs: 5 };
    const panel = (running: boolean, lastRun?: AggregationLastRun) => (
      <OutputPanel
        height={260}
        view="Tree"
        lastRun={lastRun}
        running={running}
        pipelineName={null}
        onHeightChange={vi.fn()}
        onHeightCommit={vi.fn()}
        onViewChange={vi.fn()}
        onSaveAsCollection={vi.fn()}
        onSaveAsView={vi.fn()}
      />
    );
    const { rerender } = render(panel(false));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    rerender(panel(true));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Running…');

    rerender(panel(false, finished));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Finished: 2 documents');

    rerender(
      panel(false, { ...runMeta, rows: [], durationMs: 1, error: { code: 'X', message: 'boom' } }),
    );
    expect(region.textContent).toBe('Run failed');
  });

  it('renders the document count with tabular numerals', () => {
    renderPanel({ lastRun: { ...runMeta, rows: [{ _id: 1 }], durationMs: 1 } });
    expect(screen.getByText('1 docs').style.fontVariantNumeric).toBe('tabular-nums');
  });
});

/**
 * `height` is controlled by the caller (AggregationTab, in the real app).
 * A `vi.fn()` spy on `onHeightChange` can't prove `aria-valuenow` tracks a
 * keyboard resize, so this wrapper feeds it back into real state.
 */
function ControlledOutputPanel() {
  const [height, setHeight] = useState(260);
  return (
    <OutputPanel
      height={height}
      view="Tree"
      lastRun={undefined}
      running={false}
      pipelineName={null}
      onHeightChange={setHeight}
      onHeightCommit={() => {}}
      onViewChange={() => {}}
      onSaveAsCollection={() => {}}
      onSaveAsView={() => {}}
    />
  );
}

describe('OutputPanel resize keyboard support (#56)', () => {
  it('is reachable by Tab alone', async () => {
    const user = userEvent.setup();
    render(<ControlledOutputPanel />);
    const handle = screen.getByRole('separator', { name: 'Resize output panel' });

    await user.tab();

    expect(document.activeElement).toBe(handle);
  });

  it('ArrowUp/ArrowDown resize the panel and keep aria-valuenow and the real height in sync', async () => {
    const user = userEvent.setup();
    render(<ControlledOutputPanel />);
    const handle = screen.getByRole('separator', { name: 'Resize output panel' });
    const panel = handle.parentElement as HTMLElement;
    await user.tab();

    await expectSeparatorResizesPanel(handle, panel, {
      growKey: '{ArrowUp}',
      shrinkKey: '{ArrowDown}',
      afterGrow: '270',
      afterShrink: '250',
    });
  });

  it('Home and End reach the real bounds and stay clamped and focused past them', async () => {
    const user = userEvent.setup();
    render(<ControlledOutputPanel />);
    const handle = screen.getByRole('separator', { name: 'Resize output panel' });
    // Same 0.7-of-viewport ceiling `clampHeight` uses — not hardcoded here,
    // so this doesn't drift if jsdom's default viewport size ever changes.
    const maxHeight = Math.floor(window.innerHeight * 0.7);
    await user.tab();

    await expectSeparatorClampedAtBounds(handle, {
      min: '120',
      max: String(maxHeight),
      shrinkKey: '{ArrowDown}',
      growKey: '{ArrowUp}',
    });
  });

  it('Enter resets to the default height, the keyboard equivalent of the double-click reset', async () => {
    const user = userEvent.setup();
    render(<ControlledOutputPanel />);
    const handle = screen.getByRole('separator', { name: 'Resize output panel' });
    await user.tab();

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(handle.getAttribute('aria-valuenow')).toBe('280');

    await user.keyboard('{Enter}');
    expect(handle.getAttribute('aria-valuenow')).toBe('260');
    expect(document.activeElement).toBe(handle);
  });

  // `aria-valuemax` is metadata, not the clamp itself — `clampHeight` reads
  // `window.innerHeight` fresh on every drag/keypress regardless, so a resize
  // mid-interaction always clamps correctly either way. This only pins that
  // the *displayed* bound doesn't go stale when nothing else re-renders.
  it('updates aria-valuemax when the window resizes while nothing else changes', () => {
    const originalInnerHeight = window.innerHeight;
    try {
      render(<ControlledOutputPanel />);
      const handle = screen.getByRole('separator', { name: 'Resize output panel' });
      const before = handle.getAttribute('aria-valuemax');

      Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true });
      fireEvent(window, new Event('resize'));

      expect(handle.getAttribute('aria-valuemax')).toBe(String(Math.floor(2000 * 0.7)));
      expect(handle.getAttribute('aria-valuemax')).not.toBe(before);
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
    }
  });
});

describe('OutputPanel — Save as view', () => {
  it('is enabled with no output rows and calls onSaveAsView', () => {
    const onSaveAsView = vi.fn();
    renderPanel({ onSaveAsView });

    const button = screen.getByRole('button', { name: /Save as view/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onSaveAsView).toHaveBeenCalledTimes(1);
  });

  it('is disabled while the pipeline runs', () => {
    renderPanel({ running: true });
    expect((screen.getByRole('button', { name: /Save as view/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
