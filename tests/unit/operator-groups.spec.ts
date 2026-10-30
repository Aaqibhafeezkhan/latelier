import { describe, it, expect } from 'vitest';
import {
  OPERATOR_GROUP_LABELS,
  groupOperatorRows,
} from '../../src/features/fieldSuggestions/operatorGroups';
import { fieldOperatorSource } from '../../src/features/fieldSuggestions/sources/operatorSource';
import type { OperatorSuggestion, Suggestion } from '../../src/features/fieldSuggestions/types';
import type { OperatorClass } from '../../src/features/fieldSuggestions/operators';

function op(name: string, cls: OperatorClass): OperatorSuggestion {
  return { kind: 'operator', name, class: cls, source: 'operators' };
}

describe('groupOperatorRows', () => {
  it('groups the real field-position list into its class runs, in registry order', async () => {
    const items = (await fieldOperatorSource({} as never)) as Suggestion[];
    const groups = groupOperatorRows(items);
    const names = (g: { start: number; end: number }) =>
      items.slice(g.start, g.end).map((s) => (s.kind === 'operator' ? s.name : '?'));

    expect(groups.slice(0, 6).map((g) => g.label)).toEqual([
      'Comparison',
      'Logical',
      'Element',
      'Evaluation',
      'Array',
      'Geospatial',
    ]);
    expect(names(groups[0]!)).toEqual(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);
    expect(names(groups[1]!)).toEqual(['$not']);
    expect(names(groups[2]!)).toEqual(['$exists', '$type']);
    expect(names(groups[5]!)).toEqual(['$geoWithin', '$geoIntersects', '$near', '$nearSphere']);
    // The runs tile the list: each starts where the previous one ended.
    groups.forEach((g, i) => {
      expect(g.start).toBe(i === 0 ? 0 : groups[i - 1]!.end);
    });
    expect(groups[groups.length - 1]!.end).toBe(items.length);
  });

  it('leaves no trailing Other group on the real field-position list', async () => {
    const items = (await fieldOperatorSource({} as never)) as Suggestion[];
    expect(groupOperatorRows(items).map((g) => g.label)).toEqual([
      'Comparison',
      'Logical',
      'Element',
      'Evaluation',
      'Array',
      'Geospatial',
    ]);
  });

  it('names a class without a dedicated label "Other"', () => {
    const groups = groupOperatorRows([op('$sum', 'accumulator'), op('$sum2', 'accumulator')]);
    expect(groups).toEqual([{ label: 'Other', start: 0, end: 2 }]);
  });

  it('starts a new group when the class changes back to an earlier one', () => {
    const groups = groupOperatorRows([
      op('$eq', 'query'),
      op('$not', 'logical'),
      op('$gt', 'query'),
    ]);
    expect(groups.map((g) => [g.label, g.start, g.end])).toEqual([
      ['Comparison', 0, 1],
      ['Logical', 1, 2],
      ['Comparison', 2, 3],
    ]);
  });

  it('leaves non-operator items ungrouped and ends the run at them', () => {
    const items: Suggestion[] = [
      op('$eq', 'query'),
      { kind: 'field', path: 'name', source: 'schema' },
      op('$ne', 'query'),
    ];
    expect(groupOperatorRows(items).map((g) => [g.start, g.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('returns no groups for an empty list', () => {
    expect(groupOperatorRows([])).toEqual([]);
  });

  it('maps each operator class to its header', () => {
    expect(OPERATOR_GROUP_LABELS).toEqual({
      query: 'Comparison',
      logical: 'Logical',
      element: 'Element',
      evaluation: 'Evaluation',
      array: 'Array',
      geo: 'Geospatial',
    });
  });
});
