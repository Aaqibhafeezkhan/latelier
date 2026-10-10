/* eslint-disable @typescript-eslint/no-explicit-any -- these tests hand-edit parsed Compass JSON of a deliberately untyped shape. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EJSON } from 'bson';
import { describe, expect, it } from 'vitest';
import { isCompassExport, readCompass } from '../../electron/services/import/compassReader';
import type { CandidateRow } from '../../electron/services/import/candidateRow';

// Fixtures exported by MongoDB Compass 1.49.7 (see docs/agents/c14-plan.md §9 L1).
const DIR = path.join(__dirname, '../fixtures/compass');
const load = (name: string): any => EJSON.parse(readFileSync(path.join(DIR, name), 'utf8'));

const SECRET_VALUES = ['fixture-pw-1', 'fixture-pw-2', 'fixture-pw-3', 'fixture-ssh-pw', 'fixture-key-pass'];
const KEY_PATH = '/nonexistent/fixture_id_ed25519';

/** A one-entry export built from `entry`. */
function single(entry: any): CandidateRow {
  const rows = readCompass({ type: 'Compass Connections', version: 1, connections: [entry] });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const URI = 'mongodb://db.example.test:27017/';

function expectNoLeaks(rows: CandidateRow[]): void {
  for (const row of rows) {
    expect(row.input).not.toHaveProperty('password');
    expect(row.input).not.toHaveProperty('sshPassword');
    expect(row.input).not.toHaveProperty('sshPassphrase');
    // Everything but `secrets` (input, warnings, unusable, repick, nameHint, sealed) is free of secret values.
    const outside = JSON.stringify({ ...row, secrets: undefined });
    for (const secret of SECRET_VALUES) expect(outside).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(KEY_PATH);
  }
}

describe('isCompassExport', () => {
  it('recognises the Compass type marker and nothing else', () => {
    expect(isCompassExport(load('plain.json'))).toBe(true);
    expect(isCompassExport({ type: 'Compass Connection' })).toBe(false);
    expect(isCompassExport({ format: 'latelier.connection-export' })).toBe(false);
    expect(isCompassExport(null)).toBe(false);
    expect(isCompassExport(undefined)).toBe(false);
    expect(isCompassExport('Compass Connections')).toBe(false);
  });
});

// Rows are read inside each test, not at collection time, so Stryker's
// per-test coverage sees the reader run under the active mutant.
describe('readCompass — real plain export', () => {
  const read = () => readCompass(load('plain.json'));

  it('lists all four entries and moves every secret out of input', () => {
    const rows = read();
    expect(rows).toHaveLength(4);
    expectNoLeaks(rows);
  });

  it('favourite: string, name, credentials; a named Compass colour is left unset', () => {
    const rows = read();
    expect(rows[0]).toEqual({
      input: expect.objectContaining({
        connectionType: 'standard',
        host: 'db1.example.test',
        port: 27017,
        authUsername: 'alice',
        authDatabase: 'admin',
      }),
      secrets: { password: 'fixture-pw-1' },
      nameHint: 'Fixture favourite',
      explicitDirect: false,
      multiHost: false,
      warnings: [],
      repick: [],
      defaultTicked: true,
    });
    expect(rows[0]!.input).not.toHaveProperty('color');
    expect(rows[0]!.input).not.toHaveProperty('ssh');
  });

  it('SSH with a password', () => {
    const rows = read();
    expect(rows[1]!.input.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 22,
      username: 'tunnel',
      authMethod: 'password',
    });
    expect(rows[1]!.secrets).toStrictEqual({ password: 'fixture-pw-2', sshPassword: 'fixture-ssh-pw' });
    expect(rows[1]!.repick).toEqual([]);
    expect(rows[1]!.nameHint).toBe('Fixture SSH password');
  });

  it('SSH with an identity file: key auth, an sshKey re-pick and the key passphrase, never the path', () => {
    const rows = read();
    expect(rows[2]!.input.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 2222,
      username: 'tunnel',
      authMethod: 'key',
    });
    expect(rows[2]!.secrets).toStrictEqual({ password: 'fixture-pw-3', sshPassphrase: 'fixture-key-pass' });
    expect(rows[2]!.repick).toEqual(['sshKey']);
  });

  it('OIDC is listed but unusable', () => {
    const rows = read();
    expect(rows[3]).toMatchObject({ nameHint: 'Fixture OIDC', defaultTicked: false, input: {}, secrets: {} });
    expect(rows[3]!.unusable).toBe("OIDC sign-in isn't supported yet.");
  });

  it('a plain export seals nothing', () => {
    const rows = read();
    expect(rows.map((r) => r.sealed)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('readCompass — real encrypted export', () => {
  const file = load('encrypted.json');
  const read = () => readCompass(file);

  it('seals each usable entry’s blob and holds no plaintext secret', () => {
    const rows = read();
    expect(rows.map((r) => r.sealed)).toEqual([
      { kind: 'compass', blob: file.connections[0].connectionSecrets },
      { kind: 'compass', blob: file.connections[1].connectionSecrets },
      { kind: 'compass', blob: file.connections[2].connectionSecrets },
      undefined,
    ]);
    // Strict, so a secret field set to `undefined` also fails.
    expect(rows.map((r) => r.secrets)).toStrictEqual([{}, {}, {}, {}]);
    expectNoLeaks(rows);
  });

  it('keeps the username of a string whose password Compass stripped', () => {
    const rows = read();
    expect(rows[0]!.input).toMatchObject({ host: 'db1.example.test', authUsername: 'alice' });
    expect(rows[0]!.defaultTicked).toBe(true);
  });

  it('a sealed SSH entry without a key file authenticates with a password', () => {
    const rows = read();
    expect(rows[1]!.input.ssh).toMatchObject({ enabled: true, port: 22, authMethod: 'password' });
  });

  it('a sealed SSH entry with a key file still uses the key', () => {
    const rows = read();
    expect(rows[2]!.input.ssh).toMatchObject({ port: 2222, authMethod: 'key' });
    expect(rows[2]!.repick).toEqual(['sshKey']);
  });

  it('OIDC stays unusable', () => {
    const rows = read();
    expect(rows[3]!.unusable).toBe("OIDC sign-in isn't supported yet.");
  });
});

describe('readCompass — hand-edited entries', () => {
  it('ticks by savedConnectionType, falling back to the favourite object', () => {
    const fav = { name: 'F' };
    const opts = { connectionString: URI };
    expect(single({ favorite: fav, connectionOptions: opts, savedConnectionType: 'recent' }).defaultTicked).toBe(false);
    expect(single({ connectionOptions: opts, savedConnectionType: 'favorite' }).defaultTicked).toBe(true);
    expect(single({ favorite: fav, connectionOptions: opts }).defaultTicked).toBe(true);
    expect(single({ connectionOptions: opts }).defaultTicked).toBe(false);
  });

  it('a recent connection with no favourite has an empty name hint', () => {
    expect(single({ connectionOptions: { connectionString: URI }, savedConnectionType: 'recent' }).nameHint).toBe('');
  });

  it('keeps only a #rrggbb colour', () => {
    const color = (c: string) => single({ favorite: { name: 'x', color: c }, connectionOptions: { connectionString: URI } });
    expect(color('#aaBB09').input.color).toBe('#aaBB09');
    expect(color('#abc').input).not.toHaveProperty('color');
    expect(color('color3').input).not.toHaveProperty('color');
  });

  it('warns about configured FLE only', () => {
    const fle = (fleOptions: any) => single({ connectionOptions: { connectionString: URI, fleOptions } }).warnings;
    expect(fle({ storeCredentials: false, autoEncryption: { keyVaultNamespace: 'enc.keys' } })).toEqual([
      'In-use encryption (FLE) settings were not imported.',
    ]);
    expect(fle({ storeCredentials: false })).toEqual([]);
    expect(fle({ storeCredentials: false, autoEncryption: {} })).toEqual([]);
  });

  it('warns about an application-level proxy', () => {
    const proxy = (on: boolean) =>
      single({ connectionOptions: { connectionString: URI, useApplicationLevelProxy: on } }).warnings;
    expect(proxy(true)).toEqual(['Application-level proxy settings were not imported.']);
    expect(proxy(false)).toEqual([]);
  });

  it('appends its own warnings after the parser’s and carries multi-host and explicit direct', () => {
    const row = single({
      connectionOptions: {
        connectionString: 'mongodb://a.example.test,b.example.test/?directConnection=true',
        fleOptions: { autoEncryption: { keyVaultNamespace: 'enc.keys' } },
      },
    });
    expect(row.multiHost).toBe(true);
    expect(row.explicitDirect).toBe(true);
    expect(row.warnings.at(-1)).toBe('In-use encryption (FLE) settings were not imported.');
    expect(row.warnings.length).toBeGreaterThan(1);
  });

  it('ignores unknown fields', () => {
    const row = single({ id: 'x', lastUsed: new Date(0), connectionOptions: { connectionString: URI, oidc: {} }, extra: 1 });
    expect(row.unusable).toBeUndefined();
    expect(row.input.host).toBe('db.example.test');
  });

  it('an SSH tunnel without a key file is password auth even with no password', () => {
    const row = single({ connectionOptions: { connectionString: URI, sshTunnel: { host: 'h', port: 22, username: 'u' } } });
    expect(row.input.ssh).toEqual({ enabled: true, host: 'h', port: 22, username: 'u', authMethod: 'password' });
    expect(row.secrets).toStrictEqual({});
    expect(row.repick).toEqual([]);
  });

  it('keeps the parser’s re-pick markers ahead of the SSH key, and no file path', () => {
    const row = single({
      connectionOptions: {
        connectionString: 'mongodb://db.example.test/?tls=true&tlsCAFile=%2Ftmp%2Fca.pem',
        sshTunnel: { host: 'h', identityKeyFile: '/tmp/id_ed25519' },
      },
    });
    expect(row.repick).toEqual(['tlsCa', 'sshKey']);
    expect(JSON.stringify(row)).not.toMatch(/ca\.pem|id_ed25519/);
  });

  it('an entry without a connection string is listed as unusable', () => {
    const expected = {
      input: {},
      secrets: {},
      nameHint: 'N',
      explicitDirect: false,
      multiHost: false,
      warnings: [],
      repick: [],
      defaultTicked: false,
      unusable: 'No connection string.',
    };
    expect(single({ favorite: { name: 'N' }, connectionOptions: {}, connectionSecrets: 'AAE=' })).toEqual(expected);
    expect(single({ favorite: { name: 'N' } })).toEqual(expected);
    expect(single({ favorite: { name: 'N' }, connectionOptions: { connectionString: '' } })).toEqual(expected);
  });

  it('a string the parser rejects is unusable with the parser’s reason', () => {
    const row = single({ favorite: { name: 'N' }, connectionOptions: { connectionString: 'http://nope' } });
    expect(row.unusable).toEqual(expect.any(String));
    expect(row.unusable).not.toBe('No connection string.');
  });
});

describe('readCompass — refusals', () => {
  it('refuses any version but 1', () => {
    const plain = load('plain.json');
    for (const version of [2, '1', undefined]) {
      expect(() => readCompass({ ...plain, version })).toThrow("This Compass export version isn't supported.");
    }
    expect(() => readCompass(null)).toThrow("This Compass export version isn't supported.");
  });

  it('needs EJSON.parse: plain JSON.parse leaves the version as {$numberInt}', () => {
    const text = readFileSync(path.join(DIR, 'plain.json'), 'utf8');
    expect(() => readCompass(JSON.parse(text))).toThrow("This Compass export version isn't supported.");
  });

  it('refuses a version 1 file whose shape is not a Compass export', () => {
    for (const bad of [
      { version: 1 },
      { version: 1, connections: {} },
      { version: 1, connections: [{ connectionOptions: { connectionString: 5 } }] },
      { version: 1, connections: [{ connectionOptions: { sshTunnel: { port: '22' } } }] },
      { version: 1, connections: [{ favorite: { name: 7 } }] },
      { version: 1, connections: [{ favorite: { color: 7 } }] },
      { version: 1, connections: [{ connectionOptions: { fleOptions: { autoEncryption: 'yes' } } }] },
    ]) {
      expect(() => readCompass(bad)).toThrow("This Compass export can't be read.");
    }
  });
});
