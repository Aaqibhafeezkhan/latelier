import React from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit, bracketMatching } from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { useIsDark } from '../ThemeContext';
import { atelierDark } from './scriptEditor/editorTheme';
import { mongoCompletions } from './scriptEditor/mongoCompletions';

export interface ScriptEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Cmd/Ctrl+Enter handler. Returning anything is ignored. */
  onRun?: () => void;
  /** Mod-Shift-Enter handler (e.g. "run up to this stage"). Additive to `onRun`. */
  onRunAlt?: () => void;
  /** Fires when the editor's content area loses focus. */
  onBlur?: () => void;
  readOnly?: boolean;
  /** Height in px. The editor fills horizontally. */
  height?: number | string;
  /** Optional stable id used as data-testid. */
  testId?: string;
  /** Accessible name applied to the CodeMirror content region. */
  ariaLabel?: string;
  /**
   * Live collection names for the active connection/db. Powers the
   * `db.<TAB>` autocomplete branch. The reference can change freely; the
   * editor reads the latest value via a ref so the view doesn't rebuild.
   */
  collections?: readonly string[];
  /**
   * Connection/db context for field-name autocomplete inside
   * `db.<coll>.find({ … })` style calls. Field suggestions are skipped when
   * either is missing. Defaults to `'test'` for dbName when the caller
   * passes none. ScriptTab passes the database a run would use: its DB
   * field, else the connection's default database, else `'test'`.
   */
  connectionId?: string;
  dbName?: string;
  /**
   * Factory for a completion source that overrides `mongoCompletions`
   * entirely (e.g. the aggregation stage-body source, whose bodies are
   * top-level `{ … }` objects rather than `db.<coll>.<method>(…)` calls).
   * Called once, inside the same mount effect that builds `mongoCompletions`
   * — a plain function value (not a factory) can't be constructed during
   * the caller's render if it closes over refs (React's `react-hooks/refs`
   * rule), so the factory indirection defers that read to here. When
   * provided, `collections`/`connectionId`/`dbName` are ignored for
   * completion purposes — the caller's source is expected to read its own
   * context.
   */
  completionSource?: () => CompletionSource;
}

/**
 * Thin CodeMirror 6 wrapper for the W12 script tab. Controlled-component
 * shape: parent owns `value`, the editor pushes `onChange` on every doc
 * mutation. The view is constructed once; subsequent value changes are
 * applied as transactions when they don't already match the doc text
 * (avoids a feedback loop with onChange).
 */
export function ScriptEditor({
  value,
  onChange,
  onRun,
  onRunAlt,
  onBlur,
  readOnly = false,
  height = '100%',
  testId,
  ariaLabel,
  collections,
  connectionId,
  dbName,
  completionSource,
}: ScriptEditorProps) {
  const isDark = useIsDark();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const themeCompartment = React.useRef(new Compartment());
  const readOnlyCompartment = React.useRef(new Compartment());
  const ariaLabelCompartment = React.useRef(new Compartment());

  // Latest callbacks via refs so the editor's keymap closures see fresh
  // versions without remounting the view on every parent re-render.
  const onChangeRef = React.useRef(onChange);
  const onRunRef = React.useRef(onRun);
  const onRunAltRef = React.useRef(onRunAlt);
  const collectionsRef = React.useRef<readonly string[]>(collections ?? []);
  const connectionIdRef = React.useRef<string | undefined>(connectionId);
  const dbNameRef = React.useRef<string | undefined>(dbName);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  React.useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);
  React.useEffect(() => {
    onRunAltRef.current = onRunAlt;
  }, [onRunAlt]);
  React.useEffect(() => {
    collectionsRef.current = collections ?? [];
  }, [collections]);
  React.useEffect(() => {
    connectionIdRef.current = connectionId;
  }, [connectionId]);
  React.useEffect(() => {
    dbNameRef.current = dbName;
  }, [dbName]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const runKeymap = keymap.of([
      {
        key: 'Mod-Enter',
        run: () => {
          onRunRef.current?.();
          return true;
        },
      },
      {
        key: 'Mod-Shift-Enter',
        run: () => {
          // Only claim the keystroke when a caller actually wants it (e.g.
          // the aggregation stage body's "run to here"). ScriptTab doesn't
          // pass `onRunAlt`, so returning `false` here lets CodeMirror fall
          // through to its default handling exactly as before this prop
          // existed — AC7 (ScriptTab behavior unchanged).
          if (!onRunAltRef.current) return false;
          onRunAltRef.current();
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) onChangeRef.current(u.state.doc.toString());
    });

    // Mantine's dialogs close on Escape via a `capture: true` `window`
    // listener (see `FieldAutocompleteInput`'s identical marker), which fires
    // before this editor's own Escape binding (`completionKeymap`'s
    // `closeCompletion`) ever runs — so `stopPropagation` from in here is too
    // late to matter, and CLAUDE.md's "Escape closes the completion popup
    // instead" trap goes uncaught for any caller inside a Mantine dialog.
    // Marking `contentDOM` while a completion is open is the same escape
    // hatch `FieldAutocompleteInput` already uses: Mantine checks the
    // attribute on `event.target` and skips closing, leaving Escape to close
    // just the popup; the following Escape (no completion open) reaches the
    // dialog as normal.
    const completionMarker = EditorView.updateListener.of((u) => {
      if (completionStatus(u.state) !== null) u.view.contentDOM.setAttribute('data-mantine-stop-propagation', 'true');
      else u.view.contentDOM.removeAttribute('data-mantine-stop-propagation');
    });

    // A caller-supplied `completionSource` replaces `mongoCompletions`
    // entirely (rather than merging both) so results aren't duplicated —
    // e.g. the aggregation stage-body source below, whose bodies are
    // top-level `{ … }` objects rather than `db.<coll>.<method>(…)` calls.
    const completionExt = completionSource
      ? javascriptLanguage.data.of({ autocomplete: completionSource() })
      : mongoCompletions({
          getCollections: () => collectionsRef.current,
          getFieldContext: () => {
            const cid = connectionIdRef.current;
            if (!cid) return null;
            return { connectionId: cid, dbName: dbNameRef.current?.trim() || 'test' };
          },
        });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        completionExt,
        highlightActiveLine(),
        indentUnit.of('  '),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        javascript(),
        runKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        themeCompartment.current.of(isDark ? atelierDark : []),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        ariaLabelCompartment.current.of(
          EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        ),
        updateListener,
        completionMarker,
        EditorView.theme({
          '&': { height: '100%', fontSize: 'var(--atelier-editor-font-size, 13px)' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme on dark/light flip.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(isDark ? atelierDark : []),
    });
  }, [isDark]);

  // Toggle read-only at runtime.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(readOnly),
      ),
    });
  }, [readOnly]);

  // Update the content region's accessible name at runtime (e.g. a stage
  // body's op label changes without remounting the editor).
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: ariaLabelCompartment.current.reconfigure(
        EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      ),
    });
  }, [ariaLabel]);

  // Sync external value into the editor when the parent changes it
  // (e.g. the tab restored from disk). Skip when the editor's current
  // doc already matches — otherwise typing would cycle through a
  // re-dispatch on every keystroke.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      data-testid={testId}
      onBlur={onBlur}
      style={{ height, width: '100%', overflow: 'hidden' }}
    />
  );
}
