import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import { SuggestionPopover } from '../../src/features/fieldSuggestions/SuggestionPopover';
import type { Suggestion } from '../../src/features/fieldSuggestions/types';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { fieldOperatorSource } from '../../src/features/fieldSuggestions/sources/operatorSource';
import { HintsContext, type HintsContextValue } from '../../src/hints/HintsContext';

function Harness({
  items,
  onSelect = () => {},
  open = true,
  groupOperators,
}: {
  items: Suggestion[];
  onSelect?: (s: Suggestion) => void;
  open?: boolean;
  groupOperators?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div>
      <input ref={inputRef} data-testid="anchor" />
      <SuggestionPopover
        items={items}
        anchorRef={inputRef}
        open={open}
        onSelect={onSelect}
        onClose={() => {}}
        groupOperators={groupOperators}
      />
    </div>
  );
}

describe('SuggestionPopover side panel', () => {
  beforeEach(() => {
    installAtelierMock();
  });

  afterEach(() => {
    uninstallAtelierMock();
  });

  it('renders the side doc panel when the highlighted item is an operator with docs', () => {
    const items: Suggestion[] = [
      {
        kind: 'operator',
        name: '$match',
        class: 'stage',
        source: 'operators',
        description: 'Filters the pipeline so that only documents matching the query pass.',
        syntax: '{ $match: <query> }',
        example: '{ $match: { status: "active" } }',
        url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/',
      },
    ];
    render(<Harness items={items} />);
    expect(screen.getByLabelText('Documentation for $match')).toBeTruthy();
  });

  it('does not render the side doc panel for field suggestions', () => {
    const items: Suggestion[] = [
      { kind: 'field', path: 'name', source: 'schema' },
      { kind: 'field', path: 'age', source: 'schema' },
    ];
    render(<Harness items={items} />);
    expect(screen.queryByLabelText(/Documentation for/)).toBeNull();
  });

  it('mounts and unmounts the panel when the highlight moves between operator and field', () => {
    const items: Suggestion[] = [
      { kind: 'field', path: 'status', source: 'schema' },
      {
        kind: 'operator',
        name: '$match',
        class: 'stage',
        source: 'operators',
        description: 'Filters documents.',
        syntax: '{ $match: <query> }',
        example: '{ $match: {} }',
        url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/',
      },
    ];
    render(<Harness items={items} />);

    // First item (field) highlighted by default — no panel.
    expect(screen.queryByLabelText(/Documentation for/)).toBeNull();

    // Hover the second (operator) row → highlight moves → panel appears.
    const operatorRow = screen.getByText('$match').closest('[role="option"]')!;
    fireEvent.mouseEnter(operatorRow);
    expect(screen.getByLabelText('Documentation for $match')).toBeTruthy();

    // Hover back to the field row → panel unmounts.
    const fieldRow = screen.getByText('status').closest('[role="option"]')!;
    fireEvent.mouseEnter(fieldRow);
    expect(screen.queryByLabelText(/Documentation for/)).toBeNull();
  });
});

/**
 * The auto-highlight must not swallow Enter.
 *
 * The popover binds its keys to the anchor input, so every caller (the query
 * bar's projection/sort inputs, the drawer's cond rows, the filter textarea)
 * shares this rule. Before the fix, a user typing a complete `{ name: 1 }`
 * and pressing Enter to commit got `{ name: 1 }_id`: the popover took the key
 * and inserted whatever ranked first in a list the user never looked at.
 *
 * Both directions are asserted deliberately. "Enter doesn't select" alone
 * would also pass against a popover that had stopped handling Enter at all,
 * which would break the one flow keyboard users actually rely on.
 */
