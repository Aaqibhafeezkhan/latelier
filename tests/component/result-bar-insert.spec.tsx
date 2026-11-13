import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState } from '@shared/types';

function makeState(): CollectionTabState {
  return {
    view: 'Tree',
    builder: {
      projection: [],
      sort: '',
      limit: '',
    },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: {
      documents: [{}],
      durationMs: 5,
      ranAt: new Date().toISOString(),
    },
  };
}

function renderBar(
  metaOverrides: Partial<CollectionWorkspaceMeta> = {},
  references?: { count: number; onOpen: () => void },
) {
  const actions = emptyWorkspaceActions();
  const meta = emptyWorkspaceMeta(metaOverrides);
  render(
    <CollectionWorkspaceProvider state={makeState()} actions={actions} meta={meta}>
      <ResultBar references={references} />
    </CollectionWorkspaceProvider>,
  );
  return { actions };
}

// Insert moved here from the header (six-chrome-strips cleanup) — it needs
// to keep the primary-action wiring (`actions.openInsert`) and the
// aria-label existing e2e selectors match on (`/Insert document/`).
describe('ResultBar — Insert', () => {
  it('calls actions.openInsert() when clicked (writable provider)', () => {
    const { actions } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));
    expect(actions.openInsert).toHaveBeenCalledTimes(1);
  });

  it('is not offered in a read-only provider', () => {
    renderBar({ isReadOnly: true });
    expect(screen.queryByRole('button', { name: 'Insert document' })).toBeNull();
  });
});

// References sits beside Fields: both shape how this collection's documents read.
describe('ResultBar — References', () => {
  it('shows the rule count and opens the editor', () => {
    const onOpen = vi.fn();
    renderBar({}, { count: 3, onOpen });
    fireEvent.click(screen.getByRole('button', { name: 'References (3)' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is absent where no references prop is passed (previews)', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: /References/ })).toBeNull();
  });
});
