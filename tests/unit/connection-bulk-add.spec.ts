import { describe, it, expect } from 'vitest';
import {
  baseNames,
  lineInputProblem,
  lineToInput,
  parseLine,
  repickFor,
  type ParsedLine,
} from '../../electron/services/connectionBulkAdd';

const DEFAULTS = { readOnly: false, directConnection: false };
const ok = (uri: string) => {
  const l = parseLine(uri);
  if (!l.ok) throw new Error(`expected ${uri} to parse: ${l.reason}`);
  return l;
};

describe('parseLine', () => {
  it('parses a connection string and reports its warnings as words', () => {
    const l = ok('mongodb://a:1,b:2/');
    expect(l.input.host).toBe('a');
    expect(l.warnings).toHaveLength(1);
    expect(l.warnings[0]).toMatch(/first host/);
  });

  it('reports a dropped option by its name', () => {
    expect(ok('mongodb://h/?w=majority').warnings).toEqual(['w']);
  });

  it('turns a parse failure into a reason instead of throwing', () => {
    expect(parseLine('http://nope')).toEqual({
      ok: false,
      reason: 'URI must start with mongodb:// or mongodb+srv://',
    });
  });

  it('never echoes a password in the reason a line was refused', () => {
    for (const uri of [
      'mongodb://u:s3cret@',
      'mongodb://u:s3cret@h/%zz',
      'mongodb://u:s3cret@h/?authMechanism=NOPE',
      'mongodb://u:s3c%ret@h/',
      'mongodb+srv://u:s3cret@h:1:2/',
    ]) {
      const l = parseLine(uri);
      expect(l.ok, uri).toBe(false);
      expect(JSON.stringify(l), uri).not.toContain('s3c');
    }
  });

  it('records whether the string set directConnection itself, case-insensitively', () => {
    expect(ok('mongodb://h/?directConnection=false').explicitDirect).toBe(true);
    expect(ok('mongodb://h/?DIRECTCONNECTION=true').explicitDirect).toBe(true);
    expect(ok('mongodb://h/?appName=x').explicitDirect).toBe(false);
  });

  it('reads the params of a line with surrounding spaces, as the parser accepts it', () => {
    expect(ok('  mongodb://h/?directConnection=true  ').explicitDirect).toBe(true);
  });

  it('never reads params off an SRV line, even one with a port the parser strips', () => {
    expect(ok('mongodb+srv://c.example.net:27017/?directConnection=true').explicitDirect).toBe(false);
  });
});

describe('baseNames', () => {
  it('names a line by its host, or host:port when the batch has that host on another port', () => {
    const lines = ['mongodb://localhost:27017', 'mongodb://localhost:27018', 'mongodb://db.example.com']
      .map(parseLine);
    expect(baseNames(lines)).toEqual(['localhost:27017', 'localhost:27018', 'db.example.com']);
  });

  it('keeps the bare host when the same host and port repeat, leaving the clash rule to number them', () => {
    const lines = ['mongodb://h:1', 'mongodb://h:1'].map(parseLine);
    expect(baseNames(lines)).toEqual(['h', 'h']);
  });

  it('leaves a bad line an empty slot', () => {
    const lines = ['mongodb://prod', 'nope', 'mongodb://prod'].map(parseLine);
    expect(baseNames(lines)).toEqual(['prod', '', 'prod']);
  });

  it('names an SRV line by its cluster host', () => {
    expect(baseNames([parseLine('mongodb+srv://u:p@c0.ab.mongodb.net/db')])).toEqual(['c0.ab.mongodb.net']);
  });
});

