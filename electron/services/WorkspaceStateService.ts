import { randomUUID } from 'node:crypto';
import type {
  AggregationTabState,
  CollectionTab,
  CollectionTabState,
  CollectionView,
  ScriptTab,
  ScriptTabState,
  Stage,
  WorkspaceTab,
} from '@shared/types';
import {
  DEFAULT_AGGREGATION_TAB_STATE,
  DEFAULT_COLLECTION_TAB_STATE,
  DEFAULT_SCRIPT_TAB_STATE,
} from '@shared/defaults';
import type { WorkspaceTabRepo, WorkspaceTabRow } from '../db/repositories/WorkspaceTabRepo.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { SavedAggregationPayloadSchema } from '../ipc/schemas/saved.ts';
import type { SavedQueryService } from './SavedQueryService.ts';
import { serializeTabState } from './tabStateResults.ts';
import type { AppStateService } from './AppStateService.ts';

export interface OpenCollectionInput {
  connectionId: string;
  dbName: string;
  collection: string;
  reuseExisting?: boolean;
  initialState?: Partial<CollectionTabState>;
}

export interface OpenAggregationInput {
  connectionId: string;
  dbName: string;
  collection: string;
  savedId?: string;
  name?: string;
  initialState?: Partial<AggregationTabState>;
}

export interface OpenDefaultInput {
  connectionId: string;
  dbName?: string;
  collection?: string;
}

export interface OpenScriptInput {
  connectionId: string;
  initialState?: Partial<ScriptTabState>;
}

export interface TabStatePatch {
  state: Partial<CollectionTabState> | Partial<ScriptTabState>;
}

export class WorkspaceStateService {
  private repo: WorkspaceTabRepo;
  private saved: SavedQueryService;
  constructor(repo: WorkspaceTabRepo, saved: SavedQueryService) {
    this.repo = repo;
    this.saved = saved;
  }

  list(): WorkspaceTab[] {
    return this.repo.list().map((r) => rowToTab(this.restoreEmptiedPipeline(r)));
  }

  get(id: string): WorkspaceTab {
    const row = this.repo.findById(id);
    if (!row) throw new NotFoundError(`workspace tab ${id} not found`);
    return rowToTab(row);
  }

  openCollection(input: OpenCollectionInput): WorkspaceTab {
    const reuse = input.reuseExisting ?? true;
    if (reuse) {
      const existing = this.repo.findMatching(
        input.connectionId,
        'collection',
        input.dbName,
        input.collection,
      );
      if (existing) {
        // If caller asked for a specific sub-view, flip it in-place so that
        // navigating from "Open aggregation on this collection" lands on the
        // Aggregation sub-tab even when a tab is already open.
        if (input.initialState?.activeView) {
          const merged = mergeState(existing.state_json, {
            activeView: input.initialState.activeView,
          });
          this.repo.updateState(existing.id, merged);
          this.repo.setActiveExclusive(existing.id);
          return rowToTab({ ...existing, is_active: 1, state_json: merged });
        }
        this.repo.setActiveExclusive(existing.id);
        return rowToTab({ ...existing, is_active: 1 });
      }
    }
    const state: CollectionTabState = {
      ...DEFAULT_COLLECTION_TAB_STATE,
      ...(input.initialState ?? {}),
    };
    const id = randomUUID();
    const row: WorkspaceTabRow = {
      id,
      connection_id: input.connectionId,
      kind: 'collection',
      db_name: input.dbName,
      collection: input.collection,
      state_json: serializeTabState({ ...state }),
      position: this.repo.nextPosition(),
      is_active: 1,
      opened_at: new Date().toISOString(),
      pinned: 0,
    };
    this.repo.insert(row);
    this.repo.setActiveExclusive(id);
    return rowToTab({ ...row, is_active: 1 });
  }

