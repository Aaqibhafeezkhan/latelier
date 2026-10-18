import React from 'react';
import { themeVars } from '../../../theme/themeVars';
import { I } from '../../../icons';
import { Button, Group, Modal, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, getErrorMessage, isIpcError } from '../../../api/atelier';
import { notify } from '../../../theme/notifications';
import type {
  AggregationLastRun,
  AggregationTabState,
  ExplainVerbosity,
  ResultViewMode,
  Stage,
  StageOp,
} from '@shared/types';
import { repairOnCommit } from '../../../utils/shellSyntax';
import {
  addStage,
  duplicateStage,
  moveStage,
  removeStage as removeStageOp,
  restoreStage,
  setBody as setBodyOp,
  setOp as setOpOp,
  stageSig,
  toggleEnabled as toggleEnabledOp,
  validatePipeline,
  isWriteStage,
} from './pipeline';
import { PipelineOutline } from './PipelineOutline';
import { StageAccordion } from './StageAccordion';
import { OutputPanel } from './OutputPanel';
import { useRegisterCommands } from '../../../commands/useRegisterCommands';
import { useLatest } from '../../../commands/useLatest';
import { useDialogFocusReturn } from '../../../hooks/useDialogFocusReturn';
import type { SuggestionContext } from '../../../features/fieldSuggestions/types';
import { invalidateSampleSchemaCache } from '../../../features/fieldSuggestions/sources/sampleSchemaSource';
import { ExplainDrawer } from './ExplainDrawer';
import { SaveAsCollectionModal } from './SaveAsCollectionModal';
import { notifyCollectionChanged } from '../../../state/collectionChanges';
import { SaveAsViewModal } from './SaveAsViewModal';
import { saveResultMessage } from './saveResultMessage';
import { SavePipelineModal } from './SavePipelineModal';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
  state: AggregationTabState;
  darkMode: boolean;
  sourceCount: number | null;
  onPatch: (patch: Partial<AggregationTabState>) => void;
}

