import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  REDACTED_KEYS,
  isSecretFieldPath as mainIsSecretFieldPath,
} from '../../electron/log';
import {
  SECRET_FIELD_KEYS,
  isSecretFieldPath,
} from '../../src/utils/secretFieldPath';

// The renderer cannot import electron/log.ts (it pulls in node:fs), so it
// keeps its own copy of the list. These tests fail the moment the two drift.
describe('isSecretFieldPath (renderer copy)', () => {
  it('holds exactly the key list main redacts and refuses to record', () => {
    const sorted = (s: ReadonlySet<string>) => [...s].sort((a, b) => a.localeCompare(b));
    expect(sorted(SECRET_FIELD_KEYS)).toEqual(sorted(REDACTED_KEYS));
  });

  it('flags a secret segment at any depth, in any casing', () => {
    expect(isSecretFieldPath('token')).toBe(true);
    expect(isSecretFieldPath('auth.PassWord')).toBe(true);
    expect(isSecretFieldPath('a.b.secret')).toBe(true);
    expect(isSecretFieldPath('status')).toBe(false);
    expect(isSecretFieldPath('tokens')).toBe(false);
    expect(isSecretFieldPath('')).toBe(false);
  });

  it('agrees with main for every generated path', () => {
    const keys = [...REDACTED_KEYS];
    const segment = fc.oneof(
      fc.constantFrom(...keys).map((k) => k.toUpperCase()),
      fc.constantFrom(...keys),
      fc.string({ maxLength: 8 }),
    );
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segs) => {
        const path = segs.join('.');
        expect(isSecretFieldPath(path)).toBe(mainIsSecretFieldPath(path));
      }),
    );
  });
});
