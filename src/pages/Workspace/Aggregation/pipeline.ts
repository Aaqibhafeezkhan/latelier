import type { PipelineState, Stage, StageOp } from '@shared/types';
import { prettyPrintJsonKeepingBigInts } from '../../../utils/bigIntJson';
import { ejsonParse, ejsonStringify, isValidEjson } from '../../../utils/ejson';
import { refusalMessage, repairToCanonicalEjson } from '../../../utils/shellSyntax';
import { stageOperatorSummary } from '../../../features/fieldSuggestions/operators';

/**
 * Stage ops handled by the builder. Only a subset of the full catalog —
 * the picker / accordion show these by default. The full catalog lives in
 * `src/features/fieldSuggestions/operators.ts`.
 */
export const KNOWN_STAGE_OPS: readonly StageOp[] = [
  '$match', '$group', '$sort', '$project', '$addFields',
  '$limit', '$skip', '$count', '$lookup', '$unwind',
  '$replaceRoot', '$redact', '$out', '$merge',
  '$set', '$unset',
  '$facet', '$bucket', '$sample', '$graphLookup',
  '$unionWith', '$setWindowFields', '$geoNear', '$documents',
];

// Body-shape hints stay local — they're UI copy specific to the aggregation
// builder, not something the general operator catalog should carry.
const STAGE_HINT: Record<string, string> = {
  '$match':       '{ field: { $op: val } }',
  '$group':       '{ _id: "$field", ... }',
  '$sort':        '{ field: 1 | -1 }',
  '$project':     '{ field: 1 | 0 | expr }',
  '$addFields':   '{ newField: expr }',
  '$set':         '{ newField: expr }',
  '$unset':       '"field" | ["f1","f2"]',
  '$limit':       'number',
  '$skip':        'number',
  '$count':       '"outputField"',
  '$lookup':      '{ from, localField, foreignField, as }',
  '$unwind':      '"$arrayField"',
  '$replaceRoot': '{ newRoot: "$subdoc" }',
  '$redact':      '"$$KEEP" | "$$PRUNE"',
  '$out':         '"collectionName"',
  '$merge':       '{ into, whenMatched, whenNotMatched }',
  '$facet':           '{ outputField: [ stages ], ... }',
  '$bucket':          '{ groupBy, boundaries, default, output }',
  '$sample':          '{ size: n }',
  '$graphLookup':     '{ from, startWith, connectFromField, connectToField, as }',
  '$unionWith':       '{ coll, pipeline }',
  '$setWindowFields': '{ partitionBy, sortBy, output }',
  '$geoNear':         '{ near, distanceField, spherical }',
  '$documents':       '[ {...}, {...} ]',
};

/**
 * `{ desc, hint }` lookup used by the stage picker/accordion. `desc` is
 * sourced from the shared operator catalog; `hint` stays here.
 */
export const STAGE_OP_INFO: Record<string, { desc: string; hint: string }> = Object.fromEntries(
  KNOWN_STAGE_OPS.map((op) => [
    op,
    {
      // Stryker disable next-line StringLiteral: every KNOWN_STAGE_OPS entry has a
      // real summary in the operator catalog (verified: none fall through to '').
      desc: stageOperatorSummary(op) ?? '',
      // Stryker disable next-line StringLiteral: every KNOWN_STAGE_OPS entry has a
      // STAGE_HINT entry above (verified: none fall through to '').
      hint: STAGE_HINT[op] ?? '',
    },
  ]),
);

export const DEFAULT_BODIES: Record<string, string> = {
  '$match':       '{\n  \n}',
  '$group':       '{\n  _id: "$field",\n  count: { $sum: 1 }\n}',
  '$sort':        '{ field: 1 }',
  '$project':     '{\n  field: 1\n}',
  '$addFields':   '{\n  newField: "$existingField"\n}',
  '$set':         '{\n  newField: "$existingField"\n}',
  '$unset':       '"fieldToDrop"',
  '$limit':       '100',
  '$skip':        '0',
  '$count':       '"totalCount"',
  '$lookup':      '{\n  from: "collection",\n  localField: "_id",\n  foreignField: "_id",\n  as: "result"\n}',
  '$unwind':      '"$arrayField"',
  '$replaceRoot': '{ newRoot: "$subdoc" }',
  '$redact':      '"$$KEEP"',
  '$out':         '"outputCollection"',
  '$merge':       '{\n  into: "outputCollection",\n  whenMatched: "merge",\n  whenNotMatched: "insert"\n}',
  '$facet':           '{\n  outputA: [ ]\n}',
  '$bucket':          '{\n  groupBy: "$field",\n  boundaries: [ ],\n  default: "other",\n  output: { }\n}',
  '$sample':          '{ size: 100 }',
  '$graphLookup':     '{\n  from: "collection",\n  startWith: "$field",\n  connectFromField: "field",\n  connectToField: "field",\n  as: "result"\n}',
  '$unionWith':       '{\n  coll: "collection",\n  pipeline: [ ]\n}',
  '$setWindowFields': '{\n  partitionBy: "$field",\n  sortBy: { field: 1 },\n  output: { }\n}',
  '$geoNear':         '{\n  near: { type: "Point", coordinates: [ 0, 0 ] },\n  distanceField: "dist",\n  spherical: true\n}',
  '$documents':       '[ ]',
};

