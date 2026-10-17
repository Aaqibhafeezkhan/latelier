import type { Review, ReviewRow } from '@shared/types';
import { normalizeConnectionInput } from '../../mongo/normalize.ts';
import { baseNames, repickFor, type Line } from '../connectionBulkAdd.ts';
import { planNames, uniqueName } from '../connectionExportFormat.ts';
import type { CandidateRow } from './candidateRow.ts';

/** The mechanisms that sign in with a username and password. */
const PASSWORD_MECHS = new Set(['default', 'scram256', 'scram1']);

/**
 * The rows the review asks for a username and password (C13 §7.1 step 4):
 * password sign-in, or none yet, which a typed username turns on. X.509
 * and AWS are never asked.
 */
const CRED_MECHS = new Set([...PASSWORD_MECHS, 'none']);

const normalName = (name: string): string => normalizeConnectionInput({ name }).name;

/** Each usable row's planned name, and the name it asked for; `null` for an unusable row. */
export type PlannedName = { requested: string; savedAs: string } | null;

/**
 * C13 §4.2 and §7.1 step 3 over every usable row, ticked or not, so unticking
 * a row cannot move another one's name. A row asks for its own name (cut to
 * the limit) or, without one, its host — `host:port` when another row that is
 * named by its host has the same host on a different port.
 */
export function planRowNames(existing: Iterable<string>, rows: readonly CandidateRow[]): PlannedName[] {
  const hints = rows.map((r) => normalName(r.nameHint));
  const byHost: Line[] = rows.map((r, i) =>
    // Stryker disable next-line ObjectLiteral,StringLiteral: baseNames reads nothing of a failed line but `ok`, so its reason (or the object's shape beyond a falsy `ok`) is unobservable.
    r.unusable === undefined && hints[i] === '' ? { ok: true, ...r } : { ok: false, reason: '' },
  );
  const bases = baseNames(byHost);
  const wanted = rows.map((_, i) => hints[i] || bases[i]!);
  const planned = planNames(
    existing,
    wanted.filter((_, i) => rows[i]!.unusable === undefined),
  );
  let k = 0;
  return rows.map((r, i) =>
    r.unusable === undefined
      ? { requested: uniqueName(normalName(wanted[i]!), new Set()), savedAs: planned[k++]! }
      : null,
  );
}

/**
 * Where the Direct connection toggle starts (C14 §6): absent on SRV, off for
 * a string that named several hosts so the driver can discover the set, the
 * source's own value when it set one, and otherwise on.
 */
export function directDefault(row: CandidateRow): boolean | null {
  if (row.input.connectionType === 'srv') return null;
  if (row.multiHost) return false;
  if (row.explicitDirect) return row.input.advanced!.directConnection;
  return true;
}

/**
 * The password exists only sealed. A L'Atelier export names its sealed fields;
 * a Compass blob is opaque until commit, so a password is assumed when the
 * string has a username and signs in with a password.
 */
function passwordSealed(row: CandidateRow): boolean {
  const { sealed, input } = row;
  if (row.secrets.password || sealed === undefined) return false;
  if (sealed.kind === 'latelier') return sealed.fields.includes('password');
  return Boolean(input.authUsername) && PASSWORD_MECHS.has(input.authMech!);
}

/** The final-approval screen for any source (C14 §6). Nothing secret is in it. */
export function buildReview(rows: readonly CandidateRow[], existing: Iterable<string>): Review {
  const names = planRowNames(existing, rows);
  return {
    hasEncryptedSecrets: rows.some((r) => r.unusable === undefined && r.sealed !== undefined),
    rows: rows.map((row, index): ReviewRow => {
      if (row.unusable !== undefined) return { index, ok: false, reason: row.unusable };
      const { requested, savedAs } = names[index]!;
      const { input } = row;
      const srv = input.connectionType === 'srv';
      const sealed = passwordSealed(row);
      const hasPassword = Boolean(row.secrets.password) || sealed;
      return {
        index,
        ok: true,
        savedAs,
        ...(savedAs === requested ? {} : { renamedFrom: requested }),
        host: input.host!,
        ...(srv ? {} : { port: input.port! }),
        srv,
        ...(input.authUsername ? { authUsername: input.authUsername } : {}),
        hasPassword,
        passwordSealed: sealed,
        needsCredentials: CRED_MECHS.has(input.authMech!) && (!input.authUsername || !hasPassword),
        directConnection: directDefault(row),
        defaultTicked: row.defaultTicked,
        repick: repickFor(input, row.repick),
        warnings: row.warnings,
        tls: input.tls!.enabled,
        ...(input.defaultDb ? { defaultDb: input.defaultDb } : {}),
        ssh: input.ssh?.enabled === true,
      };
    }),
  };
}
