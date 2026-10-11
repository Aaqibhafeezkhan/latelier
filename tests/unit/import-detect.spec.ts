import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFileSize, detect } from '../../electron/services/import/detect';
import { latelierRows } from '../../electron/services/import/latelierSource';
import {
  buildConnectionExport,
  MAX_FILE_BYTES,
  parseConnectionExport,
  type ExportEntry,
} from '../../electron/services/connectionExportFormat';
import type { AppError } from '../../electron/errors';

const COMPASS = path.join(__dirname, '../fixtures/compass');
const fixture = (name: string) => readFileSync(path.join(COMPASS, name), 'utf8');

const TOO_LARGE = 'This file is too large to import (5 MB limit).';

function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a refusal');
}

function expectRefused(fn: () => unknown, message: string): void {
  const err = refusal(fn);
  expect(err.code).toBe('VALIDATION');
  expect(err.message).toBe(message);
}

const ENTRY: ExportEntry = {
  name: 'Prod',
  color: '#1A6835',
  connectionType: 'standard',
  readOnly: true,
  host: 'db.example.com',
  port: 27017,
  authMech: 'scram256',
  authUsername: 'alice',
  tls: { enabled: true, verify: true },
  advanced: {
    connectTimeoutMs: 10_000,
    socketTimeoutMs: 30_000,
    serverSelectionTimeoutMs: 30_000,
    readPreference: 'primary',
    maxPoolSize: 100,
    directConnection: false,
  },
};

const exportText = (connections: object[], over: object = {}) =>
  JSON.stringify({
    format: 'latelier.connection-export',
    version: 1,
    exportedAt: '2026-10-02T09:00:00.000Z',
    encryption: null,
    connections,
    ...over,
  });

describe('checkFileSize', () => {
  it('accepts exactly the limit and refuses one byte more', () => {
    expect(() => checkFileSize(MAX_FILE_BYTES)).not.toThrow();
    expectRefused(() => checkFileSize(MAX_FILE_BYTES + 1), TOO_LARGE);
  });
});

describe('detect', () => {
  it('refuses text that is not JSON', () => {
    expectRefused(() => detect('format: yaml'), "This isn't a JSON file.");
    expectRefused(() => detect(''), "This isn't a JSON file.");
  });

  it('counts the size in bytes, not characters', () => {
    // Half the limit in characters, just over it in UTF-8 bytes.
    const text = JSON.stringify('é'.repeat(MAX_FILE_BYTES / 2));
    expect(text.length).toBeLessThan(MAX_FILE_BYTES);
    expectRefused(() => detect(text), TOO_LARGE);
  });

  it('reads a text of exactly the limit', () => {
    const text = JSON.stringify({ pad: 'x'.repeat(MAX_FILE_BYTES - 10) });
    expect(Buffer.byteLength(text)).toBe(MAX_FILE_BYTES);
    expect(detect(text).source).toBe('unknown');
  });

  it('routes a L\'Atelier export through the C13 parser', () => {
    const text = exportText([ENTRY]);
    const found = detect(text);
    expect(found).toEqual({ source: 'latelier', file: parseConnectionExport(text) });
  });

  it("keeps C13's newer-version refusal and its strict schema", () => {
    expectRefused(
      () => detect(exportText([ENTRY], { version: 2 })),
      "This file was made by a newer version of L'Atelier. Update to import it.",
    );
    expect(refusal(() => detect(exportText([{ ...ENTRY, extra: 1 }]))).message).toMatch(
      /^Invalid Connection Export at connections\.0/,
    );
  });

  it('checks the export format before the Compass marker', () => {
    const text = exportText([ENTRY], { type: 'Compass Connections' });
    expect(refusal(() => detect(text)).message).toBe(
      'Invalid Connection Export at (root): Unrecognized key: "type"',
    );
  });

  it('reads the real Compass export as canonical EJSON', () => {
    const found = detect(fixture('plain.json'));
    if (found.source !== 'compass') throw new Error(`expected compass, got ${found.source}`);
    expect(found.rows.map((r) => r.nameHint)).toEqual([
      'Fixture favourite',
      'Fixture SSH password',
      'Fixture SSH key',
      'Fixture OIDC',
    ]);
    // `{"$numberInt":"2222"}` became a number only because EJSON read it.
    expect(found.rows[2]!.input.ssh).toMatchObject({ port: 2222 });
  });

  it('refuses a Compass export of another version', () => {
    const text = fixture('plain.json').replace('"$numberInt": "1"', '"$numberInt": "2"');
    expectRefused(() => detect(text), "This Compass export version isn't supported.");
  });

  it('turns EJSON the bson reader rejects into a refusal of its own', () => {
    const text = JSON.stringify({ type: 'Compass Connections', version: 1, connections: [], id: { $oid: 'zz' } });
    expectRefused(() => detect(text), "This Compass export can't be read.");
  });

  it('hands anything else over as plain JSON, $-keys untouched', () => {
    const value = { servers: [{ host: 'h', port: { $numberInt: '5' } }], format: 'other' };
    expect(detect(JSON.stringify(value))).toEqual({ source: 'unknown', value });
  });

  it.each([['an array', [1, 2]], ['a number', 42], ['null', null], ['a string', 'Compass Connections']])(
    'hands %s over as unknown',
    (_label, value) => {
      expect(detect(JSON.stringify(value))).toEqual({ source: 'unknown', value });
    },
  );
});

describe('latelierRows', () => {
  it('keeps every setting of the entry and names its sealed secrets, never their values', async () => {
    const text = await buildConnectionExport({
      items: [
        { entry: { ...ENTRY, repick: ['tlsCa'] }, secrets: { password: 'pw-marker', sshPassphrase: 'pp-marker' } },
        { entry: { ...ENTRY, name: 'Plain', readOnly: false } },
      ],
      passphrase: 'twelve chars!!',
      scrypt: { N: 1024, r: 8, p: 1 },
    });
    const [sealed, plain] = latelierRows(parseConnectionExport(text));

    expect(sealed).toEqual({
      input: { ...ENTRY },
      secrets: {},
      sealed: { kind: 'latelier', fields: ['password', 'sshPassphrase'] },
      nameHint: 'Prod',
      explicitDirect: true,
      multiHost: false,
      warnings: [],
      repick: ['tlsCa'],
      defaultTicked: true,
    });
    expect(plain).not.toHaveProperty('sealed');
    expect(plain!.repick).toEqual([]);
    expect(plain!.input).toMatchObject({ name: 'Plain', readOnly: false });
    expect(JSON.stringify([sealed, plain])).not.toMatch(/pw-marker|pp-marker/);
  });
});
