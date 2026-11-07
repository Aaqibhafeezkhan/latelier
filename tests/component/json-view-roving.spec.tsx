import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, within, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { JsonView } from '../../src/pages/Workspace/views/JsonView';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionTabState } from '@shared/types';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';

const DOCS = [
  { _id: 1, name: 'alpha' },
  { _id: 2, name: 'beta' },
  { _id: 3, name: 'gamma' },
];

function renderJson(docs: unknown[] = DOCS, meta: Partial<CollectionWorkspaceMeta> = {}) {
  const actions = emptyWorkspaceActions();
  const state: CollectionTabState = {
    view: 'JSON',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  };
  const utils = render(
    <CollectionWorkspaceProvider state={state} actions={actions} meta={emptyWorkspaceMeta(meta)}>
      <JsonView documents={docs} />
    </CollectionWorkspaceProvider>,
  );
  const tree = screen.getByRole('tree', { name: 'Documents' });
  const card = (n: number) => screen.getByRole('treeitem', { name: `Document ${n}` });
  return { ...utils, actions, tree, card };
}

// The JSON view's cards join Table and Tree's keyboard model: the list is one
// tab stop, `aria-activedescendant` names the active card, and that card is
// outlined while the list has focus.
describe('JsonView — active row', () => {
  it('is one tab stop naming the first card', () => {
    const { tree, card } = renderJson();
    expect(tree.getAttribute('tabindex')).toBe('0');
    expect(tree.getAttribute('aria-activedescendant')).toBe(card(1).id);
    expect(card(1).id).toBe('json-row-0');
    for (const n of [1, 2, 3]) expect(card(n).getAttribute('tabindex')).toBe('-1');
  });

  // One tab stop per widget (X19): of every control inside the cards, only the
  // roving card's are tabbable (its buttons and its brace collapse toggles), and
  // the set moves with the arrow keys.
  it('only the active card\'s controls are in the Tab order, and they follow the arrows', () => {
    const { tree, card } = renderJson();
    const cardsOfTabbable = () =>
      [...tree.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter((el) => el.getAttribute('tabindex') !== '-1')
        .map((el) => el.closest('[role="treeitem"]')!.id);

    const inCard0 = cardsOfTabbable();
    expect(inCard0.length).toBeGreaterThan(5);
    expect(new Set(inCard0)).toEqual(new Set([card(1).id]));

    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(new Set(cardsOfTabbable())).toEqual(new Set([card(2).id]));
    expect(cardsOfTabbable()).toHaveLength(inCard0.length);
  });

  it('each card is a treeitem whose nearest role-bearing ancestor is the tree', () => {
    const { tree, card } = renderJson();
    for (const n of [1, 2, 3]) expect(card(n).parentElement!.closest('[role]')).toBe(tree);
  });

  it('a click makes the clicked card active and outlines it', async () => {
    const { tree, card } = renderJson();
    expect(card(2).style.outline).toBe('');

    await userEvent.click(card(2));

    expect(document.activeElement).toBe(tree);
    expect(tree.getAttribute('aria-activedescendant')).toBe(card(2).id);
    expect(card(2).style.outline).toContain('solid');
    expect(card(1).style.outline).toBe('');
  });

  it('ArrowDown moves the active card, and the outline with it', async () => {
    const { tree, card } = renderJson();
    await userEvent.click(card(1));

    fireEvent.keyDown(tree, { key: 'ArrowDown' });

    expect(tree.getAttribute('aria-activedescendant')).toBe(card(2).id);
    expect(card(2).style.outline).toContain('solid');
    expect(card(1).style.outline).toBe('');
  });

  it('E on the list edits the active card', async () => {
    const { tree, card, actions } = renderJson();
    await userEvent.click(card(1));
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });

    fireEvent.keyDown(tree, { key: 'e' });

    expect(actions.openEdit).toHaveBeenCalledTimes(1);
    expect(actions.openEdit).toHaveBeenCalledWith(DOCS[2]);
  });

  it('D on the list deletes the active card', async () => {
    const { tree, card, actions } = renderJson();
    await userEvent.click(card(1));
    fireEvent.keyDown(tree, { key: 'ArrowDown' });

    fireEvent.keyDown(tree, { key: 'd', ctrlKey: true });
    expect(actions.openDelete).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: 'd' });
    expect(actions.openDelete).toHaveBeenCalledWith(DOCS[1]);
  });

  it.each([{ isView: true }, { isReadOnly: true }])('D does nothing when %o', (meta) => {
    const { tree, actions } = renderJson(DOCS, meta);

    fireEvent.keyDown(tree, { key: 'd' });

    expect(actions.openDelete).not.toHaveBeenCalled();
  });

  it('Shift+F10 opens the document menu for the active card', async () => {
    const { tree, card } = renderJson();
    await userEvent.click(card(2));

    fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });

    expect(screen.getByRole('group', { name: 'Document actions' })).toBeTruthy();
  });

  it('Enter does not edit, select or open anything', async () => {
    const { tree, card, actions } = renderJson();
    await userEvent.click(card(2));

    fireEvent.keyDown(tree, { key: 'Enter' });

    expect(actions.openEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Document actions' })).toBeNull();
    expect(tree.getAttribute('aria-activedescendant')).toBe(card(2).id);
  });

  it('a plain click does not select; ⌘/Ctrl-click still toggles selection', async () => {
    const { card } = renderJson();
    const toggle = () => within(card(2)).getByRole('button', { name: /^(Select|Deselect) document 2$/ });

    await userEvent.click(card(2));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(card(2), { metaKey: true });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(card(2), { ctrlKey: true });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('JsonView — Space does not page-scroll the list', () => {
  it('prevents the default action of Space on the list', async () => {
    const { tree, card } = renderJson();
    await userEvent.click(card(1));
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    tree.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
