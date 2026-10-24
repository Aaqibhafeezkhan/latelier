import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, fireEvent, screen, within, act } from '../helpers/render';
import { Int32, Long } from 'bson';
import { StageAccordion } from '../../src/pages/Workspace/Aggregation/StageAccordion';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { DEFAULT_BODIES } from '../../src/pages/Workspace/Aggregation/pipeline';
import type { Stage } from '@shared/types';
import type { ScriptEditorProps } from '../../src/components/ScriptEditor';

/**
 * `ScriptEditor` mounts a real CodeMirror 6 view, which needs layout APIs
 * jsdom doesn't implement (see T2.4 plan risk notes) — behavioral coverage
 * for the real editor lives in e2e. Here we stub it with a plain `<input>`
 * (deliberately not a `<textarea>`, so "no textarea remains" assertions
 * stay meaningful) that forwards the controlled-component + toolbar-facing
 * props StageRow relies on.
 */
vi.mock('../../src/components/ScriptEditor', () => ({
  ScriptEditor: ({ value, onChange, onBlur, onRunAlt, testId, ariaLabel }: ScriptEditorProps) => (
    <input
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onBlur?.()}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
          e.preventDefault();
          onRunAlt?.();
        }
      }}
    />
  ),
}));

beforeEach(() => installAtelierMock());
afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function stage(over: Partial<Stage> = {}): Stage {
  return {
    id: over.id ?? 1,
    op: over.op ?? '$match',
    body: over.body ?? '{}',
    enabled: over.enabled ?? true,
    ...over,
  } as Stage;
}

type AccordionProps = React.ComponentProps<typeof StageAccordion>;

// Placeholder for callbacks a given test does not assert on. A no-arg
// void function is assignable to every one of these prop signatures.
const noop = () => {};

function renderAccordion(stages: Stage[], overrides: Partial<AccordionProps> = {}) {
  return render(
      <StageAccordion
        stages={stages}
        activeId={overrides.activeId ?? null}
        collection="orders"
        sourceCount={1234}
        outputCount={null}
        stageCounts={overrides.stageCounts ?? {}}
        stageSamples={overrides.stageSamples ?? {}}
        staleStageIds={overrides.staleStageIds ?? new Set()}
        previewLoading={new Set()}
        darkMode={false}
        suggestionContext={null}
        onAdd={overrides.onAdd ?? noop}
        onToggleActive={overrides.onToggleActive ?? noop}
        onToggleEnabled={overrides.onToggleEnabled ?? noop}
        onChangeOp={overrides.onChangeOp ?? noop}
        onBodyChange={overrides.onBodyChange ?? noop}
        onMoveUp={overrides.onMoveUp ?? noop}
        onMoveDown={overrides.onMoveDown ?? noop}
        onReorder={overrides.onReorder ?? noop}
        onRemove={overrides.onRemove ?? noop}
        onDuplicate={overrides.onDuplicate ?? noop}
        onRunToStage={overrides.onRunToStage ?? noop}
        onRefreshPreview={noop}
      />
  );
}

/**
 * P1-12 coverage for StageAccordion.
 */
