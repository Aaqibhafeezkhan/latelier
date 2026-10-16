import { describe, it, expect, vi } from 'vitest';
import { confirmQuit, describeRunningWork } from '../../electron/quitGuard';

describe('describeRunningWork', () => {
  it('is null when nothing is running', () => {
    expect(describeRunningWork({ scripts: 0, shellCommands: 0 })).toBeNull();
  });

  it('names one running script', () => {
    expect(describeRunningWork({ scripts: 1, shellCommands: 0 })).toBe('This will stop 1 running script.');
  });

  it('pluralises scripts', () => {
    expect(describeRunningWork({ scripts: 3, shellCommands: 0 })).toBe('This will stop 3 running scripts.');
  });

  it('names one shell command and pluralises several', () => {
    expect(describeRunningWork({ scripts: 0, shellCommands: 1 })).toBe('This will stop 1 running shell command.');
    expect(describeRunningWork({ scripts: 0, shellCommands: 2 })).toBe('This will stop 2 running shell commands.');
  });

  it('lists both kinds when both are running', () => {
    expect(describeRunningWork({ scripts: 1, shellCommands: 2 })).toBe(
      'This will stop 1 running script and 2 running shell commands.',
    );
  });
});

describe('confirmQuit', () => {
  it('quits without asking when nothing is running', async () => {
    const confirm = vi.fn(async () => false);
    await expect(confirmQuit({ counts: () => ({ scripts: 0, shellCommands: 0 }), confirm })).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks with the description of what stops, and quits on a yes', async () => {
    const confirm = vi.fn(async () => true);
    await expect(confirmQuit({ counts: () => ({ scripts: 1, shellCommands: 2 }), confirm })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith('This will stop 1 running script and 2 running shell commands.');
  });

  it('stays open on a no', async () => {
    const confirm = vi.fn(async () => false);
    await expect(confirmQuit({ counts: () => ({ scripts: 2, shellCommands: 0 }), confirm })).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
