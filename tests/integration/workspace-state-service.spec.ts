import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { WorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import { NotFoundError, ValidationError } from '../../electron/errors';
import { createTempDb, type TempDb } from '../helpers/db';
import type { CollectionTab, Stage, WorkspaceTab } from '../../shared/types';

// The service returns the `WorkspaceTab` union; the fields these tests read
// (view, pageSize, activeView, aggregation) only exist on the collection variant.
function asCollectionTab(tab: WorkspaceTab): CollectionTab {
  if (tab.kind !== 'collection') throw new Error(`expected a collection tab, got ${tab.kind}`);
  return tab;
}

function seedConnection(tmp: TempDb, id: string): void {
  const now = new Date().toISOString();
  tmp.db
    .prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES (?, 'c-' || ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
    )
    .run(id, id, now, now);
}

describe('WorkspaceStateService', () => {
  let tmp: TempDb;
  let svc: WorkspaceStateService;
  let repo: WorkspaceTabRepo;
  let saved: SavedQueryService;

  beforeEach(() => {
    tmp = createTempDb();
    repo = new WorkspaceTabRepo(tmp.db);
    saved = new SavedQueryService(new SavedQueryRepo(tmp.db));
    svc = new WorkspaceStateService(repo, saved);
    seedConnection(tmp, 'conn');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('openCollection with reuseExisting=true (default) does not duplicate', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    expect(a.id).toBe(b.id);
    expect(svc.list().length).toBe(1);
  });

  it('openCollection with reuseExisting=false creates a new tab', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const b = svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      reuseExisting: false,
    });
    expect(a.id).not.toBe(b.id);
    expect(svc.list().length).toBe(2);
  });

  it('is_active is exclusive', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    const list = svc.list();
    const active = list.filter((t) => t.isActive);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe(b.id);
    expect(list.find((t) => t.id === a.id)!.isActive).toBe(false);
  });

  it('openAggregation reuses the matching collection tab and flips activeView', () => {
    const c = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const a = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(a.id).toBe(c.id);
    expect(a.kind).toBe('collection');
    expect(a.state.activeView).toBe('aggregation');
    expect(a.state.aggregation).toBeDefined();
    // No second tab spawned.
    expect(svc.list().length).toBe(1);
  });

  it('openAggregation creates a fresh tab when no matching collection tab exists', () => {
    const a = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(a.kind).toBe('collection');
    expect(a.state.activeView).toBe('aggregation');
  });

  it('openAggregation preserves existing aggregation state across re-opens', () => {
    const a = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    svc.update(a.id, {
      state: {
        aggregation: {
          ...a.state.aggregation!,
          stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
        },
      },
    });
    const b = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(b.id).toBe(a.id);
    expect(b.state.aggregation?.stages.length).toBe(1);
  });

  describe('openAggregation on a saved pipeline', () => {
    const STORED: Stage[] = [
      { id: 4, op: '$match', body: '{ status: "open" }', enabled: true },
      { id: 9, op: '$limit', body: '5', enabled: false, note: 'trial' },
    ];

    type SavedInput = Parameters<SavedQueryService['create']>[0];

    // `create` does not validate the payload (the router does), so a row the way an
    // older build or a corrupted write left it can be stored as is.
    function saveRow(overrides: Partial<SavedInput> = {}) {
      return saved.create({
        connectionId: 'conn',
        dbName: 'd',
        collection: 'c',
        kind: 'aggregation',
        name: 'open orders',
        payload: { kind: 'aggregation', stages: STORED, description: 'keep me' },
        ...overrides,
      });
    }

    const savePipeline = () => saveRow();
    const withPayload = (payload: unknown, overrides: Partial<SavedInput> = {}) =>
      saveRow({ payload: payload as SavedInput['payload'], ...overrides });

    const open = (savedId: string, ns: { connectionId?: string; dbName?: string; collection?: string } = {}) =>
      asCollectionTab(
        svc.openAggregation({
          connectionId: 'conn',
          dbName: 'd',
          collection: 'c',
          savedId,
          name: 'open orders',
          ...ns,
        }),
      );

    it('seeds the stored stages into a collection tab that is already open', () => {
      // The Saved list lives in the Builder pane of an open collection tab, so this is
      // the path a user takes; an empty seed here is what made the next Save wipe the pipeline.
      const existing = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
      const row = savePipeline();

      const tab = open(row.id);

      expect(tab.id).toBe(existing.id);
      expect(tab.state.aggregation).toMatchObject({ stages: STORED, savedId: row.id, name: 'open orders' });
      const listed = asCollectionTab(svc.list().find((t) => t.id === tab.id)!);
      expect(listed.state.aggregation?.stages).toEqual(STORED);
    });

    it('seeds the stored stages into a fresh tab', () => {
      const row = savePipeline();

      const tab = open(row.id);

      expect(svc.list()).toHaveLength(1);
      expect(tab.state.activeView).toBe('aggregation');
      expect(tab.state.aggregation).toMatchObject({ stages: STORED, savedId: row.id });
    });

    it('lets a Save straight after opening leave the stored pipeline unchanged', () => {
      const row = savePipeline();

      const tab = open(row.id);
      // What AggregationTab's Save sends: the tab's stages, nothing else.
      saved.update(row.id, { payload: { kind: 'aggregation', stages: tab.state.aggregation!.stages } });

      const after = saved.get(row.id);
      expect(after.payload).toEqual({ kind: 'aggregation', stages: STORED, description: 'keep me' });
    });

    it('opens a row whose payload lacks its own kind, as Save accepts it', () => {
      const row = withPayload({ stages: STORED });

      expect(open(row.id).state.aggregation?.stages).toEqual(STORED);
    });

    describe('a refused open', () => {
      // An existing tab on the same collection, so that "refused" also means it was left alone:
      // main reseeds that tab in place, and a half-applied open would show here.
      let before: WorkspaceTab[];

      beforeEach(() => {
        svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
        seedConnection(tmp, 'conn2');
        before = svc.list();
      });

      function expectRefused(run: () => unknown, error: new (...args: never[]) => Error) {
        expect(run).toThrow(error);
        expect(svc.list()).toEqual(before);
      }

      it('answers NOT_FOUND for an unknown saved id', () => {
        expectRefused(() => open('gone'), NotFoundError);
      });

      it('refuses a find row', () => {
        const find = saveRow({
          kind: 'find',
          name: 'a find',
          payload: { kind: 'find', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}' },
        });

        expectRefused(() => open(find.id), ValidationError);
      });

      it('refuses a find row holding an aggregation-shaped payload', () => {
        // Save checks the payload against the row's kind, so it would fail on this tab.
        const row = withPayload({ kind: 'aggregation', stages: STORED }, { kind: 'find', name: 'odd find' });

        expectRefused(() => open(row.id), ValidationError);
      });

      it.each([
        ['missing', { kind: 'aggregation' }],
        ['null', { kind: 'aggregation', stages: null }],
        ['a string', { kind: 'aggregation', stages: 'abc' }],
        ['an object', { kind: 'aggregation', stages: { a: 1 } }],
        ['made of malformed stages', { kind: 'aggregation', stages: [{ id: 'x' }] }],
      ])('refuses a pipeline whose stages are %s, naming the pipeline', (_label, payload) => {
        const row = withPayload(payload, { name: 'broken pipeline' });

        expect(() => open(row.id)).toThrow(/"broken pipeline" is unreadable/);
        expect(svc.list()).toEqual(before);
      });

      it('refuses a row whose payload cannot be read', () => {
        const row = savePipeline();
        tmp.db.prepare('UPDATE saved_queries SET payload_json = ? WHERE id = ?').run('not json', row.id);

        expectRefused(() => open(row.id), ValidationError);
      });

      it.each([
        ['another collection', { collection: 'other' }],
        ['another database', { dbName: 'other' }],
        ['another connection', { connectionId: 'conn2' }],
      ])('refuses a pipeline saved on %s, since the tab would carry its id into Save', (_label, ns) => {
        const row = savePipeline();

        expectRefused(() => open(row.id, ns), ValidationError);
      });
    });

    describe('a tab saved before the stages were loaded on open', () => {
      // The old open seeded `stages: []` over the `savedId`, and its next Save wiped the
      // stored pipeline. `tabs:list` is what the renderer reads at launch.
      const stored = () => [{ id: 1, op: '$limit', body: '3', enabled: true }];

      function emptiedTab(aggregation: Record<string, unknown>) {
        const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
        svc.update(tab.id, { state: { activeView: 'aggregation', aggregation } as never });
        return tab;
      }
      const stagesOf = (id: string) =>
        asCollectionTab(svc.list().find((t) => t.id === id)!).state.aggregation?.stages;

      it('gets the stored stages back, and keeps them', () => {
        const row = savePipeline();
        const tab = emptiedTab({ stages: [], activeStageId: null, savedId: row.id, name: row.name });

        expect(stagesOf(tab.id)).toEqual(STORED);
        const persisted = rawState(tab.id).aggregation as { stages: Stage[]; savedId: string; name: string };
        expect(persisted).toMatchObject({ stages: STORED, savedId: row.id, name: row.name });
      });

      it('leaves a tab alone whose stages the user cleared by hand', () => {
        const row = savePipeline();
        const tab = emptiedTab({ stages: [], activeStageId: null, savedId: row.id, dirty: true });

        expect(stagesOf(tab.id)).toEqual([]);
      });

      it('leaves a tab alone that already has stages', () => {
        const row = savePipeline();
        const mine = stored();
        const tab = emptiedTab({ stages: mine, activeStageId: null, savedId: row.id });

        expect(stagesOf(tab.id)).toEqual(mine);
      });

      it('leaves a tab alone whose pipeline was saved empty', () => {
        const row = withPayload({ kind: 'aggregation', stages: [] });
        const tab = emptiedTab({ stages: [], activeStageId: null, savedId: row.id });

        expect(stagesOf(tab.id)).toEqual([]);
      });

      it('still lists every tab when the saved row is gone or unreadable', () => {
        const unreadable = withPayload({ kind: 'aggregation' }, { name: 'unreadable' });
        const a = emptiedTab({ stages: [], activeStageId: null, savedId: 'gone' });
        const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c', reuseExisting: false });
        svc.update(b.id, {
          state: { aggregation: { stages: [], activeStageId: null, savedId: unreadable.id } } as never,
        });

        expect(svc.list()).toHaveLength(2);
        expect(stagesOf(a.id)).toEqual([]);
        expect(stagesOf(b.id)).toEqual([]);
      });

      // `tabs:update` stores the aggregation state unchecked; SQLite throws
      // binding `true` or an object, and that must not fail every later list.
      it.each([true, { id: 'x' }])('skips a savedId of %j instead of failing the list', (savedId) => {
        const tab = emptiedTab({ stages: [], activeStageId: null, savedId });

        expect(svc.list()).toHaveLength(1);
        expect(stagesOf(tab.id)).toEqual([]);
      });
    });
  });

  it('update merges patch into state', () => {
    const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const updated = asCollectionTab(svc.update(tab.id, {
      state: { view: 'JSON' },
    }));
    expect(updated.kind).toBe('collection');
    expect(updated.state.view).toBe('JSON');
    // default field still present
    expect(updated.state.pageSize).toBe(50);
  });

  it('update round-trips activeView:"structure" and a second field in the same patch', () => {
    const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    svc.update(tab.id, { state: { activeView: 'structure', page: 2 } });
    const reread = asCollectionTab(svc.get(tab.id));
    expect(reread.state.activeView).toBe('structure');
    expect(reread.state.page).toBe(2);
  });

  it('closeAll removes every tab, the active and the pinned ones too', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    svc.setPinned(a.id, true);
    expect(svc.list().length).toBe(2);
    svc.closeAll();
    expect(svc.list()).toEqual([]);
  });

  it('the repo clears every row in one statement and reports how many went', () => {
    for (let i = 0; i < 25; i += 1) {
      svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: `c${i}` });
    }
    expect(repo.deleteAll()).toBe(25);
    expect(repo.list()).toEqual([]);
    expect(repo.deleteAll()).toBe(0);
  });

  it('close returns newActiveId = left neighbour when active closed', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    const c = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    svc.setActive(b.id);
    const r = svc.close(b.id);
    expect(r.newActiveId).toBe(a.id);
    expect(svc.list().find((t) => t.isActive)!.id).toBe(a.id);
    expect(c).toBeDefined();
  });

  it('close of non-active returns newActiveId null', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    // b is now active
    const r = svc.close(a.id);
    expect(r.newActiveId).toBeNull();
    expect(svc.list().find((t) => t.isActive)!.id).toBe(b.id);
  });

  it('close of last tab returns newActiveId null', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const r = svc.close(a.id);
    expect(r.newActiveId).toBeNull();
    expect(svc.list().length).toBe(0);
  });

  it('reorder persists a new ordering', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    const c = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    svc.reorder([c.id, a.id, b.id]);
    expect(svc.list().map((t) => t.collection)).toEqual(['c', 'a', 'b']);
  });

  it('get throws NotFoundError for unknown id', () => {
    expect(() => svc.get('missing')).toThrow(NotFoundError);
  });

  // ─── N0.5: renameCollectionTabs — keep open tabs pointed at reality ────
  describe('renameCollectionTabs', () => {
    it('retargets the matching tab in place, preserving its state', () => {
      const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      svc.update(tab.id, { state: { page: 3, pageSize: 100 } });

      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(result).toEqual({ retargeted: true, closed: false });
      const updated = svc.get(tab.id);
      expect(updated.collection).toBe('orders2');
      expect(updated.dbName).toBe('d');
      // Non-namespace state survives the retarget.
      expect((updated as CollectionTab).state.page).toBe(3);
      expect((updated as CollectionTab).state.pageSize).toBe(100);
      expect(svc.list().length).toBe(1);
    });

    it('is a no-op when no tab is open on the old namespace', () => {
      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'ghost',
        newCollection: 'ghost2',
      });
      expect(result).toEqual({ retargeted: false, closed: false });
      expect(svc.list().length).toBe(0);
    });

    it('is a no-op when oldCollection === newCollection', () => {
      svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders',
      });
      expect(result).toEqual({ retargeted: false, closed: false });
    });

    it('closes the stale tab instead of duplicating when a tab already targets the new name', () => {
      const stale = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      const already = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders2' });

      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(result).toEqual({ retargeted: false, closed: true });
      expect(() => svc.get(stale.id)).toThrow(NotFoundError);
      expect(svc.get(already.id).collection).toBe('orders2');
      expect(svc.list().length).toBe(1);
    });

    it('activates the surviving tab when the closed stale tab was active (collision)', () => {
      const already = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders2' });
      const stale = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      svc.setActive(stale.id); // focus the tab that will be closed on rename

      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(result).toEqual({ retargeted: false, closed: true });
      const survivors = svc.list();
      expect(survivors.length).toBe(1);
      expect(survivors[0]!.id).toBe(already.id);
      // Focus lands on the surviving same-namespace tab, not an arbitrary neighbour.
      expect(survivors[0]!.isActive).toBe(true);
    });

    it('only retargets the tab on the matching connectionId', () => {
      seedConnection(tmp, 'other');
      const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      const otherConn = svc.openCollection({ connectionId: 'other', dbName: 'd', collection: 'orders' });

      svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(svc.get(tab.id).collection).toBe('orders2');
      expect(svc.get(otherConn.id).collection).toBe('orders');
    });
  });

  // ─── T0.5 / W07: sticky page-size default seeding ──────────────────────
  //
  // The renderer's `useWorkspaceTabs().openCollection` reads a global prefs
  // key before calling `tabs:openCollection` and forwards it as
  // `initialState.pageSize` when set, or omits `initialState` entirely on a
  // never-set (null) pref. These two integration tests exercise the service
  // side of both branches directly (no prefs repo involved at this layer).
  it('openCollection seeds pageSize from a caller-supplied initialState on a brand-new tab', () => {
    const tab = asCollectionTab(svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: { pageSize: 250 },
    }));
    expect(tab.kind).toBe('collection');
    expect(tab.state.pageSize).toBe(250);
  });

  it('openCollection falls back to the default pageSize (50) when no initialState is supplied (null-pref branch)', () => {
    // Mirrors the renderer omitting `initialState` entirely when
    // `api.prefs.get('ui.workspace.defaultPageSize')` resolves to `null` —
    // this is what keeps W07 AC1 ("default page size is 50") true for a
    // genuinely first-time user.
    const tab = asCollectionTab(svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(tab.state.pageSize).toBe(50);
  });

  it('openCollection reuse path ignores initialState.pageSize — an already-open tab keeps its own persisted size', () => {
    const first = svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: { pageSize: 100 },
    });
    svc.update(first.id, { state: { pageSize: 500 } });
    // Re-open with a different sticky-default seed — the reuse branch must
    // not clobber the tab's own persisted pageSize.
    const reopened = asCollectionTab(svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: { pageSize: 10 },
    }));
    expect(reopened.id).toBe(first.id);
    expect(reopened.state.pageSize).toBe(500);
  });

  // ─── Result documents are never written to SQLite ───────────────────────

  function rawState(id: string): Record<string, unknown> {
    const row = tmp.db.prepare('SELECT state_json FROM workspace_tabs WHERE id = ?').get(id) as {
      state_json: string;
    };
    expect(row.state_json).not.toContain('pii-document');
    return JSON.parse(row.state_json) as Record<string, unknown>;
  }

  const PII = { secret: 'pii-document' };

  it('update strips find, aggregation and script results from the stored row but keeps the rest', () => {
    const coll = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    svc.update(coll.id, {
      state: {
        page: 4,
        lastRunHasMore: true,
        columns: { a: { width: 120 } },
        expandedRows: { x: true },
        lastRun: { documents: [PII], durationMs: 1, ranAt: 'now' },
        aggregation: {
          stages: [],
          activeStageId: null,
          outputHeight: 200,
          outputView: 'Tree',
          lastRun: {
            rows: [PII],
            durationMs: 1,
            ranAt: 'now',
            stageCounts: {},
            stageSamples: { 0: [PII] },
          },
        },
      },
    });
    const stored = rawState(coll.id);
    expect(stored).not.toHaveProperty('lastRun');
    expect(stored.aggregation).not.toHaveProperty('lastRun');
    expect(stored).toMatchObject({
      page: 4,
      lastRunHasMore: true,
      columns: { a: { width: 120 } },
      expandedRows: { x: true },
      aggregation: { outputHeight: 200 },
    });

    const script = svc.openScript({ connectionId: 'conn' });
    svc.update(script.id, {
      state: {
        source: 'db.c.find()',
        lastResult: { valueJson: JSON.stringify([PII]), printBuffer: '', durationMs: 1 },
        lastError: { code: 'X', message: 'pii-document' },
      },
    });
    const storedScript = rawState(script.id);
    expect(storedScript).not.toHaveProperty('lastResult');
    expect(storedScript).not.toHaveProperty('lastError');
    expect(storedScript.source).toBe('db.c.find()');
  });

  it('update stores the schema numeric range of a plain field but not of a secret-named one', () => {
    const coll = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const numeric = { min: 1, max: 9, avg: 4.5 };
    svc.update(coll.id, {
      state: {
        schema: {
          sampleSize: 100,
          entries: [
            { path: 'price', frequency: 1, types: { number: 3 }, distinct: 3, numeric },
            { path: 'user.password', frequency: 1, types: { number: 3 }, distinct: 3, numeric },
          ],
        },
      },
    });
    const entries = (rawState(coll.id).schema as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]).toMatchObject({ path: 'price', distinct: 3, numeric });
    expect(entries[1]).toMatchObject({ path: 'user.password', distinct: 3 });
    expect(entries[1]).not.toHaveProperty('numeric');
  });

  it('a later update does not resurrect or re-store results, and legacy stored results are cleaned on the next write', () => {
    const coll = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    tmp.db
      .prepare('UPDATE workspace_tabs SET state_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ queryRaw: '{}', lastRun: { documents: [PII] }, aggregation: { lastRun: { rows: [PII] } } }),
        coll.id,
      );
    svc.update(coll.id, { state: { page: 1 } });
    const stored = rawState(coll.id);
    expect(stored).not.toHaveProperty('lastRun');
    expect(stored.aggregation).not.toHaveProperty('lastRun');
    expect(stored.page).toBe(1);
  });

  it('create paths strip results from initialState', () => {
    const coll = svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: { lastRun: { documents: [PII], durationMs: 1, ranAt: 'now' }, pageSize: 10 },
    });
    expect(rawState(coll.id)).toMatchObject({ pageSize: 10 });
    expect(rawState(coll.id)).not.toHaveProperty('lastRun');

    const script = svc.openScript({
      connectionId: 'conn',
      initialState: { lastError: { code: 'X', message: 'pii-document' }, title: 'keep' },
    });
    expect(rawState(script.id)).toMatchObject({ title: 'keep' });
    expect(rawState(script.id)).not.toHaveProperty('lastError');
  });

  it('openAggregation with a seeded aggregation strips its nested lastRun', () => {
    const tab = svc.openAggregation({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: {
        lastRun: { rows: [PII], durationMs: 1, ranAt: 'now', stageCounts: {}, stageSamples: {} },
        outputHeight: 333,
      },
    });
    expect(rawState(tab.id).aggregation).toMatchObject({ outputHeight: 333 });
    expect(rawState(tab.id).aggregation).not.toHaveProperty('lastRun');
  });

  // ─── Performance regression guard ───────────────────────────────────────
  //
  // Every keystroke in a builder cell, query bar, or script editor lands
  // here via a 250 ms debounce on `api.tabs.update`. The handler accepts
  // `state: z.record(z.string(), z.unknown())` with no size validation, so
  // a giant pasted aggregation pipeline can balloon `state_json` to
  // hundreds of KB. The call does a `findById` SELECT * + synchronous
  // JSON merge + UPDATE on the main thread; if it ever blows past tens
  // of ms, IPC queues stack behind it. 200 ms is loose enough not to
  // flake in CI but strict enough to catch a 5-10× regression.
  // The fastest of five runs is what is checked: a busy machine can stall any
  // single run past the budget (it did, at 516 ms, under a parallel suite),
  // but a real regression slows every run, so the minimum still catches it.
  it('update with a 500KB state payload stays inside a wall-clock budget', () => {
    const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'big' });
    const fat: Record<string, unknown> = { queryRaw: 'x'.repeat(500 * 1024) };
    const runs = Array.from({ length: 5 }, () => {
      const t0 = Date.now();
      svc.update(tab.id, { state: fat });
      return Date.now() - t0;
    });
    expect(Math.min(...runs)).toBeLessThan(200);
    // Sanity: the blob actually round-trips through the SQLite write.
    const refetched = svc.get(tab.id);
    const stored = (refetched as { state: { queryRaw?: string } }).state.queryRaw;
    expect(stored?.length).toBe(500 * 1024);
  });

  // ─── W13 — legacy state_json hydration ───────────────────────────
  //
  // A tab persisted before W13 has `state_json` shaped like the pre-#277
  // world: `queryDirty` present, `builder` carrying `conditions`/`logic`,
  // and no `queryRaw` key at all. `CollectionTabState.queryRaw` is required
  // now — if `{...DEFAULT_COLLECTION_TAB_STATE, ...parsed}` ever stopped
  // filling that gap, every renderer call site that does `state.queryRaw
  // .trim()` (`currentFilterJson`, `isDefaultQueryState`) would throw a
  // TypeError on launch instead of falling back to `'{}'`. This is §8's
  // "stale keys in persisted state are ignored" made checkable — every other
  // test in this file writes through `svc.update`, whose payload always
  // carries a fresh `queryRaw`, so none of them would catch a regression
  // here.
  it('hydrates a pre-W13 legacy state_json without a queryRaw key to the required default, keeping sort/limit/projection', () => {
    const legacyStateJson = JSON.stringify({
      view: 'Tree',
      builder: {
        conditions: [
          { id: 1, field: 'status', op: '$eq', valType: 'string', value: 'active' },
        ],
        logic: 'AND',
        projection: ['name'],
        sort: '{"age":1}',
        limit: '10',
      },
      queryDirty: true,
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      // No `queryRaw` — the pre-`queryRaw` shape this migration accepts.
    });
    const id = 'legacy-tab-1';
    repo.insert({
      id,
      connection_id: 'conn',
      kind: 'collection',
      db_name: 'd',
      collection: 'legacy',
      state_json: legacyStateJson,
      position: repo.nextPosition(),
      is_active: 0,
      opened_at: new Date().toISOString(),
      pinned: 0,
    });

    const tab = asCollectionTab(svc.get(id));
    expect(tab.state.queryRaw).toBe('{}');
    expect(tab.state.builder.sort).toBe('{"age":1}');
    expect(tab.state.builder.limit).toBe('10');
    expect(tab.state.builder.projection).toEqual(['name']);

    // Same hydration path via list(), not just get().
    const listed = asCollectionTab(svc.list().find((t) => t.id === id)!);
    expect(listed.state.queryRaw).toBe('{}');
  });

  // ─── 'schema' → 'structure' migration on read ──────────────────────────
  describe('activeView migration on read', () => {
    function seedWithActiveView(activeView: unknown): string {
      const id = `view-tab-${String(activeView)}`;
      repo.insert({
        id,
        connection_id: 'conn',
        kind: 'collection',
        db_name: 'd',
        collection: 'c',
        state_json: JSON.stringify(
          activeView === undefined ? {} : { activeView },
        ),
        position: repo.nextPosition(),
        is_active: 0,
        opened_at: new Date().toISOString(),
        pinned: 0,
      });
      return id;
    }

    it('migrates a persisted schema view to structure', () => {
      const id = seedWithActiveView('schema');
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('structure');
    });

    it('leaves a persisted structure view as structure', () => {
      const id = seedWithActiveView('structure');
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('structure');
    });

    it('leaves documents and aggregation unchanged', () => {
      const docsId = seedWithActiveView('documents');
      const aggId = seedWithActiveView('aggregation');
      expect(asCollectionTab(svc.get(docsId)).state.activeView).toBe('documents');
      expect(asCollectionTab(svc.get(aggId)).state.activeView).toBe('aggregation');
    });

    it('falls back to documents for a garbage value', () => {
      const id = seedWithActiveView('not-a-real-view');
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('documents');
    });

    it('falls back to documents when activeView is absent', () => {
      const id = seedWithActiveView(undefined);
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('documents');
    });

    it('falls back to documents for unparseable state_json', () => {
      const id = 'view-tab-corrupt';
      repo.insert({
        id,
        connection_id: 'conn',
        kind: 'collection',
        db_name: 'd',
        collection: 'c',
        state_json: '{not json',
        position: repo.nextPosition(),
        is_active: 0,
        opened_at: new Date().toISOString(),
        pinned: 0,
      });
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('documents');
    });
  });
});
