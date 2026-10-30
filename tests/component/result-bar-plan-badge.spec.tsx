import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  renderHook,
  screen,
  fireEvent,
  waitFor,
  emptyWorkspaceActions,
  emptyWorkspaceMeta,
} from '../helpers/render';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { useFindExplain } from '../../src/pages/Workspace/useFindExplain';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
});

const ixscanPlan = {
  queryPlanner: {
    winningPlan: {
      stage: 'FETCH',
      inputStage: { stage: 'IXSCAN', indexName: 'status_1', keyPattern: { status: 1 } },
    },
  },
};
const collscanPlan = { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } };

function makeState(plan: unknown, queryRaw = '{"status":"a"}', sort = ''): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort, limit: '' },
    queryRaw,
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: [{ _id: 1 }], durationMs: 3, ranAt: '2026-01-01T00:00:00.000Z', plan },
  };
}

function renderBar(plan: unknown, queryRaw?: string, sort?: string) {
  const openCreateIndex = vi.fn();
  const explain = vi.fn(async () => ({ plan: collscanPlan, verbosity: 'queryPlanner' }));
  installAtelierMock({ query: { explain } });
  render(
    <CollectionWorkspaceProvider
      state={makeState(plan, queryRaw, sort)}
      actions={emptyWorkspaceActions({ openCreateIndex })}
      meta={emptyWorkspaceMeta()}
    >
      <ResultBar />
    </CollectionWorkspaceProvider>,
  );
  return { explain, openCreateIndex };
}

describe('ResultBar plan badge', () => {
  it('names the index an IXSCAN plan used', () => {
    renderBar(ixscanPlan);
    expect(screen.getByRole('button', { name: 'Query plan: status_1' }).textContent).toContain(
      'status_1',
    );
  });

  it('says "no index" for a COLLSCAN plan', () => {
    renderBar(collscanPlan);
    expect(screen.getByRole('button', { name: 'Query plan: no index' }).textContent).toContain(
      'no index',
    );
  });

  it('shows no badge without a plan or with an unrecognized one', () => {
    renderBar(undefined);
    expect(screen.queryByTestId('plan-badge')).toBeNull();
  });

  it('shows no badge for a plan with neither COLLSCAN nor IXSCAN', () => {
    renderBar({ queryPlanner: { winningPlan: { stage: 'EOF' } } });
    expect(screen.queryByTestId('plan-badge')).toBeNull();
  });

  it('opens the explain drawer on the plan it already holds, without asking the server', async () => {
    const { explain } = renderBar(ixscanPlan);
    fireEvent.click(screen.getByTestId('plan-badge'));

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => expect(dialog.textContent).toContain('status_1'));
    expect(explain).not.toHaveBeenCalled();
  });

  it('marks the badge "(not current)" while the query above is unrunnable', () => {
    renderBar(ixscanPlan, 'not json');
    expect(
      screen.getByRole('button', { name: 'Query plan: status_1 (not current)' }),
    ).toBeTruthy();
  });

  it('truncates a long index name inside the bar and keeps it readable on hover', () => {
    const name = 'a_1_b_1_c_1_d_1_e_1_f_1_g_1_h_1_i_1_j_1_k_1_l_1_m_1';
    renderBar({ queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: name } } });
    const badge = screen.getByTestId('plan-badge');
    expect(badge.getAttribute('title')).toBe(name);
    expect(badge.style.maxWidth).not.toBe('');
    expect(badge.style.textOverflow).toBe('ellipsis');
    expect(badge.style.overflow).toBe('hidden');
  });

  it('opens a stale plan as "(not current)" and offers no index suggestion for it', async () => {
    renderBar(collscanPlan, 'not json');
    fireEvent.click(screen.getByTestId('plan-badge'));

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan (not current)' });
    await waitFor(() => expect(dialog.textContent).toContain('COLLSCAN'));
    expect(screen.queryByTestId('explain-create-index')).toBeNull();
  });

  it('offers the index suggestion for a current COLLSCAN plan', async () => {
    renderBar(collscanPlan);
    fireEvent.click(screen.getByTestId('plan-badge'));

    await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => expect(screen.getByTestId('explain-create-index')).toBeTruthy());
  });

  // The suggestion reads the sort through the same parser as the table
  // header, so every direction the driver runs prefills the index.
  it('prefills the index suggestion from a string sort direction', async () => {
    const { openCreateIndex } = renderBar(collscanPlan, '{"status":"a"}', '{"age":"asc"}');
    fireEvent.click(screen.getByTestId('plan-badge'));
    fireEvent.click(await screen.findByTestId('explain-create-index'));

    expect(openCreateIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: [
          { field: 'status', direction: 1 },
          { field: 'age', direction: 1 },
        ],
      }),
    );
  });

  it('still opens the suggestion when the sort holds a $meta key', async () => {
    const { openCreateIndex } = renderBar(
      collscanPlan,
      '{"status":"a"}',
      '{"score":{"$meta":"textScore"},"age":-1}',
    );
    fireEvent.click(screen.getByTestId('plan-badge'));
    fireEvent.click(await screen.findByTestId('explain-create-index'));

    expect(openCreateIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: [
          { field: 'status', direction: 1 },
          { field: 'age', direction: -1 },
        ],
      }),
    );
  });
});

