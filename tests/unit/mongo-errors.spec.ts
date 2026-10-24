import { describe, it, expect } from 'vitest';
import {
  classifyIfDriverError,
  classifyMongoOpError,
  isMaxTimeMSExpired,
} from '../../electron/mongo/errors';
import { ObjectId, Decimal128 } from 'bson';
import { AppError, MongoOpError, ValidationError } from '../../electron/errors';
import { MongoNetworkTimeoutError } from 'mongodb';

/**
 * `classifyMongoOpError` is the single seam a raw driver error crosses on its
 * way to the router, so a branch that never matches is invisible — the error
 * still arrives as a well-formed envelope, just carrying the wrong code.
 *
 * Each shape below is what the driver actually produces, taken from a probe
 * against a real server rather than from the server's error-code table. The
 * two differ: mongod sends `codeName` for some errors (`IndexNotFound`) and
 * omits it entirely for others (`DocumentValidationFailure`, duplicate key),
 * and classifying on the name alone is what left the validator branch dead.
 */
describe('classifyMongoOpError', () => {
  const cases: Array<{
    what: string;
    err: Record<string, unknown>;
    code: string;
  }> = [
    // Observed with `codeName` populated.
    { what: 'MaxTimeMSExpired', err: { codeName: 'MaxTimeMSExpired', code: 50 }, code: 'TIMEOUT' },
    { what: 'IndexNotFound', err: { codeName: 'IndexNotFound', code: 27 }, code: 'NOT_FOUND' },
    { what: 'Unauthorized', err: { codeName: 'Unauthorized', code: 13 }, code: 'UNAUTHORIZED' },
    { what: 'BadValue', err: { codeName: 'BadValue', code: 2 }, code: 'VALIDATION' },
    { what: 'IndexOptionsConflict', err: { code: 85 }, code: 'CONFLICT' },
    { what: 'IndexKeySpecsConflict', err: { code: 86 }, code: 'CONFLICT' },
    { what: 'UserNotFound', err: { code: 11 }, code: 'NOT_FOUND' },
    { what: 'UserAlreadyExists', err: { code: 51003 }, code: 'CONFLICT' },
    { what: 'RoleAlreadyExists', err: { code: 51002 }, code: 'CONFLICT' },
    { what: 'RoleNotFound', err: { code: 31 }, code: 'VALIDATION' },
    { what: 'NamespaceExists', err: { code: 48 }, code: 'CONFLICT' },
    { what: 'NamespaceNotFound', err: { code: 26 }, code: 'NOT_FOUND' },

    // Observed with NO `codeName` — these are the ones a name-keyed branch misses.
    { what: 'duplicate key', err: { code: 11000 }, code: 'CONFLICT' },
    { what: 'document validation failure', err: { code: 121 }, code: 'VALIDATION' },

    // Network errors — classified by name, not code.
    { what: 'MongoNetworkError', err: { name: 'MongoNetworkError' }, code: 'NETWORK' },
    { what: 'MongoNetworkTimeoutError', err: { name: 'MongoNetworkTimeoutError' }, code: 'NETWORK' },

    // An operation that found no server to run on (a read preference no
    // member can serve) is not a query that ran too long: TIMEOUT would get
    // QueryService's "stopped after N s, add an index" wording, and would
    // stop the drawer's live count asking that collection again.
    { what: 'MongoServerSelectionError', err: { name: 'MongoServerSelectionError' }, code: 'MONGO_ERROR' },

    { what: 'anything unrecognized', err: { code: 999999 }, code: 'MONGO_ERROR' },
  ];

  for (const c of cases) {
    it(`maps ${c.what} to ${c.code}`, () => {
      const out = classifyMongoOpError({ ...c.err, message: 'boom' });
      expect(out).toBeInstanceOf(AppError);
      expect(out.code).toBe(c.code);
    });
  }

  // Every case above that has both `code` and `codeName` set together can't
  // tell which one actually decided the branch — mutating either disjunct
  // away still leaves the other true. Isolate the codeName-only side for
  // each of those, with no `code` field at all.
  const codeNameOnlyCases: Array<{ what: string; codeName: string; code: string }> = [
    { what: 'Unauthorized (codeName alone)', codeName: 'Unauthorized', code: 'UNAUTHORIZED' },
    { what: 'BadValue (codeName alone)', codeName: 'BadValue', code: 'VALIDATION' },
    { what: 'IndexOptionsConflict (codeName alone)', codeName: 'IndexOptionsConflict', code: 'CONFLICT' },
    { what: 'IndexKeySpecsConflict (codeName alone)', codeName: 'IndexKeySpecsConflict', code: 'CONFLICT' },
    { what: 'IndexNotFound (codeName alone)', codeName: 'IndexNotFound', code: 'NOT_FOUND' },
    { what: 'UserNotFound (codeName alone)', codeName: 'UserNotFound', code: 'NOT_FOUND' },
    { what: 'UserAlreadyExists (codeName alone)', codeName: 'UserAlreadyExists', code: 'CONFLICT' },
    { what: 'RoleAlreadyExists (codeName alone)', codeName: 'RoleAlreadyExists', code: 'CONFLICT' },
    { what: 'RoleNotFound (codeName alone)', codeName: 'RoleNotFound', code: 'VALIDATION' },
    { what: 'DocumentValidationFailure (codeName alone)', codeName: 'DocumentValidationFailure', code: 'VALIDATION' },
    { what: 'NamespaceExists (codeName alone)', codeName: 'NamespaceExists', code: 'CONFLICT' },
    { what: 'NamespaceNotFound (codeName alone)', codeName: 'NamespaceNotFound', code: 'NOT_FOUND' },
  ];
  for (const c of codeNameOnlyCases) {
    it(`maps ${c.what} to ${c.code}`, () => {
      const out = classifyMongoOpError({ codeName: c.codeName, message: 'boom' });
      expect(out.code).toBe(c.code);
    });
  }

  // The reverse isolation for the branches whose table entry above sets
  // `codeName` and `code` together (Unauthorized, BadValue, IndexNotFound):
  // a `code`-only input, with no `codeName` at all.
  const codeOnlyCases: Array<{ what: string; code: number; expected: string }> = [
    { what: 'Unauthorized (code alone)', code: 13, expected: 'UNAUTHORIZED' },
    { what: 'BadValue (code alone)', code: 2, expected: 'VALIDATION' },
    { what: 'IndexNotFound (code alone)', code: 27, expected: 'NOT_FOUND' },
  ];
  for (const c of codeOnlyCases) {
    it(`maps ${c.what} to ${c.expected}`, () => {
      const out = classifyMongoOpError({ code: c.code, message: 'boom' });
      expect(out.code).toBe(c.expected);
    });
  }

  // The `mongoMessage` detail these four branches attach is never asserted
  // by the table above, so a mutant collapsing it to `{}` still passes.
  it('attaches mongoMessage to details for BadValue/RoleNotFound/NamespaceExists/NamespaceNotFound', () => {
    expect(classifyMongoOpError({ code: 2, message: 'bad value here' }).details).toMatchObject({
      mongoMessage: 'bad value here',
    });
    expect(classifyMongoOpError({ code: 31, message: 'no such role' }).details).toMatchObject({
      mongoMessage: 'no such role',
    });
    expect(classifyMongoOpError({ code: 48, message: 'target exists' }).details).toMatchObject({
      mongoMessage: 'target exists',
    });
    expect(classifyMongoOpError({ code: 26, message: 'no such namespace' }).details).toMatchObject({
      mongoMessage: 'no such namespace',
    });
  });

  // `??`, not `&&`: a message of `undefined` must fall back to `String(err)`,
  // not to `undefined` itself.
  it('falls back to String(err) when the driver error carries no message at all', () => {
    const err = { code: 999999 };
    const out = classifyMongoOpError(err);
    expect(out.message).toBe(String(err));
  });

  it('classifies a validator rejection by its numeric code, which is all mongod sends', () => {
    // The regression this guards: mongod reports code 121 with no codeName, so
    // a branch keyed only on the name never ran and every schema violation
    // reached the renderer as MONGO_ERROR.
    const out = classifyMongoOpError({ code: 121, message: 'Document failed validation' });
    expect(out.code).toBe('VALIDATION');
    expect(out).toBeInstanceOf(ValidationError);
  });

  it('passes errInfo through, so the renderer can say which rule failed', () => {
    const out = classifyMongoOpError({
      code: 121,
      message: 'Document failed validation',
      errInfo: { details: { operatorName: '$jsonSchema' } },
    });
    const errInfo = (out.details as { errInfo: { details: { operatorName: string } } }).errInfo;
    expect(errInfo.details.operatorName).toBe('$jsonSchema');
  });

  it('encodes errInfo as Extended JSON — mongod puts live BSON in it', () => {
    // Probed against a real validator: `failingDocumentId` comes back as an
    // ObjectId wrapping a Buffer. Everything crossing IPC is EJSON v2, so a
    // raw ObjectId here would reach the renderer as `{ buffer: Uint8Array }`.
    const oid = new ObjectId('6aa7e3dad2c27effdd46e76e');
    const out = classifyMongoOpError({
      code: 121,
      message: 'Document failed validation',
      errInfo: { failingDocumentId: oid, details: { consideredValue: new Decimal128('1.5') } },
    });
    const errInfo = (out.details as { errInfo: Record<string, Record<string, string>> }).errInfo;
    expect(errInfo.failingDocumentId).toEqual({ $oid: '6aa7e3dad2c27effdd46e76e' });
    expect(errInfo.details.consideredValue).toEqual({ $numberDecimal: '1.5' });
  });

  it('omits errInfo entirely when the driver did not supply one', () => {
    const out = classifyMongoOpError({ code: 121, message: 'Document failed validation' });
    expect(out.details).not.toHaveProperty('errInfo');
  });

  it('returns an AppError unchanged, so applying it twice cannot reclassify', () => {
    const already = new ValidationError('already classified', { keep: true });
    expect(classifyMongoOpError(already)).toBe(already);
    expect(classifyMongoOpError(classifyMongoOpError(already))).toBe(already);
  });

  it('merges extraDetails into the classified error', () => {
    const out = classifyMongoOpError({ code: 11000, message: 'dup' }, { insertedCount: 3 });
    expect(out.code).toBe('CONFLICT');
    expect(out.details).toMatchObject({ insertedCount: 3, mongoCode: 11000 });
  });

  it('keeps extraDetails on the unrecognized fallback', () => {
    const out = classifyMongoOpError({ code: 999999, message: 'x' }, { insertedCount: 1 });
    expect(out.code).toBe('MONGO_ERROR');
    expect(out.details).toMatchObject({ insertedCount: 1 });
  });

  it('keeps extraDetails on network errors', () => {
    const out = classifyMongoOpError({ name: 'MongoNetworkError', message: 'connection lost' }, { insertedCount: 5 });
    expect(out.code).toBe('NETWORK');
    expect(out.details).toMatchObject({ insertedCount: 5 });
  });

  it('classifies a real MongoNetworkTimeoutError instance as NETWORK', () => {
    const err = new MongoNetworkTimeoutError('timeout');
    const out = classifyMongoOpError(err);
    expect(out.code).toBe('NETWORK');
    expect(out).toBeInstanceOf(AppError);
  });
});

