import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// The dark editor theme, built from the app's own tokens (src/index.css) so the
// editor follows the surfaces around it instead of carrying a second palette.
// The syntax colours are the `--atelier-syn-*` tokens in the dark block; a unit
// test keeps each of them readable against `--atelier-surface`.
export const atelierDark: Extension = [
  EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--atelier-surface)',
        color: 'var(--atelier-text)',
      },
      '.cm-content': { caretColor: 'var(--atelier-accent)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--atelier-accent)' },
      // The editor uses the browser's own selection (no drawSelection), so ::selection is
      // what paints; .cm-selectionBackground covers it if drawSelection is ever added.
      '.cm-content ::selection, .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
        { backgroundColor: 'var(--atelier-editor-selection)' },
      '.cm-activeLine': { backgroundColor: 'var(--atelier-surface-active)' },
      '.cm-gutters': {
        backgroundColor: 'var(--atelier-surface-raised)',
        color: 'var(--atelier-text-muted)',
        borderRight: '1px solid var(--atelier-border)',
      },
      '.cm-activeLineGutter': { backgroundColor: 'var(--atelier-surface-active)' },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--atelier-syn-keyword)' },
      { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--atelier-syn-string)' },
      { tag: [t.number, t.bool, t.null], color: 'var(--atelier-color-number)' },
      { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--atelier-syn-property)' },
      { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--atelier-syn-comment)', fontStyle: 'italic' },
      { tag: [t.punctuation, t.bracket, t.operator, t.separator], color: 'var(--atelier-syn-punct)' },
    ]),
  ),
];