// W14 §9 — the plan badge's drawer re-asks the server with the tab's current
// options. A half-typed one would come back as a server refusal; the
// builder's own message names what to fix instead.
describe('useFindExplain — the filter it sends', () => {
  const wrap = (state: CollectionTabState) =>
    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <CollectionWorkspaceProvider state={state} actions={emptyWorkspaceActions()} meta={emptyWorkspaceMeta()}>
          {children}
        </CollectionWorkspaceProvider>
      );
    };

  // The plan badge reads the committed `queryRaw`, which the Run gate accepts
  // with NBSP padding; the main process's `JSON.parse` would refuse it.
  it('sends a filter padded with Unicode spaces trimmed', async () => {
    const explain = vi.fn(async () => ({ plan: collscanPlan, verbosity: 'queryPlanner' }));
    installAtelierMock({ query: { explain } });
    const state = makeState(collscanPlan, '\u00a0{"status":"a"}\u00a0');
    const { result } = renderHook(() => useFindExplain(() => state.queryRaw), { wrapper: wrap(state) });

    await result.current.runExplain('queryPlanner');
    expect(explain).toHaveBeenCalledTimes(1);
    expect((explain.mock.calls[0] as unknown[])[0]).toMatchObject({ filter: '{"status":"a"}' });
  });

  it('prefills the index suggestion from a filter padded with Unicode spaces', async () => {
    installAtelierMock({ query: { explain: vi.fn(async () => ({ plan: collscanPlan, verbosity: 'queryPlanner' })) } });
    const openCreateIndex = vi.fn();
    const state = makeState(collscanPlan, '\u00a0{"status":"a"}\u00a0');
    const { result } = renderHook(() => useFindExplain(() => state.queryRaw), {
      wrapper: ({ children }) => (
        <CollectionWorkspaceProvider state={state} actions={emptyWorkspaceActions({ openCreateIndex })} meta={emptyWorkspaceMeta()}>
          {children}
        </CollectionWorkspaceProvider>
      ),
    });

    result.current.onCreateIndex!();
    expect(openCreateIndex).toHaveBeenCalledWith(
      expect.objectContaining({ keys: [{ field: 'status', direction: 1 }] }),
    );
  });

  it('refuses an unrunnable filter with the Run gate\'s reason and asks the server nothing', async () => {
    const explain = vi.fn(async () => ({ plan: collscanPlan, verbosity: 'queryPlanner' }));
    installAtelierMock({ query: { explain } });
    const state = makeState(collscanPlan, '[1]');
    const { result } = renderHook(() => useFindExplain(() => state.queryRaw), { wrapper: wrap(state) });

    await expect(result.current.runExplain('queryPlanner')).rejects.toThrow(
      'A filter must be a document, like { "status": "active" }.',
    );
    expect(explain).not.toHaveBeenCalled();
  });
});

describe('useFindExplain — find options that cannot run', () => {
  it('refuses with the option problem and asks the server nothing', async () => {
    const explain = vi.fn(async () => ({ plan: collscanPlan, verbosity: 'queryPlanner' }));
    installAtelierMock({ query: { explain } });
    const state = makeState(collscanPlan);
    const { result } = renderHook(() => useFindExplain(() => state.queryRaw), {
      wrapper: ({ children }) => (
        <CollectionWorkspaceProvider
          state={{ ...state, builder: { ...state.builder, collation: '{"locale":' } }}
          actions={emptyWorkspaceActions()}
          meta={emptyWorkspaceMeta()}
        >
          {children}
        </CollectionWorkspaceProvider>
      ),
    });

    await expect(result.current.runExplain('queryPlanner')).rejects.toThrow(/^Can't parse this collation/);
    expect(explain).not.toHaveBeenCalled();
  });
});
