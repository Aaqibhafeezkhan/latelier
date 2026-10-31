import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  awaitRendererFlush,
  confirmQuit,
  createBeforeQuitHandler,
  createQuitGate,
  describeQuitDetail,
  describeRunningWork,
  resetUnsavedWork,
  runTeardown,
  type RendererFlushOutcome,
  type RunningWork,
  type UnsavedWorkStore,
} from '../../electron/quitGuard';

describe('describeRunningWork', () => {
  it('is null when nothing is running', () => {
    expect(describeRunningWork({ scripts: 0, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 })).toBeNull();
  });

  it('names one running script', () => {
    expect(describeRunningWork({ scripts: 1, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 })).toBe('This will stop 1 running script.');
  });

  it('pluralises scripts', () => {
    expect(describeRunningWork({ scripts: 3, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 })).toBe('This will stop 3 running scripts.');
  });

  it('names one shell command and pluralises several', () => {
    expect(describeRunningWork({ scripts: 0, shellCommands: 1, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 })).toBe('This will stop 1 running shell command.');
    expect(describeRunningWork({ scripts: 0, shellCommands: 2, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 })).toBe('This will stop 2 running shell commands.');
  });

  it('lists both kinds when both are running', () => {
    expect(describeRunningWork({ scripts: 1, shellCommands: 2, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 })).toBe(
      'This will stop 1 running script and 2 running shell commands.',
    );
  });
});

describe('describeRunningWork imports and aggregations', () => {
  const none: RunningWork = { scripts: 0, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 };

  it('names a running import and an aggregation, singular and plural', () => {
    expect(describeRunningWork({ ...none, imports: 1 })).toBe('This will stop 1 running import.');
    expect(describeRunningWork({ ...none, imports: 2 })).toBe('This will stop 2 running imports.');
    expect(describeRunningWork({ ...none, aggregations: 1, unsavedForms: 0, unsavedPipelines: 0 })).toBe('This will stop 1 running aggregation.');
    expect(describeRunningWork({ ...none, aggregations: 3, unsavedForms: 0, unsavedPipelines: 0 })).toBe('This will stop 3 running aggregations.');
  });

  it('lists every kind that is running, in a readable list', () => {
    expect(describeRunningWork({ ...none, imports: 1, aggregations: 2, unsavedForms: 0, unsavedPipelines: 0 })).toBe(
      'This will stop 1 running import and 2 running aggregations.',
    );
    expect(describeRunningWork({ scripts: 1, shellCommands: 2, imports: 1, aggregations: 2, unsavedForms: 0, unsavedPipelines: 0 })).toBe(
      'This will stop 1 running script, 2 running shell commands, 1 running import, and 2 running aggregations.',
    );
  });
});

describe('describeRunningWork unsaved work', () => {
  const none: RunningWork = { scripts: 0, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 };

  it('names an unsaved connection form alone, with no running-work sentence', () => {
    expect(describeRunningWork({ ...none, unsavedForms: 1 })).toBe(
      'Unsaved changes in the connection form will be lost.',
    );
  });

  it('counts several connection forms', () => {
    expect(describeRunningWork({ ...none, unsavedForms: 2 })).toBe(
      'Unsaved changes in 2 connection forms will be lost.',
    );
  });

  it('names one pipeline and pluralises several', () => {
    expect(describeRunningWork({ ...none, unsavedPipelines: 1 })).toBe('Unsaved changes in 1 pipeline will be lost.');
    expect(describeRunningWork({ ...none, unsavedPipelines: 3 })).toBe('Unsaved changes in 3 pipelines will be lost.');
  });

  it('lists the form and the pipelines together', () => {
    expect(describeRunningWork({ ...none, unsavedForms: 1, unsavedPipelines: 2 })).toBe(
      'Unsaved changes in the connection form and 2 pipelines will be lost.',
    );
  });

  it('puts the unsaved sentence after the running-work sentence', () => {
    expect(describeRunningWork({ ...none, scripts: 1, unsavedForms: 1, unsavedPipelines: 2 })).toBe(
      'This will stop 1 running script. Unsaved changes in the connection form and 2 pipelines will be lost.',
    );
  });
});

describe('describeQuitDetail', () => {
  const none: RunningWork = { scripts: 0, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 };
  const RUNNING = 'Work in progress is cancelled and its results are lost.';
  const UNSAVED = 'Changes you have not saved cannot be recovered.';
  const BOTH = 'Work in progress is cancelled, and its results and your unsaved changes are lost.';

  it.each([
    ['a script', { scripts: 1 }],
    ['a shell command', { shellCommands: 1 }],
    ['an import', { imports: 1 }],
    ['an aggregation', { aggregations: 1 }],
  ])('speaks of cancelled work when only %s is running', (_label, work) => {
    expect(describeQuitDetail({ ...none, ...work })).toBe(RUNNING);
  });

  it('speaks only of unsaved changes when nothing is running', () => {
    expect(describeQuitDetail({ ...none, unsavedForms: 1 })).toBe(UNSAVED);
    expect(describeQuitDetail({ ...none, unsavedPipelines: 2 })).toBe(UNSAVED);
  });

  it('names both when work runs and changes are unsaved', () => {
    expect(describeQuitDetail({ ...none, scripts: 1, unsavedForms: 1 })).toBe(BOTH);
    expect(describeQuitDetail({ ...none, aggregations: 2, unsavedPipelines: 1 })).toBe(BOTH);
  });
});

