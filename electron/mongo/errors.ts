import type { ProbeErrorCode } from '@shared/types';
import { AppError, ConflictError, NotFoundError, SystemError, ValidationError } from '../errors.ts';
import { ejsonEncode } from './ejson.ts';

/**
 * The one place a raw `mongodb` driver error becomes an `AppError`. Every
 * mongo service routes its catch block through this, so a given driver code
 * reaches the renderer as the same app code regardless of which operation
 * (or which document/admin/index/user call) produced it.
 *
 * `extraDetails` merges into the classified error's `details` — the one
 * caller-specific addition callers need is `insertMany`'s partial-insert
 * `insertedCount` (see `DocumentService.insertMany`), threaded through
 * rather than duplicating the classification logic per caller.
 */
/**
 * True for an error thrown by the `mongodb` driver. Every error class it
 * exports is named `Mongo…` (`MongoServerError`, `MongoNetworkError`,
 * `MongoOperationTimeoutError`, …), which is the only marker they all share —
 * `code` and `codeName` are absent on several of them.
 */
function isDriverError(err: unknown): boolean {
  // Stryker disable next-line OptionalChaining: this function's only caller (classifyIfDriverError) wraps the call in a try/catch that returns `err` unchanged on any throw — the same outcome the ternary's else branch already returns for a non-driver-error err, so dropping the `?.` and letting a null/undefined err throw here is unobservable through that caller.
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.startsWith('Mongo');
}

/**
 * The backstop at the IPC boundary, for a driver error that reached the router
 * without a service having classified it.
 *
 * Classification is a call each service has to remember, and one it can forget:
 * `QueryService.count`/`findOne`/`explain` all did, so a `MaxTimeMSExpired`
 * from a count arrived at `toIpcError` as a bare `Error` and left it as
 * `INTERNAL`. Every such omission is a silent one — the envelope still has a
 * code, just the wrong code.
 *
 * Deliberately narrow. A blanket classify here would be worse than the gap it
 * closes: `classifyMongoOpError` ends in `MONGO_ERROR`, so a `TypeError` from
 * a real bug in our own code would be relabelled as a database problem.
 * Anything that is not a driver error is passed through untouched to stay
 * `INTERNAL`, which is what an unexpected throw should look like.
 *
 * Non-throwing, and that is load-bearing rather than defensive habit. A thrown
 * value is not necessarily a well-behaved object: `instanceof` runs a Proxy's
 * `getPrototypeOf` trap, reading `name` runs whatever getter is on the value,
 * and `classifyMongoOpError` goes on to read `code`, `codeName` and `message`
 * the same way. Any of those can throw. This runs at the IPC boundary, where
 * `toIpcError` is already wrapped for exactly that reason — classifying in
 * front of it without the same protection put the read *outside* the envelope's
 * guard, and a hostile thrown value made the registered handler reject instead
 * of returning `{ ok: false, error }`. Probed both ways, through the real
 * router: a Proxy whose `getPrototypeOf` throws, and a plain object with a
 * throwing `name` getter.
 *
 * Classification is an improvement to the error's *code*. It must never cost
 * the envelope, so a failure here hands back the original value and lets
 * `toIpcError` — which handles anything — have the last word.
 */
export function classifyIfDriverError(err: unknown): unknown {
  try {
    // Stryker disable next-line ConditionalExpression: dropping this early return still reaches the same outcome for every AppError — either isDriverError(err) is false and the ternary's else branch returns err unchanged, or it's true and classifyMongoOpError's own `if (err instanceof AppError) return err;` (its very first line) returns err unchanged instead. Every AppError instance satisfies that nested guard by definition, so this one is redundant with it (see mongo-errors.spec.ts's classifyIfDriverError describe block for the two routes this documents).
    if (err instanceof AppError) return err;
    return isDriverError(err) ? classifyMongoOpError(err) : err;
  } catch {
    return err;
  }
}

