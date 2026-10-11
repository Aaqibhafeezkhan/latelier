import { describe, expect, it } from 'vitest';
import type { ReviewRow } from '@shared/types';
import { parseLine } from '../../electron/services/connectionBulkAdd';
import type { CandidateRow } from '../../electron/services/import/candidateRow';
import { buildReview, directDefault, planRowNames } from '../../electron/services/import/review';

/** A candidate row as the readers build it: the string's settings, its password moved to `secrets`. */
function row(uri: string, over: Partial<CandidateRow> = {}): CandidateRow {
  const line = parseLine(uri);
  if (!line.ok) throw new Error(`expected ${uri} to parse: ${line.reason}`);
  const { password, ...input } = line.input;
  return {
    input,
    secrets: password ? { password } : {},
    nameHint: '',
    explicitDirect: line.explicitDirect,
    multiHost: line.multiHost,
    warnings: line.warnings,
    repick: line.repick,
    defaultTicked: true,
    ...over,
  };
}

const unusable = (reason: string, over: Partial<CandidateRow> = {}): CandidateRow => ({
  input: {},
  secrets: {},
  nameHint: '',
  explicitDirect: false,
  multiHost: false,
  warnings: [],
  repick: [],
  defaultTicked: false,
  unusable: reason,
  ...over,
});

type OkRow = Extract<ReviewRow, { ok: true }>;
const okRows = (rows: CandidateRow[], existing: string[] = []): OkRow[] =>
  buildReview(rows, existing).rows.map((r) => {
    if (!r.ok) throw new Error(`row ${r.index} is unusable: ${r.reason}`);
    return r;
  });
const one = (r: CandidateRow): OkRow => okRows([r])[0]!;
const names = (rows: CandidateRow[], existing: string[] = []) =>
  okRows(rows, existing).map((r) => (r.renamedFrom === undefined ? r.savedAs : `${r.renamedFrom} -> ${r.savedAs}`));

describe('buildReview: a whole row', () => {
  it('shows what the row will be, and nothing secret', () => {
    const r = row('mongodb://alice:pw-marker@DB.example.com:2000/app?tls=true&w=1', {
      warnings: ['w'],
      repick: ['tlsCa'],
      defaultTicked: false,
    });
    expect(buildReview([r], [])).toEqual({
      hasEncryptedSecrets: false,
      rows: [
        {
          index: 0,
          ok: true,
          savedAs: 'DB.example.com',
          host: 'DB.example.com',
          port: 2000,
          srv: false,
          authUsername: 'alice',
          hasPassword: true,
          passwordSealed: false,
          needsCredentials: false,
          directConnection: true,
          defaultTicked: false,
          repick: ['tlsCa'],
          warnings: ['w'],
          tls: true,
          defaultDb: 'app',
          ssh: false,
        },
      ],
    });
    expect(JSON.stringify(buildReview([r], []))).not.toContain('pw-marker');
  });

  it('leaves out the port on SRV and the optional fields a row lacks', () => {
    const r = one(row('mongodb+srv://c.example.net'));
    expect(r).toMatchObject({ srv: true, host: 'c.example.net', tls: true });
    for (const k of ['port', 'authUsername', 'defaultDb', 'renamedFrom']) expect(r).not.toHaveProperty(k);
  });

  it('lists an unusable row with its reason only, at its own index', () => {
    const review = buildReview([row('mongodb://a'), unusable('No connection string.', { nameHint: 'x' })], []);
    expect(review.rows[1]).toEqual({ index: 1, ok: false, reason: 'No connection string.' });
    expect(review.rows[0]).toMatchObject({ index: 0, ok: true });
  });

  it('reports SSH on only when the row enables it', () => {
    const on = row('mongodb://a', { input: { ...row('mongodb://a').input, ssh: { enabled: true } } });
    const off = row('mongodb://b', { input: { ...row('mongodb://b').input, ssh: { enabled: false } } });
    expect(okRows([on, off, row('mongodb://c')]).map((r) => r.ssh)).toEqual([true, false, false]);
  });

  it('adds the X.509 certificate to the files to re-pick, once', () => {
    const x509 = 'mongodb://h/?authMechanism=MONGODB-X509&tls=true';
    expect(one(row(x509, { repick: [] })).repick).toEqual(['tlsClientCert']);
    expect(one(row(x509, { repick: ['tlsCa', 'tlsClientCert'] })).repick).toEqual(['tlsCa', 'tlsClientCert']);
  });
});

