import { api, getErrorMessage } from '../api/atelier';
import type { RendererLogInput, RendererLogSource } from '@shared/ipc';

// Main refuses a longer message or stack outright, so both are cut here
// rather than losing the whole line to the cap.
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;

let fallbackUsed = false;

/**
 * Sends one line to main's log file (`app:log`). Returns nothing and never
 * throws or rejects: it runs inside the global `error` and
 * `unhandledrejection` handlers, where a failure of its own would raise the
 * very event being handled and loop.
 */
export function logToMain(
  level: RendererLogInput['level'],
  message: string,
  source: RendererLogSource,
  stack?: string,
): void {
  try {
    // Built inside the try: a caller outside TypeScript's reach can pass a
    // value with no `slice`. `api` throws synchronously when the bridge is
    // missing; the call itself rejects when main refuses or is gone.
    const input: RendererLogInput = { level, message: message.slice(0, MAX_MESSAGE), source };
    if (stack !== undefined) input.stack = stack.slice(0, MAX_STACK);
    api.app.log(input).catch(fallBack);
  } catch (err) {
    fallBack(err);
  }
}

// When main cannot take the line, devtools is the only place left to say so.
// Once only, and through console.warn rather than logToMain: a bridge that
// stays broken would otherwise warn for every line, or feed itself.
function fallBack(err: unknown): void {
  if (fallbackUsed) return;
  fallbackUsed = true;
  console.warn('[rendererLog] could not send a log line to main; later failures are not reported', err);
}

/**
 * Logs a failed call at the site that would otherwise swallow it:
 * `.catch((err) => logFailure('script cancel', err))`. The message names the
 * action and carries the error's own message; the stack goes along only for a
 * thrown Error, because main rejects with a plain `{ code, message }`.
 */
export function logFailure(what: string, err: unknown): void {
  logToMain(
    'warn',
    `${what} failed: ${getErrorMessage(err, 'unknown error')}`,
    'component',
    err instanceof Error ? err.stack : undefined,
  );
}

/**
 * A thrown value as a message and, for an Error, its stack, both as strings.
 * Anything can be thrown, and an Error's `message` and `stack` can be
 * reassigned to any value, so both are coerced.
 */
export function describeError(value: unknown): { message: string; stack?: string } {
  try {
    if (value instanceof Error) {
      const { message, stack } = value as { message: unknown; stack?: unknown };
      return stack === undefined ? { message: String(message) } : { message: String(message), stack: String(stack) };
    }
    return { message: String(value) };
  } catch {
    // String() throws for an object with no usable toString (a null-prototype
    // object, say), and a getter can throw; the line is still worth sending
    // without the value.
    return { message: 'a value that cannot be printed was thrown' };
  }
}

/** Forwards uncaught errors and unhandled rejections to main's log. Install once, before the app renders. */
export function installGlobalErrorLogging(target: Window = window): void {
  target.addEventListener('error', (event) => {
    const { message, stack } = describeError(event.error ?? event.message);
    logToMain('error', message, 'window.error', stack);
  });
  target.addEventListener('unhandledrejection', (event) => {
    const { message, stack } = describeError(event.reason);
    logToMain('error', message, 'unhandledrejection', stack);
  });
}
