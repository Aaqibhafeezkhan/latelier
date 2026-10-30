import { describe, it, expect } from 'vitest';
import { columnKeyDialogCopy } from '../../electron/db/columnKeyStore';

describe('columnKeyDialogCopy', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'treats an unavailable keychain on %s as unreachable, steering away from Reset',
    (platform) => {
      const copy = columnKeyDialogCopy(false, platform);
      expect(copy.kind).toBe('unreachable');
      expect(copy.message).toMatch(/can't be reached right now/);
      expect(copy.detail).toMatch(/Only if the keychain is gone for good: Reset protected data/);
      expect(copy.detail).not.toMatch(/removed or reset/);
    },
  );

  it('tells macOS users to relaunch and click Always Allow', () => {
    expect(columnKeyDialogCopy(false, 'darwin').detail).toMatch(/click Always Allow/);
  });

  it.each(['linux', 'win32'] as const)('tells %s users to start again from their desktop session', (platform) => {
    const { detail } = columnKeyDialogCopy(false, platform);
    expect(detail).toMatch(/start L'Atelier again from your normal desktop session/);
    expect(detail).not.toMatch(/Always Allow/);
  });

  it.each(['darwin', 'linux', 'win32'] as const)(
    'treats an available keychain that cannot decrypt on %s as a key that is gone',
    (platform) => {
      const copy = columnKeyDialogCopy(true, platform);
      expect(copy.kind).toBe('gone');
      expect(copy.detail).toMatch(/removed or reset/);
      expect(copy.detail).not.toMatch(/Only if the keychain is gone for good/);
    },
  );
});
