import { describe, it, expect, vi } from 'vitest';
import { confirmQuit, createQuitGate, describeRunningWork, type RunningWork } from '../../electron/quitGuard';

describe('describeRunningWork', () => {
  it('is null when nothing is running', () => {
    expect(describeRunningWork({ scripts: 0, shellCommands: 0, imports: 0, aggregations: 0 })).toBeNull();
  });

  it('names one running script', () => {
    expect(describeRunningWork({ scripts: 1, shellCommands: 0, imports: 0, aggregations: 0 })).toBe('This will stop 1 running script.');
  });

  it('pluralises scripts', () => {
    expect(describeRunningWork({ scripts: 3, shellCommands: 0, imports: 0, aggregations: 0 })).toBe('This will stop 3 running scripts.');
  });

  it('names one shell command and pluralises several', () => {
    expect(describeRunningWork({ scripts: 0, shellCommands: 1, imports: 0, aggregations: 0 })).toBe('This will stop 1 running shell command.');
    expect(describeRunningWork({ scripts: 0, shellCommands: 2, imports: 0, aggregations: 0 })).toBe('This will stop 2 running shell commands.');
  });

  it('lists both kinds when both are running', () => {
    expect(describeRunningWork({ scripts: 1, shellCommands: 2, imports: 0, aggregations: 0 })).toBe(
      'This will stop 1 running script and 2 running shell commands.',
    );
  });
});

describe('describeRunningWork imports and aggregations', () => {
  const none: RunningWork = { scripts: 0, shellCommands: 0, imports: 0, aggregations: 0 };

  it('names a running import and an aggregation, singular and plural', () => {
    expect(describeRunningWork({ ...none, imports: 1 })).toBe('This will stop 1 running import.');
    expect(describeRunningWork({ ...none, imports: 2 })).toBe('This will stop 2 running imports.');
    expect(describeRunningWork({ ...none, aggregations: 1 })).toBe('This will stop 1 running aggregation.');
    expect(describeRunningWork({ ...none, aggregations: 3 })).toBe('This will stop 3 running aggregations.');
  });

  it('lists every kind that is running, in a readable list', () => {
    expect(describeRunningWork({ ...none, imports: 1, aggregations: 2 })).toBe(
      'This will stop 1 running import and 2 running aggregations.',
    );
    expect(describeRunningWork({ scripts: 1, shellCommands: 2, imports: 1, aggregations: 2 })).toBe(
      'This will stop 1 running script, 2 running shell commands, 1 running import, and 2 running aggregations.',
    );
  });
});

describe('confirmQuit', () => {
  it('quits without asking when nothing is running', async () => {
    const confirm = vi.fn(async () => false);
    await expect(confirmQuit({ counts: () => ({ scripts: 0, shellCommands: 0, imports: 0, aggregations: 0 }), confirm })).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks with the description of what stops, and quits on a yes', async () => {
    const confirm = vi.fn(async () => true);
    await expect(confirmQuit({ counts: () => ({ scripts: 1, shellCommands: 2, imports: 0, aggregations: 0 }), confirm })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith('This will stop 1 running script and 2 running shell commands.');
  });

  it('stays open on a no', async () => {
    const confirm = vi.fn(async () => false);
    await expect(confirmQuit({ counts: () => ({ scripts: 2, shellCommands: 0, imports: 0, aggregations: 0 }), confirm })).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});

describe('createQuitGate', () => {
  const idle: RunningWork = { scripts: 0, shellCommands: 0, imports: 0, aggregations: 0 };
  const busy: RunningWork = { scripts: 1, shellCommands: 0, imports: 0, aggregations: 0 };

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
    const { gate: g, confirm } = gate({ scripts: 2, shellCommands: 1, imports: 0, aggregations: 0 });
    expect(g.check()).toBe('hold');
    await g.ask();
    expect(confirm).toHaveBeenCalledExactlyOnceWith('This will stop 2 running scripts and 1 running shell command.');
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
