import { z } from 'zod';
import type { ConnectionInput, RepickFile, UriCredentials } from '@shared/types';
import { AppError } from '../errors.ts';
import { parseConnectionUri } from '../mongo/uri-parse.ts';
import { applyCrossFieldRules, BaseInputShape } from '../ipc/schemas/connection.ts';

/** C13 §7.1 — the paste box's limits, also enforced by the channel schema. */
export const MAX_URI_LINES = 100;
export const MAX_URI_LENGTH = 4096;

/** Same default as a new Connection in the form. */
const DEFAULT_COLOR = '#7c6af7';

/** A line that parsed, with what the batch needs from it. */
export interface ParsedLine {
  ok: true;
  input: Partial<ConnectionInput>;
  /** The string set `directConnection` itself, so the batch default must not override it. */
  explicitDirect: boolean;
  /** The string named several hosts and only the first was kept. */
  multiHost: boolean;
  /** Credential files the string referenced; the user picks them again. */
  repick: RepickFile[];
  warnings: string[];
}
export type Line = ParsedLine | { ok: false; reason: string };

export function parseLine(uri: string): Line {
  try {
    const { input, warnings, repick, directConnectionExplicit } = parseConnectionUri(uri);
    return {
      ok: true,
      input,
      explicitDirect: directConnectionExplicit === true,
      multiHost: warnings.some((w) => w.code === 'MULTI_HOST_TRUNCATED'),
      // Stryker disable next-line ArrayDeclaration: parseConnectionUri sets `repick` on every return path (optional only in the shared type), so the fallback is never taken and its contents cannot be observed.
      repick: repick ?? [],
      // Stryker disable next-line LogicalOperator: every warning the parser pushes sets `detail` (verified by reading each `warnings.push` in uri-parse.ts); the code is a fallback for one that someday doesn't.
      warnings: warnings.map((w) => w.detail ?? w.code),
    };
  } catch (err) {
    // Stryker disable next-line StringLiteral: unreachable in practice — parseConnectionUri wraps every failure in a ValidationError (its own throws, the ConnectionString constructor's, and the path decode). Kept so a library change cannot surface a raw error message.
    return { ok: false, reason: err instanceof AppError ? err.message : 'Not a connection string' };
  }
}

/**
 * The name each line asks for, before clash renaming: its host, or `host:port`
 * when another line in the batch has the same host on a different port.
 * Unparseable lines get an empty slot so indices stay aligned.
 */
export function baseNames(lines: readonly Line[]): string[] {
  const ports = new Map<string, Set<number>>();
  for (const l of lines) {
    if (!l.ok) continue;
    const set = ports.get(l.input.host!) ?? new Set<number>();
    set.add(l.input.port!);
    ports.set(l.input.host!, set);
  }
  return lines.map((l) => {
    if (!l.ok) return '';
    const host = l.input.host!;
    return ports.get(host)!.size > 1 ? `${host}:${l.input.port}` : host;
  });
}

/** What the user picks again: the auth-derived marker plus any the parser read off the string. */
export function repickFor(input: Partial<ConnectionInput>, found: readonly RepickFile[] = []): RepickFile[] {
  const files = new Set(found);
  if (input.authMech === 'x509') files.add('tlsClientCert');
  return [...files];
}

/** The mechanisms that authenticate with a username and password. */
const PASSWORD_MECHS = new Set(['default', 'scram256', 'scram1', 'none']);

/**
 * The Connection a parsed row creates, with the user's final choices for it:
 * `directConnection` is the value itself, not a default, and is never applied
 * to SRV. Credentials typed in the second step win over the row's, and a
 * username cleared there means no authentication; a username with no
 * mechanism negotiates (`default`). Colour and SSH are the row's own.
 */
export function lineToInput(
  line: { input: Partial<ConnectionInput> },
  name: string,
  set: { readOnly: boolean; directConnection: boolean },
  creds: UriCredentials | undefined,
): ConnectionInput {
  const parsed = line.input;
  const cleared = creds?.username === '' && PASSWORD_MECHS.has(parsed.authMech!);
  const username = cleared ? undefined : creds?.username || parsed.authUsername;
  const srv = parsed.connectionType === 'srv';
  const authMech = cleared ? 'none' : parsed.authMech === 'none' && username ? 'default' : parsed.authMech!;
  // A row left without a username saves without authentication, so a password
  // that came with it from the file has nothing to sign in with and is dropped.
  // A typed one is kept, so the import rules still refuse it in words.
  const password = cleared ? undefined : creds?.password || (authMech === 'none' ? undefined : parsed.password);
  return {
    name,
    color: parsed.color ?? DEFAULT_COLOR,
    connectionType: parsed.connectionType!,
    host: parsed.host!,
    port: parsed.port!,
    ...(parsed.defaultDb ? { defaultDb: parsed.defaultDb } : {}),
    authMech,
    ...(username ? { authUsername: username } : {}),
    ...(parsed.authDatabase ? { authDatabase: parsed.authDatabase } : {}),
    ...(password ? { password } : {}),
    tls: parsed.tls!,
    ...(parsed.ssh ? { ssh: parsed.ssh } : {}),
    advanced: {
      ...parsed.advanced!,
      // The driver refuses directConnection on an SRV string.
      directConnection: !srv && set.directConnection,
    },
    readOnly: set.readOnly,
  };
}

/**
 * The import rules (C13 §4): a password may be missing — it can be entered
 * later — and an X.509 certificate is picked after saving.
 */
const LineInputSchema = z
  .object(BaseInputShape)
  .superRefine((data, ctx) => applyCrossFieldRules(data, ctx, { mode: 'import' }));

/** `null` when valid, otherwise the first problem in words. */
export function lineInputProblem(input: ConnectionInput): string | null {
  const r = LineInputSchema.safeParse(input);
  return r.success ? null : r.error.issues[0]!.message;
}
