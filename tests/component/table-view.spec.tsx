import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  fireEvent,
  screen,
  waitFor,
  within,
  act,
  emptyWorkspaceActions,
  emptyWorkspaceMeta,
  expectActiveRowOutlineLifecycle,
} from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { notifications } from '@mantine/notifications';
import { itReturnsFocusToPopoverTrigger } from '../helpers/popoverFocusReturn';
import { TableView } from '../../src/pages/Workspace/views/TableView';
import { FieldsControl } from '../../src/pages/Workspace/FieldsControl';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceActions } from '../../src/pages/Workspace/context';
import type { CollectionTabState, ReferenceRule } from '@shared/types';
import { DRAGGED_FIELD_MIME, cycleSortField } from '../../src/pages/Workspace/builder';

// jsdom doesn't implement clipboard by default; stub so copyToClipboard
// doesn't throw when rendered.
let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});
afterEach(() => {
  // Mantine's notification store is module-global and outlives RTL's
  // unmount, so a toast raised by one test would still be on screen for the
  // next one's "did it *not* claim success?" assertion.
  notifications.clean();
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});

function emptyState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Table',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    ...overrides,
  };
}

function renderTable(
  docs: unknown[],
  extra: {
    refsByField?: Map<string, ReferenceRule>;
    columnConfig?: CollectionTabState['columnConfig'];
    expandedRows?: Record<string, boolean>;
    onRowExpand?: (docId: string, expanded: boolean) => void;
    actions?: Partial<CollectionWorkspaceActions>;
    sort?: string;
    onSortField?: (field: string) => void;
  } = {},
) {
  return render(
      <CollectionWorkspaceProvider
        state={emptyState()}
        actions={emptyWorkspaceActions(extra.actions)}
        meta={emptyWorkspaceMeta()}
      >
        <TableView
          documents={docs}
          onColumnResize={vi.fn()}
          refsByField={extra.refsByField}
          columnConfig={extra.columnConfig}
          expandedRows={extra.expandedRows}
          onRowExpand={extra.onRowExpand ?? vi.fn()}
          sort={extra.sort}
          onSortField={extra.onSortField}
        />
      </CollectionWorkspaceProvider>
  );
}

/**
 * Real `useState` harness for the FieldsControl <-> TableView round-trip
 * (AC3/AC4): patches from the chooser must come back through props and
 * actually change what TableView renders. A static-prop render can't
 * observe this (known gotcha) — see also treeview/table-view specs for the
 * same pattern.
 */
function renderStatefulTable(initial: CollectionTabState) {
  function Harness() {
    const [state, setState] = React.useState(initial);
    const actions = React.useMemo<CollectionWorkspaceActions>(
      () =>
        emptyWorkspaceActions({
          patch: (p) => setState((s) => ({ ...s, ...p })),
          patchWith: (fn) => setState((s) => ({ ...s, ...fn(s) })),
        }),
      [],
    );
    const documents = state.lastRun?.documents ?? [];
    const handleRowExpand = (docId: string, expanded: boolean) => {
      setState((s) => {
        const next = { ...(s.expandedRows ?? {}) };
        if (expanded) next[docId] = true;
        else delete next[docId];
        return { ...s, expandedRows: next };
      });
    };
    return (
      <CollectionWorkspaceProvider state={state} actions={actions} meta={emptyWorkspaceMeta()}>
        <FieldsControl />
        <TableView
          documents={documents}
          columns={state.columns}
          columnConfig={state.columnConfig}
          expandedRows={state.expandedRows}
          onRowExpand={handleRowExpand}
          onColumnResize={(field, width) =>
            setState((s) => ({ ...s, columns: { ...(s.columns ?? {}), [field]: { width } } }))
          }
        />
      </CollectionWorkspaceProvider>
    );
  }
  return render(<Harness />);
}

