import ConnectionString from 'mongodb-connection-string-url';
import type {
  AuthMech,
  ConnectionInput,
  ParsedUri,
  ParsedUriWarning,
  ReadPref,
  RepickFile,
} from '@shared/types';
import { ValidationError } from '../errors.ts';

const AUTH_MECH_MAP: Record<string, AuthMech> = {
  'SCRAM-SHA-256': 'scram256',
  'SCRAM-SHA-1': 'scram1',
  'MONGODB-X509': 'x509',
  'MONGODB-AWS': 'awsiam',
};

const READ_PREFS: ReadPref[] = [
  // Stryker disable next-line StringLiteral: mutating this entry is unobservable — the fallback below (readPreference ?? 'primary') is 'primary' too, so an unmatched 'primary' param still resolves to 'primary'. Verified by reading the ternary at readPrefParam below.
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
];

const PROXY_PARAMS = ['proxyhost', 'proxyport', 'proxyusername', 'proxypassword'];

const DROPPED_OPTIONS = new Set([
  'retrywrites',
  'w',
  'wtimeoutms',
  'journal',
  'replicaset',
  'loadbalanced',
  'readconcernlevel',
  // Both weaken verification and are not honoured: the connection stays
  // strict, but the user is told instead of being left to assume otherwise.
  'tlsinsecure',
  'tlsallowinvalidhostnames',
]);

/**
 * Parse a pasted mongodb:// or mongodb+srv:// URI into a partial
 * ConnectionInput. Does not persist anything. The caller merges the result
 * into the NewConnection form state.
 *
 * Throws ValidationError if the URI cannot be parsed at all.
 */
