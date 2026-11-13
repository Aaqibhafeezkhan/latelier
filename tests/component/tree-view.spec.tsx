import { describe, it, expect, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  within,
  act,
  emptyWorkspaceActions,
  emptyWorkspaceMeta,
  expectActiveRowOutlineLifecycle,
} from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { TreeView } from '../../src/pages/Workspace/views/TreeView';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceActions, CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState, TableColumnConfig } from '@shared/types';

const noop = () => {};

function emptyState(columnConfig?: TableColumnConfig): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    columnConfig,
  };
}

function renderTree(documents: unknown[], opts: {
  expanded?: Record<string, true>;
  /** Fields control's per-tab config — hide/reorder now drive the Tree preview directly. */
  columnConfig?: TableColumnConfig;
  onRowExpand?: (id: string, expanded: boolean) => void;
  onSelect?: (doc: unknown) => void;
  actions?: Partial<CollectionWorkspaceActions>;
  meta?: Partial<CollectionWorkspaceMeta>;
} = {}) {
  return render(
      <CollectionWorkspaceProvider
        state={emptyState(opts.columnConfig)}
        actions={emptyWorkspaceActions(opts.actions)}
        meta={emptyWorkspaceMeta(opts.meta)}
      >
        <TreeView
          documents={documents}
          expandedRows={opts.expanded}
          onSelect={opts.onSelect ?? noop}
          onRowExpand={opts.onRowExpand ?? vi.fn()}
        />
      </CollectionWorkspaceProvider>
  );
}

/**
 * P1-11 coverage for TreeView. The existing `treeview-deeppaths-reset.spec.tsx`
 * pins the deepPaths-reset perf fix; these add the basic rendering /
 * interaction surface (collapsed preview, expansion, deletion).
 */
