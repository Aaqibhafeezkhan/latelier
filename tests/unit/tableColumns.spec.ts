import { describe, it, expect } from 'vitest';
import {
  resolveColumns,
  reorder,
  getValueAtPath,
  orderFields,
  deriveColumns,
  ariaSortFor,
  nestedReferenceFor,
} from '../../src/pages/Workspace/views/tableColumns';
import type { ReferenceRule, TableColumnConfig } from '@shared/types';

describe('orderFields', () => {
  const derived = ['_id', 'apple', 'banana', 'zebra'];

  it('returns derived order unchanged when no order is given', () => {
    expect(orderFields(derived, undefined)).toEqual(derived);
    expect(orderFields(derived, [])).toEqual(derived);
  });

  it('returns a fresh array when no order is given, not the same `derived` reference', () => {
    expect(orderFields(derived, undefined)).not.toBe(derived);
  });

  it('applies the explicit order, including hidden-equivalent fields (no hidden concept here)', () => {
    expect(orderFields(derived, ['zebra', '_id'])).toEqual([
      'zebra',
      '_id',
      'apple',
      'banana',
    ]);
  });

  it('drops stale order entries that no longer exist in derived', () => {
    expect(orderFields(derived, ['ghost', 'zebra'])).toEqual([
      'zebra',
      '_id',
      'apple',
      'banana',
    ]);
  });

  // `derived` is documented as coming from `deriveColumns` (already unique),
  // but `orderFields` takes a plain `string[]` and doesn't itself assume
  // that — the second loop's own `seen.add` is what stops a duplicate
  // `derived` entry from being appended twice.
  it('does not duplicate a derived field that appears twice in the input', () => {
    expect(orderFields(['a', 'a', 'b'], ['b'])).toEqual(['b', 'a']);
  });

  // The early `order.length === 0` return hands back `derived.slice()`
  // verbatim, duplicates included. Without the early return, an empty
  // `order` would fall into the general loop, whose `seen` set dedupes —
  // a duplicate `derived` entry is the only input that tells the two
  // code paths apart (their output is otherwise identical for every
  // non-duplicated `derived`).
  it('preserves a duplicate derived field when order is the empty array', () => {
    expect(orderFields(['a', 'a', 'b'], [])).toEqual(['a', 'a', 'b']);
  });
});

describe('resolveColumns', () => {
  const derived = ['_id', 'apple', 'banana', 'zebra'];

  it('undefined config → derived order, all visible, no computed', () => {
    expect(resolveColumns(derived, undefined)).toEqual([
      { field: '_id', kind: 'field' },
      { field: 'apple', kind: 'field' },
      { field: 'banana', kind: 'field' },
      { field: 'zebra', kind: 'field' },
    ]);
  });

  it('honors an explicit order', () => {
    const config: TableColumnConfig = { order: ['zebra', '_id', 'apple'] };
    const result = resolveColumns(derived, config);
    expect(result.map((c) => c.field)).toEqual(['zebra', '_id', 'apple', 'banana']);
  });

  it('drops hidden columns from the resolved list', () => {
    const config: TableColumnConfig = { hidden: ['banana'] };
    const result = resolveColumns(derived, config);
    expect(result.map((c) => c.field)).toEqual(['_id', 'apple', 'zebra']);
  });

  it('appends newly-derived columns not yet in order', () => {
    const config: TableColumnConfig = { order: ['banana', '_id'] };
    // `apple` and `zebra` are not in `order` — they append, in their derived
    // (alphabetical) order, after the configured ones.
    const result = resolveColumns(derived, config);
    expect(result.map((c) => c.field)).toEqual(['banana', '_id', 'apple', 'zebra']);
  });

  it('keeps _id first when no explicit order is configured', () => {
    const result = resolveColumns(derived, { hidden: [] });
    expect(result[0].field).toBe('_id');
  });

  it('does not special-case _id when the user has explicitly reordered it', () => {
    const config: TableColumnConfig = { order: ['apple', 'banana', '_id', 'zebra'] };
    const result = resolveColumns(derived, config);
    expect(result.map((c) => c.field)).toEqual(['apple', 'banana', '_id', 'zebra']);
  });

  it('appends computed columns after derived/ordered field columns', () => {
    const config: TableColumnConfig = {
      computed: [{ id: 'c1', path: 'address.city', label: 'City' }],
    };
    const result = resolveColumns(derived, config);
    expect(result[result.length - 1]).toEqual({
      field: 'c1',
      kind: 'computed',
      path: 'address.city',
      label: 'City',
    });
  });

  it('a hidden field and a computed column can coexist', () => {
    const config: TableColumnConfig = {
      hidden: ['zebra'],
      computed: [{ id: 'c1', path: 'nested.value' }],
    };
    const result = resolveColumns(derived, config);
    expect(result.map((c) => c.field)).toEqual(['_id', 'apple', 'banana', 'c1']);
  });

  // Mutation: `new Set(config?.hidden ?? [])` mutated to a non-empty default
  // survived every test above, because none of them derive a field that the
  // mutant's injected literal ("Stryker was here", Stryker's own sentinel
  // for a string-array mutation) would coincidentally hide — an absent
  // `hidden` filtering out a fictional field is indistinguishable from
  // filtering out nothing, for every field name a normal test would pick.
  // Deriving a field with that exact name is what actually exercises "the
  // default hides nothing" rather than "the default doesn't happen to hide
  // one of these four unrelated fields".
  it('hides nothing when `hidden` is unset, even for a field matching a common mutation sentinel', () => {
    const result = resolveColumns([...derived, 'Stryker was here'], undefined);
    expect(result.map((c) => c.field)).toContain('Stryker was here');
  });
});

