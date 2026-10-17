import { createCipheriv, pbkdf2, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EJSON } from 'bson';
import { describe, expect, it, vi } from 'vitest';
import { decryptCompassSecrets } from '../../electron/services/import/compassCrypto';
import { AppError } from '../../electron/errors';

// Wraps the real pbkdf2 so a test can see whether a key was derived; every
// other test still runs the real thing through the wrapper.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, pbkdf2: vi.fn(actual.pbkdf2) };
});

// Fixtures exported by MongoDB Compass 1.49.7 (see docs/agents/c14-plan.md §9 L1).
const DIR = path.join(__dirname, '../fixtures/compass');
const PASS = readFileSync(path.join(DIR, 'passphrase.txt'), 'utf8').trim();
const encrypted = EJSON.parse(readFileSync(path.join(DIR, 'encrypted.json'), 'utf8')) as {
  connections: { favorite: { name: string }; connectionSecrets: string }[];
};
const blobs = encrypted.connections.map((c) => c.connectionSecrets);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).code;
  }
  throw new Error('expected a throw');
}

/** Builds a blob with Compass's layout from our own reading of it — never stands in for the real fixture. */
function syntheticBlob(plaintext: string, opts: { version?: number; pass?: string } = {}): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(opts.pass ?? PASS, salt, 100_000, 32, 'sha512');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const version = Buffer.alloc(2);
  version.writeUInt16BE(opts.version ?? 1);
  return Buffer.concat([version, salt, iv, cipher.getAuthTag(), ct]).toString('base64');
}

describe('decryptCompassSecrets — real Compass export', () => {
  it('opens every entry of encrypted.json with the fixture passphrase', async () => {
    expect(await Promise.all(blobs.map((b) => decryptCompassSecrets(b, PASS)))).toEqual([
      { secrets: { password: 'fixture-pw-1' }, dropped: [] },
      { secrets: { password: 'fixture-pw-2', sshPassword: 'fixture-ssh-pw' }, dropped: [] },
      { secrets: { password: 'fixture-pw-3', sshPassphrase: 'fixture-key-pass' }, dropped: [] },
      { secrets: {}, dropped: [] },
    ]);
  });

  it('a wrong passphrase is BAD_PASSPHRASE', async () => {
    expect(await codeOf(decryptCompassSecrets(blobs[0]!, `${PASS}x`))).toBe('BAD_PASSPHRASE');
    await expect(decryptCompassSecrets(blobs[0]!, `${PASS}x`)).rejects.toThrow('Wrong passphrase for this Compass export.');
  });

  it('the passphrase is used as given, not trimmed', async () => {
    expect(await codeOf(decryptCompassSecrets(blobs[0]!, `${PASS}\n`))).toBe('BAD_PASSPHRASE');
  });

  it('a tampered tag is BAD_PASSPHRASE', async () => {
    const buf = Buffer.from(blobs[1]!, 'base64');
    buf[40]! ^= 0x01;
    expect(await codeOf(decryptCompassSecrets(buf.toString('base64'), PASS))).toBe('BAD_PASSPHRASE');
  });

  it('a tampered ciphertext is BAD_PASSPHRASE', async () => {
    const buf = Buffer.from(blobs[1]!, 'base64');
    buf[buf.length - 1]! ^= 0x01;
    expect(await codeOf(decryptCompassSecrets(buf.toString('base64'), PASS))).toBe('BAD_PASSPHRASE');
  });

  it('a version other than 1 is refused before any key is derived', async () => {
    const buf = Buffer.from(blobs[0]!, 'base64');
    buf.writeUInt16BE(2, 0);
    vi.mocked(pbkdf2).mockClear();
    await expect(decryptCompassSecrets(buf.toString('base64'), PASS)).rejects.toThrow(
      "This Compass export's secrets use an unsupported format.",
    );
    expect(pbkdf2).not.toHaveBeenCalled();
  });
});

describe('decryptCompassSecrets — malformed blobs', () => {
  it('rejects text that is not base64', async () => {
    await expect(decryptCompassSecrets(`${blobs[0]!.slice(0, 20)}!${blobs[0]!.slice(21)}`, PASS)).rejects.toThrow(
      "This Compass export's secrets are damaged.",
    );
  });

  it('rejects a blob shorter than its 50-byte header', async () => {
    const header = Buffer.from(blobs[3]!, 'base64').subarray(0, 49).toString('base64');
    await expect(decryptCompassSecrets(header, PASS)).rejects.toThrow("This Compass export's secrets are damaged.");
  });

  it('a header with no ciphertext reaches the cipher (and fails authentication)', async () => {
    const header = Buffer.from(blobs[3]!, 'base64').subarray(0, 50).toString('base64');
    expect(await codeOf(decryptCompassSecrets(header, PASS))).toBe('BAD_PASSPHRASE');
  });

  it('synthetic: authenticated plaintext that is not JSON is damaged, not a wrong passphrase', async () => {
    await expect(decryptCompassSecrets(syntheticBlob('not json'), PASS)).rejects.toThrow(
      "This Compass export's secrets are damaged.",
    );
  });

  it('synthetic: plaintext without a secrets object is damaged', async () => {
    expect(await codeOf(decryptCompassSecrets(syntheticBlob('{"password":"x"}'), PASS))).toBe('VALIDATION');
    expect(await codeOf(decryptCompassSecrets(syntheticBlob('{"secrets":"x"}'), PASS))).toBe('VALIDATION');
  });
});

describe('decryptCompassSecrets — secrets L’Atelier has no place for', () => {
  it('synthetic: names other secrets in dropped, never their values, and skips empty ones', async () => {
    const blob = syntheticBlob(
      JSON.stringify({
        secrets: {
          password: 'pw-value',
          awsSessionToken: 'aws-value',
          proxyPassword: 'proxy-value',
          autoEncryption: { kmsProviders: { local: { key: 'k' } } },
          tlsCertificateKeyFilePassword: '',
          oidcSerializedState: null,
          sshTunnelPassphrase: '',
        },
      }),
    );
    const out = await decryptCompassSecrets(blob, PASS);
    expect(out).toEqual({
      secrets: { password: 'pw-value' },
      dropped: ['awsSessionToken', 'proxyPassword', 'autoEncryption'],
    });
    expect(JSON.stringify(out.dropped)).not.toMatch(/aws-value|proxy-value/);
  });

  it('synthetic: a kept name holding a non-string is dropped, not stored', async () => {
    const blob = syntheticBlob(JSON.stringify({ secrets: { sshTunnelPassword: 42, constructor: 'c' } }));
    expect(await decryptCompassSecrets(blob, PASS)).toEqual({ secrets: {}, dropped: ['sshTunnelPassword', 'constructor'] });
  });

  it('synthetic: a different passphrase than the one sealed with is BAD_PASSPHRASE', async () => {
    expect(await codeOf(decryptCompassSecrets(syntheticBlob('{"secrets":{}}', { pass: 'other' }), PASS))).toBe(
      'BAD_PASSPHRASE',
    );
  });
});
