import React from 'react';
import type { IpcApi } from '@shared/ipc';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../helpers/render';
import { DarkCtx } from '../../src/ThemeContext';
import { AggregationTab } from '../../src/pages/Workspace/Aggregation/AggregationTab';
import { notifications } from '@mantine/notifications';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../../src/features/fieldSuggestions/sources/schemaEnumSource';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';
import type { AggregationTabState, AggStagePreview } from '@shared/types';

// Spied so each write path can be checked for dropping the cached enum suggestions.
vi.mock('../../src/features/fieldSuggestions/sources/schemaEnumSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/schemaEnumSource')>()),
  invalidateSchemaEnumCache: vi.fn(),
}));

// Mocked at the exact module AggregationTab imports; the rest stays real
// because the tab reaches the suggestion sources through their barrel.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));

/**
 * Unlike `renderTab` below (a static `state` prop + a noop `onPatch` spy —
 * fine for smoke tests), T2.1's stale/write-warning coverage needs
 * `onChangeOp` -> `onPatch` -> `setOp` to actually flow back into rendered
 * props, since the DOM only reflects `state.stages` as owned by this
 * wrapper's own `useState`.
 */
function renderStatefulTab(initial: AggregationTabState) {
  function StatefulTab() {
    const [state, setState] = React.useState<AggregationTabState>(initial);
    const onPatch = (patch: Partial<AggregationTabState>) =>
      setState((s) => ({ ...s, ...patch }));
    return (
      <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={state}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
      </DarkCtx.Provider>
    );
  }
  return render(<StatefulTab />);
}

function opTrigger(index = 1) {
  return screen.getByRole('button', {
    name: new RegExp(`Change operator for stage ${index}`),
  });
}

function optionFor(op: string) {
  const opt = screen.getAllByRole('option').find((el) => el.textContent?.startsWith(op));
  if (!opt) throw new Error(`no option found starting with ${op}`);
  return opt;
}

beforeEach(() => installAtelierMock());
afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderTab(state: AggregationTabState = DEFAULT_AGGREGATION_TAB_STATE) {
  const onPatch = vi.fn();
  const result = render(
    <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={state}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
    </DarkCtx.Provider>,
  );
  return { ...result, onPatch };
}

/**
 * P1-12 smoke coverage for AggregationTab. Verifies the component mounts
 * with empty + populated pipelines and renders the OutputPanel + StageAccordion
 * subtrees. Deeper interaction coverage lives in those components' own
 * spec files.
 */
describe('AggregationTab — smoke', () => {
  it('mounts with the default empty pipeline state', () => {
    const { container } = renderTab();
    expect(container.textContent).toContain('orders');
    expect(container.textContent).toContain('Pipeline output');
  });

  it('renders existing stages from state', () => {
    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [
        { id: 1, op: '$match', body: '{ status: "active" }', enabled: true },
        { id: 2, op: '$limit', body: '10', enabled: true },
      ],
    };
    const { container } = renderTab(state);
    expect(container.textContent).toContain('$match');
    expect(container.textContent).toContain('$limit');
  });

  /**
   * Regression guard for the ExplainDrawer prop-shape refactor (X-Ticket
   * 98 / T0.1): Aggregation's Explain flow must still call api.agg.explain
   * with stages/verbosity/cancelToken and surface writeStageOmitted, exactly
   * as before the drawer was generalized to accept an injected fetcher.
   */
  it('Explain still calls api.agg.explain with stages/verbosity/cancelToken', async () => {
    const explainSpy = vi.fn<IpcApi['agg']['explain']>(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
      verbosity: 'queryPlanner',
      writeStageOmitted: true,
    }));
    installAtelierMock({ agg: { explain: explainSpy, cancel: async () => undefined } });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    renderTab(state);

    const explainBtn = await screen.findByRole('button', { name: 'Explain' });
    fireEvent.click(explainBtn);

    await waitFor(() => {
      expect(explainSpy).toHaveBeenCalledTimes(1);
    });
    const args = explainSpy.mock.calls[0]?.[0];
    expect(args?.stages).toEqual(state.stages);
    expect(args?.verbosity).toBe('queryPlanner');
    expect(typeof args?.cancelToken).toBe('string');

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(dialog.textContent).toContain('Stages with write ops were omitted');
    });
  });

  // W16 Tier 4 acceptance: "a COLLSCAN explain for a find shows the action;
  // an aggregation explain does not". AggregationTab passes no
  // `onCreateIndex` to ExplainDrawer — only a find has a filter
  // `suggestIndex` can read — so the button must never render here, even on
  // a COLLSCAN with an otherwise-identical summary strip to the find case.
  it('a COLLSCAN explain shows no "Create an index for this query" action', async () => {
    const explainSpy = vi.fn<IpcApi['agg']['explain']>(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
      verbosity: 'queryPlanner',
      writeStageOmitted: false,
    }));
    installAtelierMock({ agg: { explain: explainSpy, cancel: async () => undefined } });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    renderTab(state);

    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }));

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => expect(dialog.textContent).toContain('COLLSCAN'));
    expect(screen.queryByTestId('explain-create-index')).toBeNull();
  });
});

