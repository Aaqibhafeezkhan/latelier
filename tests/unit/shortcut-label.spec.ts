import { describe, it, expect } from 'vitest';
import { formatShortcut } from '../../src/commands/shortcutLabel';

describe('formatShortcut', () => {
  it.each(['⌘T', '⌘↵', '⇧⌘↵', '⌘⌥←', '⌘1–9', 'F5', ''])('keeps %j as written on a Mac', (label) => {
    expect(formatShortcut(label, true)).toBe(label);
  });

  it.each([
    ['⌘T', 'Ctrl+T'],
    ['⌘N', 'Ctrl+N'],
    ['⌘K', 'Ctrl+K'],
    ['⌘↵', 'Ctrl+Enter'],
    ['⌘/', 'Ctrl+/'],
    ['⌥T', 'Alt+T'],
    ['⇧T', 'Shift+T'],
    ['↵', 'Enter'],
    ['⌘1–9', 'Ctrl+1–9'],
  ])('writes %j as %j elsewhere', (label, expected) => {
    expect(formatShortcut(label, false)).toBe(expected);
  });

  it('joins combined modifiers in the Windows order, whichever way the glyphs were written', () => {
    expect(formatShortcut('⌘⇧↵', false)).toBe('Ctrl+Shift+Enter');
    expect(formatShortcut('⇧⌘↵', false)).toBe('Ctrl+Shift+Enter');
    expect(formatShortcut('⇧⌥⌘T', false)).toBe('Ctrl+Alt+Shift+T');
    expect(formatShortcut('⌘⌥←', false)).toBe('Ctrl+Alt+←');
    expect(formatShortcut('⌘⌥→', false)).toBe('Ctrl+Alt+→');
  });

  it('passes a label without glyphs through', () => {
    expect(formatShortcut('F5', false)).toBe('F5');
    expect(formatShortcut('Esc', false)).toBe('Esc');
    expect(formatShortcut('', false)).toBe('');
  });

  it('writes bare modifiers without a dangling plus', () => {
    expect(formatShortcut('⌘', false)).toBe('Ctrl');
    expect(formatShortcut('⇧⌘', false)).toBe('Ctrl+Shift');
  });

  it('does not read a glyph in the middle of a label as a modifier', () => {
    expect(formatShortcut('T⌘', false)).toBe('T⌘');
  });
});
