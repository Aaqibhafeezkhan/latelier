import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ResultViewer } from '../../src/pages/Workspace/ResultViewer';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState } from '@shared/types';

const noop = () => {};

// jsdom doesn't implement clipboard by default; some view children
// (TableView, JsonView) install clipboard handlers — stub so the tests
// don't trip over an undefined navigator.clipboard.
let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});
afterEach(() => {
  uninstallAtelierMock();
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    ...overrides,
  };
}

const makeMeta = emptyWorkspaceMeta;

function renderViewer(
  state: CollectionTabState,
  meta: Partial<CollectionWorkspaceMeta> = {},
  children: React.ReactNode,
) {
  return render(
      <CollectionWorkspaceProvider
        state={state}
        actions={emptyWorkspaceActions()}
        meta={makeMeta(meta)}
      >
        {children}
      </CollectionWorkspaceProvider>
  );
}

describe('ResultViewer compound', () => {
  it('Body shows the empty-collection CTA when the committed filter is {} on page 0', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{}',
      page: 0,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('This collection is empty');
    expect(screen.getByRole('button', { name: /import documents/i })).toBeTruthy();
  });

  it('keeps the import dialog open when the import refresh fills the empty collection', () => {
    const empty = makeState({
      queryRaw: '{}',
      page: 0,
      lastRun: { documents: [], durationMs: 0, ranAt: new Date().toISOString() },
    });
    const body = (
      <ResultViewer>
        <ResultViewer.Body onClearFilter={noop} onColumnResize={noop} onRowExpand={noop} />
      </ResultViewer>
    );
    const { rerender } = renderViewer(empty, {}, body);
    fireEvent.click(screen.getByRole('button', { name: /import documents/i }));
    expect(screen.getByRole('dialog', { name: /import into/i })).toBeTruthy();

    // The import's own refresh lands rows, which unmounts the empty state.
    rerender(
      <CollectionWorkspaceProvider
        state={makeState({
          queryRaw: '{}',
          page: 0,
          lastRun: { documents: [{ _id: 1 }], durationMs: 0, ranAt: new Date().toISOString() },
        })}
        actions={emptyWorkspaceActions()}
        meta={makeMeta({})}
      >
        {body}
      </CollectionWorkspaceProvider>,
    );
    expect(screen.queryByText('This collection is empty')).toBeNull();
    expect(screen.getByRole('dialog', { name: /import into/i })).toBeTruthy();
  });

  // The failure carries no report, so the result list is re-run from the
  // partial-import callback instead of `onImported`.
  it('re-runs the query when the empty-state import fails after some documents landed', async () => {
    installAtelierMock({
      app: { pickFile: async () => ({ path: '/home/me/people.jsonl' }) } as never,
      data: {
        import: async () => {
          throw { code: 'MONGO_OP', message: 'batch 3 failed', details: { insertedCount: 2400 } };
        },
      },
    });
    const actions = emptyWorkspaceActions();
    render(
      <CollectionWorkspaceProvider
        state={makeState({
          queryRaw: '{}',
          page: 0,
          lastRun: { documents: [], durationMs: 0, ranAt: new Date().toISOString() },
        })}
        actions={actions}
        meta={makeMeta({})}
      >
        <ResultViewer>
          <ResultViewer.Body onClearFilter={noop} onColumnResize={noop} onRowExpand={noop} />
        </ResultViewer>
      </CollectionWorkspaceProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /import documents/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/batch 3 failed/);
    expect(actions.run).toHaveBeenCalledTimes(1);
  });

  it('Body hides the import CTA for a read-only consumer, but still shows the empty-collection message', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{}',
      page: 0,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      { isReadOnly: true },
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('This collection is empty');
    expect(screen.queryByRole('button', { name: /import documents/i })).toBeNull();
  });

  it('Body says to run the query when the tab has never run, with no Clear-filter button', () => {
    const { container } = renderViewer(
      makeState({ queryRaw: '{"a":1}', page: 0 }),
      {},
      <ResultViewer>
        <ResultViewer.Body onClearFilter={noop} onColumnResize={noop} onRowExpand={noop} />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('Run the query to see results');
    expect(container.textContent).not.toContain('No matching documents');
    expect(container.textContent).not.toContain('This collection is empty');
    expect(screen.queryByRole('button', { name: /clear filter/i })).toBeNull();
  });

  it('Body renders "No matching documents" for an empty result behind a non-default filter', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{ "status": "archived" }',
      page: 0,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const onClearFilter = vi.fn();
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={onClearFilter}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('No matching documents');
    expect(container.textContent).toContain('Clear filter');
    fireEvent.click(screen.getByRole('button', { name: /clear filter/i }));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('Body renders "No matching documents" for an empty result on a later page of an unfiltered query', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{}',
      page: 1,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('No matching documents');
  });

  it('Body switches to the Table slot when state.view is "Table"', () => {
    const state = makeState({
      view: 'Table',
      lastRun: {
        documents: [{ _id: 1, name: 'alpha' }],
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    // Table-specific markers: column header testid + cell value
    expect(container.querySelector('[data-testid="table-header-name"]')).toBeTruthy();
    expect(container.textContent).toContain('alpha');
  });

  it('Body switches to the Json slot when state.view is "JSON"', () => {
    const state = makeState({
      view: 'JSON',
      lastRun: {
        documents: [{ _id: 1, name: 'alpha' }],
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    // JsonView pretty-prints with two-space indents — look for indented key
    // and the EJSON-aware output (no $oid here because _id is a plain number).
    expect(container.textContent).toContain('"name"');
    expect(container.textContent).toContain('alpha');
  });

  function renderLoadingBody(state: CollectionTabState) {
    return renderViewer(
      state,
      { isLoading: true },
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
  }

  it('a first load with no rows yet shows skeleton rows in a status region, not the body', () => {
    const { container } = renderLoadingBody(makeState({ view: 'Tree' }));
    const status = screen.getByRole('status', { name: 'Loading results' });
    expect(status.querySelectorAll('.mantine-Skeleton-root')).toHaveLength(8);
    // One live region at a time: no "Loading…" strip on top of the skeleton.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.textContent).not.toContain('Loading…');
  });

  it.each([
    ['an empty result', { documents: [] as unknown[] }],
    ['an errored result', { documents: [] as unknown[], error: { code: 'MONGO_ERROR', message: 'boom' } }],
  ])('a re-run after %s shows the Loading strip, not the first-load skeleton', (_label, run) => {
    renderLoadingBody(
      makeState({
        view: 'Tree',
        lastRun: { ...run, durationMs: 0, ranAt: new Date().toISOString() } as CollectionTabState['lastRun'],
      }),
    );
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(screen.queryByRole('status', { name: 'Loading results' })).toBeNull();
  });

  it('a re-run keeps the existing rows under the Loading strip, with no skeleton', () => {
    const { container } = renderLoadingBody(
      makeState({
        view: 'JSON',
        lastRun: { documents: [{ _id: 1, name: 'alpha' }], durationMs: 0, ranAt: new Date().toISOString() },
      }),
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading…');
    expect(screen.queryByRole('status', { name: 'Loading results' })).toBeNull();
    expect(container.textContent).toContain('alpha');
  });

  it('Pagination slot renders ResultBar against the same provider', () => {
    const state = makeState({
      view: 'Tree',
      page: 0,
      pageSize: 10,
      totalCount: 100,
      lastRunHasMore: true,
      lastRun: {
        documents: new Array(10).fill({}),
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Pagination />
      </ResultViewer>,
    );
    // 100 / 10 = 10 pages — pager shows "1 / 10"
    expect(container.textContent).toContain('1 / 10');
  });

  it('individual Tree slot can be used without Body for custom composition', () => {
    const state = makeState({
      view: 'Tree',
      lastRun: {
        documents: [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }],
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Tree onRowExpand={noop} />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('99439011');
    expect(container.textContent).toContain('alpha');
  });
});