describe('StageAccordion — stage rendering and operations', () => {
  it('renders source header with collection name and document count', () => {
    const { container } = renderAccordion([]);
    expect(container.textContent).toContain('orders');
    expect(container.textContent).toContain('1,234 documents');
  });

  it('renders each stage with its op label and toggle button', () => {
    const stages = [
      stage({ id: 1, op: '$match', enabled: true }),
      stage({ id: 2, op: '$group', enabled: false }),
      stage({ id: 3, op: '$sort', enabled: true }),
    ];
    const { container } = renderAccordion(stages);
    expect(container.textContent).toContain('$match');
    expect(container.textContent).toContain('$group');
    expect(container.textContent).toContain('$sort');

    // Two ON badges (matches enabled stages) and one OFF.
    const onButtons = screen.getAllByText('ON');
    const offButtons = screen.getAllByText('OFF');
    expect(onButtons).toHaveLength(2);
    expect(offButtons).toHaveLength(1);
  });

  it('invokes onToggleEnabled when the ON/OFF button is clicked', () => {
    const onToggleEnabled = vi.fn<NonNullable<AccordionProps['onToggleEnabled']>>();
    renderAccordion([stage({ id: 7, op: '$match', enabled: true })], { onToggleEnabled });
    fireEvent.click(screen.getByText('ON'));
    expect(onToggleEnabled).toHaveBeenCalledWith(7);
  });

  it('shows the Disable tooltip when keyboard focus lands on the ON/OFF toggle', async () => {
    renderAccordion([stage({ id: 1, enabled: true })]);

    fireEvent.focus(screen.getByRole('button', { name: 'Disable stage' }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Disable');
  });

  it('pressing Enter on a collapsed stage header expands it (keyboard equivalent of the click)', async () => {
    const onToggleActive = vi.fn<NonNullable<AccordionProps['onToggleActive']>>();
    const { container } = renderAccordion([stage({ id: 7, op: '$match', enabled: true })], {
      onToggleActive,
    });
    // S6852 fix: the row itself is a plain div now (see StageAccordion.tsx);
    // the accessible leaf is the summary-text <button> carrying aria-expanded.
    const header = container.querySelector(
      '[data-testid="stage-row-7"] button[aria-expanded]',
    ) as HTMLElement;
    expect(header.getAttribute('aria-expanded')).toBe('false');

    // A real <button>'s Enter-activates-click is native browser behavior that
    // raw fireEvent.keyDown doesn't simulate in jsdom; userEvent does.
    header.focus();
    await userEvent.keyboard('{Enter}');
    expect(onToggleActive).toHaveBeenCalledWith(7);
  });

  it('does not also toggle the stage when Enter is pressed on a control inside the header', () => {
    // The header row is a plain div with no keydown handler of its own (see
    // StageAccordion.tsx) — the ON/OFF switch, move / duplicate / delete
    // buttons and the expand/collapse button are all siblings, not nested
    // inside one another, so nothing on this row can double-fire anymore.
    const onToggleActive = vi.fn<NonNullable<AccordionProps['onToggleActive']>>();
    renderAccordion([stage({ id: 7, op: '$match', enabled: true })], { onToggleActive });

    fireEvent.keyDown(screen.getByText('ON'), { key: 'Enter', bubbles: true });
    expect(onToggleActive).not.toHaveBeenCalled();
  });

  it('the expand/collapse button contains no nested interactive controls (nested-interactive / S6852)', () => {
    const { container } = renderAccordion([stage({ id: 7, op: '$match', enabled: true })]);
    const header = container.querySelector(
      '[data-testid="stage-row-7"] button[aria-expanded]',
    ) as HTMLElement;
    expect(within(header).queryAllByRole('button')).toHaveLength(0);
  });

  it('disables move-up on the first stage and move-down on the last', () => {
    renderAccordion([
      stage({ id: 1, op: '$match' }),
      stage({ id: 2, op: '$sort' }),
    ]);
    const moveUps = screen.getAllByLabelText('Move stage up');
    const moveDowns = screen.getAllByLabelText('Move stage down');
    // first stage's move-up disabled; last stage's move-down disabled
    expect(moveUps[0]!.hasAttribute('disabled')).toBe(true);
    expect(moveDowns[moveDowns.length - 1]!.hasAttribute('disabled')).toBe(true);
    // and the symmetric counterparts are enabled
    expect(moveDowns[0]!.hasAttribute('disabled')).toBe(false);
    expect(moveUps[moveUps.length - 1]!.hasAttribute('disabled')).toBe(false);
  });
});

/**
 * T2.1 — editable stage operator + expanded curated set + custom escape hatch.
 */
describe('StageAccordion — editable stage operator (T2.1)', () => {
  function opTrigger(index = 1) {
    return screen.getByRole('button', {
      name: new RegExp(`Change operator for stage ${index}`),
    });
  }

  function optionFor(op: string) {
    const opt = screen
      .getAllByRole('option')
      .find((el) => el.textContent?.startsWith(op));
    if (!opt) throw new Error(`no option found starting with ${op}`);
    return opt;
  }

  // Wraps the accordion in a plain parent element with its own click/keydown
  // handlers, so propagation-stopping fixes inside the picker can be verified
  // against a real ancestor in the React tree — a `document`-level listener
  // is unreliable here because closing the picker unmounts the backdrop/input
  // in the same tick, which independently halts native bubbling.
  function renderWithParentHandlers(
    stages: Stage[],
    handlers: { onParentClick?: () => void; onParentKeyDown?: () => void } = {},
  ) {
    return render(
      <div onClick={handlers.onParentClick} onKeyDown={handlers.onParentKeyDown}>
        <StageAccordion
          stages={stages}
          activeId={null}
          collection="orders"
          sourceCount={1234}
          outputCount={null}
          stageCounts={{}}
          stageSamples={{}}
          staleStageIds={new Set()}
          previewLoading={new Set()}
          darkMode={false}
          suggestionContext={null}
          onAdd={vi.fn()}
          onToggleActive={vi.fn()}
          onToggleEnabled={vi.fn()}
          onChangeOp={vi.fn()}
          onBodyChange={vi.fn()}
          onMoveUp={vi.fn()}
          onMoveDown={vi.fn()}
          onReorder={vi.fn()}
          onRemove={vi.fn()}
          onDuplicate={vi.fn()}
          onRunToStage={vi.fn()}
          onRefreshPreview={vi.fn()}
        />
      </div>,
    );
  }

  it('AC1: clicking the op control opens the picker; picking a different op calls onChangeOp', () => {
    const onChangeOp = vi.fn<NonNullable<AccordionProps['onChangeOp']>>();
    renderAccordion([stage({ id: 7, op: '$match' })], { onChangeOp });

    fireEvent.click(opTrigger());
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.click(optionFor('$sort'));
    expect(onChangeOp).toHaveBeenCalledWith(7, '$sort');
  });

  it('AC2: the picker offers more than the old 16 ops, including $facet, with search + keyboard nav', () => {
    renderAccordion([stage({ id: 1, op: '$match' })]);
    fireEvent.click(opTrigger());

    const allOptions = screen.getAllByRole('option');
    expect(allOptions.length).toBeGreaterThan(16);
    expect(allOptions.some((el) => el.textContent?.startsWith('$facet'))).toBe(true);

    // Bare typing ("sort") still matches "$sort" — and highlights it first.
    const search = screen.getByLabelText('Search stages');
    fireEvent.change(search, { target: { value: 'sort' } });
    const narrowed = screen.getAllByRole('option');
    expect(narrowed.some((el) => el.textContent?.startsWith('$sort'))).toBe(true);
    expect(narrowed[0]!.textContent).toMatch(/^\$sort/);
    expect(narrowed[0]!.getAttribute('aria-selected')).toBe('true');

    // Clear the search, exercise ↑/↓/Enter.
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const afterDown = screen.getAllByRole('option');
    expect(afterDown[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('AC3: "Other / custom stage…" lets the user submit an arbitrary $operator', () => {
    const onChangeOp = vi.fn<NonNullable<AccordionProps['onChangeOp']>>();
    renderAccordion([stage({ id: 3, op: '$match' })], { onChangeOp });

    fireEvent.click(opTrigger());
    fireEvent.click(screen.getByText('Other / custom stage…'));

    const input = screen.getByLabelText('Custom stage operator');
    fireEvent.change(input, { target: { value: 'foo' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChangeOp).toHaveBeenCalledWith(3, '$foo');
  });

  it('normalizes a custom op with multiple leading $ to a single leading $', () => {
    const onChangeOp = vi.fn<NonNullable<AccordionProps['onChangeOp']>>();
    renderAccordion([stage({ id: 3, op: '$match' })], { onChangeOp });

    fireEvent.click(opTrigger());
    fireEvent.click(screen.getByText('Other / custom stage…'));

    const input = screen.getByLabelText('Custom stage operator');
    fireEvent.change(input, { target: { value: '$$foo' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChangeOp).toHaveBeenCalledWith(3, '$foo');
  });

  it('disables the custom "Add" button when the input normalizes to an empty name', () => {
    renderAccordion([stage({ id: 3, op: '$match' })]);

    fireEvent.click(opTrigger());
    fireEvent.click(screen.getByText('Other / custom stage…'));

    const input = screen.getByLabelText('Custom stage operator');
    const addButton = screen.getByLabelText('Add custom stage');

    // Only `$` characters normalize to an empty name — button stays disabled.
    fireEvent.change(input, { target: { value: '$$$' } });
    expect(addButton.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: '$$foo' } });
    expect(addButton.hasAttribute('disabled')).toBe(false);
  });

  it('stops propagation of the Escape keydown that exits custom mode', () => {
    const onParentKeyDown = vi.fn();
    renderWithParentHandlers([stage({ id: 3, op: '$match' })], { onParentKeyDown });

    fireEvent.click(opTrigger());
    fireEvent.click(screen.getByText('Other / custom stage…'));
    const input = screen.getByLabelText('Custom stage operator');

    fireEvent.keyDown(input, { key: 'Escape' });

    // Custom mode closed, but the keydown never reached the parent.
    expect(screen.queryByLabelText('Custom stage operator')).toBeNull();
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });

  it('Escape in the search box closes the picker and clears the search for the next open', () => {
    renderAccordion([stage({ id: 3, op: '$match' })]);

    fireEvent.click(opTrigger());
    fireEvent.change(screen.getByLabelText('Search stages'), { target: { value: 'sort' } });
    fireEvent.keyDown(screen.getByLabelText('Search stages'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(opTrigger());
    expect((screen.getByLabelText('Search stages') as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText('Custom stage operator')).toBeNull();
  });

  it('stops propagation of the Escape keydown that closes the picker from the search box', () => {
    const onParentKeyDown = vi.fn();
    renderWithParentHandlers([stage({ id: 3, op: '$match' })], { onParentKeyDown });

    fireEvent.click(opTrigger());
    onParentKeyDown.mockClear();
    fireEvent.keyDown(screen.getByLabelText('Search stages'), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });

  it('stops propagation of the backdrop click that closes the picker', () => {
    const onParentClick = vi.fn();
    const { container } = renderWithParentHandlers(
      [stage({ id: 3, op: '$match' })],
      { onParentClick },
    );
    // Open via the add-stage pill rather than the stage-row op trigger: the
    // row wraps its op badge in a `stopPropagation` span (to keep row clicks
    // from toggling `onToggleActive`), which would mask whether the
    // backdrop itself stops propagation. The pill has no such wrapper.
    fireEvent.click(screen.getAllByRole('button', { name: /Add stage/ })[0]!);
    onParentClick.mockClear(); // isolate the backdrop click from the opening click

    const backdrop = container.querySelector('div[style*="z-index: 199"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('AC4: an unrecognized op shows the unknown-op badge; a curated op does not', () => {
    const { rerender } = renderAccordion([stage({ id: 1, op: '$fakeOp' })]);
    expect(screen.getByText('Unknown op')).toBeTruthy();

    rerender(
      <StageAccordion
        stages={[stage({ id: 1, op: '$match' })]}
        activeId={null}
        collection="orders"
        sourceCount={1234}
        outputCount={null}
        stageCounts={{}}
        stageSamples={{}}
        staleStageIds={new Set()}
        previewLoading={new Set()}
        darkMode={false}
        suggestionContext={null}
        onAdd={vi.fn()}
        onToggleActive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onChangeOp={vi.fn()}
        onBodyChange={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onReorder={vi.fn()}
        onRemove={vi.fn()}
        onDuplicate={vi.fn()}
        onRunToStage={vi.fn()}
        onRefreshPreview={vi.fn()}
      />,
    );
    expect(screen.queryByText('Unknown op')).toBeNull();
  });

  it('AC8: the add-stage pill still inserts via onAdd at the correct index', () => {
    const onAdd = vi.fn<NonNullable<AccordionProps['onAdd']>>();
    renderAccordion(
      [stage({ id: 1, op: '$match' }), stage({ id: 2, op: '$sort' })],
      { onAdd },
    );

    // Pills: [before #1] [between #1/#2] [after #2] — click the middle one.
    const addButtons = screen.getAllByRole('button', { name: /Add stage/ });
    expect(addButtons).toHaveLength(3);
    fireEvent.click(addButtons[1]!);
    fireEvent.click(optionFor('$limit'));

    expect(onAdd).toHaveBeenCalledWith('$limit', 0);
  });
});

/**
 * T2.2 — the stage grip is wired to real HTML5 drag-and-drop reordering
 * (mirroring TabStrip's local drag-state pattern), in addition to the
 * existing up/down arrows.
 */
describe('StageAccordion — drag-to-reorder grip (T2.2)', () => {
  it('AC: dragging a stage grip and dropping on another stage calls onReorder with the correct from/to indices', () => {
    const onReorder = vi.fn<NonNullable<AccordionProps['onReorder']>>();
    renderAccordion(
      [stage({ id: 1 }), stage({ id: 2 }), stage({ id: 3 })],
      { onReorder },
    );

    // Drag stage id 3 (index 2) and drop it onto stage id 1's row (index 0).
    fireEvent.dragStart(screen.getByTestId('stage-drag-handle-3'));
    fireEvent.dragOver(screen.getByTestId('stage-row-1'));
    fireEvent.drop(screen.getByTestId('stage-row-1'));
    fireEvent.dragEnd(screen.getByTestId('stage-drag-handle-3'));

    expect(onReorder).toHaveBeenCalledWith(2, 0);
  });

  it('AC: dropping a stage onto itself is a no-op', () => {
    const onReorder = vi.fn<NonNullable<AccordionProps['onReorder']>>();
    renderAccordion(
      [stage({ id: 1 }), stage({ id: 2 }), stage({ id: 3 })],
      { onReorder },
    );

    fireEvent.dragStart(screen.getByTestId('stage-drag-handle-1'));
    fireEvent.dragOver(screen.getByTestId('stage-row-1'));
    fireEvent.drop(screen.getByTestId('stage-row-1'));
    fireEvent.dragEnd(screen.getByTestId('stage-drag-handle-1'));

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('sets dataTransfer data on drag start (Firefox requires it to initiate a drag)', () => {
    renderAccordion([stage({ id: 1 }), stage({ id: 2 })]);

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId('stage-drag-handle-1'), {
      dataTransfer: { setData },
    });

    expect(setData).toHaveBeenCalledWith('text/plain', '');
  });

  it('the grip is draggable and keeps its existing click-stopPropagation behavior', () => {
    const onToggleActive = vi.fn<NonNullable<AccordionProps['onToggleActive']>>();
    renderAccordion([stage({ id: 1 })], { onToggleActive });

    const handle = screen.getByTestId('stage-drag-handle-1');
    expect(handle.getAttribute('draggable')).toBe('true');

    // Clicking the grip must not toggle the row (stopPropagation guard,
    // unchanged from before this ticket).
    fireEvent.click(handle);
    expect(onToggleActive).not.toHaveBeenCalled();
  });
});

/**
 * T2.4 — the stage body editor is now a (mocked, per the file-level
 * `vi.mock`) `ScriptEditor` instead of a bare `<textarea>`.
 */
describe('StageAccordion — stage body editor (T2.4)', () => {
  /**
   * Round-trips `onBodyChange`/`onChangeOp` back into the rendered stage via
   * a real `useState`, mirroring `renderStatefulTab` in
   * aggregation-tab.spec.tsx — AC5's "op-change default body reflects" and
   * "a local edit survives the prop round-trip" assertions both need the
   * DOM to reflect state that flowed back through props, not a static one.
   */
  function renderStatefulAccordion(initialStages: Stage[], activeId: number | null) {
    function Wrapper() {
      const [stages, setStages] = React.useState(initialStages);
      const onBodyChange = (id: number, body: string) => {
        setStages((prev) => prev.map((s) => (s.id === id ? { ...s, body } : s)));
      };
      const onChangeOp = (id: number, op: Stage['op']) => {
        setStages((prev) =>
          prev.map((s) => (s.id === id ? { ...s, op, body: DEFAULT_BODIES[op] ?? s.body } : s)),
        );
      };
      return (
        <StageAccordion
          stages={stages}
          activeId={activeId}
          collection="orders"
          sourceCount={1234}
          outputCount={null}
          stageCounts={{}}
          stageSamples={{}}
          staleStageIds={new Set()}
          previewLoading={new Set()}
          darkMode={false}
          suggestionContext={null}
          onAdd={vi.fn()}
          onToggleActive={vi.fn()}
          onToggleEnabled={vi.fn()}
          onChangeOp={onChangeOp}
          onBodyChange={onBodyChange}
          onMoveUp={vi.fn()}
          onMoveDown={vi.fn()}
          onReorder={vi.fn()}
          onRemove={vi.fn()}
          onDuplicate={vi.fn()}
          onRunToStage={vi.fn()}
          onRefreshPreview={vi.fn()}
        />
      );
    }
    return render(<Wrapper />);
  }

  it('AC1/AC3/AC8: expanding a stage renders the editor host and toolbar, with no textarea', () => {
    const { container } = renderAccordion([stage({ id: 7, op: '$match' })], { activeId: 7 });

    expect(screen.getByTestId('stage-body-editor-7')).toBeTruthy();
    expect(container.querySelector('textarea')).toBeNull();
    expect(screen.getByText('Copy')).toBeTruthy();
    expect(screen.getByText('Format')).toBeTruthy();
    expect(screen.getByText('Run to here')).toBeTruthy();
  });

  it('AC3: Run to here fires on Mod-Shift-Enter from the editor', () => {
    const onRunToStage = vi.fn<NonNullable<AccordionProps['onRunToStage']>>();
    renderAccordion([stage({ id: 7, op: '$match' })], { activeId: 7, onRunToStage });

    fireEvent.keyDown(screen.getByTestId('stage-body-editor-7'), {
      key: 'Enter',
      metaKey: true,
      shiftKey: true,
    });

    expect(onRunToStage).toHaveBeenCalledWith(7);
  });

  it('AC3: Format pretty-prints a valid body and no-ops on an invalid one', () => {
    const onBodyChange = vi.fn<NonNullable<AccordionProps['onBodyChange']>>();
    renderAccordion([stage({ id: 7, op: '$match', body: '{"a":1}' })], {
      activeId: 7,
      onBodyChange,
    });

    fireEvent.click(screen.getByText('Format'));
    expect(onBodyChange).toHaveBeenCalledWith(7, JSON.stringify({ a: 1 }, null, 2));

    onBodyChange.mockClear();
    fireEvent.change(screen.getByTestId('stage-body-editor-7'), { target: { value: '{ invalid' } });
    onBodyChange.mockClear(); // isolate Format's own effect from the onChange call above
    fireEvent.click(screen.getByText('Format'));
    expect(onBodyChange).not.toHaveBeenCalled();
  });

  it('AC4: shows the error strip and a red border ~400ms after an invalid edit, and clears both on a valid edit', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderAccordion([stage({ id: 7, op: '$match', body: '{}' })], {
        activeId: 7,
      });
      const editorHost = screen.getByTestId('stage-body-editor-7');
      const borderedWrapper = editorHost.parentElement as HTMLElement;

      fireEvent.change(editorHost, { target: { value: '{ invalid' } });
      // Debounce hasn't elapsed yet — no error surfaced.
      expect(screen.queryByRole('alert')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(400);
      });
      // X14 §5 — the strip carries the transform's reason with a line
      // and column, not the bare 'invalid EJSON' it shipped with.
      expect(screen.getByRole('alert').textContent).toBe(
        'Line 1, column 10: Unexpected token',
      );
      expect(borderedWrapper.style.border).toContain('var(--atelier-red)');
      expect(container.textContent).toContain('(invalid)');

      fireEvent.change(editorHost, { target: { value: '{}' } });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(borderedWrapper.style.border).not.toContain('var(--atelier-red)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC5: a local edit is not reverted by the prop round-trip', () => {
    renderStatefulAccordion([stage({ id: 7, op: '$match', body: '{}' })], 7);

    const editorHost = screen.getByTestId('stage-body-editor-7');
    fireEvent.change(editorHost, { target: { value: '{ "status": "paid"' } });

    // onBodyChange -> onPatch -> the same value flows back as `stage.body`;
    // the mid-edit guard (cleared only on blur) must not let that prop
    // round-trip clobber what's still being typed.
    expect((editorHost as HTMLInputElement).value).toBe('{ "status": "paid"');
  });

  it('AC5: an op-change default body is reflected into the editor after blur', () => {
    renderStatefulAccordion([stage({ id: 7, op: '$match', body: '{}' })], 7);

    const editorHost = screen.getByTestId('stage-body-editor-7');
    fireEvent.change(editorHost, { target: { value: '{ "status": "paid"' } });
    fireEvent.blur(editorHost); // clears the mid-edit guard, same as the old textarea's onBlur

    // Changing the op elsewhere (the op badge) supplies a fresh default body
    // for the same stage id — it must land in the editor now that we're not
    // mid-edit.
    fireEvent.click(
      screen.getByRole('button', { name: /Change operator for stage 1/ }),
    );
    fireEvent.click(
      screen.getAllByRole('option').find((el) => el.textContent?.startsWith('$sort'))!,
    );

    expect((editorHost as HTMLInputElement).value).toBe(DEFAULT_BODIES['$sort']);
  });

  /**
   * X14 §4 — Shell Syntax in a stage body. The conversion point is
   * the editor's blur, in the box the user typed in, so `stage.body` never
   * carries a dialect the main process's `ejsonParse` would refuse.
   */
  describe('Shell Syntax (X14 §4)', () => {
    /** The leading whitespace of each line, which a reprint would flatten. */
    const indents = (text: string) => text.split('\n').map((l) => /^[ \t]*/.exec(l)![0]);

    // The mocked editor is an `<input>`, which drops newlines from `value` —
    // the multi-line assertions read the committed text off `onBodyChange`.
    it('repairs the shipped $group template on blur and raises no error', () => {
      const onBodyChange = vi.fn<NonNullable<AccordionProps['onBodyChange']>>();
      renderAccordion([stage({ id: 7, op: '$group', body: DEFAULT_BODIES['$group'] })], {
        activeId: 7,
        onBodyChange,
      });

      fireEvent.blur(screen.getByTestId('stage-body-editor-7'));

      expect(onBodyChange).toHaveBeenCalledWith(
        7,
        '{\n  "_id": "$field",\n  "count": { "$sum": 1 }\n}',
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });

    /**
     * The acceptance risk. A shape assertion cannot see indentation loss, so
     * these assert the line count and the per-line leading whitespace of the
     * committed text directly. `$lookup` is the deepest shipped template.
     */
    it('keeps the line count and per-line indentation of a multi-line body', () => {
      const onBodyChange = vi.fn<NonNullable<AccordionProps['onBodyChange']>>();
      renderAccordion([stage({ id: 7, op: '$lookup', body: DEFAULT_BODIES['$lookup'] })], {
        activeId: 7,
        onBodyChange,
      });

      const before = DEFAULT_BODIES['$lookup']!;
      fireEvent.blur(screen.getByTestId('stage-body-editor-7'));

      expect(onBodyChange).toHaveBeenCalledTimes(1);
      const after = onBodyChange.mock.calls[0]![1];
      expect(after.split('\n')).toHaveLength(6);
      expect(after.split('\n')).toHaveLength(before.split('\n').length);
      expect(indents(after)).toEqual(['', '  ', '  ', '  ', '  ', '']);
      expect(indents(after)).toEqual(indents(before));
      expect(after).toBe(
        '{\n  "from": "collection",\n  "localField": "_id",\n  "foreignField": "_id",\n  "as": "result"\n}',
      );
    });

    it('hand-indented input keeps the indentation the user chose, not a re-print', () => {
      const onBodyChange = vi.fn<NonNullable<AccordionProps['onBodyChange']>>();
      const typed = '{\n\t_id: "$status",\n        count: { $sum: 1 },\n}';
      renderAccordion([stage({ id: 7, op: '$group', body: typed })], {
        activeId: 7,
        onBodyChange,
      });

      fireEvent.blur(screen.getByTestId('stage-body-editor-7'));

      const after = onBodyChange.mock.calls[0]![1];
      expect(after.split('\n')).toHaveLength(4);
      expect(indents(after)).toEqual(['', '\t', '        ', '']);
    });

    it('leaves a body that is already Canonical EJSON byte-identical', () => {
      const onBodyChange = vi.fn<NonNullable<AccordionProps['onBodyChange']>>();
      const canonical = '{\n  "_id"   :  "$field",\n  "count": { "$sum": 1 },\n\n  "n": 1\n}';
      renderAccordion([stage({ id: 7, op: '$group', body: canonical })], {
        activeId: 7,
        onBodyChange,
      });

      fireEvent.blur(screen.getByTestId('stage-body-editor-7'));

      // Nothing is committed at all, so the odd spacing, the blank line and the
      // key order all survive untouched — the repair never re-prints.
      expect(onBodyChange).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('leaves a single-line canonical body in the box exactly as written', () => {
      renderStatefulAccordion([stage({ id: 7, op: '$match', body: '{ "a"  : 1 }' })], 7);
      const editorHost = screen.getByTestId('stage-body-editor-7') as HTMLInputElement;

      fireEvent.blur(editorHost);

      expect(editorHost.value).toBe('{ "a"  : 1 }');
    });

    it('leaves text no repair can rescue as typed, and still flags it', () => {
      renderStatefulAccordion([stage({ id: 7, op: '$match', body: '{}' })], 7);
      const editorHost = screen.getByTestId('stage-body-editor-7') as HTMLInputElement;

      fireEvent.change(editorHost, { target: { value: '{ _id: ' } });
      fireEvent.blur(editorHost);

      expect(editorHost.value).toBe('{ _id: ');
      expect(screen.getByRole('alert').textContent).toBe(
        'Line 1, column 7: Unexpected token',
      );
    });

    // X14 §5. The multi-line half of the location is asserted in
    // `tests/unit/pipeline-ops.spec.ts` — the ScriptEditor test double is a
    // plain `<input>`, which strips newlines out of the value it is given.
    it('names the regex flag MongoDB has no equivalent for', () => {
      renderStatefulAccordion([stage({ id: 7, op: '$match', body: '{}' })], 7);
      const editorHost = screen.getByTestId('stage-body-editor-7') as HTMLInputElement;

      fireEvent.change(editorHost, { target: { value: '{name: /^acme/gi}' } });
      fireEvent.blur(editorHost);

      const msg = screen.getByRole('alert').textContent ?? '';
      expect(msg).toMatch(/^Line 1, column 8: /);
      expect(msg).toContain('"g"');
      expect(msg).toContain('global');
    });

    it('Format pretty-prints a Shell Syntax body instead of silently doing nothing', () => {
      const onBodyChange = vi.fn<NonNullable<AccordionProps['onBodyChange']>>();
      renderAccordion([stage({ id: 7, op: '$group', body: '{ _id: "$field" }' })], {
        activeId: 7,
        onBodyChange,
      });

      fireEvent.click(screen.getByText('Format'));

      expect(onBodyChange).toHaveBeenCalledWith(7, '{\n  "_id": "$field"\n}');
    });

    it.each([
      ['Shell Syntax', '{ n: 9007199254740993 }'],
      ['JSON', '{"n":9007199254740993}'],
    ])('Format keeps an integer beyond 2^53 exact in a %s body', (_name, body) => {
      const onBodyChange = vi.fn<NonNullable<AccordionProps['onBodyChange']>>();
      renderAccordion([stage({ id: 7, op: '$match', body })], { activeId: 7, onBodyChange });

      fireEvent.click(screen.getByText('Format'));

      expect(onBodyChange).toHaveBeenCalledWith(7, '{\n  "n": 9007199254740993\n}');
    });
  });
});

describe('StageAccordion — readable EJSON in the stage preview', () => {
  it('shows a count as a number rather than a wrapped string', () => {
    // UX review §4.1: the preview and the Documents view must use the same
    // renderer. Before this fix, this read `{"$numberInt":"102"}`.
    const { container } = renderAccordion([stage({ id: 3, op: '$group' })], {
      activeId: 3,
      stageSamples: { 3: [{ _id: 'a', n: new Int32(102) }] },
    });

    expect(container.textContent).toContain('102');
    expect(container.textContent).not.toContain('$numberInt');
  });

  it('keeps an int64 wrapped, because the preview is read as data', () => {
    const { container } = renderAccordion([stage({ id: 3, op: '$group' })], {
      activeId: 3,
      stageSamples: { 3: [{ big: Long.fromString('9007199254740993') }] },
    });

    expect(container.textContent).toContain('9007199254740993');
    expect(container.textContent).not.toContain('9007199254740992');
  });
});

describe('StageAccordion — expanded preview header (N5.8, N5.9)', () => {
  it('shows a stale marker with an explanatory title when the stage was edited after the last run', () => {
    renderAccordion([stage({ id: 7 })], {
      activeId: 7,
      stageCounts: { 7: 12 },
      staleStageIds: new Set([7]),
    });

    const marker = screen.getByTitle('Stage edited after last run');
    expect(marker.textContent).toContain('stale');
  });

  it('omits the marker for a fresh stage and sets tabular numerals on the doc count', () => {
    renderAccordion([stage({ id: 7 })], { activeId: 7, stageCounts: { 7: 12 } });

    expect(screen.queryByTitle('Stage edited after last run')).toBeNull();
    const header = screen.getByText(/Stage preview/);
    expect(header.textContent).toContain('12 docs');
    expect(header.style.fontVariantNumeric).toBe('tabular-nums');
  });
});

describe('StageAccordion — focus after adding or deleting a stage (N5.23)', () => {
  // A real useState wrapper: the focus move only exists once the add/remove
  // has round-tripped back into the `stages` prop.
  function Harness({ initial, spy }: { initial: Stage[]; spy?: () => void }) {
    const [stages, setStages] = React.useState(initial);
    const nextId = React.useRef(100);
    return (
      <StageAccordion
        stages={stages}
        activeId={null}
        collection="orders"
        sourceCount={1}
        outputCount={null}
        stageCounts={{}}
        stageSamples={{}}
        staleStageIds={new Set()}
        previewLoading={new Set()}
        darkMode={false}
        suggestionContext={null}
        onAdd={(op) => {
          spy?.();
          setStages((prev) => [...prev, stage({ id: nextId.current++, op: op as Stage['op'] })]);
        }}
        onToggleActive={noop}
        onToggleEnabled={noop}
        onChangeOp={noop}
        onBodyChange={noop}
        onMoveUp={noop}
        onMoveDown={noop}
        onReorder={noop}
        onRemove={(id) => setStages((prev) => prev.filter((s) => s.id !== id))}
        onDuplicate={noop}
        onRunToStage={noop}
        onRefreshPreview={noop}
      />
    );
  }

  const summary = (id: number) =>
    document.querySelector<HTMLElement>(`[data-stage-summary="${id}"]`) as HTMLElement;

  it('focuses the new stage summary button after a stage is added', () => {
    render(<Harness initial={[stage({ id: 1 })]} />);
    expect(document.activeElement).toBe(document.body);

    const pills = screen.getAllByRole('button', { name: /Add stage/ });
    fireEvent.click(pills[pills.length - 1]!);
    fireEvent.click(screen.getAllByRole('option').find((el) => el.textContent?.startsWith('$sort'))!);

    expect(document.activeElement).toBe(summary(100));
    expect(summary(100).getAttribute('aria-expanded')).toBe('false');
  });

  it('focuses the neighbour that took the removed stage place', () => {
    render(<Harness initial={[stage({ id: 1 }), stage({ id: 2 }), stage({ id: 3 })]} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[1]!);

    expect(document.querySelector('[data-stage-summary="2"]')).toBeNull();
    expect(document.activeElement).toBe(summary(3));
  });

  it('focuses the previous stage when the last one is removed, and the add pill when none is left', () => {
    render(<Harness initial={[stage({ id: 1 }), stage({ id: 2 })]} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[1]!);
    expect(document.activeElement).toBe(summary(1));

    fireEvent.click(screen.getByRole('button', { name: 'Delete stage' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Add stage/ }));
  });

  it('leaves focus alone when it sits outside the accordion', () => {
    render(
      <>
        <button>elsewhere</button>
        <Harness initial={[stage({ id: 1 }), stage({ id: 2 })]} />
      </>,
    );
    screen.getByText('elsewhere').focus();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[0]!);

    expect(document.activeElement).toBe(screen.getByText('elsewhere'));
  });
});
