import type { Stage, ValType } from '@shared/types';
import { toDisplayValue } from '../../utils/displayValue';
import { repairToCanonicalEjson } from '../../utils/shellSyntax';
import { valTypeFromDisplayType } from '../../pages/Workspace/builder';
import {
  parseFilter,
  parseJsonArrayLenient,
  type CondNode,
  type FilterNode,
} from '../../pages/Workspace/filterTree';

/**
 * The only ops both suggested and recorded — mirrors
 * `VALUE_SUGGESTION_OPS` in `operators.ts` and `RECORDABLE_OPS` in
 * `RecentFieldValueService`. Kept as its own copy rather than a shared
 * import: it's a two-line set literal, and the three call sites (popover
 * gating, this write path, and main's authoritative filter) each want to
 * fail independently rather than share a module that could silently drift
 * out of a process boundary.
 */
const RECORDABLE_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);

function collectCondNodes(node: FilterNode, out: CondNode[]): void {
  if (node.kind === 'cond') {
    out.push(node);
  } else if (node.kind === 'group') {
    for (const child of node.children) collectCondNodes(child, out);
  }
}

export interface FieldValueEntry {
  field: string;
  value: string;
  valType: ValType;
  op: string;
}

/**
 * Walks a successful run's filter for the conditions worth remembering.
 * `$in`/`$nin` are element-wise: each array element becomes
 * its own entry, typed from its own EJSON shape rather than the cond's
 * `array` valType, since that's what the value popover suggests against.
 */
export function fieldValueEntriesFromFilter(filterJson: string): FieldValueEntry[] {
  const parsed = parseFilter(filterJson);
  if (!parsed.ok) return [];
  const conds: CondNode[] = [];
  collectCondNodes(parsed.root, conds);
  const entries: FieldValueEntry[] = [];
  for (const cond of conds) {
    if (cond.field.trim() === '' || !RECORDABLE_OPS.has(cond.op)) continue;
    if (cond.op === '$in' || cond.op === '$nin') {
      for (const el of parseJsonArrayLenient(cond.value)) {
        const dv = toDisplayValue(el);
        // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral:
        // defensive. `parseFilter` only models an `$in`/`$nin` as a cond when
        // every element is a scalar it can type; an object, nested array or
        // non-scalar sentinel (`$timestamp`, `$minKey`, `$regularExpression`)
        // turns the whole condition into a raw node, which is never walked.
        // Verified with a probe over each of those shapes: all yield [].
        if (dv.type === 'object' || dv.type === 'array' || dv.type === 'undefined') continue;
        if (dv.display.trim() === '') continue;
        entries.push({ field: cond.field, value: dv.display, valType: valTypeFromDisplayType(dv.type), op: cond.op });
      }
    } else if (cond.value.trim() !== '') {
      entries.push({ field: cond.field, value: cond.value, valType: cond.valType, op: cond.op });
    }
  }
  return entries;
}

/**
 * The values an aggregation run's filter carried. Only the leading run of
 * enabled `$match` stages counts: after a `$group`, `$project`, `$unwind` or
 * any other reshaping stage, a key no longer names a field of the source
 * collection, so recording it would suggest values for fields that don't
 * exist there. Disabled stages are skipped without ending the run, since the
 * server never sees them. A body that is not EJSON yet is repaired first; one
 * that cannot be repaired is skipped.
 */
export function fieldValueEntriesFromStages(stages: Stage[]): FieldValueEntry[] {
  const entries: FieldValueEntry[] = [];
  for (const stage of stages) {
    if (!stage.enabled) continue;
    if (stage.op !== '$match') break;
    // A `failed` repair falls through with the original text, which
    // `parseFilter` rejects in turn: the repair only fails on text that is
    // not strict JSON, so the stage adds nothing.
    const repair = repairToCanonicalEjson(stage.body);
    const text = repair.kind === 'repaired' ? repair.text : stage.body;
    entries.push(...fieldValueEntriesFromFilter(text));
  }
  return entries;
}
