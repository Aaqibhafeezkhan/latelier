/**
 * What quitting would cut off or throw away. Idle shells and everything else
 * are not counted. The `unsaved*` counts are renderer reports (see
 * `UnsavedWorkStore`); the rest are read from main's own services.
 */
export interface RunningWork {
  scripts: number;
  shellCommands: number;
  imports: number;
  aggregations: number;
  unsavedForms: number;
  unsavedPipelines: number;
}

/**
 * Unsaved work the renderer reports through `app:setUnsavedWork`, one count
 * per source, each report replacing the last. Main resets both to zero when
 * the renderer reloads, crashes or its window closes, so a report never
 * outlives the page that made it.
 */
export interface UnsavedWorkStore {
  connectionForm: number;
  pipelines: number;
}

const plural = (n: number, noun: string): string => `${n} running ${noun}${n === 1 ? '' : 's'}`;

/**
 * What quitting would stop and lose, as one or two sentences, or null when
 * there is neither running work nor unsaved work.
 */
export function describeRunningWork({
  scripts,
  shellCommands,
  imports,
  aggregations,
  unsavedForms,
  unsavedPipelines,
}: RunningWork): string | null {
  const list = (items: string[]) => new Intl.ListFormat('en').format(items);
  const running: string[] = [];
  if (scripts > 0) running.push(plural(scripts, 'script'));
  if (shellCommands > 0) running.push(plural(shellCommands, 'shell command'));
  if (imports > 0) running.push(plural(imports, 'import'));
  if (aggregations > 0) running.push(plural(aggregations, 'aggregation'));
  const unsaved: string[] = [];
  if (unsavedForms > 0) unsaved.push(unsavedForms === 1 ? 'the connection form' : `${unsavedForms} connection forms`);
  if (unsavedPipelines > 0) unsaved.push(`${unsavedPipelines} pipeline${unsavedPipelines === 1 ? '' : 's'}`);
  const sentences: string[] = [];
  if (running.length > 0) sentences.push(`This will stop ${list(running)}.`);
  if (unsaved.length > 0) sentences.push(`Unsaved changes in ${list(unsaved)} will be lost.`);
  return sentences.length === 0 ? null : sentences.join(' ');
}

/**
 * The quit dialog's detail line, matched to what the question is about:
 * running work is cancelled, unsaved changes are gone for good.
 */
export function describeQuitDetail({ scripts, shellCommands, imports, aggregations, unsavedForms, unsavedPipelines }: RunningWork): string {
  const running = [scripts, shellCommands, imports, aggregations].some((n) => n > 0);
  const unsaved = unsavedForms > 0 || unsavedPipelines > 0;
  if (running && unsaved) return 'Work in progress is cancelled, and its results and your unsaved changes are lost.';
  if (unsaved) return 'Changes you have not saved cannot be recovered.';
  return 'Work in progress is cancelled and its results are lost.';
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
  /** Takes back a yes whose quit never happened, so the next attempt asks again. */
  reset(): void;
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
    reset() {
      confirmed = false;
    },
  };
}

/**
 * Runs shutdown steps in order, each in its own try/catch, so one that throws
 * or rejects cannot skip the ones after it (a failed step must not leave the
 * pool connected or the database open). Never throws; failures go to `onError`.
 */
export async function runTeardown(
  steps: ReadonlyArray<readonly [name: string, run: () => void | Promise<void>]>,
  onError: (step: string, err: unknown) => void,
): Promise<void> {
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      onError(name, err);
    }
  }
}
