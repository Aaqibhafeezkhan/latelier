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