export function parseConnectionUri(raw: string): ParsedUri {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ValidationError('URI is empty');
  }
  if (!/^mongodb(\+srv)?:\/\//.test(trimmed)) {
    throw new ValidationError(
      'URI must start with mongodb:// or mongodb+srv://',
    );
  }

  // Defensive: `mongodb+srv://host:port/…` is malformed per the spec, but
  // pasting such a URI shouldn't hard-fail. Strip the port silently and
  // surface a warning at the end.
  const srvPortStripped: string[] = [];
  let normalized = trimmed;
  // Stryker disable next-line ConditionalExpression,StringLiteral: forcing this guard true only widens which strings reach the replace() below; the replacement regex is itself anchored to the literal 'mongodb+srv://' prefix, so it never matches a non-SRV string regardless of the guard. Verified with node: 'mongodb://...'.replace(/^(mongodb\+srv:\/\/...)/, ...) returns the input unchanged.
  if (normalized.startsWith('mongodb+srv://')) {
    normalized = normalized.replace(
      // Stryker disable next-line Regex: removing the leading `^` is unobservable here — this branch only runs when `normalized` already starts with the literal at index 0 (see the startsWith guard above), and String#replace tries the leftmost position first, so the match is found at index 0 whether or not it is anchored. Verified with node across strings that also contain the literal again later.
      /^(mongodb\+srv:\/\/(?:[^@/]*@)?)([^/?]+)/,
      (_full, prefix: string, hostSegment: string) => {
        const cleaned = hostSegment
          .split(',')
          .map((h) => {
            const m = h.match(/^(.*?):(\d+)$/);
            if (m) {
              srvPortStripped.push(m[0]!);
              return m[1]!;
            }
            return h;
          })
          .join(',');
        return prefix + cleaned;
      },
    );
  }

  let cs: ConnectionString;
  try {
    cs = new ConnectionString(normalized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`could not parse URI: ${msg}`);
  }

  const warnings: ParsedUriWarning[] = [];
  const isSrv = cs.isSRV;

  if (srvPortStripped.length > 0) {
    warnings.push({
      code: 'OPTION_DROPPED',
      detail: `SRV URIs cannot include a port; stripped: ${srvPortStripped.join(', ')}`,
    });
  }

  // Hosts ---------------------------------------------------------------
  // Stryker disable next-line ArrayDeclaration: `cs.hosts` is never undefined for any URI that survives the `new ConnectionString(...)` construction above — every URI missing a host list already throws there (verified with node: 'mongodb://', 'mongodb:///db', 'mongodb://@/db' all throw "Protocol and host list are required"). The `?? []` is a defensive fallback against a library-invariant change, kept rather than deleted.
  const hosts = cs.hosts ?? [];
  // Stryker disable next-line BlockStatement,ConditionalExpression: unreachable for the same reason — ConnectionString never returns an empty host list, so this guard's body never runs against real input. Kept as defense-in-depth against the library relaxing that invariant, not deleted.
  if (hosts.length === 0) {
    // Stryker disable next-line StringLiteral,CallExpression: dead code per the note above; neither the message text nor the throw itself can be observed by any input.
    throw new ValidationError('URI has no host');
  }
  if (hosts.length > 1) {
    warnings.push({
      code: 'MULTI_HOST_TRUNCATED',
      detail: `Only the first host was captured (${hosts[0]}). Replica-set host lists aren't modeled in iteration 1.`,
    });
  }
  const firstHost = hosts[0]!;
  // host:port split (SRV always has no port)
  const split = isSrv ? { host: firstHost, port: undefined } : splitHostPort(firstHost);
  const host = split.host;
  if (!HOST_CHARS.test(host) && !IPV6_LITERAL.test(host)) {
    throw new ValidationError("The host has characters a host name can't contain.");
  }
  let port = 27017;
  if (split.port !== undefined) {
    // Digits only: Number() would also accept '1e3', '0x10', ' 5' and ''.
    const p = /^\d{1,5}$/.test(split.port) ? Number(split.port) : 0;
    if (p < 1 || p > 65535) {
      throw new ValidationError('Port must be a number from 1 to 65535.');
    }
    port = p;
  }

  // Path → default_db ---------------------------------------------------
  // decodeURIComponent throws a raw URIError on malformed percent-encoding
  // (e.g. `db%zzname`). Unlike the username/password below — where a bad
  // escape makes `new ConnectionString(...)` itself throw, already caught
  // above — this decode happens after construction succeeds, so it needs
  // its own try/catch to keep the same ValidationError taxonomy.
  let defaultDb: string | undefined;
  // Stryker disable next-line StringLiteral: `cs.pathname` is always a string (at minimum '/') for any URI that parses at all — verified with node across 'mongodb://host', 'mongodb://host/', 'mongodb://host/db' — so the `?? ''` fallback is never taken.
  const pathname = cs.pathname ?? '';
  // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: pathname is always truthy (see above), so `pathname && X` reduces to `X` for every reachable input; forcing the whole condition (or either operand) true only makes the branch run when pathname === '/', which strips to '' and is then reset to undefined by the `if (!defaultDb) defaultDb = undefined` normalization below anyway — same observable result either way. Verified by tracing pathname === '/' through both the guarded and unguarded path.
  if (pathname && pathname !== '/') {
    try {
      // Stryker disable next-line Regex: removing the `^` anchor is unobservable — pathname always starts with '/' (WHATWG URL invariant, verified with node), so the leftmost (and only relevant) match is at index 0 whether or not the pattern is anchored.
      defaultDb = decodeURIComponent(pathname.replace(/^\//, ''));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`could not parse URI: malformed database path (${msg})`);
    }
    // Stryker disable next-line ConditionalExpression: unreachable given the guard above — decodeURIComponent never shrinks a non-empty input to length 0, and pathname !== '/' guarantees the stripped input has length >= 1, so defaultDb is always truthy here.
    if (!defaultDb) defaultDb = undefined;
  }

  // Userinfo ------------------------------------------------------------
  const authUsername = cs.username ? decodeURIComponent(cs.username) : undefined;
  const password = cs.password ? decodeURIComponent(cs.password) : undefined;

  // Query params (case-insensitive) -------------------------------------
  const params = new Map<string, string>();
  for (const [k, v] of cs.searchParams.entries()) {
    params.set(k.toLowerCase(), v);
  }

  // Auth mechanism ------------------------------------------------------
  const mechParam = params.get('authmechanism');
  let authMech: AuthMech;
  if (mechParam) {
    const mapped = AUTH_MECH_MAP[mechParam.toUpperCase()];
    if (mechParam.toUpperCase() === 'MONGODB-OIDC') {
      throw new ValidationError("OIDC sign-in isn't supported yet.");
    }
    if (!mapped) {
      throw new ValidationError(
        `unsupported authMechanism: ${mechParam}`,
      );
    }
    authMech = mapped;
  } else {
    // No explicit mechanism — let the driver negotiate when creds are present.
    authMech = authUsername ? 'default' : 'none';
  }

  // TLS -----------------------------------------------------------------
  const tlsParam = params.get('tls') ?? params.get('ssl');
  const tlsAllow = params.get('tlsallowinvalidcertificates');
  // SRV implies TLS on the server unless explicitly disabled.
  let tlsEnabled: boolean;
  if (tlsParam !== undefined) {
    tlsEnabled = tlsParam === 'true';
  } else {
    tlsEnabled = isSrv;
  }
  const tlsVerify = tlsAllow === 'true' ? false : true;
  if (!tlsVerify) {
    warnings.push({
      code: 'TLS_VERIFY_DISABLED',
      detail:
        'Certificate verification is turned off: anyone on the network path can impersonate this server',
    });
  }

  // Advanced options ----------------------------------------------------
  const connectTimeoutMs = parseIntParam(params.get('connecttimeoutms'), 10_000);
  const socketTimeoutMs = parseIntParam(params.get('sockettimeoutms'), 30_000);
  const serverSelectionTimeoutMs = parseIntParam(
    params.get('serverselectiontimeoutms'),
    30_000,
  );
  const maxPoolSize = parseIntParam(params.get('maxpoolsize'), 100);
  const directConnection = params.get('directconnection') === 'true';
  const appName = params.get('appname') ?? undefined;

  const readPrefParam = params.get('readpreference');
  const readPreference: ReadPref =
    readPrefParam && (READ_PREFS as string[]).includes(readPrefParam)
      ? (readPrefParam as ReadPref)
      : 'primary';

  const authDatabase = params.get('authsource') ?? undefined;

  // Credential files: the path is machine-local, so only the marker survives.
  const repick: RepickFile[] = [];
  if (params.get('tlscafile')) repick.push('tlsCa');
  if (params.get('tlscertificatekeyfile') || authMech === 'x509') repick.push('tlsClientCert');

  // proxyPassword is a secret, so the sentence names no value.
  if (PROXY_PARAMS.some((k) => params.has(k))) {
    warnings.push({
      code: 'PROXY_DROPPED',
      detail: 'Proxy options in the string were not imported; the connection goes direct.',
    });
  }

  // Warn on dropped options
  for (const [k] of params.entries()) {
    if (DROPPED_OPTIONS.has(k)) {
      warnings.push({ code: 'OPTION_DROPPED', detail: k });
    }
  }

  const input: Partial<ConnectionInput> = {
    connectionType: isSrv ? 'srv' : 'standard',
    host,
    port,
    defaultDb,
    authMech,
    authUsername,
    authDatabase,
    password,
    tls: {
      enabled: tlsEnabled,
      verify: tlsVerify,
    },
    advanced: {
      connectTimeoutMs,
      socketTimeoutMs,
      serverSelectionTimeoutMs,
      readPreference,
      maxPoolSize,
      directConnection,
      appName,
    },
  };

  return {
    input,
    warnings,
    repick,
    // SRV lines never get direct connection, so their params are not read.
    directConnectionExplicit: !isSrv && params.has('directconnection'),
  };
}

// Letters, digits and . - _ plus % for percent-encoded bytes (unix sockets).
const HOST_CHARS = /^[A-Za-z0-9._%-]+$/;
const IPV6_LITERAL = /^\[[0-9A-Fa-f:.]+\]$/;

/** Split `host[:port]`, treating a bracketed IPv6 literal as one unit. */
function splitHostPort(authority: string): { host: string; port: string | undefined } {
  let idx = authority.lastIndexOf(':');
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    idx = authority.charAt(close + 1) === ':' ? close + 1 : -1;
    if (idx < 0) return { host: authority, port: undefined };
  }
  if (idx < 0) return { host: authority, port: undefined };
  return { host: authority.slice(0, idx), port: authority.slice(idx + 1) };
}

function parseIntParam(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}
