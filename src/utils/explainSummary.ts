import { isRecord } from './displayValue';

/**
 * Compact, defensive summary of a MongoDB explain plan — used to drive the
 * `ExplainDrawer` summary strip (winning-plan stage chain, index usage,
 * execution metrics). Always total: never throws, returns `null` when the
 * shape isn't recognized so callers can degrade to the full raw tree.
 *
 * Handles the shape variance across:
 * - find explains: `queryPlanner.winningPlan` (+ `executionStats` at verbosity
 *   `executionStats`/`allPlansExecution`).
 * - aggregation explains: `{ stages: [{ $cursor: { queryPlanner, executionStats } }] }`.
 * - sharded plans: `winningPlan.shards[]`, each carrying its own `winningPlan`.
 * - SBE / 5.1+ plans: `winningPlan.queryPlan` nests the classic stage tree.
 */
export interface ExplainSummary {
  /** Stage names from the winning plan root down to the innermost input stage. */
  stages: string[];
  usesIndex: boolean;
  collscan: boolean;
  indexName?: string;
  keyPattern?: unknown;
  nReturned?: number;
  docsExamined?: number;
  keysExamined?: number;
  executionTimeMillis?: number;
}

function nextStage(stage: Record<string, unknown>): unknown {
  if (isRecord(stage.inputStage)) return stage.inputStage;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: `> 0` vs `>= 0`/forced-`true` only differ when stage.inputStages is a real (Array.isArray) array of length 0 — and for any real array, arr[0] is always undefined at that length, so the `return stage.inputStages[0]` this guards is `undefined` either way this branch is reached or the `return undefined` below runs instead. Verified: both paths return the same value for an empty array.
  if (Array.isArray(stage.inputStages) && stage.inputStages.length > 0) {
    return stage.inputStages[0];
  }
  return undefined;
}

function collectStageChain(stage: unknown, acc: string[]): void {
  if (!isRecord(stage)) return;
  if (typeof stage.stage === 'string') acc.push(stage.stage);
  collectStageChain(nextStage(stage), acc);
}

function findIndexInfo(stage: unknown): { indexName?: string; keyPattern?: unknown } | null {
  if (!isRecord(stage)) return null;
  if (stage.stage === 'IXSCAN') {
    return {
      indexName: typeof stage.indexName === 'string' ? stage.indexName : undefined,
      keyPattern: stage.keyPattern,
    };
  }
  return findIndexInfo(nextStage(stage));
}

/** Follows the aggregation `{ stages: [{ $cursor }] }` wrapper down to the
 * find-shaped object (`{ queryPlanner, executionStats? }`) both the winning
 * plan and execution stats live on. Returns the find-shaped object as-is when
 * there's no aggregation wrapper. */
function unwrapCursorStage(plan: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(plan.stages)) return plan;
  const cursorStage = plan.stages.find(
    (s): s is Record<string, unknown> => isRecord(s) && isRecord(s.$cursor),
  );
  if (!cursorStage) return null;
  return isRecord(cursorStage.$cursor) ? cursorStage.$cursor : null;
}

function extractWinningPlan(inner: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(inner.queryPlanner)) return null;
  const rootPlan: unknown = inner.queryPlanner.winningPlan;
  if (!isRecord(rootPlan)) return null;

  // Sharded: winningPlan.shards[] each carry their own winningPlan.
  let winningPlan: Record<string, unknown> = rootPlan;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: the `Array.isArray(...)` conjunct here is real (unmutated) — for any of its `length > 0`/`length >= 0`/forced-`true` variants, the only case they can disagree with real behavior is a real, empty array, and for an empty array `winningPlan.shards[0]` is always `undefined`, which fails the `isRecord(shard0)` check right below regardless of whether this outer branch runs at all. Verified: entering this block on an empty array is a no-op.
  if (Array.isArray(winningPlan.shards) && winningPlan.shards.length > 0) {
    const shard0: unknown = winningPlan.shards[0];
    if (isRecord(shard0) && isRecord(shard0.winningPlan)) {
      winningPlan = shard0.winningPlan;
    }
  }

  // SBE / 5.1+: the classic stage tree lives under winningPlan.queryPlan.
  const nested: unknown = winningPlan.queryPlan;
  if (isRecord(nested)) {
    winningPlan = nested;
  }

  return winningPlan;
}

export function summarizeExplain(plan: unknown): ExplainSummary | null {
  if (!isRecord(plan)) return null;

  const inner = unwrapCursorStage(plan);
  if (!inner) return null;

  const winningPlan = extractWinningPlan(inner);
  // Stryker disable next-line ConditionalExpression: redundant with the `stages.length === 0` return below — collectStageChain(null, stages) leaves `stages` at its initial `[]` (isRecord(null) is false, so it returns immediately without pushing), so a null winningPlan reaches that later `return null` regardless of whether this guard runs. Verified by inspection of collectStageChain's own guard.
  if (!winningPlan) return null;

  const stages: string[] = [];
  collectStageChain(winningPlan, stages);
  if (stages.length === 0) return null;

  const collscan = stages.includes('COLLSCAN');
  const usesIndex = stages.includes('IXSCAN');
  const idx = findIndexInfo(winningPlan);

  const summary: ExplainSummary = { stages, usesIndex, collscan };
  if (idx?.indexName !== undefined) summary.indexName = idx.indexName;
  if (idx && 'keyPattern' in idx) summary.keyPattern = idx.keyPattern;

  const stats = inner.executionStats;
  if (isRecord(stats)) {
    if (typeof stats.nReturned === 'number') summary.nReturned = stats.nReturned;
    if (typeof stats.totalDocsExamined === 'number') summary.docsExamined = stats.totalDocsExamined;
    if (typeof stats.totalKeysExamined === 'number') summary.keysExamined = stats.totalKeysExamined;
    if (typeof stats.executionTimeMillis === 'number') {
      summary.executionTimeMillis = stats.executionTimeMillis;
    }
  }

  return summary;
}

