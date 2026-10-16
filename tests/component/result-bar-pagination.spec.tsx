import { describe, it, expect, vi, afterEach } from 'vitest';
import { notifications } from '@mantine/notifications';
import { render, screen, fireEvent, waitFor, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionTabState } from '@shared/types';

interface BarStateOverride {
  limit?: string;
  page?: number;
  pageSize?: number;
  docCount?: number | null;
  durationMs?: number | null;
  totalCount?: number | undefined;
  hasMore?: boolean | undefined;
  isLoading?: boolean;
}

function makeState(o: BarStateOverride): CollectionTabState {
  const docCount = o.docCount ?? null;
  const documents = docCount !== null ? new Array(docCount).fill({}) : [];
  return {
    view: 'Tree',
    builder: {
      projection: [],
      sort: '',
      limit: o.limit ?? '',
    },
    queryRaw: '{}',
    page: o.page ?? 0,
    pageSize: o.pageSize ?? 50,
    activeBuilderTab: 'Builder',
    totalCount: o.totalCount,
    lastRunHasMore: o.hasMore,
    lastRun:
      docCount !== null
        ? {
            documents,
            durationMs: o.durationMs ?? 5,
            ranAt: new Date().toISOString(),
          }
        : undefined,
  };
}

function renderBar(overrides: BarStateOverride = {}) {
  const actions = emptyWorkspaceActions();
  const meta = emptyWorkspaceMeta({ isLoading: overrides.isLoading ?? false });
  render(
      <CollectionWorkspaceProvider
        state={makeState(overrides)}
        actions={actions}
        meta={meta}
      >
        <ResultBar />
      </CollectionWorkspaceProvider>
  );
  return { actions };
}

