import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FieldSource,
  FieldSuggestion,
  OperatorSuggestion,
  Suggestion,
  SuggestionContext,
  ValueSource,
  ValueSuggestion,
} from './types';
import { DEFAULT_FIELD_SOURCES, DEFAULT_VALUE_SOURCES } from './sources';

export interface UseSuggestionsOpts {
  fieldSources?: readonly FieldSource[];
  valueSources?: readonly ValueSource[];
  /** Max items returned. Popover renders whatever it gets. */
  limit?: number;
}

export interface UseSuggestionsResult {
  items: Suggestion[];
  loading: boolean;
}

function scoreMatch(token: string, candidate: string): number {
  if (!token) return 1;
  const t = token.toLowerCase();
  const p = candidate.toLowerCase();
  if (p === t) return 100;
  if (p.startsWith(t)) return 50;
  // Operator-friendly: "eq" should match "$eq". Score against the stripped
  // candidate too when the user omitted the leading $.
  if (!t.startsWith('$') && p.startsWith('$')) {
    const stripped = p.slice(1);
    if (stripped === t) return 100;
    if (stripped.startsWith(t)) return 50;
  }
  const idx = p.indexOf(t);
  if (idx !== -1) return 10 - Math.min(idx, 9);
  return -1;
}

function rankField(token: string, s: FieldSuggestion): number {
  const m = scoreMatch(token, s.path);
  if (m < 0) return m;
  return m + Math.min(s.frequency ?? 0, 50) / 50;
}

function rankValue(token: string, s: ValueSuggestion): number {
  const m = scoreMatch(token, s.display);
  if (m < 0) return m;
  return m + Math.min(s.frequency ?? 0, 50) / 50;
}

function rankOperator(token: string, s: OperatorSuggestion): number {
  const m = scoreMatch(token, s.name);
  if (m < 0) return m;
  // Off-context ops still surface, but after in-context matches.
  return s.offContext ? m - 30 : m;
}

/**
 * The sync pass calls every source to find the sync ones, so an async source
 * also runs there and its promise is dropped. The effect below runs it again
 * and owns its outcome, so a rejection of this duplicate must not surface as
 * an unhandled rejection.
 */
function ignoreDuplicateRun(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

/**
 * Compose field or value sources into a ranked suggestion list for a given
 * input token. Sync sources resolve immediately; async sources populate
 * later without blocking render.
 */
export function useSuggestions(
  context: SuggestionContext | null,
  token: string,
  opts: UseSuggestionsOpts = {},
): UseSuggestionsResult {
  const limit = opts.limit ?? 50;
  const isValueMode = context?.target !== undefined && context?.target !== null;

  // Sources are configuration: capture once on mount so callers can hand
  // us freshly-allocated arrays every render without re-firing the effect.
  // The trade-off — dynamic swapping of sources is not supported — is
  // acceptable; the public plan has one fixed composition per surface.
  const [sources] = useState(() => ({
    fieldSources: opts.fieldSources ?? DEFAULT_FIELD_SOURCES,
    valueSources: opts.valueSources ?? DEFAULT_VALUE_SOURCES,
  }));

  const [asyncItems, setAsyncItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const contextKey = context
    ? `${context.connectionId}|${context.dbName}|${context.collection}|${context.target?.field ?? ''}|${context.target?.operator ?? ''}|${context.operatorContext ?? ''}`
    : null;
  const recentDocs = context?.recentDocs;

  const syncItems = useMemo<Suggestion[]>(() => {
    if (!context) return [];
    if (isValueMode) {
      const tgt = context.target!;
      const out: ValueSuggestion[] = [];
      for (const src of sources.valueSources) {
        const r = src({ ...context, target: tgt });
        if (r instanceof Promise) ignoreDuplicateRun(r);
        else out.push(...r);
      }
      return out;
    }
    const out: Array<FieldSuggestion | OperatorSuggestion> = [];
    for (const src of sources.fieldSources) {
      const r = src(context);
      if (r instanceof Promise) ignoreDuplicateRun(r);
      else out.push(...r);
    }
    return out;
    // contextKey/recentDocs capture context changes by value; context itself
    // is included so TS understands the closure is well-typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, recentDocs, isValueMode, sources]);

  useEffect(() => {
    reqId.current += 1;
    const myReq = reqId.current;
    void (async () => {
      // A superseded request's `finally` below skips `setLoading`, so the
      // paths that end this request without starting a new async batch clear
      // it themselves — else a context that goes away mid-load sticks it on.
      if (!context) {
        if (myReq === reqId.current) {
          setAsyncItems((prev) => (prev.length === 0 ? prev : []));
          setLoading(false);
        }
        return;
      }
      const selectedSources = isValueMode ? sources.valueSources : sources.fieldSources;
      const asyncRuns: Array<Promise<Suggestion[]>> = [];
      for (const src of selectedSources) {
        const r = isValueMode
          ? (src as ValueSource)({ ...context, target: context.target! })
          : (src as FieldSource)(context);
        if (r instanceof Promise) asyncRuns.push(r as Promise<Suggestion[]>);
      }
      if (asyncRuns.length === 0) {
        if (myReq === reqId.current) {
          setAsyncItems((prev) => (prev.length === 0 ? prev : []));
          setLoading(false);
        }
        return;
      }
      if (myReq === reqId.current) setLoading(true);
      try {
        // A source that rejects only loses its own batch: the sync items and
        // the healthy async sources still show, and `loading` always settles.
        const settled = await Promise.allSettled(asyncRuns);
        if (myReq !== reqId.current) return;
        const batches = settled.flatMap((r) => {
          if (r.status === 'fulfilled') return r.value;
          console.warn('[suggestions] source failed', r.reason);
          return [];
        });
        setAsyncItems(batches as Suggestion[]);
      } finally {
        // A newer request owns `loading`; only the latest one may clear it.
        if (myReq === reqId.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, recentDocs, isValueMode, sources]);

  const items = useMemo<Suggestion[]>(() => {
    const all = [...syncItems, ...asyncItems];
    // Dedupe by a key that matches across kinds.
    const byKey = new Map<string, Suggestion>();
    for (const s of all) {
      let key: string;
      if (s.kind === 'field') key = `F:${s.path}`;
      else if (s.kind === 'operator') key = `O:${s.name}`;
      // `display` is the unique user-visible form; `value` may be an EJSON
      // object (ObjectId/Date/...), so String() collapses different objects
      // into "[object Object]" and merges unrelated values.
      else key = `V:${s.display}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, s);
      } else if (s.kind === 'field' && existing.kind === 'field') {
        const merged: FieldSuggestion = {
          ...existing,
          frequency: (existing.frequency ?? 0) + (s.frequency ?? 0),
          type: existing.type ?? s.type,
        };
        byKey.set(key, merged);
      } else if (s.kind === 'value' && existing.kind === 'value') {
        const merged: ValueSuggestion = {
          ...existing,
          frequency: (existing.frequency ?? 0) + (s.frequency ?? 0),
        };
        byKey.set(key, merged);
      }
    }

    const ranked: Array<{ s: Suggestion; r: number }> = [];
    for (const s of byKey.values()) {
      let r: number;
      if (s.kind === 'field') r = rankField(token, s);
      else if (s.kind === 'operator') r = rankOperator(token, s);
      else r = rankValue(token, s);
      if (r >= 0) ranked.push({ s, r });
    }
    ranked.sort((a, b) => b.r - a.r);
    return ranked.slice(0, limit).map((e) => e.s);
  }, [syncItems, asyncItems, token, limit]);

  return { items, loading };
}