/**
 * The backstop the router applies to every channel. Its whole value is what it
 * declines to touch: a blanket classify would end in `MONGO_ERROR`, so a
 * `TypeError` from a bug in our own code would reach the renderer labelled as a
 * database problem. The integration spec drives real driver errors through a
 * real server; these pin the two passthrough branches, which no server produces.
 */
describe('classifyIfDriverError', () => {
  it('classifies an error the driver threw', () => {
    const out = classifyIfDriverError({
      name: 'MongoServerError',
      codeName: 'MaxTimeMSExpired',
      code: 50,
      message: 'operation exceeded time limit',
    });
    expect(out).toBeInstanceOf(AppError);
    expect((out as AppError).code).toBe('TIMEOUT');
  });

  it('passes an error of our own through untouched, so it stays INTERNAL', () => {
    const bug = new TypeError('x is not a function');
    expect(classifyIfDriverError(bug)).toBe(bug);
  });

  // A service that already classified its own error hands the router an
  // `AppError`, and the backstop must not reclassify it — a `ConflictError`
  // from a duplicate key would otherwise be re-read as a generic driver
  // failure. Both subclasses below return by identity, but by different
  // routes: `AppError` hardcodes `this.name`, so a `ValidationError` fails
  // `isDriverError` and never reaches the classifier, while a `MongoOpError`
  // is named `MongoOpError` — it passes the `Mongo…` prefix check and is
  // caught by `classifyMongoOpError`'s own `instanceof` guard instead.
  //
  // That makes the two guards redundant: removing either one leaves both
  // cases green. What is pinned here is the contract — an already-classified
  // error survives untouched — not either individual branch.
  it.each([
    ['a subclass the driver prefix does not match', () => new ValidationError('already classified')],
    ['a subclass named MongoOpError, which it does', () => new MongoOpError('CONFLICT', 'dup key')],
  ])('returns %s unchanged', (_what, make) => {
    const already = make();
    expect(classifyIfDriverError(already)).toBe(already);
    expect(classifyIfDriverError(classifyIfDriverError(already))).toBe(already);
  });

  it('leaves a non-object throw alone', () => {
    expect(classifyIfDriverError('boom')).toBe('boom');
    expect(classifyIfDriverError(undefined)).toBe(undefined);
    expect(classifyIfDriverError(null)).toBe(null);
  });

  // The docstring's own claim: classification must never cost the envelope,
  // so a hostile thrown value whose `instanceof` check itself throws (a Proxy
  // with a throwing `getPrototypeOf` trap) still gets handed back, via the
  // outer try/catch, rather than rejecting the caller.
  it('hands back a hostile value whose own instanceof check throws, rather than rejecting', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap sprung');
        },
      },
    );
    expect(classifyIfDriverError(hostile)).toBe(hostile);
  });

  it('keys off the driver name prefix, not on having a mongo-shaped code', () => {
    // A plain Error carrying a driver code is not a driver error — only the
    // `Mongo…` class names are common to every error the driver exports.
    const impostor = Object.assign(new Error('dup'), { code: 11000 });
    expect(classifyIfDriverError(impostor)).toBe(impostor);
  });

  // `isDriverError`'s `typeof name === 'string'` guard is not just belt-and-
  // suspenders against a throw: a boxed `String` has `typeof !== 'string'`
  // but still inherits `startsWith`, so without the guard a `new
  // String('MongoFoo')` name would slip past the `typeof` check, pass the
  // prefix test, and get handed to `classifyMongoOpError` — whose own field
  // reads (`e.name === 'MongoNetworkError'`, `===` against a boxed String)
  // all fail, landing it as a fabricated `MONGO_ERROR` instead of passing
  // the original error through untouched.
  it('does not treat a boxed String name as a driver name, even though it has startsWith', () => {
    const err = { name: new String('MongoServerError'), message: 'x' };
    expect(classifyIfDriverError(err)).toBe(err);
  });
});

/**
 * Two call sites branch on this to retry with a cheaper question rather than to
 * build an `AppError`, so it has to stay exact: a false positive turns a real
 * failure into a silent degrade.
 */
describe('isMaxTimeMSExpired', () => {
  const cases: Array<{ what: string; err: unknown; expected: boolean }> = [
    { what: 'the server reporting MaxTimeMSExpired', err: { codeName: 'MaxTimeMSExpired', code: 50 }, expected: true },
    { what: 'a different codeName', err: { codeName: 'Unauthorized', code: 13 }, expected: false },
    // A Db-level `timeoutMS` throws this shape — no `codeName` at all, which
    // is why the bound lives on the call and not on the handle.
    { what: 'a Db-level timeoutMS, which carries no codeName', err: { name: 'MongoOperationTimeoutError' }, expected: false },
    { what: 'a plain Error that merely mentions a timeout', err: new Error('timed out'), expected: false },
    { what: 'null', err: null, expected: false },
    { what: 'undefined', err: undefined, expected: false },
  ];

  for (const c of cases) {
    it(`is ${c.expected} for ${c.what}`, () => {
      expect(isMaxTimeMSExpired(c.err)).toBe(c.expected);
    });
  }
});
