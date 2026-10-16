/** Work that quitting would cut off. Idle shells and everything else are not counted. */
export interface RunningWork {
  scripts: number;
  shellCommands: number;
}

const plural = (n: number, noun: string): string => `${n} running ${noun}${n === 1 ? '' : 's'}`;

/** What quitting would stop, as a sentence, or null when nothing is running. */
export function describeRunningWork({ scripts, shellCommands }: RunningWork): string | null {
  const parts: string[] = [];
  if (scripts > 0) parts.push(plural(scripts, 'script'));
  if (shellCommands > 0) parts.push(plural(shellCommands, 'shell command'));
  return parts.length === 0 ? null : `This will stop ${parts.join(' and ')}.`;
}

/**
 * Whether the app may quit now: yes without asking when nothing is running,
 * otherwise whatever `confirm` answers for the sentence naming what stops.
 */
export async function confirmQuit(deps: {
  counts: () => RunningWork;
  confirm: (message: string) => Promise<boolean>;
}): Promise<boolean> {
  const message = describeRunningWork(deps.counts());
  return message === null ? true : deps.confirm(message);
}

export interface QuitGate {
  /**
   * Sync, so a caller can `preventDefault()` before anything awaits. `hold`
   * means the quit or window close must be stopped and `ask()` called.
   */
  check(): 'allow' | 'hold';
  /**
   * Ask whether to quit over the running work. A yes lets every later
   * `check()` through (the close that follows, then the app quit that follows
   * the close, so one close asks once); a no leaves the gate as it was, so a
   * later attempt asks again. A request made while a question is open is
   * answered no without a second dialog.
   */
  ask(): Promise<boolean>;
  /** The system is shutting down: the work goes either way, so nothing is asked. */
  markSystemShutdown(): void;
}

export function createQuitGate(deps: {
  counts: () => RunningWork;
  confirm: (message: string) => Promise<boolean>;
}): QuitGate {
  let confirmed = false;
  let confirming = false;
  let systemShutdown = false;
  return {
    check: () =>
      confirmed || systemShutdown || describeRunningWork(deps.counts()) === null ? 'allow' : 'hold',
    async ask() {
      if (confirming) return false;
      confirming = true;
      try {
        const yes = await confirmQuit(deps);
        if (yes) confirmed = true;
        return yes;
      } finally {
        confirming = false;
      }
    },
    markSystemShutdown() {
      systemShutdown = true;
    },
  };
}
