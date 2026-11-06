import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  emptyWorkspaceActions,
  emptyWorkspaceMeta,
} from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { ResultViewer } from '../../src/pages/Workspace/ResultViewer';
import { TreeView } from '../../src/pages/Workspace/views/TreeView';
import { JsonView } from '../../src/pages/Workspace/views/JsonView';
import { TableView } from '../../src/pages/Workspace/views/TableView';
import { ViewDocumentDialog } from '../../src/pages/Workspace/ViewDocumentDialog';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import { useDocumentDialogs } from '../../src/pages/Workspace/useDocumentDialogs';
import type { CollectionTab, CollectionTabState } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
});

const DOCS = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, status: 'open', total: 3 }];

function makeState(view: CollectionTabState['view']): CollectionTabState {
  return {
    view,
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: DOCS, durationMs: 4, ranAt: '2026-01-01T00:00:00.000Z' },
  };
}

function withProvider(view: CollectionTabState['view'], isView: boolean, children: React.ReactNode) {
  const actions = emptyWorkspaceActions();
  render(
    <CollectionWorkspaceProvider
      state={makeState(view)}
      actions={actions}
      meta={emptyWorkspaceMeta({ isView })}
    >
      {children}
    </CollectionWorkspaceProvider>,
  );
  return actions;
}

describe.each([true, false])('result bar writes, isView=%s', (isView) => {
  it('offers Insert and the write items of the Documents menu only on a collection', async () => {
    withProvider('Tree', isView, <ResultBar />);
    expect(!!screen.queryByRole('button', { name: 'Insert document' })).toBe(!isView);
    await userEvent.click(screen.getByRole('button', { name: /Documents/ }));
    expect(!!screen.queryByText('Update all matching…')).toBe(!isView);
    expect(!!screen.queryByText('Import documents…')).toBe(!isView);
    expect(!!screen.queryByText('Delete all matching…')).toBe(!isView);
    // Reading a view's documents out is not a write.
    expect(screen.getByText('Export…')).toBeTruthy();
  });
});