  /**
   * Open the Aggregation sub-view on a collection. Reuses an existing
   * collection tab when one is already open; otherwise creates a fresh
   * collection tab parked on the Aggregation sub-view. Pre-existing
   * aggregation state on the tab is preserved unless `savedId`, `name` or
   * `initialState` is supplied, in which case the tab is reseeded.
   *
   * A `savedId` loads the stored pipeline's stages here, in main, because the
   * renderer's open call carries no stages: seeding the default empty list
   * would show an empty pipeline whose next Save overwrites the stored one.
   */
  openAggregation(input: OpenAggregationInput): WorkspaceTab {
    const storedStages = input.savedId
      ? this.storedPipelineStages(input.savedId, input)
      : undefined;
    const aggregationSeed: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      ...(storedStages ? { stages: storedStages } : {}),
      ...(input.initialState ?? {}),
      name: input.name,
      savedId: input.savedId,
    };

    const existing = this.repo.findMatching(
      input.connectionId,
      'collection',
      input.dbName,
      input.collection,
    );
    if (existing) {
      const current = parseState<CollectionTabState>(existing.state_json);
      const nextAggregation: AggregationTabState =
        input.savedId || input.name || input.initialState
          ? aggregationSeed
          : current.aggregation
            ? { ...current.aggregation }
            : aggregationSeed;
      const merged = mergeState(existing.state_json, {
        activeView: 'aggregation',
        aggregation: nextAggregation,
      });
      this.repo.updateState(existing.id, merged);
      this.repo.setActiveExclusive(existing.id);
      return rowToTab({ ...existing, is_active: 1, state_json: merged });
    }

