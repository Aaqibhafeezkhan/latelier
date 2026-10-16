import { domainToASCII, domainToUnicode } from 'node:url';
import type { MongoClientOptions } from 'mongodb';
import type { Connection } from '@shared/types';

/**
 * Strip leading and trailing `/` from a user-typed default database.
 *
 * An index walk rather than `.replace(/^\/+/, '').replace(/\/+$/, '')`: the
 * trailing half of that pair has an unanchored start over `\/+`, so a value
 * that is a long run of slashes followed by anything else costs O(n^2) to
 * reject (S8786). This field comes straight off the connection form.
 *
 * Both bounds checks carry equivalent mutants that stryker cannot kill, and no
 * test should be contorted to pretend otherwise. `start < end` -> `start <= end`
 * and `end > start` -> `end >= start` both still terminate, because the extra
 * iteration indexes past the walked range and compares `undefined` to `'/'`;
 * and replacing either with `true` leaves the same `undefined` guard. Verified
 * exhaustively over every arrangement of `/`, a letter and a space up to
 * length 6 (1093 inputs): all four mutants agree with this function on every
 * one, including the `slice(start, end)` cases where `end` ends up below
 * `start` and slice clamps to ''.
 */
function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/**
 * Build a mongodb:// or mongodb+srv:// URI from a saved Connection plus an
 * optional plaintext password. Never logs plaintext; never throws on missing
 * password (caller handles).
 */
export function buildUri(c: Connection, password?: string): string {
  const scheme = c.connectionType === 'srv' ? 'mongodb+srv' : 'mongodb';

  // Userinfo
  let userinfo = '';
  if (c.authMech !== 'none' && c.authUsername) {
    const user = encodeURIComponent(c.authUsername);
    const pass = password ? ':' + encodeURIComponent(password) : '';
    userinfo = `${user}${pass}@`;
  }

  // Defensive: sanitize whatever landed in the host field. Users occasionally
  // paste full URIs, trailing slashes, or a port into this input.
  const cleanHost = sanitizeHost(c.host);
  const hostport =
    c.connectionType === 'srv'
      ? cleanHost // SRV never carries a port
      : `${cleanHost}:${c.port}`;

  // Path / default database — strip any junk (/, leading whitespace) the user
  // might have typed.
  const cleanDb = stripSlashes(c.defaultDb ?? '').trim();
  const pathPart = cleanDb ? `/${encodeURIComponent(cleanDb)}` : '/';

  const params = new URLSearchParams();
  if (c.authDatabase) params.set('authSource', c.authDatabase);
  switch (c.authMech) {
    case 'scram256':
      params.set('authMechanism', 'SCRAM-SHA-256');
      break;
    case 'scram1':
      params.set('authMechanism', 'SCRAM-SHA-1');
      break;
    case 'x509':
      params.set('authMechanism', 'MONGODB-X509');
      break;
    case 'awsiam':
      params.set('authMechanism', 'MONGODB-AWS');
      break;
    // Stryker disable next-line ConditionalExpression,StringLiteral: both this case label and 'none' below are no-op branches (just `break`), and `c.authMech` is a fixed string-literal union that never equals ''. Whether the label is 'default'/'none' or the mutated '', and whether the trailing `break` runs or falls through into the next no-op case, the switch produces the same params either way. Verified by reading every branch's body: none of them have a side effect to lose.
    case 'default':
      // Omit authMechanism so the driver negotiates via SASL saslSupportedMechs.
      break;
    // Stryker disable next-line ConditionalExpression,StringLiteral: same reasoning as 'default' above — this is the switch's last case, so dropping `break` just falls out of the switch instead of through it, and the label itself is unreachable-if-renamed for the same never-'' reason.
    case 'none':
      break;
  }
  if (c.advanced.readPreference) {
    params.set('readPreference', c.advanced.readPreference);
  }
  if (c.advanced.appName) {
    params.set('appName', c.advanced.appName);
  }
  if (c.advanced.directConnection) {
    params.set('directConnection', 'true');
  }
  // TLS: SRV implies TLS on the server side but we still emit `tls=true` for
  // explicitness so operators reading the URI don't have to know the rule.
  if (c.tls.enabled) params.set('tls', 'true');
  else params.set('tls', 'false');
  if (c.tls.enabled && !c.tls.verify) {
    params.set('tlsAllowInvalidCertificates', 'true');
  }

  const qs = params.toString();
  // The `qs ? ... : ''` empty-query fallback is unreachable today — the TLS
  // block above unconditionally calls `params.set('tls', ...)` on every code
  // path, so `qs` is never empty. A `// Stryker disable` here would also
  // exempt an already-killed StringLiteral mutant on this same line, so this
  // stays prose rather than a directive.
  return `${scheme}://${userinfo}${hostport}${pathPart}${qs ? '?' + qs : ''}`;
}

/**
 * Build the option bag that accompanies the URI. Some fields (tlsCAFile,
 * tlsCertificateKeyFile, maxPoolSize, timeouts) are not representable in the
 * URI syntax and must be passed here.
 */
