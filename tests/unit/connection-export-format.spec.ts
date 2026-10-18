/* eslint-disable @typescript-eslint/no-explicit-any -- these tests edit parsed JSON of a deliberately untyped shape to build corrupt files. */
import { describe, it, expect } from 'vitest';
import type { Connection } from '@shared/types';
import {
  buildConnectionExport,
  DEFAULT_SCRYPT,
  decryptSelected,
  entryToConnectionInput,
  EXPORT_FORMAT,
  MAX_FILE_BYTES,
  MAX_NAME_LENGTH,
  parseConnectionExport,
  planNames,
  toExportEntry,
  uniqueName,
  type ExportEntry,
} from '../../electron/services/connectionExportFormat';
import { AppError } from '../../electron/errors';

const FAST = { N: 1024, r: 8, p: 1 };
const NOW = new Date('2026-10-02T09:00:00.000Z');
const PASS = 'correct horse battery';

function conn(over: Partial<Connection> = {}): Connection {
  return {
    id: 'id-1',
    name: 'Prod',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'db.example.com',
    port: 27017,
    authMech: 'scram256',
    authUsername: 'alice',
    authDatabase: 'admin',
    tls: { enabled: true, verify: true },
    advanced: {
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
      serverSelectionTimeoutMs: 30_000,
      readPreference: 'primary',
      maxPoolSize: 100,
      directConnection: false,
    },
    hasPasswordStored: true,
    hasSshPasswordStored: false,
    hasSshPassphraseStored: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const entry = (over: Partial<Connection> = {}): ExportEntry => toExportEntry(conn(over));

async function build(
  items: { entry: ExportEntry; secrets?: { password?: string; sshPassword?: string; sshPassphrase?: string } }[],
  passphrase?: string,
  scrypt = FAST,
): Promise<string> {
  return buildConnectionExport({ items, passphrase, now: NOW, scrypt });
}

/** Parse the built text, edit the JSON, and hand back text again. */
function edit(text: string, fn: (file: Record<string, any>) => void): string {
  const file = JSON.parse(text);
  fn(file);
  return JSON.stringify(file);
}

async function plain(): Promise<string> {
  return build([{ entry: entry() }]);
}

function plainSync(): string {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: NOW.toISOString(),
    encryption: null,
    connections: [entry()],
  });
}

async function sealed(): Promise<string> {
  return build([{ entry: entry(), secrets: { password: 'hunter2' } }], PASS);
}

