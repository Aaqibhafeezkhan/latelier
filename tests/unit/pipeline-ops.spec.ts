import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PipelineState, Stage } from '@shared/types';
import {
  DEFAULT_BODIES,
  KNOWN_STAGE_OPS,
  OP_COLOR,
  STAGE_OP_INFO,
  addStage,
  duplicateStage,
  formatBody,
  isKnownOp,
  isWriteStage,
  moveStage,
  nextStageId,
  removeStage,
  restoreStage,
  setBody,
  setOp,
  stageSig,
  stageSummary,
  stagesToPipelineJson,
  toggleEnabled,
  validatePipeline,
  validateStageBody,
} from '../../src/pages/Workspace/Aggregation/pipeline';
import { OPERATORS } from '../../src/features/fieldSuggestions/operators';

const NAMED_COMMON_STAGES = [
  '$facet', '$bucket', '$sample', '$graphLookup',
  '$unionWith', '$setWindowFields', '$geoNear', '$documents',
] as const;

const emptyState = { stages: [] as Stage[], activeStageId: null };

describe('pipeline ops', () => {
  it('addStage appends with unique id and activates it', () => {
    const s1 = addStage(emptyState, '$match');
    const s2 = addStage(s1, '$group');
    expect(s2.stages).toHaveLength(2);
    expect(new Set(s2.stages.map((s) => s.id)).size).toBe(2);
    expect(s2.activeStageId).toBe(s2.stages[1]!.id);
  });

  it('addStage defaults an unrecognized op to an empty-object body', () => {
    const s = addStage(emptyState, '$totallyUnknownOp');
    expect(s.stages[0]!.body).toBe('{}');
  });

  it('addStage positions by afterIndex', () => {
    const s1 = addStage(emptyState, '$match');
    const s2 = addStage(s1, '$sort');
    const s3 = addStage(s2, '$limit', 0);
    expect(s3.stages.map((s) => s.op)).toEqual(['$match', '$limit', '$sort']);
  });

  it('removeStage drops by id and clears active if matching', () => {
    const s1 = addStage(emptyState, '$match');
    const id = s1.stages[0]!.id;
    const s2 = removeStage(s1, id);
    expect(s2.stages).toHaveLength(0);
    expect(s2.activeStageId).toBeNull();
  });

  // docs/adr/0013 — restoreStage undoes a single removeStage.
  describe('restoreStage', () => {
    it('reinserts the stage at its index and activates it', () => {
      let s = addStage(emptyState, '$match');
      s = addStage(s, '$sort');
      s = addStage(s, '$limit');
      const removed = s.stages[1]!; // $sort
      const afterRemove = removeStage(s, removed.id);

      const restored = restoreStage(afterRemove, removed, 1);
      expect(restored.stages.map((st) => st.op)).toEqual(['$match', '$sort', '$limit']);
      expect(restored.activeStageId).toBe(removed.id);
    });

    /**
     * MUTATION TARGET — drop the `Math.min(index, stages.length)` clamp and
     * this throws (or silently misplaces) instead of landing at the end.
     */
    it('clamps the index to the current pipeline length', () => {
      const s = addStage(emptyState, '$match');
      const removed: Stage = { id: 99, op: '$sort', body: '{}', enabled: true };
      const restored = restoreStage(s, removed, 50);
      expect(restored.stages.map((st) => st.op)).toEqual(['$match', '$sort']);
    });

    /**
     * MUTATION TARGET — drop the `idTaken` check and this produces two
     * stages sharing id 1, silently breaking the accordion's `key`.
     */
    it('gives the restored stage a fresh id if the old one has been reused since', () => {
      let s = addStage(emptyState, '$match'); // id 1
      const removedMatch = s.stages[0]!;
      s = removeStage(s, removedMatch.id);
      s = addStage(s, '$sort'); // reuses id 1 via nextStageId

      const restored = restoreStage(s, removedMatch, 0);
      const ids = restored.stages.map((st) => st.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(restored.activeStageId).toBe(restored.stages[0]!.id);
      // the stage's own shape (op/body/enabled) must survive the id reassignment
      expect(restored.stages[0]!.op).toBe('$match');
      expect(restored.stages[0]!.enabled).toBe(true);
    });

    // MUTATION TARGET — `.some(...)` swapped for `.every(...)` is only
    // observable when `state.stages` is empty: `.every` is vacuously true on
    // an empty array (wrongly marking the id "taken"), while `.some` is
    // correctly false (nothing to collide with).
    it('does not reassign the id when restoring into an empty pipeline', () => {
      const removed: Stage = { id: 7, op: '$match', body: '{}', enabled: true };
      const restored = restoreStage(emptyState, removed, 0);
      expect(restored.stages[0]!.id).toBe(7);
      expect(restored.activeStageId).toBe(7);
    });
  });

  it('moveStage reorders', () => {
    let s = addStage(emptyState, '$match');
    s = addStage(s, '$sort');
    s = addStage(s, '$limit');
    const r = moveStage(s, 0, 2);
    expect(r.stages.map((x) => x.op)).toEqual(['$sort', '$limit', '$match']);
  });

  it('moveStage returns same state when out of bounds', () => {
    const s1 = addStage(emptyState, '$match');
    expect(moveStage(s1, 0, 5)).toEqual(s1);
    expect(moveStage(s1, -1, 0)).toEqual(s1);
  });

  // MUTATION TARGET — dropping the `from === to` early return still produces
  // the same stage order (splice out then back in at the same spot), but it
  // loses referential stability. Callers (React state) rely on getting the
  // exact same object back for a no-op move.
  it('moveStage returns the identical state object when from === to', () => {
    let s = addStage(emptyState, '$match');
    s = addStage(s, '$sort');
    expect(moveStage(s, 1, 1)).toBe(s);
  });

  describe('moveStage bounds checking (3-stage pipeline)', () => {
    const three = () => {
      let s = addStage(emptyState, '$match');
      s = addStage(s, '$sort');
      s = addStage(s, '$limit');
      return s;
    };

    it('rejects an out-of-range from (=== length)', () => {
      const s = three();
      expect(moveStage(s, 3, 0)).toEqual(s);
    });

    it('rejects a negative from, even with a valid to, without corrupting order', () => {
      const s = three();
      expect(moveStage(s, -1, 1).stages.map((x) => x.op)).toEqual(s.stages.map((x) => x.op));
    });

    it('rejects an out-of-range to (=== length)', () => {
      const s = three();
      expect(moveStage(s, 0, 3)).toEqual(s);
    });

    it('rejects a negative to, even with a valid from, without corrupting order', () => {
      const s = three();
      // from=0, to=-1: a broken `to < 0` check would let this through and,
      // because splice(-1, ...) is a valid (from-the-end) insertion point,
      // produce a plausible-looking but wrong reorder. Use an asymmetric
      // move (remove the first stage) so the wrong path is observable.
      expect(moveStage(s, 0, -1).stages.map((x) => x.op)).toEqual(s.stages.map((x) => x.op));
    });

    it('accepts to === 0 (moving the last stage to the front)', () => {
      const s = three();
      const r = moveStage(s, 2, 0);
      expect(r.stages.map((x) => x.op)).toEqual(['$limit', '$match', '$sort']);
    });
  });

  it('setBody updates only the target stage', () => {
    const s = addStage(emptyState, '$match');
    const id = s.stages[0]!.id;
    const r = setBody(s, id, '{"posted":true}');
    expect(r.stages[0]!.body).toBe('{"posted":true}');
  });

  // MUTATION TARGET — the map's `s.id === id` ternary forced to always true
  // would overwrite every stage's body, not just the target's.
  it('setBody leaves other stages untouched', () => {
    let s = addStage(emptyState, '$match');
    s = addStage(s, '$sort');
    const [first, second] = s.stages;
    const r = setBody(s, second!.id, '{"z":1}');
    expect(r.stages[0]!.body).toBe(first!.body);
    expect(r.stages[1]!.body).toBe('{"z":1}');
  });

  it('toggleEnabled flips enabled', () => {
    const s = addStage(emptyState, '$match');
    const id = s.stages[0]!.id;
    const r = toggleEnabled(s, id);
    expect(r.stages[0]!.enabled).toBe(false);
    expect(toggleEnabled(r, id).stages[0]!.enabled).toBe(true);
  });

  // MUTATION TARGET — same ternary-forced-true risk as setBody, for enabled.
  it('toggleEnabled leaves other stages untouched', () => {
    let s = addStage(emptyState, '$match');
    s = addStage(s, '$sort');
    const [first, second] = s.stages;
    const r = toggleEnabled(s, second!.id);
    expect(r.stages[0]!.enabled).toBe(first!.enabled);
    expect(r.stages[1]!.enabled).toBe(false);
  });

  it('duplicateStage inserts a copy with a new id right after', () => {
    const s = addStage(emptyState, '$match');
    const id = s.stages[0]!.id;
    const r = duplicateStage(s, id);
    expect(r.stages).toHaveLength(2);
    expect(r.stages[0]!.id).toBe(id);
    expect(r.stages[1]!.id).not.toBe(id);
    expect(r.stages[1]!.op).toBe('$match');
    expect(r.activeStageId).toBe(r.stages[1]!.id);
  });

  // MUTATION TARGET — the `findIndex` predicate forced to always true would
  // duplicate stage[0] regardless of which id was requested.
  it('duplicateStage duplicates the requested stage, not just the first one', () => {
    let s = addStage(emptyState, '$match');
    s = addStage(s, '$sort');
    const target = s.stages[1]!; // $sort
    const r = duplicateStage(s, target.id);
    expect(r.stages.map((x) => x.op)).toEqual(['$match', '$sort', '$sort']);
    expect(r.stages[2]!.id).not.toBe(target.id);
  });

  it('duplicateStage is a no-op when the id is missing', () => {
    const s = addStage(emptyState, '$match');
    expect(duplicateStage(s, 999999)).toEqual(s);
  });

  it('nextStageId is strictly increasing', () => {
    const s = addStage(emptyState, '$match');
    expect(nextStageId(s.stages)).toBe(s.stages[0]!.id + 1);
  });

  // MUTATION TARGET — a ternary of `s.id > m ? s.id : m` forced to always pick
  // `s.id` would return the *last* stage's id instead of the max.
  it('nextStageId picks the max id, not the last one seen', () => {
    const stages: Stage[] = [
      { id: 5, op: '$match', body: '{}', enabled: true },
      { id: 2, op: '$sort', body: '{}', enabled: true },
    ];
    expect(nextStageId(stages)).toBe(6);
  });

  it('isWriteStage detects $out and $merge only', () => {
    expect(isWriteStage('$out')).toBe(true);
    expect(isWriteStage('$merge')).toBe(true);
    expect(isWriteStage('$match')).toBe(false);
  });

  it('isKnownOp is true for a curated op and false for an unknown one', () => {
    expect(isKnownOp('$match')).toBe(true);
    expect(isKnownOp('$notARealOp')).toBe(false);
  });

  it('removeStage leaves activeStageId untouched when the removed id does not match it', () => {
    let s = addStage(emptyState, '$match');
    s = addStage(s, '$sort');
    const [first, second] = s.stages;
    // active is the second stage; remove the first
    expect(s.activeStageId).toBe(second!.id);
    const r = removeStage(s, first!.id);
    expect(r.activeStageId).toBe(second!.id);
  });
});

describe('setOp (T2.1)', () => {
  it('preserves a user-edited body when changing op', () => {
    const s = addStage(emptyState, '$match');
    const id = s.stages[0]!.id;
    const edited = setBody(s, id, '{ "custom": true }');
    const r = setOp(edited, id, '$group');
    expect(r.stages[0]!.op).toBe('$group');
    expect(r.stages[0]!.body).toBe('{ "custom": true }');
  });

  it('swaps body to the new default when the prior body was empty', () => {
    const s = addStage(emptyState, '$match');
    const id = s.stages[0]!.id;
    const emptied = setBody(s, id, '   ');
    const r = setOp(emptied, id, '$sort');
    expect(r.stages[0]!.op).toBe('$sort');
    expect(r.stages[0]!.body).toBe(DEFAULT_BODIES['$sort']);
  });

  it('swaps body to the new default when the prior body equalled the prior op default', () => {
    const s = addStage(emptyState, '$match'); // body === DEFAULT_BODIES['$match']
    const id = s.stages[0]!.id;
    const r = setOp(s, id, '$sort');
    expect(r.stages[0]!.op).toBe('$sort');
    expect(r.stages[0]!.body).toBe(DEFAULT_BODIES['$sort']);
  });

  it('supports a custom string op', () => {
    const s = addStage(emptyState, '$match');
    const id = s.stages[0]!.id;
    const r = setOp(s, id, '$myCustomStage');
    expect(r.stages[0]!.op).toBe('$myCustomStage');
    // the unedited body equalled the $match default, so it swaps; a custom op
    // has no DEFAULT_BODIES entry, so the '{}' fallback must kick in.
    expect(r.stages[0]!.body).toBe('{}');
  });

  it('is a no-op when the id is missing (stage identity preserved)', () => {
    const s = addStage(emptyState, '$match');
    const r = setOp(s, 999999, '$sort');
    expect(r).toEqual(s);
  });

  // MUTATION TARGET — the map's `i === idx` ternary forced to always true
  // would rewrite every stage's op/body, not just the target index's.
  it('changes only the targeted stage, leaving others untouched', () => {
    let s = addStage(emptyState, '$match');
    s = addStage(s, '$sort');
    const [first, second] = s.stages;
    const r = setOp(s, second!.id, '$limit');
    expect(r.stages[0]!.op).toBe(first!.op);
    expect(r.stages[0]!.body).toBe(first!.body);
    expect(r.stages[1]!.op).toBe('$limit');
  });
});

describe('expanded curated stage set (T2.1)', () => {
  it('KNOWN_STAGE_OPS includes all 8 named common stages', () => {
    for (const op of NAMED_COMMON_STAGES) {
      expect(KNOWN_STAGE_OPS).toContain(op);
    }
  });

  it('every named common stage has a DEFAULT_BODIES entry', () => {
    for (const op of NAMED_COMMON_STAGES) {
      expect(DEFAULT_BODIES[op]).toBeTruthy();
    }
  });
});

describe('stageSig (T2.1 — AC6)', () => {
  it('differs when op differs with body constant', () => {
    const a: Stage = { id: 1, op: '$match', body: '{}', enabled: true };
    const b: Stage = { id: 1, op: '$sort', body: '{}', enabled: true };
    expect(stageSig(a)).not.toBe(stageSig(b));
  });

  it('differs when body differs with op constant', () => {
    const a: Stage = { id: 1, op: '$match', body: '{}', enabled: true };
    const b: Stage = { id: 1, op: '$match', body: '{ "x": 1 }', enabled: true };
    expect(stageSig(a)).not.toBe(stageSig(b));
  });

  it('is stable for identical op+body', () => {
    const a: Stage = { id: 1, op: '$match', body: '{}', enabled: true };
    const b: Stage = { id: 2, op: '$match', body: '{}', enabled: true };
    expect(stageSig(a)).toBe(stageSig(b));
  });
});

describe('validatePipeline', () => {
  it('fails when no enabled stages', () => {
    const v = validatePipeline([]);
    expect(v.ok).toBe(false);
    // exact shape of the synthetic error — MUTATION TARGET for the id/reason literals
    expect(v.errors).toEqual([{ id: -1, reason: 'no enabled stages' }]);
  });

  // MUTATION TARGET — dropping the `stages.filter((s) => s.enabled)` filter
  // would count a non-empty-but-all-disabled pipeline as having enabled stages.
  it('fails when every stage is present but disabled', () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{}', enabled: false },
    ];
    const v = validatePipeline(stages);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([{ id: -1, reason: 'no enabled stages' }]);
  });

  it('accepts valid EJSON bodies', () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{}', enabled: true },
      { id: 2, op: '$limit', body: '10', enabled: true },
    ];
    const v = validatePipeline(stages);
    expect(v.ok).toBe(true);
    // MUTATION TARGET — `!isKnownOp(s.op)` forced to always true would warn on
    // every known op too.
    expect(v.warnings).toEqual([]);
  });

  it('rejects invalid EJSON', () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{ bogus ', enabled: true },
    ];
    const v = validatePipeline(stages);
    expect(v.ok).toBe(false);
    expect(v.errors[0]!.id).toBe(1);
  });

  // MUTATION TARGET — `if (!s.enabled) continue;` forced to never skip would
  // validate a disabled stage's (invalid) body and wrongly block the pipeline.
  it('ignores a disabled stage with an invalid body', () => {
    const stages: Stage[] = [
      { id: 1, op: '$match', body: '{ bogus ', enabled: false },
      { id: 2, op: '$limit', body: '10', enabled: true },
    ];
    expect(validatePipeline(stages).ok).toBe(true);
  });

  it('warns on unknown op without blocking', () => {
    const stages: Stage[] = [
      { id: 1, op: '$fakeOp', body: '{}', enabled: true },
    ];
    const v = validatePipeline(stages);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([{ id: 1, reason: 'unknown op: $fakeOp' }]);
  });
});

