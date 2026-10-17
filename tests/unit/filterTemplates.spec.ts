import { describe, it, expect } from 'vitest';
import { FILTER_TEMPLATES } from '../../src/pages/Workspace/filterTemplates';
import { printFilter, type GroupNode, type CondNode } from '../../src/pages/Workspace/filterTree';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function printed(cond: CondNode): string {
  const root: GroupNode = { kind: 'group', logic: '$and', children: [cond] };
  const out = printFilter(root);
  if (!out.ok) throw new Error(`template did not print: ${JSON.stringify(out.problems)}`);
  return out.json;
}

function template(id: string) {
  const t = FILTER_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`no template ${id}`);
  return t;
}

describe('filter templates', () => {
  it('offers four, each named for what it finds and the operator behind it', () => {
    expect(FILTER_TEMPLATES.map(({ id, label, operator }) => ({ id, label, operator }))).toEqual([
      { id: 'last7d', label: 'Last 7 days', operator: '$gte' },
      { id: 'notNull', label: 'Exists and is not null', operator: '$ne' },
      { id: 'containsCi', label: 'Contains text (any case)', operator: '$regex' },
      { id: 'inList', label: 'One of a list', operator: '$in' },
    ]);
  });

  it('builds every row with a blank field, so it waits for one before it reaches the filter', () => {
    for (const t of FILTER_TEMPLATES) {
      const cond = t.build(NOW);
      expect(cond.field).toBe('');
      expect(cond.op).toBe(t.operator);
      expect(printed(cond)).toBe('{}');
    }
  });

  it('prints the filter each one names once a field is filled in', () => {
    const withField = (id: string) => printed({ ...template(id).build(NOW), field: 'f' });
    expect(withField('last7d')).toBe('{"f":{"$gte":{"$date":"2026-10-08T12:00:00.000Z"}}}');
    expect(withField('notNull')).toBe('{"f":{"$ne":null}}');
    expect(withField('containsCi')).toBe('{"f":{"$regex":"(?i)"}}');
    expect(printed({ ...template('inList').build(NOW), field: 'f', value: '["a"]' })).toBe('{"f":{"$in":["a"]}}');
  });

  it('One of a list waits for its first value, since an empty $in matches nothing', () => {
    const root: GroupNode = { kind: 'group', logic: '$and', children: [{ ...template('inList').build(NOW), field: 'f' }] };
    expect(printFilter(root)).toEqual({ ok: false, problems: [{ path: [0], message: '$in needs at least one value' }] });
  });

  it('builds conditions whose type and value pick the right value editor', () => {
    expect(FILTER_TEMPLATES.map((t) => t.build(NOW))).toEqual([
      { kind: 'cond', field: '', op: '$gte', valType: 'date', value: '2026-10-08T12:00:00.000Z' },
      { kind: 'cond', field: '', op: '$ne', valType: 'null', value: '' },
      { kind: 'cond', field: '', op: '$regex', valType: 'string', value: '(?i)' },
      { kind: 'cond', field: '', op: '$in', valType: 'string', value: '[]' },
    ]);
  });
});
