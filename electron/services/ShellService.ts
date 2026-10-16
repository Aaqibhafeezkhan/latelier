import { randomUUID } from 'node:crypto';
import type {
  ShellOutputEvent,
  ShellSessionInfo,
} from '@shared/types';
import { NotFoundError, ValidationError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { MongoPool } from '../mongo/MongoPool.ts';
import { createRpcHost } from '../script-runner/rpcHost.ts';
import {
  isShellMessage,
  type ShellInput,
  type ShellStartRequest,
} from '../script-runner/shellProtocol.ts';
import { isRunnerMessage } from '../script-runner/protocol.ts';
import type { RunnerSpawner } from './runner/spawner.ts';

type EmitFn = (event: ShellOutputEvent) => void;

export interface ShellServiceOpts {
  pool: MongoPool;
  spawner: RunnerSpawner;
  emit: EmitFn;
  log?: Logger;
}

interface Session {
  info: ShellSessionInfo;
  /** Ends the session: kills the child, closes its host, emits `exit`. Idempotent. */
  end: (reason?: string) => void;
  /** Resolves once the session has ended. */
  exited: Promise<void>;
  isExited: boolean;
  post: (message: ShellInput) => void;
  /** Lines written whose prompt has not come back yet: more than one when a late result is pending behind newer lines. */
  pending: number;
}

/**
 * Orchestrator for the W11 Mongo shell. The REPL itself runs in a runner child
 * (`electron/script-runner/shellSession.ts`), one long-lived process per
 * session, started through the same spawner and bundled entry the script
 * editor uses. Main keeps what must stay out of it:
 *
 *  - the connection: the child holds no client and no credentials, and its
 *    `db` sends every call back as an RPC frame that this service answers
 *    through an `rpcHost` over the pool's own client, with the read-only flag
 *    read live from the connection;
 *  - the input rewriting (`rewriteShellSugar`), applied before a line is
 *    posted;
 *  - the lifecycle: a session ends when it is stopped, when its connection
 *    disconnects or goes read-only, or when the app quits, and ending it kills
 *    the child and closes the host (which aborts in-flight work and closes its
 *    cursors). A child that dies on its own ends the session with an error
 *    event.
 *
 * Output reaches the renderer as `mshell:output-event`, unchanged.
 */
export class ShellService {
  private readonly pool: MongoPool;
  private readonly spawner: RunnerSpawner;
  private readonly emit: EmitFn;
  private readonly log?: Logger;
  private readonly sessions = new Map<string, Session>();
  private readonly byConnection = new Map<string, string>();

  constructor(opts: ShellServiceOpts) {
    this.pool = opts.pool;
    this.spawner = opts.spawner;
    this.emit = opts.emit;
    this.log = opts.log;
    // A session on a connection that has gone away must not outlive it. The
    // 'disconnected' status also comes from MongoPool.markConnectionLost
    // (fail-closed, like the script runs). And a session is unusable on a
    // read-only connection (ADR 0005), so the flip ends it outright rather
    // than leaving a REPL that only refuses.
    this.pool.on('status', (runtime: { id: string; status: string }) => {
      if (runtime.status === 'disconnected') {
        this.endForConnection(runtime.id, 'the connection was disconnected');
      }
    });
    this.pool.on('read-only-enabled', (id: string) =>
      this.endForConnection(id, 'the connection was set to read-only'),
    );
  }

  async start(input: { connectionId: string; dbName?: string }): Promise<ShellSessionInfo> {
    this.pool.assertWritable(input.connectionId);

    // One live session per connection. Reusing avoids zombie REPLs when a
    // user clicks the chrome toggle off/on rapidly.
    const existing = this.sessions.get(this.byConnection.get(input.connectionId) ?? '');
    if (existing && !existing.isExited) return existing.info;

    // Force a connect — MongoPool.readClient throws SystemError if the
    // connection can't be established. Do this before spawning anything so
    // the renderer sees a clean error instead of a half-initialised session.
    const client = await this.pool.readClient(input.connectionId);

    // The connect above yields, so a second start() for this connection may
    // have registered its session meanwhile.
    const raced = this.sessions.get(this.byConnection.get(input.connectionId) ?? '');
    if (raced && !raced.isExited) return raced.info;

    const dbName = this.pool.resolveDbName(input.connectionId, input.dbName);
    const sessionId = randomUUID();
    const info: ShellSessionInfo = {
      sessionId,
      connectionId: input.connectionId,
      dbName,
      startedAt: new Date().toISOString(),
    };

    const handle = this.spawner.spawn();
    // Its own controller: ending the session must stop driver work already
    // started for it, after the cursors are closed.
    const hostCtrl = new AbortController();
    const host = createRpcHost({
      client,
      isReadOnly: () => this.pool.isReadOnly(input.connectionId),
      signal: hostCtrl.signal,
      onCloseError: (err) =>
        this.log?.warn('mshell', 'closing a shell cursor failed', { error: String(err) }),
    });

    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => {
      resolveExit = r;
    });

    const session: Session = {
      info,
      isExited: false,
      pending: 0,
      exited,
      post: (message) => handle.postMessage(message),
      end: (reason) => {
        if (session.isExited) return;
        session.isExited = true;
        handle.kill();
        // Close first so the close commands go out before the abort reaches them.
        void host.close().finally(() => hostCtrl.abort());
        if (reason !== undefined) {
          this.emit({ sessionId, kind: 'stderr', data: `shell session ended: ${reason}\n` });
        }
        this.emit({ sessionId, kind: 'exit', exitCode: reason === undefined ? 0 : 1, signal: null });
        this.sessions.delete(sessionId);
        if (this.byConnection.get(input.connectionId) === sessionId) {
          this.byConnection.delete(input.connectionId);
        }
        resolveExit();
        this.log?.info('mshell', 'exited', { sessionId, reason });
      },
    };

    handle.onMessage((message) => {
      if (session.isExited) return;
      if (isShellMessage(message)) {
        if (message.type === 'shell-out') this.emit({ sessionId, kind: 'stdout', data: message.data });
        else if (message.type === 'shell-prompt') {
          session.pending = Math.max(0, session.pending - 1);
          this.emit({ sessionId, kind: 'prompt' });
        } else session.end();
      } else if (isRunnerMessage(message) && message.type === 'rpc') {
        void host
          .handle(message)
          .then((reply) => {
            // A reply for a session that already ended has nowhere to go.
            if (!session.isExited) handle.postMessage(reply);
          })
          .catch((err: unknown) =>
            session.end(`could not answer the shell process: ${String(err)}`),
          );
      } else {
        session.end('the shell process sent a malformed message');
      }
    });
    handle.onExit((code) => {
      // A kill from end() has already marked the session ended; this is the
      // child dying on its own.
      session.end(`the shell process exited unexpectedly (exit code ${code ?? 'none'})`);
    });

    this.sessions.set(sessionId, session);
    this.byConnection.set(input.connectionId, sessionId);
    this.log?.info('mshell', 'started', {
      sessionId,
      connectionId: input.connectionId,
    });

    const request: ShellStartRequest = {
      type: 'shell-start',
      dbName,
      banner:
        `L'Atelier shell (isolated process). Connected to ${input.connectionId}. ` +
        'Type help() for hints.',
    };
    handle.postMessage(request);

    return info;
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new NotFoundError(`shell session ${sessionId} not found`);
    if (s.isExited) throw new ValidationError('shell session has exited');
    // Re-checked on every write, not just at start() — a session already
    // open when the connection flips to read-only (conn:update) must not
    // keep its require/process escape hatch. Consistent with start()'s
    // wholesale refusal: the whole session is unusable read-only, not just
    // its writes, since the REPL can't reliably tell reads from writes.
    this.pool.assertWritable(s.info.connectionId);
    s.post({ type: 'shell-in', data: rewriteShellSugar(data) });
    s.pending += 1;
  }

  /** Sessions with a line still running. An idle shell is not counted. */
  busyCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.pending > 0) n += 1;
    return n;
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.isExited) return;
    s.end();
    await s.exited;
  }

  list(): ShellSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  /** Ends every session and kills its child. Wired to `app.before-quit`. */
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const s of all) s.end();
    await Promise.allSettled(all.map((s) => s.exited));
  }

  private endForConnection(connectionId: string, reason: string): void {
    const id = this.byConnection.get(connectionId);
    if (id !== undefined) this.sessions.get(id)?.end(reason);
  }
}