/**
 * T2.1 — the stage op is now editable in place, which raises the primary
 * correctness risk: the run/stale signature used to be keyed on `body`
 * alone (AggregationTab.tsx:74,164), so an op-only change would silently
 * keep reading as "fresh". These tests drive a real op change through a
 * stateful onPatch to prove the fix (stageSig, keyed on op+body).
 */
describe('AggregationTab — editable stage operator (T2.1)', () => {
  it('AC6: changing a stage op after a run marks it stale even though its body is unchanged', async () => {
    const runSpy = vi.fn(async () => ({
      rows: [],
      durationMs: 5,
      stageCounts: { 1: 10 },
      stageSamples: { 1: [] },
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    const { container } = renderStatefulTab(state);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('10').length).toBeGreaterThan(0));

    // Freshly run: no stale marker yet.
    expect(container.querySelector('[title="Stale (edited since last run)"]')).toBeNull();

    // Change the op only — body is untouched.
    fireEvent.click(opTrigger());
    fireEvent.click(optionFor('$sort'));

    await waitFor(() => {
      expect(container.querySelector('[title="Stale (edited since last run)"]')).not.toBeNull();
    });
  });

  it('AC5: changing a stage op to $out shows the write-warning strip; changing away hides it', async () => {
    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    renderStatefulTab(state);

    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(opTrigger());
    fireEvent.click(optionFor('$out'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This stage writes to MongoDB');

    fireEvent.click(opTrigger());
    fireEvent.click(optionFor('$match'));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

/**
 * N0.4 — per-stage aggregation preview has no in-flight guard: firing
 * "Run to here" twice for the same stage in quick succession used to let
 * whichever `previewUpToStage` response landed LAST win, even if it was the
 * older (first) call resolving after the newer (second) one. This is a
 * SAME-STAGE race — a monotonic per-stage token must drop the stale
 * response. The cross-stage case (two different stages resolving
 * back-to-back) is a separate, pre-existing, out-of-scope issue.
 */
describe('AggregationTab — per-stage preview race guard (N0.4)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('drops a stale (older) preview response when a newer call for the same stage resolves first', async () => {
    const deferreds: ReturnType<typeof deferred<AggStagePreview>>[] = [];
    const previewSpy = vi.fn(() => {
      const d = deferred<AggStagePreview>();
      deferreds.push(d);
      return d.promise;
    });
    installAtelierMock({
      agg: { previewUpToStage: previewSpy, cancel: async () => undefined },
    });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
      activeStageId: 1,
    };
    renderStatefulTab(state);

    const runToHereBtn = await screen.findByRole('button', { name: 'Run to here' });

    // Fire "Run to here" twice for the SAME stage — tokens 1 and 2. Both
    // dispatches are wrapped in a single outer `act()` so React's automatic
    // batching defers the re-render (and thus the button's `disabled`
    // attribute) until after both clicks land — otherwise the in-flight
    // guard's own disabled-button UX would mask the underlying race this
    // test exists to catch (a real double-click can still beat a render).
    act(() => {
      fireEvent.click(runToHereBtn);
      fireEvent.click(runToHereBtn);
    });

    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2));

    const sampleA = [{ marker: 'STALE_TOKEN_1' }];
    const sampleB = [{ marker: 'FRESH_TOKEN_2' }];

    // Resolve the NEWER call (token 2) first...
    deferreds[1].resolve({ stageId: 1, count: 222, sample: sampleB });
    await waitFor(() => {
      expect(screen.getByText(/FRESH_TOKEN_2/)).toBeTruthy();
    });

    // ...then resolve the OLDER call (token 1). Without the token guard this
    // clobbers the freshly-committed newer preview with stale data.
    deferreds[0].resolve({ stageId: 1, count: 111, sample: sampleA });

    // Flush microtasks so a (buggy) unconditional commit would have applied.
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(/STALE_TOKEN_1/)).toBeNull();
    expect(screen.getByText(/FRESH_TOKEN_2/)).toBeTruthy();
  });
});

