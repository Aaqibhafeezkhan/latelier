import React from 'react';
import { api } from '../../api/atelier';
import { ejsonParse, isEjsonDocument, isPlainDocument } from '../../utils/ejson';
import { suggestIndex } from '../../utils/indexSuggestion';
import { compileFindOptions } from './builder';
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
 * `suggestIndex`'s sort argument. Per W16 §6/platform facts: the sort is a
 * raw EJSON string (`compileFindOptions`'s output, not a filterTree node),
 * parsed the same way as the filter and then normalized with `Number()` —
 * a direction other than `±1` (e.g. `{$meta:'textScore'}`) drops that field
 * rather than prefilling it.
 */
function parseSortDoc(raw: string | undefined): Record<string, 1 | -1> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = ejsonParse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainDocument(parsed)) return undefined;
  const result: Record<string, 1 | -1> = {};
  for (const [field, direction] of Object.entries(parsed as Record<string, unknown>)) {
    const n = Number(direction);
    if (n === 1 || n === -1) result[field] = n;
  }
  return result;
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
  const { connectionId, dbName, collection } = meta;

  const runExplain = React.useCallback(
    (verbosity: ExplainVerbosity) => {
      // The rule (never widen a refused filter to `{}`) applies even to a
      // read-only path like Explain.
      const text = readFilterText();
      if (!isEjsonDocument(text)) return Promise.reject(new Error('No runnable filter'));
      return api.query.explain({
        connectionId,
        dbName,
        collection,
        filter: text,
        sort: findOptions.sort,
        projection: findOptions.projection,
        verbosity,
      });
    },
    [connectionId, dbName, collection, findOptions.sort, findOptions.projection, readFilterText],
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
          suggestIndex(parseFilterDoc(readFilterText()), parseSortDoc(findOptions.sort)),
        );
      }
    : undefined;

  return { runExplain, onCreateIndex };
}
