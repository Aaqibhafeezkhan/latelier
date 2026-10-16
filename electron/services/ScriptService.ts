import type { MongoClient } from 'mongodb';
import type { ScriptRunInput, ScriptRunResultWire } from '@shared/types';
import {
  ConflictError,
  ReadOnlyConnectionError,
  SystemError,
  ValidationError,
  type AppError,
} from '../errors.ts';
import type { Logger } from '../log.ts';
import type { MongoPool } from '../mongo/MongoPool.ts';
import {
  fromWireError,
  isRunnerMessage,
  type RunRequest,
} from '../script-runner/protocol.ts';
import { createRpcHost } from '../script-runner/rpcHost.ts';
import type { RunnerHandle, RunnerSpawner } from './runner/spawner.ts';

const DEFAULT_MAX_TIME_MS = 60_000;

export interface ScriptServiceOpts {
  pool: MongoPool;
  spawner: RunnerSpawner;
  logger?: Logger;
}

/** One in-flight script: the connection it runs on and how to stop it. */
interface Run {
  connectionId: string;
  ctrl: AbortController;
  /** Why the run was stopped, when that is not a plain cancel. */
  stopReason?: AppError;
}

/**
 * Orchestrator for the W12 script editor. The script itself runs in a separate
 * process (`electron/script-runner/runner.ts`), one per `run()`: main posts the
 * request, waits for one message back, and kills the process on timeout,
 * cancel, or app quit. A script that never yields can therefore only ever
 * stall its own process, never the main one.
 *
 * The runner holds no database client and no credentials. Its `db` sends every
 * call back as an RPC frame, and `rpcHost` executes it here over the pool's own
 * client, through the read-only guard, with the flag read live from the
 * connection. That is what makes read-only a property of main rather than of
 * the script's process.
 *
 * Main also keeps the pieces that must survive a runner: the cancel-token
 * bookkeeping, the connect pre-flight (clean connect errors, connection status
 * events) and the wall-clock timer.
 */
export class ScriptService {
  private readonly pool: MongoPool;
  private readonly spawner: RunnerSpawner;
  private readonly active = new Map<string, AbortController>();
  private readonly runs = new Set<Run>();
  private readonly live = new Set<RunnerHandle>();
  private readonly logger?: Logger;

  constructor(opts: ScriptServiceOpts) {
    this.pool = opts.pool;
    this.spawner = opts.spawner;
    this.logger = opts.logger;
    // Every call a script makes already goes through main, which reads the
    // read-only flag live, so a flip refuses the next write by itself. These
    // relays stop the run outright on top of that: a script that was started
    // on a connection that has since gone read-only, or away (Disconnect,
    // Cancel, delete, a host edit), should not carry on.
    //
    // The 'disconnected' status also comes from MongoPool.markConnectionLost:
    // when main's own client sees no known servers for the loss grace window,
    // running scripts are killed with DB_ERROR. That is deliberate and
    // fail-closed (the deployment is unreachable, so a script on it is
    // suspect); do not narrow this to user-initiated disconnects.
    this.pool.on('read-only-enabled', (id: string) =>
      this.stopForConnection(
        id,
        new ReadOnlyConnectionError(
          'Connection was set to read-only while the script was running; the script was stopped.',
        ),
      ),
    );
    this.pool.on('status', (runtime: { id: string; status: string }) => {
      if (runtime.status !== 'disconnected') return;
      this.stopForConnection(
        runtime.id,
        new SystemError(
          'DB_ERROR',
          'Connection was disconnected while the script was running; the script was stopped.',
        ),
      );
    });
  }

  async run(input: ScriptRunInput): Promise<ScriptRunResultWire> {
    if (typeof input.source !== 'string') {
      throw new ValidationError('source must be a string', { field: 'source' });
    }
    if (input.source.length > 1_000_000) {
      throw new ValidationError('source exceeds 1 MB', { field: 'source' });
    }

    const maxTimeMs = clampTimeout(input.maxTimeMs ?? DEFAULT_MAX_TIME_MS);

    // Register the cancel token BEFORE awaiting the pool — otherwise a hung
    // connect would be uncancelable because the controller isn't in `active`
    // yet when `cancel(token)` looks it up.
    //
    // A token is meant to name one cancelable run (the renderer mints a
    // fresh `crypto.randomUUID()` per Run click — see ScriptTab.tsx). If a
    // caller reuses a token that's still in flight, `active.set` would
    // silently clobber the earlier AbortController and `cancel(token)`
    // would only ever reach the newer run, orphaning the first one for up
    // to the 24h maxTimeMs ceiling. Reject the duplicate up front instead —
    // cheaper and more honest than tracking multiple controllers per token.
    //
    // The entry stays in `active` until ITS OWN run's cleanup removes it —
    // `cancel(token)` only aborts, it does not delete. Deleting on cancel
    // would let a same-token run() fired immediately after reuse the token
    // while the cancelled run is still unwinding; that run's own cleanup
    // would then delete the new run's controller out from under it,
    // silently uncancelable. `releaseToken` below only deletes when the map
    // still holds this run's own controller.
    const run: Run = { connectionId: input.connectionId, ctrl: new AbortController() };
    if (input.cancelToken) {
      if (this.active.has(input.cancelToken)) {
        throw new ConflictError(
          `cancelToken '${input.cancelToken}' is already in use by an in-flight script`,
          { field: 'cancelToken' },
        );
      }
      this.active.set(input.cancelToken, run.ctrl);
    }
    this.runs.add(run);

    try {
      // Connect in main first so connect failures surface as clean errors
      // before any process is spawned, and so the connection's status events
      // fire as they always have. If the user cancels during this phase, the
      // controller is already wired and `aborted` is checked in the catch.
      let client: MongoClient;
      try {
        client = await this.pool.readClient(input.connectionId);
      } catch (err) {
        if (run.ctrl.signal.aborted) throw stopError(run);
        throw err;
      }
      if (run.ctrl.signal.aborted) throw stopError(run);

      const dbName = this.pool.resolveDbName(input.connectionId, input.dbName);
      return await this.runInChild(run, client, input, dbName, maxTimeMs);
    } finally {
      this.runs.delete(run);
      if (input.cancelToken) this.releaseToken(input.cancelToken, run.ctrl);
    }
  }