export function AggregationTab({
  connectionId,
  dbName,
  collection,
  state,
  darkMode,
  sourceCount,
  onPatch,
}: Props) {
  const T = themeVars;
  const stages = state.stages;

  const [running, setRunning] = React.useState(false);
  const [explainOpen, setExplainOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveAsCollectionOpen, setSaveAsCollectionOpen] = React.useState(false);
  // The repaired stages the view is saved from, or null while the dialog is closed.
  const [saveAsViewStages, setSaveAsViewStages] = React.useState<Stage[] | null>(null);
  const [writeWarning, setWriteWarning] = React.useState<{
    op: string;
    target?: string;
  } | null>(null);
  const runTokenRef = React.useRef<string | null>(null);
  // A confirmed write run can't be dropped on Cancel: main lets a write that
  // was already sent run to completion. `runIsWriteRef` marks the run in
  // flight as one; `stopping` (state for the button, ref for the settling
  // run's closure) is the Cancel-was-pressed state while it settles.
  const runIsWriteRef = React.useRef(false);
  const stoppingRef = React.useRef(false);
  const [stopping, setStopping] = React.useState(false);
  const [lastRunSig, setLastRunSig] = React.useState<Map<number, string>>(
    () => new Map(),
  );
  // Per-stage preview race guard (N0.4): a dedicated monotonic token per
  // stageId, separate from the main Run path's runTokenRef/running above —
  // reusing those would let the two paths clobber each other.
  const previewTokenRef = React.useRef(new Map<number, number>());
  const [previewLoading, setPreviewLoading] = React.useState<Set<number>>(
    () => new Set(),
  );

  const staleStageIds = React.useMemo(() => {
    const set = new Set<number>();
    if (!state.lastRun) return set;
    for (const s of stages) {
      const prev = lastRunSig.get(s.id);
      if (prev === undefined || prev !== stageSig(s)) {
        set.add(s.id);
      }
    }
    return set;
  }, [stages, state.lastRun, lastRunSig]);

  const validation = React.useMemo(() => validatePipeline(stages), [stages]);

  const markDirty = React.useCallback(() => {
    if (!state.dirty) onPatch({ dirty: true });
  }, [state.dirty, onPatch]);

  // docs/adr/0013 — removing a stage is local editor state, not a
  // server-side delete: no confirm, just an Undo toast. Refs so the toast's
  // action (clicked seconds later) reads the pipeline as it is then, not as
  // it was at delete time.
  const stagesRef = useLatest(stages);
  const onPatchRef = useLatest(onPatch);
  const markDirtyRef = useLatest(markDirty);
  // The one outstanding undo toast for this tab, single-level: a second
  // delete reuses the id so it replaces the first toast's Undo target
  // instead of stacking a second one.
  const undoToastIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    return () => {
      if (undoToastIdRef.current) notifications.hide(undoToastIdRef.current);
    };
  }, []);

  // ── Pipeline ops ─────────────────────────────────────────────────────

  const onAddStage = (op: StageOp | string, afterIndex?: number) => {
    const next = addStage({ stages, activeStageId: state.activeStageId }, op, afterIndex);
    onPatch({ stages: next.stages, activeStageId: next.activeStageId });
    markDirty();
  };

  const onRemoveStage = (id: number) => {
    const index = stages.findIndex((s) => s.id === id);
    const removedStage = stages[index];
    const next = removeStageOp({ stages, activeStageId: state.activeStageId }, id);
    onPatch({ stages: next.stages, activeStageId: next.activeStageId });
    markDirty();
    if (!removedStage) return;
    undoToastIdRef.current = notify.info(`Removed stage ${index + 1} (${removedStage.op})`, {
      id: undoToastIdRef.current ?? undefined,
      action: {
        label: 'Undo',
        onClick: () => {
          const restored = restoreStage(
            { stages: stagesRef.current, activeStageId: null },
            removedStage,
            index,
          );
          onPatchRef.current({ stages: restored.stages, activeStageId: restored.activeStageId });
          markDirtyRef.current();
          undoToastIdRef.current = null;
        },
      },
    });
  };

  const onDuplicateStage = (id: number) => {
    const next = duplicateStage({ stages, activeStageId: state.activeStageId }, id);
    onPatch({ stages: next.stages, activeStageId: next.activeStageId });
    markDirty();
  };

  const onMoveUp = (index: number) => {
    if (index === 0) return;
    const next = moveStage({ stages, activeStageId: state.activeStageId }, index, index - 1);
    onPatch({ stages: next.stages });
    markDirty();
  };

  const onMoveDown = (index: number) => {
    if (index === stages.length - 1) return;
    const next = moveStage({ stages, activeStageId: state.activeStageId }, index, index + 1);
    onPatch({ stages: next.stages });
    markDirty();
  };

  const onReorderStage = (from: number, to: number) => {
    const next = moveStage({ stages, activeStageId: state.activeStageId }, from, to);
    onPatch({ stages: next.stages });
    markDirty();
  };

  const onSetBody = (id: number, body: string) => {
    const next = setBodyOp({ stages, activeStageId: state.activeStageId }, id, body);
    onPatch({ stages: next.stages });
    markDirty();
  };

  const onToggleEnabled = (id: number) => {
    const next = toggleEnabledOp({ stages, activeStageId: state.activeStageId }, id);
    onPatch({ stages: next.stages });
    markDirty();
  };

  const onChangeOp = (id: number, op: StageOp | string) => {
    const next = setOpOp({ stages, activeStageId: state.activeStageId }, id, op);
    onPatch({ stages: next.stages });
    markDirty();
  };

  const onSelectStage = (id: number) => {
    onPatch({ activeStageId: state.activeStageId === id ? null : id });
  };

  // ── Runner ───────────────────────────────────────────────────────────

  /**
   * X14 §4 — the layer for the paths with no field to blur, the same role
   * `useQueryRunner.run` plays for the Filter Bar (T2). The stage editor
   * repairs on blur, but a stage the user never clicked into has never
   * blurred: `addStage` writes a Shell Syntax template straight into state,
   * and `validatePipeline` now passes it, so Run and Explain light up on a
   * body the main process's `ejsonParse` would refuse. Adding three stages and
   * pressing Run touches no editor at all.
   *
   * Accumulated into one patch rather than one per stage: `patchCollectionState`
   * is not a functional updater, so a second call in the same tick would
   * clobber the first. The returned array is what the caller must run — a
   * patch is async, so re-reading `stages` here would still see the old text.
   */
  const repairStageBodies = React.useCallback((): Stage[] => {
    let next = stages;
    stages.forEach((s, i) => {
      repairOnCommit(s.body, (repaired) => {
        if (next === stages) next = [...stages];
        next[i] = { ...s, body: repaired };
      });
    });
    if (next !== stages) onPatch({ stages: next });
    return next;
  }, [stages, onPatch]);

  const executeRun = React.useCallback(
    async (allowWrite: boolean) => {
      if (!validation.ok) return;
      const runStages = repairStageBodies();
      const token = crypto.randomUUID();
      runTokenRef.current = token;
      runIsWriteRef.current = allowWrite;
      stoppingRef.current = false;
      setStopping(false);
      setRunning(true);
      try {
        const result = await api.agg.run({
          connectionId: connectionId,
          dbName: dbName,
          collection: collection,
          stages: runStages,
          cancelToken: token,
          allowWrite,
        });
        if (runTokenRef.current !== token) return;
        const lastRun: AggregationLastRun = {
          rows: result.rows,
          durationMs: result.durationMs,
          ranAt: new Date().toISOString(),
          stageCounts: result.stageCounts,
          stageSamples: result.stageSamples,
          hasMore: result.hasMore,
        };
        onPatch({ lastRun });
        setLastRunSig(new Map(runStages.map((s) => [s.id, stageSig(s)])));
        if (stoppingRef.current) {
          notify.info('The write had already started, so it ran to completion.');
        }
      } catch (e) {
        if (runTokenRef.current !== token) return;
        // The cancel reached main before the write was sent: nothing ran, and
        // the tab stops quietly, as it does for a cancelled read-only run.
        if (stoppingRef.current && isIpcError(e) && e.message === 'cancelled') return;
        if (isIpcError(e)) {
          const details = (e.details ?? {}) as {
            kind?: string;
            writeStageOp?: string;
            targetCollection?: string;
          };
          if (e.code === 'VALIDATION' && details.kind === 'writeStage') {
            setWriteWarning({
              op: details.writeStageOp ?? '$out',
              target: details.targetCollection,
            });
            return;
          }
          onPatch({
            lastRun: {
              rows: state.lastRun?.rows ?? [],
              durationMs: 0,
              ranAt: new Date().toISOString(),
              stageCounts: state.lastRun?.stageCounts ?? {},
              stageSamples: state.lastRun?.stageSamples ?? {},
              error: { code: e.code, message: e.message, details: e.details },
            },
          });
        } else {
          onPatch({
            lastRun: {
              rows: state.lastRun?.rows ?? [],
              durationMs: 0,
              ranAt: new Date().toISOString(),
              stageCounts: state.lastRun?.stageCounts ?? {},
              stageSamples: state.lastRun?.stageSamples ?? {},
              error: { code: 'INTERNAL', message: String(e) },
            },
          });
        }
      } finally {
        // A confirmed run is one with a `$out`/`$merge` stage, whose target
        // main parses out of the stage body, so the renderer can't name the
        // collection it wrote: drop the connection's samples, even when the
        // run threw part-way through a `$merge`.
        if (allowWrite) invalidateSampleSchemaCache(connectionId);
        if (runTokenRef.current === token) {
          runTokenRef.current = null;
          stoppingRef.current = false;
          setStopping(false);
          setRunning(false);
        }
      }
    },
    [connectionId, dbName, collection, repairStageBodies, validation.ok, onPatch, state.lastRun],
  );

  const onRun = () => {
    if (running || !validation.ok) return;
    void executeRun(false);
  };

  const onCancelRun = () => {
    const token = runTokenRef.current;
    if (!token || stoppingRef.current) return;
    void api.agg.cancel({ token }).catch(() => {});
    if (runIsWriteRef.current) {
      // Keep the token: the run settles as completed (the write was already
      // sent) or as cancelled (it was not), and executeRun reports which.
      stoppingRef.current = true;
      setStopping(true);
      notify.info("A write stage can't be interrupted once it has started.", {
        title: 'Stopping…',
      });
      return;
    }
    runTokenRef.current = null;
    setRunning(false);
  };

  const onRunToStage = async (stageId: number) => {
    const runStages = repairStageBodies();
    const idx = runStages.findIndex((s) => s.id === stageId);
    if (idx === -1) return;
    const upto = runStages.slice(0, idx + 1).filter((s) => s.enabled);
    if (upto.length === 0) return;
    const token = (previewTokenRef.current.get(stageId) ?? 0) + 1;
    previewTokenRef.current.set(stageId, token);
    setPreviewLoading((prev) => {
      const next = new Set(prev);
      next.add(stageId);
      return next;
    });
    try {
      const preview = await api.agg.previewUpToStage({
        connectionId: connectionId,
        dbName: dbName,
        collection: collection,
        stages: upto,
        limit: 5,
      });
      // A newer call for this same stage superseded us — drop this stale
      // response instead of clobbering what it already committed.
      if (previewTokenRef.current.get(stageId) !== token) return;
      const nextRun: AggregationLastRun = state.lastRun
        ? { ...state.lastRun }
        : {
            rows: [],
            durationMs: 0,
            ranAt: new Date().toISOString(),
            stageCounts: {},
            stageSamples: {},
          };
      nextRun.stageSamples = {
        ...nextRun.stageSamples,
        [stageId]: preview.sample,
      };
      if (typeof preview.count === 'number') {
        nextRun.stageCounts = {
          ...nextRun.stageCounts,
          [stageId]: preview.count,
        };
      }
      nextRun.ranAt = new Date().toISOString();
      onPatch({ lastRun: nextRun });
    } catch (e) {
      // Same guard: a superseded failed preview must not toast over a
      // newer success (or a newer failure already surfaced).
      if (previewTokenRef.current.get(stageId) !== token) return;
      const msg = isIpcError(e) ? e.message : String(e);
      notify.error(msg, { title: 'Preview failed' });
    } finally {
      if (previewTokenRef.current.get(stageId) === token) {
        setPreviewLoading((prev) => {
          const next = new Set(prev);
          next.delete(stageId);
          return next;
        });
      }
    }
  };

  // ── Save / Save as ────────────────────────────────────────────────

  // X14 §4 — the last paths that read `stages` without a blur first.
  // The toolbar buttons blur the editor on mousedown, but the command palette's
  // "Save pipeline" does not, so a saved pipeline could keep Shell Syntax the
  // main process would refuse on the next run. The two modals read `stages`
  // from state, and the patch has landed by the time the user acts in them.
  const onSave = async () => {
    const saveStages = repairStageBodies();
    if (!state.savedId) {
      setSaveOpen(true);
      return;
    }
    try {
      await api.saved.update({
        id: state.savedId,
        patch: {
          payload: { kind: 'aggregation', stages: saveStages },
        },
      });
      onPatch({ dirty: false });
      notify.success(`Saved pipeline “${state.name ?? 'Unnamed'}”`);
    } catch (e) {
      notify.error(getErrorMessage(e, String(e)), { title: 'Save failed' });
    }
  };

  const onSaveAs = () => {
    repairStageBodies();
    setSaveOpen(true);
  };

  // ── Explain ──────────────────────────────────────────────────────

  const onExplain = () => {
    if (running || !validation.ok) return;
    setExplainOpen(true);
  };

  const runExplain = React.useCallback(
    (verbosity: ExplainVerbosity, cancelToken: string) =>
      api.agg.explain({
        connectionId,
        dbName,
        collection,
        stages: repairStageBodies(),
        verbosity,
        cancelToken,
      }),
    [connectionId, dbName, collection, repairStageBodies],
  );
  const onCancelExplainToken = React.useCallback((cancelToken: string) => {
    void api.agg.cancel({ token: cancelToken }).catch(() => {});
  }, []);

  // ── Save as collection ───────────────────────────────────────────

  const onSaveAsCollection = () => {
    // this one writes documents, so an unrepaired body is a failed
    // $out/$merge rather than a cosmetic leak.
    repairStageBodies();
    setSaveAsCollectionOpen(true);
  };

  // The repaired array, not `stages`: the repair patch has not round-tripped yet.
  const onSaveAsView = () => setSaveAsViewStages(repairStageBodies());

  // ── Palette commands + keyboard handlers ───────────────────────
  // The latest-ref pattern keeps the keyboard handler (registered once via
  // useEffect with [] dep array) reading current callback identities. Without
  // it the handler captures stale closures, or — if we widened the dep array
  // — the listener would re-register on every parent render.
  const onRunRef = useLatest(onRun);
  const onCancelRunRef = useLatest(onCancelRun);
  const onSaveRef = useLatest(onSave);
  const onExplainRef = useLatest(onExplain);
  const runningRef = useLatest(running);

  useRegisterCommands(
    [
      {
        id: 'agg.run',
        title: 'Run pipeline',
        group: 'aggregation',
        shortcut: '⌘↵',
        keywords: ['execute', 'aggregate'],
        perform: () => onRunRef.current(),
      },
      {
        id: 'agg.explain',
        title: 'Explain pipeline',
        group: 'aggregation',
        keywords: ['plan', 'analyze'],
        perform: () => onExplainRef.current(),
      },
      {
        id: 'agg.save',
        title: 'Save pipeline',
        group: 'aggregation',
        keywords: ['persist', 'bookmark'],
        perform: () => { void onSaveRef.current(); },
      },
    ],
    [],
  );

  // ── Keyboard shortcuts ──────────────────────────────────────────
  // Register once; the handler reads current callbacks/state via refs so
  // we don't have to choose between re-registering on every render and
  // capturing stale closures. (Same pattern the palette commands above
  // use — single source of truth via useLatest.)
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (runningRef.current) onCancelRunRef.current();
        else onRunRef.current();
      } else if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        onExplainRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancelRunRef, onExplainRef, onRunRef, runningRef]);

  // ── Derived UI values ───────────────────────────────────────────

  const outputCount =
    state.lastRun?.rows.length !== undefined ? state.lastRun.rows.length : null;
  const outputStale = state.lastRun ? staleStageIds.size > 0 : false;
  const hasWriteStage = stages.some((s) => s.enabled && isWriteStage(s.op));

  const suggestionContext = React.useMemo<SuggestionContext | null>(() => {
    if (!connectionId || !dbName || !collection) return null;
    return {
      connectionId: connectionId,
      dbName: dbName,
      collection: collection,
      recentDocs: state.lastRun?.rows,
    };
  }, [connectionId, dbName, collection, state.lastRun?.rows]);

  const onViewChange = (v: ResultViewMode) => onPatch({ outputView: v });
  const onHeightChange = (px: number) => {
    // instant visual update
    onPatch({ outputHeight: px });
  };
  const onHeightCommit = () => {
    // Patch already debounced — no separate commit channel needed.
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Action bar (below the workspace tab strip) */}
      <Group
        gap={8}
        wrap="nowrap"
        style={{
          padding: '6px 14px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
          flexShrink: 0,
        }}
      >
        <Group gap={6} wrap="nowrap" style={{ flex: 1 }}>
          <span style={{ fontSize: 12, color: T.textMuted }}>
            {state.name ?? 'Unsaved pipeline'}
          </span>
          {state.dirty && (
            <Tooltip label="Unsaved changes" withArrow>
              <span
                aria-label="Unsaved changes"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: T.accent,
                  display: 'inline-block',
                }}
              />
            </Tooltip>
          )}
          {hasWriteStage && (
            <span
              style={{
                fontSize: 10,
                color: T.red,
                background: 'rgba(180,60,60,0.08)',
                padding: '1px 5px',
                borderRadius: T.rx,
                border: `1px solid ${T.border}`,
              }}
            >
              contains write stage
            </span>
          )}
        </Group>

        <Button size="compact-xs" variant="default" leftSection={I.save} disabled={running || !state.dirty} onClick={onSave}>
          Save
        </Button>
        <Button size="compact-xs" variant="default" disabled={running} onClick={onSaveAs}>
          Save as
        </Button>
        <Button
          size="compact-xs"
          variant="filled"
          leftSection={running ? I.close : I.play}
          disabled={stopping || (!running && !validation.ok)}
          onClick={running ? onCancelRun : onRun}
        >
          {running ? (stopping ? 'Stopping…' : 'Cancel') : 'Run'}
        </Button>
        <Button size="compact-xs" variant="default" leftSection={I.eye} disabled={running || !validation.ok} onClick={onExplain}>
          Explain
        </Button>
      </Group>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <PipelineOutline
          stages={stages}
          activeId={state.activeStageId}
          collection={collection}
          stageCounts={state.lastRun?.stageCounts ?? {}}
          staleStageIds={staleStageIds}
          outputCount={outputCount}
          outputStale={outputStale}
          darkMode={darkMode}
          onSelect={onSelectStage}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <StageAccordion
            stages={stages}
            activeId={state.activeStageId}
            collection={collection}
            sourceCount={sourceCount}
            outputCount={outputCount}
            stageCounts={state.lastRun?.stageCounts ?? {}}
            stageSamples={state.lastRun?.stageSamples ?? {}}
            staleStageIds={staleStageIds}
            previewLoading={previewLoading}
            darkMode={darkMode}
            suggestionContext={suggestionContext}
            onAdd={onAddStage}
            onToggleActive={onSelectStage}
            onToggleEnabled={onToggleEnabled}
            onChangeOp={onChangeOp}
            onBodyChange={onSetBody}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onReorder={onReorderStage}
            onRemove={onRemoveStage}
            onDuplicate={onDuplicateStage}
            onRunToStage={onRunToStage}
            onRefreshPreview={onRunToStage}
          />

          <OutputPanel
            height={state.outputHeight}
            view={state.outputView}
            lastRun={state.lastRun}
            running={running}
            pipelineName={state.name ?? null}
            onHeightChange={onHeightChange}
            onHeightCommit={onHeightCommit}
            onViewChange={onViewChange}
            onSaveAsCollection={onSaveAsCollection}
            onSaveAsView={onSaveAsView}
          />
        </div>
      </div>

      {writeWarning && (
        <WriteStageConfirm
          op={writeWarning.op}
          target={writeWarning.target}
          onCancel={() => setWriteWarning(null)}
          onProceed={() => {
            setWriteWarning(null);
            void executeRun(true);
          }}
        />
      )}

      {explainOpen && (
        <ExplainDrawer
          onClose={() => setExplainOpen(false)}
          runExplain={runExplain}
          onCancelToken={onCancelExplainToken}
        />
      )}

      {saveOpen && (
        <SavePipelineModal
          connectionId={connectionId}
          dbName={dbName}
          collection={collection}
          stages={stages}
          initialName={state.name}
          onClose={() => setSaveOpen(false)}
          onSaved={(saved) => {
            onPatch({ savedId: saved.id, name: saved.name, dirty: false });
            notify.success(`Saved pipeline “${saved.name}”`);
          }}
        />
      )}

      {saveAsCollectionOpen && (
        <SaveAsCollectionModal
          connectionId={connectionId}
          dbName={dbName}
          collection={collection}
          stages={stages}
          onClose={() => setSaveAsCollectionOpen(false)}
          onWritten={(info) => {
            // The target may be in another database than the source.
            notifyCollectionChanged({ connectionId, dbName: info.dbName, collection: info.collection });
            notify.success(saveResultMessage(info));
          }}
        />
      )}

      {saveAsViewStages && (
        <SaveAsViewModal
          connectionId={connectionId}
          dbName={dbName}
          collection={collection}
          stages={saveAsViewStages}
          onClose={() => setSaveAsViewStages(null)}
          onCreated={(name) => {
            notifyCollectionChanged({ connectionId, dbName, collection: name });
            notify.success(`Created view “${name}”`);
          }}
        />
      )}
    </div>
  );
}