describe('SuggestionPopover — Enter only selects an actively chosen item', () => {
  beforeEach(() => {
    installAtelierMock();
  });

  afterEach(() => {
    uninstallAtelierMock();
  });

  const items: Suggestion[] = [
    { kind: 'field', path: 'name', source: 'schema' },
    { kind: 'field', path: 'nickname', source: 'schema' },
  ];

  it('leaves Enter to the input when the list was never walked', () => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    // The first row is tinted for display, but it does NOT claim to be
    // selected — W15 §5. An earlier revision left `aria-selected="true"` here
    // while Enter deliberately refused to act on it, which told a screen-reader
    // user an option was selected that pressing Enter would not take.
    expect(screen.getByText('name').closest('[role="option"]')?.getAttribute('aria-selected'))
      .toBe('false');

    const anchor = screen.getByTestId('anchor');
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    anchor.dispatchEvent(evt);

    // … but it isn't a selection: nothing inserted, and the key is left
    // unprevented so the input's own commit-on-Enter still runs.
    expect(picked).toEqual([]);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('selects the highlighted item once the user has arrowed to it', () => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    anchor.dispatchEvent(evt);

    expect(picked.map((s) => (s.kind === 'field' ? s.path : ''))).toEqual(['nickname']);
    expect(evt.defaultPrevented).toBe(true);
  });

  // ⌘/Ctrl+Enter is Run, never Select. The popover used to take it
  // as a pick, and the key then bubbled on to the Run handler, so one press
  // both inserted the suggestion and ran the query.
  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
  ])('leaves %s+Enter to the Run handler even after arrowing', (_name, mod) => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mod });
    anchor.dispatchEvent(evt);

    expect(picked).toEqual([]);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('claims aria-selected exactly when Enter would take the row', () => {
    // The other half of the acceptance criterion. Asserting only "false before
    // ArrowDown" would also pass against a popover that had stopped setting
    // `aria-selected` at all, which is a different bug with the same shape.
    render(<Harness items={items} onSelect={() => {}} />);
    const selected = () =>
      screen.getAllByRole('option').map((el) => el.getAttribute('aria-selected'));

    expect(selected()).toEqual(['false', 'false']);

    fireEvent.keyDown(screen.getByTestId('anchor'), { key: 'ArrowDown' });
    expect(selected()).toEqual(['false', 'true']);
  });

  it('stands the engagement down when the list is rebuilt under it', () => {
    // The user arrows to a row, then types another character: `useSuggestions`
    // re-ranks and hands back a new list, so the row they chose is no longer
    // the row they chose. Enter has to go back to the input.
    const picked: Suggestion[] = [];
    const { rerender } = render(<Harness items={items} onSelect={(s) => picked.push(s)} />);
    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });

    rerender(<Harness items={[...items]} onSelect={(s) => picked.push(s)} />);
    fireEvent.keyDown(anchor, { key: 'Enter' });

    expect(picked).toEqual([]);
  });

  it('stands the engagement down when the popover closes and reopens', () => {
    // Escape (or a blur) and then refocus with the same text: `items` keeps
    // its identity, so `open` is the only thing that says "this is a fresh
    // popover". Without that half, Enter would select on reopen.
    const picked: Suggestion[] = [];
    const props = { items, onSelect: (s: Suggestion) => picked.push(s) };
    const { rerender } = render(<Harness {...props} />);
    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });

    rerender(<Harness {...props} open={false} />);
    rerender(<Harness {...props} open />);
    fireEvent.keyDown(anchor, { key: 'Enter' });

    expect(picked).toEqual([]);
  });

  it('still selects on Tab without arrowing — Tab means "complete this"', () => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    fireEvent.keyDown(screen.getByTestId('anchor'), { key: 'Tab' });

    expect(picked.map((s) => (s.kind === 'field' ? s.path : ''))).toEqual(['name']);
  });
});

// Escape belongs to the innermost thing on screen. The list claims it only
// while it is showing — `defaultPrevented` for a bubble-phase host (the
// Fields control's popover), and `data-mantine-stop-propagation` on the input
// for a Mantine Modal/Drawer, whose capture-phase window listener runs first
// and skips a target carrying that attribute.
describe('SuggestionPopover — Escape layering', () => {
  const ITEMS: Suggestion[] = [{ kind: 'field', path: 'name', source: 'schema' }];

  it('claims Escape and marks the input while the list is showing', () => {
    render(<Harness items={ITEMS} />);
    const anchor = screen.getByTestId('anchor');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(anchor.getAttribute('data-mantine-stop-propagation')).toBe('true');
    expect(fireEvent.keyDown(anchor, { key: 'Escape' })).toBe(false); // prevented
  });

  it('leaves Escape to the host, and the input unmarked, when nothing is showing', () => {
    render(<Harness items={[]} />);
    const anchor = screen.getByTestId('anchor');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(anchor.hasAttribute('data-mantine-stop-propagation')).toBe(false);
    expect(fireEvent.keyDown(anchor, { key: 'Escape' })).toBe(true); // not prevented
  });

  it('unmarks the input when the list closes', () => {
    const { rerender } = render(<Harness items={ITEMS} />);
    const anchor = screen.getByTestId('anchor');
    expect(anchor.getAttribute('data-mantine-stop-propagation')).toBe('true');
    rerender(<Harness items={ITEMS} open={false} />);
    expect(anchor.hasAttribute('data-mantine-stop-propagation')).toBe(false);
  });
});

