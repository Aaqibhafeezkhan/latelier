import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  WorkspaceTabRepo,
  type WorkspaceTabRow,
} from '../../electron/db/repositories/WorkspaceTabRepo';
import { createTempDb, type TempDb, createTempCipher, cellType } from '../helpers/db';

function seedConnection(tmp: TempDb, id: string): void {
  const now = new Date().toISOString();
  tmp.db
    .prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES (?, 'c-' || ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
    )
    .run(id, id, now, now);
}

function makeRow(overrides: Partial<WorkspaceTabRow> = {}): WorkspaceTabRow {
  return {
    id: randomUUID(),
    connection_id: 'conn',
    kind: 'collection',
    db_name: 'db',
    collection: 'coll',
    state_json: '{}',
    position: 0,
    is_active: 0,
    opened_at: new Date().toISOString(),
    pinned: 0,
    ...overrides,
  };
}

describe('WorkspaceTabRepo', () => {
  let tmp: TempDb;
  let repo: WorkspaceTabRepo;

  beforeEach(() => {
    tmp = createTempDb();
    repo = new WorkspaceTabRepo(tmp.db, createTempCipher());
    seedConnection(tmp, 'conn');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('insert + list round-trips in position order', () => {
    const a = makeRow({ collection: 'a', position: 0 });
    const b = makeRow({ collection: 'b', position: 1 });
    const c = makeRow({ collection: 'c', position: 2 });
    repo.insert(a);
    repo.insert(b);
    repo.insert(c);
    expect(repo.list().map((r) => r.collection)).toEqual(['a', 'b', 'c']);
  });

  it('nextPosition returns max+1 (or 0 when empty)', () => {
    expect(repo.nextPosition()).toBe(0);
    repo.insert(makeRow({ position: 0 }));
    expect(repo.nextPosition()).toBe(1);
    repo.insert(makeRow({ position: 4 }));
    expect(repo.nextPosition()).toBe(5);
  });

  it('findMatching picks the first tab with the same conn/kind/db/coll', () => {
    repo.insert(makeRow({ connection_id: 'conn', db_name: 'd', collection: 'x', position: 0 }));
    repo.insert(makeRow({ connection_id: 'conn', db_name: 'd', collection: 'y', position: 1 }));
    const match = repo.findMatching('conn', 'collection', 'd', 'y');
    expect(match?.collection).toBe('y');
    expect(repo.findMatching('conn', 'collection', 'd', 'z')).toBeNull();
  });

  it('setActiveExclusive flips exactly one is_active flag', () => {
    const a = makeRow({ id: 'a', is_active: 1 });
    const b = makeRow({ id: 'b', is_active: 0, position: 1 });
    repo.insert(a);
    repo.insert(b);
    repo.setActiveExclusive('b');
    const rows = repo.list();
    expect(rows.find((r) => r.id === 'a')!.is_active).toBe(0);
    expect(rows.find((r) => r.id === 'b')!.is_active).toBe(1);
  });

  it('reorder rewrites positions to match orderedIds', () => {
    repo.insert(makeRow({ id: 'a', position: 0 }));
    repo.insert(makeRow({ id: 'b', position: 1 }));
    repo.insert(makeRow({ id: 'c', position: 2 }));
    repo.reorder(['c', 'a', 'b']);
    expect(repo.list().map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorder with an unknown id is a no-op for that id', () => {
    repo.insert(makeRow({ id: 'a', position: 0 }));
    repo.insert(makeRow({ id: 'b', position: 1 }));
    repo.reorder(['b', 'ghost', 'a']);
    expect(repo.list().map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('updateState overwrites state_json', () => {
    repo.insert(makeRow({ id: 'a', state_json: '{"view":"Tree"}' }));
    repo.updateState('a', '{"view":"JSON"}');
    expect(repo.findById('a')!.state_json).toBe('{"view":"JSON"}');
    expect(cellType(tmp.db, 'workspace_tabs', 'state_json', 'a')).toBe('blob');
  });

  it('a state cell copied onto another tab reads as empty state rather than decrypting there', () => {
    repo.insert(makeRow({ id: 'a', collection: 'a', state_json: '{"view":"Tree"}' }));
    repo.insert(makeRow({ id: 'b', collection: 'b', position: 1, state_json: '{"view":"JSON"}' }));
    tmp.db.prepare("UPDATE workspace_tabs SET state_json = (SELECT state_json FROM workspace_tabs WHERE id = 'a') WHERE id = 'b'").run();
    expect(repo.findById('b')!.state_json).toBe('');
    expect(repo.findById('a')!.state_json).toBe('{"view":"Tree"}');
  });

  it('deleteById returns changes count', () => {
    repo.insert(makeRow({ id: 'a' }));
    expect(repo.deleteById('a')).toBe(1);
    expect(repo.deleteById('ghost')).toBe(0);
  });

  it('cascade from connections delete', () => {
    repo.insert(makeRow({ connection_id: 'conn' }));
    tmp.db.prepare('DELETE FROM connections WHERE id = ?').run('conn');
    expect(repo.list().length).toBe(0);
  });

  it('setPinned toggles the pinned column', () => {
    const r = makeRow({ collection: 'a' });
    repo.insert(r);
    expect(repo.findById(r.id)?.pinned).toBe(0);
    repo.setPinned(r.id, true);
    expect(repo.findById(r.id)?.pinned).toBe(1);
    repo.setPinned(r.id, false);
    expect(repo.findById(r.id)?.pinned).toBe(0);
  });

  it('retargetCollection updates only the collection column, leaving db_name untouched', () => {
    const r = makeRow({ id: 'a', db_name: 'db', collection: 'orders' });
    repo.insert(r);
    repo.retargetCollection('a', 'orders2');
    const row = repo.findById('a')!;
    expect(row.collection).toBe('orders2');
    expect(row.db_name).toBe('db');
  });

  it('list sorts pinned tabs ahead of unpinned ones regardless of position', () => {
    const a = makeRow({ collection: 'a', position: 0 });
    const b = makeRow({ collection: 'b', position: 1 });
    const c = makeRow({ collection: 'c', position: 2 });
    repo.insert(a);
    repo.insert(b);
    repo.insert(c);
    repo.setPinned(c.id, true);
    expect(repo.list().map((r) => r.collection)).toEqual(['c', 'a', 'b']);
  });

  /**
   * confirms `list()`'s `ORDER BY pinned DESC, position ASC` needs no
   * change under the new `handleDrop` invariant (X16 §5, `tabGroups.ts`).
   *
   * Three Connections' tabs interleaved by `position`, one tab pinned on a
   * Connection nobody drags. `reorder()` is called with the exact id list
   * `TabStrip.tsx`'s fixed `handleDrop` now produces for an in-group drag on
   * a different Connection — built from raw-position order, splicing only
   * the dragged group's own slots (see the component-level test in
   * `tests/component/workspace-tab-groups.spec.tsx` for how that list is
   * derived).
   */
  it('reorder + list stays correct when a same-group drag runs after a cross-group pin', () => {
    // c1: a1(pos0), a2(pos3) — the group that gets dragged.
    // c2: b1(pos1), b2(pos4, pinned) — untouched by the drag.
    // c3: q1(pos2) — untouched by the drag.
    const a1 = makeRow({ id: 'a1', connection_id: 'c1', collection: 'alpha', position: 0 });
    const b1 = makeRow({ id: 'b1', connection_id: 'c2', collection: 'bravo', position: 1 });
    const q1 = makeRow({ id: 'q1', connection_id: 'c3', collection: 'quebec', position: 2 });
    const a2 = makeRow({ id: 'a2', connection_id: 'c1', collection: 'charlie', position: 3 });
    const b2 = makeRow({ id: 'b2', connection_id: 'c2', collection: 'delta', position: 4 });
    for (const id of new Set([a1, b1, q1, a2, b2].map((r) => r.connection_id))) {
      seedConnection(tmp, id);
    }
    [a1, b1, q1, a2, b2].forEach((r) => repo.insert(r));
    repo.setPinned('b2', true);

    // The list `handleDrop` now hands to `onReorder` after dragging `a1`
    // (alpha) onto `a2` (charlie) within c1 — every other tab keeps its
    // raw-position relative order (`b1` before `b2`, both before... no,
    // `q1` sits between them by raw position), only c1's own slots permute.
    repo.reorder(['a2', 'b1', 'q1', 'a1', 'b2']);

    // Positions are rewritten sequentially in that order.
    const byId = new Map(repo.list().map((r) => [r.id, r]));
    expect(byId.get('a2')!.position).toBe(0);
    expect(byId.get('b1')!.position).toBe(1);
    expect(byId.get('q1')!.position).toBe(2);
    expect(byId.get('a1')!.position).toBe(3);
    expect(byId.get('b2')!.position).toBe(4);

    // `list()`'s pinned-first read still puts the pinned tab first — the
    // repo query alone restores pinned-first display order on the next
    // full load, independent of whatever transient order a component held
    // in memory right after the drag.
    expect(repo.list().map((r) => r.id)).toEqual(['b2', 'a2', 'b1', 'q1', 'a1']);

    // And critically for `groupTabsByConnection`: sorted by raw `position`
    // (ignoring `pinned`, exactly what it does), each Connection's first
    // appearance is still c1, c2, c3 — the same group order as before the
    // drag+pin, because the drag only ever permuted c1's own position slots.
    const byPosition = [...repo.list()].sort((r1, r2) => r1.position - r2.position);
    const firstAppearance: string[] = [];
    for (const row of byPosition) {
      if (!firstAppearance.includes(row.connection_id)) firstAppearance.push(row.connection_id);
    }
    expect(firstAppearance).toEqual(['c1', 'c2', 'c3']);
  });
});
