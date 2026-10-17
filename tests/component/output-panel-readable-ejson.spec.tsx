// UX review §4.1 — the aggregation output renders like every other
// result surface.
//
// The review's wording is the acceptance criterion: "the stage preview and the
// output tree show `n: {"$numberInt":"102"}`, where the Documents view shows
// `102`. The two result displays must use the same renderer."
//
// Nothing in the suite caught the difference before this file, which is how
// the two surfaces drifted in the first place.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen } from '../helpers/render';
import { Int32, Long, Decimal128 } from 'bson';
import { OutputPanel } from '../../src/pages/Workspace/Aggregation/OutputPanel';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ejsonParse, ejsonStringify } from '../../src/utils/ejson';
import { notifications } from '@mantine/notifications';
import type { AggregationLastRun, ResultViewMode } from '@shared/types';

let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  installAtelierMock();
  originalClipboard = navigator.clipboard;
});
afterEach(() => {
  notifications.clean();
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const runMeta = { ranAt: '2026-08-09T12:00:00.000Z', stageCounts: {}, stageSamples: {} };

function renderPanel(rows: unknown[], view: ResultViewMode = 'JSON') {
  const lastRun: AggregationLastRun = { ...runMeta, rows, durationMs: 5 };
  return render(
    <OutputPanel
      height={260}
      view={view}
      lastRun={lastRun}
      running={false}
      pipelineName={null}
      onHeightChange={vi.fn()}
      onHeightCommit={vi.fn()}
      onViewChange={vi.fn()}
      onSaveAsCollection={vi.fn()}
      onSaveAsView={vi.fn()}
    />,
  );
}

describe('OutputPanel — readable EJSON', () => {
  it('shows a count as a number, the way the Documents view already did', () => {
    const { container } = renderPanel([{ _id: 'a', n: new Int32(102) }]);

    expect(container.textContent).toContain('"n": 102');
    expect(container.textContent).not.toContain('$numberInt');
  });

  it('shows a date as an ISO string in the JSON view', () => {
    const { container } = renderPanel([{ at: new Date('2025-01-31T00:48:48.524Z') }]);

    expect(container.textContent).toContain('2025-01-31T00:48:48.524Z');
    expect(container.textContent).not.toContain('1738284528524');
  });

  it('does the same in the Tree view', () => {
    const { container } = renderPanel([{ n: new Int32(102) }], 'Tree');

    expect(container.textContent).toContain('102');
    expect(container.textContent).not.toContain('$numberInt');
  });

  it('does the same in the Table view', () => {
    const { container } = renderPanel([{ n: new Int32(102) }], 'Table');

    expect(container.textContent).not.toContain('$numberInt');
  });

  it('keeps an int64 wrapped, because this output gets copied', () => {
    // The reason the renderer is a lossless subset rather than bson's relaxed
    // mode. A user copies a result and pastes it into a filter; relaxed mode
    // would hand them 9007199254740992.
    const { container } = renderPanel([{ big: Long.fromString('9007199254740993') }]);

    expect(container.textContent).toContain('9007199254740993');
    expect(container.textContent).not.toContain('9007199254740992');
  });

  it('copies text that means exactly what the server returned', async () => {
    const rows = [
      { n: new Int32(102), big: Long.fromString('9007199254740993'), price: Decimal128.fromString('19.99'), at: new Date('2025-01-31T00:48:48.524Z') },
    ];
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel(rows);

    fireEvent.click(screen.getByText('Copy').closest('button')!);

    await screen.findByText(/Output copied to the clipboard/);
    const copied = writeText.mock.calls[0]![0];

    // Two assertions, and the first one is why: re-canonicalizing both sides
    // is true of the *canonical* rendering too, so on its own it cannot tell
    // the two apart and the copy path would sit uncovered.
    expect(copied).toContain('"n": 102');
    expect(copied).not.toContain('$numberInt');
    expect(copied).toContain('9007199254740993');
    // …and it still has to mean the same documents.
    expect(ejsonStringify(ejsonParse(copied))).toBe(ejsonStringify(rows));
  });

  it('downloads the same readable text it shows', async () => {
    const rows = [{ n: new Int32(102), big: Long.fromString('9007199254740993') }];
    const saveFile = vi.fn<(input: { defaultName: string; content: string }) => Promise<{ path: string }>>(
      async () => ({ path: '/tmp/out.json' }),
    );
    installAtelierMock({ app: { saveFile } as never });
    renderPanel(rows);

    fireEvent.click(screen.getByText('⇩').closest('button')!);

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());
    const { content } = saveFile.mock.calls[0]![0];
    expect(content).toContain('"n": 102');
    expect(content).not.toContain('$numberInt');
    expect(ejsonStringify(ejsonParse(content))).toBe(ejsonStringify(rows));
  });
});
