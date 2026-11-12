import { afterEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.fn<(opts: { title: string; body: string; confirmLabel: string }) => Promise<boolean>>();
const notifyError = vi.fn();
vi.mock('../../src/utils/confirm', () => ({ confirmDestructive: (opts: never) => confirm(opts) }));
vi.mock('../../src/theme/notifications', () => ({ notify: { error: (...a: unknown[]) => notifyError(...a) } }));

const { closeTabGuarded } = await import('../../src/pages/Workspace/tabActions');
const { confirmDeleteSaved, openSavedPipeline, renameOpenPipelines } = await import('../../src/pages/Workspace/savedActions');

afterEach(() => vi.clearAllMocks());

const tab = (id: string, kind: 'collection' | 'script', dirty: boolean) =>
  ({ id, kind, state: kind === 'collection' ? { aggregation: { dirty } } : {} }) as never;

describe('closeTabGuarded', () => {
  function tabsWith(...tabs: never[]) {
    const close = vi.fn(async () => {});
    return { tabs: { tabs, close }, close };
  }

  it('closes a clean tab, a script tab or an unknown id without asking', async () => {
    const { tabs, close } = tabsWith(tab('a', 'collection', false), tab('s', 'script', true));
    await closeTabGuarded(tabs, 'a');
    await closeTabGuarded(tabs, 's');
    await closeTabGuarded(tabs, 'gone');
    expect(confirm).not.toHaveBeenCalled();
    expect(close.mock.calls).toEqual([['a'], ['s'], ['gone']]);
  });

  it('asks only about the tab being closed, and not about one with no pipeline yet', async () => {
    const { tabs, close } = tabsWith(tab('d', 'collection', true), tab('c', 'collection', false), {
      id: 'n',
      kind: 'collection',
      state: {},
    } as never);
    await closeTabGuarded(tabs, 'c');
    await closeTabGuarded(tabs, 'n');
    expect(confirm).not.toHaveBeenCalled();
    expect(close.mock.calls).toEqual([['c'], ['n']]);
  });

  it('asks before closing a tab with unsaved pipeline edits, and keeps it on Cancel', async () => {
    const { tabs, close } = tabsWith(tab('d', 'collection', true));
    confirm.mockResolvedValueOnce(false);
    await closeTabGuarded(tabs, 'd');
    expect(confirm).toHaveBeenCalledWith({
      title: 'Discard unsaved pipeline changes?',
      body: 'This tab has pipeline edits that have not been saved. Closing it discards them.',
      confirmLabel: 'Discard and close',
    });
    expect(close).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    await closeTabGuarded(tabs, 'd');
    expect(close).toHaveBeenCalledWith('d');
  });
});

describe('savedActions', () => {
  const saved = { id: 'q2', name: 'Orders by region', connectionId: 'c1', dbName: 'shop', collection: 'orders' };

  it('asks the saved list’s delete question', async () => {
    confirm.mockResolvedValueOnce(true);
    await expect(confirmDeleteSaved({ name: 'x' })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith({
      title: 'Delete "x"?',
      body: 'This removes the saved query. This action cannot be undone.',
      confirmLabel: 'Delete',
    });
  });

  it('opens a saved pipeline on its collection by id and name', async () => {
    const openAggregation = vi.fn(async () => ({ id: 't1' }) as never);
    await expect(openSavedPipeline({ openAggregation }, saved)).resolves.toEqual({ id: 't1' });
    expect(openAggregation).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      savedId: 'q2',
      name: 'Orders by region',
    });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('says a deleted pipeline no longer exists, and any other failure as it is', async () => {
    const fail = (e: unknown) => ({ openAggregation: vi.fn(async () => Promise.reject(e)) });
    await expect(openSavedPipeline(fail({ code: 'NOT_FOUND', message: 'row q2' }), saved)).resolves.toBeNull();
    expect(notifyError).toHaveBeenLastCalledWith('It no longer exists.', { title: 'Could not open “Orders by region”' });
    await openSavedPipeline(fail({ code: 'INTERNAL', message: 'boom' }), saved);
    expect(notifyError).toHaveBeenLastCalledWith('boom', { title: 'Could not open “Orders by region”' });
    await openSavedPipeline(fail('plain'), saved);
    expect(notifyError).toHaveBeenLastCalledWith('plain', { title: 'Could not open “Orders by region”' });
  });
});

describe('renameOpenPipelines', () => {
  it('renames only the pipeline tabs of that saved pipeline', () => {
    const patchAggregationState = vi.fn();
    const tabs = [
      { id: 'a', kind: 'collection', state: { aggregation: { savedId: 's1' } } },
      { id: 'b', kind: 'collection', state: { aggregation: { savedId: 's2' } } },
      { id: 'c', kind: 'collection', state: {} },
      { id: 'd', kind: 'script', state: {} },
      { id: 'e', kind: 'collection', state: { aggregation: { savedId: 's1' } } },
    ] as never;
    renameOpenPipelines({ tabs, patchAggregationState }, 's1', 'Totals');
    expect(patchAggregationState.mock.calls).toEqual([
      ['a', { name: 'Totals' }],
      ['e', { name: 'Totals' }],
    ]);
  });
});
