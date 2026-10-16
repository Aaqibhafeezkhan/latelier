import { describe, it, expect } from 'vitest';
import type { MappingField } from '@shared/types';
import { ValidationError } from '../../electron/errors';
import { parseLine, type ParsedLine } from '../../electron/services/connectionBulkAdd';
import {
  buildCollections,
  combineRow,
  findCollections,
  MAP_TARGETS,
} from '../../electron/services/import/unknownJson';

const rows = (n: number, extra: object = {}) => Array.from({ length: n }, (_, i) => ({ i, ...extra }));
const fields = (value: unknown): MappingField[] => buildCollections(value)[0]!.fields;
const field = (value: unknown, path: string) => fields(value).find((f) => f.path === path);

describe('MAP_TARGETS', () => {
  it('lists the targets in the §5.3 order', () => {
    expect(MAP_TARGETS).toEqual([
      'name', 'connectionString', 'host', 'port', 'username',
      'password', 'authDatabase', 'defaultDb', 'tls',
    ]);
  });
});

describe('findCollections', () => {
  it('takes a top-level array of objects as the collection at ""', () => {
    expect(findCollections([{ a: 1 }, { a: 2 }])).toEqual({ collections: [{ at: '', rows: [{ a: 1 }, { a: 2 }] }], ambiguous: 0 });
  });

  it('lists nested arrays largest first, ties in document order', () => {
    const value = {
      small: rows(1),
      data: { servers: rows(3), others: rows(2) },
      tie: rows(2),
    };
    expect(findCollections(value).collections.map((c) => [c.at, c.rows.length])).toEqual([
      ['data.servers', 3],
      ['data.others', 2],
      ['tie', 2],
      ['small', 1],
    ]);
  });

  it('finds collections inside array elements and objects that are not collections', () => {
    const value = [[{ a: 1 }], { list: [{ b: 1 }, { b: 2 }] }];
    expect(findCollections(value).collections.map((c) => c.at)).toEqual(['1.list', '0']);
  });

  it("does not search a collection's rows for more collections", () => {
    const value = {
      servers: [{ replicas: [{ h: 1 }, { h: 2 }, { h: 3 }] }, { replicas: [{ h: 4 }] }],
      meta: { owners: [{ n: 1 }] },
    };
    expect(findCollections(value).collections.map((c) => c.at)).toEqual(['servers', 'meta.owners']);
  });

  it('ignores empty arrays and arrays that mix objects with anything else', () => {
    const value = { empty: [], mixed: [{ a: 1 }, 2], nulls: [{ a: 1 }, null], nested: [[{ a: 1 }]], ok: rows(1) };
    expect(findCollections(value).collections.map((c) => c.at)).toEqual(['nested.0', 'ok']);
  });

  it('treats a lone top-level object as one row', () => {
    const value = { host: 'h', port: 1 };
    expect(findCollections(value).collections).toEqual([{ at: '', rows: [value] }]);
  });

  it('finds an array five levels down but not six', () => {
    const five = { a: { b: { c: { d: { e: rows(1) } } } } };
    const six = { a: { b: { c: { d: { e: { f: rows(1) } } } } } };
    expect(findCollections(five).collections.map((c) => c.at)).toEqual(['a.b.c.d.e']);
    // Six levels down is out of reach, so the top object is the lone row.
    expect(findCollections(six).collections).toEqual([{ at: '', rows: [six] }]);
  });

  it('caps a collection at 500 rows and reports the cut', () => {
    const [c] = findCollections(rows(503)).collections;
    expect(c!.rows).toHaveLength(500);
    expect(c!.rows[499]).toEqual({ i: 499 });
    expect(c!.truncatedRows).toBe(3);
    expect(findCollections(rows(500)).collections[0]).not.toHaveProperty('truncatedRows');
  });

  it('ranks by the row count before the cap', () => {
    expect(findCollections({ a: rows(600), b: rows(700) }).collections.map((c) => c.at)).toEqual(['b', 'a']);
  });

  it.each([
    ['an empty array', []],
    ['an array of strings', ['mongodb://h']],
    ['a string', 'mongodb://h'],
    ['a number', 1],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(() => findCollections(value)).toThrow(ValidationError);
    expect(() => findCollections(value)).toThrow('No connections found in this file.');
  });
});

