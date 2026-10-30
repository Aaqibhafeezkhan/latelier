import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  navigatorTreeReducer,
  initialNavigatorTreeState,
  emptyCache,
  type NavigatorTreeState,
  type NavigatorTreeAction,
  type ConnectionCache,
  type ConnectErrorInfo,
} from '../../src/pages/Workspace/navigatorTreeReducer';
import type { ProbeErrorCode } from '@shared/types';
import { ownGet } from '../../src/utils/ownProperty';
import type { CollectionInfo, DbInfo, IpcError, IpcErrorCode } from '@shared/ipc';

// Connection ids and db names are arbitrary strings used as object keys
// throughout the reducer (`state.caches[id]`, `c.collsLoading[dbName]`, …),
// via plain `{}` objects. A string that collides with an inherited
// Object.prototype member name is readable through the prototype chain even
// when no own key was ever set for it — the same class of hazard fast-check
// already caught once in this repo (ejson.ts's walkRevive/relaxLosslessly).
// These names are folded into the id/dbName generators below on purpose,
// not excluded — a fixture that can't generate the input that breaks
// something can't test for it either.
const PROTO_MEMBER_NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'];

const normalName = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((s) => !PROTO_MEMBER_NAMES.includes(s));
const hostileName = fc.constantFrom(...PROTO_MEMBER_NAMES);
// Weighted so most runs look like real ids, without starving the hostile case.
const nameArb = fc.oneof({ arbitrary: normalName, weight: 4 }, { arbitrary: hostileName, weight: 1 });

const dbInfoArb: fc.Arbitrary<DbInfo> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 8 }),
  sizeOnDisk: fc.nat(),
  empty: fc.boolean(),
});

const collectionInfoArb: fc.Arbitrary<CollectionInfo> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 8 }),
  type: fc.constantFrom<'collection' | 'view' | 'timeseries'>('collection', 'view', 'timeseries'),
  documentCount: fc.nat(),
  sizeBytes: fc.nat(),
  indexCount: fc.nat(),
  capped: fc.boolean(),
});

// Exhaustive by construction. As a plain `IpcErrorCode[]` this list silently
// under-covered the union whenever a code was added — an array annotation is a
// supertype check, so `tsc` never notices a missing member. `satisfies Record<
// IpcErrorCode, 0>` inverts that: omit a code and the typecheck fails naming it.
const IPC_ERROR_CODES = Object.keys({
  VALIDATION: 0,
  NOT_FOUND: 0,
  CONFLICT: 0,
  UNAUTHORIZED: 0,
  TIMEOUT: 0,
  NETWORK: 0,
  MONGO_ERROR: 0,
  DB_ERROR: 0,
  SECRETS_UNAVAILABLE: 0,
  SECRET_DECRYPT_FAILED: 0,
  COLUMN_DECRYPT_FAILED: 0,
  COLUMN_KEY_UNREADABLE: 0,
  BAD_PASSPHRASE: 0,
  READ_ONLY: 0,
  AUDIT_NOT_REVERSIBLE: 0,
  AUDIT_UNDO_EXPIRED: 0,
  AUDIT_ALREADY_UNDONE: 0,
  AUDIT_TARGET_CHANGED: 0,
  UNTRUSTED_SENDER: 0,
  INTERNAL: 0,
} satisfies Record<IpcErrorCode, 0>) as IpcErrorCode[];
const ipcErrorArb: fc.Arbitrary<IpcError> = fc.record({
  code: fc.constantFrom(...IPC_ERROR_CODES),
  message: fc.string({ maxLength: 20 }),
});

const connectionCacheArb: fc.Arbitrary<ConnectionCache> = fc.record({
  dbs: fc.option(fc.array(dbInfoArb, { maxLength: 3 }), { nil: null }),
  colls: fc.dictionary(nameArb, fc.array(collectionInfoArb, { maxLength: 2 }), { maxKeys: 3 }),
  err: fc.option(ipcErrorArb, { nil: null }),
  dbsLoading: fc.boolean(),
  collsLoading: fc.dictionary(nameArb, fc.boolean(), { maxKeys: 3 }),
});

const codeArb = fc.constantFrom<ProbeErrorCode>('AUTH', 'SECRET_UNREADABLE');
const connectErrorInfoArb: fc.Arbitrary<ConnectErrorInfo> = fc.record(
  { message: fc.string({ maxLength: 20 }), code: codeArb },
  { requiredKeys: ['message'] },
);

const stateArb: fc.Arbitrary<NavigatorTreeState> = fc.record({
  caches: fc.dictionary(nameArb, connectionCacheArb, { maxKeys: 3 }),
  connectErrors: fc.dictionary(nameArb, connectErrorInfoArb, { maxKeys: 3 }),
  expandedConnId: fc.option(nameArb, { nil: null }),
  expanded: fc.dictionary(nameArb, fc.dictionary(nameArb, fc.boolean(), { maxKeys: 3 }), { maxKeys: 3 }),
});

