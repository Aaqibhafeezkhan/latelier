import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, within, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { JsonView } from '../../src/pages/Workspace/views/JsonView';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionTabState } from '@shared/types';

let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});
afterEach(() => {
  // Always restore: if `originalClipboard` was undefined (jsdom default),
  // delete our injected property so the mocked clipboard doesn't leak into
  // later tests in the same worker.
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});

function emptyState(): CollectionTabState {
  return {
    view: 'JSON',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  };
}

function renderJson(
  docs: unknown[],
  overrides?: { state?: Partial<CollectionTabState>; actions?: ReturnType<typeof emptyWorkspaceActions> },
) {
  const actions = overrides?.actions ?? emptyWorkspaceActions();
  return {
    ...render(
      <CollectionWorkspaceProvider
        state={{ ...emptyState(), ...overrides?.state }}
        actions={actions}
        meta={emptyWorkspaceMeta()}
      >
        <JsonView documents={docs} />
      </CollectionWorkspaceProvider>
    ),
    actions,
  };
}

/**
 * P1-11 coverage for JsonView. Smoke-tests document rendering and the
 * EJSON-aware serialization (BSON typed values must surface their sentinel
 * form in the JSON pretty-print).
 */
describe('JsonView — rendering', () => {
  it('renders one card per document with the document keys visible', () => {
    const docs = [
      { _id: 1, name: 'alpha' },
      { _id: 2, name: 'beta' },
    ];
    const { container } = renderJson(docs);
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
    expect(container.textContent).toContain('name');
  });

  it('serializes BSON-typed values using canonical EJSON sentinels', () => {
    const docs = [
      {
        _id: { $oid: '507f1f77bcf86cd799439011' },
        createdAt: { $date: { $numberLong: '1735689600000' } },
      },
    ];
    const { container } = renderJson(docs);
    // EJSON canonical output must surface the type tags as text.
    expect(container.textContent).toContain('$oid');
    expect(container.textContent).toContain('$date');
  });

  it('shows the Copy JSON tooltip when keyboard focus lands on the icon button', async () => {
    renderJson([{ _id: 1, sku: 'a' }]);

    fireEvent.focus(screen.getByRole('button', { name: /^Copy JSON for document/ }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Copy JSON');
  });

  it('the Select button carries no nested interactive controls (nested-interactive / S6852)', () => {
    const docs = [{ _id: 1, name: 'alpha' }];
    renderJson(docs);
    const selectBtn = screen.getByRole('button', { name: 'Select document 1' });
    expect(within(selectBtn).queryAllByRole('button')).toHaveLength(0);
  });
});

/**
 * JSON honors the Fields control's hidden top-level fields.
 */
describe('JsonView — hidden fields', () => {
  it('omits a hidden top-level field from the rendered JSON', () => {
    const docs = [{ _id: 1, name: 'alpha', secret: 'shh' }];
    const { container } = renderJson(docs, {
      state: { columnConfig: { hidden: ['secret'] } },
    });
    expect(container.textContent).toContain('name');
    expect(container.textContent).not.toContain('secret');
    expect(container.textContent).not.toContain('shh');
  });

  it('shows a "N fields hidden" note reflecting the hidden count', () => {
    const docs = [{ _id: 1, name: 'alpha', secret: 'shh', other: 1 }];
    const { container } = renderJson(docs, {
      state: { columnConfig: { hidden: ['secret', 'other'] } },
    });
    expect(container.textContent).toContain('2 fields hidden');
  });

  it('shows no hidden-fields note when nothing is hidden', () => {
    const docs = [{ _id: 1, name: 'alpha' }];
    const { container } = renderJson(docs);
    expect(container.textContent).not.toContain('field hidden');
    expect(container.textContent).not.toContain('fields hidden');
  });

  it('still hands the FULL document (including hidden fields) to Edit', async () => {
    const docs = [{ _id: 1, name: 'alpha', secret: 'shh' }];
    const { actions } = renderJson(docs, {
      state: { columnConfig: { hidden: ['secret'] } },
    });
    await userEvent.click(screen.getByRole('button', { name: /^Edit document/ }));
    expect(actions.openEdit).toHaveBeenCalledWith(docs[0]);
  });

  it('E with focus inside a card opens the editor on that card', () => {
    const docs = [{ _id: 1, name: 'alpha' }, { _id: 2, name: 'beta' }];
    const { actions } = renderJson(docs);
    const card = screen.getByRole('treeitem', { name: 'Document 2' });

    fireEvent.keyDown(within(card).getByRole('button', { name: /^Copy JSON/ }), { key: 'e', ctrlKey: true });
    expect(actions.openEdit).not.toHaveBeenCalled();
    fireEvent.keyDown(within(card).getByRole('button', { name: /^Copy JSON/ }), { key: 'e' });
    expect(actions.openEdit).toHaveBeenCalledWith(docs[1]);
  });

  it('still copies the FULL document (including hidden fields)', async () => {
    const docs = [{ _id: 1, name: 'alpha', secret: 'shh' }];
    renderJson(docs, { state: { columnConfig: { hidden: ['secret'] } } });
    await userEvent.click(screen.getByRole('button', { name: /^Copy JSON/ }));
    const written = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(written).toContain('secret');
    expect(written).toContain('shh');
  });

  it('resets collapse state when hiding a field shifts group node ids', async () => {
    // `_id` is a string, not a number, so it doesn't get its own EJSON
    // wrapper group. Node ids are assigned in token order over `{`/`[`
    // tokens, so with nothing hidden: document=0, a=1, b=2, c=3.
    const docs = [
      { _id: 'id1', a: { w: 'wvalue' }, b: { y: 'yvalue' }, c: { z: 'zvalue' } },
    ];
    const { rerender } = renderJson(docs);

    // Collapse 'b' (id 2) — its content 'yvalue' should disappear.
    const collapseButtons = screen.getAllByRole('button', { name: 'Collapse' });
    await userEvent.click(collapseButtons[2]!);
    expect(screen.queryByText(/yvalue/)).toBeNull();

    // Hiding 'a' removes an earlier group, so ids shift: document=0, b=1,
    // c=2. Without a reset, the stale `docKey:2` collapse key now matches
    // 'c' instead of 'b'.
    rerender(
      <CollectionWorkspaceProvider
        state={{ ...emptyState(), columnConfig: { hidden: ['a'] } }}
        actions={emptyWorkspaceActions()}
        meta={emptyWorkspaceMeta()}
      >
        <JsonView documents={docs} />
      </CollectionWorkspaceProvider>,
    );

    // Both b and c must render expanded — collapse state should not have
    // silently moved onto 'c'.
    expect(screen.getByText(/yvalue/)).toBeTruthy();
    expect(screen.getByText(/zvalue/)).toBeTruthy();
  });
});

// N4.1 — a plain click used to toggle the card into/out of the multi-
// selection; that surprised anyone who'd learned Table or Tree's own click
// behavior first. The checkbox (or ⌘/Ctrl+click) is now the only way in.
describe('JsonView — click selection semantics (N4.1)', () => {
  it('a plain click on the card does not select it', () => {
    const docs = [{ _id: 1, name: 'alpha' }];
    const { container, getByText } = renderJson(docs);

    fireEvent.click(getByText('"alpha"'));

    expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it('⌘/Ctrl+click on the card still toggles the selection', () => {
    const docs = [{ _id: 1, name: 'alpha' }];
    const { getByText, getByRole } = renderJson(docs);

    fireEvent.click(getByText('"alpha"'), { metaKey: true });

    expect(getByRole('button', { name: 'Deselect document 1' })).toBeTruthy();
  });
});

// Edit/Delete already had their own visible per-card buttons here; this adds
// a "More actions" button for parity with Table's context menu (Duplicate).
describe('JsonView — "More actions" per-card menu', () => {
  it('opens a menu with Duplicate, and calls the workspace action on click', () => {
    const openDuplicate = vi.fn();
    const docs = [{ _id: 1, name: 'alpha' }];
    const { getByRole } = renderJson(docs, {
      actions: emptyWorkspaceActions({ openDuplicate }),
    });

    fireEvent.click(getByRole('button', { name: 'More actions for document 1' }));
    const menu = getByRole('group', { name: 'Document actions' });
    fireEvent.click(within(menu).getByText('Duplicate document'));

    expect(openDuplicate).toHaveBeenCalledWith(docs[0]);
  });

  it('omits Duplicate when the workspace has no openDuplicate action wired', () => {
    const docs = [{ _id: 1, name: 'alpha' }];
    const { getByRole, queryByText } = renderJson(docs);

    fireEvent.click(getByRole('button', { name: 'More actions for document 1' }));
    expect(queryByText('Duplicate document')).toBeNull();
  });

  it('does not toggle the card into the selection', () => {
    const docs = [{ _id: 1, name: 'alpha' }];
    const { getByRole } = renderJson(docs);

    fireEvent.click(getByRole('button', { name: 'More actions for document 1' }));
    expect(getByRole('button', { name: 'Select document 1' })).toBeTruthy();
  });
});