/** One stage of a plan tree — what `PlanTree` renders a row from. */
export interface PlanNode {
  /** `SORT`, `FETCH`, `IXSCAN`, `COLLSCAN`, or an aggregation op like `$group`. */
  stage: string;
  indexName?: string;
  keyPattern?: unknown;
  nReturned?: number;
  docsExamined?: number;
  keysExamined?: number;
  /** From `executionTimeMillisEstimate`. */
  timeMs?: number;
  collscan: boolean;
  children: PlanNode[];
}

function numberField(from: Record<string, unknown>, key: string): number | undefined {
  const v = from[key];
  return typeof v === 'number' ? v : undefined;
}

function applyMetrics(node: PlanNode, from: Record<string, unknown>): void {
  const nReturned = numberField(from, 'nReturned');
  if (nReturned !== undefined) node.nReturned = nReturned;
  const timeMs = numberField(from, 'executionTimeMillisEstimate');
  if (timeMs !== undefined) node.timeMs = timeMs;
  const docsExamined = numberField(from, 'docsExamined');
  if (docsExamined !== undefined) node.docsExamined = docsExamined;
  const keysExamined = numberField(from, 'keysExamined');
  if (keysExamined !== undefined) node.keysExamined = keysExamined;
}

/** Child stages of one classic stage: `inputStage`, then every `inputStages`
 * element, then each shard's own plan. */
function childStages(stage: Record<string, unknown>): unknown[] {
  // `stageToNode` drops anything that is not a stage record, so the entries
  // are not pre-filtered here.
  const out: unknown[] = [stage.inputStage];
  if (Array.isArray(stage.inputStages)) out.push(...(stage.inputStages as unknown[]));
  if (Array.isArray(stage.shards)) {
    for (const shard of stage.shards as unknown[]) {
      if (!isRecord(shard)) continue;
      out.push(isRecord(shard.executionStages) ? shard.executionStages : shard.winningPlan);
    }
  }
  return out;
}

function stageToNode(raw: unknown): PlanNode | null {
  if (!isRecord(raw) || typeof raw.stage !== 'string') return null;
  const node: PlanNode = { stage: raw.stage, collscan: raw.stage === 'COLLSCAN', children: [] };
  if (typeof raw.indexName === 'string') node.indexName = raw.indexName;
  if (raw.keyPattern !== undefined) node.keyPattern = raw.keyPattern;
  applyMetrics(node, raw);
  for (const child of childStages(raw)) {
    const childNode = stageToNode(child);
    if (childNode) node.children.push(childNode);
  }
  return node;
}

/** Root stage of a find-shaped explain (`{ queryPlanner, executionStats? }`). */
function findRootStage(inner: Record<string, unknown>): unknown {
  if (!isRecord(inner.queryPlanner)) return undefined;
  const winning: unknown = inner.queryPlanner.winningPlan;
  if (!isRecord(winning)) return undefined;
  // ponytail: SBE (`winningPlan.queryPlan`) carries no per-stage counts —
  // `executionStages` there is the lowercase slot tree (`project`/`nlj`/
  // `ixseek`), which does not line up with the classic names. Upgrade path:
  // map slot-tree nodes onto classic ones by `planNodeId`.
  if (isRecord(winning.queryPlan)) return winning.queryPlan;
  const stats = inner.executionStats;
  if (isRecord(stats) && isRecord(stats.executionStages)) return stats.executionStages;
  return winning;
}

/**
 * Full stage tree of an explain plan, for the drawer's stage view. Total like
 * `summarizeExplain`: unrecognized input returns `null`, never throws.
 *
 * Per-stage figures exist only at `executionStats` verbosity and above; at
 * `queryPlanner` the tree has the same shape with every figure absent.
 */
export function buildPlanTree(plan: unknown): PlanNode | null {
  if (!isRecord(plan)) return null;
  const inner = unwrapCursorStage(plan);
  if (!inner) return null;
  const cursorNode = stageToNode(findRootStage(inner));
  if (!Array.isArray(plan.stages)) return cursorNode;
  if (!cursorNode) return null;

  const root: PlanNode = { stage: 'pipeline', collscan: false, children: [cursorNode] };
  const cursorAt = plan.stages.findIndex((s) => isRecord(s) && isRecord(s.$cursor));
  for (const entry of (plan.stages as unknown[]).slice(cursorAt + 1)) {
    if (!isRecord(entry)) continue;
    const op = Object.keys(entry).find((k) => k.startsWith('$'));
    if (op === undefined) continue;
    const node: PlanNode = { stage: op, collscan: false, children: [] };
    applyMetrics(node, entry);
    root.children.push(node);
  }
  return root;
}
