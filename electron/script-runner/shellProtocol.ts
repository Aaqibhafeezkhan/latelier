/**
 * Messages between main and a shell session's runner child, beside the RPC
 * frames and replies in `protocol.ts`. Like those, they are plain
 * structured-cloneable objects; like those, nothing here carries a connection
 * string or a credential.
 */

/** main -> child, once: open a REPL over in-memory streams. */
export interface ShellStartRequest {
  type: 'shell-start';
  dbName: string;
  /** Written to the REPL's output before the first prompt. */
  banner: string;
}

/** main -> child: text for the REPL's input, already through `rewriteShellSugar`. */
export interface ShellInput {
  type: 'shell-in';
  data: string;
}

/** child -> main: a chunk the REPL wrote. Forwarded unchanged as a stdout event. */
export interface ShellOutput {
  type: 'shell-out';
  data: string;
}

/** child -> main: the REPL ended (`.exit`, end of input). The process follows. */
export interface ShellExited {
  type: 'shell-exit';
}

/**
 * child -> main: the REPL is waiting for input again (it printed a prompt).
 * Main counts one per line it wrote, so a line whose result is still pending
 * is the difference between the two.
 */
export interface ShellPrompt {
  type: 'shell-prompt';
}

export type ShellMessage = ShellOutput | ShellExited | ShellPrompt;

/** Shape check for a message arriving from the child; a REPL user can post to the port too. */
export function isShellMessage(value: unknown): value is ShellMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.type === 'shell-out') return typeof m.data === 'string';
  return m.type === 'shell-exit' || m.type === 'shell-prompt';
}

/** Shape checks for what the child receives. The sender is main, so these guard the child's own state. */
export function isShellStartRequest(value: unknown): value is ShellStartRequest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.type === 'shell-start' && typeof m.dbName === 'string' && typeof m.banner === 'string';
}

export function isShellInput(value: unknown): value is ShellInput {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.type === 'shell-in' && typeof m.data === 'string';
}
