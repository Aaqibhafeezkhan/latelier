import { describe, it, expect } from 'vitest';
import type { Stage } from '@shared/types';
import {
  fieldValueEntriesFromFilter,
  fieldValueEntriesFromStages,
} from '../../src/features/fieldSuggestions/fieldValueEntries';

describe('fieldValueEntriesFromFilter', () => {
  it('records a plain equality as an $eq entry', () => {
    expect(fieldValueEntriesFromFilter('{"status":"shipped"}')).toEqual([
      { field: 'status', value: 'shipped', valType: 'string', op: '$eq' },
    ]);
  });

  it.each(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'])('records the %s operator', (op) => {
    expect(fieldValueEntriesFromFilter(`{"status":{"${op}":"a"}}`)).toEqual([
      { field: 'status', value: 'a', valType: 'string', op },
    ]);
  });

  it.each(['$in', '$nin'])('splits %s element-wise, typing each element on its own', (op) => {
    expect(fieldValueEntriesFromFilter(`{"tags":{"${op}":["x",null]}}`)).toEqual([
      { field: 'tags', value: 'x', valType: 'string', op },
      { field: 'tags', value: 'null', valType: 'null', op },
    ]);
  });

  it('types ObjectId elements of an $in from their EJSON shape', () => {
    const a = '507f1f77bcf86cd799439011';
    expect(fieldValueEntriesFromFilter(`{"t":{"$in":[{"$oid":"${a}"}]}}`)).toEqual([
      { field: 't', value: a, valType: 'objectid', op: '$in' },
    ]);
  });

  it('drops a blank $in element', () => {
    expect(fieldValueEntriesFromFilter('{"tags":{"$in":["  ","ok"]}}')).toEqual([
      { field: 'tags', value: 'ok', valType: 'string', op: '$in' },
    ]);
  });

  it('skips an operator that is not recorded', () => {
    expect(fieldValueEntriesFromFilter('{"name":{"$regex":"^a"}}')).toEqual([]);
    expect(fieldValueEntriesFromFilter('{"name":{"$exists":true}}')).toEqual([]);
  });

  it('skips a blank value', () => {
    expect(fieldValueEntriesFromFilter('{"name":"  "}')).toEqual([]);
  });

  it('skips a blank field name', () => {
    expect(fieldValueEntriesFromFilter('{"  ":"x"}')).toEqual([]);
  });

  it('walks into $and / $or groups', () => {
    expect(
      fieldValueEntriesFromFilter('{"$or":[{"a":"x"},{"$and":[{"b":"y"}]}]}'),
    ).toEqual([
      { field: 'a', value: 'x', valType: 'string', op: '$eq' },
      { field: 'b', value: 'y', valType: 'string', op: '$eq' },
    ]);
  });

  it('records nothing for a condition the builder cannot model', () => {
    // A mixed-type $in parses to a raw node, which has no conditions to walk.
    expect(fieldValueEntriesFromFilter('{"t":{"$in":[{"a":1},"b"]}}')).toEqual([]);
  });

  it('returns [] for text that does not parse', () => {
    expect(fieldValueEntriesFromFilter('{status:')).toEqual([]);
  });
});

function stage(id: number, op: string, body: string, enabled = true): Stage {
  return { id, op, body, enabled };
}

describe('fieldValueEntriesFromStages', () => {
  it('records the leading $match stages', () => {
    expect(
      fieldValueEntriesFromStages([
        stage(1, '$match', '{"status":"a"}'),
        stage(2, '$match', '{"kind":"b"}'),
      ]),
    ).toEqual([
      { field: 'status', value: 'a', valType: 'string', op: '$eq' },
      { field: 'kind', value: 'b', valType: 'string', op: '$eq' },
    ]);
  });

  it('stops at the first enabled stage that is not $match', () => {
    expect(
      fieldValueEntriesFromStages([
        stage(1, '$match', '{"status":"a"}'),
        stage(2, '$group', '{"_id":"$status"}'),
        stage(3, '$match', '{"_id":"a"}'),
      ]),
    ).toEqual([{ field: 'status', value: 'a', valType: 'string', op: '$eq' }]);
  });

  it('records nothing when the pipeline does not open with $match', () => {
    expect(
      fieldValueEntriesFromStages([
        stage(1, '$limit', '10'),
        stage(2, '$match', '{"status":"a"}'),
      ]),
    ).toEqual([]);
  });

  it('skips disabled stages without ending the leading run', () => {
    expect(
      fieldValueEntriesFromStages([
        stage(1, '$match', '{"status":"off"}', false),
        stage(2, '$group', '{"_id":"$x"}', false),
        stage(3, '$match', '{"status":"on"}'),
      ]),
    ).toEqual([{ field: 'status', value: 'on', valType: 'string', op: '$eq' }]);
  });

  it('repairs a Shell Syntax body before reading it', () => {
    expect(fieldValueEntriesFromStages([stage(1, '$match', '{status: "a"}')])).toEqual([
      { field: 'status', value: 'a', valType: 'string', op: '$eq' },
    ]);
  });

  it('skips a body that cannot be repaired and keeps reading the next one', () => {
    expect(
      fieldValueEntriesFromStages([
        stage(1, '$match', '{status: '),
        stage(2, '$match', '{"kind":"b"}'),
      ]),
    ).toEqual([{ field: 'kind', value: 'b', valType: 'string', op: '$eq' }]);
  });

  it('splits an $in inside a $match stage element-wise', () => {
    expect(
      fieldValueEntriesFromStages([stage(1, '$match', '{tags: {$in: ["x", "y"]}}')]),
    ).toEqual([
      { field: 'tags', value: 'x', valType: 'string', op: '$in' },
      { field: 'tags', value: 'y', valType: 'string', op: '$in' },
    ]);
  });
});
