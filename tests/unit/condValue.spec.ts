import { describe, it, expect, afterAll } from 'vitest';
import {
  DATE_PRESETS,
  datePresetValue,
  localInputToIso,
  isoToLocalInput,
  chipsFromValue,
  chipText,
  parseChipText,
  valueFromChips,
  condTypeWarning,
} from '../../src/pages/Workspace/condValue';
import { summarizeSchema } from '../../src/pages/Workspace/schemaSummary';
import { coerceArrayElementWire } from '../../src/pages/Workspace/filterTree';
import type { CondNode, ValType } from '@shared/types';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('date presets', () => {
  it('lists every preset under the label the menu shows', () => {
    expect(DATE_PRESETS).toEqual([
      { id: 'now', label: 'Now' },
      { id: 'startOfToday', label: 'Start of today' },
      { id: '7d', label: '7 days ago' },
      { id: '30d', label: '30 days ago' },
      { id: 'startOfMonth', label: 'Start of this month' },
    ]);
  });

  it('counts 7 and 30 days back from now to the millisecond', () => {
    expect(datePresetValue('7d', NOW)).toBe('2026-10-08T12:00:00.000Z');
    expect(datePresetValue('30d', NOW)).toBe('2026-09-15T12:00:00.000Z');
  });

  it('puts the day and month boundaries at local midnight', () => {
    const y = NOW.getFullYear();
    const m = NOW.getMonth();
    expect(datePresetValue('startOfToday', NOW)).toBe(new Date(y, m, NOW.getDate()).toISOString());
    expect(datePresetValue('startOfMonth', NOW)).toBe(new Date(y, m, 1).toISOString());
  });

  it('gives now as itself', () => {
    expect(datePresetValue('now', NOW)).toBe(NOW.toISOString());
  });
});

// Expected local times are built with the `Date(y, m, d, h, min)`
// constructor, not by parsing the same text the code under test parses.
// Assigning `process.env.TZ` mid-run can't pin a zone here: Stryker's runner
// ignores it (its dry run read local time in the host zone after the
// assignment), so these assertions hold in whatever zone the run is in.
describe('datetime-local conversion', () => {
  it('reads the input as local time', () => {
    expect(localInputToIso('2026-10-15T09:30')).toBe(new Date(2026, 9, 15, 9, 30).toISOString());
    expect(localInputToIso('2026-01-05T23:59')).toBe(new Date(2026, 0, 5, 23, 59).toISOString());
  });

  it('gives "" for text that is not a date', () => {
    expect(localInputToIso('x')).toBe('');
    expect(localInputToIso('')).toBe('');
    expect(isoToLocalInput('bad')).toBe('');
    expect(isoToLocalInput('')).toBe('');
  });

  it('writes local minutes, zero-padded, dropping seconds and milliseconds', () => {
    expect(isoToLocalInput(new Date(2026, 0, 5, 7, 3, 59, 999).toISOString())).toBe('2026-01-05T07:03');
    expect(isoToLocalInput(new Date(2026, 10, 9, 17, 45).toISOString())).toBe('2026-11-09T17:45');
  });
});

