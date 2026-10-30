import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollectionTabState, LastRun } from '@shared/types';
import { api, getErrorMessage } from '../../api/atelier';
import { logFailure } from '../../utils/rendererLog';
import { invalidateRecentValuesCache } from '../../features/fieldSuggestions/sources';
import { fieldValueEntriesFromFilter } from '../../features/fieldSuggestions/fieldValueEntries';
import { queryRunKey } from '../../utils/queryRunKey';
import { repairOnCommit } from '../../utils/shellSyntax';
import {
  compileFindOptions,
  currentFilterJson,
  effectivePageLimit,
  filterProblem,
  optionsProblem,
  projectionProblem,
  sortProblem,
} from './builder';

/** Minimum tab slice the runner needs, decoupled from `CollectionTab` for synthetic consumers. */
export interface RunnerTarget {
  id: string;
  connectionId: string;
  dbName: string;
  collection: string;
  state: CollectionTabState;
}

export interface UseQueryRunnerArgs {
  /** Read via a ref so the returned `run` stays stable while observing the latest target. */
  active: RunnerTarget | null;
  patchCollectionState: (id: string, patch: Partial<CollectionTabState>) => void;
  /** Optional so non-Workspace consumers can skip telemetry. */
  recordSessionEvent?: (event: string, key: string) => void;
  /** Delay before `isLoading` flips true, to avoid a flash on fast finds. */
  loadingDelayMs?: number;
}

export interface UseQueryRunnerResult {
  /**
   * `override` merges into the active state for a caller that just
   * dispatched a patch this tick. `target` runs against a tab other than
   * the Focused Tab — resolved fresh at completion time, not snapshotted at
   * open time, so a pinned drawer refreshes the right tab with its current filter/sort/page.
   */
  run: (
    override?: Partial<CollectionTabState>,
    target?: RunnerTarget,
  ) => Promise<void>;
  /** True once the loading delay elapses for a find still in flight against `active`. */
  isLoading: boolean;
  /**
   * Cancels the in-flight find for `target` (default `active`) via the
   * existing `query:cancel` IPC path. A no-op if nothing is running for
   * that target. Returns to idle immediately — the aborted find's own
   * settling (success or error) is discarded, so a cancel never flashes an
   * error banner and never overwrites what was already on screen.
   */
  cancel: (target?: RunnerTarget) => void;
}