/**
 * X14 §4 — a stage the user never clicked into has never blurred,
 * so the editor's own repair never fired. `addStage` writes a Shell Syntax
 * template straight into state and the validator now passes it, which is
 * exactly how Run and Explain become enabled on text `ejsonParse` would refuse
 * in the main process. Deliberately no `fireEvent.blur` anywhere below.
 */
describe('AggregationTab — Shell Syntax on the button-less run paths (X14 §4)', () => {
  const SHELL_STAGES: AggregationTabState['stages'] = [
    { id: 1, op: '$group', body: '{\n  _id: "$field",\n  count: { $sum: 1 }\n}', enabled: true },
    { id: 2, op: '$sort', body: '{ field: 1 }', enabled: true },
  ];
  const CANONICAL = [
    '{\n  "_id": "$field",\n  "count": { "$sum": 1 }\n}',
    '{ "field": 1 }',
  ];

  it('Run repairs every stage body before it crosses IPC, with no editor blur', async () => {
    const runSpy = vi.fn<IpcApi['agg']['run']>(async () => ({
      rows: [],
      durationMs: 1,
      stageCounts: {},
      stageSamples: {},
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: SHELL_STAGES });

    const runBtn = screen.getByRole('button', { name: 'Run' });
    expect(runBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(runBtn);

    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
    expect(runSpy.mock.calls[0]![0].stages.map((s) => s.body)).toEqual(CANONICAL);
    // The line count and per-line indentation of the multi-line body survive
    // the trip — a reprint would flatten them, and no shape check would notice.
    const first = runSpy.mock.calls[0]![0].stages[0]!.body;
    expect(first.split('\n')).toHaveLength(4);
    expect(first.split('\n').map((l) => /^[ \t]*/.exec(l)![0])).toEqual(['', '  ', '  ', '']);
  });

  it('Explain repairs every stage body before it crosses IPC, with no editor blur', async () => {
    const explainSpy = vi.fn<IpcApi['agg']['explain']>(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
      verbosity: 'queryPlanner',
      writeStageOmitted: false,
    }));
    installAtelierMock({ agg: { explain: explainSpy, cancel: async () => undefined } });

    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: SHELL_STAGES });

    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));

    await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(1));
    expect(explainSpy.mock.calls[0]![0].stages.map((s) => s.body)).toEqual(CANONICAL);
  });

  it('the repaired bodies are written back into the tab state, not only sent', async () => {
    const runSpy = vi.fn<IpcApi['agg']['run']>(async () => ({
      rows: [],
      durationMs: 1,
      stageCounts: {},
      stageSamples: {},
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    const onPatch = vi.fn();
    render(
      <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={{ ...DEFAULT_AGGREGATION_TAB_STATE, stages: SHELL_STAGES }}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
      </DarkCtx.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));

    const patched = onPatch.mock.calls
      .map(([p]) => p as Partial<AggregationTabState>)
      .find((p) => p.stages);
    expect(patched?.stages?.map((s) => s.body)).toEqual(CANONICAL);
  });

  it('leaves stages that are already Canonical EJSON untouched — no patch at all', async () => {
    const runSpy = vi.fn<IpcApi['agg']['run']>(async () => ({
      rows: [],
      durationMs: 1,
      stageCounts: {},
      stageSamples: {},
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    const stages: AggregationTabState['stages'] = [
      { id: 1, op: '$match', body: '{ "a"  : 1 }', enabled: true },
    ];
    const onPatch = vi.fn();
    render(
      <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={{ ...DEFAULT_AGGREGATION_TAB_STATE, stages }}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
      </DarkCtx.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));

    expect(runSpy.mock.calls[0]![0].stages).toEqual(stages);
    expect(onPatch.mock.calls.some(([p]) => (p as Partial<AggregationTabState>).stages)).toBe(false);
  });

  // Save is the last path that reads `stages` without a blur first.
  // Reached from the command palette, nothing focuses the editor, so this
  // whole block deliberately never calls `fireEvent.blur`: a test that blurs
  // cannot see the bug.
  it('Save persists repaired bodies, with no editor blur', async () => {
    const updateSpy = vi.fn<IpcApi['saved']['update']>(async () => ({
      id: 's1',
      connectionId: 'c1',
      name: 'p',
      dbName: 'app',
      collection: 'orders',
      kind: 'aggregation',
      payload: { kind: 'aggregation', stages: [] },
      createdAt: '',
      updatedAt: '',
    }));
    installAtelierMock({ saved: { update: updateSpy } });

    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: SHELL_STAGES,
      savedId: 's1',
      name: 'p',
      dirty: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const payload = updateSpy.mock.calls[0]![0].patch.payload;
    if (payload?.kind !== 'aggregation') throw new Error('expected an aggregation payload');
    expect(payload.stages.map((s) => s.body)).toEqual(CANONICAL);
  });

  // `WorkspaceStateService.list` restores the stored stages of a saved-pipeline tab that is
  // clean and has none, on the footing that every edit leaves the tab dirty. Emptying the
  // pipeline by hand is the edit that would otherwise look the same as a never-loaded tab.
  it('removing the last stage leaves a saved pipeline dirty, not clean and empty', () => {
    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
      savedId: 's1',
      name: 'p',
    });
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete stage' }));

    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
  });

  // docs/adr/0013 — stage delete is local editor state: no confirm, an Undo
  // toast instead. `renderStatefulTab`, not `renderTab`: the restore has to
  // round-trip through `onPatch` and come back as props for the accordion to
  // show the stage again.
  describe('remove stage — Undo toast (docs/adr/0013)', () => {
    function opAt(index: number) {
      return screen.getByRole('button', {
        name: new RegExp(`Change operator for stage ${index + 1} \\(currently \\$`),
      }).getAttribute('aria-label');
    }

    it('restores the removed stage at its index', async () => {
      renderStatefulTab({
        ...DEFAULT_AGGREGATION_TAB_STATE,
        stages: [
          { id: 1, op: '$match', body: '{}', enabled: true },
          { id: 2, op: '$sort', body: '{}', enabled: true },
        ],
      });

      expect(opAt(0)).toMatch(/\$match/);
      expect(opAt(1)).toMatch(/\$sort/);

      fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[0]!);

      // $match is gone; $sort shifted up to index 0.
      expect(opAt(0)).toMatch(/\$sort/);
      expect(screen.queryByRole('button', { name: 'Change operator for stage 2 (currently $sort)' })).toBeNull();

      const undo = await screen.findByRole('button', { name: 'Undo' });
      fireEvent.click(undo);

      await waitFor(() => expect(opAt(0)).toMatch(/\$match/));
      expect(opAt(1)).toMatch(/\$sort/);
    });

    /**
     * MUTATION TARGET — drop the `index` argument in `onRemoveStage`'s Undo
     * `onClick` (always restore at 0, say) and this goes red: $limit ends up
     * first instead of last.
     */
    it('a second delete replaces the first toast\'s Undo target', async () => {
      renderStatefulTab({
        ...DEFAULT_AGGREGATION_TAB_STATE,
        stages: [
          { id: 1, op: '$match', body: '{}', enabled: true },
          { id: 2, op: '$sort', body: '{}', enabled: true },
          { id: 3, op: '$limit', body: '5', enabled: true },
        ],
      });

      // Remove $match (index 0).
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[0]!);
      await screen.findByRole('button', { name: 'Undo' });

      // Remove what is now index 1 ($limit) — only one Undo toast survives.
      // A non-zero index matters here: restoring at 0 instead of the
      // captured index would put $limit first instead of last.
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[1]!);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1));

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      // $limit came back at the end, not at 0; $match stays gone.
      await waitFor(() => expect(opAt(1)).toMatch(/\$limit/));
      expect(opAt(0)).toMatch(/\$sort/);
      expect(screen.queryByRole('button', { name: /currently \$match\)/ })).toBeNull();
    });
  });
});

