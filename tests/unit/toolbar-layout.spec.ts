import { describe, expect, it } from 'vitest';
import { outputBarActions, resultBarLayout } from '../../src/pages/Workspace/toolbarLayout';

describe('resultBarLayout', () => {
  it.each([
    // Boundaries, each side: the window sizes the boards were drawn at sit inside these.
    [900, { count: 'full', iconControls: false, planBadge: true, wrap: false }],
    [899, { count: 'range', iconControls: false, planBadge: true, wrap: false }],
    [760, { count: 'range', iconControls: false, planBadge: true, wrap: false }],
    [759, { count: 'range', iconControls: true, planBadge: true, wrap: false }],
    [640, { count: 'range', iconControls: true, planBadge: true, wrap: false }],
    [639, { count: 'total', iconControls: true, planBadge: false, wrap: false }],
    [500, { count: 'total', iconControls: true, planBadge: false, wrap: false }],
    [499, { count: 'total', iconControls: true, planBadge: false, wrap: true }],
  ])('at %i px', (width, expected) => {
    expect(resultBarLayout(width)).toEqual(expected);
  });

  it('merges the counts before it collapses any control', () => {
    for (let w = 320; w <= 2000; w += 1) {
      const { count, iconControls } = resultBarLayout(w);
      if (iconControls) expect(count).not.toBe('full');
    }
  });

  it('with no measured width (no layout), gives room for everything', () => {
    expect(resultBarLayout(null)).toEqual({ count: 'full', iconControls: false, planBadge: true, wrap: false });
  });

  // The rule is enforced by the signature: nothing about the query can reach it.
  it('takes the width and nothing else', () => {
    expect(resultBarLayout.length).toBe(1);
    expect(outputBarActions.length).toBe(1);
  });
});

describe('outputBarActions', () => {
  it.each([
    [760, 'labels'],
    [759, 'icons'],
    [592, 'icons'],
    [520, 'icons'],
    [519, 'menu'],
    [423, 'menu'],
  ])('at %i px is %s', (width, expected) => {
    expect(outputBarActions(width)).toBe(expected);
  });

  it('with no measured width, shows labels', () => {
    expect(outputBarActions(null)).toBe('labels');
  });
});