describe('ResultBar - pagination canNext', () => {
  it('disables Next on the last page when totalPages is known, even if hasMore=true', () => {
    // Reproduces the bug: a find whose last page is exactly full reports
    // hasMore=true from the server (docs.length === limit), but totalPages
    // from count() says we're on the last page. Next must reflect
    // totalPages, not the stale hasMore.
    renderBar({
      // 26 pages * 50 = 1300 total, page index 25 is the last.
      page: 25,
      pageSize: 50,
      totalCount: 1300,
      hasMore: true,
      docCount: 50,
      durationMs: 5,
    });
    const nextBtn = screen.getByLabelText('Next page') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);

    const lastBtn = screen.getByLabelText('Last page') as HTMLButtonElement;
    expect(lastBtn.disabled).toBe(true);
  });

  it('enables Next when page < totalPages - 1', () => {
    const { actions } = renderBar({
      page: 10,
      pageSize: 50,
      totalCount: 1300,
      hasMore: true,
      docCount: 50,
      durationMs: 5,
    });
    const nextBtn = screen.getByLabelText('Next page') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
    fireEvent.click(nextBtn);
    expect(actions.patch).toHaveBeenCalledWith({ page: 11 });
    expect(actions.run).toHaveBeenCalledWith({ page: 11 });
  });

  it('falls back to hasMore while totalCount is still in flight', () => {
    renderBar({
      page: 0,
      pageSize: 50,
      totalCount: undefined,
      hasMore: true,
      docCount: 50,
      durationMs: 5,
    });
    const nextBtn = screen.getByLabelText('Next page') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
  });

  it('disables Next when totalCount is in flight and hasMore is false', () => {
    renderBar({
      page: 0,
      pageSize: 50,
      totalCount: undefined,
      hasMore: false,
      docCount: 1,
      durationMs: 5,
    });
    const nextBtn = screen.getByLabelText('Next page') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it('Last page button jumps to the final page', () => {
    const { actions } = renderBar({
      page: 0,
      pageSize: 50,
      totalCount: 1300, // 26 pages → last index is 25
      hasMore: true,
      docCount: 50,
      durationMs: 5,
    });
    const lastBtn = screen.getByLabelText('Last page') as HTMLButtonElement;
    expect(lastBtn.disabled).toBe(false);
    fireEvent.click(lastBtn);
    expect(actions.patch).toHaveBeenCalledWith({ page: 25 });
    expect(actions.run).toHaveBeenCalledWith({ page: 25 });
  });

  it('First page button jumps to page 0', () => {
    const { actions } = renderBar({
      page: 25,
      pageSize: 50,
      totalCount: 1300,
      hasMore: true,
      docCount: 50,
      durationMs: 5,
    });
    const firstBtn = screen.getByLabelText('First page') as HTMLButtonElement;
    expect(firstBtn.disabled).toBe(false);
    fireEvent.click(firstBtn);
    expect(actions.patch).toHaveBeenCalledWith({ page: 0 });
    expect(actions.run).toHaveBeenCalledWith({ page: 0 });
  });
});

describe('ResultBar - page size selector (T0.5 / W07)', () => {
  function openAndPick(nextValue: string) {
    const input = screen.getByRole('combobox', { name: 'Rows per page' });
    fireEvent.click(input);
    const option = screen.getByRole('option', { name: nextValue });
    fireEvent.click(option);
  }

  it('defaults to 50 on a fresh tab and exposes a labeled control', () => {
    renderBar({ page: 0, pageSize: 50 });
    const input = screen.getByRole('combobox', { name: 'Rows per page' }) as HTMLInputElement;
    expect(input.value).toBe('50');
  });

  it('offers exactly the spec-defined option set {10,25,50,100,250,500}', () => {
    renderBar({ page: 0, pageSize: 50 });
    const input = screen.getByRole('combobox', { name: 'Rows per page' });
    fireEvent.click(input);
    for (const n of [10, 25, 50, 100, 250, 500]) {
      expect(screen.getByRole('option', { name: String(n) })).toBeTruthy();
    }
  });

  it('changing size resets page to 0 and re-runs with the new numeric limit', () => {
    const { actions } = renderBar({
      page: 3,
      pageSize: 50,
      totalCount: 1300,
      hasMore: true,
      docCount: 50,
      durationMs: 5,
    });
    openAndPick('100');
    expect(actions.patch).toHaveBeenCalledWith({ pageSize: 100, page: 0 });
    expect(actions.run).toHaveBeenCalledWith({ pageSize: 100, page: 0 });
    // Must be a real number, never a laundered string, on both calls.
    const patchArg = (actions.patch as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(typeof patchArg.pageSize).toBe('number');
  });

  it('persists the chosen size as the sticky global default via api.prefs.set', async () => {
    const setSpy = vi.fn<(key: string, value: unknown) => void>();
    // `prefs.set` is generic; a vitest Mock erases the type parameter, so the
    // spy is wrapped by a delegating arrow that keeps the real signature.
    const set = async <T,>(key: string, value: T) => { setSpy(key, value); return value; };
    installAtelierMock({ prefs: { set } });
    renderBar({ page: 0, pageSize: 50 });
    openAndPick('250');
    await Promise.resolve();
    expect(setSpy).toHaveBeenCalledWith('ui.workspace.defaultPageSize', 250);
  });

  it('re-selecting the current page size is a no-op: no patch, no run, no prefs write', async () => {
    const setSpy = vi.fn<(key: string, value: unknown) => void>();
    // `prefs.set` is generic; a vitest Mock erases the type parameter, so the
    // spy is wrapped by a delegating arrow that keeps the real signature.
    const set = async <T,>(key: string, value: T) => { setSpy(key, value); return value; };
    installAtelierMock({ prefs: { set } });
    const { actions } = renderBar({ page: 3, pageSize: 50 });
    openAndPick('50');
    await Promise.resolve();
    expect(actions.patch).not.toHaveBeenCalled();
    expect(actions.run).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('ResultBar - a page size that could not be remembered says so', () => {
  afterEach(() => {
    uninstallAtelierMock();
    notifications.clean();
  });

  it('toasts once when persisting the sticky default fails, and still applies the size', async () => {
    const set = async () => {
      throw { code: 'SYSTEM_ERROR', message: 'disk full' };
    };
    installAtelierMock({ prefs: { set: set as never } });
    const { actions } = renderBar({ page: 0, pageSize: 50 });

    fireEvent.click(screen.getByRole('combobox', { name: 'Rows per page' }));
    fireEvent.click(screen.getByRole('option', { name: '100' }));

    expect(actions.run).toHaveBeenCalledWith({ pageSize: 100, page: 0 });
    await waitFor(() => expect(screen.getAllByText('Could not save the rows-per-page default')).toHaveLength(1));
  });
});

describe('ResultBar - the limit that caps the results is visible beside the count', () => {
  const chip = () => screen.queryByTestId('result-limit-cap');

  it('shows "limit N" with its explanation when a limit is set', () => {
    renderBar({ limit: '10', docCount: 10 });
    expect(chip()?.textContent).toBe('limit 10');
    expect(chip()?.getAttribute('title')).toContain('all pages');
  });

  it('shows nothing for a blank limit, or one that is coerced to no limit', () => {
    renderBar({ limit: '', docCount: 10 });
    expect(chip()).toBeNull();
  });

  it('shows nothing for a limit that is not a number', () => {
    renderBar({ limit: 'abc', docCount: 10 });
    expect(chip()).toBeNull();
  });
});
