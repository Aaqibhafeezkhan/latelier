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
 * per source, each report replacing the last. When the renderer reloads,
 * crashes or its window closes, main resets it (`resetUnsavedWork`), so a
 * report never outlives the page that made it.
 */
export interface UnsavedWorkStore {
  connectionForm: number;
  pipelines: number;
}

/**
 * Forgets what a page that is gone reported. The form's report goes with the
 * form. Dirty pipelines do not: they live in the saved tabs, so `savedDirtyPipelines`
 * recounts them from there instead of waiting for the Workspace to mount again
 * and report.
 */
export function resetUnsavedWork(store: UnsavedWorkStore, savedDirtyPipelines: () => number): void {
  store.connectionForm = 0;
  store.pipelines = savedDirtyPipelines();
}

export type RendererFlushOutcome = 'flushed' | 'timeout' | 'no-window';

/**
 * Asks the renderer to save its pending tab edits and waits for its answer,
 * bounded. `send` delivers the request and returns false when there is no
 * window to send it to; `ack` is what the renderer's reply calls. An ack after
 * the timeout, or a second one, changes nothing.
 */
export function awaitRendererFlush(deps: { send: () => boolean; timeoutMs: number }): {
  promise: Promise<RendererFlushOutcome>;
  ack: () => void;
} {
  // The executor runs synchronously, so `ack` is final by the time it is returned.
  let ack = (): void => {};
  const promise = new Promise<RendererFlushOutcome>((resolve) => {
    if (!deps.send()) {
      resolve('no-window');
      return;
    }
    const timer = setTimeout(() => resolve('timeout'), deps.timeoutMs);
    ack = () => {
      clearTimeout(timer);
      resolve('flushed');
    };
  });
  return { promise, ack };
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
 * The `before-quit` handler. Every call holds Electron's own quit: before the
 * teardown it would skip the question or the teardown, and during it (a second
 * Cmd+Q while the renderer flushes, say) it would end the app with the pool
 * connected or the database half closed. The teardown ends the app itself,
 * with `app.exit`, which emits no `before-quit`. Over work the gate holds, it
 * asks, and quits again on a yes; otherwise it starts `shutdown`, once.
 */
export function createBeforeQuitHandler(deps: {
  gate: Pick<QuitGate, 'check' | 'ask'>;
  quit: () => void;
  shutdown: () => void;
  onAskError: (err: unknown) => void;
}): { handle: (e: { preventDefault: () => void }) => void; isShuttingDown: () => boolean } {
  let shuttingDown = false;
  return {
    handle(e) {
      e.preventDefault();
      if (shuttingDown) return;
      if (deps.gate.check() === 'hold') {
        deps.gate.ask().then((yes) => {
          if (yes) deps.quit();
        }, deps.onAskError);
        return;
      }
      shuttingDown = true;
      deps.shutdown();
    },
    isShuttingDown: () => shuttingDown,
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
