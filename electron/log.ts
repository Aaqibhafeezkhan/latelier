import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, ensurePrivateFile, PrivateModeError } from './utils/privateFs.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (tag: string, msg: string, data?: unknown) => void;
  info:  (tag: string, msg: string, data?: unknown) => void;
  warn:  (tag: string, msg: string, data?: unknown) => void;
  error: (tag: string, msg: string, data?: unknown) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40,
};

/**
 * Field names whose value is replaced with '<redacted>' before serialisation.
 * Matched case-insensitively against object keys at any nesting depth.
 * Exported only so a test can pin `src/utils/secretFieldPath.ts`, the
 * renderer's copy, to this list.
 */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'password', 'pwd', 'sshpassword', 'sshpassphrase',
  'passphrase', 'secret', 'token', 'apikey', 'authorization',
  'ssh_password', 'ssh_passphrase',
]);

/**
 * Credentials embedded in a string value (most often a connection URI echoed
 * in an error message) are masked whatever key they sit under. The userinfo
 * runs to the last `@` before the first `/` or whitespace, so an unencoded `@`
 * inside a password is covered too. One quantifier, so it stays linear. A
 * password holding a literal `/` still leaves its tail visible — the URI is
 * malformed at that point and no pattern can tell where the userinfo ends.
 */
const URI_USERINFO = /(mongodb(?:\+srv)?:\/\/)[^/\s]*@/gi;

/**
 * Query parameters of a connection string that carry a secret, lower-cased.
 * Matches the set the import wizard masks, plus the legacy PEM-key alias.
 */
const SECRET_URI_PARAMS = new Set([
  'password', 'proxypassword', 'tlscertificatekeyfilepassword', 'sslpemkeypassword',
]);
const URI_STRING = /mongodb(?:\+srv)?:\/\/\S*/gi;
// The name stops at any separator, `?` included: a name that could run across
// later `?`s rescans the rest of the string from each one when no `=` follows,
// which is quadratic on a run of `?`. With it, the scan stays linear.
const URI_QUERY_PARAM = /([?&])([^=&?]*)=([^&]*)/g;

// An authMechanismProperties value holding the AWS session token is masked
// whole: splitting a malformed list to find the token's end cannot be trusted.
// The driver reads parameters through URLSearchParams, which decodes valid
// escapes and keeps malformed ones as written, so `%70roxyPassword` is
// `proxyPassword` and `AWS%5FSESSION%5FTOKEN` is the token's marker even next
// to a broken escape. Name and value are compared the way the driver sees them.
function asDriverReads(raw: string): string {
  return new URLSearchParams(`v=${raw}`).get('v')!;
}

function scrubQueryParam(match: string, sep: string, name: string, value: string): string {
  const key = asDriverReads(name).toLowerCase();
  const secret = SECRET_URI_PARAMS.has(key)
    || (key === 'authmechanismproperties' && /aws_session_token/i.test(asDriverReads(value)));
  return secret ? `${sep}${name}=***` : match;
}

const scrubString = (s: string): string =>
  s.replace(URI_USERINFO, '$1***@')
    .replace(URI_STRING, (uri) => uri.replace(URI_QUERY_PARAM, scrubQueryParam));

/**
 * True when a dotted field path (e.g. `user.password`) has any segment that
 * is a secret key name, checked case-insensitively. Shared with
 * `RecentFieldValueService` so a value typed against a secret-named field
 * never reaches `recent_field_values` — main is the trust boundary, not the
 * renderer that sends the record request.
 */
export function isSecretFieldPath(field: string): boolean {
  return field.split('.').some((segment) => REDACTED_KEYS.has(segment.toLowerCase()));
}

const REDACTED_PLACEHOLDER = '<redacted>';
const CIRCULAR_PLACEHOLDER = '[Circular]';
const IN_PROGRESS = Symbol('in-progress');

export function redactSecrets<T>(value: T): T {
  return walk(value, new Map()) as T;
}

// Maps each object to its redacted output so a shared (non-cyclic) reference
// resolves to the same sanitized clone on every visit, instead of the
// original, unredacted object. While an object is still being walked its
// entry holds IN_PROGRESS, so a true cycle back to an ancestor resolves to a
// circular marker rather than infinite-recursing or leaking the original.
function walk(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as object;
  if (seen.has(obj)) {
    const cached = seen.get(obj);
    return cached === IN_PROGRESS ? CIRCULAR_PLACEHOLDER : cached;
  }
  seen.set(obj, IN_PROGRESS);

  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((v) => walk(v, seen));
  } else {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED_PLACEHOLDER;
      } else {
        out[k] = walk(v, seen);
      }
    }
    result = out;
  }
  seen.set(obj, result);
  return result;
}