/**
 * A non-special URL scheme percent-encodes a non-ASCII host, and the driver
 * decodes that again for a standard connection but not for SRV, where the
 * lookup would ask for `m%C3%BCnchen.example`. Such a host goes to the driver
 * as its punycode, which both forms resolve. Anything else (a Unix-socket host
 * keeps its escapes) is left as it is.
 */
// Stryker disable BlockStatement: emptying the catch leaves `decoded` undefined, and `.test(undefined)` is false (it tests the ASCII string 'undefined'), so the next line returns the same hostname. Verified with node.
function toDriverHost(hostname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(hostname);
  } catch {
    // A malformed escape is not an encoded name; the driver gets it as written.
    return hostname;
  }
  if (!/[\u0080-\uFFFF]/.test(decoded)) return hostname;
  // domainToASCII cuts a name at `/`, `?` or `#` and folds look-alike dots, so
  // the punycode is used only when it names exactly the decoded host; any other
  // host goes on as written rather than as a different name.
  const ascii = domainToASCII(decoded);
  return domainToUnicode(ascii) === decoded.toLowerCase() ? ascii : hostname;
}
// Stryker restore BlockStatement

/**
 * Extract just the host from whatever the user typed into the Host field.
 * Input like `mongodb+srv://user@cluster.mongodb.net:27017/db?opt=1`
 * becomes `cluster.mongodb.net`.
 *
 * Uses the WHATWG URL parser (the same authority-parsing algorithm the real
 * driver's connection-string parser builds on) instead of hand-rolled
 * `indexOf('@')` string surgery. That matters because naive @-splitting
 * gets the userinfo/host boundary wrong whenever the pasted text also
 * contains a `#` fragment or more than one `@` — both were exploitable:
 * a fragment-decorated host (`good.com#@evil.com`) resolved to the wrong
 * host, and a double-`@` paste (`user@evil.com@good.com`) left an embedded
 * `@` in the output that a downstream parser reinterpreted as real
 * userinfo, smuggling an attacker-controlled username onto the wire.
 * `URL#hostname` can never contain `@`, `/`, `?`, or `#` — those characters
 * terminate the authority component by definition — so taking only that
 * component structurally rules out both classes of bug regardless of how
 * many separators the input contains.
 */
function sanitizeHost(raw: string): string {
  const trimmed = raw.trim();
  // Stryker disable next-line ConditionalExpression: skipping this early return when trimmed === '' produces the same output through the normal path anyway — `new URL('mongodb://' + '')` parses to hostname '' (verified with node), identical to returning `trimmed` ('') directly. This is a fast-path, not a behavior branch.
  if (!trimmed) return trimmed;
  const hasScheme = /^mongodb(\+srv)?:\/\//.test(trimmed);
  try {
    return toDriverHost(new URL(hasScheme ? trimmed : `mongodb://${trimmed}`).hostname);
  } catch {
    // Not parseable as a URL at all (e.g. stray whitespace). Fall back to
    // manual stripping, still cutting `/?#` before splitting on the LAST
    // `@` so we never emit an embedded separator into the output.
    const noScheme = trimmed.replace(/^mongodb(\+srv)?:\/\//, '');
    // Stryker disable next-line StringLiteral: `String#split` with a `limit` always returns an array of at least `limit` elements (padding with '' as needed) for any input, including an empty string, so `[0]` is never undefined and the `?? ''` fallback is unreachable.
    const authority = noScheme.split(/[/?#]/, 1)[0] ?? '';
    const atIdx = authority.lastIndexOf('@');
    // Stryker disable next-line ConditionalExpression: when atIdx is genuinely -1, `authority.slice(atIdx + 1)` is `authority.slice(0)`, which is `authority` itself — so forcing this ternary to always take the slice branch is unobservable; it only changes which literal expression computes the same string.
    const host = atIdx === -1 ? authority : authority.slice(atIdx + 1);
    return host.replace(/:\d+$/, '');
  }
}

/**
 * Strip `username:password` from a `mongodb://` / `mongodb+srv://` URI so it
 * can be safely logged.
 */
export function redactUriUserInfo(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
}

export function buildOptions(c: Connection): MongoClientOptions {
  const opts: MongoClientOptions = {
    connectTimeoutMS: c.advanced.connectTimeoutMs,
    socketTimeoutMS: c.advanced.socketTimeoutMs,
    serverSelectionTimeoutMS: c.advanced.serverSelectionTimeoutMs,
    maxPoolSize: c.advanced.maxPoolSize,
  };
  if (c.tls.enabled) {
    opts.tls = true;
    if (!c.tls.verify) opts.tlsAllowInvalidCertificates = true;
    if (c.tls.caPath) opts.tlsCAFile = c.tls.caPath;
    if (c.tls.clientCertPath) opts.tlsCertificateKeyFile = c.tls.clientCertPath;
  } else {
    opts.tls = false;
  }
  return opts;
}
