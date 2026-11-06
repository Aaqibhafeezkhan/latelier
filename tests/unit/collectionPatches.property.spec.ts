import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { columnResizePatch, rowExpandPatch, schemaPatch } from '../../src/pages/Workspace/collectionPatches';
import { DEFAULT_SCHEMA_TAB_STATE } from '@shared/defaults';
import type { CollectionTabState } from '@shared/types';

// `columns`/`expandedRows` are name-keyed maps built from user-controlled
// field names / doc ids via plain `{}` objects and spread, same hazard class
// as navigatorTreeReducer.property.spec.ts's PROTO_MEMBER_NAMES. Included in
// the key generator rather than excluded, per CLAUDE.md's property-testing
// conventions.
const HOSTILE_KEYS = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];
const normalKey = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !HOSTILE_KEYS.includes(s));
const keyArb = fc.oneof({ arbitrary: normalKey, weight: 4 }, { arbitrary: fc.constantFrom(...HOSTILE_KEYS), weight: 1 });

const BASE: CollectionTabState = {
  view: 'Tree',
  builder: { projection: [], sort: '', limit: '' },
  queryRaw: '{}',
  page: 0,
  pageSize: 50,
  activeBuilderTab: 'Builder',
};

const widthArb = fc.integer({ min: 0, max: 2000 });
const columnsArb = fc.dictionary(keyArb, fc.record({ width: widthArb }), { maxKeys: 5 });

describe('columnResizePatch', () => {
  it('preserves every other field\'s width unchanged', () => {
    fc.assert(
      fc.property(columnsArb, keyArb, widthArb, (columns, field, width) => {
        const prev = { ...BASE, columns };
        const result = columnResizePatch(prev, field, width);
        expect(result.columns![field]).toEqual({ width });
        for (const k of Object.keys(columns)) {
          if (k === field) continue;
          expect(result.columns![k]).toEqual(columns[k]);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('applying the same resize twice is a content fixpoint', () => {
    fc.assert(
      fc.property(columnsArb, keyArb, widthArb, (columns, field, width) => {
        const prev = { ...BASE, columns };
        const once = { ...prev, ...columnResizePatch(prev, field, width) };
        const twice = { ...once, ...columnResizePatch(once, field, width) };
        expect(twice.columns).toEqual(once.columns);
      }),
      { numRuns: 40 },
    );
  });
});

const expandedRowsArb = fc.dictionary(keyArb, fc.boolean(), { maxKeys: 5 });

describe('rowExpandPatch', () => {
  it('preserves every other row id unchanged', () => {
    fc.assert(
      fc.property(expandedRowsArb, keyArb, fc.boolean(), (expandedRows, docId, expanded) => {
        const prev = { ...BASE, expandedRows };
        const result = rowExpandPatch(prev, docId, expanded);
        for (const k of Object.keys(expandedRows)) {
          if (k === docId) continue;
          expect(result.expandedRows![k]).toBe(expandedRows[k]);
        }
      }),
      { numRuns: 40 },
    );
  });

  // The invariant `collectionPatches.spec.ts` pins with one example: a
  // collapsed row is never left as a `false` key (the object is persisted
  // verbatim to `workspace_tabs.state_json`, so a stray key would grow it
  // without bound).
  //
  // Uses `hasOwnProperty`, not `in`: `in` walks the prototype chain, so for
  // a hostile `docId` it reads the inherited `Object.prototype` member
  // instead of checking whether `rowExpandPatch` actually created/removed
  // an own key. `keyArb`, not `normalKey` — `rowExpandPatch` now writes via
  // `ownSet` (always creates an own key, even for `docId === '__proto__'`)
  // so the hostile-inclusive generator is expected to hold.
  it('the target id is present in the result iff expanded is true', () => {
    fc.assert(
      fc.property(expandedRowsArb, keyArb, fc.boolean(), (expandedRows, docId, expanded) => {
        const prev = { ...BASE, expandedRows };
        const result = rowExpandPatch(prev, docId, expanded);
        expect(Object.prototype.hasOwnProperty.call(result.expandedRows!, docId)).toBe(expanded);
      }),
      { numRuns: 40 },
    );
  });

  it('applying the same expand/collapse twice is a fixpoint', () => {
    fc.assert(
      fc.property(expandedRowsArb, keyArb, fc.boolean(), (expandedRows, docId, expanded) => {
        const prev = { ...BASE, expandedRows };
        const once = { ...prev, ...rowExpandPatch(prev, docId, expanded) };
        const twice = { ...once, ...rowExpandPatch(once, docId, expanded) };
        expect(twice.expandedRows).toEqual(once.expandedRows);
      }),
      { numRuns: 40 },
    );
  });
});

// SchemaTabState's fields are fixed names (not user-controlled keys), so no
// hostile-key generator needed here — `entries` (an array of sample rows) is
// left out of the generator; the patch surface this module exercises is the
// scalar fields.
const schemaFieldsArb = fc.record(
  {
    sampleSize: fc.nat(),
    sampledCount: fc.nat(),
    sampledOf: fc.nat(),
    ranAt: fc.string({ maxLength: 10 }),
    durationMs: fc.nat(),
    errorMessage: fc.string({ maxLength: 10 }),
  },
  { requiredKeys: [] },
);

describe('schemaPatch', () => {
  // The valuable invariant: a patch never drops a key it doesn't
  // name. Two halves — patch fields win, untouched fields survive.
  it('every field present in the patch wins in the result', () => {
    fc.assert(
      fc.property(schemaFieldsArb, schemaFieldsArb, (prevFields, patch) => {
        const prev = { ...BASE, schema: { ...DEFAULT_SCHEMA_TAB_STATE, ...prevFields } };
        const result = schemaPatch(prev, patch);
        for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
          expect(result.schema![k]).toEqual(patch[k]);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('every field absent from the patch is preserved from prev.schema', () => {
    fc.assert(
      fc.property(schemaFieldsArb, schemaFieldsArb, (prevFields, patch) => {
        const prevSchema = { ...DEFAULT_SCHEMA_TAB_STATE, ...prevFields };
        const prev = { ...BASE, schema: prevSchema };
        const result = schemaPatch(prev, patch);
        for (const k of Object.keys(prevSchema) as (keyof typeof prevSchema)[]) {
          if (k in patch) continue;
          expect(result.schema![k]).toEqual(prevSchema[k]);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('applying the same patch twice is a fixpoint', () => {
    fc.assert(
      fc.property(schemaFieldsArb, schemaFieldsArb, (prevFields, patch) => {
        const prev = { ...BASE, schema: { ...DEFAULT_SCHEMA_TAB_STATE, ...prevFields } };
        const once = { ...prev, ...schemaPatch(prev, patch) };
        const twice = { ...once, ...schemaPatch(once, patch) };
        expect(twice.schema).toEqual(once.schema);
      }),
      { numRuns: 40 },
    );
  });
});