function todayStamp(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The pre-rename prefix stays so older logs still age out.
export const isLogFile = (name: string): boolean =>
  (name.startsWith('latelier.') || name.startsWith('mongolab.')) && name.endsWith('.log');

/**
 * Splits a log file name into its date and part: `latelier.<date>.log` is part
 * 0 and `latelier.<date>.<N>.log` is part N, written once part N-1 reached the
 * size cap. A part that is not a number comes back NaN.
 */
function logNameParts(name: string): { date: string; part: number } {
  const fields = name.slice(name.indexOf('.') + 1, -'.log'.length).split('.');
  return { date: fields[0]!, part: fields.length === 1 ? 0 : Number.parseInt(fields[1]!, 10) };
}

/**
 * Oldest-first order of log file names: by date, then by part number counted
 * as a number (`.10` after `.2`, and the bare name before `.1`), then the
 * pre-rename `mongolab.` file first, since on the upgrade day it was written
 * before the `latelier.` one. Whole-name order gets all three wrong. Dates are
 * ISO, so code-unit order is chronological; `localeCompare` is avoided on
 * purpose, because its collation depends on the locale and which files a
 * caller keeps must not.
 */
export function compareLogFiles(a: string, b: string): number {
  const pa = logNameParts(a);
  const pb = logNameParts(b);
  const legacy = (name: string) => (name.startsWith('mongolab.') ? 0 : 1);
  if (pa.date < pb.date) return -1;
  if (pa.date > pb.date) return 1;
  return pa.part - pb.part || legacy(a) - legacy(b);
}

export type RateVerdict = { allow: true } | { allow: false; firstDrop: boolean; until: number };

export interface RateGate {
  take: () => RateVerdict;
  /** Opens a fresh window: the next call is allowed whatever came before. */
  reset: () => void;
}

/**
 * Lets at most `maxPerWindow` calls through per fixed window of `windowMs`,
 * the window starting at the first call after the last one ended. A refused
 * call says whether it is the window's first refusal, so the caller can say
 * once that lines are being dropped, and when the window ends.
 */
export function createRateGate(maxPerWindow: number, windowMs: number, now: () => number = Date.now): RateGate {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  return {
    take() {
      const t = now();
      // A clock that moved back (NTP, a manual change) also opens a window:
      // otherwise every call would be refused until it caught up, unannounced.
      if (t < windowStart || t - windowStart >= windowMs) {
        windowStart = t;
        count = 0;
      }
      count++;
      if (count <= maxPerWindow) return { allow: true };
      return { allow: false, firstDrop: count === maxPerWindow + 1, until: windowStart + windowMs };
    },
    reset() {
      windowStart = Number.NEGATIVE_INFINITY;
      count = 0;
    },
  };
}

/**
 * Deletes log files past retention. A failure stops the sweep (nothing more is
 * pruned this run), so it is returned for the caller to report once it has a
 * logger — silently stopping would let logs outlive their retention unnoticed.
 */
function pruneOldLogs(dir: string, retentionDays: number): StartupWarning[] {
  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!isLogFile(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
    return [];
  } catch (err) {
    return [{ msg: 'could not prune old log files', data: { message: String(err) } }];
  }
}

interface StartupWarning { msg: string; data: { file?: string; message: string } }

/**
 * Logs written by an older install carry the process umask (often 0644).
 * Returns the files that could not be tightened so the caller can report them
 * once it has a logger.
 */
function tightenLogFiles(dir: string): StartupWarning[] {
  const failures: StartupWarning[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!isLogFile(name)) continue;
    try {
      ensurePrivateFile(path.join(dir, name));
    } catch (err) {
      failures.push({ msg: 'could not restrict log file permissions', data: { file: name, message: String(err) } });
    }
  }
  return failures;
}