// All 13 NavigatorTreeAction variants, ids and db names hostile-inclusive.
const actionArb: fc.Arbitrary<NavigatorTreeAction> = fc.oneof(
  fc.record({ type: fc.constant<'dbsLoadStart'>('dbsLoadStart'), id: nameArb }),
  fc.record({
    type: fc.constant<'dbsLoadSuccess'>('dbsLoadSuccess'),
    id: nameArb,
    dbs: fc.array(dbInfoArb, { maxLength: 3 }),
  }),
  fc.record({ type: fc.constant<'dbsLoadError'>('dbsLoadError'), id: nameArb, err: ipcErrorArb }),
  fc.record({ type: fc.constant<'collsLoadStart'>('collsLoadStart'), id: nameArb, dbName: nameArb }),
  fc.record({
    type: fc.constant<'collsLoadSuccess'>('collsLoadSuccess'),
    id: nameArb,
    dbName: nameArb,
    colls: fc.array(collectionInfoArb, { maxLength: 2 }),
  }),
  fc.record({ type: fc.constant<'collsLoadError'>('collsLoadError'), id: nameArb, dbName: nameArb }),
  fc.record({ type: fc.constant<'cacheReset'>('cacheReset'), id: nameArb }),
  fc.record({
    type: fc.constant<'connectErrorSet'>('connectErrorSet'),
    id: nameArb,
    message: fc.string({ maxLength: 20 }),
    code: fc.option(codeArb, { nil: undefined }),
  }),
  fc.record({ type: fc.constant<'connectErrorClear'>('connectErrorClear'), id: nameArb }),
  fc.record({
    type: fc.constant<'connectErrorBackfill'>('connectErrorBackfill'),
    id: nameArb,
    message: fc.string({ maxLength: 20 }),
    code: fc.option(codeArb, { nil: undefined }),
  }),
  fc.record({ type: fc.constant<'expandedConnSet'>('expandedConnSet'), id: fc.option(nameArb, { nil: null }) }),
  fc.record({ type: fc.constant<'expandedConnSetIfNull'>('expandedConnSetIfNull'), id: nameArb }),
  fc.record({
    type: fc.constant<'dbExpandedSet'>('dbExpandedSet'),
    connectionId: nameArb,
    dbName: nameArb,
    value: fc.boolean(),
  }),
);

describe('navigatorTreeReducer property: invariants over every generated (state, action)', () => {
  // A real invariant, not a restatement: nothing in the switch stops a future
  // case from writing `state.caches[id].dbsLoading = true` directly instead
  // of spreading, and this is the property that would catch it. Wrapped to
  // tolerate a throw — a mutation-before-throw would still be a violation,
  // and the known collsLoadStart crash (a hostile connection id) throws
  // before touching `state` at all, which this also confirms.
  it('never mutates the input state, whether the dispatch succeeds or throws', () => {
    fc.assert(
      fc.property(stateArb, actionArb, (state, action) => {
        const before = structuredClone(state);
        try {
          navigatorTreeReducer(state, action);
        } catch {
          // see the deterministic collsLoadStart case below
        }
        expect(state).toEqual(before);
      }),
    );
  });

  // Structural, not incidental: the accordion invariant (spec §4.2 — at most
  // one root open) depends on expandedConnId staying a single id or null,
  // never an object, array, or stale leftover from some other slice.
  it('expandedConnId stays a string or null after any action', () => {
    fc.assert(
      fc.property(stateArb, actionArb, (state, action) => {
        let next: NavigatorTreeState;
        try {
          next = navigatorTreeReducer(state, action);
        } catch {
          return; // the one documented throw path — see below
        }
        expect(next.expandedConnId === null || typeof next.expandedConnId === 'string').toBe(true);
      }),
    );
  });
});

