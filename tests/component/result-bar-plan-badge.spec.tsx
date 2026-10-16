import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  emptyWorkspaceActions,
  emptyWorkspaceMeta,
} from '../helpers/render';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
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

function makeState(plan: unknown, queryRaw = '{"status":"a"}'): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw,
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: [{ _id: 1 }], durationMs: 3, ranAt: '2026-01-01T00:00:00.000Z', plan },
  };
}

function renderBar(plan: unknown, queryRaw?: string) {
  const explain = vi.fn(async () => ({ plan: collscanPlan, verbosity: 'queryPlanner' }));
  installAtelierMock({ query: { explain } });
  render(
    <CollectionWorkspaceProvider
      state={makeState(plan, queryRaw)}
      actions={emptyWorkspaceActions()}
      meta={emptyWorkspaceMeta()}
    >
      <ResultBar />
    </CollectionWorkspaceProvider>,
  );
  return { explain };
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
});