export function createLogger(userDataDir: string, opts: {
  level?: LogLevel;
  retentionDays?: number;
  toStderr?: boolean;
  /** A day's file rolls to the next `.N` part once it holds this many bytes. */
  maxFileBytes?: number;
} = {}): Logger {
  // Defaults to the quiet level on purpose. `ipc.req` logs the pre-validation
  // payload of every channel — documents, filters, shell input — so a debug
  // default leaks user data to disk for anyone who forgets to pass a level.
  // Whoever wants the verbose level has to ask for it; forgetting is safe.
  const level = opts.level ?? 'info';
  const retention = opts.retentionDays ?? 7;
  const toStderr = opts.toStderr ?? true;

  const logsDir = path.join(userDataDir, 'logs');
  // The logger must not be what kills boot: a logs dir we created but cannot
  // chmod (not owned by this user) is reported once the logger exists. A failed
  // mkdir still throws, as it always did.
  const startupWarnings: StartupWarning[] = [];
  try {
    ensurePrivateDir(logsDir);
  } catch (err) {
    if (!(err instanceof PrivateModeError)) throw err;
    startupWarnings.push({ msg: 'could not restrict logs directory permissions', data: { message: err.message } });
  }
  startupWarnings.push(...pruneOldLogs(logsDir, retention), ...tightenLogFiles(logsDir));

  let diskFailureReported = false;

  // The file being written: its day, its part and the bytes it holds. The
  // size is counted in memory and read from disk only when a day is opened
  // (the first line, then each date change), never per line.
  const maxFileBytes = opts.maxFileBytes ?? 10 * 1024 * 1024;
  let day: string | undefined;
  let part = 0;
  let bytes = 0;
  const partPath = (stamp: string, n: number) =>
    path.join(logsDir, n === 0 ? `latelier.${stamp}.log` : `latelier.${stamp}.${n}.log`);

  // Resumes the newest part of the day already on disk, so a restart appends
  // where the last run stopped rather than to a part that is already full.
  function openDay(stamp: string): void {
    const parts = fs.readdirSync(logsDir)
      .filter((name) => name.startsWith(`latelier.${stamp}.`) && name.endsWith('.log'))
      .map((name) => logNameParts(name).part)
      .filter((n) => Number.isInteger(n));
    const newest = Math.max(0, ...parts);
    bytes = fs.statSync(partPath(stamp, newest), { throwIfNoEntry: false })?.size ?? 0;
    part = newest;
    day = stamp;
  }

  // A part that already holds bytes rolls over before a line would take it
  // past the cap; an empty one takes the line whatever its size, or a single
  // oversized line would open empty parts forever.
  function fileFor(lineBytes: number): string {
    const stamp = todayStamp();
    if (stamp !== day) openDay(stamp);
    if (bytes > 0 && bytes + lineBytes > maxFileBytes) {
      part++;
      bytes = 0;
    }
    return partPath(stamp, part);
  }

  function write(lvl: LogLevel, tag: string, msg: string, data?: unknown): void {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const line = {
      t: new Date().toISOString(),
      level: lvl,
      tag,
      msg: scrubString(msg),
      // Stryker disable next-line ConditionalExpression: redactSecrets(undefined) returns undefined unchanged (walk's `typeof !== 'object'` guard), and JSON.stringify drops an undefined-valued key entirely, so `{ data: undefined }` and no `data` key at all serialize byte-identically — verified with a node probe.
      ...(data !== undefined ? { data: redactSecrets(data) } : {}),
    };
    const serialized = JSON.stringify(line) + '\n';
    const lineBytes = Buffer.byteLength(serialized);
    try {
      // Opening the day reads the logs dir, so it fails with the same broken
      // disk as the append and is reported the same way.
      fs.appendFileSync(fileFor(lineBytes), serialized, { mode: 0o600 });
      bytes += lineBytes;
    } catch {
      // Logging must never crash the app, and the failing logger cannot report
      // its own failure, so say so once on stderr. Fixed text, no re-entry into
      // write(): a disk that stays broken would otherwise recurse or spam.
      if (!diskFailureReported) {
        diskFailureReported = true;
        process.stderr.write('log: cannot write the log file; further disk errors are not reported\n');
      }
    }
    if (toStderr) process.stderr.write(serialized);
  }

  for (const w of startupWarnings) write('warn', 'log', w.msg, w.data);

  return {
    debug: (tag, msg, data) => write('debug', tag, msg, data),
    info:  (tag, msg, data) => write('info',  tag, msg, data),
    warn:  (tag, msg, data) => write('warn',  tag, msg, data),
    error: (tag, msg, data) => write('error', tag, msg, data),
  };
}
