// Starter rows for an empty filter tree (W15 §14.8). Each one is a condition
// with a blank field, so it stays pending until the person names the field,
// and its label doubles as documentation for the operator behind it.
import type { CondNode } from '@shared/types';
import { datePresetValue } from './condValue';

export interface FilterTemplate {
  id: string;
  label: string;
  /** The operator the row uses, named in the button's tooltip. */
  operator: string;
  build: (now: Date) => CondNode;
}

export const FILTER_TEMPLATES: FilterTemplate[] = [
  {
    id: 'last7d',
    label: 'Last 7 days',
    operator: '$gte',
    build: (now) => ({ kind: 'cond', field: '', op: '$gte', valType: 'date', value: datePresetValue('7d', now) }),
  },
  {
    id: 'notNull',
    label: 'Exists and is not null',
    operator: '$ne',
    build: () => ({ kind: 'cond', field: '', op: '$ne', valType: 'null', value: '' }),
  },
  {
    id: 'containsCi',
    label: 'Contains text (any case)',
    operator: '$regex',
    // `(?i)` is PCRE's inline case-insensitive flag, so the person types the
    // text after it and needs no separate `$options`.
    build: () => ({ kind: 'cond', field: '', op: '$regex', valType: 'string', value: '(?i)' }),
  },
  {
    id: 'inList',
    label: 'One of a list',
    operator: '$in',
    build: () => ({ kind: 'cond', field: '', op: '$in', valType: 'string', value: '[]' }),
  },
];
