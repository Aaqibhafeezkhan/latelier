import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, expectSeparatorClampedAtBounds } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { ResizeHandle } from '../../src/pages/Workspace/ResizeHandle';

/**
 * The reference drawer put `ResizeHandle`'s `edge="right"` branch into service for the first
 * time — the reference drawer sits to the *right* of its handle, where the
 * navigator sits to the left of its own. Until now every call site was
 * `edge="left"`, so the inverted-delta branch
 * (`edge === 'left' || edge === 'bottom' ? deltaPx : -deltaPx`) was dead code
 * and the component had no tests at all.
 *
 * A backwards sign is the failure that matters here: the drawer would grow
 * when dragged away from and shrink when dragged toward, which typechecks,
 * lints, and renders perfectly.
 */
function drag(handle: HTMLElement, from: number, to: number) {
  fireEvent.mouseDown(handle, { clientX: from, clientY: from });
  fireEvent.mouseMove(window, { clientX: to, clientY: to });
  fireEvent.mouseUp(window, { clientX: to, clientY: to });
}

describe('ResizeHandle edges', () => {
  it('shrinks a right-edge panel when dragged right, and grows it when dragged left', () => {
    const onChange = vi.fn();
    render(
      <ResizeHandle
        edge="right"
        value={380}
        min={160}
        max={560}
        onChange={onChange}
        ariaLabel="Resize reference drawer"
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize reference drawer' });

    // Dragging right moves the handle toward the panel, so the panel shrinks.
    drag(handle, 500, 560);
    expect(onChange).toHaveBeenLastCalledWith(320);

    // And away from it grows the panel. This is the assertion that fails if
    // `right` is treated like `left`.
    drag(handle, 500, 440);
    expect(onChange).toHaveBeenLastCalledWith(440);
  });

  it('grows a left-edge panel when dragged right — the navigator, unchanged', () => {
    const onChange = vi.fn();
    render(
      <ResizeHandle
        edge="left"
        value={206}
        min={160}
        max={560}
        onChange={onChange}
        ariaLabel="Resize navigator"
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize navigator' });

    drag(handle, 300, 360);
    expect(onChange).toHaveBeenLastCalledWith(266);
  });

  it('clamps to min and max, and commits the clamped value rather than the raw one', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <ResizeHandle
        edge="right"
        value={380}
        min={160}
        max={560}
        onChange={onChange}
        onCommit={onCommit}
        ariaLabel="Resize reference drawer"
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize reference drawer' });

    // Far past min: 380 - 900 would be -520.
    drag(handle, 500, 1400);
    expect(onChange).toHaveBeenLastCalledWith(160);
    expect(onCommit).toHaveBeenLastCalledWith(160);

    // Far past max: 380 + 900 would be 1280. `onCommit` is what reaches
    // `api.prefs.set`, so an unclamped value here would persist a width the
    // handle itself refuses to produce, and survive a relaunch.
    drag(handle, 1400, 500);
    expect(onChange).toHaveBeenLastCalledWith(560);
    expect(onCommit).toHaveBeenLastCalledWith(560);
  });
});

/**
 * `value`/`onChange` are controlled — a bare `vi.fn()` spy proves a callback
 * fired, not that `aria-valuenow` moved. This wrapper feeds `onChange` back
 * into real state so the assertions below are on the rendered attribute,
 * the thing #56 says the old tests never checked.
 */
function ControlledResizeHandle({
  edge,
  initial,
  min,
  max,
  onCommit,
  ariaLabel = 'Resize reference drawer',
}: {
  edge: 'left' | 'right' | 'top' | 'bottom';
  initial: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ResizeHandle
      edge={edge}
      value={value}
      min={min}
      max={max}
      onChange={setValue}
      onCommit={onCommit}
      ariaLabel={ariaLabel}
    />
  );
}

describe('ResizeHandle keyboard resize (#56)', () => {
  it('is reachable by Tab alone', async () => {
    const user = userEvent.setup();
    render(<ControlledResizeHandle edge="right" initial={380} min={160} max={560} onCommit={vi.fn()} />);
    const handle = screen.getByRole('separator', { name: 'Resize reference drawer' });

    await user.tab();

    expect(document.activeElement).toBe(handle);
  });

  it('edge="right": ArrowLeft grows the drawer and ArrowRight shrinks it — inverted to agree with the mouse drag — and commits immediately, keeping focus', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<ControlledResizeHandle edge="right" initial={380} min={160} max={560} onCommit={onCommit} />);
    const handle = screen.getByRole('separator', { name: 'Resize reference drawer' });
    await user.tab();

    // Dragging right shrinks a right-edge panel (the mouse test above), so
    // ArrowRight — the "toward the panel" key — must shrink it too.
    await user.keyboard('{ArrowRight}');
    expect(handle.getAttribute('aria-valuenow')).toBe('370');
    expect(onCommit).toHaveBeenLastCalledWith(370);
    expect(document.activeElement).toBe(handle);

    // And ArrowLeft — "away from the panel" — grows it, twice over.
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(handle.getAttribute('aria-valuenow')).toBe('390');
    expect(onCommit).toHaveBeenLastCalledWith(390);
    expect(document.activeElement).toBe(handle);
  });

  it('edge="left": ArrowRight grows the navigator and ArrowLeft shrinks it — not inverted', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ControlledResizeHandle
        edge="left"
        initial={206}
        min={160}
        max={560}
        onCommit={onCommit}
        ariaLabel="Resize navigator"
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize navigator' });
    await user.tab();

    await user.keyboard('{ArrowRight}');
    expect(handle.getAttribute('aria-valuenow')).toBe('216');
    expect(onCommit).toHaveBeenLastCalledWith(216);

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(handle.getAttribute('aria-valuenow')).toBe('196');
    expect(onCommit).toHaveBeenLastCalledWith(196);
    expect(document.activeElement).toBe(handle);
  });

  it('Home and End jump to the bounds regardless of edge, and stay clamped and focused past them', async () => {
    const user = userEvent.setup();
    render(<ControlledResizeHandle edge="right" initial={380} min={160} max={560} onCommit={vi.fn()} />);
    const handle = screen.getByRole('separator', { name: 'Resize reference drawer' });
    await user.tab();

    // For edge="right" the arrows are inverted: ArrowRight shrinks, so it is
    // the one that must stay clamped at min rather than go negative, and
    // ArrowLeft grows, so it is the one that must not overshoot max. Stated
    // here rather than derived in the helper — see its docstring.
    await expectSeparatorClampedAtBounds(handle, {
      min: '160',
      max: '560',
      shrinkKey: '{ArrowRight}',
      growKey: '{ArrowLeft}',
    });
  });

  it('shows a focus indicator on keyboard focus, not just on hover', async () => {
    const user = userEvent.setup();
    render(<ControlledResizeHandle edge="right" initial={380} min={160} max={560} onCommit={vi.fn()} />);
    const handle = screen.getByRole('separator', { name: 'Resize reference drawer' });

    // jsdom applies no stylesheet, so the keyboard highlight itself (the
    // `:focus-visible` rule) is proven in e2e; here, that the handle opts in.
    expect(handle.classList.contains('resize-separator')).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(handle);
  });

  /**
   * `left`/`right` were the only edges either drag or Arrow keys were ever
   * tested against — `top`/`bottom` are unused in production today, but a
   * regression here would be just as latent as the one this closes (mouse
   * and keyboard disagreeing on which physical direction grows the panel).
   * Each case drags 40px in the negative screen direction (up/left) and
   * presses the one Arrow key that means the same physical direction, then
   * asserts they moved the tracked value the same way — the exact shape
   * used to find and confirm the fix.
   */
  const EDGE_CASES: ReadonlyArray<{
    edge: 'left' | 'right' | 'top' | 'bottom';
    key: '{ArrowLeft}' | '{ArrowUp}';
    expectedDrag: number;
    expectedArrow: number;
  }> = [
    { edge: 'left', key: '{ArrowLeft}', expectedDrag: 260, expectedArrow: 290 },
    { edge: 'right', key: '{ArrowLeft}', expectedDrag: 340, expectedArrow: 310 },
    { edge: 'top', key: '{ArrowUp}', expectedDrag: 340, expectedArrow: 310 },
    { edge: 'bottom', key: '{ArrowUp}', expectedDrag: 260, expectedArrow: 290 },
  ];

  EDGE_CASES.forEach(({ edge, key, expectedDrag, expectedArrow }) => {
    it(`edge="${edge}": dragging up/left and pressing ${key} move the value the same direction`, async () => {
      const user = userEvent.setup();

      const onChangeDrag = vi.fn();
      const { unmount } = render(
        <ResizeHandle edge={edge} value={300} min={100} max={600} onChange={onChangeDrag} ariaLabel="probe" />,
      );
      const dragHandle = screen.getByRole('separator', { name: 'probe' });
      drag(dragHandle, 500, 460); // 40px negative (up for vertical, left for horizontal)
      expect(onChangeDrag).toHaveBeenLastCalledWith(expectedDrag);
      unmount();

      render(<ControlledResizeHandle edge={edge} initial={300} min={100} max={600} onCommit={vi.fn()} ariaLabel="probe" />);
      const arrowHandle = screen.getByRole('separator', { name: 'probe' });
      await user.tab();
      await user.keyboard(key);
      expect(arrowHandle.getAttribute('aria-valuenow')).toBe(String(expectedArrow));

      // The actual regression check: both moved off 300 in the same direction.
      expect(Math.sign(expectedDrag - 300)).toBe(Math.sign(expectedArrow - 300));
    });
  });
});
