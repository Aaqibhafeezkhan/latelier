import React from 'react';
import { api } from '../../api/atelier';
import { ejsonParse, isEjsonDocument, isPlainDocument } from '../../utils/ejson';
import { suggestIndex } from '../../utils/indexSuggestion';
import { compileFindOptions, optionsProblem, parseSortString } from './builder';
import { useCollectionWorkspace } from './context';
import type { ExplainRunResult } from './Aggregation/ExplainDrawer';
import type { ExplainVerbosity } from '@shared/types';

/** `suggestIndex`'s filter argument — an unparseable or non-document filter is treated as empty rather than thrown. */
function parseFilterDoc(raw: string): Record<string, unknown> {
  try {
    const parsed = ejsonParse(raw);
    return isPlainDocument(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The find explain the Documents view opens an `ExplainDrawer` with — shared
 * by the QueryBar's Explain menu and the result bar's plan badge, which must
 * ask the same question of the same query.
 *
 * `readFilterText` is where the filter text comes from at call time: the
 * QueryBar passes its field's `commitNow` (X14's repair path), the result bar
 * the committed `queryRaw`.
 */
export function useFindExplain(readFilterText: () => string): {
  runExplain: (verbosity: ExplainVerbosity) => Promise<ExplainRunResult>;
  onCreateIndex: (() => void) | undefined;
} {
  const { state, actions, meta } = useCollectionWorkspace();
  const findOptions = React.useMemo(() => compileFindOptions(state.builder), [state.builder]);
  const optionError = React.useMemo(() => optionsProblem(state.builder), [state.builder]);
  const { connectionId, dbName, collection } = meta;

  const runExplain = React.useCallback(
    (verbosity: ExplainVerbosity) => {
      // The rule (never widen a refused filter to `{}`) applies even to a
      // read-only path like Explain.
      const text = readFilterText();
      if (!isEjsonDocument(text)) return Promise.reject(new Error('No runnable filter'));
      // Same for the options: the builder's message, not the server's refusal.
      if (optionError !== null) return Promise.reject(new Error(optionError));
      return api.query.explain({
        connectionId,
        dbName,
        collection,
        filter: text,
        sort: findOptions.sort,
        projection: findOptions.projection,
        collation: findOptions.collation,
        hint: findOptions.hint,
        readPreference: findOptions.readPreference,
        verbosity,
      });
    },
    [connectionId, dbName, collection, findOptions, optionError, readFilterText],
  );

  // Same inputs `runExplain` reads — the button only appears on the explain
  // that was just run against them, so the suggestion has to read the same
  // query. `actions.openCreateIndex` is optional (saved-query preview,
  // ScriptTab's synthetic provider don't have a Structure view), so
  // `undefined` here means `ExplainDrawer` renders no button at all.
  const openCreateIndex = actions.openCreateIndex;
  const onCreateIndex = openCreateIndex
    ? () => {
        openCreateIndex(
          // The table header's parser: a direction the driver refuses, or a
          // `{$meta}` key, drops that field rather than prefilling it.
          suggestIndex(parseFilterDoc(readFilterText()), parseSortString(findOptions.sort ?? '')),
        );
      }
    : undefined;

  return { runExplain, onCreateIndex };
}