/**
 * Whether a driver error is the server refusing an operation that outran its
 * `maxTimeMS`. Separate from classification because two call sites branch on
 * it to retry with a cheaper question rather than to build an `AppError`.
 */
export function isMaxTimeMSExpired(err: unknown): boolean {
  return (err as { codeName?: unknown } | null)?.codeName === 'MaxTimeMSExpired';
}

export function classifyMongoOpError(
  err: unknown,
  extraDetails?: Record<string, unknown>,
): AppError {
  if (err instanceof AppError) return err;
  const e = err as {
    codeName?: string;
    code?: number;
    message?: string;
    name?: string;
    errInfo?: unknown;
  };
  const msg = e.message ?? String(err);
  const withExtra = (details?: Record<string, unknown>): Record<string, unknown> | undefined =>
    extraDetails ? { ...details, ...extraDetails } : details;

  if (e.codeName === 'MaxTimeMSExpired') return new SystemError('TIMEOUT', msg, withExtra());
  if (e.name === 'MongoNetworkError' || e.name === 'MongoNetworkTimeoutError') {
    return new SystemError('NETWORK', msg, withExtra());
  }
  if (e.codeName === 'Unauthorized' || e.code === 13) {
    return new SystemError('UNAUTHORIZED', msg, withExtra());
  }
  if (e.code === 2 || e.codeName === 'BadValue') {
    return new ValidationError(msg, withExtra({ mongoMessage: msg }));
  }
  if (
    e.code === 85 ||
    e.code === 86 ||
    e.codeName === 'IndexOptionsConflict' ||
    e.codeName === 'IndexKeySpecsConflict'
  ) {
    return new SystemError('CONFLICT', msg, withExtra());
  }
  if (e.code === 27 || e.codeName === 'IndexNotFound') {
    return new SystemError('NOT_FOUND', msg, withExtra());
  }
  if (e.code === 11 || e.codeName === 'UserNotFound') {
    return new SystemError('NOT_FOUND', msg, withExtra());
  }
  if (
    e.code === 51003 ||
    e.code === 51002 ||
    e.codeName === 'UserAlreadyExists' ||
    e.codeName === 'RoleAlreadyExists'
  ) {
    return new SystemError('CONFLICT', msg, withExtra());
  }
  if (e.code === 31 || e.codeName === 'RoleNotFound') {
    return new ValidationError(msg, withExtra({ mongoMessage: msg }));
  }
  // Duplicate key (E11000) — document/insertMany writes only.
  if (e.code === 11000) {
    return new ConflictError(msg, withExtra({ mongoCode: 11000 }));
  }
  // Schema validator rejection — document/insertMany writes only. Keyed on
  // the numeric code because mongod sends 121 with no `codeName` at all,
  // the same way it reports a duplicate key; matching only the name left
  // this branch unreachable and every validator rejection a MONGO_ERROR.
  // `errInfo` carries which rule failed, so it is worth passing on — but it
  // arrives as live BSON (`failingDocumentId` is an ObjectId wrapping a
  // Buffer, and `consideredValue` holds the offending value at whatever type
  // it had), and everything crossing IPC is Extended JSON v2. Encode it here
  // rather than at the one eventual reader, so no consumer can receive the
  // raw shape.
  if (e.code === 121 || e.codeName === 'DocumentValidationFailure') {
    return new ValidationError(
      msg,
      withExtra({
        mongoCode: 121,
        ...(e.errInfo !== undefined ? { errInfo: ejsonEncode(e.errInfo) } : {}),
      }),
    );
  }
  // renameCollection/createCollection: existing target, missing source.
  if (e.code === 48 || e.codeName === 'NamespaceExists') {
    return new ConflictError(msg, withExtra({ mongoMessage: msg }));
  }
  if (e.code === 26 || e.codeName === 'NamespaceNotFound') {
    return new NotFoundError(msg, withExtra({ mongoMessage: msg }));
  }
  return new SystemError('MONGO_ERROR', msg, withExtra());
}