describe('reorder', () => {
  it('moves an item forward (down the list)', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item backward (up the list)', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when from === to', () => {
    const list = ['a', 'b', 'c'];
    expect(reorder(list, 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('guards against an out-of-range `from`', () => {
    const list = ['a', 'b', 'c'];
    expect(reorder(list, -1, 1)).toEqual(list);
    expect(reorder(list, 5, 1)).toEqual(list);
    // Boundary: `from === list.length` is one past the last valid index,
    // still out of range — not just anything strictly greater.
    expect(reorder(list, list.length, 1)).toEqual(list);
  });

  it('guards against an out-of-range `to`', () => {
    const list = ['a', 'b', 'c'];
    expect(reorder(list, 0, -1)).toEqual(list);
    expect(reorder(list, 0, 5)).toEqual(list);
    // Boundary: `to === list.length` is one past the last valid index —
    // out of range, same as the `from` boundary above.
    expect(reorder(list, 0, list.length)).toEqual(list);
  });

  // `to === 0` is the first valid index, not an out-of-range one — the
  // opposite boundary from the guard above. Without this, a `to < 0` guard
  // loosened to `to <= 0` still passes every other test here.
  it('treats `to === 0` as a valid, in-range destination', () => {
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input array', () => {
    const list = ['a', 'b', 'c'];
    reorder(list, 0, 2);
    expect(list).toEqual(['a', 'b', 'c']);
  });

  // The docstring promises "a new array (input untouched)" even on the
  // no-op path — `toEqual` alone can't tell a fresh copy from the same
  // reference handed back.
  it('returns a fresh array (not the same reference) even on the out-of-range no-op path', () => {
    const list = ['a', 'b', 'c'];
    expect(reorder(list, -1, 1)).not.toBe(list);
  });
});

describe('getValueAtPath', () => {
  it('resolves a nested object path', () => {
    const doc = { address: { city: 'Springfield' } };
    expect(getValueAtPath(doc, 'address.city')).toBe('Springfield');
  });

  it('resolves a numeric array index segment', () => {
    const doc = { tags: ['a', 'b', 'c'] };
    expect(getValueAtPath(doc, 'tags.1')).toBe('b');
  });

  // A single-digit index can't tell `ARRAY_INDEX_RE`'s "digits after the
  // first" apart from "non-digits after the first" — both happen to accept
  // "1". A real multi-digit canonical index is what actually needs the
  // digit class right.
  it('resolves a multi-digit array index segment', () => {
    const doc = { tags: Array.from({ length: 12 }, (_, i) => `item${i}`) };
    expect(getValueAtPath(doc, 'tags.10')).toBe('item10');
  });

  it('resolves a top-level (undotted) path', () => {
    const doc = { name: 'alpha' };
    expect(getValueAtPath(doc, 'name')).toBe('alpha');
  });

  it('returns undefined for a missing path', () => {
    const doc = { address: { city: 'Springfield' } };
    expect(getValueAtPath(doc, 'address.zip')).toBeUndefined();
  });

  it('returns undefined when an intermediate segment is missing', () => {
    const doc = { address: null };
    expect(getValueAtPath(doc, 'address.city')).toBeUndefined();
  });

  it('returns undefined for non-record input', () => {
    expect(getValueAtPath('not a doc', 'a.b')).toBeUndefined();
    expect(getValueAtPath(null, 'a.b')).toBeUndefined();
    expect(getValueAtPath(undefined, 'a.b')).toBeUndefined();
  });

  it('reads own keys only, never an inherited property', () => {
    expect(getValueAtPath({ a: {} }, 'a.constructor')).toBeUndefined();
    expect(getValueAtPath({ tags: ['x'] }, 'tags.length')).toBeUndefined();
  });

  // Reviewer-bot finding: `Number(segment)` + `Number.isInteger` coerces
  // non-canonical strings into valid array indices (" " and "" → 0, "1e0" and
  // "0x1" → 1). Only a strict canonical-integer segment should resolve.
  describe('rejects non-canonical array index segments', () => {
    const doc = { tags: ['a', 'b', 'c'] };

    it.each([' ', '', '1e0', '0x1', '01'])('segment %j → undefined', (segment) => {
      expect(getValueAtPath(doc, `tags.${segment}`)).toBeUndefined();
    });

    it('still resolves canonical indices, including "0"', () => {
      expect(getValueAtPath(doc, 'tags.0')).toBe('a');
      expect(getValueAtPath(doc, 'tags.1')).toBe('b');
      expect(getValueAtPath(doc, 'tags.2')).toBe('c');
    });
  });
});

describe('deriveColumns field ordering', () => {
  // `nonId.sort()` with no compare function orders by UTF-16 code unit, which
  // puts every capitalised field ahead of every lowercase one: `Name`, `Zip`,
  // `age`. That reads as two separate alphabets in the column chooser. The
  // explicit `localeCompare` comparator is what interleaves them, and this
  // pins it — a revert to a bare `.sort()` fails here, not silently in the UI.
  it('alphabetises case-insensitively rather than by code unit', () => {
    expect(deriveColumns([{ _id: 1, Zip: 1, age: 1, Name: 1, _tag: 1 }])).toEqual([
      '_id',
      '_tag',
      'age',
      'Name',
      'Zip',
    ]);
  });

  it('keeps _id first whatever the other fields sort to', () => {
    expect(deriveColumns([{ Aa: 1, _id: 1 }])[0]).toBe('_id');
  });

  it('unions fields across documents without duplicating', () => {
    expect(deriveColumns([{ _id: 1, b: 1 }, { _id: 2, a: 1, b: 2 }])).toEqual(['_id', 'a', 'b']);
  });

  it('scans only the first 50 documents — a field introduced later stays undiscovered', () => {
    const docs = Array.from({ length: 50 }, () => ({ _id: 1 }));
    docs.push({ _id: 1, lateField: 'x' } as unknown as { _id: number });
    expect(deriveColumns(docs)).not.toContain('lateField');
  });

  it('skips a non-record entry in the documents array instead of throwing', () => {
    const docs = [{ _id: 1, name: 'a' }, null, { _id: 2, name: 'b' }];
    expect(deriveColumns(docs)).toEqual(['_id', 'name']);
  });
});

describe('ariaSortFor (#53)', () => {
  it('is undefined for a non-sortable column regardless of dir', () => {
    expect(ariaSortFor(false, undefined)).toBeUndefined();
    expect(ariaSortFor(false, 1)).toBeUndefined();
    expect(ariaSortFor(false, -1)).toBeUndefined();
  });

  it('is "none" for a sortable column with no active sort', () => {
    expect(ariaSortFor(true, undefined)).toBe('none');
  });

  it('is "ascending" or "descending" for a sortable column\'s active direction', () => {
    expect(ariaSortFor(true, 1)).toBe('ascending');
    expect(ariaSortFor(true, -1)).toBe('descending');
  });
});

describe('nestedReferenceFor', () => {
  const mk = (id: string, sourceField: string): ReferenceRule => ({
    id,
    connectionId: 'c1',
    sourceDb: 'app',
    sourceCollection: 'orders',
    sourceField,
    targetDb: 'app',
    targetCollection: 'users',
    targetField: '_id',
    projection: [],
    displayTemplate: undefined,
    enabled: true,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  });
  const refs = (...fields: string[]) =>
    new Map(fields.map((f) => [f, mk(f, f)] as const));

  it('returns null with no rules at all', () => {
    expect(nestedReferenceFor('address', { address: { userId: 1 } }, undefined)).toBeNull();
    expect(nestedReferenceFor('address', { address: { userId: 1 } }, new Map())).toBeNull();
  });

  it('ignores a direct rule on the column itself', () => {
    expect(nestedReferenceFor('address', { address: { userId: 1 } }, refs('address'))).toBeNull();
  });

  it('ignores a rule on a sibling column whose name merely starts with the field', () => {
    expect(nestedReferenceFor('addr', { addr: { userId: 1 }, address: { userId: 2 } }, refs('address.userId'))).toBeNull();
  });

  it('matches a dotted rule and returns its rule, path and leaf value', () => {
    const r = refs('address.userId');
    expect(nestedReferenceFor('address', { address: { userId: 7 } }, r)).toEqual({
      rule: r.get('address.userId'),
      path: 'address.userId',
      value: 7,
    });
  });

  it('returns null when the dotted path is missing from the document', () => {
    expect(nestedReferenceFor('address', { address: { city: 'x' } }, refs('address.userId'))).toBeNull();
  });

  it('returns null when the rule targets a nested object or an array', () => {
    expect(nestedReferenceFor('address', { address: { geo: { a: 1 } } }, refs('address.geo'))).toBeNull();
    expect(nestedReferenceFor('address', { address: { ids: [1, 2] } }, refs('address.ids'))).toBeNull();
  });

  it('treats an ObjectId sentinel as a leaf, not an object', () => {
    const oid = { $oid: '507f1f77bcf86cd799439011' };
    const r = refs('address.userId');
    expect(nestedReferenceFor('address', { address: { userId: oid } }, r)).toEqual({
      rule: r.get('address.userId'),
      path: 'address.userId',
      value: oid,
    });
  });

  it('picks the first matching rule by localeCompare and skips non-leaf ones', () => {
    const doc = { address: { a: { x: 1 }, b: 'bee', c: 'sea' } };
    const r = refs('address.c', 'address.b', 'address.a');
    expect(nestedReferenceFor('address', doc, r)?.path).toBe('address.b');
  });
});
