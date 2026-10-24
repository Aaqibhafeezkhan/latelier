/**
 * The renderer's copy of `REDACTED_KEYS` in `electron/log.ts`: field names
 * whose values are redacted from logs and never recorded as value history.
 * `electron/log.ts` pulls in `node:fs`, so the renderer cannot import it;
 * `tests/unit/secret-field-path.spec.ts` fails the moment the lists drift.
 */
export const SECRET_FIELD_KEYS: ReadonlySet<string> = new Set([
  'password', 'pwd', 'sshpassword', 'sshpassphrase',
  'passphrase', 'secret', 'token', 'apikey', 'authorization',
  'ssh_password', 'ssh_passphrase',
]);

/** True when any segment of a dotted field path is a secret key name, in any casing. */
export function isSecretFieldPath(field: string): boolean {
  return field.split('.').some((segment) => SECRET_FIELD_KEYS.has(segment.toLowerCase()));
}