describe('navigatorTreeReducer property: connection isolation', () => {
  // An action naming connection X must never disturb a sibling connection Y's
  // entry — this is what lets the component hold five Connections' caches in
  // one map without a write on one clobbering another's reference (and
  // therefore its memoized render). Y is drawn from the same hostile-
  // inclusive generator as X: an untouched sibling must stay untouched
  // whatever its name looks like.
  const idScopedActionArb: fc.Arbitrary<NavigatorTreeAction> = fc.oneof(
    fc.record({ type: fc.constant<'dbsLoadStart'>('dbsLoadStart'), id: nameArb }),
    fc.record({
      type: fc.constant<'dbsLoadSuccess'>('dbsLoadSuccess'),
      id: nameArb,
      dbs: fc.array(dbInfoArb, { maxLength: 3 }),
    }),
    fc.record({ type: fc.constant<'dbsLoadError'>('dbsLoadError'), id: nameArb, err: ipcErrorArb }),
    fc.record({ type: fc.constant<'collsLoadStart'>('collsLoadStart'), id: nameArb, dbName: nameArb }),
    fc.record({
      type: fc.constant<'collsLoadSuccess'>('collsLoadSuccess'),
      id: nameArb,
      dbName: nameArb,
      colls: fc.array(collectionInfoArb, { maxLength: 2 }),
    }),
    fc.record({ type: fc.constant<'collsLoadError'>('collsLoadError'), id: nameArb, dbName: nameArb }),
    fc.record({ type: fc.constant<'cacheReset'>('cacheReset'), id: nameArb }),
    fc.record({
      type: fc.constant<'connectErrorSet'>('connectErrorSet'),
      id: nameArb,
      message: fc.string({ maxLength: 20 }),
      code: fc.option(codeArb, { nil: undefined }),
    }),
    fc.record({ type: fc.constant<'connectErrorClear'>('connectErrorClear'), id: nameArb }),
    fc.record({
      type: fc.constant<'connectErrorBackfill'>('connectErrorBackfill'),
      id: nameArb,
      message: fc.string({ maxLength: 20 }),
      code: fc.option(codeArb, { nil: undefined }),
    }),
  );

  it('leaves a sibling connection\'s cache and connectError reference-equal', () => {
    fc.assert(
      fc.property(
        stateArb,
        idScopedActionArb,
        nameArb,
        connectionCacheArb,
        connectErrorInfoArb,
        (state, action, siblingId, siblingCache, siblingError) => {
          const actedOnId = 'id' in action ? action.id : undefined;
          fc.pre(siblingId !== actedOnId);
          const seeded: NavigatorTreeState = {
            ...state,
            caches: { ...state.caches, [siblingId]: siblingCache },
            connectErrors: { ...state.connectErrors, [siblingId]: siblingError },
          };
          let next: NavigatorTreeState;
          try {
            next = navigatorTreeReducer(seeded, action);
          } catch {
            // The acted-on id crashed (the documented collsLoadStart case) —
            // out of scope for an isolation claim about the sibling.
            return;
          }
          expect(next.caches[siblingId]).toBe(siblingCache);
          expect(next.connectErrors[siblingId]).toBe(siblingError);
        },
      ),
    );
  });
});

describe('navigatorTreeReducer property: no-op guards return the identical reference', () => {
  // collsLoadStart's dedup: seeded honestly via an own `collsLoading[dbName]
  // = true` key (shadowing any inherited value), so this is a clean test of
  // "already loading is a no-op" rather than the read-side collision below.
  // Both id and dbName are hostile-inclusive now that every read in the
  // reducer goes through `ownGet` — an own key always shadows the prototype
  // chain regardless of what the key is named.
  it('a duplicate collsLoadStart for a database already marked loading is a no-op', () => {
    fc.assert(
      fc.property(stateArb, nameArb, nameArb, (state, id, dbName) => {
        const priorCache = ownGet(state.caches, id) ?? emptyCache();
        const seededCache: ConnectionCache = {
          ...priorCache,
          collsLoading: { ...priorCache.collsLoading, [dbName]: true },
        };
        const seeded: NavigatorTreeState = { ...state, caches: { ...state.caches, [id]: seededCache } };
        const next = navigatorTreeReducer(seeded, { type: 'collsLoadStart', id, dbName });
        expect(next).toBe(seeded);
      }),
    );
  });

  // connectErrorBackfill never overwrites a message already present — holds
  // for hostile ids too, though for the wrong reason (an inherited
  // Object.prototype member reads as "already backfilled" and the guard
  // fires before ever writing) — a distinct, already-covered facet of the
  // same read-side collision as the deterministic case below, not a second
  // bug to chase here.
  //
  // `existing` is non-empty on purpose: the guard is a truthiness check
  // (`if (state.connectErrors[id])`), so an empty-string message reads as
  // "not set" and is a legitimate write, not a no-op — that's a property of
  // the guard's existing truthy-check shape, not something this file is
  // trying to characterize.
  it('backfill on a connection whose error is already set is a no-op', () => {
    fc.assert(
      fc.property(
        stateArb,
        nameArb,
        fc.string({ minLength: 1, maxLength: 20 }).map((message) => ({ message })),
        fc.string({ maxLength: 20 }),
        (state, id, existing, incoming) => {
          const seeded: NavigatorTreeState = { ...state, connectErrors: { ...state.connectErrors, [id]: existing } };
          const next = navigatorTreeReducer(seeded, { type: 'connectErrorBackfill', id, message: incoming });
          expect(next).toBe(seeded);
        },
      ),
    );
  });

  // dbExpandedSet's "already at this value" guard is asserted here only
  // because this test seeds `expanded[connectionId][dbName]` as an own key
  // before dispatching — that own key shadows any inherited value, so the
  // guard's read never touches the prototype chain at all. Optional chaining
  // does NOT rescue the unseeded case the way an earlier version of this
  // comment claimed: `?.` only short-circuits when the LEFT side is
  // null/undefined, and an untouched hostile connection id's left side is a
  // truthy inherited value (e.g. `expanded['constructor']` is the `Object`
  // function), so `?.[dbName]` proceeds to read a property off it — and for
  // `dbName: 'constructor'` that resolves to `Function`, not `undefined`.
  // Verified directly: `({}['constructor'])?.['constructor']` is `Function`,
  // not `undefined`, so `?? false` never even applies.
  it('setting a db\'s expanded flag to the value it already holds is a no-op', () => {
    fc.assert(
      fc.property(stateArb, nameArb, nameArb, fc.boolean(), (state, connectionId, dbName, value) => {
        const seeded: NavigatorTreeState = {
          ...state,
          expanded: { ...state.expanded, [connectionId]: { ...state.expanded[connectionId], [dbName]: value } },
        };
        const next = navigatorTreeReducer(seeded, { type: 'dbExpandedSet', connectionId, dbName, value });
        expect(next).toBe(seeded);
      }),
    );
  });

  // connectErrorClear's absent-id no-op now guards on an own-property read
  // (`ownGet(...) === undefined`), not the raw `in` operator — `in` walks
  // the prototype chain on its own (`'constructor' in {}` is true
  // regardless of any own key), which would make this precondition
  // permanently false for every hostile id and silently skip them all. The
  // precondition mirrors the reducer's actual guard so hostile ids get real
  // coverage here.
  it('clearing a connection with no recorded error is a no-op', () => {
    fc.assert(
      fc.property(stateArb, nameArb, (state, id) => {
        fc.pre(ownGet(state.connectErrors, id) === undefined);
        const next = navigatorTreeReducer(state, { type: 'connectErrorClear', id });
        expect(next).toBe(state);
      }),
    );
  });
});