    return this.openCollection({
      connectionId: input.connectionId,
      dbName: input.dbName,
      collection: input.collection,
      initialState: {
        activeView: 'aggregation',
        aggregation: aggregationSeed,
      },
    });
  }

  // Fails rather than falling back to an empty list: a tab opened empty over a
  // stored pipeline is the state whose Save wipes it. Gates on the row's own
  // `kind` and on stages that pass the schema `saved:update` holds a Save to, not
  // on the payload's inner `kind`: a row can lack that key and still be saved to,
  // and a row of another kind can carry an aggregation-shaped payload. A tab
  // carries its `savedId` into every later Save, so the row must also belong to
  // the namespace the tab is on, or that Save would overwrite another
  // collection's pipeline.
  private storedPipelineStages(
    savedId: string,
    ns: { connectionId: string; dbName: string; collection: string },
  ): Stage[] {
    const saved = this.saved.get(savedId);
    if (saved.kind !== 'aggregation') {
      throw new ValidationError(`saved query "${saved.name}" is not an aggregation pipeline`);
    }
    if (
      saved.connectionId !== ns.connectionId ||
      saved.dbName !== ns.dbName ||
      saved.collection !== ns.collection
    ) {
      throw new ValidationError(
        `saved pipeline "${saved.name}" belongs to ${saved.dbName}.${saved.collection}, not ${ns.dbName}.${ns.collection}`,
      );
    }
    // A corrupted payload reads back as null (see `SavedQueryService.get`).
    const stages = SavedAggregationPayloadSchema.shape.stages.safeParse(
      (saved.payload as { stages?: unknown } | null)?.stages,
    );
    if (!stages.success) {
      throw new ValidationError(`saved pipeline "${saved.name}" is unreadable: its stages are missing or malformed`);
    }
    return stages.data as Stage[];
  }

  // A tab persisted before `openAggregation` loaded stored stages holds
  // `stages: []` over a `savedId`, and its next Save would wipe the stored
  // pipeline. Every stage edit marks the tab `dirty`, so a clean tab with no
  // stages is one that was never edited: the stored pipeline is its truth. A
  // pipeline saved empty reads back empty, so there is nothing to change. A row
  // that is gone or unreadable leaves the tab as it is; one bad tab must not
  // fail the whole list. `tabs:update` stores the aggregation state unchecked,
  // so a `savedId` that is not a string is skipped here: SQLite cannot bind it,
  // and the error would fail every list from then on.
  private restoreEmptiedPipeline(row: WorkspaceTabRow): WorkspaceTabRow {
    if (row.kind !== 'collection') return row;
    const aggregation = parseState<CollectionTabState>(row.state_json).aggregation;
    if (typeof aggregation?.savedId !== 'string' || !aggregation.savedId) return row;
    if (aggregation.dirty || (aggregation.stages?.length ?? 0) > 0) return row;
    let stages: Stage[];
    try {
      stages = this.storedPipelineStages(aggregation.savedId, {
        connectionId: row.connection_id,
        dbName: row.db_name,
        collection: row.collection,
      });
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof ValidationError) return row;
      throw e;
    }
    if (stages.length === 0) return row;
    const state_json = mergeState(row.state_json, { aggregation: { ...aggregation, stages } });
    this.repo.updateState(row.id, state_json);
    return { ...row, state_json };
  }

  /**
   * Create a new script tab (W12). Always allocates a fresh tab — script
   * tabs are user-managed, not deduplicated by (db, collection) like
   * collection tabs. The `db_name` / `collection` SQL columns are set to
   * empty strings since scripts don't bind to either at the row level;
   * the active db lives in `state.dbName`.
   */
  openScript(input: OpenScriptInput): ScriptTab {
    const state: ScriptTabState = {
      ...DEFAULT_SCRIPT_TAB_STATE,
      ...(input.initialState ?? {}),
    };
    const id = randomUUID();
    const row: WorkspaceTabRow = {
      id,
      connection_id: input.connectionId,
      kind: 'script',
      db_name: '',
      collection: '',
      state_json: serializeTabState({ ...state }),
      position: this.repo.nextPosition(),
      is_active: 1,
      opened_at: new Date().toISOString(),
      pinned: 0,
    };
    this.repo.insert(row);
    this.repo.setActiveExclusive(id);
    return rowToTab({ ...row, is_active: 1 }) as ScriptTab;
  }

  /**
   * Open the default collection for a connection — caller resolves `dbName`
   * and `collection` beforehand (via `meta:listDatabases` / `listCollections`).
   * If none supplied and no existing tab matches, creates a placeholder tab
   * pointing at "(none)"/"(none)" so the workspace still has something to show.
   */
  openDefault(input: OpenDefaultInput): WorkspaceTab {
    const dbName = input.dbName ?? '';
    const collection = input.collection ?? '';
    if (!dbName && !collection) {
      // No collection provided — look for an existing tab on this connection.
      const existing = this.repo
        .list()
        .find((r) => r.connection_id === input.connectionId);
      if (existing) {
        this.repo.setActiveExclusive(existing.id);
        return rowToTab({ ...existing, is_active: 1 });
      }
    }
    return this.openCollection({
      connectionId: input.connectionId,
      dbName,
      collection,
      reuseExisting: true,
    });
  }

  update(id: string, patch: TabStatePatch): WorkspaceTab {
    const row = this.repo.findById(id);
    if (!row) throw new NotFoundError(`workspace tab ${id} not found`);
    let serialized: string;
    try {
      serialized = mergeState(row.state_json, patch.state);
    } catch {
      throw new ValidationError('could not merge tab state — existing state was not valid JSON');
    }
    this.repo.updateState(id, serialized);
    return rowToTab({ ...row, state_json: serialized });
  }

  close(id: string): { newActiveId: string | null } {
    const row = this.repo.findById(id);
    if (!row) throw new NotFoundError(`workspace tab ${id} not found`);
    const wasActive = row.is_active === 1;
    const all = this.repo.list();
    const idx = all.findIndex((r) => r.id === id);

    this.repo.deleteById(id);

    if (!wasActive) return { newActiveId: null };

    const remaining = all.filter((r) => r.id !== id);
    if (remaining.length === 0) return { newActiveId: null };
    // Prefer the left neighbour, else the right neighbour.
    const pick = remaining[idx - 1] ?? remaining[idx] ?? remaining[0]!;
    this.repo.setActiveExclusive(pick.id);
    return { newActiveId: pick.id };
  }

  setActive(id: string): void {
    const row = this.repo.findById(id);
    if (!row) throw new NotFoundError(`workspace tab ${id} not found`);
    this.repo.setActiveExclusive(id);
  }

  /** Closes every tab, pinned and active ones included. */
  closeAll(): void {
    this.repo.deleteAll();
  }

  setPinned(id: string, pinned: boolean): WorkspaceTab {
    const row = this.repo.findById(id);
    if (!row) throw new NotFoundError(`workspace tab ${id} not found`);
    this.repo.setPinned(id, pinned);
    return rowToTab({ ...row, pinned: pinned ? 1 : 0 });
  }

  reorder(orderedIds: string[]): void {
    this.repo.reorder(orderedIds);
  }

  /**
   * N0.5 — keep an open collection tab pointed at reality after the
   * underlying collection is renamed via `collectionRename`. Re-targets the
   * matching tab's `collection` column in place (preserving its query,
   * filters, pagination, etc.) rather than closing it.
   *
   * If a tab is *already* open on `newCollection` (the caller had both the
   * old and new names open at once — unusual but possible), retargeting
   * would produce two tabs pointing at the same namespace. Close the stale
   * one instead so the surviving tab is the one that already reflects the
   * new name. When the stale tab was the active one, focus moves to that
   * surviving same-namespace tab rather than `close()`'s arbitrary
   * left/right neighbour election.
   */
  renameCollectionTabs(input: {
    connectionId: string;
    dbName: string;
    oldCollection: string;
    newCollection: string;
  }): { retargeted: boolean; closed: boolean } {
    const { connectionId, dbName, oldCollection, newCollection } = input;
    if (oldCollection === newCollection) return { retargeted: false, closed: false };
    const stale = this.repo.findMatching(connectionId, 'collection', dbName, oldCollection);
    if (!stale) return { retargeted: false, closed: false };
    const conflict = this.repo.findMatching(connectionId, 'collection', dbName, newCollection);
    if (conflict) {
      const staleWasActive = stale.is_active === 1;
      this.close(stale.id);
      if (staleWasActive) this.setActive(conflict.id);
      return { retargeted: false, closed: true };
    }
    this.repo.retargetCollection(stale.id, newCollection);
    return { retargeted: true, closed: false };
  }
}