/**
 * A confirmed `$out`/`$merge` run writes to a collection the renderer can't
 * name (main parses the target out of the stage body), so the tab drops the
 * connection's field-suggestion samples. A run with no write stage, and a
 * write run still waiting on its confirmation, change nothing.
 */
describe('AggregationTab — field-suggestion sample after a write run', () => {
  const invalidate = vi.mocked(invalidateSampleSchemaCache);
  const WRITE_STAGES: AggregationTabState['stages'] = [
    { id: 1, op: '$match', body: '{}', enabled: true },
    { id: 2, op: '$out', body: '"monthly"', enabled: true },
  ];
  const writeBlocked = {
    code: 'VALIDATION',
    message: 'run blocked: write stage present',
    details: { kind: 'writeStage', writeStageOp: '$out', targetCollection: 'monthly' },
  };
  const ranOk = { rows: [], durationMs: 1, stageCounts: {}, stageSamples: {}, hasMore: false };

  beforeEach(() => {
    invalidate.mockClear();
    vi.mocked(invalidateSchemaEnumCache).mockClear();
  });

  it('is dropped for the connection once the confirmed write run settles', async () => {
    const run = vi.fn(async (input: { allowWrite?: boolean }) => {
      if (!input.allowWrite) throw writeBlocked;
      return ranOk;
    });
    installAtelierMock({ agg: { run: run as never, cancel: async () => undefined } });
    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: WRITE_STAGES });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Proceed' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![0]).toMatchObject({ allowWrite: true });
    await waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1'));
    await waitFor(() => expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1'));
  });

  it('is dropped even when the confirmed write run fails part-way', async () => {
    const run = vi.fn(async (input: { allowWrite?: boolean }) => {
      throw input.allowWrite ? { code: 'INTERNAL', message: 'merge failed' } : writeBlocked;
    });
    installAtelierMock({ agg: { run: run as never, cancel: async () => undefined } });
    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: WRITE_STAGES });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Proceed' }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1'));
    await waitFor(() => expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1'));
  });

  it('is kept while the write is still unconfirmed, and after a cancelled confirmation', async () => {
    const run = vi.fn(async () => {
      throw writeBlocked;
    });
    installAtelierMock({ agg: { run: run as never, cancel: async () => undefined } });
    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: WRITE_STAGES });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    // Wait for the dialog itself: while the blocked run is in flight the tab's
    // own run button also reads "Cancel".
    await screen.findByRole('button', { name: 'Proceed' });
    expect(invalidate).not.toHaveBeenCalled(); // blocked, nothing written yet
    expect(invalidateSchemaEnumCache).not.toHaveBeenCalled(); // blocked, nothing written yet
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});

    expect(run).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    expect(invalidateSchemaEnumCache).not.toHaveBeenCalled();
  });

  it('is kept by a run with no write stage', async () => {
    const run = vi.fn(async () => ranOk);
    installAtelierMock({ agg: { run: run as never, cancel: async () => undefined } });
    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(invalidate).not.toHaveBeenCalled();
    expect(invalidateSchemaEnumCache).not.toHaveBeenCalled();
  });
});