describe('TreeView — rendering and interaction', () => {
  it('renders one row per document and shows a collapsed-preview slice of fields', () => {
    const docs = [
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha', count: 1 },
      { _id: { $oid: '507f1f77bcf86cd799439012' }, name: 'beta', count: 2 },
    ];
    const { container } = renderTree(docs);

    // TreeView's getDocId() shows the last 8 chars of each $oid.
    expect(container.textContent).toContain('99439011');
    expect(container.textContent).toContain('99439012');
    // Collapsed preview includes the non-_id fields by default
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
  });

  it('hiding a field in the Fields control removes it from the collapsed preview', () => {
    const docs = [
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha', secret: 'hidden' },
    ];
    const { container } = renderTree(docs, { columnConfig: { hidden: ['secret'] } });

    expect(container.textContent).toContain('alpha');
    // `secret` is hidden in the Fields control — must not appear in the preview.
    // Strip <style> elements first: Mantine's MantineProvider injects a
    // global stylesheet that mentions the word "hidden" in utility class
    // names (e.g., .mantine-hidden-from-xs), which would otherwise be
    // picked up by container.textContent.
    const rendered = container.cloneNode(true) as HTMLElement;
    rendered.querySelectorAll('style').forEach((el) => el.remove());
    expect(rendered.textContent).not.toContain('hidden');
  });

  it('with no Fields config, the preview falls back to a document\'s own first 4 keys', () => {
    const docs = [{ _id: 1, aa: 1, bb: 2, cc: 3, dd: 4, ee: 5 }];
    const { container } = renderTree(docs);

    expect(container.textContent).toContain('aa:');
    expect(container.textContent).not.toContain('ee:');
  });

  it('reordering fields in the Fields control changes which 4 fields the Tree previews', () => {
    const docs = [{ _id: 1, aa: 1, bb: 2, cc: 3, dd: 4, ee: 5 }];
    const { container } = renderTree(docs, {
      columnConfig: { order: ['ee', 'dd', 'cc', 'bb', 'aa'] },
    });

    // Reordered to the front — now inside the first-4 preview slice.
    expect(container.textContent).toContain('ee:');
    // Pushed to 5th by the reorder — falls out of the slice.
    expect(container.textContent).not.toContain('aa:');
  });

  it('hiding every field shows an empty collapsed preview, not the hidden fields', () => {
    const docs = [
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha', secret: 'topsecret' },
    ];
    const { container } = renderTree(docs, { columnConfig: { hidden: ['name', 'secret'] } });

    const rendered = container.cloneNode(true) as HTMLElement;
    rendered.querySelectorAll('style').forEach((el) => el.remove());
    expect(rendered.textContent).not.toContain('alpha');
    expect(rendered.textContent).not.toContain('topsecret');
  });

  it('with a Fields config, each sparse row previews its own visible fields, not a global slice', () => {
    const docs = [
      { _id: 1, a: 'zone-a', b: 'zone-b', c: 'zone-c', d: 'zone-d' },
      { _id: 2, e: 'zone-e', f: 'zone-f' },
    ];
    // Hiding `a` pushes the visible list to [b, c, d, e, f]; a global first-4
    // slice would cut `f` before the second doc's own fields are considered,
    // even though that doc has none of b/c/d.
    const { container } = renderTree(docs, { columnConfig: { hidden: ['a'] } });

    expect(container.textContent).toContain('zone-e');
    expect(container.textContent).toContain('zone-f');
  });

  it('renders an expanded row with its top-level fields visible', () => {
    const docs = [
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha', visibleField: 'yes' },
    ];
    // TreeView's getDocId() takes the last 8 chars of `$oid` as the row
    // key — so the matching `expandedRows` key for this doc is '99439011',
    // not '39439011'. Earlier this test "passed" because `visibleField` is
    // also visible in the collapsed preview strip; using the real expanded
    // key makes the assertion actually test the expanded code path.
    const { container } = renderTree(docs, { expanded: { '99439011': true } });

    // Expanded view shows the full key list including `_id`
    expect(container.textContent).toContain('visibleField');
    expect(container.textContent).toContain('yes');
  });

  // S6848 a11y fix (row now carries role="treeitem"/tabIndex/onKeyDown for
  // "Click to expand"): the row's onKeyDown must ignore a keydown that
  // bubbles up from the nested expand button, or Enter on that button would
  // call onRowExpand twice (once from the button's own click, once from the
  // row) and net out to a no-op instead of expanding.
  it('pressing Enter on the expand button expands exactly once, not twice', async () => {
    const docs = [
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' },
    ];
    const onRowExpand = vi.fn();
    renderTree(docs, { onRowExpand });

    const btn = screen.getByRole('button', { name: 'Expand document' });
    btn.focus();
    await userEvent.keyboard('{Enter}');

    expect(onRowExpand).toHaveBeenCalledTimes(1);
    expect(onRowExpand).toHaveBeenCalledWith('507f1f77bcf86cd799439011', true);
  });

  // N4.1 — Tree had no visible way to select without ⌘/Ctrl+click; the
  // checkbox added alongside the expand chevron is that path.
  it('the checkbox selects a row without expanding it, and names the document', () => {
    const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }];
    const onRowExpand = vi.fn();
    const { getByRole, container } = renderTree(docs, { onRowExpand });
    const checkbox = getByRole('button', { name: 'Select document 99439011' });

    fireEvent.click(checkbox);

    expect(onRowExpand).not.toHaveBeenCalled();
    expect(checkbox.getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Deselect document 99439011' })).toBe(checkbox);
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull();
  });

  // A ghost-coloured check on an unselected box read as already checked.
  it('an unselected checkbox is empty and shows a check only once selected', () => {
    const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }];
    const { getByRole } = renderTree(docs);
    const checkbox = getByRole('button', { name: 'Select document 99439011' });

    expect(checkbox.getAttribute('aria-pressed')).toBe('false');
    expect(checkbox.querySelector('svg')).toBeNull();

    fireEvent.click(checkbox);

    expect(checkbox.getAttribute('aria-pressed')).toBe('true');
    expect(checkbox.querySelector('svg')).not.toBeNull();
  });

  it('collapsed rows pack the preview beside the id and use compact paddings', () => {
    const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }];
    const { getByRole, getByText } = renderTree(docs);
    const row = getByRole('treeitem');
    expect(row.style.padding).toBe('4px 12px');
    expect(row.style.minHeight).toBe('32px');
    const previewBox = getByText('"alpha"').closest('div[style*="flex: 1"]') as HTMLElement;
    expect(previewBox.style.justifyContent).toBe('flex-start');
  });

  // #20 — roving focus: the tree itself is the widget's only tab stop.
  describe('roving focus (#20)', () => {
    const threeDocs = [
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'a' },
      { _id: { $oid: '507f1f77bcf86cd799439012' }, name: 'b' },
      { _id: { $oid: '507f1f77bcf86cd799439013' }, name: 'c' },
    ];

    it('the tree is a tab stop and names row 0 as the active descendant', () => {
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')!;

      expect(tree.getAttribute('tabindex')).toBe('0');
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-0');
      expect(container.querySelector('#tree-row-0')).not.toBeNull();
    });

    it('ArrowDown/ArrowUp move the active descendant and wrap at both ends', () => {
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')!;

      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-1');

      fireEvent.keyDown(tree, { key: 'ArrowUp' });
      fireEvent.keyDown(tree, { key: 'ArrowUp' });
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-2');
    });

    it('Home/End jump to the first/last row', () => {
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')!;

      fireEvent.keyDown(tree, { key: 'End' });
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-2');
      fireEvent.keyDown(tree, { key: 'Home' });
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-0');
    });

    it('Enter on the tree itself expands the active row', () => {
      const onRowExpand = vi.fn();
      const { container } = renderTree(threeDocs, { onRowExpand });
      const tree = container.querySelector('[role="tree"]')!;

      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      fireEvent.keyDown(tree, { key: 'Enter' });

      expect(onRowExpand).toHaveBeenCalledWith('507f1f77bcf86cd799439012', true);
    });

    it('E on the tree opens the editor on the active row', () => {
      const openEdit = vi.fn();
      const { container } = renderTree(threeDocs, { actions: { openEdit } });
      const tree = container.querySelector('[role="tree"]')!;

      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      fireEvent.keyDown(tree, { key: 'E' });

      expect(openEdit).toHaveBeenCalledWith(threeDocs[1]);
    });

    it('D on the tree opens the delete confirmation for the active row', () => {
      const openDelete = vi.fn();
      const { container } = renderTree(threeDocs, { actions: { openDelete } });
      const tree = container.querySelector('[role="tree"]')!;

      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      fireEvent.keyDown(tree, { key: 'D' });

      expect(openDelete).toHaveBeenCalledTimes(1);
      expect(openDelete).toHaveBeenCalledWith(threeDocs[1]);
    });

    it('D does nothing with a modifier or from a nested control', () => {
      const openDelete = vi.fn();
      const { container } = renderTree(threeDocs, { actions: { openDelete } });
      const tree = container.querySelector('[role="tree"]')!;

      fireEvent.keyDown(tree, { key: 'd', ctrlKey: true });
      fireEvent.keyDown(tree, { key: 'd', metaKey: true });
      fireEvent.keyDown(screen.getAllByRole('button', { name: /^Edit document/ })[0], { key: 'd' });

      expect(openDelete).not.toHaveBeenCalled();
    });

    it.each([{ isView: true }, { isReadOnly: true }])('D does nothing, and is not swallowed, when %o', (meta) => {
      const openDelete = vi.fn();
      const { container } = renderTree(threeDocs, { actions: { openDelete }, meta });

      const notPrevented = fireEvent.keyDown(container.querySelector('[role="tree"]')!, { key: 'd' });

      expect(openDelete).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    });

    // One tab stop per list (X19): Tab from the tree reaches only the active
    // row's actions, so a page of rows is not a page of tab stops.
    it('only the active row keeps its buttons in the Tab order, and the stop follows the arrows', () => {
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')!;
      const tabStops = () =>
        screen.getAllByRole('button').filter((b) => b.getAttribute('tabindex') !== '-1').map((b) => b.getAttribute('aria-label'));

      expect(tabStops()).toEqual([
        'Select document 99439011',
        'Expand document',
        'Edit document 99439011',
        'Delete document 99439011',
        'More actions for document 99439011',
      ]);

      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      expect(tabStops().every((label) => label?.includes('99439012') || label === 'Expand document')).toBe(true);
      expect(tabStops()).toHaveLength(5);
    });

    // Mirrors the existing per-row guard test above, at the container level:
    // Enter bubbling from a nested button must not also expand the row.
    it('Enter bubbling up from a nested button does not double-expand', async () => {
      const onRowExpand = vi.fn();
      renderTree([threeDocs[0]], { onRowExpand });

      const btn = screen.getByRole('button', { name: 'Expand document' });
      btn.focus();
      await userEvent.keyboard('{Enter}');

      expect(onRowExpand).toHaveBeenCalledTimes(1);
    });

    // Found in review: `tabIndex={-1}` excludes the row from Tab order but
    // (per the HTML focusing-steps algorithm) leaves it click-focusable —
    // `fireEvent.click` elsewhere in this file does no focus management at
    // all, which is why this needs `userEvent`'s click specifically, the one
    // that walks up to the nearest focusable ancestor like a real browser.
    it('a real click on a row does not trap focus there — ArrowDown still moves the tree afterward', async () => {
      const user = userEvent.setup();
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')!;
      const rows = container.querySelectorAll('[role="treeitem"]');

      await user.click(rows[0]);
      await user.keyboard('{ArrowDown}');

      expect(document.activeElement).toBe(tree);
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-1');
    });

    it('clicking row 2 makes it the active row — ArrowDown moves to row 3, not row 1', async () => {
      const user = userEvent.setup();
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')!;
      const rows = container.querySelectorAll('[role="treeitem"]');

      await user.click(rows[1]);
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-1');
      await user.keyboard('{ArrowDown}');
      expect(tree.getAttribute('aria-activedescendant')).toBe('tree-row-2');
    });
  });

  // #60 — the active row is announced (aria-activedescendant, #20) but was
  // never drawn. These assert the real inline outline, not an attribute.
  describe('active-row visual highlight (#60)', () => {
    const threeDocs = [
      { _id: 1, name: 'a' },
      { _id: 2, name: 'b' },
      { _id: 3, name: 'c' },
    ];

    it('no row is outlined before focus, the active row gains it on focus, ArrowDown moves it, blur clears it', () => {
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')! as HTMLElement;
      const rows = () => Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));

      expectActiveRowOutlineLifecycle(tree, rows, { key: 'ArrowDown', from: 0, to: 1 });
    });

    it('a selected-and-active row shows both treatments; selected-but-not-active shows only the background/left-border', () => {
      const { container } = renderTree(threeDocs);
      const tree = container.querySelector('[role="tree"]')! as HTMLElement;
      const row1 = container.querySelector('#tree-row-1') as HTMLElement;

      fireEvent.click(row1, { metaKey: true }); // ⌘+click selects row 1 and makes it the active row too.
      act(() => tree.focus());

      const outer1 = row1.parentElement!;
      expect(outer1.getAttribute('data-selected')).toBe('true');
      expect(row1.style.outline).toContain('2px');

      // Move the active row off row 1 — it stays selected, but the outline
      // must follow the active index, leaving only the background/border.
      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      expect(outer1.getAttribute('data-selected')).toBe('true');
      expect(row1.style.outline).not.toContain('2px');
      expect(outer1.style.background).toContain('accent-soft');
      expect(outer1.style.borderLeft).toContain('accent');

      const row2 = container.querySelector('#tree-row-2') as HTMLElement;
      expect(row2.style.outline).toContain('2px');
    });

    // The whole reason for driving the highlight from React instead of a
    // CSS descendant selector (`DocFieldTree` mounts *inside* an expanded
    // outer row — see `TreeView.tsx:337`): a descendant selector keyed off
    // the outer tree's own `aria-activedescendant`/focus would paint this
    // nested tree's row too, even though the nested tree itself never had
    // focus. This test fails against that implementation.
    it("an expanded row's nested DocFieldTree never receives the outer tree's active-row outline", () => {
      const { container } = renderTree(threeDocs, { expanded: { '1': true } });
      const tree = container.querySelector('[role="tree"]')! as HTMLElement;

      act(() => tree.focus());

      const outlined = Array.from(container.querySelectorAll<HTMLElement>('*')).filter((el) =>
        el.style.outline?.includes('2px'),
      );
      expect(outlined).toHaveLength(1);
      expect(outlined[0].id).toBe('tree-row-0');
    });
  });

  // Edit/Delete already had their own visible per-row buttons here; this
  // adds a "More actions" button for parity with Table's context menu
  // (Duplicate), opening the same shared menu content.
  describe('"More actions" per-row menu', () => {
    it('opens a menu with Duplicate, and calls the workspace action on click', () => {
      const openDuplicate = vi.fn();
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }];
      const { getByRole } = renderTree(docs, { actions: { openDuplicate } });

      fireEvent.click(getByRole('button', { name: /More actions for document/ }));
      const menu = getByRole('group', { name: 'Document actions' });
      fireEvent.click(within(menu).getByText('Duplicate document'));

      expect(openDuplicate).toHaveBeenCalledWith(docs[0]);
    });

    it('omits Duplicate when the workspace has no openDuplicate action wired', () => {
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }];
      const { getByRole, queryByText } = renderTree(docs);

      fireEvent.click(getByRole('button', { name: /More actions for document/ }));
      expect(queryByText('Duplicate document')).toBeNull();
    });

    it('does not expand or collapse the row it belongs to', () => {
      const onRowExpand = vi.fn();
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }];
      const { getByRole } = renderTree(docs, { onRowExpand });

      fireEvent.click(getByRole('button', { name: /More actions for document/ }));
      expect(onRowExpand).not.toHaveBeenCalled();
    });

    it('closes the field-level menu when the doc menu opens, and vice versa', () => {
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }];
      const { getByRole, queryByRole } = renderTree(docs, {
        expanded: { '507f1f77bcf86cd799439011': true },
      });

      // Right-click the expanded 'name' field row to open the field-level
      // menu. Field rows are identified by a stable `field-row-<docId>::<path>`
      // id, since the doc summary row's own accessible name also contains
      // "name" (it previews the field's value).
      const nameFieldRow = document.getElementById(
        'field-row-507f1f77bcf86cd799439011::name',
      )!;
      fireEvent.contextMenu(nameFieldRow);
      expect(getByRole('group', { name: 'Field actions' })).toBeTruthy();

      // Opening the doc-level "More actions" menu must close the field menu —
      // both are dismissed only by useMenuFocus's window click listener, and
      // this button stops propagation, so it never fires for the other menu.
      fireEvent.click(getByRole('button', { name: /More actions for document/ }));
      expect(queryByRole('group', { name: 'Field actions' })).toBeNull();
      expect(getByRole('group', { name: 'Document actions' })).toBeTruthy();

      // And the reverse: opening a field menu closes the doc menu.
      fireEvent.contextMenu(nameFieldRow);
      expect(queryByRole('group', { name: 'Document actions' })).toBeNull();
      expect(getByRole('group', { name: 'Field actions' })).toBeTruthy();
    });
  });
});