describe('parseLine: multiHost and repick', () => {
  it('flags a string that named several hosts, and only that', () => {
    expect(ok('mongodb://a:1,b:2/').multiHost).toBe(true);
    expect(ok('mongodb://a:1/').multiHost).toBe(false);
    expect(ok('mongodb://a:1/?w=1').multiHost).toBe(false);
  });

  it('carries the files the parser says to pick again, with no path in the line', () => {
    const l = ok('mongodb://h/?tls=true&tlsCAFile=/etc/ca.pem&tlsCertificateKeyFile=/etc/c.pem');
    expect(l.repick).toEqual(['tlsCa', 'tlsClientCert']);
    expect(JSON.stringify(l)).not.toContain('/etc/');
    expect(ok('mongodb://h/').repick).toEqual([]);
  });

  it('takes explicitDirect from the parser: an explicit false counts, an absent param does not', () => {
    expect(ok('mongodb://h/?directConnection=false').explicitDirect).toBe(true);
    expect(ok('mongodb://h/').explicitDirect).toBe(false);
  });

  it('reports a proxy drop as words without the proxy password', () => {
    const l = ok('mongodb://h/?proxyHost=p&proxyPassword=hunter2');
    expect(l.warnings).toHaveLength(1);
    expect(JSON.stringify(l)).not.toContain('hunter2');
  });

  it('turns an OIDC string into a refusal reason', () => {
    expect(parseLine('mongodb://h/?authMechanism=MONGODB-OIDC')).toEqual({
      ok: false,
      reason: "OIDC sign-in isn't supported yet.",
    });
  });
});

describe('repickFor', () => {
  it('asks an X.509 line to re-pick its certificate', () => {
    const x509 = ok('mongodb://h/?authMechanism=MONGODB-X509&tls=true').input;
    expect(repickFor(x509)).toEqual(['tlsClientCert']);
    expect(repickFor(ok('mongodb://h').input)).toEqual([]);
  });

  it('adds the files it is handed without repeating the X.509 one', () => {
    const x509 = ok('mongodb://h/?authMechanism=MONGODB-X509&tls=true').input;
    expect(repickFor(x509, ['tlsClientCert', 'tlsCa'])).toEqual(['tlsClientCert', 'tlsCa']);
    expect(repickFor(ok('mongodb://h').input, ['tlsCa'])).toEqual(['tlsCa']);
  });
});

