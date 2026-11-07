import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionTabState } from '@shared/types';

/** jsdom has no layout: this gives the bar, and only the bar, a width. */
function giveBarWidth(width: number) {
  const native = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
    return this.matches('[data-testid="result-bar"]') ? ({ width } as DOMRect) : native.call(this);
  });
}

const RUN = { documents: new Array(50).fill({}), durationMs: 2, ranAt: '2026-01-01T00:00:00.000Z' };

function barState(over: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    totalCount: 60,
    lastRun: RUN,
    ...over,
  };
}

function bar(state: CollectionTabState, isLoading = false) {
  return (
    <CollectionWorkspaceProvider
      state={state}
      actions={emptyWorkspaceActions()}
      meta={emptyWorkspaceMeta({ isLoading })}
    >
      <ResultBar />
    </CollectionWorkspaceProvider>
  );
}

/** Each named control's accessible name, and whether it shows words or only an icon. */
function controlForms() {
  const root = screen.getByTestId('result-bar');
  const form = (name: RegExp) => {
    const b = within(root).getByRole('button', { name });
    return `${b.getAttribute('aria-label') ?? b.textContent}:${b.classList.contains('mantine-ActionIcon-root') ? 'icon' : 'label'}`;
  };
  return [form(/^Fields/), form(/^Insert document/), form(/^Documents/)];
}

beforeEach(() => installAtelierMock());
afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('ResultBar collapses by width alone', () => {
  it.each([
    [792, 'label'],
    [686, 'icon'],
  ])('at %i px every state keeps the same control forms', (width, form) => {
    giveBarWidth(width);
    const { rerender } = render(bar(barState()));
    const fresh = controlForms();
    expect(fresh.every((f) => f.endsWith(`:${form}`))).toBe(true);

    rerender(bar(barState({ queryRaw: '{ bad:' })));
    expect(screen.getByTestId('result-count-stale').textContent).toContain('not current');
    expect(controlForms()).toEqual(fresh);

    rerender(bar(barState(), true));
    expect(controlForms()).toEqual(fresh);

    rerender(bar(barState({ lastRun: undefined, totalCount: undefined })));
    expect(controlForms()).toEqual(fresh);

    rerender(bar(barState({ lastRun: { ...RUN, documents: new Array(3).fill({}) }, totalCount: 3 })));
    expect(controlForms()).toEqual(fresh);
  });

  it('icon-only controls keep their accessible names', () => {
    giveBarWidth(686);
    render(bar(barState()));
    const root = screen.getByTestId('result-bar');
    for (const name of ['Fields', 'Insert document', 'Documents']) {
      const b = within(root).getByRole('button', { name });
      expect(b.querySelector('svg')).not.toBeNull();
    }
  });

  it('marks a changed Fields view on the icon, so it does not hide behind a click', () => {
    giveBarWidth(686);
    const { rerender } = render(bar(barState()));
    expect(screen.queryByTestId('fields-changed-mark')).toBeNull();
    rerender(bar(barState({ columnConfig: { hidden: ['a'] } })));
    expect(screen.getByTestId('fields-changed-mark')).toBeTruthy();
  });

  it('Tree, JSON and Table keep their words at every width', () => {
    giveBarWidth(520);
    render(bar(barState()));
    for (const view of ['Tree', 'JSON', 'Table']) expect(screen.getByText(view)).toBeTruthy();
  });

  it.each([
    [1066, /60 results/, /showing 1–50/],
    [792, /1–50 of 60/, /^$/],
    [579, /60 results/, /^$/],
  ])('at %i px the count merges, with the rest in a tooltip', (width, shown, also) => {
    giveBarWidth(width);
    render(bar(barState()));
    const slot = screen.getByTestId('result-count-slot');
    expect(slot.textContent).toMatch(shown);
    if (also.source !== '^$') expect(slot.textContent).toMatch(also);
    else expect(slot.querySelector('[title*="showing 1–50"]')).not.toBeNull();
  });

  it('the narrowest bar spends its room on "not current" rather than the noun', () => {
    giveBarWidth(579);
    render(bar(barState({ queryRaw: '{ bad:' })));
    expect(screen.getByTestId('result-count-slot').textContent).toBe('60· not current');
  });

  it('everything that depends on the query sits in the flexible slot, not among the anchored controls', () => {
    giveBarWidth(792);
    render(
      bar(
        barState({
          queryRaw: '{ bad:',
          builder: { projection: [], sort: '', limit: '10' },
          lastRun: { ...RUN, plan: { queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: 'status_1' } } } } as never,
        }),
      ),
    );
    const slot = screen.getByTestId('result-count-slot');
    expect(slot.style.flexGrow).toBe('1');
    expect(slot.style.minWidth).toBe('0px');
    expect(slot.contains(screen.getByTestId('result-count-stale'))).toBe(true);
    expect(slot.contains(screen.getByTestId('result-limit-cap'))).toBe(true);
    expect(slot.contains(screen.getByTestId('plan-badge'))).toBe(true);
  });

  it('wraps rather than clips only at a width reachable by dragging the panes', () => {
    giveBarWidth(460);
    render(bar(barState()));
    expect(screen.getByTestId('result-bar').style.getPropertyValue('--group-wrap')).toBe('wrap');
  });
});
