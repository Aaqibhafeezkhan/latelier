import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { IdInputSchema, NonEmpty, zodValidator } from '../validators.ts';
import type { WorkspaceStateService, TabStatePatch } from '../../services/WorkspaceStateService.ts';

/**
 * Partial tab-state payload accepted by `tabs:update`, `tabs:openScript`, and
 * `tabs:openCollection`'s `initialState`.
 *
 * Tabs are polymorphic (collection / aggregation / script), so the schema
 * unions the known fields across `CollectionTabState`, `AggregationTabState`,
 * and `ScriptTabState`. Each known field has its proper type; `.passthrough()`
 * preserves additive forward-compat (a newer renderer can ship a new field
 * without coordinating both sides).
 *
 * Before P1-14 this was `z.record(z.string(), z.unknown())` — type errors
 * on known fields (e.g. `page: "1"` instead of `1`) crossed IPC unchecked
 * and only surfaced when the renderer next tried to use the value.
 */
const TabStateShape = z
  .object({
    // ─── CollectionTabState ────────────────────────────────────────
    activeView: z.enum(['documents', 'aggregation', 'structure']).optional(),
    view: z.enum(['Tree', 'JSON', 'Table']).optional(),
    builder: z.record(z.string(), z.unknown()).optional(),
    queryRaw: z.string().optional(),
    // The drawer's tree and the text it was recorded against. The tree is
    // checked node by node only where it is read back (`seedTree`), which
    // falls back to the text for a malformed one.
    filterDraft: z.object({ root: z.record(z.string(), z.unknown()), queryRaw: z.string() }).optional(),
    page: z.number().int().nonnegative().optional(),
    pageSize: z.number().int().positive().optional(),
    totalCount: z.number().int().nonnegative().optional(),
    lastRunHasMore: z.boolean().optional(),
    lastRun: z.record(z.string(), z.unknown()).optional(),
    columns: z.record(z.string(), z.object({ width: z.number() })).optional(),
    expandedRows: z.record(z.string(), z.boolean()).optional(),
    activeBuilderTab: z.string().optional(),
    referenceDrawer: z.record(z.string(), z.unknown()).optional(),
    aggregation: z.record(z.string(), z.unknown()).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    // ─── ScriptTabState ────────────────────────────────────────────
    title: z.string().optional(),
    source: z.string().optional(),
    dbName: z.string().optional(),
    maxTimeMs: z.number().int().positive().optional(),
    lastResult: z.unknown().optional(),
    lastError: z.unknown().optional(),
    resultPanelHeight: z.number().int().positive().optional(),
    resultView: z.enum(['Tree', 'JSON', 'Table']).optional(),
    resultColumns: z.record(z.string(), z.object({ width: z.number() })).optional(),
    resultExpandedRows: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

const OpenCollectionInput = z.object({
  connectionId: NonEmpty,
  dbName: z.string(),
  collection: z.string(),
  reuseExisting: z.boolean().optional(),
  initialState: TabStateShape.optional(),
});

const OpenAggregationInput = z.object({
  connectionId: NonEmpty,
  dbName: z.string(),
  collection: z.string(),
  savedId: z.string().optional(),
  name: z.string().optional(),
});

const OpenDefaultInput = z.object({
  connectionId: NonEmpty,
  dbName: z.string().optional(),
  collection: z.string().optional(),
});

const OpenScriptInput = z.object({
  connectionId: NonEmpty,
  initialState: TabStateShape.optional(),
});

const UpdateInput = z.object({
  id: NonEmpty,
  patch: z.object({
    state: TabStateShape,
  }),
});

const ReorderInput = z.object({
  orderedIds: z.array(NonEmpty),
});

const SetPinnedInput = z.object({
  id: NonEmpty,
  pinned: z.boolean(),
});

const CollectionRenamedInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  oldCollection: NonEmpty,
  newCollection: NonEmpty,
});

export function registerTabsChannels(
  router: Router,
  svc: WorkspaceStateService,
): void {
  router.register(
    IPC_CHANNELS.tabsList,
    zodValidator(z.undefined().or(z.null()).optional()),
    () => svc.list(),
  );

  router.register(
    IPC_CHANNELS.tabsOpenCollection,
    zodValidator(OpenCollectionInput),
    (input) =>
      svc.openCollection(input as Parameters<typeof svc.openCollection>[0]),
  );

  router.register(
    IPC_CHANNELS.tabsOpenAggregation,
    zodValidator(OpenAggregationInput),
    (input) => svc.openAggregation(input),
  );

  router.register(
    IPC_CHANNELS.tabsOpenDefault,
    zodValidator(OpenDefaultInput),
    (input) => svc.openDefault(input),
  );

  router.register(
    IPC_CHANNELS.tabsOpenScript,
    zodValidator(OpenScriptInput),
    (input) =>
      svc.openScript(input as Parameters<typeof svc.openScript>[0]),
  );

  router.register(
    IPC_CHANNELS.tabsUpdate,
    zodValidator(UpdateInput),
    ({ id, patch }) => svc.update(id, patch as TabStatePatch),
  );

  router.register(
    IPC_CHANNELS.tabsClose,
    zodValidator(IdInputSchema),
    ({ id }) => svc.close(id),
  );

  router.register(
    IPC_CHANNELS.tabsSetActive,
    zodValidator(IdInputSchema),
    ({ id }) => {
      svc.setActive(id);
      return { id };
    },
  );

  router.register(
    IPC_CHANNELS.tabsReorder,
    zodValidator(ReorderInput),
    ({ orderedIds }) => {
      svc.reorder(orderedIds);
      return { ok: true as const };
    },
  );

  router.register(
    IPC_CHANNELS.tabsSetPinned,
    zodValidator(SetPinnedInput),
    ({ id, pinned }) => svc.setPinned(id, pinned),
  );

  router.register(
    IPC_CHANNELS.tabsCollectionRenamed,
    zodValidator(CollectionRenamedInput),
    (input) => svc.renameCollectionTabs(input),
  );
}
