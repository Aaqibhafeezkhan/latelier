import { describe, it, expect } from 'vitest';
import { toUserInfo, toRoleInfo } from '../../electron/mongo/UserService';

describe('toUserInfo', () => {
  it('maps a SCRAM-only user with roles', () => {
    const info = toUserInfo({
      _id: 'myapp.alice',
      user: 'alice',
      db: 'myapp',
      mechanisms: ['SCRAM-SHA-256'],
      roles: [
        { role: 'readWrite', db: 'myapp' },
        { role: 'read', db: 'logs' },
      ],
    });
    expect(info.username).toBe('alice');
    expect(info.db).toBe('myapp');
    expect(info.mechanisms).toEqual(['SCRAM-SHA-256']);
    expect(info.roles).toEqual([
      { role: 'readWrite', db: 'myapp' },
      { role: 'read', db: 'logs' },
    ]);
    expect(info.external).toBe(false);
    expect(info.customData).toBeUndefined();
  });

  it('marks external when only non-password mechanisms are configured', () => {
    const info = toUserInfo({
      user: 'CN=client,OU=app',
      db: '$external',
      mechanisms: ['MONGODB-X509'],
      roles: [{ role: 'readAnyDatabase', db: 'admin' }],
    });
    expect(info.external).toBe(true);
  });

  it('treats a user with at least one SCRAM mech as not external', () => {
    const info = toUserInfo({
      user: 'mixed',
      db: 'myapp',
      mechanisms: ['SCRAM-SHA-256', 'MONGODB-X509'],
      roles: [],
    });
    expect(info.external).toBe(false);
  });

  it('drops unknown mechanism strings and treats no-mechs user as not external', () => {
    const info = toUserInfo({
      user: 'legacy',
      db: 'admin',
      mechanisms: ['UNKNOWN-MECH'],
      roles: [],
    });
    expect(info.mechanisms).toEqual([]);
    // No recognised mechs at all → can't claim external safely; default to false.
    expect(info.external).toBe(false);
  });

  it('serialises customData as canonical EJSON', () => {
    const info = toUserInfo({
      user: 'alice',
      db: 'myapp',
      mechanisms: ['SCRAM-SHA-256'],
      roles: [],
      customData: { team: 'platform', tier: 1 },
    });
    expect(info.customData).toBe('{"team":"platform","tier":{"$numberInt":"1"}}');
  });
});

describe('toRoleInfo', () => {
  it('maps a built-in role with no inheritance', () => {
    const info = toRoleInfo({
      role: 'readWrite',
      db: 'admin',
      isBuiltin: true,
    });
    expect(info).toEqual({
      role: 'readWrite',
      db: 'admin',
      isBuiltin: true,
      roles: [],
      inheritedRoles: [],
    });
  });

  it('keeps direct roles apart from the inherited closure and serializes privileges', () => {
    const info = toRoleInfo({
      role: 'app_admin',
      db: 'myapp',
      roles: [{ role: 'app_writer', db: 'myapp' }],
      inheritedRoles: [
        { role: 'app_writer', db: 'myapp' },
        { role: 'read', db: 'myapp' },
      ],
      privileges: [{ resource: { db: 'myapp', collection: 'c' }, actions: ['find'] }],
    });
    expect(info.roles).toEqual([{ role: 'app_writer', db: 'myapp' }]);
    expect(info.inheritedRoles).toHaveLength(2);
    expect(JSON.parse(info.privileges!)).toEqual([
      { resource: { db: 'myapp', collection: 'c' }, actions: ['find'] },
    ]);
  });

  it('maps a custom role with inherited roles', () => {
    const info = toRoleInfo({
      role: 'app_writer',
      db: 'myapp',
      isBuiltin: false,
      inheritedRoles: [
        { role: 'readWrite', db: 'myapp' },
        { role: 'read', db: 'logs' },
      ],
    });
    expect(info.isBuiltin).toBe(false);
    expect(info.inheritedRoles).toEqual([
      { role: 'readWrite', db: 'myapp' },
      { role: 'read', db: 'logs' },
    ]);
  });
});