// ─── Input rewriting ────────────────────────────────────────────────────────

/**
 * Rewrite mongosh-style sugar to JS that Node's default REPL evaluator can
 * parse: `use foo` / `show dbs` / `show collections` and their aliases.
 *
 * `[ \t]*` (not `\s*`) so the trailing newline that delimits the REPL line
 * is preserved — without it, the REPL never sees a complete line and hangs.
 */
// `use foo`, `use "foo"`, `use 'foo';` — accept optional matching quotes
// and a trailing semicolon. The bare-name capture group rejects whitespace
// and quote characters so `use "foo` (unbalanced) doesn't slip through.
const SHELL_SUGAR: ReadonlyArray<readonly [RegExp, string]> = [
  [/^[ \t]*use[ \t]+"([^"\s]+)"[ \t]*(?:;[ \t]*)?$/m, 'use("$1")'],
  [/^[ \t]*use[ \t]+'([^'\s]+)'[ \t]*(?:;[ \t]*)?$/m, 'use("$1")'],
  [/^[ \t]*use[ \t]+([^\s"';]+)[ \t]*(?:;[ \t]*)?$/m, 'use("$1")'],
  [/^[ \t]*show[ \t]+(?:dbs|databases)[ \t]*(?:;[ \t]*)?$/m, 'await __shellShow("dbs")'],
  [/^[ \t]*show[ \t]+(?:collections|tables)[ \t]*(?:;[ \t]*)?$/m, 'await __shellShow("collections")'],
];

function rewriteShellSugar(line: string): string {
  return SHELL_SUGAR.reduce((acc, [re, sub]) => acc.replace(re, sub), line);
}