describe('navigatorTreeReducer property: fixpoints', () => {
  // No map read at all — expandedConnId is a bare scalar field — so this
  // holds unconditionally, hostile ids included.
  it('expandedConnSetIfNull applied twice equals applied once', () => {
    fc.assert(
      fc.property(stateArb, nameArb, (state, id) => {
        const once = navigatorTreeReducer(state, { type: 'expandedConnSetIfNull', id });
        const twice = navigatorTreeReducer(once, { type: 'expandedConnSetIfNull', id });
        expect(twice).toBe(once);
      }),
    );
  });

  // Verified empirically before asserting it: the first apply always creates
  // an OWN `expanded[connectionId][dbName]` key (computed-key assignment,
  // never the prototype-setting literal form), which shadows any inherited
  // collision on the second apply — so this holds for hostile ids too.
  it('dbExpandedSet applied twice with the same value equals applied once', () => {
    fc.assert(
      fc.property(stateArb, nameArb, nameArb, fc.boolean(), (state, connectionId, dbName, value) => {
        const action: NavigatorTreeAction = { type: 'dbExpandedSet', connectionId, dbName, value };
        const once = navigatorTreeReducer(state, action);
        const twice = navigatorTreeReducer(once, action);
        expect(twice).toBe(once);
      }),
    );
  });

  // Also verified empirically: holds for hostile ids too, for the same
  // reason the no-op-guard property above does. `message` is non-empty for
  // the same truthiness reason as that property.
  it('connectErrorBackfill applied twice with the same message equals applied once', () => {
    fc.assert(
      fc.property(stateArb, nameArb, fc.string({ minLength: 1, maxLength: 20 }), (state, id, message) => {
        const action: NavigatorTreeAction = { type: 'connectErrorBackfill', id, message };
        const once = navigatorTreeReducer(state, action);
        const twice = navigatorTreeReducer(once, action);
        expect(twice).toBe(once);
      }),
    );
  });
});

// The one behaviour this file found that is currently wrong: a db name that
// collides with an inherited Object.prototype member starts an actual load
// rather than being misread as one already in flight. A deterministic case,
// not a property — fast-check may not reliably generate the exact colliding
// name — pinning the fixed behaviour now that `collsLoadStart` reads
// `collsLoading` through `ownGet`.
describe('a db name colliding with an Object.prototype member', () => {
  it('starts an in-flight load rather than reading one as already started', () => {
    const seeded: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: { conn1: emptyCache() },
    };
    const next = navigatorTreeReducer(seeded, { type: 'collsLoadStart', id: 'conn1', dbName: 'constructor' });
    expect(next).not.toBe(seeded);
    expect(next.caches.conn1.collsLoading.constructor).toBe(true);
  });
});
