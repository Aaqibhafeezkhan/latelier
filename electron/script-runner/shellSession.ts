import { PassThrough } from 'node:stream';
import * as repl from 'node:repl';
import { inspect, types } from 'node:util';
import type { Context } from 'node:vm';
import { ejsonStringifyRelaxed } from '../mongo/ejson.ts';
import type { Channel } from './channel.ts';
import type { RpcClient } from './rpcClient.ts';
import { isShellInput, type ShellStartRequest } from './shellProtocol.ts';

/**
 * A shell session's REPL, running in the runner child. `repl.start` reads from
 * and writes to in-memory streams; main feeds the input stream with
 * `shell-in` messages and forwards what the output stream produces. The
 * session's `db` is the same RPC facade a script gets, so the REPL holds no
 * client and no credentials either: a `require('child_process')` typed here
 * reaches this process and nothing of main's.
 *
 * Runs under Electron's utilityProcess and Node's type stripping (see
 * `runner.ts`), so no enums, no parameter properties, no runtime path aliases.
 */
export function startShellSession(channel: Channel, rpc: RpcClient, req: ShellStartRequest): void {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => channel.post({ type: 'shell-out', data: chunk }));

  // `use foo` swaps this without rebuilding the `db` proxy.
  const ctx = { currentDb: req.dbName };
  const db = rpc.makeDb(ctx);

  // Before the REPL starts: it writes its own first prompt as it starts.
  stdout.write(`${req.banner}\n`);

  const server = repl.start({
    prompt: `${ctx.currentDb}> `,
    input: stdin,
    output: stdout,
    terminal: false,
    useColors: false,
    ignoreUndefined: true,
    // A cursor and a collection print their one-line hint; EJSON would print a
    // collection (an empty proxy) as `{}`, which reads as an empty result.
    writer: (value: unknown) =>
      rpc.isCursor(value) || rpc.isCollection(value) ? inspect(value) : shellWriter(value),
  });
  // Tell main each time the REPL is ready for another line, so it can tell a
  // line still waiting on its result from an idle shell. The prompt the REPL
  // printed while starting (above) is not counted: main has written no line yet.
  const baseDisplayPrompt = server.displayPrompt;
  server.displayPrompt = (preserveCursor?: boolean) => {
    baseDisplayPrompt.call(server, preserveCursor);
    channel.post({ type: 'shell-prompt' });
  };
  // Node's REPL prints a top-level Promise as it is and only awaits an
  // explicit `await`. A query call is always async here, so settle a thenable
  // result before it reaches the writer. Input is not paused meanwhile: a
  // result that never arrives leaves later commands working, and one that
  // arrives late prints after them.
  // The default evaluator is not exported, so wrap the one the REPL holds.
  // `eval` is typed read-only, but the REPL calls `this.eval` for every line.
  const baseEval = server.eval;
  (server as { eval: repl.REPLEval }).eval = (cmd, context, file, done) => {
    baseEval.call(server, cmd, context, file, (err, result) => {
      if (err !== null) return done(err, result);
      let thenable: boolean;
      try {
        thenable = typeof (result as { then?: unknown } | null | undefined)?.then === 'function';
      } catch (probeError) {
        // A throwing `then` getter fails this command only, never the session.
        return done(probeError as Error, undefined);
      }
      if (!thenable) return done(null, result);
      // The REPL prefixes each line with the earlier lines of a multi-line
      // command and clears them only when it finishes, which is now later:
      // clear them here, or every command typed meanwhile is glued onto this one.
      server.clearBufferedCommand();
      // `Promise.resolve` adopts the thenable once, so one that settles twice
      // cannot print twice. A falsy reason would read as success to the REPL.
      Promise.resolve(result).then(
        (value) => done(null, value),
        (reason) => done(reason || new Error(`Promise rejected with ${inspect(reason)}`), undefined),
      );
    });
  };
  // The REPL's `.clear` builds a fresh context and drops everything on the old
  // one, so the helpers go in through a function that runs again on 'reset'.
  // `db` and `ctx` live outside the context, so the current database survives.
  const installHelpers = (context: Context): void => {
    context.db = db;
    context.use = (name: string) => {
      ctx.currentDb = name;
      server.setPrompt(`${name}> `);
      return `switched to db ${name}`;
    };
    context.help = help;
    // Mongosh-style `show ...` sugar (rewritten in main). Returned values flow
    // through the standard REPL writer, so they are formatted like any query.
    context.__shellShow = async (kind: 'dbs' | 'collections'): Promise<string> => {
      if (kind === 'dbs') {
        // `authorizedDatabases: true` lets users with scoped roles (Atlas
        // read-only, per-db users) see the dbs they have access to even when
        // they lack the cluster-wide listDatabases privilege.
        const admin = rpc.makeDb({ currentDb: 'admin' }) as {
          runCommand(cmd: object): Promise<{ databases: Array<{ name: string; sizeOnDisk?: number }> }>;
        };
        const r = await admin.runCommand({ listDatabases: 1, authorizedDatabases: true });
        return r.databases.map((d) => `${d.name}\t${d.sizeOnDisk ?? 0}`).join('\n');
      }
      const cursor = (db as { listCollections(): { toArray(): Promise<Array<{ name: string }>> } }).listCollections();
      return (await cursor.toArray()).map((c) => c.name).join('\n');
    };
  };
  installHelpers(server.context);
  server.on('reset', installHelpers);

  // A user's own un-awaited rejection must not take the session down.
  process.on('unhandledRejection', (reason) => {
    const message = (reason as { message?: unknown } | null)?.message;
    stdout.write(`Uncaught: ${typeof message === 'string' ? message : String(reason)}\n`);
  });

  server.on('exit', () => channel.post({ type: 'shell-exit' }));
  channel.onMessage((message) => {
    if (isShellInput(message)) stdin.write(message.data);
  });
}

