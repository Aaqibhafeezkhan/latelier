import type { IpcMain } from 'electron';
import type { Envelope } from '@shared/ipc';
import type { Logger } from '../log.ts';
import type { SenderCheck } from './senderGuard.ts';
import { success, toIpcError } from './envelope.ts';
import { classifyIfDriverError } from '../mongo/errors.ts';

export type Validator<I> = (payload: unknown) => I;
export type Handler<I, O> = (input: I) => Promise<O> | O;

/**
 * Receives every validated invocation once its envelope is settled. Decides
 * for itself whether the channel is audited, and returns the id of the entry
 * it wrote when that entry is Reversible (null otherwise). May throw; the
 * router logs that and returns the envelope unchanged.
 */
export interface AuditSink {
  record(
    channel: string,
    input: unknown,
    envelope: Envelope<unknown>,
    startedAt: number,
    durationMs: number,
    /** What the handler threw, when the envelope is an error — the only place an Undo capture riding a failure can be read. */
    thrown?: unknown,
  ): string | null;
}

export interface RegisterOptions {
  /**
   * The handler decides what of this channel's traffic reaches the log (as
   * `app:log` does with its rate gate), so the router writes neither the
   * request line nor the success line, and its error line carries no request
   * summary. Otherwise a renderer calling in a loop would write one ungated
   * line per call around a gate that drops the call itself.
   */
  quiet?: boolean;
}

export interface Router {
  register<I, O>(
    channel: string,
    validate: Validator<I>,
    handler: Handler<I, O>,
    opts?: RegisterOptions,
  ): void;
}

const MAX_LOGGED_FIELD_LEN = 200;

/**
 * Stringify-and-truncate to a fixed length so a long EJSON filter or a
 * multi-stage aggregation pipeline doesn't bloat the log line. Strings pass
 * through as-is and get character-sliced; arrays / objects (e.g. the
 * Aggregation `stages: Stage[]` payload) are JSON.stringified first, then
 * sliced.
 */
function compactField(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  let str: string;
  if (typeof v === 'string') {
    str = v;
  } else if (typeof v === 'object') {
    try {
      str = JSON.stringify(v);
    } catch {
      return '[unserializable]';
    }
  } else {
    return v;
  }
  return str.length > MAX_LOGGED_FIELD_LEN
    ? `${str.slice(0, MAX_LOGGED_FIELD_LEN)}…(+${str.length - MAX_LOGGED_FIELD_LEN})`
    : str;
}

/**
 * Compact summary of a request payload — surfaces DB-routing fields
 * (connection / db / collection) and the few inputs that matter for
 * diagnosing pagination or filter issues without dumping the whole
 * envelope. Filter / sort / projection / aggregation stages get
 * stringified-and-truncated; the full payload is still available at debug
 * level via ipc.req.
 */
function summarizeRequest(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['connectionId', 'dbName', 'collection', 'kind', 'limit',
                     'skip', 'page', 'pageSize', 'verbosity']) {
    if (key in obj) out[key] = obj[key];
  }
  for (const key of ['filter', 'sort', 'projection', 'stages']) {
    if (key in obj) out[key] = compactField(obj[key]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Answer to an `invoke` that did not come from the app's own document. It is an
 * ordinary `Envelope`, so a caller that somehow reaches this sees a failure it
 * can switch on rather than a hang.
 *
 * `UNTRUSTED_SENDER` rather than `UNAUTHORIZED` on purpose — the renderer
 * already reads `UNAUTHORIZED` as "your MongoDB user lacks permission", and
 * sending someone to check their database grants over a message that never came
 * from the app would be actively misleading.
 */
const DENIED: Envelope<never> = {
  ok: false,
  error: { code: 'UNTRUSTED_SENDER', message: 'IPC request from an untrusted sender' },
};

/**
 * `isTrustedSender` is required, not optional. A security check with a default
 * is a check that can be dropped from production wiring while every test stays
 * green; making it a parameter means omitting it does not compile.
 */
export function createRouter(
  ipcMain: Pick<IpcMain, 'handle'>,
  isTrustedSender: SenderCheck,
  log?: Logger,
  audit?: AuditSink,
): Router {
  return {
    register<I, O>(
      channel: string,
      validate: Validator<I>,
      handler: Handler<I, O>,
      opts: RegisterOptions = {},
    ): void {
      const quiet = opts.quiet === true;
      ipcMain.handle(channel, async (evt, raw: unknown): Promise<Envelope<O>> => {
        // Before anything else — before the payload is even logged, since an
        // untrusted payload is not ours to write down.
        if (!isTrustedSender(evt)) {
          log?.warn('ipc.denied', channel, { url: evt.senderFrame?.url });
          return DENIED;
        }
        const t0 = Date.now();
        // Full input goes to debug so production (info) stays terse but a
        // developer can flip the log level for a fine-grained trace of every
        // DB request — including the filter / sort / projection that was
        // actually sent to MongoDB.
        if (!quiet) log?.debug('ipc.req', channel, { input: raw });
        // Set only once validation passes: a payload that fails its schema
        // never reached a server, and has no trustworthy namespace to record.
        let validated: { input: I } | null = null;
        let envelope: Envelope<O>;
        let durationMs: number;
        let thrown: unknown;
        try {
          const input = validate(raw);
          validated = { input };
          const data = await handler(input);
          durationMs = Date.now() - t0;
          if (!quiet) {
            log?.info('ipc.ok', channel, {
              durationMs,
              req: summarizeRequest(raw),
            });
          }
          envelope = success<O>(data);
        } catch (err) {
          durationMs = Date.now() - t0;
          thrown = err;
          // Services classify their own driver errors, and the envelope only
          // knows `AppError`. A service that forgets leaves `toIpcError` with
          // a bare driver error to label `INTERNAL`, which is a wrong code
          // rather than a missing one — nothing fails, the renderer just
          // stops being able to tell a timeout from a bug. Classifying here
          // makes that unforgettable; anything that is not a driver error
          // passes through and still reads as `INTERNAL`.
          const ipcErr = toIpcError(classifyIfDriverError(err));
          log?.error('ipc.err', channel, {
            durationMs,
            code: ipcErr.code,
            message: ipcErr.message,
            req: quiet ? undefined : summarizeRequest(raw),
          });
          envelope = { ok: false, error: ipcErr };
        }
        // Outside the try above on purpose: an audit write that throws must
        // not turn a completed Operation into an error envelope. The entry is
        // lost and the Operation's result stands (ADR 0002).
        if (audit && validated) {
          try {
            const auditId = audit.record(channel, validated.input, envelope, t0, durationMs, thrown);
            // Handing back the entry id is what lets the renderer offer Undo.
            // Only a Reversible entry has one, and every audited channel
            // resolves to an object.
            if (auditId !== null && envelope.ok) {
              envelope = success({ ...(envelope.data as object), auditId } as O);
            }
          } catch (err) {
            log?.error('audit.write', channel, { message: toIpcError(err).message });
          }
        }
        return envelope;
      });
    },
  };
}