  /**
   * Spawn the runner, hand it the request, answer its database calls, and
   * settle on the first of: its result, its exit, the wall clock, or an abort.
   * Every path kills the process and ends the host (aborting its in-flight
   * driver work and closing its cursors); whatever arrives after settling is
   * ignored.
   */
  private runInChild(
    run: Run,
    client: MongoClient,
    input: ScriptRunInput,
    dbName: string,
    maxTimeMs: number,
  ): Promise<ScriptRunResultWire> {
    return new Promise<ScriptRunResultWire>((resolve, reject) => {
      const handle = this.spawner.spawn();
      this.live.add(handle);
      let settled = false;

      // Its own controller: a timeout kills the child without ever aborting
      // `run.ctrl`, and the driver work already started for it must stop too.
      const hostCtrl = new AbortController();
      const host = createRpcHost({
        client,
        isReadOnly: () => this.pool.isReadOnly(run.connectionId),
        signal: hostCtrl.signal,
        onCloseError: (err) =>
          this.logger?.warn('script', 'closing a script cursor failed', { error: String(err) }),
      });

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.ctrl.signal.removeEventListener('abort', onAbort);
        handle.kill();
        // Close first so the close commands go out before the abort reaches them.
        void host.close().finally(() => hostCtrl.abort());
        finish();
      };
      const onAbort = (): void => settle(() => reject(stopError(run)));

      // The timer covers the whole child: spawn, connect, run and encode.
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new SystemError(
                'TIMEOUT',
                `script exceeded ${maxTimeMs}ms (cancel and rerun, or raise the limit)`,
              ),
            ),
          ),
        maxTimeMs,
      );
      run.ctrl.signal.addEventListener('abort', onAbort, { once: true });

      handle.onMessage((message) => {
        if (!isRunnerMessage(message)) {
          settle(() => reject(new SystemError('INTERNAL', 'script runner sent a malformed message')));
        } else if (message.type === 'rpc') {
          void host
            .handle(message)
            .then((reply) => {
              // A reply for a run that already ended has nowhere to go.
              if (!settled) handle.postMessage(reply);
            })
            .catch((err: unknown) =>
              settle(() =>
                reject(new SystemError('INTERNAL', `could not answer the script runner: ${String(err)}`)),
              ),
            );
        } else if (message.type === 'result') {
          settle(() =>
            resolve({
              valueJson: message.valueJson,
              printBuffer: message.printBuffer,
              durationMs: message.durationMs,
            }),
          );
        } else {
          settle(() => reject(fromWireError(message.error)));
        }
      });
      handle.onExit((code) => {
        this.live.delete(handle);
        settle(() =>
          reject(
            new SystemError(
              'INTERNAL',
              `script runner exited unexpectedly (exit code ${code ?? 'none'})`,
            ),
          ),
        );
      });

      const request: RunRequest = {
        type: 'run',
        source: input.source,
        dbName,
        ejsonRelaxed: input.ejsonRelaxed ?? false,
      };
      handle.postMessage(request);
    });
  }

  cancel(token: string): void {
    this.active.get(token)?.abort();
  }

  /** Stop every in-flight script on `connectionId`, reporting `reason` as why. */
  private stopForConnection(connectionId: string, reason: AppError): void {
    for (const run of this.runs) {
      if (run.connectionId !== connectionId) continue;
      run.stopReason = reason;
      run.ctrl.abort();
    }
  }

  /**
   * Remove `token` from `active` only if it still maps to `ctrl` — i.e.
   * only if this run is still the token's owner. A cancelled run's cleanup
   * must not delete a different run's controller that reused the same
   * token while the cancelled run was unwinding.
   */
  private releaseToken(token: string, ctrl: AbortController): void {
    if (this.active.get(token) === ctrl) this.active.delete(token);
  }

  /** Scripts in flight, from the call until it settles. */
  runningCount(): number {
    return this.runs.size;
  }

  /** Stop all in-flight scripts and kill their processes. Wired to `app.before-quit`. */
  cancelAll(): void {
    for (const run of this.runs) run.ctrl.abort();
    this.active.clear();
    // A process that already answered but has not exited yet is not in `runs`.
    for (const handle of this.live) handle.kill();
    this.live.clear();
  }
}

function stopError(run: Run): AppError {
  return run.stopReason ?? new SystemError('TIMEOUT', 'script cancelled');
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_MAX_TIME_MS;
  // Hard ceiling at 24 h — the "no limit" knob in the UI maps here.
  return Math.min(Math.max(Math.floor(ms), 100), 24 * 60 * 60 * 1000);
}
