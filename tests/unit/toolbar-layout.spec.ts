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

  // The References button shifts every step by its own width: labelled above the
  // icon step, an icon below it.
  it.each([
    [1041, { count: 'full', iconControls: false, planBadge: true, wrap: false }],
    [1040, { count: 'range', iconControls: false, planBadge: true, wrap: false }],
    [901, { count: 'range', iconControls: false, planBadge: true, wrap: false }],
    [900, { count: 'range', iconControls: true, planBadge: true, wrap: false }],
    [672, { count: 'range', iconControls: true, planBadge: true, wrap: false }],
    [671, { count: 'total', iconControls: true, planBadge: false, wrap: false }],
    [532, { count: 'total', iconControls: true, planBadge: false, wrap: false }],
    [531, { count: 'total', iconControls: true, planBadge: false, wrap: true }],
  ])('with References, at %i px', (width, expected) => {
    expect(resultBarLayout(width, true)).toEqual(expected);
  });

  it('with References, still merges the counts before it collapses any control', () => {
    for (let w = 320; w <= 2000; w += 1) {
      const { count, iconControls } = resultBarLayout(w, true);
      if (iconControls) expect(count).not.toBe('full');
    }
  });

  it('with no measured width (no layout), gives room for everything', () => {
    expect(resultBarLayout(null)).toEqual({ count: 'full', iconControls: false, planBadge: true, wrap: false });
  });

  // The rule is enforced by the signature: nothing about the query can reach it.
  // The one optional flag is which controls the bar holds, not the query.
  it('takes the width and nothing else', () => {
    expect(resultBarLayout.length).toBe(1);
    expect(resultBarLayout(null, true)).toEqual(resultBarLayout(null));
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

  // The References button shifts every step by its own width: labelled above the
  // icon step, an icon below it.
  it.each([
    [1041, { count: 'full', iconControls: false, planBadge: true, wrap: false }],
    [1040, { count: 'range', iconControls: false, planBadge: true, wrap: false }],
    [901, { count: 'range', iconControls: false, planBadge: true, wrap: false }],
    [900, { count: 'range', iconControls: true, planBadge: true, wrap: false }],
    [672, { count: 'range', iconControls: true, planBadge: true, wrap: false }],
    [671, { count: 'total', iconControls: true, planBadge: false, wrap: false }],
    [532, { count: 'total', iconControls: true, planBadge: false, wrap: false }],
    [531, { count: 'total', iconControls: true, planBadge: false, wrap: true }],
  ])('with References, at %i px', (width, expected) => {
    expect(resultBarLayout(width, true)).toEqual(expected);
  });

  it('with References, still merges the counts before it collapses any control', () => {
    for (let w = 320; w <= 2000; w += 1) {
      const { count, iconControls } = resultBarLayout(w, true);
      if (iconControls) expect(count).not.toBe('full');
    }
  });

  it('with no measured width, shows labels', () => {
    expect(outputBarActions(null)).toBe('labels');
  });
});
