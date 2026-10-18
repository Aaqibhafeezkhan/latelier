import React from 'react';

/**
 * Which nested field paths are expanded inside a row's field tree. Ephemeral
 * and view-local; resets when the document set changes so the Set doesn't
 * grow monotonically across queries. "Adjust state during render" pattern,
 * not a useEffect, to avoid a cascading effect-then-render cycle.
 */
export function useDeepPaths(documents: unknown[]) {
  const [deepPaths, setDeepPaths] = React.useState<Set<string>>(new Set());
  const [prevDocuments, setPrevDocuments] = React.useState<unknown[]>(documents);
  if (prevDocuments !== documents) {
    setPrevDocuments(documents);
    setDeepPaths(new Set());
  }
  const toggleDeepPath = React.useCallback((p: string) => {
    setDeepPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);
  return { deepPaths, toggleDeepPath };
}