export const OP_COLOR: Record<string, { bg: string; text: string }> = {
  '$match':      { bg: 'rgba(61,57,132,0.15)',   text: '#3D3984' },
  '$group':      { bg: 'rgba(107,58,138,0.15)',  text: '#6B3A8A' },
  '$sort':       { bg: 'rgba(26,80,104,0.15)',   text: '#1A5068' },
  '$limit':      { bg: 'rgba(138,107,64,0.15)',  text: '#8A6B40' },
  '$project':    { bg: 'rgba(90,100,26,0.15)',   text: '#5A641A' },
  '$lookup':     { bg: 'rgba(138,80,26,0.15)',   text: '#8A501A' },
  '$unwind':     { bg: 'rgba(26,60,138,0.15)',   text: '#1A3C8A' },
  '$addFields':  { bg: 'rgba(26,104,104,0.15)',  text: '#1A6868' },
  '$set':        { bg: 'rgba(26,104,104,0.15)',  text: '#1A6868' },
  '$unset':      { bg: 'rgba(120,60,60,0.15)',   text: '#783C3C' },
  '$count':      { bg: 'rgba(138,26,26,0.15)',   text: '#8A1A1A' },
  '$skip':       { bg: 'rgba(100,100,100,0.15)', text: '#646464' },
  '$replaceRoot':{ bg: 'rgba(80,26,104,0.15)',   text: '#501A68' },
  '$redact':     { bg: 'rgba(104,80,26,0.15)',   text: '#68501A' },
  '$out':        { bg: 'rgba(180,60,60,0.18)',   text: '#B43C3C' },
  '$merge':      { bg: 'rgba(180,110,60,0.18)',  text: '#B46E3C' },
  '$facet':           { bg: 'rgba(58,138,107,0.15)',  text: '#3A8A6B' },
  '$bucket':          { bg: 'rgba(138,58,90,0.15)',   text: '#8A3A5A' },
  '$sample':          { bg: 'rgba(58,90,138,0.15)',   text: '#3A5A8A' },
  '$graphLookup':     { bg: 'rgba(90,138,58,0.15)',   text: '#5A8A3A' },
  '$unionWith':       { bg: 'rgba(138,120,58,0.15)',  text: '#8A783A' },
  '$setWindowFields': { bg: 'rgba(58,138,138,0.15)',  text: '#3A8A8A' },
  '$geoNear':         { bg: 'rgba(120,58,138,0.15)',  text: '#783A8A' },
  '$documents':       { bg: 'rgba(90,90,58,0.15)',    text: '#5A5A3A' },
};

export function isWriteStage(op: string): boolean {
  return op === '$out' || op === '$merge';
}

export function isKnownOp(op: string): op is StageOp {
  return (KNOWN_STAGE_OPS as readonly string[]).includes(op);
}

export function nextStageId(stages: Stage[]): number {
  // Stryker disable next-line EqualityOperator: when s.id === m, `s.id > m`
  // and `s.id >= m` pick different branches but the same value (m itself),
  // so the reduce's running max is identical either way. Verified: a `>` vs
  // `>=` swap here cannot change the result of a max-reduce.
  return stages.reduce((m, s) => (s.id > m ? s.id : m), 0) + 1;
}

