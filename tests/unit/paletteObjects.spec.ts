import { describe, expect, it, vi } from 'vitest';
import {
  databaseObject,
  isPaletteSaved,
  savedObject,
  tabObject,
} from '../../src/pages/Workspace/paletteObjects';
import { activateTab, tabLabel } from '../../src/pages/Workspace/tabActions';
import { objectRow } from '../../src/commands/registry';
import type { PaletteContext } from '../../src/commands/types';
import type { CollectionTab, SavedQuerySummary, ScriptTab } from '@shared/types';

const ctx: PaletteContext = { pathname: '/workspace', connectionId: 'c1' };

const collTab = (over: Partial<CollectionTab> = {}): CollectionTab =>
  ({
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    position: 0,
    isActive: false,
    openedAt: '2026-07-26T12:00:00.000Z',
    pinned: false,
    state: {},
    ...over,
  }) as CollectionTab;

const scriptTab = (title: string | undefined): ScriptTab =>
  ({
    id: 's1',
    kind: 'script',
    connectionId: 'c1',
    position: 0,
    isActive: false,
    openedAt: '2026-07-26T12:00:00.000Z',
    pinned: true,
    state: { title },
  }) as unknown as ScriptTab;

const saved = (over: Partial<SavedQuerySummary> = {}): SavedQuerySummary => ({
  id: 'q1',
  connectionId: 'c1',
  dbName: 'shop',
  collection: 'orders',
  kind: 'find',
  name: 'Open orders last 7 days',
  updatedAt: '2026-11-11T10:00:00.000Z',
  ...over,
});

const ids = (o: { actions: { id: string }[] }) => o.actions.map((a) => a.id);

describe('tabLabel', () => {
  it('names a collection tab by its collection and a script tab by its title', () => {
    expect(tabLabel(collTab())).toBe('orders');
    expect(tabLabel(collTab({ collection: '' }))).toBe('(empty)');
    expect(tabLabel(scriptTab('seed users'))).toBe('seed users');
    expect(tabLabel(scriptTab(''))).toBe('Script');
  });
});

describe('tabObject', () => {
  function build(tab: CollectionTab | ScriptTab = collTab(), connectionName: string | null = 'Production') {
    const handlers = { activate: vi.fn(), close: vi.fn(), setPinned: vi.fn() };
    return { obj: tabObject({ tab, connectionName: connectionName ?? undefined, ...handlers }), ...handlers };
  }

  it('is named as its tab, with `<db> · <Connection>` and the Open tab tag', () => {
    const { obj } = build();
    expect(obj).toMatchObject({ id: 'tab:t1', kind: 'tab', name: 'orders', subtitle: 'shop · Production', tag: 'Open tab' });
    expect(objectRow(obj).object).toBe(obj);
  });

  it('gives a script tab its Connection alone, and no subtitle without one', () => {
    expect(build(scriptTab('x')).obj.subtitle).toBe('Production');
    expect(build(scriptTab('x'), null).obj.subtitle).toBeUndefined();
    expect(build(collTab(), null).obj.subtitle).toBe('shop');
  });

  it('switches by default, then closes and pins, each by its verb', () => {
    const { obj, activate, close, setPinned } = build();
    expect(ids(obj)).toEqual(['switch', 'close', 'pin']);
    expect(obj.actions.map((a) => [a.verb, a.title])).toEqual([
      ['open', 'Switch to'],
      ['close', 'Close'],
      ['pin', 'Pin'],
    ]);
    expect(obj.actions.some((a) => a.destructive || a.alternate)).toBe(false);
    void obj.actions[0]!.perform(ctx);
    expect(activate).toHaveBeenCalledWith('t1');
    void obj.actions[1]!.perform(ctx);
    expect(close).toHaveBeenCalledWith('t1');
    void obj.actions[2]!.perform(ctx);
    expect(setPinned).toHaveBeenCalledWith('t1', true);
  });

  it('offers Unpin on a pinned tab', () => {
    const { obj, setPinned } = build(scriptTab('x'));
    expect(obj.actions[2]!.title).toBe('Unpin');
    void obj.actions[2]!.perform(ctx);
    expect(setPinned).toHaveBeenCalledWith('s1', false);
  });
});

