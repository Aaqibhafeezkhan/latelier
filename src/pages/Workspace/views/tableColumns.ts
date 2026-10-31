import { isRecord, toDisplayValue } from '../../../utils/displayValue';
import { getAtSegments } from '../documentDiff';
import type { ReferenceRule, TableColumnConfig } from '@shared/types';
import type { SortDir } from '../builder';

/**
 * Schema-derived field list — scans the first 50 documents, keeping `_id`
 * first and the rest alphabetized. Shared by `TableView` (the rendered
 * columns) and `FieldsControl` (the show/hide/reorder field list), so both
 * always agree on which fields exist.
 */
export function deriveColumns(documents: unknown[]): string[] {
  const seen = new Set<string>();
  const nonId: string[] = [];

  for (const doc of documents.slice(0, 50)) {
    if (!isRecord(doc)) continue;
    for (const key of Object.keys(doc)) {
      if (key !== '_id' && !seen.has(key)) {
        seen.add(key);
        nonId.push(key);
      }
    }
  }

  return ['_id', ...nonId.sort((a, b) => a.localeCompare(b))];
}

/**
 * A single resolved Table column — either a plain field (a derived key that
 * exists on documents) or a computed dotted-path accessor column (T2.5,
 * AC8). Kept as a discriminated union so the Table's render loop can branch
 * on `kind` without re-deriving whether a column is computed from its name.
 */
export type ResolvedColumn =
  | { kind: 'field'; field: string }
  | { kind: 'computed'; field: string; path: string; label?: string };

/**
 * Apply an explicit field order on top of the schema-derived field list.
 * Fields in `order` come first (in that order); any derived field not
 * listed in `order` (schema drift — a new field appearing in later
 * documents, or simply never having been reordered) appends afterward in
 * its natural derived order. Fields in `order` that no longer exist in
 * `derived` are dropped silently.
 *
 * Exported separately from `resolveColumns` so the column chooser can
 * render checkboxes for *every* field (including hidden ones) in the
 * user's configured order — `resolveColumns` only returns visible columns.
 */
export function orderFields(derived: string[], order?: string[]): string[] {
  if (!order || order.length === 0) return derived.slice();
  const derivedSet = new Set(derived);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const f of order) {
    if (derivedSet.has(f) && !seen.has(f)) {
      result.push(f);
      seen.add(f);
    }
  }
  for (const f of derived) {
    if (!seen.has(f)) {
      result.push(f);
      seen.add(f);
    }
  }
  return result;
}

/**
 * Single source of truth for the Table view's visible, ordered column list
 * (T2.5, AC3/AC4/AC8). Combines the schema-derived field list with the
 * user's persisted `TableColumnConfig`:
 *
 *  - `order` — see `orderFields`.
 *  - `hidden` — fields dropped entirely from the result.
 *  - `computed` — dotted-path accessor columns appended after all field
 *    columns.
 *
 * `_id` gets no special-casing beyond being first in `derived` (TableView's
 * `deriveColumns` already puts it there) — once the user explicitly
 * reorders, `_id` moves like any other field.
 */
export function resolveColumns(
  derived: string[],
  config: TableColumnConfig | undefined,
): ResolvedColumn[] {
  const ordered = orderFields(derived, config?.order);
  const hidden = new Set(config?.hidden ?? []);
  const fieldColumns: ResolvedColumn[] = ordered
    .filter((f) => !hidden.has(f))
    .map((field) => ({ kind: 'field', field }));

  const computedColumns: ResolvedColumn[] = (config?.computed ?? []).map((c) => ({
    kind: 'computed',
    field: c.id,
    path: c.path,
    label: c.label,
  }));

  return [...fieldColumns, ...computedColumns];
}

/**
 * Move the item at `from` to `to`, returning a new array (input untouched).
 * Out-of-range indices (either side) are a no-op — callers (the column
 * chooser's drag-reorder) don't need to pre-validate drop targets.
 */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (
    from < 0 ||
    from >= list.length ||
    to < 0 ||
    to >= list.length ||
    // Stryker disable next-line ConditionalExpression: splice(i, 1) then splice(i, 0, moved) is an identity for any i — verified with a node probe across every index of a 5-element array
    from === to
  ) {
    return list.slice();
  }
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * `aria-sort` for a Table header cell (#53). A non-sortable column (a
 * computed accessor column, or a plain column when the view has no
 * `onSortField` at all) gets `undefined` — no attribute at all — rather than
 * `'none'`, which ARIA reserves for a sortable-but-currently-unsorted column.
 * Collapsing those two into one value would tell assistive tech every column
 * is sortable.
 */
export function ariaSortFor(
  sortable: boolean,
  dir: SortDir | undefined,
): 'ascending' | 'descending' | 'none' | undefined {
  if (!sortable) return undefined;
  if (dir === 1) return 'ascending';
  if (dir === -1) return 'descending';
  return 'none';
}

/**
 * Walk a dotted path (e.g. `address.city`, `tags.1`) into a document,
 * resolving numeric segments as array indices. Returns `undefined` on any
 * missing/non-document intermediate — same "absent value" semantics as a
 * regular missing field, so the Table renders it identically (T2.5, AC8).
 * No expression evaluation — accessor-only, per the ticket's scope guard.
 * Own keys only, so a path can't read an inherited `constructor`.
 */
export function getValueAtPath(doc: unknown, path: string): unknown {
  return getAtSegments(doc as Record<string, unknown>, path.split('.'))?.value;
}

/**
 * A reference rule on a dotted path under `field` (e.g. `address.userId` for
 * the `address` column) that the object cell can carry a chip for, since the
 * column's own key never matches such a rule. Only a rule whose target is a
 * leaf counts — the same `toDisplayValue` classification the Tree uses to
 * decide expansion, so an ObjectId `{$oid}` sentinel is a leaf, not an
 * object. Candidates are tried in `localeCompare` order so the choice is
 * stable.
 */
export function nestedReferenceFor(
  field: string,
  doc: unknown,
  refsByField: Map<string, ReferenceRule> | undefined,
): { rule: ReferenceRule; path: string; value: unknown } | null {
  if (!refsByField) return null;
  const prefix = `${field}.`;
  const candidates = [...refsByField.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [path, rule] of candidates) {
    const value = getValueAtPath(doc, path);
    const type = toDisplayValue(value).type;
    if (value === undefined || type === 'object' || type === 'array') continue;
    return { rule, path, value };
  }
  return null;
}