/**
 * X14 §4 (T4) — this pays off the app's disagreement with
 * itself: the templates the app writes and the help the stage picker shows are
 * written in the dialect its own validator used to refuse.
 */
describe('validateStageBody — Shell Syntax (X14 §4)', () => {
  const body = (op: string, text: string): Stage => ({ id: 1, op, body: text, enabled: true });

  it('accepts the shipped $group template, unedited', () => {
    // The exact string `addStage('$group')` writes into a new stage.
    expect(DEFAULT_BODIES['$group']).toBe('{\n  _id: "$field",\n  count: { $sum: 1 }\n}');
    expect(validateStageBody(body('$group', DEFAULT_BODIES['$group']!))).toBeNull();
  });

  it.each(Object.keys(DEFAULT_BODIES))('accepts the shipped %s template, unedited', (op) => {
    expect(validateStageBody(body(op, DEFAULT_BODIES[op]!))).toBeNull();
  });

  // The stage picker renders `OperatorDocPanel`, whose `example` block is the
  // built-in help. Every one of them must validate as written.
  const stagePickerExamples = OPERATORS.filter(
    (op) => (KNOWN_STAGE_OPS as readonly string[]).includes(op.name) && op.example,
  ).map((op) => [op.name, op.example!] as const);

  it('the stage picker shows help for every known stage op', () => {
    expect(new Set(stagePickerExamples.map(([name]) => name)).size).toBe(KNOWN_STAGE_OPS.length);
  });

  it.each(stagePickerExamples)('accepts the %s stage-picker help example', (op, example) => {
    expect(validateStageBody(body(op, example))).toBeNull();
  });

  // `$count`, `$unwind`, `$limit`, `$skip`, `$unset`, `$redact` and `$out` take
  // a primitive body and are judged by their own branch. No shipped template
  // exercises it — every primitive default is already strict JSON — so these
  // hand-written cases are the only cover that branch has.
  it('accepts a single-quoted $count body (the primitive-body branch)', () => {
    expect(validateStageBody(body('$count', "'totalCount'"))).toBeNull();
  });

  it('accepts a single-quoted $unwind body (the primitive-body branch)', () => {
    expect(validateStageBody(body('$unwind', "'$arrayField'"))).toBeNull();
  });

  it('accepts a mongosh ObjectId in a $match body', () => {
    expect(
      validateStageBody(body('$match', '{ _id: ObjectId("507f1f77bcf86cd799439011") }')),
    ).toBeNull();
  });

  // X14 §5 — still refused, and now the refusal says why and where.
  // The reason is the transform's own, verbatim; only the `Line L, column C`
  // prefix is added here. An earlier fix stripped acorn's own trailing `(1:7)` from the
  // reason, so this message carries one position rather than two disagreeing
  // by one — asserted whole, because a `toContain` would not have caught the
  // second one.
  it('still refuses text no repair can rescue, and reports the transform reason', () => {
    expect(validateStageBody(body('$match', '{ bogus '))).toBe(
      'Line 1, column 8: Unexpected token',
    );
    expect(validateStageBody(body('$match', '{ name: /^acme/gi }'))).toBe(
      'Line 1, column 9: The regular expression flag "g" (global) has no MongoDB equivalent. Remove it.',
    );
    expect(validateStageBody(body('$match', '{ a: b }'))).toContain('"b" is a bare word');
    expect(validateStageBody(body('$count', "'a' + 'b'"))).toContain(
      'arithmetic or comparison expression',
    );
    expect(validateStageBody(body('$match', '   '))).toBe('body is empty');
  });

  // A stage body is multi-line and hand-indented, which is the whole reason
  // §5 asks for a location: a typo forty lines down is not findable by eye.
  it('locates the refusal by line and column inside a multi-line body', () => {
    const multiline = '{\n  "a": 1,\n  "b": { c }\n}';
    expect(validateStageBody(body('$match', multiline))).toMatch(/^Line 3, column 10: /);
  });

  // The repair runs in front of the EJSON check, never instead of it: a body
  // that is well-formed JSON but not well-formed BSON comes back `unchanged`
  // from the transform and must still be refused.
  //
  // These two must NOT move with the block above. "the transform could
  // not read this" and "this is well-formed JSON but not well-formed BSON" are
  // different faults with different fixes; if both sets changed together, a
  // shared message had collapsed them.
  it('still refuses a malformed sentinel that parses as JSON', () => {
    expect(validateStageBody(body('$match', '{ "_id": { "$oid": "nothex" } }'))).toBe('invalid EJSON');
    expect(validateStageBody(body('$match', '{ _id: { $oid: "nothex" } }'))).toBe('invalid EJSON');
  });
});

