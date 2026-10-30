import type { OperatorClass } from './operators';
import type { Suggestion } from './types';

/**
 * Header text for each operator class in the builder's grouped op picker. The
 * `query` class is the comparison operators (`$eq`, `$gt`, `$in`, ...), which
 * is what a user scanning the list is looking for, hence the friendlier name.
 */
export const OPERATOR_GROUP_LABELS: Partial<Record<OperatorClass, string>> = {
  query: 'Comparison',
  logical: 'Logical',
  element: 'Element',
  evaluation: 'Evaluation',
  array: 'Array',
  geo: 'Geospatial',
};

/** Header for a class the picker has no dedicated name for. */
const FALLBACK_GROUP_LABEL = 'Other';

export interface OperatorGroupRange {
  label: string;
  /** Index of the group's first row in `items`. */
  start: number;
  /** One past the group's last row. */
  end: number;
}

/**
 * Splits a ranked suggestion list into runs of consecutive operators of one
 * class. Only the grouping is computed here: the list's order is untouched, so
 * a run is only as long as the order makes it. A non-operator item belongs to
 * no group and ends the run before it.
 */
export function groupOperatorRows(items: readonly Suggestion[]): OperatorGroupRange[] {
  const groups: OperatorGroupRange[] = [];
  let runClass: OperatorClass | null = null;
  items.forEach((s, i) => {
    if (s.kind !== 'operator') {
      runClass = null;
      return;
    }
    if (s.class === runClass) {
      groups[groups.length - 1]!.end = i + 1;
      return;
    }
    runClass = s.class;
    groups.push({
      label: OPERATOR_GROUP_LABELS[s.class] ?? FALLBACK_GROUP_LABEL,
      start: i,
      end: i + 1,
    });
  });
  return groups;
}