/**
 * Cancel on a confirmed write run. Main lets a `$out`/`$merge` that has
 * already been sent run to completion (the server would finish it anyway), so
 * the tab must not drop the run on Cancel: it waits, says it is stopping, and
 * reports what actually happened. A read-only run still stops at once.
 */
describe('AggregationTab — cancelling a run', () => {
  const WRITE_STAGES: AggregationTabState['stages'] = [
    { id: 1, op: '$match', body: '{}', enabled: true },
    { id: 2, op: '$out', body: '"monthly"', enabled: true },
  ];
  const writeBlocked = {
    code: 'VALIDATION',
    message: 'run blocked: write stage present',
    details: { kind: 'writeStage', writeStageOp: '$out', targetCollection: 'monthly' },
  };
  const ranOk = { rows: [], durationMs: 7, stageCounts: {}, stageSamples: {}, hasMore: false };

  // Mantine's notification store is module-global and outlives RTL's
  // unmount: one test's toast would still be on screen for the next one's
  // "no completion notice" assertion.
  afterEach(() => notifications.clean());

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Starts a confirmed write run whose main-side promise is `pending`. */
  async function startWriteRun(pending: Promise<typeof ranOk>) {
    const run = vi.fn(async (input: { allowWrite?: boolean }) => {
      if (!input.allowWrite) throw writeBlocked;
      return pending;
    });
    const cancel = vi.fn(async () => undefined);
    installAtelierMock({ agg: { run: run as never, cancel: cancel as never } });
    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: WRITE_STAGES });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Proceed' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    return { run, cancel };
  }

  it('a refused cancel is logged and shown to the user', async () => {
    const log = vi.fn<IpcApi['app']['log']>(async () => undefined);
    installAtelierMock({
      app: { log },
      agg: {
        run: (() => new Promise(() => {})) as never,
        cancel: async () => {
          throw { code: 'INTERNAL', message: 'no such run' };
        },
      },
    });
    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Cancel failed')).toBeTruthy();
    expect(screen.getByText('no such run')).toBeTruthy();
    expect(log).toHaveBeenCalledWith({ level: 'warn', message: 'aggregation cancel failed: no such run', source: 'component' });
  });

  it('a cancelled write run that completes shows its result and says the write ran to completion', async () => {
    const pending = deferred<typeof ranOk>();
    const { run, cancel } = await startWriteRun(pending.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const token = (run.mock.calls[1]![0] as { cancelToken: string }).cancelToken;
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ token });
    expect((await screen.findByRole('button', { name: /Stopping/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      await screen.findByText('Asking the server to stop the write stage.'),
    ).toBeTruthy();

    await act(async () => pending.resolve(ranOk));

    expect(
      await screen.findByText("The write couldn't be stopped, so it ran to completion."),
    ).toBeTruthy();
    expect(screen.queryByText('· 7ms')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a write run cancelled before the write was sent stops without an error or a completion notice', async () => {
    const pending = deferred<typeof ranOk>();
    await startWriteRun(pending.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: /Stopping/ });
    await act(async () => pending.reject({ code: 'INTERNAL', message: 'cancelled' }));

    expect((await screen.findByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/ran to completion/)).toBeNull();
    expect(screen.queryByText(/Write stopped/)).toBeNull();
    expect(screen.queryByText(/cancelled/)).toBeNull();
    expect(screen.queryByText('· 7ms')).toBeNull();
  });

  it('a $out write killed on the server says its target was left unchanged', async () => {
    const pending = deferred<typeof ranOk>();
    await startWriteRun(pending.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: /Stopping/ });
    await act(async () =>
      pending.reject({
        code: 'INTERNAL',
        message: 'cancelled',
        details: { writeStageOp: '$out', partialWrite: false },
      }),
    );

    expect(
      await screen.findByText('Write stopped. The $out target was left unchanged.'),
    ).toBeTruthy();
    expect(screen.queryByText(/ran to completion/)).toBeNull();
    expect(screen.queryByText('· 7ms')).toBeNull();
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a $merge write killed on the server warns that some documents may already be written', async () => {
    const pending = deferred<typeof ranOk>();
    await startWriteRun(pending.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: /Stopping/ });
    await act(async () =>
      pending.reject({
        code: 'INTERNAL',
        message: 'cancelled',
        details: { writeStageOp: '$merge', partialWrite: true },
      }),
    );

    expect(
      await screen.findByText(
        'Write stopped. $merge may already have written some documents, and they stay in the target.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/left unchanged/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a cancelled write run that then fails shows the error, not a completion notice', async () => {
    const pending = deferred<typeof ranOk>();
    await startWriteRun(pending.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: /Stopping/ });
    await act(async () =>
      pending.reject({
        code: 'CONFLICT',
        message: '$merge with whenMatched: fail found an existing document',
        details: { mongoCode: 11000 },
      }),
    );

    expect(
      await screen.findByText('$merge with whenMatched: fail found an existing document'),
    ).toBeTruthy();
    expect(screen.getByText('CONFLICT')).toBeTruthy();
    expect(screen.queryByText(/ran to completion/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a read-only run still stops at once and drops its late result', async () => {
    const pending = deferred<typeof ranOk>();
    const run = vi.fn(async () => pending.promise);
    const cancel = vi.fn(async () => undefined);
    installAtelierMock({ agg: { run: run as never, cancel: cancel as never } });
    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Stopping/ })).toBeNull();
    await act(async () => pending.resolve(ranOk));
    expect(screen.queryByText('· 7ms')).toBeNull();
    expect(screen.queryByText(/ran to completion/)).toBeNull();
  });
});