describe('lineToInput', () => {
  it('builds a full Connection from the string, the batch defaults and the name', () => {
    const c = lineToInput(ok('mongodb://u:p@h:2000/app?authSource=admin'), 'h', { readOnly: true, directConnection: true }, undefined);
    expect(c).toEqual({
      name: 'h',
      color: '#7c6af7',
      connectionType: 'standard',
      host: 'h',
      port: 2000,
      defaultDb: 'app',
      authMech: 'default',
      authUsername: 'u',
      authDatabase: 'admin',
      password: 'p',
      tls: { enabled: false, verify: true },
      advanced: {
        connectTimeoutMs: 10_000,
        socketTimeoutMs: 30_000,
        serverSelectionTimeoutMs: 30_000,
        readPreference: 'primary',
        maxPoolSize: 100,
        directConnection: true,
        appName: undefined,
      },
      readOnly: true,
    });
  });

  it('leaves optional fields out rather than setting them undefined', () => {
    const c = lineToInput(ok('mongodb://h'), 'h', DEFAULTS, undefined);
    for (const k of ['defaultDb', 'authUsername', 'authDatabase', 'password', 'ssh']) expect(c).not.toHaveProperty(k);
    expect(c.authMech).toBe('none');
  });

  it('applies the chosen directConnection, whatever the string said', () => {
    const on = { readOnly: false, directConnection: true };
    expect(lineToInput(ok('mongodb://h/?directConnection=false'), 'h', on, undefined).advanced.directConnection).toBe(true);
    expect(lineToInput(ok('mongodb://h/?directConnection=true'), 'h', DEFAULTS, undefined).advanced.directConnection).toBe(false);
  });

  it("keeps the row's own colour and SSH settings", () => {
    const ssh = { enabled: true, host: 'bastion', port: 22, username: 'tunnel', authMethod: 'key' as const };
    const c = lineToInput({ input: { ...ok('mongodb://h').input, color: '#123456', ssh } }, 'h', DEFAULTS, undefined);
    expect(c).toMatchObject({ color: '#123456', ssh });
  });

  it('never sets directConnection on an SRV line, whatever asks for it', () => {
    const on = { readOnly: false, directConnection: true };
    expect(lineToInput(ok('mongodb+srv://c.example.net'), 'c', on, undefined).advanced.directConnection).toBe(false);
  });

  it('lets typed credentials win over the string, and negotiates when a username turns auth on', () => {
    const typed = lineToInput(ok('mongodb://h'), 'h', DEFAULTS, { index: 0, username: 'bob', password: 'pw' });
    expect(typed).toMatchObject({ authMech: 'default', authUsername: 'bob', password: 'pw' });
    const over = lineToInput(ok('mongodb://u:p@h'), 'h', DEFAULTS, { index: 0, username: 'v', password: 'q' });
    expect(over).toMatchObject({ authUsername: 'v', password: 'q' });
  });

  it("falls back to the string's username when only a password was typed", () => {
    const c = lineToInput(ok('mongodb://u@h'), 'h', DEFAULTS, { index: 0, password: 'pw' });
    expect(c).toMatchObject({ authUsername: 'u', password: 'pw', authMech: 'default' });
  });

  it("a username cleared in the second step saves without authentication, dropping the string's", () => {
    const c = lineToInput(ok('mongodb://u:pw@h/?authMechanism=SCRAM-SHA-256'), 'h', DEFAULTS, { index: 0, username: '' });
    expect(c.authMech).toBe('none');
    expect(c).not.toHaveProperty('authUsername');
    expect(c).not.toHaveProperty('password');
    expect(lineInputProblem(c)).toBeNull();
  });

  it.each([
    ['left blank', { index: 0, username: '', password: '' }],
    ['not sent', undefined],
  ])('a password from the file with the username %s saves without authentication', (_, creds) => {
    const fromFile = { input: { ...ok('mongodb://h').input, password: 'pw' } };
    const c = lineToInput(fromFile, 'h', DEFAULTS, creds);
    expect(c.authMech).toBe('none');
    expect(c).not.toHaveProperty('authUsername');
    expect(c).not.toHaveProperty('password');
    expect(lineInputProblem(c)).toBeNull();
  });

  it('a cleared username leaves a mechanism that needs none, such as AWS, alone', () => {
    const c = lineToInput(ok('mongodb://h/?authMechanism=MONGODB-AWS'), 'h', DEFAULTS, { index: 0, username: '' });
    expect(c.authMech).toBe('awsiam');
  });

  it('keeps an explicit mechanism when a username is typed', () => {
    const c = lineToInput(ok('mongodb://h/?authMechanism=SCRAM-SHA-256'), 'h', DEFAULTS, { index: 0, username: 'bob' });
    expect(c.authMech).toBe('scram256');
  });
});

describe('lineInputProblem', () => {
  const build = (uri: string, creds?: { username?: string; password?: string }) =>
    lineToInput(ok(uri) as ParsedLine, 'n', DEFAULTS, creds ? { index: 0, ...creds } : undefined);

  it('accepts a username without a password, which can be entered later', () => {
    expect(lineInputProblem(build('mongodb://u@h'))).toBeNull();
  });

  it('accepts an X.509 line without its certificate, which is picked after saving', () => {
    expect(lineInputProblem(build('mongodb://h/?authMechanism=MONGODB-X509&tls=true'))).toBeNull();
  });

  it('rejects a password with no username, in words', () => {
    expect(lineInputProblem(build('mongodb://h', { password: 'pw' }))).toBe(
      'Password must be empty when authentication is none',
    );
  });

  it('rejects an explicit mechanism left without a username', () => {
    expect(lineInputProblem(build('mongodb://h/?authMechanism=SCRAM-SHA-256'))).toBe(
      'Username is required for password authentication',
    );
  });
});

describe('long hostnames', () => {
  // A valid hostname runs to 253 characters; a Connection name stops at 64.
  const host = 'production-documentdb-cluster.cluster-abcdefghijkl.us-east-1.docdb.amazonaws.com';

  it('keeps the full host under a clamped name, and still saves', () => {
    const line = ok(`mongodb://${host}:27017`);
    const input = lineToInput(line, host.slice(0, 64), DEFAULTS, undefined);
    expect(input.host).toBe(host);
    expect(lineInputProblem(input)).toBeNull();
  });
});
