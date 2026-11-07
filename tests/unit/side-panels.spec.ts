import { describe, expect, it } from 'vitest';
import { narrowOpenPanel, toggleNarrowPanel } from '../../src/pages/Workspace/sidePanels';

describe('narrowOpenPanel', () => {
  it('before any toggle, follows the stored layout and prefers the navigator', () => {
    expect(narrowOpenPanel(undefined, false, false)).toBe('navigator');
    expect(narrowOpenPanel(undefined, false, true)).toBe('navigator');
    expect(narrowOpenPanel(undefined, true, false)).toBe('builder');
    expect(narrowOpenPanel(undefined, true, true)).toBeNull();
  });

  it('after a toggle, the choice wins, including closing everything', () => {
    expect(narrowOpenPanel('builder', false, true)).toBe('builder');
    expect(narrowOpenPanel(null, false, false)).toBeNull();
  });
});

describe('toggleNarrowPanel', () => {
  it('opening one closes the other', () => {
    expect(toggleNarrowPanel('navigator', 'builder', false)).toBe('builder');
    expect(toggleNarrowPanel('builder', 'navigator', false)).toBe('navigator');
  });

  it('closing the open one leaves none', () => {
    expect(toggleNarrowPanel('builder', 'builder', true)).toBeNull();
  });

  it('closing one that is already closed leaves the other alone', () => {
    expect(toggleNarrowPanel('navigator', 'builder', true)).toBe('navigator');
  });
});
