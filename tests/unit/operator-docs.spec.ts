import { describe, it, expect } from 'vitest';
import {
  OPERATORS,
  CLASS_COLOR,
  classColor,
  findOperatorDocs,
  type OperatorClass,
} from '../../src/features/fieldSuggestions/operators';

const RICH_CLASSES: readonly OperatorClass[] = [
  'stage',
  'query',
  'logical',
  'element',
  'evaluation',
  'array',
  'geo',
  'accumulator',
  'update',
];

const RICH_EXPRESSIONS = new Set([
  '$cond',
  '$ifNull',
  '$switch',
  '$let',
  '$concat',
  '$substr',
  '$toLower',
  '$toUpper',
  '$split',
  '$trim',
  '$add',
  '$subtract',
  '$multiply',
  '$divide',
  '$round',
  '$dateToString',
  '$dateFromString',
  '$dateAdd',
  '$dateDiff',
  '$map',
  '$filter',
  '$reduce',
  '$size',
  '$toString',
  '$toInt',
]);

describe('operator catalog content', () => {
  it('every rich-class operator has description + syntax + example + url', () => {
    const missing: string[] = [];
    for (const op of OPERATORS) {
      if (!RICH_CLASSES.includes(op.class)) continue;
      if (!op.description || !op.syntax || !op.example || !op.url) {
        missing.push(`${op.name} (${op.class})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every operator with a description also has syntax, example, and url', () => {
    const broken: string[] = [];
    for (const op of OPERATORS) {
      if (!op.description) continue;
      if (!op.syntax || !op.example || !op.url) {
        broken.push(`${op.name} (${op.class})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every URL starts with https://www.mongodb.com/docs/', () => {
    const bad: string[] = [];
    for (const op of OPERATORS) {
      if (!op.url) continue;
      if (!op.url.startsWith('https://www.mongodb.com/docs/')) {
        bad.push(`${op.name}: ${op.url}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every syntax string contains the operator name', () => {
    const bad: string[] = [];
    for (const op of OPERATORS) {
      if (!op.syntax) continue;
      if (!op.syntax.includes(op.name)) {
        bad.push(`${op.name} (${op.class}): ${op.syntax}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every expression operator has at least a summary', () => {
    const missing: string[] = [];
    for (const op of OPERATORS) {
      if (op.class !== 'expression') continue;
      if (!op.summary) missing.push(op.name);
    }
    expect(missing).toEqual([]);
  });

  it('the 25 listed expression ops have rich content', () => {
    const missing: string[] = [];
    for (const name of RICH_EXPRESSIONS) {
      const op = OPERATORS.find((o) => o.name === name && o.class === 'expression');
      if (!op) {
        missing.push(`${name}: not in catalog`);
        continue;
      }
      if (!op.description || !op.syntax || !op.example || !op.url) {
        missing.push(`${name}: missing fields`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('findOperatorDocs', () => {
  it('prefers the class match when given prefClass', () => {
    const query = findOperatorDocs('$eq', 'query');
    expect(query?.class).toBe('query');
    const expr = findOperatorDocs('$eq', 'expression');
    expect(expr?.class).toBe('expression');
  });

  it('returns a description-bearing entry when no class matches', () => {
    // $eq without prefClass — should resolve to something with a description.
    const any = findOperatorDocs('$eq');
    expect(any).not.toBeNull();
    expect(any?.description).toBeTruthy();
  });

  it('returns null for unknown operators', () => {
    expect(findOperatorDocs('$nope')).toBeNull();
  });

  it('disambiguates $set across stage and update classes', () => {
    const stageSet = findOperatorDocs('$set', 'stage');
    const updateSet = findOperatorDocs('$set', 'update');
    expect(stageSet?.class).toBe('stage');
    expect(updateSet?.class).toBe('update');
    expect(stageSet?.description).not.toBe(updateSet?.description);
  });
});

describe('classColor', () => {
  it('returns the base palette for light mode', () => {
    for (const cls of Object.keys(CLASS_COLOR) as OperatorClass[]) {
      const light = classColor(cls, false);
      expect(light.bg).toMatch(/0\.15/);
    }
  });

  it('brightens the bg alpha for dark mode', () => {
    for (const cls of Object.keys(CLASS_COLOR) as OperatorClass[]) {
      const dark = classColor(cls, true);
      expect(dark.bg).toMatch(/0\.25/);
    }
  });

  it('keeps the light ink in light mode and lightens it for dark mode', () => {
    for (const cls of Object.keys(CLASS_COLOR) as OperatorClass[]) {
      expect(classColor(cls, false).text).toBe(CLASS_COLOR[cls].text);
      expect(classColor(cls, true).text).toBe(`color-mix(in srgb, ${CLASS_COLOR[cls].text} 40%, white)`);
    }
  });
});