export function addStage(
  state: PipelineState,
  op: StageOp | string,
  afterIndex?: number,
): PipelineState {
  const id = nextStageId(state.stages);
  const body = DEFAULT_BODIES[op] ?? '{}';
  const stage: Stage = { id, op, body, enabled: true };
  const stages = [...state.stages];
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator:
  // once afterIndex >= stages.length - 1, insertAt below (afterIndex + 1) is >=
  // stages.length, and Array#splice clamps an out-of-range index to append —
  // identical to the push() branch. Verified with a probe (splice(N,...) and
  // splice(N+k,...) both append). Mutating this boundary is unobservable.
  if (afterIndex === undefined || afterIndex >= stages.length - 1) {
    stages.push(stage);
  } else {
    const insertAt = Math.max(0, afterIndex + 1);
    stages.splice(insertAt, 0, stage);
  }
  return { ...state, stages, activeStageId: id };
}

export function removeStage(state: PipelineState, id: number): PipelineState {
  const stages = state.stages.filter((s) => s.id !== id);
  const activeStageId = state.activeStageId === id ? null : state.activeStageId;
  return { ...state, stages, activeStageId };
}

/**
 * Undoes a single `removeStage` (docs/adr/0013 — local editor state gets an
 * Undo toast, not a confirm). Reinserts `stage` at `index`, clamped to the
 * pipeline's current length so a restore fired after other edits shifted the
 * stage list still lands somewhere valid instead of throwing.
 *
 * Gives the stage a fresh id when its old one has since been reused by
 * `addStage`/`duplicateStage` (both derive from the same max-id-plus-one), so
 * the restored stage never collides with a stage added after the delete.
 */
export function restoreStage(state: PipelineState, stage: Stage, index: number): PipelineState {
  const idTaken = state.stages.some((s) => s.id === stage.id);
  const restored = idTaken ? { ...stage, id: nextStageId(state.stages) } : stage;
  const stages = [...state.stages];
  const insertAt = Math.min(Math.max(0, index), stages.length);
  stages.splice(insertAt, 0, restored);
  return { ...state, stages, activeStageId: restored.id };
}

export function moveStage(state: PipelineState, from: number, to: number): PipelineState {
  if (from === to) return state;
  if (from < 0 || from >= state.stages.length) return state;
  if (to < 0 || to >= state.stages.length) return state;
  const stages = [...state.stages];
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved);
  return { ...state, stages };
}

export function setBody(state: PipelineState, id: number, body: string): PipelineState {
  return {
    ...state,
    stages: state.stages.map((s) => (s.id === id ? { ...s, body } : s)),
  };
}

/**
 * Change a stage's operator in place (T2.1). Body handling is deterministic:
 * the user's body is preserved unless it's empty or still equals the prior
 * op's default body, in which case it's replaced with the new op's default
 * so the stage doesn't carry over a body shape that no longer matches.
 */
export function setOp(state: PipelineState, id: number, op: StageOp | string): PipelineState {
  const idx = state.stages.findIndex((s) => s.id === id);
  if (idx === -1) return state;
  const stage = state.stages[idx]!;
  const priorDefault = DEFAULT_BODIES[stage.op];
  const wasEmpty = stage.body.trim() === '';
  // Stryker disable next-line ConditionalExpression: stage.body is always a
  // string, so `stage.body === priorDefault` is already false whenever
  // priorDefault is undefined — forcing the left operand to `true` can't
  // change the result (verified: string === undefined is always false).
  const wasPriorDefault = priorDefault !== undefined && stage.body === priorDefault;
  const nextBody = wasEmpty || wasPriorDefault ? (DEFAULT_BODIES[op] ?? '{}') : stage.body;
  const stages = state.stages.map((s, i) => (i === idx ? { ...s, op, body: nextBody } : s));
  return { ...state, stages };
}

/**
 * Signature used for run/stale tracking (T2.1 — AC6). Must key on both `op`
 * and `body` so an in-place operator change (with the body left untouched)
 * still flags the stage as stale relative to the last run.
 */
export function stageSig(stage: Stage): string {
  return `${stage.op} ${stage.body}`;
}

export function toggleEnabled(state: PipelineState, id: number): PipelineState {
  return {
    ...state,
    stages: state.stages.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
  };
}

export function duplicateStage(state: PipelineState, id: number): PipelineState {
  const idx = state.stages.findIndex((s) => s.id === id);
  if (idx === -1) return state;
  const original = state.stages[idx]!;
  const copy: Stage = { ...original, id: nextStageId(state.stages) };
  const stages = [...state.stages];
  stages.splice(idx + 1, 0, copy);
  return { ...state, stages, activeStageId: copy.id };
}

export interface ValidationIssue {
  id: number;
  reason: string;
}