describe('stageSummary', () => {
  it('summarizes $match by first key, with a count of the rest', () => {
    expect(
      stageSummary({ id: 1, op: '$match', body: '{ "posted": true, "a": 1 }', enabled: true }),
    ).toBe('posted: … (+1)');
  });

  it('summarizes a single-key $match with no "+N" suffix', () => {
    expect(
      stageSummary({ id: 1, op: '$match', body: '{ "a": 1 }', enabled: true }),
    ).toBe('a: …');
  });

  it('reports an empty $match distinctly', () => {
    expect(stageSummary({ id: 1, op: '$match', body: '{}', enabled: true })).toBe('(empty match)');
  });

  // MUTATION TARGET — the `stage.op === '$match' && ... && typeof parsed ===
  // 'object'` guard forced to always pass would crash or misbehave on a
  // non-object parse result (a bare number here).
  it('falls back to the raw body when a $match body parses to a non-object', () => {
    expect(stageSummary({ id: 1, op: '$match', body: '5', enabled: true })).toBe('5');
  });

  it('counts $group metrics, excluding _id', () => {
    const summary = stageSummary({
      id: 1,
      op: '$group',
      body: '{ "_id": "$x", "count": { "$sum": 1 }, "avg": { "$avg": "$y" } }',
      enabled: true,
    });
    expect(summary).toBe('_id: …, metrics: 2');
  });

  // MUTATION TARGET — the `stage.op === '$group'` check forced to always pass
  // would treat any object-bodied stage as a $group and print "metrics: N".
  it('does not treat a non-$group stage as a $group, even with an object body', () => {
    const summary = stageSummary({
      id: 1,
      op: '$addFields',
      body: '{ "a": 1, "b": 2 }',
      enabled: true,
    });
    expect(summary).not.toContain('metrics');
  });

  // MUTATION TARGET — the `typeof parsed === 'object'` guard inside the
  // $group branch forced to always pass would crash (or misbehave) on a
  // non-object parse result, since the code below assumes `parsed` is a
  // record.
  it('falls back to the raw body when a $group body parses to a non-object', () => {
    expect(stageSummary({ id: 1, op: '$group', body: '5', enabled: true })).toBe('5');
  });

  // MUTATION TARGET — narrowing the ISODate/ObjectId regexes from `[^)]*` to
  // `[^)]` (exactly one char) leaves multi-char call arguments un-neutralized,
  // so JSON.parse throws and the summary falls back to firstLine key-matching
  // instead of the $match branch. A second key makes the two paths produce
  // different strings: the $match branch appends "(+1)", the firstLine
  // fallback never does.
  it('neutralizes a multi-character ISODate(...) call before parsing', () => {
    expect(
      stageSummary({
        id: 1,
        op: '$match',
        body: '{ "when": ISODate("2020-01-01"), "extra": 1 }',
        enabled: true,
      }),
    ).toBe('when: … (+1)');
  });

  it('neutralizes a multi-character ObjectId(...) call before parsing', () => {
    expect(
      stageSummary({
        id: 1,
        op: '$match',
        body: '{ "_id": ObjectId("507f1f77bcf86cd799439011"), "extra": 1 }',
        enabled: true,
      }),
    ).toBe('_id: … (+1)');
  });

  // MUTATION TARGET — dropping `.trim()` on `stage.body` would treat a
  // whitespace-only body as non-empty and fall through to JSON.parse instead
  // of returning `stage.op` directly.
  it('treats a whitespace-only body as empty', () => {
    expect(stageSummary({ id: 1, op: '$match', body: '   ', enabled: true })).toBe('$match');
  });

  describe('firstLine fallback (unparseable, non-EJSON bodies)', () => {
    // MUTATION TARGET — dropping `.split('\n')[0]` would feed the whole
    // multi-line body (not just its first line) into the key regex/length
    // check below.
    it('uses only the first line of a multi-line unparseable body', () => {
      expect(
        stageSummary({ id: 1, op: '$match', body: 'not json\nkey: value', enabled: true }),
      ).toBe('not json');
    });

    // MUTATION TARGET — a body with no `key:` shape and no match: kills the
    // `if (match)` boundary and its literal-string mutants.
    it('returns the trimmed first line verbatim when it has no key: shape', () => {
      expect(
        stageSummary({ id: 1, op: '$match', body: '  no colon in here  ', enabled: true }),
      ).toBe('no colon in here');
    });

    // MUTATION TARGET — dropping the inner `.trim()` on the first line is
    // invisible for a single-line body, because stageSummary already trims
    // `stage.body` as a whole before this point. A trailing space *inside*
    // the first line of a multi-line body survives the outer trim and can
    // only be removed by the inner one.
    it('trims trailing whitespace on the first line of a multi-line body', () => {
      expect(
        stageSummary({ id: 1, op: '$match', body: 'stuff   \nkey: value', enabled: true }),
      ).toBe('stuff');
    });

    // MUTATION TARGET — kills the `firstLine.length > 40` boundary and the
    // 40/slice/'…' literals.
    it('truncates a long, unmatched first line to 40 chars plus an ellipsis', () => {
      const long = 'a'.repeat(50);
      expect(stageSummary({ id: 1, op: '$match', body: long, enabled: true })).toBe(
        `${'a'.repeat(40)}…`,
      );
    });

    // MUTATION TARGET — `firstLine.length > 40` swapped for `>= 40`: exactly
    // 40 chars must NOT be truncated.
    it('does not truncate a first line of exactly 40 characters', () => {
      const exact = 'a'.repeat(40);
      expect(stageSummary({ id: 1, op: '$match', body: exact, enabled: true })).toBe(exact);
    });

    // Exercises the key regex's success path on the fallback branch (not the
    // JSON.parse branch above) with a bare, unquoted, brace-less key — kills
    // the regex variants that require `{`, mandate/forbid `$`, or narrow the
    // whitespace/quote character classes.
    it('extracts a bare unquoted key from an unparseable body', () => {
      expect(
        stageSummary({ id: 1, op: '$match', body: 'field: 1', enabled: true }),
      ).toBe('field: …');
    });

    it('extracts a $-prefixed key from an unparseable body', () => {
      expect(
        stageSummary({ id: 1, op: '$match', body: '$dollarKey: 1', enabled: true }),
      ).toBe('$dollarKey: …');
    });

    it('extracts a braced, quoted key from an unparseable body', () => {
      expect(
        stageSummary({ id: 1, op: '$match', body: '{ "field": (unparseable', enabled: true }),
      ).toBe('field: …');
    });

    // MUTATION TARGET — dropping the `^` anchor lets `.match()` find the key
    // pattern anywhere in the string, not just at the start.
    it('does not match a key: shape that is not at the start of the line', () => {
      const body = '???field: 1';
      expect(stageSummary({ id: 1, op: '$match', body, enabled: true })).toBe(body);
    });

    // MUTATION TARGET — the `\s*` before the colon swapped for `\S*`: a real
    // space between the key and the colon must still match.
    it('allows whitespace between the key and the colon', () => {
      expect(
        stageSummary({ id: 1, op: '$match', body: 'field : 1', enabled: true }),
      ).toBe('field: …');
    });
  });
});