describe('SuggestionPopover — keyboard hint footer', () => {
  const ITEMS: Suggestion[] = [
    { kind: 'field', path: 'name', source: 'schema' },
    { kind: 'field', path: 'age', source: 'schema' },
  ];

  function hintsStub(overrides: Partial<HintsContextValue> = {}): HintsContextValue {
    return {
      loaded: true,
      settled: true,
      isDismissed: () => false,
      dismiss: vi.fn(),
      reset: () => {},
      registerCandidate: () => {},
      unregisterCandidate: () => {},
      visibleId: null,
      recordSessionEvent: () => {},
      getSessionEventCount: () => 0,
      ...overrides,
    };
  }

  function renderWithHints(hints: HintsContextValue, onSelect = vi.fn()) {
    render(
      <HintsContext.Provider value={hints}>
        <Harness items={ITEMS} onSelect={onSelect} />
      </HintsContext.Provider>,
    );
    return onSelect;
  }

  const footer = () => screen.queryByRole('note', { name: 'Navigate suggestions' });

  it('shows the keys under the list, outside the listbox', () => {
    renderWithHints(hintsStub());
    const note = footer();
    expect(note?.textContent).toBe('Tab inserts the highlighted item. ↑↓ to pick another, then Enter or Tab. Esc to close.');
    expect(screen.getByRole('listbox').contains(note)).toBe(false);
  });

  it('dismisses the hint on the first pick by click, and still selects', () => {
    const hints = hintsStub();
    const onSelect = renderWithHints(hints);
    fireEvent.click(screen.getByRole('option', { name: /age/ }));
    expect(hints.dismiss).toHaveBeenCalledExactlyOnceWith('suggestions.keyboard');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(ITEMS[1]);
  });

  it('dismisses the hint on a pick by Tab', () => {
    const hints = hintsStub();
    const onSelect = renderWithHints(hints);
    fireEvent.keyDown(screen.getByTestId('anchor'), { key: 'Tab' });
    expect(hints.dismiss).toHaveBeenCalledExactlyOnceWith('suggestions.keyboard');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(ITEMS[0]);
  });

  it('shows no footer, and dismisses nothing, once the hint is dismissed', () => {
    const hints = hintsStub({ isDismissed: (id) => id === 'suggestions.keyboard' });
    renderWithHints(hints);
    expect(footer()).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /age/ }));
    expect(hints.dismiss).not.toHaveBeenCalled();
  });

  it('shows no footer before the hint state has loaded', () => {
    renderWithHints(hintsStub({ loaded: false }));
    expect(footer()).toBeNull();
  });

  it('shows no footer without a hints provider', () => {
    render(<Harness items={ITEMS} />);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(footer()).toBeNull();
  });

  it('keeps a mousedown on the footer from blurring the input', () => {
    renderWithHints(hintsStub());
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    footer()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

/**
 * The builder's operator picker groups its rows by class while the box is
 * blank. The grouping is presentation only: the highlight, Enter and the ARIA
 * selection keep walking one flat list.
 */
describe('SuggestionPopover — grouped operators', () => {
  beforeEach(() => {
    installAtelierMock();
  });

  afterEach(() => {
    uninstallAtelierMock();
  });

  // The builder's real list.
  const fieldOps = async () => (await fieldOperatorSource({} as never)) as Suggestion[];

  // `getByText('$nin')` also matches the `$nin` that a description spells out.
  const optionNamed = (name: string) =>
    screen.getAllByRole('option').find((o) => o.querySelector('span')?.textContent === name)!;

  it('renders a header per class, in order, with each option inside its group', async () => {
    render(<Harness items={await fieldOps()} groupOperators />);

    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-labelledby')).every(Boolean)).toBe(true);
    const headers = groups.map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)!);
    expect(headers.map((h) => h.textContent)).toEqual([
      'Comparison',
      'Logical',
      'Element',
      'Evaluation',
      'Array',
      'Geospatial',
    ]);
    const optionsIn = (g: HTMLElement) =>
      Array.from(g.querySelectorAll('[role="option"]')).map(
        (o) => o.querySelector('span')!.textContent,
      );
    expect(optionsIn(groups[0]!)).toEqual(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);
    expect(optionsIn(groups[1]!)).toEqual(['$not']);
    expect(optionsIn(groups[5]!)).toEqual(['$geoWithin', '$geoIntersects', '$near', '$nearSphere']);
    // Headers are labels, not options, and sit in the listbox itself.
    expect(headers.every((h) => h.getAttribute('role') === null)).toBe(true);
    expect(screen.getByRole('listbox').contains(groups[0]!)).toBe(true);
  });

  it('walks the highlight across a group boundary as one flat list', async () => {
    const picked: Suggestion[] = [];
    render(<Harness items={await fieldOps()} groupOperators onSelect={(s) => picked.push(s)} />);
    const anchor = screen.getByTestId('anchor');

    // $eq is row 0; seven ArrowDowns reach $nin, the last Comparison row.
    for (let i = 0; i < 7; i++) fireEvent.keyDown(anchor, { key: 'ArrowDown' });
    expect(optionNamed('$nin').getAttribute('aria-selected')).toBe('true');
    // One more crosses into the next group's first row, skipping the header.
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });
    expect(optionNamed('$not').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);

    fireEvent.keyDown(anchor, { key: 'Enter' });
    expect(picked.map((s) => (s.kind === 'operator' ? s.name : ''))).toEqual(['$not']);
  });

  it('shows the flat list, with no headers, when the caller does not ask for groups', async () => {
    // The typed-token case: the builder passes `groupOperators={false}` and
    // the list is a relevance ranking, which headers would misrepresent.
    render(<Harness items={await fieldOps()} groupOperators={false} />);
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(20);
  });

  it('never groups by default, as aggregation callers expect', async () => {
    render(<Harness items={await fieldOps()} />);
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });

  it('leaves non-operator rows outside any group', () => {
    const items: Suggestion[] = [
      { kind: 'field', path: 'name', source: 'schema' },
      { kind: 'operator', name: '$eq', class: 'query', source: 'operators' },
    ];
    render(<Harness items={items} groupOperators />);
    const group = screen.getByRole('group');
    expect(group.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(group.contains(screen.getByText('name'))).toBe(false);
  });
});
