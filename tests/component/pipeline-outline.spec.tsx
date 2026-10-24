import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import { PipelineOutline } from '../../src/pages/Workspace/Aggregation/PipelineOutline';
import type { Stage } from '@shared/types';

function stage(over: Partial<Stage> = {}): Stage {
  return {
    id: over.id ?? 1,
    op: over.op ?? '$match',
    body: over.body ?? '{}',
    enabled: over.enabled ?? true,
    ...over,
  } as Stage;
}

/**
 * The sidebar stage row was a `<div onClick>` (SonarCloud typescript:S6848 —
 * a non-native element with an interactive handler and no keyboard
 * equivalent). It's now a native `<button>`, which gets Enter/Space handling
 * for free — this covers the click still working and the new keyboard path.
 */
describe('PipelineOutline — stage row selection', () => {
  it('clicking a stage row calls onSelect with its id', () => {
    const onSelect = vi.fn();
    render(
      <PipelineOutline
        stages={[stage({ id: 3, op: '$sort' })]}
        activeId={null}
        collection="orders"
        stageCounts={{}}
        staleStageIds={new Set()}
        outputCount={null}
        outputStale={false}
        darkMode={false}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Jump to stage 1/ }));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('the stage row is a native <button>, so Enter/Space activation is native — not something we hand-roll', () => {
    render(
      <PipelineOutline
        stages={[stage({ id: 3, op: '$sort' })]}
        activeId={null}
        collection="orders"
        stageCounts={{}}
        staleStageIds={new Set()}
        outputCount={null}
        outputStale={false}
        darkMode={false}
        onSelect={vi.fn()}
      />,
    );

    // Was a `<div onClick>` (SonarCloud S6848: no keyboard equivalent, not
    // focusable). A real jsdom `fireEvent.keyDown` doesn't simulate the
    // browser's own Enter/Space -> click activation, so the only thing worth
    // asserting here is the tag itself — that's what makes the activation
    // native instead of requiring a hand-rolled onKeyDown.
    const row = screen.getByRole('button', { name: /Jump to stage 1/ });
    expect(row.tagName).toBe('BUTTON');
  });
});

describe('PipelineOutline — stage count', () => {
  it('sets tabular numerals on the per-stage count', () => {
    render(
      <PipelineOutline
        stages={[stage({ id: 3, op: '$sort' })]}
        activeId={null}
        collection="orders"
        stageCounts={{ 3: 1234 }}
        staleStageIds={new Set()}
        outputCount={null}
        outputStale={false}
        darkMode={false}
        onSelect={vi.fn()}
      />,
    );

    const count = screen.getByText(/1,?234/);
    expect(count.style.fontVariantNumeric).toBe('tabular-nums');
  });
});
