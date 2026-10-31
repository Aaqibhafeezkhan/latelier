import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { AuditRepo } from '../../electron/db/repositories/AuditRepo';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { RecentFieldValueRepo } from '../../electron/db/repositories/RecentFieldValueRepo';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { AuditService } from '../../electron/services/AuditService';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { WorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import { RecentFieldValueService } from '../../electron/services/RecentFieldValueService';
import { UndoStore } from '../../electron/services/UndoStore';
import { createTempCipher, createTempDb, insertConnectionRow, type TempDb } from '../helpers/db';

const SECRET = 'cell-content-7a1f';

/**
 * Makes row `bad` unreadable by giving it row `good`'s sealed cell: the AAD
 * names the row id, so the copy fails to decrypt exactly like a corrupt cell.
 */
function swapIn(tmp: TempDb, table: string, column: string, good: string, bad: string): void {
  tmp.db.prepare(`UPDATE ${table} SET ${column} = (SELECT ${column} FROM ${table} WHERE id = ?) WHERE id = ?`).run(good, bad);
}

describe('one undecryptable cell does not take down a list', () => {
  let tmp: TempDb;
  let warn: ReturnType<typeof vi.fn<(tag: string, msg: string, data?: unknown) => void>>;
  let log: { warn: typeof warn };
  const now = new Date().toISOString();

  beforeEach(() => {
    tmp = createTempDb();
    insertConnectionRow(tmp.db, 'c1');
    warn = vi.fn<(tag: string, msg: string, data?: unknown) => void>();
    log = { warn };
  });
  afterEach(() => tmp.cleanup());

  function expectWarned(table: string, column: string, id: string): void {
    expect(warn).toHaveBeenCalledWith('db', 'skipped an unreadable encrypted cell', { table, column, id });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  }

  it('recent queries: the bad row is skipped, the rest listed', () => {
    const repo = new RecentQueryRepo(tmp.db, createTempCipher(), log);
    for (const id of ['good', 'bad']) {
      repo.insert({
        id, connection_id: 'c1', db_name: 'd', collection: 'c', kind: 'find',
        payload_json: JSON.stringify({ queryRaw: SECRET }), ran_at: now, duration_ms: 1, result_count: 0, error_code: null,
      });
    }
    swapIn(tmp, 'recent_queries', 'payload_json', 'good', 'bad');
    expect(new RecentQueryService(repo).list({ connectionId: 'c1' }).map((q) => q.id)).toEqual(['good']);
    expectWarned('recent_queries', 'payload_json', 'bad');
    expect(() => repo.findById('bad')).toThrow(expect.objectContaining({ code: 'COLUMN_DECRYPT_FAILED' }));
  });

  it('audit log: the bad row is skipped, the rest listed', () => {
    const repo = new AuditRepo(tmp.db, createTempCipher(), log);
    for (const id of ['good', 'bad']) {
      repo.insert({
        id, connection_id: 'c1', db_name: 'd', collection: 'c', op: 'deleteOne',
        summary_json: JSON.stringify({ op: 'deleteOne', filter: SECRET, deletedCount: 1 }),
        outcome: 'ok', error_code: null, ran_at: now, duration_ms: 1, reversible: 0, undone_at: null,
      });
    }
    swapIn(tmp, 'audit_log', 'summary_json', 'good', 'bad');
    const svc = new AuditService(repo, {} as never, new UndoStore());
    expect(svc.list({ connectionId: 'c1' }).map((e) => e.id)).toEqual(['good']);
    expectWarned('audit_log', 'summary_json', 'bad');
  });

  it('saved queries: the bad row is listed with no payload, the rest intact', () => {
    const repo = new SavedQueryRepo(tmp.db, createTempCipher(), log);
    const svc = new SavedQueryService(repo);
    const payload = { queryRaw: SECRET, description: 'kept' } as never;
    const good = svc.create({ connectionId: 'c1', dbName: 'd', collection: 'c', kind: 'find', name: 'good', payload });
    const bad = svc.create({ connectionId: 'c1', dbName: 'd', collection: 'c', kind: 'find', name: 'bad', payload });
    swapIn(tmp, 'saved_queries', 'payload_json', good.id, bad.id);
    const listed = svc.list();
    expect(listed.map((s) => s.name).sort((a, b) => a.localeCompare(b))).toEqual(['bad', 'good']);
    expect(listed.find((s) => s.id === good.id)!.description).toBe('kept');
    expect(listed.find((s) => s.id === bad.id)!.description).toBeUndefined();
    expectWarned('saved_queries', 'payload_json', bad.id);
  });

  it('workspace tabs: the bad tab is listed with its default state, the rest intact', () => {
    const repo = new WorkspaceTabRepo(tmp.db, createTempCipher(), log);
    for (const [id, position] of [['good', 0], ['bad', 1]] as const) {
      repo.insert({
        id, connection_id: 'c1', kind: 'collection', db_name: 'd', collection: id,
        state_json: JSON.stringify({ queryRaw: SECRET, pageSize: 200 }), position, is_active: 0, opened_at: now, pinned: 0,
      });
    }
    swapIn(tmp, 'workspace_tabs', 'state_json', 'good', 'bad');
    const svc = new WorkspaceStateService(repo, new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher())));
    const tabs = svc.list();
    expect(tabs.map((t) => t.id)).toEqual(['good', 'bad']);
    expect((tabs[0]!.state as { pageSize?: number }).pageSize).toBe(200);
    expect((tabs[1]!.state as { queryRaw?: string }).queryRaw).not.toBe(SECRET);
    expectWarned('workspace_tabs', 'state_json', 'bad');
  });

  describe('a tab whose state cell is unreadable stays usable', () => {
    function setupBadTab() {
      const repo = new WorkspaceTabRepo(tmp.db, createTempCipher(), log);
      for (const [id, position] of [['good', 0], ['bad', 1]] as const) {
        repo.insert({
          id, connection_id: 'c1', kind: 'collection', db_name: 'd', collection: id,
          state_json: JSON.stringify({ queryRaw: SECRET }), position, is_active: id === 'bad' ? 1 : 0, opened_at: now, pinned: 0,
        });
      }
      swapIn(tmp, 'workspace_tabs', 'state_json', 'good', 'bad');
      const svc = new WorkspaceStateService(repo, new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher())));
      return { repo, svc };
    }

    it('updates, and the update re-seals the cell so it decrypts again', () => {
      const { svc } = setupBadTab();
      svc.update('bad', { state: { pageSize: 100 } });
      const cell = tmp.db.prepare("SELECT state_json FROM workspace_tabs WHERE id = 'bad'").get() as { state_json: Buffer };
      expect(JSON.parse(createTempCipher().open('workspace_tabs', 'state_json', 'bad', cell.state_json))).toMatchObject({ pageSize: 100 });
      expectWarned('workspace_tabs', 'state_json', 'bad');
      warn.mockClear();
      svc.update('bad', { state: { pageSize: 50 } });
      expect(warn).not.toHaveBeenCalled();
    });

    it('closes, activates and pins', () => {
      const { svc } = setupBadTab();
      expect(() => svc.setPinned('bad', true)).not.toThrow();
      expect(() => svc.setActive('bad')).not.toThrow();
      expect(svc.close('bad')).toEqual({ newActiveId: 'good' });
      expect(svc.list().map((t) => t.id)).toEqual(['good']);
    });

    it('is found by findMatching, as opening the same collection again does', () => {
      const { repo } = setupBadTab();
      expect(repo.findMatching('c1', 'collection', 'd', 'bad')).toMatchObject({ id: 'bad', state_json: '' });
    });
  });

  it('value suggestions: the bad value is skipped, the rest listed', () => {
    const repo = new RecentFieldValueRepo(tmp.db, createTempCipher(), log);
    const base = { connectionId: 'c1', dbName: 'd', collection: 'c', field: 'f', valType: 'string' as const, lastUsedAt: now };
    repo.upsert({ ...base, id: 'good', value: SECRET });
    repo.upsert({ ...base, id: 'bad', value: 'other' });
    swapIn(tmp, 'recent_field_values', 'value', 'good', 'bad');
    const values = new RecentFieldValueService(repo).listForField('c1', 'd', 'c', 'f');
    expect(values.map((v) => v.value)).toEqual([SECRET]);
    expectWarned('recent_field_values', 'value', 'bad');
  });
});