// ─── Write-stage confirm dialog ─────────────────────────────────────────

export function WriteStageConfirm({
  op,
  target,
  onCancel,
  onProceed,
}: {
  op: string;
  target?: string;
  onCancel: () => void;
  onProceed: () => void;
}) {
  const T = themeVars;
  // Dismiss paths only — Proceed is a handoff into the run.
  const cancel = useDialogFocusReturn(onCancel);
  return (
    // X15 T6 — no `closeOnClickOutside={false}` here on purpose. This dialog
    // holds no typed input, so a backdrop click loses nothing and the Mantine
    // default is the right convenience. That also makes the ticket's
    // `closeOnClickOutside` mutation *equivalent* for this overlay — there is
    // no test to write that could tell the two builds apart, and writing one
    // that pretends otherwise would be theatre.
    <Modal
      opened
      onClose={cancel}
      title="Confirm write"
      size={440}
      centered
    >
      <div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>
          Running this pipeline will write to collection{' '}
          <code style={{ color: T.text }}>{target ?? '(unknown)'}</code> via{' '}
          <code style={{ color: T.text }}>{op}</code>. Proceed?
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={cancel}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              border: `1px solid ${T.border}`,
              borderRadius: T.rs,
              background: 'none',
              color: T.textMuted,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onProceed}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              borderRadius: T.rs,
              background: T.red,
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Proceed
          </button>
        </div>
      </div>
    </Modal>
  );
}