// ─── Row ↔ object mappers ────────────────────────────────────────────────────

function parseState<T>(raw: string): Partial<T> {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Partial<T>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Maps a persisted `activeView` value to the current `CollectionView` union.
 * `'schema'` is the retired value and migrates to `'structure'`; anything
 * else outside the union (a future value read by an older build, or
 * corrupted `state_json`) falls back to `'documents'` rather than leaving a
 * tab stuck on a view the renderer no longer knows how to render.
 */
function normalizeActiveView(raw: unknown): CollectionView {
  if (raw === 'aggregation' || raw === 'structure') return raw;
  if (raw === 'schema') return 'structure';
  return 'documents';
}

function mergeState(
  currentJson: string,
  patch: Partial<CollectionTabState> | Partial<ScriptTabState>,
): string {
  const current = parseState<Record<string, unknown>>(currentJson);
  return serializeTabState({ ...current, ...patch });
}

function rowToTab(row: WorkspaceTabRow): WorkspaceTab {
  if (row.kind === 'script') {
    const parsed = parseState<ScriptTabState>(row.state_json);
    const state: ScriptTabState = {
      ...DEFAULT_SCRIPT_TAB_STATE,
      ...parsed,
    };
    const tab: ScriptTab = {
      id: row.id,
      kind: 'script',
      connectionId: row.connection_id,
      dbName: row.db_name,
      collection: row.collection,
      position: row.position,
      isActive: row.is_active === 1,
      openedAt: row.opened_at,
      pinned: row.pinned === 1,
      state,
    };
    return tab;
  }
  const parsed = parseState<CollectionTabState>(row.state_json);
  const state: CollectionTabState = {
    ...DEFAULT_COLLECTION_TAB_STATE,
    ...parsed,
    activeView: normalizeActiveView(parsed.activeView),
  };
  const tab: CollectionTab = {
    id: row.id,
    kind: 'collection',
    connectionId: row.connection_id,
    dbName: row.db_name,
    collection: row.collection,
    position: row.position,
    isActive: row.is_active === 1,
    openedAt: row.opened_at,
    pinned: row.pinned === 1,
    state,
  };
  return tab;
}

/**
 * Boot-time enforcement of "Reopen tabs on launch". Only an explicit `false`
 * clears the workspace; an unset key keeps the restore behaviour. Done once in
 * main because `/workspace` remounts on route changes, so a renderer-side
 * clear would wipe tabs mid-session.
 */
export function applyRestoreTabsPref(appState: AppStateService, tabs: WorkspaceStateService): void {
  if (appState.get<boolean>('ui.workspace.restoreTabs') === false) tabs.closeAll();
}
