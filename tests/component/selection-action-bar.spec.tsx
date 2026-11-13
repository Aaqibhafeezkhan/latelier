import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { ResultViewer } from '../../src/pages/Workspace/ResultViewer';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState } from '@shared/types';

let originalClipboard: Clipboard | undefined;
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  originalClipboard = navigator.clipboard;
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});

const DOCS = [
  { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' },
  { _id: { $oid: '507f1f77bcf86cd799439012' }, name: 'beta' },
];

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'JSON',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: {
      documents: DOCS,
      durationMs: 5,
      ranAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

const makeMeta = emptyWorkspaceMeta;

function renderBar(
  onDeleteSelected: (docs: unknown[]) => void,
  metaOverrides: Partial<CollectionWorkspaceMeta> = {},
) {
  return render(
    <CollectionWorkspaceProvider
      state={makeState()}
      actions={emptyWorkspaceActions()}
      meta={makeMeta(metaOverrides)}
    >
      <ResultViewer>
        <ResultViewer.SelectionBar onDeleteSelected={onDeleteSelected} />
        <ResultViewer.Json />
      </ResultViewer>
    </CollectionWorkspaceProvider>,
  );
}

function selectFirstCard() {
  // A plain click on the card no longer selects it — the visible checkbox
  // (or ⌘/Ctrl+click) is the way in now.
  fireEvent.click(screen.getByRole('button', { name: 'Select document 99439011' }));
}

describe('SelectionActionBar', () => {
  it('AC1 — renders nothing when no rows are selected', () => {
    const { container } = renderBar(vi.fn());
    expect(container.textContent).not.toContain('selected');
  });

  // #106 — jsdom has no layout, so this can't measure the rendered height;
  // it guards that the strip stays mounted and keeps the same fixed inline
  // height in both states. The e2e measures the real grid position.
  it('#106 — the strip stays mounted at the same fixed height, with or without a selection', () => {
    const { container } = renderBar(vi.fn());
    const strip = () => container.querySelector<HTMLElement>('[data-testid="selection-bar"]')!;
    expect(strip()).not.toBeNull();
    expect(container.querySelector('[data-testid="selection-bar-count"]')).toBeNull();
    expect(strip().style.height).toBe('31px');
    expect(strip().style.boxSizing).toBe('border-box');
    selectFirstCard();
    expect(container.querySelector('[data-testid="selection-bar-count"]')).not.toBeNull();
    expect(strip().style.height).toBe('31px');
    expect(strip().style.boxSizing).toBe('border-box');
  });

  it('with nothing else to say, the band holds a one-line hint naming how to select', () => {
    const { container } = renderBar(vi.fn());
    const hint = () => container.querySelector<HTMLElement>('[data-testid="band-hint"]');
    expect(hint()?.textContent).toBe(
      'Select rows with the checkbox or ⌘/Ctrl-click to copy or delete them',
    );
    selectFirstCard();
    expect(hint()).toBeNull();
  });

  it('shows no hint when there are no rows to select (empty, never-run)', () => {
    const empty = render(
      <CollectionWorkspaceProvider
        state={makeState({ lastRun: { documents: [], durationMs: 1, ranAt: new Date().toISOString() } })}
        actions={emptyWorkspaceActions()}
        meta={makeMeta()}
      >
        <ResultViewer>
          <ResultViewer.SelectionBar onDeleteSelected={vi.fn()} />
          <ResultViewer.Json />
        </ResultViewer>
      </CollectionWorkspaceProvider>,
    );
    expect(empty.container.querySelector('[data-testid="band-hint"]')).toBeNull();
    expect(empty.container.querySelector('[data-testid="selection-bar"]')).not.toBeNull();
    empty.unmount();

    const neverRun = render(
      <CollectionWorkspaceProvider
        state={makeState({ lastRun: undefined })}
        actions={emptyWorkspaceActions()}
        meta={makeMeta()}
      >
        <ResultViewer>
          <ResultViewer.SelectionBar onDeleteSelected={vi.fn()} />
          <ResultViewer.Json />
        </ResultViewer>
      </CollectionWorkspaceProvider>,
    );
    expect(neverRun.container.querySelector('[data-testid="band-hint"]')).toBeNull();
  });

  it('the hint stays on one line inside the fixed band', () => {
    const { container } = renderBar(vi.fn());
    const hint = container.querySelector<HTMLElement>('[data-testid="band-hint"]')!;
    expect(hint.style.whiteSpace).toBe('nowrap');
    expect(hint.style.overflow).toBe('hidden');
    expect(hint.style.textOverflow).toBe('ellipsis');
    expect(hint.style.minWidth).toBe('0px');
  });

  it('the hint gives way to Running… and keeps the band height', () => {
    const { container } = renderBar(vi.fn(), { isLoading: true });
    expect(container.querySelector('[data-testid="band-hint"]')).toBeNull();
    expect(container.textContent).toContain('Running…');
    expect(container.querySelector<HTMLElement>('[data-testid="selection-bar"]')!.style.height).toBe('31px');
  });

  it('on a view the hint does not offer delete', () => {
    const { container } = renderBar(vi.fn(), { isView: true });
    expect(container.querySelector('[data-testid="band-hint"]')?.textContent).toBe(
      'Select rows with the checkbox or ⌘/Ctrl-click to copy them',
    );
  });

  it('#106 — read-only still renders nothing at all, strip included', () => {
    const { container } = renderBar(vi.fn(), { isReadOnly: true });
    expect(container.querySelector('[data-testid="selection-bar"]')).toBeNull();
  });

  it('AC2 — shows the selection count once a row is selected', () => {
    const { container } = renderBar(vi.fn());
    selectFirstCard();
    expect(container.textContent).toContain('1 selected');
  });

  it('AC3 — Copy writes the selected doc to the clipboard as canonical EJSON', async () => {
    const { container } = renderBar(vi.fn());
    selectFirstCard();
    fireEvent.click(container.querySelector('[data-testid="selection-bar-copy"]')!);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0]![0] as string;
    expect(JSON.parse(written)).toEqual(DOCS[0]);
  });

  it('AC4 — Delete calls onDeleteSelected with the selected docs', () => {
    const onDeleteSelected = vi.fn();
    const { container } = renderBar(onDeleteSelected);
    selectFirstCard();
    fireEvent.click(container.querySelector('[data-testid="selection-bar-delete"]')!);
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
    expect(onDeleteSelected).toHaveBeenCalledWith([DOCS[0]]);
  });

  it('AC7 — never renders for a read-only (isReadOnly) consumer, even with a selection', () => {
    const { container } = renderBar(vi.fn(), { isReadOnly: true });
    selectFirstCard();
    expect(container.textContent).not.toContain('selected');
  });

  it('disables Delete when no selected doc has an _id (would otherwise risk a full-collection delete)', () => {
    const onDeleteSelected = vi.fn();
    const state = makeState({
      lastRun: {
        documents: [{ name: 'no-id-doc' }],
        durationMs: 1,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = render(
      <CollectionWorkspaceProvider state={state} actions={emptyWorkspaceActions()} meta={makeMeta()}>
        <ResultViewer>
          <ResultViewer.SelectionBar onDeleteSelected={onDeleteSelected} />
          <ResultViewer.Json />
        </ResultViewer>
      </CollectionWorkspaceProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select document (no _id)' }));
    const deleteButton = container.querySelector(
      '[data-testid="selection-bar-delete"]',
    ) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(deleteButton);
    expect(onDeleteSelected).not.toHaveBeenCalled();
  });
});