// The DST example needs a zone that has one. Where assigning TZ takes effect
// (vitest's own runner) this runs in New York; where it doesn't and the host
// isn't there either, the block is skipped rather than asserting on a zone
// it isn't in.
const savedTz = process.env.TZ;
process.env.TZ = 'America/New_York';
const inNewYork =
  new Date('2026-11-01T05:30:00.000Z').getHours() === 1 && new Date('2026-11-01T06:30:00.000Z').getHours() === 1;
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe.runIf(inNewYork)('datetime-local conversion across a DST fall-back hour (New York)', () => {
  // 2026-11-01 01:30 happens twice in New York: 05:30Z (EDT), then 06:30Z
  // (EST). The input's text can't say which, and reading it back picks the
  // first, so a value in the second hour moves an hour earlier once edited.
  it('reads the repeated 01:30 as the first one', () => {
    expect(isoToLocalInput('2026-11-01T06:30:00.000Z')).toBe('2026-11-01T01:30');
    expect(isoToLocalInput('2026-11-01T05:30:00.000Z')).toBe('2026-11-01T01:30');
    expect(localInputToIso('2026-11-01T01:30')).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('chips', () => {
  it('reads a JSON array of primitives', () => {
    expect(chipsFromValue('["a",1,true,null]', 'array')).toEqual(['a', 1, true, null]);
    expect(chipsFromValue('  ', 'array')).toEqual([]);
    expect(chipsFromValue('', 'array')).toEqual([]);
  });

  it('refuses anything a chip cannot show', () => {
    expect(chipsFromValue('[{"$oid":"0123456789abcdef01234567"}]', 'array')).toBeNull();
    expect(chipsFromValue('[[1]]', 'array')).toBeNull();
    expect(chipsFromValue('garbage', 'array')).toBeNull();
    expect(chipsFromValue('{}', 'array')).toBeNull();
    expect(chipsFromValue('"a"', 'array')).toBeNull();
  });

  it('a text row shows a list as chips only when every item is text', () => {
    // A bare chip in a text row reads back as text: an ObjectId row's 1 would
    // go out as {"$oid":"1"} after the next edit, a date row's as {"$date":"1"}.
    for (const vt of ['string', 'objectid', 'long', 'decimal', 'date'] as const) {
      expect(chipsFromValue('["a",1]', vt)).toBeNull();
      expect(chipsFromValue('[null]', vt)).toBeNull();
      expect(chipsFromValue('[true]', vt)).toBeNull();
      expect(chipsFromValue('["a","1"]', vt)).toEqual(['a', '1']);
    }
    expect(chipsFromValue('["a",1,true,null]', 'number')).toEqual(['a', 1, true, null]);
  });

  it('keeps an integer past 2^53 out of chips, where it would be rounded', () => {
    expect(chipsFromValue('[9007199254740993]', 'array')).toBeNull();
    expect(chipsFromValue('[9007199254740991, 1.5]', 'array')).toEqual([9007199254740991, 1.5]);
  });

  it('reads typed chip text as the value it looks like', () => {
    expect(parseChipText('42', 'array')).toBe(42);
    expect(parseChipText('-1.5', 'array')).toBe(-1.5);
    expect(parseChipText('.5', 'array')).toBe(0.5);
    expect(parseChipText('.55', 'array')).toBe(0.55);
    expect(parseChipText('1e3', 'array')).toBe(1000);
    expect(parseChipText('2.E-2', 'array')).toBe(0.02);
    expect(parseChipText('true', 'array')).toBe(true);
    expect(parseChipText('false', 'array')).toBe(false);
    expect(parseChipText('null', 'array')).toBeNull();
    expect(parseChipText('"42"', 'array')).toBe('42');
    expect(parseChipText(' a ', 'array')).toBe('a');
    expect(parseChipText('abc', 'array')).toBe('abc');
    expect(parseChipText('1.2.3', 'array')).toBe('1.2.3');
    expect(parseChipText('x42', 'array')).toBe('x42');
    expect(parseChipText('42x', 'array')).toBe('42x');
    expect(parseChipText('"a', 'array')).toBe('"a');
    expect(parseChipText('"\\"', 'array')).toBe('"\\"');
    expect(parseChipText('1e999', 'array')).toBe('1e999');
    // Text `Number()` would read but a person means as text.
    expect(parseChipText('', 'array')).toBe('');
    expect(parseChipText('0x10', 'array')).toBe('0x10');
    expect(parseChipText('0b1', 'array')).toBe('0b1');
    expect(parseChipText('+5', 'array')).toBe('+5');
    expect(parseChipText('1e', 'array')).toBe('1e');
    expect(parseChipText('-', 'array')).toBe('-');
    expect(parseChipText('.', 'array')).toBe('.');
    // JSON that isn't a string literal stays text.
    expect(parseChipText('[1]', 'array')).toBe('[1]');
    expect(parseChipText('{"a":1}', 'array')).toBe('{"a":1}');
  });

  it('quotes a string chip only when its plain text would read as something else', () => {
    expect(chipText('abc', 'array')).toBe('abc');
    expect(chipText('42', 'array')).toBe('"42"');
    expect(chipText('true', 'array')).toBe('"true"');
    expect(chipText(' a', 'array')).toBe('" a"');
    expect(chipText(42, 'array')).toBe('42');
    expect(chipText(false, 'array')).toBe('false');
    expect(chipText(null, 'array')).toBe('null');
  });

  it('keeps a chip as text in a row whose type wraps text, so no digit is lost', () => {
    const wire = (text: string, vt: ValType) => coerceArrayElementWire(parseChipText(text, vt), vt);
    expect(wire('007', 'string')).toBe('007');
    expect(wire('1.0', 'string')).toBe('1.0');
    expect(wire('true', 'string')).toBe('true');
    expect(wire(' "a b" ', 'string')).toBe('a b');
    expect(wire('9007199254740993', 'long')).toEqual({ $numberLong: '9007199254740993' });
    expect(wire('123456789012345678901234', 'objectid')).toEqual({ $oid: '123456789012345678901234' });
    expect(wire('1.10', 'decimal')).toEqual({ $numberDecimal: '1.10' });
    expect(wire('2026', 'date')).toEqual({ $date: '2026' });
  });

  it('reads numbers and literals in a row whose type does not wrap text', () => {
    expect(parseChipText('007', 'number')).toBe(7);
    expect(parseChipText('true', 'boolean')).toBe(true);
    expect(parseChipText('null', 'array')).toBeNull();
    expect(parseChipText('"42"', 'number')).toBe('42');
  });

  it('labels a chip so it reads back the same in its row', () => {
    expect(chipText('42', 'string')).toBe('42');
    expect(chipText('"q"', 'string')).toBe('"\\"q\\""');
    expect(chipText(' a', 'objectid')).toBe('" a"');
    expect(chipText(7, 'string')).toBe('7');
  });

  it('writes chips back as a JSON array', () => {
    expect(valueFromChips(['a', 1])).toBe('["a",1]');
    expect(valueFromChips([])).toBe('[]');
  });
});

describe('condTypeWarning', () => {
  const entries = new Map(
    summarizeSchema(Array(10).fill({ status: 'a', n: 1, tags: ['x'], mixed: 1 }).concat(
      Array(2).fill({ mixed: 'b' }),
    )).map((e) => [e.path, e]),
  );
  const cond = (field: string, op: string, valType: ValType, value = ''): CondNode => ({
    kind: 'cond',
    field,
    op,
    valType,
    value,
  });

  it('warns when the value type disagrees with what the sample holds', () => {
    expect(condTypeWarning(entries, cond('status', '$eq', 'number', '5'))).toEqual({
      field: 'status',
      expectedType: 'string',
      actualType: 'number',
      percent: 100,
    });
    for (const [vt, actual] of [
      ['long', 'long'],
      ['decimal', 'decimal'],
      ['boolean', 'boolean'],
      ['date', 'date'],
      ['objectid', 'objectid'],
    ] as const) {
      expect(condTypeWarning(entries, cond('status', '$gt', vt))?.actualType).toBe(actual);
    }
    expect(condTypeWarning(entries, cond('n', '$lte', 'string', 'x'))?.expectedType).toBe('number');
  });

  it('is silent when the value type agrees', () => {
    expect(condTypeWarning(entries, cond('status', '$eq', 'string', 'a'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$ne', 'string'))).toBeNull();
  });

  it('treats number, long and decimal as one family', () => {
    expect(condTypeWarning(entries, cond('n', '$eq', 'long', '1'))).toBeNull();
    expect(condTypeWarning(entries, cond('n', '$eq', 'decimal', '1'))).toBeNull();
  });

  it('checks a list by its first non-null element, as it is sent', () => {
    expect(condTypeWarning(entries, cond('status', '$in', 'array', '[null,1,2]'))?.actualType).toBe('number');
    expect(condTypeWarning(entries, cond('status', '$nin', 'array', '[1]'))?.actualType).toBe('number');
    expect(condTypeWarning(entries, cond('status', '$in', 'array', '["a"]'))).toBeNull();
    // A string-typed list sends every element as a string.
    expect(condTypeWarning(entries, cond('status', '$in', 'string', '[1,2]'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$in', 'array', '[]'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$in', 'array', '[null]'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$in', 'array', 'oops'))).toBeNull();
  });

  it('stays silent where a type comparison means nothing', () => {
    // An array field matches its elements, so the field's own type says nothing.
    expect(condTypeWarning(entries, cond('tags', '$eq', 'string', 'x'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$exists', 'string', 'true'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$type', 'string', 'number'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$regex', 'regex', 'a'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$all', 'array', '[1]'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$eq', 'null'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$eq', 'regex', 'a'))).toBeNull();
    expect(condTypeWarning(entries, cond('status', '$eq', 'array', '[1]'))).toBeNull();
    expect(condTypeWarning(entries, cond('nope', '$eq', 'number', '1'))).toBeNull();
    expect(condTypeWarning(entries, cond('', '$eq', 'number', '1'))).toBeNull();
    expect(condTypeWarning(entries, cond('  ', '$eq', 'number', '1'))).toBeNull();
    // A field the sample shows as mixed has no type to disagree with.
    expect(condTypeWarning(entries, cond('mixed', '$eq', 'boolean', 'true'))).toBeNull();
  });

  it('is silent for a blank field even when the sample has an empty-named field', () => {
    // A blank field is a pending row, never printed, so nothing to warn about.
    const withEmptyKey = new Map(summarizeSchema(Array(3).fill({ '': 'a' })).map((e) => [e.path, e]));
    expect(withEmptyKey.has('')).toBe(true);
    expect(condTypeWarning(withEmptyKey, cond('', '$eq', 'number', '1'))).toBeNull();
  });

  it('looks the field up by its trimmed name', () => {
    expect(condTypeWarning(entries, cond(' status ', '$eq', 'number', '5'))?.field).toBe('status');
  });
});
