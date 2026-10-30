import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { AppStateRepo } from '../../electron/db/repositories/AppStateRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { AppStateService } from '../../electron/services/AppStateService';
import {
  WorkspaceStateService,
  applyRestoreTabsPref,
} from '../../electron/services/WorkspaceStateService';
import { createTempDb, type TempDb, createTempCipher } from '../helpers/db';

const RESTORE_KEY = 'ui.workspace.restoreTabs';

describe('applyRestoreTabsPref (boot)', () => {
  let tmp: TempDb;
  let tabs: WorkspaceStateService;
  let appState: AppStateService;

  beforeEach(() => {
    tmp = createTempDb();
    const now = new Date().toISOString();
    tmp.db
      .prepare(
        `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
         VALUES ('conn', 'c', 'standard', 'localhost', 27017, 'none', ?, ?)`,
      )
      .run(now, now);
    tabs = new WorkspaceStateService(
      new WorkspaceTabRepo(tmp.db, createTempCipher()),
      new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher())),
    );
    appState = new AppStateService(new AppStateRepo(tmp.db));
    const a = tabs.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    tabs.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    tabs.setPinned(a.id, true);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('closes every tab, pinned included, when the setting is off', () => {
    appState.set(RESTORE_KEY, false);
    applyRestoreTabsPref(appState, tabs);
    expect(tabs.list()).toEqual([]);
  });

  it('keeps the tabs when the setting is on', () => {
    appState.set(RESTORE_KEY, true);
    applyRestoreTabsPref(appState, tabs);
    expect(tabs.list().length).toBe(2);
  });

  it('keeps the tabs when the setting was never set', () => {
    applyRestoreTabsPref(appState, tabs);
    expect(tabs.list().length).toBe(2);
  });
});