function expectCode(fn: () => unknown, code: string): Promise<void> | void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        () => {
          throw new Error(`expected ${code}, but it resolved`);
        },
        (e: unknown) => {
          expect((e as AppError).code).toBe(code);
        },
      );
    }
  } catch (e) {
    expect((e as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing threw`);
}

describe('encryption', () => {
  it('round-trips every secret of every selected entry', async () => {
    const text = await build(
      [
        { entry: entry({ name: 'A' }), secrets: { password: 'pw-a', sshPassword: 'sp-a', sshPassphrase: 'ph-a' } },
        { entry: entry({ name: 'B' }) },
        { entry: entry({ name: 'C' }), secrets: { password: 'pw-ç·✓' } },
      ],
      PASS,
    );
    const file = parseConnectionExport(text);
    const secrets = await decryptSelected(file, PASS, [0, 1, 2]);
    expect(secrets.get(0)).toEqual({ password: 'pw-a', sshPassword: 'sp-a', sshPassphrase: 'ph-a' });
    expect(secrets.get(1)).toBeUndefined();
    expect(secrets.get(2)).toEqual({ password: 'pw-ç·✓' });
  });

  it('only decrypts the selected entries', async () => {
    const text = await build(
      [
        { entry: entry({ name: 'A' }), secrets: { password: 'pw-a' } },
        { entry: entry({ name: 'B' }), secrets: { password: 'pw-b' } },
      ],
      PASS,
    );
    const secrets = await decryptSelected(parseConnectionExport(text), PASS, [1]);
    expect([...secrets.keys()]).toEqual([1]);
  });

  it('never writes a secret in the clear, and records no encryption block without secrets', async () => {
    const text = await sealed();
    expect(text).not.toContain('hunter2');
    expect(parseConnectionExport(text).encryption).toMatchObject({ kdf: 'scrypt', cipher: 'aes-256-gcm', ...FAST });
    const none = parseConnectionExport(await plain());
    expect(none.encryption).toBeNull();
    expect(none.connections[0]).not.toHaveProperty('secrets');
  });

  it('gives each secret its own IV and each file its own salt', async () => {
    const text = await build(
      [{ entry: entry(), secrets: { password: 'same', sshPassword: 'same' } }],
      PASS,
    );
    const s = parseConnectionExport(text).connections[0]!.secrets!;
    expect(s.password!.iv).not.toBe(s.sshPassword!.iv);
    expect(s.password!.ct).not.toBe(s.sshPassword!.ct);
    const other = parseConnectionExport(await sealed());
    expect(other.encryption!.salt).not.toBe(parseConnectionExport(text).encryption!.salt);
  });

  it('a secret requires a passphrase to build', async () => {
    await expectCode(() => build([{ entry: entry(), secrets: { password: 'x' } }]), 'VALIDATION');
  });

  it('an empty-string secret is not a secret', async () => {
    const file = parseConnectionExport(await build([{ entry: entry(), secrets: { password: '' } }], PASS));
    expect(file.encryption).toBeNull();
  });

  it('a wrong passphrase is BAD_PASSPHRASE', async () => {
    const file = parseConnectionExport(await sealed());
    await expectCode(() => decryptSelected(file, 'not the passphrase', [0]), 'BAD_PASSPHRASE');
  });

  it('a missing passphrase is a validation error, not a bad passphrase', async () => {
    const file = parseConnectionExport(await sealed());
    await expectCode(() => decryptSelected(file, undefined, [0]), 'VALIDATION');
  });

  it('needs no passphrase when none of the selected entries has secrets', async () => {
    const text = await build(
      [{ entry: entry({ name: 'A' }) }, { entry: entry({ name: 'B' }), secrets: { password: 'x' } }],
      PASS,
    );
    expect((await decryptSelected(parseConnectionExport(text), undefined, [0])).size).toBe(0);
  });

  it.each(['ct', 'tag', 'iv'] as const)('a flipped byte in %s is rejected on the first secret', async (part) => {
    const text = edit(await sealed(), (f) => {
      const buf = Buffer.from(f.connections[0].secrets.password[part], 'base64');
      buf[0] = buf[0]! ^ 0xff;
      f.connections[0].secrets.password[part] = buf.toString('base64');
    });
    await expectCode(() => decryptSelected(parseConnectionExport(text), PASS, [0]), 'BAD_PASSPHRASE');
  });

  it('a damaged secret after a good one is a damaged file, not a wrong passphrase', async () => {
    const text = edit(
      await build(
        [{ entry: entry({ name: 'A' }), secrets: { password: 'ok' } }, { entry: entry({ name: 'B' }), secrets: { password: 'bad' } }],
        PASS,
      ),
      (f) => {
        const buf = Buffer.from(f.connections[1].secrets.password.ct, 'base64');
        buf[0] = buf[0]! ^ 0xff;
        f.connections[1].secrets.password.ct = buf.toString('base64');
      },
    );
    await expectCode(() => decryptSelected(parseConnectionExport(text), PASS, [0, 1]), 'VALIDATION');
  });

  it('reads the scrypt parameters from the file, not from a constant', async () => {
    const text = await sealed();
    expect((await decryptSelected(parseConnectionExport(text), PASS, [0])).get(0)).toEqual({ password: 'hunter2' });
    const changed = edit(text, (f) => {
      f.encryption.N = 2048;
    });
    await expectCode(() => decryptSelected(parseConnectionExport(changed), PASS, [0]), 'BAD_PASSPHRASE');
    const otherR = edit(text, (f) => {
      f.encryption.r = 16;
    });
    await expectCode(() => decryptSelected(parseConnectionExport(otherR), PASS, [0]), 'BAD_PASSPHRASE');
    const otherP = edit(text, (f) => {
      f.encryption.p = 2;
    });
    await expectCode(() => decryptSelected(parseConnectionExport(otherP), PASS, [0]), 'BAD_PASSPHRASE');
  });

  it('reads the salt from the file too', async () => {
    const changed = edit(await sealed(), (f) => {
      f.encryption.salt = Buffer.alloc(16, 7).toString('base64');
    });
    await expectCode(() => decryptSelected(parseConnectionExport(changed), PASS, [0]), 'BAD_PASSPHRASE');
  });

  it('records the default 131072/8/1 when no parameters are given, and round-trips at that cost', async () => {
    const text = await buildConnectionExport({
      items: [{ entry: entry(), secrets: { password: 'pw' } }],
      passphrase: PASS,
      now: NOW,
    });
    const file = parseConnectionExport(text);
    expect(file.encryption).toMatchObject({ N: 131_072, r: 8, p: 1 });
    expect(DEFAULT_SCRYPT).toEqual({ N: 131_072, r: 8, p: 1 });
    expect((await decryptSelected(file, PASS, [0])).get(0)).toEqual({ password: 'pw' });
  });

  it('stamps the file with the format, version and export time', async () => {
    const file = parseConnectionExport(await plain());
    expect(file).toMatchObject({ format: EXPORT_FORMAT, version: 1, exportedAt: '2026-10-02T09:00:00.000Z' });
  });

  it('writes readable, indented JSON', async () => {
    expect(await plain()).toContain('\n  "format"');
  });
});

describe('parseConnectionExport', () => {
  const fileOf = async () => JSON.parse(await plain()) as Record<string, any>;
  const parse = (f: unknown) => parseConnectionExport(JSON.stringify(f));
  const message = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('did not throw');
  };

  it('accepts what build produced', async () => {
    const file = parse(await fileOf());
    expect(file.connections).toHaveLength(1);
    expect(file.connections[0]!.name).toBe('Prod');
  });

  it('refuses a newer version with the update message', async () => {
    const f = await fileOf();
    f.version = 2;
    expect(message(() => parse(f))).toBe("This file was made by a newer version of L'Atelier. Update to import it.");
  });

  it('refuses a version below 1 and a non-numeric one as invalid', async () => {
    for (const v of [0, '1', null]) {
      const f = await fileOf();
      f.version = v;
      await expectCode(() => parse(f), 'VALIDATION');
    }
  });

  it('refuses a different format, and a non-object, as not an export', async () => {
    const f = await fileOf();
    f.format = 'something.else';
    expect(message(() => parse(f))).toBe("This file isn't a L'Atelier Connection Export.");
    for (const v of [[], null, 'text', 3]) {
      expect(message(() => parseConnectionExport(JSON.stringify(v)))).toBe(
        "This file isn't a L'Atelier Connection Export.",
      );
    }
  });

  it('checks the format before the version', async () => {
    const f = await fileOf();
    f.format = 'something.else';
    f.version = 9;
    expect(message(() => parse(f))).toContain("isn't a L'Atelier Connection Export");
  });

  it('rejects malformed JSON as a validation error', async () => {
    await expectCode(() => parseConnectionExport('{nope'), 'VALIDATION');
    expect(message(() => parseConnectionExport('{nope'))).toBe("This file isn't valid JSON.");
  });

  it('rejects an unknown field at the root and on an entry', async () => {
    const root = await fileOf();
    root.extra = 1;
    await expectCode(() => parse(root), 'VALIDATION');
    const ent = await fileOf();
    ent.connections[0].extra = 1;
    await expectCode(() => parse(ent), 'VALIDATION');
    const adv = await fileOf();
    adv.connections[0].advanced.extra = 1;
    await expectCode(() => parse(adv), 'VALIDATION');
  });

  it.each([
    ['tls.clientCertPath', (e: any) => (e.tls.clientCertPath = '/home/me/.ssh/id_rsa')],
    ['tls.caPath', (e: any) => (e.tls.caPath = '/etc/ca.pem')],
    ['ssh.privateKeyPath', (e: any) => (e.ssh = { enabled: false, privateKeyPath: '/k' })],
    ['flat tlsClientCertPath', (e: any) => (e.tlsClientCertPath = '/k')],
    ['flat tlsCaPath', (e: any) => (e.tlsCaPath = '/k')],
    ['flat sshPrivateKeyPath', (e: any) => (e.sshPrivateKeyPath = '/k')],
    ['plaintext password', (e: any) => (e.password = 'pw')],
    ['plaintext sshPassword', (e: any) => (e.sshPassword = 'pw')],
    ['plaintext sshPassphrase', (e: any) => (e.sshPassphrase = 'pw')],
  ])('rejects %s on an entry', async (_label, mutate) => {
    const f = await fileOf();
    mutate(f.connections[0]);
    await expectCode(() => parse(f), 'VALIDATION');
  });

  it('rejects secrets while encryption is null, and accepts them when it is recorded', async () => {
    const text = await sealed();
    const stripped = edit(text, (f) => {
      f.encryption = null;
    });
    await expectCode(() => parseConnectionExport(stripped), 'VALIDATION');
    expect(() => parseConnectionExport(text)).not.toThrow();
  });

  it('allows a recorded encryption block with no secrets (they were all omitted)', async () => {
    const f = JSON.parse(await sealed());
    delete f.connections[0].secrets;
    expect(() => parse(f)).not.toThrow();
  });

  it.each([
    ['N not a power of 2', { N: 3000 }],
    ['N below the floor', { N: 512 }],
    ['N above the cap', { N: 2 ** 22 }],
    ['N × r above the cap', { N: 2 ** 17, r: 32 }],
    ['r zero', { r: 0 }],
    ['r above the cap', { r: 33 }],
    ['p zero', { p: 0 }],
    ['p above the cap', { p: 5 }],
    ['non-integer N', { N: 1024.5 }],
    ['another kdf', { kdf: 'pbkdf2' }],
    ['another cipher', { cipher: 'aes-128-gcm' }],
    ['a short salt', { salt: Buffer.alloc(8).toString('base64') }],
    ['an unknown field', { extra: true }],
  ])('rejects out-of-bounds or unknown encryption parameters: %s', async (_label, patch) => {
    const text = edit(await sealed(), (f) => Object.assign(f.encryption, patch));
    await expectCode(() => parseConnectionExport(text), 'VALIDATION');
  });

  // Real scrypt at the largest accepted cost (N 2^20, r 2: about 256 MB), twice per
  // row, so its run time follows how busy the machine is; the default 5s is not enough
  // on a loaded runner.
  it('accepts parameters at the bounds, and each one really derives a key', { timeout: 60_000 }, async () => {
    // A bound the parser accepts but OpenSSL refuses would be a file nobody can open.
    for (const params of [{ N: 2 ** 15, r: 1, p: 1 }, { N: 2 ** 16, r: 2, p: 4 }, { N: 2 ** 20, r: 2, p: 1 }, { N: 1024, r: 1, p: 1 }]) {
      const text = await build([{ entry: entry(), secrets: { password: 'pw' } }], PASS, params);
      const file = parseConnectionExport(text);
      expect((await decryptSelected(file, PASS, [0])).get(0)).toEqual({ password: 'pw' });
    }
  });

  it('rejects N >= 2^(16 r), which OpenSSL cannot run, with its own message', async () => {
    for (const patch of [{ N: 2 ** 16, r: 1 }, { N: 2 ** 17, r: 1 }, { N: 2 ** 21, r: 1 }]) {
      const text = edit(await sealed(), (f) => Object.assign(f.encryption, patch));
      let message = '';
      try {
        parseConnectionExport(text);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('N must be below 2^(16 × r)');
    }
  });

  it.each([
    ['iv of the wrong length', (s: any) => (s.iv = Buffer.alloc(11).toString('base64'))],
    ['tag of the wrong length', (s: any) => (s.tag = Buffer.alloc(15).toString('base64'))],
    ['ct not base64', (s: any) => (s.ct = 'not base64!!')],
    ['empty ct', (s: any) => (s.ct = '')],
    ['unknown sealed field', (s: any) => (s.extra = 1)],
  ])('rejects a malformed sealed secret: %s', async (_label, mutate) => {
    const text = edit(await sealed(), (f) => mutate(f.connections[0].secrets.password));
    await expectCode(() => parseConnectionExport(text), 'VALIDATION');
  });

  it('rejects an empty connections list, and more than 1000', async () => {
    const f = await fileOf();
    f.connections = [];
    await expectCode(() => parse(f), 'VALIDATION');
    const g = await fileOf();
    g.connections = Array.from({ length: 1001 }, (_, i) => ({ ...g.connections[0], name: `c${i}` }));
    await expectCode(() => parse(g), 'VALIDATION');
  });

  it('rejects a bad exportedAt', async () => {
    const f = await fileOf();
    f.exportedAt = 'yesterday';
    await expectCode(() => parse(f), 'VALIDATION');
  });

  it('accepts an x509 entry that has no certificate path, and a scram entry without secrets', () => {
    const x509 = toExportEntry(conn({ authMech: 'x509', authUsername: 'CN=client' }));
    const parsed = parseConnectionExport(
      JSON.stringify({
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: NOW.toISOString(),
        encryption: null,
        connections: [x509, entry()],
      }),
    );
    expect(parsed.connections.map((c) => c.authMech)).toEqual(['x509', 'scram256']);
  });

  it('accepts an entry with ssh enabled and stores it as-is', async () => {
    const e = toExportEntry(conn({ ssh: { enabled: true, host: 'bastion', port: 22, username: 'me', authMethod: 'key' } }));
    const file = parseConnectionExport(await build([{ entry: e }]));
    expect(file.connections[0]!.ssh).toEqual({ enabled: true, host: 'bastion', port: 22, username: 'me', authMethod: 'key' });
  });

  it('keeps the cross-field rules that survive an import: x509 needs TLS, scram needs a user', async () => {
    const f = await fileOf();
    f.connections[0].authMech = 'x509';
    f.connections[0].tls.enabled = false;
    await expectCode(() => parse(f), 'VALIDATION');
    const g = await fileOf();
    delete g.connections[0].authUsername;
    await expectCode(() => parse(g), 'VALIDATION');
  });

  it('rejects a name or host that is only whitespace', async () => {
    const f = await fileOf();
    f.connections[0].name = '   ';
    expect(message(() => parse(f))).toContain('connections.0.name');
    const g = await fileOf();
    g.connections[0].host = '  ';
    expect(message(() => parse(g))).toContain('connections.0.host');
  });

  it('reports the path of the first problem and lists every issue in details', async () => {
    const f = await fileOf();
    f.connections[0].port = 0;
    f.connections[0].color = 'red';
    try {
      parse(f);
      throw new Error('did not throw');
    } catch (e) {
      const err = e as AppError;
      expect(err.message).toContain('connections.0.');
      expect((err.details as { issues: unknown[] }).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('drops a __proto__ key instead of carrying it into the parsed entry', async () => {
    const text = (await plain()).replace('"name": "Prod"', '"name": "Prod", "__proto__": {"x": 1}');
    const entry = parseConnectionExport(text).connections[0]!;
    expect(Object.hasOwn(entry, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('toExportEntry / entryToConnectionInput', () => {
  it('drops the id, the timestamps, the has*Stored flags and the three credential paths', () => {
    const e = toExportEntry(
      conn({
        tls: { enabled: true, verify: false, caPath: '/ca.pem', clientCertPath: '/c.pem' },
        ssh: { enabled: false, host: 'h', privateKeyPath: '/k' },
        lastUsedAt: '2026-02-02T00:00:00Z',
      }),
    );
    const json = JSON.stringify(e);
    for (const leaked of ['id-1', '2026-01-01', '2026-02-02', 'has', '/ca.pem', '/c.pem', '/k', 'Path']) {
      expect(json).not.toContain(leaked);
    }
    expect(e.tls).toEqual({ enabled: true, verify: false });
    expect(e.ssh).toEqual({ enabled: false, host: 'h' });
  });

  it('records which credential files will need picking again', () => {
    expect(toExportEntry(conn()).repick).toBeUndefined();
    expect(toExportEntry(conn({ tls: { enabled: true, verify: true, caPath: '/ca' } })).repick).toEqual(['tlsCa']);
    expect(
      toExportEntry(
        conn({
          tls: { enabled: true, verify: true, caPath: '/ca', clientCertPath: '/cc' },
          ssh: { enabled: false, privateKeyPath: '/k' },
        }),
      ).repick,
    ).toEqual(['tlsCa', 'tlsClientCert', 'sshKey']);
    expect(toExportEntry(conn({ tls: { enabled: true, verify: true, caPath: '' } })).repick).toBeUndefined();
  });

  it('keeps every other field, and omits optional ones that are unset', () => {
    const e = toExportEntry(conn({ defaultDb: 'app', readOnly: true }));
    expect(e).toMatchObject({
      name: 'Prod',
      color: '#1A6835',
      connectionType: 'standard',
      readOnly: true,
      host: 'db.example.com',
      port: 27017,
      defaultDb: 'app',
      authMech: 'scram256',
      authUsername: 'alice',
      authDatabase: 'admin',
    });
    const bare = toExportEntry(conn({ authUsername: undefined, authDatabase: undefined }));
    expect('defaultDb' in bare).toBe(false);
    expect('authUsername' in bare).toBe(false);
    expect('ssh' in bare).toBe(false);
    expect('appName' in bare.advanced).toBe(false);
  });

  it('entryToConnectionInput carries no secrets and no export bookkeeping', async () => {
    const parsed = parseConnectionExport(
      await build([{ entry: toExportEntry(conn({ tls: { enabled: true, verify: true, caPath: '/ca' } })), secrets: { password: 'pw' } }], PASS),
    );
    const input = entryToConnectionInput(parsed.connections[0]!);
    expect(input).not.toHaveProperty('secrets');
    expect(input).not.toHaveProperty('repick');
    expect(input).not.toHaveProperty('password');
    expect(input.name).toBe('Prod');
    expect(parsed.connections[0]).toHaveProperty('secrets');
  });
});

describe('name planning', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('Prod', new Set(['Dev']))).toBe('Prod');
  });

  it('clamps a name past the limit, then resolves a clash on the clamped name', () => {
    const long = `${'a'.repeat(63)} b${'c'.repeat(20)}`;
    expect(uniqueName(long, new Set())).toBe('a'.repeat(63));
    expect(uniqueName(long, new Set(['a'.repeat(63)]))).toBe(`${'a'.repeat(60)} (2)`);
  });

  it('Prod → Prod (2); with Prod (2) taken → Prod (3)', () => {
    expect(uniqueName('Prod', new Set(['Prod']))).toBe('Prod (2)');
    expect(uniqueName('Prod', new Set(['Prod', 'Prod (2)']))).toBe('Prod (3)');
    expect(uniqueName('Prod', new Set(['Prod', 'Prod (2)', 'Prod (3)', 'Prod (4)']))).toBe('Prod (5)');
  });

  it('clashes inside one file: [Prod, Prod] → [Prod, Prod (2)]', () => {
    expect(planNames([], ['Prod', 'Prod'])).toEqual(['Prod', 'Prod (2)']);
    expect(planNames(['Prod'], ['Prod', 'Prod', 'Prod (2)'])).toEqual(['Prod (2)', 'Prod (3)', 'Prod (2) (2)']);
  });

  it('is case-sensitive, like the table index', () => {
    expect(planNames(['prod'], ['Prod'])).toEqual(['Prod']);
  });

  it('plans the normalized name, because create() normalizes', () => {
    expect(planNames(['Prod East'], ['  Prod   East '])).toEqual(['Prod East (2)']);
  });

  it('keeps a long name within the limit by cutting its base', () => {
    const long = 'x'.repeat(MAX_NAME_LENGTH);
    const [first, second, third] = planNames([long], [long, long, long]);
    expect(first).toBe(`${'x'.repeat(MAX_NAME_LENGTH - 4)} (2)`);
    expect(second).toBe(`${'x'.repeat(MAX_NAME_LENGTH - 4)} (3)`);
    expect(third!.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('does not leave a double space where the cut falls on a space', () => {
    const base = `${'x'.repeat(MAX_NAME_LENGTH - 5)} y`;
    expect(base).toHaveLength(MAX_NAME_LENGTH - 3);
    const planned = uniqueName(base, new Set([base]));
    expect(planned).not.toContain('  ');
    expect(planned.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it('a ten-digit suffix still fits the limit', () => {
    const long = 'x'.repeat(MAX_NAME_LENGTH);
    const taken = new Set([long]);
    for (let n = 2; n < 12; n++) taken.add(uniqueName(long, taken));
    expect([...taken].every((n) => n.length <= MAX_NAME_LENGTH)).toBe(true);
    expect(taken.size).toBe(11);
  });
});

describe('the contract the rest of the app relies on', () => {
  const failure = (fn: () => unknown): AppError & { details: { issues: { path: unknown[]; message: string }[] } } => {
    try {
      fn();
    } catch (e) {
      return e as never;
    }
    throw new Error('did not throw');
  };

  it('pins the format name and the file size limit', () => {
    expect(EXPORT_FORMAT).toBe('latelier.connection-export');
    expect(MAX_FILE_BYTES).toBe(5_242_880);
  });

  it('says why each rule failed', async () => {
    const text = await sealed();
    const issueFor = (patch: (f: Record<string, any>) => void) =>
      failure(() => parseConnectionExport(edit(text, patch))).details.issues.map((i) => i.message);

    expect(issueFor((f) => (f.encryption.N = 3000))).toContain('N must be a power of 2');
    expect(issueFor((f) => ((f.encryption.N = 2 ** 17), (f.encryption.r = 32)))).toContain(
      'scrypt cost (N × r) is too high',
    );
    expect(issueFor((f) => (f.connections[0].secrets.password.iv = Buffer.alloc(11).toString('base64')))).toContain(
      'must decode to 12 bytes',
    );
    expect(issueFor((f) => (f.connections[0].secrets.password.tag = Buffer.alloc(15).toString('base64')))).toContain(
      'must decode to 16 bytes',
    );
    expect(issueFor((f) => (f.connections[0].name = '  '))).toContain('Name must not be blank');
    expect(issueFor((f) => (f.connections[0].host = '  '))).toContain('Host must not be blank');
    expect(issueFor((f) => (f.encryption = null))).toContain(
      'A file with encrypted secrets must record how they were encrypted',
    );
  });

  it('points each rule at the field it is about', async () => {
    const text = await sealed();
    const pathFor = (patch: (f: Record<string, any>) => void) =>
      failure(() => parseConnectionExport(edit(text, patch))).details.issues.map((i) => i.path.join('.'));
    expect(pathFor((f) => (f.connections[0].name = ' '))).toContain('connections.0.name');
    expect(pathFor((f) => (f.connections[0].host = ' '))).toContain('connections.0.host');
    expect(pathFor((f) => (f.encryption = null))).toContain('encryption');
  });

  it('names a root-level problem as (root), and a nested one by its path', async () => {
    const f = JSON.parse(await plain());
    f.extra = 1;
    expect(failure(() => parseConnectionExport(JSON.stringify(f))).message).toMatch(/^Invalid Connection Export at \(root\): /);
    const g = JSON.parse(await plain());
    g.connections[0].port = 0;
    expect(failure(() => parseConnectionExport(JSON.stringify(g))).message).toMatch(/at connections\.0\.port: /);
  });

  it('a string version is invalid, not "newer", however large it reads', async () => {
    const f = JSON.parse(await plain());
    f.version = '2';
    expect(failure(() => parseConnectionExport(JSON.stringify(f))).message).not.toContain('newer');
    f.version = 1.5;
    expect(failure(() => parseConnectionExport(JSON.stringify(f))).code).toBe('VALIDATION');
  });

  it('accepts every re-pick marker and nothing else', async () => {
    const withRepick = (repick: unknown) => {
      const f = JSON.parse(plainSync());
      f.connections[0].repick = repick;
      return JSON.stringify(f);
    };
    expect(() => parseConnectionExport(withRepick(['tlsCa', 'tlsClientCert', 'sshKey']))).not.toThrow();
    for (const bad of [['bogus'], ['tlsCa', 'tlsClientCert', 'sshKey', 'tlsCa'], 'tlsCa']) {
      expect(() => parseConnectionExport(withRepick(bad))).toThrow();
    }
  });

  it('secrets in one entry with encryption null are rejected even when other entries have none', async () => {
    const f = JSON.parse(await sealed());
    f.connections.unshift({ ...f.connections[0], name: 'Plain' });
    delete f.connections[0].secrets;
    f.encryption = null;
    await expectCode(() => parseConnectionExport(JSON.stringify(f)), 'VALIDATION');
  });

  it('says what is missing when a passphrase is not given', async () => {
    await expect(build([{ entry: entry(), secrets: { password: 'x' } }])).rejects.toThrow('required to include passwords');
    const file = parseConnectionExport(await sealed());
    await expect(decryptSelected(file, undefined, [0])).rejects.toThrow('required to import passwords');
  });

  it('a wrong passphrase and a damaged file read differently to the user', async () => {
    const file = parseConnectionExport(await sealed());
    await expect(decryptSelected(file, 'not the passphrase', [0])).rejects.toThrow('Wrong Export Passphrase.');
    const two = parseConnectionExport(
      await build(
        [{ entry: entry({ name: 'A' }), secrets: { password: 'a' } }, { entry: entry({ name: 'B' }), secrets: { password: 'b' } }],
        PASS,
      ),
    );
    two.connections[1]!.secrets!.password!.ct = Buffer.from('zz').toString('base64');
    await expect(decryptSelected(two, PASS, [0, 1])).rejects.toThrow(/damaged/);
  });

  it('refuses secrets with no recorded encryption, for a file that skipped the parser', async () => {
    const file = parseConnectionExport(await sealed());
    file.encryption = null;
    await expectCode(() => decryptSelected(file, PASS, [0]), 'VALIDATION');
  });

  it('ignores an index that is not in the file (the service validates indices before it gets here)', async () => {
    const file = parseConnectionExport(await sealed());
    const out = await decryptSelected(file, PASS, [0, 9]);
    expect([...out.keys()]).toEqual([0]);
  });
});