function shellWriter(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  // EJSON returns undefined for values it can't serialize (e.g. plain
  // functions, including the `db` proxy). Fall through to util.inspect so
  // typing `db` still produces something readable.
  try {
    // An Error has no enumerable fields, so EJSON would print `{}`: the REPL
    // routes every thrown error through this writer. `isNativeError` also
    // holds for an error made in the REPL's own vm context.
    if (types.isNativeError(value)) return errorText(value);
    const ejson = ejsonStringifyRelaxed(flattenErrors(value, new WeakSet()), 2);
    if (typeof ejson === 'string') return ejson;
  } catch {
    // fall through
  }
  return inspect(value, { depth: 4, colors: false });
}

/**
 * An error's one-line `name: message`, then what else tells the user why: an
 * AggregateError's members, and the `details` an error rebuilt from the wire
 * carries (a document-validation failure keeps which rule failed there). No
 * stack: its frames are the runner's, not the user's.
 */
function errorText(err: Error): string {
  const lines = [Error.prototype.toString.call(err)];
  const { errors, details } = err as { errors?: unknown; details?: unknown };
  if (Array.isArray(errors)) {
    for (const member of errors) {
      lines.push(`  ${types.isNativeError(member) ? Error.prototype.toString.call(member) : inspect(member, { depth: 0 })}`);
    }
  }
  if (details !== undefined) {
    try {
      const text = ejsonStringifyRelaxed(details, 2);
      if (text !== undefined) lines.push(text);
    } catch {
      // Details that cannot be printed (a cycle) are left out; the one-line form still tells the user what failed.
    }
  }
  return lines.join('\n');
}

/**
 * `value` with each Error inside plain objects and arrays replaced by its
 * one-line text, since EJSON would print every one as `{}`. A value without
 * an Error comes back as is. `path` guards against a cycle on the way down
 * only, so an error that appears twice is replaced both times.
 */
function flattenErrors(value: unknown, path: WeakSet<object>): unknown {
  if (types.isNativeError(value)) return Error.prototype.toString.call(value);
  if (typeof value !== 'object' || value === null || path.has(value)) return value;
  // A plain object's prototype is some realm's Object.prototype, so the one
  // above it is null; this holds for objects made in the REPL's vm context too.
  const proto = Object.getPrototypeOf(value) as object | null;
  const isArray = Array.isArray(value);
  if (!isArray && proto !== null && Object.getPrototypeOf(proto) !== null) return value;
  path.add(value);
  try {
    const keys = isArray ? [] : Object.keys(value);
    const children = isArray ? [...(value as unknown[])] : keys.map((key) => (value as Record<string, unknown>)[key]);
    const flat = children.map((child) => flattenErrors(child, path));
    if (flat.every((child, i) => child === children[i])) return value;
    // `fromEntries` defines own properties, so a `__proto__` key cannot reach the prototype.
    return isArray ? flat : Object.fromEntries(keys.map((key, i) => [key, flat[i]]));
  } finally {
    path.delete(value);
  }
}

function help(): string {
  return [
    "L'Atelier shell: a Node REPL with a Mongo driver context, run in its own process.",
    '',
    '  db                          — current database (use("name") to switch)',
    '  db.<coll>.find(filter, opt) — returns a cursor (call .toArray())',
    '  db.<coll>.findOne(filter)',
    '  db.<coll>.insertOne(doc)',
    '  db.<coll>.updateOne(filter, update)',
    '  db.<coll>.deleteOne(filter)',
    '  db.<coll>.countDocuments(filter)',
    '  db.<coll>.aggregate(pipeline).toArray()',
    '  db.runCommand({ ping: 1 })',
    '  show dbs / show collections',
    '',
    'All async ops can be awaited at the top level.',
  ].join('\n');
}