describe('TreeView row actions', () => {
  const DOCS = [
    { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' },
    { _id: { $oid: '507f1f77bcf86cd799439012' }, name: 'beta' },
  ];
  const rowActions = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="tree-row-actions"]')];

  it('are hidden at rest with their space kept, so a row never shifts', () => {
    const { container } = renderTree(DOCS);
    const [first] = rowActions(container);
    expect(first!.style.opacity).toBe('0');
    // Still mounted: hiding them must not take the width away, or Tab's reach.
    expect(within(first!).getByRole('button', { name: /^Edit document/ })).toBeTruthy();
    expect(within(first!).getByRole('button', { name: /^Delete document/ })).toBeTruthy();
    expect(within(first!).getByRole('button', { name: /^More actions/ })).toBeTruthy();
  });

  it('show on hover and hide again', () => {
    const { container } = renderTree(DOCS);
    const row = container.querySelectorAll('[role="treeitem"]')[1]!;
    const actions = rowActions(container)[1]!;
    fireEvent.mouseEnter(row);
    expect(actions.style.opacity).toBe('1');
    fireEvent.mouseLeave(row);
    expect(actions.style.opacity).toBe('0');
  });

  it('show with focus inside the row, so a keyboard user sees what Tab reached', () => {
    const { container } = renderTree(DOCS);
    const actions = rowActions(container)[1]!;
    fireEvent.focus(within(actions).getByRole('button', { name: /^Edit document/ }));
    expect(actions.style.opacity).toBe('1');
    fireEvent.blur(within(actions).getByRole('button', { name: /^Edit document/ }));
    expect(actions.style.opacity).toBe('0');
  });

  it('show on the active row, for as long as the tree holds focus', () => {
    const { container } = renderTree(DOCS);
    const tree = container.querySelector('[role="tree"]') as HTMLElement;
    act(() => tree.focus());
    expect(rowActions(container)[0]!.style.opacity).toBe('1');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(rowActions(container)[0]!.style.opacity).toBe('0');
    expect(rowActions(container)[1]!.style.opacity).toBe('1');
  });
});
