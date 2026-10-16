import { createDecipheriv, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BadPassphraseError, ValidationError } from '../../errors.ts';
import type { SecretValues } from '../connectionExportFormat.ts';

/*
 * MongoDB Compass's `connectionSecrets` blob (its connection-storage package,
 * `encrypt.ts`): u16 big-endian version | 16-byte salt | 16-byte IV |
 * 16-byte GCM tag | ciphertext. Key = PBKDF2-SHA512(passphrase, salt, 100000,
 * 32 bytes); AES-256-GCM with no additional data. The plaintext is
 * `{"secrets":{…}}`. Pinned by the real Compass export in tests/fixtures/compass.
 */
const VERSION = 1;
const SALT_END = 2 + 16;
const IV_END = SALT_END + 16;
const HEADER_LENGTH = IV_END + 16;

/** Compass's secret names that L'Atelier keeps, and where they go. */
const KEPT = new Map<string, keyof SecretValues>([
  ['password', 'password'],
  ['sshTunnelPassword', 'sshPassword'],
  ['sshTunnelPassphrase', 'sshPassphrase'],
]);

const Plaintext = z.object({ secrets: z.record(z.string(), z.unknown()) });

// Async so 100,000 SHA-512 rounds per sealed entry never block the main process.
const pbkdf2Async = promisify(pbkdf2);

const DAMAGED = "This Compass export's secrets are damaged.";

/**
 * Opens one entry's `connectionSecrets`. `dropped` names the secrets Compass
 * stored that a Connection has no place for (never their values).
 */
export async function decryptCompassSecrets(
  blob: string,
  passphrase: string,
): Promise<{ secrets: SecretValues; dropped: string[] }> {
  const buf = Buffer.from(blob, 'base64');
  // Buffer.from skips characters that aren't base64 instead of failing.
  if (buf.toString('base64') !== blob || buf.length < HEADER_LENGTH) throw new ValidationError(DAMAGED);
  if (buf.readUInt16BE(0) !== VERSION) {
    throw new ValidationError("This Compass export's secrets use an unsupported format.");
  }
  const key = await pbkdf2Async(passphrase, buf.subarray(2, SALT_END), 100_000, 32, 'sha512');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(SALT_END, IV_END));
  decipher.setAuthTag(buf.subarray(IV_END, HEADER_LENGTH));
  let text: string;
  try {
    text = Buffer.concat([decipher.update(buf.subarray(HEADER_LENGTH)), decipher.final()]).toString('utf8');
  } catch {
    // GCM cannot tell a wrong passphrase from a tampered blob.
    throw new BadPassphraseError('Wrong passphrase for this Compass export.');
  }
  let parsed: z.infer<typeof Plaintext>;
  try {
    parsed = Plaintext.parse(JSON.parse(text));
  } catch {
    throw new ValidationError(DAMAGED);
  }
  const secrets: SecretValues = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(parsed.secrets)) {
    if (value === null || value === '') continue;
    const field = KEPT.get(name);
    if (field && typeof value === 'string') secrets[field] = value;
    else dropped.push(name);
  }
  return { secrets, dropped };
}
