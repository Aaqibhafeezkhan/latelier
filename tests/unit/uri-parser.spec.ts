import { describe, it, expect } from 'vitest';
import { parseConnectionUri, parseHostPort } from '../../electron/mongo/uri-parse';
import { ValidationError } from '../../electron/errors';

describe('parseConnectionUri', () => {
  it('parses a basic SCRAM standard URI', () => {
    const { input, warnings } = parseConnectionUri(
      'mongodb://alice:hunter2@db.example.com:27017/myapp?authSource=admin&authMechanism=SCRAM-SHA-256',
    );
    expect(input.connectionType).toBe('standard');
    expect(input.host).toBe('db.example.com');
    expect(input.port).toBe(27017);
    expect(input.defaultDb).toBe('myapp');
    expect(input.authMech).toBe('scram256');
    expect(input.authUsername).toBe('alice');
    expect(input.password).toBe('hunter2');
    expect(input.authDatabase).toBe('admin');
    expect(warnings).toEqual([]);
  });

  it('parses SRV and omits port', () => {
    const { input } = parseConnectionUri(
      'mongodb+srv://u:p@cluster.mongodb.net/mydb?authSource=admin',
    );
    expect(input.connectionType).toBe('srv');
    expect(input.host).toBe('cluster.mongodb.net');
    expect(input.defaultDb).toBe('mydb');
    // SRV implies TLS by default
    expect(input.tls?.enabled).toBe(true);
  });

  it('decodes URL-encoded password and username', () => {
    const { input } = parseConnectionUri(
      'mongodb://us%20er:p%40ss%3Aword@localhost:27017/',
    );
    expect(input.authUsername).toBe('us er');
    expect(input.password).toBe('p@ss:word');
  });

  it('defaults authMech to "default" (driver-negotiated) when creds are present and no mechanism is specified', () => {
    const { input } = parseConnectionUri('mongodb://alice:pw@localhost/');
    expect(input.authMech).toBe('default');
  });

  it('defaults authMech to none when no creds are present', () => {
    const { input } = parseConnectionUri('mongodb://localhost/');
    expect(input.authMech).toBe('none');
  });

  it('captures tls=false explicitly', () => {
    const { input } = parseConnectionUri('mongodb://localhost/?tls=false');
    expect(input.tls?.enabled).toBe(false);
  });

  it('maps tlsAllowInvalidCertificates to verify=false', () => {
    const { input } = parseConnectionUri(
      'mongodb://localhost/?tls=true&tlsAllowInvalidCertificates=true',
    );
    expect(input.tls).toEqual({ enabled: true, verify: false });
  });

  it('captures readPreference', () => {
    const { input } = parseConnectionUri(
      'mongodb://localhost/?readPreference=secondaryPreferred',
    );
    expect(input.advanced?.readPreference).toBe('secondaryPreferred');
  });

  it('captures directConnection', () => {
    const { input } = parseConnectionUri(
      'mongodb://localhost/?directConnection=true',
    );
    expect(input.advanced?.directConnection).toBe(true);
  });

  it('captures timeouts and maxPoolSize', () => {
    const { input } = parseConnectionUri(
      'mongodb://localhost/?connectTimeoutMS=5000&socketTimeoutMS=15000&serverSelectionTimeoutMS=7500&maxPoolSize=25',
    );
    expect(input.advanced?.connectTimeoutMs).toBe(5000);
    expect(input.advanced?.socketTimeoutMs).toBe(15000);
    expect(input.advanced?.serverSelectionTimeoutMs).toBe(7500);
    expect(input.advanced?.maxPoolSize).toBe(25);
  });

  it('maps every supported authMechanism', () => {
    const cases: Array<[string, string]> = [
      ['SCRAM-SHA-256', 'scram256'],
      ['SCRAM-SHA-1', 'scram1'],
      ['MONGODB-X509', 'x509'],
      ['MONGODB-AWS', 'awsiam'],
    ];
    for (const [param, expected] of cases) {
      const { input } = parseConnectionUri(
        `mongodb://user:pw@localhost/?authMechanism=${param}`,
      );
      expect(input.authMech).toBe(expected);
    }
  });

  it('rejects unsupported authMechanism', () => {
    expect(() =>
      parseConnectionUri('mongodb://user:pw@localhost/?authMechanism=PLAIN'),
    ).toThrow(ValidationError);
  });

  it('warns when the host list has multiple entries', () => {
    const { input, warnings } = parseConnectionUri(
      'mongodb://a.example.com:27017,b.example.com:27018/?replicaSet=rs0',
    );
    expect(input.host).toBe('a.example.com');
    expect(input.port).toBe(27017);
    expect(warnings.find((w) => w.code === 'MULTI_HOST_TRUNCATED')?.detail).toBe(
      "Only the first host was captured (a.example.com:27017). Replica-set host lists aren't modeled in iteration 1.",
    );
  });

  it('warns on dropped options', () => {
    const { warnings } = parseConnectionUri(
      'mongodb://localhost/?retryWrites=true&w=majority',
    );
    const dropped = warnings.filter((w) => w.code === 'OPTION_DROPPED').map((w) => w.detail);
    expect(dropped).toContain('retrywrites');
    expect(dropped).toContain('w');
  });

  it.each(['tlsInsecure', 'tlsAllowInvalidHostnames'])(
    '%s is reported as dropped and leaves verification on',
    (key) => {
      const { input, warnings } = parseConnectionUri(`mongodb://db.example.com/?tls=true&${key}=true`);
      expect(warnings).toContainEqual({ code: 'OPTION_DROPPED', detail: key.toLowerCase() });
      expect(input.tls?.verify).toBe(true);
      expect(warnings.some((w) => w.code === 'TLS_VERIFY_DISABLED')).toBe(false);
    },
  );

  it.each([
    'mongodb://db.example.com/?tls=true&tlsAllowInvalidCertificates=true',
    'mongodb://db.example.com/?ssl=true&tlsAllowInvalidCertificates=true',
    'mongodb+srv://cluster.example.com/?tlsAllowInvalidCertificates=true',
  ])('tlsAllowInvalidCertificates=true warns that verification is off: %s', (uri) => {
    const { input, warnings } = parseConnectionUri(uri);
    expect(input.tls?.verify).toBe(false);
    const w = warnings.filter((x) => x.code === 'TLS_VERIFY_DISABLED');
    expect(w).toHaveLength(1);
    expect(w[0]?.detail).toMatch(/verification is turned off/i);
  });

  it.each(['false', 'nope'])('tlsAllowInvalidCertificates=%s adds no TLS warning', (v) => {
    const { input, warnings } = parseConnectionUri(
      `mongodb://db.example.com/?tls=true&tlsAllowInvalidCertificates=${v}`,
    );
    expect(input.tls?.verify).toBe(true);
    expect(warnings.some((w) => w.code === 'TLS_VERIFY_DISABLED')).toBe(false);
  });

  it('rejects missing scheme', () => {
    expect(() => parseConnectionUri('localhost:27017')).toThrow(ValidationError);
  });

  it('rejects empty URI, naming the reason', () => {
    expect(() => parseConnectionUri('')).toThrow('URI is empty');
    expect(() => parseConnectionUri('   ')).toThrow('URI is empty');
  });

  it('rejects unparseable URI with a fixed sentence, never the library message', () => {
    expect(() => parseConnectionUri('mongodb://')).toThrow(/^This isn't a valid connection string\.$/);
  });

  it('never quotes the userinfo when it cannot parse the string', () => {
    for (const uri of [
      'mongodb+srv://alice:2024/hunter2@cluster.example.net',
      'mongodb://alice:2024/hunter2@h',
      'mongodb://alice/hunter2:x@h',
    ]) {
      expect(() => parseConnectionUri(uri)).toThrow("This isn't a valid connection string.");
    }
  });

  it('strips the port from an SRV host with nothing after it', () => {
    const { input, warnings } = parseConnectionUri('mongodb+srv://u:p@c.example.net:27017');
    expect(input.host).toBe('c.example.net');
    expect(warnings.find((w) => w.code === 'OPTION_DROPPED')?.detail).toBe(
      'SRV URIs cannot include a port; stripped: c.example.net:27017',
    );
  });

  it.each([
    ['db.example.com:27018', { host: 'db.example.com', port: 27018 }],
    ['[::1]:27019', { host: '[::1]', port: 27019 }],
    ['[::1]', { host: '[::1]' }],
    ['[::1]x', { problem: "The host has characters a host name can't contain." }],
    ['a[1.2]', { problem: "The host has characters a host name can't contain." }],
    ['[1.2]a', { problem: "The host has characters a host name can't contain." }],
    ['m\u00fcnchen.example:27018', { host: 'm\u00fcnchen.example', port: 27018 }],
    ['a b', { problem: "The host has characters a host name can't contain." }],
    ['a/b', { problem: "The host has characters a host name can't contain." }],
    ['a?b', { problem: "The host has characters a host name can't contain." }],
    ['a#b', { problem: "The host has characters a host name can't contain." }],
    ['a@b', { problem: "The host has characters a host name can't contain." }],
    ['h:0', { problem: 'Port must be a number from 1 to 65535.' }],
    ['h:', { problem: 'Port must be a number from 1 to 65535.' }],
  ])('parseHostPort(%j) follows the host rules', (authority, expected) => {
    expect(parseHostPort(authority, true)).toEqual(expected);
  });

  it('parseHostPort keeps a colon in the host when no port is allowed', () => {
    expect(parseHostPort('h:1', false)).toEqual({ problem: "The host has characters a host name can't contain." });
    expect(parseHostPort('h', false)).toEqual({ host: 'h' });
  });

  it('does not read an SRV userinfo holding "/" and ":digits" as the host', () => {
    // An escaped password with '/' must reach the host list intact.
    const { input, warnings } = parseConnectionUri('mongodb+srv://alice:2024%2Fhunter2@cluster.example.net:27017/db?tls=true');
    expect(input).toMatchObject({ host: 'cluster.example.net', password: '2024/hunter2', defaultDb: 'db' });
    expect(warnings.find((w) => w.code === 'OPTION_DROPPED')?.detail).toBe(
      'SRV URIs cannot include a port; stripped: cluster.example.net:27017',
    );
    // An '@' in the query is not the end of the userinfo.
    expect(parseConnectionUri('mongodb+srv://u:p@c.example.net:1/?appName=a@b').input).toMatchObject({
      host: 'c.example.net', authUsername: 'u', advanced: { appName: 'a@b' },
    });
  });

  it('the scheme check is anchored to the start, not found anywhere in the string', () => {
    // Without the `^` anchor, a URI with "mongodb://" appearing later in the
    // string (not as the actual scheme) would slip past this check and fail
    // with a different, less specific error from ConnectionString instead.
    expect(() => parseConnectionUri('xmongodb://localhost')).toThrow(
      'URI must start with mongodb:// or mongodb+srv://',
    );
  });

  it('returns no defaultDb when the path is empty or "/"', () => {
    const { input } = parseConnectionUri('mongodb://localhost/');
    expect(input.defaultDb).toBeUndefined();
  });

  it('captures appName', () => {
    const { input } = parseConnectionUri(
      'mongodb://localhost/?appName=my-app',
    );
    expect(input.advanced?.appName).toBe('my-app');
  });

  it('throws ValidationError (not a raw URIError) on malformed percent-encoding in the db path', () => {
    // Regression for a fuzz-found bug: the decodeURIComponent(...) call on
    // the path segment sat outside the try/catch wrapping ConnectionString
    // construction, so a malformed %-escape threw an uncaught URIError that
    // the IPC router mapped to code: 'INTERNAL' instead of 'VALIDATION'.
    expect(() => parseConnectionUri('mongodb://host/db%zzname')).toThrow(ValidationError);
  });

  it('strips ports from SRV URIs instead of failing', () => {
    const { input, warnings } = parseConnectionUri(
      'mongodb+srv://user:p@cluster.mongodb.net:27017/mydb',
    );
    expect(input.connectionType).toBe('srv');
    expect(input.host).toBe('cluster.mongodb.net');
    expect(input.defaultDb).toBe('mydb');
    expect(warnings.some((w) => w.detail?.includes('SRV URIs cannot include a port'))).toBe(true);
    expect(warnings.find((w) => w.code === 'OPTION_DROPPED')?.detail).toBe(
      'SRV URIs cannot include a port; stripped: cluster.mongodb.net:27017',
    );
  });

  it('trims surrounding whitespace before parsing', () => {
    const { input } = parseConnectionUri('  mongodb://localhost:27017/  \n');
    expect(input.host).toBe('localhost');
  });

  it('rejects a URI with no scheme prefix at all, naming the requirement', () => {
    expect(() => parseConnectionUri('notaurl')).toThrow(
      'URI must start with mongodb:// or mongodb+srv://',
    );
  });

  it('a plain mongodb:// URI (no +srv) is not treated as SRV, even with multiple hosts', () => {
    const { input } = parseConnectionUri('mongodb://a.example.com:27017,b.example.com:27018/');
    expect(input.connectionType).toBe('standard');
    expect(input.port).toBe(27017);
  });

  it('strips a port from an SRV host with no userinfo (no user:pass@)', () => {
    // The port-strip regex's userinfo group is optional (`(?:[^@/]*@)?`) —
    // without the `?`, this URI (no credentials) wouldn't match at all, the
    // port would survive into the normalized URI, and ConnectionString
    // itself rejects a port on an SRV host.
    const { input, warnings } = parseConnectionUri('mongodb+srv://cluster.mongodb.net:27017/mydb');
    expect(input.host).toBe('cluster.mongodb.net');
    expect(warnings.find((w) => w.code === 'OPTION_DROPPED')?.detail).toContain('cluster.mongodb.net:27017');
  });

  it('an SRV host with no colon is left untouched (no stray strip)', () => {
    const { input, warnings } = parseConnectionUri('mongodb+srv://cluster.mongodb.net/mydb');
    expect(input.host).toBe('cluster.mongodb.net');
    expect(warnings.find((w) => w.code === 'OPTION_DROPPED')).toBeUndefined();
  });

  it('a host with no port keeps the 27017 default', () => {
    const { input } = parseConnectionUri('mongodb://localhost/');
    expect(input.host).toBe('localhost');
    expect(input.port).toBe(27017);
  });

  it('rejects malformed database path with a message naming it as such', () => {
    expect(() => parseConnectionUri('mongodb://host/db%zzname')).toThrow(
      /malformed database path/,
    );
  });

  it('rejects unsupported authMechanism, naming the value in the message', () => {
    expect(() => parseConnectionUri('mongodb://user:pw@localhost/?authMechanism=PLAIN')).toThrow(
      'unsupported authMechanism: PLAIN',
    );
  });

  it('ssl=true is accepted as an alias for tls=true', () => {
    const { input } = parseConnectionUri('mongodb://localhost/?ssl=true');
    expect(input.tls?.enabled).toBe(true);
  });

  it('tlsAllowInvalidCertificates absent defaults verify to true', () => {
    const { input } = parseConnectionUri('mongodb://localhost/?tls=true');
    expect(input.tls?.verify).toBe(true);
  });

  it('directConnection defaults to false when absent', () => {
    const { input } = parseConnectionUri('mongodb://localhost/');
    expect(input.advanced?.directConnection).toBe(false);
  });

  it('readPreference falls back to primary when absent or unrecognized', () => {
    expect(parseConnectionUri('mongodb://localhost/').input.advanced?.readPreference).toBe('primary');
    expect(
      parseConnectionUri('mongodb://localhost/?readPreference=bogus').input.advanced?.readPreference,
    ).toBe('primary');
  });

  it('every READ_PREFS value round-trips unchanged', () => {
    for (const rp of ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest']) {
      const { input } = parseConnectionUri(`mongodb://localhost/?readPreference=${rp}`);
      expect(input.advanced?.readPreference).toBe(rp);
    }
  });

  it('every DROPPED_OPTIONS key is reported, not just retrywrites/w', () => {
    const { warnings } = parseConnectionUri(
      'mongodb://localhost/?wtimeoutMS=1000&journal=true&replicaSet=rs0&loadBalanced=true&readConcernLevel=majority',
    );
    const dropped = warnings.filter((w) => w.code === 'OPTION_DROPPED').map((w) => w.detail);
    expect(dropped).toEqual(
      expect.arrayContaining(['wtimeoutms', 'journal', 'replicaset', 'loadbalanced', 'readconcernlevel']),
    );
  });

  it('parseIntParam: missing param uses the fallback', () => {
    const { input } = parseConnectionUri('mongodb://localhost/');
    expect(input.advanced?.connectTimeoutMs).toBe(10_000);
    expect(input.advanced?.socketTimeoutMs).toBe(30_000);
    expect(input.advanced?.serverSelectionTimeoutMs).toBe(30_000);
    expect(input.advanced?.maxPoolSize).toBe(100);
  });

  it('parseIntParam: a non-numeric value falls back rather than becoming NaN', () => {
    const { input } = parseConnectionUri('mongodb://localhost/?maxPoolSize=notanumber');
    expect(input.advanced?.maxPoolSize).toBe(100);
  });

  it('parseIntParam: a negative value falls back rather than being kept', () => {
    const { input } = parseConnectionUri('mongodb://localhost/?maxPoolSize=-5');
    expect(input.advanced?.maxPoolSize).toBe(100);
  });

  it('parseIntParam: an empty-string value falls back rather than parsing as 0', () => {
    // Number('') is 0, not NaN — the `!raw` guard is what catches this, not
    // Number.isFinite.
    const { input } = parseConnectionUri('mongodb://localhost/?maxPoolSize=');
    expect(input.advanced?.maxPoolSize).toBe(100);
  });

  it('parseIntParam: zero is a valid value, not treated as falsy/missing', () => {
    const { input } = parseConnectionUri('mongodb://localhost/?maxPoolSize=0');
    expect(input.advanced?.maxPoolSize).toBe(0);
  });

  it('parseIntParam: a fractional value is rounded', () => {
    const { input } = parseConnectionUri('mongodb://localhost/?maxPoolSize=25.6');
    expect(input.advanced?.maxPoolSize).toBe(26);
  });

  it('an SRV host with a non-numeric suffix after the colon is rejected, not silently truncated', () => {
    // The port-strip regex is anchored with `$` so it only matches a colon
    // followed by digits-to-end-of-string. Without that anchor, a host like
    // `cluster.mongodb.net:1234abc` would partially match `:1234` and the
    // `abc` suffix would be silently dropped, producing a valid-looking host
    // instead of surfacing the malformed input.
    expect(() =>
      parseConnectionUri('mongodb+srv://cluster.mongodb.net:1234abc/mydb'),
    ).toThrow(ValidationError);
  });

  it('rejects an SRV URI with multiple comma-separated hosts (the port-strip rejoins with a comma)', () => {
    // Each host segment has its port stripped independently, then rejoined
    // with `,` before being handed to ConnectionString. Rejoining with `''`
    // instead would silently glue two distinct hostnames into one
    // (`a.example.comb.example.com`), which ConnectionString happily accepts
    // as a single SRV host — hiding the fact that the user pasted a
    // multi-host list SRV doesn't support.
    expect(() =>
      parseConnectionUri(
        'mongodb+srv://a.example.com:27017,b.example.com:27018/mydb',
      ),
    ).toThrow("This isn't a valid connection string.");
  });

  it('a numeric-only host with no port is not misread as a bare port number', () => {
    // firstHost.lastIndexOf(':') is -1 here (no colon at all). If the port
    // split ran unconditionally, `firstHost.slice(idx + 1)` with idx === -1
    // would re-parse the whole host string as a port number and truncate the
    // last character off the host via `slice(0, idx)`.
    const { input } = parseConnectionUri('mongodb://12345/db');
    expect(input.host).toBe('12345');
    expect(input.port).toBe(27017);
  });
});

describe('parseConnectionUri: C14 import markers', () => {
  it('tlsCAFile and tlsCertificateKeyFile become re-pick markers, in any casing, and no path is kept', () => {
    for (const q of [
      'tlsCAFile=/etc/ca.pem&tlsCertificateKeyFile=/etc/client.pem',
      'TLSCAFILE=/etc/ca.pem&TlsCertificateKeyFile=/etc/client.pem',
    ]) {
      const { input, repick } = parseConnectionUri(`mongodb://h/?tls=true&${q}`);
      expect(repick).toEqual(['tlsCa', 'tlsClientCert']);
      expect(JSON.stringify(input)).not.toContain('/etc/');
      expect(input.tls).toEqual({ enabled: true, verify: true });
    }
  });

  it('marks only the file the string names', () => {
    expect(parseConnectionUri('mongodb://h/?tlsCAFile=/a.pem').repick).toEqual(['tlsCa']);
    expect(parseConnectionUri('mongodb://h/?tlsCertificateKeyFile=/a.pem').repick).toEqual(['tlsClientCert']);
    expect(parseConnectionUri('mongodb://h/').repick).toEqual([]);
  });

  it('ignores a file param with no value', () => {
    expect(parseConnectionUri('mongodb://h/?tlsCAFile=&tlsCertificateKeyFile=').repick).toEqual([]);
  });

  it('X.509 needs the client certificate re-picked once, even when the string names the file too', () => {
    expect(parseConnectionUri('mongodb://h/?authMechanism=MONGODB-X509&tls=true').repick).toEqual(['tlsClientCert']);
    expect(
      parseConnectionUri('mongodb://h/?authMechanism=MONGODB-X509&tlsCertificateKeyFile=/c.pem&tlsCAFile=/a.pem').repick,
    ).toEqual(['tlsCa', 'tlsClientCert']);
  });

  it('reports directConnectionExplicit for any value and casing, never for SRV or an absent param', () => {
    expect(parseConnectionUri('mongodb://h/?directConnection=true').directConnectionExplicit).toBe(true);
    expect(parseConnectionUri('mongodb://h/?DirectConnection=false').directConnectionExplicit).toBe(true);
    expect(parseConnectionUri('mongodb://h/?appName=x').directConnectionExplicit).toBe(false);
    expect(parseConnectionUri('mongodb+srv://c.example.net/?directConnection=true').directConnectionExplicit).toBe(false);
  });

  it('leaves input.advanced.directConnection as it was: false unless the string says true', () => {
    const adv = (u: string) => parseConnectionUri(u).input.advanced?.directConnection;
    expect(adv('mongodb://h/?directConnection=false')).toBe(false);
    expect(adv('mongodb://h/?directConnection=true')).toBe(true);
    expect(adv('mongodb://h/')).toBe(false);
  });

  it('refuses MONGODB-OIDC with its own message, in any casing, without echoing the string', () => {
    for (const mech of ['MONGODB-OIDC', 'mongodb-oidc']) {
      expect(() => parseConnectionUri(`mongodb://u:s3cret@h/?authMechanism=${mech}`)).toThrow(
        new ValidationError("OIDC sign-in isn't supported yet."),
      );
    }
  });

  it('warns once when the string carries proxy options, without any of their values', () => {
    const { warnings } = parseConnectionUri(
      'mongodb://h/?proxyHost=socks.corp&proxyPort=1080&proxyUsername=bob&PROXYPASSWORD=hunter2',
    );
    const proxy = warnings.filter((w) => w.code === 'PROXY_DROPPED');
    expect(proxy).toHaveLength(1);
    expect(proxy[0]!.detail).toMatch(/^Proxy options/);
    for (const v of ['socks.corp', '1080', 'bob', 'hunter2']) expect(JSON.stringify(warnings)).not.toContain(v);
  });

  it('warns for each single proxy param on its own, and not when there are none', () => {
    for (const p of ['proxyHost=h', 'proxyPort=1', 'proxyUsername=u', 'proxyPassword=p']) {
      const { warnings } = parseConnectionUri(`mongodb://h/?${p}`);
      expect(warnings.map((w) => w.code), p).toEqual(['PROXY_DROPPED']);
    }
    expect(parseConnectionUri('mongodb://h/?appName=x').warnings).toEqual([]);
  });
});

describe('parseConnectionUri: SRV port strip', () => {
  it('finds userinfo only inside the authority, so an @ in the path is not one', () => {
    const { input, warnings } = parseConnectionUri('mongodb+srv://u@good.example.net/db@x:1');
    expect(input.host).toBe('good.example.net');
    expect(input.defaultDb).toBe('db@x:1');
    expect(warnings.find((w) => w.code === 'OPTION_DROPPED')).toBeUndefined();
  });
});

describe('parseConnectionUri: host and port validation', () => {
  const PORT_MSG = 'Port must be a number from 1 to 65535.';
  const HOST_MSG = "The host has characters a host name can't contain.";

  it.each([
    ['mongodb://h:abc', PORT_MSG],
    ['mongodb://u:p@h:abc/db', PORT_MSG],
    ['mongodb://h:0', PORT_MSG],
    ['mongodb://h:65536', PORT_MSG],
    ['mongodb://h:1e3', PORT_MSG],
    ['mongodb://h:', PORT_MSG],
    ['mongodb://[::1]:abc', PORT_MSG],
    ['mongodb://h&tls=true', HOST_MSG],
    ['mongodb://h$x:27017', HOST_MSG],
    ['mongodb://a:b:27017', HOST_MSG],
    ['mongodb+srv://h&tls=true', HOST_MSG],
    ['mongodb://a b', HOST_MSG],
    ['mongodb://h[1]', HOST_MSG],
    ['mongodb://m\u00fcnchen\u00a0.example', HOST_MSG],
    ['mongodb://m\u00fcnchen\u3000.example', HOST_MSG],
    ['mongodb://m\u00fcnchen$.example', HOST_MSG],
    ['mongodb://good%2eexample', HOST_MSG],
    ['mongodb://good%40evil', HOST_MSG],
    ['mongodb://100%', HOST_MSG],
    ['mongodb://%2Ftmp%2Fsock.sock.evil', HOST_MSG],
  ])('refuses %s', (uri, message) => {
    expect(() => parseConnectionUri(uri)).toThrow(new ValidationError(message));
  });

  it.each([
    ['mongodb://localhost', 'localhost', 27017],
    ['mongodb://127.0.0.1:27017', '127.0.0.1', 27017],
    ['mongodb://[::1]:27018', '[::1]', 27018],
    ['mongodb://[::1]', '[::1]', 27017],
    ['mongodb://my_host-1.example.com:27017', 'my_host-1.example.com', 27017],
    ['mongodb://h:1', 'h', 1],
    ['mongodb://h:65535', 'h', 65535],
    ['mongodb://m\u00fcnchen.example', 'm\u00fcnchen.example', 27017],
    ['mongodb://m\u00fcnchen.example:27018/db', 'm\u00fcnchen.example', 27018],
    ['mongodb://\u65e5\u672c.example', '\u65e5\u672c.example', 27017],
    ['mongodb://\ud83d\ude00.example', '\ud83d\ude00.example', 27017],
    ['mongodb+srv://m\u00fcnchen.example', 'm\u00fcnchen.example', 27017],
    ['mongodb://M\u00dcNCHEN.example', 'M\u00dcNCHEN.example', 27017],
    ['mongodb://\u0430pple.example', '\u0430pple.example', 27017],
    ['mongodb://%2Ftmp%2Fmongodb-27017.sock', '%2Ftmp%2Fmongodb-27017.sock', 27017],
  ])('accepts %s', (uri, host, port) => {
    const { input } = parseConnectionUri(uri);
    expect({ host: input.host, port: input.port }).toEqual({ host, port });
  });

  // Host names whose DNS form (UTS46) is a different name than the one shown.
  it.each([
    ['an ideographic full stop', 'good.example\u3002evil.com'],
    ['a fullwidth full stop', 'good.example\uFF0Eevil.com'],
    ['a halfwidth ideographic full stop', 'good.example\uFF61evil.com'],
    ['a zero-width space', 'go\u200Bod.example'],
    ['a zero-width joiner', 'go\u200Dod.example'],
    ['a soft hyphen', 'go\u00ADod.example'],
    ['a fullwidth slash', 'good\uFF0Fevil.com'],
    ['a fullwidth at sign', 'good\uFF20evil.com'],
    ['a fullwidth question mark', 'good\uFF1Fevil.com'],
    ['a fullwidth number sign', 'good\uFF03evil.com'],
    ['a fullwidth colon', 'good\uFF1A1.com'],
    ['a fullwidth comma', 'good\uFF0Cevil.com'],
    ['a small commercial at', 'good\uFE6Bevil.com'],
    ['a small number sign', 'good\uFE5Fevil.com'],
    ['a right-to-left override', 'good\u202Eevil.com'],
    ['a lone surrogate', 'good\uD800.example'],
  ])('refuses a host with %s', (_name, host) => {
    expect(parseHostPort(host, true)).toEqual({ problem: "The host has characters a host name can't contain." });
  });

  it('keeps an uppercase international host as typed, lower-casing only for the check', () => {
    expect(parseHostPort('M\u00dcNCHEN.example', true)).toEqual({ host: 'M\u00dcNCHEN.example' });
  });

  it('keeps stripping a port from an SRV host', () => {
    const { input } = parseConnectionUri('mongodb+srv://cluster0.abc.mongodb.net:27017/db');
    expect(input.host).toBe('cluster0.abc.mongodb.net');
  });
});
