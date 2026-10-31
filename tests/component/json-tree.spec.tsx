import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import { JsonTree } from '../../src/pages/Workspace/Aggregation/JsonTree';

// Partial mock: wraps the real `toDisplayValue` in a spy so we can assert
// *which* node values got re-evaluated after a toggle, without changing its
// behavior for any other test in this file.
vi.mock('../../src/utils/displayValue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/displayValue')>();
  return { ...actual, toDisplayValue: vi.fn(actual.toDisplayValue) };
});

import { toDisplayValue } from '../../src/utils/displayValue';

describe('JsonTree', () => {
  it('renders top-level keys, with nested objects collapsed by default', () => {
    render(<JsonTree value={{ a: { b: 1 }, c: 'hello' }} />);

    // Top-level keys are visible without any interaction.
    expect(screen.getByText('a:')).toBeTruthy();
    expect(screen.getByText('c:')).toBeTruthy();

    // Nested child `b` is not rendered until `a` is expanded.
    expect(screen.queryByText('b:')).toBeNull();
  });

  it('clicking a node Expand toggle reveals its children', () => {
    render(<JsonTree value={{ a: { b: 1 } }} />);

    const expandBtn = screen.getByRole('button', { name: 'Expand' });
    fireEvent.click(expandBtn);

    expect(screen.getByText('b:')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();

    // Toggle collapses back.
    const collapseBtn = screen.getByRole('button', { name: 'Collapse' });
    fireEvent.click(collapseBtn);
    expect(screen.queryByText('b:')).toBeNull();
  });

  it('the expand toggle reports aria-expanded, and a clipped leaf value carries its full text as a title', () => {
    render(<JsonTree value={{ a: { long: 'x'.repeat(200) } }} />);

    const toggle = screen.getByRole('button', { name: 'Expand' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded')).toBe('true');

    const full = `"${'x'.repeat(200)}"`;
    expect(screen.getByText(full).getAttribute('title')).toBe(full);
  });

  it('renders array nodes with index keys, collapsed by default', () => {
    render(<JsonTree value={{ arr: [1, 2, 3] }} />);
    expect(screen.getByText('arr:')).toBeTruthy();
    expect(screen.queryByText('0:')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('0:')).toBeTruthy();
    expect(screen.getByText('1:')).toBeTruthy();
    expect(screen.getByText('2:')).toBeTruthy();
  });

  it('formats leaf types: strings quoted, numbers/booleans/null bare', () => {
    render(
      <JsonTree
        value={{ str: 'hi', num: 42, bool: true, nil: null }}
      />,
    );
    expect(screen.getByText('"hi"')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
    expect(screen.getAllByText('null').length).toBeGreaterThan(0);
  });

  it('formats EJSON leaf shapes via toDisplayValue (objectid, date)', () => {
    render(
      <JsonTree
        value={{
          oid: { $oid: '507f1f77bcf86cd799439011' },
          d: { $date: '2024-01-15T12:00:00.000Z' },
        }}
      />,
    );
    expect(screen.getByText('507f1f77bcf86cd799439011')).toBeTruthy();
    expect(screen.getByText('2024-01-15T12:00:00.000Z')).toBeTruthy();
    // Type badges render the EJSON type name.
    expect(screen.getByText('objectid')).toBeTruthy();
    expect(screen.getByText('date')).toBeTruthy();
  });

  it('visually emphasizes keys in highlightKeys', () => {
    render(
      <JsonTree value={{ stage: 'COLLSCAN', other: 1 }} highlightKeys={new Set(['stage'])} />,
    );
    const row = screen.getByText('stage:');
    expect(row).toBeTruthy();
    // Emphasis is expressed via inline style (bold weight) — assert it's not
    // the same as an un-highlighted row's weight.
    const otherRow = screen.getByText('other:');
    expect(row.style.fontWeight).not.toBe(otherRow.style.fontWeight);
  });

  it('renders a bare leaf value at the root without crashing', () => {
    render(<JsonTree value={42} />);
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('T2.3 perf — toggling one node does not re-render unrelated sibling nodes', () => {
    const mockedToDisplayValue = vi.mocked(toDisplayValue);
    render(<JsonTree value={{ first: { nested: 1 }, second: 'MARKER', third: 3 }} />);
    mockedToDisplayValue.mockClear();

    // Expand "first" — this replaces `expandedPaths` with a new Set instance
    // (identity changes), but only `first` (and its newly-revealed child
    // `nested`) should actually re-render; `second`/`third` are unaffected.
    const expandButtons = screen.getAllByRole('button', { name: 'Expand' });
    fireEvent.click(expandButtons[0]);

    // Positive assertion first, so this test can't pass vacuously if the
    // spy never fires: the newly-revealed child is genuinely rendered.
    expect(mockedToDisplayValue.mock.calls.some((call) => call[0] === 1)).toBe(true);

    // Untouched siblings must not be re-evaluated.
    expect(mockedToDisplayValue.mock.calls.some((call) => call[0] === 'MARKER')).toBe(false);
    expect(mockedToDisplayValue.mock.calls.some((call) => call[0] === 3)).toBe(false);
  });

  // #86 — a top-level key literally named "a.b" used to compute the same
  // `path` as nested field `b` under top-level "a" (plain `.`-joining), so
  // expanding one toggled the other's expansion state too.
  it('a dotted top-level key does not share expansion state with a same-shaped nested path (#86)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<JsonTree value={{ 'a.b': { x: 1 }, a: { b: { y: 2 } } }} />);

    const rootExpandButtons = screen.getAllByRole('button', { name: 'Expand' });
    expect(rootExpandButtons).toHaveLength(2); // "a.b" and "a"

    // Expand the dotted top-level row — reveals its own child "x" only.
    fireEvent.click(rootExpandButtons[0]);
    expect(screen.getByText('x:')).toBeTruthy();
    expect(screen.queryByText('b:')).toBeNull();

    // Expand "a" — reveals its own child "b" (itself still collapsed).
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('b:')).toBeTruthy();
    expect(screen.queryByText('y:')).toBeNull();

    // Expand nested "b" — only now does "y" appear.
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('y:')).toBeTruthy();

    const duplicateKeyWarning = errorSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('same key'),
    );
    expect(duplicateKeyWarning).toBe(false);
    errorSpy.mockRestore();
  });
});