describe('buildCollections — fields', () => {
  it('flattens rows to dot paths over scalar leaves, union in document order', () => {
    const value = [
      { name: 'a', servers: [{ host: 'h1' }], opts: { tls: true, n: null, empty: {} } },
      { name: 'b', port: 27018 },
    ];
    // A row's own array of objects is a field of the row, not another collection.
    expect(buildCollections(value).map((c) => c.at)).toEqual(['']);
    expect(buildCollections(value)[0]).toEqual({
      at: '',
      rows: 2,
      fields: [
        { path: 'name', sample: 'a', masked: false, suggested: 'name' },
        { path: 'servers.0.host', sample: 'h1', masked: false, suggested: 'host' },
        { path: 'opts.tls', sample: 'true', masked: false, suggested: 'tls' },
        { path: 'port', sample: '27018', masked: false, suggested: 'port' },
      ],
    });
  });

  it('takes the sample from the first row that has the path', () => {
    expect(field([{ a: 1 }, { a: 2, b: 'x' }, { b: 'y' }], 'b')!.sample).toBe('x');
  });

  it('carries the row count and the cut', () => {
    const [c] = buildCollections(rows(501));
    expect(c!.rows).toBe(500);
    expect(c!.truncatedRows).toBe(1);
    expect(buildCollections(rows(2))[0]).not.toHaveProperty('truncatedRows');
  });

  it('lists at most 200 paths', () => {
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${i}`, i]));
    const wider = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`g${i}`, i]));
    const fs = fields([wide, wider]);
    expect(fs).toHaveLength(200);
    expect(fs[149]!.path).toBe('f149');
    expect(fs[199]!.path).toBe('g49');
  });

  it('offers leaves up to 20 levels below the row and skips deeper ones', () => {
    const deep = (levels: number): Record<string, unknown> =>
      levels === 0 ? { leaf: 'x' } : { n: deep(levels - 1) };
    // Under `a`, deep(n)'s leaf is segment n + 2.
    const [, last] = fields([{ host: 'h', a: deep(18) }]);
    expect(last!.path.split('.')).toHaveLength(20);
    expect(last!.path.endsWith('.n.leaf')).toBe(true);
    expect(fields([{ host: 'h', a: deep(19) }]).map((f) => f.path)).toEqual(['host']);
    // Far past the cap, flattening still returns instead of overflowing the stack.
    let huge: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 100_000; i++) huge = { n: huge };
    expect(fields([{ host: 'h', a: huge }]).map((f) => f.path)).toEqual(['host']);
    expect(combineRow({ host: 'h', a: huge }, { host: 'host' }).input.host).toBe('h');
  });

  it('keeps a "__proto__" key as data', () => {
    const value = JSON.parse('[{"__proto__": {"host": "h"}, "port": 1}]');
    expect(fields(value).map((f) => f.path)).toEqual(['__proto__.host', 'port']);
  });
});

describe('buildCollections — paths that name two things', () => {
  // A literal dotted key and real nesting join to the same path, so one of
  // them would silently stand in for the other.
  const REVIEWED = '{"db.servers":[{"host":"first.example"}],"db":{"servers":[{"host":"second.example"}]}}';

  it('refuses a file whose only lists share their path, with no fallback to the top-level object', () => {
    expect(() => buildCollections(JSON.parse(REVIEWED))).toThrow(ValidationError);
    expect(() => buildCollections(JSON.parse(REVIEWED))).toThrow(
      "The lists of connections in this file can't be told apart: each has the same path as another list.",
    );
  });

  it('leaves colliding lists out and keeps the others', () => {
    const value = JSON.parse(REVIEWED.replace(/^\{/, '{"ok":[{"host":"ok.example"}],'));
    expect(buildCollections(value).map((c) => c.at)).toEqual(['ok']);
  });

  it.each([
    ['three ways', '{"a.b.c":[{"x":1}],"a.b":{"c":[{"x":2}]},"a":{"b":{"c":[{"x":3}]}},"ok":[{"x":4}]}'],
    ['an array index against a "0" key', '{"a":[[{"x":1}]],"a.0":[{"x":2}],"ok":[{"x":3}]}'],
    ['empty keys against a dot', '{"":{"":[{"x":1}]},".":[{"x":2}],"ok":[{"x":3}]}'],
  ])('leaves out lists that collide %s', (_label, text) => {
    expect(buildCollections(JSON.parse(text)).map((c) => c.at)).toEqual(['ok']);
  });

  it('leaves out a field two leaves of a row share, and never reads either value', () => {
    const value = JSON.parse('[{"host":"h","a.b":"first-leaf","a":{"b":"second-leaf"}}]');
    expect(fields(value).map((f) => f.path)).toEqual(['host']);
    expect(JSON.stringify(buildCollections(value))).not.toMatch(/first-leaf|second-leaf/);
    const row = combineRow(value[0], { host: 'host', name: 'a.b' });
    expect(row.nameHint).toBe('');
    expect(row.warnings).toEqual([]);
  });

  it('leaves out a field that collides in any row, even one the first row has once', () => {
    const value = JSON.parse('[{"host":"h","a.b":1},{"host":"i","a.b":2,"a":{"b":3}},{"z":1}]');
    expect(fields(value).map((f) => f.path)).toEqual(['host', 'z']);
  });

  it.each([
    ['three ways', '{"a.b.c":1,"a.b":{"c":2},"a":{"b":{"c":3}},"host":"h"}'],
    ['an array index against a "0" key', '{"a":[1],"a.0":2,"host":"h"}'],
    ['an empty key', '{"x":1,"":{"x":2},"host":"h"}'],
  ])('leaves out fields that collide %s', (_label, text) => {
    expect(fields([JSON.parse(text)]).map((f) => f.path)).toEqual(['host']);
  });

  it('counts the paths left out, not the lists or leaves behind them', () => {
    const lists = '{"a.b":[{"x":1}],"a":{"b":[{"x":2}]},"c.d":[{"x":3}],"c":{"d":[{"x":4}],"d.e":[{"x":5}]},"ok":[{"x":6}]}';
    expect(findCollections(JSON.parse(lists)).ambiguous).toBe(2);
    expect(findCollections(JSON.parse(lists)).collections.map((c) => c.at)).toEqual(['c.d.e', 'ok']);
    const three = '{"a.b.c":1,"a.b":{"c":2},"a":{"b":{"c":3}},"x.y":1,"x":{"y":2},"host":"h"}';
    expect(buildCollections([JSON.parse(three)])[0]).toMatchObject({ fields: [{ path: 'host' }], ambiguousFields: 2 });
    expect(buildCollections([{ host: 'h' }])[0]).not.toHaveProperty('ambiguousFields');
  });

  it('never shows a secret through a colliding path', () => {
    const value = JSON.parse('[{"host":"h","a.uri":"mongodb://u:pw-marker@x","a":{"uri":"plain"}}]');
    expect(JSON.stringify(buildCollections(value))).not.toContain('pw-marker');
    expect(combineRow(value[0], { host: 'host', connectionString: 'a.uri' }).secrets).toEqual({});
  });
});

describe('buildCollections — masking', () => {
  it.each(['password', 'dbPass', 'PWD', 'pw', 'Pw', 'dbPw', 'clientSecret', 'apiToken', 'sshKey', 'Credentials'])(
    'masks a path ending in %s',
    (key) => {
      expect(field({ [key]: 'hunter2' }, key)).toMatchObject({ sample: '••••', masked: true });
    },
  );

  it.each(['authSource', 'authMechanism'])('shows the sample of %s, which is not a secret', (key) => {
    expect(field({ [key]: 'admin' }, key)).toMatchObject({ sample: 'admin', masked: false });
  });

  it('masks a non-string value under a secret key', () => {
    expect(field({ pin: 1, auth: { key: 1234 } }, 'auth.key')).toMatchObject({ sample: '••••', masked: true });
  });

  it('masks a list of secrets under a secret key', () => {
    expect(field({ apiKeys: ['k1', 'k2'] }, 'apiKeys.0')).toMatchObject({ sample: '••••', masked: true });
  });

  it('reads only the last key, so a secret-named container does not mask its fields', () => {
    expect(field({ secret: { host: 'h' } }, 'secret.host')).toEqual({
      path: 'secret.host', sample: 'h', masked: false, suggested: 'host',
    });
  });

  it('skips only all-digit index segments when finding the last key', () => {
    const value = { password: { '1st': 'a', v2: 'b' }, apiKeys: Array.from({ length: 11 }, () => 'k') };
    expect(field(value, 'password.1st')).toMatchObject({ sample: 'a', masked: false });
    expect(field(value, 'password.v2')).toMatchObject({ sample: 'b', masked: false });
    expect(field(value, 'apiKeys.10')).toMatchObject({ sample: '••••', masked: true });
  });

  it('leaves a non-secret path alone', () => {
    expect(field({ hostname: 'db.example.com' }, 'hostname')).toMatchObject({ sample: 'db.example.com', masked: false });
  });

  it('strips the userinfo password from a connection string', () => {
    const f = field({ conn: 'mongodb://alice:hunter2@h:27017/app' }, 'conn')!;
    expect(f).toMatchObject({ masked: true, sample: 'mongodb://alice@h:27017/app' });
  });

  it.each([
    ['tlsCertificateKeyFilePassword', 'mongodb://h/?TLSCertificateKeyFilePassword=hunter2&appName=x'],
    ['proxyPassword', 'mongodb://h/?proxyPassword=hunter2&proxyHost=p'],
    ['AWS_SESSION_TOKEN', 'mongodb+srv://h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:hunter2'],
  ])('strips %s from a connection string', (_label, uri) => {
    const f = field({ conn: uri }, 'conn')!;
    expect(f.masked).toBe(true);
    expect(f.sample).not.toContain('hunter2');
    expect(f.sample.startsWith('mongodb')).toBe(true);
  });

  it('reads a connection string with surrounding spaces', () => {
    expect(field({ conn: ' mongodb://alice:hunter2@h ' }, 'conn')).toMatchObject({ sample: 'mongodb://alice@h/', masked: true });
  });

  it.each([
    'see mongodb://alice:hunter2@h',
    'primary MONGODB+SRV://alice:hunter2@c.example.net, then failover',
    'mongodb://h and mongodb://alice:hunter2@h2',
    'mongodb://h/?appName=x mongodb://alice:hunter2@h2',
    'mongodb://h/?appName=mongodb://alice:hunter2@h2',
    // Parses as one string with no password, yet carries a second one in a parameter.
    'mongodb://h/?appName=mongodb://alice:hunter2',
  ])('hides text that holds a connection string among other words: %s', (notes) => {
    expect(field({ notes }, 'notes')).toMatchObject({ sample: '••••', masked: true });
  });

  it.each(['\u200Bmongodb://alice:hunter2@h', '\uFEFF mongodb://alice:hunter2@h\u2060\n', '\u200C\u200Dmongodb://alice:hunter2@h'])(
    'reads a connection string behind invisible characters: %j',
    (conn) => {
      expect(field({ conn }, 'conn')).toMatchObject({ sample: 'mongodb://alice@h/', masked: true });
    },
  );

  it('shows a connection string without secrets behind invisible characters as it is', () => {
    expect(field({ conn: '\u200Bmongodb://alice@h' }, 'conn')).toMatchObject({ sample: '\u200Bmongodb://alice@h', masked: false });
  });

  it('keeps a key holding a connection string out of every path and collection', () => {
    const value = {
      'mongodb://admin:hunter2@prod': { host: 'h' },
      'x MONGODB+SRV://a:hunter2@c': [{ host: 'h' }],
      servers: [{ host: 'h', 'mongodb://admin:hunter2@prod': { port: 1 }, ok: 1 }],
    };
    const out = JSON.stringify(buildCollections(value));
    expect(out).not.toContain('hunter2');
    expect(buildCollections(value).map((c) => c.at)).toEqual(['servers']);
    expect(fields(value).map((f) => f.path)).toEqual(['host', 'ok']);
    // With its only array out of reach the object is the lone row, and the key is still no field.
    expect(buildCollections({ 'mongodb://admin:hunter2@prod': [{ host: 'h' }] })).toEqual([{ at: '', rows: 1, fields: [] }]);
  });

  it('skips keys longer than 256 characters', () => {
    const long = 'k'.repeat(257);
    const fine = 'f'.repeat(256);
    expect(fields([{ host: 'h', [long]: 1, [fine]: 2 }]).map((f) => f.path)).toEqual(['host', fine]);
    expect(findCollections({ [long]: [{ a: 1 }], [fine]: [{ b: 1 }] }).collections.map((c) => c.at)).toEqual([fine]);
  });

  it.each([
    ['mixed-case duplicates', 'mongodb://h/?proxyPassword=hunter2&PROXYPASSWORD=hunter3&TLSCertificateKeyFilePassword=hunter4&tlscertificatekeyfilepassword=hunter5'],
    ['a lower-case token key', 'mongodb://h/?authMechanismProperties=aws_session_token:hunter2'],
    ['an upper-case properties name', 'mongodb://h/?AUTHMECHANISMPROPERTIES=AWS_SESSION_TOKEN:hunter2'],
    ['repeated properties', 'mongodb://h/?authMechanismProperties=SERVICE_NAME:x&authMechanismProperties=AWS_SESSION_TOKEN:hunter2'],
  ])('strips every copy of a secret parameter (%s)', (_label, uri) => {
    const f = field({ conn: uri }, 'conn')!;
    expect(f.masked).toBe(true);
    expect(f.sample).not.toMatch(/hunter/);
  });

  it('keeps the non-secret parts of a stripped connection string', () => {
    const uri = 'mongodb://alice:pw@h1,h2/app?authMechanismProperties=SERVICE_NAME:x&proxyPassword=p&appName=a';
    expect(field({ conn: uri }, 'conn')!.sample).toBe(
      'mongodb://alice@h1,h2/app?authMechanismProperties=SERVICE_NAME%3Ax&appName=a',
    );
  });

  it('shows a connection string without secrets as it is', () => {
    const uri = 'mongodb://alice@h:27017/?authSource=admin';
    expect(field({ conn: uri }, 'conn')).toMatchObject({ sample: uri, masked: false });
    // Only authMechanismProperties can carry the token.
    const named = 'mongodb://h/?appName=AWS_SESSION_TOKEN';
    expect(field({ conn: named }, 'conn')).toMatchObject({ sample: named, masked: false });
  });

  it('hides a connection string it cannot parse', () => {
    expect(field({ conn: 'mongodb://alice:hun/ter2@h' }, 'conn')).toMatchObject({ sample: '••••', masked: true });
    expect(field({ conn: ' MONGODB://alice:hunter2@h' }, 'conn')).toMatchObject({ sample: '••••', masked: true });
  });
});

describe('buildCollections — suggestions', () => {
  const suggestions = (value: unknown) =>
    Object.fromEntries(fields(value).filter((f) => f.suggested).map((f) => [f.path, f.suggested]));

  it('matches each key-name synonym case-insensitively', () => {
    const row = {
      URI: 'x', HostName: 'h', Port: 1, Login: 'u', PWD: 'p', authSource: 'a', DbName: 'd', Label: 'n', SSL: true,
    };
    expect(suggestions(row)).toEqual({
      URI: 'connectionString', HostName: 'host', Port: 'port', Login: 'username', PWD: 'password',
      authSource: 'authDatabase', DbName: 'defaultDb', Label: 'name', SSL: 'tls',
    });
  });

  it.each([
    ['url', 'connectionString'], ['connectionString', 'connectionString'], ['connection_string', 'connectionString'],
    ['mongoUri', 'connectionString'], ['mongoUrl', 'connectionString'], ['host', 'host'], ['server', 'host'],
    ['user', 'username'], ['username', 'username'], ['password', 'password'], ['pass', 'password'],
    ['authDb', 'authDatabase'], ['authDatabase', 'authDatabase'], ['db', 'defaultDb'], ['database', 'defaultDb'],
    ['name', 'name'], ['title', 'name'], ['tls', 'tls'],
  ])('suggests %s as %s', (key, target) => {
    expect(field({ [key]: 'x' }, key)!.suggested).toBe(target);
  });

  it('suggests a mongodb:// or mongodb+srv:// value as Connection string, over its key name', () => {
    expect(suggestions({ host: 'mongodb://h' })).toEqual({ host: 'connectionString' });
    expect(suggestions({ notes: ' mongodb+srv://h' })).toEqual({ notes: 'connectionString' });
  });

  it('gives each target to the first path in document order only', () => {
    expect(suggestions({ primary: { host: 'a' }, replica: { host: 'b' }, uri: 'mongodb://x', other: 'mongodb://y' }))
      .toEqual({ 'primary.host': 'host', uri: 'connectionString' });
  });

  it('does not fall back to the key name when the value rule lost its target', () => {
    expect(suggestions({ uri: 'mongodb://x', host: 'mongodb://y' })).toEqual({ uri: 'connectionString' });
  });

  it('suggests nothing for an unknown key', () => {
    expect(field({ hosts: 'x' }, 'hosts')).not.toHaveProperty('suggested');
  });
});

describe('combineRow', () => {
  const ok = (uri: string) => parseLine(uri) as ParsedLine;
  const withoutPassword = (line: ParsedLine) => {
    const rest = { ...line.input };
    delete rest.password;
    return rest;
  };

  it('uses a mapped connection string as the base, password moved to secrets', () => {
    const uri = 'mongodb://alice:pw@h1,h2/app?directConnection=false&replicaSet=rs';
    const line = ok(uri);
    const row = combineRow({ label: 'Prod', uri }, { name: 'label', connectionString: 'uri' });
    expect(row).toEqual({
      input: withoutPassword(line),
      secrets: { password: 'pw' },
      nameHint: 'Prod',
      explicitDirect: line.explicitDirect,
      multiHost: true,
      warnings: line.warnings,
      repick: line.repick,
      defaultTicked: true,
    });
    expect(row.input).not.toHaveProperty('password');
  });

  it('ignores Host and Port when a string is mapped', () => {
    const row = combineRow({ uri: 'mongodb://h:1', host: 'other', port: 'bad' }, { connectionString: 'uri', host: 'host', port: 'port' });
    expect(row.input).toMatchObject({ host: 'h', port: 1 });
    expect(row.warnings).toEqual([]);
  });

  it('fills only what the string lacks', () => {
    const row = combineRow(
      { uri: 'mongodb://h', u: 'bob', p: 'pw', a: 'admin', d: 'app', t: 'true' },
      { connectionString: 'uri', username: 'u', password: 'p', authDatabase: 'a', defaultDb: 'd', tls: 't' },
    );
    expect(row.input).toMatchObject({
      authUsername: 'bob', authMech: 'default', authDatabase: 'admin', defaultDb: 'app', tls: { enabled: true, verify: true },
    });
    expect(row.secrets).toEqual({ password: 'pw' });
    expect(row.warnings).toEqual([]);
  });

  it('keeps an explicit mechanism when a username fills in', () => {
    const row = combineRow({ uri: 'mongodb://h/?authMechanism=SCRAM-SHA-256', u: 'bob' }, { connectionString: 'uri', username: 'u' });
    expect(row.input).toMatchObject({ authUsername: 'bob', authMech: 'scram256' });
  });

  it('warns on a conflict, naming the path but never the value', () => {
    const row = combineRow(
      { s: { uri: 'mongodb://alice:pw@h/app?authSource=admin&tls=true' }, u: 'bob', p: 'other-pw', a: 'x', d: 'y', t: false },
      { connectionString: 's.uri', username: 'u', password: 'p', authDatabase: 'a', defaultDb: 'd', tls: 't' },
    );
    expect(row.input).toMatchObject({ authUsername: 'alice', authDatabase: 'admin', defaultDb: 'app', tls: { enabled: true } });
    expect(row.secrets).toEqual({ password: 'pw' });
    const conflict = (p: string) => `${p} was ignored: the connection string already sets a different value.`;
    expect(row.warnings).toEqual([conflict('u'), conflict('p'), conflict('a'), conflict('d'), conflict('t')]);
    expect(JSON.stringify(row.warnings)).not.toContain('other-pw');
  });

  it('does not warn when a mapped value equals the string', () => {
    const row = combineRow(
      { uri: 'mongodb://alice:pw@h/app?authSource=admin&ssl=false', u: 'alice', p: 'pw', a: 'admin', d: 'app', t: 'false' },
      { connectionString: 'uri', username: 'u', password: 'p', authDatabase: 'a', defaultDb: 'd', tls: 't' },
    );
    expect(row.warnings).toEqual([]);
  });

  it.each([
    ['tls first', 'mongodb://h/?tls=true'],
    ['ssl', 'mongodb://h/?appName=x&SSL=true'],
  ])('warns when the string sets TLS itself (%s)', (_label, uri) => {
    const row = combineRow({ uri, t: false }, { connectionString: 'uri', tls: 't' });
    expect(row.input.tls!.enabled).toBe(true);
    expect(row.warnings).toEqual(['t was ignored: the connection string already sets a different value.']);
  });

  it('only reads TLS from the query part of the string', () => {
    const row = combineRow({ uri: 'mongodb://h/db&tls=false', t: true }, { connectionString: 'uri', tls: 't' });
    expect(row.input.tls!.enabled).toBe(true);
    expect(row.warnings).toEqual([]);
  });

  it('lets a mapped TLS override the parser default when the string names no TLS', () => {
    const row = combineRow({ uri: 'mongodb+srv://h', t: false }, { connectionString: 'uri', tls: 't' });
    expect(row.input.tls).toEqual({ enabled: false, verify: true });
    expect(row.warnings).toEqual([]);
    const other = combineRow({ uri: 'mongodb+srv://h/?appName=x', t: false }, { connectionString: 'uri', tls: 't' });
    expect(other.input.tls!.enabled).toBe(false);
  });

  it('builds a standard Connection from Host, port 27017 by default', () => {
    const row = combineRow({ host: 'db.local' }, { host: 'host' });
    expect(row).toEqual({
      input: ok('mongodb://db.local').input,
      secrets: {},
      nameHint: '',
      explicitDirect: false,
      multiHost: false,
      warnings: [],
      repick: [],
      defaultTicked: true,
    });
    expect(row.input).toMatchObject({ connectionType: 'standard', port: 27017 });
    expect(row.secrets).toStrictEqual({});
  });

  it('gives Host + Port + Username + Auth database + Default database + TLS the same input as the equivalent string', () => {
    const row = combineRow(
      { host: 'db.example.com', port: '27018', user: 'alice', pw: 'pw', authSource: 'admin', db: 'app', tls: true },
      { host: 'host', port: 'port', username: 'user', password: 'pw', authDatabase: 'authSource', defaultDb: 'db', tls: 'tls' },
    );
    const line = ok('mongodb://alice:pw@db.example.com:27018/app?authSource=admin&tls=true');
    expect(row.input).toEqual(withoutPassword(line));
    expect(row.secrets).toEqual({ password: 'pw' });
    expect(row.explicitDirect).toBe(line.explicitDirect);
  });

  it.each([
    [65535, 65535], ['1', 1], [27018, 27018],
  ])('accepts port %j', (port, expected) => {
    const row = combineRow({ host: 'h', port }, { host: 'host', port: 'port' });
    expect(row.input.port).toBe(expected);
    expect(row.warnings).toEqual([]);
  });

  it.each([0, 65536, 1.5, -1, '0x10', '1e3', ' 1', 'abc', true])('ignores port %j with a warning', (port) => {
    const row = combineRow({ host: 'h', p: port }, { host: 'host', port: 'p' });
    expect(row.input.port).toBe(27017);
    expect(row.warnings).toEqual(["p was ignored: it isn't a port number from 1 to 65535."]);
  });

  it.each([[true, true], ['true', true], [false, false], ['false', false]])('accepts TLS %j', (tls, enabled) => {
    expect(combineRow({ host: 'h', tls }, { host: 'host', tls: 'tls' }).input.tls!.enabled).toBe(enabled);
  });

  it.each(['TRUE', 'yes', 1, 0])('ignores TLS %j with a warning', (tls) => {
    const row = combineRow({ host: 'h', t: tls }, { host: 'host', tls: 't' });
    expect(row.input.tls!.enabled).toBe(false);
    expect(row.warnings).toEqual(["t was ignored: it isn't true or false."]);
  });

  it('ignores a non-text value for a text target with a warning', () => {
    const row = combineRow({ host: 'h', n: 7, u: true }, { host: 'host', name: 'n', username: 'u' });
    expect(row.nameHint).toBe('');
    expect(row.input.authUsername).toBeUndefined();
    expect(row.warnings).toEqual(["n was ignored: it isn't text.", "u was ignored: it isn't text."]);
  });

  it('is unusable when the mapped host is not text', () => {
    const row = combineRow({ host: 5 }, { host: 'host' });
    expect(row.warnings).toEqual(["host was ignored: it isn't a valid host."]);
    expect(row.unusable).toBe('No connection string or host in this row.');
  });

  it.each([
    ['name', 'secret'], ['host', 'dbPassword'], ['username', 'apiKey'], ['authDatabase', 'token'],
    ['defaultDb', 'credentials.0'], ['port', 'pwd'], ['tls', 'secretTls'],
  ] as const)('ignores %s mapped to the secret-named path %s', (target, path) => {
    const row = combineRow(
      { host: 'h', secret: 'hunter2', dbPassword: 'hunter2', apiKey: 'hunter2', token: 'hunter2', credentials: ['hunter2'], pwd: 27018, secretTls: true },
      { ...(target === 'host' ? {} : { host: 'host' }), [target]: path },
    );
    expect(row.warnings).toEqual([`${path} was ignored: it holds a secret; map it to Password or Connection string.`]);
    expect(JSON.stringify(row)).not.toContain('hunter2');
    // The secret took no effect: the host row is unusable, the others keep every default.
    if (target === 'host') expect(row.unusable).toBe('No connection string or host in this row.');
    else expect(row.input).toEqual(ok('mongodb://h').input);
  });

  it('ignores a connection string carrying a secret mapped to a shown target', () => {
    const row = combineRow(
      { host: 'h', backup: 'mongodb://h/?proxyPassword=hunter2', plain: 'mongodb://a@h' },
      { host: 'host', name: 'backup', username: 'plain' },
    );
    expect(row.warnings).toEqual(['backup was ignored: it holds a secret; map it to Password or Connection string.']);
    expect(row.nameHint).toBe('');
    // A string without a secret is shown on the mapping screen, so it may feed any target.
    expect(row.input.authUsername).toBe('mongodb://a@h');
  });

  it('lets a secret path feed Password and Connection string', () => {
    const row = combineRow({ secret: 'hunter2', mongoPassword: 'mongodb://a@h' }, { password: 'secret', connectionString: 'mongoPassword' });
    expect(row.warnings).toEqual([]);
    expect(row.secrets).toEqual({ password: 'hunter2' });
    expect(row.input.host).toBe('h');
  });

  it.each([
    ['db.example.com:27018', 'db.example.com', 27018],
    ['[::1]:27019', '[::1]', 27019],
    ['[::1]', '[::1]', 27017],
    ['10.0.0.5', '10.0.0.5', 27017],
  ])('splits a mapped Host %s like the parser does', (value, host, port) => {
    const row = combineRow({ h: value }, { host: 'h' });
    expect(row.input).toMatchObject({ host, port });
    expect(row.warnings).toEqual([]);
    expect(row.input).toEqual(ok(`mongodb://${value}`).input);
  });

  it.each(['db.example.com:0', 'db.example.com:99999', 'db.example.com:abc', 'a b', 'u@h', 'h/db', 'a,b', 'h?x=1', ''])(
    'ignores the invalid mapped Host %j with a warning',
    (value) => {
      const row = combineRow({ h: value, label: 'x' }, { host: 'h', name: 'label' });
      expect(row.unusable).toBe('No connection string or host in this row.');
      expect(row.warnings).toEqual(value === '' ? [] : ["h was ignored: it isn't a valid host."]);
    },
  );

  it("lets the host's own port win over a mapped Port, warning when they differ", () => {
    const same = combineRow({ h: 'db:27018', p: 27018 }, { host: 'h', port: 'p' });
    expect(same.input.port).toBe(27018);
    expect(same.warnings).toEqual([]);
    const other = combineRow({ h: 'db:27018', p: 27020 }, { host: 'h', port: 'p' });
    expect(other.input.port).toBe(27018);
    expect(other.warnings).toEqual(['p was ignored: the host already sets a different port.']);
    expect(combineRow({ h: 'db', p: 27020 }, { host: 'h', port: 'p' }).input.port).toBe(27020);
  });

  it('ignores an embedded connection string mapped to Name', () => {
    const row = combineRow({ host: 'h', notes: 'see mongodb://alice:hunter2@h' }, { host: 'host', name: 'notes' });
    expect(row.nameHint).toBe('');
    expect(row.warnings).toEqual(['notes was ignored: it holds a secret; map it to Password or Connection string.']);
  });

  it('treats a missing, empty or non-scalar mapped value as absent, without a warning', () => {
    const row = combineRow({ host: 'h', u: '', o: { a: 1 }, z: null }, { host: 'host', username: 'u', name: 'o', defaultDb: 'z', tls: 'nope' });
    expect(row.warnings).toEqual([]);
    expect(row.input.authUsername).toBeUndefined();
  });

  it('falls back to Host when the mapped string is not a connection string', () => {
    const row = combineRow({ uri: 'https://h', host: 'h' }, { connectionString: 'uri', host: 'host' });
    expect(row.input.host).toBe('h');
    expect(row.warnings).toEqual(["uri was ignored: it isn't a connection string."]);
  });

  it('is unusable with neither a string nor a host', () => {
    const row = combineRow({ label: 'x', port: 'bad' }, { name: 'label', host: 'host', port: 'port' });
    expect(row).toEqual({
      input: {},
      secrets: {},
      nameHint: 'x',
      explicitDirect: false,
      multiHost: false,
      warnings: ["port was ignored: it isn't a port number from 1 to 65535."],
      repick: [],
      defaultTicked: false,
      unusable: 'No connection string or host in this row.',
    });
  });

  it("is unusable with the parser's reason when the string does not parse", () => {
    const uri = 'mongodb://h/?authMechanism=PLAIN';
    const line = parseLine(uri);
    const row = combineRow({ uri, host: 'h' }, { connectionString: 'uri', host: 'host' });
    expect(line.ok).toBe(false);
    expect(row.unusable).toBe((line as { reason: string }).reason);
    expect(row.defaultTicked).toBe(false);
    expect(row.input).toEqual({});
  });
});