describe('buildReview: names', () => {
  it("uses the row's own name, normalized and cut to 64, and only calls a clash a rename", () => {
    const long = 'N'.repeat(70);
    expect(names([row('mongodb://h', { nameHint: '  Prod   East ' }), row('mongodb://h', { nameHint: long })])).toEqual([
      'Prod East',
      'N'.repeat(64),
    ]);
  });

  it('falls back to the host when the name is blank', () => {
    expect(names([row('mongodb://h', { nameHint: '   ' }), row('mongodb://g')])).toEqual(['h', 'g']);
  });

  it('names same-host rows host:port when their ports differ, among host-named rows only', () => {
    expect(names([row('mongodb://h:1'), row('mongodb://h:2'), row('mongodb://g:3')])).toEqual(['h:1', 'h:2', 'g']);
    // A row with its own name does not make a host-named row spell out its port.
    expect(names([row('mongodb://h:1', { nameHint: 'Mine' }), row('mongodb://h:2')])).toEqual(['Mine', 'h']);
  });

  it('dedupes against existing Connections and within the batch, with the asked-for name kept', () => {
    expect(names([row('mongodb://h'), row('mongodb://h'), row('mongodb://x', { nameHint: 'Prod' })], ['Prod'])).toEqual([
      'h',
      'h -> h (2)',
      'Prod -> Prod (2)',
    ]);
  });

  it('keeps a renamed long name within the limit, reporting the cut name as asked for', () => {
    const long = 'N'.repeat(70);
    const [r] = okRows([row('mongodb://h', { nameHint: long })], ['N'.repeat(64)]);
    expect(r!.renamedFrom).toBe('N'.repeat(64));
    expect(r!.savedAs).toBe(`${'N'.repeat(60)} (2)`);
  });

  it('gives unusable rows no name, so they never push a usable row to "(2)"', () => {
    const rows = [unusable('bad', { nameHint: 'Prod' }), row('mongodb://h', { nameHint: 'Prod' })];
    expect(planRowNames([], rows)).toEqual([null, { requested: 'Prod', savedAs: 'Prod' }]);
    expect(buildReview(rows, []).rows[1]).toMatchObject({ savedAs: 'Prod' });
  });

  it("never hands an unusable row's name to the usable row after it", () => {
    const rows = [unusable('bad', { nameHint: 'Zed' }), row('mongodb://h', { nameHint: 'Prod' })];
    expect(planRowNames([], rows)).toEqual([null, { requested: 'Prod', savedAs: 'Prod' }]);
  });

  it("leaves an unusable row's host out of the host:port rule", () => {
    const rows = [unusable('bad', { input: row('mongodb://h:1').input }), row('mongodb://h:2')];
    expect(planRowNames([], rows)[1]).toEqual({ requested: 'h', savedAs: 'h' });
  });
});

describe('directDefault (C14 §6)', () => {
  it.each([
    ['a single host', 'mongodb://h', true],
    ['an explicit directConnection=false', 'mongodb://h/?directConnection=false', false],
    ['an explicit directConnection=true', 'mongodb://h/?directConnection=true', true],
    ['several hosts', 'mongodb://a,b', false],
    ['several hosts, even when the string asks for direct', 'mongodb://a,b/?directConnection=true', false],
    ['SRV', 'mongodb+srv://c.example.net', null],
  ])('%s starts %s', (_label, uri, expected) => {
    expect(directDefault(row(uri))).toBe(expected);
    expect(one(row(uri)).directConnection).toBe(expected);
  });

  it('keeps an exported value, and never gives an SRV row one', () => {
    const exported = row('mongodb://h', { explicitDirect: true });
    exported.input.advanced!.directConnection = false;
    expect(directDefault(exported)).toBe(false);
    expect(directDefault(row('mongodb+srv://c.example.net', { explicitDirect: true, multiHost: true }))).toBeNull();
  });
});