describe('formatBody', () => {
  it('pretty-prints valid JSON', () => {
    expect(formatBody('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('returns unparseable text unchanged', () => {
    expect(formatBody('{ not json')).toBe('{ not json');
  });

  // `JSON.stringify(JSON.parse(body))` writes 9007199254740993 as 9007199254740992.
  it('keeps an integer beyond 2^53 exact', () => {
    expect(formatBody('{"n": 9007199254740993}')).toBe('{\n  "n": 9007199254740993\n}');
  });

  it('keeps a negative integer beyond 2^53 exact', () => {
    expect(formatBody('{"n":-9007199254740993}')).toBe('{\n  "n": -9007199254740993\n}');
  });

  it('keeps an integer beyond 2^53 exact inside an array and a nested object', () => {
    expect(formatBody('{"$match":{"a":[1,9007199254740993],"b":{"c":9007199254740993}}}')).toBe(
      [
        '{',
        '  "$match": {',
        '    "a": [',
        '      1,',
        '      9007199254740993',
        '    ],',
        '    "b": {',
        '      "c": 9007199254740993',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('returns unparseable text that holds a big integer unchanged', () => {
    expect(formatBody('{ n: 9007199254740993 }')).toBe('{ n: 9007199254740993 }');
  });
});

describe('stage catalog completeness (colors, hints)', () => {
  it('KNOWN_STAGE_OPS is the full curated set, not empty', () => {
    expect(KNOWN_STAGE_OPS.length).toBeGreaterThanOrEqual(24);
    expect(KNOWN_STAGE_OPS).toContain('$match');
    expect(KNOWN_STAGE_OPS).toContain('$documents');
  });

  it('every KNOWN_STAGE_OPS entry has a real color and hint, not a fallback', () => {
    expect(KNOWN_STAGE_OPS.length).toBeGreaterThan(0);
    for (const op of KNOWN_STAGE_OPS) {
      const color = OP_COLOR[op];
      expect(color, `missing OP_COLOR for ${op}`).toBeDefined();
      expect(color!.bg).toMatch(/^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/);
      expect(color!.text).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(STAGE_OP_INFO[op]!.hint.length).toBeGreaterThan(0);
      expect(STAGE_OP_INFO[op]!.desc.length).toBeGreaterThan(0);
    }
  });
});

describe('pipeline invariants (fast-check)', () => {
  // `fc.constantFrom` throws if given zero values, so it's called fresh
  // inside each test rather than hoisted to describe-scope: a describe-level
  // call that throws aborts collection of the whole file before any test
  // runs, which a mutation-testing runner can fail to attribute to a kill.
  const opArb = () => fc.constantFrom(...KNOWN_STAGE_OPS);

  it('addStage then removeStage restores the original stage list', () => {
    fc.assert(
      fc.property(opArb(), (op) => {
        const added = addStage(emptyState, op);
        const restored = removeStage(added, added.stages[0]!.id);
        expect(restored.stages).toEqual(emptyState.stages);
      }),
    );
  });

  it('toggleEnabled applied twice is the identity', () => {
    fc.assert(
      fc.property(opArb(), (op) => {
        const s = addStage(emptyState, op);
        const id = s.stages[0]!.id;
        const twice = toggleEnabled(toggleEnabled(s, id), id);
        expect(twice.stages).toEqual(s.stages);
      }),
    );
  });

  it('moveStage is a permutation: same stages, same set of ids, valid indices preserved', () => {
    fc.assert(
      fc.property(
        fc.array(opArb(), { minLength: 1, maxLength: 8 }),
        fc.nat(),
        fc.nat(),
        (ops, rawFrom, rawTo) => {
          let s: PipelineState = emptyState;
          for (const op of ops) s = addStage(s, op);
          const from = rawFrom % s.stages.length;
          const to = rawTo % s.stages.length;
          const moved = moveStage(s, from, to);
          expect(moved.stages).toHaveLength(s.stages.length);
          expect(new Set(moved.stages.map((st) => st.id))).toEqual(new Set(s.stages.map((st) => st.id)));
        },
      ),
    );
  });
});

describe('stagesToPipelineJson', () => {
  const st = (id: number, op: string, body: string, enabled = true): Stage => ({ id, op, body, enabled });

  it('keeps the enabled stages in order and emits canonical EJSON', () => {
    const json = stagesToPipelineJson([
      st(1, '$match', '{"n": 1}'),
      st(2, '$limit', '5', false),
      st(3, '$sort', '{"at": {"$date": "2026-01-01T00:00:00Z"}}'),
      st(4, '$project', '{"n": 1.5}'),
    ]);
    expect(json).toBe(
      '[{"$match":{"n":{"$numberInt":"1"}}},' +
        '{"$sort":{"at":{"$date":{"$numberLong":"1767225600000"}}}},' +
        '{"$project":{"n":{"$numberDouble":"1.5"}}}]',
    );
  });

  it('gives an empty array when no stage is enabled', () => {
    expect(stagesToPipelineJson([st(1, '$match', '{}', false)])).toBe('[]');
  });

  it('throws naming the stage by its position, its operator and the parser reason', () => {
    const run = () => stagesToPipelineJson([st(4, '$match', '{}', false), st(7, '$group', '{ _id: ')]);
    expect(run).toThrow(/^stage 2 \(\$group\): invalid EJSON — \S/);
    let thrown: unknown;
    try {
      run();
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect((thrown as Error).message.endsWith((thrown as { cause: Error }).cause.message)).toBe(true);
  });

  it('skips a disabled stage even when its body would not parse', () => {
    expect(stagesToPipelineJson([st(1, '$match', '{ broken', false), st(2, '$limit', '3')])).toBe(
      '[{"$limit":{"$numberInt":"3"}}]',
    );
  });
});
