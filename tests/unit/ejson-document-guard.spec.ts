import { describe, expect, it } from 'vitest';
import { isEjsonDocument } from '../../src/utils/ejson';
import { parseEjsonDocument } from '../../electron/mongo/ejson';
import { sortProblem, classifySort } from '../../src/pages/Workspace/builder';
import { isRawProjection } from '../../src/pages/Workspace/projection';

/**
 * The document guard runs on both sides of the process boundary — `shared/` is
 * types-only, so the rule exists as two copies (`isEjsonDocument` in the
 * renderer, `parseEjsonDocument` in main). There is nothing else to catch it if
 * they drift.
 *
 * So the table below is the rule, and both sides are driven from it. A change
 * to one copy alone fails here rather than surviving to production as a
 * client/main disagreement — which is the failure mode W15 §3.1 exists to name.
 */
const CASES: ReadonlyArray<{ json: string; document: boolean; why: string }> = [
  // Ordinary documents.
  { json: '{}', document: true, why: 'empty document — Mongo\'s own "no sort"' },
  { json: '{"name":1}', document: true, why: 'inclusion projection' },
  { json: '{"createdAt":-1}', document: true, why: 'descending sort' },
  { json: '{"tags":{"$slice":5}}', document: true, why: 'operator document' },

  // Nested sentinels are ordinary and must keep working.
  {
    json: '{"createdAt":{"$date":"2026-01-01T00:00:00Z"}}',
    document: true,
    why: 'nested $date is a normal filter',
  },
  {
    json: '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}',
    document: true,
    why: 'nested $oid is the commonest filter there is',
  },
  {
    json: '{"total":{"$numberDecimal":"1.5"}}',
    document: true,
    why: 'nested $numberDecimal',
  },

  // Non-documents.
  { json: 'null', document: false, why: 'driver ignores a null sort and runs unsorted' },
  { json: '[1,2]', document: false, why: 'array' },
  { json: '42', document: false, why: 'scalar' },
  { json: '"abc"', document: false, why: 'string' },
  { json: 'true', document: false, why: 'boolean' },

  // Bare sentinels. Each revives to a BSON instance that passes a
  // `typeof === "object" && !Array.isArray` test.
  {
    json: '{"$oid":"507f1f77bcf86cd799439011"}',
    document: false,
    why: 'revives to ObjectId; as a filter it matches nothing, silently',
  },
  {
    json: '{"$date":"2026-01-01T00:00:00Z"}',
    document: false,
    why: 'revives to Date; as a sort it runs in insertion order, silently',
  },
  {
    json: '{"$numberDecimal":"1.5"}',
    document: false,
    why: 'revives to Decimal128',
  },
  { json: '{"$numberLong":"42"}', document: false, why: 'revives to Long' },
  {
    json: '{"$regularExpression":{"pattern":"a","options":"i"}}',
    document: false,
    why: 'revives to BSONRegExp',
  },
];

describe('the document guard agrees across the process boundary', () => {
  for (const { json, document, why } of CASES) {
    it(`${json} → ${document ? 'document' : 'refused'} (${why})`, () => {
      // Renderer.
      expect(isEjsonDocument(json)).toBe(document);

      // Main. Throws a ValidationError naming the field rather than returning
      // a boolean, so the shapes differ — the *verdict* is what must match.
      let mainAccepted = true;
      try {
        parseEjsonDocument(json, 'sort');
      } catch {
        mainAccepted = false;
      }
      expect(mainAccepted).toBe(document);
    });
  }
});

describe('the sort and projection gates inherit the rule', () => {
  const BARE_SENTINELS = [
    '{"$oid":"507f1f77bcf86cd799439011"}',
    '{"$date":"2026-01-01T00:00:00Z"}',
    '{"$numberDecimal":"1.5"}',
  ];

  for (const json of BARE_SENTINELS) {
    it(`refuses ${json} as a sort, naming it as a non-document`, () => {
      expect(sortProblem(json)).toBe('A sort must be a document, like { field: 1 }.');
    });

    it(`refuses ${json} as a raw projection`, () => {
      expect(isRawProjection(json)).toBe(false);
    });

    // The property `builder-compile.spec.ts` pins: `classifySort` is 'invalid'
    // exactly when `sortProblem` refuses. A bare sentinel is an object with no
    // enumerable keys, so it used not to even reach 'unrepresentable'
    // on its own — it classified as 'none', i.e. "no sort at all".
    it(`classifies ${json} as invalid, not as no-sort`, () => {
      expect(classifySort(json)).toBe('invalid');
    });
  }

  // The nested sentinel must be a direction the driver runs: a `$date` value
  // parses but makes the driver throw "Invalid sort direction".
  it('still accepts a sort whose value is a nested sentinel', () => {
    expect(sortProblem('{"createdAt":{"$numberInt":"-1"}}')).toBeNull();
  });
});