describe('TableView — rendering and interaction', () => {
  it('derives columns from the first 50 docs, _id first, others alphabetized', () => {
    const docs = [
      { _id: 1, zebra: 'z', apple: 'a' },
      { _id: 2, banana: 'b' },
    ];
    const { container } = renderTable(docs);
    expect(container.textContent).toContain('_id');
    expect(container.textContent).toContain('apple');
    expect(container.textContent).toContain('banana');
    expect(container.textContent).toContain('zebra');

    const text = container.textContent ?? '';
    const idIdx = text.indexOf('_id');
    const appleIdx = text.indexOf('apple');
    const bananaIdx = text.indexOf('banana');
    const zebraIdx = text.indexOf('zebra');
    expect(idIdx).toBeLessThan(appleIdx);
    expect(appleIdx).toBeLessThan(bananaIdx);
    expect(bananaIdx).toBeLessThan(zebraIdx);
  });

  it('renders cell values from documents', () => {
    const docs = [{ _id: 1, name: 'alpha' }];
    const { container } = renderTable(docs);
    expect(container.textContent).toContain('alpha');
  });

  it('renders a ReferenceChip for a column with a matching reference rule', () => {
    const rule: ReferenceRule = {
      id: 'r1',
      connectionId: 'c1',
      sourceDb: 'app',
      sourceCollection: 'orders',
      sourceField: 'userId',
      targetDb: 'app',
      targetCollection: 'users',
      targetField: '_id',
      projection: [],
      displayTemplate: undefined,
      enabled: true,
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    };
    const refsByField = new Map<string, ReferenceRule>([['userId', rule]]);
    const docs = [{ _id: 'o1', userId: { $oid: '507f1f77bcf86cd799439011' } }];
    const { container } = renderTable(docs, { refsByField });
    expect(container.textContent).toMatch(/users|→|↗/);
  });

  // AC1 — row expand reuses the Tree's field-tree renderer. `nested` itself
  // is already visible as a *column* before expansion (unlike Tree view,
  // Table always shows every derived field as a header) — the un-expanded
  // assertion checks the nested object's own inner field (`deep`), which
  // only the DocFieldTree panel would ever render.
  it('expands a row via the gutter chevron to reveal its full document as a field tree', () => {
    const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha', nested: { deep: 'value123' } }];
    const onRowExpand = vi.fn();
    const { getByRole, queryByText } = renderTable(docs, { onRowExpand });

    expect(queryByText('deep')).toBeNull();
    expect(queryByText(/value123/)).toBeNull();

    fireEvent.click(getByRole('button', { name: 'Expand document' }));
    expect(onRowExpand).toHaveBeenCalledWith('507f1f77bcf86cd799439011', true);
  });

  it('renders the DocFieldTree panel (with FIELD/VALUE/TYPE header) when expandedRows marks the row expanded', () => {
    const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, visibleField: 'yes' }];
    const { container } = renderTable(docs, {
      expandedRows: { '507f1f77bcf86cd799439011': true },
    });
    expect(container.textContent).toContain('Field');
    expect(container.textContent).toContain('Value');
    expect(container.textContent).toContain('Type');
    expect(container.textContent).toContain('visibleField');
    expect(container.textContent).toContain('yes');
  });

  // AC5 — click-to-expand cell.
  it('opens a popover with the full value when the cell expand affordance is clicked', () => {
    const longValue = 'x'.repeat(80);
    const docs = [{ _id: 1, note: longValue }];
    const { getByTitle, getByText, queryByText } = renderTable(docs);

    const cell = getByTitle(/Drag to add "note/);
    // The cell itself already renders the raw value (unquoted) — that alone
    // isn't proof the popover opened. The popover renders it quoted
    // (`"${value}"`), which the cell never does, so assert on that form to
    // actually discriminate "popover open" from "cell always shows this".
    expect(queryByText(`"${longValue}"`)).toBeNull();

    fireEvent.mouseEnter(cell);
    // Scope to this cell — every column's cell renders its own "Expand cell
    // value" button, so an unscoped query would match more than one.
    const expandBtn = within(cell).getByRole('button', { name: 'Expand cell value' });
    fireEvent.click(expandBtn);

    expect(getByText(`"${longValue}"`)).toBeTruthy();
  });

  it('a cell with a value advertises both drag-to-filter and double-click-to-copy in its title', () => {
    const { getByTitle } = renderTable([{ _id: 1, note: 'hello' }]);
    expect(getByTitle(/Drag to add "note/).getAttribute('title')).toBe(
      'Drag to add "note $eq …" to builder · double-click to copy',
    );
  });

  // AC6 regressions — behaviour that must survive the memo/gutter/dynamic-
  // height refactor.
  describe('AC6 regressions', () => {
    it('⌘/Ctrl+click toggles a row into multi-select without deselecting via plain click semantics', () => {
      const docs = [
        { _id: 1, name: 'a' },
        { _id: 2, name: 'b' },
      ];
      const { container, getAllByTitle } = renderTable(docs);
      const rows = container.querySelectorAll('[data-selected]');
      expect(rows.length).toBe(2);

      // Selection is driven by a click anywhere in the row's cell strip
      // (data-selected lives on the row's outer wrapper, one level up from
      // the clickable strip — the row-expand chevron/gutter and the
      // DocFieldTree panel below deliberately do NOT carry this handler).
      const cells = getAllByTitle(/Drag to add "name/);
      fireEvent.click(cells[0], { metaKey: true });
      fireEvent.click(cells[1], { metaKey: true });
      expect(rows[0].getAttribute('data-selected')).toBe('true');
      expect(rows[1].getAttribute('data-selected')).toBe('true');
    });

    // N4.1 — a plain click used to select the row outright; it now only
    // makes it the active row, leaving selection to the checkbox or
    // ⌘/Ctrl+click, so the same gesture means the same thing in every view.
    it('a plain click on a row makes it active but does not select it', () => {
      const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }];
      const { container, getAllByTitle } = renderTable(docs);
      const grid = container.querySelector('[role="grid"]')!;
      const rows = container.querySelectorAll('[data-selected]');
      const cells = getAllByTitle(/Drag to add "name/);

      fireEvent.click(cells[1]);

      expect(rows[0].getAttribute('data-selected')).toBe('false');
      expect(rows[1].getAttribute('data-selected')).toBe('false');
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-1');
    });

    it('the gutter checkbox selects a row without moving it via a plain click, and names the document', () => {
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'a' }];
      const { getByRole } = renderTable(docs);
      const checkbox = getByRole('button', { name: 'Select document 99439011' });

      fireEvent.click(checkbox);
      expect(checkbox.getAttribute('aria-pressed')).toBe('true');
      expect(getByRole('button', { name: 'Deselect document 99439011' })).toBe(checkbox);
    });

    it('double-click on a cell copies its value to the clipboard', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { getByTitle } = renderTable(docs);
      const cell = getByTitle(/Drag to add "name/);
      fireEvent.doubleClick(cell);
      expect(clipboardWriteTextWasCalled()).toBe(true);
    });

    // the badge used to be set synchronously, next to a dropped
    // promise: it claimed a copy that may never have happened.
    it('shows the copied badge only once the write has resolved', async () => {
      let settle: () => void = () => {};
      const writeText = vi.fn(() => new Promise<void>((res) => { settle = res; }));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { getByTitle } = renderTable([{ _id: 1, name: 'alpha' }]);

      fireEvent.doubleClick(getByTitle(/Drag to add "name/));
      expect(getByTitle(/Drag to add "name/).textContent).not.toContain('Copied');

      await act(async () => { settle(); });
      await waitFor(() =>
        expect(getByTitle(/Drag to add "name/).textContent).toContain('Copied'),
      );
    });

    it('reports a rejected cell copy and shows no badge', async () => {
      const writeText = vi.fn(async () => { throw new Error('denied'); });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { getByTitle } = renderTable([{ _id: 1, name: 'alpha' }]);

      fireEvent.doubleClick(getByTitle(/Drag to add "name/));

      await screen.findByText(/Could not copy to the clipboard/);
      expect(getByTitle(/Drag to add "name/).textContent).not.toContain('Copied');
    });

    // X19 #83 — the flash and the #60 active-row outline are both
    // `var(--atelier-accent)`; clipping the flash to the content box keeps
    // it off the 2px inset band the outline occupies. jsdom paints nothing,
    // so this only guards the style is set — `x19-copy-flash-outline.e2e.ts`
    // proves the pixels actually separate.
    it('a copied cell clips its flash background to the content box (#83)', async () => {
      const { getByTitle } = renderTable([{ _id: 1, name: 'alpha' }]);
      const cell = getByTitle(/Drag to add "name/);

      fireEvent.doubleClick(cell);

      await waitFor(() => expect(cell.style.backgroundClip).toBe('content-box'));
    });

    // The regression this guard exists for: without `e.target !==
    // e.currentTarget`, Enter on a nested native button (which also bubbles
    // its keydown up to the strip) would both run its own action AND select
    // the row it lives in.
    it('Enter on the expand chevron expands the row but does not also select it', () => {
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'a' }];
      const onRowExpand = vi.fn();
      const { container } = renderTable(docs, { onRowExpand });
      const row = container.querySelector('[data-selected]')!;
      const chevron = container.querySelector('[aria-label="Expand document"]')!;

      fireEvent.keyDown(chevron, { key: 'Enter' });
      expect(row.getAttribute('data-selected')).toBe('false');
    });

    it('drag start on a cell sets the DRAGGED_FIELD_MIME payload', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { getByTitle } = renderTable(docs);
      const cell = getByTitle(/Drag to add "name/);

      const setData = vi.fn();
      fireEvent.dragStart(cell, {
        dataTransfer: { setData, effectAllowed: '' },
      });
      const call = setData.mock.calls.find(([type]) => type === DRAGGED_FIELD_MIME);
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1])).toEqual({ field: 'name', value: 'alpha' });
    });

    it('right-click on a cell opens the context menu with Copy value / Copy field path', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { getByTitle, getByText } = renderTable(docs);
      const cell = getByTitle(/Drag to add "name/);
      fireEvent.contextMenu(cell);
      expect(getByText('Copy value')).toBeTruthy();
      expect(getByText('Copy field path')).toBeTruthy();
    });

    it('Escape closes the cell context menu', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { getByTitle, getByText, queryByText } = renderTable(docs);
      const cell = getByTitle(/Drag to add "name/);
      fireEvent.contextMenu(cell);
      expect(getByText('Copy value')).toBeTruthy();

      // Fired at the window, not at the menu node. The menu opens from a
      // `contextmenu` event and nothing focuses it, so a keydown dispatched
      // straight at the element proves only that a handler exists — it is a
      // path no keyboard user can take. An earlier version of this test did
      // exactly that and passed against a handler that could never fire.
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(queryByText('Copy value')).toBeNull();
    });

    it('Escape closes the field context menu from an expanded row', () => {
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, visibleField: 'yes' }];
      const { container, getByText, queryByText } = renderTable(docs, {
        expandedRows: { '507f1f77bcf86cd799439011': true },
      });
      // The field menu is a second, independently-registered window listener;
      // the cell menu passing says nothing about this one.
      const fieldRow = container.querySelector('[role="treeitem"]')!;
      fireEvent.contextMenu(fieldRow);
      expect(getByText('Copy field path')).toBeTruthy();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(queryByText('Copy field path')).toBeNull();
    });

    it('resize handle is still present on a column header', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { container } = renderTable(docs);
      expect(container.querySelector('[data-resize-handle="1"]')).toBeTruthy();
    });

    it('sort indicator renders when a header is the active sort field', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { getByTestId } = render(
        <CollectionWorkspaceProvider state={emptyState()} actions={emptyWorkspaceActions()} meta={emptyWorkspaceMeta()}>
          <TableView
            documents={docs}
            onColumnResize={vi.fn()}
            onSortField={vi.fn()}
            sort={'{"name":1}'}
          />
        </CollectionWorkspaceProvider>,
      );
      expect(getByTestId('table-header-name').textContent).toContain('↑');
    });
  });

  // AC3/AC4 — column chooser hide/reorder round-trips into TableView.
  describe('column chooser integration (stateful)', () => {
    function stateWithDocs(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
      return emptyState({
        lastRun: {
          documents: [
            { _id: 1, apple: 'a-val', banana: 'b-val' },
            { _id: 2, apple: 'a-val2', banana: 'b-val2' },
          ],
          durationMs: 1,
          ranAt: '2026-01-01T00:00:00Z',
        },
        ...overrides,
      });
    }

    it('hiding a column via the chooser removes its header + cells; unhiding restores it', () => {
      const { getByRole, container, queryByTestId } = renderStatefulTable(stateWithDocs());

      expect(queryByTestId('table-header-apple')).toBeTruthy();
      expect(container.textContent).toContain('a-val');

      fireEvent.click(getByRole('button', { name: /fields/i }));
      const appleCheckbox = getByRole('checkbox', { name: 'apple' });
      fireEvent.click(appleCheckbox);

      expect(queryByTestId('table-header-apple')).toBeNull();
      expect(container.textContent).not.toContain('a-val');

      fireEvent.click(appleCheckbox);
      expect(queryByTestId('table-header-apple')).toBeTruthy();
      expect(container.textContent).toContain('a-val');
    });

    it('reordering via drag changes the header order', () => {
      const { getByRole, getByTestId } = renderStatefulTable(stateWithDocs());

      fireEvent.click(getByRole('button', { name: /fields/i }));
      // Scope to the chooser's own popover dropdown — TableView's cells are
      // also `draggable`, so an unscoped document-wide query would be
      // ambiguous between the two.
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      const checkboxRows = dialog.querySelectorAll('[draggable="true"]');
      // Order in the chooser is `_id, apple, banana` — drag `banana` (index 2)
      // to the front (index 0).
      const dataTransfer = {};
      fireEvent.dragStart(checkboxRows[2], { dataTransfer });
      fireEvent.dragOver(checkboxRows[0], { dataTransfer });
      fireEvent.drop(checkboxRows[0], { dataTransfer });

      const idHeader = getByTestId('table-header-_id');
      const bananaHeader = getByTestId('table-header-banana');
      const appleHeader = getByTestId('table-header-apple');
      // `banana` must now render before both `_id` and `apple` in DOM order.
      const position = idHeader.compareDocumentPosition(bananaHeader);
      expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      const applePosition = appleHeader.compareDocumentPosition(bananaHeader);
      expect(applePosition & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });

    // AC8 — computed dotted-path column.
    it('a computed dotted-path column renders the nested value', () => {
      const { getByRole, container } = renderStatefulTable(
        stateWithDocs({
          lastRun: {
            documents: [{ _id: 1, address: { city: 'Springfield' } }],
            durationMs: 1,
            ranAt: '2026-01-01T00:00:00Z',
          },
        }),
      );

      fireEvent.click(getByRole('button', { name: /fields/i }));
      const input = getByRole('textbox', { name: /computed column path/i });
      fireEvent.change(input, { target: { value: 'address.city' } });
      fireEvent.click(getByRole('button', { name: /add column/i }));

      expect(container.textContent).toContain('Springfield');
      // Header for the computed column shows the path (no explicit label set).
      const headers = Array.from(container.querySelectorAll('[data-testid^="table-header-"]'));
      expect(headers.some((h) => h.textContent?.includes('address.city'))).toBe(true);
    });
  });

  // #20 — roving focus: the grid itself is the widget's only tab stop, and
  // arrow/Home/End move `aria-activedescendant` between mounted rows instead
  // of putting every row in the tab order.
  describe('roving focus (#20)', () => {
    // #72 — the four tests below all mounted the same 3-doc grid; the setup
    // was byte-identical each time (SonarCloud flagged it as a self-
    // duplicate). One fixture and one helper, kept behind the describe so it
    // can't leak into the Enter-selection tests below, which need their own
    // doc shapes.
    const THREE_DOCS = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }, { _id: 3, name: 'c' }];
    function renderGrid() {
      const { container } = renderTable(THREE_DOCS);
      return { container, grid: container.querySelector('[role="grid"]')! };
    }

    it('the grid is a tab stop and names row 0 as the active descendant', () => {
      const { container, grid } = renderGrid();

      expect(grid.getAttribute('tabindex')).toBe('0');
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-0');
      expect(container.querySelector('#table-row-0')).not.toBeNull();
    });

    it.each([
      { key: 'ArrowDown', description: 'ArrowDown moves the active descendant to the next row', expected: 'table-row-1' },
      { key: 'ArrowUp', description: 'ArrowUp from row 0 wraps to the last row', expected: 'table-row-2' },
    ])('$description', ({ key, expected }) => {
      const { grid } = renderGrid();

      fireEvent.keyDown(grid, { key });
      expect(grid.getAttribute('aria-activedescendant')).toBe(expected);
    });

    it('End jumps to the last row, Home jumps back to the first', () => {
      const { grid } = renderGrid();

      fireEvent.keyDown(grid, { key: 'End' });
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-2');
      fireEvent.keyDown(grid, { key: 'Home' });
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-0');
    });

    it('Enter on the grid itself selects the active row', () => {
      const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }];
      const { container } = renderTable(docs);
      const grid = container.querySelector('[role="grid"]')!;
      const rows = container.querySelectorAll('[data-selected]');

      fireEvent.keyDown(grid, { key: 'ArrowDown' });
      fireEvent.keyDown(grid, { key: 'Enter' });

      expect(rows[0].getAttribute('data-selected')).toBe('false');
      expect(rows[1].getAttribute('data-selected')).toBe('true');
    });

    it('E on the grid opens the editor on the active row; a modified E or one from a nested control does not', () => {
      const openEdit = vi.fn();
      const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }];
      const { container } = renderTable(docs, { actions: { openEdit } });
      const grid = container.querySelector('[role="grid"]')!;

      fireEvent.keyDown(grid, { key: 'ArrowDown' });
      fireEvent.keyDown(grid, { key: 'e', metaKey: true });
      fireEvent.keyDown(container.querySelector('[aria-label="Expand document"]')!, { key: 'e' });
      expect(openEdit).not.toHaveBeenCalled();

      fireEvent.keyDown(grid, { key: 'e' });
      expect(openEdit).toHaveBeenCalledWith(docs[1]);
    });

    // The mutation this guards against: dropping `e.target !== e.currentTarget`
    // at the grid level would make Enter on the row's own nested expand
    // button ALSO select the active row (mirrors the pre-existing guard on
    // the row strip's own onKeyDown, at the grid's level instead).
    it('Enter bubbling up from a nested button does not select the active row', () => {
      const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'a' }];
      const { container } = renderTable(docs);
      const chevron = container.querySelector('[aria-label="Expand document"]')!;
      const row = container.querySelector('[data-selected]')!;

      fireEvent.keyDown(chevron, { key: 'Enter' });
      expect(row.getAttribute('data-selected')).toBe('false');
    });

    // Found in review: `tabIndex={-1}` on the row strip excludes it from
    // *sequential* (Tab) focus but leaves it click-focusable per the HTML
    // focusing-steps algorithm. `fireEvent.click` (used everywhere else in
    // this file) does no focus management at all, so nothing here had ever
    // caught a real click actually moving DOM focus onto the row — only
    // `userEvent`'s `click` walks up to the nearest focusable ancestor the
    // way a real browser does, which is why this needs it specifically:
    // once focus is truly on the row, every later keydown reaches the grid
    // with `e.target` = the row, `e.currentTarget` = the grid, and
    // `useRovingFocus`'s own-target guard swallows it — Arrow/Home/End all
    // go dead until focus is moved again by hand.
    it('a real click on a row does not trap focus there — ArrowDown still moves the grid afterward', async () => {
      const user = userEvent.setup();
      const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }, { _id: 3, name: 'c' }];
      const { container } = renderTable(docs);
      const grid = container.querySelector('[role="grid"]')!;
      // Scoped to the grid, not `container` — #53 gives the sticky header
      // row its own `role="row"` too (for its `columnheader` children), and
      // it's a DOM sibling of the grid, not a descendant, so this excludes
      // it without depending on index order.
      const strip = grid.querySelectorAll('[role="row"]')[0] as HTMLElement;

      await user.click(strip);
      await user.keyboard('{ArrowDown}');

      expect(document.activeElement).toBe(grid);
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-1');
    });

    // Clicking a row should also make it the roving-focus target, so the
    // very next Arrow moves from the row just clicked — not from wherever
    // the highlight happened to be sitting before.
    it('clicking row 2 makes it the active row — ArrowDown moves to row 3, not row 1', async () => {
      const user = userEvent.setup();
      const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }, { _id: 3, name: 'c' }];
      const { container } = renderTable(docs);
      const grid = container.querySelector('[role="grid"]')!;
      // Scoped to the grid — see the note in the previous test.
      const strip = grid.querySelectorAll('[role="row"]')[1] as HTMLElement;

      await user.click(strip);
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-1');
      await user.keyboard('{ArrowDown}');
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-2');
    });

    // #55 — the shared ContextMenu had no keyboard open path; this cell menu
    // is TableView's own hand-rolled one (not the shared `ContextMenu`
    // component), so it needs its own keyboard trigger and focus management.
    describe('keyboard: opening the context menu (#55)', () => {
      it('Shift+F10 opens the menu for the active row, with Edit/Delete reachable', async () => {
        const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }];
        const { container, getByText } = renderTable(docs);
        const grid = container.querySelector('[role="grid"]')! as HTMLElement;

        fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });

        expect(await screen.findByText('Edit')).toBeTruthy();
        expect(getByText('Delete')).toBeTruthy();
      });

      it('the ContextMenu key opens the same menu', async () => {
        const docs = [{ _id: 1, name: 'a' }];
        const { container } = renderTable(docs);
        const grid = container.querySelector('[role="grid"]')! as HTMLElement;

        fireEvent.keyDown(grid, { key: 'ContextMenu' });

        expect(await screen.findByText('Edit')).toBeTruthy();
      });

      it('F10 without Shift does not open the menu', () => {
        const docs = [{ _id: 1, name: 'a' }];
        const { container, queryByText } = renderTable(docs);
        const grid = container.querySelector('[role="grid"]')! as HTMLElement;

        fireEvent.keyDown(grid, { key: 'F10', shiftKey: false });

        expect(queryByText('Edit')).toBeNull();
      });

      it('anchors the menu to the active row, not a stale {0,0}', async () => {
        const docs = [{ _id: 1, name: 'a' }];
        const { container } = renderTable(docs);
        const grid = container.querySelector('[role="grid"]')! as HTMLElement;
        const row = container.querySelector('#table-row-0')!;
        vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
          left: 42,
          bottom: 84,
          top: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 42,
          y: 84,
          toJSON: () => {},
        } as DOMRect);

        fireEvent.keyDown(grid, { key: 'ContextMenu' });

        const menu = await screen.findByRole('group', { name: 'Cell actions' });
        expect(menu.style.left).toBe('42px');
        expect(menu.style.top).toBe('84px');
      });

      it('focus enters the menu on open and Escape returns it to the grid', async () => {
        const docs = [{ _id: 1, name: 'a' }];
        const { container } = renderTable(docs);
        const grid = container.querySelector('[role="grid"]')! as HTMLElement;

        fireEvent.keyDown(grid, { key: 'ContextMenu' });
        await screen.findByRole('group', { name: 'Cell actions' });
        await waitFor(() =>
          expect(document.activeElement?.closest('[role="group"]')).toBeTruthy(),
        );

        // Same window-level Escape listener as the existing mouse-opened
        // menu (`:869`/`:973`) — must not regress it.
        fireEvent.keyDown(window, { key: 'Escape' });

        await waitFor(() => expect(document.activeElement).toBe(grid));
      });

      it('right-click does not force focus into the menu — unchanged from before #69', () => {
        const docs = [{ _id: 1, name: 'a' }];
        const { getByTitle, getByText } = renderTable(docs);
        const cell = getByTitle(/Drag to add "name/);

        fireEvent.contextMenu(cell);
        expect(getByText('Edit')).toBeTruthy();

        // A mouse open still doesn't grab focus into the menu the way a
        // keyboard open does (`focusMenuOnOpen` stays unset on this path) —
        // only the close-time restore below is new.
        expect(document.activeElement?.closest('[role="group"]')).toBeNull();
      });

      // #69 — right-click open, then Escape, used to strand focus on
      // `<body>` (nothing set `returnFocusTo` for a mouse open). Now both
      // open paths share the same mechanism.
      it('right-click open, then Escape, returns focus to the grid — not <body>', () => {
        const docs = [{ _id: 1, name: 'a' }];
        const { container, getByTitle, getByText } = renderTable(docs);
        const grid = container.querySelector('[role="grid"]')! as HTMLElement;
        const cell = getByTitle(/Drag to add "name/);

        fireEvent.contextMenu(cell);
        expect(getByText('Edit')).toBeTruthy();

        fireEvent.keyDown(window, { key: 'Escape' });

        expect(document.querySelector('[aria-label="Cell actions"]')).toBeNull();
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement).toBe(grid);
      });
    });
  });

  // #60 — the active row is announced (aria-activedescendant, #20) but was
  // never drawn. These assert the real inline outline, not an attribute.
  describe('active-row visual highlight (#60)', () => {
    it('no row is outlined before focus, the active row gains it on focus, ArrowDown moves it, blur clears it', () => {
      const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }, { _id: 3, name: 'c' }];
      const { container } = renderTable(docs);
      const grid = container.querySelector('[role="grid"]')! as HTMLElement;
      const rows = () => Array.from(grid.querySelectorAll<HTMLElement>('[role="row"]'));

      expectActiveRowOutlineLifecycle(grid, rows, { key: 'ArrowDown', from: 0, to: 1 });
    });

    it('a selected-and-active row shows both treatments; selected-but-not-active shows only the background', () => {
      const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }, { _id: 3, name: 'c' }];
      const { container } = renderTable(docs);
      const grid = container.querySelector('[role="grid"]')! as HTMLElement;
      const strip1 = grid.querySelectorAll('[role="row"]')[1] as HTMLElement;

      fireEvent.click(strip1, { metaKey: true }); // ⌘+click selects row 1 and makes it the active row too.
      act(() => grid.focus());

      const row1 = container.querySelector('#table-row-1') as HTMLElement;
      const outer1 = row1.parentElement!;
      expect(outer1.getAttribute('data-selected')).toBe('true');
      expect(row1.style.outline).toContain('2px');

      // Move the active row off row 1 — it stays selected, but the outline
      // must follow the active index, leaving only the background behind.
      fireEvent.keyDown(grid, { key: 'ArrowDown' });
      expect(outer1.getAttribute('data-selected')).toBe('true');
      expect(row1.style.outline).not.toContain('2px');
      expect(outer1.style.background).toContain('accent-soft');

      const row2 = container.querySelector('#table-row-2') as HTMLElement;
      expect(row2.style.outline).toContain('2px');
    });

    // The whole reason for driving the highlight from React instead of a
    // CSS descendant selector (`DocFieldTree` mounts *inside* an expanded
    // outer row — see `TableView.tsx:670`): a descendant selector keyed off
    // the outer grid's own `aria-activedescendant`/focus would paint this
    // nested tree's row too, even though the nested tree itself never had
    // focus. This test fails against that implementation.
    it('an expanded row\'s nested DocFieldTree never receives the outer grid\'s active-row outline', () => {
      const docs = [{ _id: 1, a: 1, b: 2 }, { _id: 2, a: 3, b: 4 }];
      const { container } = renderTable(docs, { expandedRows: { '1': true } });
      const grid = container.querySelector('[role="grid"]')! as HTMLElement;

      act(() => grid.focus());

      const outlined = Array.from(container.querySelectorAll<HTMLElement>('*')).filter((el) =>
        el.style.outline?.includes('2px'),
      );
      expect(outlined).toHaveLength(1);
      expect(outlined[0].id).toBe('table-row-0');
    });
  });

  // #53 — the sort mechanism (a real <button>) already worked; the sorted
  // header cell just never said so to assistive tech, and the hover-gated
  // pencil/expand affordances were invisible to a keyboard user who tabbed
  // onto them.
  describe('aria-sort and focus-visible affordances (#53)', () => {
    it('a sortable column header is a columnheader with aria-sort="none" while unsorted', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { getByTestId } = renderTable(docs, { onSortField: vi.fn() });
      const header = getByTestId('table-header-name');

      expect(header.getAttribute('role')).toBe('columnheader');
      expect(header.getAttribute('aria-sort')).toBe('none');
    });

    it('carries aria-sort="ascending" or "descending" for the actively sorted column', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const ascending = renderTable(docs, { onSortField: vi.fn(), sort: '{"name":1}' });
      expect(within(ascending.container).getByTestId('table-header-name').getAttribute('aria-sort')).toBe(
        'ascending',
      );
      ascending.unmount();

      const descending = renderTable(docs, { onSortField: vi.fn(), sort: '{"name":-1}' });
      expect(within(descending.container).getByTestId('table-header-name').getAttribute('aria-sort')).toBe(
        'descending',
      );
    });

    it('keyboard-activating the sort button cycles aria-sort ascending -> descending -> none', async () => {
      const user = userEvent.setup();
      function Harness() {
        const [sort, setSort] = React.useState('');
        return (
          <CollectionWorkspaceProvider state={emptyState()} actions={emptyWorkspaceActions()} meta={emptyWorkspaceMeta()}>
            <TableView
              documents={[{ _id: 1, name: 'alpha' }]}
              onColumnResize={vi.fn()}
              onSortField={(field) => setSort((s) => cycleSortField(s, field))}
              sort={sort}
            />
          </CollectionWorkspaceProvider>
        );
      }
      const { getByTestId, getByRole } = render(<Harness />);
      const header = getByTestId('table-header-name');
      const sortButton = getByRole('button', { name: 'name' });

      expect(header.getAttribute('aria-sort')).toBe('none');
      sortButton.focus();
      await user.keyboard('{Enter}');
      expect(header.getAttribute('aria-sort')).toBe('ascending');
      await user.keyboard('{Enter}');
      expect(header.getAttribute('aria-sort')).toBe('descending');
      await user.keyboard('{Enter}');
      expect(header.getAttribute('aria-sort')).toBe('none');
    });

    it('a non-sortable computed column header is still a columnheader but carries no aria-sort', () => {
      const docs = [{ _id: 1, address: { city: 'Springfield' } }];
      const columnConfig: CollectionTabState['columnConfig'] = {
        computed: [{ id: 'computed:address.city', path: 'address.city' }],
      };
      const { getByTestId } = renderTable(docs, { onSortField: vi.fn(), columnConfig });
      const header = getByTestId('table-header-computed:address.city');

      expect(header.getAttribute('role')).toBe('columnheader');
      expect(header.hasAttribute('aria-sort')).toBe(false);
    });

    it('a column with no onSortField at all is a columnheader with no aria-sort (view has sorting disabled)', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const { getByTestId } = renderTable(docs);
      const header = getByTestId('table-header-name');

      expect(header.getAttribute('role')).toBe('columnheader');
      expect(header.hasAttribute('aria-sort')).toBe(false);
    });

    it('a column hidden via the column chooser renders no header at all — no orphaned aria-sort', () => {
      const docs = [{ _id: 1, name: 'alpha' }];
      const columnConfig: CollectionTabState['columnConfig'] = { hidden: ['name'] };
      const { queryByTestId } = renderTable(docs, {
        onSortField: vi.fn(),
        sort: '{"name":1}',
        columnConfig,
      });

      expect(queryByTestId('table-header-name')).toBeNull();
    });

    it('focusing the expand-cell affordance makes it visible (WCAG 2.4.11), not just present', () => {
      const docs = [{ _id: 1, note: 'hello' }];
      const { getByTitle } = renderTable(docs);
      const cell = getByTitle(/Drag to add "note/);
      const expandBtn = within(cell).getByRole('button', { name: 'Expand cell value' }) as HTMLElement;

      // Baseline: nothing hovered/focused yet — the affordance exists (it's
      // always mounted) but is not visible. Asserting only `toBeTruthy()` on
      // the button, as the pre-existing expand test does, would pass whether
      // or not this fix is applied — the button is real either way. Opacity
      // is the actual property the hover path already drives (:171/:358), so
      // it's the one a focus path has to drive too.
      expect(expandBtn.style.opacity).toBe('0');
      expect(expandBtn.style.pointerEvents).toBe('none');

      // The button is already a real tab stop (never `tabIndex={-1}`), so
      // this reproduces exactly what a keyboard user tabbing onto it does.
      // `fireEvent.focus`, not a raw `.focus()` call: the visibility flip is
      // a React state update inside the `onFocus` handler this cell's
      // wrapping `gridcell` div carries, and only `fireEvent` wraps native
      // event dispatch in `act()` so that update is flushed before the next
      // assertion runs — a bare `element.focus()` schedules the same update
      // but leaves it unflushed, which is a false negative, not proof the
      // fix is missing (confirmed against a real probe: logging inside the
      // handler shows it firing either way; only the flushed DOM differs).
      // A Table cell's trigger stays a Tab stop; only the Tree leaf's opts out.
      expect(expandBtn.hasAttribute('tabindex')).toBe(false);
      fireEvent.focus(expandBtn);

      expect(expandBtn.style.opacity).toBe('1');
      expect(expandBtn.style.pointerEvents).toBe('auto');
    });

    it('blurring the expand-cell affordance hides it again (not stuck visible)', () => {
      const docs = [{ _id: 1, note: 'hello' }];
      const { getByTitle } = renderTable(docs);
      const cell = getByTitle(/Drag to add "note/);
      const expandBtn = within(cell).getByRole('button', { name: 'Expand cell value' }) as HTMLElement;

      fireEvent.focus(expandBtn);
      expect(expandBtn.style.opacity).toBe('1');
      fireEvent.blur(expandBtn);
      expect(expandBtn.style.opacity).toBe('0');
    });

    it('tabbing onto the edit-cell pencil affordance makes it visible', () => {
      const docs = [{ _id: 1, status: 'pending' }];
      const { getByTitle } = renderTable(docs, { actions: { updateField: vi.fn() } });
      const cell = getByTitle(/Drag to add "status/);
      const editBtn = within(cell).getByRole('button', { name: 'Edit cell value' }) as HTMLElement;

      expect(editBtn.style.opacity).toBe('0');
      fireEvent.focus(editBtn);
      expect(editBtn.style.opacity).toBe('1');
      expect(editBtn.style.pointerEvents).toBe('auto');
    });
  });

  // #79 — closing the "Expand cell value" popover on a click that lands on a
  // non-focusable area used to drop focus to <body>. `returnFocus` fixes it
  // here because this dropdown has no focusable content to autofocus (see
  // the prop's comment on `TableView.tsx`). Shared with column-chooser/
  // preview-picker specs — see the helper's docstring.
  describe('expand-cell popover — focus return on close (#79)', () => {
    itReturnsFocusToPopoverTrigger(async () => {
      const docs = [{ _id: 1, note: 'hello' }];
      const ctx = renderTable(docs);
      const cell = ctx.getByTitle(/Drag to add "note/);
      fireEvent.mouseEnter(cell);
      const trigger = within(cell).getByRole('button', { name: 'Expand cell value' });
      await userEvent.click(trigger);
      // No focusInside: this dropdown has no focusable content.
      return { trigger };
    });
  });

  // Table rows previously exposed Edit/Duplicate/Delete only via a
  // right-click context menu, unlike Tree/JSON's always-visible per-row
  // buttons. This adds a matching visible Edit/Delete pair plus a "More
  // actions" button that opens the same context menu, keeping it reachable
  // by keyboard and under horizontal scroll.
  describe('per-row actions column', () => {
    it('Edit and Delete buttons are named with the document and call the workspace actions', () => {
      const openEdit = vi.fn();
      const openDelete = vi.fn();
      const docs = [{ _id: 1, sku: 'a' }];
      const { getByRole } = renderTable(docs, { actions: { openEdit, openDelete } });

      fireEvent.click(getByRole('button', { name: 'Edit document 1' }));
      expect(openEdit).toHaveBeenCalledWith(docs[0]);

      fireEvent.click(getByRole('button', { name: 'Delete document 1' }));
      expect(openDelete).toHaveBeenCalledWith(docs[0]);
    });

    it('shows the Delete document tooltip when keyboard focus lands on the icon button', async () => {
      const { getByRole } = renderTable([{ _id: 1, sku: 'a' }]);

      fireEvent.focus(getByRole('button', { name: 'Delete document 1' }));

      const tip = await screen.findByRole('tooltip');
      expect(tip.textContent).toBe('Delete document');
    });

    it('is not a data column: FieldsControl lists no "Actions" entry', () => {
      const { getByRole, queryByRole } = renderStatefulTable(
        emptyState({
          lastRun: {
            documents: [{ _id: 1, sku: 'a' }],
            durationMs: 1,
            ranAt: '2026-01-01T00:00:00Z',
          },
        }),
      );

      fireEvent.click(getByRole('button', { name: /fields/i }));
      expect(queryByRole('checkbox', { name: /actions/i })).toBeNull();
    });

    it('clicking Edit or "More actions" does not move the active row or change selection', () => {
      const docs = [{ _id: 1, sku: 'a' }, { _id: 2, sku: 'b' }];
      const { getByRole, container } = renderTable(docs);
      // Excludes the header strip — it also carries `role="row"` (its
      // `columnheader` children need a valid row parent) but never
      // `data-selected`, only document rows do.
      const rows = () =>
        Array.from(
          container.querySelectorAll('[data-selected] [role="row"]'),
        ) as HTMLElement[];
      const grid = getByRole('grid');

      act(() => grid.focus());
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-0');

      // `aria-activedescendant` tracks the roving index itself, unlike the
      // visual outline — which also depends on the grid still holding real
      // DOM focus, and clicking any real button (this one included) moves
      // focus onto it regardless of `stopPropagation`. So this is the
      // signal that survives the click and actually proves the row 1
      // buttons never called `onSelect` for row 1.
      fireEvent.click(getByRole('button', { name: 'Edit document 2' }));
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-0');
      expect(rows()[1].getAttribute('aria-selected')).toBe('false');

      fireEvent.click(getByRole('button', { name: 'More actions for document 2' }));
      expect(grid.getAttribute('aria-activedescendant')).toBe('table-row-0');
      expect(rows()[1].getAttribute('aria-selected')).toBe('false');
    });

    it('"More actions" opens the same cell-level menu the right-click path opens, including Duplicate', () => {
      const openDuplicate = vi.fn();
      const docs = [{ _id: 1, sku: 'a' }];
      const { getByRole } = renderTable(docs, { actions: { openDuplicate } });

      fireEvent.click(getByRole('button', { name: 'More actions for document 1' }));

      const menu = getByRole('group', { name: 'Cell actions' });
      expect(within(menu).getByText('Duplicate document')).toBeTruthy();

      fireEvent.click(within(menu).getByText('Duplicate document'));
      expect(openDuplicate).toHaveBeenCalledWith(docs[0]);
    });

    it('focusing the Edit button on a non-active row makes the actions column visible', () => {
      const docs = [{ _id: 1, sku: 'a' }];
      const { getByRole } = renderTable(docs);
      const editBtn = getByRole('button', { name: 'Edit document 1' }) as HTMLElement;
      const actionsCell = editBtn.closest('[role="gridcell"]') as HTMLElement;

      expect(actionsCell.style.opacity).toBe('0');
      fireEvent.focus(editBtn);
      expect(actionsCell.style.opacity).toBe('1');
      fireEvent.blur(editBtn);
      expect(actionsCell.style.opacity).toBe('0');
    });
  });
});

function clipboardWriteTextWasCalled(): boolean {
  const mock = navigator.clipboard.writeText as unknown as { mock?: { calls: unknown[] } };
  return (mock.mock?.calls.length ?? 0) > 0;
}