// A successful run records the values its leading `$match` stages carried,
// so the builder's value popover can offer them later.
describe('AggregationTab — value recording', () => {
  const ranOk = { rows: [], durationMs: 1, stageCounts: {}, stageSamples: {}, hasMore: false };

  it('records the leading $match values after a successful run', async () => {
    const run = vi.fn(async () => ranOk);
    const recordFieldValues = vi.fn(async () => ({ recorded: 1 }));
    installAtelierMock({
      agg: { run: run as never, cancel: async () => undefined },
      recent: { recordFieldValues: recordFieldValues as never } as never,
    });
    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [
        { id: 1, op: '$match', body: '{ status: "x" }', enabled: true },
        { id: 2, op: '$group', body: '{ _id: "$kind" }', enabled: true },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() =>
      expect(recordFieldValues).toHaveBeenCalledExactlyOnceWith({
        connectionId: 'c1',
        dbName: 'app',
        collection: 'orders',
        entries: [{ field: 'status', value: 'x', valType: 'string', op: '$eq' }],
      }),
    );
  });

  it('records nothing for a pipeline without a leading $match', async () => {
    const run = vi.fn(async () => ranOk);
    const recordFieldValues = vi.fn(async () => ({ recorded: 0 }));
    installAtelierMock({
      agg: { run: run as never, cancel: async () => undefined },
      recent: { recordFieldValues: recordFieldValues as never } as never,
    });
    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$limit', body: '10', enabled: true }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // Let the resolved run settle before asserting the absence.
    await act(async () => {
      await Promise.resolve();
    });
    expect(recordFieldValues).not.toHaveBeenCalled();
  });
});