export function useQueryRunner({
  active,
  patchCollectionState,
  recordSessionEvent,
  loadingDelayMs = 180,
}: UseQueryRunnerArgs): UseQueryRunnerResult {
  const activeRef = useRef<RunnerTarget | null>(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const patchRef = useRef(patchCollectionState);
  useEffect(() => {
    patchRef.current = patchCollectionState;
  }, [patchCollectionState]);
  const recordRef = useRef(recordSessionEvent);
  useEffect(() => {
    recordRef.current = recordSessionEvent;
  }, [recordSessionEvent]);
  // Keyed by target.id, not a single flag — a pinned drawer's refresh of
  // another tab must not block on or bleed a spinner onto the focused one.
  const runningIdsRef = useRef<Set<string>>(new Set());
  // Monotonic per-target token so a slow background count() from an older
  // run can't overwrite a newer run's totalCount. Also the supersession
  // guard: bumping it (cancel, or a newer run starting) makes the older
  // run's find() settle as a no-op instead of patching stale state.
  const runTokenRef = useRef<Map<string, number>>(new Map());
  // The cancelToken currently owning `target.id`'s in-flight find, so
  // `cancel()` and a superseding `run()` know what to hand `query:cancel`.
  const cancelTokensRef = useRef<Map<string, string>>(new Map());
  // Which write of a `lastRun` is the latest per target, as a number rather
  // than the `lastRun` itself: the runner outlives closed tabs, and holding
  // their documents would keep every closed tab's page alive. A late plan lands
  // only on the run that wrote it: a newer run that wrote nothing (cancelled
  // before its find settled) leaves the screen on this run, and its plan is
  // still true.
  const lastWrittenRef = useRef<Map<string, number>>(new Map());
  const writeSeqRef = useRef(0);
  // The plan last received per target, with the query it explained. A page
  // change runs the same query, so it keeps this plan instead of asking the
  // server to explain it again.
  const explainedRef = useRef<Map<string, { key: string; plan: unknown }>>(new Map());
  const loadingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const timers = loadingTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // Shared by `cancel()` and a superseding `run()`: stop tracking `id` as
  // running right now (not waiting for the abort to settle), so the UI
  // returns to idle immediately and a fresh run isn't blocked behind it.
  const clearRunning = useCallback((id: string) => {
    runningIdsRef.current.delete(id);
    const timer = loadingTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      loadingTimersRef.current.delete(id);
    }
    setLoadingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const cancel = useCallback(
    (explicitTarget?: RunnerTarget) => {
      const target = explicitTarget ?? activeRef.current;
      if (!target) return;
      const token = cancelTokensRef.current.get(target.id);
      if (!token || !runningIdsRef.current.has(target.id)) return;
      // Bump the token first so the in-flight find's own catch/then sees
      // itself as stale and skips patching state once the abort settles.
      runTokenRef.current.set(target.id, (runTokenRef.current.get(target.id) ?? 0) + 1);
      clearRunning(target.id);
      void api.query.cancel({ token }).catch((err: unknown) => logFailure('query cancel', err));
    },
    [clearRunning],
  );

  const run = useCallback(
    async (override?: Partial<CollectionTabState>, explicitTarget?: RunnerTarget) => {
      const target = explicitTarget ?? activeRef.current;
      if (!target) return;
      // A newer Run supersedes an older in-flight one for the same target:
      // cancel it server-side and disown it here so its eventual settling
      // is discarded rather than clobbering this run's result.
      if (runningIdsRef.current.has(target.id)) {
        const staleToken = cancelTokensRef.current.get(target.id);
        if (staleToken) {
          void api.query.cancel({ token: staleToken }).catch((err: unknown) => logFailure('query cancel', err));
        }
      }
      const runToken = (runTokenRef.current.get(target.id) ?? 0) + 1;
      runTokenRef.current.set(target.id, runToken);
      const cancelToken = crypto.randomUUID();
      cancelTokensRef.current.set(target.id, cancelToken);
      /** Returns the write's number when it writes a `lastRun`. */
      const patchState = (id: string, patch: Partial<CollectionTabState>): number | undefined => {
        let seq: number | undefined;
        if (patch.lastRun) lastWrittenRef.current.set(id, (seq = ++writeSeqRef.current));
        patchRef.current(id, patch);
        return seq;
      };
      const recordEvent = recordRef.current;
      const requested: CollectionTabState = override
        ? { ...target.state, ...override }
        : target.state;
      // Covers the Run paths that have no blur to repair Shell Syntax on
      // (auto-run, palette query.run, post-write re-runs) — run strictly
      // before the validity checks below, whose rules stay unchanged.
      // Accumulated into one patch: patchCollectionState isn't a functional
      // updater, so a second call this tick would clobber the first.
      const patch: Partial<CollectionTabState> = {};
      repairOnCommit(requested.queryRaw, (next) => {
        patch.queryRaw = next;
      });
      let builder = requested.builder;
      repairOnCommit(builder.sort, (next) => {
        builder = { ...builder, sort: next };
      });
      repairOnCommit(builder.projectionRaw ?? '', (next) => {
        builder = { ...builder, projectionRaw: next };
      });
      if (builder !== requested.builder) patch.builder = builder;
      const state: CollectionTabState =
        Object.keys(patch).length === 0 ? requested : { ...requested, ...patch };
      if (Object.keys(patch).length > 0) patchState(target.id, patch);
      runningIdsRef.current.add(target.id);
      const existingTimer = loadingTimersRef.current.get(target.id);
      if (existingTimer) clearTimeout(existingTimer);
      loadingTimersRef.current.set(
        target.id,
        setTimeout(() => {
          loadingTimersRef.current.delete(target.id);
          setLoadingIds((prev) => {
            const next = new Set(prev);
            next.add(target.id);
            return next;
          });
        }, loadingDelayMs),
      );
      try {
        const compiled = compileFindOptions(state.builder);
        const filter = currentFilterJson(state);
        if (filter === null) {
          patchState(target.id, {
            lastRun: {
              documents: target.state.lastRun?.documents ?? [],
              durationMs: 0,
              ranAt: new Date().toISOString(),
              // `currentFilterJson` is null exactly when `filterProblem`
              // names a reason, so the pill says what is wrong with the filter.
              error: { code: 'VALIDATION', message: filterProblem(state.queryRaw)! },
            },
          });
          return;
        }
        const sortError = sortProblem(state.builder.sort);
        if (sortError !== null) {
          patchState(target.id, {
            lastRun: {
              documents: target.state.lastRun?.documents ?? [],
              durationMs: 0,
              ranAt: new Date().toISOString(),
              error: { code: 'VALIDATION', message: sortError },
            },
          });
          return;
        }
        const builderError = projectionProblem(state.builder) ?? optionsProblem(state.builder);
        if (builderError !== null) {
          patchState(target.id, {
            lastRun: {
              documents: target.state.lastRun?.documents ?? [],
              durationMs: 0,
              ranAt: new Date().toISOString(),
              error: { code: 'VALIDATION', message: builderError },
            },
          });
          return;
        }
        // W14 §9: what decides which documents match, so the count and the
        // plan describe the same set as the find.
        const match = {
          collation: compiled.collation,
          hint: compiled.hint,
          readPreference: compiled.readPreference,
        };
        const userLimit = compiled.limit;
        const { skip, limit } = effectivePageLimit(userLimit, state.page, state.pageSize);

        // Sending limit=0 to Mongo means "no limit" — short-circuit past the user's cap.
        if (limit === 0) {
          patchState(target.id, {
            lastRun: {
              documents: [],
              durationMs: 0,
              ranAt: new Date().toISOString(),
            },
            lastRunHasMore: false,
            totalCount: userLimit ?? 0,
          });
          return;
        }

        const findResult = await api.query.find({
          connectionId: target.connectionId,
          dbName: target.dbName,
          collection: target.collection,
          filter,
          sort: compiled.sort,
          projection: compiled.projection,
          ...match,
          maxTimeMS: compiled.maxTimeMS,
          limit,
          skip,
          cancelToken,
        });
        // Superseded (cancelled, or a newer run already took over) while
        // this find was in flight — its result is stale, discard it.
        if (runToken !== runTokenRef.current.get(target.id)) return;
        const effectiveHasMore =
          findResult.hasMore &&
          (userLimit === null || skip + limit < userLimit);
        // The explain sees none of skip, limit-per-page or page size, so a run
        // that only moved the page asks the same question as the last one. Any
        // other run, an explicit Run included, asks again: an index built since
        // may have changed the answer.
        const explainKey = JSON.stringify([
          target.connectionId,
          target.dbName,
          target.collection,
          filter,
          compiled.sort,
          compiled.projection,
          userLimit,
          match,
        ]);
        const pageOnly =
          override !== undefined &&
          Object.keys(override).length > 0 &&
          Object.keys(override).every((k) => k === 'page' || k === 'pageSize');
        const known = explainedRef.current.get(target.id);
        const keepPlan = pageOnly && known?.key === explainKey;
        const lastRun: LastRun = {
          documents: findResult.documents,
          durationMs: findResult.durationMs,
          ranAt: new Date().toISOString(),
          ...(keepPlan ? { plan: known.plan } : {}),
        };
        const written = patchState(target.id, { lastRun, lastRunHasMore: effectiveHasMore });
        // Fire-and-forget, like the count below: the plan badge's data. The
        // result never waits on it, and a failed explain only means no badge.
        if (!keepPlan) {
          api.query
            .explain({
              connectionId: target.connectionId,
              dbName: target.dbName,
              collection: target.collection,
              filter,
              sort: compiled.sort,
              projection: compiled.projection,
              ...match,
              verbosity: 'queryPlanner',
            })
            .then((res) => {
              explainedRef.current.set(target.id, { key: explainKey, plan: res.plan });
              if (lastWrittenRef.current.get(target.id) !== written) return;
              patchState(target.id, { lastRun: { ...lastRun, plan: res.plan } });
            })
            .catch((err: unknown) => logFailure('plan explain', err));
        }
        // Fire-and-forget: persists the values this run's conditions actually
        // carried for the value-suggestion popover. Never
        // blocks or fails the run itself — main re-filters by op and secret
        // field path regardless of what's sent here.
        const entries = fieldValueEntriesFromFilter(filter);
        if (entries.length > 0) {
          api.recent
            .recordFieldValues({
              connectionId: target.connectionId,
              dbName: target.dbName,
              collection: target.collection,
              entries,
            })
            .then(() => {
              invalidateRecentValuesCache(target.connectionId, target.dbName, target.collection);
            })
            // Value history is a convenience: a failed write must not fail
            // the run, but it is reported rather than dropped.
            .catch((err: unknown) => logFailure('recording field values', err));
        }
        recordEvent?.(
          'queryRun',
          queryRunKey({
            connectionId: target.connectionId,
            dbName: target.dbName,
            collection: target.collection,
            filter,
            sort: compiled.sort ?? '',
            projection: state.builder.projection,
            projectionRaw: state.builder.projectionRaw,
            limit,
            skip,
            ...match,
            maxTimeMS: compiled.maxTimeMS,
          }),
        );
        // Background count, capped at userLimit so the pager matches what's reachable.
        api.query
          .count({
            connectionId: target.connectionId,
            dbName: target.dbName,
            collection: target.collection,
            filter,
            ...match,
          })
          .then(({ count }) => {
            if (runToken !== runTokenRef.current.get(target.id)) return;
            const displayCount =
              userLimit !== null ? Math.min(count, userLimit) : count;
            patchState(target.id, { totalCount: displayCount });
          })
          .catch((err) => {
            // A superseded run's count is cancelled with it, which is not a failure.
            // The page itself is already on screen; only its total goes missing.
            if (runToken !== runTokenRef.current.get(target.id)) return;
            logFailure('counting the matching documents', err);
          });
      } catch (err) {
        // Superseded (cancelled, or a newer run already took over): the
        // abort's rejection is expected noise, not a result to show — a
        // cancelled find must not flash an error banner over what's there.
        if (runToken !== runTokenRef.current.get(target.id)) return;
        const code = (err as { code?: string }).code ?? 'INTERNAL';
        const message = getErrorMessage(err, 'Unknown error');
        const prevDocs = target.state.lastRun?.documents ?? [];
        patchState(target.id, {
          lastRun: {
            documents: prevDocs,
            durationMs: 0,
            ranAt: new Date().toISOString(),
            error: { code, message },
          },
        });
      } finally {
        // Only the run that still owns `target.id` clears the running/
        // loading state — a superseded run's `finally` must not stomp on
        // the newer run (or a cancel) that already claimed it.
        if (runToken === runTokenRef.current.get(target.id)) {
          clearRunning(target.id);
          if (cancelTokensRef.current.get(target.id) === cancelToken) {
            cancelTokensRef.current.delete(target.id);
          }
        }
      }
    },
    [loadingDelayMs, clearRunning],
  );

  const isLoading = active ? loadingIds.has(active.id) : false;

  return { run, cancel, isLoading };
}