export const SECRET_UNREADABLE_MESSAGE =
  "This connection's saved password can't be read on this install. Re-enter it.";

export const KEYCHAIN_BLOCKED_MESSAGE =
  'macOS blocked access to this app\'s saved passwords. Quit and reopen L\'Atelier, then click "Always Allow" when macOS asks.';

/**
 * Classify a raw error thrown by the `mongodb` driver (or surrounding I/O)
 * into a coarse category useful for the renderer banner.
 */
export function classifyMongoError(
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): {
  code: ProbeErrorCode;
  message: string;
} {
  if (err === null || err === undefined) {
    return { code: 'UNKNOWN', message: 'unknown error' };
  }
  // The vault threw before any client existed: the stored secret belongs to
  // another install (or a reset keychain), which no retry can fix.
  if (err instanceof AppError && err.code === 'SECRET_DECRYPT_FAILED') {
    // Denying the macOS keychain prompt leaves encryption unavailable for the
    // rest of the process; only a relaunch can ask again.
    const details = err.details as { encryptionAvailable?: unknown } | undefined;
    if (platform === 'darwin' && details?.encryptionAvailable === false) {
      return { code: 'KEYCHAIN_BLOCKED', message: KEYCHAIN_BLOCKED_MESSAGE };
    }
    return { code: 'SECRET_UNREADABLE', message: SECRET_UNREADABLE_MESSAGE };
  }
  const e = err as {
    name?: string;
    code?: number | string;
    codeName?: string;
    message?: string;
  };

  // Stryker disable next-line StringLiteral: `name` is only ever read through `=== 'MongoServerSelectionError'` below — no default string this fallback could hold will collide with that literal, so its exact value is unobservable.
  const name = e.name ?? '';
  // Stryker disable next-line StringLiteral: `codeName` is only ever read through `=== 'AuthenticationFailed'/'Unauthorized'/'MaxTimeMSExpired'` below — same reasoning as `name` just above.
  const codeName = (e.codeName ?? '').toString();
  const mongoCode = e.code;
  const msg = e.message ?? String(err);

  // Authentication
  if (
    mongoCode === 18 ||
    codeName === 'AuthenticationFailed' ||
    /Authentication failed|auth(entication)? fail/i.test(msg)
  ) {
    return { code: 'AUTH', message: msg };
  }

  // Authorization
  if (mongoCode === 13 || codeName === 'Unauthorized' || /not authorized/i.test(msg)) {
    return { code: 'UNAUTHORIZED', message: msg };
  }

  // TLS handshake (server didn't speak TLS on the port we tried). Checked
  // before TIMEOUT / NETWORK because the driver wraps these as either a
  // selection error or a raw socket error depending on timing.
  if (
    /Client network socket disconnected before secure TLS connection was established/i.test(msg) ||
    /TLS handshake/i.test(msg) ||
    /SSL.*handshake/i.test(msg)
  ) {
    return { code: 'TLS_HANDSHAKE', message: msg };
  }

  // Selection timeout
  if (name === 'MongoServerSelectionError' || codeName === 'MaxTimeMSExpired') {
    return { code: 'TIMEOUT', message: msg };
  }

  // Network
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|ETIMEDOUT/.test(msg)) {
    return { code: 'NETWORK', message: msg };
  }

  // TLS (certificate-level verification failures)
  //
  // The `name === 'MongoNetworkError'` conjunct this used to OR in here was
  // dead: /SSL|TLS/ is a strict sub-alternation of the pattern below (which
  // already has an `SSL|TLS` branch of its own), so whenever the conjunct's
  // own regex matched, the pattern below already had too — fuzzed 500k random
  // strings against both with zero counterexamples. Removed rather than
  // annotated, since a real (name, regex) pair is otherwise easy to misread
  // as load-bearing.
  if (/SSL|TLS|certificate|self[- ]signed|unable to verify/i.test(msg)) {
    return { code: 'TLS', message: msg };
  }

  return { code: 'UNKNOWN', message: msg };
}