describe.each([
  ['Tree', <TreeView key="t" documents={DOCS} onSelect={() => {}} onRowExpand={() => {}} />],
  ['JSON', <JsonView key="j" documents={DOCS} />],
  [
    'Table',
    <TableView key="b" documents={DOCS} onColumnResize={() => {}} onRowExpand={() => {}} />,
  ],
] as const)('%s row actions', (name, node) => {
  it('on a view: View document instead of Edit, no Delete, no Duplicate', async () => {
    const actions = withProvider(name, true, node);
    expect(screen.queryByRole('button', { name: /^Edit document/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete document/ })).toBeNull();
    // fireEvent: the Table's actions column is pointer-events:none until hovered.
    fireEvent.click(screen.getAllByRole('button', { name: /^More actions for document/ })[0]);
    expect(screen.getByText('View document')).toBeTruthy();
    expect(screen.queryByText('Duplicate document')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
    fireEvent.click(screen.getByText('View document'));
    expect(actions.openEdit).toHaveBeenCalledTimes(1);
  });

  it('on a collection: Edit, Delete and Duplicate stay', async () => {
    withProvider(name, false, node);
    expect(screen.getByRole('button', { name: /^Edit document/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Delete document/ })).toBeTruthy();
    expect(screen.queryByText('View document')).toBeNull();
  });
});

describe('selection bar', () => {
  it.each([
    [true, false],
    [false, true],
  ])('isView=%s: Delete present=%s, Copy always', (isView, hasDelete) => {
    withProvider(
      'JSON',
      isView,
      <ResultViewer>
        <ResultViewer.SelectionBar onDeleteSelected={() => {}} />
        <ResultViewer.Json />
      </ResultViewer>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select document 99439011' }));
    expect(screen.getByTestId('selection-bar-copy')).toBeTruthy();
    expect(!!screen.queryByTestId('selection-bar-delete')).toBe(hasDelete);
  });
});

describe('empty view', () => {
  it('does not offer Import documents', () => {
    const state = { ...makeState('Tree'), lastRun: { documents: [], durationMs: 1, ranAt: 'x' } };
    render(
      <CollectionWorkspaceProvider
        state={state}
        actions={emptyWorkspaceActions()}
        meta={emptyWorkspaceMeta({ isView: true })}
      >
        <ResultViewer>
          <ResultViewer.Body onClearFilter={() => {}} onColumnResize={() => {}} onRowExpand={() => {}} />
        </ResultViewer>
      </CollectionWorkspaceProvider>,
    );
    expect(screen.getByText('This collection is empty')).toBeTruthy();
    expect(screen.queryByText('Import documents…')).toBeNull();
  });
});

describe('useDocumentDialogs on a view', () => {
  const tab = {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders_view',
    state: makeState('Tree'),
  } as unknown as CollectionTab;

  function mount(isView: boolean) {
    const ref = { current: tab } as React.RefObject<CollectionTab | null>;
    return renderHook(() =>
      useDocumentDialogs({
        activeCollectionRef: ref,
        queryRunner: { run: () => Promise.resolve(), cancel: () => {}, isLoading: false },
        activeTabId: 't1',
        resolveRunnerTarget: () => null,
        readOnly: false,
        isView,
      }),
    );
  }

  it('opens the read-only viewer for Edit and refuses every write', () => {
    const { result } = mount(true);
    act(() => {
      result.current.openEdit(DOCS[0]);
      result.current.openInsertModal();
      result.current.openDuplicate(DOCS[0]);
      result.current.openDeleteAllModal();
      result.current.openUpdateAllModal();
      result.current.setDeleteDoc(DOCS[0]);
      result.current.setDeleteSelected(DOCS);
    });
    expect(result.current.viewing?.doc).toBe(DOCS[0]);
    expect(result.current.editing).toBeNull();
    expect(result.current.inserting).toBeNull();
    expect(result.current.deleteDoc).toBeNull();
    expect(result.current.deleteSelected).toBeNull();
    expect(result.current.deleteAllOpen).toBe(false);
    expect(result.current.updateAllOpen).toBe(false);
  });

  it('on a collection Edit and Insert open their editors', () => {
    const { result } = mount(false);
    act(() => {
      result.current.openEdit(DOCS[0]);
      result.current.openInsertModal();
    });
    expect(result.current.viewing).toBeNull();
    expect(result.current.editing?.doc).toBe(DOCS[0]);
    expect(result.current.inserting).not.toBeNull();
  });
});

describe('ViewDocumentDialog', () => {
  const details = (viewOn?: string) => ({
    name: 'orders_view',
    type: 'view' as const,
    capped: false,
    options: { viewOn },
  });

  it('explains, shows the document, and opens the source collection', async () => {
    installAtelierMock({ meta: { collectionDetails: vi.fn(async () => details('orders')) } });
    const onOpenSource = vi.fn();
    const onClose = vi.fn();
    render(
      <ViewDocumentDialog
        connectionId="c1"
        dbName="shop"
        collection="orders_view"
        doc={DOCS[0]}
        onClose={onClose}
        onOpenSource={onOpenSource}
      />,
    );
    expect(screen.getByRole('dialog').textContent).toContain('shop.orders_view');
    expect(
      screen.getByText(/This is a view, so its documents can.t be edited here\. To change them, open the source collection\./),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open orders' }));
    expect(onOpenSource).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop', collection: 'orders' });
  });

  it('leaves Open out until the source is known', async () => {
    installAtelierMock({ meta: { collectionDetails: vi.fn(async () => details(undefined)) } });
    render(
      <ViewDocumentDialog
        connectionId="c1"
        dbName="shop"
        collection="orders_view"
        doc={DOCS[0]}
        onClose={() => {}}
        onOpenSource={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Close' }).length).toBe(2));
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
  });
});