describe('savedObject', () => {
  function build(s: SavedQuerySummary = saved()) {
    const open = vi.fn();
    const rename = vi.fn();
    const remove = vi.fn();
    return { obj: savedObject({ saved: s, open, rename, remove }), open, rename, remove };
  }

  it('lists a query or a pipeline with its namespace and kind tag', () => {
    expect(build().obj).toMatchObject({
      id: 'saved:q1',
      kind: 'saved',
      name: 'Open orders last 7 days',
      subtitle: 'shop.orders',
      tag: 'Query',
    });
    expect(build(saved({ kind: 'aggregation' })).obj.tag).toBe('Pipeline');
  });

  it('opens by default, runs as the alternate, renames, deletes only as a destructive action', () => {
    const { obj, open, rename, remove } = build();
    expect(obj.actions.map((a) => [a.id, a.verb, a.title, !!a.alternate, !!a.destructive])).toEqual([
      ['open', 'open', 'Open', false, false],
      ['run', 'run', 'Run', true, false],
      ['rename', 'rename', 'Rename…', false, false],
      ['delete', 'delete', 'Delete…', false, true],
    ]);
    void obj.actions[0]!.perform(ctx);
    expect(open).toHaveBeenLastCalledWith(saved(), false);
    void obj.actions[1]!.perform(ctx);
    expect(open).toHaveBeenLastCalledWith(saved(), true);
    expect(rename).not.toHaveBeenCalled();
    void obj.actions[2]!.perform(ctx);
    expect(rename).toHaveBeenCalledWith(saved());
    expect(remove).not.toHaveBeenCalled();
    void obj.actions[3]!.perform(ctx);
    expect(remove).toHaveBeenCalledWith(saved());
    expect(() => objectRow(obj)).not.toThrow();
  });

  it('lists queries and pipelines, never scripts', () => {
    expect(isPaletteSaved(saved())).toBe(true);
    expect(isPaletteSaved(saved({ kind: 'aggregation' }))).toBe(true);
    expect(isPaletteSaved(saved({ kind: 'script' }))).toBe(false);
  });
});

describe('databaseObject', () => {
  function build(connectionName: string | null = 'Production') {
    const requestDialog = vi.fn();
    const reveal = vi.fn();
    return {
      obj: databaseObject({ connectionId: 'c1', db: 'ordering', connectionName: connectionName ?? undefined, requestDialog, reveal }),
      requestDialog,
      reveal,
    };
  }

  it('is named as the database, with `<Connection> · database`', () => {
    expect(build().obj).toMatchObject({
      id: 'database:c1:ordering',
      kind: 'database',
      name: 'ordering',
      subtitle: 'Production · database',
    });
    expect(build(null).obj.subtitle).toBe('database');
    expect(build().obj.tag).toBeUndefined();
    // Found by the word, and its default action answers to no verb of the table.
    expect(build().obj.keywords).toEqual(['database']);
    expect(build().obj.actions[0]!.verb).toBe('reveal');
    expect(build().obj.actions[1]!.verb).toBe('create');
  });

  it('reveals itself in the navigator by default, then creates a collection, and drops only as a destructive action', () => {
    const { obj, requestDialog, reveal } = build();
    expect(obj.actions.map((a) => [a.id, a.title, !!a.destructive])).toEqual([
      ['reveal', 'Reveal in navigator', false],
      ['create-collection', 'Create collection…', false],
      ['drop', 'Drop database…', true],
    ]);
    expect(obj.actions[2]!.verb).toBe('delete');
    void obj.actions[0]!.perform(ctx);
    expect(reveal).toHaveBeenCalledWith('c1', 'ordering');
    expect(requestDialog).not.toHaveBeenCalled();
    void obj.actions[1]!.perform(ctx);
    expect(requestDialog).toHaveBeenLastCalledWith({ connectionId: 'c1', dbName: 'ordering', dialog: 'createCollection' });
    void obj.actions[2]!.perform(ctx);
    expect(requestDialog).toHaveBeenLastCalledWith({ connectionId: 'c1', dbName: 'ordering', dialog: 'dropDatabase' });
  });
});

describe('activateTab', () => {
  async function run(id: string, status: 'connected' | 'disconnected', activeId = 't0') {
    const setActive = vi.fn(async () => {});
    const recordSessionEvent = vi.fn();
    const openConnection = vi.fn();
    await activateTab(
      {
        tabs: { tabs: [collTab({ id: 't1', connectionId: 'c2' })], activeId, setActive },
        connections: [{ id: 'c0', status: 'disconnected' } as never, { id: 'c2', status } as never],
        recordSessionEvent,
        openConnection,
      },
      id,
    );
    return { setActive, recordSessionEvent, openConnection };
  }

  it('brings the tab to the front and records the switch', async () => {
    const r = await run('t1', 'connected');
    expect(r.setActive).toHaveBeenCalledWith('t1');
    expect(r.recordSessionEvent).toHaveBeenCalledWith('tabSwitch', '*');
    expect(r.openConnection).not.toHaveBeenCalled();
  });

  it('records no switch to the tab already in front', async () => {
    const r = await run('t1', 'connected', 't1');
    expect(r.recordSessionEvent).not.toHaveBeenCalled();
    expect(r.setActive).toHaveBeenCalledWith('t1');
  });

  it('connects a dormant tab’s Connection, the wake gesture', async () => {
    expect((await run('t1', 'disconnected')).openConnection).toHaveBeenCalledWith('c2');
    expect((await run('gone', 'disconnected')).openConnection).not.toHaveBeenCalled();
  });
});