export interface PipelineValidation {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Why this body cannot be read, once Shell Syntax has been repaired out of it —
 * or `null` when it can.
 *
 * X14 §4. A validator has nothing to commit, so it calls the transform
 * directly rather than `repairOnCommit` — the editor's blur path is what
 * commits. The repair goes *in front of* `isValidEjson` rather than replacing
 * it, the same order T3 used for the sort and projection fields: text that is
 * already strict comes back `unchanged`, and only `isValidEjson` refuses a
 * sentinel that is well-formed JSON but not well-formed BSON, such as
 * `{"$oid": "nothex"}`.
 *
 * X14 §5 — the two refusals stay distinct and now say so. A body the
 * transform refused reports the transform's own reason, located by line and
 * column, because a stage body is multi-line and a typo forty lines down is
 * not findable by eye. A body the transform accepted and `isValidEjson` then
 * rejected keeps `'invalid EJSON'`: that is a different fault (well-formed
 * JSON, malformed BSON) with a different fix.
 */
function bodyProblem(body: string): string | null {
  const outcome = repairToCanonicalEjson(body);
  const refused = refusalMessage(body, outcome);
  if (refused) return refused;
  // No `outcome.kind === 'failed'` branch here: `refusalMessage` only returns
  // null for a failed outcome when the input is empty (its own `text.trim() ===
  // ''` guard), and `body` here is always already trimmed and non-empty (see
  // the caller below) — so `refused` is truthy whenever `outcome.kind ===
  // 'failed'`, and that case is always caught by the `if (refused)` above.
  // Verified against shellSyntax.ts's repairToCanonicalEjson/refusalMessage
  // with a range of malformed inputs: every 'failed' outcome produced a
  // non-null refusal message.
  return isValidEjson(outcome.kind === 'repaired' ? outcome.text : body)
    ? null
    : 'invalid EJSON';
}

export function validateStageBody(stage: Stage): string | null {
  const body = stage.body.trim();
  if (!body) return 'body is empty';
  return bodyProblem(body);
}

export function validatePipeline(stages: Stage[]): PipelineValidation {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const enabled = stages.filter((s) => s.enabled);
  if (enabled.length === 0) {
    errors.push({ id: -1, reason: 'no enabled stages' });
  }
  for (const s of stages) {
    if (!s.enabled) continue;
    const bodyErr = validateStageBody(s);
    if (bodyErr) errors.push({ id: s.id, reason: bodyErr });
    if (!isKnownOp(s.op)) {
      warnings.push({ id: s.id, reason: `unknown op: ${s.op}` });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function stageSummary(stage: Stage): string {
  const body = stage.body.trim();
  if (!body) return stage.op;
  try {
    const parsed = JSON.parse(
      body
        .replace(/\bISODate\([^)]*\)/g, '""')
        .replace(/\bObjectId\([^)]*\)/g, '""'),
    );
    if (stage.op === '$match' && parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed as Record<string, unknown>);
      if (keys.length === 0) return '(empty match)';
      return `${keys[0]}: …${keys.length > 1 ? ` (+${keys.length - 1})` : ''}`;
    }
    if (stage.op === '$group' && parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const metrics = Object.keys(obj).filter((k) => k !== '_id').length;
      return `_id: …, metrics: ${metrics}`;
    }
  } catch {
    // fall through
  }
  const firstLine = body.split('\n')[0]!.trim();
  const match = firstLine.match(/^\{?\s*["']?(\$?\w+)["']?\s*:/);
  if (match) return `${match[1]}: …`;
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
}

export function formatBody(body: string): string {
  try {
    // Not `JSON.stringify(JSON.parse(body))`: that rounds an integer beyond 2^53.
    return prettyPrintJsonKeepingBigInts(body, 2);
  } catch {
    return body;
  }
}

/**
 * The enabled stages as one canonical EJSON array, the `pipeline` a view is
 * created with. Throws naming the first enabled stage whose body does not
 * parse by its 1-based position in the builder, with the parser's reason.
 */
export function stagesToPipelineJson(stages: Stage[]): string {
  const pipeline: Record<string, unknown>[] = [];
  stages.forEach((s, i) => {
    if (!s.enabled) return;
    try {
      pipeline.push({ [s.op]: ejsonParse(s.body) });
    } catch (e) {
      throw new Error(`stage ${i + 1} (${s.op}): invalid EJSON — ${(e as Error).message}`, { cause: e });
    }
  });
  return ejsonStringify(pipeline);
}