describe('confirmQuit', () => {
  it('quits without asking when nothing is running', async () => {
    const confirm = vi.fn(async () => false);
    await expect(confirmQuit({ counts: () => ({ scripts: 0, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 }), confirm })).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks with the description of what stops, and quits on a yes', async () => {
    const confirm = vi.fn(async () => true);
    await expect(confirmQuit({ counts: () => ({ scripts: 1, shellCommands: 2, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 }), confirm })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith('This will stop 1 running script and 2 running shell commands.');
  });

  it('stays open on a no', async () => {
    const confirm = vi.fn(async () => false);
    await expect(confirmQuit({ counts: () => ({ scripts: 2, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 }), confirm })).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});

describe('createQuitGate', () => {
  const idle: RunningWork = { scripts: 0, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 };
  const busy: RunningWork = { scripts: 1, shellCommands: 0, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 };

  function gate(initial: RunningWork, answer: () => Promise<boolean> = async () => true) {
    const state = { work: initial };
    const confirm = vi.fn<(message: string) => Promise<boolean>>(() => answer());
    return { state, confirm, gate: createQuitGate({ counts: () => state.work, confirm }) };
  }

  it('lets a quit or a window close through when nothing is running, without asking', () => {
    const { gate: g, confirm } = gate(idle);
    expect(g.check()).toBe('allow');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('holds a quit while work runs, and says what would stop when asked', async () => {
    const { gate: g, confirm } = gate({ scripts: 2, shellCommands: 1, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 });
    expect(g.check()).toBe('hold');
    await g.ask();
    expect(confirm).toHaveBeenCalledExactlyOnceWith('This will stop 2 running scripts and 1 running shell command.');
  });

  it('holds a quit over unsaved work alone, and names it when asked', async () => {
    const { gate: g, confirm } = gate({ ...idle, unsavedForms: 1 });
    expect(g.check()).toBe('hold');
    await g.ask();
    expect(confirm).toHaveBeenCalledExactlyOnceWith('Unsaved changes in the connection form will be lost.');
  });

  it('lets the follow-up through after a yes, so one close asks once', async () => {
    const { gate: g, confirm } = gate(busy, async () => true);
    expect(g.check()).toBe('hold');
    await expect(g.ask()).resolves.toBe(true);
    // The window close that follows the yes, then the app quit that follows the close.
    expect(g.check()).toBe('allow');
    expect(g.check()).toBe('allow');
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('keeps holding after a no, and asks again on a later attempt', async () => {
    const { gate: g, confirm } = gate(busy, async () => false);
    await expect(g.ask()).resolves.toBe(false);
    expect(g.check()).toBe('hold');
    await expect(g.ask()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('answers a second request while the question is open with a no, without asking again', async () => {
    let answer!: (yes: boolean) => void;
    const { gate: g, confirm } = gate(
      busy,
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const first = g.ask();
    await expect(g.ask()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    answer(true);
    await expect(first).resolves.toBe(true);
    expect(g.check()).toBe('allow');
  });

  it('can ask again once the first question is answered', async () => {
    const { gate: g, confirm } = gate(busy, async () => false);
    await g.ask();
    await g.ask();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('reset takes back a yes, so the next quit over running work asks again', async () => {
    const { gate: g, confirm } = gate(busy);
    confirm.mockResolvedValue(true);
    await g.ask();
    expect(g.check()).toBe('allow');
    g.reset();
    expect(g.check()).toBe('hold');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('skips the question for a system shutdown', () => {
    const { gate: g, confirm } = gate(busy);
    g.markSystemShutdown();
    expect(g.check()).toBe('allow');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not ask if the work has finished by the time the question would be shown', async () => {
    const { gate: g, state, confirm } = gate(busy);
    expect(g.check()).toBe('hold');
    state.work = idle;
    await expect(g.ask()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rejects when the question cannot be shown, and can be asked again', async () => {
    let fail = true;
    const { gate: g } = gate(busy, async () => {
      if (fail) throw new Error('no dialog');
      return true;
    });
    await expect(g.ask()).rejects.toThrow('no dialog');
    fail = false;
    await expect(g.ask()).resolves.toBe(true);
  });
});

describe('runTeardown', () => {
  it('runs every step in order even when earlier ones throw or reject, naming each failure', async () => {
    const order: string[] = [];
    const onError = vi.fn();
    const boom = new Error('sync boom');
    const nope = new Error('async nope');
    await runTeardown(
      [
        ['a', () => { order.push('a'); }],
        ['b', () => { order.push('b'); throw boom; }],
        ['c', async () => { order.push('c'); throw nope; }],
        ['d', async () => { order.push('d'); }],
        ['e', () => { order.push('e'); }],
      ],
      onError,
    );
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(onError.mock.calls).toEqual([['b', boom], ['c', nope]]);
  });

  it('waits for an async step before starting the next', async () => {
    const order: string[] = [];
    await runTeardown(
      [
        ['slow', async () => { await new Promise((r) => setTimeout(r, 5)); order.push('slow'); }],
        ['next', () => { order.push('next'); }],
      ],
      vi.fn(),
    );
    expect(order).toEqual(['slow', 'next']);
  });

  it('does not call onError when every step succeeds', async () => {
    const onError = vi.fn();
    await runTeardown([['a', () => {}]], onError);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('resetUnsavedWork', () => {
  it('forgets the form report and takes the pipeline count from the saved tabs', () => {
    const store: UnsavedWorkStore = { connectionForm: 1, pipelines: 5 };
    resetUnsavedWork(store, () => 2);
    expect(store).toEqual({ connectionForm: 0, pipelines: 2 });
  });

  it('zeroes the pipelines when no saved tab is dirty', () => {
    const store: UnsavedWorkStore = { connectionForm: 0, pipelines: 3 };
    resetUnsavedWork(store, () => 0);
    expect(store).toEqual({ connectionForm: 0, pipelines: 0 });
  });
});

describe('awaitRendererFlush', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The outcome so far, or 'pending', read after letting microtasks run. */
  async function settled(promise: Promise<RendererFlushOutcome>): Promise<RendererFlushOutcome | 'pending'> {
    return Promise.race([promise, Promise.resolve().then(() => 'pending' as const)]);
  }

  it('sends the request once, and answers no-window at once, with no timer, when there is no window', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => false);
    const { promise, ack } = awaitRendererFlush({ send, timeoutMs: 1500 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    ack();
    expect(await promise).toBe('no-window');
  });

  it('answers flushed on the ack and clears its timer', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const { promise, ack } = awaitRendererFlush({ send, timeoutMs: 1500 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(await settled(promise)).toBe('pending');
    ack();
    expect(vi.getTimerCount()).toBe(0);
    expect(await promise).toBe('flushed');
    ack();
    expect(await promise).toBe('flushed');
  });

  it('waits the whole timeout, then answers timeout, and a late ack changes nothing', async () => {
    vi.useFakeTimers();
    const { promise, ack } = awaitRendererFlush({ send: () => true, timeoutMs: 1500 });
    await vi.advanceTimersByTimeAsync(1499);
    expect(await settled(promise)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(promise)).toBe('timeout');
    ack();
    expect(await promise).toBe('timeout');
  });
});

describe('createBeforeQuitHandler', () => {
  function setup(check: 'allow' | 'hold', answer: Promise<boolean> = Promise.resolve(true)) {
    const gate = { check: vi.fn(() => check), ask: vi.fn(() => answer) };
    const deps = { gate, quit: vi.fn(), shutdown: vi.fn(), onAskError: vi.fn() };
    const event = () => ({ preventDefault: vi.fn() });
    return { deps, handler: createBeforeQuitHandler(deps), event };
  }

  it('holds the quit and starts the teardown once when the gate allows', () => {
    const { deps, handler, event } = setup('allow');
    expect(handler.isShuttingDown()).toBe(false);
    const e = event();
    handler.handle(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
    expect(handler.isShuttingDown()).toBe(true);
    expect(deps.gate.ask).not.toHaveBeenCalled();
  });

  it('holds a second quit during the teardown without starting it again or asking', () => {
    const { deps, handler, event } = setup('allow');
    handler.handle(event());
    deps.gate.check.mockReturnValue('hold');
    const second = event();
    handler.handle(second);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.gate.ask).not.toHaveBeenCalled();
  });

  it('over held work, asks instead of shutting down, and quits again on a yes', async () => {
    const { deps, handler, event } = setup('hold', Promise.resolve(true));
    const e = event();
    handler.handle(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.shutdown).not.toHaveBeenCalled();
    expect(handler.isShuttingDown()).toBe(false);
    expect(deps.gate.ask).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1));
  });

  it('does not quit on a no, and a later allowed quit still shuts down', async () => {
    const { deps, handler, event } = setup('hold', Promise.resolve(false));
    handler.handle(event());
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.quit).not.toHaveBeenCalled();
    deps.gate.check.mockReturnValue('allow');
    handler.handle(event());
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
  });

  it('hands a failed question to onAskError', async () => {
    const boom = new Error('no dialog');
    const { deps, handler, event } = setup('hold', Promise.reject(boom));
    handler.handle(event());
    await vi.waitFor(() => expect(deps.onAskError).toHaveBeenCalledWith(boom));
    expect(deps.quit).not.toHaveBeenCalled();
  });
});
