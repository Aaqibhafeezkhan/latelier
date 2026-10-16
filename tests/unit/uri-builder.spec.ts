import { describe, it, expect } from 'vitest';
import ConnectionString from 'mongodb-connection-string-url';
import type { Connection } from '@shared/types';
import { buildUri, buildOptions, redactUriUserInfo } from '../../electron/mongo/uri';

function mk(overrides: Partial<Connection> & Partial<Connection['advanced']> = {}): Connection {
  const base: Connection = {
    id: 'id',
    name: 'Test',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'localhost',
    port: 27017,
    defaultDb: undefined,
    authMech: 'none',
    authUsername: undefined,
    authDatabase: undefined,
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
      serverSelectionTimeoutMs: 30_000,
      readPreference: 'primary',
      maxPoolSize: 100,
      directConnection: false,
    },
    hasPasswordStored: false,
    hasSshPasswordStored: false,
    hasSshPassphraseStored: false,
    createdAt: '',
    updatedAt: '',
  };
  return { ...base, ...overrides, tls: { ...base.tls, ...(overrides.tls ?? {}) } };
}

describe('buildUri', () => {
  it('no-auth standard', () => {
    const uri = buildUri(mk());
    expect(uri).toMatch(/^mongodb:\/\/localhost:27017\//);
    expect(uri).toContain('readPreference=primary');
    expect(uri).toContain('tls=false');
  });

  it('SCRAM with password and default db', () => {
    const uri = buildUri(
      mk({
        authMech: 'scram256',
        authUsername: 'alice',
        authDatabase: 'admin',
        defaultDb: 'myapp',
      }),
      'hunter2',
    );
    expect(uri).toMatch(/^mongodb:\/\/alice:hunter2@localhost:27017\/myapp\?/);
    expect(uri).toContain('authSource=admin');
    expect(uri).toContain('authMechanism=SCRAM-SHA-256');
  });

  it('URL-encodes special characters in password and username', () => {
    const uri = buildUri(
      mk({ authMech: 'scram256', authUsername: 'us er', authDatabase: 'admin' }),
      'p@ss:word',
    );
    expect(uri).toContain('us%20er:p%40ss%3Aword@');
  });

  it('SRV omits port and uses mongodb+srv scheme', () => {
    const uri = buildUri(mk({ connectionType: 'srv', host: 'cluster.mongodb.net' }));
    expect(uri).toMatch(/^mongodb\+srv:\/\/cluster\.mongodb\.net\//);
    expect(uri).not.toMatch(/:27017/);
  });

  it('SRV strips residual :port suffix from host defensively', () => {
    const uri = buildUri(
      mk({ connectionType: 'srv', host: 'cluster.mongodb.net:27017', port: 27017 }),
    );
    expect(uri).toMatch(/^mongodb\+srv:\/\/cluster\.mongodb\.net\//);
    expect(uri).not.toMatch(/:27017/);
  });

  it('strips scheme prefix if user pasted full URI into Host', () => {
    const uri = buildUri(
      mk({ connectionType: 'srv', host: 'mongodb+srv://cluster.mongodb.net/' }),
    );
    expect(uri).toMatch(/^mongodb\+srv:\/\/cluster\.mongodb\.net\//);
    expect(uri).not.toMatch(/@mongodb\+srv:/);
    expect(uri).not.toMatch(/\/\/admin|\/\/\?/);
  });

  it('strips trailing slash from Host', () => {
    const uri = buildUri(
      mk({ connectionType: 'srv', host: 'cluster.mongodb.net/', defaultDb: 'admin' }),
    );
    expect(uri).toMatch(/cluster\.mongodb\.net\/admin\?/);
    expect(uri).not.toMatch(/\/\/admin/);
  });

  it('strips leading slash from defaultDb', () => {
    const uri = buildUri(
      mk({ connectionType: 'srv', host: 'cluster.mongodb.net', defaultDb: '/admin' }),
    );
    expect(uri).toMatch(/cluster\.mongodb\.net\/admin\?/);
    expect(uri).not.toMatch(/\/\/admin/);
  });

  it('strips userinfo baked into Host', () => {
    const uri = buildUri(
      mk({
        connectionType: 'srv',
        host: 'user:pw@cluster.mongodb.net',
        authMech: 'scram256',
        authUsername: 'alice',
      }),
      'secret',
    );
    // Userinfo from Host stripped; the real userinfo built from authUsername+password kept.
    expect(uri).toMatch(/^mongodb\+srv:\/\/alice:secret@cluster\.mongodb\.net\//);
  });

  it('strips path and query from Host', () => {
    const uri = buildUri(
      mk({ connectionType: 'srv', host: 'cluster.mongodb.net/db?x=1' }),
    );
    expect(uri).toMatch(/^mongodb\+srv:\/\/cluster\.mongodb\.net\//);
    expect(uri).not.toMatch(/x=1&/);
  });

  it('default authMech omits authMechanism param but keeps userinfo', () => {
    const uri = buildUri(
      mk({ authMech: 'default', authUsername: 'alice', authDatabase: 'admin' }),
      'hunter2',
    );
    expect(uri).toContain('alice:hunter2@');
    expect(uri).not.toContain('authMechanism=');
    expect(uri).toContain('authSource=admin');
  });

  it('X.509 authMech', () => {
    const uri = buildUri(mk({ authMech: 'x509', authUsername: 'CN=client' }));
    expect(uri).toContain('authMechanism=MONGODB-X509');
    expect(uri).toContain('CN%3Dclient');
  });

  it('AWS IAM authMech', () => {
    const uri = buildUri(mk({ authMech: 'awsiam', authUsername: 'AKIA123' }), 'secret');
    expect(uri).toContain('authMechanism=MONGODB-AWS');
    expect(uri).toContain('AKIA123:secret@');
  });

  it('appName and directConnection options', () => {
    const uri = buildUri(
      mk({ advanced: { ...mk().advanced, appName: 'mongolab', directConnection: true } }),
    );
    expect(uri).toContain('appName=mongolab');
    expect(uri).toContain('directConnection=true');
  });

  it('TLS allowInvalidCertificates when verify is false', () => {
    const uri = buildUri(mk({ tls: { enabled: true, verify: false } }));
    expect(uri).toContain('tls=true');
    expect(uri).toContain('tlsAllowInvalidCertificates=true');
  });

  it('no default db → trailing slash only', () => {
    const uri = buildUri(mk());
    expect(uri).toMatch(/localhost:27017\/\?/);
  });

  describe('userinfo gating (authMech / authUsername must both hold)', () => {
    it('authMech !== none but no authUsername → no userinfo', () => {
      const uri = buildUri(mk({ authMech: 'scram256', authUsername: undefined }), 'hunter2');
      expect(uri).not.toContain('@');
    });

    it('authMech === none with authUsername set → no userinfo (auth mech gate wins)', () => {
      const uri = buildUri(mk({ authMech: 'none', authUsername: 'alice' }), 'hunter2');
      expect(uri).not.toContain('@');
    });

    it('authUsername with no password → userinfo has no trailing colon segment', () => {
      const uri = buildUri(mk({ authMech: 'scram256', authUsername: 'alice' }));
      expect(uri).toMatch(/^mongodb:\/\/alice@localhost:27017\//);
    });
  });

  describe('defaultDb slash/whitespace stripping', () => {
    it('strips multiple leading slashes, not just one', () => {
      const uri = buildUri(mk({ defaultDb: '///admin' }));
      expect(uri).toMatch(/localhost:27017\/admin\?/);
    });

    it('strips multiple trailing slashes, not just one', () => {
      const uri = buildUri(mk({ defaultDb: 'admin///' }));
      expect(uri).toMatch(/localhost:27017\/admin\?/);
    });

    it('an internal slash (not leading/trailing) is preserved, not stripped by an unanchored regex', () => {
      const uri = buildUri(mk({ defaultDb: 'my/db//' }));
      // Anchored: leading-replace is a no-op (no leading slash), trailing-replace
      // strips only the two REAL trailing slashes, leaving the internal one.
      expect(uri).toContain(`/${encodeURIComponent('my/db')}?`);
    });

    it('trims surrounding whitespace even with no slashes present', () => {
      const uri = buildUri(mk({ defaultDb: '  admin  ' }));
      expect(uri).toMatch(/localhost:27017\/admin\?/);
    });
  });

  it('omits authSource when authDatabase is not set', () => {
    const uri = buildUri(mk({ authDatabase: undefined }));
    expect(uri).not.toContain('authSource=');
  });

  it('SCRAM-SHA-1 authMech', () => {
    const uri = buildUri(mk({ authMech: 'scram1', authUsername: 'alice' }), 'hunter2');
    expect(uri).toContain('authMechanism=SCRAM-SHA-1');
  });

  describe('advanced options are omitted, not defaulted, when unset', () => {
    it('no readPreference set → param absent', () => {
      // ReadPref is a required field at the type level, but the guard exists
      // for real-world rows that predate it or lost it at rest — simulate
      // that with a cast rather than a value the type system would allow.
      const uri = buildUri(
        mk({
          advanced: { ...mk().advanced, readPreference: undefined as unknown as Connection['advanced']['readPreference'] },
        }),
      );
      expect(uri).not.toContain('readPreference=');
    });

    it('no appName set → param absent', () => {
      const uri = buildUri(mk());
      expect(uri).not.toContain('appName=');
    });

    it('directConnection false → param absent', () => {
      const uri = buildUri(mk({ advanced: { ...mk().advanced, directConnection: false } }));
      expect(uri).not.toContain('directConnection=');
    });
  });

  describe('tlsAllowInvalidCertificates gating requires BOTH tls.enabled and !tls.verify', () => {
    it('enabled + verify → not set', () => {
      const uri = buildUri(mk({ tls: { enabled: true, verify: true } }));
      expect(uri).not.toContain('tlsAllowInvalidCertificates');
    });

    it('disabled + !verify → not set (proves it is && not ||)', () => {
      const uri = buildUri(mk({ tls: { enabled: false, verify: false } }));
      expect(uri).toContain('tls=false');
      expect(uri).not.toContain('tlsAllowInvalidCertificates');
    });
  });

  describe('host sanitization edge cases', () => {
    it('trims surrounding whitespace from Host', () => {
      const uri = buildUri(mk({ host: ' localhost ' }));
      expect(uri).toMatch(/^mongodb:\/\/localhost:27017\//);
    });

    it('scheme-prefix check is anchored: a scheme substring NOT at the start is not treated as a full URI', () => {
      // 'xmongodb://good.com' does not START with mongodb://, so it must be
      // wrapped and parsed as a plain host — an unanchored check would instead
      // treat it as already-schemed and parse it directly, yielding a
      // different (attacker-relevant) hostname.
      const uri = buildUri(mk({ host: 'xmongodb://good.com' }));
      expect(uri).toMatch(/^mongodb:\/\/xmongodb:27017\//);
    });

    it('hands the driver a non-ASCII host as punycode, for standard and SRV alike', () => {
      expect(buildUri(mk({ host: 'CAFÉ.com' }))).toContain('//xn--caf-dma.com:27017/');
      expect(buildUri(mk({ host: 'münchen.example' }))).toContain('xn--mnchen-3ya.example:27017/');
      const srv = buildUri(mk({ host: 'münchen.example', connectionType: 'srv' }));
      expect(srv).toContain('xn--mnchen-3ya.example/');
      expect(srv).not.toContain('%');
    });

    it.each([
      ['an encoded slash', 'm%C3%BCnchen%2Fevil'],
      ['an encoded query', 'm%C3%BCnchen%3F%3DauthSource'],
      ['an encoded fragment', 'm%C3%BCnchen%23x'],
      ['an ideographic full stop', 'm%C3%BCnchen%E3%80%82evil.com'],
    ])('never shortens or rewrites a non-ASCII host with %s into a different punycode name', (_, host) => {
      const uri = buildUri(mk({ host }));
      expect(uri).not.toContain('xn--');
      expect(uri).toContain(`//${host}:27017/`);
    });

    it('hands an ASCII host to the driver exactly as typed, case included', () => {
      expect(buildUri(mk({ host: 'Mongo.Example.com' }))).toContain('//Mongo.Example.com:27017/');
    });

    it('leaves a percent-encoded Unix-socket host as it is', () => {
      expect(buildUri(mk({ host: '%2Ftmp%2Fmongodb-27017.sock' }))).toContain('%2Ftmp%2Fmongodb-27017.sock:27017/');
    });

    it('keeps a host with a malformed escape as written instead of throwing', () => {
      expect(() => buildUri(mk({ host: '%E0%A4%A.sock' }))).not.toThrow();
    });

    describe('malformed-host fallback path (URL constructor throws)', () => {
      it('scheme-prefixed but unparseable host still strips the scheme in the fallback', () => {
        const uri = buildUri(mk({ host: 'mongodb://[::1' }));
        expect(uri).toMatch(/^mongodb:\/\/\[::27017\//);
      });

      it('unparseable host with userinfo and multiple colon-digit groups strips only the trailing one', () => {
        const uri = buildUri(mk({ host: 'x@a:1b:22[::12' }));
        expect(uri).toMatch(/^mongodb:\/\/a:1b:22\[::27017\//);
      });

      it('an embedded scheme literal that is not at the start of a malformed host is not stripped from the middle', () => {
        // The scheme-strip regex here is anchored with `^`, so it only
        // strips a scheme prefix that is actually at position 0. Without
        // the anchor, the literal 'mongodb://' embedded later in the
        // string would also be stripped, silently rewriting the host.
        const uri = buildUri(mk({ host: '[mongodb://x' }));
        expect(uri).toMatch(/^mongodb:\/\/\[mongodb::27017\//);
      });
    });
  });

  describe('host-hijack security (fuzz-found)', () => {
    // These assert against the REAL driver-side parser, not just the output
    // string shape — a fix that merely looks different but still confuses
    // mongodb-connection-string-url downstream is not a fix.

    it('a `#` fragment glued onto the host does not hijack the real host', () => {
      // Exploit: host field = 'good.com#@evil.com'. Naive `indexOf('@')`
      // stripping doesn't know '#' starts a fragment, so it slices off
      // 'good.com#' and returns 'evil.com'.
      const uri = buildUri(mk({ host: 'good.com#@evil.com' }));
      const cs = new ConnectionString(uri);
      expect(cs.hosts).toEqual(['good.com:27017']);
      expect(cs.username).toBe('');
      expect(cs.password).toBe('');
    });

    it('a literal backslash-decorated host does not leak auth even when the resulting host is ambiguous', () => {
      // Exploit variant: host field contains a literal `\@`. Whichever side
      // of the `@` wins as "the host" is inherently ambiguous for a bare
      // (non-URI) host string — but the fix must guarantee the winning host
      // token is clean: no embedded `@`/`\` that a downstream parser could
      // reinterpret as a userinfo delimiter.
      const uri = buildUri(mk({ host: 'good.com\\@evil.com' }));
      const cs = new ConnectionString(uri);
      expect(cs.hosts).toHaveLength(1);
      expect(cs.hosts[0]).not.toMatch(/[@\\]/);
      expect(cs.username).toBe('');
      expect(cs.password).toBe('');
    });

    it('a pasted URI with a double-embedded @ does not smuggle a username onto the wire', () => {
      // Exploit: host field = 'mongodb://user@evil.com@good.com/'. The old
      // code only stripped the FIRST '@', leaving 'evil.com@good.com'
      // embedded raw in the built URI. Re-parsed downstream, that embedded
      // '@' gets reinterpreted as a real userinfo delimiter — smuggling
      // username 'evil.com' onto the wire even though authMech is 'none'
      // and no username was configured.
      const uri = buildUri(
        mk({ host: 'mongodb://user@evil.com@good.com/', authMech: 'none', authUsername: undefined }),
      );
      const cs = new ConnectionString(uri);
      expect(cs.hosts).toEqual(['good.com:27017']);
      expect(cs.username).toBe('');
      expect(cs.password).toBe('');
    });

    it('adjacent case: a normal host with no @ is untouched', () => {
      const uri = buildUri(mk({ host: 'good.com' }));
      const cs = new ConnectionString(uri);
      expect(cs.hosts).toEqual(['good.com:27017']);
    });

    it('adjacent case: a legitimately pasted full URI with real userinfo still extracts cleanly', () => {
      const uri = buildUri(
        mk({ connectionType: 'srv', host: 'mongodb+srv://user:pw@cluster.mongodb.net/db' }),
      );
      const cs = new ConnectionString(uri);
      expect(cs.hosts).toEqual(['cluster.mongodb.net']);
      // The stray userinfo baked into the pasted Host text is discarded —
      // real auth always comes from authUsername/password, never from Host.
      expect(cs.username).toBe('');
      expect(cs.password).toBe('');
    });
  });
});

describe('buildOptions', () => {
  it('propagates timeouts and maxPoolSize', () => {
    const opts = buildOptions(
      mk({
        advanced: {
          ...mk().advanced,
          connectTimeoutMs: 7_500,
          socketTimeoutMs: 25_000,
          serverSelectionTimeoutMs: 15_000,
          maxPoolSize: 42,
        },
      }),
    );
    expect(opts.connectTimeoutMS).toBe(7_500);
    expect(opts.socketTimeoutMS).toBe(25_000);
    expect(opts.serverSelectionTimeoutMS).toBe(15_000);
    expect(opts.maxPoolSize).toBe(42);
  });

  it('attaches TLS paths when provided', () => {
    const opts = buildOptions(
      mk({
        tls: {
          enabled: true,
          verify: true,
          caPath: '/etc/ssl/ca.pem',
          clientCertPath: '/etc/ssl/client.pem',
        },
      }),
    );
    expect(opts.tls).toBe(true);
    expect(opts.tlsCAFile).toBe('/etc/ssl/ca.pem');
    expect(opts.tlsCertificateKeyFile).toBe('/etc/ssl/client.pem');
  });

  it('sets tls=false when disabled', () => {
    const opts = buildOptions(mk());
    expect(opts.tls).toBe(false);
  });

  it('sets tlsAllowInvalidCertificates when verify is false', () => {
    const opts = buildOptions(mk({ tls: { enabled: true, verify: false } }));
    expect(opts.tlsAllowInvalidCertificates).toBe(true);
  });

  it('does not set tlsAllowInvalidCertificates when verify is true', () => {
    const opts = buildOptions(mk({ tls: { enabled: true, verify: true } }));
    expect(opts.tlsAllowInvalidCertificates).toBeUndefined();
  });

  it('does not set tlsCAFile when caPath is not provided', () => {
    const opts = buildOptions(mk({ tls: { enabled: true, verify: true } }));
    // `in` rather than toBeUndefined(): the guard being forced to `if (true)`
    // would still assign `opts.tlsCAFile = undefined`, which reads back as
    // undefined too — only an own-property check tells them apart.
    expect('tlsCAFile' in opts).toBe(false);
  });

  it('does not set tlsCertificateKeyFile when clientCertPath is not provided', () => {
    const opts = buildOptions(mk({ tls: { enabled: true, verify: true } }));
    expect('tlsCertificateKeyFile' in opts).toBe(false);
  });
});

describe('redactUriUserInfo', () => {
  it('replaces a multi-character userinfo segment with a fixed placeholder', () => {
    const redacted = redactUriUserInfo('mongodb://alice:hunter2@localhost:27017/db?tls=true');
    expect(redacted).toBe('mongodb://<redacted>@localhost:27017/db?tls=true');
  });

  it('leaves a URI with no userinfo unchanged', () => {
    const uri = 'mongodb://localhost:27017/db?tls=true';
    expect(redactUriUserInfo(uri)).toBe(uri);
  });
});