describe('AggregationTab — Copy menu (#23)', () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
    notifications.clean();
  });

  const pipelineState = (body: string): AggregationTabState => ({
    ...DEFAULT_AGGREGATION_TAB_STATE,
    stages: [
      { id: 1, op: '$match', body, enabled: true },
      { id: 2, op: '$limit', body: '5', enabled: false },
    ],
  });

  const copyAs = async (label: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy pipeline' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: label }));
  };

  it('copies the enabled stages as a Canonical EJSON array, repairing Shell Syntax', async () => {
    const { onPatch } = renderTab(pipelineState('{ status: "open" }'));
    await copyAs('Pipeline (EJSON array)');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('[{"$match":{"status":"open"}}]'));
    // Copying repairs a copy of the bodies, never the tab's own.
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('copies a driver snippet that keeps an ObjectId through EJSON.parse', async () => {
    renderTab(pipelineState('{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60718") }'));
    await copyAs('mongosh');
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toBe(
      'db.getCollection("orders").aggregate([{"$match":{"_id":EJSON.parse(' +
        JSON.stringify('{"$oid":"64b7f0c2a1b2c3d4e5f60718"}') +
        ', { relaxed: false })}}])',
    );
  });

  it('is disabled while the pipeline does not validate', () => {
    renderTab(pipelineState('{ a: '));
    expect((screen.getByRole('button', { name: 'Copy pipeline' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// jsdom never blurs an element that goes `disabled`, and the e2e suite cannot
// inject IPC latency, so the focus drop itself is unobservable here; what the
// fix guarantees (and what is asserted) is that Save never takes the real
// `disabled` attribute, which is what makes Chromium blur it.
describe('AggregationTab — Save stays focusable when it goes inert', () => {
  const savedState = {
    ...DEFAULT_AGGREGATION_TAB_STATE,
    stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    savedId: 's1',
    name: 'p',
  } satisfies AggregationTabState;

  const updateOk = async () => ({
    id: 's1',
    connectionId: 'c1',
    name: 'p',
    dbName: 'app',
    collection: 'orders',
    kind: 'aggregation' as const,
    payload: { kind: 'aggregation' as const, stages: [] },
    createdAt: '',
    updatedAt: '',
  });

  it('a clean pipeline: Save is aria-disabled, not disabled, and a click saves nothing', () => {
    const update = vi.fn<IpcApi['saved']['update']>(updateOk);
    installAtelierMock({ saved: { update } });
    renderStatefulTab(savedState);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(save);
    expect(update).not.toHaveBeenCalled();
  });

  it('a successful save clears dirty without taking focus off the button', async () => {
    const update = vi.fn<IpcApi['saved']['update']>(updateOk);
    installAtelierMock({ saved: { update } });
    renderStatefulTab({ ...savedState, dirty: true });

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('aria-disabled')).toBe(false);
    save.focus();
    fireEvent.click(save);

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('true'),
    );
    const after = screen.getByRole('button', { name: 'Save' });
    expect(after.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(after);
  });
});

// The palette command reaches the same save as the button, so the button's
// inert states (nothing changed, a run in flight) have to hold for it too.
describe('AggregationTab — the "Save pipeline" palette command', () => {
  const savedState = {
    ...DEFAULT_AGGREGATION_TAB_STATE,
    stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    savedId: 's1',
    name: 'p',
  } satisfies AggregationTabState;

  const updateOk = async () => ({
    id: 's1',
    connectionId: 'c1',
    name: 'p',
    dbName: 'app',
    collection: 'orders',
    kind: 'aggregation' as const,
    payload: { kind: 'aggregation' as const, stages: [] },
    createdAt: '',
    updatedAt: '',
  });

  function runSaveCommand() {
    const cmd = commandRegistry.list().find((c) => c.id === 'agg.save');
    if (!cmd) throw new Error('agg.save is not registered');
    act(() => {
      void cmd.perform({ pathname: '/workspace', connectionId: 'c1' });
    });
  }

  it('saves nothing on a clean pipeline', async () => {
    const update = vi.fn<IpcApi['saved']['update']>(updateOk);
    installAtelierMock({ saved: { update } });
    renderStatefulTab(savedState);

    runSaveCommand();
    await act(async () => {});

    expect(update).not.toHaveBeenCalled();
  });

  it('saves nothing while a run is in flight', async () => {
    const update = vi.fn<IpcApi['saved']['update']>(updateOk);
    const run = vi.fn<IpcApi['agg']['run']>(() => new Promise(() => {}));
    installAtelierMock({ saved: { update }, agg: { run } });
    renderStatefulTab({ ...savedState, dirty: true });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    runSaveCommand();
    await act(async () => {});

    expect(update).not.toHaveBeenCalled();
  });

  it('still saves a dirty, idle pipeline', async () => {
    const update = vi.fn<IpcApi['saved']['update']>(updateOk);
    installAtelierMock({ saved: { update } });
    renderStatefulTab({ ...savedState, dirty: true });

    runSaveCommand();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });
});
