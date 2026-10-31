import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { WorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import type { Logger } from '../../electron/log';
import { DEFAULT_AGGREGATION_TAB_STATE } from '../../shared/defaults';
import { createTempDb, type TempDb, createTempCipher } from '../helpers/db';

// When the page that reported dirty pipelines is gone (reload, crash, window
// closed), main recounts them from the saved tabs with `dirtyPipelineCount`,
// by the renderer's rule: a collection tab whose `aggregation.dirty` is true.

describe('WorkspaceStateService.dirtyPipelineCount', () => {
  let tmp: TempDb;
  let svc: WorkspaceStateService;
  let log: Logger;

  const setRaw = (id: string, column: 'state_json' | 'kind', value: string) =>
    tmp.db.prepare(`UPDATE workspace_tabs SET ${column} = ? WHERE id = ?`).run(value, id);

  const openPipeline = (collection: string, dirty: boolean) => {
    const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection });
    svc.update(tab.id, { state: { aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty } } });
    return tab.id;
  };

  beforeEach(() => {
    tmp = createTempDb();
    const now = new Date().toISOString();
    tmp.db
      .prepare(
        `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
         VALUES ('conn', 'c', 'standard', 'localhost', 27017, 'none', ?, ?)`,
      )
      .run(now, now);
    log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    svc = new WorkspaceStateService(new WorkspaceTabRepo(tmp.db, createTempCipher()), new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher())), log);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('is 0 with no tabs', () => {
    expect(svc.dirtyPipelineCount()).toBe(0);
  });

  it('counts dirty pipelines and ignores clean ones and tabs without a pipeline', () => {
    openPipeline('a', true);
    openPipeline('b', true);
    openPipeline('c', false);
    svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'plain' });
    expect(svc.dirtyPipelineCount()).toBe(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('ignores a script tab even when its saved state says dirty', () => {
    const script = svc.openScript({ connectionId: 'conn' });
    setRaw(script.id, 'state_json', JSON.stringify({ aggregation: { dirty: true } }));
    expect(svc.dirtyPipelineCount()).toBe(0);
  });

  it('counts a legacy aggregation-kind row, which reads back as a collection tab', () => {
    const id = openPipeline('legacy', true);
    setRaw(id, 'kind', 'aggregation');
    expect(svc.list().find((t) => t.id === id)?.kind).toBe('collection');
    expect(svc.dirtyPipelineCount()).toBe(1);
  });

  it('counts a truthy non-boolean dirty and ignores a falsy one, as the Workspace does', () => {
    const truthy = openPipeline('truthy', true);
    const falsy = openPipeline('falsy', true);
    setRaw(truthy, 'state_json', JSON.stringify({ aggregation: { dirty: 'yes' } }));
    setRaw(falsy, 'state_json', JSON.stringify({ aggregation: { dirty: 0 } }));
    expect(svc.dirtyPipelineCount()).toBe(1);
  });

  it('counts an unparseable row as 0 and names every such row in one warning', () => {
    openPipeline('ok', true);
    const bad1 = openPipeline('bad1', true);
    const bad2 = openPipeline('bad2', true);
    setRaw(bad1, 'state_json', '{not json');
    setRaw(bad2, 'state_json', '');
    expect(svc.dirtyPipelineCount()).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [, , data] = vi.mocked(log.warn).mock.calls[0]!;
    expect((data as { ids: string[] }).ids.toSorted((x, y) => x.localeCompare(y))).toEqual(
      [bad1, bad2].toSorted((x, y) => x.localeCompare(y)),
    );
  });

  it('reads a JSON null or scalar state as not dirty', () => {
    const a = openPipeline('null', true);
    const b = openPipeline('scalar', true);
    setRaw(a, 'state_json', 'null');
    setRaw(b, 'state_json', '7');
    expect(svc.dirtyPipelineCount()).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
