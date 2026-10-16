# W03 — Query runner service

> **Status: Implemented.**

## Purpose

Run `find` queries and related read operations against Mongo on behalf of the renderer. Owns pagination, cancellation, EJSON serialization, and the capture of each run into the "recent queries" history (W10).

## Scope

- **In**: `QueryService` in main; `query:find`, `query:count`, `query:findOne`, `query:explain`, `query:cancel` IPC channels; EJSON wire format.
- **Out**: UI-side query building (W04/W05), write ops (W08), aggregation (A04).

## Dependencies

- F01, F04, F05 (pool), W10 (recent queries capture).

## 1. Wire format — EJSON

All document payloads and query objects travel as **Extended JSON v2 (canonical)**:
- BSON types are preserved (`ObjectId`, `Date`, `Decimal128`, `Long`, `RegExp`).
- Serialized via `EJSON.stringify(obj, { relaxed: false })` in main and `EJSON.parse(str, { relaxed: false })` in renderer (the `bson` package has a pure-JS EJSON module; renderer imports it as a pure function).

### What crosses the wire
Inputs:
- `filter`: the query shape, as an EJSON **string** (we don't try to serialize user-typed MQL into IPC-safe objects).
- `sort`, `projection`: same — EJSON strings.
- `limit`, `skip`: plain numbers.

Outputs:
- `documents`: `Array<Record<string, unknown>>` where any BSON types are EJSON-encoded values. Renderer parses once before rendering.

## 2. Types

```ts
// shared/types.ts
export interface FindInput {
  connectionId: string;
  dbName: string;
  collection: string;
  filter: string;            // EJSON string, e.g., '{"amount":{"$gt":100}}'
  projection?: string;       // EJSON string or undefined
  sort?: string;
  limit: number;             // 1..1000 (UI caps at 500 page size)
  skip: number;              // >= 0
  ejsonRelaxed?: boolean;    // default false; relaxed=true returns JS-friendly numbers
  cancelToken?: string;      // caller-supplied UUID for cancellation
}

export interface FindResult {
  documents: unknown[];      // EJSON docs
  durationMs: number;
  totalCount?: number;       // if caller asked for it via query:count
  hasMore: boolean;          // true if documents.length === limit
}

export interface ExplainInput extends Omit<FindInput, 'limit' | 'skip' | 'cancelToken'> {
  verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution';
}
```

## 3. Channels

| Channel           | Input           | Output          |
| ----------------- | --------------- | --------------- |
| `query:find`      | `FindInput`     | `FindResult`    |
| `query:count`     | same minus `limit`/`skip`/`projection`/`sort` | `{ count: number }` |
| `query:findOne`   | subset          | `{ document: unknown \| null; durationMs }` |
| `query:explain`   | `ExplainInput`  | `{ plan: unknown; verbosity }` |
| `query:cancel`    | `{ token }`     | `void`          |

## 4. Implementation

```ts
// electron/mongo/QueryService.ts
export class QueryService {
  private active = new Map<string, AbortController>();

  constructor(private pool: MongoPool, private recent: RecentQueryService) {}

  async find(input: FindInput): Promise<FindResult> {
    const filter = ejsonParse(input.filter);
    const sort   = input.sort ? ejsonParse(input.sort) : undefined;
    const projection = input.projection ? ejsonParse(input.projection) : undefined;
    const ctrl = new AbortController();
    if (input.cancelToken) this.active.set(input.cancelToken, ctrl);

    const db = await this.pool.getDb(input.connectionId, input.dbName);
    const coll = db.collection(input.collection);

    const t0 = Date.now();
    try {
      const docs = await coll.find(filter, {
        sort, projection, limit: Math.min(input.limit, 1000), skip: input.skip,
        signal: ctrl.signal,
      }).toArray();
      const durationMs = Date.now() - t0;
      const out = ejsonEncodeArray(docs, input.ejsonRelaxed ?? false);
      await this.recent.record({ /* see W10 */ });
      return { documents: out, durationMs, hasMore: out.length === input.limit };
    } catch (err) {
      await this.recent.recordError({ /* … */ });
      throw classifyMongoError(err);
    } finally {
      if (input.cancelToken) this.active.delete(input.cancelToken);
    }
  }

  cancel(token: string) {
    this.active.get(token)?.abort();
  }
}
```

Cancellation uses the Mongo driver's `signal` option (supported in v6). Aborting closes the underlying cursor.

## 5. Pagination

This spec supports **skip/limit** pagination. The UI (W07) requests `page * pageSize` skip and `pageSize` limit.

- Performance note: skip is O(n) on large result sets. We expose skip because it's easy and the iteration 1 default page size (50) × realistic page counts should be acceptable. A future upgrade to cursor-based ("_id > last") is a follow-up.
- `query:count` for the "X documents" label runs `countDocuments(filter)` with a 5-second timeout via `maxTimeMS: 5000`. If it errors (e.g., timeout on massive collections), UI shows "many" instead of a number.

## 6. Validation

Zod:
- `filter`, `sort`, `projection`: `z.string().refine(isValidEjson)`.
- `limit`: 1–1000.
- `skip`: ≥ 0.
- `dbName`, `collection`: strings, min 1, max 120.
- Rejects empty-string filter (caller passes `"{}"` to mean "all").

Parse failures return VALIDATION with `details: { field, reason }`.

## 7. Mongo error classification

Reuse F05's classifier plus:
- `err.codeName === 'MaxTimeMSExpired'` → `TIMEOUT`.
- `err.codeName === 'Unauthorized'` → `UNAUTHORIZED`.
- Query-shape errors (`err.code === 2` BadValue) → `VALIDATION` with `details.mongoMessage`.

`query:find` words the two ceilings it enforces for the person who hit them,
keeping the raw message in `details.mongoMessage`:

- `TIMEOUT` (the 30 s `maxTimeMS`): "The query was stopped after 30 s. Add an index or narrow the filter."
- A result over the 50 MB encoded-size cap is a `VALIDATION` error, not `INTERNAL`: "The result is larger than 50 MB. Add a filter, a projection, or lower the rows per page."

Both ceilings are constructor inputs (`QueryService`'s `limits`) so a test can
lower them rather than seed 50 MB or wait 30 s.

Renderer uses these to show readable banners (W05 footer pill).

## 8. EJSON helpers

```ts
// electron/mongo/ejson.ts
import { EJSON } from 'bson';
export function ejsonParse<T = unknown>(s: string): T { return EJSON.parse(s, { relaxed: false }); }
export function ejsonEncodeArray(docs: unknown[], relaxed: boolean) {
  return docs.map(d => EJSON.serialize(d, { relaxed }));
}
```

On the renderer side, we **lazy-parse**. JSON view and Tree view can render EJSON directly (each leaf shows its type; BSON types like `ObjectId` render as `ObjectId("…")`). A utility `ejsonToDisplay(value, type)` turns the Extended-JSON canonical form into a friendly string.

## 9. Acceptance criteria

- `query:find` against a seeded collection returns documents in EJSON canonical form.
- `ObjectId` round-trip: input filter with `{ "_id": { "$oid": "…" } }` finds the doc; returned doc's `_id` is also an `$oid` shape.
- `limit: 0` is rejected by validation (must be ≥ 1).
- `limit: 10` plus a result of exactly 10 docs yields `hasMore: true`; a result of 9 docs yields `hasMore: false`.
- `query:cancel` aborts an in-flight long query and the handler returns a VALIDATION-free TIMEOUT-like error.
- `query:count` with a pathological filter times out within ~5 seconds.

## 10. Test cases

### Unit
- **ejson.spec.ts**: parse/serialize round-trips for `ObjectId`, `Date`, `Long`, `Decimal128`, `RegExp`.
- **classify.spec.ts**: fixture errors → expected codes.

### Integration (memory Mongo + temp SQLite for recent)
- **find-happy.spec.ts**: 10 seeded docs, filter `{}`, limit 5 → 5 docs, `hasMore: true`, `durationMs` sensible.
- **find-filter.spec.ts**: numeric/date/RegExp filters work.
- **find-projection-sort.spec.ts**: projection hides fields; sort order is respected.
- **find-skip.spec.ts**: skip advances correctly.
- **count-timeout.spec.ts**: seed many docs; artificially force `maxTimeMS` to 1 → TIMEOUT.
- **cancel.spec.ts**: long `$where` query started with cancelToken; cancel resolves quickly; original find rejects.
- **unauthorized.spec.ts**: create a user without list privilege → UNAUTHORIZED.
- **recent-capture.spec.ts**: after a successful `find`, a row exists in `recent_queries` for the connection (W10 contract).

### Component
Covered by W05/W06 which exercise this service.