describe('buildReview: passwords and credentials (L4)', () => {
  const compass = { kind: 'compass' as const, blob: 'AAE=' };
  const flags = (r: CandidateRow) => {
    const { hasPassword, passwordSealed, needsCredentials } = one(r);
    return { hasPassword, passwordSealed, needsCredentials };
  };
  const none = { hasPassword: false, passwordSealed: false, needsCredentials: false };

  it.each([
    ['a password in the string', row('mongodb://u:p@h'), { hasPassword: true, passwordSealed: false, needsCredentials: false }],
    ['a username alone', row('mongodb://u@h'), { ...none, needsCredentials: true }],
    ['SCRAM with nothing', row('mongodb://h/?authMechanism=SCRAM-SHA-256'), { ...none, needsCredentials: true }],
    ['SCRAM-SHA-1 with a username alone', row('mongodb://u@h/?authMechanism=SCRAM-SHA-1'), { ...none, needsCredentials: true }],
    ['no authentication', row('mongodb://h'), { ...none, needsCredentials: true }],
    ['a password with no username', row('mongodb://h/?authMechanism=SCRAM-SHA-256', { secrets: { password: 'p' } }), { hasPassword: true, passwordSealed: false, needsCredentials: true }],
    ['X.509', row('mongodb://h/?authMechanism=MONGODB-X509&tls=true'), none],
    ['AWS with a key id alone', row('mongodb://k@h/?authMechanism=MONGODB-AWS'), none],
  ])('%s', (_label, r, expected) => {
    expect(flags(r)).toEqual(expected);
  });

  it('a sealed L\'Atelier password counts as present; another sealed field does not', () => {
    const sealedPw = row('mongodb://u@h', { sealed: { kind: 'latelier', fields: ['sshPassword', 'password'] } });
    expect(flags(sealedPw)).toEqual({ hasPassword: true, passwordSealed: true, needsCredentials: false });
    const sealedSsh = row('mongodb://u@h', { sealed: { kind: 'latelier', fields: ['sshPassword'] } });
    expect(flags(sealedSsh)).toEqual({ ...none, needsCredentials: true });
  });

  it('a Compass blob holds a password when the string has a username and signs in with one', () => {
    expect(flags(row('mongodb://u@h', { sealed: compass }))).toEqual({
      hasPassword: true,
      passwordSealed: true,
      needsCredentials: false,
    });
    expect(flags(row('mongodb://u@h/?authMechanism=SCRAM-SHA-256', { sealed: compass })).passwordSealed).toBe(true);
    expect(flags(row('mongodb://h', { sealed: compass }))).toEqual({ ...none, needsCredentials: true });
    expect(flags(row('mongodb://u@h/?authMechanism=MONGODB-X509&tls=true', { sealed: compass }))).toEqual(none);
    expect(flags(row('mongodb://u@h/?authMechanism=MONGODB-AWS', { sealed: compass }))).toEqual(none);
  });

  it('a password in clear is never "sealed", even beside a blob', () => {
    expect(flags(row('mongodb://u:p@h', { sealed: compass }))).toEqual({
      hasPassword: true,
      passwordSealed: false,
      needsCredentials: false,
    });
  });
});

describe('buildReview: hasEncryptedSecrets', () => {
  const sealed = { kind: 'compass' as const, blob: 'AAE=' };

  it('is set by any usable sealed row, and not by an unusable one', () => {
    expect(buildReview([row('mongodb://a'), row('mongodb://b', { sealed })], []).hasEncryptedSecrets).toBe(true);
    expect(buildReview([row('mongodb://a'), unusable('OIDC', { sealed })], []).hasEncryptedSecrets).toBe(false);
    expect(buildReview([row('mongodb://u:p@a')], []).hasEncryptedSecrets).toBe(false);
  });
});
