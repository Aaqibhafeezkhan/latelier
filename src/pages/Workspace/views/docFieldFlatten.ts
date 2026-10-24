import { isRecord, toDisplayValue } from '../../../utils/displayValue';
import { childKey, rootKey } from './fieldPathKey';

export interface FlatFieldRow {
  /** Same `path` key `FieldNode` (`DocFieldTree.tsx`) uses for expansion
   * state and its own `id` — an escaped identity key, not a raw dot-path
   * (see `fieldPathKey.ts`, #86). */
  path: string;
  /** Whether this row can be expanded — Enter/Space on an expandable active
   * row toggles it; on a leaf it opens the full-value popover instead. */
  expandable: boolean;
  /** Dot-path of the field within the document (no docId prefix) — same
   * value `FieldNode` computes for itself as it recurses. Carried here too
   * (#68) so a keyboard-opened field menu can hand the same `fieldPath` to
   * `onOpenMenu` that a mouse-opened one does, rather than re-deriving it
   * from `path` — `path` is now an escaped identity key that also carries the
   * `docId` prefix (#86), so unescaping it back into a plain dot-path would
   * be extra work for no benefit over just carrying the value this same
   * recursion already computed. */
  fieldPath: string;
  /** The field's own value — same reasoning as `fieldPath` above. */
  value: unknown;
}

/**
 * The document's field rows in the exact order `FieldNode`'s own recursion
 * (`DocFieldTree.tsx`) renders them — top-level fields, and (only for a
 * currently-expanded path) its children immediately after it, depth-first.
 * This is what #20's roving focus needs to turn "ArrowDown" into "the next
 * visible row": unlike `TableView`/`TreeView` (one roving row per document,
 * a fixed count), a field tree's row count and order change as the user
 * expands/collapses sibling fields, so there's no static index to roll a
 * highlight over — it has to be recomputed from `doc` + `expandedPaths` on
 * every render.
 *
 * Pulled out of `DocFieldTree.tsx` (a components-only file, same reason
 * `docId.ts` lives next to it as its own module) so this pure function gets
 * fast `tests/unit/` coverage without needing a DOM.
 */
export function flattenVisibleFieldRows(
  doc: Record<string, unknown>,
  docId: string,
  expandedPaths: Set<string>,
): FlatFieldRow[] {
  const out: FlatFieldRow[] = [];
  const visit = (
    entries: Array<[string, unknown]>,
    parentPath: string | null,
    parentFieldPath: string,
  ) => {
    for (const [name, value] of entries) {
      const path = parentPath === null ? rootKey(docId, name) : childKey(parentPath, name);
      const fieldPath = parentFieldPath ? `${parentFieldPath}.${name}` : name;
      const dv = toDisplayValue(value);
      const expandable = dv.type === 'object' || dv.type === 'array';
      out.push({ path, expandable, fieldPath, value });
      if (!expandable || !expandedPaths.has(path)) continue;
      // Stryker disable LogicalOperator,ConditionalExpression: dv comes from toDisplayValue(value), whose only 'array' case is `Array.isArray(v)` and whose only 'object' case is inside its own `isRecord(v)` branch — for this value, dv.type === 'array' always agrees with Array.isArray(value), and reaching the else-if means dv.type === 'object', which already guarantees isRecord(value). Verified against displayValue.ts's source and a throwaway probe over array/non-array/record/non-record shapes.
      if (dv.type === 'array' && Array.isArray(value)) {
        visit(value.map((v, i): [string, unknown] => [String(i), v]), path, fieldPath);
      } else if (isRecord(value)) {
        visit(Object.entries(value), path, fieldPath);
      }
      // Stryker restore LogicalOperator,ConditionalExpression
    }
  };
  visit(Object.entries(doc), null, '');
  return out;
}
