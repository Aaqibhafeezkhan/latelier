import React from 'react';
import type { FeatureHintId } from '@shared/types';
import {
  dismissHint as dismissHintStorage,
  getDismissedHints,
  resetHints as resetHintsStorage,
} from './storage';
import { HintsContext, type HintsContextValue } from './HintsContext';
import { HINT_REGISTRY } from './registry';
import { logFailure } from '../utils/rendererLog';

const SETTLE_MS = 1500;
const SESSION_COUNTER_CAP = 500;

export function HintsProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = React.useState(false);
  const [settled, setSettled] = React.useState(false);
  const [dismissedIds, setDismissedIds] = React.useState<Set<FeatureHintId>>(
    () => new Set(),
  );
  const [candidates, setCandidates] = React.useState<FeatureHintId[]>([]);
  // Nested by kind so callers' keys (which may contain any character) never
  // collide with each other across kinds. Each inner map is bounded to
  // SESSION_COUNTER_CAP entries via FIFO eviction.
  const sessionCounters = React.useRef<Map<string, Map<string, number>>>(
    new Map(),
  );

  React.useEffect(() => {
    let cancelled = false;
    void getDismissedHints()
      .then((s) => {
        if (cancelled) return;
        setDismissedIds(new Set(s.dismissedIds));
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  const isDismissed = React.useCallback(
    (id: FeatureHintId) => dismissedIds.has(id),
    [dismissedIds],
  );

  const dismiss = React.useCallback((id: FeatureHintId) => {
    setDismissedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    // Memory state is the source of truth for the rest of the session.
    void dismissHintStorage(id).catch((err) => logFailure('saving a dismissed hint', err));
  }, []);

  const reset = React.useCallback(() => {
    setDismissedIds(new Set());
    void resetHintsStorage().catch((err) => logFailure('resetting hints', err));
  }, []);

  const registerCandidate = React.useCallback((id: FeatureHintId) => {
    setCandidates((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const unregisterCandidate = React.useCallback((id: FeatureHintId) => {
    setCandidates((prev) => prev.filter((c) => c !== id));
  }, []);

  const recordSessionEvent = React.useCallback((kind: string, key: string) => {
    let inner = sessionCounters.current.get(kind);
    if (!inner) {
      inner = new Map();
      sessionCounters.current.set(kind, inner);
    }
    if (!inner.has(key) && inner.size >= SESSION_COUNTER_CAP) {
      const oldest = inner.keys().next().value;
      if (oldest !== undefined) inner.delete(oldest);
    }
    inner.set(key, (inner.get(key) ?? 0) + 1);
  }, []);

  const getSessionEventCount = React.useCallback((kind: string, key: string) => {
    return sessionCounters.current.get(kind)?.get(key) ?? 0;
  }, []);

  // Lowest `priority` wins, not registration order — the primary-path hint
  // (Run) must beat a secondary one even when it registers later. Ties keep
  // whichever candidate `reduce` saw first, i.e. mount order.
  const visibleId = candidates.reduce<FeatureHintId | null>((best, id) => {
    if (best === null) return id;
    return HINT_REGISTRY[id].priority < HINT_REGISTRY[best].priority ? id : best;
  }, null);

  const value = React.useMemo<HintsContextValue>(
    () => ({
      loaded,
      settled,
      isDismissed,
      dismiss,
      reset,
      registerCandidate,
      unregisterCandidate,
      visibleId,
      recordSessionEvent,
      getSessionEventCount,
    }),
    [
      loaded,
      settled,
      isDismissed,
      dismiss,
      reset,
      registerCandidate,
      unregisterCandidate,
      visibleId,
      recordSessionEvent,
      getSessionEventCount,
    ],
  );

  return <HintsContext.Provider value={value}>{children}</HintsContext.Provider>;
}
